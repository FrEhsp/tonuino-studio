/**
 * Lossless loudness change like MP3Gain: every Layer III granule stores an
 * 8-bit global_gain; one step scales the decoded signal by 2^(1/4), i.e.
 * 1.505 dB. Changing the field changes the volume without re-encoding and can
 * be undone by applying the opposite number of steps (unless a value hit the
 * 0 or 255 limit).
 *
 * Frames with CRC protection get a recomputed CRC when their old CRC was
 * valid; frames whose CRC was already wrong keep it wrong.
 */
import type { ByteSource } from '../../platform/types';
import { crc16, readBits, writeBits } from './bits';
import { AudioError, checkAborted } from './errors';
import { decodeHeader, readU32, type FrameHeader, type Mp3Index, type MpegVersion } from './mp3frames';
import { BlobCollector, blobOfRange, CHUNK_SIZE, readRange } from './source';

/** One global_gain step in dB (20·log10(2^¼)). */
export const GAIN_STEP_DB = 5 * Math.log10(2);

/** Whole global_gain steps that move `currentLufs` closest to `targetLufs`. */
export function stepsForTarget(currentLufs: number, targetLufs: number): number {
  if (!Number.isFinite(currentLufs) || !Number.isFinite(targetLufs)) return 0;
  const steps = Math.round((targetLufs - currentLufs) / GAIN_STEP_DB);
  return steps === 0 ? 0 : steps; // avoid -0
}

/** Bit offsets of the global_gain fields, counted from the start of the side information. */
export function globalGainBitOffsets(version: MpegVersion, channels: 1 | 2): number[] {
  const out: number[] = [];
  if (version === 1) {
    // main_data_begin 9, private 5 (mono) / 3 (stereo), scfsi 4 per channel; 59 bits per granule/channel
    const base = channels === 1 ? 18 : 20;
    for (let gr = 0; gr < 2; gr++) for (let ch = 0; ch < channels; ch++) out.push(base + (gr * channels + ch) * 59 + 21);
  } else {
    // main_data_begin 8, private 1 (mono) / 2 (stereo); one granule, 63 bits per channel
    const base = channels === 1 ? 9 : 10;
    for (let ch = 0; ch < channels; ch++) out.push(base + ch * 63 + 21);
  }
  return out;
}

const OFFSETS = {
  v1mono: globalGainBitOffsets(1, 1),
  v1stereo: globalGainBitOffsets(1, 2),
  lsfMono: globalGainBitOffsets(2, 1),
  lsfStereo: globalGainBitOffsets(2, 2),
};

function gainOffsets(h: FrameHeader): number[] {
  if (h.version === 1) return h.channels === 1 ? OFFSETS.v1mono : OFFSETS.v1stereo;
  return h.channels === 1 ? OFFSETS.lsfMono : OFFSETS.lsfStereo;
}

function frameCrc(frame: Uint8Array, offset: number, h: FrameHeader): number {
  const side = offset + 6;
  return crc16(frame, side, side + h.sideInfoSize, crc16(frame, offset + 2, offset + 4));
}

/** The global_gain values of the Layer III frame at `offset` (granule-major order). */
export function readGlobalGains(buf: Uint8Array, offset: number): number[] {
  const h = decodeHeader(readU32(buf, offset));
  if (!h || h.layer !== 3) return [];
  const side = (offset + 4 + (h.crc ? 2 : 0)) * 8;
  return gainOffsets(h).map((bit) => readBits(buf, side + bit, 8));
}

/**
 * Adds `steps` to every global_gain of the Layer III frame at `offset`
 * (in place). Returns how many fields were clamped at 0 or 255.
 */
export function adjustFrameGain(buf: Uint8Array, offset: number, steps: number): number {
  const h = decodeHeader(readU32(buf, offset));
  if (!h || h.layer !== 3 || offset + 4 + (h.crc ? 2 : 0) + h.sideInfoSize > buf.length) return 0;
  const crcWasValid = h.crc && frameCrc(buf, offset, h) === ((buf[offset + 4] << 8) | buf[offset + 5]);
  const side = (offset + 4 + (h.crc ? 2 : 0)) * 8;
  let clamped = 0;
  for (const bit of gainOffsets(h)) {
    const g = readBits(buf, side + bit, 8) + steps;
    const v = g < 0 ? 0 : g > 255 ? 255 : g;
    if (v !== g) clamped++;
    writeBits(buf, side + bit, 8, v);
  }
  if (crcWasValid) {
    const crc = frameCrc(buf, offset, h);
    buf[offset + 4] = crc >> 8;
    buf[offset + 5] = crc & 0xff;
  }
  return clamped;
}

export interface GainOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Receives the number of global_gain fields that hit 0 or 255. */
  onClamped?: (count: number) => void;
  /**
   * Replaces all tags in the same pass: this ID3 tag (e.g. from
   * buildSmallId3) goes in front, ID3v1/APE/Lyrics3 at the end and junk
   * before the first frame are dropped; null writes no tag at all. When
   * omitted, the original tags are kept.
   */
  tag?: Uint8Array | null;
}

/**
 * Returns a copy of the file with every audio frame's global_gain changed by
 * `steps` (1.505 dB each). The Xing/Info frame is copied unchanged; tags too,
 * unless `opts.tag` replaces them. Use the same steps for every file of an
 * album (see albumLoudness) so the levels between tracks stay as they were.
 */
export async function applyGain(source: ByteSource, index: Mp3Index, steps: number, opts: GainOptions = {}): Promise<Blob> {
  const { onProgress, signal } = opts;
  if (index.layer !== 3) throw new AudioError('unsupported-layer');
  const s = Math.round(steps);
  const offsets = index.frameOffsets;
  // The output goes into Blobs every few MB: a long book never sits in the JS heap as a whole.
  const out = new BlobCollector();
  const replaceTags = opts.tag !== undefined;
  out.pushBlob(await blobOfRange(source, replaceTags ? index.audioStart : 0, offsets[0], signal)); // keeps the Xing/Info frame
  const span = Math.max(1, index.audioEnd - offsets[0]);
  let clamped = 0;
  let k = 0;
  while (k < index.frameCount) {
    checkAborted(signal);
    const k0 = k;
    const chunkStart = offsets[k0];
    let k1 = k0 + 1;
    while (k1 < index.frameCount && offsets[k1] - chunkStart < CHUNK_SIZE) k1++;
    const chunkEnd = k1 < index.frameCount ? offsets[k1] : index.audioEnd;
    const buf = (await readRange(source, chunkStart, chunkEnd - chunkStart)).slice();
    if (s !== 0) {
      for (k = k0; k < k1; k++) {
        const i = offsets[k] - chunkStart;
        if (i + 4 > buf.length || !decodeHeader(readU32(buf, i))) throw new AudioError('read-failed');
        clamped += adjustFrameGain(buf, i, s);
      }
    }
    k = k1;
    out.push([buf]);
    onProgress?.(Math.min(1, (chunkEnd - offsets[0]) / span));
  }
  if (!replaceTags) out.pushBlob(await blobOfRange(source, index.audioEnd, source.size, signal));
  opts.onClamped?.(clamped);
  onProgress?.(1);
  return out.toBlob(replaceTags && opts.tag ? [opts.tag] : []);
}
