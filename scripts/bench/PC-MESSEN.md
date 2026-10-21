# Messen auf einem Test-PC (Checkliste für eine Helfer-Sitzung)

Ziel: zeigen, dass die neue Version auf einem Linux-Test-PC in keinem Punkt
langsamer ist als die vorige (TODO #45) und ob das Scrollen jetzt flüssig ist
(TODO #37), auf Wunsch mit einer echten SD-Karte. Es läuft nur, wenn die
Besitzerin oder der Besitzer des PCs zustimmt,
und immer nach der Lastregel (PC LOAD GUARD).

## Vorher

1. **Fragen**, ob jetzt gemessen werden darf. Die Messung öffnet etwa
   achtmal ein App-Fenster für je 1–2 Minuten; Maus und Tastatur in der Zeit
   nicht anfassen. Insgesamt etwa 15–20 Minuten.
2. **Last prüfen**, nichts anderes darf rechnen (Satzlabor, Builds, Downloads,
   Videos):

       uptime; free -m; ps -eo pcpu,pmem,comm --sort=-pcpu | head -8

   Weiter nur, wenn die 1-Minuten-Last unter einem Viertel der Kerne liegt
   (`nproc`) und mindestens 3 GB frei sind (`available`). Das Skript prüft
   das noch einmal und bricht sonst ab.
3. **Die Karte nur lesend einhängen.** Ihren Einhängepunkt (z. B.
   `/media/<name>/KARTE`) als `KARTE` angeben. Prüfen:

       findmnt -no OPTIONS --target "$KARTE"

   Steht dort kein `ro`:
   `sudo mount -o remount,ro "$KARTE"`
   (das Skript bricht bei einer beschreibbaren Karte ab). Andere Karten oder
   USB-Sticks vorher abziehen.
4. **Beide Versionen bereitlegen**, ohne sie zu installieren: die AppImages der
   alten (z. B. 0.2.2) und der neuen Version, ausführbar (`chmod +x`). Die
   installierte App (`/usr/bin/tonuino-studio`) geht auch für eine der beiden.
   Nichts bauen auf dem Test-PC.
5. **TonUINO Studio schließen**, falls es läuft.

## Messen

Im Terminal in der Desktop-Sitzung des Test-PCs (es braucht den Bildschirm):

    cd ~/tonuino-studio   # oder wo das Repo liegt; sonst nur die beiden Skripte kopieren
    KARTE=/media/<name>/KARTE scripts/bench/test-pc.sh \
        ~/Downloads/TonUINO-Studio_0.2.2_amd64.AppImage \
        ~/Downloads/TonUINO-Studio_0.3.0_amd64.AppImage

Das Skript

- startet beide Versionen abwechselnd im Messmodus (`TONUINO_MESSEN=1`), mit
  `nice -n 5` und `ionice -c 2 -n 7`, immer nur eine, höchstens 6 Minuten;
- wärmt jede erst einmal auf und misst dann zweimal (`LAEUFE=2`);
- wartet vor jedem Lauf, bis die Last wieder niedrig ist;
- misst die neue Version zum Vergleich der Grafikwege noch je einmal mit
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` und mit `WEBKIT_DISABLE_COMPOSITING_MODE=1`
  (bekannte Ursache für zähes Scrollen mit NVIDIA unter X11);
- beendet bei Abbruch (Strg+C) die gestartete App; es bleibt nichts laufen.

Der Messmodus nimmt eine erfundene Box mit 52 Ordnern im Speicher (die
Einstellungen und die Karte auf dem PC bleiben unberührt): Start, Regal gleich nach dem Start
und später, jede Seite zweimal, ab 0.3 auch der lange Ordner (120 Titel)
mit Abspielen, Scrollen der Titelliste und Springen. Steckt die Karte (KARTE), misst
die neue Version danach dieselben Dinge auf ihr („echteKarte“, nur lesend: Regal,
längster Ordner, Abspielen, Springen). Die alte Version kennt den langen Ordner
und die echte Karte noch nicht; in der Tabelle steht dort „neu gemessen“.

## Danach

- Ergebnis: `~/TonUINO-Tempo-<Datum>/vergleich.md` (Tabelle vorher/nachher mit
  Urteil, darunter die beiden Grafik-Varianten), die einzelnen JSON-Dateien und
  `rechner.txt` (Grafikkarte, Sitzungstyp). Ohne `node` auf dem Test-PC die
  JSON-Dateien mitnehmen und anderswo vergleichen:

      node scripts/bench/messung-vergleich.mjs --vorher alt-1.json,alt-2.json --nachher neu-1.json,neu-2.json

- Prüfen, dass nichts mehr läuft: `pgrep -a tonuino-studio` (leer).
- Sagen, dass die Karte wieder beschreibbar eingehängt werden kann
  (`sudo mount -o remount,rw …` oder abziehen und neu einstecken).
- Werte in einfachen Worten in die Versionsnotizen (#45). Ist „ohne DMA-BUF“
  deutlich flüssiger, ist das ein Hinweis für einen eigenen Schritt (die App
  könnte die Variable auf NVIDIA selbst setzen), nicht ohne Messung einbauen.

## Web-App

Die Web-App lässt sich auf jedem Rechner mit `scripts/bench/run.mjs`
vergleichen (README.md), mit der erfundenen Karte. Eine echte Karte geht
dort nicht: der Browser bekäme alle Dateien der Karte in seinen Speicher.
Für die echte Karte zählt die Desktop-App oben. Auf dem Test-PC nur, wenn
Playwright/Chromium oder python3-gi mit WebKit2 4.1 schon da sind (nichts
installieren), mit derselben Lastregel und `--runs 2`.
