import type { Dir } from '../../platform/types';
import type { FirmwareProfile } from './card';
import { modeByCode } from './modes';
import type { PlanStep, RepairPlan } from './repair';
import { assertWritable, noteRead, UnreadableCardFile } from './unreadable';
import {
  CATALOG_FILE,
  folderName,
  MAX_FOLDER,
  parseFolderNumber,
  parseHelperTrackName,
  parseTempDir,
  REORDER_DONE_MARKER,
  REORDER_MARKER,
  type SdFolder,
  type SdScan,
} from './sd';

/**
 * The catalog remembers what the card does not: titles, covers, how each
 * card plays its folder. It lives as `tonuino-studio.json` on the SD card, so
 * it travels with the card, and the app keeps a copy on the computer.
 */

export const CATALOG_APP = 'tonuino-studio';
export const CATALOG_FORMAT = 1;

export type ContentKind = 'hoerspiel' | 'hoerbuch' | 'musik' | 'lieder' | 'wissen' | 'sonstiges';

export const CONTENT_KINDS: { id: ContentKind; label: string; defaultMode: number }[] = [
  { id: 'hoerspiel', label: 'Hörspiel', defaultMode: 5 },
  { id: 'hoerbuch', label: 'Hörbuch', defaultMode: 5 },
  { id: 'musik', label: 'Musik', defaultMode: 2 },
  { id: 'lieder', label: 'Kinderlieder', defaultMode: 3 },
  { id: 'wissen', label: 'Wissen', defaultMode: 2 },
  { id: 'sonstiges', label: 'Sonstiges', defaultMode: 2 },
];

export interface CatalogTrack {
  /** File name on the card, e.g. "003.mp3". */
  file: string;
  title?: string;
  /**
   * The title is a guess: from a shop's track list (iTunes, MusicBrainz) or
   * the artist field of the file. Shown as "automatisch erkannt" until someone
   * edits it. Optional since 0.3; older versions ignore it and keep the title.
   */
  titleAuto?: true;
  durationSec?: number;
  /**
   * The length comes from the MP3's frames (or the decoder), not from a
   * guess in its tags: the folder page need not check it again. Optional
   * since 0.3.
   */
  durationExact?: true;
  /** Size of the file when the app last noted the folder: tells a swapped file from the one it knew. */
  size?: number;
  /** Id of the folder's origin entry, for tracks that came from "Entdecken". */
  origin?: string;
  /**
   * Name of the episode (Folge) the track belongs to, when several share the
   * folder (extra "Mehr als 99 Hörspiele", see episodes.ts): tracks in a row
   * with the same name are one episode. Optional since 0.3; older versions
   * drop it.
   */
  episode?: string;
}

/**
 * Where tracks from "Entdecken" came from and under which licence, kept with
 * the folder so the credit travels with the card. One entry per item (an
 * episode, a book, a story), shared by all of its tracks.
 */
export interface FolderOrigin {
  id: string;
  /** Entry id and item key in the list of sources. */
  entry: string;
  item: string;
  /** The item's title, e.g. the episode. */
  title: string;
  /** The source's title, when it differs from the item's. */
  series?: string;
  publisher: string;
  /** The item's page, else the source's. */
  pageUrl: string;
  licence: { kind: 'podcast' | 'private-use' | 'public-domain' | 'cc'; label: string; url?: string };
  /** Title, creators, source, licence and what the app changed, as written into the files. */
  credit: string;
  /** What the app changed: "converted", "loudness", "split", "tags". */
  changes: string[];
  retrievedAt: number;
}

/** How the card for a folder plays it. The folder number is the catalog key. */
export interface FolderCard {
  mode: number;
  special?: number;
  special2?: number;
}

export interface CatalogFolder {
  title: string;
  artist?: string;
  /** Series and episode, e.g. "Die drei ???" and 125. */
  series?: string;
  episode?: number;
  kind?: ContentKind;
  card?: FolderCard;
  /** In track order. */
  tracks: CatalogTrack[];
  /** Track count and size when the app last wrote the folder, to notice changes made elsewhere. */
  fingerprint?: string;
  /** Entry in tonuino-studio-covers.zip, e.g. "05.jpg". */
  cover?: string;
  /** Where the cover came from, for the credit line ("iTunes", "MusicBrainz", "Datei"). */
  coverSource?: string;
  /** Background colour for stickers, picked from the cover. */
  color?: string;
  /** Sticker adjustments: shorter title, picture section (0…1 focus, zoom 0 = whole picture … 4), orientation. */
  sticker?: StickerTweaks;
  /** Origin and licence of tracks from "Entdecken". */
  origins?: FolderOrigin[];
  /**
   * Made quieter or louder on purpose ("Leiser für die Nacht"): dB from the
   * level every other folder gets, LEVEL_OFFSET_MIN_DB…LEVEL_OFFSET_MAX_DB.
   * Matching the folder again and adding tracks to it keep it. Missing: as
   * loud as the others. Optional since 0.5; older versions drop it.
   */
  levelOffsetDb?: number;
  /**
   * A reorder of the folder is under way and the tracks are listed under
   * their new names already, also those still waiting in the helper folder
   * (see planReorder, applyPlanToCatalog).
   */
  renumbered?: boolean;
  addedAt: number;
  updatedAt: number;
}

/** How much quieter or louder a folder may be made on purpose (CatalogFolder.levelOffsetDb). */
export const LEVEL_OFFSET_MIN_DB = -12;
export const LEVEL_OFFSET_MAX_DB = 6;

/** A folder's offset as kept: within the range, in half dB, 0 (as loud as the others) as undefined. */
export function cleanLevelOffset(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const db = Math.round(Math.max(LEVEL_OFFSET_MIN_DB, Math.min(LEVEL_OFFSET_MAX_DB, v)) * 2) / 2;
  return db === 0 ? undefined : db;
}

export interface StickerTweaks {
  title?: string;
  focusX?: number;
  focusY?: number;
  zoom?: number;
  orientation?: 'landscape' | 'portrait';
  /**
   * The card on the shelf ("Meine Box"): a recipe's id, "-" for no recipe
   * (the cover whole next to a panel), "sticker" for the sticker as printed;
   * missing = recognised automatically. Optional since 0.3; older versions
   * ignore it.
   */
  recipe?: string;
  /**
   * Sticker style "Bildkarte", a card without a cover: an ARASAAC pictogram
   * (its number, core/stickers/arasaac.ts) in place of the app's own motif.
   * The picture itself stays on the device that chose it. Optional since
   * 0.5; older versions ignore it.
   */
  pictogram?: number;
}

/** A card that does not belong to a folder: modifier and admin cards, or parts of a folder. */
export interface ExtraCard {
  id: string;
  label: string;
  folder: number;
  mode: number;
  special: number;
  special2: number;
  /** 1: the old card format of TonUINO 2.0 (the only other value kept). Left out for the format of 2.1 and TNG (2). */
  version?: number;
  /** A further card of a folder: its own sticker text and section; picture and colour otherwise come from the folder. */
  sticker?: StickerTweaks;
  color?: string;
  /**
   * Entry in tonuino-studio-covers.zip with a picture of its own, e.g. the
   * cover an episode had as a folder before its series was packed into one
   * (pack.ts). Without it the card shows the folder's cover. Optional since
   * 0.4.1; older versions drop it and show the folder's cover.
   */
  cover?: string;
}

export interface Catalog {
  app: typeof CATALOG_APP;
  format: number;
  /** Identifies this SD card (and the box it belongs to). */
  id: string;
  /** Name of the box, e.g. "Emmas TonUINO". */
  name: string;
  profile: FirmwareProfile;
  /** How `profile` was set: by hand, or from the start of the box over USB (firmwaredetect.ts). Missing in catalogs before 0.3. */
  profileFrom?: 'manual' | 'box';
  /** What the box named at its start the last time it was connected over USB; `date` is the build date TNG names with its version ("2026-09-17"). */
  firmware?: { board?: string; version?: string; date?: string; updatedAt?: number };
  systemSounds?: { version: string; installedAt: number };
  /**
   * When someone looked at the card on a computer and saw FAT32. The web app
   * can only guess the format (see fsguess.ts); this silences the guess.
   */
  formatChecked?: number;
  /**
   * Two folders swap their numbers (planSwapFolders) and the catalog lists
   * them under their new numbers already. An interrupted swap is then
   * finished instead of undone, so titles and files stay together. Gone
   * again once no helper folder of the swap is left on the card.
   */
  swap?: { a: number; b: number };
  folders: Record<string, CatalogFolder>;
  extraCards: ExtraCard[];
  updatedAt: number;
}

export function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function newCatalog(name = 'Meine TonUINO-Box', profile: FirmwareProfile = 'tng'): Catalog {
  return {
    app: CATALOG_APP,
    format: CATALOG_FORMAT,
    id: newId(),
    name,
    profile,
    folders: {},
    extraCards: [],
    updatedAt: Date.now(),
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const byte = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= 255 ? n : undefined;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KINDS = new Set<string>(CONTENT_KINDS.map((k) => k.id));

/** Reads a catalog, tolerating missing or broken fields. Null when it is not a catalog at all. */
export function parseCatalog(text: string): Catalog | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.app !== CATALOG_APP) return null;
  const now = Date.now();
  const folders: Record<string, CatalogFolder> = {};
  if (isObj(raw.folders)) {
    for (const [key, v] of Object.entries(raw.folders)) {
      const n = parseFolderNumber(key);
      if (n === null || !isObj(v)) continue;
      const origins = parseOrigins(v.origins);
      const originIds = new Set(origins?.map((o) => o.id));
      const tracks: CatalogTrack[] = Array.isArray(v.tracks)
        ? v.tracks.filter(isObj).flatMap((t) => {
            const file = str(t.file);
            if (!file) return [];
            const track: CatalogTrack = { file, title: str(t.title), durationSec: num(t.durationSec), size: num(t.size) };
            const origin = str(t.origin);
            if (origin && originIds.has(origin)) track.origin = origin;
            if (t.titleAuto === true && track.title) track.titleAuto = true;
            if (t.durationExact === true && track.durationSec !== undefined) track.durationExact = true;
            const episode = str(t.episode)?.trim();
            if (episode) track.episode = episode;
            return [track];
          })
        : [];
      const card = isObj(v.card) && byte(v.card.mode) ? { mode: byte(v.card.mode)!, special: byte(v.card.special), special2: byte(v.card.special2) } : undefined;
      folders[folderName(n)] = {
        title: str(v.title) ?? `Ordner ${folderName(n)}`,
        artist: str(v.artist),
        series: str(v.series),
        episode: num(v.episode),
        kind: KINDS.has(str(v.kind) ?? '') ? (v.kind as ContentKind) : undefined,
        card,
        tracks,
        fingerprint: str(v.fingerprint),
        cover: str(v.cover),
        coverSource: str(v.coverSource),
        color: str(v.color),
        sticker: parseTweaks(v.sticker),
        origins,
        levelOffsetDb: cleanLevelOffset(v.levelOffsetDb),
        renumbered: v.renumbered === true ? true : undefined,
        addedAt: num(v.addedAt) ?? now,
        updatedAt: num(v.updatedAt) ?? now,
      };
    }
  }
  const extraCards: ExtraCard[] = Array.isArray(raw.extraCards)
    ? raw.extraCards.filter(isObj).flatMap((c) => {
        const folder = byte(c.folder);
        const mode = byte(c.mode);
        if (folder === undefined || mode === undefined) return [];
        const card: ExtraCard = { id: str(c.id) ?? newId(), label: str(c.label) ?? '', folder, mode, special: byte(c.special) ?? 0, special2: byte(c.special2) ?? 0 };
        if (c.version === 1) card.version = 1;
        const sticker = parseTweaks(c.sticker);
        if (sticker) card.sticker = sticker;
        const color = str(c.color);
        if (color) card.color = color;
        const cover = str(c.cover);
        if (cover) card.cover = cover;
        return [card];
      })
    : [];
  const fw = isObj(raw.firmware) ? { board: str(raw.firmware.board), version: str(raw.firmware.version), date: str(raw.firmware.date), updatedAt: num(raw.firmware.updatedAt) } : undefined;
  const ss = isObj(raw.systemSounds) && str(raw.systemSounds.version) ? { version: str(raw.systemSounds.version)!, installedAt: num(raw.systemSounds.installedAt) ?? now } : undefined;
  const sa = isObj(raw.swap) ? byte(raw.swap.a) : undefined;
  const sb = isObj(raw.swap) ? byte(raw.swap.b) : undefined;
  return {
    app: CATALOG_APP,
    format: num(raw.format) ?? CATALOG_FORMAT,
    id: str(raw.id) ?? newId(),
    name: str(raw.name) ?? 'Meine TonUINO-Box',
    profile: raw.profile === 'classic21' ? 'classic21' : 'tng',
    profileFrom: raw.profileFrom === 'manual' || raw.profileFrom === 'box' ? raw.profileFrom : undefined,
    firmware: fw,
    systemSounds: ss,
    formatChecked: num(raw.formatChecked),
    swap: sa && sb && sa !== sb && sa <= MAX_FOLDER && sb <= MAX_FOLDER ? { a: sa, b: sb } : undefined,
    folders,
    extraCards,
    updatedAt: num(raw.updatedAt) ?? now,
  };
}

const LICENCE_KINDS = new Set(['podcast', 'private-use', 'public-domain', 'cc']);

/** Origin entries of a folder; malformed ones are dropped. */
function parseOrigins(v: unknown): FolderOrigin[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: FolderOrigin[] = [];
  const seen = new Set<string>();
  for (const o of v) {
    if (!isObj(o) || !isObj(o.licence)) continue;
    const id = str(o.id);
    const entry = str(o.entry);
    const item = str(o.item);
    const title = str(o.title);
    const publisher = str(o.publisher);
    const pageUrl = str(o.pageUrl);
    const credit = str(o.credit);
    const kind = str(o.licence.kind);
    const label = str(o.licence.label);
    if (!id || seen.has(id) || !entry || !item || !title || !publisher || !pageUrl || !credit || !kind || !LICENCE_KINDS.has(kind) || !label) continue;
    seen.add(id);
    const url = str(o.licence.url);
    out.push({
      id,
      entry,
      item,
      title,
      series: str(o.series),
      publisher,
      pageUrl,
      licence: { kind: kind as FolderOrigin['licence']['kind'], label, ...(url ? { url } : {}) },
      credit,
      changes: Array.isArray(o.changes) ? o.changes.filter((c): c is string => typeof c === 'string') : [],
      retrievedAt: num(o.retrievedAt) ?? 0,
    });
  }
  return out.length ? out : undefined;
}

function parseTweaks(v: unknown): StickerTweaks | undefined {
  if (!isObj(v)) return undefined;
  const unit = (x: unknown) => {
    const n = num(x);
    return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
  };
  const zoom = num(v.zoom);
  const out: StickerTweaks = {
    title: str(v.title),
    focusX: unit(v.focusX),
    focusY: unit(v.focusY),
    zoom: zoom !== undefined && zoom >= 0 && zoom <= 4 ? zoom : undefined,
    orientation: v.orientation === 'landscape' || v.orientation === 'portrait' ? v.orientation : undefined,
    recipe: typeof v.recipe === 'string' && /^[a-z0-9-]{1,60}$/.test(v.recipe) ? v.recipe : undefined,
    pictogram: typeof v.pictogram === 'number' && Number.isInteger(v.pictogram) && v.pictogram > 0 && v.pictogram < 10_000_000 ? v.pictogram : undefined,
  };
  return Object.values(out).some((x) => x !== undefined) ? out : undefined;
}

export function serializeCatalog(c: Catalog): string {
  const sortedFolders: Record<string, CatalogFolder> = {};
  for (const key of Object.keys(c.folders).sort()) sortedFolders[key] = c.folders[key];
  return JSON.stringify({ ...c, folders: sortedFolders }, (_k, v) => (v === undefined ? undefined : v), 1) + '\n';
}

/**
 * The card's catalog, or null when the card has none. A catalog that is
 * there but cannot be read or understood throws UnreadableCardFile, and
 * saveCatalog leaves it alone until a later reading works: else the next
 * change would put a new, empty list over the names (0.5.1).
 */
export async function loadCatalog(root: Dir): Promise<Catalog | null> {
  let catalog: Catalog | null;
  try {
    if (!(await root.exists(CATALOG_FILE))) {
      noteRead(root, CATALOG_FILE, true);
      return null;
    }
    catalog = parseCatalog(new TextDecoder().decode(await root.read(CATALOG_FILE)));
  } catch (e) {
    noteRead(root, CATALOG_FILE, false);
    throw e;
  }
  noteRead(root, CATALOG_FILE, !!catalog);
  if (!catalog) throw new UnreadableCardFile(CATALOG_FILE);
  return catalog;
}

/** The catalog without the time it was saved: equal for two catalogs that say the same. */
export function catalogContent(c: Catalog): string {
  return serializeCatalog({ ...c, updatedAt: 0 });
}

/**
 * Writes the catalog. A save that would change nothing but the time leaves
 * the file as it is, so a card read for a Paket gets no change from it.
 */
export async function saveCatalog(root: Dir, c: Catalog): Promise<void> {
  assertWritable(root, CATALOG_FILE);
  const before = (await root.exists(CATALOG_FILE)) ? new TextDecoder().decode(await root.read(CATALOG_FILE)) : null;
  const at = before === null ? undefined : savedAt(before);
  if (at !== undefined && serializeCatalog({ ...c, updatedAt: at }) === before) {
    c.updatedAt = at;
    return;
  }
  c.updatedAt = Date.now();
  await root.write(CATALOG_FILE, new TextEncoder().encode(serializeCatalog(c)));
}

function savedAt(text: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    return isObj(raw) ? num(raw.updatedAt) : undefined;
  } catch {
    return undefined;
  }
}

/** Unique track count and their total size. Changes when someone edits the folder with another program. */
export function folderFingerprint(folder: SdFolder): string {
  const seen = new Set<number>();
  let bytes = 0;
  for (const t of folder.tracks) {
    if (seen.has(t.number)) continue;
    seen.add(t.number);
    bytes += t.size;
  }
  return `${seen.size}:${bytes}`;
}

export type ShelfState =
  /** Known to the catalog and unchanged. */
  | 'ok'
  /** On the card but not in the catalog (copied with another program). */
  | 'unknown'
  /** In the catalog, but the files changed since. */
  | 'changed'
  /** In the catalog, but the folder is gone from the card. */
  | 'missing';

export interface ShelfItem {
  number: number;
  name: string;
  folder?: SdFolder;
  entry?: CatalogFolder;
  state: ShelfState;
  /** Title to show: catalog title, otherwise "Ordner 05". */
  title: string;
  trackCount: number;
  durationSec?: number;
}

export function buildShelf(scan: SdScan, catalog: Catalog | null): ShelfItem[] {
  const items = new Map<number, ShelfItem>();
  for (const f of scan.folders) {
    const entry = catalog?.folders[f.name];
    const fp = folderFingerprint(f);
    items.set(f.number, {
      number: f.number,
      name: f.name,
      folder: f,
      entry,
      state: !entry ? 'unknown' : entry.fingerprint && entry.fingerprint !== fp ? 'changed' : 'ok',
      title: entry?.title || `Ordner ${f.name}`,
      trackCount: new Set(f.tracks.map((t) => t.number)).size,
      durationSec: entry ? sumDurations(entry, f) : undefined,
    });
  }
  for (const [key, entry] of Object.entries(catalog?.folders ?? {})) {
    const n = parseFolderNumber(key);
    if (n === null || items.has(n)) continue;
    items.set(n, { number: n, name: key, entry, state: 'missing', title: entry.title, trackCount: 0 });
  }
  return [...items.values()].sort((a, b) => a.number - b.number);
}

function sumDurations(entry: CatalogFolder, folder: SdFolder): number | undefined {
  const byFile = new Map(entry.tracks.map((t) => [t.file.toLowerCase(), t.durationSec]));
  let sum = 0;
  for (const t of folder.tracks) {
    const d = byFile.get(t.name.toLowerCase());
    if (d === undefined) return undefined;
    sum += d;
  }
  return sum;
}

/** Track titles for a folder in the order of the card, falling back to the file name. */
export function trackRows(folder: SdFolder, entry?: CatalogFolder): { number: number; file: string; size: number; title: string; durationSec?: number }[] {
  const byFile = new Map((entry?.tracks ?? []).map((t) => [t.file.toLowerCase(), t]));
  return folder.tracks.map((t) => {
    const c = byFile.get(t.name.toLowerCase());
    const fallback = t.suffix.replace(/^[\s_\-.]+/, '').trim();
    return { number: t.number, file: t.name, size: t.size, title: c?.title || fallback || `Titel ${t.number}`, durationSec: c?.durationSec };
  });
}

/**
 * Keeps track titles attached to their files after a repair. `done` are the
 * steps that ran (all of them by default), so an interrupted repair leaves
 * the catalog matching the card: the steps are replayed in order, and a track
 * still waiting in a helper folder keeps its entry under the name
 * "Dateien zurücklegen" gives it back.
 */
export function applyPlanToCatalog(c: Catalog, plan: RepairPlan, done: PlanStep[] = plan.steps): void {
  // A swap changes the catalog in one go at its commit (see planSwapFolders). Only a list of steps that
  // starts at the beginning counts: the steps after the commit come again later and must not swap back.
  if (plan.swap && plan.commitAt !== undefined && done.includes(plan.steps[0]) && done.includes(plan.steps[plan.commitAt])) {
    swapFolderEntries(c, plan.swap.a, plan.swap.b);
    c.swap = { ...plan.swap };
  }
  interface Spot {
    track: CatalogTrack;
    /** Catalog folder the track belongs to. */
    home: string;
    /** Folder on the card the file is in now. */
    dir: string;
    gone?: boolean;
  }
  const spots: Spot[] = [];
  const at = new Map<string, Spot>();
  const key = (dir: string, file: string) => `${dir}/${file}`.toLowerCase();
  for (const [name, entry] of Object.entries(c.folders)) {
    for (const track of entry.tracks) {
      const spot: Spot = { track, home: name, dir: name };
      spots.push(spot);
      at.set(key(name, track.file), spot);
    }
  }
  const relocate = (dir: string, file: string, toDir: string, toFile: string) => {
    const spot = at.get(key(dir, file));
    if (!spot) return;
    at.delete(key(dir, file));
    // A file never replaces another, so an entry already there was stale.
    const stale = at.get(key(toDir, toFile));
    if (stale && stale !== spot) stale.gone = true;
    spot.dir = toDir;
    spot.track.file = toFile;
    at.set(key(toDir, toFile), spot);
  };

  /**
   * A file coming back from a helper folder ("Dateien zurücklegen"): its
   * entry waits in its folder under the name it was meant to come back
   * with: the old name, or the new one once the catalog has the new numbers
   * of a reorder (`renumbered`). It may come back under another name (the
   * old one was taken meanwhile, or the run stopped right after the catalog
   * switched). All of them move at once at the end, since the names of
   * several tracks can swap.
   */
  const returning: { spot: Spot; dir: string; file: string }[] = [];
  const back = (parked: string, dir: string, file: string) => {
    const h = parseHelperTrackName(parked);
    const was = h ? (c.folders[dir]?.renumbered ? h.newName : h.oldName) : parked;
    const spot = at.get(key(dir, was));
    if (!spot || spot.home !== dir) return;
    at.delete(key(dir, was));
    returning.push({ spot, dir, file });
  };

  for (const step of done) {
    if (step.op === 'delete' && step.path.length === 2) {
      const spot = at.get(key(step.path[0], step.path[1]));
      if (spot) spot.gone = true;
      at.delete(key(step.path[0], step.path[1]));
    } else if (step.op === 'title' && step.dir.length === 1) {
      // The words of the old name, now in the file's title: the catalog keeps them too when it has none.
      const spot = at.get(key(step.dir[0], step.file));
      if (spot && !spot.track.title?.trim()) spot.track.title = step.title;
    } else if (step.op === 'rename' && step.dir.length === 1) {
      relocate(step.dir[0], step.from, step.dir[0], step.to);
    } else if (step.op === 'rename' && step.dir.length === 0) {
      const from = parseFolderNumber(step.from);
      const to = parseFolderNumber(step.to);
      // A misnamed folder ("5" → "05") has no entry yet; nothing to carry over.
      if (from !== null && to !== null && c.folders[step.from] && !c.folders[step.to]) {
        c.folders[step.to] = c.folders[step.from];
        delete c.folders[step.from];
        for (const spot of spots.filter((s) => s.dir === step.from)) relocate(step.from, spot.track.file, step.to, spot.track.file);
        for (const spot of spots) if (spot.home === step.from) spot.home = step.to;
      }
    } else if (step.op === 'move' && step.from.length === 2 && step.toDir.length === 1) {
      if (parseTempDir(step.from[0]) !== undefined && !at.has(key(step.from[0], step.from[1]))) back(step.from[1], step.toDir[0], step.name);
      else relocate(step.from[0], step.from[1], step.toDir[0], step.name);
    } else if (step.op === 'rmdir' && step.path.length === 1 && parseFolderNumber(step.path[0]) !== null) {
      // Rebuilding a folder removes and recreates it; only a folder that stays gone leaves the catalog.
      const recreated = plan.steps.some((x) => x.op === 'mkdir' && x.path.length === 1 && x.path[0] === step.path[0]);
      if (!recreated) delete c.folders[step.path[0]];
    } else if (step.op === 'rmdir' && step.path.length === 1) {
      // The helper folder is gone: no track waits for its name any more.
      const n = parseTempDir(step.path[0]);
      if (n) delete c.folders[folderName(n)]?.renumbered;
    }
  }
  for (const r of returning) {
    const stale = at.get(key(r.dir, r.file));
    if (stale && stale !== r.spot) stale.gone = true;
    r.spot.dir = r.dir;
    r.spot.track.file = r.file;
    at.set(key(r.dir, r.file), r.spot);
  }

  const ran = (path: string[]) => done.some((s) => s.op === 'mkdir' && s.path.join('/') === path.join('/'));
  const lists = new Map<string, CatalogTrack[]>();
  for (const spot of spots) {
    if (spot.gone) continue;
    let dir = spot.dir;
    if (parseTempDir(dir) !== undefined) {
      // Waiting in a helper folder: the entry stays with its folder, under the name it comes back with.
      const h = ran([dir, REORDER_MARKER]) ? parseHelperTrackName(spot.track.file) : null;
      dir = spot.home;
      if (h) {
        const renumbered = ran([spot.dir, REORDER_DONE_MARKER]);
        spot.track.file = renumbered ? h.newName : h.oldName;
        const entry = c.folders[dir];
        if (entry && renumbered) entry.renumbered = true;
      }
    }
    if (!c.folders[dir]) continue;
    const list = lists.get(dir) ?? [];
    if (!list.some((t) => t.file.toLowerCase() === spot.track.file.toLowerCase())) list.push(spot.track);
    lists.set(dir, list);
  }
  for (const [name, entry] of Object.entries(c.folders)) entry.tracks = lists.get(name) ?? [];
}

/**
 * Picks the copy of a catalog (kept on this computer) that belongs to a card
 * whose own catalog is gone: every folder on the card has to be in it with
 * the same track count and size, and no other folder. Folder names alone
 * would also match another box with folders 01 to 05. The newest copy wins.
 */
export function matchLibraryCatalog(scan: SdScan, copies: Catalog[]): Catalog | null {
  if (scan.kind !== 'tonuino' || !scan.folders.length) return null;
  const fits = (c: Catalog) =>
    Object.keys(c.folders).length === scan.folders.length &&
    scan.folders.every((f) => {
      const fp = c.folders[f.name]?.fingerprint;
      return !!fp && fp === folderFingerprint(f);
    });
  return copies.filter(fits).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/** Records the folder as the app sees it now, so later changes by other programs stand out. */
export function touchFolder(c: Catalog, folder: SdFolder): void {
  const entry = c.folders[folder.name];
  if (!entry) return;
  entry.fingerprint = folderFingerprint(folder);
  entry.updatedAt = Date.now();
  // Noted with no file waiting (see updateCatalog): every name is what the card says.
  delete entry.renumbered;
  const files = new Map(folder.tracks.map((t) => [t.name.toLowerCase(), t.size]));
  entry.tracks = entry.tracks.filter((t) => files.has(t.file.toLowerCase()));
  for (const t of entry.tracks) t.size = files.get(t.file.toLowerCase());
  const order = new Map(folder.tracks.map((t, i) => [t.name.toLowerCase(), i]));
  entry.tracks.sort((a, b) => (order.get(a.file.toLowerCase()) ?? 0) - (order.get(b.file.toLowerCase()) ?? 0));
  if (entry.origins) {
    // Credits of tracks that are gone go with them.
    const used = new Set(entry.tracks.map((t) => t.origin));
    const origins = entry.origins.filter((o) => used.has(o.id));
    entry.origins = origins.length ? origins : undefined;
  }
}

/**
 * What changed in a folder since the app last noted it, by file name: tracks
 * that came in, tracks that are gone, and tracks swapped for another file of
 * the same name (only where the catalog knows the size). A catalog that knows
 * no track at all tells nothing about new ones.
 */
export function folderChanges(folder: SdFolder, entry: CatalogFolder): { added: string[]; missing: CatalogTrack[]; replaced: string[] } {
  const known = new Map(entry.tracks.map((t) => [t.file.toLowerCase(), t]));
  const onCard = new Set(folder.tracks.map((t) => t.name.toLowerCase()));
  const added: string[] = [];
  const replaced: string[] = [];
  for (const t of folder.tracks) {
    const k = known.get(t.name.toLowerCase());
    if (!k) {
      if (known.size) added.push(t.name);
    } else if (k.size !== undefined && k.size !== t.size) replaced.push(t.name);
  }
  return { added, missing: entry.tracks.filter((t) => !onCard.has(t.file.toLowerCase())), replaced };
}

/** Folder numbers 1-99 used neither on the card nor in the catalog. */
export function unusedFolderNumbers(scan: SdScan, c: Pick<Catalog, 'folders'> | null): number[] {
  const used = new Set<number>(scan.folders.map((f) => f.number));
  for (const key of Object.keys(c?.folders ?? {})) {
    const n = parseFolderNumber(key);
    if (n !== null) used.add(n);
  }
  const out: number[] = [];
  for (let n = 1; n <= MAX_FOLDER; n++) if (!used.has(n)) out.push(n);
  return out;
}

/**
 * After a folder got another number (planRenumberFolder): its special
 * cards, like a part of the folder, go with it. Returns their ids, so
 * "Karten beschreiben" can offer them ticked; the cards written before
 * still name the old number.
 */
export function moveExtraCards(c: Catalog, from: number, to: number): string[] {
  const moved: string[] = [];
  for (const x of c.extraCards) {
    if (x.folder !== from) continue;
    x.folder = to;
    moved.push(x.id);
  }
  return moved;
}

/**
 * A folder was deleted: its entry goes, and so do its special cards
 * (episode cards "von … bis …" included). They played what was in it; a
 * new album under the same number later must not take them over. Returns
 * the cover zip entries no folder or card shows any more: the folder's
 * picture and the pictures of its cards, e.g. the covers episodes kept
 * from their own folders before a series was packed (pack.ts). `entries`:
 * what the cover zip holds, so a picture under the folder's number that the
 * catalog had lost track of goes as well.
 */
export function forgetFolder(c: Catalog, folder: number, entries: Iterable<string> = []): string[] {
  const name = folderName(folder);
  const stray = [...entries].filter((e) => e.startsWith(`${name}.`));
  const pictures = [c.folders[name]?.cover, ...c.extraCards.filter((x) => x.folder === folder).map((x) => x.cover), ...stray];
  delete c.folders[name];
  c.extraCards = c.extraCards.filter((x) => x.folder !== folder);
  const shown = new Set([...Object.values(c.folders).map((f) => f.cover), ...c.extraCards.map((x) => x.cover)]);
  return [...new Set(pictures)].filter((e): e is string => !!e && !shown.has(e));
}

/**
 * Two folders swapped their numbers (planSwapFolders): titles, covers,
 * sticker settings and the special cards of each go with it, episode cards
 * included. The cover entry keeps its name here; swapCovers renames it.
 */
export function swapFolderEntries(c: Catalog, a: number, b: number): void {
  const na = folderName(a);
  const nb = folderName(b);
  const ea = c.folders[na];
  const eb = c.folders[nb];
  delete c.folders[na];
  delete c.folders[nb];
  if (ea) c.folders[nb] = ea;
  if (eb) c.folders[na] = eb;
  for (const x of c.extraCards) {
    if (x.folder === a) x.folder = b;
    else if (x.folder === b) x.folder = a;
  }
}

/** A folder card that plays one of several folders at random ("Hörbuch" with a last folder). */
export interface RangeCard {
  folder: number;
  title: string;
  last: number;
}

/**
 * Folder cards whose range of folders holds `from` or `to`, the moved
 * folder's own card included: after the move they play other folders than
 * before. The app does not change them by itself, only the user knows what
 * the range was meant for.
 */
export function rangeCardsTouching(c: Pick<Catalog, 'folders'>, from: number, to: number): RangeCard[] {
  const out: RangeCard[] = [];
  for (const [name, f] of Object.entries(c.folders)) {
    const n = parseFolderNumber(name);
    const span = f.card?.special2 ?? 0;
    const params = f.card ? modeByCode(f.card.mode)?.params : undefined;
    if (n === null || span <= 0 || (params !== 'folderRange' && params !== 'folderRangeTracks')) continue;
    const last = n + span;
    if ((from >= n && from <= last) || (to >= n && to <= last)) out.push({ folder: n, title: f.title, last });
  }
  return out.sort((a, b) => a.folder - b.folder);
}

/**
 * Sticker colour, picture section and the sticker's own orientation (Quer or
 * Hoch) were chosen for the old picture; the text on the sticker and the
 * shelf card's recipe stay.
 */
export function dropPictureTweaks(f: CatalogFolder): void {
  f.color = undefined;
  if (!f.sticker) return;
  const kept: StickerTweaks = {};
  if (f.sticker.title !== undefined) kept.title = f.sticker.title;
  // The shelf card's recipe is chosen for the folder, not for the picture.
  if (f.sticker.recipe !== undefined) kept.recipe = f.sticker.recipe;
  f.sticker = Object.keys(kept).length ? kept : undefined;
}
