#!/usr/bin/env bash
# Kurze Tempo-Messung auf einem Linux-Test-PC: nur Regal und Leerlauf
# (TONUINO_MESSEN=kurz, src/app/measure.ts), je Einstellung LAEUFE Läufe,
# abwechselnd, damit eine Last von außen alle gleich trifft.
#
#   scripts/bench/test-pc-kurz.sh APP [AUSGABE-ORDNER]
#
# Einstellungen: normal; TONUINO_GTK_US=4167 und =1000 (kürzester Abstand
# zwischen zwei Bildern des Fensters, src-tauri/src/screenrate.rs);
# vblank_mode=0 (Mesa wartet beim Zeigen nicht auf den Bildschirm).
# Lastregel wie test-pc.sh: Speicher und Last vorher prüfen, nice/ionice,
# immer nur ein Programm, nichts bleibt laufen.
set -euo pipefail

APP=${1:?Aufruf: test-pc-kurz.sh APP [AUSGABE-ORDNER]}
OUT=${2:-$HOME/TonUINO-Tempo-kurz-$(date +%Y%m%d-%H%M)}
LAEUFE=${LAEUFE:-3}
MIN_FREI_MB=${MIN_FREI_MB:-3000}
CPUS=$(nproc)
MAX_LAST=${MAX_LAST:-$(awk -v c="$CPUS" 'BEGIN { m = c / 4; if (m < 1) m = 1; print m }')}
ERGEBNIS=$HOME/TonUINO-Messung.json

[ -x "$APP" ] || { echo "Nicht ausführbar: $APP (chmod +x?)"; exit 2; }
[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || { echo "Bitte in der Desktop-Sitzung des Test-PCs starten (kein DISPLAY)."; exit 2; }

frei_mb() { awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo; }
last() { cut -d' ' -f1 /proc/loadavg; }
zu_hoch() { awk -v l="$(last)" -v m="$MAX_LAST" 'BEGIN { exit !(l > m) }'; }

laeuft=""
aufraeumen() {
  if [ -n "$laeuft" ] && kill -0 "$laeuft" 2>/dev/null; then
    kill "$laeuft" 2>/dev/null || true
    sleep 2
    kill -9 "$laeuft" 2>/dev/null || true
  fi
  if [ -f "$ERGEBNIS.vor-messung" ] && [ ! -f "$ERGEBNIS" ]; then mv "$ERGEBNIS.vor-messung" "$ERGEBNIS"; fi
}
trap aufraeumen EXIT INT TERM

echo "Kerne: $CPUS, Last: $(last) (höchstens $MAX_LAST), freier Speicher: $(frei_mb) MB (mindestens $MIN_FREI_MB)"
if pgrep -x tonuino-studio >/dev/null; then echo "TonUINO Studio läuft schon. Bitte erst schließen."; exit 3; fi
if [ "$(frei_mb)" -lt "$MIN_FREI_MB" ]; then echo "Zu wenig freier Speicher. Abbruch."; exit 3; fi
if zu_hoch; then
  echo "Der PC ist beschäftigt. Was gerade rechnet:"
  ps -eo pcpu,pmem,comm --sort=-pcpu | head -6
  exit 3
fi
mkdir -p "$OUT"
[ -f "$ERGEBNIS" ] && mv "$ERGEBNIS" "$ERGEBNIS.vor-messung"
{ echo "Zeit: $(date -Is)"; echo "Rechner: $(uname -srm), $CPUS Kerne"; echo "App: $APP"; echo "Sitzung: ${XDG_SESSION_TYPE:-?}"; } > "$OUT/rechner.txt"

ruhig_werden() {
  local i=0
  sleep 5
  while zu_hoch && [ $i -lt 24 ]; do sleep 5; i=$((i + 1)); done
}

# messen NAME [VAR=WERT …]: ein kurzer Lauf, höchstens 2 Minuten.
messen() {
  local name=$1; shift
  ruhig_werden
  echo "== $name  (Last $(last))"
  rm -f "$ERGEBNIS"
  env TONUINO_MESSEN=kurz "$@" nice -n 5 ionice -c 2 -n 7 timeout 120 "$APP" >"$OUT/$name.log" 2>&1 &
  laeuft=$!
  wait "$laeuft" || true
  laeuft=""
  if [ -f "$ERGEBNIS" ]; then mv "$ERGEBNIS" "$OUT/$name.json"; echo "   gespeichert"; else echo "   kein Ergebnis (siehe $OUT/$name.log)"; fi
}

messen aufwaermen
for i in $(seq 1 "$LAEUFE"); do
  messen "normal-$i"
  messen "gtk4167-$i" TONUINO_GTK_US=4167
  messen "gtk1000-$i" TONUINO_GTK_US=1000
  messen "vblank0-$i" vblank_mode=0
done
echo "Fertig. Ergebnisse in $OUT. Es läuft nichts mehr."
