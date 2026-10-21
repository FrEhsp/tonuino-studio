# Tempo-Vergleich

Misst, ob eine Version von TonUINO Studio flüssiger ist als eine andere
(Regel aus TODO #45: keine Version darf langsamer sein als die vorige). Gemessen
wird die Web-App, gebaut aus beliebigen Commits, auf einer erfundenen SD-Karte,
die einer vollen Familienkarte nachgebaut ist (47 Ordner mit Covern, ein Hörbuch mit 120
Titeln, Systemansagen, Katalog und Cover-Zip).

## Aufruf

    PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright/index.mjs \
      nice node scripts/bench/run.mjs --refs 2a29ed0,WORKTREE --runs 3

- `--refs`: Commits, Tags oder Branches, durch Komma getrennt; die erste ist
  „vorher“. `WORKTREE` ist der Arbeitsstand mit allen nicht eingecheckten
  Änderungen. Jeder Commit wird einmal gebaut (`build-ref.sh`: vorübergehender
  `git worktree` unter `/tmp/tonuino-bench`, danach wieder entfernt; nur der
  gebaute Ordner `dist-<hash>` bleibt).
- `--runs N`: Läufe je Version, abwechselnd (A, B, A, B …), damit ein
  beschäftigter Moment beide trifft. Lauf 0 ist der allererste Start (Sticker
  werden gemalt); gewertet wird der Median der späteren.
- `--engines chromium,webkit`: Chromium über Playwright (Browser aus
  `/opt/pw-browsers`, `CHROMIUM_PATH` setzt einen anderen; nie `playwright install`)
  und WebKitGTK wie die Linux-App (`webkit.py`, braucht python3-gi mit WebKit2 4.1,
  ohne Bildschirm über `xvfb-run`).
  `BENCH_WEBKIT_COMPOSITING=on|off` erzwingt den Grafikweg, `BENCH_THREADS=1`
  schreibt die CPU-Zeit je Thread dazu.
- `--only start,shelf,folder,player,import`: nur diese Messungen.
- `--imports N`: das Hinzufügen in den letzten N Läufen (Standard 1; es ist
  langsam und schwankt, für eine Aussage besser 3).
- `--throttle 4`: Chromium-CPU gedrosselt wie ein langsamer Laptop.
- `--out DIR`: Ergebnis `ergebnis.json` (alle Werte) und `zusammenfassung.md`
  (deutsche Tabelle, vorher/nachher/Urteil, am Ende „Langsamer als vorher: …“).

Ein Lauf mit drei Läufen je Version dauert in Chromium etwa 5 Minuten. Er
belegt einen Kern und läuft mit `nice`; parallel nicht mehr als einen zweiten
Job starten. Aufräumen: `rm -rf /tmp/tonuino-bench/dist-* /tmp/tonuino-bench/ergebnis-*`
(die Messkarte `card-4` und das Album `import-4` lassen sich behalten, sie
werden sonst mit ffmpeg neu gebaut).

## Was gemessen wird

| Messung | Werte |
|---|---|
| `start` | erstes Bild, Regal sichtbar, ab wann alles stillsteht, wie oft und wie viele Elemente nach dem ersten Bild noch springen (Position/Größe je Bild verfolgt), Layout-Verschiebung (CLS), blockierte Zeit durch lange Aufgaben in den ersten 3 s nach dem Regal |
| `shelf` | Regal mit 1400 px/s hinunter und hinauf: Bilder pro Sekunde, langsamstes Zwanzigstel, längster Hänger, verlorene Zeit, leere Sticker im Blick |
| `folder` | langen Ordner (120 Titel) öffnen, ersten Titel abspielen, Titelliste scrollen |
| `player` | vom Klick bis zum Ton, fünfmal springen: bis der Balken folgt, bis die Stelle erreicht ist |
| `import` | Album mit 24 MP3 (45 MB) über „Hinzufügen“ auf die Karte: Lesen, Schreiben, MB/s |

In Chromium steht zu jeder Messung auch die Rechenzeit (`cpuMs`: CPU-Zeit
der Seite vom Laden bis zum Ende der Messung, `cpuGpuMs` die des
GPU-Prozesses). Sie schwankt viel weniger als die Zeiten auf der Uhr, wenn der
Rechner nebenher beschäftigt ist; bei widersprüchlichen Werten zählt sie.

Die Karte steckt nicht wirklich im Browser: `probe.js` (vor der App geladen)
spielt das File System Access API mit Dateien aus IndexedDB vor; geschrieben
wird nur in den Speicher der Seite. In WebKitGTK (`webkit.py`) zählt zusätzlich
die CPU-Zeit pro Bild (aus /proc), die auch auf einem beschäftigten Rechner
vergleichbar bleibt. Im Xvfb ohne Grafikkarte rechnet WebKit die Grafik mit
llvmpipe; die Bildraten dort sind nicht die eines echten PCs, die Unterschiede
zwischen Versionen schon. Ohne Tonausgabe (Container ohne Soundkarte) spielt
WebKit den Titel dort nicht ab; `playingWhileScrolling` sagt, ob er lief.
`cpuMs` umfasst in WebKit nur die Zeit des Scrollens.

Nach jedem Lauf wartet die Seite, bis die App mit ihrer Hintergrundarbeit
fertig ist (`settle`: 2,5 s lang kein Bild mehr gemalt oder gespeichert,
höchstens 45 s), und wird erst dann geschlossen, wie nach einer Weile echter
Benutzung. Ohne das maß jeder spätere Lauf halb gemalte Karten des vorigen mit.

## Ursachen suchen

    nice node scripts/bench/profile.mjs --ref WORKTREE --what shelf|folder|open|start|player [--wait 0] [--callers NAME]

Zeichnet eine DevTools-Spur in Chromium auf und listet, was der Hauptthread
tat und welche Funktionen (über die Source Maps auf `src/` zurückgeführt) am
meisten Zeit brauchten. `--wait 0` misst gleich nach dem Start (wie `run.mjs`,
sonst 2,5 s später), `--callers NAME` zeigt, von wo eine Funktion ihre Zeit
bekommt, `--trace datei.json` speichert die Spur. `BENCH_EXTRA_CSS=datei.css` legt für Versuche ein
Stylesheet über das der App (auch in `webkit.py`): so zeigt sich, was eine
Regel kostet, ohne die App zu ändern.

## Auf einem Test-PC

Siehe [PC-MESSEN.md](PC-MESSEN.md): der Messmodus der Desktop-App
(`TONUINO_MESSEN=1`) mit `test-pc.sh`, auf Wunsch mit einer echten Karte, mit Lastregel.

## Drucken in WebKitGTK

    xvfb-run python3.12 -I scripts/bench/druck.py URL AUSGABE.pdf [RÄNDER] [PAPIER]

Druckt den Stickerbogen der Web-App mit Messkarte so, wie WebKitGTK ihn über
`window.print()` drucken würde, ohne Dialog in eine PDF-Datei (GTK „In Datei
drucken“, Ränder und Papier wählbar), und misst jede Seite (Papier, wo Farbe
ist). So zeigt sich der Fehler von TODO #85 (verkleinert, leere Seite nach
jedem Bogen). Den Druckweg der Desktop-App (PDF an CUPS) prüfen
`tests/stickers/systemPrint.test.ts` (virtueller Drucker mit pdftoppm) und
die Tests in `src-tauri/src/print.rs` (erfundenes `lp`).
