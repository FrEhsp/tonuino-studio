/**
 * A made-up SD card for the speed comparison, like a full family card:
 * 47 folders (music albums, a few long audio books, one folder without a
 * cover), the full system announcements in mp3/ and advert/, a catalog and
 * a cover zip as the app writes them. Built once with ffmpeg and kept
 * (BENCH_TMP/card-<version>); the files hold real MP3 frames, short ones
 * except the first title of the long audio book, which runs ten minutes
 * (for the player: playing and seeking).
 *
 * Also a few MP3 files for the import measurement (BENCH_TMP/import-<version>).
 *
 *   node scripts/bench/card.mjs        prints the folders
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION = 4;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BENCH_TMP = process.env.BENCH_TMP ?? '/tmp/tonuino-bench';

/** The folder that holds the ten-minute title and the longest track list. */
export const LONG_FOLDER = 14;
/** The folder with many short titles for the import (it does not exist on the card). */
export const IMPORT_TRACKS = 24;

/** Made-up titles and artists like those on a family card, with umlauts and long names. */
const FOLDERS = [
  ['Konzert in der Küche', 'Topf & Deckel', 'musik', 16],
  ['Hinter dem Schrank 7', 'Diverse Interpreten', 'musik', 18],
  ['Morning Songs (Remastered)', 'Erwachsenen-Musik', 'musik', 12],
  ['Das Löffelkonzert', 'Die Spatzenbande', 'lieder', 20],
  ['Tanz mit dem Igel', 'Kalle Klang', 'lieder', 14],
  ['Unter dem Apfelbaum', 'Diverse Interpreten', 'lieder', 22],
  ['Blue Harbour', 'The Lighthouses', 'musik', 17],
  ['Northern Lights', 'Anna North', 'musik', 11],
  ['The Quiet Hours', 'Field & Stone', 'musik', 12],
  ['Die schönsten Kinderlieder zum Mitsingen', 'Kinderchor', 'lieder', 30],
  ['Sternschnuppe: Lieder für Kinder', 'Sternschnuppe', 'lieder', 19],
  ['Paper Moon', 'The Paper Birds', 'musik', 11],
  ['Green', 'Mara Wood', 'musik', 10],
  ['Die Reise zum Nebelberg (ungekürzte Lesung)', 'Henrike Feder', 'hoerbuch', 120],
  ['Paula und ihre Freunde', 'Paula Pfeffer', 'lieder', 21],
  ['Alles Gute', 'Kalle Klang', 'lieder', 15],
  ['Chansons du matin', 'Lola Blau', 'musik', 13],
  ['Paris la nuit', 'Lola Blau', 'musik', 14],
  ['Lotta & Lu: Das große Rennen (Soundtrack)', 'Lotta & Lu', 'musik', 24],
  ['Hinter dem Schrank 6', 'Diverse Interpreten', 'musik', 18],
  ['Hinter dem Schrank 5', 'Diverse Interpreten', 'musik', 18],
  ['Igel sucht den Mond', 'Igel', 'hoerspiel', 26],
  ['Hinter dem Schrank 4', 'Diverse Interpreten', 'musik', 18],
  ['Hinter dem Schrank 3', 'Diverse Interpreten', 'hoerspiel', 18],
  ['Lotta & Lu: Kuddelmuddel im Stall', 'Lotta & Lu', 'musik', 22],
  ['Plätzchenzeit', 'Paula Pfeffer', 'lieder', 16],
  ['Lieder aus der Kinderzeit', 'Diverse Interpreten', 'lieder', 25],
  ['Mutige Kinder', 'Paula Pfeffer', 'lieder', 17],
  ['Heute ist dein Tag', 'Paula Pfeffer', 'lieder', 18],
  ['Kling, Glöckchen! Das Winteralbum', 'Hinter dem Schrank', 'musik', 20],
  ['Tschu, tschu, die kleine Bahn', 'Diverse Interpreten', 'lieder', 24],
  ['Kinderdisco', 'Diverse Interpreten', 'lieder', 28],
  ['Schlaflieder', 'Diverse Interpreten', 'lieder', 20],
  ['Die Sonne geht auf', 'Diverse Interpreten', 'lieder', 19],
  ['Konzert in der Küche (Live)', 'Topf & Deckel', 'musik', 16],
  ['Hör mal', 'Diverse Interpreten', 'lieder', 15],
  ['Hinter dem Schrank', 'Diverse Interpreten', 'musik', 18],
  ['Hinter dem Schrank 2', 'Diverse Interpreten', 'musik', 18],
  ['Hinter dem Schrank 8', 'Diverse Interpreten', 'musik', 18],
  ['Paulas Vogelfest', 'Paula Pfeffer', 'lieder', 22],
  ['Wir sind die Kinder vom Wiesenweg', 'Diverse Interpreten', 'lieder', 21],
  ['Das Gespenst im Turm', 'Greta Grimm', 'hoerspiel', 34],
  ['Ein Boot nach Bananien', 'Bruno Bär', 'hoerspiel', 12],
  ['Das Buch ohne Ende (Lesung)', 'Henrike Feder', 'hoerbuch', 80],
  ['Der Dieb im Zauberwald 1–3', 'Greta Grimm', 'hoerspiel', 40],
  ['Die Hexe vom Hügel', 'Greta Grimm', 'hoerspiel', 30],
  ['Das Entlein', 'Diverse Interpreten', 'hoerspiel', 9],
];

const FAT_TIME = new Date('2025-11-02T10:00:00Z');

function ffmpeg(args) {
  execFileSync('nice', ['-n', '15', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/** An MP3 of `seconds` with a tone that differs per `seed`, mono 32 kbit/s, with an ID3 title. */
function mp3(path, seconds, seed, title) {
  const freq = 220 + ((seed * 37) % 600);
  ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, '-ac', '1', '-ar', '22050', '-b:a', '32k', '-metadata', `title=${title}`, '-id3v2_version', '3', path]);
}

function jpeg(path, seed) {
  const hue = (seed * 47) % 360;
  ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=600x600:rate=1,hue=h=${hue}:s=1.4`, '-frames:v', '1', '-q:v', '4', path]);
}

function fatTimes(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) fatTimes(p);
    utimesSync(p, FAT_TIME, FAT_TIME);
  }
  utimesSync(dir, FAT_TIME, FAT_TIME);
}

/** A ZIP with stored entries, as the app writes its cover file (via JSZip from the repo). */
async function coverZip(covers) {
  const { default: JSZip } = await import(pathToFileURL(join(ROOT, 'node_modules', 'jszip', 'lib', 'index.js')).href);
  const zip = new JSZip();
  for (const [name, bytes] of [...covers].sort()) zip.file(name, bytes, { binary: true, date: new Date(0) });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

async function buildCard(dir) {
  const tmp = `${dir}.part`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const base = join(tmp, '.base');
  mkdirSync(base);
  // A handful of short MP3s, copied as titles (the content does not matter, the frames are real).
  const shorts = [0, 1, 2, 3].map((k) => {
    const p = join(base, `short${k}.mp3`);
    mp3(p, 20 + k * 3, k, `Titel ${k}`);
    return readFileSync(p);
  });
  const longPath = join(base, 'long.mp3');
  mp3(longPath, 600, 99, 'Kapitel 1');
  const long = readFileSync(longPath);
  const announce = join(base, 'announce.mp3');
  mp3(announce, 1, 7, 'Ansage');
  const announceBytes = readFileSync(announce);

  const catalog = {
    app: 'tonuino-studio',
    format: 1,
    id: '6f0e2c1a-bench-4c1d-9d4e-tonuinobench',
    name: 'Messkarte',
    profile: 'tng',
    folders: {},
    extraCards: [],
    updatedAt: FAT_TIME.getTime(),
  };
  const covers = new Map();
  for (let i = 0; i < FOLDERS.length; i++) {
    const [title, artist, kind, count] = FOLDERS[i];
    const n = i + 1;
    const name = String(n).padStart(2, '0');
    mkdirSync(join(tmp, name));
    const tracks = [];
    let bytes = 0;
    for (let t = 1; t <= count; t++) {
      const file = `${String(t).padStart(3, '0')}.mp3`;
      const data = n === LONG_FOLDER && t === 1 ? long : shorts[(n + t) % shorts.length];
      writeFileSync(join(tmp, name, file), data);
      bytes += data.length;
      const chapter = kind === 'hoerbuch' || kind === 'hoerspiel' ? `Kapitel ${t}` : `Lied Nummer ${t} aus ${title}`;
      tracks.push({ file, title: chapter, durationSec: n === LONG_FOLDER && t === 1 ? 600 : 140 + ((t * 37 + n) % 160), size: data.length });
    }
    const entry = { title, artist, kind, card: { mode: kind === 'hoerbuch' ? 5 : 2 }, tracks, fingerprint: `${count}:${bytes}`, addedAt: FAT_TIME.getTime(), updatedAt: FAT_TIME.getTime() };
    // Folder 09 has no cover, as happens on real cards.
    if (n !== 9) {
      const cover = join(base, `${name}.jpg`);
      jpeg(cover, n);
      covers.set(`${name}.jpg`, readFileSync(cover));
      entry.cover = `${name}.jpg`;
      entry.coverSource = 'iTunes';
    }
    catalog.folders[name] = entry;
  }
  // System announcements as the TNG set brings them.
  mkdirSync(join(tmp, 'mp3'));
  mkdirSync(join(tmp, 'advert'));
  for (let k = 1; k <= 320; k++) writeFileSync(join(tmp, 'mp3', `${String(k).padStart(4, '0')}.mp3`), announceBytes);
  for (let k = 1; k <= 262; k++) writeFileSync(join(tmp, 'advert', `${String(k).padStart(4, '0')}.mp3`), announceBytes);
  writeFileSync(join(tmp, 'tonuino-studio.json'), JSON.stringify(catalog, null, 1) + '\n');
  writeFileSync(join(tmp, 'tonuino-studio-covers.zip'), await coverZip(covers));
  rmSync(base, { recursive: true, force: true });
  fatTimes(tmp);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
}

function buildImport(dir) {
  const tmp = `${dir}.part`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // An album as one gets it: 24 titles of about two minutes each, 128 kbit/s stereo (about 2 MB each).
  for (let t = 1; t <= IMPORT_TRACKS; t++) {
    const p = join(tmp, `${String(t).padStart(2, '0')} - Messlied ${t}.mp3`);
    const freq = 300 + t * 20;
    ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${110 + t}`, '-ac', '2', '-ar', '44100', '-b:a', '128k', '-metadata', `title=Messlied ${t}`, '-metadata', 'album=Messalbum', '-metadata', 'artist=Messband', '-metadata', `track=${t}`, '-id3v2_version', '3', p]);
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
}

/** Every file below `dir`: path, size, time; sorted like the card lists them (FAT order is the order of writing). */
export function indexOf(dir) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const p = join(at, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        out.push({ path: relative(dir, p), dir: true });
        walk(p);
      } else out.push({ path: relative(dir, p), size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(dir);
  return out;
}

/** Builds what is missing and returns where card and import files are. */
export async function ensureCard() {
  mkdirSync(BENCH_TMP, { recursive: true });
  const card = join(BENCH_TMP, `card-${VERSION}`);
  const imp = join(BENCH_TMP, `import-${VERSION}`);
  if (!existsSync(join(card, 'tonuino-studio.json'))) await buildCard(card);
  if (!existsSync(imp)) buildImport(imp);
  const files = indexOf(card);
  const bytes = files.reduce((a, f) => a + (f.size ?? 0), 0);
  const tag = createHash('sha1').update(JSON.stringify(files)).digest('hex').slice(0, 8);
  return { card, imp, folders: FOLDERS.length, files: files.filter((f) => !f.dir).length, bytes, tag };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const c = await ensureCard();
  console.log(JSON.stringify(c, null, 1));
}
