#!/usr/bin/env bash
# Tempo-Messung auf einem Linux-Test-PC (Checkliste: scripts/bench/PC-MESSEN.md).
#
#   KARTE=/media/…/KARTE scripts/bench/test-pc.sh ALTE-APP NEUE-APP [AUSGABE-ORDNER]
#
# ALTE-APP / NEUE-APP: das Programm der beiden Versionen, z. B. zwei AppImages
# ("TonUINO Studio_0.2.2_amd64.AppImage") oder /usr/bin/tonuino-studio.
# Startet beide abwechselnd im Messmodus (TONUINO_MESSEN=1, src/app/measure.ts),
# je ein Aufwärmlauf und LAEUFE Messläufe, dann die neue Version je einmal mit
# TONUINO_60FPS=1 (mit GRAFIK=1 auch mit WEBKIT_DISABLE_DMABUF_RENDERER=1 und
# WEBKIT_DISABLE_COMPOSITING_MODE=1).
# Ist unter KARTE eine echte SD-Karte schreibgeschützt eingehängt, misst die neue
# Version am Ende auch sie.
#
# Lastregel: prüft vorher freien Speicher und Last, läuft mit nice/ionice,
# immer nur ein Programm, wartet zwischen den Läufen, bis der PC ruhig ist,
# und lässt nichts laufen (auch nicht bei Abbruch mit Strg+C).
set -euo pipefail

OLD=${1:?Aufruf: test-pc.sh ALTE-APP NEUE-APP [AUSGABE-ORDNER]}
NEW=${2:?Aufruf: test-pc.sh ALTE-APP NEUE-APP [AUSGABE-ORDNER]}
OUT=${3:-$HOME/TonUINO-Tempo-$(date +%Y%m%d-%H%M)}
KARTE=${KARTE:-}
LAEUFE=${LAEUFE:-2}
MIN_FREI_MB=${MIN_FREI_MB:-3000}
# Höchste 1-Minuten-Last, bei der gemessen wird (Standard: ein Viertel der Kerne, mindestens 1).
CPUS=$(nproc)
MAX_LAST=${MAX_LAST:-$(awk -v c="$CPUS" 'BEGIN { m = c / 4; if (m < 1) m = 1; print m }')}
ERGEBNIS=$HOME/TonUINO-Messung.json
HIER=$(cd "$(dirname "$0")" && pwd)

for app in "$OLD" "$NEW"; do
  [ -x "$app" ] || { echo "Nicht ausführbar: $app (chmod +x?)"; exit 2; }
done
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

echo "== Vorher prüfen"
echo "Kerne: $CPUS, Last: $(last) (höchstens $MAX_LAST), freier Speicher: $(frei_mb) MB (mindestens $MIN_FREI_MB)"
if pgrep -x tonuino-studio >/dev/null; then
  echo "TonUINO Studio läuft schon. Bitte erst schließen."; exit 3
fi
if [ "$(frei_mb)" -lt "$MIN_FREI_MB" ]; then echo "Zu wenig freier Speicher. Abbruch."; exit 3; fi
if zu_hoch; then
  echo "Der PC ist beschäftigt. Was gerade rechnet:"
  ps -eo pcpu,pmem,comm --sort=-pcpu | head -6
  echo "Bitte später messen (oder MAX_LAST höher setzen, wenn das in Ordnung ist)."
  exit 3
fi
if [ -n "$KARTE" ] && mountpoint -q "$KARTE" 2>/dev/null; then
  opts=$(findmnt -no OPTIONS --target "$KARTE")
  case ",$opts," in
    *,ro,*) echo "Karte: $KARTE, schreibgeschützt eingehängt (gut)." ;;
    *) echo "Die Karte unter $KARTE ist beschreibbar eingehängt. Für die Messung bitte nur lesend:"
       echo "    sudo mount -o remount,ro '$KARTE'"
       echo "(oder die Karte abziehen, dann wird nur die Messbox gemessen)."
       exit 3 ;;
  esac
else
  echo "Keine Karte unter ${KARTE:-KARTE (nicht gesetzt)}: gemessen wird nur die Messbox im Speicher."
fi
# Andere eingehängte Karten würde die neue Version auch finden: nur lesend ist sicher.
mkdir -p "$OUT"
[ -f "$ERGEBNIS" ] && mv "$ERGEBNIS" "$ERGEBNIS.vor-messung"
{
  echo "Zeit: $(date -Is)"; echo "Rechner: $(uname -srm), $CPUS Kerne"; echo "Alt: $OLD"; echo "Neu: $NEW"
  echo "Grafik: $(lspci 2>/dev/null | grep -iE 'vga|3d' | sed 's/^[^ ]* //' | tr '\n' ';')"
  echo "Sitzung: ${XDG_SESSION_TYPE:-?}"
} > "$OUT/rechner.txt"

ruhig_werden() {
  local i=0
  sleep 10
  while zu_hoch && [ $i -lt 24 ]; do sleep 5; i=$((i + 1)); done
  if zu_hoch; then echo "   (Last bleibt bei $(last), messe trotzdem weiter)"; fi
}

# messen NAME APP [VAR=WERT …]: ein Lauf im Messmodus, höchstens 6 Minuten.
messen() {
  local name=$1 app=$2; shift 2
  ruhig_werden
  echo "== $name  (Last $(last), frei $(frei_mb) MB)"
  rm -f "$ERGEBNIS"
  env TONUINO_MESSEN=1 "$@" nice -n 5 ionice -c 2 -n 7 timeout 360 "$app" >"$OUT/$name.log" 2>&1 &
  laeuft=$!
  wait "$laeuft" || true
  laeuft=""
  if [ -f "$ERGEBNIS" ]; then mv "$ERGEBNIS" "$OUT/$name.json"; echo "   gespeichert: $OUT/$name.json"
  else echo "   kein Ergebnis (siehe $OUT/$name.log)"; fi
}

# Aufwärmen: Sticker und Bilder einmal malen lassen, wie bei jedem späteren Start.
messen alt-aufwaermen "$OLD"
messen neu-aufwaermen "$NEW"
for i in $(seq 1 "$LAEUFE"); do
  messen "alt-$i" "$OLD"
  messen "neu-$i" "$NEW"
done
# Die neue Version einmal mit WebKits alter 60-Bilder-Bremse (TONUINO_60FPS=1,
# src-tauri/src/lib.rs tune_webview): zeigt, was das Lösen bringt.
messen neu-60fps "$NEW" TONUINO_60FPS=1
# Vergleich der Grafikwege (nur mit GRAFIK=1, je ein Lauf der neuen Version).
if [ "${GRAFIK:-0}" = 1 ]; then
  messen neu-ohne-dmabuf "$NEW" WEBKIT_DISABLE_DMABUF_RENDERER=1
  messen neu-ohne-compositing "$NEW" WEBKIT_DISABLE_COMPOSITING_MODE=1
fi

echo
liste() { local f="" n; for n in "$@"; do [ -f "$OUT/$n.json" ] && f="$f${f:+,}$OUT/$n.json"; done; echo "$f"; }
alt=$(liste $(for i in $(seq 1 "$LAEUFE"); do echo "alt-$i"; done))
neu=$(liste $(for i in $(seq 1 "$LAEUFE"); do echo "neu-$i"; done))
if command -v node >/dev/null && [ -n "$alt" ] && [ -n "$neu" ]; then
  nice node "$HIER/messung-vergleich.mjs" --vorher "$alt" --nachher "$neu" | tee "$OUT/vergleich.md"
  for v in 60fps ohne-dmabuf ohne-compositing; do
    [ -f "$OUT/neu-$v.json" ] || continue
    echo; echo "### Neu, $v (Spalte rechts) gegen neu normal"
    nice node "$HIER/messung-vergleich.mjs" --vorher "$alt" --nachher "$neu" --extra "$OUT/neu-$v.json" | tail -n +3 | tee -a "$OUT/vergleich.md"
  done
else
  echo "Ergebnisse liegen in $OUT (ohne node kein Vergleich; messung-vergleich.mjs geht auch auf einem anderen Rechner)."
fi
echo "Fertig. Es läuft nichts mehr."
