# Box-Simulator: die App gegen die echte TNG-Firmware prüfen

Teil des Testlabors (TODO #66, #69, [TESTLABOR.md](TESTLABOR.md); dort läuft
er mit `npm run test:labor`). Nicht in der App, nur für unsere Prüfrunden vor
jedem Release.

Der Simulator (`scripts/firmware/boxsim.c`) lässt einen Build aus dem
Firmware-Baukasten (`public/firmware/baukasten/`) unverändert auf einem
simulierten ATmega328P laufen (simavr). Drumherum steckt eine nachgebaute Box:

- **DFPlayer Mini** an SoftwareSerial D2/D3 (9600 Baud, Busy an D4): versteht
  die Befehle der Firmware, antwortet mit „online“, Titelzahl, Titelende und
  Fehlern; kleine SD-Karte mit Ordnern und den echten Systemansagen von TNG
  (`boxsim-sounds.tsv`: Länge und Text jeder Ansage, aus TNG `sd-card/`).
- **RC522-Kartenleser** an SPI: MIFARE Classic 1K, Ultralight, NTAG213/215/216
  mit eigenem Speicher je UID, Schlüssel, Schreibschutz, wackliger Karte.
- **Tasten** (3 oder 5, kurz, lang, gehalten, zusammen), **Drehgeber**,
  **Poti**, **Kopfhörerbuchse** (D8), **USB-Seriell** (115200 Baud, DTR-Reset).

Die Tests unter `tests/boxsim/` lassen die App-Teile, die mit der Box reden,
gegen diese Box laufen. Ohne Simulator werden sie übersprungen, `npm test`
bleibt also wie es ist.

## Vor jedem Release

```sh
sudo apt-get install gcc simavr libsimavr-dev   # einmal
npm run test:boxsim                             # alles, etwa 5 Minuten
npm run test:boxsim -- usb                      # nur tests/boxsim/usb*
BOXSIM_KEEP=1 npm run test:boxsim -- keys       # Ordner mit Simulator und Builds behalten
```

Auf dem Mac läuft er in `.github/workflows/mac-test.yml`: simavr 1.6 (wie
Debian und Ubuntu) aus dem Quelltext, mit GCC gebaut, über `SIMAVR_PREFIX`.
Mit simavr aus dem aktuellen master schlagen `cards` und `usb` fehl (auch
unter Linux): die Karten antworten dort mit anderem Takt. simavr 1.6 mit
clang gebaut bleibt nach dem Start der Box hängen (auch unter Linux).

`scripts/firmware/boxsim-run.mjs` baut den Simulator, packt nur die Builds
aus, die die Tests brauchen (`BUILDS` dort), in einen Ordner unter `/tmp`,
lässt die Tests mit `nice` und eine Datei nach der anderen laufen und löscht
den Ordner wieder. Alles muss grün sein. Schlägt etwas fehl, steht im Fehler
das Protokoll der Box (Zeit, Logzeile, Ansage, Karte, Taste).

Neuer TNG-Stand im Baukasten: einmal laufen lassen. Ändert die Firmware ihre
Logzeilen oder Ansagen, zeigt sich das hier zuerst.

Einen Kandidaten prüfen, bevor er in die App kommt
([FIRMWARE-BAUKASTEN.md](FIRMWARE-BAUKASTEN.md), „Einen neuen Stand
übernehmen“): `BOXSIM_BAUKASTEN=/pfad/zum/kandidaten npm run test:boxsim`.
Der Ordner kommt von `build_baukasten.py --candidate` und hat ein eigenes
`manifest.json`. `boxsim-run.mjs` schreibt den TNG-Stand nach `tng.json`;
`tests/boxsim/boxsim.ts` liest ihn als `SIM_TNG`, und die Tests erwarten
die Versionszeile dieses Stands.

## Was geprüft wird

| Datei | App-Teil | gegen die echte Firmware |
|---|---|---|
| `start.test.ts` | Box-Logbuch, Steckbrief (`bootlog.ts`, `logexplain.ts`, `boxfacts.ts`) | Start von Classic 3/5, AiO 5, writeCard-Build; Kopfhörer; Leser fehlt, Nachbau-Chips, MP3-Player fehlt, SD-Karte fehlt, Neustart, leerer Ordner, fehlende Datei, falscher Schlüssel, alte Karte |
| `usb.test.ts` | Box erkennen (`detect.ts`), Einstellungen nach dem Update (`aftercheck.ts`), „Kann die Box Karten schreiben?“ und „Über USB an die Box“ (`writecard.ts`, `usbwrite.ts`) | in Echtzeit über den simulierten USB-Anschluss; Karten werden wirklich in den Kartenspeicher geschrieben und zurückgelesen (Classic, NTAG215, Ultralight, Admin-Karte); Abbrechen, Box spielt, Schreibfehler |
| `guides.test.ts` | Box einstellen (`settingsguide.ts`), Kopfhörer-Grenzen (`headphones.ts`), Karte an der Box anlernen (`boxguide.ts`, auch Einzelkarten am Stück) | jede Taste jedes Schritts wird gedrückt, die Box muss sagen, was der Schritt verspricht; danach Neustart und Einstellungen aus dem Log bzw. Kartenspeicher prüfen |
| `keys.test.ts` | Admin-Tasten (`adminkeys.ts`), Werkseinstellung beim Einschalten, Tasten und Teile testen (`partstest.ts`), Box testen (`boxtest.ts`), Extras (`extraslog.ts`), Lautstärke-Grenzen | |
| `cards.test.ts` | Kartenleser testen (`readertest.ts`), schneller Kartenwechsel (TNG Issue 347, Hilfe) | |

`tests/boxsim/boxsim.ts` ist die Brücke: `BoxSim` startet einen Build und
nimmt Skriptbefehle, `sim.serial` ist ein `SerialAccess` wie die echte Box am
Kabel. `tests/boxsim/guide.ts` führt eine Anleitung der App Schritt für
Schritt an der Box aus und hört mit.

## Den Simulator von Hand benutzen

```sh
gcc -O2 -o /tmp/boxsim scripts/firmware/boxsim.c -I/usr/include/simavr -lsimavr -lm
printf 'until enter Idle\ncard classic tonuino=3,2\nwait 5\npress up\nwait 2\n' \
  | /tmp/boxsim --sounds scripts/firmware/boxsim-sounds.tsv classic-3.bin
```

Optionen und Befehle stehen oben in `boxsim.c`. `--bat-pin MV` legt eine
Spannung an A5 (Akku-Messung hinter dem Spannungsteiler), für Builds mit
`BAT_VOLTAGE_MEASUREMENT`. Jede Zeile der Ausgabe hat die
simulierte Zeit und eine Quelle (`box|` Logzeile, `mp3|` Ansage oder Titel,
`rfid|` Karte, `key|` Taste). Ohne `--realtime` vergeht Zeit nur während
`wait`, `until` und `press`, etwa fünfmal schneller als echt.

## Kartenmodell

Eine Karte, die nach dem Auswählen eine neue Anfrage (REQA) bekommt, fällt
nach ISO 14443-3 still in den Ruhezustand. TNG fragt alle 50 ms an
(`chip_card.cpp` `getCardEvent`), eine liegende Karte antwortet also nur jedes
zweite Mal und ist die Hälfte der Zeit nicht ausgewählt. Gelesen wird sie
direkt nach dem Auswählen, das geht immer. Geschrieben wird beim Anlernen aber
ohne neues Auswählen (`writeCard`): Liegt die Karte schon die ganze Zeit
(neue, leere Karte), schlägt das im Simulator in etwa der Hälfte der Fälle mit
`Auth failed: 3` und „Oh weh! Das hat leider nicht geklappt!“ fehl. Wird die
Karte erst aufgelegt, wenn die Box danach fragt (Admin-Menü, Einzelkarten,
über USB), klappt es immer.

Ob echte Karten so reagieren, zeigt nur eine echte Box (siehe unten). Bis
dahin ist das ISO-Verhalten der Standard; `--reqa-answers` lässt die Karte
jede Anfrage beantworten. Die Tests der leeren Karte nutzen diesen Schalter,
damit sie die Anleitung prüfen und nicht den Zufall.

## Was nur an einer echten Box geht

- Ton: ob Lautsprecher, Verstärker und Kopfhörer wirklich etwas hören lassen,
  Lautstärke-Empfinden, Rauschen.
- Funk: Störungen und Reichweite des Kartenlesers, Karten am Rand, Metall,
  zwei Karten zugleich; das echte Verhalten liegender Karten (oben).
- Strom: Einbrüche, Akku, Brummen, Wackelkontakte, ein USB-Kabel ohne Daten.
- Eigenheiten echter DFPlayer-Nachbauten (MH2024K, GD3200B …): der Simulator
  hat einen braven DFPlayer, Doppelmeldungen nur mit `--mp3-double-finish`.
- AiO (LGT8F328P): läuft als ATmega328P mit angepasstem SoftwareSerial-Takt,
  nur annähernd. Das AiO+ (ESP32) gar nicht.
- Bootloader und Flashen, CH340-Treiber, 3×3-Tastenfeld, LED-Ring.

Prüfliste für eine echte Box: zehn leere Karten nacheinander an der Box anlernen
(„Oh, eine neue Karte!“) und zählen, wie oft „Oh weh!“ kommt; eine Karte
über USB schreiben und die Admin-Karte zurücklesen; Einzelkarten am Stück mit
einer Karte, die zu früh aufliegt.
