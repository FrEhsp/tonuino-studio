#!/usr/bin/env bash
# Takes the screenshots of the help again (public/hilfe, HELP_PHOTOS in
# src/features/help/topics.ts): WebKitGTK on the made-up card of the bench,
# cropped to the part the help talks about and saved as small WebP files.
# After a change of look, run it and check the pictures; the crop boxes are
# measured on the pictures and need a new look when the pages move.
#
# Usage: DISPLAY=:<n> scripts/bench/help-photos.sh <dist>
#   <dist>  a web build (SOURCES_RELEASE_CHECK=off npx vite build --outDir …)
# Needs an Xvfb display, ImageMagick (convert) and ffmpeg with libwebp.
set -Eeuo pipefail

dist="${1:?Aufruf: help-photos.sh <dist>}"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d "${BENCH_TMP:-/tmp}/help-photos.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
shots() { nice node "$ROOT_DIR/scripts/bench/shots.mjs" "$dist" "$tmp" "$@" > /dev/null; }

# Karten beschreiben: the first card ticked, then the row "Womit beschreibst du sie?".
SHOT_JS="(() => { document.querySelector('.pick-row input')?.click(); setTimeout(() => { const h = document.querySelector('#cards-step-2'); if (!h) return; h.scrollIntoView({ block: 'start' }); let s = h.parentElement; while (s && s.scrollHeight <= s.clientHeight) s = s.parentElement; (s || document.scrollingElement).scrollTop -= 30; }, 300); })()" \
  shots 1440x900 /karten,/hinzufuegen mit
# The steps of "An der Box" and the health banner of Meine Box, in a narrower window so the text stays large.
SHOT_JS="(() => { document.querySelector('.pick-row input')?.click(); setTimeout(() => document.querySelector('#cards-step-3')?.scrollIntoView({ block: 'start' }), 300); })()" \
  shots 860x1000 /karten,/ mit

crop() { convert "$tmp/$2" -crop "$3" +repage "$tmp/$1.png"; ffmpeg -loglevel error -y -i "$tmp/$1.png" -c:v libwebp -quality 72 -compression_level 6 "$ROOT_DIR/public/hilfe/$1.webp"; }
crop karten-wege karten-1440x900-karte-js.png 730x212+284+22
crop ablage hinzufuegen-1440x900-karte-js.png 832x312+289+125
crop an-der-box karten-860x1000-karte-js.png 776x588+43+313
crop gesundheitscheck start-860x1000-karte-js.png 840x242+8+58
identify -format '%f %wx%h\n' "$ROOT_DIR"/public/hilfe/*.webp
