import { childOf, type BlobFile, type BlobFolder, type BlobNode } from '../../platform/blobtree';
import { crc32, crc32OfBlob, knownCrc32 } from '../zip/crc32';
import type { ZipDirectory } from '../zip/zipreader';
import { EMPTY_ZIP, layoutZip, type ZipEntryInput, type ZipLayout } from '../zip/zipwriter';
import { CATALOG_FILE, COVERS_FILE, isJunk, parseFolderNumber, parseTempDir } from './sd';
import type { WritePlan } from './writeplan';

/**
 * The Paket: a ZIP file the browser downloads and the user unpacks onto the
 * card. Entries go in the order the card should get them, because unzip
 * tools create files in archive order and that becomes the order on FAT:
 * mp3, advert, then 01 … 99, and inside a folder the tracks by number.
 */

export type PackageMode = 'changes' | 'full';

/** A file, or a folder ("05/") when `file` is missing. */
export interface PackageItem {
  path: string;
  file?: BlobFile;
}

export interface PackageContent {
  mode: PackageMode;
  items: PackageItem[];
  files: number;
  bytes: number;
  /** What to delete on the card before unpacking ('changes'). */
  deleteFirst: string[];
  /** Hidden files to delete on the card by hand ('changes'), see WritePlan. */
  deleteJunk: string[];
  /** What only goes away and is not in the Paket again. */
  removeOnly: string[];
  /** The card is formatted before unpacking ('full'). */
  format: boolean;
}

export interface PackageManifest {
  /** File name of the ZIP. */
  name: string;
  mode: PackageMode;
  createdAt: number;
  /** Size of the ZIP in bytes. */
  size: number;
  files: { path: string; size: number; crc32: number; isNew: boolean }[];
  /** Entries of the card's root that the Paket brings. */
  topLevel: string[];
  deleteFirst: string[];
  /** Hidden files to delete by hand; missing in Pakete from before it existed. */
  deleteJunk?: string[];
  removeOnly: string[];
}

export interface TopEntry {
  name: string;
  entry: 'directory' | 'file';
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function topRank(e: TopEntry): [number, number, string] {
  const n = e.name.toLowerCase();
  if (e.entry === 'directory') {
    if (n === 'mp3') return [0, 0, n];
    if (n === 'advert') return [1, 0, n];
    const f = parseFolderNumber(e.name);
    if (f !== null) return [2, f, n];
    return [5, 0, n];
  }
  if (n === CATALOG_FILE) return [3, 0, n];
  if (n === COVERS_FILE) return [4, 0, n];
  return [6, 0, n];
}

/**
 * Order of the card's root: mp3, advert, 01 … 99, the catalog, the covers,
 * other folders A–Z, other files. The app's files come right after the
 * box's folders: should unpacking stop at a big file of the family's own,
 * names and pictures are on the card already.
 */
export function topLevelOrder(a: TopEntry, b: TopEntry): number {
  const ra = topRank(a);
  const rb = topRank(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || cmp(ra[2], rb[2]) || cmp(a.name, b.name);
}

/** Order inside a folder: names with a leading number by that number, then the others by name. */
export function entryOrder(a: string, b: string): number {
  const na = /^\d+/.exec(a);
  const nb = /^\d+/.exec(b);
  if (na && nb) {
    const d = Number(na[0]) - Number(nb[0]);
    if (d) return d;
  } else if (na) return -1;
  else if (nb) return 1;
  return cmp(a.toLowerCase(), b.toLowerCase()) || cmp(a, b);
}

/** Bytes of a node without the junk in it (junk never goes into a Paket). */
export function packedBytes(node: BlobNode): number {
  if (isJunk(node.name)) return 0;
  if (node.kind === 'file') return node.blob.size;
  return node.children.reduce((n, c) => n + packedBytes(c), 0);
}

/** A helper folder of a repair ("_tonuino-studio-temp-05"). */
export function isTempFolder(node: BlobNode): boolean {
  return node.kind === 'directory' && parseTempDir(node.name) !== undefined;
}

function hasRealFiles(folder: BlobFolder): boolean {
  return folder.children.some((c) => !isJunk(c.name) && (c.kind === 'file' || hasRealFiles(c)));
}

/**
 * Whether a top-level entry goes into a Paket of the whole card: not junk,
 * and helper folders of a repair only while files wait in them (leaving
 * them out would lose those files when the card is formatted).
 */
export function belongsInFullPackage(node: BlobNode): boolean {
  if (isJunk(node.name)) return false;
  if (isTempFolder(node)) return hasRealFiles(node as BlobFolder);
  return true;
}

const asTop = (n: BlobNode): TopEntry => ({ name: n.name, entry: n.kind });

function addFolder(items: PackageItem[], folder: BlobFolder, path: string) {
  items.push({ path: `${path}/` });
  const kids = folder.children.filter((c) => !isJunk(c.name));
  const byName = (a: BlobNode, b: BlobNode) => entryOrder(a.name, b.name);
  for (const f of kids.filter((c): c is BlobFile => c.kind === 'file').sort(byName)) items.push({ path: `${path}/${f.name}`, file: f });
  for (const d of kids.filter((c): c is BlobFolder => c.kind === 'directory').sort(byName)) addFolder(items, d, `${path}/${d.name}`);
}

function addTop(items: PackageItem[], node: BlobNode) {
  if (node.kind === 'file') items.push({ path: node.name, file: node });
  else addFolder(items, node, node.name);
}

/** The covers file when no cover is left: an archive without entries. */
function emptyCovers(): BlobFile {
  return { kind: 'file', name: COVERS_FILE, blob: new Blob([EMPTY_ZIP as BlobPart]), crc32: crc32(EMPTY_ZIP), staged: true };
}

/**
 * What goes into the Paket. 'changes': every added or replaced entry of
 * the root as a whole, then the app's files. 'full': everything that
 * belongs on the card, for a freshly formatted one. Junk stays out.
 */
export function packageContent(plan: WritePlan, current: BlobFolder, mode: PackageMode): PackageContent {
  const items: PackageItem[] = [];
  if (mode === 'changes') {
    for (const c of plan.changes) {
      if (c.kind === 'remove') continue;
      const node = childOf(current, c.name);
      if (node) addTop(items, node);
    }
    for (const a of plan.appFiles) {
      if (a.empty) {
        items.push({ path: COVERS_FILE, file: emptyCovers() });
        continue;
      }
      const node = childOf(current, a.name);
      if (node?.kind === 'file') items.push({ path: node.name, file: node });
    }
  } else {
    const tops = current.children.filter(belongsInFullPackage).sort((a, b) => topLevelOrder(asTop(a), asTop(b)));
    for (const n of tops) addTop(items, n);
  }
  let files = 0;
  let bytes = 0;
  for (const i of items) {
    if (!i.file) continue;
    files++;
    bytes += i.file.blob.size;
  }
  return {
    mode,
    items,
    files,
    bytes,
    deleteFirst: mode === 'changes' ? [...plan.deleteFirst] : [],
    deleteJunk: mode === 'changes' ? [...plan.deleteJunk] : [],
    removeOnly: mode === 'changes' ? plan.changes.filter((c) => c.kind === 'remove').map((c) => c.name) : [],
    format: mode === 'full',
  };
}

/** The biggest file FAT32 can hold: 4 GiB minus one byte. */
export const FAT32_MAX_FILE = 0xffffffff;
/** About what fits on a 32 GB card, the biggest the box reads. */
export const CARD_32GB_BYTES = 31_000_000_000;
const CLUSTER = 32 * 1024;

/**
 * What keeps a Paket from fitting on a card for the box (FAT32, at most
 * 32 GB): files too big for FAT32, and more than a 32 GB card holds
 * (counted in 32 KiB clusters, as the guide formats the card).
 */
export function fat32Limits(content: PackageContent): { tooBig: string[]; onCard: number; overCard: boolean } {
  const tooBig: string[] = [];
  let onCard = 0;
  for (const i of content.items) {
    const size = i.file ? i.file.blob.size : 0;
    if (size > FAT32_MAX_FILE) tooBig.push(i.path);
    onCard += Math.max(1, Math.ceil(size / CLUSTER)) * CLUSTER;
  }
  return { tooBig, onCard, overCard: onCard > CARD_32GB_BYTES };
}

/**
 * Folders the catalog knows that the reading of the card does not have.
 * A browser can stop reading a card at a folder it cannot open and still
 * hand over the rest: then the whole-card Paket would miss them, and the
 * card is formatted afterwards. (Also true for folders deleted elsewhere.)
 */
export function knownFoldersMissing(known: Iterable<string>, current: BlobFolder): string[] {
  const out: string[] = [];
  for (const name of known) {
    if (parseFolderNumber(name) === null) continue;
    if (childOf(current, name)?.kind !== 'directory') out.push(name);
  }
  return out.sort();
}

const NAME_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** "TonUINO-Paket-0610-1432-7KQ.zip": day and month, hour and minute, three letters so two Pakete never share a name. */
export function packageName(mode: PackageMode, at: Date, rand: () => number = Math.random): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  let code = '';
  for (let i = 0; i < 3; i++) code += NAME_ALPHABET[Math.min(NAME_ALPHABET.length - 1, Math.floor(rand() * NAME_ALPHABET.length))];
  const kind = mode === 'full' ? 'TonUINO-Karte-komplett' : 'TonUINO-Paket';
  return `${kind}-${p2(at.getDate())}${p2(at.getMonth() + 1)}-${p2(at.getHours())}${p2(at.getMinutes())}-${code}.zip`;
}

/** A Paket's file name, also as the browser renames a second download ("… (1).zip", "…(1).zip", "…-1.zip"). */
export const PACKAGE_FILE_PATTERN = /^TonUINO-(Paket|Karte-komplett)-.*\.zip$/i;

function topLevelOf(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const top = p.split('/')[0];
    if (!top || seen.has(top.toLowerCase())) continue;
    seen.add(top.toLowerCase());
    out.push(top);
  }
  return out;
}

/** What a Paket holds, to check the card against it later. Needs the CRCs, so call it after buildPackageBlob. */
export function manifestOf(content: PackageContent, layout: ZipLayout, name: string, at: number): PackageManifest {
  return {
    name,
    mode: content.mode,
    createdAt: at,
    size: layout.size,
    files: content.items.flatMap((i) => {
      if (!i.file) return [];
      const crc = i.file.crc32 ?? knownCrc32(i.file.blob);
      if (crc === undefined) throw new Error(`Für ${i.path} fehlt die Prüfsumme.`);
      return [{ path: i.path, size: i.file.blob.size, crc32: crc, isNew: !!i.file.staged }];
    }),
    topLevel: topLevelOf(content.items.map((i) => i.path)),
    deleteFirst: [...content.deleteFirst],
    ...(content.deleteJunk.length ? { deleteJunk: [...content.deleteJunk] } : {}),
    removeOnly: [...content.removeOnly],
  };
}

/**
 * The manifest of a Paket the app did not make in this session: a
 * download from earlier, or one from someone else. Its folders are to be
 * deleted before unpacking, because a Paket always brings whole folders.
 */
export function manifestFromZip(dir: ZipDirectory, name: string): PackageManifest {
  const mode: PackageMode = /karte-komplett/i.test(name) ? 'full' : 'changes';
  const paths = dir.entries.map((e) => e.path);
  const folders = topLevelOf(paths.filter((p) => p.includes('/')));
  return {
    name,
    mode,
    createdAt: 0,
    size: dir.size,
    files: dir.entries.filter((e) => !e.isDir).map((e) => ({ path: e.path, size: e.size, crc32: e.crc32, isNew: false })),
    topLevel: topLevelOf(paths),
    deleteFirst: mode === 'changes' ? folders : [],
    removeOnly: [],
  };
}

/** Whether a manifest looks like something for a TonUINO card (system sounds, numbered folders or the catalog). */
export function isCardPackage(m: PackageManifest): boolean {
  return m.topLevel.some((t) => /^(mp3|advert)$/i.test(t) || parseFolderNumber(t) !== null || t.toLowerCase() === CATALOG_FILE);
}

/** Card files whose CRC is not known yet: building the Paket reads them once. */
export function crcPending(content: PackageContent): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const i of content.items) {
    if (!i.file || i.file.crc32 !== undefined || knownCrc32(i.file.blob) !== undefined) continue;
    files++;
    bytes += i.file.blob.size;
  }
  return { files, bytes };
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/**
 * The Paket as one Blob, built from the card's Files, the staged files and
 * the header bytes, without copying any music. Files whose CRC is unknown
 * are read once first; `onProgress` counts those bytes.
 */
export async function buildPackageBlob(
  content: PackageContent,
  opts: { now?: Date; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ blob: Blob; layout: ZipLayout }> {
  const total = crcPending(content).bytes;
  let done = 0;
  for (const item of content.items) {
    const f = item.file;
    if (!f) continue;
    if (f.crc32 === undefined) f.crc32 = knownCrc32(f.blob);
    if (f.crc32 !== undefined) continue;
    opts.signal?.throwIfAborted();
    const start = done;
    try {
      f.crc32 = await crc32OfBlob(f.blob, { signal: opts.signal, onProgress: (n) => opts.onProgress?.(start + n, total) });
    } catch (e) {
      if (isAbort(e)) throw e;
      throw new Error(`Die Datei „${item.path}“ auf der Karte ließ sich nicht lesen. Steckt die Karte noch? Lies die Karte neu ein und versuche es noch einmal.`, {
        cause: e,
      });
    }
    done += f.blob.size;
    opts.onProgress?.(done, total);
  }
  const entries: ZipEntryInput[] = content.items.map((i) => (i.file ? { path: i.path, size: i.file.blob.size, crc32: i.file.crc32! } : { path: i.path, size: 0, crc32: 0 }));
  const layout = layoutZip(entries, { now: opts.now });
  const parts: BlobPart[] = layout.parts.map((p) => (p instanceof Uint8Array ? (p as BlobPart) : content.items[p.entry].file!.blob));
  return { blob: new Blob(parts, { type: 'application/zip' }), layout };
}
