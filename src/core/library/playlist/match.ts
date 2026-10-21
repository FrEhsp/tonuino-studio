/**
 * Matching a track list against the user's own audio files: which file is
 * which song of the list. The same recording code (ISRC) or the file name
 * the list names settles it; otherwise title, artist and length are compared
 * after both sides are put into the same plain spelling. Every file goes to
 * one entry at most, the best pairs first.
 */
import { titleFromFileName } from '../grouping';
import type { Candidate, EntryMatch, LibraryFile, ListEntry, TrackList } from './types';

/** From this score a file counts as found. */
export const SURE_SCORE = 0.85;
/** From this score a file is offered, but the user should check it. */
export const UNSURE_SCORE = 0.6;
/** Candidates below this are not worth showing. */
const SHOW_SCORE = 0.35;
/** Candidates kept per entry (the user picks among the first five). */
const KEEP = 8;
const SHOW = 5;
/** Files scored in full per entry, after the token index narrowed them down. */
const SCORE_LIMIT = 300;

const WEIGHT = { title: 0.65, artist: 0.25, duration: 0.1, album: 0.1 };
/** Albums this alike count as the same; less alike, the album is left out of the score (songs come on many albums). */
const SAME_ALBUM = 0.8;
/** Titles and names are cut to this length: no song needs more, and odd long texts stay quick. */
const MAX_NAME = 300;

/* ----------------------------------------------------------- normalizing */

/** Words that mark a bracketed part as a version note, not part of the name. */
const VERSION_WORDS =
  /\b(remaster(ed)?|remix(ed)?|mix|edit|version|live|mono|stereo|explicit|clean|bonus|demo|acoustic|akustik|unplugged|instrumental|karaoke|deluxe|anniversary|single|radio|original|extended|re-?recorded|re-?mastered|feat\.?|ft\.|featuring|with|from|aus dem|soundtrack|ost|session|orchestral|reprise)\b/i;

/** Kinds of versions that are a different recording: a live version is no studio version. */
const VERSION_KINDS: [kind: string, re: RegExp, factor: number][] = [
  ['live', /\b(live|unplugged|konzert|concert)\b/i, 0.82],
  ['remix', /\b(remix(ed)?|rmx|club mix|extended mix|dub mix)\b/i, 0.82],
  ['acoustic', /\b(acoustic|akustik)\b/i, 0.82],
  ['instrumental', /\b(instrumental|karaoke|playback)\b/i, 0.7],
];

/**
 * Words a version note after a dash is made of ("Remastered 2011", "Radio
 * Edit", "Single Version"). Narrower than VERSION_WORDS: after a dash also
 * stand real parts of a name ("Folge 3: Heidi und das Original").
 */
const DASH_NOTE_WORDS = new Set(
  (
    'remaster remastered remasters remix remixed mix mixed edit edited version live mono stereo explicit clean bonus track demo ' +
    'acoustic akustik unplugged instrumental karaoke deluxe anniversary edition expanded single radio original extended re recorded ' +
    'rerecorded mastered digital digitally soundtrack ost session sessions orchestral reprise album short long cut studio alternate alt und'
  ).split(' '),
);

/** Leading words of a bracket that is a note even with numbers in it: "(feat. 50 Cent)", "(aus „Folge 12“)". */
const NOTE_START = /^(feat\.?|ft\.|featuring|with|mit|from|aus)\s/i;

/** Every number in the text is a year ("Remastered 2011"): nothing that tells songs or episodes apart is lost. */
function onlyYears(s: string): boolean {
  return (s.match(/\d+/g) ?? []).every((n) => /^(19|20)\d\d$/.test(n));
}

/** A part after " - " is a version note: "Radio Edit", "Remastered 2011", "Live at Wembley", 'From "Frozen"'. */
function isDashNote(part: string): boolean {
  if (part.includes(':') || !onlyYears(part)) return false;
  if (/^live( (at|in|from|aus|im|vom|von|on|bei) .*)?$/i.test(part)) return true;
  if (/^(from|aus) ["“„'‘«»]/i.test(part)) return true;
  const words = plain(part).split(' ');
  return words.every((w) => DASH_NOTE_WORDS.has(w) || /^(19|20)\d\d$/.test(w));
}

/** Where the last " - " (or – or —) of a title starts; -1 for none. */
function lastDash(s: string): number {
  return Math.max(s.lastIndexOf(' - '), s.lastIndexOf(' – '), s.lastIndexOf(' — '));
}

/** Single spaces, cut to MAX_NAME. */
function squeeze(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

export interface TitleParts {
  /** Plain spelling without version notes: "hey jude". */
  norm: string;
  /** Numbers in the title ("Folge 12" → ["12"]), sorted. Different numbers mean a different song or episode. */
  numbers: string;
  /** Version kinds named in the notes ("live", "remix", …). */
  versions: string[];
}

/** Lower case, no accents, ß → ss, & → und, no punctuation, single spaces. */
function plain(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/ł/g, 'l')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/&|\+/g, ' und ')
    .replace(/['’‘`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(and|et)\b/g, 'und')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Takes the version notes off a title, in its own spelling: "Song (feat. X) - Remastered 2011" → "Song". */
export function stripVersionInfo(title: string): string {
  return splitVersion(title).rest;
}

function splitVersion(title: string): { rest: string; notes: string[] } {
  const notes: string[] = [];
  const t = squeeze(title);
  // Bracketed notes: "(Remastered 2011)", "[Live]", "{Radio Edit}". Other brackets stay part of the name, and so do numbers.
  let rest = t.replace(/ ?[([{]([^()[\]{}]*)[)\]}]/g, (_all, inner: string) => {
    if (VERSION_WORDS.test(inner) && (onlyYears(inner) || NOTE_START.test(inner.trim()))) {
      notes.push(inner);
      return ' ';
    }
    return ` ${inner} `;
  });
  rest = rest.replace(/\s+/g, ' ').trim();
  // Dash notes at the end: "Song - Radio Edit", "Song - Live at Wembley".
  for (let at = lastDash(rest); at > 0; at = lastDash(rest)) {
    const tail = rest.slice(at + 3).trim();
    if (!tail || !isDashNote(tail)) break;
    notes.push(tail);
    rest = rest.slice(0, at).trim();
  }
  // "Song feat. X" without brackets.
  rest = rest.replace(/ (feat\.?|ft\.|featuring) .*$/i, (all) => {
    notes.push(all);
    return '';
  });
  rest = rest.trim();
  return { rest: rest || t, notes };
}

export function titleParts(title: string): TitleParts {
  const { rest, notes } = splitVersion(title);
  const norm = plain(rest);
  const numbers = [...new Set((norm.match(/\d+/g) ?? []).map((n) => String(Number(n))))].sort().join(' ');
  const noteText = notes.join(' ');
  const versions = VERSION_KINDS.filter(([, re]) => re.test(noteText)).map(([kind]) => kind);
  return { norm, numbers, versions };
}

/** A title in plain spelling, without version notes ("(Remastered 2011)", "- Radio Edit", "feat. …"). */
export function normalizeTitle(s: string): string {
  return titleParts(s).norm;
}

/** An artist name in plain spelling; a leading "The" goes. */
export function normalizeArtist(s: string): string {
  return plain(s).replace(/^the /, '');
}

const VARIOUS = /^(various( artists)?|verschiedene( interpreten| kunstler)?|va|diverse( interpreten)?|sampler|compilation)$/;

/** "A, B", "A & B", "A feat. B" → the whole name and each part, in plain spelling. */
function artistVariants(names: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const name = raw && squeeze(raw);
    if (!name) continue;
    const whole = normalizeArtist(name);
    if (!whole || VARIOUS.test(whole)) continue;
    out.add(whole);
    for (const part of name.split(/\s*(?:,|;|\/|&|\+|\band\b|\bund\b|\bfeat\.?|\bft\.|\bfeaturing\b|\bwith\b|\bvs\.?)\s*/i)) {
      const p = normalizeArtist(part);
      if (p && !VARIOUS.test(p)) out.add(p);
    }
  }
  return [...out];
}

/* -------------------------------------------------------------- the files */

/** Tag titles that say nothing ("Track 01", "Unbekannt"): the file name knows more. */
const PLACEHOLDER_TITLE = /^(track|titel|title|spur|audiotrack|unbekannt|unknown|untitled)\s*\d*$/i;

/** Title and artist of a file: from its tags, or from its name ("Artist - Title.mp3", "01 - Title.mp3"). */
export function libraryNameInfo(file: LibraryFile): { artist?: string; title: string } {
  const info = file.info;
  const tagArtist = [info?.artist, info?.albumArtist].find((a) => a && !VARIOUS.test(normalizeArtist(a)));
  if (info?.title && !PLACEHOLDER_TITLE.test(info.title.trim())) return { artist: tagArtist, title: info.title };
  const fromName = squeeze(titleFromFileName(file.source.name.slice(-MAX_NAME)));
  // The first " - " splits artist and title (found by position: odd long names stay quick).
  const dash = /\s[-–—]\s/.exec(fromName);
  const artist = dash ? fromName.slice(0, dash.index).trim() : '';
  const title = dash ? fromName.slice(dash.index + 3).trim() : '';
  if (artist && title) return { artist: tagArtist ?? artist, title };
  return { artist: tagArtist, title: fromName };
}

function cleanIsrc(s: string | undefined): string | undefined {
  const t = s?.replace(/[\s-]/g, '').toUpperCase();
  return t && /^[A-Z0-9]{12}$/.test(t) ? t : undefined;
}

/** A path in lower case, split at "/" and "\\". */
function pathParts(path: string): string[] {
  return path.toLowerCase().split(/[\\/]/).filter(Boolean);
}

function baseName(path: string): string {
  return pathParts(path).pop() ?? path.toLowerCase();
}

/** How many parts two paths share from the end: "Bibi/Folge 12/01.mp3" and "Musik/Bibi/Folge 12/01.mp3" share 3. */
function sharedTail(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** An album in plain spelling; `series` is the same without numbers ("band 2" → "band"). */
interface AlbumParts {
  norm: string;
  numbers: string;
  series: string;
  grams: Uint32Array;
}

function albumParts(album: string | undefined): AlbumParts | undefined {
  if (!album?.trim()) return undefined;
  const { norm, numbers } = titleParts(album);
  if (!norm) return undefined;
  return { norm, numbers, series: norm.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim(), grams: bigrams(norm) };
}

interface Side {
  title: TitleParts;
  grams: Uint32Array;
  artists: { name: string; grams: Uint32Array }[];
  album?: AlbumParts;
  durationSec?: number;
  isrc?: string;
}

interface PreparedFile extends Side {
  index: number;
  /** Base name in lower case. */
  name: string;
  /** Path parts in lower case: from the folder the user chose, or the whole path. */
  path: string[];
  file: LibraryFile;
}

interface PreparedEntry extends Side {
  entry: ListEntry;
  /** Base name of the file the list names, in lower case. */
  hint?: string;
  /** The path the list names, in lower case parts (just the base name when it has no folders). */
  hintPath?: string[];
  /** Same song, same version: for finding repeats in the list. */
  key: string;
}

function prepareFile(file: LibraryFile, index: number): PreparedFile {
  const named = libraryNameInfo(file);
  const title = titleParts(named.title);
  const path = pathParts(file.source.relativePath ?? file.source.path ?? file.source.name);
  return {
    index,
    file,
    name: baseName(file.source.name),
    path: path.length ? path : [baseName(file.source.name)],
    title,
    grams: bigrams(title.norm),
    artists: artistVariants([named.artist, file.info?.albumArtist]).map((name) => ({ name, grams: bigrams(name) })),
    album: albumParts(file.info?.album),
    durationSec: file.info?.durationSec,
    isrc: cleanIsrc(file.info?.isrc),
  };
}

function prepareEntry(entry: ListEntry): PreparedEntry {
  const title = titleParts(entry.title);
  const artists = artistVariants(entry.artists);
  const hint = entry.fileHint ? baseName(entry.fileHint) : undefined;
  const hintPath = entry.filePath ? pathParts(entry.filePath) : hint ? [hint] : undefined;
  return {
    entry,
    title,
    grams: bigrams(title.norm),
    artists: artists.map((name) => ({ name, grams: bigrams(name) })),
    album: albumParts(entry.album),
    durationSec: entry.durationSec,
    isrc: cleanIsrc(entry.isrc),
    hint,
    hintPath: hintPath?.length ? hintPath : undefined,
    key: `${entry.artists.map(normalizeArtist).sort().join(',')}|${title.norm}|${title.versions.join(',')}`,
  };
}

/** Two albums are one, or one series with the same number: "Band 2" and "Band 2 (Remastered)". */
function sameAlbum(a: AlbumParts, b: AlbumParts): boolean {
  return a.norm === b.norm || dice(a.grams, b.grams) >= SAME_ALBUM;
}

/**
 * A repeat of an earlier entry: the same recording code, or the same artist,
 * title and version, and neither the album nor the file the list names
 * says otherwise ("Kapitel 1" of "Band 1" is not "Kapitel 1" of "Band 2").
 */
function repeats(e: PreparedEntry, first: PreparedEntry): boolean {
  if (e.album && first.album && e.album.norm !== first.album.norm) return false;
  if (e.hintPath && first.hintPath && e.hintPath.join('/') !== first.hintPath.join('/')) return false;
  return true;
}

/* ---------------------------------------------------------------- scoring */

/** Character pairs of " text ", sorted, for the Dice similarity. */
function bigrams(s: string): Uint32Array {
  if (!s) return new Uint32Array(0);
  const t = ` ${s} `;
  const out = new Uint32Array(t.length - 1);
  for (let i = 0; i < t.length - 1; i++) out[i] = ((t.charCodeAt(i) << 16) | t.charCodeAt(i + 1)) >>> 0;
  return out.sort();
}

/** Dice similarity of two sorted bigram lists: 1 for the same text, 0 for nothing in common. */
function dice(a: Uint32Array, b: Uint32Array): number {
  if (!a.length || !b.length) return 0;
  let i = 0;
  let j = 0;
  let same = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      same++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return (2 * same) / (a.length + b.length);
}

/**
 * How the file the list names fits a file: 'only' when no other file fits
 * the named path as well ("Bibi/Folge 12/01.mp3" settles it, a bare "01.mp3"
 * among many does not), 'same' when the base name is the same.
 */
type NameFit = 'only' | 'same' | undefined;

function score(e: PreparedEntry, f: PreparedFile, name: NameFit): Candidate {
  if (e.isrc && e.isrc === f.isrc) return { file: f.file, score: 1, reason: 'isrc' };
  if (name === 'only') return { file: f.file, score: 1, reason: 'name' };
  const tags = scoreTags(e, f);
  // The same name, but other files have it too: the name helps, the tags decide, and without them the user does.
  if (name === 'same' && tags < SURE_SCORE) return { file: f.file, score: UNSURE_SCORE + (SURE_SCORE - 0.01 - UNSURE_SCORE) * tags, reason: 'name' };
  return { file: f.file, score: tags, reason: 'tags' };
}

function scoreTags(e: PreparedEntry, f: PreparedFile): number {
  const title = e.title.norm === f.title.norm ? 1 : dice(e.grams, f.grams);
  let sum = WEIGHT.title * title;
  let weight = WEIGHT.title;
  if (e.artists.length) {
    // An untagged file says nothing about its artist: half marks.
    let artist = f.artists.length ? 0 : 0.5;
    for (const a of e.artists) for (const b of f.artists) artist = Math.max(artist, a.name === b.name ? 1 : dice(a.grams, b.grams));
    sum += WEIGHT.artist * artist;
    weight += WEIGHT.artist;
  }
  if (e.durationSec !== undefined && f.durationSec !== undefined) {
    const delta = Math.abs(e.durationSec - f.durationSec);
    sum += WEIGHT.duration * Math.min(1, Math.max(0, (20 - delta) / 17));
    weight += WEIGHT.duration;
  }
  // The same album speaks for the file; another album says little (a song is on many albums).
  const sameAlbumToo = !!e.album && !!f.album && sameAlbum(e.album, f.album);
  if (sameAlbumToo) {
    sum += WEIGHT.album;
    weight += WEIGHT.album;
  }
  let s = sum / weight;
  // "Folge 12" is not "Folge 21": different numbers rule a file out unless the user picks it.
  if (e.title.numbers !== f.title.numbers) s *= e.title.numbers && f.title.numbers ? 0.5 : 0.92;
  // So are "Band 1" and "Band 2" of one series, even with the same chapter titles.
  if (e.album && f.album && e.album.numbers && f.album.numbers && e.album.numbers !== f.album.numbers) {
    if (e.album.series === f.album.series || dice(bigrams(e.album.series), bigrams(f.album.series)) >= SAME_ALBUM) s *= 0.5;
  }
  for (const [kind, , factor] of VERSION_KINDS) {
    if (e.title.versions.includes(kind) !== f.title.versions.includes(kind)) s *= factor;
  }
  return s;
}

/** Files whose name fits the one the list names, and how ('only' for the one that fits the path best, when it is alone). */
function nameFits(e: PreparedEntry, idx: Index): Map<number, NameFit> {
  const fits = new Map<number, NameFit>();
  const same = (e.hint && idx.byName.get(e.hint)) || [];
  if (!same.length || !e.hintPath) return fits;
  let best = 0;
  let bestCount = 0;
  let bestIndex = -1;
  for (const i of same) {
    fits.set(i, 'same');
    const shared = sharedTail(e.hintPath, idx.files[i].path);
    if (shared > best) [best, bestCount, bestIndex] = [shared, 1, i];
    else if (shared === best) bestCount++;
  }
  if (bestCount === 1) fits.set(bestIndex, 'only');
  return fits;
}

/* ------------------------------------------------------------- the index */

/** Words of a title and the first four letters of long words (catches small typos). */
function indexKeys(norm: string): string[] {
  const keys = new Set<string>();
  for (const w of norm.split(' ')) {
    if (!w) continue;
    keys.add(w);
    if (w.length >= 5) keys.add(`^${w.slice(0, 4)}`);
  }
  return [...keys];
}

interface Index {
  files: PreparedFile[];
  byKey: Map<string, number[]>;
  byNorm: Map<string, number[]>;
  byIsrc: Map<string, number[]>;
  byName: Map<string, number[]>;
  /** Keys in more files than this narrow nothing down. */
  common: number;
}

function push(map: Map<string, number[]>, key: string | undefined, i: number): void {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(i);
  else map.set(key, [i]);
}

/** Files that could be the entry: same ISRC, same name, same title, or the most title words in common. */
function candidatesOf(e: PreparedEntry, idx: Index, counts: Int32Array): number[] {
  const out = new Set<number>();
  for (const i of (e.isrc && idx.byIsrc.get(e.isrc)) || []) out.add(i);
  for (const i of (e.hint && idx.byName.get(e.hint)) || []) out.add(i);
  for (const i of idx.byNorm.get(e.title.norm) ?? []) out.add(i);
  const postings = indexKeys(e.title.norm)
    .map((k) => idx.byKey.get(k))
    .filter((p): p is number[] => !!p)
    .sort((a, b) => a.length - b.length);
  // Common words ("the", "die", "love") only count when the title has nothing rarer.
  const useful = postings.filter((p) => p.length <= idx.common);
  const lists = useful.length ? useful : postings.slice(0, 1);
  const touched: number[] = [];
  for (const p of lists) {
    for (const i of p) {
      if (counts[i] === 0) touched.push(i);
      counts[i]++;
    }
  }
  const len = e.title.norm.length;
  const rank = (i: number) => counts[i] * 1000 - Math.abs(idx.files[i].title.norm.length - len);
  if (touched.length > SCORE_LIMIT) touched.sort((a, b) => rank(b) - rank(a) || a - b);
  for (const i of touched.slice(0, SCORE_LIMIT)) out.add(i);
  for (const i of touched) counts[i] = 0;
  return [...out];
}

/* ---------------------------------------------------------- the matching */

export interface MatchProgress {
  done: number;
  total: number;
}

/** A candidate and the index of its file. */
interface Scored {
  c: Candidate;
  i: number;
}

/** Files prepared, and entries scored, between two breaks of the async variant. */
const FILES_PER_STEP = 2000;
const ENTRIES_PER_STEP = 200;

/** The whole matching, in steps: the async variant lets the page breathe between them. */
function* matchSteps(list: TrackList, files: LibraryFile[]): Generator<MatchProgress, EntryMatch[]> {
  const total = files.length + list.entries.length;
  const idx: Index = {
    files: [],
    byKey: new Map(),
    byNorm: new Map(),
    byIsrc: new Map(),
    byName: new Map(),
    common: Math.max(500, Math.ceil(files.length / 20)),
  };
  for (let i = 0; i < files.length; i++) {
    const f = prepareFile(files[i], i);
    idx.files.push(f);
    for (const k of indexKeys(f.title.norm)) push(idx.byKey, k, i);
    push(idx.byNorm, f.title.norm, i);
    push(idx.byIsrc, f.isrc, i);
    push(idx.byName, f.name, i);
    if ((i + 1) % FILES_PER_STEP === 0) yield { done: i + 1, total };
  }

  // Repeats in the list: the first one counts, the others are left out.
  const entries = list.entries.map(prepareEntry);
  const firstByKey = new Map<string, PreparedEntry[]>();
  const firstByIsrc = new Map<string, number>();
  const duplicateOf: (number | undefined)[] = entries.map((e) => {
    const sameIsrc = e.isrc ? firstByIsrc.get(e.isrc) : undefined;
    if (sameIsrc !== undefined) return sameIsrc;
    const earlier = e.title.norm ? (firstByKey.get(e.key) ?? []) : [];
    const first = earlier.find((f) => repeats(e, f));
    if (first) return first.entry.position;
    if (e.isrc) firstByIsrc.set(e.isrc, e.entry.position);
    if (e.title.norm) firstByKey.set(e.key, [...earlier, e]);
    return undefined;
  });

  const counts = new Int32Array(files.length);
  const kept: Scored[][] = [];
  const pairs: { entry: number; file: number; score: number }[] = [];
  for (let n = 0; n < entries.length; n++) {
    const e = entries[n];
    const found: Scored[] = [];
    if (duplicateOf[n] === undefined) {
      const fits = nameFits(e, idx);
      for (const i of candidatesOf(e, idx, counts)) {
        const c = score(e, idx.files[i], fits.get(i));
        if (c.score >= SHOW_SCORE) found.push({ c, i });
      }
      found.sort((a, b) => b.c.score - a.c.score || a.i - b.i);
      found.length = Math.min(found.length, KEEP);
      for (const { c, i } of found) if (c.score >= UNSURE_SCORE) pairs.push({ entry: n, file: i, score: c.score });
    }
    kept.push(found);
    if ((n + 1) % ENTRIES_PER_STEP === 0) yield { done: files.length + n + 1, total };
  }

  // Best pairs first; each file and each entry once.
  pairs.sort((a, b) => b.score - a.score || a.entry - b.entry || a.file - b.file);
  const chosen = new Map<number, number>();
  const used = new Set<number>();
  for (const p of pairs) {
    if (chosen.has(p.entry) || used.has(p.file)) continue;
    chosen.set(p.entry, p.file);
    used.add(p.file);
  }

  return entries.map((e, n): EntryMatch => {
    const dup = duplicateOf[n];
    if (dup !== undefined) return { entry: e.entry, quality: 'fehlt', candidates: [], duplicateOf: dup };
    const found = kept[n];
    const fi = chosen.get(n);
    if (fi === undefined) return { entry: e.entry, quality: 'fehlt', candidates: found.slice(0, SHOW).map((s) => s.c) };
    const pick = found.find((s) => s.i === fi)!;
    const shown = found.slice(0, SHOW);
    if (!shown.includes(pick)) shown[SHOW - 1] = pick;
    let quality: EntryMatch['quality'] = pick.c.score >= SURE_SCORE ? 'sicher' : 'unsicher';
    // Only a title, and another artist's song fits as well: the user decides.
    if (quality === 'sicher' && pick.c.reason === 'tags' && !e.artists.length) {
      const artistOf = (s: Scored) => idx.files[s.i].artists[0]?.name ?? '';
      if (found.some((s) => s !== pick && s.c.reason === 'tags' && s.c.score >= pick.c.score - 0.03 && artistOf(s) !== artistOf(pick))) quality = 'unsicher';
    }
    return { entry: e.entry, quality, chosen: pick.c.file, candidates: shown.map((s) => s.c) };
  });
}

/** Matches a list against the user's files, in list order. */
export function matchTrackList(list: TrackList, files: LibraryFile[]): EntryMatch[] {
  const steps = matchSteps(list, files);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * The same, with breaks every few hundred entries so the page stays usable.
 * Throws the signal's reason (an AbortError) when cancelled.
 */
export async function matchTrackListAsync(
  list: TrackList,
  files: LibraryFile[],
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<EntryMatch[]> {
  const steps = matchSteps(list, files);
  const total = files.length + list.entries.length;
  for (;;) {
    opts.signal?.throwIfAborted();
    const r = steps.next();
    if (r.done) {
      opts.onProgress?.(total, total);
      return r.value;
    }
    opts.onProgress?.(r.value.done, r.value.total);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
