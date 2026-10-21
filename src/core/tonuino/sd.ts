import type { Dir, DirEntry } from '../../platform/types';

/**
 * Rules for the SD card layout the DFPlayer expects, and a scanner that
 * reads a card into a model the rest of the app works with.
 *
 *   01 … 99/        audio folders, files 001.mp3 … 255.mp3 (text after the number is allowed by most chips)
 *   mp3/            system announcements of the firmware, 0001.mp3 …
 *   advert/         announcements played over a running track, 0001.mp3 …
 */

export const SYSTEM_DIRS = ['mp3', 'advert'] as const;
export type SystemDirName = (typeof SYSTEM_DIRS)[number];
export const CATALOG_FILE = 'tonuino-studio.json';
export const COVERS_FILE = 'tonuino-studio-covers.zip';
export const APP_FILES = [CATALOG_FILE, COVERS_FILE] as const;
export const MAX_FOLDER = 99;
export const MAX_TRACKS = 255;
/**
 * Helper folder used while a repair rewrites a folder (see repair.ts). It is
 * named after the folder it belongs to, e.g. "_tonuino-studio-temp-05", so an
 * interrupted repair can put the files back where they came from.
 */
export const TEMP_PREFIX = '_tonuino-studio-temp';

export function tempDirName(folder: number): string {
  return `${TEMP_PREFIX}-${String(folder).padStart(2, '0')}`;
}

/**
 * Helper folders of a swap of two folders (see planSwapFolders): the files
 * of folder 05 on their way to 12 wait in "_tonuino-studio-temp-05-nach-12",
 * and "_tonuino-studio-temp-05-tausch-12" is an empty marker that says the
 * swap goes forward, so an interrupted swap is finished, not undone. Both
 * names lie outside 01 to 99, so a swap works with all 99 folders taken.
 */
export function swapHelperName(from: number, to: number): string {
  return `${tempDirName(from)}-nach-${String(to).padStart(2, '0')}`;
}

export function swapMarkerName(a: number, b: number): string {
  return `${tempDirName(a)}-tausch-${String(b).padStart(2, '0')}`;
}

const TEMP_NAME = /^_tonuino-studio-temp(?:-(\d{2})(?:-(nach|tausch)-(\d{2}))?)?$/i;

/** Folder number a temp dir belongs to, null for a temp dir without number, undefined for other names. */
export function parseTempDir(name: string): number | null | undefined {
  const m = TEMP_NAME.exec(name);
  if (!m) return undefined;
  return m[1] ? parseFolderNumber(m[1]) : null;
}

/** The two numbers of a swap helper or marker (see swapHelperName), null for other names. */
export function parseSwapDir(name: string): { from: number; to: number; marker: boolean } | null {
  const m = TEMP_NAME.exec(name);
  const from = m?.[3] ? parseFolderNumber(m[1]) : null;
  const to = m?.[3] ? parseFolderNumber(m[3]) : null;
  if (from === null || to === null || from === to) return null;
  return { from, to, marker: m![2].toLowerCase() === 'tausch' };
}

/** The folders whose files may wait in a helper folder: its own and, for a swap, the other one. */
export function helperFolders(t: Pick<SdTempDir, 'folder' | 'swap'>): number[] {
  const out = t.folder === null ? [] : [t.folder];
  if (t.swap) out.push(t.swap.to);
  return out;
}

/**
 * Marker folders inside the helper folder of a reorder (see planReorder).
 * The first says the files carry both names ("002=005.mp3": new number 002,
 * old name 005.mp3); the second appears once the folder was emptied and
 * created again, from then on the new numbers apply. With them an
 * interrupted reorder can always be put back without a name clash.
 */
export const REORDER_MARKER = 'umsortieren';
export const REORDER_DONE_MARKER = 'neue-nummern';

/**
 * Name of a track in the helper folder of a reorder: new number, then the old
 * name. "=" means the new name is the pure number, "+" that it keeps the text
 * after the number. (Browsers refuse "~" in names, so it is not used.)
 */
export function helperTrackName(newNumber: number, oldName: string, pureNumbers: boolean): string {
  return `${String(newNumber).padStart(3, '0')}${pureNumbers ? '=' : '+'}${oldName}`;
}

/** Old and new name of a track in the helper folder of a reorder, null for other names. */
export function parseHelperTrackName(name: string): { oldName: string; newName: string } | null {
  const m = /^(\d{3})([=+])(.+)$/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  const old = parseNumberedAudio(m[3]);
  // Only tracks are stored like this; anything else in the folder kept its plain name.
  if (n < 1 || n > MAX_TRACKS || !old) return null;
  return { oldName: m[3], newName: `${m[1]}${m[2] === '=' ? '' : old.suffix}.${old.ext}` };
}

const JUNK_NAMES = new Set([
  '.ds_store',
  '.spotlight-v100',
  '.trashes',
  '.fseventsd',
  '.temporaryitems',
  '.apdisk',
  '.volumeicon.icns',
  '.com.apple.timemachine.donotpresent',
  '.metadata_never_index',
  '.metadata_never_index_unless_rootfs',
  '.metadata_direct_scope_only',
  '.documentrevisions-v100',
  'system volume information',
  '$recycle.bin',
  'recycler',
  'thumbs.db',
  'desktop.ini',
  '.directory',
]);

/**
 * Empty marker "<name>.tonuino-open" the app puts next to a file while it
 * writes it in place (desktop: a new file, fsops.rs; Android: every audio
 * file, androidSaf.ts) and removes once the file is complete. Left behind
 * next to its file, it says the file was cut off (card pulled). Alone it is
 * junk.
 */
export const OPEN_SUFFIX = '.tonuino-open';

/**
 * Half-written files of an interrupted save: Chrome's "*.crswap" and the
 * desktop app's "*.tonuino-tmp" (the real file next to them is complete),
 * and markers of unfinished writes.
 */
export function isPartialFile(name: string): boolean {
  return /\.(crswap|tonuino-tmp|tonuino-open)$/i.test(name);
}

/** Audio files whose write never finished: their marker lies next to them. Such markers are left out of the junk. */
function unfinishedIn(entries: DirEntry[]): { files: Set<string>; markers: Set<string> } {
  const files = new Set<string>();
  const markers = new Set<string>();
  const names = new Set(entries.filter((e) => e.kind === 'file').map((e) => e.name));
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.toLowerCase().endsWith(OPEN_SUFFIX)) continue;
    const target = e.name.slice(0, -OPEN_SUFFIX.length);
    // A marker of anything but audio (catalog, picture) is junk: the scan has nothing to say about that file.
    if (!names.has(target) || !isAudioName(target)) continue;
    files.add(target);
    markers.add(e.name);
  }
  return { files, markers };
}

/** Files and folders operating systems leave on the card. The DFPlayer may count them as tracks. */
export function isJunk(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('._')) return true;
  if (JUNK_NAMES.has(n)) return true;
  if (isPartialFile(n)) return true;
  return /^\.trash(-\d+)?$/.test(n);
}

/** Which operating system left a junk entry, for friendlier messages. */
export function junkOrigin(name: string): 'macos' | 'windows' | 'linux' | 'app' | 'other' {
  const n = name.toLowerCase();
  if (isPartialFile(n)) return 'app';
  if (n.startsWith('._') || n.startsWith('.ds_') || n.startsWith('.spotlight') || n === '.trashes' || n === '.fseventsd' || n.startsWith('.metadata_') || n === '.temporaryitems' || n === '.apdisk' || n === '.volumeicon.icns' || n.startsWith('.com.apple') || n.startsWith('.documentrevisions')) return 'macos';
  if (n === 'system volume information' || n === '$recycle.bin' || n === 'recycler' || n === 'thumbs.db' || n === 'desktop.ini') return 'windows';
  if (n.startsWith('.trash') || n === '.directory') return 'linux';
  return 'other';
}

export function parseFolderNumber(name: string): number | null {
  if (!/^\d{2}$/.test(name)) return null;
  const n = Number(name);
  return n >= 1 && n <= MAX_FOLDER ? n : null;
}

export function folderName(n: number): string {
  return String(n).padStart(2, '0');
}

export function trackName(n: number, ext = 'mp3'): string {
  return `${String(n).padStart(3, '0')}.${ext}`;
}

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };

/**
 * Name for a new track: "001.mp3", or with readable text "001_Der_Hund.mp3".
 * The text uses plain ASCII so every player and every computer can read it.
 */
export function importTrackName(n: number, title: string, pureNumbers: boolean, ext = 'mp3'): string {
  if (pureNumbers) return trackName(n, ext);
  const text = title
    .replace(/[äöüÄÖÜß]/g, (c) => UMLAUTS[c])
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 40)
    .replace(/[_-]+$/, '');
  return text ? `${String(n).padStart(3, '0')}_${text}.${ext}` : trackName(n, ext);
}

export function systemTrackName(n: number, ext = 'mp3'): string {
  return `${String(n).padStart(4, '0')}.${ext}`;
}

/**
 * A folder named almost like a box folder: one or two digits, a space,
 * "_", "-" or ".", then text ("02 Bibi", "2_Bibi_und_Tina"). The box only
 * finds "02". The text comes back readable, as a title ("Bibi und Tina").
 */
export function parseNamedFolder(name: string): { number: number; rest: string } | null {
  const m = /^(\d{1,2})[\s_.-]+(\S.*)$/.exec(name);
  if (!m) return null;
  const rest = m[2].replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  // A digit right after the number makes it a date or a range ("12.12.2023 Weihnachtsfeier", "01 - 03"), no box folder.
  if (/^\d/.test(rest)) return null;
  return /\p{L}/u.test(rest) ? { number: Number(m[1]), rest } : null;
}

/** Edits (insert, delete, replace one letter) that turn a into b. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** The system folder a name is a typo of ("advent", "adverts", "mp3s"), at most two letters off. */
export function systemFolderTypo(name: string): SystemDirName | null {
  const n = name.toLowerCase();
  let best: SystemDirName | null = null;
  let bestDistance = 3;
  for (const s of SYSTEM_DIRS) {
    if (Math.abs(n.length - s.length) >= bestDistance) continue;
    const d = editDistance(n, s);
    if (d > 0 && d < bestDistance) {
      best = s;
      bestDistance = d;
    }
  }
  return best;
}

const AUDIO_EXT = /\.(mp3|wav)$/i;
/** Music the box cannot play (the app converts it when added). It may still be worth keeping. */
const UNPLAYABLE_AUDIO = /\.(m4a|m4b|aac|flac|ogg|oga|opus|wma|aiff?)$/i;

export function isUnplayableAudio(name: string): boolean {
  return UNPLAYABLE_AUDIO.test(name);
}

export interface ParsedTrackName {
  number: number;
  /** Text between the number and the extension, e.g. "_Intro". */
  suffix: string;
  ext: 'mp3' | 'wav';
  digits: number;
}

/** Parses "001.mp3", "012 Kapitel.mp3", also wrong digit counts so they can be reported. */
export function parseNumberedAudio(name: string): ParsedTrackName | null {
  const m = /^(\d{1,4})(.*)\.(mp3|wav)$/i.exec(name);
  if (!m) return null;
  return { number: Number(m[1]), suffix: m[2], ext: m[3].toLowerCase() as 'mp3' | 'wav', digits: m[1].length };
}

export function isAudioName(name: string): boolean {
  return AUDIO_EXT.test(name);
}

export interface SdTrack {
  number: number;
  name: string;
  size: number;
  suffix: string;
  ext: 'mp3' | 'wav';
  /** Position in the directory listing (FAT order on desktop). */
  order: number;
}

export interface SdFolder {
  number: number;
  name: string;
  /** Valid tracks sorted by number (duplicates included, see duplicates). */
  tracks: SdTrack[];
  /** Files named like tracks but with the wrong digit count, e.g. 0001.mp3 or 1.mp3. */
  wrongDigits: SdTrack[];
  /** Audio files without a number, or numbers above 255. */
  unnumbered: DirEntry[];
  /** Other files (cover.jpg, playlists, …). */
  others: DirEntry[];
  junk: DirEntry[];
  subfolders: DirEntry[];
  /** Audio files with 0 bytes, e.g. left by an interrupted copy. Also listed above. */
  empty: string[];
  /** Audio files cut off while written (card pulled): their OPEN_SUFFIX marker is there. Also listed above. */
  unfinished?: string[];
  totalBytes: number;
}

export interface SdSystemDir {
  name: SystemDirName;
  /** Actual directory name on the card (case may differ). */
  dirName: string;
  files: SdTrack[];
  wrongDigits: SdTrack[];
  others: DirEntry[];
  junk: DirEntry[];
  /** Audio files with 0 bytes, or cut off while written (OPEN_SUFFIX marker). Also listed above. */
  empty: string[];
  totalBytes: number;
}

/** Only a size the platform reported counts; an unknown size is not "empty". */
function isEmptyAudio(e: DirEntry): boolean {
  return e.kind === 'file' && e.size === 0 && isAudioName(e.name);
}

export type SdKind = 'tonuino' | 'empty' | 'foreign';

/** Leftover helper folder of an interrupted repair. */
export interface SdTempDir {
  name: string;
  /** Folder the files belong to, null when unknown. */
  folder: number | null;
  /** Files waiting to go back, without junk and marker folders. */
  entries: DirEntry[];
  /** Tracks carry their new number and old name (REORDER_MARKER). */
  encoded: boolean;
  /** The new numbers apply already (REORDER_DONE_MARKER). */
  newNumbers: boolean;
  /**
   * Part of a swap of two folders (planSwapFolders): `to` is the other
   * number. A helper holds files of `folder` on their way to `to`; a marker
   * holds nothing and says the swap goes forward.
   */
  swap?: { to: number; marker: boolean };
}

/** A top-level folder named almost like a box folder, e.g. "02 Bibi" (see parseNamedFolder). */
export interface SdNearFolder {
  entry: DirEntry;
  /** The number the name starts with, 0 to 99. */
  number: number;
  /** The text after the number, readable ("Bibi"). */
  rest: string;
  /** Audio files in it (mp3, wav): without them it is no audio folder, just a name with a number ("01 Urlaubsfotos"). */
  audio: number;
}

/** A top-level folder named almost like mp3 or advert, e.g. "advent". */
export interface SdNearSystem {
  entry: DirEntry;
  target: SystemDirName;
  /** Files in it named like announcements (four-digit number). */
  sounds: number;
}

/** How many file times the scan keeps for guessing the file system (see fsguess.ts). */
export const MAX_FILE_TIMES = 300;

export interface SdScan {
  kind: SdKind;
  folders: SdFolder[];
  system: Partial<Record<SystemDirName, SdSystemDir>>;
  rootJunk: DirEntry[];
  /** Root entries that are neither TonUINO folders nor app files nor junk. */
  rootOthers: DirEntry[];
  /** Directory names that look like folders but are invalid ("1", "100", "00"). */
  invalidFolders: DirEntry[];
  /** Folders of rootOthers named almost like a box folder ("02 Bibi"). */
  nearFolders: SdNearFolder[];
  /** Folders of rootOthers named almost like mp3 or advert ("advent"). */
  nearSystem: SdNearSystem[];
  tempDirs: SdTempDir[];
  hasCatalog: boolean;
  hasCovers: boolean;
  /** Root order of numbered folders and system folders as listed. */
  rootOrder: string[];
  /** Modification times of up to MAX_FILE_TIMES files on the card, as far as the platform reports them. */
  fileTimes: number[];
  /** Modification time of the catalog file, when there is one and the platform reports it. */
  catalogTime?: number;
  /**
   * Files and folders the system reports as write-protected (desktop: the FAT
   * read-only attribute), as paths like "05/003.mp3", at most MAX_READ_ONLY.
   * The card itself may be writable: then exactly these cannot be changed.
   */
  readOnly?: string[];
  /** How many there are when readOnly lists only the first MAX_READ_ONLY. */
  readOnlyTotal?: number;
  scannedAt: number;
}

/** Write-protected entries the scan lists by name; more are only counted in readOnlyTotal. */
export const MAX_READ_ONLY = 200;

export interface ScanProgress {
  done: number;
  total: number;
  current?: string;
}

/** Files per folder whose times the scan keeps, so one folder copied from elsewhere does not fill the list. */
const FILE_TIMES_PER_DIR = 20;

export async function scanSd(
  root: Dir,
  opts: { onProgress?: (p: ScanProgress) => void; signal?: AbortSignal } = {},
): Promise<SdScan> {
  const entries = await root.list();
  const scan: SdScan = {
    kind: 'empty',
    folders: [],
    system: {},
    rootJunk: [],
    rootOthers: [],
    invalidFolders: [],
    nearFolders: [],
    nearSystem: [],
    tempDirs: [],
    hasCatalog: false,
    hasCovers: false,
    rootOrder: [],
    fileTimes: [],
    scannedAt: Date.now(),
  };
  const readOnly: string[] = [];
  let readOnlyTotal = 0;
  const noteReadOnly = (dir: string, e: DirEntry) => {
    if (!e.readOnly) return;
    readOnlyTotal++;
    if (readOnly.length < MAX_READ_ONLY) readOnly.push(dir ? `${dir}/${e.name}` : e.name);
  };
  /** Notes the times of the files of one directory, a few per directory. 0 means the platform does not know. Also notes write-protected entries. */
  const timesOf = (dir = '') => {
    let n = 0;
    return (e: DirEntry) => {
      noteReadOnly(dir, e);
      if (e.kind !== 'file' || !e.modified || n >= FILE_TIMES_PER_DIR || scan.fileTimes.length >= MAX_FILE_TIMES) return;
      scan.fileTimes.push(e.modified);
      n++;
    };
  };

  const folderEntries: { n: number; entry: DirEntry }[] = [];
  const systemEntries: { name: SystemDirName; entry: DirEntry }[] = [];
  const typoEntries: { entry: DirEntry; target: SystemDirName }[] = [];

  const tempEntries: { folder: number | null; entry: DirEntry }[] = [];
  const rootTime = timesOf();

  for (const e of entries) {
    if (isJunk(e.name)) {
      scan.rootJunk.push(e);
      continue;
    }
    if (e.kind === 'directory') {
      const t = parseTempDir(e.name);
      if (t !== undefined) {
        tempEntries.push({ folder: t, entry: e });
        continue;
      }
    }
    if (e.kind === 'file' && e.name.toLowerCase() === CATALOG_FILE) {
      noteReadOnly('', e);
      scan.hasCatalog = true;
      if (e.modified) scan.catalogTime = e.modified;
      continue;
    }
    rootTime(e);
    if (e.kind === 'file' && e.name.toLowerCase() === COVERS_FILE) {
      scan.hasCovers = true;
      continue;
    }
    if (e.kind === 'directory') {
      const n = parseFolderNumber(e.name);
      if (n !== null) {
        folderEntries.push({ n, entry: e });
        scan.rootOrder.push(e.name);
        continue;
      }
      const sys = SYSTEM_DIRS.find((s) => s === e.name.toLowerCase());
      if (sys) {
        systemEntries.push({ name: sys, entry: e });
        scan.rootOrder.push(e.name);
        continue;
      }
      if (/^\d{1,3}$/.test(e.name)) {
        scan.invalidFolders.push(e);
        continue;
      }
      // Names that are almost right get their own report; for telling the kind of card they stay other content.
      const named = parseNamedFolder(e.name);
      if (named) scan.nearFolders.push({ entry: e, ...named, audio: 0 });
      else {
        const target = systemFolderTypo(e.name);
        if (target) typoEntries.push({ entry: e, target });
      }
    }
    scan.rootOthers.push(e);
  }

  const total = folderEntries.length + systemEntries.length;
  let done = 0;
  const tick = (current: string) => opts.onProgress?.({ done: ++done, total, current });

  for (const { name, entry } of systemEntries) {
    opts.signal?.throwIfAborted();
    const dir = await root.dir(entry.name);
    scan.system[name] = await scanSystemDir(dir, name, entry.name, timesOf(entry.name));
    tick(entry.name);
  }

  for (const near of scan.nearFolders) {
    opts.signal?.throwIfAborted();
    near.audio = await countFiles(root, near.entry.name, isAudioName);
  }
  for (const { entry, target } of typoEntries) {
    opts.signal?.throwIfAborted();
    const sounds = await countFiles(root, entry.name, (name) => parseNumberedAudio(name)?.digits === 4);
    scan.nearSystem.push({ entry, target, sounds });
  }

  for (const { folder, entry } of tempEntries) {
    const dir = await root.dir(entry.name);
    const all = (await dir.list()).filter((x) => !isJunk(x.name));
    const marker = (name: string) => all.some((x) => x.kind === 'directory' && x.name.toLowerCase() === name);
    const encoded = marker(REORDER_MARKER);
    const newNumbers = marker(REORDER_DONE_MARKER);
    const markers = new Set([...(encoded ? [REORDER_MARKER] : []), ...(newNumbers ? [REORDER_DONE_MARKER] : [])]);
    const entries = all.filter((x) => !(x.kind === 'directory' && markers.has(x.name.toLowerCase())));
    const swap = parseSwapDir(entry.name);
    scan.tempDirs.push({ name: entry.name, folder, entries, encoded, newNumbers, ...(swap ? { swap: { to: swap.to, marker: swap.marker } } : {}) });
  }

  folderEntries.sort((a, b) => a.n - b.n);
  for (const { n, entry } of folderEntries) {
    opts.signal?.throwIfAborted();
    const dir = await root.dir(entry.name);
    scan.folders.push(await scanFolder(dir, n, entry.name, timesOf(entry.name)));
    tick(entry.name);
  }

  if (readOnlyTotal) {
    scan.readOnly = readOnly;
    if (readOnlyTotal > readOnly.length) scan.readOnlyTotal = readOnlyTotal;
  }

  const hasTonuinoContent =
    scan.folders.length > 0 || systemEntries.length > 0 || scan.hasCatalog || scan.tempDirs.length > 0;
  if (hasTonuinoContent) scan.kind = 'tonuino';
  else if (scan.rootOthers.length === 0 && scan.invalidFolders.length === 0) scan.kind = 'empty';
  else scan.kind = 'foreign';
  return scan;
}

/** Files in a top-level folder whose name passes `test`, junk aside; 0 when the folder cannot be read. */
async function countFiles(root: Dir, name: string, test: (file: string) => boolean): Promise<number> {
  try {
    return (await (await root.dir(name)).list()).filter((x) => x.kind === 'file' && !isJunk(x.name) && test(x.name)).length;
  } catch {
    // A folder that cannot be read holds nothing the box could play either.
    return 0;
  }
}

async function scanFolder(dir: Dir, number: number, name: string, noteTime: (e: DirEntry) => void): Promise<SdFolder> {
  const entries = await dir.list();
  const folder: SdFolder = {
    number,
    name,
    tracks: [],
    wrongDigits: [],
    unnumbered: [],
    others: [],
    junk: [],
    subfolders: [],
    empty: [],
    totalBytes: 0,
  };
  const open = unfinishedIn(entries);
  entries.forEach((e, order) => {
    if (open.markers.has(e.name)) return;
    if (isJunk(e.name)) {
      folder.junk.push(e);
      return;
    }
    if (e.kind === 'directory') {
      folder.subfolders.push(e);
      return;
    }
    noteTime(e);
    if (isEmptyAudio(e)) folder.empty.push(e.name);
    else if (open.files.has(e.name)) (folder.unfinished ??= []).push(e.name);
    folder.totalBytes += e.size ?? 0;
    const parsed = parseNumberedAudio(e.name);
    if (!parsed) {
      if (isAudioName(e.name)) folder.unnumbered.push(e);
      else folder.others.push(e);
      return;
    }
    const track: SdTrack = { number: parsed.number, name: e.name, size: e.size ?? 0, suffix: parsed.suffix, ext: parsed.ext, order };
    if (parsed.digits !== 3) folder.wrongDigits.push(track);
    else if (parsed.number < 1 || parsed.number > MAX_TRACKS) folder.unnumbered.push(e);
    else folder.tracks.push(track);
  });
  folder.tracks.sort((a, b) => a.number - b.number || a.order - b.order);
  return folder;
}

async function scanSystemDir(dir: Dir, name: SystemDirName, dirName: string, noteTime: (e: DirEntry) => void): Promise<SdSystemDir> {
  const entries = await dir.list();
  const sys: SdSystemDir = { name, dirName, files: [], wrongDigits: [], others: [], junk: [], empty: [], totalBytes: 0 };
  const open = unfinishedIn(entries);
  entries.forEach((e, order) => {
    if (open.markers.has(e.name)) return;
    if (isJunk(e.name)) {
      sys.junk.push(e);
      return;
    }
    if (e.kind === 'directory') {
      sys.others.push(e);
      return;
    }
    noteTime(e);
    if (isEmptyAudio(e) || open.files.has(e.name)) sys.empty.push(e.name);
    sys.totalBytes += e.size ?? 0;
    const parsed = parseNumberedAudio(e.name);
    if (!parsed) {
      sys.others.push(e);
      return;
    }
    const t: SdTrack = { number: parsed.number, name: e.name, size: e.size ?? 0, suffix: parsed.suffix, ext: parsed.ext, order };
    if (parsed.digits !== 4) sys.wrongDigits.push(t);
    else sys.files.push(t);
  });
  sys.files.sort((a, b) => a.number - b.number || a.order - b.order);
  return sys;
}

/** Numbers 1-99 not used by any folder. */
export function freeFolderNumbers(scan: SdScan): number[] {
  const used = new Set(scan.folders.map((f) => f.number));
  const free: number[] = [];
  for (let n = 1; n <= MAX_FOLDER; n++) if (!used.has(n)) free.push(n);
  return free;
}

/** The folder number new content should go to: the first gap, otherwise after the last. */
export function nextFolderNumber(scan: SdScan, reserved: Iterable<number> = []): number | null {
  const taken = new Set([...scan.folders.map((f) => f.number), ...reserved]);
  for (let n = 1; n <= MAX_FOLDER; n++) if (!taken.has(n)) return n;
  return null;
}

/** Tracks with the same number in one folder, grouped. */
export function duplicateTracks(folder: SdFolder): SdTrack[][] {
  const groups = new Map<number, SdTrack[]>();
  for (const t of folder.tracks) {
    const g = groups.get(t.number) ?? [];
    g.push(t);
    groups.set(t.number, g);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Missing numbers between 1 and the highest track number. */
export function missingTrackNumbers(folder: SdFolder): number[] {
  const nums = new Set(folder.tracks.map((t) => t.number));
  const max = folder.tracks.reduce((m, t) => Math.max(m, t.number), 0);
  const missing: number[] = [];
  for (let n = 1; n <= max; n++) if (!nums.has(n)) missing.push(n);
  return missing;
}

/** True when the directory order of the tracks differs from their numbers. */
export function isOutOfOrder(tracks: SdTrack[]): boolean {
  const byOrder = [...tracks].sort((a, b) => a.order - b.order);
  for (let i = 1; i < byOrder.length; i++) if (byOrder[i].number < byOrder[i - 1].number) return true;
  return false;
}

export function folderTrackCount(scan: SdScan, n: number): number | undefined {
  const f = scan.folders.find((x) => x.number === n);
  if (!f) return undefined;
  return new Set(f.tracks.map((t) => t.number)).size;
}

export function totalAudioBytes(scan: SdScan): number {
  let sum = 0;
  for (const f of scan.folders) sum += f.totalBytes;
  for (const s of Object.values(scan.system)) sum += s?.totalBytes ?? 0;
  return sum;
}
