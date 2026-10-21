/**
 * Lossless MP3 splitting at frame boundaries.
 *
 * Every part gets: [optional small ID3 tag] [fresh Xing/Info frame] [frames].
 * The Xing/Info frame is a valid silent Layer III frame (side info zeroed)
 * carrying frame count, byte count and a seek table for the part.
 *
 * Bit reservoir: a Layer III frame may keep part of its data in the frames
 * before it (main_data_begin). After a cut, those bytes would be missing at
 * the start of a part. We copy them to the end of the new Xing/Info frame,
 * where a decoder that plays the tag frame as audio (like the DFPlayer) finds
 * them in its reservoir, so the first frames decode exactly as in the
 * original. Decoders that skip the tag frame mute the first frame instead,
 * which is inaudible because we cut inside pauses.
 */
import type { ByteSource } from '../../platform/types';
import { crc16Arc } from './bits';
import { AudioError, checkAborted } from './errors';
import {
  bitrateTable,
  decodeHeader,
  frameAtTime,
  frameLengthFor,
  readU32,
  sideInfoSizeFor,
  timeOfFrame,
  versionBitsOf,
  type FrameHeader,
  type Mp3Index,
  type MpegVersion,
} from './mp3frames';
import { adjustFrameGain } from './mp3gain';
import { blobPart, CHUNK_SIZE, readRange } from './source';

/* ------------------------------------------------------------ Xing/Info frame */

export interface XingFrameParams {
  version: MpegVersion;
  sampleRate: number;
  /** 0 stereo, 1 joint stereo, 2 dual channel, 3 mono. */
  channelMode: number;
  /** Preferred bitrate; the next larger one is used when the data does not fit. */
  bitrateKbps?: number;
  copyright?: boolean;
  original?: boolean;
  emphasis?: number;
}

export interface XingFrameInfo {
  /** 'Info' for constant bitrate streams, 'Xing' for variable bitrate. */
  kind: 'Xing' | 'Info';
  /** Number of audio frames after the tag frame. */
  frames: number;
  /** Bytes of the audio frames after the tag frame (the tag frame adds its own length). */
  audioBytes: number;
  /**
   * 100 byte offsets, relative to the first audio frame, of the frame at
   * 0 %, 1 %, … 99 % of the playing time. Linear when omitted.
   */
  tocOffsets?: ArrayLike<number>;
  /** Bit reservoir bytes for the first audio frames; stored at the end of the frame. */
  reservoir?: Uint8Array;
  /**
   * LAME extension with encoder delay and padding, so gapless decoders
   * (mpg123, foobar2000, iTunes) play exactly the encoded samples.
   */
  lame?: LameTagInfo;
}

export interface LameTagInfo {
  /** Samples of delay the encoder added at the start (LAME: 576). */
  encoderDelay: number;
  /** Samples of padding at the end. */
  padding: number;
  /** Nine characters, e.g. "LAME3.98r". */
  encoder?: string;
  /** Lowpass frequency in Hz, when known. */
  lowpassHz?: number;
  /** CRC-16/ARC of the audio frames after the tag frame. */
  musicCrc?: number;
}

/** Bytes of the LAME extension after the Xing payload. */
const LAME_TAG_BYTES = 36;

const SAMPLE_RATE_INDEX: Record<number, number> = {
  44100: 0, 48000: 1, 32000: 2, 22050: 0, 24000: 1, 16000: 2, 11025: 0, 12000: 1, 8000: 2,
};

/** Bytes of the Xing payload we write: magic, flags, frames, bytes, TOC, quality. */
const XING_PAYLOAD = 4 + 4 + 4 + 4 + 100 + 4;

/** Builds a silent Layer III frame carrying a Xing (VBR) or Info (CBR) header. */
export function buildXingFrame(params: XingFrameParams, info: XingFrameInfo): Uint8Array {
  const { version, sampleRate } = params;
  const channels: 1 | 2 = params.channelMode === 3 ? 1 : 2;
  const sideInfo = sideInfoSizeFor(version, channels);
  const reservoir = info.reservoir ?? new Uint8Array(0);
  const lame = info.lame && info.lame.encoderDelay >= 0 && info.lame.encoderDelay < 4096 && info.lame.padding >= 0 && info.lame.padding < 4096 ? info.lame : undefined;
  const needed = 4 + sideInfo + XING_PAYLOAD + (lame ? LAME_TAG_BYTES : 0) + reservoir.length;
  const srIndex = SAMPLE_RATE_INDEX[sampleRate];
  if (srIndex === undefined) throw new RangeError(`Unsupported sample rate ${sampleRate}`);
  const table = bitrateTable(version, 3);
  const preferred = params.bitrateKbps ?? 0;
  const pick =
    table.find((b) => b.kbps >= preferred && frameLengthFor(version, 3, b.kbps, sampleRate, 0) >= needed) ??
    table.find((b) => frameLengthFor(version, 3, b.kbps, sampleRate, 0) >= needed);
  if (!pick) throw new RangeError('Xing frame data does not fit into any bitrate');
  const len = frameLengthFor(version, 3, pick.kbps, sampleRate, 0);

  const f = new Uint8Array(len);
  f[0] = 0xff;
  f[1] = 0xe0 | (versionBitsOf(version) << 3) | (1 << 1) | 1; // Layer III, no CRC
  f[2] = (pick.index << 4) | (srIndex << 2);
  f[3] = ((params.channelMode & 3) << 6) | (params.copyright ? 8 : 0) | (params.original ? 4 : 0) | ((params.emphasis ?? 0) & 3);
  // Side information stays zero: main_data_begin 0, part2_3_length 0, i.e. silence.
  let p = 4 + sideInfo;
  const magic = info.kind;
  for (let i = 0; i < 4; i++) f[p + i] = magic.charCodeAt(i);
  p += 4;
  const put32 = (v: number) => {
    f[p] = (v >>> 24) & 0xff;
    f[p + 1] = (v >>> 16) & 0xff;
    f[p + 2] = (v >>> 8) & 0xff;
    f[p + 3] = v & 0xff;
    p += 4;
  };
  const totalBytes = len + info.audioBytes;
  put32(0x0f); // frames, bytes, TOC, quality
  put32(info.frames);
  put32(totalBytes);
  for (let i = 0; i < 100; i++) {
    const rel = info.tocOffsets ? info.tocOffsets[i] : (info.audioBytes * i) / 100;
    f[p + i] = Math.min(255, Math.floor(((len + rel) * 256) / totalBytes));
  }
  p += 100;
  put32(0); // quality
  if (lame) {
    const t = p;
    const name = (lame.encoder ?? 'LAME3.98r').padEnd(9, ' ').slice(0, 9);
    for (let i = 0; i < 9; i++) f[t + i] = name.charCodeAt(i) & 0x7f;
    f[t + 9] = info.kind === 'Info' ? 0x01 : 0x04; // tag revision 0; VBR method: CBR or VBR
    f[t + 10] = Math.min(255, Math.round((lame.lowpassHz ?? 0) / 100));
    f[t + 20] = Math.min(255, pick.kbps);
    f[t + 21] = lame.encoderDelay >> 4;
    f[t + 22] = ((lame.encoderDelay & 0x0f) << 4) | (lame.padding >> 8);
    f[t + 23] = lame.padding & 0xff;
    f[t + 24] = (sampleRate === 44100 ? 1 : sampleRate === 48000 ? 2 : sampleRate > 48000 ? 3 : 0) << 6;
    p = t + 28;
    put32(totalBytes); // music length: tag frame and audio
    f[t + 32] = ((lame.musicCrc ?? 0) >> 8) & 0xff;
    f[t + 33] = (lame.musicCrc ?? 0) & 0xff;
    const crc = crc16Arc(f, 0, t + 34);
    f[t + 34] = crc >> 8;
    f[t + 35] = crc & 0xff;
  }
  f.set(reservoir, len - reservoir.length);
  return f;
}

/* ------------------------------------------------------------ helpers */

/** Bytes of main data a Layer III frame carries itself. */
export function mainDataSize(h: FrameHeader): number {
  return h.frameLength - 4 - (h.crc ? 2 : 0) - h.sideInfoSize;
}

/** main_data_begin of the Layer III frame at `i`. */
export function mainDataBegin(buf: Uint8Array, i: number, h: FrameHeader): number {
  const s = i + 4 + (h.crc ? 2 : 0);
  return h.version === 1 ? (buf[s] << 1) | (buf[s + 1] >> 7) : buf[s];
}

export function maxReservoir(version: MpegVersion): number {
  return version === 1 ? 511 : 255;
}

/** Snaps cut times (seconds of decoded audio) to frame boundaries; drops duplicates and cuts at the ends. */
export function snapCuts(index: Mp3Index, cutTimesSec: readonly number[]): { frames: number[]; timesSec: number[] } {
  const set = new Set<number>();
  for (const t of cutTimesSec) {
    if (!Number.isFinite(t)) continue;
    const f = frameAtTime(index, t);
    if (f > 0 && f < index.frameCount) set.add(f);
  }
  const frames = [...set].sort((a, b) => a - b);
  return { frames, timesSec: frames.map((f) => timeOfFrame(index, f)) };
}

interface PartData {
  pieces: Uint8Array[];
  audioBytes: number;
  /** CRC-16/ARC of the frames (the LAME tag's "music CRC"). */
  musicCrc: number;
  tocOffsets: Float64Array;
  first: FrameHeader;
  cbr: boolean;
  /** Reservoir bytes the first frames reach back for. */
  reservoirNeed: number;
}

function endOfFrameRange(index: Mp3Index, k: number): number {
  return k < index.frameCount ? index.frameOffsets[k] : index.audioEnd;
}

/** Reads frames [f0, f1) and collects their bytes, seek table and reservoir needs. */
async function collectPart(
  source: ByteSource,
  index: Mp3Index,
  f0: number,
  f1: number,
  onBytes: (n: number) => void,
  signal?: AbortSignal,
  gainSteps = 0,
): Promise<PartData> {
  const n = f1 - f0;
  const offsets = index.frameOffsets;
  const tocFrames = new Int32Array(100);
  for (let i = 0; i < 100; i++) tocFrames[i] = Math.floor((i * n) / 100);
  const tocOffsets = new Float64Array(100);
  let tocNext = 0;

  const pieces: Uint8Array[] = [];
  let audioBytes = 0;
  let first: FrameHeader | null = null;
  let minBr = 15;
  let maxBr = 0;
  let need = 0;
  let cumMain = 0;
  let reservoirDone = false;
  let maxRes = 511;

  let k = f0;
  while (k < f1) {
    checkAborted(signal);
    const k0 = k;
    const chunkStart = offsets[k0];
    let k1 = k0 + 1;
    while (k1 < f1 && offsets[k1] - chunkStart < CHUNK_SIZE) k1++;
    const chunkEnd = endOfFrameRange(index, k1);
    const read = await readRange(source, chunkStart, chunkEnd - chunkStart);
    // Gain changes the frames in place: never in the caller's own buffer.
    const buf = gainSteps ? read.slice() : read;
    let runStart = -1;
    let runEnd = -1;
    for (k = k0; k < k1; k++) {
      const i = offsets[k] - chunkStart;
      const h = i + 4 <= buf.length ? decodeHeader(readU32(buf, i)) : null;
      if (!h || i + h.frameLength > buf.length) throw new AudioError('read-failed');
      if (gainSteps) adjustFrameGain(buf, i, gainSteps);
      if (!first) {
        first = h;
        maxRes = maxReservoir(h.version);
      }
      while (tocNext < 100 && tocFrames[tocNext] === k - f0) tocOffsets[tocNext++] = audioBytes;
      if (!reservoirDone) {
        need = Math.max(need, mainDataBegin(buf, i, h) - cumMain);
        cumMain += mainDataSize(h);
        if (cumMain >= maxRes) reservoirDone = true;
      }
      if (h.bitrateIndex < minBr) minBr = h.bitrateIndex;
      if (h.bitrateIndex > maxBr) maxBr = h.bitrateIndex;
      audioBytes += h.frameLength;
      if (i === runEnd) {
        runEnd += h.frameLength;
      } else {
        if (runStart >= 0) pieces.push(buf.subarray(runStart, runEnd));
        runStart = i;
        runEnd = i + h.frameLength;
      }
    }
    if (runStart >= 0) pieces.push(buf.subarray(runStart, runEnd));
    onBytes(chunkEnd - chunkStart);
  }
  let musicCrc = 0;
  for (const piece of pieces) musicCrc = crc16Arc(piece, 0, piece.length, musicCrc);
  return { pieces, audioBytes, musicCrc, tocOffsets, first: first as FrameHeader, cbr: minBr === maxBr, reservoirNeed: Math.max(0, need) };
}

/**
 * The last `need` bytes of main data before frame `f0`, gathered backwards
 * over the preceding frames (and the original Xing/Info frame).
 */
export async function gatherReservoir(source: ByteSource, index: Mp3Index, f0: number, need: number): Promise<Uint8Array> {
  const out = new Uint8Array(need);
  let fill = need;
  const takeFrom = (frame: Uint8Array, h: FrameHeader) => {
    const md = frame.subarray(4 + (h.crc ? 2 : 0) + h.sideInfoSize, h.frameLength);
    const take = Math.min(fill, md.length);
    out.set(md.subarray(md.length - take), fill - take);
    fill -= take;
  };
  let k = f0 - 1;
  while (fill > 0 && k >= 0) {
    const kStart = Math.max(0, k - 31);
    const blockStart = index.frameOffsets[kStart];
    const block = await readRange(source, blockStart, endOfFrameRange(index, k + 1) - blockStart);
    for (; k >= kStart && fill > 0; k--) {
      const i = index.frameOffsets[k] - blockStart;
      const h = decodeHeader(readU32(block, i));
      if (!h || i + h.frameLength > block.length) return out; // damaged: leave zeros
      takeFrom(block.subarray(i, i + h.frameLength), h);
    }
  }
  if (fill > 0 && index.xing && index.xing.kind !== 'VBRI') {
    const frame = await readRange(source, index.xing.offset, index.xing.frameLength);
    const h = decodeHeader(readU32(frame, 0));
    if (h && frame.length >= h.frameLength) takeFrom(frame, h);
  }
  return out;
}

/* ------------------------------------------------------------ cutting */

export const LAME_ENCODER = /^(LAME|Lavf|Lavc|L3\.9|GOGO)/;

/**
 * LAME tag for a part when the source has one: the encoder delay stays with
 * the first part and the padding with the last, so gapless players trim
 * them exactly as in the original file.
 */
function partLame(index: Mp3Index, part: number, partCount: number, musicCrc: number): LameTagInfo | undefined {
  if (!index.lame) return undefined;
  return {
    encoderDelay: part === 0 ? index.lame.encoderDelay : 0,
    padding: part === partCount - 1 ? index.lame.padding : 0,
    encoder: LAME_ENCODER.test(index.lame.encoder) ? index.lame.encoder : undefined,
    musicCrc,
  };
}

export interface CutOptions {
  /** Small ID3 tag for each part (e.g. from buildSmallId3), or null for none. */
  tagFor?: (partIndex: number, partCount: number) => Uint8Array | null;
  /** Changes the volume of every frame by this many global_gain steps on the way (see applyGain). */
  gainSteps?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Splits an MP3 losslessly. `cutTimesSec` are positions in decoded audio
 * (as in AudioAnalysis); each is moved to the nearest frame boundary
 * (±13 ms at 44.1 kHz). Returns one Blob per part, in order. When the source
 * has a LAME tag, the first part keeps its encoder delay and the last part
 * its padding.
 */
export async function cutMp3(source: ByteSource, index: Mp3Index, cutTimesSec: readonly number[], opts: CutOptions = {}): Promise<Blob[]> {
  const blobs: Blob[] = [];
  for await (const part of cutMp3Parts(source, index, cutTimesSec, opts)) blobs.push(part);
  return blobs;
}

/**
 * Like cutMp3, but hands out one part at a time, so a long book never has
 * to be held in memory as a whole: each part is read when it is asked for.
 * The number of parts is snapCuts(index, cutTimesSec).frames.length + 1.
 */
export async function* cutMp3Parts(source: ByteSource, index: Mp3Index, cutTimesSec: readonly number[], opts: CutOptions = {}): AsyncGenerator<Blob, void, undefined> {
  const { signal, onProgress } = opts;
  if (index.layer !== 3) throw new AudioError('unsupported-layer');
  const steps = Math.round(opts.gainSteps ?? 0);
  const { frames } = snapCuts(index, cutTimesSec);
  const bounds = [0, ...frames, index.frameCount];
  const partCount = bounds.length - 1;
  const totalBytes = Math.max(1, index.audioEnd - index.frameOffsets[0]);
  let done = 0;
  for (let part = 0; part < partCount; part++) {
    checkAborted(signal);
    const f0 = bounds[part];
    const f1 = bounds[part + 1];
    const data = await collectPart(
      source,
      index,
      f0,
      f1,
      (bytes) => {
        done += bytes;
        onProgress?.(Math.min(1, done / totalBytes));
      },
      signal,
      steps,
    );
    const reservoir = data.reservoirNeed > 0 ? await gatherReservoir(source, index, f0, data.reservoirNeed) : undefined;
    const h = data.first;
    const xing = buildXingFrame(
      {
        version: h.version,
        sampleRate: h.sampleRate,
        channelMode: h.channelMode,
        bitrateKbps: h.bitrateKbps,
        copyright: ((h.raw >>> 3) & 1) === 1,
        original: ((h.raw >>> 2) & 1) === 1,
        emphasis: h.raw & 3,
      },
      { kind: data.cbr ? 'Info' : 'Xing', frames: f1 - f0, audioBytes: data.audioBytes, tocOffsets: data.tocOffsets, reservoir, lame: partLame(index, part, partCount, data.musicCrc) },
    );
    const tag = opts.tagFor?.(part, partCount);
    const parts: BlobPart[] = [];
    if (tag && tag.length > 0) parts.push(blobPart(tag));
    parts.push(blobPart(xing));
    for (const piece of data.pieces) parts.push(blobPart(piece));
    if (part === partCount - 1) onProgress?.(1);
    yield new Blob(parts, { type: 'audio/mpeg' });
  }
}
