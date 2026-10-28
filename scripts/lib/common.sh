# Shared helpers for scripts/build-linux.sh and scripts/build-windows.sh.
# Source this file after `set -Eeuo pipefail`; it is not meant to be run.
# shellcheck shell=bash

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' RED=$'\e[31m' YELLOW=$'\e[33m' GREEN=$'\e[32m' RESET=$'\e[0m'
else
  BOLD='' RED='' YELLOW='' GREEN='' RESET=''
fi

CURRENT_STEP='Vorbereitung'
MISSING=()

step() {
  CURRENT_STEP="$1"
  printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"
}

note() {
  printf '%sHinweis:%s %s\n' "$YELLOW" "$RESET" "$*"
}

die() {
  printf '\n%sFEHLER:%s %s\n' "$RED$BOLD" "$RESET" "$*" >&2
  exit 1
}

# Any failing command ends the script with the name of the step it was in.
# Called by hand with the exit code of a command whose failure was caught.
on_error() {
  local status="${1:-$?}"
  printf '\n%sFEHLER:%s Der Schritt "%s" ist fehlgeschlagen (Exit-Code %s).\n' \
    "$RED$BOLD" "$RESET" "$CURRENT_STEP" "$status" >&2
  printf 'Die Ursache steht in der Ausgabe darüber. Hilfe: docs/BUILD.md\n' >&2
  exit "$status"
}
trap on_error ERR

# Prerequisite checks collect everything that is missing and report it at once.
require_cmd() {
  local cmd="$1" hint="$2"
  command -v "$cmd" >/dev/null 2>&1 || MISSING+=("Programm '$cmd' fehlt. $hint")
}

require_pkg_config() {
  local module="$1" hint="$2"
  command -v pkg-config >/dev/null 2>&1 || return 0 # reported by require_cmd
  pkg-config --exists "$module" 2>/dev/null || MISSING+=("Bibliothek '$module' (pkg-config) fehlt. $hint")
}

# Vite 8 needs Node.js ^20.19.0 or >=22.12.0.
require_node() {
  require_cmd node 'Node.js 22.12 oder neuer installieren (https://nodejs.org).'
  require_cmd npm 'npm wird mit Node.js installiert.'
  command -v node >/dev/null 2>&1 || return 0
  local version major minor
  version="$(node -p 'process.versions.node')"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  if ((major < 20 || major == 21 || (major == 20 && minor < 19) || (major == 22 && minor < 12))); then
    MISSING+=("Node.js $version ist zu alt. Nötig ist 20.19 oder 22.12 und neuer.")
  fi
}

require_rust() {
  require_cmd cargo 'Rust über https://rustup.rs installieren.'
  require_cmd rustc 'Rust über https://rustup.rs installieren.'
}

finish_checks() {
  if ((${#MISSING[@]} > 0)); then
    printf '\n%sFEHLER:%s Es fehlen Voraussetzungen für den Build:\n' "$RED$BOLD" "$RESET" >&2
    printf '  - %s\n' "${MISSING[@]}" >&2
    printf 'Was gebraucht wird, steht in docs/BUILD.md.\n' >&2
    exit 1
  fi
  echo 'Alles da.'
}

# Reads product name and version the same way tauri does
# (productName from tauri.conf.json, version from package.json).
read_app_info() {
  PRODUCT_NAME="$(node -p 'require("./src-tauri/tauri.conf.json").productName')"
  APP_VERSION="$(node -p 'require("./package.json").version')"
}

# Asks cargo for the target directory (honours CARGO_TARGET_DIR and
# .cargo/config) and the name of the app binary.
read_cargo_info() {
  local metadata
  metadata="$(cargo metadata --format-version 1 --no-deps --manifest-path src-tauri/Cargo.toml)"
  TARGET_DIR="$(node -e 'console.log(JSON.parse(process.argv[1]).target_directory)' "$metadata")"
  BIN_NAME="$(node -e '
    const pkg = JSON.parse(process.argv[1]).packages[0];
    console.log(pkg.targets.find((t) => t.kind.includes("bin")).name);
  ' "$metadata")"
}

# The check of "Entdecken" in vite.config.ts stopped the build. Prints what
# is missing (one problem per line in the report file) and how to go on.
sources_check_stopped() {
  local report="$1"
  printf '\n%sFEHLER:%s Die Prüfung für „Entdecken“ hat den Build gestoppt.\n' "$RED$BOLD" "$RESET" >&2
  printf 'Dieser Build zeigt „Entdecken“, weil eine Liste mitkommt oder eine Adresse für die Liste gesetzt ist. Dafür fehlt noch:\n' >&2
  sed 's/^/  - /' -- "$report" >&2
  rm -f -- "$report"
  cat >&2 <<EOF
So geht es weiter:
  - Setz die fehlenden Angaben und starte das Skript noch einmal, zum Beispiel so:
      VITE_SOURCES_CONTACT=quellen@example.org VITE_WEB_ORIGIN=https://studio.example.org $0
  - Oder bau ohne „Entdecken“: VITE_WEB_ORIGIN und VITE_SOURCES_INDEX_URL nicht setzen
    und SOURCES_SNAPSHOT=off setzen (ohne die mitgelieferte Liste).
Mehr dazu in docs/BUILD.md im Abschnitt „Entdecken“.
EOF
  exit 1
}

# Usage: install_and_build_frontend <linux|windows>
install_and_build_frontend() {
  local platform="$1" report status=0
  step 'npm-Pakete installieren (npm ci)'
  npm ci --prefer-offline --no-audit --no-fund

  # vite.config.ts turns source maps on for development. The packages embed
  # dist/ into the program, so they are built without them.
  # TAURI_ENV_PLATFORM is what the Tauri CLI sets when it runs
  # beforeBuildCommand itself. vite.config.ts reads it to keep desktop-only
  # functions in this build and out of the web app.
  # The settings of "Entdecken" (VITE_SOURCES_CONTACT, VITE_WEB_ORIGIN,
  # VITE_SOURCES_INDEX_URL, SOURCES_RELEASE_CHECK) reach the build from the
  # environment unchanged. When its check stops the build, it writes what is
  # missing to SOURCES_RELEASE_CHECK_REPORT.
  step 'Oberfläche bauen (npm run build, ohne Source Maps)'
  report="$(mktemp)"
  TAURI_ENV_PLATFORM="$platform" SOURCES_RELEASE_CHECK_REPORT="$report" npm run build -- --sourcemap false || status=$?
  if ((status != 0)); then
    if [[ -s "$report" ]]; then
      sources_check_stopped "$report"
    fi
    rm -f -- "$report"
    on_error "$status"
  fi
  rm -f -- "$report"
  local map
  map="$(find dist -name '*.map' -print -quit)"
  [[ -z "$map" ]] || die "dist/ enthält trotz --sourcemap false noch Source Maps, zum Beispiel $map"
  # The app has no downloader for video sites, and no release may bring one
  # back by accident (tests/build/webBuild.test.ts checks the same).
  if grep -rqsiE 'yt-dlp|ytdlp|youtube' dist; then
    die "dist/ enthält Teile eines Downloads von Videoseiten: $(grep -rlsiE 'yt-dlp|ytdlp|youtube' dist | head -3 | tr '\n' ' ')"
  fi
}

# The front end is built by install_and_build_frontend, so tauri build must
# not run beforeBuildCommand a second time.
TAURI_SKIP_FRONTEND_BUILD='{"build":{"beforeBuildCommand":null}}'

# Tauri's updater (docs/BUILD.md, "Automatische Updates"). With the secret key
# in TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD),
# tauri build also writes the signed update files (.sig next to the AppImage
# and the setup), through src-tauri/tauri.updater.conf.json. The public key in
# tauri.conf.json (plugins.updater.pubkey) must be the real one then. Once the
# app has the plugin (tauri-plugin-updater in Cargo.toml), a build without
# the key stops: its users could never update by themselves. Call before
# install_and_build_frontend; pass "${UPDATER_ARGS[@]}" to tauri build.
UPDATER_ARGS=()
prepare_updater() {
  local pubkey plugin=0
  grep -q '^tauri-plugin-updater' src-tauri/Cargo.toml && plugin=1
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    ((plugin == 0)) || die 'Die App hat den Updater eingebaut, aber TAURI_SIGNING_PRIVATE_KEY fehlt. Ohne den Schlüssel könnte sich diese Version nie selbst aktualisieren. Siehe docs/BUILD.md, „Automatische Updates“.'
    return 0
  fi
  pubkey="$(node -p 'require("./src-tauri/tauri.conf.json").plugins?.updater?.pubkey ?? ""')"
  [[ -n "$pubkey" && "$pubkey" != PLATZHALTER* ]] ||
    die 'TAURI_SIGNING_PRIVATE_KEY ist gesetzt, aber in src-tauri/tauri.conf.json steht beim Updater (plugins.updater.pubkey) noch kein öffentlicher Schlüssel. Siehe docs/BUILD.md, „Automatische Updates“.'
  UPDATER_ARGS=(--config src-tauri/tauri.updater.conf.json)
  if ((plugin)); then
    # The front end offers "Jetzt aktualisieren" (vite.config.ts, __SELF_UPDATE__).
    export VITE_SELF_UPDATE=on
    note 'Mit Updater: Die App kann sich selbst aktualisieren, die Update-Dateien werden signiert.'
  else
    note 'Die Update-Dateien werden signiert. Der Updater selbst ist noch nicht eingebaut (docs/BUILD.md).'
  fi
}

# Usage: rename_deb_package <file.deb> <name>
# Rewrites the Package field of a .deb in place; contents and maintainer
# scripts stay as they are.
rename_deb_package() {
  local deb="$1" name="$2" work
  [[ -f "$deb" ]] || die ".deb-Paket wurde nicht erzeugt. Erwartet: $deb"
  work="$(mktemp -d)"
  dpkg-deb -R "$deb" "$work/pkg"
  sed -i "s/^Package: .*/Package: $name/" "$work/pkg/DEBIAN/control"
  dpkg-deb --root-owner-group -Zxz -b "$work/pkg" "$deb" >/dev/null
  rm -rf -- "$work"
  [[ "$(dpkg-deb -f "$deb" Package)" == "$name" ]] || die "Das .deb heißt nach dem Umbenennen nicht $name."
}

# Prints one finished artifact with its size, or fails if it is missing.
report_artifact() {
  local label="$1" path="$2"
  [[ -f "$path" ]] || die "$label wurde nicht erzeugt. Erwartet: $path"
  printf '  %-14s %s%s%s (%s)\n' "$label" "$GREEN" "$path" "$RESET" "$(du -h -- "$path" | cut -f1)"
}
