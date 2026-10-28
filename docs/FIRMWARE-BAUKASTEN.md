# Firmware-Baukasten

TonUINO TNG hat Extras, die man nur beim Bauen der Firmware einschalten kann
(`#define` in `src/constants.hpp` oder `-D` beim Compiler): Drehregler, Poti,
Leuchtring, leuchtende Tasten, Kopfhörer-Erkennung und mehr. Die fertigen
Builds auf tonuino.github.io haben davon nichts eingeschaltet. Bisher hieß das:
Arduino IDE oder PlatformIO installieren, eine Zeile auskommentieren, selbst
bauen.

Der Baukasten nimmt das ab: Unter „Firmware aufspielen“ → „Fertige Firmware“
gibt es den Bereich **Extras**. Wer dort etwas anhakt, bekommt eine fertig
gebaute Firmware mit genau diesen Extras. Ohne Extras kommt der Build ohne
Extras: Classic und AiO bekommen seit 0.6 immer einen Build des Baukastens,
nie den neuesten Stand von tonuino.github.io (siehe „Geprüfter Stand“). Alle Builds liegen in der App
(`public/firmware/baukasten/`), es wird nichts heruntergeladen und nichts
installiert.

Issues: #30 (Drehregler/Poti), #32 (Baukasten), #25 (Leuchtring).

## Geprüfter Stand: welche Firmware die App aufspielt (#135)

tonuino.github.io hat immer den neuesten Stand von TNG `main`. Seit dem
26.10.2026 ist das „V3.3.4 26.10.26“ (PR #343: `config.hpp`, Einstellungen
Version 3, Akku-Abgleich), ohne Release. Hätte die App weiter von dort
geladen, käme ungeprüfte Firmware auf die Boxen, sobald jemand in TNG etwas
zusammenführt.

Deshalb spielt die App nur noch **einen geprüften Stand** auf:

- **Classic und AiO:** „Fertige Firmware“ ist der Build ohne Extras aus dem
  Baukasten (`classic-3`, `aio-5`, …). Er liegt in der App, wird nicht
  heruntergeladen und ist mit dem Box-Simulator geprüft. Mit Extras kommt
  der passende Baukasten-Build, wie bisher. `wizard.ts` `wantedBuildId`
  liefert dafür immer eine ID.
- **AiO+:** Der Baukasten kann den ATmega4809 nicht bauen. Die App lädt
  weiter von tonuino.github.io, liest aber die Versionszeile im Image
  (`firmwareVersion`). Ist es nicht der geprüfte Stand, steht ein Hinweis da,
  und „Weiter“ geht erst nach dem Haken „Ich möchte diese Firmware trotzdem
  aufspielen“ (`FirmwareChoice.unchecked`, `acceptUnchecked`).
- **ESP32:** Das Update läuft über die Webseite der Box. Die App sagt nur,
  welcher Stand geprüft ist.

Wo der Stand steht, alle an einer Stelle:

| Stelle | Was |
|---|---|
| `scripts/firmware/build_baukasten.py` `TNG_STANDS`, `PINNED_STAND` | Commit, Version, Datum, Art der Konfiguration (`-D` oder `config.hpp`) |
| `public/firmware/baukasten/manifest.json` `tng` | was gebaut wurde (`versionString`, `commit`, `date`, `config`) |
| `src/core/firmware/tngstands.ts` `TNG_STANDS`, `CHECKED_TNG` | was die App über jeden Stand weiß (Logbuch, Box einstellen, Hinweise) |
| `tests/firmware/baukasten.test.ts` | prüft, dass `CHECKED_TNG` und Manifest gleich sind |

### Einen neuen Stand übernehmen

Ohne Frank: Jeder Schritt ist ein Befehl, und ein roter Test hält an.

1. Commit eintragen: in `build_baukasten.py` `TNG_STANDS` (Version wie in
   `src/version.hpp`, Commit, Datum, `config` = `"config.hpp"` ab PR #343).
2. Kandidat bauen, nur die Builds für den Simulator (etwa 1 Minute):
   `nice python3 scripts/firmware/build_baukasten.py --tng "V3.3.4 26.10.26" --candidate /tmp/kandidat`
3. Simulator gegen den Kandidaten:
   `BOXSIM_BAUKASTEN=/tmp/kandidat npm run test:boxsim` (etwa 5 Minuten).
   Rot heißt: Die Firmware verhält sich anders, als die App erwartet. Erst
   die App anpassen (meist `tngstands.ts`, `logline.ts`, `logexplain.ts`),
   dann weiter.
4. Grün: `PINNED_STAND` auf den neuen Stand setzen und alles bauen:
   `nice python3 scripts/firmware/build_baukasten.py --work /tmp/baukasten --jobs 2`.
5. In `tngstands.ts` den Stand eintragen (falls neu) und `CHECKED_TNG`
   darauf setzen. `npm test` muss grün sein (der Manifest-Test vergleicht).
6. `npm run test:boxsim` ohne `BOXSIM_BAUKASTEN`, dann diese Datei und die
   Tabelle der Quellen unten nachziehen.

`scripts/firmware/build_baukasten.py` prüft beim Bauen, dass
`src/version.hpp` des Commits wirklich die eingetragene Version nennt.

### Stand 27.10.2026: V3.3.4 geprüft, aber nicht übernommen

Geprüft bleibt **V3.3.3 17.09.26** (`d527ca5`). Der Kandidat V3.3.4
(`bd65503`) lief im Simulator durch (48 Tests), nachdem die App gelernt hat,
dass 5 Tasten dort ab Werk `IB:0` haben. Übernommen ist er nicht, weil:

- er kein Release ist (das README nennt schon 3.4.0),
- die Einstellungen in Version 3 gespeichert werden: zurück auf eine ältere
  Firmware bleibt „Ver:3“ stehen,
- die Akku-Messung auf Arduino-Platinen falsch rechnet (unten).

Das entscheidet Frank, oder der nächste Release von TNG.

**config.hpp:** Ab PR #343 liest TNG eine `config.hpp` neben `src/`. Der
Baukasten schreibt sie für solche Stände (`config_hpp()`), statt `-D` für
die TNG-Schalter zu setzen; die Platinen-Schalter des Frameworks bleiben
`-D`. Zwei Unterschiede: `NEO_RING` ist dort die Zahl der LEDs (der
Baukasten setzt `NEO_RING 24`), und ein anderer MP3-Chip braucht dazu
`DFMiniMp3_T_CHIP_Mp3ChipIncongruousNoAck`. Mit V3.3.4 sind die
`config.hpp`-Builds Byte für Byte gleich den `-D`-Builds (geprüft für
`classic-3`, `classic-5`, `aio-5`, `classic-3-encoder-weiter`). Alte Stände
ignorieren `config.hpp`, dort bleibt `-D`.

### Akku-Messung ab 26.10.2026

Mit `BAT_VOLTAGE_MEASUREMENT_CALIBRATION` loggt die Box alle 2 s
„BatVoltage: <mV>“ und nimmt „BAT <mV>“ über USB an. Das Box-Logbuch zeigt
dann „Akku-Messung abgleichen“ (`src/core/firmware/batcalib.ts`,
`BatteryCalibration.tsx`). Im Simulator
(`boxsim --bat-pin 1850`, Classic, V3.3.4 mit Akku-Messung und Abgleich)
zeigten sich zwei Fehler der Firmware:

1. `serial_input.cpp` liest das Wort mit `readBytesUntil(' ', cmdWord, 4)`
   und schließt es nicht mit 0 ab. `cmdWord[3]` ist, was auf dem Stack lag:
   „BAT 3700“ wurde ignoriert. Die App schickt deshalb `BAT`, ein NUL-Byte
   und ` 3700`; damit klappt es.
2. `batVoltage.cpp` rechnet `value*settings.voltMeasCorrection` und
   `voltMeasCorrection * voltageMeasurement` mit 16 Bit (int auf AVR). Bei
   1850 mV am Pin misst die Box etwa 33 mV statt 3,6 V; der Abgleich
   speichert einen Korrekturwert um 30. Ohne Abgleich-Schalter meldet die
   Box nach 10 s „BatVoltage empty“ und schaltet ab. ESP32 (32 Bit) ist
   nicht betroffen. Die App schickt bei so einer Messung nichts und erklärt
   „Akku leer“ mit diesem Fehler (`tngstands.ts` `batteryMathBrokenOnAvr`).

Beides wäre etwas für die TNG-Leute; es geht nur mit Franks OK hinaus.

## Was angeboten wird

| Extra (App)                         | Flags                                     | Classic | AiO |
|-------------------------------------|-------------------------------------------|---------|-----|
| Drehregler                          | `ROTARY_ENCODER`                          | nur 3 Tasten | nur 3 Tasten |
| Drehregler mit Vor und Zurück       | `ROTARY_ENCODER` `ROTARY_ENCODER_LONGPRESS` | nur 3 Tasten | nur 3 Tasten |
| Lautstärke-Knopf ohne Raster (Poti) | `POTI`                                    | nur 3 Tasten | nur 3 Tasten |
| Leuchtring                          | `NEO_RING`                                | ja (siehe Bootloader) | passt nicht |
| Leuchtring mit Lautstärke-Anzeige   | `NEO_RING` `NEO_RING_EXT`                 | ja (siehe Bootloader) | passt nicht |
| Leuchtende Tasten                   | `USE_LED_BUTTONS`                         | ja, nicht mit „Lautsprecher stumm“ | nein (A5) |
| Lautsprecher stumm beim Ein-/Ausschalten | `SPKONOFF`                           | ja | schon eingebaut |
| Kopfhörer-Erkennung                 | `HPJACKDETECT`                            | ja | nein (D8) |
| Abschaltung für CubieKid-/Trägerplatine | `USE_TRAEGER_PLATINE_SHUTDOWN`        | ja, kommt aus der Frage „Wie geht deine Box aus?“ | eigene Schaltung |
| Verhalten „Weitermachen“            | `RESUME_ON_SAME_RFID` `DONT_ACCEPT_SAME_RFID_TWICE` `REPLAY_ON_PLAY_BUTTON` `STORE_LAST_CARD` | ja | ja |
| MP3-Player-Chip MH2024K-24SS (hinter „Mehr“) | `DFMiniMp3_T_CHIP_MH2024K24SS_MP3_TF_16P_V3_0` | nur ohne Licht, „Lautsprecher stumm“, Kopfhörer | ja (3x3: passt nicht) |
| MP3-Player-Chip GD3200B/GD3200D (hinter „Mehr“) | `DFMiniMp3_T_CHIP_GD3200B` | wie oben | wie oben |
| MP3-Player-Chip LISP3 (hinter „Mehr“) | `DFMiniMp3_T_CHIP_LISP3` | wie oben | wie oben |
| Wecker-Start (hinter „Mehr“) | `SPECIAL_START_SHORTCUT` | nur ohne Licht, „Lautsprecher stumm“, Kopfhörer und anderen Chip | nein |
| Vorschau: Karten über die Box beschreiben | `SerialWriteCard`, **anderer TNG-Commit** (siehe unten) | nur ohne Licht, „Lautsprecher stumm“, Kopfhörer, anderen Chip und Wecker-Start; fast alle nur mit neuem Bootloader | passt nicht |

Drehregler, Poti und Licht schließen sich jeweils gegenseitig aus (je eine
Auswahl). Die Regeln stehen zweimal, gleich: in
`scripts/firmware/build_baukasten.py` (`matrix()`) und in
`src/core/firmware/baukasten.ts` (`knobBlocker`, `lightBlocker`, …).
`tests/firmware/baukasten.test.ts` prüft, dass beide und das Manifest
zusammenpassen: Jede erlaubte Auswahl hat einen Build oder steht unter
„passt nicht“, und jeder Build hat genau die Flags seiner Extras.

Das Verhalten „Weitermachen“ fasst vier Schalter zusammen, weil alle
Kombinationen einzeln zu viele Builds wären. Text in der App: „Dieselbe Karte
noch mal auflegen fängt nicht von vorn an, in der Pause geht es weiter.
Play/Pause ohne Karte spielt die letzte Karte, auch nach dem Ausschalten.“
(constants.hpp:318, 325, 332, 348).

### Wie der Drehregler sich verhält (wichtig für Hilfe und Tests)

- Ein Dreh wird in TNG zu einem Tastendruck (`rotary_encoder.cpp:61–70`,
  `getCommandRawFromCommand` 103–131). Mit 3 Tasten und der Werkseinstellung
  „Tastenbelegung“ = kurzer Druck ändert die Lautstärke (`IB:1`,
  `settings.cpp:70`) ist das `up`/`down`, sonst `upLong`/`downLong`.
- Was der Druck bewirkt, sagt die Tabelle in `commands.cpp:30–36`: Während
  die Box **spielt**, ist es immer lauter/leiser. In **Pause und Leerlauf**
  ist es mit `IB:1` „Ring heller/dunkler“ (`bright_up`/`bright_down`, ohne
  Leuchtring ohne Wirkung), mit `IB:0` die Kurzwahl 2/3 (`shortcut2`/`3`).
  Im Admin-Menü blättert ein Dreh durch die Einträge.
- „Drehregler mit Vor und Zurück“ (`ROTARY_ENCODER_LONGPRESS`,
  `rotary_encoder.cpp:72–92`): mehrere Rastungen schnell hintereinander ändern
  die Lautstärke; eine einzelne Rastung springt nach `buttonLongPress` = 1000 ms
  (constants.hpp:542) zum nächsten oder vorigen Titel.
- Classic und AiO fragen den Drehgeber per Timer ab
  (`rotary_encoder.hpp:13–16`, `ROTARY_ENCODER_USES_TIMER`), ohne Interrupt.
- Keine internen Pull-ups (`rotaryEncoderPullUp = false`, constants.hpp:214).
  Fertige Module wie KY-040 haben eigene Widerstände; ein nackter Drehgeber
  braucht zwei 10-kΩ-Widerstände nach 5 V.
- Poti: `map(analogRead(A3), 0, 1023, minVolume, maxVolume)` (`poti.cpp:24`),
  also die Grenzen aus „Box einstellen“.

### MP3-Player-Chip

Manche DFPlayer-Nachbauten brauchen eine eigene Einstellung
(constants.hpp:157–174). Die fertige Firmware hat keine davon; constants.hpp
setzt immer `DFMiniMp3_T_CHIP_Mp3ChipIncongruousNoAck` (Zeile 174), daran
ändert der Baukasten nichts. Die Chip-Defines schalten nur TNGs
Umgehungen ein:

| Chip | Was TNG dann anders macht | Typisches Zeichen |
|------|---------------------------|-------------------|
| MH2024K-24SS (MP3-TF-16P V3.0) | wartet 2500 statt 1200 ms auf den Titelstart (constants.hpp:592–593), wartet bei Ansagen einmal mehr auf den Busy-Pin (mp3.cpp:152–157), überhört „Titel fertig“ nach Ansagen (mp3.hpp:35–37) | Nur manche Dateien machen Ärger; nach einem bestimmten Titel reagieren die Tasten nicht mehr. Im Log flattert `isPlaying: 1/0`, dann `missing OnPlayFinished` (Forum 15006#1–#8) |
| GD3200B, auch GD3200D (z. B. Reichelt) | 2500 ms, spielt vor dem Zählen kurz Titel 1 des Ordners (mp3.cpp:332–348), überhört „Titel fertig“ nach Ansagen | Jeder Ordner hat so viele Titel wie Ordner 01 (Forum 13154#1–7) |
| LISP3 (z. B. DFRobot) | überhört „Titel fertig“ nach Ansagen | Nach einer Ansage springt die Box einen Titel weiter |

Nicht angeboten: `DFMiniMp3_T_CHIP_MH2024K16SS`. Es wählt in mp3.hpp:28–29
die Bibliotheks-Variante `Mp3ChipMH2024K16SS` (ohne Prüfsummen), die das
feste NoAck-Define in mp3.hpp:31–33 gleich wieder überschreibt. Das ginge nur
mit einer Änderung am Quelltext. Die App zeigt es ausgegraut mit diesem
Grund (`MH2024K16SS_TEXT` in mp3chip.ts), damit jemand mit diesem Chip es
findet.

Genau ein Chip-Define, wie es TNG im Kommentar verlangt, geht mit `d527ca5`
ebenfalls nicht: constants.hpp:174 setzt NoAck immer, ein `-D` kann das nicht
zurücknehmen. Die Chip-Builds haben deshalb NoAck **und** das Chip-Define;
die Bibliothek arbeitet dann wie bei den offiziellen Builds (NoAck), dazu
kommen TNGs Umgehungen für den Chip. TNGs PR #343 (Zweig `issue_342`, noch
nicht in main) setzt NoAck nur, wenn kein anderer Chip gewählt ist
(constants.hpp:195–202 dort), und bringt als sechste Wahl
`DFMiniMp3_T_CHIP_Original`. Sobald das in main ist und der Commit unten
nachgezogen wird, lassen sich alle Chips einzeln bauen, auch MH2024K16SS.

Die Chip-Builds gibt es für die üblichen Boxen: mit oder ohne Drehregler oder
Poti, Trägerplatine und „Weitermachen“, ohne Licht, „Lautsprecher stumm“
und Kopfhörer-Erkennung. Alle Chips mal alle Extras wären viermal so viele
Builds. Wer beides braucht, nimmt „Eigene Datei“.

`src/core/firmware/mp3chip.ts` hat dazu `suggestChip(evidence)`: Andere Teile
der App (Log-Auswertung, Erkennung von Nachbauten, eine Frage an den Nutzer)
geben dort hinein, was sie wissen (`chip`, `missingOnPlayFinished`,
`playingFlaps`, `onlySomeFiles`, `sameCountEveryFolder`,
`skipsAfterAnnouncement`, `current`), und bekommen den Chip mit einem Satz
Begründung zurück. Den Chip übernimmt der Assistent mit
`chooseExtras(s, { ...s.extras, chip })`.

### Vorschau: Karten über die Box beschreiben (TODO #93)

TNG kann mit `-D SerialWriteCard` eine Karte schreiben, die per USB kommt:
`WRITECARD <mode>,<folder>,<special>,<special2>`. Den Befehl hat donschoof
geschrieben (TNG PR #344); Boerge1 hat ihn in den Arbeitszweig `issue_345`
übernommen, PR #346 nach `main` ist noch offen. Eine offizielle Firmware mit
dem Befehl gibt es nicht, und auch nach dem Merge ist der Schalter aus.

Der Baukasten baut deshalb als Vorschau aus **`tonuino/TonUINO-TNG@abfa307`**
(Branch `issue_345`, „V3.3.3 08.10.26“, gleicher Unterbau `d527ca5` wie die
übrigen Builds, Quelle `tng-writecard` im Manifest) mit `-D SerialWriteCard`,
ohne `SerialInputAsCommand`. Nicht aus dem Fork donschoof/TonUINO-TNG: Der ist
von hier aus nicht erreichbar, und `abfa307` liegt im offiziellen Repo.
Gebaut wird wie beim Chip nur für die üblichen Boxen (Drehregler oder Poti,
Trägerplatine, „Weitermachen“), nicht zusammen mit anderem Chip oder
Wecker-Start. Die Original-TNG (`d527ca5`) bleibt Standard und unverändert;
alle anderen Builds sind Byte für Byte dieselben wie vorher.

- Größe: +1290 Bytes. `classic-3-writeCard` (30684) und
  `classic-3-traeger-writeCard` (30550) passen noch auf den alten Bootloader,
  alle anderen 22 Classic-Builds brauchen den neuen (bis 31638 Bytes, RAM
  höchstens 1637). **Die AiO passt nicht**: schon `aio-3-writeCard` hat 29982
  von 29696 Bytes (AiO 3x3: 30884). Die App graut die Wahl dort aus.
- Kartenformat und EEPROM: unverändert (`Chip_card::writeCard()` wie im
  Box-Menü, `settings.cpp` gleich). Der Wechsel zwischen Vorschau und
  Original-TNG ist in beide Richtungen gefahrlos; der Check vor dem Update
  sagt aber, dass das Kartenschreiben dann fehlt (`extrascheck.ts`, an der
  Zeichenkette `WRITECARD: ` im Image, auch bei einer künftigen offiziellen
  Firmware).
- **Erkennen der Box: nicht an der Firmware-Auswahl, sondern durch Fragen.**
  Nach dem Verbinden (Box-Logbuch, Box testen, Karten beschreiben) schickt die
  App, sobald die Box nach dem Start ruhig ist, `WRITECARD CANCEL`
  (`logsession.ts`, `WriteCardProbe` in `src/core/firmware/writecard.ts`).
  Mit dem Befehl antwortet die Box sofort `WRITECARD: ERR` (nichts
  abzubrechen), ohne ihn gar nicht. Spielt sie gerade, kommt auch mit Befehl
  nichts; dann heißt es „unklar“ und „Noch einmal fragen“. So geht jede Box mit
  dem Befehl, auch ein späterer offizieller Build, ohne Änderung an der App.
- **Wann die Vorschau verschwindet:** eine Stelle, `offerWriteCardPreview()`
  in `baukasten.ts`. Sobald eine offizielle TNG den Befehl hat: in
  `build_baukasten.py` `SOURCES["tng"]` auf den Commit setzen,
  `TNG_HAS_WRITE_CARD = True` (dann bekommen alle Builds `SerialWriteCard`,
  die Vorschau-Builds und `writeCardPreview` fallen weg, `tng.writeCard` ist
  true), neu bauen. Die wöchentliche Forum-Runde achtet auf PR #346 und darauf,
  ob `SerialWriteCard` in die Uploader-Envs kommt.
- Protokoll und Fallen (Recherche `recherche/donschoof-kartenschreiben.md`):
  `WRITECARD: OK` kommt erst, wenn die Karte wieder abgenommen ist, **auch
  wenn das Schreiben fehlschlug**; Fehler erkennt die App an `Auth  failed`
  bzw. `MIFARE_Write  failed` davor. Keine Antwort, wenn die Box spielt, im
  Menü ist oder schon eine Karte aufliegt. Den Ordner prüft die Firmware nicht:
  Die App erlaubt nur 1–99, die Admin-Karte geht als `255,0`, Spezialkarten
  (Ordner 0) gar nicht, und Karten, deren Felder der Befehl nicht trägt (z. B.
  Hörbuch über mehrere Ordner), werden abgelehnt statt anders geschrieben.
  Nach dem Schreiben legt man die Karte noch einmal auf; der Classic zeigt im
  Log `CardData: …`, die App vergleicht. Die AiO schreibt keine Kartenzeilen
  ins Log, dort fragt die App „Spielt die Box das Richtige?“.

## Pins pro Platine (für den Lötplan)

Alle Angaben aus TNG `src/constants.hpp` des festgelegten Commits
`d527ca5` (siehe unten), Zeilennummern in dieser Datei. Gilt für die
Builds des Baukastens (Classic = Arduino Nano mit `TonUINO_Classic`, AiO =
`ALLinONE`).

### Classic (Arduino Nano)

| Extra | Signal | Pin | Pegel / Hinweis | Quelle |
|-------|--------|-----|-----------------|--------|
| Drehregler | CLK | A3 | ohne Pull-up | constants.hpp:209 |
| Drehregler | DT | A4 | ohne Pull-up | constants.hpp:210 |
| Drehregler | Pull-up | – | `rotaryEncoderPullUp = false` | constants.hpp:214 |
| Poti | Schleifer | A3 | Enden an GND und 5 V | constants.hpp:232 |
| Leuchtring | DIN | D5 | 24 LEDs | constants.hpp:255, 258 |
| Leuchtende Tasten | LED Play/Pause | A5 | Vorwiderstand je LED (z. B. 1 kΩ) | constants.hpp:508 (Text: 488) |
| Leuchtende Tasten | LED Vor (up) | D6 | | constants.hpp:509 |
| Leuchtende Tasten | LED Zurück (down) | D5 | | constants.hpp:510 |
| Lautsprecher stumm | Verstärker an | D6 | active high (HIGH = Verstärker an) | constants.hpp:284–285 |
| Kopfhörer-Erkennung | Schaltkontakt | D8 | active low: LOW = kein Kopfhörer (`dfPlayer_noHeadphoneJackDetect`) | constants.hpp:303–304 |
| Trägerplatine | Abschalten | D7 | active low statt active high | constants.hpp:602–607 |
| Wecker-Start | Signal vom Wecker | A6 | active high; der Classic liest A6 mit `analogRead`, ab 512 (etwa 2,5 V) gilt es als an, nur beim Start | constants.hpp:365, tonuino.cpp:136–151 |

Belegte Pins des Classic zum Vergleich: Tasten A0 (Play/Pause), A1/A2
(3 Tasten, constants.hpp:552, 565–566); 5 Tasten A3/A4/A1/A2
(constants.hpp:560–563); 3×3-Tastenfeld A3 (constants.hpp:555); RFID RST 9,
SS 10 (576–577); DFPlayer RX 2, TX 3, Busy 4 (585–590); Abschaltung 7 (602);
offener Analogpin für den Zufall A7 (608).

Daraus die Regeln: Drehregler und Poti nur mit 3 Tasten; „Leuchtende Tasten“
und „Lautsprecher stumm“ nicht zusammen (beide D6); Leuchtring und leuchtende
Tasten nicht zusammen (beide D5, und nur ein Licht).

**D6:** Ist „Lautsprecher stumm“ oder „Leuchtende Tasten“ gewählt, zeigt die
App eine Warnung (`D6_WARNING` in baukasten.ts): D6 kann nur eins, den
Verstärker schalten (SPKONOFF, constants.hpp:284), die LED der Vor-Taste
(509) oder ein Bluetooth-Modul einschalten (`BT_MODULE`, 386, solange der
MP3-Player an D2/D3 hängt). Forum 14770#2: SPKONOFF geht, solange D6 sonst
frei ist. Derselbe Satz steht im Lötplan bei „Kein Knacken …“ und „Tasten mit
LED“; sind beide gewählt, steht er als Warnung über den Extras.

**Wecker-Start** (`SPECIAL_START_SHORTCUT`, constants.hpp:352–371): Liegt
beim Einschalten an A6 Spannung an, spielt die Box statt des normalen Starts
Ordner 1, Titel 1 als Einzeltitel (state_machine.cpp:787–788); ohne Signal
startet sie wie immer (`start`: Kurzwahl 4 oder Pling, state_machine.cpp:648–685). Gedacht für
einen Wecker, der die Box einschaltet; TNGs Konfigurationsvorlage aus PR #343
nennt den Schalter „Soundtrack als Weckersignal (HW erforderlich, externer
Wecker mit Signalausgang)“. Nur Classic: Wo A6 auf der AiO herauskommt, ist
nicht belegt.

### AiO (LGT8F328P)

| Extra | Signal | Pin | Quelle |
|-------|--------|-----|--------|
| Drehregler | CLK / DT | A3 / A4 | constants.hpp:209–210 |
| Poti | Schleifer | A3 | constants.hpp:232 |

Fest eingebaut beim AiO: `SPKONOFF` (constants.hpp:690), Verstärker an D8
active low (734–735), USB-Zugang A5 (736–737), Abschaltung 7 active low
(732–733). Tasten: A0 Play/Pause (692), 3 Tasten A2/A1 (700–701), 5 Tasten
zusätzlich A4/A3 (705–706), 3×3-Tastenfeld A2 mit Vor/Zurück an A4/A3
(695–697). Deshalb: Drehregler und Poti nur mit 3 Tasten; keine
Kopfhörer-Erkennung (D8 ist der Verstärker); keine leuchtenden Tasten (A5);
der Leuchtring passt nicht in den Speicher (siehe Größen).

### AiO+, Nano Every, ESP32 (nicht im Baukasten)

Zur Vollständigkeit, falls ein Lötplan sie zeigt: AiO+ Drehregler CLK 36 (PF2),
DT 37 (PF3) (constants.hpp:201–202; die Alternative 31/32 = PE1/PE2 ist
auskommentiert, 197–198), Poti A14 = PF4 (226), Leuchtring Pin 10 = PB2
(249). ESP32 Wroom: Drehregler 27/14 (205–206), Poti 27 (229), Ring 2 (252).
Every: wie Classic (A3/A4, A3, D5). Der fertige Build „AiO+ 5 Tasten mit
Extras“ (5f) von tonuino.github.io hat Leuchtring, Kopfhörer und Spiele schon
an.

## Was nicht angeboten wird, und warum

- **Spiele** (`QUIZ_GAME` +2 kB, `MEMORY_GAME` +1 kB, `TEAPOT_GAME`,
  `MODIFICATION_CARD_JUKEBOX`): passen auf Classic und AiO nicht in den
  Speicher, zusammen schon gar nicht.
- **Batteriespannung** (`BAT_VOLTAGE_MEASUREMENT`, A5): +1,3 kB, braucht einen
  Spannungsteiler und Kalibrierwerte; auf dem AiO nicht vorgesehen.
- **Bluetooth-Modul** (`BT_MODULE`): nutzt D6/D8 (constants.hpp:386–387),
  kollidiert mit „Lautsprecher stumm“ und Kopfhörer.
- **MP3-Chip MH2024K16SS** und Chip zusammen mit Licht, „Lautsprecher
  stumm“ oder Kopfhörer: siehe „MP3-Player-Chip“ oben.
- **Kleinere Schalter** (`MRFC522_RX_GAIN_…`, `FOLDER_QUEUE` +0,4 kB,
  `DISABLE_SHUTDOWN_VIA_BUTTON`): möglich, aber jede weitere Auswahl
  verdoppelt die Zahl der Builds. Später, wenn jemand fragt.
- **Neue Schalter aus TNGs PR #343** (Zweig `issue_342`, Stand 05.10.2026,
  nicht in main): `NEO_RING <Anzahl>` (Pixelzahl des Rings statt fest 24;
  `NEO_RING_2` bleibt bei 24), `FIVEBUTTONS_SWITCHED` (5 Tasten mit
  getauschten Vor/Zurück- und Lauter/Leiser-Tasten, Classic/Every/ESP32 Nano
  A1–A4, ESP32-WROOM 25/26/27/14, nicht AiO/AiO+) und
  `DFMiniMp3_T_CHIP_Original`. Der Baukasten baut `d527ca5` (= main), dort
  gibt es sie nicht (constants.hpp:258 `neoPixelNumber = 24`, kein
  `FIVEBUTTONS_SWITCHED`). Nötig, sobald PR #343 in main ist: Commit in
  `SOURCES` nachziehen, `NEO_RING=<n>` statt `NEO_RING` setzen (eine Auswahl
  der Pixelzahl, jede Zahl ein eigener Build), `FIVEBUTTONS_SWITCHED` als
  vierte Tastenwahl beim Classic, die Chip-Wahl auf „genau einer“ umstellen,
  dann neu bauen. Der „Soundtrack als Weckersignal“ der Vorlage ist der alte
  Schalter `SPECIAL_START_SHORTCUT`, den `d527ca5` schon hat: Er ist als
  Wecker-Start im Baukasten.
- **3×3-Tasten und der Kompilierfehler im Release V3.3.3_2026.02.25**
  (`#elif BUTTONS3X3` ohne `defined()`, TonUINO-TNG.ino:72, Forum 15001):
  betrifft den Baukasten nicht. `d527ca5` hat die Korrektur `#elif
  defined(BUTTONS3X3)` (Issue 330, Commit `b42e7c4` vom 15.05.2026), und die
  Builds setzen `BUTTONS3X3=1` wie `platformio.ini`; damit ginge sogar die
  alte Zeile durch. Den Fehler sieht nur, wer den Release-Tag in der Arduino
  IDE mit `#define BUTTONS3X3` baut.
- **AiO+, Nano Every, ESP32**: Hier fehlt die Toolchain. Für den ATmega4809
  (Every und AiO+, `platform = atmelmegaavr` in platformio.ini) hat das
  avr-gcc 7.3 von Debian/Ubuntu keine Gerätedateien, und die ESP32-Toolchain
  lässt sich in der Bauumgebung nicht laden. Für diese Platinen bleibt es bei den offiziellen Builds und „Eigene
  Datei“.

## Größen und Bootloader

Ein Nano hat zwei mögliche Bootloader:

- **alt** (ATmegaBOOT, 57600 Baud, 2 KiB): Firmware bis **30720 Bytes**,
- **neu** (Optiboot, 115200 Baud, 512 Bytes): bis **32256 Bytes**.

Builds über 30720 Bytes stehen im Manifest mit `needsNewBootloader: true`; die
App sagt das in den Extras und beim Aufspielen. `src/core/firmware/flash.ts`
erkennt den Bootloader an der Baudrate: Beim alten bricht das Aufspielen ab,
**bevor** etwas geschrieben wird („Diese Firmware braucht einen Nano mit neuem
Bootloader … Auf der Box hat sich nichts geändert.“). Der AiO hat Platz für
29696 Bytes (lgt8fx boards.txt).

<!-- sizes:begin -->
### Matrix und Größen (aus dem Manifest)

- 516 erlaubte Kombinationen, davon **413 gebaut** und 103 zu groß (stehen im Manifest unter `notFitting`, die App graut sie aus).
- Davon 101 mit anderem MP3-Player-Chip (MH2024K-24SS, GD3200B, LISP3) und 24 mit Wecker-Start; keiner braucht den neuen Bootloader.
- 24 mit der Vorschau „Karten über die Box beschreiben“ (alle Classic, 22 davon mit neuem Bootloader; die 12 AiO-Kombinationen sind zu groß).
- 157 Classic-Builds brauchen den neuen Bootloader (über 30720 Bytes).
- In der App: 15 Packs, zusammen **1,81 MiB** (+ Manifest 342 KiB).
- RAM (statisch, .data + .bss): höchstens 1637 von 2048 Bytes.

| Build | Bytes | Unterschied zu ohne Extras |
|-------|------:|------:|
| `classic-3` | 29394 |  |
| `classic-3-encoder` | 29720 | +326 |
| `classic-3-encoderSkip` | 30004 | +610 |
| `classic-3-poti` | 29640 | +246 |
| `classic-3-ring` | 31300 (neuer Bootloader) | +1906 |
| `classic-3-ringVolume` | 31786 (neuer Bootloader) | +2392 |
| `classic-3-ledButtons` | 30140 | +746 |
| `classic-3-speakerOff` | 29438 | +44 |
| `classic-3-headphones` | 29660 | +266 |
| `classic-3-traeger` | 29260 | -134 |
| `classic-3-weiter` | 29632 | +238 |
| `classic-3-encoder-ring` | 31634 (neuer Bootloader) | +2240 |
| `classic-3-encoder-ringVolume` | 32124 (neuer Bootloader) | +2730 |
| `classic-5` | 29906 |  |
| `classic-5-ring` | 31806 (neuer Bootloader) | +1900 |
| `classic-3x3` | 30130 |  |
| `aio-3` | 28750 |  |
| `aio-3-encoder` | 29078 | +328 |
| `aio-3-encoderSkip` | 29362 | +612 |
| `aio-3-poti` | 29160 | +410 |
| `aio-3-weiter` | 29008 | +258 |
| `aio-5` | 29194 |  |
| `aio-3x3` | 29666 |  |
| `classic-3-mh2024k24ss` | 29550 | +156 |
| `classic-3-gd3200b` | 29524 | +130 |
| `classic-3-lisp3` | 29420 | +26 |
| `aio-3-mh2024k24ss` | 28904 | +154 |
| `aio-3x3-mh2024k24ss` | passt nicht | |
| `aio-3x3-lisp3` | 29694 | +28 |
| `classic-3-alarm` | 29494 | +100 |
| `classic-5-alarm` | 30006 | +100 |
| `classic-3x3-alarm` | 30222 | +92 |
| `classic-3-writeCard` | 30684 | +1290 |
| `classic-3-traeger-writeCard` | 30550 | +1290 |
| `classic-3-encoder-writeCard` | 31008 (neuer Bootloader) | +1614 |
| `classic-5-writeCard` | 31184 (neuer Bootloader) | +1278 |
| `classic-3x3-writeCard` | 31408 (neuer Bootloader) | +1278 |
| `aio-3-writeCard` | passt nicht (29982) | |

Der Leuchtring passt beim Classic nur mit dem neuen Bootloader; beim AiO (29696 Bytes) gar nicht. Classic mit Drehregler, Poti, Kopfhörer, Trägerplatine oder „Weitermachen“ passt auch auf den alten Bootloader.
<!-- sizes:end -->

## So entstehen die Builds

`scripts/firmware/build_baukasten.py` baut ohne PlatformIO und ohne Arduino
IDE (beide Registries sind in der Bauumgebung gesperrt, und für die App soll
nichts installiert werden):

- Quellen von GitHub, auf feste Commits geprüft:

  | Quelle | Version | Commit |
  |--------|---------|--------|
  | TonUINO-TNG | V3.3.3 17.09.26 (master) | `d527ca5f3c5090a74ccdf5505202db352d7531c8` |
  | ArduinoCore-avr (Classic) | 1.8.6 | `42fa4a1ea1b1b11d1cc0a60298e529d37f9d14bd` |
  | lgt8fx (AiO) | 1.0.6, aus `lgt8f-1.0.6.zip` (sha256 `e7384539…2f23bd`) | `81d98d6375b2a39154fa138a0f3fc2e5a8a92301` |
  | JC_Button | 2.1.2 | `f379405f8ac425d2f0fe6248cbdad5e5461ae467` |
  | MFRC522_fix (boerge1/rfid) | 1.4.12 | `a384087d1241a37f09028ff9a0cd5a8cdf9cbc0f` |
  | DFMiniMp3 | 1.2.3 | `9e0720c92ae45c6e93a9c571cb78099cc58fa534` |
  | Adafruit_NeoPixel | 1.11.0 | `9a9104c6ede08097f8067f4005837ff56a3d2936` |
  | TonUINO-TNG, nur Vorschau „Karten über die Box beschreiben“ | V3.3.3 08.10.26 (Branch `issue_345`) | `abfa3075f8dea929a943943eb8059d2b362ed160` |

  Der TNG-Commit ist der, aus dem die offiziellen Builds auf
  tonuino.github.io stammen (`src/version.hpp`: „V3.3.3 17.09.26“); der Tag
  `V3.3.3_2026.02.25` ist älter. Bibliotheksversionen wie in TNGs
  `platformio.ini` und README.
- Toolchain: `avr-gcc 7.3.0` aus Debian/Ubuntu (`apt-get install gcc-avr
  avr-libc binutils-avr`), dieselbe GCC-Version wie PlatformIOs
  toolchain-atmelavr 1.70300. Das Skript bricht bei einer anderen Version ab.
- Flags wie PlatformIOs platform-atmelavr (`builder/frameworks/arduino.py`):
  `-Os -Wall -ffunction-sections -fdata-sections -flto`, C: `-std=gnu11
  -fno-fat-lto-objects`, C++: `-fno-exceptions -fno-threadsafe-statics
  -fpermissive -std=gnu++17 -fconcepts`, Linken: `-Os -Wl,--gc-sections -flto
  -fuse-linker-plugin`; Core und jede Bibliothek als eigenes Archiv, gelinkt
  Bibliotheken, Core, `-lm`.
- Defines je Umgebung genau wie `platformio.ini`
  (`[env:TonUINO_Classic_*]`, `[env:ALLinONE_*]`), dazu `-D__IN_VS_CODE__`
  wie im `[env]`-Abschnitt. Tasten: Classic 3 ohne Define, Classic 5
  `FIVEBUTTONS=1`, 3×3 `BUTTONS3X3=1`, AiO 3 `THREEBUTTONS`, AiO 5 ohne
  Define (constants.hpp:686–688 setzt dann `FIVEBUTTONS`).

```sh
sudo apt-get install gcc-avr avr-libc binutils-avr
python3 scripts/firmware/build_baukasten.py --work /tmp/baukasten --jobs 2
python3 scripts/firmware/build_baukasten.py --list            # alle IDs
python3 scripts/firmware/build_baukasten.py --only classic-3-encoder   # zum Ausprobieren, schreibt nichts
python3 scripts/firmware/build_baukasten.py --work /tmp/baukasten --check   # neu bauen und mit dem Manifest vergleichen
python3 scripts/firmware/build_baukasten.py --work /tmp/baukasten --reuse   # nur neue Builds bauen, gleiche aus dem Manifest übernehmen (per SHA-256 geprüft)
```

Ein voller Lauf dauert mit zwei Jobs 30 bis 80 Minuten. Die Builds sind
reproduzierbar: zwei Läufe ergeben dieselben SHA-256 (gzip mit `mtime=0`).
`--check` vergleicht jeden Build mit dem Manifest.

**Gegenprobe im Simulator** (`scripts/firmware/simbox.c`, simavr 1.6 aus
apt): Die Builds starten und verhalten sich wie im Quelltext beschrieben.
Die ganze Box mit MP3-Player, Kartenleser und Tasten, gegen die die App
geprüft wird: [BOX-SIMULATOR.md](BOX-SIMULATOR.md).

| Build | Ergebnis |
|-------|----------|
| `classic-3` | Banner, „V3.3.3 17.09.26“, „C 3“, Einstellungen, „enter Idle“; D7 Ausgang, LOW |
| `classic-3-traeger` | wie oben, aber D7 HIGH (active low, also „nicht abschalten“) |
| `classic-3-encoder` | CLK A3 fällt mit DT A4 HIGH → `btn/cmd: up/bright_up`, mit DT LOW → `down/bright_down` (Leerlauf, `IB:1`) |
| `classic-3-poti` | A3 auf 0 mV → `Volume: 5`, 5000 mV → `Volume: 24`, 2500 mV → `Volume: 20`; keine `btn/cmd`-Zeile |
| `classic-3-ring` | D5 Ausgang, 23 000 Pegelwechsel in 1,5 s (NeoPixel-Daten) |
| `classic-3-ledButtons` | A5, D5, D6 Ausgänge; Log `LEDs(D/P/U): 5 19 6`, `NUM LEDS: 3` |
| `classic-3-speakerOff` | D6 Ausgang, HIGH (Verstärker an) |
| `classic-3-mh2024k24ss` | startet wie `classic-3` bis „enter Idle“ (ohne DFPlayer im Simulator lässt sich der Chip selbst nicht prüfen) |
| `classic-3-alarm` | A6 auf 5000 mV (`simbox … alarm`): nach „enter Idle“ gleich „enter StartPlay“ statt `btn/cmd: start/start`; A6 auf 0 V und `classic-3` mit A6 auf 5000 mV: normaler Start |
| `aio-3-encoder` | Banner, „V3.3.3 17.09.26“, „A 3“, Einstellungen (simavr kennt den LGT8F328P nicht ganz, weiter kommt er nicht) |
| `classic-3-writeCard` (`simbox … serial "WRITECARD CANCEL" "WRITECARD 4,5,0" "WRITECARD 255,0" "WRITECARD CANCEL"`) | im Leerlauf: `WRITECARD CANCEL` → `WRITECARD: ERR` nach 45 ms; `4,5,0` (Einzeltitel 0) → `WRITECARD: ERR`; `255,0` → `enter WriteC`, `play mp3 800`, wartet; `CANCEL` → `SM abort`, `play mp3 802`, `WRITECARD: ERR` |
| `classic-3` (gleich gefragt) | keine Antwort, auch nicht auf `WRITECARD 1,5` |

**Byte-Vergleich mit den offiziellen Builds:** tonuino.github.io ist aus der
Bauumgebung nicht erreichbar (Proxy 403). Der Vergleich von `classic-3` mit
dem offiziellen `TonUINO_Classic_3/firmware.hex` (Größe ±1 %) steht noch aus.
Wer ihn machen will: `firmware.hex` laden, mit `avr-objcopy -I ihex -O binary`
umwandeln und Größe und Versionszeile vergleichen.

## Wie die App die Builds bekommt

- `public/firmware/baukasten/manifest.json`: TNG-Version, Quellen, Toolchain,
  Flags, Liste „passt nicht“ und je Build: ID, Extras, alle Defines, Größe,
  RAM, `needsNewBootloader`, SHA-256, Pack und Offset.
- `public/firmware/baukasten/<platine>-<tasten>[-<regler>].pack.gz`: die
  Images einer Gruppe hintereinander, als ein gzip-Strom. Builds, die sich in
  wenigen Extras unterscheiden, teilen fast alle Bytes; deflate findet das
  vorige Image in seinem 32-KiB-Fenster. Ein Viertel der Größe einzelner
  Dateien.
- `src/core/firmware/baukasten.ts`: lädt Manifest und Pack mit `fetch` neben
  der App (`import.meta.env.BASE_URL`), entpackt mit `DecompressionStream`,
  prüft SHA-256 mit `crypto.subtle`. Kein neues npm-Paket. Ein Webserver, der
  `.gz` mit `Content-Encoding: gzip` ausliefert, schadet nicht (die App
  erkennt schon entpackte Daten). `identifyBuild()` erkennt einen
  Baukasten-Build in Flash, das von der Box zurückgelesen wurde.
- Assistent (`src/features/workshop/wizard.ts`, `ExtrasPanel.tsx`): Extras
  hängen am Assistenten-Zustand; ein geladener Build, der nicht mehr zur
  Auswahl passt, fällt weg, und „Weiter“ geht erst mit dem richtigen Build.
  Die Antwort „Mit CubieKid- oder Trägerplatine“ wählt beim Classic den Build
  mit `USE_TRAEGER_PLATINE_SHUTDOWN`.

## Was die Box im Log zeigt (Box testen)

`src/core/firmware/extraslog.ts` (`ExtrasLogWatcher`, Tests in
`tests/firmware/extraslog.test.ts`) macht aus den Zeilen des Box-Logbuchs
Ereignisse für eine Live-Anzeige:

- `Volume: n` (mp3.cpp `logVolume`): jede Lautstärke. Ursache: Start, Regler,
  Taste oder Kopfhörer.
- Drehregler: ein Dreh ist ein `btn/cmd: up/volume_up` bzw.
  `down/volume_down` (Werkseinstellung `IB:1`; mit `IB:0` `upLong`/`downLong`)
  ohne `…LongRepeat` davor, nur während die Box spielt.
- **AiO:** Dort schreibt TNG die `btn/cmd`-Zeilen nur auf Debug-Ebene, als
  Zahlen (`commands.cpp:107–108`); sie kommen nicht im Log an. Beim AiO sieht
  man also nur `Volume: n`, ohne Ursache (außer beim Poti und beim Start).
- Poti: setzt die Lautstärke direkt, ohne `btn/cmd`-Zeile. Eine
  `Volume`-Zeile ohne Befehl davor kommt vom Poti.
- `hpJackDetect: 0|1`: Kopfhörer ab oder an (nur mit Kopfhörer-Erkennung,
  nur bei Änderung), danach die Lautstärke für Lautsprecher oder Kopfhörer.
- `LEDs(D/P/U): 5 19 6` und `NUM LEDS: 3` beim Start: Firmware mit
  leuchtenden Tasten (led_manager.cpp:17–18).
- Leuchtring und Drehregler selbst schreiben nichts auf Info-Ebene; welche
  Extras genau drin sind, sagt nur das Image (`identifyBuild`).

Der Start nennt nur Platine und Tasten (`TonUINO-TNG.ino`: „C 3“, „A 5“).

## Automatisch erkannte Firmware (Karten beschreiben, #29)

`src/core/tonuino/firmwaredetect.ts`: Beim Karten-Beschreiben steht
„Automatisch erkannt: TonUINO TNG (aus …) ändern“. Sicher ist der Start der
Box über USB (Box-Logbuch, „Box erkennen“, gerade aufgespielte Firmware), er
wird im Katalog der Karte gemerkt. Sonst zählen die Ansagen auf der SD-Karte:
nur TNG hat `mp3/0262`, `0500–0510`, `0520–0524`, `0530–0532`, `0985–0989`,
`advert/0262`, `0306–0309`, `0320–0326`; nur 2.1 hat `mp3/0982–0984`. Eine
Wahl von Hand gewinnt immer. Die Auswahl erscheint nur, wenn nichts erkannt
wurde.

## Lizenz (GPL-3.0)

TonUINO TNG steht unter der GPL-3.0. Jeder Build nennt im Manifest Quelle,
Commit, Toolchain und alle Flags; die App zeigt bei einer Firmware mit Extras
die Zeile „Quelle: TonUINO TNG 3.3.3 (https://github.com/tonuino/TonUINO-TNG,
Commit d527ca5), gebaut mit -D …“. Mit diesem Skript und den Commits lässt
sich jeder Build Byte für Byte nachbauen. Geändert wird am Quellcode nichts.

Die Vorschau-Builds nennen ihre eigene Quelle (Manifest `writeCardPreview`:
Repo, Branch `issue_345`, Commit `abfa307`, Autor donschoof, PRs #344/#346,
`-D SerialWriteCard`), in der App: „Quelle: TonUINO TNG 3.3.3
(https://github.com/tonuino/TonUINO-TNG, Branch issue_345, Commit abfa307,
Kartenschreiben von donschoof, freie Software unter der GPL-3.0), gebaut mit
-D …“. Ein Quell-Archiv legt der Baukasten für keinen Build ab, auch hier
nicht. Das ist bei `abfa307` heikler als bei `d527ca5` (main): Ein
Arbeitszweig kann nach dem Merge verschwinden; `refs/pull/344/head` und
`refs/pull/346/head` bleiben zwar, zeigen aber nicht sicher auf `abfa307`.
Vor einem Release mit der Vorschau sollte ein Quell-Archiv des Commits
(`git archive abfa307`) zum Release gelegt werden.
