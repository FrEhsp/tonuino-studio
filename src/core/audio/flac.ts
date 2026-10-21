/**
 * Native FLAC demuxer for the WebCodecs path. FLAC frames carry no length:
 * a frame ends where the next valid frame header starts. A header counts as
 * valid when its sync code, reserved bits, CRC-8 and the expected frame or
 * sample number agree, which makes false matches inside audio data
 * practically impossible. When the next header is damaged, the frame ends
 * where its CRC-16 checks out; the damaged bytes are left out and reading
 * goes on at the next valid header. Chapter marks come from CHAPTERxxx
 * comments or from an embedded CD cue sheet (one chapter per CD track).
 */
import type { ByteSource } from '../../platform/types';
import { crc16 } from './bits';
import { chaptersFromVorbisComments, parseVorbisComments, type ChapterMark, type EncodedAudioInfo, type EncodedPacket, type PacketReader } from './demux';
import { AudioError, checkAborted } from './errors';
import { measureTags } from './id3';
import { readRange, WindowReader } from './source';

export interface FlacStreamInfo {
  minBlockSize: number;
  maxBlockSize: number;
  minFrameSize: number;
  maxFrameSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 0 when unknown. */
  totalSamples: number;
}

/** Parses the 34 bytes of a STREAMINFO block starting at `o`. */
export function parseStreamInfo(b: Uint8Array, o: number): FlacStreamInfo {
  return {
    minBlockSize: (b[o] << 8) | b[o + 1],
    maxBlockSize: (b[o + 2] << 8) | b[o + 3],
    minFrameSize: (b[o + 4] << 16) | (b[o + 5] << 8) | b[o + 6],
    maxFrameSize: (b[o + 7] << 16) | (b[o + 8] << 8) | b[o + 9],
    sampleRate: (b[o + 10] << 12) | (b[o + 11] << 4) | (b[o + 12] >> 4),
    channels: ((b[o + 12] >> 1) & 7) + 1,
    bitsPerSample: (((b[o + 12] & 1) << 4) | (b[o + 13] >> 4)) + 1,
    totalSamples: (b[o + 13] & 0x0f) * 2 ** 32 + (((b[o + 14] << 24) | (b[o + 15] << 16) | (b[o + 16] << 8) | b[o + 17]) >>> 0),
  };
}

const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

export function crc8(b: Uint8Array, start: number, end: number): number {
  let c = 0;
  for (let i = start; i < end; i++) c = CRC8[c ^ b[i]];
  return c;
}

const RATE_CODES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];

export interface FlacFrameHeader {
  blockSize: number;
  /** Frame number (fixed block size) or number of the first sample (variable block size). */
  number: number;
  variable: boolean;
  headerLength: number;
}

/** Parses and checks a FLAC frame header at `i`; null when there is none. */
export function parseFlacFrameHeader(b: Uint8Array, i: number, info?: Pick<FlacStreamInfo, 'channels' | 'sampleRate' | 'maxBlockSize'>): FlacFrameHeader | null {
  if (i + 6 > b.length || b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8) return null;
  const variable = (b[i + 1] & 1) === 1;
  const bsCode = b[i + 2] >> 4;
  const srCode = b[i + 2] & 15;
  const chCode = b[i + 3] >> 4;
  const ssCode = (b[i + 3] >> 1) & 7;
  if (bsCode === 0 || srCode === 15 || chCode > 10 || ssCode === 3 || b[i + 3] & 1) return null;
  if (info) {
    if ((chCode < 8 ? chCode + 1 : 2) !== info.channels) return null;
    if (srCode > 0 && srCode < 12 && RATE_CODES[srCode] !== info.sampleRate) return null;
  }
  let p = i + 4;
  const c0 = b[p++];
  let n: number;
  let extra: number;
  if (c0 < 0x80) [n, extra] = [c0, 0];
  else if ((c0 & 0xe0) === 0xc0) [n, extra] = [c0 & 0x1f, 1];
  else if ((c0 & 0xf0) === 0xe0) [n, extra] = [c0 & 0x0f, 2];
  else if ((c0 & 0xf8) === 0xf0) [n, extra] = [c0 & 0x07, 3];
  else if ((c0 & 0xfc) === 0xf8) [n, extra] = [c0 & 0x03, 4];
  else if ((c0 & 0xfe) === 0xfc) [n, extra] = [c0 & 0x01, 5];
  else if (c0 === 0xfe) [n, extra] = [0, 6];
  else return null;
  if (p + extra + 3 > b.length) return null;
  for (let k = 0; k < extra; k++) {
    const c = b[p++];
    if ((c & 0xc0) !== 0x80) return null;
    n = n * 64 + (c & 0x3f);
  }
  let blockSize: number;
  if (bsCode === 1) blockSize = 192;
  else if (bsCode <= 5) blockSize = 576 << (bsCode - 2);
  else if (bsCode === 6) blockSize = b[p++] + 1;
  else if (bsCode === 7) {
    blockSize = ((b[p] << 8) | b[p + 1]) + 1;
    p += 2;
  } else blockSize = 256 << (bsCode - 8);
  if (srCode === 12) p += 1;
  else if (srCode === 13 || srCode === 14) p += 2;
  if (p >= b.length) return null;
  if (info?.maxBlockSize && blockSize > info.maxBlockSize) return null;
  if (crc8(b, i, p) !== b[p]) return null;
  return { blockSize, number: n, variable, headerLength: p + 1 - i };
}

function cueSheetChapters(b: Uint8Array, sampleRate: number): ChapterMark[] {
  // catalog 128, lead-in 8, flags + reserved 259, track count 1
  let p = 396;
  if (p > b.length) return [];
  const count = b[p - 1];
  const out: ChapterMark[] = [];
  for (let t = 0; t < count && p + 36 <= b.length; t++) {
    const offset = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) * 2 ** 32 + (((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0);
    const number = b[p + 8];
    const indices = b[p + 35];
    p += 36;
    let start = offset;
    for (let k = 0; k < indices && p + 12 <= b.length; k++, p += 12) {
      const io = ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
      if (b[p + 8] === 1) start = offset + io;
    }
    if (number !== 170 && number !== 255) out.push({ startSec: start / sampleRate, title: undefined });
  }
  return out;
}

export class FlacPacketReader implements PacketReader {
  private readonly reader: WindowReader;
  private pos: number;
  private expected = -1;
  private sampleTime = 0;
  private ended = false;

  private constructor(
    readonly info: EncodedAudioInfo,
    private readonly stream: FlacStreamInfo,
    source: ByteSource,
    audioStart: number,
    audioEnd: number,
    private readonly signal?: AbortSignal,
  ) {
    this.reader = new WindowReader(source, audioEnd);
    this.pos = audioStart;
  }

  static async open(source: ByteSource, signal?: AbortSignal): Promise<FlacPacketReader> {
    const layout = await measureTags(source);
    let p = layout.audioStart;
    const magic = await readRange(source, p, 4);
    if (String.fromCharCode(...magic) !== 'fLaC') throw new AudioError('unsupported-format');
    p += 4;
    let stream: FlacStreamInfo | null = null;
    let streamBlock: Uint8Array | null = null;
    let comments: string[] = [];
    let cue: Uint8Array | null = null;
    for (let guard = 0; guard < 1024; guard++) {
      const h = await readRange(source, p, 4);
      if (h.length < 4) throw new AudioError('decode-failed');
      const last = (h[0] & 0x80) !== 0;
      const type = h[0] & 0x7f;
      const len = (h[1] << 16) | (h[2] << 8) | h[3];
      if (type === 0 && len >= 34) {
        streamBlock = await readRange(source, p + 4, 34);
        stream = parseStreamInfo(streamBlock, 0);
      } else if (type === 4 && len < 4 << 20) {
        comments = parseVorbisComments(await readRange(source, p + 4, len));
      } else if (type === 5 && len < 1 << 20) {
        cue = await readRange(source, p + 4, len);
      }
      p += 4 + len;
      if (last) break;
    }
    checkAborted(signal);
    if (!stream || !streamBlock || !(stream.sampleRate > 0)) throw new AudioError('decode-failed');
    const desc = new Uint8Array(4 + 4 + 34);
    desc.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34], 0); // "fLaC", last block STREAMINFO, length 34
    desc.set(streamBlock, 8);
    let chapters = chaptersFromVorbisComments(comments);
    if (chapters.length === 0 && cue) chapters = cueSheetChapters(cue, stream.sampleRate);
    const total = stream.totalSamples;
    const durationSec = total > 0 ? total / stream.sampleRate : 0;
    const info: EncodedAudioInfo = {
      container: 'flac',
      codec: 'flac',
      webCodecs: 'flac',
      description: desc,
      sampleRate: stream.sampleRate,
      channels: stream.channels,
      skipSamples: 0,
      totalSamples: total > 0 ? total : undefined,
      durationSec,
      durationExact: total > 0,
      bitrateKbps: durationSec > 0 ? Math.round(((layout.audioEnd - p) * 8) / durationSec / 1000) : undefined,
      chapters: chapters.length > 0 ? chapters : undefined,
    };
    return new FlacPacketReader(info, stream, source, p, layout.audioEnd, signal);
  }

  /**
   * Finds the next acceptable header at or after `from`. Returns its
   * position, -1 at the end of the file, or -2 when `stopAt` was passed.
   */
  private async findHeader(from: number, expected: number, stopAt = Infinity): Promise<number> {
    const r = this.reader;
    let p = from;
    for (;;) {
      checkAborted(this.signal);
      if (p + 6 > r.end) return -1;
      if (p > stopAt) return -2;
      // Checking a header looks up to 32 bytes ahead: with fewer left in the window, load the next part first.
      if (p < r.base || (p + 32 >= r.limit && r.limit < r.end)) {
        const before = p < r.base ? -1 : r.limit;
        await r.ensure(p, Math.max(1 << 20, this.stream.maxFrameSize + 64));
        if (p < r.base || p + 6 > r.limit || r.limit <= before) return -1; // the source delivered less than announced
      }
      const buf = r.buf;
      const lim = (r.limit < r.end ? r.limit - 32 : r.limit - 6) - r.base;
      let i = p - r.base;
      for (; i < lim; i++) {
        if (buf[i] !== 0xff || (buf[i + 1] & 0xfe) !== 0xf8) continue;
        if (r.base + i > stopAt) return -2;
        const h = parseFlacFrameHeader(buf, i, this.stream);
        if (h && (expected < 0 || h.number === expected)) return r.base + i;
      }
      if (r.limit >= r.end) return -1;
      p = r.base + i;
    }
  }

  /**
   * Where a frame ends when no header of the next frame follows it: at the
   * first place where the CRC-16 over the frame checks out and a sync code or
   * the end of the audio comes next. -1 when there is none within `maxLen`.
   */
  private async crcEnd(start: number, minLen: number, maxLen: number): Promise<number> {
    const r = this.reader;
    await r.ensure(start, maxLen + 2);
    const b = r.buf;
    const from = start - r.base;
    const last = Math.min(b.length, from + maxLen);
    if (from + minLen > last) return -1;
    let crc = crc16(b, from, from + minLen, 0);
    for (let i = from + minLen; ; i++) {
      if (crc === 0 && (r.base + i === r.end || (b[i] === 0xff && (b[i + 1] & 0xfe) === 0xf8))) return r.base + i;
      if (i === last) return -1;
      crc = crc16(b, i, i + 1, crc);
    }
  }

  async next(): Promise<EncodedPacket | null> {
    const r = this.reader;
    while (!this.ended) {
      const start = await this.findHeader(this.pos, this.expected);
      if (start < 0) break;
      await r.ensure(start, 32);
      const h = parseFlacFrameHeader(r.buf, start - r.base, this.stream) as FlacFrameHeader;
      const nextExpected = h.variable ? h.number + h.blockSize : h.number + 1;
      const minLen = Math.max(h.headerLength + 2, this.stream.minFrameSize > 0 ? this.stream.minFrameSize : 0);
      // The longest the frame can be: its samples stored verbatim (a side channel one bit wider), or more if STREAMINFO says so.
      const maxLen = Math.max(this.stream.maxFrameSize + 16, Math.ceil((h.blockSize * this.stream.channels * (this.stream.bitsPerSample + 1)) / 8) + 64);
      let expected = nextExpected;
      let end = await this.findHeader(start + minLen, nextExpected, start + maxLen);
      if (end < 0) {
        // No next frame within reach: this is the last frame, or the next header is damaged. Keep the
        // damaged bytes out of the packet, and go on at the next valid header whatever its number.
        expected = -1;
        end = await this.crcEnd(start, minLen, maxLen);
        if (end < 0) {
          // Leave out a frame whose end is not sure rather than hand the decoder a frame cut short.
          this.expected = -1;
          this.pos = start + minLen;
          continue;
        }
      }
      await r.ensure(start, end - start);
      const i = start - r.base;
      const data = r.buf.subarray(i, Math.min(r.buf.length, i + end - start));
      const rate = this.stream.sampleRate;
      const packet: EncodedPacket = {
        data,
        timestampUs: Math.round((this.sampleTime * 1e6) / rate),
        durationUs: Math.round((h.blockSize * 1e6) / rate),
      };
      this.sampleTime += h.blockSize;
      this.expected = expected;
      this.pos = end;
      return packet;
    }
    this.ended = true;
    return null;
  }

  progress(): number {
    return Math.min(1, this.pos / Math.max(1, this.reader.end));
  }

  async close(): Promise<void> {
    this.ended = true;
  }
}
