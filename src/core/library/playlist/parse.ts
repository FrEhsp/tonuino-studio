/**
 * Reading a track list the user brought along: a Spotify data export (ZIP or
 * one of its JSON files), a CSV table, an M3U playlist or plain text. Only
 * the names of the songs are read; the sound comes from the user's own files
 * (see match.ts). Nothing here goes on the network.
 */
import type JSZip from 'jszip';
import { titleFromFileName } from '../grouping';
import { extensionOf } from '../tags';
import type { ListEntry, ParseResult, TrackList } from './types';

/** Largest file read as a track list. */
export const MAX_LIST_FILE_BYTES = 50 * 1024 * 1024;
/** Most entries kept per list; the rest count as skipped. */
export const MAX_LIST_ENTRIES = 10000;
/** Most lists kept from one file; a real Spotify export has a few hundred at most. */
export const MAX_LISTS = 1000;
/** Most entries over all lists of one file. */
const MAX_TOTAL_ENTRIES = 200000;
/** Most files a ZIP may hold; a Spotify export has a few dozen. */
const MAX_ZIP_ENTRIES = 5000;
/** Longer lines are no song title (and would only slow the reading down). */
const MAX_LINE = 2000;

/** Name of a list made from pasted text. */
export const PASTED_LIST_NAME = 'Eingefügte Liste';
/** Name of the "liked songs" in a Spotify export. */
export const LIKED_SONGS_NAME = 'Lieblingssongs';

const ORIGIN = { spotify: 'Spotify-Export', csv: 'CSV-Datei', m3u: 'M3U-Playlist', text: 'Text' } as const;

/** An entry before it gets its position. */
type Draft = Omit<ListEntry, 'position'>;

/** Reads one chosen file. Never throws: what cannot be read comes back as `problem`. */
export async function parseTrackListFile(name: string, bytes: Uint8Array): Promise<ParseResult> {
  if (bytes.length > MAX_LIST_FILE_BYTES) {
    return { lists: [], problem: 'Die Datei ist zu groß für eine Titelliste (mehr als 50 MB). Wähle die Datei mit der Playlist selbst.' };
  }
  if (bytes.length === 0) return { lists: [], problem: 'Die Datei ist leer.' };
  const ext = extensionOf(name);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (ext === 'zip' || isZip) {
    try {
      return await parseZip(bytes);
    } catch {
      return { lists: [], problem: 'Die ZIP-Datei lässt sich nicht öffnen. Vielleicht ist sie beim Herunterladen nicht vollständig angekommen – lade sie noch einmal herunter.' };
    }
  }
  if (['mp3', 'm4a', 'flac', 'ogg', 'wav', 'pdf', 'jpg', 'jpeg', 'png', 'xlsx', 'xls', 'ods', 'docx'].includes(ext)) {
    return { lists: [], problem: notAListText(ext) };
  }
  return parseTrackListText(decodeText(bytes), name);
}

/** Reads text: pasted by the user (no name) or the content of a chosen file. */
export function parseTrackListText(text: string, name?: string): ParseResult {
  const body = text.replace(/^\uFEFF/, '');
  const listName = name ? baseName(name).replace(/\.[^.]+$/, '') || PASTED_LIST_NAME : PASTED_LIST_NAME;
  const ext = name ? extensionOf(name) : '';
  if (!body.trim()) return { lists: [], problem: name ? 'In der Datei stehen keine Titel.' : 'Füge zuerst ein paar Titel ein, einen pro Zeile.' };

  const trimmed = body.trimStart();
  // Excel writes "sep=;" above a table it saved.
  const sep = /^sep=(.)\r?\n/i.exec(trimmed);
  if (sep) return parseCsv(trimmed.slice(sep[0].length), listName, sep[1]);
  if (ext === 'json' || (!ext && /^[{[]/.test(trimmed))) {
    const json = tryJson(body);
    if (json !== undefined) {
      const room = newRoom();
      return finish(spotifyLists(json, name ? baseName(name) : 'Liste.json', room), spotifyProblem([json]), room);
    }
    if (ext === 'json') return { lists: [], problem: 'Die JSON-Datei ist beschädigt oder unvollständig. Lade den Export noch einmal herunter.' };
  }
  if (ext === 'm3u' || ext === 'm3u8' || /^#EXTM3U/i.test(trimmed)) return parseM3u(body, listName);
  if (ext === 'csv' || ext === 'tsv') return parseCsv(body, listName, ext === 'tsv' ? '\t' : undefined);
  // Pasted or .txt: a table copied from a spreadsheet has a header row that names a title column.
  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  const delimiter = guessDelimiter(firstLine);
  if (delimiter && findColumns(splitCsvLine(firstLine, delimiter)).title !== undefined) {
    return parseCsv(body, listName, delimiter);
  }
  return parseText(body, listName);
}

/* ------------------------------------------------------------ Spotify export */

/** Files with what was played: large, and never a playlist. */
const HISTORY = /streaming_?history|endsong/i;

async function parseZip(bytes: Uint8Array): Promise<ParseResult> {
  // The ZIP says at its end how many files it holds: thousands are no data export, and opening them would take long.
  const count = zipEntryCount(bytes);
  if (count !== undefined && count > MAX_ZIP_ENTRIES) {
    return { lists: [], problem: 'In dieser ZIP-Datei sind sehr viele Dateien, das ist kein Spotify-Export. Wähle die ZIP-Datei mit deinen Spotify-Kontodaten.' };
  }
  const { default: JSZipLib } = await import('jszip');
  const zip = await JSZipLib.loadAsync(bytes);
  const lists: TrackList[] = [];
  const parsed: unknown[] = [];
  const room = newRoom();
  let names: string[] = [];
  zip.forEach((path, entry) => {
    if (!entry.dir) names.push(path);
  });
  names = names.slice(0, MAX_ZIP_ENTRIES).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  let budget = MAX_LIST_FILE_BYTES * 4;
  for (const path of names) {
    const file = baseName(path);
    if (extensionOf(file) !== 'json' || file.startsWith('._') || path.includes('__MACOSX/') || HISTORY.test(file)) continue;
    if (budget <= 0) break;
    const entry = zip.file(path);
    if (!entry) continue;
    // The size the ZIP states may be false: the unpacking itself counts and stops at the limit.
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (size !== undefined && (size > MAX_LIST_FILE_BYTES || size > budget)) continue;
    const unpacked = await unpackLimited(entry, Math.min(MAX_LIST_FILE_BYTES, budget));
    budget -= unpacked.used;
    // Bigger than a playlist can be: none (and maybe a trap).
    if (!unpacked.data) continue;
    const json = tryJson(decodeText(unpacked.data));
    if (json === undefined) continue;
    parsed.push(json);
    // The whole path: two "Playlist1.json" in different folders are different lists.
    lists.push(...spotifyLists(json, path, room));
  }
  if (!lists.length) {
    const history = names.some((n) => HISTORY.test(n));
    if (history && !parsed.some(hasPlaylists)) {
      return {
        lists: [],
        problem: 'In dieser ZIP-Datei steht nur, was du gehört hast, aber keine Playlist. Fordere bei Spotify die „Kontodaten“ an, darin stehen deine Playlists.',
      };
    }
    if (!parsed.some(hasPlaylists)) {
      return { lists: [], problem: 'In dieser ZIP-Datei ist keine Playlist. Wähle die ZIP-Datei mit deinen Spotify-Kontodaten.' };
    }
  }
  return finish(lists, spotifyProblem(parsed), room);
}

interface StreamLike {
  on(event: 'data', fn: (chunk: Uint8Array) => void): StreamLike;
  on(event: 'error', fn: (e: unknown) => void): StreamLike;
  on(event: 'end', fn: () => void): StreamLike;
  resume(): StreamLike;
  pause(): StreamLike;
}

/** Unpacks one file of the ZIP, but stops after `limit` bytes. `data` is missing when the file is bigger. */
function unpackLimited(entry: JSZip.JSZipObject, limit: number): Promise<{ data?: Uint8Array; used: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let used = 0;
    let ended = false;
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): StreamLike }).internalStream('uint8array');
    stream
      .on('data', (chunk) => {
        if (ended) return;
        used += chunk.length;
        if (used > limit) {
          ended = true;
          chunks.length = 0;
          stream.pause();
          resolve({ used });
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (e) => {
        if (ended) return;
        ended = true;
        reject(e);
      })
      .on('end', () => {
        if (ended) return;
        ended = true;
        const data = new Uint8Array(used);
        let at = 0;
        for (const c of chunks) {
          data.set(c, at);
          at += c.length;
        }
        resolve({ data, used });
      })
      .resume();
  });
}

/** The number of files the end record of a ZIP names; undefined when there is none. */
function zipEntryCount(bytes: Uint8Array): number | undefined {
  // The end record is 22 bytes, plus a comment of up to 65535.
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      // Total number of entries; 0xffff points to a ZIP64 record, which no export needs.
      return bytes[i + 10] | (bytes[i + 11] << 8);
    }
  }
  return undefined;
}

/** What is left of the limits on lists and entries while one file is read. */
interface Room {
  lists: number;
  entries: number;
  /** Lists left out for lack of room. */
  omitted: number;
}

function newRoom(): Room {
  return { lists: MAX_LISTS, entries: MAX_TOTAL_ENTRIES, omitted: 0 };
}

function hasPlaylists(json: unknown): boolean {
  return isObject(json) && (Array.isArray(json.playlists) || Array.isArray(json.tracks));
}

function spotifyProblem(parsed: unknown[]): string {
  if (!parsed.some(hasPlaylists)) {
    return 'In dieser Datei ist keine Playlist. Aus dem Spotify-Export passen die Dateien „Playlist1.json“ oder „YourLibrary.json“.';
  }
  return 'Die Playlists im Export enthalten keine Lieder, nur Podcast-Folgen, Hörbücher oder nichts.';
}

/** Playlists of one JSON file of a Spotify export: "Playlist1.json" or "YourLibrary.json". `file` (its path) makes the ids. */
function spotifyLists(json: unknown, file: string, room: Room): TrackList[] {
  if (!isObject(json)) return [];
  const lists: TrackList[] = [];
  const add = (list: TrackList) => {
    if (!list.entries.length) return;
    if (room.lists <= 0 || room.entries < list.entries.length) {
      room.omitted++;
      return;
    }
    room.lists--;
    room.entries -= list.entries.length;
    lists.push(list);
  };
  if (Array.isArray(json.playlists)) {
    json.playlists.forEach((p, i) => {
      if (!isObject(p)) return;
      if (room.lists <= 0) {
        room.omitted++;
        return;
      }
      const items = Array.isArray(p.items) ? p.items : Array.isArray(p.tracks) ? p.tracks : [];
      let skipped = 0;
      const drafts: Draft[] = [];
      for (const item of items) {
        const d = spotifyItem(item);
        if (d) drafts.push(d);
        else skipped++;
      }
      const name = text(p.name) ?? `Playlist ${i + 1}`;
      add(makeList(`${file}#${i + 1}`, name, ORIGIN.spotify, drafts, skipped));
    });
  }
  // YourLibrary.json: the liked songs (albums, shows and episodes there are no songs of a list).
  if (Array.isArray(json.tracks)) {
    let skipped = 0;
    const drafts: Draft[] = [];
    for (const t of json.tracks) {
      const d = isObject(t) ? spotifyTrack(t) : undefined;
      if (d) drafts.push(d);
      else skipped++;
    }
    add(makeList(file, LIKED_SONGS_NAME, ORIGIN.spotify, drafts, skipped));
  }
  return lists;
}

/** One item of a playlist: a song, a local file, or something left out (episode, audiobook, empty). */
function spotifyItem(item: unknown): Draft | undefined {
  if (!isObject(item)) return undefined;
  if (isObject(item.track)) return spotifyTrack(item.track);
  if (isObject(item.localTrack)) return spotifyTrack(item.localTrack);
  if (item.episode || item.audiobook || item.audiobookChapter) return undefined;
  // Some exports put the fields on the item itself.
  if (typeof item.track === 'string' || item.trackName) return spotifyTrack(item);
  return undefined;
}

function spotifyTrack(t: Record<string, unknown>): Draft | undefined {
  const uri = text(t.trackUri) ?? text(t.uri);
  let title = text(t.trackName) ?? text(t.track) ?? text(t.name) ?? text(t.title);
  let artist = text(t.artistName) ?? artistText(t.artist) ?? artistText(t.artists);
  let album = text(t.albumName) ?? albumText(t.album);
  let durationSec = msToSec(t.durationMs ?? t.duration_ms) ?? numberOf(t.duration);
  // Local files only carry "spotify:local:Artist:Album:Title:Seconds".
  if (uri?.startsWith('spotify:local:')) {
    const [a, b, c, d] = uri.slice('spotify:local:'.length).split(':').map(decodeLocal);
    title ??= c || undefined;
    artist ??= a || undefined;
    album ??= b || undefined;
    durationSec ??= numberOf(d);
  }
  if (uri && /^spotify:(episode|show|audiobook|chapter):/.test(uri)) return undefined;
  if (!title) return undefined;
  return {
    title,
    artists: artist ? [artist] : [],
    album,
    durationSec,
    isrc: text(t.isrc),
  };
}

function decodeLocal(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' ')).trim();
  } catch {
    return part.replace(/\+/g, ' ').trim();
  }
}

function artistText(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    const names = v.map((a) => (isObject(a) ? text(a.name) : text(a))).filter((a): a is string => !!a);
    return names.length ? names.join(', ') : undefined;
  }
  return isObject(v) ? text(v.name) : text(v);
}

function albumText(v: unknown): string | undefined {
  return isObject(v) ? text(v.name) : text(v);
}

/* ---------------------------------------------------------------------- CSV */

interface Columns {
  title?: number;
  artist?: number;
  album?: number;
  duration?: number;
  /** The duration column counts milliseconds. */
  durationMs?: boolean;
  isrc?: number;
}

/** Header names, squeezed to letters and digits ("Artist Name(s)" → "artistnames"), best first. */
const HEADERS = {
  title: ['trackname', 'titel', 'title', 'songtitel', 'songtitle', 'songname', 'liedtitel', 'tracktitle', 'song', 'lied', 'stück', 'stueck', 'track', 'name'],
  artist: ['artistnames', 'artistname', 'artists', 'artist', 'künstler', 'kuenstler', 'künstlerin', 'interpret', 'interpreten', 'interpretin', 'band', 'sänger', 'saenger'],
  album: ['albumname', 'album', 'albumtitel', 'albumtitle', 'cd'],
  duration: ['durationms', 'duration', 'dauer', 'länge', 'laenge', 'length', 'time', 'zeit', 'spielzeit', 'dauerms', 'trackdurationms'],
  isrc: ['isrc'],
};

function headerKey(cell: string): string {
  return cell.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function findColumns(header: string[]): Columns {
  const keys = header.map(headerKey);
  const pick = (names: string[]) => {
    for (const n of names) {
      const i = keys.indexOf(n);
      if (i >= 0) return i;
    }
    return undefined;
  };
  const duration = pick(HEADERS.duration);
  return {
    title: pick(HEADERS.title),
    artist: pick(HEADERS.artist),
    album: pick(HEADERS.album),
    duration,
    durationMs: duration !== undefined && /ms$|millis/.test(keys[duration]),
    isrc: pick(HEADERS.isrc),
  };
}

/** The separator a header row uses: comma, semicolon or tab (none for a single column). */
function guessDelimiter(line: string): string | undefined {
  let best: string | undefined;
  let most = 0;
  for (const d of [',', ';', '\t']) {
    const n = splitCsvLine(line, d).length - 1;
    if (n > most) [best, most] = [d, n];
  }
  return best;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  return parseCsvRows(line, delimiter)[0] ?? [];
}

/** RFC 4180: quoted fields may hold separators, line breaks and doubled quotes. */
function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Stands for "no separator": a table of one column keeps every line whole ("Hello, Goodbye"). */
const NO_SEPARATOR = '\u0000';

function parseCsv(body: string, listName: string, delimiter?: string): ParseResult {
  const firstLine = body.split(/\r?\n/, 1)[0];
  const sep = delimiter ?? guessDelimiter(firstLine) ?? NO_SEPARATOR;
  const rows = parseCsvRows(body, sep).filter((r) => r.some((c) => c.trim() !== ''));
  const cols = rows.length ? findColumns(rows[0]) : {};
  if (cols.title === undefined) {
    return {
      lists: [],
      problem: 'In der Tabelle fehlt eine Spalte mit den Liedtiteln. Die erste Zeile braucht Überschriften wie „Titel“ und „Künstler“.',
    };
  }
  const drafts: Draft[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const cell = (i: number | undefined) => (i === undefined ? undefined : clean(row[i]));
    const title = cell(cols.title);
    if (!title) {
      skipped++;
      continue;
    }
    const artist = cell(cols.artist);
    drafts.push({
      title,
      artists: artist ? splitListArtists(artist) : [],
      album: cell(cols.album),
      durationSec: parseDuration(cell(cols.duration), cols.durationMs ?? false),
      isrc: cell(cols.isrc),
    });
  }
  return finish([makeList(listName, listName, ORIGIN.csv, drafts, skipped)], 'In der Tabelle stehen keine Titel.');
}

/** "A, B" (Exportify writes a comma inside a name as "\,"). */
function splitListArtists(cell: string): string[] {
  return cell
    .split(/(?<!\\),/)
    .map((a) => a.replace(/\\,/g, ',').trim())
    .filter(Boolean);
}

/** "3:25", "1:02:03", "205" (seconds) or milliseconds (column says so, or more than 10000). */
function parseDuration(v: string | undefined, ms: boolean): number | undefined {
  if (!v) return undefined;
  const clock = /^(?:(\d+):)?(\d{1,3}):(\d{1,2})(?:[.,]\d+)?$/.exec(v);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return ms || n > 10000 ? n / 1000 : n;
}

/* ---------------------------------------------------------------------- M3U */

function parseM3u(body: string, fallbackName: string): ParseResult {
  let name = fallbackName;
  let pending: { title?: string; artist?: string; durationSec?: number } | undefined;
  const drafts: Draft[] = [];
  let skipped = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > MAX_LINE) {
      if (!line.startsWith('#')) skipped++;
      pending = undefined;
      continue;
    }
    if (line.startsWith('#')) {
      const playlist = /^#PLAYLIST:(.*)$/i.exec(line);
      if (playlist && clean(playlist[1])) name = clean(playlist[1])!;
      const inf = extInf(line);
      if (inf) pending = inf;
      continue;
    }
    const info = pending;
    pending = undefined;
    // Streams and web addresses only say something through their #EXTINF.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) && !/^file:/i.test(line)) {
      if (info?.title) drafts.push({ title: info.title, artists: info.artist ? [info.artist] : [], durationSec: info.durationSec });
      else skipped++;
      continue;
    }
    const file = fileNameOfPath(line);
    if (!file) {
      skipped++;
      continue;
    }
    const fromName = splitArtistTitle(titleFromFileName(file));
    const title = info?.title ?? fromName.title;
    const artist = info?.title ? info.artist : fromName.artist;
    if (!title) {
      skipped++;
      continue;
    }
    const path = filePathOf(line);
    drafts.push({ title, artists: artist ? [artist] : [], durationSec: info?.durationSec, fileHint: file, filePath: path.includes('/') ? path : undefined });
  }
  return finish([makeList(fallbackName, name, ORIGIN.m3u, drafts, skipped)], 'In der Playlist stehen keine Titel.');
}

/**
 * "#EXTINF:215,Artist - Title". Attributes (tvg-name="a, b") may stand
 * before the comma, so the comma is the first one outside quotes.
 */
function extInf(line: string): { title?: string; artist?: string; durationSec?: number } | undefined {
  if (!/^#EXTINF:/i.test(line)) return undefined;
  const rest = line.slice('#EXTINF:'.length);
  const sec = Number(/^\s*(-?[\d.]+)/.exec(rest)?.[1]);
  let quoted = false;
  let comma = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '"') quoted = !quoted;
    else if (rest[i] === ',' && !quoted) {
      comma = i;
      break;
    }
  }
  if (comma < 0) return undefined;
  return { ...splitArtistTitle(rest.slice(comma + 1)), durationSec: sec > 0 ? sec : undefined };
}

/** The path of a line as "/"-separated parts, "file://" and "%20" undone: "C:\Musik\a.mp3" → "C:/Musik/a.mp3". */
function filePathOf(line: string): string {
  let p = line;
  if (/^file:/i.test(p)) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/*/i, ''));
    } catch {
      p = p.replace(/^file:\/*/i, '');
    }
  }
  return p.replace(/\\/g, '/');
}

/** "C:\Musik\a.mp3", "../a.mp3" or "file:///home/a%20b.mp3" → "a.mp3" / "a b.mp3". */
function fileNameOfPath(path: string): string | undefined {
  return clean(baseName(filePathOf(path)));
}

/* --------------------------------------------------------------------- Text */

/**
 * A number in front of a line: "1. ", "1) " and "01 " always; "1 - " when
 * every line has a number; "1 " only when the numbers count up (1, 2, 3),
 * so "99 Luftballons" and "3 Chinesen mit dem Kontrabass" keep theirs.
 */
const NUMBERED = /^\d{1,4} ?[.)] ?(?=\S)/;
const ZERO_NUMBERED = /^0\d{0,3} ?[-–—:]? (?=\S)/;
const DASH_NUMBERED = /^\d{1,4} ?[-–—:] (?=\S)/;
const BARE_NUMBERED = /^\d{1,4} (?=\S)/;

/** The lines count up from their first number: "1 …", "2 …", "3 …". */
function countsUp(lines: string[]): boolean {
  const numbers = lines.map((l) => Number(/^\d{1,4}/.exec(l)?.[0]));
  return numbers.every((n, i) => n === numbers[0] + i);
}

function parseText(body: string, listName: string): ParseResult {
  const lines: string[] = [];
  let skipped = 0;
  for (const raw of body.split(/\r?\n/)) {
    if (raw.length > MAX_LINE) {
      skipped++;
      continue;
    }
    const l = clean(raw);
    if (l && !l.startsWith('#')) lines.push(l);
  }
  const allNumbered = lines.length > 1 && lines.every((l) => NUMBERED.test(l) || DASH_NUMBERED.test(l) || BARE_NUMBERED.test(l));
  const counting = allNumbered && countsUp(lines);
  const drafts: Draft[] = [];
  let links = 0;
  for (const line of lines) {
    if (/^(https?:\/\/|spotify:)/i.test(line)) {
      links++;
      skipped++;
      continue;
    }
    let rest = line.replace(NUMBERED, '');
    if (rest === line) rest = line.replace(ZERO_NUMBERED, '');
    if (rest === line && allNumbered) rest = line.replace(DASH_NUMBERED, '');
    if (rest === line && counting) rest = line.replace(BARE_NUMBERED, '');
    const { artist, title } = splitArtistTitle(rest);
    if (!title) {
      skipped++;
      continue;
    }
    drafts.push({ title, artists: artist ? [artist] : [] });
  }
  if (!drafts.length && links) {
    return {
      lists: [],
      problem: 'Das sind Links. Ich frage bei Spotify nichts nach, schreibe die Titel selbst hin („Künstler - Titel“) oder nimm deine Spotify-Kontodaten.',
    };
  }
  return finish([makeList(listName, listName, ORIGIN.text, drafts, skipped)], 'Darin stehen keine Titel. Schreibe einen Titel pro Zeile, gern als „Künstler - Titel“.');
}

/** "Artist - Title" (also with – or —); without a dash it is just the title. */
function splitArtistTitle(s: string): { artist?: string; title?: string } {
  const t = clean(s) ?? '';
  // The first " - " with text on both sides (found by position: no pattern that could take long on odd lines).
  const m = /\s[-–—]\s/.exec(t);
  if (m) {
    const artist = clean(t.slice(0, m.index));
    const title = clean(t.slice(m.index + 3));
    if (artist && title) return { artist, title };
  }
  return { title: clean(t.replace(/^[-–—] ?/, '').replace(/ ?[-–—]$/, '')) };
}

/* ------------------------------------------------------------------ helpers */

function makeList(id: string, name: string, origin: string, drafts: Draft[], skipped: number): TrackList {
  const kept = drafts.slice(0, MAX_LIST_ENTRIES);
  const entries: ListEntry[] = kept.map((d, i) => {
    const e: ListEntry = { position: i + 1, title: d.title, artists: d.artists };
    if (d.album) e.album = d.album;
    if (d.durationSec !== undefined) e.durationSec = d.durationSec;
    if (d.isrc) e.isrc = d.isrc;
    if (d.fileHint) e.fileHint = d.fileHint;
    if (d.filePath) e.filePath = d.filePath;
    return e;
  });
  const truncated = drafts.length - kept.length;
  const list: TrackList = { id, name, origin, entries, skipped: skipped + truncated };
  if (truncated) list.truncated = truncated;
  return list;
}

/** Leaves out empty lists; with none left, says why. */
function finish(lists: TrackList[], problem: string, room?: Room): ParseResult {
  const kept = lists.filter((l) => l.entries.length > 0);
  if (!kept.length) return { lists: [], problem };
  return room?.omitted ? { lists: kept, omittedLists: room.omitted } : { lists: kept };
}

function notAListText(ext: string): string {
  if (['mp3', 'm4a', 'flac', 'ogg', 'wav'].includes(ext)) {
    return 'Das ist ein Lied, keine Titelliste. Deine Lieder wählst du im nächsten Schritt.';
  }
  if (['xlsx', 'xls', 'ods'].includes(ext)) {
    return 'Tabellen bitte als CSV-Datei speichern (in Excel oder LibreOffice: „Speichern unter“ → CSV).';
  }
  return 'Diese Datei ist keine Titelliste. Passend sind der Spotify-Export (ZIP), CSV-, M3U- oder Textdateien.';
}

/**
 * UTF-16 when the file says so (iTunes and Excel save "Unicode text" so),
 * UTF-8, or Windows-1252 for older M3U and CSV files from Windows.
 */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  // Without the mark: in UTF-16 every other byte of plain text is zero.
  const sample = bytes.subarray(0, 1000);
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) (i % 2 ? oddZero++ : evenZero++);
  if (sample.length >= 4 && oddZero > sample.length / 4 && evenZero === 0) return new TextDecoder('utf-16le').decode(bytes);
  if (sample.length >= 4 && evenZero > sample.length / 4 && oddZero === 0) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' ? clean(v) : undefined;
}

/** Single spaces, no space at the ends; a lone half of a surrogate pair (broken text) becomes "�". */
function clean(s: string | undefined): string | undefined {
  const t = s
    ?.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t : undefined;
}

function numberOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function msToSec(v: unknown): number | undefined {
  const n = numberOf(v);
  return n === undefined ? undefined : n / 1000;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
