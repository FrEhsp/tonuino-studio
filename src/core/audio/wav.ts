/**
 * Uncompressed PCM files: WAV (RIFF/RF64/BW64) and AIFF/AIFF-C. Parsing and
 * streaming PCM reading for 8/16/24/32-bit integer and 32/64-bit float data.
 */
import type { ByteSource, PcmChunk, PcmReader } from '../../platform/types';
import { AudioError, checkAborted } from './errors';
import { readRange } from './source';

export interface WavInfo {
  /** 1 = integer PCM, 3 = IEEE float. */
  formatTag: 1 | 3;
  /** Byte order of the samples (AIFF is big endian, WAV little endian). */
  bigEndian?: boolean;
  /** 8-bit samples are signed (AIFF) instead of unsigned (WAV). */
  signed8?: boolean;
  bitsPerSample: number;
  channels: number;
  sampleRate: number;
  /** Bytes per frame (all channels). */
  blockAlign: number;
  dataOffset: number;
  dataSize: number;
  durationSec: number;
}

function ascii(b: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function u64(b: Uint8Array, o: number): number {
  return u32(b, o) + u32(b, o + 4) * 2 ** 32;
}

/** Reads the chunk list of a WAV file up to the data chunk. Throws 'unsupported-format'. */
export async function probeWav(source: ByteSource): Promise<WavInfo> {
  const head = await readRange(source, 0, 12);
  const riff = ascii(head, 0, 4);
  if (!['RIFF', 'RF64', 'BW64'].includes(riff) || ascii(head, 8, 4) !== 'WAVE') throw new AudioError('unsupported-format');
  let pos = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataSize' | 'durationSec'> | null = null;
  let ds64DataSize = -1;
  for (let guard = 0; guard < 1000 && pos + 8 <= source.size; guard++) {
    const ch = await readRange(source, pos, 8);
    const id = ascii(ch, 0, 4);
    const size = u32(ch, 4);
    const body = pos + 8;
    if (id === 'ds64') {
      const d = await readRange(source, body, Math.min(size, 28));
      if (d.length >= 16) ds64DataSize = u64(d, 8);
    } else if (id === 'fmt ') {
      const f = await readRange(source, body, Math.min(size, 40));
      if (f.length < 16) throw new AudioError('unsupported-format');
      let tag = u16(f, 0);
      if (tag === 0xfffe && f.length >= 26) tag = u16(f, 24); // WAVE_FORMAT_EXTENSIBLE sub-format
      const bits = u16(f, 14);
      const channels = u16(f, 2);
      const okInt = tag === 1 && [8, 16, 24, 32].includes(bits);
      const okFloat = tag === 3 && (bits === 32 || bits === 64);
      if (!(okInt || okFloat) || channels < 1) throw new AudioError('unsupported-format');
      fmt = { formatTag: tag as 1 | 3, bitsPerSample: bits, channels, sampleRate: u32(f, 4), blockAlign: u16(f, 12) || (channels * bits) / 8 };
    } else if (id === 'data') {
      if (!fmt) throw new AudioError('unsupported-format');
      let dataSize = size;
      if ((riff !== 'RIFF' && size === 0xffffffff && ds64DataSize >= 0) || size === 0) dataSize = ds64DataSize >= 0 ? ds64DataSize : source.size - body;
      dataSize = Math.min(dataSize, source.size - body);
      dataSize -= dataSize % fmt.blockAlign;
      return { ...fmt, dataOffset: body, dataSize, durationSec: dataSize / fmt.blockAlign / fmt.sampleRate };
    }
    pos = body + size + (size & 1);
  }
  throw new AudioError('unsupported-format');
}

/** Converts interleaved PCM bytes to one Float32Array per channel. */
export function wavToFloat(
  bytes: Uint8Array,
  info: Pick<WavInfo, 'formatTag' | 'bitsPerSample' | 'channels' | 'blockAlign' | 'bigEndian' | 'signed8'>,
): Float32Array[] {
  const { channels, blockAlign, bitsPerSample: bits } = info;
  const le = !info.bigEndian;
  const frames = Math.floor(bytes.length / blockAlign);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const step = bits / 8;
  for (let c = 0; c < channels; c++) {
    const ch = out[c];
    let o = c * step;
    if (info.formatTag === 3) {
      if (bits === 32) for (let i = 0; i < frames; i++, o += blockAlign) ch[i] = view.getFloat32(o, le);
      else for (let i = 0; i < frames; i++, o += blockAlign) ch[i] = view.getFloat64(o, le);
    } else if (bits === 16) {
      for (let i = 0; i < frames; i++, o += blockAlign) ch[i] = view.getInt16(o, le) / 32768;
    } else if (bits === 24) {
      if (le) for (let i = 0; i < frames; i++, o += blockAlign) ch[i] = (((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8) / 8388608;
      else for (let i = 0; i < frames; i++, o += blockAlign) ch[i] = (((bytes[o + 2] | (bytes[o + 1] << 8) | (bytes[o] << 16)) << 8) >> 8) / 8388608;
    } else if (bits === 32) {
      for (let i = 0; i < frames; i++, o += blockAlign) ch[i] = view.getInt32(o, le) / 2147483648;
    } else if (info.signed8) {
      for (let i = 0; i < frames; i++, o += blockAlign) ch[i] = view.getInt8(o) / 128;
    } else {
      for (let i = 0; i < frames; i++, o += blockAlign) ch[i] = (bytes[o] - 128) / 128;
    }
  }
  return out;
}

/** 80-bit IEEE 754 extended float (AIFF sample rate). */
function extended80(b: Uint8Array, o: number): number {
  const exponent = ((b[o] & 0x7f) << 8) | b[o + 1];
  const hi = ((b[o + 2] << 24) | (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5]) >>> 0;
  const lo = ((b[o + 6] << 24) | (b[o + 7] << 16) | (b[o + 8] << 8) | b[o + 9]) >>> 0;
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  const value = (hi * 2 ** 32 + lo) * 2 ** (exponent - 16383 - 63);
  return b[o] & 0x80 ? -value : value;
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** Reads the chunks of an AIFF or AIFF-C file up to the sound data. Throws 'unsupported-format'. */
export async function probeAiff(source: ByteSource): Promise<WavInfo> {
  const head = await readRange(source, 0, 12);
  const kind = ascii(head, 8, 4);
  if (ascii(head, 0, 4) !== 'FORM' || (kind !== 'AIFF' && kind !== 'AIFC')) throw new AudioError('unsupported-format');
  let pos = 12;
  let comm: Omit<WavInfo, 'dataOffset' | 'dataSize' | 'durationSec'> | null = null;
  let frames = 0;
  for (let guard = 0; guard < 1000 && pos + 8 <= source.size; guard++) {
    const ch = await readRange(source, pos, 8);
    const id = ascii(ch, 0, 4);
    const size = u32be(ch, 4);
    const body = pos + 8;
    if (id === 'COMM') {
      const c = await readRange(source, body, Math.min(size, 64));
      if (c.length < 18) throw new AudioError('unsupported-format');
      const channels = (c[0] << 8) | c[1];
      frames = u32be(c, 2);
      let bits = (c[6] << 8) | c[7];
      const sampleRate = Math.round(extended80(c, 8));
      const compression = kind === 'AIFC' && c.length >= 22 ? ascii(c, 18, 4) : 'NONE';
      let formatTag: 1 | 3 = 1;
      let bigEndian = true;
      if (compression === 'sowt') bigEndian = false;
      else if (compression === 'fl32' || compression === 'FL32') [formatTag, bits] = [3, 32];
      else if (compression === 'fl64' || compression === 'FL64') [formatTag, bits] = [3, 64];
      else if (compression === 'in24') bits = 24;
      else if (compression === 'in32') bits = 32;
      else if (compression !== 'NONE' && compression !== 'twos' && compression !== 'raw ') throw new AudioError('unsupported-format');
      const okInt = formatTag === 1 && [8, 16, 24, 32].includes(bits);
      if (!(okInt || formatTag === 3) || channels < 1 || !(sampleRate > 0)) throw new AudioError('unsupported-format');
      comm = { formatTag, bigEndian, signed8: compression !== 'raw ', bitsPerSample: bits, channels, sampleRate, blockAlign: (channels * bits) / 8 };
    } else if (id === 'SSND') {
      if (!comm) throw new AudioError('unsupported-format');
      const s = await readRange(source, body, 8);
      const dataOffset = body + 8 + u32be(s, 0);
      let dataSize = Math.min(size - 8 - u32be(s, 0), source.size - dataOffset, frames > 0 ? frames * comm.blockAlign : Infinity);
      dataSize -= dataSize % comm.blockAlign;
      return { ...comm, dataOffset, dataSize, durationSec: dataSize / comm.blockAlign / comm.sampleRate };
    }
    pos = body + size + (size & 1);
  }
  throw new AudioError('unsupported-format');
}

/** WAV or AIFF, decided by the file's first bytes. */
export async function probePcmFile(source: ByteSource): Promise<WavInfo> {
  const head = await readRange(source, 0, 4);
  return ascii(head, 0, 4) === 'FORM' ? probeAiff(source) : probeWav(source);
}

export class WavPcmReader implements PcmReader {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSec: number;
  private pos: number;
  private readonly end: number;

  private constructor(
    private readonly source: ByteSource,
    readonly info: WavInfo,
    private readonly signal?: AbortSignal,
  ) {
    this.sampleRate = info.sampleRate;
    this.channels = info.channels;
    this.durationSec = info.durationSec;
    this.pos = info.dataOffset;
    this.end = info.dataOffset + info.dataSize;
  }

  /** Opens a WAV or AIFF file. */
  static async open(source: ByteSource, opts: { signal?: AbortSignal } = {}): Promise<WavPcmReader> {
    return new WavPcmReader(source, await probePcmFile(source), opts.signal);
  }

  async next(maxFrames: number): Promise<PcmChunk | null> {
    checkAborted(this.signal);
    if (this.pos >= this.end) return null;
    const want = Math.min(this.end - this.pos, Math.max(1, Math.floor(maxFrames)) * this.info.blockAlign);
    const bytes = await readRange(this.source, this.pos, want);
    const usable = bytes.length - (bytes.length % this.info.blockAlign);
    if (usable <= 0) {
      this.pos = this.end;
      return null;
    }
    this.pos += usable;
    return { channels: wavToFloat(bytes.subarray(0, usable), this.info), sampleRate: this.sampleRate };
  }

  /** Fraction of the data chunk read so far. */
  progress(): number {
    return this.info.dataSize > 0 ? (this.pos - this.info.dataOffset) / this.info.dataSize : 1;
  }

  async close(): Promise<void> {
    this.pos = this.end;
  }
}

/** Builds a 16-bit PCM WAV file (for tests and exports). */
export function encodeWav16(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const n = channels[0]?.length ?? 0;
  const ch = channels.length;
  const dataSize = n * ch * 2;
  const out = new Uint8Array(44 + dataSize);
  const v = new DataView(out.buffer);
  const put = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  put(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  put(36, 'data');
  v.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767))), true);
      o += 2;
    }
  }
  return out;
}
