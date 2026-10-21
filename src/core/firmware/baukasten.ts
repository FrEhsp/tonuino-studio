/**
 * Firmware-Baukasten: TonUINO-TNG with compile-time extras for Classic
 * (Arduino Nano) and AiO, built by scripts/firmware/build_baukasten.py and
 * shipped with the app in public/firmware/baukasten: manifest.json and
 * packs (<board>-<buttons>[-<knob>].pack.gz, the flash images of a group one
 * after the other). Decisions and pins: docs/FIRMWARE-BAUKASTEN.md.
 *
 * The rules below follow TNG src/constants.hpp of the pinned commit (V3.3.3
 * 17.09.26). The build script has the same rules in matrix();
 * tests/firmware/baukasten.test.ts checks that both agree with the manifest.
 */
import type { HexImage } from './intelhex';
import { CHIP_TEXTS, OTHER_CHIPS, type Mp3Chip } from './mp3chip';
import type { BoardId } from './variants';

/** Boards the Baukasten builds for. AiO+, Nano Every and ESP32 need a toolchain the build cannot get (see the doc). */
export type BaukastenBoard = 'classic' | 'aio';
export type BaukastenButtons = '3' | '5' | '3x3';

/** Volume knob: rotary encoder, encoder that also skips, or potentiometer. */
export type KnobKind = 'encoder' | 'encoderSkip' | 'poti';
/** Light: NeoPixel ring, ring that also shows the volume, or buttons with LEDs. */
export type LightKind = 'ring' | 'ringVolume' | 'ledButtons';
export type PresetId = 'standard' | 'weiter';

export interface ExtrasChoice {
  knob?: KnobKind;
  light?: LightKind;
  /** SPKONOFF: amplifier off while switching on and off (Classic, pin D6). */
  speakerOff?: boolean;
  /** HPJACKDETECT: headphone jack with switch (Classic, pin D8). */
  headphones?: boolean;
  /** USE_TRAEGER_PLATINE_SHUTDOWN: shutdown pin D7 active-low, for CubieKid and the carrier board (Classic). Set by the wizard's shutdown question. */
  traeger?: boolean;
  preset?: PresetId;
  /** The MP3 player chip (mp3chip.ts); undefined or 'standard' as the official builds. */
  chip?: Mp3Chip;
  /** SPECIAL_START_SHORTCUT: starts with track 1 of folder 01 when A6 is high at the start, for an alarm clock (Classic). */
  alarm?: boolean;
  /** Preview: SerialWriteCard from TNG branch issue_345, the box writes cards sent over USB (writecard.ts, offerWriteCardPreview). */
  writeCard?: boolean;
}

export function isBaukastenBoard(board: BoardId | undefined): board is BaukastenBoard {
  return board === 'classic' || board === 'aio';
}

export function isBaukastenButtons(buttons: string | undefined): buttons is BaukastenButtons {
  return buttons === '3' || buttons === '5' || buttons === '3x3';
}

/* ---------------------------------------------------------------- texts */

export interface ExtraText {
  label: string;
  /** One plain sentence what it does. */
  text: string;
  /** What has to be soldered in, or undefined when nothing. */
  parts?: string;
}

export const KNOB_TEXTS: Record<KnobKind, ExtraText> = {
  encoder: {
    label: 'Drehregler',
    text: 'Drehen macht lauter oder leiser, Klicke für Klick, solange die Box spielt.',
    parts: 'Braucht einen Drehgeber (zum Beispiel KY-040) an A3 und A4.',
  },
  encoderSkip: {
    label: 'Drehregler mit Vor und Zurück',
    text: 'Schnell drehen ändert die Lautstärke. Ein einzelner Klick springt nach einer Sekunde zum nächsten oder vorigen Titel.',
    parts: 'Braucht einen Drehgeber (zum Beispiel KY-040) an A3 und A4.',
  },
  poti: {
    label: 'Lautstärke-Knopf ohne Raster (Poti)',
    text: 'Wie am alten Radio: Die Stellung des Knopfs ist die Lautstärke.',
    parts: 'Braucht ein Potentiometer an A3.',
  },
};

export const LIGHT_TEXTS: Record<LightKind, ExtraText> = {
  ring: {
    label: 'Leuchtring',
    text: 'Ein Ring aus 24 bunten Lämpchen zeigt, was die Box tut: grün pulsierend beim Warten, Regenbogen beim Spielen.',
    parts: 'Braucht einen NeoPixel-Ring an D5.',
  },
  ringVolume: {
    label: 'Leuchtring mit Lautstärke-Anzeige',
    text: 'Wie der Leuchtring. Dazu zeigt er beim Lauter- und Leiserstellen kurz die Lautstärke und leuchtet in der letzten Minute vor dem Ausschalten orange, immer schwächer.',
    parts: 'Braucht einen NeoPixel-Ring an D5.',
  },
  ledButtons: {
    label: 'Leuchtende Tasten',
    text: 'Die Lämpchen in den Tasten blinken beim Warten, leuchten beim Spielen, und in der Pause blinkt nur Play/Pause.',
    parts: 'Braucht Tasten mit Lämpchen an A5 (Play/Pause), D6 (Vor) und D5 (Zurück), jeweils mit Vorwiderstand.',
  },
};

export const SPEAKER_OFF_TEXT: ExtraText = {
  label: 'Lautsprecher stumm beim Ein- und Ausschalten',
  text: 'Kein Knacken und Rauschen mehr beim Ein- und Ausschalten. Steckt ein Kopfhörer, bleibt der Lautsprecher aus.',
  parts: 'Braucht eine Schaltung, die den Verstärker über D6 an- und ausschaltet.',
};

export const HEADPHONES_TEXT: ExtraText = {
  label: 'Kopfhörer-Erkennung',
  text: 'Die Box merkt, wenn ein Kopfhörer steckt, und nimmt dann die Lautstärke-Grenzen für Kopfhörer aus „Box einstellen“.',
  parts: 'Braucht eine Kopfhörerbuchse mit Schaltkontakt an D8.',
};

/**
 * SPECIAL_START_SHORTCUT (constants.hpp:352–371): at its start the Classic
 * reads A6 with analogRead, 512 or more counts as high (tonuino.cpp:136–151),
 * and then plays folder 1, track 1 as a single track (state_machine.cpp:
 * 787–788) instead of the start shortcut or the pling (648–685). Only at the
 * start. TNG's config template of PR #343 calls it "Soundtrack als
 * Weckersignal (HW erforderlich, externer Wecker mit Signalausgang)".
 */
export const ALARM_TEXT: ExtraText = {
  label: 'Wecker-Start',
  text: 'Schaltet ein Wecker die Box ein, spielt sie gleich den ersten Titel aus Ordner 01.',
  parts: 'Braucht einen Wecker mit Signalausgang an A6: Beim Einschalten muss dort mehr als die halbe Spannung (2,5 V) anliegen.',
};

/**
 * The preview of TNG's serial WRITECARD (donschoof's code, TNG branch
 * issue_345, not in an official release yet; TODO #93). Said honestly: a
 * preview until the official firmware can do it.
 */
export const WRITE_CARD_TEXT: ExtraText = {
  label: 'Vorschau: Karten über die Box beschreiben',
  text: 'Ich schicke die Karte per USB an die Box, und die Box schreibt sie selbst. Das ist eine Vorschau, bis die offizielle Firmware das kann: Der Code ist von donschoof und liegt bei TonUINO TNG erst in einem Arbeitszweig. Sonst ist es die normale TNG; Karten und Einstellungen bleiben, wie sie sind.',
  parts: 'Braucht kein Bauteil, nur das USB-Kabel zum Computer.',
};

/**
 * D6 of the Classic (constants.hpp): SPKONOFF switches the amplifier there
 * (284), USE_LED_BUTTONS has the LED of „Vor“ there (509), BT_MODULE switches
 * the module on there while the MP3 player is on D2/D3 (386; D2 when it is on
 * the hardware serial D0/D1 of a Nano Every, 381–383). Forum 14770#2: SPKONOFF
 * is fine as long as D6 is not used otherwise. Only one of them can have D6.
 */
export const D6_WARNING =
  'D6 kann nur eins: den Verstärker an- und ausschalten (SPKONOFF, gegen das Knacken), das Lämpchen der Vor-Taste (leuchtende Tasten) oder ein Bluetooth-Modul einschalten. Schließe an D6 nur eins davon an.';

export const PRESET_TEXTS: Record<PresetId, ExtraText> = {
  standard: { label: 'Wie gewohnt', text: 'Die Box verhält sich wie mit der fertigen Firmware.' },
  weiter: {
    label: 'Weitermachen',
    text: 'Dieselbe Karte noch mal auflegen fängt nicht von vorn an, in der Pause geht es weiter. Play/Pause ohne Karte spielt die letzte Karte, auch nach dem Ausschalten.',
  },
};

/* ---------------------------------------------------------------- rules */

const NOT_HERE = 'Geht bei dieser Platine nicht.';

/**
 * Why a knob cannot be chosen, or undefined. Pins (constants.hpp): encoder
 * CLK A3, DT A4; poti A3 on Classic and AiO. With 5 buttons A3 and A4 are
 * buttons on both boards; with the 3x3 field the Classic has the field on A3,
 * the AiO its Vor/Zurück buttons on A3 and A4.
 */
export function knobBlocker(board: BaukastenBoard, buttons: BaukastenButtons): string | undefined {
  if (buttons === '5') return 'Geht nur mit 3 Tasten: Bei 5 Tasten hängen an A3 und A4 schon Tasten.';
  if (buttons === '3x3') return board === 'classic' ? 'Geht nur mit 3 Tasten: Das 3×3-Tastenfeld hängt schon an A3.' : 'Geht nur mit 3 Tasten: Beim 3×3-Tastenfeld hängen an A3 und A4 schon Tasten.';
  return undefined;
}

/**
 * Why a light cannot be chosen, or undefined. The ring (D5) does not fit into
 * the AiO's flash; the LED buttons need A5, which is the AiO's USB access pin,
 * and share D6 with the speaker switch-off on the Classic.
 */
export function lightBlocker(board: BaukastenBoard, light: LightKind, choice: ExtrasChoice): string | undefined {
  const plain = onlyPlain(choice);
  if (board === 'classic' && plain) return plain;
  if (board === 'aio') return light === 'ledButtons' ? 'Geht bei der AiO nicht: A5 ist dort schon belegt.' : 'Passt bei der AiO nicht mehr in den Speicher.';
  if (light === 'ledButtons' && choice.speakerOff) return 'Geht nicht zusammen mit „Lautsprecher stumm“: Beide brauchen D6.';
  return undefined;
}

export function speakerOffBlocker(board: BaukastenBoard, choice: ExtrasChoice): string | undefined {
  if (board === 'aio') return 'Hat die AiO schon eingebaut.';
  const plain = onlyPlain(choice);
  if (plain) return plain;
  if (choice.light === 'ledButtons') return 'Geht nicht zusammen mit „Leuchtende Tasten“: Beide brauchen D6.';
  return undefined;
}

/** On the AiO, D8 switches its amplifier (constants.hpp ALLinONE ampEnablePin = 8). */
export function headphonesBlocker(board: BaukastenBoard, choice: ExtrasChoice = {}): string | undefined {
  if (board === 'aio') return NOT_HERE + ' D8 schaltet dort den Verstärker.';
  return onlyPlain(choice);
}

/**
 * Why another MP3 chip cannot go with the rest, or undefined. The chip builds
 * exist for the common boxes only (knob, carrier board, "Weitermachen"):
 * all chips times all extras would be four times the builds in the app.
 */
export function chipBlocker(choice: ExtrasChoice): string | undefined {
  if (choice.light || choice.speakerOff || choice.headphones) return PLAIN_ONLY;
  if (choice.alarm) return ALARM_ONLY_PLAIN;
  if (choice.writeCard) return WRITE_CARD_ONLY_PLAIN;
  return undefined;
}

/** The alarm start: Classic only, and like the chip only for the common builds. */
export function alarmBlocker(board: BaukastenBoard, choice: ExtrasChoice): string | undefined {
  if (board === 'aio') return NOT_HERE;
  if (choice.light || choice.speakerOff || choice.headphones) return PLAIN_ONLY;
  if (choice.chip && choice.chip !== 'standard') return CHIP_ONLY_PLAIN;
  if (choice.writeCard) return WRITE_CARD_ONLY_PLAIN;
  return undefined;
}

/**
 * The preview of writing cards over USB: like the chip only for the common
 * builds (another TNG commit, so every combination is a build of its own),
 * not with another chip or the alarm start. Whether it is offered at all
 * decides offerWriteCardPreview().
 */
export function writeCardBlocker(choice: ExtrasChoice): string | undefined {
  if (choice.light || choice.speakerOff || choice.headphones) return PLAIN_ONLY;
  if (choice.chip && choice.chip !== 'standard') return CHIP_ONLY_PLAIN;
  if (choice.alarm) return ALARM_ONLY_PLAIN;
  return undefined;
}

const PLAIN_ONLY = 'Gibt es nur ohne Licht, „Lautsprecher stumm“ und Kopfhörer-Erkennung.';

/** What another chip rules out (see chipBlocker). */
const CHIP_ONLY_PLAIN = 'Geht nicht zusammen mit einem anderen MP3-Player-Chip.';
const ALARM_ONLY_PLAIN = `Geht nicht zusammen mit „${ALARM_TEXT.label}“.`;
const WRITE_CARD_ONLY_PLAIN = 'Geht nicht zusammen mit der Vorschau „Karten über die Box beschreiben“.';

/** What another chip, the alarm start or the write-card preview rules out: light, speaker switch-off and headphones. */
function onlyPlain(choice: ExtrasChoice): string | undefined {
  if (choice.chip && choice.chip !== 'standard') return CHIP_ONLY_PLAIN;
  if (choice.alarm) return ALARM_ONLY_PLAIN;
  return choice.writeCard ? WRITE_CARD_ONLY_PLAIN : undefined;
}

export function traegerBlocker(board: BaukastenBoard): string | undefined {
  return board === 'aio' ? 'Die AiO schaltet sich mit ihrer eigenen Schaltung aus.' : undefined;
}

/** The choice without what this board and button count cannot have. */
export function normalizeChoice(board: BaukastenBoard, buttons: BaukastenButtons, choice: ExtrasChoice): ExtrasChoice {
  const out: ExtrasChoice = {};
  if (choice.knob && !knobBlocker(board, buttons)) out.knob = choice.knob;
  if (choice.speakerOff && !speakerOffBlocker(board, {})) out.speakerOff = true;
  if (choice.light && !lightBlocker(board, choice.light, out)) out.light = choice.light;
  if (choice.headphones && !headphonesBlocker(board)) out.headphones = true;
  if (choice.traeger && !traegerBlocker(board)) out.traeger = true;
  if (choice.preset && choice.preset !== 'standard') out.preset = choice.preset;
  // Last: the extras above that were ticked first win over the chip and the alarm start.
  if (choice.chip && choice.chip !== 'standard' && !chipBlocker(out)) out.chip = choice.chip;
  if (choice.alarm && !alarmBlocker(board, out)) out.alarm = true;
  if (choice.writeCard && !writeCardBlocker(out)) out.writeCard = true;
  return out;
}

/** True when nothing is switched on: then the official build is the right one. */
export function isPlain(choice: ExtrasChoice): boolean {
  return !choice.knob && !choice.light && !choice.speakerOff && !choice.headphones && !choice.traeger && (choice.preset ?? 'standard') === 'standard' && (choice.chip ?? 'standard') === 'standard' && !choice.alarm && !choice.writeCard;
}

/** Build id as the build script names it, e.g. "classic-3-encoder-ring-weiter". */
export function buildId(board: BaukastenBoard, buttons: BaukastenButtons, choice: ExtrasChoice): string {
  const parts: string[] = [board, buttons];
  if (choice.knob) parts.push(choice.knob);
  if (choice.light) parts.push(choice.light);
  if (choice.speakerOff) parts.push('speakerOff');
  if (choice.headphones) parts.push('headphones');
  if (choice.traeger) parts.push('traeger');
  if (choice.preset && choice.preset !== 'standard') parts.push(choice.preset);
  if (choice.chip && choice.chip !== 'standard') parts.push(choice.chip);
  if (choice.alarm) parts.push('alarm');
  if (choice.writeCard) parts.push('writeCard');
  return parts.join('-');
}

/**
 * Every choice the rules allow for a board and button count (what the build
 * script should have built). `writeCard`: whether the write-card preview is
 * built (offerWriteCardPreview of the manifest).
 */
export function allowedChoices(board: BaukastenBoard, buttons: BaukastenButtons, opts: { writeCard?: boolean } = {}): ExtrasChoice[] {
  const out: ExtrasChoice[] = [];
  const knobs: (KnobKind | undefined)[] = [undefined, 'encoder', 'encoderSkip', 'poti'];
  const lights: (LightKind | undefined)[] = [undefined, 'ring', 'ringVolume', 'ledButtons'];
  for (const knob of knobs) {
    if (knob && knobBlocker(board, buttons)) continue;
    for (const light of lights) {
      for (const speakerOff of [false, true]) {
        if (speakerOff && speakerOffBlocker(board, { light })) continue;
        if (light && lightBlocker(board, light, { speakerOff })) continue;
        for (const headphones of [false, true]) {
          if (headphones && headphonesBlocker(board)) continue;
          for (const traeger of [false, true]) {
            if (traeger && traegerBlocker(board)) continue;
            for (const preset of ['standard', 'weiter'] as PresetId[]) {
              for (const chip of ['standard', ...OTHER_CHIPS] as Mp3Chip[]) {
                for (const alarm of [false, true]) {
                  const c: ExtrasChoice = {};
                  if (knob) c.knob = knob;
                  if (light) c.light = light;
                  if (speakerOff) c.speakerOff = true;
                  if (headphones) c.headphones = true;
                  if (traeger) c.traeger = true;
                  if (preset !== 'standard') c.preset = preset;
                  if (chip !== 'standard') {
                    if (chipBlocker(c)) continue;
                    c.chip = chip;
                  }
                  if (alarm) {
                    if (alarmBlocker(board, c)) continue;
                    c.alarm = true;
                  }
                  out.push(c);
                  if (opts.writeCard && !writeCardBlocker(c)) out.push({ ...c, writeCard: true });
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------- manifest */

export interface BaukastenBuild {
  id: string;
  board: BaukastenBoard;
  buttons: BaukastenButtons;
  knob: KnobKind | null;
  light: LightKind | null;
  speakerOff: boolean;
  headphones: boolean;
  traeger: boolean;
  preset: PresetId;
  /** The MP3 player chip; missing in manifests from before 0.3.1 (then 'standard'). */
  chip?: Mp3Chip;
  /** The alarm start (SPECIAL_START_SHORTCUT); missing in older manifests (then false). */
  alarm?: boolean;
  /** The write-card preview (SerialWriteCard, built from manifest.writeCardPreview); missing in older manifests (then false). */
  writeCard?: boolean;
  /** The official environment it extends, e.g. "TonUINO_Classic_3". */
  env: string;
  /** Every -D flag of the build. */
  defines: string[];
  /** Size of the flash image. */
  bytes: number;
  /** Static RAM (.data + .bss). */
  ram: number;
  fits: boolean;
  /** Classic only: bigger than 30720 bytes, so only for a Nano with the new bootloader (Optiboot). */
  needsNewBootloader: boolean;
  /** SHA-256 of the flash image (hex). */
  sha256: string;
  /** The pack file and where the image starts in the unpacked pack. */
  pack: string;
  offset: number;
}

/** Where the write-card preview builds come from (GPL: repository, commit, flags). */
export interface WriteCardPreviewSource {
  /** Key in `sources`. */
  source: string;
  repository: string;
  commit: string;
  branch: string;
  versionString: string;
  /** Who wrote the serial command. */
  author: string;
  pullRequests: string[];
  license: string;
  defines: string[];
}

export interface BaukastenManifest {
  format: 1;
  /** `writeCard`: the TNG commit of all builds has WRITECARD itself (then there is no preview). */
  tng: { version: string; versionString: string; repository: string; commit: string; license: string; writeCard?: boolean };
  /** The write-card preview; missing when there is none (older manifests, or once official TNG has the command). */
  writeCardPreview?: WriteCardPreviewSource;
  sources: Record<string, { repository: string; commit: string }>;
  toolchain: Record<string, string>;
  flags: Record<string, string[]>;
  script: string;
  notFitting: string[];
  builds: BaukastenBuild[];
}

/** Where the files lie next to the app (public/firmware/baukasten). */
export const BAUKASTEN_DIR = 'firmware/baukasten/';

/**
 * THE place that decides whether the wizard offers „Vorschau: Karten über die
 * Box beschreiben“. The preview builds come from TNG's work branch
 * (manifest.writeCardPreview). Once an official TNG commit has WRITECARD, the
 * build script moves SOURCES["tng"] to it, sets TNG_HAS_WRITE_CARD (manifest
 * tng.writeCard) and stops building the preview; then this is false and the
 * choice disappears, also for a manifest that still lists old preview builds.
 * Boxes are told apart by asking them (WRITECARD CANCEL after connecting,
 * logsession.ts), not by this, so a box with an official build keeps writing
 * cards without any change in the app.
 */
export function offerWriteCardPreview(manifest: BaukastenManifest): boolean {
  return !manifest.tng.writeCard && !!manifest.writeCardPreview && manifest.builds.some((b) => b.writeCard);
}

export function findBuild(manifest: BaukastenManifest, id: string): BaukastenBuild | undefined {
  return manifest.builds.find((b) => b.id === id);
}

export type ChoiceStatus =
  | { kind: 'ok'; build: BaukastenBuild }
  /** Allowed by the pins, but together it does not fit into the flash. */
  | { kind: 'too-big' }
  /** Not built (should not happen for allowed choices). */
  | { kind: 'missing' };

export function choiceStatus(manifest: BaukastenManifest, board: BaukastenBoard, buttons: BaukastenButtons, choice: ExtrasChoice): ChoiceStatus {
  const id = buildId(board, buttons, normalizeChoice(board, buttons, choice));
  const build = findBuild(manifest, id);
  if (build) return { kind: 'ok', build };
  return manifest.notFitting.includes(id) ? { kind: 'too-big' } : { kind: 'missing' };
}

/** File name for saving, e.g. "TonUINO_Classic_3_drehregler.hex". */
export function baukastenFileName(build: BaukastenBuild): string {
  return `TonUINO-TNG_${build.id}.hex`;
}

/** What the source line says: TNG version, commit and flags (GPL: where the firmware comes from). */
export function sourceText(manifest: BaukastenManifest, build: BaukastenBuild): string {
  const extra = build.defines.filter((d) => !/^(F_CPU|CLOCK_SOURCE|SERIAL_RX_BUFFER_SIZE|ARDUINO|ARDUINO_ARCH_AVR|ARDUINO_AVR_\w+|__IN_VS_CODE__)\b/.test(d));
  const preview = build.writeCard ? manifest.writeCardPreview : undefined;
  if (preview) {
    return `TonUINO TNG ${manifest.tng.version} (${preview.repository}, Branch ${preview.branch}, Commit ${preview.commit.slice(0, 7)}, Kartenschreiben von ${preview.author}, freie Software unter der ${preview.license}), gebaut mit ${extra.map((d) => `-D ${d}`).join(' ')}`;
  }
  return `TonUINO TNG ${manifest.tng.version} (${manifest.tng.repository}, Commit ${manifest.tng.commit.slice(0, 7)}, freie Software unter der ${manifest.tng.license}), gebaut mit ${extra.map((d) => `-D ${d}`).join(' ')}`;
}

/* --------------------------------------------------------------- loading */

export type LocalFetch = (url: string) => Promise<Response>;

export class BaukastenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaukastenError';
  }
}

export async function loadManifest(fetchFn: LocalFetch, base: string): Promise<BaukastenManifest> {
  const res = await fetchFn(`${base}${BAUKASTEN_DIR}manifest.json`);
  if (!res.ok) throw new BaukastenError(`manifest.json: HTTP ${res.status}`);
  const m = (await res.json()) as BaukastenManifest;
  if (m.format !== 1 || !Array.isArray(m.builds)) throw new BaukastenError('manifest.json: unknown format');
  return m;
}

/**
 * Unpacks a gzip file with the platform's DecompressionStream (no library
 * needed). A web server that sends .gz files with "Content-Encoding: gzip"
 * has the browser unpack them already: then the bytes come back as they are.
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The pack unpacked last: choosing another extra mostly stays in the same pack. */
let lastPack: { url: string; data: Promise<Uint8Array> } | null = null;

async function loadPack(fetchFn: LocalFetch, url: string): Promise<Uint8Array> {
  if (lastPack?.url === url) return lastPack.data;
  const data = (async () => {
    const res = await fetchFn(url);
    if (!res.ok) throw new BaukastenError(`${url}: HTTP ${res.status}`);
    return gunzip(new Uint8Array(await res.arrayBuffer()));
  })();
  lastPack = { url, data };
  data.catch(() => {
    if (lastPack?.data === data) lastPack = null;
  });
  return data;
}

/** Loads one build and checks its checksum. The image starts at address 0 (Classic and AiO have the bootloader at the end). */
export async function loadBuildImage(fetchFn: LocalFetch, base: string, build: BaukastenBuild): Promise<HexImage> {
  const pack = await loadPack(fetchFn, `${base}${BAUKASTEN_DIR}${build.pack}`);
  const data = pack.slice(build.offset, build.offset + build.bytes);
  if (data.length !== build.bytes || (await sha256Hex(data)) !== build.sha256) throw new BaukastenError(`${build.id}: checksum does not match`);
  return { data, startAddress: 0, byteCount: data.length };
}

/**
 * Which Baukasten build a flash image is, e.g. the old firmware read from a
 * box before an upload, or a saved file. The image may be longer than the
 * build (read flash ends in erased 0xff bytes). Undefined for any other
 * firmware, the official builds included.
 */
export async function identifyBuild(manifest: BaukastenManifest, data: Uint8Array): Promise<BaukastenBuild | undefined> {
  // Erased flash after the firmware does not count.
  let end = data.length;
  while (end > 0 && data[end - 1] === 0xff) end--;
  const byLength = new Map<number, BaukastenBuild[]>();
  for (const b of manifest.builds) {
    // The image itself may end in 0xff bytes.
    if (b.bytes < end || b.bytes > data.length) continue;
    byLength.set(b.bytes, [...(byLength.get(b.bytes) ?? []), b]);
  }
  for (const [length, builds] of byLength) {
    const sha = await sha256Hex(data.subarray(0, length));
    const hit = builds.find((b) => b.sha256 === sha);
    if (hit) return hit;
  }
  return undefined;
}

/* ------------------------------------------------------------ summaries */

/** Short German list of what is switched on, e.g. "Drehregler, Leuchtring, Weitermachen". */
export function choiceSummary(choice: ExtrasChoice): string {
  const parts: string[] = [];
  if (choice.knob) parts.push(KNOB_TEXTS[choice.knob].label);
  if (choice.light) parts.push(LIGHT_TEXTS[choice.light].label);
  if (choice.speakerOff) parts.push(SPEAKER_OFF_TEXT.label);
  if (choice.headphones) parts.push(HEADPHONES_TEXT.label);
  if (choice.traeger) parts.push('Abschaltung für CubieKid- oder Trägerplatine');
  if (choice.preset && choice.preset !== 'standard') parts.push(PRESET_TEXTS[choice.preset].label);
  if (choice.chip && choice.chip !== 'standard') parts.push(CHIP_TEXTS[choice.chip].label);
  if (choice.alarm) parts.push(ALARM_TEXT.label);
  if (choice.writeCard) parts.push(WRITE_CARD_TEXT.label);
  return parts.join(', ');
}

/** The choice a build was made from. */
export function choiceOf(build: BaukastenBuild): ExtrasChoice {
  const c: ExtrasChoice = {};
  if (build.knob) c.knob = build.knob;
  if (build.light) c.light = build.light;
  if (build.speakerOff) c.speakerOff = true;
  if (build.headphones) c.headphones = true;
  if (build.traeger) c.traeger = true;
  if (build.preset !== 'standard') c.preset = build.preset;
  if (build.chip && build.chip !== 'standard') c.chip = build.chip;
  if (build.alarm) c.alarm = true;
  if (build.writeCard) c.writeCard = true;
  return c;
}
