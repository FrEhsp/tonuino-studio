/** Test helpers: synthetic PCM, MP3 encoding with lamejs, decoding with mpg123. */
import { Mp3Encoder } from '@breezystack/lamejs';
import { MPEGDecoder } from 'mpg123-decoder';
import { vi } from 'vitest';
import { readBits, writeBits } from '../../src/core/audio/bits';
import { decodeHeader, readU32, type MpegVersion } from '../../src/core/audio/mp3frames';

export interface Segment {
  /** Seconds. */
  sec: number;
  /** Tone frequency in Hz; omit for silence. */
  freq?: number;
  /** Peak amplitude (default 0.3). */
  amp?: number;
}

/** Tone bursts and silences, back to back. Bursts get 5 ms fades to avoid clicks. */
export function synth(sampleRate: number, segments: Segment[]): Float32Array {
  const total = segments.reduce((n, s) => n + Math.round(s.sec * sampleRate), 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const s of segments) {
    const n = Math.round(s.sec * sampleRate);
    if (s.freq) {
      const amp = s.amp ?? 0.3;
      const fade = Math.min(Math.round(0.005 * sampleRate), n >> 1);
      for (let i = 0; i < n; i++) {
        let g = 1;
        if (i < fade) g = i / fade;
        else if (i >= n - fade) g = (n - 1 - i) / fade;
        out[o + i] = amp * g * Math.sin((2 * Math.PI * s.freq * i) / sampleRate);
      }
    }
    o += n;
  }
  return out;
}

export function sine(sampleRate: number, freq: number, sec: number, amp: number, phase = 0): Float32Array {
  const n = Math.round(sec * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase);
  return out;
}

function toInt16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
  return out;
}

/** Encodes PCM to MP3 with lamejs (CBR, no Xing frame, no bit reservoir). */
export function encodeMp3(channels: Float32Array[], sampleRate: number, kbps: number): Uint8Array {
  const enc = new Mp3Encoder(channels.length, sampleRate, kbps);
  const l = toInt16(channels[0]);
  const r = channels.length > 1 ? toInt16(channels[1]) : undefined;
  const parts: Uint8Array[] = [];
  const block = 1152 * 32;
  for (let i = 0; i < l.length; i += block) {
    const out = enc.encodeBuffer(l.subarray(i, i + block), r?.subarray(i, i + block));
    parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length));
  }
  const tail = enc.flush();
  parts.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length));
  return concat(parts);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function decodeMp3(bytes: Uint8Array, gapless = true): Promise<{ channelData: Float32Array[]; samplesDecoded: number; sampleRate: number }> {
  const dec = new MPEGDecoder({ enableGapless: gapless });
  await dec.ready;
  try {
    const r = dec.decode(bytes);
    return { channelData: r.channelData, samplesDecoded: r.samplesDecoded, sampleRate: r.sampleRate };
  } finally {
    dec.free();
  }
}

export async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

/**
 * Runs `fn` and returns the most bytes that went into one Blob as arrays
 * (not as Blobs): what had to sit in the JS heap at the same time.
 */
export async function rawBytesPerBlob(fn: () => Promise<unknown>): Promise<number> {
  let most = 0;
  class CountingBlob extends Blob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      let raw = 0;
      for (const p of parts ?? []) if (ArrayBuffer.isView(p) || p instanceof ArrayBuffer) raw += p.byteLength;
      most = Math.max(most, raw);
      super(parts, options);
    }
  }
  vi.stubGlobal('Blob', CountingBlob);
  try {
    await fn();
  } finally {
    vi.unstubAllGlobals();
  }
  return most;
}

/** RMS level in dBFS of a range. */
export function rmsDb(x: Float32Array, start = 0, end = x.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, end - start) + 1e-30);
}

/** Amplitude of a frequency component (Goertzel), relative to a full-scale sine = 1. */
export function toneAmplitude(x: Float32Array, sampleRate: number, freq: number, start = 0, end = x.length): number {
  const n = end - start;
  const w = (2 * Math.PI * freq) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    // Hann window to limit leakage
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re += x[start + i] * win * Math.cos(w * i);
    im -= x[start + i] * win * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / (n * 0.5);
}

/**
 * Repacks a stream so that every frame starts its main data as early as the
 * bit reservoir allows (main_data_begin > 0), like LAME does by default.
 */
export function makeReservoirStream(mp3: Uint8Array): Uint8Array {
  const frames: { p: number; region: number; md: number; used: number }[] = [];
  for (let p = 0; p + 4 <= mp3.length; ) {
    const h = decodeHeader(readU32(mp3, p));
    if (!h) break;
    const region = 4 + (h.crc ? 2 : 0) + h.sideInfoSize;
    const side = (p + 4 + (h.crc ? 2 : 0)) * 8;
    const base = h.version === 1 ? (h.channels === 1 ? 18 : 20) : h.channels === 1 ? 9 : 10;
    const step = h.version === 1 ? 59 : 63;
    const fields = (h.version === 1 ? 2 : 1) * h.channels;
    let bits = 0;
    for (let i = 0; i < fields; i++) bits += readBits(mp3, side + base + i * step, 12);
    frames.push({ p, region, md: h.frameLength - region, used: Math.ceil(bits / 8) });
    p += h.frameLength;
  }
  const out = mp3.slice();
  const total = frames.reduce((n, f) => n + f.md, 0);
  const stream = new Uint8Array(total);
  let prevEnd = 0;
  let streamBase = 0;
  const version = decodeHeader(readU32(mp3, 0))?.version as MpegVersion;
  const maxRes = version === 1 ? 511 : 255;
  for (const f of frames) {
    const start = Math.max(prevEnd, streamBase - maxRes);
    stream.set(mp3.subarray(f.p + f.region, f.p + f.region + f.used), start);
    const side = (f.p + 4) * 8;
    writeBits(out, side, version === 1 ? 9 : 8, streamBase - start);
    prevEnd = start + f.used;
    streamBase += f.md;
  }
  streamBase = 0;
  for (const f of frames) {
    out.set(stream.subarray(streamBase, streamBase + f.md), f.p + f.region);
    streamBase += f.md;
  }
  return out;
}
