#!/usr/bin/env bash
# Builds the Android app of TonUINO Studio from a fresh checkout: one signed
# APK for 64- and 32-bit ARM phones (aarch64, armv7). Details: docs/BUILD.md
#
# Usage: scripts/build-android.sh
# Needed in the environment:
#   JAVA_HOME             a JDK 17 or newer (or java 17+ in PATH)
#   ANDROID_HOME          the Android SDK with platforms/ and build-tools/
#                         (ANDROID_SDK_ROOT is taken as well)
#   NDK_HOME              the Android NDK (for example $ANDROID_HOME/ndk/<version>)
#   TONUINO_KEYSTORE      the keystore that signs the APK (PKCS12 or JKS). When
#                         the file does not exist yet, the script creates it there.
#                         Keep it safe and never publish it: updates of the app
#                         must be signed with the same key.
#   TONUINO_KEYSTORE_PASS its password (at least 6 characters)
# Optional:
#   TONUINO_KEY_ALIAS     the key in the keystore (default: tonuino)
#   CARGO_BUILD_JOBS      parallel compiler jobs (default: 4)
#   CARGO_TARGET_DIR      where cargo writes build output (default: src-tauri/target)
#   VITE_SOURCES_CONTACT, VITE_WEB_ORIGIN, VITE_SOURCES_INDEX_URL
#                         settings of "Entdecken" (docs/BUILD.md); the app shows
#                         the list that comes with it and needs only the contact
#                         address for "Melden".
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=lib/common.sh
source scripts/lib/common.sh

case "${1:-}" in
  '') ;;
  -h | --help)
    echo 'Aufruf: scripts/build-android.sh   (Details in docs/BUILD.md, Abschnitt „Android“)'
    exit 0
    ;;
  *) die "Unbekannte Angabe '$1'. Aufruf: scripts/build-android.sh" ;;
esac

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
ANDROID_TARGETS=(aarch64-linux-android armv7-linux-androideabi)
CARGO_TOML=src-tauri/Cargo.toml
GEN_DIR=src-tauri/gen/android

step 'Voraussetzungen prüfen'
require_node
require_rust
require_cmd rustup 'Rust über https://rustup.rs installieren, dann kann das Skript die Android-Ziele prüfen.'

# Java 17 or newer (Gradle and the Android build tools need it).
JAVA_BIN=java
[[ -z "${JAVA_HOME:-}" ]] || JAVA_BIN="$JAVA_HOME/bin/java"
if ! command -v "$JAVA_BIN" >/dev/null 2>&1; then
  MISSING+=("Java fehlt. Installiere ein JDK 17 oder neuer (zum Beispiel: sudo apt install openjdk-17-jdk) und setze JAVA_HOME.")
else
  JAVA_VERSION="$("$JAVA_BIN" -version 2>&1 | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p' | head -1)"
  if [[ -z "$JAVA_VERSION" || "$JAVA_VERSION" -lt 17 ]]; then
    MISSING+=("Java ${JAVA_VERSION:-unbekannter Version} ist zu alt. Nötig ist ein JDK 17 oder neuer; setze JAVA_HOME darauf.")
  fi
fi

# The Android SDK with at least one platform and the build tools (zipalign, apksigner).
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
BUILD_TOOLS=''
if [[ -z "$ANDROID_HOME" || ! -d "$ANDROID_HOME" ]]; then
  MISSING+=("Das Android-SDK fehlt. Installiere es (Android Studio oder die „command line tools“) und setze ANDROID_HOME auf seinen Ordner.")
else
  export ANDROID_HOME
  compgen -G "$ANDROID_HOME/platforms/android-*" >/dev/null ||
    MISSING+=("Im Android-SDK fehlt eine Plattform. Installiere sie: sdkmanager \"platforms;android-36\"")
  if [[ -d "$ANDROID_HOME/build-tools" ]]; then
    BUILD_TOOLS="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V | tail -1)"
  fi
  if [[ -z "$BUILD_TOOLS" ]]; then
    MISSING+=("Im Android-SDK fehlen die build-tools. Installiere sie: sdkmanager \"build-tools;36.0.0\"")
  else
    BUILD_TOOLS="$ANDROID_HOME/build-tools/$BUILD_TOOLS"
    for tool in zipalign apksigner; do
      [[ -x "$BUILD_TOOLS/$tool" ]] || MISSING+=("In $BUILD_TOOLS fehlt $tool. Installiere die build-tools neu.")
    done
  fi
fi

# The NDK, which tauri needs to build the Rust part for the phone.
if [[ -z "${NDK_HOME:-}" || ! -d "${NDK_HOME:-}/toolchains/llvm" ]]; then
  MISSING+=("Das Android-NDK fehlt. Installiere es (sdkmanager \"ndk;27.2.12479018\") und setze NDK_HOME auf seinen Ordner, zum Beispiel \$ANDROID_HOME/ndk/27.2.12479018.")
else
  export NDK_HOME
fi

# The Rust targets of the phones.
if command -v rustup >/dev/null 2>&1; then
  INSTALLED_TARGETS="$(rustup target list --installed)"
  for target in "${ANDROID_TARGETS[@]}"; do
    grep -qx "$target" <<<"$INSTALLED_TARGETS" || MISSING+=("Das Rust-Ziel $target fehlt. Installiere es: rustup target add $target")
  done
fi

# The key that signs the APK.
KEY_ALIAS="${TONUINO_KEY_ALIAS:-tonuino}"
if [[ -z "${TONUINO_KEYSTORE:-}" ]]; then
  MISSING+=("TONUINO_KEYSTORE fehlt: der Pfad zum Schlüssel, mit dem die App signiert wird. Gibt es die Datei noch nicht, legt das Skript sie dort an. Leg sie außerhalb des Quellcodes ab.")
elif [[ -z "${TONUINO_KEYSTORE_PASS:-}" || ${#TONUINO_KEYSTORE_PASS} -lt 6 ]]; then
  MISSING+=("TONUINO_KEYSTORE_PASS fehlt oder ist kürzer als 6 Zeichen: das Passwort des Schlüssels.")
else
  KEYSTORE_DIR="$(cd -- "$(dirname -- "$TONUINO_KEYSTORE")" 2>/dev/null && pwd || true)"
  if [[ -z "$KEYSTORE_DIR" ]]; then
    MISSING+=("Den Ordner für TONUINO_KEYSTORE gibt es nicht: $(dirname -- "$TONUINO_KEYSTORE")")
  elif [[ "$KEYSTORE_DIR/" == "$ROOT_DIR/"* ]]; then
    MISSING+=("TONUINO_KEYSTORE liegt im Quellcode ($TONUINO_KEYSTORE). Leg den Schlüssel außerhalb ab, damit er nie mit dem Quellcode weitergegeben wird.")
  else
    KEYSTORE="$KEYSTORE_DIR/$(basename -- "$TONUINO_KEYSTORE")"
    if [[ ! -f "$KEYSTORE" ]]; then
      KEYTOOL=keytool
      [[ -z "${JAVA_HOME:-}" ]] || KEYTOOL="$JAVA_HOME/bin/keytool"
      command -v "$KEYTOOL" >/dev/null 2>&1 || MISSING+=("keytool fehlt (kommt mit dem JDK). Damit legt das Skript den Schlüssel an.")
    fi
  fi
fi
finish_checks

if [[ ! -f "$KEYSTORE" ]]; then
  step "Neuen Schlüssel anlegen: $KEYSTORE"
  "$KEYTOOL" -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=TonUINO Studio' \
    -storepass:env TONUINO_KEYSTORE_PASS -keypass:env TONUINO_KEYSTORE_PASS
  chmod 600 -- "$KEYSTORE"
  note "Neuer Schlüssel in $KEYSTORE. Bewahre ihn und sein Passwort sicher auf (zum Beispiel als Kopie auf einem USB-Stick) und gib ihn nie weiter oder ins Netz: Jedes Update der App muss mit genau diesem Schlüssel signiert sein, sonst lässt Android es nicht über die alte App installieren."
fi

# The Android build of the Rust part needs a "cdylib". Desktop builds keep
# crate-type = ["rlib"] (see the comment in Cargo.toml), so the switch only
# lasts as long as this script, also when it fails.
CARGO_BACKUP="$(mktemp)"
cp -p -- "$CARGO_TOML" "$CARGO_BACKUP"
restore_cargo_toml() {
  if [[ -f "$CARGO_BACKUP" ]]; then
    cp -p -- "$CARGO_BACKUP" "$CARGO_TOML"
    rm -f -- "$CARGO_BACKUP"
  fi
}
trap restore_cargo_toml EXIT

# The licence list of the app names the crates of the phone, not those of the desktop.
export TAURI_ENV_TARGET_TRIPLE="${ANDROID_TARGETS[0]}"
install_and_build_frontend android

if [[ ! -d "$GEN_DIR" ]]; then
  step 'Android-Projekt anlegen (tauri android init)'
  nice npm run tauri -- android init --ci --skip-targets-install
fi

step 'Eigene Dateien ins Android-Projekt bringen (NFC, SD-Karte, USB, Berechtigungen)'
MAIN_ACTIVITY="$(find "$GEN_DIR/app/src/main" -name MainActivity.kt -print -quit)"
[[ -n "$MAIN_ACTIVITY" ]] || die "tauri android init hat keine MainActivity.kt in $GEN_DIR/app/src/main angelegt."
PACKAGE="$(sed -n 's/^package[[:space:]]\{1,\}\([A-Za-z0-9_.]\{1,\}\).*/\1/p' "$MAIN_ACTIVITY" | head -1)"
[[ -n "$PACKAGE" ]] || die "In $MAIN_ACTIVITY steht kein package."
PACKAGE_DIR="$(dirname -- "$MAIN_ACTIVITY")"
for source in src-tauri/android/*.kt; do
  sed "s/^package .*/package $PACKAGE/" "$source" >"$PACKAGE_DIR/$(basename -- "$source")"
done
echo "Kotlin-Dateien nach $PACKAGE_DIR (package $PACKAGE)."

PROGUARD="$GEN_DIR/app/proguard-rules.pro"
# TonuinoUsb came last: a project prepared for an older version gets the whole list again.
if ! grep -qs 'TonuinoUsb' "$PROGUARD"; then
  { echo; sed "s/{{package}}/$PACKAGE/g" src-tauri/android/proguard-tonuino.pro; } >>"$PROGUARD"
fi

# Permissions: NFC for the cards; the microphone for "Selbst aufnehmen" (the WebView asks
# for it the first time a page records). The SD card needs none: the user picks it in
# Android's folder chooser. USB host and microphone are optional features, like NFC, so the
# app still installs on a phone without them.
MANIFEST="$GEN_DIR/app/src/main/AndroidManifest.xml"
[[ -f "$MANIFEST" ]] || die "Das Android-Manifest fehlt: $MANIFEST"
node - "$MANIFEST" <<'EOF'
const fs = require('node:fs');
const file = process.argv[2];
let xml = fs.readFileSync(file, 'utf8');
const lines = [];
for (const name of ['android.permission.NFC', 'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS']) {
  if (!xml.includes(`"${name}"`)) lines.push(`<uses-permission android:name="${name}" />`);
}
for (const name of ['android.hardware.nfc', 'android.hardware.usb.host', 'android.hardware.microphone']) {
  if (!xml.includes(`"${name}"`)) lines.push(`<uses-feature android:name="${name}" android:required="false" />`);
}
if (lines.length) {
  const at = xml.indexOf('<application');
  if (at < 0) throw new Error(`no <application> in ${file}`);
  xml = xml.slice(0, at) + lines.map((l) => `${l}\n    `).join('') + xml.slice(at);
  fs.writeFileSync(file, xml);
}
console.log(lines.length ? `Manifest ergänzt: ${lines.length} Zeile(n).` : 'Manifest hat schon alles.');
EOF

step "Rust-Teil als Bibliothek für Android bauen lassen (crate-type nur für diesen Build)"
grep -qx 'crate-type = \["rlib"\]' "$CARGO_TOML" || die "In $CARGO_TOML steht nicht crate-type = [\"rlib\"]. Das Skript ändert die Zeile nur, wenn sie genau so dasteht."
sed -i 's/^crate-type = \["rlib"\]$/crate-type = ["cdylib", "rlib"]/' "$CARGO_TOML"

step "App bauen (tauri android build: APK für aarch64 und armv7, $CARGO_BUILD_JOBS Jobs)"
nice npm run tauri -- android build --apk --ci --target aarch64 armv7 --config "$TAURI_SKIP_FRONTEND_BUILD"
restore_cargo_toml

UNSIGNED="$(find "$GEN_DIR/app/build/outputs/apk" -name '*-release-unsigned.apk' -print 2>/dev/null | sort | tail -1)"
[[ -n "$UNSIGNED" ]] || die "tauri android build hat keine unsignierte Release-APK unter $GEN_DIR/app/build/outputs/apk erzeugt."

step 'APK ausrichten und signieren (zipalign, apksigner)'
read_app_info
read_cargo_info
OUT_DIR="$TARGET_DIR/android"
mkdir -p -- "$OUT_DIR"
APK="$OUT_DIR/TonUINO-Studio_${APP_VERSION}.apk"
ALIGNED="$(mktemp --suffix=.apk)"
"$BUILD_TOOLS/zipalign" -p -f 4 "$UNSIGNED" "$ALIGNED"
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass env:TONUINO_KEYSTORE_PASS --key-pass env:TONUINO_KEYSTORE_PASS --out "$APK" "$ALIGNED"
rm -f -- "$ALIGNED" "$APK.idsig"
"$BUILD_TOOLS/apksigner" verify "$APK"

step 'Fertig'
report_artifact 'APK' "$APK"
echo "Installieren: Datei aufs Handy kopieren und öffnen, oder per USB: adb install -r \"$APK\""
