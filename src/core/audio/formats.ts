/**
 * Container detection from the first bytes of a file. The file extension is
 * only a tie-breaker: renamed files ("MP3s" that are really M4A or WebM) are
 * common, and the content decides which decoder runs.
 */
import type { ByteSource } from '../../platform/types';
import { parseId3v2Header } from './id3';
import { decodeHeader, readU32 } from './mp3frames';
import { readRange } from './source';

export type ContainerKind =
  | 'mp3'
  | 'wav'
  | 'mp4'
  | 'aac'
  | 'flac'
  | 'ogg'
  | 'webm'
  | 'aiff'
  | 'asf'
  | 'unknown';

/** Bytes read for sniffing (after leading ID3 tags). */
const SNIFF_BYTES = 64 * 1024;

const EXTENSIONS: Record<string, ContainerKind> = {
  mp3: 'mp3',
  mp2: 'mp3',
  mpga: 'mp3',
  wav: 'wav',
  wave: 'wav',
  m4a: 'mp4',
  m4b: 'mp4',
  m4p: 'mp4',
  mp4: 'mp4',
  mov: 'mp4',
  '3gp': 'mp4',
  aac: 'aac',
  adts: 'aac',
  flac: 'flac',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  webm: 'webm',
  mka: 'webm',
  mkv: 'webm',
  weba: 'webm',
  aif: 'aiff',
  aiff: 'aiff',
  aifc: 'aiff',
  wma: 'asf',
  asf: 'asf',
};

/** Container guessed from a file name, or 'unknown'. */
export function kindFromName(name: string): ContainerKind {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return (m && EXTENSIONS[m[1].toLowerCase()]) || 'unknown';
}

function ascii(b: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

/** ADTS frame length at `p`, or 0 when there is no plausible ADTS header. */
export function adtsFrameLength(b: Uint8Array, p: number): number {
  if (p + 7 > b.length) return 0;
  if (b[p] !== 0xff || (b[p + 1] & 0xf6) !== 0xf0) return 0; // sync, layer 00
  if (((b[p + 2] >> 2) & 0x0f) > 12) return 0; // sampling frequency index
  const len = ((b[p + 3] & 0x03) << 11) | (b[p + 4] << 3) | (b[p + 5] >> 5);
  const headerLen = b[p + 1] & 1 ? 7 : 9;
  return len > headerLen ? len : 0;
}

/** True when `count` ADTS frames follow each other from `p` (or the data ends early). */
function adtsChain(b: Uint8Array, p: number, count: number): boolean {
  let q = p;
  for (let i = 0; i < count; i++) {
    const len = adtsFrameLength(b, q);
    if (!len) return false;
    q += len;
    if (q + 7 > b.length) return i > 0;
  }
  return true;
}

/** True when `count` MPEG audio frames with the same format follow each other from `p`. */
function mpegChain(b: Uint8Array, p: number, count: number): boolean {
  const first = p + 4 <= b.length ? decodeHeader(readU32(b, p)) : null;
  if (!first) return false;
  let q = p;
  for (let i = 0; i < count; i++) {
    if (q + 4 > b.length) return i > 1;
    const h = decodeHeader(readU32(b, q));
    if (!h || h.version !== first.version || h.layer !== first.layer || h.sampleRate !== first.sampleRate) return false;
    q += h.frameLength;
  }
  return true;
}

function sniffBytes(b: Uint8Array): ContainerKind {
  const magic4 = ascii(b, 0, 4);
  if ((magic4 === 'RIFF' || magic4 === 'RF64' || magic4 === 'BW64') && ascii(b, 8, 4) === 'WAVE') return 'wav';
  if (magic4 === 'FORM' && (ascii(b, 8, 4) === 'AIFF' || ascii(b, 8, 4) === 'AIFC')) return 'aiff';
  if (magic4 === 'fLaC') return 'flac';
  if (magic4 === 'OggS') return 'ogg';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75 && b[4] === 0x8e && b[5] === 0x66) return 'asf';
  const box = ascii(b, 4, 4);
  const boxSize = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  // QuickTime files from old tools can start without 'ftyp'.
  if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box) && (boxSize === 1 || boxSize >= 8)) return 'mp4';
  if (adtsChain(b, 0, 3)) return 'aac';
  if (mpegChain(b, 0, 3)) return 'mp3';
  return 'unknown';
}

/** Detects the container of an audio file from its content, falling back to the file extension. */
export async function sniffContainer(source: ByteSource): Promise<ContainerKind> {
  let offset = 0;
  // Skip leading ID3v2 tags (MP3, but also AAC and FLAC files carry them).
  for (let guard = 0; guard < 4; guard++) {
    const head = await readRange(source, offset, 10);
    const tag = head.length >= 10 ? parseId3v2Header(head, 0) : null;
    if (!tag) break;
    offset += tag.size;
  }
  const b = await readRange(source, offset, SNIFF_BYTES);
  if (b.length < 4) return 'unknown';
  const kind = sniffBytes(b);
  if (kind !== 'unknown') return kind;
  // Junk before the first frame (common in MP3 files from old rippers).
  const byName = kindFromName(source.name);
  const limit = b.length - 4;
  for (let p = 1; p < limit; p++) {
    if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) continue;
    if ((b[p + 1] & 0x06) === 0) {
      if (adtsChain(b, p, 4)) return 'aac';
    } else if (mpegChain(b, p, 4)) {
      return 'mp3';
    }
  }
  // An MP3 whose audio starts beyond the sniffed range: let the MP3 scanner decide.
  return byName === 'mp3' ? 'mp3' : 'unknown';
}
