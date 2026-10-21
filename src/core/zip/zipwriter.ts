/**
 * Lays out a ZIP archive without holding its data: headers become bytes,
 * the data of each file stays where it is ({ entry: i } parts), so a Blob
 * can be built from card Files and staged files and downloaded as one ZIP.
 *
 * Rules, checked with Info-ZIP unzip, zipinfo, Python's zipfile and JSZip:
 * - Only "stored" (no compression) and no data descriptors: CRC and size
 *   are known before writing. Audio does not compress anyway.
 * - The UTF-8 flag (bit 11) is set only for names with non-ASCII characters.
 * - "Made by" Unix (host 3): Debian's and Ubuntu's unzip ignore the UTF-8
 *   flag for host 0 (MS-DOS) and garble "Größe" into "Gr├╢├ƒe".
 * - ZIP64 fields appear only where a size, an offset or the number of
 *   entries does not fit; then the ZIP64 end record follows as well.
 * - Entries keep the order given: unzip and Python create files and folders
 *   strictly in archive order, which on FAT is the order the box plays.
 */

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const enc = new TextEncoder();

export interface ZipEntryInput {
  /** "05/003.mp3"; a folder ends with "/" ("05/") and has size 0 and crc32 0. */
  path: string;
  size: number;
  crc32: number;
}

/** Bytes of the archive, or `{ entry: i }`: the data of input i goes here. */
export type ZipPart = Uint8Array | { entry: number };

export interface ZipLayout {
  parts: ZipPart[];
  /** Size of the whole archive in bytes. */
  size: number;
  /** The archive has a ZIP64 end record. */
  zip64: boolean;
  entryCount: number;
  /** Where the central directory sits. */
  directory: { offset: number; length: number };
}

export class ZipPathError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'ZipPathError';
  }
}

/** An archive without any entry: only the end record. */
export const EMPTY_ZIP: Uint8Array = (() => {
  const e = new Uint8Array(22);
  new DataView(e.buffer).setUint32(0, 0x06054b50, true);
  return e;
})();

/** MS-DOS date and time in local time, as ZIP stores them (2 s steps, 1980 to 2107). */
export function dosDateTime(d: Date): { date: number; time: number } {
  const y = d.getFullYear();
  if (y < 1980) return { date: (1 << 5) | 1, time: 0 };
  if (y > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
  return {
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

function u64(dv: DataView, off: number, v: number) {
  dv.setUint32(off, v % 0x100000000, true);
  dv.setUint32(off + 4, Math.floor(v / 0x100000000), true);
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Throws ZipPathError for names that must not go into the archive. */
export function checkZipPath(path: string): void {
  const fail = (why: string) => {
    throw new ZipPathError(`Ungültiger Name im Paket (${why}): ${path}`, path);
  };
  if (!path || path === '/') fail('leer');
  if (path.startsWith('/')) fail('beginnt mit /');
  if (path.includes('\\')) fail('enthält \\');
  if (CONTROL.test(path)) fail('Steuerzeichen');
  const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  for (const s of segments) {
    if (!s) fail('leerer Teil');
    if (s === '.' || s === '..') fail('. oder ..');
  }
  if (enc.encode(path).length > MAX16) fail('zu lang');
}

/**
 * Header bytes for `entries` in the order given and where each entry's data
 * goes. Paths are checked (see checkZipPath); two paths that differ only in
 * case are refused, because FAT would put them in the same place.
 */
export function layoutZip(entries: readonly ZipEntryInput[], opts: { now?: Date; forceZip64?: boolean } = {}): ZipLayout {
  const force = !!opts.forceZip64;
  const { date, time } = dosDateTime(opts.now ?? new Date());
  const seen = new Set<string>();
  for (const e of entries) {
    checkZipPath(e.path);
    const key = e.path.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) throw new ZipPathError(`Diesen Namen gibt es im Paket zweimal: ${e.path}`, e.path);
    seen.add(key);
    if (!e.path.endsWith('/') && (!Number.isSafeInteger(e.size) || e.size < 0)) throw new ZipPathError(`Ungültige Größe für ${e.path}`, e.path);
  }

  const parts: ZipPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let pending: Uint8Array[] = [];
  const flush = () => {
    if (!pending.length) return;
    if (pending.length === 1) parts.push(pending[0]);
    else {
      const out = new Uint8Array(pending.reduce((n, b) => n + b.length, 0));
      let p = 0;
      for (const b of pending) {
        out.set(b, p);
        p += b.length;
      }
      parts.push(out);
    }
    pending = [];
  };

  let anyZip64 = force;
  entries.forEach((e, i) => {
    const isDir = e.path.endsWith('/');
    const name = enc.encode(e.path);
    const flags = /[^\u0000-\u007f]/.test(e.path) ? 0x0800 : 0;
    const size = isDir ? 0 : e.size;
    const crc = isDir ? 0 : e.crc32 >>> 0;
    const bigSize = force || size >= MAX32;
    const bigOffset = force || offset >= MAX32;
    if (bigSize || bigOffset) anyZip64 = true;
    const needed = bigSize || bigOffset ? 45 : isDir ? 20 : 10;

    // Local header. Only sizes go into its ZIP64 field; the offset is the central directory's business.
    const lExtra = bigSize ? 20 : 0;
    const lh = new Uint8Array(30 + name.length + lExtra);
    const l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, bigSize ? 45 : isDir ? 20 : 10, true);
    l.setUint16(6, flags, true);
    l.setUint16(8, 0, true);
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, bigSize ? MAX32 : size, true);
    l.setUint32(22, bigSize ? MAX32 : size, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, lExtra, true);
    lh.set(name, 30);
    if (bigSize) {
      const x = 30 + name.length;
      l.setUint16(x, 0x0001, true);
      l.setUint16(x + 2, 16, true);
      u64(l, x + 4, size);
      u64(l, x + 12, size);
    }
    const localOffset = offset;
    pending.push(lh);
    offset += lh.length;
    if (size > 0) {
      flush();
      parts.push({ entry: i });
      offset += size;
    }

    // Central directory header, emitted after all entries.
    const fields: number[] = [];
    if (bigSize) fields.push(size, size);
    if (bigOffset) fields.push(localOffset);
    const cExtra = fields.length ? 4 + 8 * fields.length : 0;
    const ch = new Uint8Array(46 + name.length + cExtra);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, (3 << 8) | (needed === 45 ? 45 : 20), true);
    c.setUint16(6, needed, true);
    c.setUint16(8, flags, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, bigSize ? MAX32 : size, true);
    c.setUint32(24, bigSize ? MAX32 : size, true);
    c.setUint16(28, name.length, true);
    c.setUint16(30, cExtra, true);
    c.setUint16(32, 0, true);
    c.setUint16(34, 0, true);
    c.setUint16(36, 0, true);
    // Unix mode in the high half, MS-DOS attribute (folder or archive) in the low half.
    c.setUint32(38, (((isDir ? 0o40755 : 0o100644) << 16) | (isDir ? 0x10 : 0x20)) >>> 0, true);
    c.setUint32(42, bigOffset ? MAX32 : localOffset, true);
    ch.set(name, 46);
    if (cExtra) {
      const x = 46 + name.length;
      c.setUint16(x, 0x0001, true);
      c.setUint16(x + 2, 8 * fields.length, true);
      fields.forEach((v, k) => u64(c, x + 4 + 8 * k, v));
    }
    central.push(ch);
  });

  const cdOffset = offset;
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const n = entries.length;
  const zip64 = anyZip64 || n >= MAX16 || cdOffset >= MAX32 || cdSize >= MAX32;
  for (const ch of central) pending.push(ch);
  offset += cdSize;

  if (zip64) {
    const z = new Uint8Array(56 + 20);
    const zd = new DataView(z.buffer);
    zd.setUint32(0, 0x06064b50, true);
    u64(zd, 4, 44);
    zd.setUint16(12, 45, true);
    zd.setUint16(14, 45, true);
    zd.setUint32(16, 0, true);
    zd.setUint32(20, 0, true);
    u64(zd, 24, n);
    u64(zd, 32, n);
    u64(zd, 40, cdSize);
    u64(zd, 48, cdOffset);
    // Locator: where the ZIP64 end record is.
    zd.setUint32(56, 0x07064b50, true);
    zd.setUint32(60, 0, true);
    u64(zd, 64, offset);
    zd.setUint32(72, 1, true);
    pending.push(z);
    offset += z.length;
  }

  const end = new Uint8Array(22);
  const ed = new DataView(end.buffer);
  ed.setUint32(0, 0x06054b50, true);
  const count = force || n >= MAX16 ? MAX16 : n;
  ed.setUint16(8, count, true);
  ed.setUint16(10, count, true);
  ed.setUint32(12, force || cdSize >= MAX32 ? MAX32 : cdSize, true);
  ed.setUint32(16, force || cdOffset >= MAX32 ? MAX32 : cdOffset, true);
  pending.push(end);
  offset += 22;
  flush();
  return { parts, size: offset, zip64, entryCount: n, directory: { offset: cdOffset, length: cdSize } };
}
