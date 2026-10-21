import { effect, signal } from '@preact/signals';
import { mapLimit } from '../../core/async';
import { checkMp3, GAIN_STEP_DB, MAX_BOOST_DB, mp3DurationOf, mp3DurationSec, QUIET_SHORTFALL_DB, type Mp3Rebuild } from '../../core/audio';
import { cutAtTracks, estimateTrackCount, groupIntoAlbums, hasAlbumCuts, isCuttable, isLongTrack, isPlayableAsIs, isSplit, type AlbumDraft, type DraftTrack, type InputFile, type SplitMode } from '../../core/library/grouping';
import { AUDIO_EXTENSIONS, extensionOf, readTrackInfo, type TrackInfo } from '../../core/library/tags';
import { unzipSource } from './unzip';
import { listing, numberGaps, SHORT_SEC, tooShort } from '../../core/library/albumcheck';
import { sameSoundGroups, soundFingerprint } from '../../core/library/sameaudio';
import { applyHints } from '../../core/library/hints';
import { albumFromSources, coverCredit, creditTagsFor, recordOrigins, seriesFor, UNCHANGED_NOT_MP3, type TrackOrigin, type WrittenTrack } from '../../core/sources/origin';
import { CONTENT_KINDS, newId, type Catalog, type CatalogFolder, type CatalogTrack } from '../../core/tonuino/catalog';
import { executePlan, planFix } from '../../core/tonuino/repair';
import { folderName, helperFolders, importTrackName, isOutOfOrder, MAX_TRACKS, nextFolderNumber, parseNumberedAudio, type SdScan } from '../../core/tonuino/sd';
import { seriesKey, seriesOfTitle } from '../../core/tonuino/series';
import type { ByteSource, Dir } from '../../platform/types';
import { normalizeCover } from '../../ui/image';
import { playDoneSound } from '../../ui/sound';
import { card, plat, rescan, recordingInImport, setCover, settings, transferredToCard, updateCatalog } from '../../app/state';
import { formatBytes, plural } from '../../app/format';
import { holdWhile, writeGuard } from '../../app/writeguard';
import type { CoverKind } from '../../core/stickers/coversearch';
import { uprightFor } from '../box/CoverDialog';
import { announcementText, announceTrack } from '../../core/audio/announce';
import { fileSource } from '../../core/audio/source';
import { matchCues, measuredOf, readCue } from './wholeAlbum';
import { estimateAlbumBytes, FileError, prepareAlbum, UNREADABLE, type AlbumGain, type PreparedAlbum, type TrackJob, type TrackWork } from './process';

/** The album a cover of the online search belongs to (CoverCandidate's id, and its edition for a cassette). */
export interface CoverHit {
  id: string;
  edition?: string;
}

/** An album on its way to the card: one TonUINO folder. */
export interface ImportAlbum extends AlbumDraft {
  /** Folder number on the card. */
  target: number;
  /** Adds to an existing folder instead of creating one. */
  append: boolean;
  /** Preview of the cover found in the files. */
  coverUrl?: string;
  /**
   * A picture chosen in the review: where it came from ("Datei", "iTunes" …) and whether it is a cassette cover. Without it,
   * the picture came with the files. `hit`: the album of an online search's cover, whose track list may cut the file.
   */
  coverFrom?: { source: string; kind?: CoverKind; hit?: CoverHit };
  /** „Ohne Bild“ chosen: files added later bring none either. */
  noCover?: boolean;
  /** Going on with a transfer that stopped in this album. */
  resume?: ResumeInfo;
  /** Titles the album gave when it was prepared with these settings, because they did not fit into the folder. */
  planned?: { split: SplitMode; splitMinutes: number; tracks: number };
  /** The extra "Titelansagen": each title is spoken in front of its file (desktop app). */
  announce?: boolean;
}

/** Where a transfer that stopped in an album goes on. */
export interface ResumeInfo {
  /**
   * Cut files of which the first parts are on the card already: how many, of
   * how many, and their file names in the folder (the last files there).
   */
  parts: Map<ByteSource, { done: number; of: number; files: string[] }>;
  /** The album's loudness change, so the rest sounds the same. */
  gain: AlbumGain;
  /** Number of the last file in the folder after the stop: when it differs, the folder or the card changed. */
  last: number;
}

export type Phase = 'pick' | 'reading' | 'review' | 'writing' | 'done';

export type WriteStep = 'prepare' | 'adjust' | 'convert' | 'cut' | 'copy' | 'check';

const STEP_FOR: Record<TrackWork, WriteStep> = { copy: 'copy', adjust: 'adjust', convert: 'convert', cut: 'cut' };

/** Rough part of a file's time that goes into the work before copying, for the overall progress. */
const WORK_SHARE: Record<TrackWork, number> = { copy: 0, adjust: 0.4, cut: 0.3, convert: 0.85 };

/** Part of an album's time that goes into measuring it (loudness, pauses) before its files: about one read of every file. */
export const PREPARE_SHARE = 0.3;

/** The part of the album's bar for its preparation: small when nothing is measured, only the files checked. */
export function prepareShare(a: Pick<ImportAlbum, 'tracks' | 'split' | 'unchanged' | 'resume'>, normalizeLoudness: boolean): number {
  const measures = (normalizeLoudness && !a.unchanged && !a.resume?.gain) || (a.split !== 'none' && a.tracks.some(isCuttable));
  return measures ? PREPARE_SHARE : 0.05;
}

/**
 * One album on the overall bar of a transfer, which weighs every album by
 * its estimated size from `start` on. The preparation fills the first
 * `share` of it, the work on the files and the writing the rest: the bar
 * moves through both, instead of waiting at 0 % and then jumping.
 */
export function albumProgress(start: number, bytes: number, share: number) {
  let prepared = 0;
  return {
    /** While preparing: steps one after the other each go from 0 to 1, the bar never moves back. */
    prepare(fraction: number): number {
      prepared = Math.max(prepared, Math.min(1, Math.max(0, fraction)));
      return start + bytes * share * prepared;
    },
    /** While working on the files: `done` of `total`, in the files' own estimates. */
    files(done: number, total: number): number {
      return start + bytes * (share + (1 - share) * (total > 0 ? Math.min(1, done / total) : 1));
    },
    end: start + bytes,
  };
}

export interface WriteState {
  album: number;
  albums: number;
  track: number;
  tracks: number;
  folder: number;
  title: string;
  step: WriteStep;
  /** Shown while preparing, e.g. "Sucht Sprechpausen". */
  detail?: string;
  /** 0..1 within the current step, when known. */
  fraction?: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface ImportResult {
  /** Folders whose files are on the card (but for files in `skipped`). */
  folders: number[];
  /** Albums that arrived, when several went onto one folder (episodes); else one per folder. */
  albums?: number;
  /** Folders that got albums as episodes of their own (extra „Mehr als 99 Hörspiele“): each wants a card per episode. */
  episodes?: number[];
  /** The folder that was being written when the import stopped. */
  partial?: { folder: number; written: number };
  cancelled?: boolean;
  /** Why the import stopped: the card, or something unexpected. */
  error?: string;
  /** Albums that could not go to the card as they are, with the reason. The others went on. */
  refused: { title: string; reason: string }[];
  /** Files left out because they could not be read or converted, with the reason. The others went on. */
  skipped: { name: string; reason: string }[];
  /**
   * What is not on the card yet and can go there on another try: albums not
   * started or refused, and what is missing in `partial`, ready to go on with
   * where it stopped (also inside a cut file, with the same loudness).
   */
  rest: ImportAlbum[];
  /** The app fixed the order of the files on the card afterwards. */
  reordered: number[];
  /**
   * Folders whose order the app could not fix: hidden files in them would
   * stay behind (removing them is up to the user), or the fix failed.
   */
  unordered?: number[];
  /**
   * What the app did on its own that is worth knowing: files it made anew,
   * albums that stayed quieter. After „Rest übertragen“ the notes of the
   * runs before are kept.
   */
  notes?: ImportNote[];
  /** Hidden files (such as "._001.mp3" from a Mac) left in the folders the transfer wrote to, as "03/._001.mp3". */
  junk?: string[];
}

/** Something the done screen tells about the transfer, besides what went wrong. */
export type ImportNote =
  /** An MP3 that was damaged or joined from several files, converted anew. `file` is its path as picked. */
  | { kind: 'rebuilt'; reason: Mp3Rebuild; file: string; folder: number }
  /** An MP3 album that stayed about `db` decibels under the others, because its MP3s would clip otherwise. */
  /** `boostLeft`: dB the album would still lack with „Leise MP3s lauter machen“, which boosts by MAX_BOOST_DB at most. */
  | { kind: 'quiet'; title: string; folder: number; db: number; boostLeft?: number }
  /** A quiet MP3 album whose MP3s were converted to make it louder (boostQuietMp3). */
  /** `db`: how much quieter than the others the album stayed, beyond the largest boost. */
  | { kind: 'boosted'; title: string; folder: number; db?: number }
  /** Titles that went to the card without their spoken title (the extra "Titelansagen"), with the first reason. */
  | { kind: 'unannounced'; folder: number; titles: string[]; reason: string }
  /** The loudness change „Gleiche Lautstärke“ gave the album, in dB (negative: quieter). */
  | { kind: 'level'; title: string; folder: number; db: number }
  /** Files that were clipped before they came here (isClipped); `file` is the path as picked. */
  | { kind: 'clipped'; file: string; folder: number }
  /** The album's cover (found in its files or chosen in the review) could not be stored for its folder. */
  | { kind: 'cover'; folder: number; title: string; reason: string };

/** Something that will not be transferred, with the reason in words for the user. */
export interface RejectedEntry {
  name: string;
  reason: string;
  /** A download that could not be loaded: an entry of a web page or of "Entdecken" (not a file of the user). */
  web?: boolean;
}

export interface ImportSession {
  phase: Phase;
  /** Adds everything to this folder (from "Titel hinzufügen" on a folder page). */
  forFolder?: number;
  reading?: { done: number; total: number };
  albums: ImportAlbum[];
  /** Files that are not audio or could not be read, and downloads that could not be loaded. */
  rejected: RejectedEntry[];
  write?: WriteState;
  result?: ImportResult;
  /** Notes of the runs before, when the transfer goes on with „Rest übertragen“. */
  notes?: ImportNote[];
  /** Something in the review was changed by hand (title, order, folder, kind …): discarding asks first. */
  edited?: boolean;
  /** Started by a recording ("Selbst aufnehmen"): the review asks only where it goes (AddPage.tsx). */
  recording?: boolean;
  /**
   * Folders that get several albums of one series as episodes, from the
   * offer of the add page (packOffer), also with the extra "Mehr als 99
   * Hörspiele" off: each album's tracks get its name as their episode, a
   * new folder the series' name.
   */
  packed?: { folder: number; title: string }[];
}

export const session = signal<ImportSession>({ phase: 'pick', albums: [], rejected: [] });

// Told to the tabs without them reading the import (audit 0.4 #27): after „Auf die SD-Karte …“ the recording is still where you are.
effect(() => {
  const s = session.value;
  recordingInImport.value = !!s.recording && s.phase !== 'pick';
});

/** Picked files live only in the app: closing or reloading asks first, as long as they wait. */
holdWhile(writeGuard, 'selection', () => {
  const { phase, albums, result } = session.value;
  return ((phase === 'review' || phase === 'reading') && albums.length > 0) || (phase === 'done' && !!result?.rest.length);
});

let controller: AbortController | null = null;

/** Files that exist only for this import (downloads from the web), and how to remove them. */
interface Owned {
  sources: Set<ByteSource>;
  release: () => unknown;
}

const owned = new Set<Owned>();

function runRelease(release: () => unknown) {
  void Promise.resolve()
    .then(release)
    .catch(() => undefined);
}

/**
 * Removes downloaded files that no album uses any more: when they were taken
 * out of the selection, and all of them once the import is over (on the card,
 * discarded, or nothing left to add). After a transfer that stopped, what is
 * left to transfer stays until the import is discarded. Never while files
 * are read or written.
 */
function releaseUnused() {
  if (!owned.size) return;
  const { phase, albums, result } = session.value;
  if (phase === 'reading' || phase === 'writing') return;
  const kept = phase === 'review' ? albums : phase === 'done' ? (result?.rest ?? []) : [];
  const used = new Set<ByteSource>(kept.flatMap((a) => a.tracks.map((t) => t.source)));
  for (const o of [...owned]) {
    if ([...o.sources].some((s) => used.has(s))) continue;
    owned.delete(o);
    runRelease(o.release);
  }
}

function update(patch: Partial<ImportSession>) {
  session.value = { ...session.value, ...patch };
  releaseUnused();
}

function revokeCovers(albums: ImportAlbum[]) {
  for (const a of albums) if (a.coverUrl) URL.revokeObjectURL(a.coverUrl);
}

const resetListeners = new Set<() => void>();

/** Calls `listener` whenever the import is discarded or started anew (e.g. to stop a download for it). */
export function onImportReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => resetListeners.delete(listener);
}

export function resetImport(forFolder?: number) {
  generation++;
  controller?.abort();
  controller = null;
  revokeCovers(session.value.albums);
  session.value = { phase: 'pick', albums: [], rejected: [], forFolder };
  releaseUnused();
  for (const listener of [...resetListeners]) listener();
}

/* ------------------------------------------------------------------ reading */

const COVER_FILE = /^(cover|folder|front|album|albumart(small|large)?|bild)\.(jpe?g|png|webp)$/i;
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp'];
/** Files that come with downloads and CDs and are not worth mentioning. */
const QUIET_EXT = ['txt', 'nfo', 'm3u', 'm3u8', 'pls', 'cue', 'log', 'ini', 'db', 'url', 'sfv', 'md5', 'pdf', 'accurip', 'xml', 'json', 'lrc'];

/** Packed albums the app does not unpack (ZIP it does, see unzip.ts). */
const PACKED_EXT = ['rar', '7z'];

function dirOf(s: ByteSource): string {
  const p = s.relativePath ?? '';
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i).toLowerCase();
}

/**
 * The playing time decides whether an MP3 counts as long and gets cut. MP3s
 * joined from several files tell the time of their first part, VBR files
 * without a Xing frame tell none: then the frames are counted.
 */
async function withMp3Duration(source: ByteSource, info: TrackInfo, signal: AbortSignal): Promise<TrackInfo> {
  try {
    const durationSec = await mp3DurationSec(source, info.durationSec, signal);
    return durationSec === info.durationSec ? info : { ...info, durationSec };
  } catch (e) {
    if (signal.aborted) throw e;
    return info; // not readable as MP3 here: it is copied as it is
  }
}

/**
 * Looks at every frame of an MP3, in one read of the file: damaged files and
 * files joined from several files are converted anew (the review says so),
 * and the frames tell the playing time. Files of a publisher that allows no
 * changes go to the card as they are, so they only get their playing time.
 */
async function withMp3Check(source: ByteSource, info: TrackInfo, signal: AbortSignal, unchanged: boolean): Promise<TrackInfo> {
  if (unchanged) return withMp3Duration(source, info, signal);
  try {
    const { check, index } = await checkMp3(source, { signal });
    // A file in two formats has no frame index: its time comes from its header, as before.
    const durationSec = index ? mp3DurationOf(index, info.durationSec) : await withMp3Duration(source, info, signal).then((i) => i.durationSec);
    return { ...info, durationSec, mp3Check: check };
  } catch (e) {
    if (signal.aborted) throw e;
    return info; // not readable as MP3 here: it is copied as it is
  }
}

/** Not one MP3 frame in the file: the check finds no playing time at all. */
function noMp3Audio(info: TrackInfo): boolean {
  return info.mp3Check?.rebuild === 'damaged' && info.mp3Check.durationSec === undefined;
}

/** The sound of each file read, to find the same sound under two names (doubles). */
const prints = new WeakMap<ByteSource, string>();

interface ReadResult {
  inputs: InputFile[];
  images: Map<string, ByteSource>;
  rejected: RejectedEntry[];
}

async function readSources(
  sources: ByteSource[],
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
  hints?: Map<ByteSource, Partial<TrackInfo>>,
  origins?: Map<ByteSource, TrackOrigin>,
  /** False when files of the call were in the selection already: a picture left over from a folder picked again is no news. */
  reportQuiet = true,
): Promise<ReadResult> {
  const audio: ByteSource[] = [];
  const images = new Map<string, ByteSource>();
  /** Cue sheets: a whole CD in one file says where its tracks begin (wholeAlbum.ts). */
  const cueFiles: ByteSource[] = [];
  const rejected: RejectedEntry[] = [];
  /** Pictures and files that come with albums: not worth a word, unless they are all there is. */
  const quiet: RejectedEntry[] = [];
  // ZIP archives: their files instead, as if the unpacked folder had been picked.
  if (sources.some((s) => extensionOf(s.name) === 'zip')) {
    const unpacked: ByteSource[] = [];
    for (const s of sources) {
      if (extensionOf(s.name) !== 'zip') {
        unpacked.push(s);
        continue;
      }
      const { sources: inside, error } = await unzipSource(s, signal);
      if (error) rejected.push({ name: s.relativePath ?? s.name, reason: error });
      unpacked.push(...inside);
    }
    sources = unpacked;
  }
  for (const s of sources) {
    const ext = extensionOf(s.name);
    const hidden = s.name.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(s.name);
    if (AUDIO_EXTENSIONS.includes(ext)) {
      if (s.size > 0) audio.push(s);
      else rejected.push({ name: s.relativePath ?? s.name, reason: 'Die Datei ist leer.' });
    } else if (IMAGE_EXT.includes(ext)) {
      const dir = dirOf(s);
      if (COVER_FILE.test(s.name) || !images.has(dir)) images.set(dir, s);
      quiet.push({ name: s.relativePath ?? s.name, reason: 'Ein Bild, keine Audiodatei.' });
    } else if (PACKED_EXT.includes(ext)) {
      rejected.push({ name: s.relativePath ?? s.name, reason: `${ext.toUpperCase()}-Datei. Ich öffne nur ZIP-Archive. Entpacke sie zuerst (Rechtsklick › Hier entpacken) und nimm dann den Ordner mit den Audiodateien.` });
    } else if (!hidden) {
      if (ext === 'cue') cueFiles.push(s);
      (QUIET_EXT.includes(ext) ? quiet : rejected).push({ name: s.relativePath ?? s.name, reason: 'Keine Audiodatei.' });
    }
  }
  // A PDF or a photo alone: say why nothing happens, instead of nothing.
  if (!audio.length && !rejected.length && reportQuiet) rejected.push(...quiet);
  let done = 0;
  onProgress(0, audio.length);
  const inputs = await mapLimit(audio, 4, async (source): Promise<InputFile> => {
    if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    const hint = hints?.get(source);
    const origin = origins?.get(source);
    const file = (f: InputFile): InputFile => (origin ? { ...f, origin } : f);
    const print = await soundFingerprint(source);
    if (print) prints.set(source, print);
    try {
      let info: TrackInfo;
      try {
        info = applyHints(await readTrackInfo(source, { cover: false, signal }), hint) ?? {};
      } catch {
        // MP3 files with broken tags usually still play: keep them. Without any MP3 audio in them there is nothing to keep.
        if (extensionOf(source.name) === 'mp3') {
          const checked = await withMp3Check(source, applyHints(undefined, hint) ?? {}, signal, origin?.entry.editPolicy === 'unchanged');
          if (!noMp3Audio(checked)) return file({ source, info: checked });
        }
        return file({ source, error: UNREADABLE });
      }
      if (isPlayableAsIs({ source, info, title: source.name })) {
        info = await withMp3Check(source, info, signal, origin?.entry.editPolicy === 'unchanged');
        // Tags that read fine on a file without a single MP3 frame: nothing in it would play.
        if (noMp3Audio(info)) return file({ source, error: UNREADABLE });
      } else {
        if (origin?.entry.editPolicy === 'unchanged') return file({ source, info, error: UNCHANGED_NOT_MP3 });
        // Files to convert: find out now whether this computer can, not halfway through the transfer.
        try {
          const probe = await plat().audio.check?.(source, signal);
          // Tags read quickly often lack the playing time of Ogg and FLAC files, and tell only the
          // first stream of a chained Ogg file (`cat a.ogg b.ogg`); the decoder knows all of it.
          if (probe?.durationSec) info = { ...info, durationSec: probe.durationSec };
          if (!info.channels && probe?.channels) info = { ...info, channels: probe.channels };
        } catch (e) {
          if (signal.aborted) throw e;
          return file({ source, info, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return file({ source, info });
    } finally {
      onProgress(++done, audio.length);
    }
  });
  for (const f of inputs) if (f.error) rejected.push({ name: f.source.relativePath ?? f.source.name, reason: f.error });
  if (cueFiles.length) {
    const sheets = (await Promise.all(cueFiles.map(async (source) => ({ source, sheet: await readCue(source) })))).flatMap((c) => (c.sheet ? [{ source: c.source, sheet: c.sheet }] : []));
    matchCues(sheets, inputs.filter((f) => !f.error).map((f) => ({ source: f.source, durationSec: f.info?.durationSec })), dirOf);
  }
  return { inputs, images, rejected };
}

/**
 * The album's picture: a cover file in its folder (cover.jpg, folder.jpg …),
 * else the picture in its files, else another picture in its folder. That
 * last one only when no other album came from the same folder: one photo
 * among loose files is no cover for all of them.
 */
async function findCover(album: AlbumDraft, images: Map<string, ByteSource>, albumsIn: Map<string, number>): Promise<{ data: Uint8Array; mimeType: string } | undefined> {
  if (album.cover) return album.cover;
  const dir = dirOf(album.tracks[0].source);
  const img = images.get(dir);
  const alone = (albumsIn.get(dir) ?? 0) <= 1;
  // Loose files have no folder of their own: there a cover file counts only for one album, too.
  if (img && COVER_FILE.test(img.name) && (dir || alone)) return readImage(img);
  for (const t of album.tracks.slice(0, 3)) {
    try {
      const info = await readTrackInfo(t.source, { cover: true });
      if (info.picture) return info.picture;
    } catch {
      // Next track.
    }
  }
  return img && alone ? readImage(img) : undefined;
}

async function readImage(img: ByteSource): Promise<{ data: Uint8Array; mimeType: string }> {
  const ext = extensionOf(img.name);
  return { data: await img.read(0, img.size), mimeType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
}

/** How many albums came from each folder, for findCover. */
function albumsPerFolder(drafts: AlbumDraft[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of drafts) {
    const dir = dirOf(d.tracks[0].source);
    out.set(dir, (out.get(dir) ?? 0) + 1);
  }
  return out;
}

function withCoverUrl(a: ImportAlbum): ImportAlbum {
  if (!a.cover) return a;
  return { ...a, coverUrl: URL.createObjectURL(new Blob([a.cover.data as BlobPart], { type: a.cover.mimeType })) };
}

/**
 * Folders whose files partly wait in the helper folder of the app, after a
 * change that was interrupted (see planRecoverTemp). Nothing may go into
 * them before the files are back: the new titles would take their numbers.
 */
export function waitingFolders(scan: SdScan): Set<number> {
  // A scan made before helper folders were known has no list of them.
  return new Set((scan.tempDirs ?? []).flatMap(helperFolders));
}

/**
 * Why nothing goes into such a folder, and what to do. On the album card the
 * button for it sits right below the text; after a transfer it is on "Meine Box".
 */
function helperWaiting(folder: number, button: 'below' | 'box'): string {
  const where = button === 'below' ? 'Tippe unten auf' : 'Tippe unter „Meine Box“ auf';
  return `In Ordner ${folderName(folder)} wurde eine frühere Änderung unterbrochen. Ein Teil seiner Titel wartet noch im Hilfsordner der App. Lege sie zuerst zurück: ${where} „Ansehen und reparieren“ und dann auf „Dateien zurücklegen“. Danach kannst du das Album hinzufügen.`;
}

/** Folder numbers for new albums: the first free ones, in the order of the list. */
function assignTargets(albums: ImportAlbum[], scan: SdScan): ImportAlbum[] {
  // A number whose files wait in the helper folder is not free.
  const reserved = waitingFolders(scan);
  for (const a of albums) if (a.target) reserved.add(a.target);
  return albums.map((a) => {
    if (a.target) return a;
    const n = nextFolderNumber(scan, reserved) ?? 0;
    if (n) reserved.add(n);
    return { ...a, target: n };
  });
}

/**
 * Albums of files from "Entdecken": the kind follows the list (a story,
 * a song), and a publisher that allows no changes gets its files unchanged.
 */
export function withOrigins(a: ImportAlbum): ImportAlbum {
  const facts = albumFromSources(a.tracks);
  if (!facts) return a;
  const out: ImportAlbum = { ...a };
  if (!a.append && facts.kind) out.kind = facts.kind;
  if (facts.unchanged) {
    out.unchanged = true;
    out.split = 'none';
  }
  return out;
}

/** Files that do not come from the user's disk (downloads from a web page or from "Entdecken"). */
export interface AddOptions {
  /** Facts per file that win over its tags: titles, album, order. */
  hints?: Map<ByteSource, Partial<TrackInfo>>;
  /** Source and licence per file (files from "Entdecken"). */
  origins?: Map<ByteSource, TrackOrigin>;
  /** Entries that could not be loaded, listed with the files that are not transferred. */
  rejected?: RejectedEntry[];
  /** Removes the files once no album uses them any more. */
  release?: () => unknown;
}

export interface AddResult {
  /** Audio files that can be used. */
  accepted: number;
  /** The files of this call that cannot be used, and why. */
  rejected: RejectedEntry[];
  /** Stopped before the files were added (cancelled, or files added again meanwhile). */
  cancelled?: boolean;
  /** Files of this call left out because they were in the selection already. */
  doubled?: number;
}

/** Calls of addSources run one after the other, so one reading never cuts off another. */
let queue: Promise<unknown> = Promise.resolve();
/** Calls that have not finished yet. */
let pending = 0;
/** Counts discarded imports: files waiting for one do not end up in the next. */
let generation = 0;

/**
 * Reads the dropped, picked or downloaded files and groups them into albums,
 * after the files of earlier calls (right away when none runs). Changes made
 * to the albums while the files are read are kept.
 */
export function addSources(sources: ByteSource[], opts: AddOptions = {}): Promise<AddResult> {
  const gen = generation;
  const go = async () => {
    try {
      return await readAndGroup(sources, opts, gen);
    } finally {
      pending--;
    }
  };
  const run = pending++ ? queue.then(go) : go();
  queue = run.catch(() => undefined);
  return run;
}

async function readAndGroup(sources: ByteSource[], opts: AddOptions, gen: number): Promise<AddResult> {
  const s = card.value;
  // Discarded meanwhile, no card, or the transfer has started: nothing is added.
  const phase = session.value.phase;
  if (gen !== generation || !s?.scan || !sources.length || phase === 'writing' || phase === 'done') {
    if (opts.release) runRelease(opts.release);
    return { accepted: 0, rejected: [], cancelled: true };
  }
  if (opts.release) owned.add({ sources: new Set(sources), release: opts.release });
  // The same file picked or dropped again: it is in the selection already.
  const chosen = new Set(session.value.albums.flatMap((a) => a.tracks.map((t) => sameFileKey(t.source))));
  const fresh = sources.filter((src) => !chosen.has(sameFileKey(src)));
  const doubled = sources.length - fresh.length;
  if (!fresh.length) {
    releaseUnused();
    return { accepted: 0, rejected: [], doubled };
  }
  sources = fresh;
  const forFolder = session.value.forFolder;
  const ctrl = new AbortController();
  controller = ctrl;
  update({ phase: 'reading', reading: { done: 0, total: sources.length } });
  try {
    const read = await readSources(sources, ctrl.signal, (done, total) => update({ reading: { done, total } }), opts.hints, opts.origins, doubled === 0);
    if (ctrl.signal.aborted) return { accepted: 0, rejected: [], cancelled: true };
    read.rejected.push(...(opts.rejected ?? []));
    let drafts = groupIntoAlbums(read.inputs, { splitMinutes: settings.value.splitMinutes });
    const entry = forFolder ? s.catalog?.folders[folderName(forFolder)] : undefined;
    const albumsIn = albumsPerFolder(drafts);
    const covers = forFolder
      ? [drafts[0] && !entry?.cover && !session.value.albums[0]?.cover && !session.value.albums[0]?.noCover ? await findCover(drafts[0], read.images, albumsIn).catch(() => undefined) : undefined]
      : await mapLimit(drafts, 2, (d) => findCover(d, read.images, albumsIn).catch(() => undefined));
    if (ctrl.signal.aborted) return { accepted: 0, rejected: [], cancelled: true };
    // The session as it is now: changes made while reading stay.
    const now = session.value;
    let albums: ImportAlbum[];
    if (forFolder) {
      // Everything goes into one folder: keep the order of the albums, one after the other.
      const existing = now.albums[0];
      const tracks: DraftTrack[] = [...(existing?.tracks ?? []), ...drafts.flatMap((d) => d.tracks)];
      const cover = existing?.cover ?? (existing?.noCover ? undefined : covers[0]);
      const album: ImportAlbum = {
        id: existing?.id ?? drafts[0]?.id ?? 'append',
        title: entry?.title ?? `Ordner ${folderName(forFolder)}`,
        artist: entry?.artist,
        kind: entry?.kind ?? drafts[0]?.kind ?? 'hoerspiel',
        tracks,
        durationSec: tracks.every((t) => t.info?.durationSec !== undefined) ? tracks.reduce((sum, t) => sum + (t.info?.durationSec ?? 0), 0) : undefined,
        split: appendSplit(tracks, existing, drafts),
        splitMinutes: existing?.splitMinutes ?? settings.value.splitMinutes,
        target: forFolder,
        append: true,
        // Going on with a transfer that stopped: that stays so.
        resume: existing?.resume,
        coverFrom: existing?.coverFrom,
        noCover: existing?.noCover,
      };
      if (existing?.coverUrl) URL.revokeObjectURL(existing.coverUrl);
      // No album without files: when none of them can go there, the reasons are what there is to see.
      albums = tracks.length ? [withCoverUrl(withOrigins({ ...album, cover, unchanged: existing?.unchanged }))] : [];
      drafts = [];
    } else {
      albums = drafts.map((d, i) => withCoverUrl(withOrigins({ ...d, cover: covers[i], target: 0, append: false })));
      albums = assignTargets([...now.albums, ...albums], s.scan);
    }
    const seen = new Set(now.rejected.map((r) => r.name));
    const rejected = [...now.rejected, ...read.rejected.filter((r) => !seen.has(r.name))];
    // Files that cannot go to the card are shown with the reason, also when none is left.
    update({ phase: afterReading({ albums, rejected }), reading: undefined, albums, rejected });
    return { accepted: read.inputs.filter((f) => !f.error).length, rejected: read.rejected, ...(doubled ? { doubled } : {}) };
  } catch (e) {
    if (ctrl.signal.aborted) return { accepted: 0, rejected: [], cancelled: true };
    update({ phase: afterReading(session.value), reading: undefined });
    throw e;
  }
}

/**
 * A file counts as picked already when it is the same file on disk (desktop),
 * or has the same name, size and time of change. Not by the path inside a
 * picked folder: the same file picked alone has none.
 */
function sameFileKey(s: ByteSource): string {
  if (s.path) return `p|${s.path}`;
  const mod = typeof File !== 'undefined' && s.blob instanceof File ? s.blob.lastModified : '';
  return `${s.name.toLowerCase()}|${s.size}|${mod}`;
}

/** The review shows the albums, or why none of the files can go to the card; with neither, back to the start. */
function afterReading(s: Pick<ImportSession, 'albums' | 'rejected'>): Phase {
  return s.albums.length || s.rejected.length ? 'review' : 'pick';
}

/**
 * How to cut when files are added to a folder: what was chosen for the long
 * files picked before, else what a new album would get. "Nicht teilen" after
 * a pick without long files was no choice, and chapters only work when every
 * long file has them.
 */
function appendSplit(tracks: DraftTrack[], existing: ImportAlbum | undefined, drafts: AlbumDraft[]): SplitMode {
  const long = tracks.filter(isLongTrack);
  if (!tracks.some(isCuttable)) return 'none';
  const split = (existing?.tracks.some(isCuttable) ? existing.split : undefined) ?? drafts.find((d) => d.split !== 'none')?.split ?? 'pauses';
  return split === 'chapters' && !long.every((t) => (t.info?.chapters?.length ?? 0) > 1) ? 'pauses' : split;
}

/**
 * How an album with other files cuts: as before while it has something to
 * cut. Without the whole album that "An den Albumtiteln" was about, long
 * files go back to the pauses.
 */
function splitAfter(tracks: DraftTrack[], split: SplitMode): SplitMode {
  if (!tracks.some(isCuttable)) return 'none';
  if (split === 'tracks' && !tracks.some(hasAlbumCuts)) return 'pauses';
  return split;
}

export function cancelReading() {
  controller?.abort();
  update({ phase: afterReading(session.value), reading: undefined });
}

/* ------------------------------------------------------------------ editing */

/** The phase after the albums were changed: reading goes on (more files come). */
function phaseAfterEdit(albums: ImportAlbum[]): Phase {
  if (session.value.phase === 'reading') return 'reading';
  return albums.length ? 'review' : 'pick';
}

/** The import holds a recording (recordingImport.ts): the review speaks of it, not of an album. */
export function markRecording() {
  update({ recording: true });
}

export function updateAlbum(id: string, patch: Partial<ImportAlbum>) {
  update({ albums: session.value.albums.map((a) => (a.id === id ? { ...a, ...patch } : a)), edited: true });
}

export function removeAlbum(id: string) {
  const s = session.value;
  const gone = s.albums.find((a) => a.id === id);
  if (gone?.coverUrl) URL.revokeObjectURL(gone.coverUrl);
  const albums = s.albums.filter((a) => a.id !== id);
  update({ albums, phase: phaseAfterEdit(albums), edited: true });
}

/** The album with other files: its playing time and cutting follow them. */
function withTracks(a: ImportAlbum, tracks: DraftTrack[]): ImportAlbum {
  const durations = tracks.map((t) => t.info?.durationSec);
  const durationSec = durations.every((d) => d !== undefined) ? (durations as number[]).reduce((x, y) => x + y, 0) : undefined;
  return { ...a, tracks, durationSec, split: splitAfter(tracks, a.split) };
}

export function updateTracks(id: string, mutate: (tracks: DraftTrack[]) => DraftTrack[]) {
  const s = session.value;
  const albums = s.albums
    .map((a) => {
      if (a.id !== id) return a;
      return { ...withTracks(a, mutate([...a.tracks])), planned: undefined };
    })
    .filter((a) => a.tracks.length);
  update({ albums, phase: phaseAfterEdit(albums), edited: true });
}

/** A picture chosen in the review (`from`: where from), or none at all. */
export function setCoverFor(id: string, cover: { data: Uint8Array; mimeType: string } | undefined, from?: ImportAlbum['coverFrom']) {
  const a = session.value.albums.find((x) => x.id === id);
  if (!a) return;
  if (a.coverUrl) URL.revokeObjectURL(a.coverUrl);
  updateAlbum(id, withCoverUrl({ ...a, cover, coverUrl: undefined, coverFrom: cover ? from : undefined, noCover: !cover }));
}

/* ------------------------------------------------------------------ checks */

export interface Problem {
  album?: string;
  text: string;
  /** Files of the folder wait in the helper folder: the health check puts them back. */
  helper?: boolean;
  /** About single titles of the album: leaving the whole album out is not the answer. */
  inside?: boolean;
}

/** Everything that would stop the import, in plain words. */
export function problems(sess: ImportSession, scan: SdScan): Problem[] {
  const out: Problem[] = [];
  const used = new Map<number, string>();
  /** Tracks the albums so far put into each folder. */
  const planned = new Map<number, number>();
  const waiting = waitingFolders(scan);
  for (const a of sess.albums) {
    if (!a.target) {
      out.push({ album: a.id, text: `Für „${a.title}“ ist kein Ordner mehr frei. Eine Box kann höchstens 99 Ordner abspielen.` });
      continue;
    }
    // Several albums may go onto the end of one folder; only two new folders under one number clash.
    if (!a.append) {
      const other = used.get(a.target);
      if (other) out.push({ album: a.id, text: `„${a.title}“ und „${other}“ wollen beide in Ordner ${folderName(a.target)}.` });
      used.set(a.target, a.title);
    }
    if (waiting.has(a.target)) out.push({ album: a.id, text: helperWaiting(a.target, 'below'), helper: true });
    const existing = scan.folders.find((f) => f.number === a.target);
    if (existing && !a.append) out.push({ album: a.id, text: `Ordner ${folderName(a.target)} gibt es schon. Wähle einen anderen Ordner.` });
    const base = a.append && existing ? Math.max(0, ...existing.tracks.map((t) => t.number)) : 0;
    if (a.resume && base !== a.resume.last) out.push({ album: a.id, text: changedSinceStop(a.target) });
    // What albums before this one put into the same folder counts too.
    const have = base + (planned.get(a.target) ?? 0);
    const { count, exact } = trackCountOf(a);
    planned.set(a.target, (planned.get(a.target) ?? 0) + count);
    if (have + count > MAX_TRACKS) out.push({ album: a.id, text: tooManyTitles(a, have + count, exact) });
  }
  return out;
}

/**
 * Where the albums' titles land in their folders, in the order they are
 * written: an album onto a folder starts after the tracks there and after
 * the albums before it in the list. `exact` is false while the number of
 * titles is an estimate (files still to be cut). For the extra "Mehr als 99
 * Hörspiele", which names each album's tracks before the transfer.
 */
export function plannedRanges(sess: Pick<ImportSession, 'albums'>, scan: SdScan): Map<string, { first: number; last: number; exact: boolean }> {
  const out = new Map<string, { first: number; last: number; exact: boolean }>();
  const next = new Map<number, number>();
  for (const a of sess.albums) {
    if (!a.target) continue;
    const existing = scan.folders.find((f) => f.number === a.target);
    const base = a.append && existing ? Math.max(0, ...existing.tracks.map((t) => t.number)) : 0;
    const first = next.get(a.target) ?? base + 1;
    const { count, exact } = trackCountOf(a);
    out.set(a.id, { first, last: first + count - 1, exact });
    next.set(a.target, first + count);
  }
  return out;
}

/**
 * Extra "Mehr als 99 Hörspiele": every album that would make a folder of its
 * own goes onto the end of `folder` instead, one after the other in the order
 * of the list. The tracks in the folder keep their numbers. A folder not on
 * the card yet is made by the first of them. Albums going onto other folders
 * stay where they go.
 */
export function gatherInto(folder: number) {
  const scan = card.value?.scan;
  if (!scan || !folder) return;
  const exists = scan.folders.some((f) => f.number === folder);
  let first = !exists;
  const albums = session.value.albums.map((a) => {
    if (a.append && a.target !== folder) return a;
    // A transfer that stopped goes on where it was.
    if (a.resume) return a;
    const append = !first;
    first = false;
    return { ...a, target: folder, append };
  });
  update({ albums, edited: true });
}

/** Undoes gatherInto: the albums going onto `folder` get folders of their own again (but a transfer that stopped). */
export function spreadOut(folder: number) {
  const scan = card.value?.scan;
  if (!scan) return;
  const albums = session.value.albums.map((a) => (a.target === folder && !a.resume ? { ...a, target: 0, append: false } : a));
  update({ albums: assignTargets(albums, scan), edited: true });
}

/**
 * What the add page offers when a series comes in several albums, or when
 * no folder is free any more (Frank 16.10.2026, "Reihe in einen Ordner
 * packen"): to put the albums as episodes into one folder (a folder of the
 * series on the card, when there is one with room), or, with nothing to put
 * them into, to pack a series on the card first.
 */
export type PackOffer =
  | { kind: 'gather'; series: string; albums: string[]; target: number; existing: boolean }
  | { kind: 'packed'; series: string; albums: string[]; target: number }
  | { kind: 'pack'; albums: number };

export function packOffer(sess: Pick<ImportSession, 'albums' | 'forFolder' | 'packed'>, scan: SdScan, catalog: Pick<Catalog, 'folders'> | null | undefined): PackOffer | null {
  if (sess.forFolder) return null;
  const done = sess.packed?.find((p) => sess.albums.some((a) => a.target === p.folder));
  if (done) return { kind: 'packed', series: done.title, albums: sess.albums.filter((a) => a.target === done.folder).map((a) => a.id), target: done.folder };
  const loose = sess.albums.filter((a) => !a.append && !a.resume);
  const groups = new Map<string, { name: string; albums: ImportAlbum[] }>();
  for (const a of loose) {
    const name = seriesOfTitle(a.title);
    if (!name) continue;
    const g = groups.get(seriesKey(name)) ?? { name, albums: [] };
    g.albums.push(a);
    groups.set(seriesKey(name), g);
  }
  /** A folder of the series on the card with room for `count` more tracks: named like it, or noting it. */
  const home = (key: string, count: number) =>
    scan.folders.find((f) => {
      const e = catalog?.folders[f.name];
      if (!e || (seriesKey(e.title) !== key && seriesKey(e.series ?? '') !== key)) return false;
      return Math.max(0, ...f.tracks.map((t) => t.number)) + count <= MAX_TRACKS;
    });
  const fits = (g: { albums: ImportAlbum[] }) => g.albums.reduce((n, a) => n + trackCountOf(a).count, 0);
  const homeless = loose.filter((a) => !a.target);
  const best = [...groups.entries()]
    .map(([key, g]) => ({ key, ...g, home: home(key, fits(g)) }))
    .filter((g) => (g.albums.length >= 2 && (g.home || fits(g) <= MAX_TRACKS)) || (g.home && g.albums.some((a) => !a.target)))
    .sort((a, b) => b.albums.length - a.albums.length)[0];
  if (best) {
    const target = best.home?.number ?? best.albums.find((a) => a.target)?.target ?? 0;
    if (target) return { kind: 'gather', series: best.name, albums: best.albums.map((a) => a.id), target, existing: !!best.home };
  }
  return homeless.length ? { kind: 'pack', albums: homeless.length } : null;
}

/** Takes the offer: the albums go into `target` as episodes, the first makes the folder when it is new. */
export function packAlbums(offer: Extract<PackOffer, { kind: 'gather' }>) {
  const scan = card.value?.scan;
  if (!scan) return;
  let first = !scan.folders.some((f) => f.number === offer.target);
  const ids = new Set(offer.albums);
  const albums = session.value.albums.map((a) => {
    if (!ids.has(a.id)) return a;
    const append = !first;
    first = false;
    return { ...a, target: offer.target, append };
  });
  update({ albums: assignTargets(albums, scan), packed: [...(session.value.packed ?? []).filter((p) => p.folder !== offer.target), { folder: offer.target, title: offer.series }], edited: true });
}

/** Undoes packAlbums: every album gets a folder of its own again. */
export function unpackAlbums(folder: number) {
  update({ packed: session.value.packed?.filter((p) => p.folder !== folder) });
  spreadOut(folder);
}

/** After folders on the card were packed: albums without a folder get one of the numbers that became free. */
export function refillTargets() {
  const scan = card.value?.scan;
  if (scan) update({ albums: assignTargets(session.value.albums, scan) });
}

/** Title and artist without case, spaces and punctuation: "Bibi & Tina 1" and "bibi tina 1" are the same. */
function albumKey(title: string, artist: string | undefined): string {
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return `${norm(title)}|${norm(artist ?? '')}`;
}

/**
 * Albums that look like one picked twice, or like one on the card already.
 * Only a hint: two albums may have the same name and still differ.
 */
export function doubles(sess: ImportSession, catalog: Catalog | undefined, notOnCard: ReadonlySet<number> = new Set()): Problem[] {
  const out: Problem[] = [];
  const onCard = new Map<string, string>();
  for (const [name, f] of Object.entries(catalog?.folders ?? {})) onCard.set(albumKey(f.title, f.artist), name);
  const seen = new Set<string>();
  for (const a of sess.albums) {
    for (const same of sameSoundGroups(a.tracks, (t) => prints.get(t.source))) {
      const names = same.map((t) => `„${t.title}“`);
      out.push({
        album: a.id,
        inside: true,
        text: `In „${a.title}“ ist ${names.length === 2 ? 'zweimal' : `${names.length}-mal`} derselbe Ton unter anderem Namen: ${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}. Vermutlich ist der Download fehlerhaft. Lade das Album neu herunter oder nimm die doppelten Titel heraus.`,
      });
    }
    for (const gap of numberGaps(a.tracks)) {
      const where = gap.disc ? ` auf CD ${gap.disc}` : '';
      const which = gap.missing.length === 1 ? `fehlt Titel ${gap.missing[0]}` : `fehlen die Titel ${listing(gap.missing.map(String))}`;
      out.push({ album: a.id, inside: true, text: `In „${a.title}“${where} ${which}. Vielleicht ist der Download unvollständig. Fehlt nichts mit Absicht, lade das Album neu herunter.` });
    }
    const short = tooShort(a.tracks);
    if (short.length) {
      const names = listing(short.map((t) => `„${t.title}“`));
      out.push({
        album: a.id,
        inside: true,
        text: `In „${a.title}“ ${short.length === 1 ? 'ist' : 'sind'} ${names} kürzer als ${SHORT_SEC} Sekunden. Vermutlich ${short.length === 1 ? 'ist die Datei' : 'sind die Dateien'} kaputt. Höre kurz rein und nimm sie heraus, wenn nichts zu hören ist.`,
      });
    }
    if (a.append || !a.title.trim()) continue;
    const key = albumKey(a.title, a.artist);
    if (seen.has(key)) out.push({ album: a.id, text: `„${a.title}“ ist zweimal ausgewählt. Ist es dasselbe Album, nimm eins heraus.` });
    else if (onCard.has(key)) {
      const name = onCard.get(key)!;
      // A folder that comes with the next Paket is not on the card yet.
      out.push({
        album: a.id,
        text: notOnCard.has(Number(name))
          ? `„${a.title}“ wartet schon als Ordner ${name} im Paket. Ist es dasselbe Album, lasse es hier weg.`
          : `„${a.title}“ ist schon in Ordner ${name} auf der Karte. Ist es dasselbe Album, nimm es hier heraus.`,
      });
    }
    seen.add(key);
  }
  return out;
}

/**
 * Titles the album still puts on the card: known after an import stopped at
 * the limit with these settings, else estimated. Parts of a cut file that are
 * on the card already do not count.
 */
export function trackCountOf(a: ImportAlbum): { count: number; exact: boolean } {
  if (a.planned && a.planned.split === a.split && a.planned.splitMinutes === a.splitMinutes) return { count: a.planned.tracks, exact: true };
  if (!a.resume) return { count: estimateTrackCount(a), exact: !a.tracks.some((t) => isSplit(a, t) && !cutAtTracks(a, t)) };
  let count = 0;
  let exact = true;
  for (const t of a.tracks) {
    const p = a.resume.parts.get(t.source);
    if (p) {
      count += p.of - p.done;
    } else {
      count += estimateTrackCount({ ...a, tracks: [t] });
      if (isSplit(a, t) && !cutAtTracks(a, t)) exact = false;
    }
  }
  return { count, exact };
}

/** An album that does not fit on the card any more, with what to do. */
function noSpace(need: number, free: number, boosted: boolean): string {
  const why = boosted ? ' Ich mache die leisen MP3-Dateien lauter und wandle sie dafür um. Dadurch werden sie größer.' : '';
  return `Auf der Karte ist nicht genug Platz. Das Album braucht etwa ${formatBytes(need)}, frei sind noch ${formatBytes(Math.max(0, free))}.${why} Lösche auf der Karte etwas, das du nicht mehr brauchst. Dann übertrage den Rest.`;
}

/** The limit of 255 titles per folder, with what to do. */
function tooManyTitles(a: Pick<ImportAlbum, 'target' | 'split'>, count: number, exact: boolean): string {
  const todo = a.split === 'pauses' ? 'Wähle längere Titel beim Teilen.' : a.split === 'chapters' ? 'Teile an Sprechpausen und wähle lange Titel.' : 'Nimm ein paar Dateien heraus.';
  return `In Ordner ${folderName(a.target)} passen nur ${MAX_TRACKS} Titel. Es wären ${exact ? '' : 'etwa '}${count}. ${todo}`;
}

export function totalBytes(sess: ImportSession): number {
  return sess.albums.reduce((sum, a) => sum + albumBytesOf(a, settings.value.bitrateKbps), 0);
}

/** Rough size of what the album still puts on the card. */
export function albumBytesOf(a: ImportAlbum, bitrateKbps: number): number {
  if (!a.resume) return estimateAlbumBytes(a, bitrateKbps, settings.value.monoSpeech);
  return a.tracks.reduce((sum, t) => {
    const bytes = estimateAlbumBytes({ ...a, tracks: [t] }, bitrateKbps, settings.value.monoSpeech);
    const p = a.resume?.parts.get(t.source);
    return sum + (p ? Math.round((bytes * (p.of - p.done)) / p.of) : bytes);
  }, 0);
}

/* ------------------------------------------------------------------ writing */

function isAbort(e: unknown): boolean {
  return (e instanceof DOMException && e.name === 'AbortError') || (e instanceof Error && e.name === 'AbortError');
}

/** Stops one album, not the whole import: it cannot go to the card as it is. */
class AlbumError extends Error {
  constructor(
    message: string,
    /** Titles it would give, when they are too many. */
    readonly tracks?: number,
  ) {
    super(message);
  }
}

/**
 * The name an album goes by while it is reviewed, written and reported: onto
 * a folder already there it is that folder's name, not the one from the new
 * files. A folder without a catalog entry is "Ordner NN", in the entry it
 * gets as well (see defaultEntry).
 */
export function shownTitle(a: Pick<ImportAlbum, 'append' | 'target' | 'title'>): string {
  const own = `Ordner ${folderName(a.target)}`;
  if (a.append) return card.value?.catalog?.folders[folderName(a.target)]?.title ?? own;
  return a.title.trim() || own;
}

function defaultEntry(a: ImportAlbum, now: number): CatalogFolder {
  const entry: CatalogFolder = { title: a.append ? `Ordner ${folderName(a.target)}` : a.title.trim() || `Ordner ${folderName(a.target)}`, artist: a.artist?.trim() || undefined, kind: a.kind, tracks: [], addedAt: now, updatedAt: now };
  const series = seriesFor(a);
  if (series) entry.series = series;
  return entry;
}

/** The rest would not join what is on the card: never write it then. */
function changedSinceStop(folder: number): string {
  return `In Ordner ${folderName(folder)} hat sich seit dem Abbruch etwas geändert, oder es steckt eine andere SD-Karte im Computer. Stecke die Karte von vorhin ein oder wähle „Alles verwerfen“.`;
}

/** A cut file goes on where it stopped only when it is cut into the same parts as before. Files left out are not checked. */
function checkResume(a: ImportAlbum, jobs: TrackJob[], skipped: Set<DraftTrack>) {
  for (const t of a.tracks) {
    const p = a.resume?.parts.get(t.source);
    if (!p || skipped.has(t)) continue;
    const left = jobs.filter((j) => j.source === t.source);
    if (left.length !== p.of - p.done || left.some((j) => j.parts !== p.of)) {
      throw new Error(`„${t.title}“ lässt sich nicht mehr genauso teilen wie vorhin. Lösche die Teile in Ordner ${folderName(a.target)} und füge die Datei noch einmal hinzu.`);
    }
  }
}

/**
 * What of an album did not reach the card, after `arrived` of its jobs got
 * there as the files `written` (the last one numbered `last`): the files not
 * written yet, and for a cut file the parts it still needs. Files that could
 * not be read stay out. `resume` is where the album went on from, without the
 * parts that went again in this run. When something arrived, the album then
 * adds to its folder and keeps its loudness change.
 */
function restOf(
  a: ImportAlbum,
  prepared: PreparedAlbum | undefined,
  arrived: TrackJob[],
  written: CatalogTrack[],
  skipped: Set<DraftTrack>,
  resume: ResumeInfo | undefined,
  last: number,
): ImportAlbum | undefined {
  const missing = a.tracks.filter((t) => !skipped.has(t));
  if (!prepared || !arrived.length) return missing.length ? { ...withTracks(a, missing), resume } : undefined;
  const { jobs, gain } = prepared;
  // The last part on the card of every file that got there, and the names of its parts from this run.
  const reached = new Map<ByteSource, TrackJob>();
  const files = new Map<ByteSource, string[]>();
  arrived.forEach((j, k) => {
    reached.set(j.source, j);
    files.set(j.source, [...(files.get(j.source) ?? []), written[k].file]);
  });
  const parts = new Map(resume?.parts);
  const tracks = missing.filter((t) => {
    const job = reached.get(t.source);
    if (!job) return true;
    if (job.part + 1 >= job.parts) {
      parts.delete(t.source);
      return false;
    }
    parts.set(t.source, { done: job.part + 1, of: job.parts, files: [...(parts.get(t.source)?.files ?? []), ...(files.get(t.source) ?? [])] });
    return true;
  });
  if (!tracks.length) return undefined;
  const durations = tracks.map((t) => {
    const p = parts.get(t.source);
    if (!p) return t.info?.durationSec;
    return jobs.filter((j) => j.source === t.source && j.part >= p.done).reduce((sum, j) => sum + (j.durationSec ?? 0), 0);
  });
  return {
    ...a,
    tracks,
    append: true,
    planned: undefined,
    durationSec: durations.every((d) => d !== undefined) ? (durations as number[]).reduce((x, y) => x + y, 0) : undefined,
    split: splitAfter(tracks, a.split),
    resume: { parts, gain, last },
  };
}

/**
 * Writes all albums to the card, one file after the other in ascending
 * order. Closing the app meanwhile asks first, also from another page:
 * it would leave only part of an album on the card.
 */
export async function runImport(): Promise<void> {
  if (!card.value?.scan || session.value.phase !== 'review') return;
  await writeGuard.during('tracks', writeAlbums);
}

async function writeAlbums(): Promise<void> {
  const s = card.value;
  if (!s?.scan || session.value.phase !== 'review') return;
  const albums = [...session.value.albums].sort((a, b) => a.target - b.target);
  // Titles added from a folder's page are no episode of their own.
  const forFolder = session.value.forFolder;
  const ctrl = new AbortController();
  controller = ctrl;
  const opts = settings.value;
  const bytesTotal = albums.reduce((sum, a) => sum + albumBytesOf(a, opts.bitrateKbps), 0);
  let bytesDone = 0;
  const done: number[] = [];
  const result: ImportResult = { folders: done, refused: [], skipped: [], rest: [], reordered: [], notes: [...(session.value.notes ?? [])], junk: [] };
  const state = (patch: Partial<WriteState>) => {
    const prev = session.value.write;
    update({ write: { ...(prev as WriteState), ...patch } });
  };
  update({
    phase: 'writing',
    write: { album: 0, albums: albums.length, track: 0, tracks: 0, folder: albums[0]?.target ?? 0, title: albums[0] ? shownTitle(albums[0]) : '', step: 'prepare', bytesDone: 0, bytesTotal },
  });

  for (let ai = 0; ai < albums.length; ai++) {
    const a = albums[ai];
    const name = folderName(a.target);
    const bar = albumProgress(bytesDone, albumBytesOf(a, opts.bitrateKbps), prepareShare(a, opts.normalizeLoudness));
    state({ album: ai, folder: a.target, title: shownTitle(a), track: 0, tracks: a.tracks.length, step: 'prepare', detail: undefined, fraction: undefined, bytesDone });
    let prepared: PreparedAlbum | undefined;
    const written: CatalogTrack[] = [];
    /** The jobs behind `written`, one each. */
    const arrived: TrackJob[] = [];
    /** Files of the album left out because they could not be read or converted. */
    const skipped = new Set<DraftTrack>();
    /** Written files from "Entdecken", for the credits in the catalog. */
    const credits: WrittenTrack[] = [];
    let dir: Dir | undefined;
    /** The folder is new: it goes again when nothing got into it. */
    let created = false;
    /** Number of the next file in the folder. */
    let next = 1;
    /** The file being written, and where its titles start in `written`. */
    let active: DraftTrack | undefined;
    let activeStart = 0;
    /** Where the album goes on from: parts of a cut file that a run before put on the card. */
    const resume: ResumeInfo | undefined = a.resume && { ...a.resume, parts: new Map(a.resume.parts) };
    /** Extra "Mehr als 99 Hörspiele": the album is an episode of its folder, noted on each of its tracks. */
    const pack = session.value.packed?.find((p) => p.folder === a.target);
    const episode = (opts.episodePlanner || pack) && !forFolder ? a.title.trim().replace(/\s+/g, ' ') || undefined : undefined;
    /** Parts from a run before went again: the folder changed even when nothing new got in. */
    let dropped = false;
    const skip = (e: FileError) => {
      skipped.add(e.track);
      result.skipped.push({ name: e.file, reason: e.reason });
    };
    // A file that is left out leaves none of its parts behind: the box would play half of it.
    const dropActive = async () => {
      const parts = written.splice(activeStart);
      arrived.splice(activeStart);
      for (const w of parts) {
        await dir?.remove(w.file).catch(() => undefined);
        const k = credits.findIndex((c) => c.track === w);
        if (k >= 0) credits.splice(k, 1);
      }
      next -= parts.length;
    };
    /** Files of this album that moved up to close a gap: name before this run → name now, for the catalog. */
    const renamed = new Map<string, string>();
    /**
     * The same for the parts a run before wrote of a file that is left out
     * now. They are normally the last files in the folder. When the file was
     * moved down the list, files of this album come after them (from this
     * run or one before): those move up, so the numbers have no gap. The
     * box would stop at a gap.
     */
    const dropEarlier = async (t: DraftTrack) => {
      const p = resume?.parts.get(t.source);
      if (!resume || !p || !dir) return;
      for (const file of p.files) await dir.remove(file).catch(() => undefined);
      resume.parts.delete(t.source);
      dropped = true;
      const gone = p.files.flatMap((f) => parseNumberedAudio(f)?.number ?? []).sort((x, y) => x - y);
      if (!gone.length) return;
      const entries = await dir.list().catch(() => undefined);
      if (!entries) return;
      const tracks = entries
        .flatMap((e) => {
          const parsed = e.kind === 'file' ? parseNumberedAudio(e.name) : null;
          return parsed && parsed.digits === 3 ? [{ name: e.name, number: parsed.number }] : [];
        })
        .sort((x, y) => x.number - y.number);
      for (const f of tracks) {
        const to = f.number - gone.filter((g) => g < f.number).length;
        if (to === f.number) continue;
        const toName = `${String(to).padStart(3, '0')}${f.name.slice(3)}`;
        try {
          await dir.rename(f.name, toName);
        } catch {
          // Left where it is: the next file still gets a free number (below), the health check shows the gap.
          break;
        }
        for (const w of written) if (w.file === f.name) w.file = toName;
        for (const q of resume.parts.values()) q.files = q.files.map((x) => (x === f.name ? toName : x));
        const before = [...renamed].find(([, now]) => now === f.name)?.[0] ?? f.name;
        renamed.set(before, toName);
      }
      // The next file comes after the last one in the folder, wherever the moves got to.
      const left = await dir.list().catch(() => undefined);
      const last = Math.max(0, ...(left ?? []).flatMap((e) => (e.kind === 'file' ? (parseNumberedAudio(e.name)?.number ?? []) : [])));
      next = last + 1;
      // A run that stops before a new file arrives hands this on: the next run checks the folder against it.
      resume.last = last;
    };
    try {
      // Checked again on the card as it is now: a change may have stopped since the review.
      if (waitingFolders(card.value?.scan ?? s.scan).has(a.target)) throw new AlbumError(helperWaiting(a.target, 'box'));
      prepared = await prepareAlbum(a, {
        audio: plat().audio,
        normalizeLoudness: opts.normalizeLoudness,
        boostQuietMp3: opts.boostQuietMp3,
        // Added to a folder made quieter or louder on purpose: the new tracks get its level.
        levelOffsetDb: a.append ? card.value?.catalog?.folders[name]?.levelOffsetDb : undefined,
        monoSpeech: opts.monoSpeech,
        stripTags: opts.stripTags,
        bitrateKbps: opts.bitrateKbps,
        signal: ctrl.signal,
        analysisOf: measuredOf,
        onPrepare: (detail, fraction) => state({ step: 'prepare', detail, fraction, bytesDone: bar.prepare(fraction) }),
        tagsFor: creditTagsFor,
        ...announcing(a, result),
        // Going on with a transfer that stopped: the parts on the card stay, the loudness stays the same.
        skipParts: a.resume ? new Map([...a.resume.parts].map(([source, p]) => [source, p.done])) : undefined,
        gain: a.resume?.gain,
      });
      prepared.skipped.forEach(skip);
      const { jobs } = prepared;
      checkResume(a, jobs, skipped);
      const scan = card.value?.scan ?? s.scan;
      const existing = scan.folders.find((f) => f.number === a.target);
      if (existing && !a.append) throw new AlbumError(`Ordner ${name} gibt es inzwischen schon. Es wurde nichts überschrieben. Wähle einen anderen Ordner.`);
      next = a.append && existing ? Math.max(0, ...existing.tracks.map((t) => t.number)) + 1 : 1;
      if (a.resume && next - 1 !== a.resume.last) throw new Error(changedSinceStop(a.target));
      if (next - 1 + jobs.length > MAX_TRACKS) throw new AlbumError(tooManyTitles(a, next - 1 + jobs.length, true), jobs.length);
      // Measured again now that the work is known: converted files (a quiet album made louder) can be bigger than the review thought.
      const free = card.value?.info.freeBytes;
      const need = jobs.reduce((sum, j) => (skipped.has(j.track) ? sum : sum + j.estimateBytes), 0);
      if (free !== undefined && need > free) throw new AlbumError(noSpace(need, free, !!prepared.gain.boosted));
      created = !existing;
      dir = await s.volume.root.dir(name, { create: true });
      // A cut file that cannot be read any more takes the parts it has on the card with it.
      for (const t of skipped) await dropEarlier(t);
      state({ tracks: jobs.length });
      // The overall bar counts the work on every file (also on files converted ahead) and the writing.
      const jobBytes = jobs.reduce((sum, j) => sum + j.estimateBytes, 0);
      const progress = (current: number, writing: number) =>
        bar.files(
          jobs.reduce((sum, j, k) => {
            const share = WORK_SHARE[j.work];
            const work = k < current ? 1 : Math.min(1, Math.max(0, j.worked()));
            const write = k < current ? 1 : k === current ? writing : 0;
            return sum + j.estimateBytes * (share * work + (1 - share) * write);
          }, 0),
          jobBytes,
        );
      for (let ti = 0; ti < jobs.length; ti++) {
        const job = jobs[ti];
        // The other parts of a file that could not be converted: the next file counts them as done.
        if (skipped.has(job.track)) continue;
        if (job.track !== active) {
          active = job.track;
          activeStart = written.length;
        }
        const file = importTrackName(next, job.title, opts.pureNumbers);
        state({ track: ti, step: STEP_FOR[job.work], detail: job.title, fraction: 0, bytesDone: progress(ti, 0) });
        let data: Blob;
        try {
          data = await job.produce((f) => state({ fraction: f, bytesDone: progress(ti, 0) }), ctrl.signal);
        } catch (e) {
          if (!(e instanceof FileError) || ctrl.signal.aborted) throw e;
          // A damaged file is left out; the other files and albums go on.
          skip(e);
          await dropActive();
          await dropEarlier(job.track);
          continue;
        }
        state({ step: 'copy', fraction: 0, bytesDone: progress(ti, 0) });
        try {
          await dir.write(file, data, {
            signal: ctrl.signal,
            onProgress: (n) => {
              const f = data.size ? n / data.size : 1;
              state({ fraction: f, bytesDone: progress(ti, f) });
            },
          });
        } catch (e) {
          // Never leave half a file behind: the box would play it.
          await dir.remove(file).catch(() => undefined);
          throw e;
        }
        const track: CatalogTrack = { file, title: job.title, durationSec: job.durationSec };
        // A guessed title stays marked as long as nobody changed it (cut parts get titles of their own).
        if (job.track.titleAuto && job.parts === 1 && job.title === job.track.title) track.titleAuto = true;
        // Lengths of the import come from the frames or the decoder (withMp3Check, analysis), never from a guess.
        if (job.durationSec !== undefined) track.durationExact = true;
        if (episode) track.episode = episode;
        written.push(track);
        arrived.push(job);
        if (job.origin) credits.push({ track, origin: job.origin, changes: job.changes });
        next++;
        state({ bytesDone: progress(ti + 1, 0) });
      }
      // Several albums onto one folder (episodes): the folder counts once.
      if (written.length) {
        result.albums = (result.albums ?? done.length) + 1;
        if (!done.includes(a.target)) done.push(a.target);
        if (episode && !result.episodes?.includes(a.target)) (result.episodes ??= []).push(a.target);
      }
    } catch (e) {
      if (isAbort(e)) result.cancelled = true;
      else if (e instanceof AlbumError) result.refused.push({ title: shownTitle(a), reason: e.message });
      else result.error = e instanceof Error ? e.message : String(e);
      if (written.length) result.partial = { folder: a.target, written: written.length };
      // What did not get there stays, ready to go on with: also inside a cut file, whose parts on the card stay.
      const left = restOf(a, prepared, arrived, written, skipped, resume, next - 1);
      const planned = e instanceof AlbumError && e.tracks !== undefined ? { split: a.split, splitMinutes: a.splitMinutes, tracks: e.tracks } : undefined;
      if (left) result.rest.push(planned && !arrived.length ? { ...left, planned } : left);
    } finally {
      prepared?.close();
    }
    // The next album starts where this one ends on the bar, also when it stopped early.
    bytesDone = bar.end;
    if (prepared) addNotes(result, a, prepared, arrived);
    // A Mac may write a hidden twin ("._001.mp3") next to every file: the box would count it as a title.
    if (dir && written.length) await removeTwins(dir, written.map((w) => w.file));
    // A new folder that got nothing goes again: an empty folder trips up the box (and blocks the number).
    // So does a folder that only held the parts of a file that is left out now.
    let emptied = false;
    if (!written.length && dropped && dir) emptied = (await dir.list().catch(() => [undefined])).length === 0;
    if ((created || emptied) && !written.length) await s.volume.root.remove(name).catch(() => undefined);

    // Record what is on the card now, also after an error, so titles are not lost.
    if (written.length || dropped) {
      await rescan().catch(() => undefined);
      const now = Date.now();
      await updateCatalog(
        (c) => {
          if (emptied) {
            delete c.folders[name];
            return;
          }
          // Titles of files that moved up to close a gap go with them.
          const known = c.folders[name];
          if (known && renamed.size) {
            const lower = new Map([...renamed].map(([from, to]) => [from.toLowerCase(), to]));
            const moved = new Set<string>();
            const kept = known.tracks.filter((t) => !lower.has(t.file.toLowerCase()));
            const up = known.tracks.filter((t) => lower.has(t.file.toLowerCase()));
            for (const t of up) {
              t.file = lower.get(t.file.toLowerCase())!;
              moved.add(t.file.toLowerCase());
            }
            // An entry under a name a moved file took belonged to a part that went.
            known.tracks = [...kept.filter((t) => !moved.has(t.file.toLowerCase())), ...up];
          }
          // Only parts went: noting the folder below drops them from its entry.
          if (!written.length) return;
          const entry = c.folders[name] ?? (c.folders[name] = defaultEntry(a, now));
          if (!a.append) {
            const fresh = defaultEntry(a, now);
            Object.assign(entry, { title: fresh.title, artist: a.artist?.trim() || undefined, kind: a.kind });
            // A new album has the level of the others, whatever a folder of that number had before.
            delete entry.levelOffsetDb;
            if (fresh.series) entry.series = fresh.series;
            // A new folder for a series packed on the add page is named like the series; each album is an episode in it.
            if (pack) Object.assign(entry, { title: pack.title, series: pack.title });
          }
          recordOrigins(entry, credits, newId);
          entry.tracks = [...entry.tracks.filter((t) => !written.some((w) => w.file.toLowerCase() === t.file.toLowerCase())), ...written];
          entry.updatedAt = now;
        },
        { touchFolders: [a.target] },
      ).catch(() => undefined);
      if (written.length && a.cover && !hasCover(a.target)) {
        // A picture that cannot be stored is no reason to stop, but the done screen says so (TODO #84: it went missing without a word).
        let failed: string | null = null;
        try {
          const img = await normalizeCover(a.cover.data, a.cover.mimeType);
          // A cassette cover from the search turns its sticker upright, as on the folder page.
          const kind = a.coverFrom?.kind;
          if (!(await setCover(a.target, img.data, img.mimeType, a.coverFrom?.source ?? coverCredit(a.tracks), kind ? uprightFor(kind, img) : undefined))) {
            failed = 'Der Ordner fehlt im Inhaltsverzeichnis der Karte.';
          }
        } catch (e) {
          failed = e instanceof Error ? e.message : String(e);
        }
        if (failed) {
          console.error(`Cover of folder ${name} not stored:`, failed);
          (result.notes ??= []).push({ kind: 'cover', folder: a.target, title: shownTitle(a), reason: failed });
        }
      }
    }
    if (result.cancelled || result.error) {
      result.rest.push(...albums.slice(ai + 1));
      break;
    }
  }

  // Players play in the order the files sit in the folder: check it, fix it.
  // Not on a snapshot (Firefox, Safari): the Paket brings every folder in the order of the numbers.
  state({ step: 'check', detail: undefined, fraction: undefined });
  const touched = [...done, ...(result.partial && !done.includes(result.partial.folder) ? [result.partial.folder] : [])];
  const order = await fixOrder(s.volume.root, await rescan().catch(() => undefined), s.volume.access === 'snapshot' ? [] : touched);
  const scan = order.scan;
  result.reordered = order.reordered;
  if (order.unordered.length) result.unordered = order.unordered;
  if (touched.length) await updateCatalog(() => undefined, { touchFolders: touched }).catch(() => undefined);
  // Hidden files that are still in these folders (from before, or written by the computer meanwhile): the done screen offers to remove them.
  result.junk = junkIn(scan, touched);

  controller = null;
  // After the first transfer "Meine Box" may ask once whether to remember the box (remembered.ts).
  if (done.length) transferredToCard.value = true;
  update({ phase: 'done', write: undefined, result });
  // Everything got there: the same "all fine" as the done screen.
  if (done.length && !result.error && !result.cancelled && !result.refused.length && !result.skipped.length) void playDoneSound('songs');
}

export function cancelImport() {
  controller?.abort();
}

/** After a transfer that stopped: back to the review with what did not get to the card. */
export function resumeImport() {
  const s = session.value;
  const rest = s.phase === 'done' ? s.result?.rest : undefined;
  if (!rest?.length) return;
  const kept = new Set(rest.map((a) => a.coverUrl));
  revokeCovers(s.albums.filter((a) => !kept.has(a.coverUrl)));
  // What the app did on its own so far is told again at the end.
  update({ phase: 'review', albums: rest, rejected: [], result: undefined, write: undefined, notes: s.result?.notes });
}

/* ------------------------------------------------------------------ spoken titles */

/**
 * The extra "Titelansagen" for an album: the title spoken in front of each
 * file, by the computer's voice. Titles it could not announce are noted.
 */
function announcing(a: ImportAlbum, result: ImportResult): { announce?: Parameters<typeof prepareAlbum>[1]['announce']; onAnnounceFailed?: Parameters<typeof prepareAlbum>[1]['onAnnounceFailed'] } {
  const speech = plat().speech;
  if (!a.announce || !settings.value.announceTitles || !speech) return {};
  return {
    announce: async (title, mp3, signal) => {
      const r = await announceTrack(fileSource(mp3, 'titel.mp3'), () => speech.say(announcementText(title)), { signal });
      return { blob: r.blob, addedSec: r.announcementSec };
    },
    onAnnounceFailed: (job, e) => {
      const notes = (result.notes ??= []);
      const note = notes.find((n): n is Extract<ImportNote, { kind: 'unannounced' }> => n.kind === 'unannounced' && n.folder === a.target);
      if (note) note.titles.push(job.title);
      else notes.push({ kind: 'unannounced', folder: a.target, titles: [job.title], reason: e instanceof Error ? e.message : String(e) });
    },
  };
}

/* ------------------------------------------------------------------ notes and hidden files */

/** Files made anew, and an MP3 album that stayed quiet or was made louder: only for what got to the card, each once. */
function addNotes(result: ImportResult, a: ImportAlbum, prepared: PreparedAlbum, arrived: TrackJob[]) {
  const notes = (result.notes ??= []);
  const reached = new Set(arrived.map((j) => j.track));
  const title = shownTitle(a);
  const has = (kind: ImportNote['kind']) => notes.some((n) => n.kind === kind && n.folder === a.target);
  for (const r of prepared.rebuilt) {
    if (!reached.has(r.track)) continue;
    const file = r.track.source.relativePath ?? r.track.source.name;
    if (!notes.some((n) => n.kind === 'rebuilt' && n.folder === a.target && n.file === file)) notes.push({ kind: 'rebuilt', reason: r.reason, file, folder: a.target });
  }
  for (const t of prepared.clipped ?? []) {
    if (!reached.has(t)) continue;
    const file = t.source.relativePath ?? t.source.name;
    if (!notes.some((n) => n.kind === 'clipped' && n.folder === a.target && n.file === file)) notes.push({ kind: 'clipped', file, folder: a.target });
  }
  if (prepared.levelDb !== undefined && arrived.length && !notes.some((n) => n.kind === 'level' && n.folder === a.target && n.title === title)) {
    notes.push({ kind: 'level', title, folder: a.target, db: prepared.levelDb });
  }
  const { gain } = prepared;
  // Only MP3s that went to the card as they are stay quiet; converted files got the whole change.
  const copied = arrived.some((j) => j.work !== 'convert');
  if ((gain.shortfallDb ?? 0) > QUIET_SHORTFALL_DB && copied && !has('quiet')) {
    const db = gain.quietDb ?? gain.shortfallDb ?? 0;
    // The whole distance, measured from the album as it was: the boost covers MAX_BOOST_DB of it.
    const boostLeft = Math.round(db + gain.steps * GAIN_STEP_DB - MAX_BOOST_DB);
    notes.push({ kind: 'quiet', title, folder: a.target, db: Math.round(db), ...(boostLeft >= 1 ? { boostLeft } : {}) });
  }
  // MP3s converted only to make the album louder: said, because they lose a little quality.
  const made = new Set(prepared.rebuilt.map((r) => r.track));
  if (gain.boosted && arrived.some((j) => isPlayableAsIs(j.track) && !made.has(j.track)) && !has('boosted')) {
    const left = Math.round(gain.quietDb ?? 0);
    notes.push({ kind: 'boosted', title, folder: a.target, ...(left >= 1 ? { db: left } : {}) });
  }
}

/**
 * Removes the hidden twin a Mac may write next to a file on the card
 * ("._001.mp3", AppleDouble), for the files just written and no others.
 * Best effort: a twin that stays shows on the done screen.
 */
export async function removeTwins(dir: Dir, files: string[]): Promise<void> {
  let names: Set<string>;
  try {
    names = new Set((await dir.list()).map((e) => e.name));
  } catch {
    return;
  }
  for (const f of files) {
    for (const twin of [`._${f}`, `._${f}.crswap`]) if (names.has(twin)) await dir.remove(twin).catch(() => undefined);
  }
}

/**
 * Puts the files of these folders in the order of their numbers where they
 * are not. A folder with hidden files is left as it is: the reorder moves
 * only the titles, and the folder could not go away with the hidden files
 * in it, which would leave the titles in the helper folder.
 */
export async function fixOrder(root: Dir, scan: SdScan | undefined, folders: number[]): Promise<{ reordered: number[]; unordered: number[]; scan: SdScan | undefined }> {
  const reordered: number[] = [];
  const unordered: number[] = [];
  for (const n of folders) {
    const f = scan?.folders.find((x) => x.number === n);
    if (!scan || !f || !isOutOfOrder(f.tracks)) continue;
    const plan = f.junk.length ? undefined : planFix(scan, { kind: 'rebuild-order', folder: n });
    if (!plan || plan.leftovers.length) {
      unordered.push(n);
      continue;
    }
    const r = await executePlan(root, plan).catch((e: unknown) => ({ error: e instanceof Error ? e : new Error(String(e)) }));
    if ('error' in r && r.error) unordered.push(n);
    else reordered.push(n);
    scan = await rescan().catch(() => undefined);
  }
  return { reordered, unordered, scan };
}

/** "Ordner 05", "den Ordnern 48 und 49", "den Ordnern 03, 04 und 07": for "in …". */
export function foldersWords(folders: readonly number[]): string {
  const names = folders.map(folderName);
  return names.length === 1 ? `Ordner ${names[0]}` : `den Ordnern ${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

/** What the done screen says about folders whose order is still wrong, and what to do. */
export function unorderedNote(r: ImportResult): { text: string; health: boolean } | undefined {
  const folders = r.unordered ?? [];
  if (!folders.length) return undefined;
  const junk = new Set((r.junk ?? []).map((p) => Number(p.split('/')[0])));
  const first = `In ${foldersWords(folders)} liegen die Titel auf der Karte nicht in der Reihenfolge ihrer Nummern. Die Box spielt sie dann durcheinander.`;
  if (folders.every((n) => junk.has(n))) return { text: `${first} Räume unten zuerst die versteckten Dateien auf. Dann ordne ich die Titel neu.`, health: false };
  return { text: `${first} Öffne „Meine Box“ und tippe auf „Ansehen und reparieren“. Dort bringe ich das in Ordnung.`, health: true };
}

/** Hidden files in these folders, as "03/._001.mp3". */
function junkIn(scan: SdScan | undefined, folders: number[]): string[] {
  if (!scan) return [];
  return folders
    .flatMap((n) => (scan.folders.find((f) => f.number === n)?.junk ?? []).map((e) => `${folderName(n)}/${e.name}`))
    .sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
}

/**
 * Removes the hidden files the done screen lists, and no others, with the
 * clean-up of the health check. The list then shows what is left.
 */
export async function cleanImportJunk(): Promise<void> {
  const s = card.value;
  const r = session.value.result;
  if (!s?.scan || !r?.junk?.length) return;
  const listed = new Set(r.junk.map((p) => p.toLowerCase()));
  const all = planFix(s.scan, { kind: 'clean-junk', keepRoot: true });
  const plan = { ...all, steps: all.steps.filter((st) => st.op === 'delete' && listed.has(st.path.join('/').toLowerCase())) };
  const folders = [...new Set(r.junk.map((p) => Number(p.split('/')[0])))];
  const done = await writeGuard.during('repair', async () => {
    const cleaned = await executePlan(s.volume.root, plan).catch((e: unknown) => ({ error: e instanceof Error ? e : new Error(String(e)) }));
    // Folders the import could not put in order because of these files: now it can.
    const waiting = r.unordered ?? [];
    const order = waiting.length ? await fixOrder(s.volume.root, await rescan().catch(() => undefined), waiting) : undefined;
    return { cleaned, order };
  });
  const scan = await rescan().catch(() => undefined);
  const now = session.value.result;
  if (now) {
    const next: ImportResult = { ...now, junk: scan ? junkIn(scan, folders).filter((p) => listed.has(p.toLowerCase())) : now.junk };
    if (done.order) {
      next.reordered = [...now.reordered, ...done.order.reordered];
      next.unordered = done.order.unordered;
    }
    update({ result: next });
  }
  const failed = done.cleaned.error;
  if (failed) throw failed instanceof Error ? failed : new Error(failed.message);
}

/** What the album's note says about the files made anew, by reason. */
export function rebuildNote(damaged: number, joined: number): string {
  const parts: string[] = [];
  if (damaged) parts.push(damaged === 1 ? 'Eine MP3-Datei ist beschädigt' : `${damaged} MP3-Dateien sind beschädigt`);
  if (joined) {
    const one = parts.length ? 'eine ist' : 'Eine MP3-Datei ist';
    const many = parts.length ? `${joined} sind` : `${joined} MP3-Dateien sind`;
    parts.push(`${joined === 1 ? one : many} aus mehreren Dateien zusammengesetzt`);
  }
  return `${parts.join(', ')}. Ich wandle sie neu um, damit die Box nicht hängen bleibt oder aussetzt.`;
}

/** A paragraph of the done screen about what the app did on its own, with the files it is about. */
export interface DoneNote {
  text: string;
  files?: string[];
  /** Link to the help. */
  help?: string;
  /** Links to the settings and to this folder's page, for what to do next. */
  settings?: boolean;
  folder?: number;
}

/**
 * Whether the folder has a cover that is really there. A catalog entry can
 * name a picture the cover zip no longer has (a folder of that number
 * deleted outside the app): then the new album's cover goes in.
 */
function hasCover(folder: number): boolean {
  const s = card.value;
  const entry = s?.catalog?.folders[folderName(folder)]?.cover;
  return !!entry && !!s?.covers.has(entry);
}

/** The notes in words: files made anew first, then quiet albums. */
export function doneNotes(r: ImportResult): DoneNote[] {
  const notes = r.notes ?? [];
  const out: DoneNote[] = [];
  const damaged = notes.flatMap((n) => (n.kind === 'rebuilt' && n.reason === 'damaged' ? [n.file] : []));
  const joined = notes.flatMap((n) => (n.kind === 'rebuilt' && n.reason === 'joined' ? [n.file] : []));
  if (damaged.length) {
    out.push({
      text: `${damaged.length === 1 ? 'Eine beschädigte Datei hab' : `${damaged.length} beschädigte Dateien hab`} ich neu erstellt. An kaputten Stellen kann die Box sonst hängen bleiben.`,
      files: damaged,
    });
  }
  if (joined.length) {
    const names = joined.map((f) => `„${f}“`);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}` : names[0];
    out.push({
      text: `Neu umgewandelt, weil aus mehreren Dateien zusammengesetzt: ${joined.length > 5 ? `${joined.length} Dateien` : list}. Sonst kann die Box an den Nahtstellen aussetzen.`,
      files: joined.length > 5 ? joined : undefined,
    });
  }
  const clipped = notes.flatMap((n) => (n.kind === 'clipped' ? [n.file] : []));
  if (clipped.length) {
    const why = 'Die lautesten Stellen sind darin abgeschnitten. Das kratzt auch am PC, und leiser machen hilft nicht. Eine bessere Quelle hilft, zum Beispiel die CD.';
    out.push({
      text: clipped.length === 1 ? `„${clipped[0]}“ ist schon übersteuert. ${why}` : `${clipped.length} Dateien sind schon übersteuert. ${why}`,
      files: clipped.length > 1 ? clipped : undefined,
      help: 'uebersteuert',
    });
  }
  for (const n of notes) {
    if (n.kind === 'cover') {
      const reason = /[.!?]$/.test(n.reason.trim()) ? n.reason.trim() : `${n.reason.trim()}.`;
      out.push({
        text: `Das Cover von „${n.title}“ konnte ich nicht speichern, Ordner ${folderName(n.folder)} hat darum noch keins. ${reason} Du kannst es auf der Seite des Ordners noch einmal festlegen.`,
        folder: n.folder,
      });
    } else if (n.kind === 'unannounced') {
      const names = n.titles.slice(0, 3).map((t) => `„${t}“`);
      const list = n.titles.length > 3 ? `${names.join(', ')} und ${n.titles.length - 3} weitere` : names.length > 1 ? `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}` : names[0];
      const reason = /[.!?]$/.test(n.reason.trim()) ? n.reason.trim() : `${n.reason.trim()}.`;
      out.push({ text: `Ohne Titelansage in Ordner ${folderName(n.folder)}: ${list}. ${reason}`, help: 'titelansagen', folder: n.folder });
    } else if (n.kind === 'boosted') {
      const still = n.db ? ` Ganz so laut wie deine anderen Alben ist es trotzdem nicht: Es bleibt etwa ${n.db}\u00a0dB leiser, weil ich höchstens um ${MAX_BOOST_DB}\u00a0dB anhebe.` : '';
      out.push({ text: `„${n.title}“ war sehr leise. Ich hab die MP3-Dateien lauter gemacht und dafür neu umgewandelt.${still}`, help: 'lautstaerke' });
    } else if (n.kind === 'quiet') {
      out.push({
        text:
          `„${n.title}“ ist etwa ${n.db}\u00a0dB leiser geblieben als deine anderen Alben. Ohne Umwandeln ging es nicht lauter, weil einzelne Stellen sonst übersteuern würden. ` +
          `Mit „Leise MP3s lauter machen“ in den Einstellungen mache ich solche Alben lauter. Dafür löschst du auf der Seite von Ordner ${folderName(n.folder)} die Titel und fügst die Dateien mit „Titel hinzufügen“ neu hinzu.` +
          // No figure for the largest boost here: it starts from the original files, not from what is left, and invites a wrong sum.
          (n.boostLeft ? ` Es wird dann lauter, aber nicht ganz so laut wie die anderen: Es bliebe etwa ${n.boostLeft}\u00a0dB leiser.` : ''),
        help: 'lautstaerke',
        settings: true,
        folder: n.folder,
      });
    }
  }
  const level = levelNote(notes.filter((n): n is Extract<ImportNote, { kind: 'level' }> => n.kind === 'level'));
  if (level) out.push({ text: level, help: 'lautstaerke' });
  return out;
}

/** What „Gleiche Lautstärke“ did to each album, in one sentence: „A“ 3 dB leiser, „B“ passte schon. */
export function levelNote(levels: readonly { title: string; db: number }[]): string | undefined {
  if (!levels.length) return undefined;
  // Half decibels at most: finer is not heard, and the MP3 steps are 1.5 dB anyway.
  const rounded = levels.map((l) => ({ title: l.title, db: Math.round(l.db * 2) / 2 }));
  const dB = (db: number) => `${Math.abs(db).toLocaleString('de-DE', { maximumFractionDigits: 1 })}\u00a0dB`;
  if (rounded.length <= 6) {
    const parts = rounded.map((l) => `„${l.title}“ ${l.db < 0 ? `${dB(l.db)} leiser` : l.db > 0 ? `${dB(l.db)} lauter` : 'passte schon'}`);
    return `Gleiche Lautstärke: ${parts.join(', ')}.`;
  }
  const quieter = rounded.filter((l) => l.db < 0).length;
  const louder = rounded.filter((l) => l.db > 0).length;
  const fine = rounded.length - quieter - louder;
  const parts = [
    quieter ? `${plural(quieter, 'Album', 'Alben')} leiser gemacht` : '',
    louder ? `${quieter ? louder : plural(louder, 'Album', 'Alben')} lauter` : '',
    fine ? `${fine} ${fine === 1 ? 'passte' : 'passten'} schon` : '',
  ].filter(Boolean);
  return `Gleiche Lautstärke: ${parts.join(', ')}.`;
}

/**
 * What the done screen says when not everything arrived, one paragraph each. The skipped files come as a list of their own.
 * `packaged` (Firefox, Safari): the files went into the Paket for the card, not onto the card itself.
 */
export function resultNotes(r: ImportResult, opts: { packaged?: boolean } = {}): string[] {
  const p = !!opts.packaged;
  const notes: string[] = [];
  if (r.error) notes.push(r.error);
  for (const x of r.refused) notes.push(`„${x.title}“: ${x.reason}`);
  const there = p ? 'fertig fürs Paket' : 'angekommen';
  const albums = r.albums ?? r.folders.length;
  let arrived = albums ? `${plural(albums, 'Album ist', 'Alben sind')} ${there}.` : `Kein Album ist ganz ${there}.`;
  if (r.partial) arrived += ` In Ordner ${folderName(r.partial.folder)} ${r.partial.written === 1 ? 'ist' : 'sind'} ${plural(r.partial.written, 'Titel', 'Titel')} ${p ? 'fertig' : 'angekommen'}.`;
  notes.push(arrived);
  if (r.rest.length) {
    const names = r.rest.map((a) => (a.target === r.partial?.folder ? `${plural(a.tracks.length, 'Datei', 'Dateien')} für Ordner ${folderName(a.target)}` : `„${shownTitle(a)}“`));
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}` : names[0];
    notes.push(p ? `Noch nicht im Paket: ${list}. Mit „Rest vorbereiten“ holst du das nach.` : `Noch nicht auf der Karte: ${list}. Mit „Rest übertragen“ holst du das nach.`);
  }
  return notes;
}

/** Recommended card mode for an album, for the summary after the import. */
export function defaultModeFor(kind: ImportAlbum['kind']): number {
  return CONTENT_KINDS.find((k) => k.id === kind)?.defaultMode ?? 5;
}
