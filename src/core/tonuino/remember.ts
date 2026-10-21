import { catalogContent, parseCatalog, type Catalog } from './catalog';
import { profileFromSounds, type SoundsEvidence } from './firmwaredetect';
import { folderName, parseNumberedAudio, type SdFolder, type SdScan, type SdTrack } from './sd';

/**
 * „Box merken“: what the app keeps of a box on this device, so that its
 * shelf, its cards and its stickers work without the SD card. Folder
 * numbers, the files' names and sizes, the catalog (names, artists, titles,
 * how each card plays, further and special cards) and small covers; no
 * audio. Plain data, kept per box under the id of its catalog
 * (Catalog.id, the same id that tells boxes apart everywhere else).
 *
 * Read only: the shelf and the lists are built from it as from a card
 * (memoryScan), but nothing is ever written back to a card from it.
 */

export const MEMORY_FORMAT = 1;
/**
 * Longer side of a remembered cover in pixels: enough for a sharp sticker
 * (a cover 50 mm high at 300 dpi needs about 600; Frank, 17.10.2026, prints
 * without the card). Covers kept smaller before (360) are made again.
 */
export const THUMB_PX = 1000;
/** From this age on, the page says that the box may have changed since. */
export const STALE_DAYS = 30;

export interface MemoryTrack {
  number: number;
  /** File name on the card, e.g. "003.mp3": the catalog's titles are keyed by it. */
  name: string;
  size: number;
}

export interface MemoryFolder {
  number: number;
  tracks: MemoryTrack[];
}

export interface BoxMemory {
  format: typeof MEMORY_FORMAT;
  /** The box: the id of its catalog. */
  id: string;
  /** Name of the box, e.g. "Emmas TonUINO". */
  name: string;
  /** Name of the drive or folder it was read from. */
  label: string;
  /** When the app first remembered the box. */
  since: number;
  /** When the content was last taken from the card („gemerkt am“). */
  at: number;
  /** The catalog without the time it was saved (catalogContent). */
  catalog: string;
  folders: MemoryFolder[];
  /** What the announcements on the card said about the firmware (decideProfile): the system folders are not kept. */
  sounds?: SoundsEvidence;
  /** Bytes of the thumbnails kept beside it, so a list of memories need not read them. */
  thumbBytes?: number;
}

/** The cover a thumbnail was made from: its entry in the cover zip, its size and CRC-32. */
export interface CoverStamp {
  entry: string;
  size: number;
  crc: number;
}

export interface MemoryThumb {
  stamp: CoverStamp;
  /** Type of `data`, e.g. "image/jpeg". */
  type: string;
  data: Uint8Array;
  /** THUMB_PX it was made with; missing: 360, before 0.5. */
  px?: number;
}

/** Thumbnails by folder name ("05"). */
export type MemoryThumbs = Record<string, MemoryThumb>;

/** What a list of remembered boxes shows. */
export interface MemorySummary {
  id: string;
  name: string;
  at: number;
  folders: number;
}

/** Folders with their tracks as listed on the card; duplicates and helper folders stay out. */
function memoryFolders(scan: SdScan): MemoryFolder[] {
  return scan.folders.map((f) => ({
    number: f.number,
    tracks: f.tracks.map((t) => ({ number: t.number, name: t.name, size: t.size })),
  }));
}

/**
 * What to remember of an open card. `before` is the memory of the same box
 * from an earlier visit: it keeps the day the box was first remembered.
 */
export function buildBoxMemory(scan: SdScan, catalog: Catalog, opts: { label: string; at: number; before?: BoxMemory | null; thumbs?: MemoryThumbs }): BoxMemory {
  const before = opts.before?.id === catalog.id ? opts.before : null;
  const sounds = profileFromSounds(scan);
  return {
    format: MEMORY_FORMAT,
    id: catalog.id,
    name: catalog.name,
    label: opts.label,
    since: before ? Math.min(before.since, opts.at) : opts.at,
    at: opts.at,
    catalog: catalogContent(catalog),
    folders: memoryFolders(scan),
    ...(sounds ? { sounds } : {}),
    ...(opts.thumbs ? { thumbBytes: Object.values(opts.thumbs).reduce((n, t) => n + t.data.length, 0) } : {}),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A stored memory as read back; null when it is not one (another format, damaged). */
export function parseBoxMemory(raw: unknown): BoxMemory | null {
  if (!isObj(raw) || raw.format !== MEMORY_FORMAT) return null;
  const { id, name, label, since, at, catalog, folders, sounds } = raw;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || typeof catalog !== 'string' || !isNum(at) || !Array.isArray(folders)) return null;
  const out: MemoryFolder[] = [];
  for (const f of folders) {
    if (!isObj(f) || !isNum(f.number) || f.number < 1 || f.number > 99 || !Array.isArray(f.tracks)) return null;
    const tracks: MemoryTrack[] = [];
    for (const t of f.tracks) {
      if (!isObj(t) || !isNum(t.number) || typeof t.name !== 'string' || !isNum(t.size)) return null;
      tracks.push({ number: t.number, name: t.name, size: t.size });
    }
    out.push({ number: f.number, tracks });
  }
  const m: BoxMemory = { format: MEMORY_FORMAT, id, name, label: typeof label === 'string' ? label : '', since: isNum(since) ? since : at, at, catalog, folders: out };
  if (isObj(sounds) && (sounds.profile === 'tng' || sounds.profile === 'classic21') && Array.isArray(sounds.files)) {
    m.sounds = { profile: sounds.profile, files: sounds.files.filter((f): f is string => typeof f === 'string') };
  }
  if (isNum(raw.thumbBytes)) m.thumbBytes = raw.thumbBytes;
  return m;
}

export function memoryCatalog(m: BoxMemory): Catalog | null {
  return parseCatalog(m.catalog);
}

export function memorySummary(m: BoxMemory): MemorySummary {
  return { id: m.id, name: m.name, at: m.at, folders: m.folders.length };
}

/**
 * The remembered folders as a reading of the card, for everything that
 * builds on one (shelf, card list, track titles). It has no system folders,
 * no junk and no file times: nothing to judge or repair, and the health
 * check never sees it.
 */
export function memoryScan(m: BoxMemory, hasCovers = false): SdScan {
  const folders: SdFolder[] = m.folders.map((f) => {
    const tracks: SdTrack[] = f.tracks.map((t, order) => {
      const parsed = parseNumberedAudio(t.name);
      return { number: t.number, name: t.name, size: t.size, suffix: parsed?.suffix ?? '', ext: parsed?.ext ?? 'mp3', order };
    });
    return {
      number: f.number,
      name: folderName(f.number),
      tracks,
      wrongDigits: [],
      unnumbered: [],
      others: [],
      junk: [],
      subfolders: [],
      empty: [],
      totalBytes: tracks.reduce((sum, t) => sum + t.size, 0),
    };
  });
  return {
    kind: folders.length ? 'tonuino' : 'empty',
    folders,
    system: {},
    rootJunk: [],
    rootOthers: [],
    invalidFolders: [],
    nearFolders: [],
    nearSystem: [],
    tempDirs: [],
    hasCatalog: true,
    hasCovers,
    rootOrder: folders.map((f) => f.name),
    fileTimes: [],
    scannedAt: m.at,
  };
}

/** Whether two memories of a box say the same, apart from when they were taken. */
export function sameMemory(a: BoxMemory | null | undefined, b: BoxMemory): boolean {
  if (!a) return false;
  return a.id === b.id && a.name === b.name && a.label === b.label && a.catalog === b.catalog && JSON.stringify([a.folders, a.sounds]) === JSON.stringify([b.folders, b.sounds]);
}

/* ------------------------------------------------------------------ covers */

/**
 * The covers of the catalog's folders as they are on the card, by folder
 * name. `crc` may cache by the bytes' identity: the card's cover map keeps
 * the same arrays until a cover changes.
 */
export function coverStamps(catalog: Catalog, covers: ReadonlyMap<string, Uint8Array>, crc: (bytes: Uint8Array) => number): Record<string, CoverStamp> {
  const out: Record<string, CoverStamp> = {};
  for (const [name, f] of Object.entries(catalog.folders)) {
    const bytes = f.cover ? covers.get(f.cover) : undefined;
    if (f.cover && bytes) out[name] = { entry: f.cover, size: bytes.length, crc: crc(bytes) };
  }
  return out;
}

const sameStamp = (a: CoverStamp | undefined, b: CoverStamp | undefined) => !!a && !!b && a.entry === b.entry && a.size === b.size && a.crc === b.crc;

/**
 * Refreshing the memory of a box: which thumbnails stay as they are (same
 * cover), which are made anew (new or changed cover) and which go (the
 * folder has no cover any more, or is gone).
 */
export function thumbPlan(have: MemoryThumbs | undefined, want: Record<string, CoverStamp>): { keep: string[]; make: string[]; drop: string[] } {
  const keep: string[] = [];
  const make: string[] = [];
  for (const name of Object.keys(want).sort()) (sameStamp(have?.[name]?.stamp, want[name]) && (have![name].px ?? 360) >= THUMB_PX ? keep : make).push(name);
  const drop = Object.keys(have ?? {})
    .filter((name) => !(name in want) || !keep.includes(name))
    .sort();
  return { keep, make, drop };
}

/**
 * The thumbnails after a refresh: the kept ones and the newly made ones. A
 * cover that could not be made smaller stays out (the shelf draws the
 * folder's own sticker then), unless an older thumbnail of the very same
 * cover is still there.
 */
export function mergeThumbs(have: MemoryThumbs | undefined, made: MemoryThumbs, want: Record<string, CoverStamp>): MemoryThumbs {
  const out: MemoryThumbs = {};
  for (const name of Object.keys(want).sort()) {
    const fresh = made[name];
    if (fresh && sameStamp(fresh.stamp, want[name])) out[name] = fresh;
    else if (sameStamp(have?.[name]?.stamp, want[name])) out[name] = have![name];
  }
  return out;
}

/** Whether a refresh changed the thumbnails. */
export function sameThumbs(a: MemoryThumbs | undefined, b: MemoryThumbs): boolean {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameStamp(a![k].stamp, b[k].stamp) && a![k].data.length === b[k].data.length);
}

/** About how much room a memory takes on the device, in bytes; without `thumbs` as noted when it was taken. */
export function memoryBytes(m: BoxMemory, thumbs?: MemoryThumbs): number {
  let n = m.catalog.length + JSON.stringify(m.folders).length + m.name.length + m.label.length;
  if (!thumbs) return n + (m.thumbBytes ?? 0);
  for (const t of Object.values(thumbs)) n += t.data.length;
  return n;
}

/* ------------------------------------------------------------------ in words */

/** The day a memory was taken, as the page says it: "13.10.2026". */
export function rememberedDate(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Old enough that the box may well hold more by now (STALE_DAYS). */
export function isStale(at: number, now: number, days = STALE_DAYS): boolean {
  return now - at > days * 24 * 3600 * 1000;
}
