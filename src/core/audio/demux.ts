/**
 * Demuxing for the WebCodecs path. Containers are split into encoded packets
 * here; the browser's AudioDecoder turns them into PCM (webcodecs.ts).
 *
 * This file holds the shared types, the ADTS reader for raw AAC files and
 * chapter marks from Vorbis comments (Ogg, FLAC). MP4, Ogg and FLAC have their
 * own files. Everything here is plain TypeScript and runs in Node.
 */
import type { ByteSource } from '../../platform/types';
import { AudioError, checkAborted } from './errors';
import { adtsFrameLength, type ContainerKind } from './formats';
import { measureTags } from './id3';
import { readRange, WindowReader } from './source';

export interface ChapterMark {
  startSec: number;
  title?: string;
}

/** What a demuxer knows about the audio track before decoding starts. */
export interface EncodedAudioInfo {
  container: ContainerKind;
  /** Short codec name: 'aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac', 'ac3', 'eac3', or a sample entry type. */
  codec: string;
  /** WebCodecs codec string ('mp4a.40.2', 'opus', 'flac', …); undefined when WebCodecs has no name for it. */
  webCodecs?: string;
  /** WebCodecs decoder description (AudioSpecificConfig, OpusHead, 'fLaC' + STREAMINFO, Xiph headers). */
  description?: Uint8Array;
  /** Sample rate the timing below refers to (the decoder may output another one, e.g. HE-AAC). */
  sampleRate: number;
  channels: number;
  /** Samples (at `sampleRate`) the decoder outputs before the first real sample: priming, pre-skip, edit list. */
  skipSamples: number;
  /** Real samples after the skip, when known; decoded audio is cut there (end padding). */
  totalSamples?: number;
  /** Playing time; an estimate when `durationExact` is false. */
  durationSec: number;
  durationExact: boolean;
  bitrateKbps?: number;
  chapters?: ChapterMark[];
  /** Set when the file is copy protected; it cannot be decoded. */
  drm?: string;
}

export interface EncodedPacket {
  data: Uint8Array;
  /** Presentation time in microseconds. */
  timestampUs: number;
  durationUs?: number;
}

/** Sequential access to the packets of one audio track. */
export interface PacketReader {
  readonly info: EncodedAudioInfo;
  /** The next packet in decoding order, or null at the end. */
  next(): Promise<EncodedPacket | null>;
  /** 0..1, how much of the file has been read. */
  progress(): number;
  close(): Promise<void>;
}

/* ------------------------------------------------------------ chapters from Vorbis comments */

function parseClock(text: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3].replace(',', '.'));
}

/**
 * Chapter marks from Vorbis comments in the common "CHAPTER001=00:01:02.500"
 * / "CHAPTER001NAME=Title" form (written by many tagging tools).
 */
export function chaptersFromVorbisComments(comments: readonly string[]): ChapterMark[] {
  const times = new Map<string, number>();
  const names = new Map<string, string>();
  for (const c of comments) {
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    const key = c.slice(0, eq).toUpperCase();
    const value = c.slice(eq + 1);
    const m = /^CHAPTER(\d+)(NAME)?$/.exec(key);
    if (!m) continue;
    if (m[2]) {
      if (value.trim()) names.set(m[1], value.trim());
    } else {
      const t = parseClock(value);
      if (t !== null) times.set(m[1], t);
    }
  }
  const out: ChapterMark[] = [];
  for (const [id, startSec] of times) out.push({ startSec, title: names.get(id) });
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Parses a Vorbis comment block (vendor string, then "KEY=value" entries; little endian lengths). */
export function parseVorbisComments(b: Uint8Array, offset = 0): string[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dec = new TextDecoder('utf-8');
  let p = offset;
  if (p + 4 > b.length) return [];
  const vendorLen = dv.getUint32(p, true);
  p += 4 + vendorLen;
  if (p + 4 > b.length) return [];
  const count = dv.getUint32(p, true);
  p += 4;
  const out: string[] = [];
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const len = dv.getUint32(p, true);
    p += 4;
    if (p + len > b.length) break;
    out.push(dec.decode(b.subarray(p, p + len)));
    p += len;
  }
  return out;
}

/* ------------------------------------------------------------ ADTS (raw AAC) */

export const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Two-byte AudioSpecificConfig for a plain AAC stream. */
export function audioSpecificConfig(objectType: number, sampleRateIndex: number, channelConfig: number): Uint8Array {
  return new Uint8Array([(objectType << 3) | (sampleRateIndex >> 1), ((sampleRateIndex & 1) << 7) | (channelConfig << 3)]);
}

interface AdtsHeader {
  objectType: number;
  sampleRateIndex: number;
  channelConfig: number;
  frameLength: number;
  headerLength: number;
  blocks: number;
}

function parseAdts(b: Uint8Array, p: number): AdtsHeader | null {
  const frameLength = adtsFrameLength(b, p);
  if (!frameLength) return null;
  return {
    objectType: ((b[p + 2] >> 6) & 3) + 1,
    sampleRateIndex: (b[p + 2] >> 2) & 15,
    channelConfig: ((b[p + 2] & 1) << 2) | (b[p + 3] >> 6),
    frameLength,
    headerLength: b[p + 1] & 1 ? 7 : 9,
    blocks: (b[p + 6] & 3) + 1,
  };
}

/** Raw AAC in ADTS frames (.aac files). Packets are the frames without their ADTS header. */
export class AdtsPacketReader implements PacketReader {
  private pos: number;
  private frameIndex = 0;

  private constructor(
    readonly info: EncodedAudioInfo,
    private readonly reader: WindowReader,
    start: number,
    private readonly signal?: AbortSignal,
  ) {
    this.pos = start;
  }

  static async open(source: ByteSource, signal?: AbortSignal): Promise<AdtsPacketReader> {
    const layout = await measureTags(source);
    const reader = new WindowReader(source, layout.audioEnd);
    const head = await readRange(source, layout.audioStart, Math.min(256 * 1024, layout.audioEnd - layout.audioStart));
    let first = -1;
    for (let p = 0; p + 7 <= head.length; p++) {
      const h = parseAdts(head, p);
      if (h && (p + h.frameLength + 7 > head.length || parseAdts(head, p + h.frameLength))) {
        first = p;
        break;
      }
    }
    if (first < 0) throw new AudioError('unsupported-format');
    const h = parseAdts(head, first) as AdtsHeader;
    const sampleRate = AAC_SAMPLE_RATES[h.sampleRateIndex];
    if (!sampleRate) throw new AudioError('unsupported-format');
    // Estimate the duration from the frames in the first 256 KiB.
    let frames = 0;
    let bytes = 0;
    for (let p = first; p + 7 <= head.length; ) {
      const f = parseAdts(head, p);
      if (!f || p + f.frameLength > head.length) break;
      frames += f.blocks;
      bytes += f.frameLength;
      p += f.frameLength;
    }
    const audioBytes = layout.audioEnd - layout.audioStart - first;
    const bytesPerSec = frames > 0 ? (bytes / (frames * 1024)) * sampleRate : 16000;
    const info: EncodedAudioInfo = {
      container: 'aac',
      codec: 'aac',
      webCodecs: `mp4a.40.${h.objectType}`,
      description: audioSpecificConfig(h.objectType, h.sampleRateIndex, h.channelConfig),
      sampleRate,
      channels: h.channelConfig === 0 ? 2 : h.channelConfig === 7 ? 8 : h.channelConfig,
      skipSamples: 0,
      durationSec: audioBytes / bytesPerSec,
      durationExact: false,
      bitrateKbps: Math.round((bytesPerSec * 8) / 1000),
    };
    return new AdtsPacketReader(info, reader, layout.audioStart + first, signal);
  }

  async next(): Promise<EncodedPacket | null> {
    const r = this.reader;
    for (;;) {
      checkAborted(this.signal);
      if (this.pos + 7 > r.end) return null;
      await r.ensure(this.pos, 16 * 1024);
      const i = this.pos - r.base;
      const h = parseAdts(r.buf, i);
      if (h && this.pos + h.frameLength <= r.end) {
        if (h.blocks !== 1) throw new AudioError('unsupported-format'); // several raw blocks per frame: rare, let the fallback try
        await r.ensure(this.pos, h.frameLength);
        const j = this.pos - r.base;
        const data = r.buf.subarray(j + h.headerLength, j + h.frameLength);
        const packet: EncodedPacket = {
          data,
          timestampUs: Math.round((this.frameIndex * 1024 * 1e6) / this.info.sampleRate),
          durationUs: Math.round((1024 * 1e6) / this.info.sampleRate),
        };
        this.pos += h.frameLength;
        this.frameIndex++;
        return packet;
      }
      // Damaged data: look for the next frame header.
      this.pos++;
      while (this.pos + 7 <= r.end) {
        await r.ensure(this.pos, 64 * 1024);
        const buf = r.buf;
        const lim = Math.min(r.limit, r.end) - 7 - r.base;
        let k = this.pos - r.base;
        while (k < lim && !(buf[k] === 0xff && (buf[k + 1] & 0xf6) === 0xf0)) k++;
        this.pos = r.base + k;
        if (k < lim) break;
        if (r.limit >= r.end) return null;
      }
    }
  }

  progress(): number {
    return Math.min(1, this.pos / Math.max(1, this.reader.end));
  }

  async close(): Promise<void> {
    this.pos = this.reader.end;
  }
}
