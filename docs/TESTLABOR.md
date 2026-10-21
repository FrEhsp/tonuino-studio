# Testlabor: die App gegen nachgebaute Geräte und schlechtes Netz

TODO #69, mit der Druckregel aus #85. Nicht in der App, nur für unsere
Prüfrunden. **Läuft vor jedem Release.**

```sh
npm run test:labor                 # alles, etwa 7 Minuten (davon 5 Box-Simulator)
npm run test:labor -- --ohne-box   # ohne Box-Simulator, etwa 2 Minuten
npm run test:labor -- sd druck     # nur diese Bereiche: sd, druck, box, nfc, netz
```

Am Ende steht eine Tabelle (bestanden / Fehler / übersprungen je Bereich) und
darunter die Hinweise: übersprungene Teile mit dem Grund (fehlendes Werkzeug,
mit apt-Paket) und gemessene Werte. „bestanden*“ heißt: bestanden, aber ein
Teil fehlte. Exit-Code 1, sobald ein Bereich Fehler hat. Ein normales
`npm test` überspringt die Labortests (sie laufen nur mit `LABOR=1`, das setzt
`scripts/labor/run.mjs`).

Werkzeuge (Debian/Ubuntu): `mtools dosfstools exfatprogs` (SD),
`cups cups-filters printer-driver-cups-pdf poppler-utils mupdf-tools ghostscript
xvfb python3-gi gir1.2-webkit2-4.1` (Drucker), Chromium aus Playwrights
Browser-Ordner oder dem System, `gcc simavr libsimavr-dev` (Box). Fehlt eines,
wird nur sein Teil übersprungen.

## Bereiche

**SD-Kartenleser** (`tests/labor/sd.test.ts`, `sd/`): echte FAT32- und
exFAT-Abbilder (mtools, ohne mount), dahinter ein nachgebauter Kartenleser mit
den Befehlen der Desktop-Brücke (fsops.rs: Schreiben über `.tonuino-tmp`,
Fehlercodes). Die App läuft von `state.ts` an unverändert. Geprüft: neue
Karte, Mac-/Windows-Reste, FAT-Reihenfolge, Schreibschutz (Schieber),
Karte als root eingehängt, volle Karte, Karte beim Schreiben gezogen,
langsamer Leser, exFAT-SDXC, große Fotoplatte und andere große Platten (dürfen
nicht als Box-Karte aufgehen). Nach jedem Schreiben `fsck.fat`.

**Drucker** (`tests/labor/druck.test.ts`, `druck/`), Druckregel #85: Seiten =
Bögen, keine leere erste Seite, Papier des Bogens, jedes Etikett an seinem
Platz in echter Größe (± 0,5 mm), gemessen im Ergebnis-PDF.
- Desktop-App: das PDF über TauriPrinter und `lp` mit den Optionen aus
  `print.rs` (aus dem Rust-Quelltext gelesen) in ein eigenes CUPS: Tintenstrahler
  A4 und Letter (Ränder 3 mm, unten 12 mm), randlos, CUPS-PDF. Bögen,
  beidseitig, Testseite, Inhaltsliste (A4 und 2 × A5 quer). Gegenproben: „An
  Seite anpassen“ und `lp` ohne Optionen müssen auffallen.
- Browser: der Druckbereich von `printSheets` mit `printCss` in Chromium
  (100 % und 97 %) und in WebKitGTK über GTK „In Datei drucken“ (mit und
  ohne Druckerrand).
- Jedes PDF der App (Bögen, Testseite, Inhaltsliste, QR-Bogen, Bedienkarte)
  in Poppler, MuPDF und Ghostscript: gleiche Seiten, gleiche Farbe. pdf.js
  fehlt (keine neue npm-Abhängigkeit).

**USB-Box**: `npm run test:boxsim`, siehe [BOX-SIMULATOR.md](BOX-SIMULATOR.md).

**Handy-NFC** (`tests/labor/nfc.test.ts`, `nfc/simphone.ts`): `window.TonuinoNfc`
wie `TonuinoNfc.kt` (ein Arbeits-Thread, `lastTag`, IOException = Karte weg,
Classic Block 4, NTAG Seiten 8–11 einzeln), dazu Karten, die man hinhält und
wegnimmt. Lesen, Schreiben, schneller Kartenwechsel, Karte mitten im Schreiben
weg, schreibgeschützte Karte, falscher Kartentyp, geänderter Schlüssel, Handy
ohne NXP-Chip, NFC aus.

**Schlechtes Internet** (`tests/labor/netz.test.ts`, `netz/stoersender.ts`):
ein lokaler Server antwortet anstelle von iTunes, MusicBrainz, Cover Art
Archive, ARASAAC und „Entdecken“: offline, hängt, bricht mitten in der Antwort
ab, tröpfelt, 429/503 mit Retry-After, 500, Anmeldeseite statt JSON. Die App
muss in der Zeit aufgeben, eine deutsche Meldung zeigen und nichts kaputt
machen.
