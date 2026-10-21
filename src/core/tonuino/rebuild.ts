import type { ByteSource, Dir, DirEntry, VolumeInfo, WriteOptions } from '../../platform/types';
import { crc32, crc32OfBlob } from '../zip/crc32';
import { isFatFilesystem } from './health';
import { entryOrder } from './package';
import { CATALOG_FILE, COVERS_FILE, parseFolderNumber, type SdFolder, type SdScan, type SdSystemDir } from './sd';

/**
 * Rebuilding a card the way the forum advises (13455, 6249, 9690): back up
 * everything the box plays to a folder on the computer, format the card,
 * then write it all back in one go and in the right order: mp3, advert,
 * 01 … 99, inside each folder the tracks by number, the app's catalog and
 * covers last. Every folder keeps its number and every file its name, so
 * the cards keep working. Nothing here ever deletes a file on the card.
 *
 * The backup folder holds a manifest with the size and CRC-32 of every
 * file. A backup that stopped half-way goes on from it, and the restore
 * checks every file against it before writing.
 */

export const BACKUP_MANIFEST = 'tonuino-studio-sicherung.json';
export const BACKUP_FORMAT = 1;
/** Start of the backup folder's name: "TonUINO-Sicherung Emmas TonUINO 06.10.2026". */
export const BACKUP_PREFIX = 'TonUINO-Sicherung';

/** One file of the card: its folder ('' for the root, 'mp3', '05', …), its name and size. */
export interface BackupEntry {
  dir: string;
  name: string;
  size: number;
}

/** A file in the backup, as copied and checked. */
export interface ManifestFile {
  path: string;
  size: number;
  crc32: number;
}

export interface BackupManifest {
  app: 'tonuino-studio';
  kind: 'sicherung';
  format: number;
  /** Name of the box, from the card's catalog. */
  boxName: string;
  /** Catalog id of the card, so a later backup of the same card can go on with this one. */
  catalogId?: string;
  createdAt: number;
  updatedAt: number;
  /** Every planned file is in `files`, copied and checked. */
  complete: boolean;
  /** Files and bytes the backup was planned with. */
  planned: { files: number; bytes: number };
  files: ManifestFile[];
  /**
   * When writing this backup back to a card began. Only then can a card
   * that holds part of the backup be a restore to go on with; before, it
   * is the old card, not formatted yet.
   */
  restoreStartedAt?: number;
}

export function entryPath(e: Pick<BackupEntry, 'dir' | 'name'>): string {
  return e.dir ? `${e.dir}/${e.name}` : e.name;
}

const key = (path: string) => path.toLowerCase();

/* ------------------------------------------------------------------ plan */

const byName = (a: { name: string }, b: { name: string }) => entryOrder(a.name, b.name);

/** The audio files of a box folder the box can find or the health check can name: tracks, wrong digit counts, unnumbered. */
export function folderFiles(f: SdFolder): BackupEntry[] {
  const files = [
    ...f.tracks.map((t) => ({ name: t.name, size: t.size })),
    ...f.wrongDigits.map((t) => ({ name: t.name, size: t.size })),
    ...f.unnumbered.map((e) => ({ name: e.name, size: e.size ?? 0 })),
  ];
  return files.sort(byName).map((x) => ({ dir: f.name, ...x }));
}

/** The numbered announcements of mp3/ or advert/. */
export function systemFiles(s: SdSystemDir): BackupEntry[] {
  const files = [...s.files, ...s.wrongDigits].map((t) => ({ name: t.name, size: t.size }));
  return files.sort(byName).map((x) => ({ dir: s.dirName, ...x }));
}

/**
 * What a backup of the card holds, in the order it is written back:
 * mp3, advert, 01 … 99 (audio only, junk and other files stay out), then
 * the catalog and the covers. `root` is the listing of the card's root,
 * for the sizes and real names of the app's two files.
 */
export function planBackup(scan: SdScan, root: readonly DirEntry[] = []): BackupEntry[] {
  const out: BackupEntry[] = [];
  for (const name of ['mp3', 'advert'] as const) {
    const s = scan.system[name];
    if (s) out.push(...systemFiles(s));
  }
  for (const f of [...scan.folders].sort((a, b) => a.number - b.number)) out.push(...folderFiles(f));
  const appFile = (want: string) => {
    const e = root.find((x) => x.kind === 'file' && x.name.toLowerCase() === want);
    return { dir: '', name: e?.name ?? want, size: e?.size ?? 0 };
  };
  if (scan.hasCatalog) out.push(appFile(CATALOG_FILE));
  if (scan.hasCovers) out.push(appFile(COVERS_FILE));
  return out;
}

export function totalBytes(entries: readonly { size: number }[]): number {
  return entries.reduce((n, e) => n + e.size, 0);
}

/**
 * What is on the card but not in a backup: other files in the box's
 * folders (pictures, playlists, music the box cannot play), sub-folders,
 * other folders and files in the root. Junk is not listed. Folders end with
 * "/". After formatting these are gone, so the dialog names them first.
 */
export function leftOut(scan: SdScan): string[] {
  const out: string[] = [];
  const name = (e: DirEntry) => (e.kind === 'directory' ? `${e.name}/` : e.name);
  for (const s of [scan.system.mp3, scan.system.advert]) {
    if (s) for (const e of s.others) out.push(`${s.dirName}/${name(e)}`);
  }
  for (const f of scan.folders) {
    for (const e of [...f.others, ...f.subfolders]) out.push(`${f.name}/${name(e)}`);
  }
  for (const e of [...scan.invalidFolders, ...scan.rootOthers]) out.push(name(e));
  return out;
}

/**
 * Why a card cannot be backed up yet: files of an interrupted repair wait in
 * a helper folder. They would be lost; the health check puts them back.
 */
export function backupBlocker(scan: SdScan): 'temp' | null {
  return scan.tempDirs.length ? 'temp' : null;
}

/* ------------------------------------------------------------------ names, time */

const p2 = (n: number) => String(n).padStart(2, '0');

/** "TonUINO-Sicherung Emmas TonUINO 06.10.2026": no characters Windows, macOS or FAT refuse. */
export function backupFolderName(boxName: string, at: Date): string {
  const box = boxName
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 40)
    .trim();
  const date = `${p2(at.getDate())}.${p2(at.getMonth() + 1)}.${at.getFullYear()}`;
  return box ? `${BACKUP_PREFIX} ${box} ${date}` : `${BACKUP_PREFIX} ${date}`;
}

/** Bytes per second a card is read and written with, roughly (cheap readers and older cards are slower). */
export const READ_SPEED = 25_000_000;
export const WRITE_SPEED = 12_000_000;

/** Minutes for backing up and writing back `bytes`, rounded up to whole minutes (formatting not included). */
export function estimateMinutes(bytes: number): number {
  return Math.max(1, Math.ceil((bytes / READ_SPEED + bytes / WRITE_SPEED) / 60));
}

/** "ein paar Minuten", "etwa 20 Minuten", "etwa 1 Stunde 10 Minuten". */
export function durationText(minutes: number): string {
  if (minutes < 5) return 'ein paar Minuten';
  if (minutes < 60) return `etwa ${Math.round(minutes / 5) * 5} Minuten`;
  const rounded = Math.round(minutes / 10) * 10;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return `etwa ${h === 1 ? '1 Stunde' : `${h} Stunden`}${m ? ` ${m} Minuten` : ''}`;
}

/* ------------------------------------------------------------------ manifest */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Reads a backup manifest; null when it is none (or broken). */
export function parseBackupManifest(text: string): BackupManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.app !== 'tonuino-studio' || raw.kind !== 'sicherung' || !Array.isArray(raw.files)) return null;
  const files: ManifestFile[] = [];
  for (const f of raw.files) {
    if (!isObj(f) || typeof f.path !== 'string' || !isNum(f.size) || !isNum(f.crc32)) return null;
    if (!safePath(f.path)) return null;
    files.push({ path: f.path, size: f.size, crc32: f.crc32 >>> 0 });
  }
  const planned = isObj(raw.planned) && isNum(raw.planned.files) && isNum(raw.planned.bytes) ? { files: raw.planned.files, bytes: raw.planned.bytes } : { files: files.length, bytes: totalBytes(files) };
  return {
    app: 'tonuino-studio',
    kind: 'sicherung',
    format: isNum(raw.format) ? raw.format : BACKUP_FORMAT,
    boxName: typeof raw.boxName === 'string' ? raw.boxName : '',
    catalogId: typeof raw.catalogId === 'string' ? raw.catalogId : undefined,
    createdAt: isNum(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : 0,
    complete: raw.complete === true,
    planned,
    files,
    ...(isNum(raw.restoreStartedAt) ? { restoreStartedAt: raw.restoreStartedAt } : {}),
  };
}

/** Notes in the backup that writing it back begins now (see BackupManifest.restoreStartedAt). */
export async function markRestoreStarted(dir: Dir, manifest: BackupManifest, now = Date.now()): Promise<BackupManifest> {
  if (manifest.restoreStartedAt) return manifest;
  const next = { ...manifest, restoreStartedAt: now };
  await dir.write(BACKUP_MANIFEST, new TextEncoder().encode(serializeBackupManifest(next)));
  return next;
}

/** A path in a manifest: one folder level at most, no way out of the backup folder. */
function safePath(path: string): boolean {
  const parts = path.split('/');
  return parts.length <= 2 && parts.every((p) => p && p !== '.' && p !== '..' && !p.includes('\\'));
}

export function serializeBackupManifest(m: BackupManifest): string {
  return JSON.stringify(m, null, 1) + '\n';
}

/** The manifest in a backup folder, null when there is none or it cannot be read. */
export async function readBackupManifest(dir: Dir): Promise<BackupManifest | null> {
  try {
    if (!(await dir.exists(BACKUP_MANIFEST))) return null;
    return parseBackupManifest(new TextDecoder().decode(await dir.read(BACKUP_MANIFEST)));
  } catch {
    return null;
  }
}

/** A backup folder found next to others: its name and manifest. */
export interface FoundBackup {
  name: string;
  manifest: BackupManifest;
}

/**
 * Backup folders inside `parent` ("TonUINO-Sicherung …" with a manifest),
 * newest first. `parent` may also be a backup folder itself: then it is the
 * only one, under the name ''.
 */
export async function findBackups(parent: Dir): Promise<FoundBackup[]> {
  const own = await readBackupManifest(parent);
  if (own) return [{ name: '', manifest: own }];
  const out: FoundBackup[] = [];
  let entries: DirEntry[] = [];
  try {
    entries = await parent.list();
  } catch {
    return [];
  }
  for (const e of entries) {
    if (e.kind !== 'directory' || !e.name.startsWith(BACKUP_PREFIX)) continue;
    try {
      const m = await readBackupManifest(await parent.dir(e.name));
      if (m) out.push({ name: e.name, manifest: m });
    } catch {
      // A folder that cannot be read is no backup to go on with.
    }
  }
  return out.sort((a, b) => b.manifest.updatedAt - a.manifest.updatedAt);
}

/* ------------------------------------------------------------------ copy */

export interface CopyProgress {
  /** Files done (copied, or found done before) and planned. */
  files: number;
  totalFiles: number;
  /** Work done and to do, in bytes: copying counts once, each check reads a bit faster. */
  done: number;
  total: number;
  /** The file being copied or checked. */
  current?: string;
}

export interface CopyOptions {
  onProgress?: (p: CopyProgress) => void;
  signal?: AbortSignal;
  /**
   * Making a backup: `to` is the backup folder. Its manifest says what is
   * there already; each file is checked after copying (size and CRC of
   * original and copy) and noted in the manifest.
   */
  backup?: { boxName: string; catalogId?: string };
  /**
   * Restoring: the size and CRC every file of the backup must have. A file
   * that differs is not written. Files already on `to` with the right size
   * count as done, so an interrupted restore goes on where it stopped.
   */
  expected?: readonly ManifestFile[];
  /**
   * Copying to another card: each file is checked after copying like in a
   * backup (size and CRC of original and copy), without a manifest.
   */
  verify?: boolean;
  /** Clock for the manifest (tests). */
  now?: () => number;
}

export interface CopyResult {
  copied: number;
  /** Files that were there and right already. */
  skipped: number;
  manifest?: BackupManifest;
}

/** What went wrong with which file: reading the original, writing the copy, or the check after it. */
export class CopyError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly stage: 'read' | 'write' | 'check' | 'damaged',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CopyError';
  }
}

/** A Dir that can copy a file natively, without the bytes passing through the page (desktop). */
interface NativeCopyDir extends Dir {
  copyFrom(name: string, source: ByteSource, opts?: WriteOptions): Promise<void>;
}

function hasNativeCopy(d: Dir): d is NativeCopyDir {
  return typeof (d as Partial<NativeCopyDir>).copyFrom === 'function';
}

const CHUNK = 4 * 1024 * 1024;
/** A check reads; reading goes about twice as fast as writing. */
const CHECK_WEIGHT = 0.5;
const MANIFEST_EVERY_MS = 3000;

const isAbort = (e: unknown) => (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';

/** CRC-32 of a file, read in pieces. */
export async function crcOfSource(src: ByteSource, opts: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {}): Promise<number> {
  if (src.blob) return crc32OfBlob(src.blob, opts);
  let crc = 0;
  for (let pos = 0; pos < src.size; pos += CHUNK) {
    opts.signal?.throwIfAborted();
    const part = await src.read(pos, Math.min(CHUNK, src.size - pos));
    if (!part.length) break;
    crc = crc32(part, crc);
    opts.onProgress?.(Math.min(src.size, pos + part.length));
  }
  return crc;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Copies `list` from `from` to `to`, folder by folder in list order, and
 * checks every file. Creates folders on `to` as needed, never removes
 * anything on either side. With `backup` it goes on from the manifest in
 * `to`; with `expected` from what `to` holds already (see CopyOptions).
 * Throws a CopyError (or the AbortError) and stops at the first file that
 * could not be copied right.
 */
export async function copyEntries(from: Dir, to: Dir, list: readonly BackupEntry[], opts: CopyOptions = {}): Promise<CopyResult> {
  const now = opts.now ?? Date.now;
  const backup = opts.backup;
  /** Original and copy are compared byte for byte (by their CRC), not only by size. */
  const compare = !!backup || !!opts.verify;
  const crcPasses = compare ? 2 : opts.expected ? 1 : 0;
  const weight = 1 + crcPasses * CHECK_WEIGHT;
  const total = list.reduce((n, e) => n + e.size * weight, 0);
  let done = 0;
  let files = 0;
  const report = (current?: string, extra = 0) => opts.onProgress?.({ files, totalFiles: list.length, done: Math.min(total, done + extra), total, current });

  const fromDirs = new Map<string, Dir>();
  const toDirs = new Map<string, Dir>();
  const dirOf = async (root: Dir, cache: Map<string, Dir>, name: string, create: boolean): Promise<Dir> => {
    if (!name) return root;
    const k = key(name);
    let d = cache.get(k);
    if (!d) {
      d = await root.dir(name, { create });
      cache.set(k, d);
    }
    return d;
  };

  const expected = new Map((opts.expected ?? []).map((f) => [key(f.path), f]));
  let manifest: BackupManifest | undefined;
  const recorded = new Map<string, ManifestFile>();
  if (backup) {
    const found = await readBackupManifest(to);
    // Only a backup of the same card: anything else in the folder is not ours to go on with.
    const old = found && (!found.catalogId || !backup.catalogId || found.catalogId === backup.catalogId) ? found : null;
    for (const f of old?.files ?? []) recorded.set(key(f.path), f);
    manifest = {
      app: 'tonuino-studio',
      kind: 'sicherung',
      format: BACKUP_FORMAT,
      boxName: backup.boxName,
      catalogId: backup.catalogId,
      createdAt: old?.createdAt || now(),
      updatedAt: now(),
      complete: false,
      planned: { files: list.length, bytes: totalBytes(list) },
      files: [],
    };
  }
  const checked = new Map<string, ManifestFile>();
  let lastSave = 0;
  const saveManifest = async (complete: boolean) => {
    if (!manifest) return;
    // Only the planned files, in plan order: what the card no longer has does not come back.
    manifest.files = list.flatMap((e) => checked.get(key(entryPath(e))) ?? []);
    manifest.complete = complete;
    manifest.updatedAt = now();
    await to.write(BACKUP_MANIFEST, new TextEncoder().encode(serializeBackupManifest(manifest)));
    lastSave = Date.now();
  };
  // Files found right before stay in the manifest even when this run stops early.
  const keepRecorded = () => {
    for (const e of list) {
      const p = key(entryPath(e));
      const r = recorded.get(p);
      if (r && !checked.has(p)) checked.set(p, r);
    }
  };

  let copied = 0;
  let skipped = 0;
  try {
    for (const e of list) {
      opts.signal?.throwIfAborted();
      const path = entryPath(e);
      report(path);
      let src: ByteSource;
      let srcDir: Dir;
      try {
        srcDir = await dirOf(from, fromDirs, e.dir, false);
        src = await srcDir.source(e.name);
      } catch (err) {
        if (isAbort(err)) throw err;
        throw new CopyError(`„${path}“ ließ sich nicht lesen. ${message(err)}`, path, 'read', { cause: err });
      }
      const dstDir = await dirOf(to, toDirs, e.dir, true).catch((err: unknown) => {
        throw new CopyError(`Der Ordner „${e.dir}“ ließ sich nicht anlegen. ${message(err)}`, path, 'write', { cause: err });
      });
      const want = expected.get(key(path));
      if (opts.expected && !want) throw new CopyError(`„${path}“ fehlt in der Liste der Sicherung.`, path, 'damaged');

      // Done before: in the manifest (backup), or on the card already (restore).
      const there = await targetSize(dstDir, e.name);
      const rec = recorded.get(key(path));
      if (backup && rec && rec.size === src.size && there === rec.size) {
        // Checked once more, the backup may have been touched since.
        const crc = await crcOfSource(await dstDir.source(e.name), { signal: opts.signal, onProgress: (b) => report(path, (b * CHECK_WEIGHT * e.size) / Math.max(1, src.size)) });
        if (crc === rec.crc32) {
          checked.set(key(path), rec);
          done += e.size * weight;
          files++;
          skipped++;
          continue;
        }
      }
      if (want && there === want.size) {
        done += e.size * weight;
        files++;
        skipped++;
        continue;
      }

      const base = done;
      let srcCrc: number | undefined;
      if (want) {
        srcCrc = await readCrc(src, path, opts.signal, (b) => report(path, b * CHECK_WEIGHT));
        if (srcCrc !== want.crc32 || src.size !== want.size) {
          throw new CopyError(`„${path}“ in der Sicherung ist beschädigt. Ich hab die Datei nicht auf die Karte geschrieben.`, path, 'damaged');
        }
        done = base + src.size * CHECK_WEIGHT;
      }

      // One more try when a check fails: a copy can go wrong once without the card being bad.
      let ok: ManifestFile | null = null;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        const start = done;
        await writeOne(srcDir, dstDir, e.name, src, path, opts.signal, (b) => report(path, b));
        done = start + src.size;
        const size = await targetSize(dstDir, e.name);
        if (size !== src.size) {
          if (attempt === 1) throw new CopyError(`„${path}“ kam nicht vollständig an (${size ?? 0} statt ${src.size} Bytes).`, path, 'check');
          done = start;
          continue;
        }
        if (!compare) {
          ok = { path, size, crc32: srcCrc ?? 0 };
          break;
        }
        srcCrc ??= await readCrc(src, path, opts.signal, (b) => report(path, b * CHECK_WEIGHT));
        done = start + src.size * (1 + CHECK_WEIGHT);
        const dstCrc = await readCrc(await dstDir.source(e.name), path, opts.signal, (b) => report(path, b * CHECK_WEIGHT));
        done = start + src.size * (1 + 2 * CHECK_WEIGHT);
        if (dstCrc === srcCrc) ok = { path, size, crc32: srcCrc };
        else if (attempt === 1) throw new CopyError(`„${path}“ kam nicht heil an: Die Kopie weicht vom Original ab.`, path, 'check');
        else {
          done = start;
          srcCrc = undefined;
        }
      }
      checked.set(key(path), ok!);
      done = base + e.size * weight;
      files++;
      copied++;
      if (manifest && Date.now() - lastSave > MANIFEST_EVERY_MS) await saveManifest(false);
    }
  } catch (err) {
    if (manifest) {
      keepRecorded();
      await saveManifest(false).catch(() => undefined);
    }
    throw err;
  }
  report();
  if (manifest) await saveManifest(true);
  return { copied, skipped, manifest };
}

/** Size of a file in `dir`, undefined when it is not there. */
async function targetSize(dir: Dir, name: string): Promise<number | undefined> {
  try {
    return (await dir.source(name)).size;
  } catch {
    return undefined;
  }
}

async function readCrc(src: ByteSource, path: string, signal: AbortSignal | undefined, onProgress: (b: number) => void): Promise<number> {
  try {
    return await crcOfSource(src, { signal, onProgress });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new CopyError(`„${path}“ ließ sich nicht lesen. ${message(err)}`, path, 'read', { cause: err });
  }
}

async function writeOne(srcDir: Dir, dstDir: Dir, name: string, src: ByteSource, path: string, signal: AbortSignal | undefined, onProgress: (b: number) => void): Promise<void> {
  try {
    if (hasNativeCopy(dstDir) && src.path) {
      await dstDir.copyFrom(name, src, { signal, onProgress });
      return;
    }
    const data = src.blob ?? (await srcDir.read(name));
    await dstDir.write(name, data, { signal, onProgress });
  } catch (err) {
    if (isAbort(err) || signal?.aborted) throw err;
    throw new CopyError(`„${path}“ ließ sich nicht schreiben. ${message(err)}`, path, 'write', { cause: err });
  }
}

/* ------------------------------------------------------------------ restore */

/** Rank of a top-level folder when writing back: mp3, advert, 01 … 99, anything else. */
function dirRank(dir: string): [number, number] {
  const d = dir.toLowerCase();
  if (d === 'mp3') return [0, 0];
  if (d === 'advert') return [1, 0];
  const n = parseFolderNumber(dir);
  if (n !== null) return [2, n];
  if (!dir) return [4, 0];
  return [3, 0];
}

function rootRank(name: string): number {
  const n = name.toLowerCase();
  return n === CATALOG_FILE ? 0 : n === COVERS_FILE ? 1 : 2;
}

/** The files of a backup in the order the card gets them back. */
export function restoreOrder(files: readonly ManifestFile[]): BackupEntry[] {
  const entries = files.map((f) => {
    const i = f.path.indexOf('/');
    return i < 0 ? { dir: '', name: f.path, size: f.size } : { dir: f.path.slice(0, i), name: f.path.slice(i + 1), size: f.size };
  });
  return entries.sort((a, b) => {
    const ra = dirRank(a.dir);
    const rb = dirRank(b.dir);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[1] !== rb[1]) return ra[1] - rb[1];
    if (a.dir !== b.dir) return a.dir < b.dir ? -1 : 1;
    if (!a.dir) return rootRank(a.name) - rootRank(b.name) || entryOrder(a.name, b.name);
    return entryOrder(a.name, b.name);
  });
}

export type RestorePlan =
  | {
      ok: true;
      entries: BackupEntry[];
      files: number;
      bytes: number;
      /** Part of the backup is on the card already: the restore goes on. */
      resume: boolean;
      /** Files of the restore order that are on the card already, complete (with `resume`). */
      present: number;
    }
  | { ok: false; reason: 'incomplete' }
  | { ok: false; reason: 'not-empty'; items: string[] };

/** Everything on a scanned card, as paths ("05/001.mp3", "Fotos/"), junk left out. `root` gives the app files' sizes. */
function cardItems(scan: SdScan, root: readonly DirEntry[] = []): { path: string; size?: number }[] {
  const rootSize = (name: string) => root.find((e) => e.kind === 'file' && e.name.toLowerCase() === name)?.size;
  const out: { path: string; size?: number }[] = [];
  const add = (dir: string, e: DirEntry) => out.push(e.kind === 'directory' ? { path: `${dir}/${e.name}/` } : { path: `${dir}/${e.name}`, size: e.size });
  for (const s of [scan.system.mp3, scan.system.advert]) {
    if (!s) continue;
    for (const t of [...s.files, ...s.wrongDigits]) out.push({ path: `${s.dirName}/${t.name}`, size: t.size });
    for (const e of s.others) add(s.dirName, e);
  }
  for (const f of scan.folders) {
    for (const t of [...f.tracks, ...f.wrongDigits]) out.push({ path: `${f.name}/${t.name}`, size: t.size });
    for (const e of [...f.unnumbered, ...f.others, ...f.subfolders]) add(f.name, e);
  }
  for (const e of [...scan.invalidFolders, ...scan.rootOthers]) out.push(e.kind === 'directory' ? { path: `${e.name}/` } : { path: e.name, size: e.size });
  for (const t of scan.tempDirs) out.push({ path: `${t.name}/` });
  if (scan.hasCatalog) out.push({ path: CATALOG_FILE, size: rootSize(CATALOG_FILE) });
  if (scan.hasCovers) out.push({ path: COVERS_FILE, size: rootSize(COVERS_FILE) });
  return out;
}

/**
 * How the backup goes back onto `target`: mp3 and advert first, then the
 * folders 01 … 99 with their tracks by number, catalog and covers last,
 * every name as it was. Only onto an empty card, or one that holds the
 * first part of this very backup (an earlier restore that stopped: the
 * files in restore order, the last one perhaps cut short). `root`, the
 * listing of the card's root, gives the sizes of the app's two files.
 */
export function planRestore(manifest: BackupManifest, target: SdScan, root: readonly DirEntry[] = []): RestorePlan {
  if (!manifest.complete) return { ok: false, reason: 'incomplete' };
  const entries = restoreOrder(manifest.files);
  const plan = { ok: true as const, entries, files: entries.length, bytes: totalBytes(entries) };
  const items = cardItems(target, root);
  if (target.kind === 'empty' && !items.length) return { ...plan, resume: false, present: 0 };
  const at = new Map(items.map((i) => [key(i.path), i]));
  const foreign = items.filter((i) => !manifest.files.some((f) => key(f.path) === key(i.path))).map((i) => i.path);
  if (foreign.length) return { ok: false, reason: 'not-empty', items: foreign };
  // A prefix of the restore order, the file after it perhaps half written; nothing further on.
  let i = 0;
  while (i < entries.length && at.get(key(entryPath(entries[i])))?.size === entries[i].size) i++;
  const later = entries.slice(i + 1).filter((e) => at.has(key(entryPath(e))));
  if (later.length) return { ok: false, reason: 'not-empty', items: items.map((x) => x.path) };
  return { ...plan, resume: true, present: i };
}

/**
 * The bytes a restore takes on a FAT32 card with 32 KiB clusters, folders
 * included. To compare with the free space the platform reports.
 */
export function bytesOnCard(entries: readonly BackupEntry[], cluster = 32 * 1024): number {
  const dirs = new Set(entries.map((e) => key(e.dir)).filter(Boolean));
  const files = entries.reduce((n, e) => n + Math.max(1, Math.ceil(e.size / cluster)) * cluster, 0);
  return files + dirs.size * cluster;
}

/* ------------------------------------------------------------------ the card to write back to */

export type TargetVerdict =
  /** Empty and FAT (or the format is unknown): ready. */
  | 'ok'
  /** Holds the first part of this backup: the restore goes on. */
  | 'resume'
  /** exFAT, NTFS, …: the box cannot read it. */
  | 'not-fat'
  /** Other files on it: format it first. */
  | 'not-empty'
  /**
   * Holds what the backup holds, but writing back never began, or holds all
   * of it: the old card, not formatted (or a card that needs nothing).
   */
  | 'not-formatted'
  /** Less free space than the backup needs. */
  | 'too-small'
  /** The backup itself is not finished. */
  | 'incomplete';

export interface TargetJudgement {
  verdict: TargetVerdict;
  /** Format as the system names it, when known. */
  fsType?: string;
  /** Bigger than 32 GB (then the card's own formatter makes exFAT). */
  big: boolean;
  /** FAT, but with clusters below 32 KB: only a hint. */
  smallClusters: boolean;
  /** The format could not be checked (browser). */
  fsUnknown: boolean;
  /** For 'not-empty': what is on the card. */
  items?: string[];
  /** For 'too-small': needed and free bytes. */
  need?: number;
  free?: number;
}

const GB = 1024 ** 3;

/** Whether `info` and the plan for it allow writing the backup back to this card. */
export function judgeTarget(info: VolumeInfo, plan: RestorePlan): TargetJudgement {
  const fs = info.fsType?.trim() ?? '';
  const base = {
    fsType: fs || undefined,
    big: !!info.totalBytes && info.totalBytes > 32.5 * GB,
    smallClusters: !!fs && isFatFilesystem(fs) && !!info.clusterSize && info.clusterSize < 32 * 1024,
    fsUnknown: !fs,
  };
  if (fs && !isFatFilesystem(fs)) return { verdict: 'not-fat', ...base };
  if (!plan.ok) return plan.reason === 'incomplete' ? { verdict: 'incomplete', ...base } : { verdict: 'not-empty', ...base, items: plan.items };
  if (!plan.resume && info.freeBytes !== undefined) {
    const need = bytesOnCard(plan.entries);
    if (info.freeBytes < need) return { verdict: 'too-small', ...base, need, free: info.freeBytes };
  }
  return { verdict: plan.resume ? 'resume' : 'ok', ...base };
}
