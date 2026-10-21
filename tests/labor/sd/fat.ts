/**
 * Reads FAT12/16/32 and exFAT images the way the card reader's driver
 * would: directory entries in their order on the card, long names, the
 * read-only attribute, modification times in FAT's two-second steps, free
 * space from the allocation table. Writing is left to mtools (simcard.ts),
 * so what the app sees is what a real FAT driver wrote.
 *
 * exFAT: only the boot sector and the directory listing; there is no
 * writer for exFAT without mounting, so exFAT cards stay as formatted.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export interface FatEntry {
  name: string;
  kind: 'file' | 'directory';
  size: number;
  /** Modification time, ms since 1970 (FAT keeps local time). */
  modified: number;
  /** The FAT read-only attribute. */
  readOnly: boolean;
  hidden: boolean;
  firstCluster: number;
}

export interface FatGeometry {
  type: 'FAT12' | 'FAT16' | 'FAT32' | 'exFAT';
  clusterSize: number;
  totalBytes: number;
  freeBytes: number;
  label: string;
}

class Img {
  private readonly fd: number;
  readonly size: number;
  constructor(path: string) {
    this.fd = openSync(path, 'r');
    this.size = statSync(path).size;
  }
  read(offset: number, length: number): Buffer {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(this.fd, buf, got, length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    return buf;
  }
  close(): void {
    closeSync(this.fd);
  }
}

function withImg<T>(path: string, fn: (img: Img) => T): T {
  const img = new Img(path);
  try {
    return fn(img);
  } finally {
    img.close();
  }
}

export class FatError extends Error {
  constructor(
    readonly code: 'not-found' | 'not-a-directory' | 'not-a-file' | 'unsupported',
    message: string,
  ) {
    super(message);
  }
}

/** FAT date and time (local time) to ms since 1970. */
export function fatTime(date: number, time: number, tenthsOf10ms = 0): number {
  if (!date) return 0;
  const y = 1980 + (date >> 9);
  const m = (date >> 5) & 0x0f;
  const d = date & 0x1f;
  const h = time >> 11;
  const mi = (time >> 5) & 0x3f;
  const s = (time & 0x1f) * 2;
  return new Date(y, m - 1, d, h, mi, s).getTime() + tenthsOf10ms * 10;
}

/* ------------------------------------------------------------------ FAT */

interface Bpb {
  type: 'FAT12' | 'FAT16' | 'FAT32';
  bps: number;
  spc: number;
  reserved: number;
  fats: number;
  fatSize: number;
  rootEntries: number;
  rootCluster: number;
  firstDataSector: number;
  clusters: number;
  label: string;
}

function bpb(img: Img): Bpb {
  const b = img.read(0, 512);
  const bps = b.readUInt16LE(11);
  const spc = b[13];
  const reserved = b.readUInt16LE(14);
  const fats = b[16];
  const rootEntries = b.readUInt16LE(17);
  const total = b.readUInt16LE(19) || b.readUInt32LE(32);
  const fatSize = b.readUInt16LE(22) || b.readUInt32LE(36);
  if (!bps || !spc || !fatSize) throw new FatError('unsupported', 'no FAT boot sector');
  const rootDirSectors = Math.ceil((rootEntries * 32) / bps);
  const firstDataSector = reserved + fats * fatSize + rootDirSectors;
  const clusters = Math.floor((total - firstDataSector) / spc);
  const type = clusters < 4085 ? 'FAT12' : clusters < 65525 ? 'FAT16' : 'FAT32';
  const labelAt = type === 'FAT32' ? 71 : 43;
  return { type, bps, spc, reserved, fats, fatSize, rootEntries, rootCluster: type === 'FAT32' ? b.readUInt32LE(44) : 0, firstDataSector, clusters, label: b.toString('latin1', labelAt, labelAt + 11).trim() };
}

class Fat {
  private readonly table: Buffer;
  constructor(
    private readonly img: Img,
    readonly p: Bpb,
  ) {
    this.table = img.read(p.reserved * p.bps, p.fatSize * p.bps);
  }
  get clusterSize(): number {
    return this.p.bps * this.p.spc;
  }
  next(c: number): number {
    const t = this.table;
    if (this.p.type === 'FAT32') return t.readUInt32LE(c * 4) & 0x0fffffff;
    if (this.p.type === 'FAT16') return t.readUInt16LE(c * 2);
    const v = t.readUInt16LE(c + (c >> 1));
    return c & 1 ? v >> 4 : v & 0xfff;
  }
  isEnd(c: number): boolean {
    const eoc = this.p.type === 'FAT32' ? 0x0ffffff8 : this.p.type === 'FAT16' ? 0xfff8 : 0xff8;
    return c < 2 || c >= eoc;
  }
  chain(first: number): number[] {
    const out: number[] = [];
    for (let c = first; !this.isEnd(c) && out.length <= this.p.clusters; c = this.next(c)) out.push(c);
    return out;
  }
  readChain(first: number, size?: number): Buffer {
    const cs = this.clusterSize;
    const parts = this.chain(first).map((c) => this.img.read((this.p.firstDataSector + (c - 2) * this.p.spc) * this.p.bps, cs));
    const all = Buffer.concat(parts);
    return size === undefined ? all : all.subarray(0, size);
  }
  freeClusters(): number {
    let free = 0;
    for (let c = 2; c < this.p.clusters + 2; c++) if (this.next(c) === 0) free++;
    return free;
  }
  rootBytes(): Buffer {
    if (this.p.type === 'FAT32') return this.readChain(this.p.rootCluster);
    const start = (this.p.reserved + this.p.fats * this.p.fatSize) * this.p.bps;
    return this.img.read(start, this.p.rootEntries * 32);
  }
}

function lfnChecksum(short: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) + (sum >> 1) + short[i]) & 0xff;
  return sum;
}

function lfnChars(e: Buffer): string {
  const out: number[] = [];
  for (const [from, n] of [
    [1, 5],
    [14, 6],
    [28, 2],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const ch = e.readUInt16LE(from + i * 2);
      if (ch === 0 || ch === 0xffff) return String.fromCharCode(...out);
      out.push(ch);
    }
  }
  return String.fromCharCode(...out);
}

/** Directory entries of a FAT directory, in their order on the card. */
function parseDir(bytes: Buffer): FatEntry[] {
  const out: FatEntry[] = [];
  let parts: string[] = [];
  let sum = -1;
  for (let off = 0; off + 32 <= bytes.length; off += 32) {
    const e = bytes.subarray(off, off + 32);
    if (e[0] === 0x00) break;
    if (e[0] === 0xe5) {
      parts = [];
      continue;
    }
    const attr = e[11];
    if (attr === 0x0f) {
      const ord = e[0] & 0x1f;
      if (e[0] & 0x40) {
        parts = [];
        sum = e[13];
      }
      parts[ord - 1] = lfnChars(e);
      continue;
    }
    if (attr & 0x08) {
      parts = [];
      continue; // volume label
    }
    const short = Buffer.from(e.subarray(0, 11));
    if (short[0] === 0x05) short[0] = 0xe5;
    let base = short.toString('latin1', 0, 8).trimEnd();
    let ext = short.toString('latin1', 8, 11).trimEnd();
    if (e[12] & 0x08) base = base.toLowerCase();
    if (e[12] & 0x10) ext = ext.toLowerCase();
    const shortName = ext ? `${base}.${ext}` : base;
    const name = parts.length && sum === lfnChecksum(short) ? parts.join('') : shortName;
    parts = [];
    if (name === '.' || name === '..') continue;
    out.push({
      name,
      kind: attr & 0x10 ? 'directory' : 'file',
      size: attr & 0x10 ? 0 : e.readUInt32LE(28),
      modified: fatTime(e.readUInt16LE(24), e.readUInt16LE(22)),
      readOnly: !!(attr & 0x01),
      hidden: !!(attr & 0x02),
      firstCluster: (e.readUInt16LE(20) << 16) | e.readUInt16LE(26),
    });
  }
  return out;
}

function find(entries: FatEntry[], name: string): FatEntry | undefined {
  const n = name.toLowerCase();
  return entries.find((e) => e.name.toLowerCase() === n);
}

/** Splits "a/b/c" (or "/a/b") into its names. */
export function parts(path: string): string[] {
  return path.split('/').filter((p) => p && p !== '.');
}

function fatDir(fat: Fat, path: string): FatEntry[] {
  let entries = parseDir(fat.rootBytes());
  for (const name of parts(path)) {
    const e = find(entries, name);
    if (!e) throw new FatError('not-found', `${path}: no such folder`);
    if (e.kind !== 'directory') throw new FatError('not-a-directory', `${path}: not a folder`);
    entries = parseDir(fat.readChain(e.firstCluster));
  }
  return entries;
}

function isExfat(img: Img): boolean {
  return img.read(3, 8).toString('latin1') === 'EXFAT   ';
}

/** The entries of a folder of the image ("" is the top level). */
export function listDir(image: string, path: string): FatEntry[] {
  return withImg(image, (img) => (isExfat(img) ? exfatDir(img, path) : fatDir(new Fat(img, bpb(img)), path)));
}

/** One entry, or undefined when it is not there. The top level is a directory. */
export function statPath(image: string, path: string): FatEntry | undefined {
  const p = parts(path);
  if (!p.length) return { name: '', kind: 'directory', size: 0, modified: 0, readOnly: false, hidden: false, firstCluster: 0 };
  try {
    return find(listDir(image, p.slice(0, -1).join('/')), p[p.length - 1]);
  } catch (e) {
    if (e instanceof FatError && (e.code === 'not-found' || e.code === 'not-a-directory')) return undefined;
    throw e;
  }
}

/** The content of a file. */
export function readFile(image: string, path: string): Uint8Array {
  return withImg(image, (img) => {
    if (isExfat(img)) throw new FatError('unsupported', 'exFAT files are not read here');
    const fat = new Fat(img, bpb(img));
    const p = parts(path);
    const e = find(fatDir(fat, p.slice(0, -1).join('/')), p[p.length - 1] ?? '');
    if (!e) throw new FatError('not-found', `${path}: no such file`);
    if (e.kind !== 'file') throw new FatError('not-a-file', `${path}: a folder`);
    return new Uint8Array(e.size ? fat.readChain(e.firstCluster, e.size) : Buffer.alloc(0));
  });
}

/** Type, cluster size, size and free space, as the system reports them for the mounted card. */
export function geometry(image: string): FatGeometry {
  return withImg(image, (img) => {
    if (isExfat(img)) return exfatGeometry(img);
    const fat = new Fat(img, bpb(img));
    const cs = fat.clusterSize;
    return { type: fat.p.type, clusterSize: cs, totalBytes: fat.p.clusters * cs, freeBytes: fat.freeClusters() * cs, label: fat.p.label };
  });
}

/* ---------------------------------------------------------------- exFAT */

interface ExBoot {
  bps: number;
  spc: number;
  fatOffset: number;
  heapOffset: number;
  clusters: number;
  rootCluster: number;
}

function exBoot(img: Img): ExBoot {
  const b = img.read(0, 512);
  return {
    bps: 1 << b[0x6c],
    spc: 1 << b[0x6d],
    fatOffset: b.readUInt32LE(0x50),
    heapOffset: b.readUInt32LE(0x58),
    clusters: b.readUInt32LE(0x5c),
    rootCluster: b.readUInt32LE(0x60),
  };
}

function exChain(img: Img, x: ExBoot, first: number, contiguous = false, bytes = 0): Buffer {
  const cs = x.bps * x.spc;
  const clusters: number[] = [];
  if (contiguous) for (let i = 0; i < Math.ceil(bytes / cs); i++) clusters.push(first + i);
  else for (let c = first; c >= 2 && c < 0xfffffff7 && clusters.length <= x.clusters; c = img.read(x.fatOffset * x.bps + c * 4, 4).readUInt32LE(0)) clusters.push(c);
  return Buffer.concat(clusters.map((c) => img.read((x.heapOffset + (c - 2) * x.spc) * x.bps, cs)));
}

function exParse(bytes: Buffer): (FatEntry & { contiguous: boolean; length: number })[] {
  const out: (FatEntry & { contiguous: boolean; length: number })[] = [];
  for (let off = 0; off + 32 <= bytes.length; off += 32) {
    const t = bytes[off];
    if (t === 0x00) break;
    if (t !== 0x85) continue;
    const count = bytes[off + 1];
    const attr = bytes.readUInt16LE(off + 4);
    const stamp = bytes.readUInt32LE(off + 12);
    const ms10 = bytes[off + 21];
    const stream = bytes.subarray(off + 32, off + 64);
    if (stream[0] !== 0xc0) continue;
    const nameLength = stream[3];
    let name = '';
    for (let i = 2; i <= count && name.length < nameLength; i++) {
      const n = bytes.subarray(off + i * 32, off + i * 32 + 32);
      if (n[0] !== 0xc1) break;
      for (let k = 0; k < 15 && name.length < nameLength; k++) name += String.fromCharCode(n.readUInt16LE(2 + k * 2));
    }
    const length = Number(stream.readBigUInt64LE(24));
    out.push({
      name,
      kind: attr & 0x10 ? 'directory' : 'file',
      size: attr & 0x10 ? 0 : length,
      modified: fatTime(stamp >>> 16, stamp & 0xffff, ms10),
      readOnly: !!(attr & 0x01),
      hidden: !!(attr & 0x02),
      firstCluster: stream.readUInt32LE(20),
      contiguous: !!(stream[1] & 0x02),
      length,
    });
    off += count * 32;
  }
  return out;
}

function exfatDir(img: Img, path: string): FatEntry[] {
  const x = exBoot(img);
  let entries = exParse(exChain(img, x, x.rootCluster));
  for (const name of parts(path)) {
    const e = entries.find((v) => v.name.toLowerCase() === name.toLowerCase());
    if (!e) throw new FatError('not-found', `${path}: no such folder`);
    if (e.kind !== 'directory') throw new FatError('not-a-directory', `${path}: not a folder`);
    entries = exParse(exChain(img, x, e.firstCluster, e.contiguous, e.length));
  }
  return entries;
}

function exfatGeometry(img: Img): FatGeometry {
  const x = exBoot(img);
  const cs = x.bps * x.spc;
  // The allocation bitmap is the root directory's entry 0x81.
  const root = exChain(img, x, x.rootCluster);
  let used = 0;
  let label = '';
  for (let off = 0; off + 32 <= root.length; off += 32) {
    const t = root[off];
    if (t === 0x00) break;
    if (t === 0x83) {
      const n = root[off + 1];
      for (let k = 0; k < n; k++) label += String.fromCharCode(root.readUInt16LE(off + 2 + k * 2));
    }
    if (t === 0x81) {
      const bitmap = exChain(img, x, root.readUInt32LE(off + 20), true, Number(root.readBigUInt64LE(off + 24)));
      for (let c = 0; c < x.clusters; c++) if (bitmap[c >> 3] & (1 << (c & 7))) used++;
    }
  }
  return { type: 'exFAT', clusterSize: cs, totalBytes: x.clusters * cs, freeBytes: (x.clusters - used) * cs, label };
}
