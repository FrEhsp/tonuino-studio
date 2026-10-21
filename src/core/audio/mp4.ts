/**
 * MP4 / M4A / M4B / MOV demuxer for the WebCodecs path.
 *
 * Reads only box headers and the `moov` index, never the whole file: the
 * first audio track, its sample tables (stts, stsz/stz2, stsc, stco/co64),
 * fragmented files (moof/traf/trun), priming and padding from the edit list
 * or iTunSMPB, QuickTime chapter tracks and Nero chapters (chpl), and copy
 * protection (FairPlay 'drms', Audible 'aavd', common encryption 'enca').
 */
import type { ByteSource } from '../../platform/types';
import { readBits } from './bits';
import { type ChapterMark, type EncodedAudioInfo, type EncodedPacket, type PacketReader, AAC_SAMPLE_RATES } from './demux';
import { AudioError, checkAborted } from './errors';
import { readRange, WindowReader } from './source';

/** Largest `moov` box we load (a 20-hour book needs about 15 MB). */
const MAX_MOOV_BYTES = 192 << 20;

/* ------------------------------------------------------------ byte helpers */

function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function i32(b: Uint8Array, o: number): number {
  return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
}

function u64(b: Uint8Array, o: number): number {
  return u32(b, o) * 2 ** 32 + u32(b, o + 4);
}

function i64(b: Uint8Array, o: number): number {
  const hi = i32(b, o);
  return hi * 2 ** 32 + u32(b, o + 4);
}

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function isPrintableType(b: Uint8Array, o: number): boolean {
  for (let i = 0; i < 4; i++) {
    const c = b[o + i];
    if (c < 0x20 || c > 0x7e) {
      if (c !== 0xa9) return false; // '©' boxes in ilst
    }
  }
  return true;
}

/* ------------------------------------------------------------ boxes */

export interface Box {
  type: string;
  /** Offsets of the box, its payload and its end (in the file or in a buffer). */
  start: number;
  body: number;
  end: number;
}

/** Child boxes of an in-memory range. Stops at the first malformed box. */
export function* childBoxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = fourcc(b, p + 4);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = u64(b, p + 8);
      body = p + 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < body - p || p + size > end) return;
    yield { type, start: p, body, end: p + size };
    p += size;
  }
}

function childBox(b: Uint8Array, parent: Box, type: string): Box | undefined {
  for (const c of childBoxes(b, parent.body, parent.end)) if (c.type === type) return c;
  return undefined;
}

function boxPath(b: Uint8Array, parent: Box | undefined, types: readonly string[]): Box | undefined {
  let cur = parent;
  for (const t of types) {
    if (!cur) return undefined;
    cur = childBox(b, cur, t);
  }
  return cur;
}

/** Reads a box header from the file; null at the end or on garbage. */
async function fileBoxAt(source: ByteSource, pos: number, limit: number): Promise<Box | null> {
  if (pos + 8 > limit) return null;
  const h = await readRange(source, pos, 16);
  if (h.length < 8 || !isPrintableType(h, 4)) return null;
  let size = u32(h, 0);
  let body = pos + 8;
  if (size === 1) {
    if (h.length < 16) return null;
    size = u64(h, 8);
    body = pos + 16;
  } else if (size === 0) {
    size = limit - pos;
  }
  if (size < body - pos) return null;
  return { type: fourcc(h, 4), start: pos, body, end: Math.min(limit, pos + size) };
}

/* ------------------------------------------------------------ sample tables */

interface SampleInfo {
  offset: number;
  size: number;
  /** Decode time and duration in media timescale units. */
  time: number;
  duration: number;
}

export interface SampleTable {
  count: number;
  /** Per-sample sizes, or null when all have `fixedSize`. */
  sizes: Uint32Array | null;
  fixedSize: number;
  /** stts as pairs: count, delta. */
  stts: Uint32Array;
  /** stsc as triples: first chunk (1-based), samples per chunk, description index. */
  stsc: Uint32Array;
  chunkOffsets: Float64Array;
}

/** Walks a sample table in order. */
export class SampleCursor {
  private sample = 0;
  private chunk = -1;
  private inChunk = 0;
  private chunkSamples = 0;
  private stscIndex = 0;
  private offset = 0;
  private sttsIndex = 0;
  private sttsLeft: number;
  private time = 0;

  constructor(private readonly t: SampleTable) {
    this.sttsLeft = t.stts.length >= 2 ? t.stts[0] : 0;
  }

  next(): SampleInfo | null {
    const t = this.t;
    if (this.sample >= t.count) return null;
    while (this.inChunk >= this.chunkSamples) {
      this.chunk++;
      if (this.chunk >= t.chunkOffsets.length) return null;
      while (this.stscIndex + 3 < t.stsc.length && t.stsc[this.stscIndex + 3] - 1 <= this.chunk) this.stscIndex += 3;
      this.chunkSamples = t.stsc.length >= 3 ? t.stsc[this.stscIndex + 1] : 0;
      this.inChunk = 0;
      this.offset = t.chunkOffsets[this.chunk];
    }
    const size = t.sizes ? t.sizes[this.sample] : t.fixedSize;
    while (this.sttsLeft === 0 && this.sttsIndex + 2 < t.stts.length) {
      this.sttsIndex += 2;
      this.sttsLeft = t.stts[this.sttsIndex];
    }
    const duration = t.stts.length >= 2 ? t.stts[this.sttsIndex + 1] : 0;
    if (this.sttsLeft > 0) this.sttsLeft--;
    const info: SampleInfo = { offset: this.offset, size, time: this.time, duration };
    this.time += duration;
    this.offset += size;
    this.inChunk++;
    this.sample++;
    return info;
  }
}

function parseSampleTable(b: Uint8Array, stbl: Box): SampleTable | null {
  const stsz = childBox(b, stbl, 'stsz');
  const stz2 = stsz ? undefined : childBox(b, stbl, 'stz2');
  const stts = childBox(b, stbl, 'stts');
  const stsc = childBox(b, stbl, 'stsc');
  const stco = childBox(b, stbl, 'stco') ?? childBox(b, stbl, 'co64');
  if ((!stsz && !stz2) || !stts || !stsc || !stco) return null;

  let count = 0;
  let sizes: Uint32Array | null = null;
  let fixedSize = 0;
  if (stsz) {
    fixedSize = u32(b, stsz.body + 4);
    count = u32(b, stsz.body + 8);
    if (fixedSize === 0) {
      count = Math.min(count, Math.floor((stsz.end - stsz.body - 12) / 4));
      sizes = new Uint32Array(count);
      for (let i = 0, o = stsz.body + 12; i < count; i++, o += 4) sizes[i] = u32(b, o);
    }
  } else if (stz2) {
    const field = b[stz2.body + 7];
    count = u32(b, stz2.body + 8);
    sizes = new Uint32Array(count);
    const base = (stz2.body + 12) * 8;
    if (![4, 8, 16].includes(field) || stz2.body + 12 + Math.ceil((count * field) / 8) > stz2.end) return null;
    for (let i = 0; i < count; i++) sizes[i] = readBits(b, base + i * field, field);
  }

  const sttsCount = Math.min(u32(b, stts.body + 4), Math.floor((stts.end - stts.body - 8) / 8));
  const sttsArr = new Uint32Array(sttsCount * 2);
  for (let i = 0; i < sttsCount * 2; i++) sttsArr[i] = u32(b, stts.body + 8 + i * 4);

  const stscCount = Math.min(u32(b, stsc.body + 4), Math.floor((stsc.end - stsc.body - 8) / 12));
  const stscArr = new Uint32Array(stscCount * 3);
  for (let i = 0; i < stscCount * 3; i++) stscArr[i] = u32(b, stsc.body + 8 + i * 4);

  const wide = stco.type === 'co64';
  const chunkCount = Math.min(u32(b, stco.body + 4), Math.floor((stco.end - stco.body - 8) / (wide ? 8 : 4)));
  const chunkOffsets = new Float64Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) chunkOffsets[i] = wide ? u64(b, stco.body + 8 + i * 8) : u32(b, stco.body + 8 + i * 4);

  return { count, sizes, fixedSize, stts: sttsArr, stsc: stscArr, chunkOffsets };
}

/* ------------------------------------------------------------ codec configuration */

interface Esds {
  objectType: number;
  avgBitrate: number;
  asc?: Uint8Array;
}

/** Reads an MPEG-4 descriptor header; returns tag, payload start and end. */
function descriptor(b: Uint8Array, p: number, end: number): { tag: number; body: number; end: number } | null {
  if (p + 2 > end) return null;
  const tag = b[p];
  let len = 0;
  let q = p + 1;
  for (let i = 0; i < 4 && q < end; i++) {
    const c = b[q++];
    len = (len << 7) | (c & 0x7f);
    if (!(c & 0x80)) break;
  }
  return { tag, body: q, end: Math.min(end, q + len) };
}

export function parseEsds(b: Uint8Array, start: number, end: number): Esds | null {
  let p = start + 4; // version, flags
  let d = descriptor(b, p, end);
  if (d && d.tag === 0x03) {
    p = d.body + 2;
    const flags = b[p++];
    if (flags & 0x80) p += 2;
    if (flags & 0x40) p += 1 + b[p];
    if (flags & 0x20) p += 2;
    d = descriptor(b, p, d.end);
  }
  while (d && d.tag !== 0x04) d = descriptor(b, d.end, end);
  if (!d || d.body + 13 > d.end) return null;
  const out: Esds = { objectType: b[d.body], avgBitrate: u32(b, d.body + 9) };
  let q = d.body + 13;
  while (q < d.end) {
    const s = descriptor(b, q, d.end);
    if (!s) break;
    if (s.tag === 0x05) {
      out.asc = b.slice(s.body, s.end);
      break;
    }
    q = s.end;
  }
  return out;
}

export interface AscInfo {
  objectType: number;
  sampleRate: number;
  channelConfig: number;
  /** Output rate including SBR when it is signalled explicitly. */
  outputRate: number;
}

/** Parses an AAC AudioSpecificConfig. */
export function parseAsc(asc: Uint8Array): AscInfo | null {
  if (asc.length < 2) return null;
  let bit = 0;
  const read = (n: number) => {
    const v = readBits(asc, bit, n);
    bit += n;
    return v;
  };
  const rate = () => {
    const i = read(4);
    return i === 15 ? (bit + 24 <= asc.length * 8 ? read(24) : 0) : (AAC_SAMPLE_RATES[i] ?? 0);
  };
  let objectType = read(5);
  if (objectType === 31) objectType = 32 + read(6);
  const sampleRate = rate();
  const channelConfig = read(4);
  let outputRate = sampleRate;
  if ((objectType === 5 || objectType === 29) && bit + 4 <= asc.length * 8) outputRate = rate() || sampleRate;
  return sampleRate > 0 ? { objectType, sampleRate, channelConfig, outputRate } : null;
}

function opusHeadFromDops(b: Uint8Array, start: number, end: number): Uint8Array | null {
  if (end - start < 11) return null;
  const channels = b[start + 1];
  const family = b[start + 10];
  const extra = family !== 0 ? 2 + channels : 0;
  if (end - start < 11 + extra) return null;
  const head = new Uint8Array(19 + extra);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  head[8] = 1;
  head[9] = channels;
  const preSkip = u16(b, start + 2);
  head[10] = preSkip & 0xff;
  head[11] = preSkip >> 8;
  const rate = u32(b, start + 4);
  head[12] = rate & 0xff;
  head[13] = (rate >>> 8) & 0xff;
  head[14] = (rate >>> 16) & 0xff;
  head[15] = rate >>> 24;
  head[16] = b[start + 9]; // output gain, little endian
  head[17] = b[start + 8];
  head[18] = family;
  head.set(b.subarray(start + 11, start + 11 + extra), 19);
  return head;
}

/* ------------------------------------------------------------ tracks */

interface Track {
  id: number;
  handler: string;
  timescale: number;
  duration: number;
  stsd?: Box;
  table: SampleTable | null;
  edits: { segmentDuration: number; mediaTime: number }[];
  chapterRefs: number[];
}

function parseTrack(b: Uint8Array, trak: Box): Track | null {
  const tkhd = childBox(b, trak, 'tkhd');
  const mdia = childBox(b, trak, 'mdia');
  const mdhd = mdia && childBox(b, mdia, 'mdhd');
  const hdlr = mdia && childBox(b, mdia, 'hdlr');
  if (!tkhd || !mdia || !mdhd || !hdlr) return null;
  const v1 = b[tkhd.body] === 1;
  const id = u32(b, tkhd.body + (v1 ? 20 : 12));
  const mv1 = b[mdhd.body] === 1;
  const timescale = u32(b, mdhd.body + (mv1 ? 20 : 12));
  const duration = mv1 ? u64(b, mdhd.body + 24) : u32(b, mdhd.body + 16);
  const stbl = boxPath(b, mdia, ['minf', 'stbl']);
  const edits: Track['edits'] = [];
  const elst = boxPath(b, trak, ['edts', 'elst']);
  if (elst) {
    const ev1 = b[elst.body] === 1;
    const n = u32(b, elst.body + 4);
    let p = elst.body + 8;
    for (let i = 0; i < n && p + (ev1 ? 20 : 12) <= elst.end; i++) {
      edits.push(ev1 ? { segmentDuration: u64(b, p), mediaTime: i64(b, p + 8) } : { segmentDuration: u32(b, p), mediaTime: i32(b, p + 4) });
      p += ev1 ? 20 : 12;
    }
  }
  const chapterRefs: number[] = [];
  const chap = boxPath(b, trak, ['tref', 'chap']);
  if (chap) for (let p = chap.body; p + 4 <= chap.end; p += 4) chapterRefs.push(u32(b, p));
  return {
    id,
    handler: fourcc(b, hdlr.body + 8),
    timescale,
    duration,
    stsd: stbl && childBox(b, stbl, 'stsd'),
    table: stbl ? parseSampleTable(b, stbl) : null,
    edits,
    chapterRefs,
  };
}

interface AudioEntry {
  format: string;
  channels: number;
  sampleRate: number;
  codec: string;
  webCodecs?: string;
  description?: Uint8Array;
  drm?: string;
  avgBitrate?: number;
}

/** Looks for a box type among the children of `box`, also inside a QuickTime 'wave' box. */
function findInEntry(b: Uint8Array, start: number, end: number, type: string): Box | undefined {
  for (const c of childBoxes(b, start, end)) {
    if (c.type === type) return c;
    if (c.type === 'wave') {
      const inner = findInEntry(b, c.body, c.end, type);
      if (inner) return inner;
    }
  }
  return undefined;
}

const DRM_ENTRIES: Record<string, string> = {
  drms: 'FairPlay (iTunes)',
  drmi: 'FairPlay (iTunes)',
  aavd: 'Audible',
  enca: 'verschlüsselt',
};

function parseAudioEntry(b: Uint8Array, stsd: Box, mediaTimescale: number): AudioEntry | null {
  const entry = childBoxes(b, stsd.body + 8, stsd.end).next().value;
  if (!entry) return null;
  const e = entry.body;
  if (e + 28 > entry.end) return null;
  const version = u16(b, e + 8);
  let channels = u16(b, e + 16);
  let sampleRate = u32(b, e + 24) / 65536;
  let childStart = e + 28;
  if (version === 1) childStart += 16;
  else if (version === 2) {
    childStart += 36;
    if (e + 44 <= entry.end) {
      sampleRate = new DataView(b.buffer, b.byteOffset + e + 32, 8).getFloat64(0);
      channels = u32(b, e + 40);
    }
  }
  if (!(sampleRate > 0) || sampleRate < 1000) sampleRate = mediaTimescale;
  const out: AudioEntry = { format: entry.type, channels, sampleRate: Math.round(sampleRate), codec: entry.type };
  const find = (type: string) => findInEntry(b, childStart, entry.end, type);

  const sinf = find('sinf');
  let format = entry.type;
  if (DRM_ENTRIES[entry.type] || sinf) {
    const frma = sinf && childBox(b, sinf, 'frma');
    const schm = sinf && childBox(b, sinf, 'schm');
    out.drm = DRM_ENTRIES[entry.type] ?? 'verschlüsselt';
    if (schm && b[schm.body + 3] === 0) out.drm += ` (${fourcc(b, schm.body + 4)})`;
    if (frma) format = fourcc(b, frma.body);
  }

  if (format === 'mp4a') {
    const esdsBox = find('esds');
    const esds = esdsBox ? parseEsds(b, esdsBox.body, esdsBox.end) : null;
    out.avgBitrate = esds?.avgBitrate || undefined;
    const ot = esds?.objectType ?? 0x40;
    if (ot === 0x69 || ot === 0x6b) {
      out.codec = 'mp3';
      out.webCodecs = 'mp3';
    } else if (ot === 0xa5) {
      out.codec = 'ac3';
      out.webCodecs = 'ac-3';
    } else if (ot === 0xa6) {
      out.codec = 'eac3';
      out.webCodecs = 'ec-3';
    } else {
      out.codec = 'aac';
      const asc = esds?.asc ? parseAsc(esds.asc) : null;
      out.description = esds?.asc;
      const aot = asc && asc.objectType <= 40 ? asc.objectType : 2;
      // MPEG-2 AAC object types (0x66-0x68) carry the same bitstream as MPEG-4 AAC LC.
      out.webCodecs = `mp4a.40.${ot >= 0x66 && ot <= 0x68 ? 2 : aot}`;
      if (asc) {
        if (asc.channelConfig > 0 && asc.channelConfig < 8) out.channels = asc.channelConfig === 7 ? 8 : asc.channelConfig;
        if (!(out.sampleRate > 0)) out.sampleRate = asc.sampleRate;
      }
    }
  } else if (format === '.mp3' || format === 'mp3 ' || format === 'ms\u0000U') {
    out.codec = 'mp3';
    out.webCodecs = 'mp3';
  } else if (format === 'Opus') {
    const dops = find('dOps');
    out.codec = 'opus';
    out.webCodecs = 'opus';
    out.sampleRate = 48000;
    if (dops) {
      out.description = opusHeadFromDops(b, dops.body, dops.end) ?? undefined;
      out.channels = b[dops.body + 1] || out.channels;
    }
  } else if (format === 'fLaC') {
    const dfla = find('dfLa');
    out.codec = 'flac';
    out.webCodecs = 'flac';
    if (dfla && dfla.end - dfla.body >= 4 + 4 + 34) {
      const blocks = b.subarray(dfla.body + 4, dfla.end);
      const desc = new Uint8Array(4 + blocks.length);
      desc.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
      desc.set(blocks, 4);
      out.description = desc;
      // STREAMINFO: sample rate 20 bits at byte 10, channels 3 bits after it.
      const si = dfla.body + 4 + 4;
      out.sampleRate = (b[si + 10] << 12) | (b[si + 11] << 4) | (b[si + 12] >> 4);
      out.channels = ((b[si + 12] >> 1) & 7) + 1;
    }
  } else if (format === 'alac') {
    const alac = find('alac');
    out.codec = 'alac';
    out.webCodecs = 'alac';
    if (alac && alac.end - alac.body >= 28) {
      out.description = b.slice(alac.start, alac.end);
      out.channels = b[alac.body + 4 + 9] || out.channels;
      out.sampleRate = u32(b, alac.body + 4 + 20) || out.sampleRate;
    }
  } else if (format === 'ac-3' || format === 'ec-3') {
    out.codec = format === 'ac-3' ? 'ac3' : 'eac3';
    out.webCodecs = format;
  } else {
    out.codec = format.trim() || format;
  }
  return out;
}

/* ------------------------------------------------------------ metadata */

function parseItunSmpb(b: Uint8Array, moov: Box): { priming: number; padding: number; total: number } | null {
  const meta = boxPath(b, moov, ['udta', 'meta']);
  if (!meta) return null;
  // 'meta' is a full box in MP4 but a plain container in some QuickTime files.
  const plain = ['hdlr', 'ilst'].includes(fourcc(b, meta.body + 4));
  const metaBody: Box = { ...meta, body: meta.body + (plain ? 0 : 4) };
  const ilst = childBox(b, metaBody, 'ilst');
  if (!ilst) return null;
  for (const item of childBoxes(b, ilst.body, ilst.end)) {
    if (item.type !== '----') continue;
    let name = '';
    let value = '';
    for (const c of childBoxes(b, item.body, item.end)) {
      if (c.type === 'name') name = new TextDecoder().decode(b.subarray(c.body + 4, c.end));
      else if (c.type === 'data') value = new TextDecoder().decode(b.subarray(c.body + 8, c.end));
    }
    if (name !== 'iTunSMPB') continue;
    const parts = value.trim().split(/\s+/).map((x) => Number.parseInt(x, 16));
    if (parts.length >= 4 && parts.slice(1, 4).every(Number.isFinite)) return { priming: parts[1], padding: parts[2], total: parts[3] };
  }
  return null;
}

function decodeChapterText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe))) {
    return new TextDecoder(bytes[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function neroChapters(b: Uint8Array, moov: Box): ChapterMark[] {
  const chpl = boxPath(b, moov, ['udta', 'chpl']);
  if (!chpl) return [];
  let p = chpl.body;
  const version = b[p];
  p += 4;
  if (version) p += 4;
  const count = b[p++];
  const out: ChapterMark[] = [];
  for (let i = 0; i < count && p + 9 <= chpl.end; i++) {
    const start = u64(b, p);
    const len = b[p + 8];
    p += 9;
    const title = decodeChapterText(b.subarray(p, Math.min(chpl.end, p + len))).trim();
    p += len;
    out.push({ startSec: start / 1e7, title: title || undefined });
  }
  return out;
}

async function quickTimeChapters(source: ByteSource, track: Track): Promise<ChapterMark[]> {
  if (!track.table || !track.timescale) return [];
  const cursor = new SampleCursor(track.table);
  const out: ChapterMark[] = [];
  for (let s = cursor.next(); s && out.length < 5000; s = cursor.next()) {
    let title: string | undefined;
    if (s.size >= 2) {
      const bytes = await readRange(source, s.offset, Math.min(s.size, 2048));
      const len = bytes.length >= 2 ? u16(bytes, 0) : 0;
      title = decodeChapterText(bytes.subarray(2, 2 + Math.min(len, bytes.length - 2))).trim() || undefined;
    }
    out.push({ startSec: s.time / track.timescale, title });
  }
  return out;
}

function cleanChapters(list: ChapterMark[], durationSec: number): ChapterMark[] | undefined {
  const sorted = list
    .filter((c) => Number.isFinite(c.startSec) && c.startSec >= 0 && (!(durationSec > 0) || c.startSec < durationSec))
    .sort((a, b) => a.startSec - b.startSec);
  const out: ChapterMark[] = [];
  for (const c of sorted) if (!out.length || c.startSec - out[out.length - 1].startSec > 0.001) out.push(c);
  return out.length > 0 ? out : undefined;
}

/* ------------------------------------------------------------ fragments */

interface TrackDefaults {
  duration: number;
  size: number;
}

/** Parses the samples of one track from a 'moof' box held in memory (offsets are file offsets). */
export function parseMoof(b: Uint8Array, moofFileStart: number, trackId: number, defaults: TrackDefaults): SampleInfo[] {
  const moof = childBoxes(b, 0, b.length).next().value;
  const out: SampleInfo[] = [];
  if (!moof || moof.type !== 'moof') return out;
  let prevTrafEnd = moofFileStart;
  for (const traf of childBoxes(b, moof.body, moof.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = childBox(b, traf, 'tfhd');
    if (!tfhd) continue;
    const flags = u32(b, tfhd.body) & 0xffffff;
    let p = tfhd.body + 4;
    const id = u32(b, p);
    p += 4;
    let base = flags & 0x020000 ? moofFileStart : prevTrafEnd;
    if (flags & 0x01) {
      base = u64(b, p);
      p += 8;
    }
    if (flags & 0x02) p += 4;
    let defDuration = defaults.duration;
    let defSize = defaults.size;
    if (flags & 0x08) {
      defDuration = u32(b, p);
      p += 4;
    }
    if (flags & 0x10) defSize = u32(b, p);
    const tfdt = childBox(b, traf, 'tfdt');
    let time = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : out.length ? out[out.length - 1].time + out[out.length - 1].duration : 0;
    let dataPos = base;
    for (const trun of childBoxes(b, traf.body, traf.end)) {
      if (trun.type !== 'trun') continue;
      const tf = u32(b, trun.body) & 0xffffff;
      const count = u32(b, trun.body + 4);
      let q = trun.body + 8;
      if (tf & 0x01) {
        dataPos = base + i32(b, q);
        q += 4;
      }
      if (tf & 0x04) q += 4;
      const per = ((tf & 0x100 ? 1 : 0) + (tf & 0x200 ? 1 : 0) + (tf & 0x400 ? 1 : 0) + (tf & 0x800 ? 1 : 0)) * 4;
      for (let i = 0; i < count && q + per <= trun.end; i++) {
        let duration = defDuration;
        let size = defSize;
        if (tf & 0x100) {
          duration = u32(b, q);
          q += 4;
        }
        if (tf & 0x200) {
          size = u32(b, q);
          q += 4;
        }
        if (tf & 0x400) q += 4;
        if (tf & 0x800) q += 4;
        if (id === trackId) out.push({ offset: dataPos, size, time, duration });
        dataPos += size;
        time += duration;
      }
    }
    prevTrafEnd = dataPos;
  }
  return out;
}

/** Walks the top-level boxes after the index and hands out the samples of each 'moof'. */
class FragmentWalker {
  private queue: SampleInfo[] = [];
  private qi = 0;

  constructor(
    private readonly source: ByteSource,
    private pos: number,
    private readonly trackId: number,
    private readonly defaults: TrackDefaults,
  ) {}

  get position(): number {
    return this.pos;
  }

  async next(): Promise<SampleInfo | null> {
    while (this.qi >= this.queue.length) {
      const box = await fileBoxAt(this.source, this.pos, this.source.size);
      if (!box) return null;
      this.pos = box.end;
      if (box.type !== 'moof' || box.end - box.start > 64 << 20) continue;
      const bytes = await readRange(this.source, box.start, box.end - box.start);
      this.queue = parseMoof(bytes, box.start, this.trackId, this.defaults);
      this.qi = 0;
    }
    return this.queue[this.qi++];
  }
}

/* ------------------------------------------------------------ probing */

export interface Mp4Probe {
  info: EncodedAudioInfo;
  brand: string;
  track: Track;
  /** Start of the first box after 'moov' (fragments follow there). */
  fragmentStart?: number;
  fragmentDefaults?: TrackDefaults;
}

/** Reads the index of an MP4 file and describes its first audio track. */
export async function probeMp4(source: ByteSource): Promise<Mp4Probe> {
  let pos = 0;
  let moovBox: Box | null = null;
  let brand = '';
  let afterMoov: number | undefined;
  for (let guard = 0; guard < 100000; guard++) {
    const box = await fileBoxAt(source, pos, source.size);
    if (!box) break;
    if (box.type === 'ftyp') brand = fourcc(await readRange(source, box.body, 4), 0);
    if (box.type === 'moov') {
      moovBox = box;
      afterMoov = box.end;
      break;
    }
    if (box.end <= pos) break;
    pos = box.end;
  }
  if (!moovBox) throw new AudioError(brand ? 'decode-failed' : 'unsupported-format');
  if (moovBox.end - moovBox.start > MAX_MOOV_BYTES) throw new AudioError('unsupported-format');
  const b = await readRange(source, moovBox.start, moovBox.end - moovBox.start);
  const moov: Box = { type: 'moov', start: 0, body: moovBox.body - moovBox.start, end: b.length };

  const mvhd = childBox(b, moov, 'mvhd');
  const mv1 = mvhd ? b[mvhd.body] === 1 : false;
  const movieTimescale = mvhd ? u32(b, mvhd.body + (mv1 ? 20 : 12)) : 0;
  const movieDuration = mvhd ? (mv1 ? u64(b, mvhd.body + 24) : u32(b, mvhd.body + 16)) : 0;

  const tracks: Track[] = [];
  for (const c of childBoxes(b, moov.body, moov.end)) {
    if (c.type !== 'trak') continue;
    const t = parseTrack(b, c);
    if (t) tracks.push(t);
  }
  const audioTracks = tracks.filter((t) => t.handler === 'soun' && t.stsd);
  const track = audioTracks[0];
  if (!track || !track.stsd) throw new AudioError('no-audio');
  const entry = parseAudioEntry(b, track.stsd, track.timescale);
  if (!entry) throw new AudioError('unsupported-format');

  // Fragmented files: defaults from 'trex', total length from 'mehd'.
  const mvex = childBox(b, moov, 'mvex');
  let fragmentDefaults: TrackDefaults | undefined;
  let fragmentDuration = 0;
  if (mvex) {
    fragmentDefaults = { duration: 0, size: 0 };
    for (const c of childBoxes(b, mvex.body, mvex.end)) {
      if (c.type === 'trex' && u32(b, c.body + 4) === track.id) fragmentDefaults = { duration: u32(b, c.body + 12), size: u32(b, c.body + 16) };
      if (c.type === 'mehd') fragmentDuration = b[c.body] === 1 ? u64(b, c.body + 4) : u32(b, c.body + 4);
    }
  }

  // Timing: media samples, priming (skip) and real length (total), in media timescale units.
  const ts = track.timescale || entry.sampleRate;
  let mediaSamples = 0;
  if (track.table) {
    const s = track.table.stts;
    for (let i = 0; i + 1 < s.length; i += 2) mediaSamples += s[i] * s[i + 1];
  }
  if (!mediaSamples) mediaSamples = track.duration;
  let skip = 0;
  let total: number | undefined;
  const edit = track.edits.find((e) => e.mediaTime >= 0);
  const smpb = parseItunSmpb(b, moov);
  if (edit) {
    skip = edit.mediaTime;
    if (edit.segmentDuration > 0 && movieTimescale > 0) total = Math.round((edit.segmentDuration * ts) / movieTimescale);
  }
  if (smpb && ts === entry.sampleRate && (!edit || edit.mediaTime === 0)) {
    // iTunes gapless info, used when the edit list does not trim (old iTunes files).
    skip = smpb.priming;
    total = smpb.total > 0 ? smpb.total : undefined;
  }
  if (total !== undefined && mediaSamples > 0 && total > mediaSamples - skip) total = Math.max(0, mediaSamples - skip);

  let durationSec: number;
  let durationExact = true;
  if (total !== undefined) durationSec = total / ts;
  else if (mediaSamples > 0) durationSec = Math.max(0, mediaSamples - skip) / ts;
  else if (fragmentDuration > 0 && movieTimescale > 0) durationSec = fragmentDuration / movieTimescale;
  else if (movieDuration > 0 && movieTimescale > 0) durationSec = movieDuration / movieTimescale;
  else {
    durationSec = 0;
    durationExact = false;
  }
  if (mvex && !track.table?.count) durationExact = fragmentDuration > 0;

  // Chapters: QuickTime chapter track first, then Nero.
  let chapters: ChapterMark[] = [];
  const chapterIds = new Set(tracks.flatMap((t) => t.chapterRefs));
  const chapterTrack = tracks.find((t) => chapterIds.has(t.id) && t.handler !== 'soun');
  if (chapterTrack) chapters = await quickTimeChapters(source, chapterTrack).catch(() => []);
  if (chapters.length === 0) chapters = neroChapters(b, moov);

  let bytes = 0;
  if (track.table) {
    if (track.table.sizes) for (let i = 0; i < track.table.sizes.length; i++) bytes += track.table.sizes[i];
    else bytes = track.table.fixedSize * track.table.count;
  }
  const bitrateKbps = entry.avgBitrate ? Math.round(entry.avgBitrate / 1000) : bytes > 0 && durationSec > 0 ? Math.round((bytes * 8) / durationSec / 1000) : undefined;

  const scale = entry.sampleRate / ts;
  const info: EncodedAudioInfo = {
    container: 'mp4',
    codec: entry.codec,
    webCodecs: entry.webCodecs,
    description: entry.description,
    sampleRate: entry.sampleRate,
    channels: entry.channels,
    skipSamples: Math.round(skip * scale),
    totalSamples: total !== undefined ? Math.round(total * scale) : undefined,
    durationSec,
    durationExact,
    bitrateKbps,
    chapters: cleanChapters(chapters, durationSec),
    drm: entry.drm ?? (brand === 'aax ' ? 'Audible' : undefined),
  };
  return { info, brand, track, fragmentStart: mvex ? afterMoov : undefined, fragmentDefaults };
}

/* ------------------------------------------------------------ packet reader */

export class Mp4PacketReader implements PacketReader {
  private readonly cursor: SampleCursor | null;
  private readonly fragments: FragmentWalker | null;
  private readonly reader: WindowReader;
  private readonly timescale: number;
  private lastOffset = 0;
  private done = false;

  private constructor(
    readonly info: EncodedAudioInfo,
    private readonly source: ByteSource,
    probe: Mp4Probe,
    private readonly signal?: AbortSignal,
  ) {
    this.cursor = probe.track.table && probe.track.table.count > 0 ? new SampleCursor(probe.track.table) : null;
    this.fragments =
      probe.fragmentStart !== undefined && probe.fragmentDefaults
        ? new FragmentWalker(source, probe.fragmentStart, probe.track.id, probe.fragmentDefaults)
        : null;
    this.reader = new WindowReader(source);
    this.timescale = probe.track.timescale || info.sampleRate;
  }

  /** Opens the first audio track. Throws 'drm-protected' for copy protected files. */
  static async open(source: ByteSource, signal?: AbortSignal): Promise<Mp4PacketReader> {
    const probe = await probeMp4(source);
    checkAborted(signal);
    if (probe.info.drm) throw new AudioError('drm-protected');
    return new Mp4PacketReader(probe.info, source, probe, signal);
  }

  async next(): Promise<EncodedPacket | null> {
    if (this.done) return null;
    checkAborted(this.signal);
    let s = this.cursor?.next() ?? null;
    if (!s && this.fragments) s = await this.fragments.next();
    if (!s || s.size <= 0 || s.offset + s.size > this.source.size) {
      this.done = true; // end, or a truncated file
      return null;
    }
    await this.reader.ensure(s.offset, s.size);
    const i = s.offset - this.reader.base;
    if (i < 0 || i + s.size > this.reader.buf.length) {
      this.done = true;
      return null;
    }
    this.lastOffset = s.offset + s.size;
    return {
      data: this.reader.buf.subarray(i, i + s.size),
      timestampUs: Math.round((s.time * 1e6) / this.timescale),
      durationUs: Math.round((s.duration * 1e6) / this.timescale),
    };
  }

  progress(): number {
    return Math.min(1, Math.max(this.lastOffset, this.fragments?.position ?? 0) / Math.max(1, this.source.size));
  }

  async close(): Promise<void> {
    this.done = true;
  }
}
