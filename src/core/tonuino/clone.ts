import type { Dir } from '../../platform/types';
import type { FirmwareProfile } from './card';
import { newCatalog, newId, saveCatalog, type Catalog } from './catalog';
import { saveCovers, type CoverMap } from './covers';
import { bytesOnCard, copyEntries, folderFiles, systemFiles, totalBytes, type BackupEntry, type CopyProgress } from './rebuild';
import { folderName, scanSd, type SdScan, type SystemDirName } from './sd';

/**
 * Folders of this card onto another SD card (a second box, the one at
 * Grandma's). Every folder keeps its number on the other card, so the
 * cards that play it here play it there too. A number that is taken there
 * is never changed: the folder is left out, or, once the user confirms,
 * the other card's folder is replaced. Titles, covers and card settings go
 * along into the other card's catalog. The plan comes first; nothing is
 * written before the user saw it.
 */

export type CloneAction = 'copy' | 'skip' | 'replace';

export interface CloneFolder {
  number: number;
  /** The folder's name on both cards, e.g. "05". */
  name: string;
  title: string;
  files: number;
  bytes: number;
  /** The number is taken on the other card. */
  taken: boolean;
  /** Title of what is there on the other card. */
  targetTitle?: string;
  /** Name of that folder on the other card. */
  targetName?: string;
  action: CloneAction;
}

export interface CloneSystem {
  name: SystemDirName;
  /** Name on this card ("mp3", or "MP3"). */
  dirName: string;
  files: number;
  bytes: number;
  taken: boolean;
  targetName?: string;
  action: CloneAction;
}

export interface ClonePlan {
  system: CloneSystem[];
  folders: CloneFolder[];
  /** What to copy, in order: mp3, advert, then the folders by number. */
  entries: BackupEntry[];
  /** Folders on the other card to remove first, because the user chose to replace them. */
  remove: string[];
  files: number;
  bytes: number;
}

export interface CloneInput {
  source: SdScan;
  sourceCatalog: Catalog | null;
  /** Folder numbers to copy. */
  folders: readonly number[];
  /** Copy mp3/ and advert/ (the announcements) too. */
  sounds: boolean;
  target: SdScan;
  targetCatalog: Catalog | null;
  /** What to do with a taken number (folder number, or "mp3" / "advert"); 'skip' unless said otherwise. */
  decisions?: ReadonlyMap<number | SystemDirName, 'skip' | 'replace'>;
}

export function planClone(i: CloneInput): ClonePlan {
  const decide = (k: number | SystemDirName, taken: boolean): CloneAction => (taken ? (i.decisions?.get(k) ?? 'skip') : 'copy');
  const system: CloneSystem[] = [];
  if (i.sounds) {
    for (const name of ['mp3', 'advert'] as const) {
      const s = i.source.system[name];
      if (!s) continue;
      const files = systemFiles(s);
      if (!files.length) continue;
      const there = i.target.system[name];
      system.push({
        name,
        dirName: s.dirName,
        files: files.length,
        bytes: totalBytes(files),
        taken: !!there,
        targetName: there?.dirName,
        action: decide(name, !!there),
      });
    }
  }
  const wanted = new Set(i.folders);
  const folders: CloneFolder[] = [];
  for (const f of [...i.source.folders].sort((a, b) => a.number - b.number)) {
    if (!wanted.has(f.number)) continue;
    const files = folderFiles(f);
    const there = i.target.folders.find((t) => t.number === f.number);
    folders.push({
      number: f.number,
      name: f.name,
      title: i.sourceCatalog?.folders[f.name]?.title || `Ordner ${f.name}`,
      files: files.length,
      bytes: totalBytes(files),
      taken: !!there,
      targetTitle: there ? i.targetCatalog?.folders[there.name]?.title || `Ordner ${there.name}` : undefined,
      targetName: there?.name,
      action: decide(f.number, !!there),
    });
  }
  const entries: BackupEntry[] = [];
  const remove: string[] = [];
  for (const s of system) {
    if (s.action === 'skip') continue;
    if (s.action === 'replace' && s.targetName) remove.push(s.targetName);
    entries.push(...systemFiles(i.source.system[s.name]!));
  }
  for (const f of folders) {
    if (f.action === 'skip') continue;
    if (f.action === 'replace' && f.targetName) remove.push(f.targetName);
    entries.push(...folderFiles(i.source.folders.find((x) => x.number === f.number)!));
  }
  return { system, folders, entries, remove, files: entries.length, bytes: totalBytes(entries) };
}

/** Cluster size of a FAT32 card from 8 to 32 GB, when the platform does not say. */
export const DEFAULT_CLUSTER = 32 * 1024;

/**
 * The room the copy needs on the other card: every file in whole clusters
 * (a 1-byte file takes a whole cluster on FAT), its folders, and the covers
 * that come along, the catalog as it will be written, less what the folders
 * it replaces free. To compare with the free space the platform reports.
 * Each replaced folder counts with its tracks only, and the catalog with its
 * whole new size (it is written anew before the old one goes), so the free
 * space is never overrated.
 */
export function cloneSpace(
  plan: ClonePlan,
  target: SdScan,
  opts: { cluster?: number; coverBytes?: number; catalogBytes?: number } = {},
): { need: number; freed: number; net: number } {
  const cluster = opts.cluster && opts.cluster > 0 ? opts.cluster : DEFAULT_CLUSTER;
  const clusters = (bytes?: number) => (bytes ? Math.ceil(bytes / cluster) * cluster : 0);
  const need = bytesOnCard(plan.entries, cluster) + clusters(opts.coverBytes) + clusters(opts.catalogBytes);
  const gone: BackupEntry[] = [];
  for (const name of plan.remove) {
    const f = target.folders.find((x) => x.name === name);
    const s = Object.values(target.system).find((x) => x?.dirName === name);
    gone.push(...(f ? folderFiles(f) : s ? systemFiles(s) : []));
  }
  const freed = gone.length ? bytesOnCard(gone, cluster) : 0;
  return { need, freed, net: Math.max(0, need - freed) };
}

/** What the other box runs, as far as anyone knows. */
export type OtherFirmware = FirmwareProfile | 'unknown';

/**
 * Whether the announcements (mp3/, advert/) may go along: only to a box
 * known to run the same firmware. Announcements of another firmware or
 * version make the box say the wrong things or nothing (forum 14326#9).
 */
export function soundsFit(source: FirmwareProfile | undefined, other: OtherFirmware): boolean {
  return !!source && other !== 'unknown' && source === other;
}

export const FIRMWARE_NAMES: Record<FirmwareProfile, string> = { tng: 'TonUINO TNG', classic21: 'TonUINO 2.1' };

/** Start of the folder made on the computer for another card: "TonUINO-Kopie 06.10.2026". */
export const EXPORT_PREFIX = 'TonUINO-Kopie';

/**
 * Where the copy goes when the user picked a folder on the computer (to
 * take to the other card by hand): the folder itself when it is empty or
 * holds a TonUINO layout already (an earlier copy), else a new
 * "TonUINO-Kopie <Datum>" inside it. Nothing that was there is touched.
 */
export async function prepareExportFolder(picked: Dir, now: Date = new Date()): Promise<{ dir: Dir; scan: SdScan; made?: string }> {
  const scan = await scanSd(picked);
  if (scan.kind !== 'foreign') return { dir: picked, scan };
  const p2 = (n: number) => String(n).padStart(2, '0');
  const base = `${EXPORT_PREFIX} ${p2(now.getDate())}.${p2(now.getMonth() + 1)}.${now.getFullYear()}`;
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base} (${i})`;
    if (await picked.exists(name)) {
      const there = await picked.dir(name).catch(() => null);
      if (!there) continue;
      const s = await scanSd(there).catch(() => null);
      // Today's earlier copy goes on; anything else of that name stays as it is.
      if (s && s.kind !== 'foreign') return { dir: there, scan: s, made: name };
      continue;
    }
    const dir = await picked.dir(name, { create: true });
    return { dir, scan: await scanSd(dir), made: name };
  }
}

/** "Ordner 05 ist auf der anderen Karte schon belegt („Bibi Blocksberg 3“). Nummern ändere ich nicht." */
export function takenText(f: Pick<CloneFolder, 'name' | 'targetTitle'>): string {
  const what = f.targetTitle && f.targetTitle !== `Ordner ${f.name}` ? ` („${f.targetTitle}“)` : '';
  return `Ordner ${f.name} ist auf der anderen Karte schon belegt${what}. Nummern ändere ich nicht.`;
}

/** Folders of the plan that end up on the other card. */
export function copiedFolders(plan: ClonePlan): CloneFolder[] {
  return plan.folders.filter((f) => f.action !== 'skip');
}

/**
 * The other card's catalog after the copy: each copied folder brings its
 * entry (title, tracks, cover, how its card plays it) and its extra cards
 * along. A replaced folder's old entry and extra cards go. Without a
 * catalog there, a new one is made with `name` and `profile` (the other
 * box's firmware as the user said; else this card's).
 */
export function cloneCatalog(target: Catalog | null, source: Catalog | null, plan: ClonePlan, opts: { name?: string; now?: number; profile?: FirmwareProfile } = {}): Catalog {
  const now = opts.now ?? Date.now();
  const c: Catalog = target ? structuredClone(target) : newCatalog(opts.name?.trim() || 'Meine TonUINO-Box', opts.profile ?? source?.profile ?? 'tng');
  const copied = copiedFolders(plan);
  const numbers = new Set(copied.map((f) => f.number));
  for (const f of copied) {
    const entry = source?.folders[f.name];
    if (entry) c.folders[folderName(f.number)] = { ...structuredClone(entry), updatedAt: now };
    else delete c.folders[folderName(f.number)];
  }
  // Extra cards of a replaced folder belonged to what was there before.
  c.extraCards = c.extraCards.filter((x) => !numbers.has(x.folder));
  const ids = new Set(c.extraCards.map((x) => x.id));
  for (const x of source?.extraCards ?? []) {
    if (!numbers.has(x.folder)) continue;
    const id = ids.has(x.id) ? newId() : x.id;
    ids.add(id);
    c.extraCards.push({ ...x, id });
  }
  if (plan.system.some((s) => s.action !== 'skip') && source?.systemSounds) c.systemSounds = { ...source.systemSounds };
  c.updatedAt = now;
  return c;
}

/** The other card's covers after the copy: the copied folders' covers replace whatever had their number, their cards' own pictures come along. */
export function cloneCovers(target: CoverMap, source: CoverMap, sourceCatalog: Catalog | null, plan: ClonePlan): CoverMap {
  const out: CoverMap = new Map(target);
  for (const f of copiedFolders(plan)) {
    const prefix = `${f.name}.`;
    for (const k of [...out.keys()]) if (k.startsWith(prefix)) out.delete(k);
    const entry = sourceCatalog?.folders[f.name]?.cover;
    const bytes = entry ? source.get(entry) : undefined;
    if (entry && bytes) out.set(entry, bytes);
  }
  // The episodes of a packed series bring the pictures of their own cards along (ExtraCard.cover, pack.ts).
  const numbers = new Set(copiedFolders(plan).map((f) => f.number));
  for (const x of sourceCatalog?.extraCards ?? []) {
    const bytes = x.cover && numbers.has(x.folder) ? source.get(x.cover) : undefined;
    if (x.cover && bytes) out.set(x.cover, bytes);
  }
  return out;
}

export interface CloneOptions {
  catalog: Catalog;
  covers: CoverMap;
  signal?: AbortSignal;
  onProgress?: (p: CopyProgress) => void;
}

/**
 * Carries out a plan: removes the folders the user chose to replace on the
 * other card, copies mp3, advert and the folders in order (each file
 * checked by its size and CRC), then writes the other card's catalog and covers.
 * This card is only read.
 */
export async function executeClone(source: Dir, target: Dir, plan: ClonePlan, opts: CloneOptions): Promise<void> {
  for (const name of plan.remove) {
    opts.signal?.throwIfAborted();
    await target.remove(name, { recursive: true });
  }
  // Every file checked like in a backup: a card that loses data shows here, not in the box.
  await copyEntries(source, target, plan.entries, { signal: opts.signal, onProgress: opts.onProgress, verify: true });
  opts.signal?.throwIfAborted();
  await saveCatalog(target, opts.catalog);
  await saveCovers(target, opts.covers);
}
