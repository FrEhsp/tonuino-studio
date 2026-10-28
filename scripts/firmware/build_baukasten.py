#!/usr/bin/env python3
"""
Builds the firmware of the "Firmware-Baukasten" (docs/FIRMWARE-BAUKASTEN.md):
TonUINO-TNG for Classic (Arduino Nano) and AiO (LGT8F328P) with compile-time
extras switched on, as gzip-compressed flash images for the app.

No PlatformIO and no Arduino IDE: the sources are cloned from GitHub at fixed
commits (checked after the clone), compiled with the avr-gcc 7.3.0 of
Ubuntu/Debian (`apt-get install gcc-avr avr-libc binutils-avr`, the same GCC
as PlatformIO's toolchain-atmelavr 1.70300) with the flags PlatformIO uses for
these boards (platform-atmelavr builder/frameworks/arduino.py; for the AiO the
recipes of the lgt8fx core's platform.txt), and linked like PlatformIO does
(core and every library in its own archive).

    python3 scripts/firmware/build_baukasten.py [--work DIR] [--jobs 2] [--only ID ...] [--check]

Writes public/firmware/baukasten/<board>-<buttons>[-<knob>].pack.gz (the
flash images of a group, one after the other, gzip) and manifest.json. With --check
it builds everything again into a temporary folder and compares the
checksums with the manifest (reproducibility check). The manifest records for
every build the sources (repository and commit), the toolchain and all flags,
as TonUINO-TNG's licence (GPL-3.0) asks.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "public" / "firmware" / "baukasten"

# ----------------------------------------------------------------- sources

# The TNG states ("Stände") the Baukasten knows, by the version string the box
# logs (src/version.hpp). The app ships builds of exactly one of them, the
# checked one (PINNED_STAND): the official builds on tonuino.github.io are
# always the newest main and change without notice (docs/FIRMWARE-BAUKASTEN.md,
# "Geprüfter Stand"). A new state is taken over only after the box simulator
# passes with it (`--candidate`, then `npm run test:boxsim`).
# - config "defines": the TNG switches go to the compiler as -D (states before
#   26.10.2026, where config.hpp did not exist yet).
# - config "config.hpp": the switches go into a config.hpp in the root of the
#   TNG tree, which src/constants.hpp includes (TNG PR #343, Issue 342). The
#   light ring then needs its number of pixels (NEO_RING 24).
TNG_REPO = "https://github.com/tonuino/TonUINO-TNG.git"
TNG_STANDS = {
    # main of 17.09.2026, what tonuino.github.io served until 26.10.2026
    "V3.3.3 17.09.26": {"commit": "d527ca5f3c5090a74ccdf5505202db352d7531c8", "version": "3.3.3", "date": "2026-09-17", "config": "defines"},
    # main of 26.10.2026 (PR #343): config.hpp, settings layout 3, invertVolumeButtons for 5 buttons, BAT calibration
    "V3.3.4 26.10.26": {"commit": "bd65503cda80e4e6944c3d23592667ed6466dda8", "version": "3.3.4", "date": "2026-10-26", "config": "config.hpp"},
}
PINNED_STAND = "V3.3.3 17.09.26"

# Library versions as TNG's platformio.ini and README pin them (NeoPixel: README "1.11.0").
SOURCES = {
    "tng": (TNG_REPO, TNG_STANDS[PINNED_STAND]["commit"]),
    # Preview "Karten über die Box beschreiben": TNG branch issue_345 ("V3.3.3 08.10.26"), which has
    # donschoof's serial WRITECARD command (PR #344, merged there by boerge1; PR #346 to main still
    # open). Same base as above (d527ca5); only the WRITE_CARD builds use it, with -D SerialWriteCard.
    "tng-writecard": ("https://github.com/tonuino/TonUINO-TNG.git", "abfa3075f8dea929a943943eb8059d2b362ed160"),
    # framework of PlatformIO's nanoatmega328; TNG README: Arduino AVR core 1.8.6
    "arduino-avr": ("https://github.com/arduino/ArduinoCore-avr.git", "42fa4a1ea1b1b11d1cc0a60298e529d37f9d14bd"),  # tag 1.8.6
    # framework-lgt8fx@1.0.6 (platformio.ini ALLinONE_*): the released package lgt8f-1.0.6.zip of this commit
    "lgt8fx": ("https://github.com/dbuezas/lgt8fx.git", "81d98d6375b2a39154fa138a0f3fc2e5a8a92301"),  # tag v1.0.6
    "JC_Button": ("https://github.com/JChristensen/JC_Button.git", "f379405f8ac425d2f0fe6248cbdad5e5461ae467"),  # tag 2.1.2
    "MFRC522_fix": ("https://github.com/boerge1/rfid.git", "a384087d1241a37f09028ff9a0cd5a8cdf9cbc0f"),  # tag 1.4.12
    "DFMiniMp3": ("https://github.com/Makuna/DFMiniMp3.git", "9e0720c92ae45c6e93a9c571cb78099cc58fa534"),  # tag 1.2.3
    "Adafruit_NeoPixel": ("https://github.com/adafruit/Adafruit_NeoPixel.git", "9a9104c6ede08097f8067f4005837ff56a3d2936"),  # tag 1.11.0
}
LGT8FX_ZIP = "lgt8f-1.0.6.zip"
LGT8FX_ZIP_SHA256 = "e7384539898243cb013182b37780205330d61fa8c5276f512422b84b2a2f23bd"

TOOLCHAIN_VERSION = "7.3.0"

# ------------------------------------------------------------------ boards


@dataclass(frozen=True)
class Board:
    id: str
    env_prefix: str
    mcu: str
    max_bytes: int
    # What PlatformIO passes for the board and its framework: always -D.
    framework: tuple[str, ...]
    # The TNG switch for the board (platformio.ini build_flags): -D, or a line of config.hpp.
    pcb: str

    @property
    def defines(self) -> tuple[str, ...]:
        return (*self.framework, self.pcb)


BOARDS = {
    # platformio.ini [env:TonUINO_Classic_*]: board nanoatmega328 (variant eightanaloginputs). Largest
    # size: 32256 with the new bootloader (Optiboot), 30720 with the old one (see needsNewBootloader).
    "classic": Board("classic", "TonUINO_Classic", "atmega328p", 32256, ("F_CPU=16000000L", "ARDUINO_ARCH_AVR", "ARDUINO=10808", "ARDUINO_AVR_NANO"), "TonUINO_Classic=1"),
    # platformio.ini [env:ALLinONE_*]: board LGT8F328P, f_cpu 16 MHz, clock_source 2 (lgt8fx boards.txt: maximum_size 29696)
    "aio": Board("aio", "ALLinONE", "atmega328p", 29696, ("F_CPU=16000000L", "CLOCK_SOURCE=2", "SERIAL_RX_BUFFER_SIZE=64", "ARDUINO_ARCH_AVR", "ARDUINO=10808", "ARDUINO_AVR_LARDU_328E"), "ALLinONE=1"),
}

# ----------------------------------------------------------------- extras

# Every compile-time switch the Baukasten offers, with the define(s) it sets.
# Names, pins and meaning: TNG src/constants.hpp (docs/FIRMWARE-BAUKASTEN.md).
HW_EXTRAS = {
    "encoder": ("ROTARY_ENCODER",),
    "encoderSkip": ("ROTARY_ENCODER", "ROTARY_ENCODER_LONGPRESS"),
    "poti": ("POTI",),
    "ring": ("NEO_RING",),
    "ringVolume": ("NEO_RING", "NEO_RING_EXT"),
    "ledButtons": ("USE_LED_BUTTONS",),
    "speakerOff": ("SPKONOFF",),
    "headphones": ("HPJACKDETECT",),
    "traeger": ("USE_TRAEGER_PLATINE_SHUTDOWN",),
}

# Behaviour presets: the full product of all behaviour switches would be far
# too many builds, and the games do not fit into Classic or AiO at all.
PRESETS = {
    "standard": (),
    # "Weitermachen": the same card does not start over, Play/Pause without a card plays the last one, also after switching off
    "weiter": ("RESUME_ON_SAME_RFID", "DONT_ACCEPT_SAME_RFID_TWICE", "REPLAY_ON_PLAY_BUTTON", "STORE_LAST_CARD"),
}

# Button defines exactly as the official environments in TNG platformio.ini:
# the Classic defaults to 3 buttons, the AiO to 5 (constants.hpp: ALLinONE
# defines FIVEBUTTONS unless THREEBUTTONS or BUTTONS3X3 is set).
# MP3 player chip (TNG constants.hpp:157-174). constants.hpp itself defines
# DFMiniMp3_T_CHIP_Mp3ChipIncongruousNoAck (line 174), so every build talks
# to the player without waiting for ACKs, as the official builds do; the
# defines below only add TNG's workarounds for the chip (dfPlayer_timeUntilStarts
# 2500 ms, OnPlayFinished ignored for advert tracks, the extra busy wait of
# MP3-TF-16P V3.0, the folder count of the GD3200B). MH2024K16SS is left out:
# its define selects the library variant Mp3ChipMH2024K16SS (mp3.hpp:28-33),
# which the NoAck define of constants.hpp overrides, so it would need a
# change of the source.
CHIPS = {
    "standard": (),
    "mh2024k24ss": ("DFMiniMp3_T_CHIP_MH2024K24SS_MP3_TF_16P_V3_0",),
    "gd3200b": ("DFMiniMp3_T_CHIP_GD3200B",),
    "lisp3": ("DFMiniMp3_T_CHIP_LISP3",),
}

# Start with track 1 of folder 01 instead of the normal start when A6 is high
# while the box starts (TNG constants.hpp:352-371, tonuino.cpp:136-151,
# state_machine.cpp:787-788): for an alarm clock that switches the box on.
# TNG's config template of PR #343 calls it "Soundtrack als Weckersignal".
# Classic only: where A6 comes out on the AiO is not documented.
ALARM_DEFINES = ("SPECIAL_START_SHORTCUT",)

# Preview: write cards over USB (WRITECARD <mode>,<folder>,... on the serial
# line, TNG issue_345 constants.hpp:155-178). Built from SOURCES["tng-writecard"],
# for the same common builds as another chip (knob, carrier board,
# "Weitermachen"), without SerialInputAsCommand. Set True when the commit
# of SOURCES["tng"] has the command itself: then every build gets the define,
# the preview builds go away and the app hides the preview (manifest
# tng.writeCard, src/core/firmware/baukasten.ts offerWriteCardPreview).
WRITE_CARD_DEFINES = ("SerialWriteCard",)
TNG_HAS_WRITE_CARD = False
WRITE_CARD_PREVIEW = {"source": "tng-writecard", "branch": "issue_345", "versionString": "V3.3.3 08.10.26", "author": "donschoof", "pullRequests": ["https://github.com/tonuino/TonUINO-TNG/pull/344", "https://github.com/tonuino/TonUINO-TNG/pull/346"]}

BUTTON_DEFINES = {
    ("classic", "3"): (),
    ("classic", "5"): ("FIVEBUTTONS=1",),
    ("classic", "3x3"): ("BUTTONS3X3=1",),
    ("aio", "3"): ("THREEBUTTONS",),
    ("aio", "5"): (),
    ("aio", "3x3"): ("BUTTONS3X3=1",),
}

# Largest firmware behind the bootloader of an Arduino Nano: old bootloader
# (ATmegaBOOT, 2 KiB, what PlatformIO's nanoatmega328 assumes) and the new one
# (Optiboot, 512 bytes; Arduino boards.txt nano.menu.cpu.atmega328.upload.maximum_size).
NANO_OLD_BOOTLOADER_MAX = 30720
NANO_OPTIBOOT_MAX = 32256


@dataclass
class Build:
    board: str
    buttons: str
    knob: str | None = None  # encoder | encoderSkip | poti
    light: str | None = None  # ring | ringVolume | ledButtons
    speaker_off: bool = False
    headphones: bool = False
    traeger: bool = False
    preset: str = "standard"
    chip: str = "standard"
    alarm: bool = False
    write_card: bool = False

    def extras(self) -> list[str]:
        out = [x for x in (self.knob, self.light) if x]
        if self.speaker_off:
            out.append("speakerOff")
        if self.headphones:
            out.append("headphones")
        if self.traeger:
            out.append("traeger")
        return out

    @property
    def id(self) -> str:
        return "-".join([self.board, self.buttons, *self.extras(), *([self.preset] if self.preset != "standard" else []), *([self.chip] if self.chip != "standard" else []), *(["alarm"] if self.alarm else []), *(["writeCard"] if self.write_card else [])])

    def tng_defines(self, config: str = "defines") -> list[str]:
        """The TNG switches of this build (board, buttons, extras), as NAME or NAME=VALUE."""
        out = [BOARDS[self.board].pcb, *BUTTON_DEFINES[(self.board, self.buttons)]]
        for name in self.extras():
            out += [d for d in HW_EXTRAS[name] if d not in out]
        out += list(PRESETS[self.preset]) + list(CHIPS[self.chip]) + (list(ALARM_DEFINES) if self.alarm else []) + (list(WRITE_CARD_DEFINES) if self.write_card else [])
        if config == "config.hpp":
            # Since PR #343 NEO_RING is the number of pixels (constants.hpp neoPixelNumber = NEO_RING); the Baukasten's ring has 24.
            out = [f"NEO_RING={NEO_RING_PIXELS}" if d == "NEO_RING" else d for d in out]
            # Since PR #343 constants.hpp sets the NoAck chip only when no chip is chosen. With it as well the
            # library talks to the player as before (and as the official builds), plus TNG's workarounds for the chip.
            if self.chip != "standard":
                out.append("DFMiniMp3_T_CHIP_Mp3ChipIncongruousNoAck")
        return out

    def all_defines(self, config: str = "defines") -> list[str]:
        return [*BOARDS[self.board].framework, *self.tng_defines(config)]

    @property
    def tng_source(self) -> str:
        return "tng-writecard" if self.write_card else "tng"


# The light ring of the Baukasten: 24 LEDs (before PR #343 fixed in constants.hpp).
NEO_RING_PIXELS = 24


def config_hpp(defines: list[str], stand: str) -> str:
    """A config.hpp for the root of the TNG tree: only #defines (TNG README, config_all_undef.hpp)."""
    lines = [f"// TonUINO Studio, Firmware-Baukasten: configuration of TonUINO TNG {stand}", "// (scripts/firmware/build_baukasten.py; template: config_all_undef.hpp)"]
    for d in defines:
        name, _, value = d.partition("=")
        lines.append(f"#define {name} {value}".rstrip())
    return "\n".join(lines) + "\n"


def matrix() -> list[Build]:
    """
    Every build the app ships (those that fit). The rules follow the pins in
    TNG src/constants.hpp; src/core/firmware/baukasten.ts has the same rules
    for the wizard, and tests/firmware/baukasten.test.ts checks both agree.
    - Knob (encoder CLK A3/DT A4, poti A3) only with 3 buttons: with 5 buttons
      A3/A4 are buttons; with the 3x3 field the Classic has the field on A3,
      the AiO its Vor/Zurück buttons on A3/A4. Encoder and poti exclude each other.
    - Classic: ring (D5) or LED buttons (A5, D5, D6), speaker switch-off (D6,
      not with LED buttons), headphone detection (D8), carrier-board shutdown.
    - AiO: amp switching (D8) and shutdown are built in; the ring and LED
      buttons do not fit into its flash (ring) or collide with USB access (A5).
    - Another MP3 chip only for the common builds: knob, carrier board and
      "Weitermachen", without light, speaker switch-off and headphones (all
      chips times all extras would be four times the builds).
    - The alarm start (A6) the same way, Classic only, and not together with
      another chip.
    - The preview "write cards over USB" (other TNG commit) the same way, on
      both boards, not with another chip or the alarm start.
    """
    builds: list[Build] = []
    for board in ("classic", "aio"):
        classic = board == "classic"
        for buttons in ("3", "5", "3x3"):
            for knob in [None, "encoder", "encoderSkip", "poti"] if buttons == "3" else [None]:
                for light in [None, "ring", "ringVolume", "ledButtons"] if classic else [None]:
                    for speaker_off in (False, True) if classic and light != "ledButtons" else (False,):
                        for headphones in (False, True) if classic else (False,):
                            for traeger in (False, True) if classic else (False,):
                                for preset in PRESETS:
                                    plain_parts = light is None and not speaker_off and not headphones
                                    for chip in CHIPS if plain_parts else ("standard",):
                                        for alarm in (False, True) if classic and plain_parts and chip == "standard" else (False,):
                                            for write_card in (False, True) if plain_parts and chip == "standard" and not alarm and not TNG_HAS_WRITE_CARD else (False,):
                                                builds.append(Build(board, buttons, knob, light, speaker_off, headphones, traeger, preset, chip, alarm, write_card))
    return builds


# ------------------------------------------------------------- toolchain


def run(cmd: list[str], cwd: Path | None = None) -> str:
    p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"command failed ({p.returncode}): {' '.join(cmd)}\n{p.stdout[-4000:]}")
    return p.stdout


def toolchain_info() -> dict:
    gcc = run(["avr-gcc", "-dumpfullversion"]).strip()
    if gcc != TOOLCHAIN_VERSION:
        sys.exit(f"avr-gcc {gcc} found, {TOOLCHAIN_VERSION} needed (apt-get install gcc-avr avr-libc binutils-avr)")
    libc = "unknown"
    try:
        out = run(["dpkg-query", "-W", "-f=${Version}", "avr-libc"])
        libc = out.strip()
    except Exception:
        pass
    return {"avr-gcc": run(["avr-gcc", "--version"]).splitlines()[0], "avr-libc": libc}


def fetch_sources(work: Path) -> dict[str, Path]:
    src = work / "src"
    src.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for name, (url, commit) in SOURCES.items():
        dest = src / name
        if not (dest / ".git").exists():
            run(["git", "init", "-q", str(dest)])
            run(["git", "-C", str(dest), "remote", "add", "origin", url])
        head = subprocess.run(["git", "-C", str(dest), "rev-parse", "HEAD"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout.strip()
        if head != commit:
            run(["git", "-C", str(dest), "fetch", "-q", "--depth", "1", "origin", commit])
            run(["git", "-C", str(dest), "-c", "advice.detachedHead=false", "checkout", "-q", "--force", commit])
        head = run(["git", "-C", str(dest), "rev-parse", "HEAD"]).strip()
        if head != commit:
            sys.exit(f"{name}: expected commit {commit}, got {head}")
        run(["git", "-C", str(dest), "clean", "-qfdx"])
        paths[name] = dest
    # The lgt8fx framework as released (the zip in the repo), not the work tree.
    zip_path = paths["lgt8fx"] / LGT8FX_ZIP
    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    if digest != LGT8FX_ZIP_SHA256:
        sys.exit(f"{LGT8FX_ZIP}: sha256 {digest}, expected {LGT8FX_ZIP_SHA256}")
    unpacked = work / "lgt8fx-1.0.6"
    if not unpacked.exists():
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(unpacked)
    paths["lgt8f"] = unpacked / "lgt8f"
    return paths


# ------------------------------------------------------------------ build

CFLAGS_COMMON = ["-Os", "-Wall", "-ffunction-sections", "-fdata-sections", "-flto"]
CFLAGS_C = ["-std=gnu11", "-fno-fat-lto-objects"]
# platformio.ini [env] build_flags -std=gnu++17 -fconcepts (build_unflags -std=gnu++11) on top of PlatformIO's CXXFLAGS
CFLAGS_CXX = ["-fno-exceptions", "-fno-threadsafe-statics", "-fpermissive", "-std=gnu++17", "-fconcepts"]
LDFLAGS = ["-Os", "-Wl,--gc-sections", "-flto", "-fuse-linker-plugin"]
COMMON_DEFINES = ["__IN_VS_CODE__"]


def sources_in(directory: Path, recursive: bool = False) -> list[Path]:
    pattern = "**/*" if recursive else "*"
    return sorted(p for p in directory.glob(pattern) if p.suffix in (".c", ".cpp", ".S") and p.is_file())


def layout(board: Board, paths: dict[str, Path], tng_src: Path) -> tuple[list[Path], dict[str, list[Path]]]:
    """Include folders and the sources of each archive (core, libraries)."""
    if board.id == "aio":
        root = paths["lgt8f"]
        core = root / "cores" / "lgt8f"
        variant = root / "variants" / "lgt8fx8p"
        fw_libs = {"SPI": root / "libraries" / "SPI" / "src", "SoftwareSerial": root / "libraries" / "SoftwareSerial", "EEPROM": root / "libraries" / "E2PROM"}
    else:
        root = paths["arduino-avr"]
        core = root / "cores" / "arduino"
        variant = root / "variants" / "eightanaloginputs"
        fw_libs = {"SPI": root / "libraries" / "SPI" / "src", "SoftwareSerial": root / "libraries" / "SoftwareSerial" / "src", "EEPROM": root / "libraries" / "EEPROM" / "src"}
    libs = {
        "JC_Button": paths["JC_Button"] / "src",
        "MFRC522_fix": paths["MFRC522_fix"] / "src",
        "DFMiniMp3": paths["DFMiniMp3"] / "src",
        "Adafruit_NeoPixel": paths["Adafruit_NeoPixel"],
        **fw_libs,
    }
    includes = [core, variant, *libs.values(), tng_src]
    archives = {"FrameworkArduino": sources_in(core), **{name: [p for p in sources_in(d) if p.suffix != ".c" or name != "Adafruit_NeoPixel" or p.name not in ("esp.c", "esp8266.c", "kendyte_k210.c")] for name, d in libs.items()}}
    return includes, archives


def compile_one(src: Path, obj: Path, mcu: str, defines: list[str], includes: list[Path]) -> None:
    obj.parent.mkdir(parents=True, exist_ok=True)
    flags = [f"-mmcu={mcu}", *CFLAGS_COMMON, *[f"-D{d}" for d in defines], *[f"-I{i}" for i in includes]]
    if src.suffix == ".c":
        cmd = ["avr-gcc", *CFLAGS_C, *flags]
    elif src.suffix == ".S":
        cmd = ["avr-gcc", "-x", "assembler-with-cpp", *flags]
    else:
        cmd = ["avr-g++", *CFLAGS_CXX, *flags]
    run([*cmd, "-c", str(src), "-o", str(obj)])


def source_config(source: str) -> str:
    """How a TNG source takes its switches: "defines" (-D) or "config.hpp"."""
    return SOURCE_CONFIG.get(source, "defines")


# Set by select_stand(): the config way of each TNG source.
SOURCE_CONFIG: dict[str, str] = {"tng": TNG_STANDS[PINNED_STAND]["config"], "tng-writecard": "defines"}
STAND = PINNED_STAND


def select_stand(stand: str) -> None:
    """Builds from another TNG state (`--tng`, `--candidate`)."""
    global STAND
    if stand not in TNG_STANDS:
        sys.exit(f"unknown TNG state {stand!r}; known: {', '.join(TNG_STANDS)}")
    STAND = stand
    SOURCES["tng"] = (TNG_REPO, TNG_STANDS[stand]["commit"])
    SOURCE_CONFIG["tng"] = TNG_STANDS[stand]["config"]


def check_version(tng: Path, stand: str) -> None:
    """The fetched TNG tree must say the version string of its state (src/version.hpp)."""
    text = (tng / "src" / "version.hpp").read_text()
    if f'"{stand}"' not in text:
        sys.exit(f"TNG src/version.hpp does not say {stand!r}:\n{text}")


def build_one(b: Build, paths: dict[str, Path], work: Path) -> dict:
    board = BOARDS[b.board]
    config = source_config(b.tng_source)
    out = work / "build" / b.id
    if out.exists():
        shutil.rmtree(out)
    if config == "config.hpp":
        # A tree of its own per build: constants.hpp includes "../config.hpp" next to its src folder
        # (and src/main.cpp the sketch "../TonUINO-TNG.ino").
        tng_root = out / "tng"
        shutil.copytree(paths[b.tng_source] / "src", tng_root / "src")
        shutil.copy2(paths[b.tng_source] / "TonUINO-TNG.ino", tng_root / "TonUINO-TNG.ino")
        (tng_root / "config.hpp").write_text(config_hpp(b.tng_defines(config), STAND))
        defines = COMMON_DEFINES + list(board.framework)
    else:
        tng_root = paths[b.tng_source]
        defines = COMMON_DEFINES + b.all_defines()
    includes, archives = layout(board, paths, tng_root / "src")
    libs: list[Path] = []
    # Core and libraries see the same flags as the sketch, as with PlatformIO.
    for name, files in archives.items():
        objs = []
        for i, f in enumerate(files):
            obj = out / name / f"{i:02d}_{f.name}.o"
            compile_one(f, obj, board.mcu, defines, includes)
            objs.append(obj)
        if objs:
            lib = out / f"lib{name}.a"
            run(["avr-gcc-ar", "rc", str(lib), *map(str, objs)])
            libs.append(lib)
    objs = []
    for f in sources_in(tng_root / "src"):
        obj = out / "src" / f"{f.name}.o"
        compile_one(f, obj, board.mcu, defines, includes)
        objs.append(obj)
    elf = out / "firmware.elf"
    # FrameworkArduino last, as PlatformIO prepends it to LIBS of the program: libraries first, then core, then -lm.
    lib_order = [l for l in libs if l.name != "libFrameworkArduino.a"] + [l for l in libs if l.name == "libFrameworkArduino.a"]
    try:
        run(["avr-gcc", f"-mmcu={board.mcu}", *LDFLAGS, "-o", str(elf), *map(str, objs), "-Wl,--start-group", *map(str, lib_order), "-lm", "-Wl,--end-group"])
    except RuntimeError as e:
        # Bigger than the whole flash of the chip (32 KiB): the linker refuses.
        m = re.search(r"region `text' overflowed by (\d+) bytes", str(e))
        if not m:
            raise
        shutil.rmtree(out)
        return {"id": b.id, "bytes": 32768 + int(m.group(1)), "ram": 0, "fits": False, "_data": b""}
    binary = out / "firmware.bin"
    run(["avr-objcopy", "-O", "binary", "-R", ".eeprom", str(elf), str(binary)])
    data = binary.read_bytes()
    size = run(["avr-size", "-A", str(elf)])
    ram = sum(int(line.split()[1]) for line in size.splitlines() if line.startswith((".data", ".bss", ".noinit")))
    result = {
        "id": b.id,
        "board": b.board,
        "buttons": b.buttons,
        "knob": b.knob,
        "light": b.light,
        "speakerOff": b.speaker_off,
        "headphones": b.headphones,
        "traeger": b.traeger,
        "preset": b.preset,
        "chip": b.chip,
        "alarm": b.alarm,
        "writeCard": b.write_card,
        "env": f"{board.env_prefix}_{b.buttons}",
        "defines": COMMON_DEFINES + b.all_defines(config),
        "bytes": len(data),
        "ram": ram,
        "fits": len(data) <= board.max_bytes,
        "needsNewBootloader": b.board == "classic" and len(data) > NANO_OLD_BOOTLOADER_MAX,
        "sha256": hashlib.sha256(data).hexdigest(),
        "_data": data,
    }
    shutil.rmtree(out)
    return result


def reuse_builds(out_dir: Path, builds: list[Build], tools: dict) -> list[dict]:
    """Builds of the current manifest that would come out the same (same id, defines, sources, toolchain, flags)."""
    path = out_dir / "manifest.json"
    if not path.exists():
        return []
    manifest = json.loads(path.read_text())
    same = (
        manifest.get("toolchain") == tools
        # A source added since (e.g. tng-writecard) does not change the other builds.
        and all(manifest_sources().get(name) == old for name, old in manifest.get("sources", {}).items())
        and manifest.get("flags") == {"c": CFLAGS_COMMON + CFLAGS_C, "cxx": CFLAGS_COMMON + CFLAGS_CXX, "link": LDFLAGS}
    )
    if not same:
        return []
    old = {b["id"]: b for b in manifest["builds"]}
    unpacked: dict[str, bytes] = {}
    out = []
    for b in builds:
        o = old.get(b.id)
        if not o or o["defines"] != COMMON_DEFINES + b.all_defines(source_config(b.tng_source)):
            continue
        if o["pack"] not in unpacked:
            unpacked[o["pack"]] = gzip.decompress((out_dir / o["pack"]).read_bytes())
        data = unpacked[o["pack"]][o["offset"] : o["offset"] + o["bytes"]]
        if hashlib.sha256(data).hexdigest() != o["sha256"]:
            continue
        r = {**{k: o[k] for k in ("id", "board", "buttons", "knob", "light", "speakerOff", "headphones", "traeger", "preset")}, "chip": b.chip, "alarm": b.alarm, "writeCard": b.write_card}
        r.update({k: o[k] for k in ("env", "defines", "bytes", "ram", "fits", "needsNewBootloader", "sha256")})
        r["_data"] = data
        out.append(r)
    return out


def boxsim_builds() -> list[str]:
    """The builds the box simulator starts: BUILDS in scripts/firmware/boxsim-run.mjs (one list, kept there)."""
    text = (REPO_ROOT / "scripts" / "firmware" / "boxsim-run.mjs").read_text()
    m = re.search(r"const BUILDS = \[([^\]]*)\]", text)
    if not m:
        sys.exit("boxsim-run.mjs: BUILDS not found")
    return re.findall(r"'([^']+)'", m.group(1))


def manifest_sources() -> dict[str, dict[str, str]]:
    return {name: {"repository": url.removesuffix(".git"), "commit": commit} for name, (url, commit) in SOURCES.items()}


def gzip_bytes(data: bytes) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0, filename="") as g:
        g.write(data)
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", type=Path, default=Path(tempfile.gettempdir()) / "tonuino-baukasten")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--jobs", type=int, default=2)
    ap.add_argument("--only", nargs="*", help="build only these ids (for trying; does not write the manifest)")
    ap.add_argument("--list", action="store_true", help="list the ids of the matrix")
    ap.add_argument("--check", action="store_true", help="rebuild and compare with the manifest")
    ap.add_argument("--print-zip-sha", action="store_true")
    ap.add_argument("--reuse", action="store_true", help="take a build from the current manifest and packs when its id, defines, sources and toolchain are the same (checked by SHA-256); builds that did not fit are built again")
    ap.add_argument("--tng", metavar="VERSION", help=f"build from another TNG state (version string, e.g. \"V3.3.4 26.10.26\"; default: the checked one, {PINNED_STAND!r})")
    ap.add_argument("--candidate", metavar="DIR", type=Path, help="build only what the box simulator needs (scripts/firmware/boxsim-run.mjs BUILDS) into DIR, with a manifest; then: BOXSIM_BAUKASTEN=DIR npm run test:boxsim")
    args = ap.parse_args()
    if args.tng:
        select_stand(args.tng)

    builds = matrix()
    if args.candidate:
        wanted = set(boxsim_builds())
        builds = [b for b in builds if b.id in wanted]
        args.out = args.candidate
    if args.list:
        for b in builds:
            print(b.id)
        print(len(builds), "builds", file=sys.stderr)
        return
    if args.print_zip_sha:
        global LGT8FX_ZIP_SHA256
        LGT8FX_ZIP_SHA256 = ""
        try:
            fetch_sources(args.work)
        except SystemExit as e:
            print(e)
        return

    tools = toolchain_info()
    paths = fetch_sources(args.work)
    check_version(paths["tng"], STAND)
    if args.only:
        wanted = set(args.only)
        builds = [b for b in builds if b.id in wanted]
        missing = wanted - {b.id for b in builds}
        if missing:
            sys.exit(f"not in the matrix: {', '.join(sorted(missing))}")

    results: list[dict] = []
    if args.reuse and not args.check:
        reused = reuse_builds(args.out, builds, tools)
        results += reused
        done = {r["id"] for r in reused}
        builds = [b for b in builds if b.id not in done]
        print(f"reused {len(reused)} builds from the manifest", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(build_one, b, paths, args.work): b for b in builds}
        for n, fut in enumerate(concurrent.futures.as_completed(futures), 1):
            r = fut.result()
            results.append(r)
            print(f"[{n}/{len(builds)}] {r['id']}: {r['bytes']} bytes, RAM {r['ram']}{'' if r['fits'] else '  DOES NOT FIT'}", flush=True)
    results.sort(key=lambda r: r["id"])

    if args.check:
        manifest = json.loads((args.out / "manifest.json").read_text())
        known = {b["id"]: b["sha256"] for b in manifest["builds"]}
        bad = [r["id"] for r in results if known.get(r["id"]) != r["sha256"]]
        if bad:
            sys.exit(f"differs from manifest: {', '.join(bad)}")
        print(f"all {len(results)} builds match the manifest")
        return
    if args.only:
        return

    args.out.mkdir(parents=True, exist_ok=True)
    for old in [*args.out.glob("*.bin.gz"), *args.out.glob("*.pack.gz")]:
        old.unlink()
    # Builds that differ in a few extras share most bytes. Packed together
    # (one gzip stream per board, buttons and knob, in id order), deflate
    # finds the previous image within its 32 KiB window: about a quarter of
    # the size of single files. The app unpacks one pack (about 1 MiB).
    packs: dict[str, list[dict]] = {}
    for r in results:
        if r["fits"]:
            # The preview builds in packs of their own (per board and buttons): the other packs stay as they were.
            key = (r["board"], r["buttons"], "writeCard") if r.get("writeCard") else (r["board"], r["buttons"], r["knob"])
            packs.setdefault("-".join(x for x in key if x), []).append(r)
    shipped = []
    for name, members in sorted(packs.items()):
        blob = bytearray()
        for r in sorted(members, key=lambda r: r["id"]):
            r["pack"] = f"{name}.pack.gz"
            r["offset"] = len(blob)
            blob += r["_data"]
            shipped.append(r)
        (args.out / f"{name}.pack.gz").write_bytes(gzip_bytes(bytes(blob)))
    for r in results:
        r.pop("_data", None)
    shipped.sort(key=lambda r: r["id"])
    tng_url, tng_commit = SOURCES["tng"]
    stand = TNG_STANDS[STAND]
    manifest = {
        "format": 1,
        "tng": {"version": stand["version"], "versionString": STAND, "date": stand["date"], "config": stand["config"], "repository": tng_url.removesuffix(".git"), "commit": tng_commit, "license": "GPL-3.0", "writeCard": TNG_HAS_WRITE_CARD},
        "sources": manifest_sources(),
        "toolchain": tools,
        "flags": {"c": CFLAGS_COMMON + CFLAGS_C, "cxx": CFLAGS_COMMON + CFLAGS_CXX, "link": LDFLAGS},
        "script": "scripts/firmware/build_baukasten.py",
        "notFitting": [r["id"] for r in results if not r["fits"]],
        **({} if TNG_HAS_WRITE_CARD else {"writeCardPreview": {**WRITE_CARD_PREVIEW, "repository": SOURCES[WRITE_CARD_PREVIEW["source"]][0].removesuffix(".git"), "commit": SOURCES[WRITE_CARD_PREVIEW["source"]][1], "license": "GPL-3.0", "defines": list(WRITE_CARD_DEFINES)}}),
        "builds": shipped,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")
    total = sum(f.stat().st_size for f in args.out.glob("*.pack.gz"))
    print(f"{len(shipped)} builds in {len(packs)} packs ({total / 1024:.0f} KiB), {len(manifest['notFitting'])} do not fit")


if __name__ == "__main__":
    main()
