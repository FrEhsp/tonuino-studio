import { childOf, nodeAt, type BlobFile, type BlobFolder } from '../../platform/blobtree';
import { crc32OfBlob } from '../zip/crc32';
import { readZipDirectory, ZipReadError } from '../zip/zipreader';
import { isCardPackage, manifestFromZip, PACKAGE_FILE_PATTERN, type PackageManifest } from './package';
import { APP_FILES, CATALOG_FILE, isJunk, parseFolderNumber } from './sd';

/**
 * Checks a card that was read again after the user unpacked a Paket onto
 * it: did everything arrive, in the right place, and is nothing old left
 * where it would confuse the box.
 */

export type CheckFinding =
  | { kind: 'picked-subfolder'; name: string }
  | { kind: 'nested'; folder: string }
  | { kind: 'not-a-card' }
  | { kind: 'nothing-arrived' }
  | { kind: 'missing'; paths: string[] }
  | { kind: 'incomplete'; paths: string[] }
  /** Same size as in the Paket, other content: an old file was kept (Windows "Dateien überspringen") or nothing was unpacked. */
  | { kind: 'outdated'; paths: string[] }
  /** `added`: the folder was new in the Paket, so the extra files were there before (another Paket?). */
  | { kind: 'leftovers'; folder: string; paths: string[]; added: boolean }
  | { kind: 'not-deleted'; names: string[] }
  | { kind: 'appledouble'; count: number }
  | { kind: 'package-on-card'; name: string }
  | { kind: 'not-formatted'; names: string[] };

export interface CheckResult {
  /** No finding left that keeps the box from working. */
  ok: boolean;
  findings: CheckFinding[];
}

/** Findings that are only a note: everything works, but it is worth knowing. */
const WARNINGS: ReadonlySet<CheckFinding['kind']> = new Set(['not-formatted']);

const result = (findings: CheckFinding[]): CheckResult => ({ ok: findings.every((f) => WARNINGS.has(f.kind)), findings });

const isBoxFolder = (name: string) => /^(mp3|advert)$/i.test(name) || parseFolderNumber(name) !== null;

function looksLikeCard(folder: BlobFolder): boolean {
  return folder.children.some((c) => (c.kind === 'directory' && isBoxFolder(c.name)) || (c.kind === 'file' && c.name.toLowerCase() === CATALOG_FILE));
}

function fileAt(folder: BlobFolder, path: string): BlobFile | undefined {
  const n = nodeAt(folder, path);
  return n?.kind === 'file' ? n : undefined;
}

/** Files below a folder that are not junk (and not inside junk folders), with paths relative to it. */
function realFiles(folder: BlobFolder, prefix = ''): string[] {
  const out: string[] = [];
  for (const c of folder.children) {
    if (isJunk(c.name)) continue;
    const path = prefix ? `${prefix}/${c.name}` : c.name;
    if (c.kind === 'file') out.push(path);
    else out.push(...realFiles(c, path));
  }
  return out;
}

function countAppleDouble(folder: BlobFolder): number {
  let n = 0;
  for (const c of folder.children) {
    if (c.name.startsWith('._')) n++;
    else if (c.kind === 'directory' && !isJunk(c.name)) n += countAppleDouble(c);
  }
  return n;
}

/** Folders of the Paket in the card's root (the entries that are not files of the root). */
function packageFolders(m: PackageManifest): string[] {
  const rootFiles = new Set(m.files.filter((f) => !f.path.includes('/')).map((f) => f.path.toLowerCase()));
  return m.topLevel.filter((t) => !rootFiles.has(t.toLowerCase()));
}

/**
 * Whether a folder of the card that is not a box folder holds the Paket
 * unpacked into it. Only when it holds nothing else (a folder of the
 * family's own, say a backup, is never taken for a mis-unpacked Paket and
 * never offered for deleting) and clearly holds the Paket: a file that is
 * new in it, or most of its files.
 */
function looksNested(card: BlobFolder, folder: BlobFolder, m: PackageManifest, inPackage: ReadonlySet<string>): boolean {
  const hits = m.files.filter((f) => {
    const there = fileAt(folder, f.path);
    const atRoot = fileAt(card, f.path);
    return there && there.blob.size === f.size && !(atRoot && atRoot.blob.size === f.size);
  });
  if (!hits.length) return false;
  if (realFiles(folder).some((p) => !inPackage.has(p.toLowerCase()))) return false;
  return hits.some((f) => f.isNew) || hits.length * 2 > m.files.length;
}

/**
 * Compares the card with the Paket. `label` is the name of the folder the
 * user chose, to notice a folder of the card chosen instead of the card.
 */
export function checkCard(card: BlobFolder, label: string, m: PackageManifest): CheckResult {
  // A folder of the card was chosen, not the card.
  if (/^(\d{2}|mp3|advert)$/i.test(label) && card.children.some((c) => c.kind === 'file' && /^\d{1,4}.*\.(mp3|wav)$/i.test(c.name))) {
    return result([{ kind: 'picked-subfolder', name: label }]);
  }

  // Unpacked into a folder of its own instead of the card's root.
  const named = card.children.find((c) => c.kind === 'directory' && /^TonUINO-(Paket|Karte-komplett)-/i.test(c.name));
  if (named) return result([{ kind: 'nested', folder: named.name }]);
  const inPackage = new Set(m.files.map((f) => f.path.toLowerCase()));
  for (const c of card.children) {
    if (c.kind !== 'directory' || isJunk(c.name) || isBoxFolder(c.name)) continue;
    if (looksNested(card, c, m, inPackage)) return result([{ kind: 'nested', folder: c.name }]);
  }

  const present = m.files.filter((f) => !!fileAt(card, f.path));
  if (!looksLikeCard(card) && !present.length) return result([{ kind: 'not-a-card' }]);
  const arrived = present.filter((f) => fileAt(card, f.path)!.blob.size === f.size);
  if (m.files.length && !arrived.length) return result([{ kind: 'nothing-arrived' }]);

  const findings: CheckFinding[] = [];
  const missing = m.files.filter((f) => !fileAt(card, f.path)).map((f) => f.path);
  if (missing.length) findings.push({ kind: 'missing', paths: missing });
  const incomplete = present.filter((f) => fileAt(card, f.path)!.blob.size !== f.size).map((f) => f.path);
  if (incomplete.length) findings.push({ kind: 'incomplete', paths: incomplete });

  const toDelete = new Set(m.deleteFirst.map((n) => n.toLowerCase()));
  for (const name of packageFolders(m)) {
    const folder = childOf(card, name);
    if (folder?.kind !== 'directory') continue;
    const extra = realFiles(folder).filter((p) => !inPackage.has(`${name}/${p}`.toLowerCase()));
    if (extra.length) findings.push({ kind: 'leftovers', folder: name, paths: extra, added: m.mode === 'changes' && !toDelete.has(name.toLowerCase()) });
  }

  const notDeleted = m.removeOnly.filter((n) => !!childOf(card, n));
  if (notDeleted.length) findings.push({ kind: 'not-deleted', names: notDeleted });

  const tops = new Set(m.topLevel.map((t) => t.toLowerCase()));
  let appleDouble = card.children.filter((c) => c.name.startsWith('._') && tops.has(c.name.slice(2).toLowerCase())).length;
  for (const name of packageFolders(m)) {
    const folder = childOf(card, name);
    if (folder?.kind === 'directory') appleDouble += countAppleDouble(folder);
  }
  if (appleDouble) findings.push({ kind: 'appledouble', count: appleDouble });

  const zip = card.children.find((c) => c.kind === 'file' && PACKAGE_FILE_PATTERN.test(c.name));
  if (zip) findings.push({ kind: 'package-on-card', name: zip.name });

  if (m.mode === 'full') {
    const others = card.children.filter((c) => !isJunk(c.name) && !tops.has(c.name.toLowerCase()) && !(zip && c === zip)).map((c) => c.name);
    if (others.length) findings.push({ kind: 'not-formatted', names: others });
  }
  return result(findings);
}

/**
 * What a Paket from elsewhere would replace on this card: its folders that
 * the card has already (they are deleted before unpacking), and whether it
 * brings its own names and pictures in place of the card's.
 */
export function replacedByPackage(card: BlobFolder, m: PackageManifest): { folders: string[]; appFiles: boolean } {
  const folders = m.deleteFirst.filter((name) => {
    const node = childOf(card, name);
    return node?.kind === 'directory' && realFiles(node).length > 0;
  });
  const brings = new Set(m.topLevel.map((t) => t.toLowerCase()));
  const appFiles = APP_FILES.some((n) => brings.has(n) && childOf(card, n)?.kind === 'file');
  return { folders, appFiles };
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** Files up to this size are compared by content in every check, not only the thorough one. */
export const QUICK_CRC_MAX = 1024 * 1024;

/**
 * Files of the Paket whose content is worth comparing in every check:
 * the app's files in the root (names, card modes and pictures often keep
 * their size when they change) and every small file. Only files that are
 * there with the right size; checkCard reports the others.
 */
function quickFiles(card: BlobFolder, m: PackageManifest): { f: PackageManifest['files'][number]; blob: Blob }[] {
  return m.files.flatMap((f) => {
    const appFile = !f.path.includes('/') && APP_FILES.some((n) => n === f.path.toLowerCase());
    if (!appFile && f.size > QUICK_CRC_MAX) return [];
    const node = fileAt(card, f.path);
    return node && node.blob.size === f.size ? [{ f, blob: node.blob }] : [];
  });
}

/**
 * checkCard, and then the small files and the app's files compared by
 * content. Sizes alone miss a catalog that kept its size, so a card where
 * nothing was unpacked could pass. A file that cannot be read counts as
 * different.
 */
export async function checkCardContent(
  card: BlobFolder,
  label: string,
  m: PackageManifest,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<CheckResult> {
  const res = checkCard(card, label, m);
  if (!res.ok) return res;
  const todo = quickFiles(card, m);
  const total = todo.reduce((n, x) => n + x.f.size, 0);
  let done = 0;
  const outdated: string[] = [];
  for (const { f, blob } of todo) {
    opts.signal?.throwIfAborted();
    try {
      if ((await crc32OfBlob(blob, { signal: opts.signal })) !== f.crc32) outdated.push(f.path);
    } catch (e) {
      if (isAbort(e)) throw e;
      outdated.push(f.path);
    }
    done += f.size;
    opts.onProgress?.(done, total);
  }
  return outdated.length ? result([{ kind: 'outdated', paths: outdated }, ...res.findings]) : res;
}

/**
 * Reads every file of the Paket back from the card and compares its CRC,
 * then lets `decode` play the new MP3s through once. Files that are missing
 * or have the wrong size are left to checkCard. A file that cannot be read
 * counts as different.
 */
export async function checkThoroughly(
  card: BlobFolder,
  m: PackageManifest,
  opts: {
    decode?: (blob: Blob, path: string, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<{ crcMismatch: string[]; decodeFailed: string[] }> {
  const there = m.files.flatMap((f) => {
    const node = fileAt(card, f.path);
    return node && node.blob.size === f.size ? [{ f, blob: node.blob }] : [];
  });
  const toDecode = opts.decode ? there.filter((x) => x.f.isNew && /\.mp3$/i.test(x.f.path)) : [];
  const total = there.reduce((n, x) => n + x.f.size, 0) + toDecode.reduce((n, x) => n + x.f.size, 0);
  let done = 0;
  const crcMismatch: string[] = [];
  const decodeFailed: string[] = [];
  for (const { f, blob } of there) {
    opts.signal?.throwIfAborted();
    const start = done;
    try {
      const crc = await crc32OfBlob(blob, { signal: opts.signal, onProgress: (n) => opts.onProgress?.(start + n, total) });
      if (crc !== f.crc32) crcMismatch.push(f.path);
    } catch (e) {
      if (isAbort(e)) throw e;
      crcMismatch.push(f.path);
    }
    done = start + f.size;
    opts.onProgress?.(done, total);
  }
  for (const { f, blob } of toDecode) {
    opts.signal?.throwIfAborted();
    if (crcMismatch.includes(f.path)) {
      done += f.size;
      continue;
    }
    try {
      await opts.decode!(blob, f.path, opts.signal);
    } catch (e) {
      if (isAbort(e)) throw e;
      decodeFailed.push(f.path);
    }
    done += f.size;
    opts.onProgress?.(done, total);
  }
  return { crcMismatch, decodeFailed };
}

/**
 * Whether a downloaded file is the complete Paket. With a manifest, it must
 * be exactly that Paket (any file name: browsers rename a second download).
 * Without one, any ZIP that brings something for a TonUINO card will do.
 */
export async function checkDownloadedPackage(
  file: { name: string; size: number; read(start: number, length: number): Promise<Uint8Array> },
  m?: PackageManifest,
): Promise<{ ok: true; name: string; manifest: PackageManifest } | { ok: false; reason: 'not-finished' | 'not-zip' | 'other-package' }> {
  let dir;
  try {
    dir = await readZipDirectory((start, length) => file.read(start, length), file.size);
  } catch (e) {
    if (e instanceof ZipReadError) return { ok: false, reason: e.code === 'truncated' ? 'not-finished' : 'not-zip' };
    throw e;
  }
  if (m) {
    const entries = dir.entries.filter((e) => !e.isDir);
    const same =
      dir.size === m.size &&
      entries.length === m.files.length &&
      entries.every((e, i) => e.path === m.files[i].path && e.size === m.files[i].size && e.crc32 === m.files[i].crc32);
    if (!same) return { ok: false, reason: 'other-package' };
    return { ok: true, name: file.name, manifest: { ...m, name: file.name } };
  }
  const manifest = manifestFromZip(dir, file.name);
  if (!isCardPackage(manifest)) return { ok: false, reason: 'other-package' };
  return { ok: true, name: file.name, manifest };
}
