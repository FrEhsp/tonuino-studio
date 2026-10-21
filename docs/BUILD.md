# TonUINO Studio: Desktop-Pakete bauen

Zwei Skripte bauen die Desktop-App aus einem frischen Checkout. Beide laufen
unter Linux (Build-Rechner: Ubuntu 24.04, x86_64):

| Skript | Ergebnis |
|---|---|
| `scripts/build-linux.sh` | `.deb`-Paket und AppImage für Linux |
| `scripts/build-windows.sh` | Windows-Installer (NSIS, `.exe`, x64), unter Linux quer kompiliert |

Die App für Android-Handys baut `scripts/build-android.sh` (Abschnitt „Android“).

Jedes Skript prüft zuerst alle Voraussetzungen und bricht mit einer Liste ab,
wenn etwas fehlt. Dann folgen `npm ci`, der Bau der Oberfläche und
`tauri build` für das Ziel. Zum Schluss stehen Pfad und Größe jeder fertigen
Datei in der Ausgabe. Schlägt ein Schritt fehl, nennt das Skript den Schritt
und endet mit dessen Exit-Code.

Die Oberfläche bauen die Skripte ohne Source Maps
(`npm run build -- --sourcemap false`). Tauri bettet `dist/` ins Programm ein,
mit den Maps war es 1,7 MB größer. `vite.config.ts` lässt die Maps für die
Entwicklung an. Die Maps enthalten nur die Zuordnung, nicht den Quelltext.

Dabei setzen die Skripte `TAURI_ENV_PLATFORM` (`linux` bzw. `windows`), so wie
es die Tauri-CLI bei `beforeBuildCommand` täte. `vite.config.ts` macht daraus
`__DESKTOP_BUILD__`: Nur mit dieser Variable kommen Desktop-Funktionen in den
Bau, die Web-App bleibt ohne sie.

## Prüfung vor dem Release

Die Skripte brechen ab, wenn in `dist/` etwas von yt-dlp oder YouTube steht.
TonUINO Studio lädt nichts von Videoseiten; die Prüfung sorgt dafür, dass das
so bleibt. `tests/build/webBuild.test.ts` prüft dasselbe an den Bauten.

## Voraussetzungen

Für beide Skripte:

- Node.js 20.19 oder 22.12 und neuer (wegen Vite), mit npm
- Rust stable über [rustup](https://rustup.rs)
- Internet beim ersten Lauf (npm-Pakete, Crates und Werkzeuge, siehe unten)

Linux-Pakete (Debian/Ubuntu):

```sh
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libudev-dev libpcsclite-dev libasound2-dev \
  patchelf file gstreamer1.0-plugins-base gstreamer1.0-plugins-good
# dpkg-deb (Paket dpkg) setzt den Paketnamen im .deb
# empfohlen, damit das AppImage Ton auch ohne PulseAudio ausgeben kann:
sudo apt install gstreamer1.0-alsa gstreamer1.0-pipewire
```

Windows-Installer, GNU-Weg (Standard, braucht nichts von Microsoft):

```sh
sudo apt install gcc-mingw-w64-x86-64 nsis   # MinGW-gcc, windres, objdump, makensis
rustup target add x86_64-pc-windows-gnu
```

Windows-Installer, MSVC-Weg nach Tauris Anleitung „Build Windows apps on
Linux“. Er geht nur auf Rechnern, die Microsofts Download-Server erreichen:

```sh
sudo apt install clang lld llvm nsis      # clang, lld-link, llvm-rc, makensis
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
```

## Bauen

```sh
scripts/build-linux.sh
scripts/build-windows.sh         # GNU-Weg
scripts/build-windows.sh msvc    # MSVC-Weg mit cargo-xwin
```

Optionale Umgebungsvariablen:

- `CARGO_TARGET_DIR`: wohin cargo baut (Standard `src-tauri/target`)
- `CARGO_BUILD_JOBS`: parallele Compiler-Jobs, z. B. `2` auf schwachen Rechnern
- `GSTREAMER_PLUGINS_DIR`, `GSTREAMER_HELPERS_DIR`: GStreamer-Plugins und
  `gst-plugin-scanner` für das AppImage, falls sie nicht wie bei Debian/Ubuntu
  unter `/usr/lib/x86_64-linux-gnu/gstreamer-1.0` und
  `/usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0` liegen
- `XWIN_CACHE_DIR` (nur MSVC): Ablage für Windows SDK und C-Laufzeit
  (Standard `~/.cache/cargo-xwin`)
- `VITE_WEB_ORIGIN`, `VITE_SOURCES_INDEX_URL`, `VITE_SOURCES_CONTACT`:
  Einstellungen für „Entdecken“, siehe [Entdecken](#entdecken)

Der erste Build dauert lange, weil das Release-Profil mit LTO und
`codegen-units = 1` baut.

## Entdecken

„Entdecken“ (freie Hörspiele, Hörbücher und Lieder, `src/features/sources`)
kommt nur in einen Build, der eine Liste zeigen kann:

- Die mitgelieferte Liste `sources/snapshot/index-v1.json` hat Einträge
  (`npm run sources:snapshot`, siehe `sources/README.md`), oder
- für den Build ist eine Adresse der Liste gesetzt: `VITE_SOURCES_INDEX_URL`,
- oder es ist die Desktop-App: Seit 0.3 stellt sie die Liste selbst zusammen,
  aus dem mitgelieferten `sources/catalog.json` und höchstens einmal am Tag
  (`src/core/sources/local.ts`, cargo-Feature `quellen`, siehe
  `sources/README.md`). Sie braucht dafür keinen Server und keine Adresse der
  Liste, nur `VITE_SOURCES_CONTACT` für „Melden“. Nur mit
  `VITE_SOURCES_INDEX_URL` lädt sie stattdessen diese Liste.

Seit 0.2 bringt das Repository eine Liste mit (siehe `sources/README.md`).
Damit hat jeder Build „Entdecken“: Die Web-App zeigt die mitgelieferte Liste,
lädt keine neuere und prüft beim Öffnen, welche Titel noch online sind; die
Desktop-App beginnt mit ihr, bis ihr erster eigener Lauf fertig ist. Ohne
`VITE_SOURCES_CONTACT` gibt es kein „Melden“. Für so einen Build ohne die
beiden Angaben `SOURCES_RELEASE_CHECK=off` setzen (die strenge Prüfung
verlangt beide weiter). `SOURCES_SNAPSHOT=off` baut ohne die mitgelieferte
Liste. Ohne Liste und ohne eine der Angaben oben fehlt
„Entdecken“ ganz: kein Menüpunkt, keine Seite, kein Tipp unter
„Hinzufügen“, kein Abschnitt in der Hilfe und keine Zeilen dazu im Text zum
Datenschutz. `#/entdecken` öffnet dann die Startseite, wie jede unbekannte
Adresse. Das entscheidet `vite.config.ts` beim Bauen (`sourcesEnabled` in
`src/features/sources/release.ts`) und setzt danach `__SOURCES_ENABLED__`.
Die Tests sehen „Entdecken“ immer.

| Variable | Wofür |
|---|---|
| `VITE_WEB_ORIGIN` | Web-Adresse der App (`https://…`), z. B. für den Download-Link. Für die Liste braucht die Desktop-App sie nicht mehr. |
| `VITE_SOURCES_INDEX_URL` | eine andere Adresse der Liste, z. B. eine Vorschau. Für die Desktop-App eine vollständige `https://`-Adresse; dann baut sie die Liste nicht selbst. |
| `VITE_SOURCES_CONTACT` | E-Mail-Adresse für „Melden“ |
| `SOURCES_RELEASE_CHECK=off` | nur für Testbuilds: Die Prüfung warnt dann nur, statt abzubrechen. |

Ein Release-Build mit „Entdecken“ bricht ohne `VITE_SOURCES_CONTACT` ab. So
erscheint keine Version ohne „Melden“. Die Sperrliste bekommt die Desktop-App
mit dem Katalog, also mit jeder neuen Version. Ein Build ohne „Entdecken“
braucht keine dieser Angaben und läuft ohne `SOURCES_RELEASE_CHECK=off`
durch. In der Ausgabe steht „Entdecken: an.“ oder „Entdecken: aus (…)“.

Die Skripte reichen die Variablen unverändert an den Bau der Oberfläche
weiter. Stoppt die Prüfung den Build, nennen sie, was fehlt und wie es
weitergeht. Werte aus `.env`-Dateien zählen wie Umgebungsvariablen.

```sh
# Desktop-App mit „Entdecken“ (baut die Liste selbst)
VITE_SOURCES_CONTACT=quellen@example.org scripts/build-linux.sh
# Desktop-App ohne „Melden“ (Testbuild)
SOURCES_RELEASE_CHECK=off scripts/build-linux.sh
# Desktop-App ohne „Entdecken“ (ohne mitgelieferte Liste, keine Adresse)
SOURCES_SNAPSHOT=off scripts/build-linux.sh
# Web-App mit „Entdecken“, ohne mitgelieferte Liste: die Adresse der Liste angeben.
# Mit mitgelieferter Liste reicht VITE_SOURCES_CONTACT; die Liste kommt dann von quellen/index-v1.json neben der App.
VITE_SOURCES_INDEX_URL=/quellen/index-v1.json VITE_SOURCES_CONTACT=quellen@example.org npm run build
```

## Download-Link der Desktop-App

Bekommt der Bau der Web-App `VITE_DESKTOP_DOWNLOAD_URL` (eine `https://`-Adresse),
zeigt sie „Desktop-App herunterladen“ überall dort, wo sie die Desktop-App
empfiehlt: im Hinweis ohne USB in der Werkstatt, in der Hilfe unter „Web-App
oder Desktop-App?“ und im Hinweis auf Handys und Tablets
(`src/features/help/desktopapp.ts`). Ohne die Variable, oder wenn sie keine
https-Adresse ist, steht dort kein Link. Die Desktop-App zeigt ihn nie.

## Wo die Dateien landen

`<target>` ist `src-tauri/target` oder `CARGO_TARGET_DIR`, `<version>` die
Version aus `package.json`.

| Datei | Pfad |
|---|---|
| .deb-Paket | `<target>/release/bundle/deb/TonUINO Studio_<version>_amd64.deb` |
| AppImage | `<target>/release/bundle/appimage/TonUINO Studio_<version>_amd64.AppImage` |
| Windows-Installer | `<target>/x86_64-pc-windows-gnu/release/bundle/nsis/TonUINO Studio_<version>_x64-setup.exe` |
| Windows-Programm ohne Installer | `<target>/x86_64-pc-windows-gnu/release/tonuino-studio.exe`, daneben `WebView2Loader.dll` |

Beim MSVC-Weg steht `x86_64-pc-windows-msvc` im Pfad, und es gibt keine
`WebView2Loader.dll`.

## Downloads beim ersten Lauf

Spätere Läufe nehmen die Dateien aus dem Cache.

- AppImage: tauri lädt `linuxdeploy`, `AppRun` und das AppImage-Plugin von
  github.com nach `~/.cache/tauri`.
- Windows: tauri lädt das NSIS-Plugin `nsis_tauri_utils.dll` von github.com
  nach `~/.cache/tauri`.
- Nur mit `embedBootstrapper` (siehe WebView2 unten): tauri lädt den
  WebView2-Bootstrapper von go.microsoft.com nach `~/.cache/tauri`.
- Nur MSVC-Weg: cargo-xwin lädt die C-Laufzeit (CRT) und das Windows SDK von
  Microsoft (aka.ms, download.visualstudio.microsoft.com) nach
  `~/.cache/cargo-xwin`. Dafür gelten die Lizenzbedingungen von Microsoft. Das
  Skript holt nur die x64-Teile (`XWIN_ARCH=x86_64`).

Der GNU-Weg lädt nichts von Microsoft. `WebView2Loader.dll` gehört zu
Microsofts WebView2 SDK und liegt dem Crate `webview2-com-sys` bei.

## Paket-Einstellungen

Alles steht in `src-tauri/tauri.conf.json`.

- **Name, Kennung, Herausgeber:** „TonUINO Studio“, `app.tonuinostudio.desktop`,
  „TonUINO Studio“. Die Kennung nie ändern: Daten und Einstellungen der App
  liegen in Ordnern mit diesem Namen.
- **Version:** kommt aus `package.json` (`"version": "../package.json"`). Für
  ein Release nur dort hochzählen; die Version in `src-tauri/Cargo.toml`
  nutzen die Pakete nicht.
- **Icons:** aus dem Logo erzeugt. `public/favicon.svg` ist dieselbe Zeichnung
  wie `src/ui/components/Logo.tsx`. Nach einer Logo-Änderung:

  ```sh
  npx tauri icon public/favicon.svg
  rm -r src-tauri/icons/android src-tauri/icons/ios   # nur Desktop
  ```

  Das erste PNG in `bundle.icon` wird unter Linux zum Fenster-Icon, deshalb
  steht `128x128.png` vorn.

## Linux-Pakete

- **glibc 2.39 oder neuer:** Gebaut auf Ubuntu 24.04 verweist das Programm
  über die Rust-Standardbibliothek auf `pidfd_spawnp` und `pidfd_getpid` aus
  glibc 2.39. Ältere glibc-Versionen lehnen es beim Start ab. Das gilt für
  das .deb wie für das AppImage: Sie laufen etwa auf Ubuntu 24.04,
  Linux Mint 22, Debian 13 und Fedora 40 oder neuer, nicht auf Ubuntu 22.04
  oder Debian 12. Das .deb hängt deshalb von `libc6 (>= 2.39)` ab
  (`bundle.linux.deb.depends`), und apt lehnt es auf älteren Systemen ab.
  Für ältere Systeme auf einer älteren Distribution mit WebKitGTK 4.1 bauen
  (z. B. Ubuntu 22.04, glibc 2.35) und die Version in `depends` anpassen.
- **Ton im AppImage:** `bundle.linux.appimage.bundleMediaFramework` ist an.
  Das AppImage bringt GStreamer 1.24 mit allen Plugins des Build-Rechners mit
  (109 Stück, darunter `playback`, `typefindfunctions`, `audioconvert`,
  `audioresample`, `volume`, `autodetect`, `pulseaudio`, `audioparsers`,
  `id3demux` und `mpg123` als MP3-Decoder). Dazu kommen `gst-plugin-scanner`
  und ein Start-Hook, der GStreamer nur diese Plugins laden lässt. So spielt
  die Vorschau MP3s unabhängig vom GStreamer des Systems. Die Ausgabe läuft
  über PulseAudio; PipeWire-Systeme bedienen das über `pipewire-pulse`. Fehlen
  auf dem Build-Rechner `gstreamer1.0-alsa` oder `gstreamer1.0-pipewire`,
  fehlen die Plugins `alsa` und `pipewire` auch im AppImage; das Skript weist
  darauf hin. Die Plugins machen das AppImage etwa 9,5 MB größer.
- **Ton im .deb:** Das Paket nutzt GStreamer und die Plugins des Systems.
  Unter Debian/Ubuntu hängt `libwebkit2gtk-4.1-0` von
  `gstreamer1.0-plugins-base` und `gstreamer1.0-plugins-good` ab, darin steckt
  auch der MP3-Decoder.
- **Startmenü und USB:** Eintrag aus `src-tauri/linux/tonuino-studio.desktop`
  (Kategorien `AudioVideo;Audio;Utility`). Das .deb bringt die udev-Regeln
  für Box und Kartenleser mit (`src-tauri/linux/`).

## Windows-Installer

- **GNU-Weg:** Rust-Ziel `x86_64-pc-windows-gnu`. MinGW-gcc linkt, `windres`
  bettet Icon und Versionsangaben ein. libgcc und winpthread bindet Rust für
  dieses Ziel statisch ein. Das Skript prüft danach die DLL-Importe der
  `.exe` mit `objdump` und bricht ab, sobald eine MinGW-Laufzeit-DLL
  auftaucht (`lib*.dll`, etwa `libgcc_s_seh-1.dll`, `libstdc++-6.dll`,
  `libwinpthread-1.dll`). Erlaubt sind nur DLLs von Windows selbst und
  `WebView2Loader.dll`.
- **Nur `rlib`:** In `src-tauri/Cargo.toml` steht bei `crate-type` nur
  `rlib`. Mit `cdylib` scheiterte das Linken für den GNU-Weg („export ordinal
  too large“), und gebraucht wird es nur für Android. `staticlib` braucht nur
  iOS; es kostete bei jedem Build ein zweites Linken mit rund 850 MB.
- **WebView2Loader.dll:** Mit dem GNU-Ziel lädt das Programm WebView2 über
  diese DLL; die statische Variante des Loaders linkt `webview2-com-sys` nur
  mit MSVC. tauri-build legt die DLL neben die `.exe`, und der Installer
  kopiert sie mit in den Programmordner. Wer die `.exe` ohne Installer
  weitergibt, muss die DLL danebenlegen.
- **Installation:** pro Benutzer ohne Admin-Rechte nach
  `%LOCALAPPDATA%\TonUINO Studio`. Der Installer spricht Deutsch oder
  Englisch, je nach Systemsprache, sonst Deutsch.
- **WebView2:** Windows 11 bringt die WebView2-Laufzeit mit, Windows 10
  bekommt sie meist über Windows Update. Für den Fall, dass sie fehlt, kennt
  Tauris Installer-Vorlage diese Modi (`bundle.windows.webviewInstallMode`):

  | Modus | beim Bauen | bei der Installation, wenn WebView2 fehlt |
  |---|---|---|
  | `skip` (gewählt) | nichts | nichts, hier greift der Hook (siehe unten) |
  | `downloadBootstrapper` | nichts | lädt Microsofts Bootstrapper unverschlüsselt herunter und startet ihn still |
  | `embedBootstrapper` | lädt den Bootstrapper (ca. 1,8 MB) von go.microsoft.com | startet den eingebetteten Bootstrapper von Microsoft, der die Laufzeit lädt |
  | `offlineInstaller` | lädt den vollständigen Laufzeit-Installer (über 100 MB) von Microsoft | installiert ohne Internet |
  | `fixedRuntime` | eine vorher von Microsoft geladene Laufzeit-Version muss im Projekt liegen | nichts, die App nutzt die mitgelieferte Laufzeit |

  `downloadBootstrapper` kommt für einen öffentlichen Installer nicht in
  Frage. Die Vorlage lädt dabei mit dem NSIS-Plugin `NSISdl`, und das kann
  kein TLS: Es übergeht das `https://` der Adresse, fragt unverschlüsselt per
  HTTP auf Port 80 an, folgt Weiterleitungen genauso und startet die geladene
  Datei ohne Prüfung der Signatur. In einem fremden Netz ließe sie sich
  unterwegs austauschen.

  Deshalb steht der Modus auf `skip`, und der Hook
  `src-tauri/windows/installer-hooks.nsh` (`bundle.windows.nsis.installerHooks`,
  Makro `NSIS_HOOK_PREINSTALL`) prüft vor dem Kopieren der Dateien, ob
  WebView2 da ist. Er liest denselben Registry-Wert wie die Vorlage, `pv` im
  Schlüssel `Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`:
  erst unter `HKLM\SOFTWARE\WOW6432Node` (auf 32-Bit-Windows
  `HKLM\SOFTWARE`), dann unter `HKCU\SOFTWARE`. Leer oder `0.0.0.0` zählt als
  fehlend. Fehlt WebView2, erklärt der Installer in seiner
  Sprache, was zu tun ist, öffnet Microsofts Download-Seite
  `https://go.microsoft.com/fwlink/p/?LinkId=2124703` im Standard-Browser und
  bricht ab. Den gerade angelegten, noch leeren Programmordner entfernt er
  wieder. Bei einer stillen Installation (`/S`) erscheinen weder Meldung noch
  Browser, der Installer endet dann mit Exit-Code 2.

  Erreicht der Build-Rechner Microsoft, ist `embedBootstrapper` die bessere
  Wahl: Dann installiert der Installer WebView2 selbst, mit Microsofts
  eingebettetem Bootstrapper. Umstellen in `src-tauri/tauri.conf.json`:

  ```json
  "webviewInstallMode": { "type": "embedBootstrapper", "silent": true }
  ```

  Der Hook kann bleiben. Er läuft nach dem WebView2-Schritt der Vorlage und
  greift nur ein, wenn die Laufzeit danach immer noch fehlt.

## macOS (GitHub Actions)

Für den Mac gibt es kein Skript: Ein Mac-Programm baut nur ein Mac. Das
erledigt `.github/workflows/mac.yml` auf einem Mac-Rechner von GitHub (Intel,
`macos-15-intel`; Apple Silicon war zu ausgelastet), bei
jedem Push auf `main` und von Hand („Run workflow“). Der Ablauf ist der von
`scripts/build-linux.sh`: `npm ci`, die Oberfläche einmal ohne Source Maps
(öffentliche Fassung, `VITE_SOURCES_CONTACT` für „Entdecken“), dann
`tauri build --target universal-apple-darwin --bundles app,dmg` ohne
`beforeBuildCommand`. Heraus kommt eine App für Apple Silicon und Intel, als
`.dmg` und als gezippte `.app`, beide als Artefakte des Laufs.

- **Signatur:** nur ad hoc (`bundle.macOS.signingIdentity: "-"`), ohne
  Hardened Runtime (`hardenedRuntime: false`): Die bräuchte Entitlements fürs
  Mikrofon und nützt nur fürs Notarisieren. Ohne
  Apple-Entwicklerkonto gibt es weder Developer-ID noch Notarisierung.
  Gatekeeper fragt deshalb beim ersten Start: Rechtsklick auf die App,
  „Öffnen“; ab macOS 15 unter „Systemeinstellungen › Datenschutz &
  Sicherheit › Trotzdem öffnen“. Die Ad-hoc-Signatur ändert sich mit jedem
  Build, macOS fragt danach also wieder nach Mikrofon und Wechselmedien.
- **Info.plist:** `src-tauri/Info.plist` ergänzt die Texte, mit denen macOS
  nach Mikrofon („Selbst aufnehmen“), SD-Karte und den Ordnern Dokumente,
  Downloads und Schreibtisch fragt. Ohne den Text fürs Mikrofon beendet macOS
  die App beim Aufnehmen.
- **Mindestens macOS 11** (`minimumSystemVersion`).
- Der Lauf prüft, dass das Programm beide Architekturen enthält, die
  Signatur gültig ist.
- **Tests auf dem Mac:** `.github/workflows/mac-test.yml` (bei jedem Push auf
  `main` und von Hand). Rust-Tests (`cargo test --lib`) auf macOS; echte
  SD-Karten als Abbilder, die macOS selbst formatiert (FAT32, exFAT) und
  unter `/Volumes` einhängt, eine schreibgeschützt: Der App-Code listet,
  liest, schreibt und wirft sie aus (`src-tauri/src/mac_card_tests.rs`), die
  Kartenprüfung und das Aufräumen vor dem Auswerfen laufen auf der
  eingehängten Karte, danach dürfen auf den Abbildern keine versteckten
  Mac-Dateien mehr sein (`tests/labor/maccard.test.ts`). Dazu der SD-Bereich
  des Testlabors (exFAT mit `newfs_exfat` von macOS), der Box-Simulator
  (simavr aus dem Quelltext gebaut) und ein Start der App für 20 Sekunden
  (Bildschirmfoto als Artefakt). Der Druck-Bereich des Testlabors fehlt: Er
  braucht das CUPS von Linux (cups-filters, cups-pdf).
  Reine Test- und Textänderungen starten `mac.yml` nicht neu.

## Android

`scripts/build-android.sh` baut die App fürs Handy: eine signierte APK für
64- und 32-Bit-ARM (`aarch64`, `armv7`), am Ende
`src-tauri/target/android/TonUINO-Studio_<Version>.apk`. Sie zeigt dieselbe
Oberfläche wie die Web-App auf dem Handy und kann dasselbe wie die
Desktop-App: Karten mit dem NFC des Handys, die SD-Karte in einem
USB-Kartenleser am Handy (Meine Box, Hinzufügen, Sticker, Prüfen), Drucken
über den Druckdienst des Handys, die Box am USB-Kabel (Logbuch, Box testen,
Firmware) und Aufnehmen mit dem Mikrofon.

Voraussetzungen (das Skript prüft sie und nennt, was fehlt):

- JDK 17 oder neuer (`JAVA_HOME`), Android-SDK mit einer Plattform und den
  build-tools (`ANDROID_HOME`), Android-NDK (`NDK_HOME`),
- die Rust-Ziele `aarch64-linux-android` und `armv7-linux-androideabi`
  (`rustup target add …`),
- der Schlüssel zum Signieren: `TONUINO_KEYSTORE` (Pfad außerhalb des
  Quellcodes) und `TONUINO_KEYSTORE_PASS`, optional `TONUINO_KEY_ALIAS`
  (Standard `tonuino`). Gibt es die Datei noch nicht, legt das Skript sie mit
  `keytool` an. Den Schlüssel sicher aufbewahren und nie weitergeben: Updates
  müssen mit demselben Schlüssel signiert sein.
- Netz für Gradle (Maven Central und Googles Maven-Server) beim ersten Bau.

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=$HOME/Android/Sdk NDK_HOME=$HOME/Android/Sdk/ndk/27.2.12479018
export TONUINO_KEYSTORE=$HOME/geheim/tonuino-android.p12 TONUINO_KEYSTORE_PASS=…
VITE_SOURCES_CONTACT=quellen@example.org scripts/build-android.sh
```

Ablauf: `npm ci`, Oberfläche mit `TAURI_ENV_PLATFORM=android` bauen,
`tauri android init` (nur wenn `src-tauri/gen/android` fehlt; der Ordner ist
nicht im Git), dann kommen alle `src-tauri/android/*.kt` neben die erzeugte
`MainActivity.kt` und an ihre Stelle (mit deren `package`), die
Berechtigungen `NFC`, `RECORD_AUDIO` und `MODIFY_AUDIO_SETTINGS` und die
Merkmale `android.hardware.nfc`, `android.hardware.usb.host` und
`android.hardware.microphone` (alle nicht verpflichtend) ins Manifest und die
Keep-Regeln aus `proguard-tonuino.pro` in `proguard-rules.pro`.
Für `tauri android build --apk --target aarch64 armv7` setzt das Skript
`crate-type` in `src-tauri/Cargo.toml` kurz auf `["cdylib", "rlib"]` und
danach wieder auf `["rlib"]`, auch wenn der Bau scheitert. Zum Schluss
richten `zipalign` und `apksigner` aus den build-tools die APK aus und
signieren sie.

- **NFC:** Die Kotlin-Brücke (`window.TonuinoNfc`) liest und schreibt wie der
  PC/SC-Leser der Desktop-App (`src-tauri/src/nfc.rs`): MIFARE Classic
  Block 4 mit Schlüssel A `FF…FF`, NTAG/Ultralight Seiten 8–11, jedes
  Schreiben wird zurückgelesen. MIFARE Classic geht nur mit einem NFC-Chip
  von NXP im Handy; andere Handys melden das, NTAG213/215 gehen überall.
- **Karte ans Handy halten:** Solange die App vorne ist, bleibt der
  Lesemodus an (`src/features/cards/nfcTap.ts`). Eine Karte zeigt sofort,
  was darauf steht; Android bietet dabei keine andere App an.
- **SD-Karte:** `window.TonuinoFiles` (`TonuinoFiles.kt`) arbeitet mit dem
  Storage Access Framework: Die Karte (oder ein Ordner) wird einmal im
  Fenster des Handys gewählt, die Freigabe bleibt gespeichert. Die Logik für
  Ordner, Dateien und Wiedererkennen steckt in
  `src/platform/tauri/androidSaf.ts` und `androidVolumes.ts`.
- **Box am USB-Kabel:** `window.TonuinoUsb` (`TonuinoUsb.kt`) öffnet das
  USB-Gerät und liest in einem eigenen Thread. Die Treiber für CH340/CH341,
  FTDI FT232R, CP210x und CDC-ACM sind in TypeScript
  (`src/platform/tauri/usbChips.ts`), ohne weitere Bibliothek.
- **Mikrofon:** Der WebView von wry fragt bei `getUserMedia` selbst nach
  `RECORD_AUDIO`. „Selbst aufnehmen“ ist auf dem Handy immer da.
- **Rust-Teil:** Für Android baut Cargo weder pcsc, serialport, sysinfo noch
  rustls (`[target.'cfg(not(target_os = "android"))'.dependencies]`), also
  keinen C-Code. Die App hat nur die Befehle für die Box im WLAN und ihre
  eigenen. „Entdecken“ zeigt die mitgelieferte Liste.
- **Paketname:** `app.tonuinostudio.desktop` aus `identifier` in
  `tauri.conf.json`. Wer ihn ändert, bekommt eine andere App: Updates über
  die alte gehen dann nicht mehr.

## Bekannte Grenzen

- Nichts ist signiert. Windows SmartScreen warnt beim ersten Start des
  Installers („Weitere Informationen“, dann „Trotzdem ausführen“). Einen
  Auto-Updater gibt es nicht.
- Kein MSI-Paket (WiX läuft nur unter Windows). Das macOS-Paket baut nur
  GitHub Actions (siehe oben), unsigniert und auf keinem Mac durchgespielt.
- Unter macOS beenden Cmd+Q und „Beenden“ im Dock die App
  sofort, auch während sie auf die SD-Karte oder die Box schreibt. Die Frage
  vor dem Schließen kommt dort nur beim Schließen des Fensters (roter Knopf,
  Cmd+W). Dem Fenster-Unterbau (tao 0.37) fehlt dafür der Haken
  `applicationShouldTerminate`.
- Der Windows-Installer ist nur unter Linux gebaut und geprüft (Dateityp,
  DLL-Importe, Inhalt), aber nicht unter Windows ausgeführt. Das gilt auch für
  den WebView2-Hook: Er steckt übersetzt im Installer, ist aber auf keinem
  Windows ohne WebView2 durchgespielt.
- Der MSVC-Weg ist nicht erprobt: Beim Einrichten waren Microsofts
  Download-Server gesperrt, cargo-xwin brach beim Laden von
  `https://aka.ms/vs/17/release/channel` ab.
- Das AppImage bringt keine udev-Regeln mit. Die App richtet den USB-Zugriff
  dann einmalig selbst ein (fragt nach dem Admin-Passwort).
- Den Paketnamen im .deb bildet Tauri aus dem Produktnamen, das ergäbe
  `ton-uino-studio`. Das Skript setzt ihn danach mit `dpkg-deb` auf
  `tonuino-studio`, so heißen auch Programm, Symbol und udev-Regel (entfernen
  mit `sudo apt remove tonuino-studio`). Ohne `dpkg-deb` auf dem
  Build-Rechner bleibt Tauris Name. Die Dateinamen enthalten Leerzeichen.
