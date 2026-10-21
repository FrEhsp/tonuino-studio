import type { ByteSource } from '../../platform/types';

/**
 * Chapter marks of MP4/M4B audiobooks. Reads the QuickTime chapter track
 * (Apple) and the Nero "chpl" list (ffmpeg, many converters). Only atom
 * headers and the small chapter tables are read, never the audio data, so
 * this also works for long books whose index comes after the audio.
 */

export interface Chapter {
  startSec: number;
  title?: string;
}

interface Atom {
  type: string;
  start: number;
  /** Offset of the payload. */
  body: number;
  end: number;
}

async function children(src: ByteSource, from: number, to: number): Promise<Atom[]> {
  const out: Atom[] = [];
  let pos = from;
  while (pos + 8 <= to) {
    const h = await src.read(pos, 16);
    if (h.length < 8) break;
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) break;
      size = Number(dv.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = to - pos;
    }
    if (size < header || pos + size > to + 8) break;
    out.push({ type, start: pos, body: pos + header, end: Math.min(pos + size, to) });
    pos += size;
  }
  return out;
}

async function child(src: ByteSource, parent: Atom, type: string): Promise<Atom | undefined> {
  return (await children(src, parent.body, parent.end)).find((a) => a.type === type);
}

async function path(src: ByteSource, parent: Atom, types: string[]): Promise<Atom | undefined> {
  let cur: Atom | undefined = parent;
  for (const t of types) {
    if (!cur) return undefined;
    cur = await child(src, cur, t);
  }
  return cur;
}

async function payload(src: ByteSource, a: Atom, max = 4 * 1024 * 1024): Promise<DataView> {
  const len = Math.min(a.end - a.body, max);
  const b = await src.read(a.body, len);
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe))) {
    return new TextDecoder(bytes[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export async function readMp4Chapters(src: ByteSource): Promise<Chapter[] | null> {
  const top = await children(src, 0, src.size);
  if (!top.some((a) => a.type === 'ftyp')) return null;
  const moov = top.find((a) => a.type === 'moov');
  if (!moov) return null;
  const fromTrack = await chapterTrack(src, moov).catch(() => null);
  if (fromTrack?.length) return fromTrack;
  const chpl = await path(src, moov, ['udta', 'chpl']);
  if (chpl) {
    const nero = await neroChapters(src, chpl).catch(() => null);
    if (nero?.length) return nero;
  }
  return null;
}

async function neroChapters(src: ByteSource, chpl: Atom): Promise<Chapter[]> {
  const dv = await payload(src, chpl);
  let p = 0;
  const version = dv.getUint8(p);
  p += 4;
  if (version) p += 4;
  const count = dv.getUint8(p++);
  const out: Chapter[] = [];
  for (let i = 0; i < count && p + 9 <= dv.byteLength; i++) {
    const start = Number(dv.getBigUint64(p));
    p += 8;
    const len = dv.getUint8(p++);
    const title = decodeText(new Uint8Array(dv.buffer, dv.byteOffset + p, Math.min(len, dv.byteLength - p)));
    p += len;
    out.push({ startSec: start / 1e7, title: title.trim() || undefined });
  }
  return out;
}

async function trackId(src: ByteSource, trak: Atom): Promise<number | undefined> {
  const tkhd = await child(src, trak, 'tkhd');
  if (!tkhd) return undefined;
  const dv = await payload(src, tkhd, 32);
  return dv.getUint8(0) === 1 ? dv.getUint32(20) : dv.getUint32(12);
}

async function chapterTrack(src: ByteSource, moov: Atom): Promise<Chapter[] | null> {
  const traks = (await children(src, moov.body, moov.end)).filter((a) => a.type === 'trak');
  let chapterId: number | undefined;
  for (const t of traks) {
    const chap = await path(src, t, ['tref', 'chap']);
    if (chap) {
      chapterId = (await payload(src, chap, 4)).getUint32(0);
      break;
    }
  }
  if (chapterId === undefined) return null;
  let trak: Atom | undefined;
  for (const t of traks) if ((await trackId(src, t)) === chapterId) trak = t;
  if (!trak) return null;

  const mdhd = await path(src, trak, ['mdia', 'mdhd']);
  const stbl = await path(src, trak, ['mdia', 'minf', 'stbl']);
  if (!mdhd || !stbl) return null;
  const md = await payload(src, mdhd, 32);
  const timescale = md.getUint8(0) === 1 ? md.getUint32(20) : md.getUint32(12);
  const parts = await children(src, stbl.body, stbl.end);
  const get = (t: string) => parts.find((a) => a.type === t);
  const stts = get('stts');
  const stsz = get('stsz');
  const stsc = get('stsc');
  const stco = get('stco') ?? get('co64');
  if (!stts || !stsz || !stsc || !stco || !timescale) return null;

  // Start time of every sample.
  const tt = await payload(src, stts);
  const starts: number[] = [];
  let t = 0;
  for (let i = 0, n = tt.getUint32(4); i < n; i++) {
    const count = tt.getUint32(8 + i * 8);
    const delta = tt.getUint32(12 + i * 8);
    for (let k = 0; k < count && starts.length < 10000; k++) {
      starts.push(t);
      t += delta;
    }
  }
  // Sample sizes.
  const sz = await payload(src, stsz);
  const fixed = sz.getUint32(4);
  const sampleCount = sz.getUint32(8);
  const sizes: number[] = [];
  for (let i = 0; i < Math.min(sampleCount, 10000); i++) sizes.push(fixed || sz.getUint32(12 + i * 4));
  // Chunk offsets.
  const co = await payload(src, stco);
  const chunkCount = co.getUint32(4);
  const offsets: number[] = [];
  for (let i = 0; i < chunkCount; i++) offsets.push(stco.type === 'co64' ? Number(co.getBigUint64(8 + i * 8)) : co.getUint32(8 + i * 4));
  // Samples per chunk.
  const sc = await payload(src, stsc);
  const entries: { first: number; per: number }[] = [];
  for (let i = 0, n = sc.getUint32(4); i < n; i++) entries.push({ first: sc.getUint32(8 + i * 12), per: sc.getUint32(12 + i * 12) });

  const sampleOffsets: number[] = [];
  for (let c = 0; c < offsets.length && sampleOffsets.length < sizes.length; c++) {
    const e = [...entries].reverse().find((x) => x.first <= c + 1);
    let off = offsets[c];
    for (let k = 0; k < (e?.per ?? 1) && sampleOffsets.length < sizes.length; k++) {
      sampleOffsets.push(off);
      off += sizes[sampleOffsets.length - 1];
    }
  }

  const out: Chapter[] = [];
  for (let i = 0; i < sampleOffsets.length; i++) {
    let title: string | undefined;
    if (sizes[i] >= 2) {
      const b = await src.read(sampleOffsets[i], Math.min(sizes[i], 1024));
      const len = (b[0] << 8) | b[1];
      title = decodeText(b.subarray(2, 2 + Math.min(len, b.length - 2))).trim() || undefined;
    }
    out.push({ startSec: (starts[i] ?? 0) / timescale, title });
  }
  return out;
}
