/**
 * What a WebM/Matroska file tells without decoding it: the audio codec and
 * the playing time. Nothing here decodes WebM (the browser's own decoder
 * does, see browserBackend.ts); the facts decide whether that is possible
 * and whether the file is short enough for it.
 *
 * Recordings made with MediaRecorder often have no Duration element, so the
 * playing time then comes from the timecode of the last cluster.
 */
import type { ByteSource } from '../../platform/types';
import { readRange } from './source';

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CLUSTER = 0x1f43b675;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const BLOCK_DURATION = 0x9b;
const CRC32 = 0xbf;
const VOID = 0xec;
/** Elements that end a cluster of unknown size. */
const TOP_LEVEL = [CLUSTER, 0x1c53bb6b /* Cues */, 0x1254c367 /* Tags */, 0x1941a469 /* Attachments */, 0x1043a770 /* Chapters */];

/** Bytes read at the start for the header, and at most at the end for the last cluster. */
const HEAD_BYTES = 256 << 10;
const MAX_TAIL_BYTES = 16 << 20;

export interface WebmProbe {
  /** e.g. "opus", "vorbis" (from the CodecID of the first audio track). */
  codec?: string;
  durationSec?: number;
}

interface Element {
  id: number;
  /** Start of the element's data. */
  data: number;
  size: number;
  /** Size not known (live recordings): the element runs until its parent ends. */
  unknown: boolean;
  /** End of the data (data + size; meaningless when unknown). */
  end: number;
}

/** EBML variable-length integer at `p`; null when invalid or cut off. */
function vint(b: Uint8Array, p: number, keepMarker: boolean): { value: number; length: number; allOnes: boolean } | null {
  if (p >= b.length || b[p] === 0) return null;
  const first = b[p];
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (p + length > b.length) return null;
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let allOnes = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[p + i];
    if (b[p + i] !== 0xff) allOnes = false;
  }
  return { value, length, allOnes };
}

function element(b: Uint8Array, p: number): Element | null {
  const id = vint(b, p, true);
  if (!id || id.length > 4) return null;
  const size = vint(b, p + id.length, false);
  if (!size) return null;
  const data = p + id.length + size.length;
  return { id: id.value, data, size: size.value, unknown: size.allOnes, end: data + size.value };
}

function uint(b: Uint8Array, e: Element): number {
  let v = 0;
  for (let i = 0; i < e.size && e.data + i < b.length; i++) v = v * 256 + b[e.data + i];
  return v;
}

function float(b: Uint8Array, e: Element): number {
  if (e.data + e.size > b.length) return Number.NaN;
  const v = new DataView(b.buffer, b.byteOffset + e.data, e.size);
  return e.size === 4 ? v.getFloat32(0) : e.size === 8 ? v.getFloat64(0) : Number.NaN;
}

/** The children of [start, end) in `b`; stops at the first one that does not parse. */
function* children(b: Uint8Array, start: number, end: number): Generator<Element> {
  let p = start;
  const stop = Math.min(end, b.length);
  while (p < stop) {
    const e = element(b, p);
    if (!e) return;
    yield e;
    if (e.unknown) return;
    p = e.end;
  }
}

function codecName(codecId: string): string {
  const known: Record<string, string> = { A_OPUS: 'opus', A_VORBIS: 'vorbis', A_FLAC: 'flac', 'A_MPEG/L3': 'mp3', A_AC3: 'ac3', A_EAC3: 'eac3' };
  if (known[codecId]) return known[codecId];
  if (codecId.startsWith('A_AAC')) return 'aac';
  if (codecId.startsWith('A_PCM')) return 'pcm';
  return codecId.replace(/^A_/, '').toLowerCase();
}

/** Relative timecode of a (Simple)Block whose data starts at `p`. */
function blockTime(b: Uint8Array, p: number): number | undefined {
  const track = vint(b, p, false);
  if (!track || p + track.length + 2 > b.length) return undefined;
  const o = p + track.length;
  return (((b[o] << 8) | b[o + 1]) << 16) >> 16;
}

/** End time of the last cluster in `b` (timecode units), from its timecode and its last block. */
function lastClusterEnd(b: Uint8Array): number | undefined {
  for (let p = b.length - 4; p >= 0; p--) {
    if (b[p] !== 0x1f || b[p + 1] !== 0x43 || b[p + 2] !== 0xb6 || b[p + 3] !== 0x75) continue;
    const cluster = element(b, p);
    if (!cluster) continue;
    let timecode: number | undefined;
    let last = 0;
    for (const e of children(b, cluster.data, cluster.unknown ? b.length : cluster.end)) {
      if (e.id === CRC32 || e.id === VOID) continue;
      // The timecode comes first; anything else means these bytes only look like a cluster.
      if (timecode === undefined) {
        if (e.id !== TIMECODE || e.size < 1 || e.size > 8) break;
        timecode = uint(b, e);
      } else if (TOP_LEVEL.includes(e.id)) break;
      else if (e.id === SIMPLE_BLOCK) last = Math.max(last, blockTime(b, e.data) ?? 0);
      else if (e.id === BLOCK_GROUP) {
        let time = 0;
        let duration = 0;
        for (const g of children(b, e.data, e.end)) {
          if (g.id === BLOCK) time = blockTime(b, g.data) ?? 0;
          else if (g.id === BLOCK_DURATION) duration = uint(b, g);
        }
        last = Math.max(last, time + duration);
      }
    }
    if (timecode !== undefined) return timecode + last;
  }
  return undefined;
}

/** Codec and playing time of a WebM/Matroska file; fields stay empty when the file does not tell. */
export async function probeWebm(source: ByteSource): Promise<WebmProbe> {
  const out: WebmProbe = {};
  const head = await readRange(source, 0, Math.min(source.size, HEAD_BYTES));
  const header = element(head, 0);
  if (!header || header.id !== EBML) return out;
  const segment = element(head, header.end);
  if (!segment || segment.id !== SEGMENT) return out;
  let scale = 1_000_000; // nanoseconds per timecode unit
  let duration = 0;
  for (const e of children(head, segment.data, segment.unknown ? head.length : segment.end)) {
    if (e.id === CLUSTER) break;
    if (e.id === INFO) {
      for (const c of children(head, e.data, e.end)) {
        if (c.id === TIMECODE_SCALE) scale = uint(head, c) || scale;
        else if (c.id === DURATION) duration = float(head, c) || 0;
      }
    } else if (e.id === TRACKS && !out.codec) {
      for (const t of children(head, e.data, e.end)) {
        if (t.id !== TRACK_ENTRY) continue;
        let type = 0;
        let codecId = '';
        for (const c of children(head, t.data, t.end)) {
          if (c.id === TRACK_TYPE) type = uint(head, c);
          else if (c.id === CODEC_ID) codecId = new TextDecoder().decode(head.subarray(c.data, Math.min(c.end, head.length))).replace(/\0+$/, '');
        }
        if (type === 2 || (type === 0 && codecId.startsWith('A_'))) {
          out.codec = codecName(codecId);
          break;
        }
      }
    }
  }
  if (duration > 0) {
    out.durationSec = (duration * scale) / 1e9;
    return out;
  }
  // No Duration element (live recordings): the last cluster tells how long the file plays.
  for (let tail = 1 << 20; ; tail *= 4) {
    const start = Math.max(0, source.size - tail);
    const end = lastClusterEnd(await readRange(source, start, source.size - start));
    if (end !== undefined) {
      out.durationSec = (end * scale) / 1e9;
      break;
    }
    if (start === 0 || tail >= MAX_TAIL_BYTES) break;
  }
  return out;
}
