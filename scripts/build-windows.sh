#!/usr/bin/env bash
# Builds the Windows x64 installer (NSIS, .exe) of TonUINO Studio on Linux,
# from a fresh checkout. Details: docs/BUILD.md
#
# Usage: scripts/build-windows.sh [gnu|msvc]
#   gnu   (default) Rust target x86_64-pc-windows-gnu, MinGW-w64 as C compiler
#         and linker. Needs nothing from Microsoft's servers.
#   msvc  Rust target x86_64-pc-windows-msvc with cargo-xwin as cargo runner,
#         as in Tauri's guide for Windows installers on Linux. cargo-xwin
#         downloads the Microsoft C runtime and the Windows SDK on the first
#         run, so this only works on machines that reach Microsoft's servers.
# Optional environment:
#   CARGO_TARGET_DIR  where cargo writes build output (default: src-tauri/target)
#   CARGO_BUILD_JOBS  number of parallel compiler jobs
#   XWIN_CACHE_DIR    msvc only: where cargo-xwin keeps the Microsoft CRT and
#                     Windows SDK (default: ~/.cache/cargo-xwin)
#   VITE_WEB_ORIGIN, VITE_SOURCES_INDEX_URL, VITE_SOURCES_CONTACT
#                     settings of "Entdecken", passed on to the build of the
#                     front end (docs/BUILD.md, section "Entdecken")
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=lib/common.sh
source scripts/lib/common.sh

USAGE='Aufruf: scripts/build-windows.sh [gnu|msvc]   (ohne Angabe: gnu; Details in docs/BUILD.md)'
(($# <= 1)) || die "Zu viele Argumente. $USAGE"
TOOLCHAIN="${1:-gnu}"
case "$TOOLCHAIN" in
  gnu) WINDOWS_TARGET=x86_64-pc-windows-gnu ;;
  msvc) WINDOWS_TARGET=x86_64-pc-windows-msvc ;;
  -h | --help)
    echo "$USAGE"
    exit 0
    ;;
  *) die "Unbekannte Angabe '$TOOLCHAIN'. $USAGE" ;;
esac

step "Voraussetzungen prüfen ($WINDOWS_TARGET)"
[[ "$(uname -s)" == Linux ]] || die 'Dieses Skript baut den Windows-Installer unter Linux. Unter Windows reicht: npm ci && npm run tauri build'

require_node
require_rust
require_cmd makensis 'Unter Debian/Ubuntu: sudo apt install nsis'
if [[ "$TOOLCHAIN" == gnu ]]; then
  MINGW_HINT='Unter Debian/Ubuntu: sudo apt install gcc-mingw-w64-x86-64'
  require_cmd x86_64-w64-mingw32-gcc "$MINGW_HINT"
  require_cmd x86_64-w64-mingw32-windres "$MINGW_HINT"
  require_cmd x86_64-w64-mingw32-objdump "$MINGW_HINT"
else
  LLVM_HINT='Unter Debian/Ubuntu: sudo apt install clang lld llvm'
  require_cmd cargo-xwin 'Einmal installieren: cargo install --locked cargo-xwin'
  require_cmd clang "$LLVM_HINT"
  require_cmd lld-link "$LLVM_HINT"
  require_cmd llvm-rc "$LLVM_HINT"
fi
if command -v rustc >/dev/null 2>&1 && [[ ! -d "$(rustc --print sysroot)/lib/rustlib/$WINDOWS_TARGET/lib" ]]; then
  MISSING+=("Das Rust-Ziel $WINDOWS_TARGET fehlt. Installieren: rustup target add $WINDOWS_TARGET")
fi
finish_checks

RUNNER_ARGS=()
if [[ "$TOOLCHAIN" == msvc ]]; then
  RUNNER_ARGS=(--runner cargo-xwin)
  # Only x64 is built, so cargo-xwin needs only the x64 parts of the CRT and SDK.
  export XWIN_ARCH="${XWIN_ARCH:-x86_64}"
  XWIN_DIR="${XWIN_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/cargo-xwin}/xwin"
  if [[ ! -f "$XWIN_DIR/DONE" ]]; then
    note "cargo-xwin lädt beim ersten Mal die Microsoft-C-Laufzeit und das Windows SDK nach $XWIN_DIR (einige hundert MB, Lizenz von Microsoft)."
  fi
fi
TOOLS_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
if [[ ! -f "$TOOLS_DIR/NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll" ]]; then
  note "tauri lädt beim ersten Mal das NSIS-Plugin nsis_tauri_utils.dll von github.com nach $TOOLS_DIR."
fi
# Only with webviewInstallMode embedBootstrapper (see docs/BUILD.md) does tauri
# fetch Microsoft's WebView2 bootstrapper at build time.
WEBVIEW2_MODE="$(node -p 'require("./src-tauri/tauri.conf.json").bundle?.windows?.webviewInstallMode?.type ?? ""')"
if [[ "$WEBVIEW2_MODE" == embedBootstrapper && ! -f "$TOOLS_DIR/MicrosoftEdgeWebview2Setup.exe" ]]; then
  note "tauri lädt beim ersten Mal den WebView2-Bootstrapper von go.microsoft.com nach $TOOLS_DIR."
fi

prepare_updater
install_and_build_frontend windows

step "Windows-App bauen und Installer erstellen (tauri build für $WINDOWS_TARGET)"
npm run tauri -- build "${RUNNER_ARGS[@]}" --target "$WINDOWS_TARGET" --bundles nsis --config "$TAURI_SKIP_FRONTEND_BUILD" ${UPDATER_ARGS[@]+"${UPDATER_ARGS[@]}"}

read_app_info
read_cargo_info
OUT_DIR="$TARGET_DIR/$WINDOWS_TARGET/release"
EXE="$OUT_DIR/$BIN_NAME.exe"

step 'Fertig'
report_artifact 'Installer' "$OUT_DIR/bundle/nsis/${PRODUCT_NAME}_${APP_VERSION}_x64-setup.exe"
((${#UPDATER_ARGS[@]} == 0)) || report_artifact 'Signatur' "$OUT_DIR/bundle/nsis/${PRODUCT_NAME}_${APP_VERSION}_x64-setup.exe.sig"
report_artifact 'Programm' "$EXE"

if [[ "$TOOLCHAIN" == gnu ]]; then
  # With the GNU target the program loads WebView2 through WebView2Loader.dll.
  # tauri-build puts it next to the .exe and the installer copies it along.
  report_artifact 'WebView2Loader' "$OUT_DIR/WebView2Loader.dll"

  # The program may import only Windows' own DLLs and WebView2Loader.dll.
  # MinGW runtime DLLs (libgcc_s_*, libstdc++-*, libwinpthread-*, all named
  # lib*.dll) would be missing on the user's PC and must be linked statically.
  IMPORTS="$(x86_64-w64-mingw32-objdump -p "$EXE" | sed -n 's/^[[:space:]]*DLL Name: //p' | sort -fu)"
  printf '  %-14s %s\n' 'DLL-Importe' "$(tr '\n' ' ' <<<"$IMPORTS")"
  if grep -qi '^lib' <<<"$IMPORTS"; then
    die "Das Programm braucht MinGW-Laufzeit-DLLs, die unter Windows fehlen: $(grep -i '^lib' <<<"$IMPORTS" | tr '\n' ' ')"
  fi
fi
