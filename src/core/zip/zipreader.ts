/**
 * Reads the table of contents of a ZIP archive from its end, without
 * reading the files in it: the end record, the ZIP64 end record when there
 * is one, and the central directory. A download that stopped early has no
 * end record or one that does not match, which is how an unfinished Paket
 * is told apart from a complete one.
 */

export interface ZipDirEntry {
  path: string;
  size: number;
  crc32: number;
  isDir: boolean;
  /** Where the entry's local header starts. */
  offset: number;
}

export interface ZipDirectory {
  entries: ZipDirEntry[];
  zip64: boolean;
  /** Size of the archive in bytes. */
  size: number;
}

export class ZipReadError extends Error {
  constructor(
    message: string,
    readonly code: 'not-zip' | 'truncated' | 'unsupported',
  ) {
    super(message);
    this.name = 'ZipReadError';
  }
}

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
/** End record, the longest comment and the ZIP64 locator. */
const TAIL = 22 + MAX16 + 20;

function u64(dv: DataView, o: number): number {
  return dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 when flagged or valid, else Latin-1 (old tools wrote their code page without saying so). */
function decodeName(bytes: Uint8Array, flagged: boolean): string {
  try {
    return utf8.decode(bytes);
  } catch {
    if (flagged) return new TextDecoder('utf-8').decode(bytes);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}

const truncated = (why: string) => new ZipReadError(`Das Paket ist nicht vollständig (${why}).`, 'truncated');

/**
 * The entries of the archive of `size` bytes. `read` returns `length`
 * bytes from `start`. Rejects with ZipReadError: 'not-zip' for other files,
 * 'truncated' for an archive that is cut off or damaged, 'unsupported' for
 * archives split over several files.
 */
export async function readZipDirectory(read: (start: number, length: number) => Promise<Uint8Array>, size: number): Promise<ZipDirectory> {
  if (size <= 0) throw truncated('leer');
  const head = await read(0, Math.min(4, size));
  const startsLikeZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6));
  if (!startsLikeZip) throw new ZipReadError('Das ist keine ZIP-Datei.', 'not-zip');
  if (size < 22) throw truncated('zu kurz');

  const tailLen = Math.min(size, TAIL);
  const tailStart = size - tailLen;
  const tail = await read(tailStart, tailLen);
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50 && i + 22 + dv.getUint16(i + 20, true) === tail.length) {
      e = i;
      break;
    }
  }
  if (e < 0) throw truncated('kein Ende');
  if (dv.getUint16(e + 4, true) !== 0 || dv.getUint16(e + 6, true) !== 0) {
    throw new ZipReadError('Das Paket ist auf mehrere Dateien verteilt.', 'unsupported');
  }
  let count = dv.getUint16(e + 10, true);
  let cdSize = dv.getUint32(e + 12, true);
  let cdOffset = dv.getUint32(e + 16, true);
  let zip64 = false;
  /** Where the central directory has to end. */
  let cdEnd = tailStart + e;
  if (e >= 20 && dv.getUint32(e - 20, true) === 0x07064b50) {
    zip64 = true;
    if (dv.getUint32(e - 16, true) !== 0 || dv.getUint32(e - 4, true) > 1) {
      throw new ZipReadError('Das Paket ist auf mehrere Dateien verteilt.', 'unsupported');
    }
    const at = u64(dv, e - 12);
    if (at + 56 > tailStart + e - 20) throw truncated('ZIP64-Ende');
    const z = await read(at, 56);
    if (z.length < 56) throw truncated('ZIP64-Ende');
    const zd = new DataView(z.buffer, z.byteOffset, 56);
    if (zd.getUint32(0, true) !== 0x06064b50) throw truncated('ZIP64-Ende');
    count = u64(zd, 32);
    cdSize = u64(zd, 40);
    cdOffset = u64(zd, 48);
    cdEnd = at;
  } else if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
    // The end record says "see ZIP64", but there is none.
    throw truncated('ZIP64-Verweis fehlt');
  }
  if (cdOffset + cdSize !== cdEnd) throw truncated('Inhaltsverzeichnis');

  const cd = cdSize ? await read(cdOffset, cdSize) : new Uint8Array(0);
  if (cd.length !== cdSize) throw truncated('Inhaltsverzeichnis');
  const c = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries: ZipDirEntry[] = [];
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cd.length || c.getUint32(p, true) !== 0x02014b50) throw truncated('Eintrag');
    const flags = c.getUint16(p + 8, true);
    const nameLen = c.getUint16(p + 28, true);
    const extraLen = c.getUint16(p + 30, true);
    const commentLen = c.getUint16(p + 32, true);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw truncated('Eintrag');
    let usize = c.getUint32(p + 24, true);
    let csize = c.getUint32(p + 20, true);
    let offset = c.getUint32(p + 42, true);
    const path = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x0800) !== 0);
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = c.getUint16(x, true);
      const len = c.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        const room = x + 4 + len;
        if (usize === MAX32 && q + 8 <= room) {
          usize = u64(c, q);
          q += 8;
        }
        if (csize === MAX32 && q + 8 <= room) {
          csize = u64(c, q);
          q += 8;
        }
        if (offset === MAX32 && q + 8 <= room) {
          offset = u64(c, q);
          q += 8;
        }
      }
      x += 4 + len;
    }
    entries.push({ path, size: usize, crc32: c.getUint32(p + 16, true), isDir: path.endsWith('/'), offset });
    p = xEnd + commentLen;
  }
  return { entries, zip64, size };
}
