#!/usr/bin/env bash
# Builds the Linux packages of TonUINO Studio from a fresh checkout:
# a .deb package and an AppImage. Details: docs/BUILD.md
#
# Usage: scripts/build-linux.sh
# Optional environment:
#   CARGO_TARGET_DIR  where cargo writes build output (default: src-tauri/target)
#   CARGO_BUILD_JOBS  number of parallel compiler jobs
#   GSTREAMER_PLUGINS_DIR, GSTREAMER_HELPERS_DIR
#                     GStreamer plugins and gst-plugin-scanner for the AppImage,
#                     if they are not in the Debian/Ubuntu folders
#   VITE_WEB_ORIGIN, VITE_SOURCES_INDEX_URL, VITE_SOURCES_CONTACT
#                     settings of "Entdecken", passed on to the build of the
#                     front end (docs/BUILD.md, section "Entdecken")
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=lib/common.sh
source scripts/lib/common.sh

case "${1:-}" in
  '') ;;
  -h | --help)
    echo 'Aufruf: scripts/build-linux.sh   (Details in docs/BUILD.md)'
    exit 0
    ;;
  *) die "Unbekannte Angabe '$1'. Aufruf: scripts/build-linux.sh" ;;
esac
(($# <= 1)) || die 'Zu viele Argumente. Aufruf: scripts/build-linux.sh'

step 'Voraussetzungen prüfen'
[[ "$(uname -s)" == Linux ]] || die 'Dieses Skript baut die Linux-Pakete und läuft nur unter Linux.'
case "$(uname -m)" in
  x86_64) DEB_ARCH=amd64 APPIMAGE_ARCH=amd64 ;;
  aarch64) DEB_ARCH=arm64 APPIMAGE_ARCH=aarch64 ;;
  *) die "Die Rechner-Architektur $(uname -m) wird nicht unterstützt (nur x86_64 und aarch64)." ;;
esac

require_node
require_rust
require_cmd cc 'Unter Debian/Ubuntu: sudo apt install build-essential'
require_cmd pkg-config 'Unter Debian/Ubuntu: sudo apt install pkg-config'
# pkg-config module and the Debian/Ubuntu package that provides it
for entry in webkit2gtk-4.1:libwebkit2gtk-4.1-dev javascriptcoregtk-4.1:libwebkit2gtk-4.1-dev \
  libsoup-3.0:libwebkit2gtk-4.1-dev gtk+-3.0:libgtk-3-dev libudev:libudev-dev libpcsclite:libpcsclite-dev alsa:libasound2-dev; do
  require_pkg_config "${entry%%:*}" "Unter Debian/Ubuntu: sudo apt install ${entry#*:}"
done

# The AppImage carries its own GStreamer plugins (bundleMediaFramework in
# tauri.conf.json), so the MP3 preview does not depend on the host's plugins
# matching the bundled libgstreamer. linuxdeploy's GStreamer plugin copies every
# plugin from GST_PLUGINS_DIR and the helpers from GST_HELPERS_DIR and needs
# patchelf and file for that. Both folders are the plugin's defaults and can be
# changed with GSTREAMER_PLUGINS_DIR and GSTREAMER_HELPERS_DIR.
require_cmd patchelf 'Unter Debian/Ubuntu: sudo apt install patchelf'
require_cmd file 'Unter Debian/Ubuntu: sudo apt install file'
GST_PLUGINS_DIR="${GSTREAMER_PLUGINS_DIR:-/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0}"
if [[ -z "${GSTREAMER_PLUGINS_DIR:-}" && ! -d "$GST_PLUGINS_DIR" ]]; then
  GST_PLUGINS_DIR=/usr/lib/gstreamer-1.0
fi
GST_HELPERS_DIR="${GSTREAMER_HELPERS_DIR:-/usr/lib/$(uname -m)-linux-gnu/gstreamer1.0/gstreamer-1.0}"
# Plugins the audio preview needs (playbin, MP3 parser and decoder, conversion,
# PulseAudio output, which PipeWire also serves through pipewire-pulse), each
# with the Debian/Ubuntu package that provides it.
for entry in coreelements:libgstreamer1.0-0 playback:gstreamer1.0-plugins-base \
  typefindfunctions:gstreamer1.0-plugins-base app:gstreamer1.0-plugins-base \
  audioconvert:gstreamer1.0-plugins-base audioresample:gstreamer1.0-plugins-base \
  volume:gstreamer1.0-plugins-base autodetect:gstreamer1.0-plugins-good \
  pulseaudio:gstreamer1.0-plugins-good audioparsers:gstreamer1.0-plugins-good \
  id3demux:gstreamer1.0-plugins-good mpg123:gstreamer1.0-plugins-good; do
  [[ -f "$GST_PLUGINS_DIR/libgst${entry%%:*}.so" ]] ||
    MISSING+=("GStreamer-Plugin '${entry%%:*}' fehlt in $GST_PLUGINS_DIR. Unter Debian/Ubuntu: sudo apt install ${entry#*:}")
done
[[ -x "$GST_HELPERS_DIR/gst-plugin-scanner" ]] ||
  MISSING+=("gst-plugin-scanner fehlt in $GST_HELPERS_DIR. Unter Debian/Ubuntu: sudo apt install libgstreamer1.0-0, sonst GSTREAMER_HELPERS_DIR setzen.")
require_cmd dpkg-deb 'Unter Debian/Ubuntu: Teil des Pakets dpkg.'
finish_checks

# Direct ALSA and PipeWire output are optional: without them the AppImage plays
# through PulseAudio only.
for entry in alsa:gstreamer1.0-alsa pipewire:gstreamer1.0-pipewire; do
  [[ -f "$GST_PLUGINS_DIR/libgst${entry%%:*}.so" ]] ||
    note "GStreamer-Plugin '${entry%%:*}' fehlt, das AppImage gibt Ton dann nur über PulseAudio aus. Nachrüsten: sudo apt install ${entry#*:}"
done

TOOLS_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
if ! compgen -G "$TOOLS_DIR/linuxdeploy-*.AppImage" >/dev/null; then
  note "Für das AppImage lädt tauri beim ersten Mal linuxdeploy und AppRun von github.com nach $TOOLS_DIR."
fi

install_and_build_frontend linux

step 'Desktop-App bauen und Pakete erstellen (tauri build: .deb und AppImage)'
npm run tauri -- build --bundles deb,appimage --config "$TAURI_SKIP_FRONTEND_BUILD"

read_app_info
read_cargo_info
BUNDLE_DIR="$TARGET_DIR/release/bundle"
DEB_FILE="$BUNDLE_DIR/deb/${PRODUCT_NAME}_${APP_VERSION}_${DEB_ARCH}.deb"
APPIMAGE_FILE="$BUNDLE_DIR/appimage/${PRODUCT_NAME}_${APP_VERSION}_${APPIMAGE_ARCH}.AppImage"

# tauri names the Debian package after productName in kebab case, which turns
# "TonUINO Studio" into "ton-uino-studio". Program, icon and udev rule are
# called like the binary (tonuino-studio), so the package gets that name too.
step "Paketnamen im .deb auf $BIN_NAME setzen"
rename_deb_package "$DEB_FILE" "$BIN_NAME"

step 'Fertig'
report_artifact '.deb-Paket' "$DEB_FILE"
report_artifact 'AppImage' "$APPIMAGE_FILE"
report_artifact 'Programm' "$TARGET_DIR/release/$BIN_NAME"
