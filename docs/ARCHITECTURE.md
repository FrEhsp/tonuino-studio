# TonUINO Studio: Architektur und Konventionen

TonUINO Studio ist eine App für TonUINO-Boxen: SD-Karte verwalten, Hörspiele
hinzufügen, Sticker drucken, RFID-Karten beschreiben, Firmware aufspielen.
Sie läuft als Web-App (Chrome, Chromium, Edge; Firefox und Safari über Pakete,
siehe unten) und als Desktop-App (Tauri 2) aus demselben Code. Zielgruppe
sind auch Familien ohne Technikwissen.

## Aufbau

```
src/
  platform/types.ts   Schnittstellen zur Plattform (Dateien, USB-Seriell, NFC, Audio)
  platform/web/       Umsetzung mit Browser-APIs (File System Access, Web Serial)
  platform/tauri/     Umsetzung über Befehle der Desktop-App (src-tauri)
  core/               Reine Logik ohne Oberfläche, mit vitest getestet
    tonuino/          Kartenformat, Modi, SD-Regeln, Gesundheitscheck, Katalog
    firmware/         Intel-HEX, STK500v1, Varianten, Aufspielen, Log-Übersetzung,
                      Firmware-Baukasten (baukasten.ts, extraslog.ts)
    audio/            MP3-Frames, verlustfreies Schneiden, Pausen, Lautheit, Kodierung
    stickers/         Etikettenvorlagen, Layout, Rendern, PDF
    sources/          „Entdecken“: Liste prüfen, laden, filtern, Dateien laden, Herkunft
    zip/              CRC-32, ZIP schreiben (nur „stored“) und lesen, für Pakete
  ui/                 Gestaltungssystem: Tokens, Komponenten
  features/           Bildschirme: Regal, Hinzufügen, Entdecken, Sticker, Karten,
                      Werkstatt, Hilfe (help/topics.ts), Einstellungen
src-tauri/            Rust-Teil der Desktop-App
scripts/              Werkzeuge für den Build; licenses.ts legt die Lizenztexte aller
                      npm-Pakete und Rust-Crates als lizenzen.json neben die App,
                      sources/ baut und prüft die Liste für „Entdecken“,
                      firmware/build_baukasten.py baut die TNG-Firmware mit Extras
                      nach public/firmware/baukasten (docs/FIRMWARE-BAUKASTEN.md)
sources/              Katalog der Quellen für „Entdecken“ und die mitgelieferte Liste
                      (Ablauf in sources/README.md)
tests/                vitest-Tests, gespiegelt nach Bereich (tests/audio, tests/firmware, …)
```

## Was in welchem Build steckt

Vite setzt beim Build Konstanten (vite.config.ts, Typen in
`src/build-env.d.ts`). Code hinter einer falschen Konstante fällt beim Build
heraus, samt Texten, Hilfe-Abschnitten und Suchwörtern der Hilfe.

- `__DESKTOP_BUILD__`: nur in der Desktop-App (Plattform `src/platform/tauri`,
  Titelansagen, NFC-Leser, Boxen im WLAN). Die Web-App enthält davon nichts.
- `__SOURCES_ENABLED__`: „Entdecken“ ist an, wenn eine Liste mitkommt
  (`sources/snapshot/index-v1.json` nicht leer) oder eine Adresse für die
  Liste gesetzt ist (`VITE_SOURCES_INDEX_URL`, in der Desktop-App auch
  `VITE_WEB_ORIGIN`). Sonst fehlen Menüpunkt, Tipp, Hilfe, Zeilen im
  Datenschutz und die Seite; `#/entdecken` führt zur Startseite. Die Regel
  steht in `src/features/sources/release.ts`, die Prüfung vor dem Release
  und die Einstellungen in docs/BUILD.md.

`tests/build/webBuild.test.ts` baut die Varianten und prüft das.

## Entdecken

- **Liste:** `src/core/sources/load.ts` lädt sie nur von der eigenen
  Webseite der App (`quellen/index-v1.json` neben der Web-App, in der
  Desktop-App unter `VITE_WEB_ORIGIN`) oder von der Adresse, die der Build in
  `VITE_SOURCES_INDEX_URL` bekommt, sonst die zuletzt geladene Kopie aus
  dem Browser-Speicher, sonst die mitgelieferte. Die Sperrliste (`blocked`)
  der neuesten Liste gilt auch für ältere Kopien. Die Liste baut ein
  täglicher Lauf (`scripts/sources/build-index.ts`) aus `sources/catalog.json`.
- **Empfehlungen und Qualität:** Der Lauf filtert Trailer, zu kurze Titel
  und schlechte Tonqualität (`src/core/sources/quality.ts`, Schwellen als
  Konstanten) und übernimmt Empfehlungen der Redaktion. Dafür hat die Liste
  zwei optionale Felder, `featured` (`{rank, why}`, an Quelle oder Titel) und
  `sparse` (Titel ohne Beschreibung); sie bleibt Format 1, ältere Apps
  übergehen die Felder. Die Reihenfolge und der Abschnitt „Empfehlungen“
  stehen in `src/core/sources/filter.ts`, der Hinweis zu bekannten
  Kaufserien in `src/core/sources/commercial.ts`. Die Startseite zeigt
  Empfehlungen nur aus einer Liste, die die App schon hat, sie lädt nichts.
- **Cover:** Das optionale Feld `cover` (an Quelle oder Titel, Format 1)
  füllt der Lauf aus dem, was die Quelle selbst veröffentlicht; die Regel für
  erlaubte Hosts steht in `src/core/sources/cover.ts` und gilt für Lauf,
  Katalog und App. `SourceCover` (`src/features/sources/parts.tsx`) zeigt das
  Bild nur auf „Entdecken“ (ohne Referrer und Cookies), sonst und bei Fehlern
  das gezeichnete Cover; die Startseite bekommt nie ein Bild.
- **Anbieter:** Erst beim Reinhören oder Laden spricht die App mit dem
  Anbieter einer Datei, immer ohne Referrer. Dateien, die die App selbst
  lädt, holt sie ohne Cookies (`src/core/sources/download.ts`); was sie nur
  abspielen kann, spielt der Browser mit den Cookies des Anbieters
  (`src/features/sources/Preview.tsx`), so steht es auch im Datenschutz.
- **Übergabe:** Geladene Dateien gehen durch den normalen Ablauf von
  „Hinzufügen“ (`src/core/sources/handoff.ts`). Ordnernummern vergibt dieser
  Ablauf wie sonst auch.
- **Herkunft:** `src/core/sources/origin.ts` schreibt Urheber, Lizenz und
  Quelle in die Tags der Datei und in den Katalog der Karte: jeder Ordner hat
  `origins`, jeder Titel daraus `origin` mit deren Id
  (`src/core/tonuino/catalog.ts`). Der Ordner zeigt sie unter „Herkunft“
  (`OriginsSection.tsx`).
- **Hilfe:** Der Abschnitt `entdecken` im Thema „Musik“ und die Zeilen im
  Datenschutz stehen in `src/features/help/topics.ts`; die Seite verlinkt
  dorthin („Woher kommen die Inhalte?“).

## Regeln

- **Sprache:** Oberflächentexte und Fehlermeldungen auf Deutsch, in der Du-Form,
  kurz und ohne Fachbegriffe. Jede Fehlermeldung sagt, was passiert ist und was
  man jetzt tun kann. Code, Bezeichner und Kommentare auf Englisch.
- **Keine neuen Abhängigkeiten:** nur Pakete aus `package.json` und Crates aus
  `src-tauri/Cargo.toml` verwenden (Features bereits deklarierter Crates dürfen
  angepasst werden). Fehlt etwas Wesentliches, nicht installieren, sondern melden.
- **TypeScript strict**, kein `any` ohne Grund. Logik in `src/core` bleibt frei
  von DOM-Zugriffen, wo es geht, damit sie in Node getestet werden kann.
  Browser-only-Code (Canvas, Web Worker, WebCodecs) liegt in eigenen Dateien.
- **Tests:** `npm test` (vitest, Node-Umgebung). `npm run typecheck` muss
  fehlerfrei sein. Rust: `cargo test` und `cargo clippy` in `src-tauri`.
- **Nichts geht still kaputt:** Funktionen, die auf der SD-Karte löschen oder
  umbenennen, liefern zuerst einen Plan (Vorschau) und führen ihn erst danach aus.
  Ordnernummern werden nie automatisch verändert, weil Karten auf sie zeigen.
- **SD-Karte:** Ordner `01`–`99`, Titel `001.mp3`–`255.mp3`, Systemordner `mp3`
  und `advert` mit `0001.mp3`. Im Hauptverzeichnis legt die App nur
  `tonuino-studio.json` (Katalog) und `tonuino-studio-covers.zip` (Cover) ab,
  niemals weitere Ordner. Geschrieben wird in aufsteigender Reihenfolge.
- **Internet:** Die App geht nur ins Internet, wenn jemand etwas öffnet oder
  startet. Jede Verbindung steht in der Hilfe unter „Datenschutz“
  (`datenschutz` in `src/features/help/topics.ts`); eine neue braucht dort
  eine Zeile. `index.html` setzt `no-referrer`: fremde Dienste erfahren nicht,
  von welcher Seite eine Anfrage kommt. Keiner der genutzten Dienste braucht
  den Referrer.
- **Aussehen:** Seit 0.2 gibt es nur noch einen Stil, „Holzwerkstatt“
  (`src/ui/stil.ts`). Tokens stehen in `tokens.css`, eigene Regeln in
  `stil-holz.css`, alle unter `:where(:root[data-stil='holz'])`; `index.html`
  setzt das Attribut vor dem ersten Bild. Eine Regel aus einem gemeinsamen
  Blatt, die `stil-holz.css` wiederholt („As in layout.css, repeated …“), muss
  dort gleich bleiben: `tests/ui/stilcopies.test.ts` meldet, welche Kopie
  mitzuändern ist. Der Stil ist absichtlich handgemacht (Stempel, Filzstift,
  krakelige Rahmen, harte Schatten, Arcade-Knöpfe, Sperrholz); er wird nicht
  „glatter“ gemacht. Holz ist Akzent (Regal, Seitenleiste), große Flächen
  sind helles Papier, Tusche ist fast schwarz. Für Ordner ohne Bild zeigt die
  App den echten Sticker, nie ein ausgedachtes Bild.
- **Tempo:** Keine Version darf langsamer sein als die vorige (Start, Springen
  beim Start, Regal, Abspieler, Hinzufügen). Vor jeder Veröffentlichung
  `node scripts/bench/run.mjs --refs <vorige Version>,WORKTREE` (siehe
  `scripts/bench/README.md`), auf einem Test-PC `scripts/bench/test-pc.sh`
  (`scripts/bench/PC-MESSEN.md`). Schneller wird es durch weniger Arbeit, nie
  durch einen glatteren Look. Das erste Bild kommt mit seinen Schriften
  (`src/ui/fontsReady.ts`); Rahmen messen erst alle Kästen und schreiben dann
  (`src/ui/drawnFrames.ts`); verdeckte Seiten (App.tsx) malen nichts neu,
  solange sie nicht zu sehen sind.
- **Töne:** Alle Töne kommen aus `src/ui/sound.ts`, alle hängen am Schalter
  „Töne“, und nie gibt es einen bei Fehlern. Das „Pling“ (`playDoneSound()`)
  heißt „die SD-Karte ist fertig“: Hörspiele auf der Karte, Karte neu
  aufgebaut oder kopiert, Ansagen drauf. Im Paket-Modus kommt es erst, wenn
  das Paket auf der Karte geprüft ist. Sticker, Firmware und Reparaturen
  bleiben still. Daneben gibt es nur zwei leise Klopfer (`playCue()`, mit Web
  Audio erzeugt): ein „Klack“, wenn eine NFC-Karte am USB-Leser beschrieben
  ist, und einen Doppelklopfer, wenn in „Box testen“ alles angekommen ist. Der Ton der Box
  (`advert/0262.mp3` auf TNG-Karten) gehört nicht der App: Sie liest ihn nur
  zur Laufzeit von der Karte der Nutzerin oder des Nutzers und spielt ihn ab,
  liefert ihn nie mit, kopiert, lädt oder speichert ihn nie. Ohne ihn spielt
  sie einen mit Web Audio erzeugten Zweiklang; mitgelieferte Tondateien gibt
  es nicht. `mp3/0944` ist eine Ansage, kein Jingle.
- **Git:** Nur der Hauptentwickler committet. Mitarbeitende Agenten führen keine
  git-Befehle aus und ändern nur die ihnen zugeteilten Dateien.

## Browser ohne Dateizugriff (Firefox, Safari)

Welche Art die App nimmt, entscheiden nur Fähigkeiten, nie der User-Agent:
`showDirectoryPicker` vorhanden heißt direkter Zugriff (`capabilities.sd`),
sonst Ordnerauswahl per `<input webkitdirectory>` oder Ziehen der Karte
(`capabilities.sdPackage`, `platform.cardSnapshot`). Die Desktop-App und
Chrome/Edge laufen unverändert.

Ausnahme sind Handys und Tablets: Ihre Browser haben eine Ordnerauswahl,
kommen aber nicht an die SD-Karte. `src/platform/web/handheld.ts` erkennt sie
am System (Android, iPhone, iPad, `userAgentData.mobile`) oder an einem
reinen Touch-Bildschirm bis 1366 px; Windows, ChromeOS und Macs ohne
Touch-Bildschirm gelten immer als Computer. Dort gibt es weder Karte noch
USB (`platform.handheld`), und die App zeigt zuerst „Bitte am Computer
öffnen“ (`src/app/HandheldNotice.tsx`). Ein schmales Fenster am Computer
bleibt ein Computer.

- **Abbild (Snapshot):** `src/platform/snapshot.ts` und `blobtree.ts` machen aus
  der Ordnerauswahl einen Baum aus `File`-Verweisen. Gelesen wird erst bei Bedarf.
- **Overlay:** `src/platform/overlay.ts` legt darüber ein `Dir`, in das die App
  wie gewohnt schreibt (Copy-on-Write). Neue Daten liegen im OPFS
  (`src/platform/web/scratch.ts`) oder, wo das fehlt, im Speicher mit Budget.
  Reste älter als 48 Stunden räumt der Start weg, außer denen eines noch
  offenen Tabs: Jeder Tab hält für seinen Ordner einen Web Lock. Ohne Web
  Locks räumt die App nichts weg.
- **Paket:** `src/core/tonuino/writeplan.ts` vergleicht Abbild und Overlay,
  `package.ts` stellt den Inhalt zusammen (ganze Ordner, „Nur die Änderungen“
  oder „Karte komplett neu aufbauen“), `buildPackageBlob` baut daraus ein
  ZIP als `Blob`, ohne die Daten zu kopieren. `guide.ts` erzeugt die Anleitung
  je System, `verify.ts` prüft danach die neu eingelesene Karte gegen das
  Manifest. `src/app/pending.ts` hält die Sitzung (sauber, wartend,
  heruntergeladen) und sperrt strukturelle Änderungen, solange ein
  heruntergeladenes Paket aufs Entpacken wartet.
- **Karte prüfen:** `checkCardContent` in `verify.ts` vergleicht erst Namen
  und Größen (`checkCard`) und liest dann die Dateien der App im Wurzelordner
  und alle Dateien bis 1 MiB, um die CRC-32 aus dem Manifest zu vergleichen.
  So fällt ein älteres Paket mit gleich großen Dateien auf. Große Titel
  gleicher Größe vergleicht nur „Gründlich prüfen“.
- **Wartendes Paket merken:** Nach dem Download legt `pending.ts` das Manifest
  unter `tonuino-studio:waiting-package` im `localStorage` ab, mit der
  Katalog-ID der Karte und einem Fingerabdruck ihres Wurzelordners
  (`src/core/tonuino/cardprint.ts`: jeder Eintrag mit Bytes und Dateien, wie
  eingelesen und wie das Paket ihn macht). Eine Karte mit Katalog erkennt die
  App an der ID, eine ohne Katalog daran, dass jeder Eintrag so ist wie beim
  Einlesen, wie nach dem Paket oder (beim Entpacken) gelöscht. Eine andere
  Karte ohne Katalog sperrt so nichts. Zwei Karten mit genau gleichem Inhalt
  (etwa zwei leere) kann ein Browser nicht unterscheiden, ohne auf sie zu
  schreiben: Dort wartet das Paket auf beiden, und „Paket verwerfen“ gibt
  die andere frei. Wird dieselbe Karte (beim kompletten
  Neuaufbau auch eine leere) nach einem Neustart eingelesen und hat sie das Paket noch nicht,
  stellt die App den Zustand „heruntergeladen“ wieder her (Overlay ganz
  gesperrt, `restored: true`). Nach „Karte prüfen“
  oder „Paket verwerfen“ ist der Eintrag weg. Geht `localStorage` nicht, fehlt
  nur diese Erinnerung.
- **Paket von woanders:** Prüft die Werkstatt eine Karte mit einem fremden
  Paket, während eigene Änderungen oder ein eigenes Paket warten, setzt
  `foreignPackageChecked` in `pending.ts` den Zustand `cardChangedElsewhere`.
  Bis die Nutzerin oder der Nutzer den neuen Stand übernimmt oder die Karte
  neu einliest, baut die App kein Paket aus dem alten Einlesen und plant
  nichts Neues (`canChangeCard()` ist falsch, `ChangedElsewhere.tsx` sagt warum).
- **Kein Paket mitten im Schreiben:** Solange der Schreibschutz
  (`src/app/writeguard.ts`) für `tracks`, `repair`, `order` oder `sounds`
  gehalten wird oder das Overlay noch eine Datei speichert
  (`overlay.writing`), bauen `makePackage` und `startPackageDownload` kein
  Paket (`copyBusy`, `BUSY_TEXT` in `pending.ts`). Sonst käme ein halbes
  Album ohne Katalogeintrag auf die Karte.
- **Format und Zeiten:** Eine eingelesene Karte behält ihre eigene `info`
  (`volumeInfo` in `src/app/state.ts`). Das Overlay gibt neuen Dateien die
  Zeit von jetzt; daraus darf der Gesundheitscheck nicht „nicht FAT32“
  raten (`fileTimesFromCard` bleibt aus).
- **Hilfe:** Abschnitte mit `packageOnly` (Paket, Karte komplett neu aufbauen)
  stehen bei der Suche in Chrome, Edge und der Desktop-App hinter allen
  anderen (`searchHelp(…, { packageMode })`).
- **Die App schreibt in dieser Art nie auf die Karte.** Alles geht über das
  Paket, das die Nutzerin oder der Nutzer selbst entpackt.
- **ZIP-Regeln** (`src/core/zip/zipwriter.ts`): nur „stored“, keine
  Datendeskriptoren, „made by“ Unix (Host 3), damit `unzip` unter Debian und
  Ubuntu UTF-8-Namen richtig liest, ZIP64 nur wo nötig. Die Einträge behalten
  die Reihenfolge: `unzip` und Python legen sie so an (für `ditto` auf dem Mac
  steht die Prüfung am echten Gerät noch aus), und auf FAT ist das die
  Reihenfolge, in der die Box abspielt.
- **Reihenfolge im Abbild:** Ob Firefox und Safari einen Ordner in der
  Reihenfolge auf der Karte liefern, ist nicht geprüft.
  `SNAPSHOT_LISTING_IS_FAT_ORDER` (in `snapshot.ts`) steht deshalb auf `false`,
  und der Gesundheitscheck beurteilt die Reihenfolge der Titel dort nicht.
- **Browser-Prüfungen:** `tests/e2e/*.mjs` laufen außerhalb von `npm test` mit
  Playwright in Chromium. Für die Paket-Art entfernen sie vor dem Start
  `showDirectoryPicker`, `showOpenFilePicker`, `showSaveFilePicker`,
  `getAsFileSystemHandle` und `navigator.serial`. Gefälschte SD-Karten sind
  Ordner auf der Festplatte; jedes Paket wird mit `unzip -t` geprüft und so
  entpackt, wie es die Anleitung sagt. Die Dateien der gefälschten Karten
  haben Zeiten wie auf FAT32 (`fatTimes`). Aufruf und Variablen stehen in
  `tests/e2e/lib.mjs`.

## Quellen

- TonUINO-TNG-Quellcode und Doku: Kartenformat `src/chip_card.*`, Modi
  `src/state_machine.cpp`, Log-Meldungen `LOG(...)` in `src/*.cpp`.
- Bedarfs-Audit mit Forumsbelegen: siehe Projektdateien `recherche/audit/`.
