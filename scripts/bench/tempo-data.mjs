/**
 * The data of the 0.6 speed check (scripts/bench/tempo.mjs): the made-up
 * card of the speed comparison (card.mjs, 47 folders) grown to 52 folders,
 * as many as the measuring mode of the app shows (src/app/measure.ts), and
 * 200 short MP3 files for the list of „Musik auf die SD-Karte“. The new
 * folders are hard links to the first five (same files, own numbers, own
 * names in the catalog); the 200 files are cut from one tone that rises,
 * so no two sound alike (the app takes a double only once).
 *
 *   node scripts/bench/tempo-data.mjs    prints where they are
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BENCH_TMP, ensureCard } from './card.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = 1;
export const FOLDERS = 52;
export const TITLES = 200;

const MORE = [
  ['Der Leuchtturm am Ende der Welt', 'Henrike Feder', 'hoerspiel'],
  ['Kleine Wolke Wanda', 'Paula Pfeffer', 'lieder'],
  ['Opas Werkstatt-Lieder', 'Kalle Klang', 'lieder'],
  ['Das Zirkuspferd', 'Greta Grimm', 'hoerspiel'],
  ['Gute Nacht, kleiner Igel', 'Igel', 'hoerspiel'],
];

async function grow(from, to) {
  const tmp = `${to}.part`;
  rmSync(tmp, { recursive: true, force: true });
  // Hard links: no second copy of the card on the disk (the app only reads it, writes stay in the page).
  execFileSync('cp', ['-al', from, tmp]);
  // Own copies of what changes (a hard link would change the original card too).
  for (const f of ['tonuino-studio.json', 'tonuino-studio-covers.zip']) rmSync(join(tmp, f));
  const catalog = JSON.parse(readFileSync(join(from, 'tonuino-studio.json'), 'utf8'));
  const existing = Object.keys(catalog.folders).length;
  const { default: JSZip } = await import(pathToFileURL(join(ROOT, 'node_modules', 'jszip', 'lib', 'index.js')).href);
  const zip = await JSZip.loadAsync(readFileSync(join(from, 'tonuino-studio-covers.zip')));
  for (let i = 0; existing + i < FOLDERS; i++) {
    const src = String(i + 1).padStart(2, '0');
    const name = String(existing + i + 1).padStart(2, '0');
    mkdirSync(join(tmp, name));
    for (const f of readdirSync(join(from, src))) linkSync(join(from, src, f), join(tmp, name, f));
    const [title, artist, kind] = MORE[i % MORE.length];
    const entry = { ...catalog.folders[src], title, artist, kind };
    const cover = zip.file(`${src}.jpg`);
    if (cover) {
      zip.file(`${name}.jpg`, await cover.async('uint8array'), { binary: true, date: new Date(0) });
      entry.cover = `${name}.jpg`;
    }
    catalog.folders[name] = entry;
  }
  writeFileSync(join(tmp, 'tonuino-studio.json'), JSON.stringify(catalog, null, 1) + '\n');
  writeFileSync(join(tmp, 'tonuino-studio-covers.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
  rmSync(to, { recursive: true, force: true });
  renameSync(tmp, to);
}

function titles(dir) {
  const tmp = `${dir}.part`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // One rising tone, cut into TITLES files of 3 s (one ffmpeg run).
  execFileSync('nice', [
    '-n',
    '15',
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=sin(2*PI*(200+t*2)*t):s=22050:d=${TITLES * 3 - 1}`,
    '-ac',
    '1',
    '-b:a',
    '32k',
    '-f',
    'segment',
    '-segment_time',
    '3',
    '-reset_timestamps',
    '1',
    join(tmp, 'Titel %03d.mp3'),
  ]);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
}

/** Builds what is missing; returns the folders for server.mjs ({ card, imp }). */
export async function ensureTempoData() {
  const base = await ensureCard();
  const card = join(BENCH_TMP, `card52-${VERSION}`);
  const imp = join(BENCH_TMP, `titel200-${VERSION}`);
  if (!existsSync(join(card, 'tonuino-studio.json'))) await grow(base.card, card);
  if (!existsSync(imp)) titles(imp);
  return { card, imp, folders: FOLDERS, titles: readdirSync(imp).length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await ensureTempoData(), null, 1));
