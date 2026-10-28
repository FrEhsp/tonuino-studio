/**
 * MPEG audio frame parsing and a streaming frame index (scanMp3).
 *
 * The index lists the byte offset of every audio frame. It is what the
 * lossless tools (cutting, gain) work on. The scanner skips ID3v2 tags and
 * junk, stops before ID3v1/APE/Lyrics3, resynchronises after damage (a new
 * position is only accepted when several consecutive headers agree on MPEG
 * version, layer, sample rate and channel count), excludes the Xing/Info/VBRI
 * frame and rejects free-format streams and streams that change their format
 * halfway (MPEG version, layer, sample rate or mono/stereo).
 *
 * What the scan had to skip tells whether a file is damaged or was joined
 * from several files (isDamagedMp3, looksJoined, checkMp3): the box's MP3
 * player can stumble over both, so the import converts such files anew.
 */
import type { ByteSource } from '../../platform/types';
import { AudioError, checkAborted, isAbortError } from './errors';
import { measureTags, parseId3v2Header, type TagLayout } from './id3';
import { CHUNK_SIZE, WindowReader } from './source';

export type MpegVersion = 1 | 2 | 2.5;

export interface FrameHeader {
  /** The 32 header bits. */
  raw: number;
  version: MpegVersion;
  /** Raw 2-bit version field: 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5. */
  versionBits: number;
  layer: 1 | 2 | 3;
  /** True when a 16-bit CRC follows the header (protection bit 0). */
  crc: boolean;
  bitrateIndex: number;
  bitrateKbps: number;
  sampleRateIndex: number;
  sampleRate: number;
  padding: 0 | 1;
  /** 0 stereo, 1 joint stereo, 2 dual channel, 3 mono. */
  channelMode: number;
  modeExtension: number;
  channels: 1 | 2;
  samplesPerFrame: number;
  frameLength: number;
  /** Layer III side information in bytes (0 for Layer I/II). */
  sideInfoSize: number;
}

export interface XingInfo {
  kind: 'Xing' | 'Info' | 'VBRI';
  /** File offset and length of the tag frame. */
  offset: number;
  frameLength: number;
  frames?: number;
  bytes?: number;
  toc?: Uint8Array;
  quality?: number;
}

export interface LameInfo {
  /** Encoder delay in samples as stored in the LAME tag (decoders add 529). */
  encoderDelay: number;
  padding: number;
  /** e.g. "LAME3.100", "Lavf60.3." */
  encoder: string;
}

export interface Mp3Index {
  /** Offset of the first MPEG frame (the Xing/Info frame when there is one). */
  audioStart: number;
  /** End of the last complete audio frame. */
  audioEnd: number;
  /** Offset of every audio frame, Xing/Info frame excluded. */
  frameOffsets: Uint32Array | Float64Array;
  frameCount: number;
  sampleRate: number;
  channels: 1 | 2;
  /** Channel mode of the first audio frame. */
  channelMode: number;
  samplesPerFrame: number;
  /** All audio frames use the same bitrate. */
  cbr: boolean;
  /** The bitrate when `cbr`. */
  bitrateKbps?: number;
  avgBitrateKbps: number;
  /**
   * Playing time as a gapless decoder (mpg123) outputs it: all frames, minus
   * decoder delay, LAME encoder delay and padding when a Xing/Info frame
   * gives the frame count (see decodedSampleCount).
   */
  durationSec: number;
  xing?: XingInfo;
  lame?: LameInfo;
  version: MpegVersion;
  layer: 1 | 2 | 3;
  /** Tag blocks around the audio. */
  tags: TagLayout;
  /** Bytes skipped between frames because they were not valid audio. */
  junkBytes: number;
  /** The part of junkBytes after the first frame: damage, or the seams of joined files. */
  innerJunkBytes: number;
  /** How often the scan had to search for the next frame after the first one. */
  resyncs: number;
  /** ID3v2 tags found between frames (a file joined from tagged files). */
  innerTags: number;
  /** Sum of all audio frame lengths. */
  audioBytes: number;
}

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Read size (default 1 MiB). */
  chunkSize?: number;
  /**
   * Called for every audio frame of the index, in order, with the bytes
   * around it: the frame starts at `buf[at]` with the 32 header bits `header`,
   * and its first FRAME_PEEK_BYTES (or the whole frame, when shorter) are in
   * `buf`. Lets a caller read the side information in the same pass
   * (mp3levels.ts) instead of reading the file twice.
   */
  onFrame?: (buf: Uint8Array, at: number, header: number) => void;
}

/** Bytes of each frame onFrame can look at: header, CRC and the largest side information. */
export const FRAME_PEEK_BYTES = 4 + 2 + 32;

/* ------------------------------------------------------------ tables */

const BITRATES: readonly (readonly number[])[] = [
  // MPEG1 Layer I, II, III
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  // MPEG2/2.5 Layer I, II, III
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
];

const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/** Layer bits (1 = III, 2 = II, 3 = I) to layer number. */
const LAYER_OF_BITS = [0, 3, 2, 1] as const;

function versionOfBits(bits: number): MpegVersion {
  return bits === 3 ? 1 : bits === 2 ? 2 : 2.5;
}

export function versionBitsOf(version: MpegVersion): number {
  return version === 1 ? 3 : version === 2 ? 2 : 0;
}

/** kbps for a bitrate index, 0 for free/bad indices. */
export function bitrateFor(version: MpegVersion, layer: 1 | 2 | 3, index: number): number {
  return BITRATES[(version === 1 ? 0 : 3) + layer - 1][index] ?? 0;
}

/** All valid bitrates (kbps) for a version and layer, ascending, with their indices. */
export function bitrateTable(version: MpegVersion, layer: 1 | 2 | 3): { index: number; kbps: number }[] {
  const row = BITRATES[(version === 1 ? 0 : 3) + layer - 1];
  const out: { index: number; kbps: number }[] = [];
  for (let i = 1; i < 15; i++) out.push({ index: i, kbps: row[i] });
  return out;
}

export function samplesPerFrameFor(version: MpegVersion, layer: 1 | 2 | 3): number {
  if (layer === 1) return 384;
  if (layer === 2) return 1152;
  return version === 1 ? 1152 : 576;
}

export function sideInfoSizeFor(version: MpegVersion, channels: 1 | 2): number {
  if (version === 1) return channels === 1 ? 17 : 32;
  return channels === 1 ? 9 : 17;
}

/** Frame length in bytes; 0 for invalid parameters. */
export function frameLengthFor(version: MpegVersion, layer: 1 | 2 | 3, kbps: number, sampleRate: number, padding: number): number {
  if (kbps <= 0 || sampleRate <= 0) return 0;
  if (layer === 1) return (Math.floor((12 * kbps * 1000) / sampleRate) + padding) * 4;
  const coef = layer === 3 && version !== 1 ? 72 : 144;
  return Math.floor((coef * kbps * 1000) / sampleRate) + padding;
}

/**
 * Frame length by an 11-bit key (version, layer, bitrate index, sample rate
 * index, padding); 0 marks reserved, free-format or bad combinations.
 */
const FRAME_LEN = (() => {
  const t = new Uint16Array(2048);
  for (const vb of [0, 2, 3]) {
    const version = versionOfBits(vb);
    for (let lb = 1; lb <= 3; lb++) {
      const layer = LAYER_OF_BITS[lb] as 1 | 2 | 3;
      for (let bi = 1; bi < 15; bi++) {
        for (let si = 0; si < 3; si++) {
          for (let pad = 0; pad < 2; pad++) {
            const key = (vb << 9) | (lb << 7) | (bi << 3) | (si << 1) | pad;
            t[key] = frameLengthFor(version, layer, bitrateFor(version, layer, bi), SAMPLE_RATES[vb][si], pad);
          }
        }
      }
    }
  }
  return t;
})();

function lengthKey(h: number): number {
  return (((h >>> 19) & 3) << 9) | (((h >>> 17) & 3) << 7) | (((h >>> 12) & 15) << 3) | (((h >>> 10) & 3) << 1) | ((h >>> 9) & 1);
}

/** Frame length for a 32-bit header, 0 when the header is not a usable frame header. */
export function frameLengthOf(h: number): number {
  if ((h >>> 21) !== 0x7ff || (h & 3) === 2) return 0;
  return FRAME_LEN[lengthKey(h)];
}

/** Stream signature: version, layer, sample rate and mono/stereo must not change. */
function signatureOf(h: number): number {
  return (h & 0xfffe0c00) + ((h & 0xc0) === 0xc0 ? 1 : 0);
}

function isFreeFormat(h: number): boolean {
  return (h >>> 21) === 0x7ff && ((h >>> 12) & 15) === 0 && ((h >>> 19) & 3) !== 1 && ((h >>> 17) & 3) !== 0 && ((h >>> 10) & 3) !== 3;
}

export function readU32(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

/** Parses a frame header at `offset`; null when the bytes are not a valid header. */
export function parseFrameHeader(b: Uint8Array, offset: number): FrameHeader | null {
  if (offset < 0 || offset + 4 > b.length) return null;
  return decodeHeader(readU32(b, offset));
}

export function decodeHeader(h: number): FrameHeader | null {
  const frameLength = frameLengthOf(h);
  if (frameLength === 0) return null;
  const versionBits = (h >>> 19) & 3;
  const version = versionOfBits(versionBits);
  const layer = LAYER_OF_BITS[(h >>> 17) & 3] as 1 | 2 | 3;
  const bitrateIndex = (h >>> 12) & 15;
  const sampleRateIndex = (h >>> 10) & 3;
  const channelMode = (h >>> 6) & 3;
  const channels: 1 | 2 = channelMode === 3 ? 1 : 2;
  return {
    raw: h,
    version,
    versionBits,
    layer,
    crc: ((h >>> 16) & 1) === 0,
    bitrateIndex,
    bitrateKbps: bitrateFor(version, layer, bitrateIndex),
    sampleRateIndex,
    sampleRate: SAMPLE_RATES[versionBits][sampleRateIndex],
    padding: ((h >>> 9) & 1) as 0 | 1,
    channelMode,
    modeExtension: (h >>> 4) & 3,
    channels,
    samplesPerFrame: samplesPerFrameFor(version, layer),
    frameLength,
    sideInfoSize: layer === 3 ? sideInfoSizeFor(version, channels) : 0,
  };
}

/* ------------------------------------------------------------ Xing / VBRI / LAME */

const LAME_PREFIXES = ['LAME', 'Lavf', 'Lavc', 'L3.9', 'GOGO'];

function ascii4(b: Uint8Array, o: number): string {
  return o + 4 <= b.length ? String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) : '';
}

/**
 * Looks for a Xing/Info or VBRI header in a Layer III frame (`frame` holds the
 * whole frame starting at its header) and for a LAME extension after it.
 */
export function parseXingFrame(frame: Uint8Array, hdr: FrameHeader, fileOffset = 0): { xing: XingInfo; lame?: LameInfo } | null {
  if (hdr.layer !== 3) return null;
  const candidates = [4 + hdr.sideInfoSize, 4 + (hdr.crc ? 2 : 0) + hdr.sideInfoSize];
  for (const at of candidates) {
    const magic = ascii4(frame, at);
    if (magic !== 'Xing' && magic !== 'Info') continue;
    if (at + 8 > frame.length) return null;
    const flags = readU32(frame, at + 4);
    let p = at + 8;
    const xing: XingInfo = { kind: magic, offset: fileOffset, frameLength: hdr.frameLength };
    if (flags & 1 && p + 4 <= frame.length) {
      xing.frames = readU32(frame, p);
      p += 4;
    }
    if (flags & 2 && p + 4 <= frame.length) {
      xing.bytes = readU32(frame, p);
      p += 4;
    }
    if (flags & 4 && p + 100 <= frame.length) {
      xing.toc = frame.slice(p, p + 100);
      p += 100;
    }
    if (flags & 8 && p + 4 <= frame.length) {
      xing.quality = readU32(frame, p);
      p += 4;
    }
    let lame: LameInfo | undefined;
    if (p + 24 <= frame.length && LAME_PREFIXES.includes(ascii4(frame, p))) {
      let encoder = '';
      for (let i = 0; i < 9; i++) {
        const c = frame[p + i];
        if (c >= 0x20 && c < 0x7f) encoder += String.fromCharCode(c);
      }
      const d = p + 21;
      lame = {
        encoder: encoder.trim(),
        encoderDelay: (frame[d] << 4) | (frame[d + 1] >> 4),
        padding: ((frame[d + 1] & 0x0f) << 8) | frame[d + 2],
      };
    }
    return { xing, lame };
  }
  const v = 4 + 32;
  if (ascii4(frame, v) === 'VBRI' && v + 18 <= frame.length) {
    return {
      xing: {
        kind: 'VBRI',
        offset: fileOffset,
        frameLength: hdr.frameLength,
        bytes: readU32(frame, v + 10),
        frames: readU32(frame, v + 14),
      },
    };
  }
  return null;
}

/* ------------------------------------------------------------ scanning */

/** Growable list of frame offsets; Uint32Array unless the file exceeds 4 GiB. */
class OffsetList {
  private data: Uint32Array | Float64Array;
  length = 0;

  constructor(capacity: number, large: boolean) {
    this.data = large ? new Float64Array(capacity) : new Uint32Array(capacity);
  }

  push(v: number): void {
    if (this.length === this.data.length) {
      const next = this.data instanceof Float64Array ? new Float64Array(this.data.length * 2) : new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }

  finish(): Uint32Array | Float64Array {
    return this.data.slice(0, this.length);
  }
}

interface SyncState {
  freeFormatSeen: boolean;
  /** ID3v2 tags skipped. */
  tags: number;
}

/** Checks that `count` more headers follow the frame at `p` with the same signature. */
async function chainOk(reader: WindowReader, p: number, h: number, count: number): Promise<boolean> {
  const sig = signatureOf(h);
  let q = p;
  let hh = h;
  for (let k = 0; ; k++) {
    q += frameLengthOf(hh);
    if (q > reader.end) return false; // frame does not fit
    if (k === count || q + 4 > reader.end) return true;
    if (!(await reader.ensure(q, 4))) return false;
    const h2 = readU32(reader.buf, q - reader.base);
    if (frameLengthOf(h2) === 0 || signatureOf(h2) !== sig) return false;
    hh = h2;
  }
}

/** Longest free-format frame worth looking for (640 kbit/s at 32 kHz is 2880 bytes). */
const MAX_FREE_FRAME = 4096;

/**
 * A free-format header counts only when two more with the same signature
 * follow at the same distance, give or take the padding byte. Single ones
 * turn up in any data now and then, and would blame a broken file on a
 * rare kind of MP3.
 */
async function freeChainOk(reader: WindowReader, p: number, h: number): Promise<boolean> {
  const sig = signatureOf(h);
  await reader.ensure(p, 2 * MAX_FREE_FRAME + 8);
  const { buf, base, limit } = reader;
  const at = (q: number) => {
    if (q < base || q + 4 > limit) return false;
    const x = readU32(buf, q - base);
    return isFreeFormat(x) && signatureOf(x) === sig;
  };
  for (let d = 24; d <= MAX_FREE_FRAME; d++) {
    if (at(p + d) && (at(p + 2 * d) || at(p + 2 * d - 1) || at(p + 2 * d + 1))) return true;
  }
  return false;
}

/**
 * Finds the next position at or after `from` where a valid header starts a
 * chain of `chain + 1` consistent frames. `sig` < 0 accepts any stream.
 * Embedded ID3v2 tags are skipped. Returns -1 when nothing is found.
 */
async function findSync(reader: WindowReader, from: number, sig: number, chain: number, state: SyncState, signal?: AbortSignal): Promise<number> {
  let p = from;
  for (;;) {
    if (p + 4 > reader.end) return -1;
    if (p < reader.base || p + 10 > reader.limit) {
      await reader.ensure(p, reader.chunkSize);
      checkAborted(signal);
      if (p < reader.base || p + 4 > reader.limit) return -1; // source delivered less than announced
    }
    const buf = reader.buf;
    const base = reader.base;
    // Keep 10 bytes of look-ahead for ID3 headers unless the window reaches the end.
    const lim = reader.limit < reader.end ? reader.limit - 9 : reader.limit - 3;
    let candidate = false;
    while (p < lim) {
      const i = p - base;
      const b0 = buf[i];
      if ((b0 === 0xff && (buf[i + 1] & 0xe0) === 0xe0) || (b0 === 0x49 && buf[i + 1] === 0x44 && buf[i + 2] === 0x33)) {
        candidate = true;
        break;
      }
      p++;
    }
    if (!candidate) {
      if (reader.limit >= reader.end) return -1;
      const before = reader.limit;
      await reader.ensure(p, reader.chunkSize); // next window, keeping the unexamined tail
      checkAborted(signal);
      if (reader.limit <= before) return -1;
      continue;
    }
    const i = p - base;
    if (buf[i] === 0x49) {
      const tag = i + 10 <= buf.length ? parseId3v2Header(buf, i) : null;
      if (tag) state.tags++;
      p += tag ? tag.size : 1;
      continue;
    }
    const h = readU32(buf, i);
    if (frameLengthOf(h) > 0) {
      // chainOk may move the window; the loop re-reads it.
      if ((sig < 0 || signatureOf(h) === sig) && (await chainOk(reader, p, h, chain))) return p;
    } else if (!state.freeFormatSeen && isFreeFormat(h) && (await freeChainOk(reader, p, h))) {
      // freeChainOk may move the window too.
      state.freeFormatSeen = true;
    }
    p++;
  }
}

/**
 * Builds the frame index of an MP3 file, reading it in ~1 MB chunks.
 * Throws AudioError 'not-mp3', 'free-format' or 'mixed-format'.
 */
export async function scanMp3(source: ByteSource, opts: ScanOptions = {}): Promise<Mp3Index> {
  const { signal, onProgress, onFrame } = opts;
  const tags = await measureTags(source);
  checkAborted(signal);
  const start = tags.audioStart;
  const end = tags.audioEnd;
  const span = Math.max(1, end - start);
  const reader = new WindowReader(source, end, Math.max(64, opts.chunkSize ?? CHUNK_SIZE));
  const state: SyncState = { freeFormatSeen: false, tags: 0 };

  const first = await findSync(reader, start, -1, 3, state, signal);
  if (first < 0) throw new AudioError(state.freeFormatSeen ? 'free-format' : 'not-mp3');
  await reader.ensure(first, 4);
  const firstHeader = decodeHeader(readU32(reader.buf, first - reader.base)) as FrameHeader;
  const sig = signatureOf(firstHeader.raw);
  let p = first;
  let junkBytes = first - start;
  let innerJunkBytes = 0;
  let resyncs = 0;
  let innerTags = 0;

  let xing: XingInfo | undefined;
  let lame: LameInfo | undefined;
  if (firstHeader.layer === 3) {
    await reader.ensure(first, firstHeader.frameLength);
    const frame = reader.buf.subarray(first - reader.base, first - reader.base + firstHeader.frameLength);
    const tag = parseXingFrame(frame, firstHeader, first);
    if (tag) {
      xing = tag.xing;
      lame = tag.lame;
      p += firstHeader.frameLength;
    }
  }

  const large = end > 0xffffffff;
  const offsets = new OffsetList(Math.max(1024, Math.min(1 << 20, Math.ceil(span / 400))), large);
  let minBr = 15;
  let maxBr = 0;
  let audioBytes = 0;
  let lastEnd = p;
  let firstAudio = -1;

  // With onFrame, a frame is only taken when its first bytes are in the window (or the window reaches the end).
  const peek = onFrame ? FRAME_PEEK_BYTES : 4;
  for (;;) {
    if (p + 4 > end) break;
    if (p < reader.base || p + Math.min(peek, end - p) > reader.limit) {
      await reader.ensure(p, reader.chunkSize);
      checkAborted(signal);
      onProgress?.(Math.min(1, (p - start) / span));
      if (p < reader.base || p + 4 > reader.limit) break; // source delivered less than announced
    }
    const buf = reader.buf;
    const base = reader.base;
    const lim = reader.limit;
    let stop = false;
    let refill = false;
    while (p + 4 <= lim) {
      const i = p - base;
      const h = ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0;
      const len = (h >>> 21) === 0x7ff && (h & 3) !== 2 ? FRAME_LEN[lengthKey(h)] : 0;
      if (len === 0 || signatureOf(h) !== sig) break;
      if (p + len > end) {
        stop = true; // truncated last frame
        break;
      }
      if (onFrame) {
        if (p + peek > lim && lim < end) {
          refill = true;
          break;
        }
        onFrame(buf, i, h);
      }
      if (firstAudio < 0) firstAudio = h;
      offsets.push(p);
      const bi = (h >>> 12) & 15;
      if (bi < minBr) minBr = bi;
      if (bi > maxBr) maxBr = bi;
      audioBytes += len;
      p += len;
      lastEnd = p;
    }
    if (stop) break;
    if (refill || p + 4 > lim) continue; // window used up: the top of the loop loads more or ends
    // Damage or junk ends a run; the stream goes on at the next run of frames. A run in another
    // format (a mono intro before stereo chapters) is a second stream that one index cannot hold.
    const tagsBefore = state.tags;
    const next = await findSync(reader, p, -1, 3, state, signal);
    if (next < 0) break;
    await reader.ensure(next, 4);
    if (signatureOf(readU32(reader.buf, next - reader.base)) !== sig) throw new AudioError('mixed-format');
    junkBytes += next - p;
    innerJunkBytes += next - p;
    resyncs++;
    innerTags += state.tags - tagsBefore;
    p = next;
  }

  const frameCount = offsets.length;
  if (frameCount === 0) throw new AudioError(state.freeFormatSeen ? 'free-format' : 'not-mp3');
  const hdr = decodeHeader(firstAudio) as FrameHeader;
  const spf = hdr.samplesPerFrame;
  const totalSamples = decodedSampleCount({ xing, lame }, frameCount, spf);
  const rawSeconds = (frameCount * spf) / hdr.sampleRate;
  onProgress?.(1);
  return {
    audioStart: first,
    audioEnd: lastEnd,
    frameOffsets: offsets.finish(),
    frameCount,
    sampleRate: hdr.sampleRate,
    channels: hdr.channels,
    channelMode: hdr.channelMode,
    samplesPerFrame: spf,
    cbr: minBr === maxBr,
    bitrateKbps: minBr === maxBr ? hdr.bitrateKbps : undefined,
    avgBitrateKbps: rawSeconds > 0 ? (audioBytes * 8) / rawSeconds / 1000 : 0,
    durationSec: totalSamples / hdr.sampleRate,
    xing,
    lame,
    version: hdr.version,
    layer: hdr.layer,
    tags,
    junkBytes,
    innerJunkBytes,
    resyncs,
    innerTags,
    audioBytes,
  };
}

/* ------------------------------------------------------------ damaged and joined files */

/** Why an MP3 is made anew instead of copied: damaged frames, or joined from several files. */
export type Mp3Rebuild = 'damaged' | 'joined';

/** What a look at all frames of an MP3 found (see checkMp3). */
export interface Mp3Check {
  /** Set when the file should be converted anew. */
  rebuild?: Mp3Rebuild;
  /** Playing time by the frame index, when the frames could be indexed. */
  durationSec?: number;
}

/** True when a decoder put out clearly less than the frames hold: it dropped frames it could not decode. */
export function decodedTooShort(indexedSec: number, decodedSec: number): boolean {
  return indexedSec - decodedSec > Math.max(1, indexedSec * 0.02);
}

/**
 * Damage inside the audio: at least 1 KiB of junk after the first frame,
 * or two or more places where the frames broke off. With the decoder's
 * playing time at hand, also frames the decoder had to drop. Junk in front
 * of the first frame (a tag with a wrong size) does no harm.
 */
export function isDamagedMp3(index: Mp3Index, analysis?: { durationSec: number }): boolean {
  if (index.innerJunkBytes >= 1024 || index.resyncs >= 2) return true;
  return !!analysis && analysis.durationSec > 0 && decodedTooShort(index.durationSec, analysis.durationSec);
}

/** The first part's Xing/Info frame counts clearly fewer frames than the file holds. */
function moreFramesThanAnnounced(index: Mp3Index): boolean {
  const announced = index.xing?.frames;
  return announced !== undefined && announced > 0 && index.frameCount - announced > 2;
}

/**
 * Signs of a file joined byte for byte (mp3wrap, copy /b, an announcement
 * in front of a track): a tag of a later part between the frames (one
 * encode never puts an ID3v2 header there), more than 1 KiB of junk inside
 * the audio (tags and Info frames of the later parts), or a first Info
 * frame that counts clearly fewer frames than there are. Streams that
 * change their format halfway scanMp3 rejects as 'mixed-format'. Bytes
 * after the last frame do not count: every frame before them is whole, and
 * old programs left text blocks or zero bytes there.
 */
export function looksJoined(index: Mp3Index): boolean {
  return index.innerTags > 0 || index.innerJunkBytes > 1024 || moreFramesThanAnnounced(index);
}

/** Why the file is made anew, if it is: joined when a later part's tag or Info frame shows, else damaged. */
export function rebuildReason(index: Mp3Index, analysis?: { durationSec: number }): Mp3Rebuild | undefined {
  if (!isDamagedMp3(index, analysis) && !looksJoined(index)) return undefined;
  return index.innerTags > 0 || moreFramesThanAnnounced(index) ? 'joined' : 'damaged';
}

/**
 * Looks at every frame of an MP3 (one read of the whole file) and tells
 * whether it should be converted anew. A file with no MP3 audio counts as
 * damaged, one that changes its format halfway as joined. Free-format and
 * MP1/MP2 files are left as they are. Throws on read errors and aborts.
 */
export async function checkMp3(source: ByteSource, opts: ScanOptions = {}): Promise<{ check: Mp3Check; index?: Mp3Index }> {
  try {
    const index = await scanMp3(source, opts);
    return { check: { rebuild: rebuildReason(index), durationSec: index.durationSec }, index };
  } catch (e) {
    if (isAbortError(e) || !(e instanceof AudioError)) throw e;
    if (e.code === 'mixed-format') return { check: { rebuild: 'joined' } };
    if (e.code === 'not-mp3') return { check: { rebuild: 'damaged' } };
    if (e.code === 'free-format') return { check: {} };
    throw e;
  }
}

/* ------------------------------------------------------------ quick probe */

export interface Mp3Probe {
  firstFrame: number;
  header: FrameHeader;
  xing?: XingInfo;
  lame?: LameInfo;
  tags: TagLayout;
  /** From the Xing/VBRI frame count, or estimated from the file size. */
  durationSec: number;
}

/** Finds the first frame and reads the Xing/LAME data without indexing the whole file. */
export async function probeMp3(source: ByteSource, signal?: AbortSignal, windowBytes = 256 * 1024): Promise<Mp3Probe> {
  const tags = await measureTags(source);
  const reader = new WindowReader(source, tags.audioEnd, windowBytes);
  const state: SyncState = { freeFormatSeen: false, tags: 0 };
  const first = await findSync(reader, tags.audioStart, -1, 3, state, signal);
  if (first < 0) throw new AudioError(state.freeFormatSeen ? 'free-format' : 'not-mp3');
  await reader.ensure(first, 4);
  const header = decodeHeader(readU32(reader.buf, first - reader.base)) as FrameHeader;
  await reader.ensure(first, header.frameLength);
  const frame = reader.buf.subarray(first - reader.base, first - reader.base + header.frameLength);
  const tag = parseXingFrame(frame, header, first);
  let durationSec: number;
  if (tag?.xing.frames) {
    durationSec = decodedSampleCount(tag, tag.xing.frames, header.samplesPerFrame) / header.sampleRate;
  } else {
    const bytes = tags.audioEnd - first - (tag ? header.frameLength : 0);
    durationSec = (bytes * 8) / (header.bitrateKbps * 1000);
  }
  return { firstFrame: first, header, xing: tag?.xing, lame: tag?.lame, tags, durationSec };
}

/**
 * Playing time of an MP3: `tagged` (from its tags) when that can be trusted,
 * else from the Xing/Info frame, else from the bytes of a constant bitrate,
 * else from counting the frames, which reads the whole file. VBR files
 * without a Xing frame tell no time (tags and browsers guess it from the
 * first frame and can be minutes off), and joined files tell the time of
 * their first part.
 */
export async function mp3DurationSec(source: ByteSource, tagged: number | undefined, signal?: AbortSignal): Promise<number | undefined> {
  const probe = await probeMp3(source, signal, 16 << 10);
  const quick = await quickDuration(source, probe, tagged, signal);
  if (quick !== undefined) return quick;
  try {
    return (await scanMp3(source, { signal })).durationSec;
  } catch (e) {
    if (isAbortError(e) || !(e instanceof AudioError) || e.code === 'read-failed') throw e;
    // The frames cannot be counted (e.g. a second stream in another format): estimated from the bytes.
    const counted = probe.xing?.bytes;
    return tagged !== undefined && counted ? (tagged * (probe.tags.audioEnd - probe.firstFrame)) / counted : probe.durationSec;
  }
}

/**
 * The playing time without counting frames: `tagged` or the Xing/Info frame's
 * count when it covers the file, `tagged` or the size for a constant
 * bitrate. Undefined when only counting the frames tells.
 */
export async function quickDuration(source: ByteSource, probe: Mp3Probe, tagged: number | undefined, signal?: AbortSignal): Promise<number | undefined> {
  if (probe.xing?.frames && !countsPart(probe.tags.audioEnd - probe.firstFrame, probe.xing.bytes)) return tagged ?? probe.durationSec;
  if (!probe.xing && (await looksConstant(source, probe, signal))) {
    return tagged !== undefined && Math.abs(tagged - probe.durationSec) < 1 ? tagged : probe.durationSec;
  }
  return undefined;
}

/** MP3s joined byte for byte keep the Xing/Info frame of their first part: it counts clearly fewer bytes than the file holds. */
function countsPart(audioBytes: number, counted: number | undefined): boolean {
  return !!counted && audioBytes - counted > Math.max(64 << 10, counted / 100);
}

/**
 * The same as mp3DurationSec, with the frame index at hand: `tagged` when it
 * can be trusted (a Xing/Info frame for the whole file, or a constant
 * bitrate it agrees with), else the frames' time.
 */
export function mp3DurationOf(index: Mp3Index, tagged: number | undefined): number {
  if (tagged === undefined) return index.durationSec;
  if (index.xing?.frames && !countsPart(index.tags.audioEnd - index.audioStart, index.xing.bytes)) return tagged;
  if (!index.xing && index.cbr && Math.abs(tagged - index.durationSec) < 1) return tagged;
  return index.durationSec;
}

/**
 * True when frames at the start, a quarter, half and three quarters into
 * the audio all have the bitrate of the first frame: a constant bitrate,
 * whose playing time the file size tells. Reads a few KiB, not the file.
 */
async function looksConstant(source: ByteSource, probe: Mp3Probe, signal?: AbortSignal): Promise<boolean> {
  const sig = signatureOf(probe.header.raw);
  const kbps = probe.header.bitrateKbps;
  const start = probe.firstFrame;
  const end = probe.tags.audioEnd;
  const window = 6 << 10;
  for (const at of [0, 0.25, 0.5, 0.75]) {
    const from = start + Math.floor((end - start) * at);
    const buf = await readWindow(source, from, Math.min(window, end - from));
    checkAborted(signal);
    const rates = framesIn(buf, sig, at === 0);
    if (rates === null) return false; // no frames found: let the full scan decide
    if (rates.some((r) => r !== kbps)) return false;
  }
  return true;
}

async function readWindow(source: ByteSource, from: number, length: number): Promise<Uint8Array> {
  return length > 0 ? source.read(from, length) : new Uint8Array(0);
}

/** Bitrates of a chain of at least three frames in `buf`, or null. `atStart`: the chain begins at byte 0. */
function framesIn(buf: Uint8Array, sig: number, atStart: boolean): number[] | null {
  const last = atStart ? 1 : Math.max(0, buf.length - 4);
  for (let p = 0; p < last; p++) {
    if (buf[p] !== 0xff || (buf[p + 1] & 0xe0) !== 0xe0) continue;
    const rates: number[] = [];
    let q = p;
    while (q + 4 <= buf.length) {
      const h = readU32(buf, q);
      const hdr = signatureOf(h) === sig ? decodeHeader(h) : null;
      if (!hdr) break;
      rates.push(hdr.bitrateKbps);
      q += hdr.frameLength;
    }
    if (rates.length >= 3) return rates;
  }
  return null;
}

/* ------------------------------------------------------------ time mapping */

/** Decoder delay (samples) that gapless decoders add to the LAME encoder delay. */
export const DECODER_DELAY = 529;

type GaplessInfo = { xing?: Pick<XingInfo, 'frames'>; lame?: Pick<LameInfo, 'encoderDelay' | 'padding'> };

/**
 * Samples a gapless decoder (mpg123, used for analysis) drops at the start.
 * mpg123 does this whenever a Xing/Info frame states the frame count: the
 * decoder delay of 529 samples plus the LAME encoder delay when present.
 * Time 0 of decoded audio (and of AudioAnalysis.power) lies this many
 * samples into the first audio frame.
 */
export function leadingTrimSamples(index: GaplessInfo): number {
  if (!index.xing?.frames) return 0;
  return DECODER_DELAY + (index.lame?.encoderDelay ?? 0);
}

/**
 * Number of samples a gapless decoder (mpg123) outputs for `frameCount`
 * frames. Frames beyond the ones the Xing/Info frame announces (MP3s joined
 * byte for byte) it plays in full, after the trimmed end of the announced ones.
 */
export function decodedSampleCount(index: GaplessInfo, frameCount: number, samplesPerFrame: number): number {
  const total = frameCount * samplesPerFrame;
  const xingFrames = index.xing?.frames;
  if (!xingFrames) return total;
  const begin = leadingTrimSamples(index);
  const end = xingFrames * samplesPerFrame - (index.lame?.padding ?? 0) + DECODER_DELAY;
  const beyond = Math.max(0, frameCount - xingFrames) * samplesPerFrame;
  return Math.max(0, Math.min(total, end + beyond) - begin);
}

/** Nearest frame boundary (0..frameCount) for a time in decoded audio. */
export function frameAtTime(index: Mp3Index, timeSec: number): number {
  const f = Math.round((timeSec * index.sampleRate + leadingTrimSamples(index)) / index.samplesPerFrame);
  return Math.max(0, Math.min(index.frameCount, f));
}

/** Time in decoded audio where frame `f` starts (clamped to 0). */
export function timeOfFrame(index: Mp3Index, f: number): number {
  return Math.max(0, (f * index.samplesPerFrame - leadingTrimSamples(index)) / index.sampleRate);
}
