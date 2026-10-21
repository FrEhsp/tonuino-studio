/**
 * One entry point for decoding any supported file without a page: MP3
 * through mpg123-decoder (WASM), WAV and AIFF directly, MP4/M4A/M4B, AAC,
 * FLAC and Ogg (Opus, Vorbis) through the demuxers and WebCodecs.
 *
 * Runs in the analysis worker of the browser build and in Node (tests).
 * Everything streams: a 10-hour book never sits decoded in memory.
 * When a file cannot be decoded here, the AudioError carries
 * `details.fallback = true` if the page's AudioContext may still manage
 * (see browserBackend.ts).
 */
import type { AudioAnalysis, ByteSource, PcmReader } from '../../platform/types';
import { AdtsPacketReader, type ChapterMark, type PacketReader } from './demux';
import { AudioError, checkAborted } from './errors';
import { FlacPacketReader } from './flac';
import { sniffContainer, type ContainerKind } from './formats';
import { chaptersFromId3, readTags } from './id3';
import { Mp3PcmReader, type MpegDecoderFactory } from './mp3decode';
import { Mp4PacketReader } from './mp4';
import { OggPacketReader } from './ogg';
import { analyzePcm, withSampleRate } from './pcm';
import { WavPcmReader } from './wav';
import { browserWebCodecs, WebCodecsPcmReader, type WebCodecsApi } from './webcodecs';
import { probeWebm } from './webm';

export interface DecodeEnv {
  /** mpg123 decoder factory (tests may inject one). */
  mpegDecoderFactory?: MpegDecoderFactory;
  /** WebCodecs to use; undefined = the environment's own (if any), null = none. */
  webCodecs?: WebCodecsApi | null;
}

export interface OpenAudioOptions {
  signal?: AbortSignal;
  env?: DecodeEnv;
  /** Resample to this rate (e.g. 44100 for MP3 encoding). */
  targetSampleRate?: number;
}

/** A decoder for one file plus what its container told us. */
export interface OpenedAudio {
  reader: PcmReader;
  /** 0..1 of the file read so far. */
  progress(): number;
  container: ContainerKind;
  codec?: string;
  bitrateKbps?: number;
  chapters?: ChapterMark[];
}

const PACKET_CONTAINERS: ContainerKind[] = ['mp4', 'aac', 'flac', 'ogg'];

async function openPackets(source: ByteSource, kind: ContainerKind, signal?: AbortSignal): Promise<PacketReader> {
  switch (kind) {
    case 'mp4':
      return Mp4PacketReader.open(source, signal);
    case 'aac':
      return AdtsPacketReader.open(source, signal);
    case 'flac':
      return FlacPacketReader.open(source, signal);
    case 'ogg':
      return OggPacketReader.open(source, signal);
    default:
      throw new AudioError('unsupported-format');
  }
}

/** Adds the "try the browser's own decoder" hint to an unsupported-format error; a codec the demuxer named stays. */
function withFallback(err: unknown, details: { durationSec?: number; container: ContainerKind; codec?: string }): unknown {
  if (err instanceof AudioError && err.code === 'unsupported-format' && !err.details?.fallback) {
    return new AudioError('unsupported-format', undefined, { cause: err, details: { ...details, codec: details.codec ?? err.details?.codec, fallback: true } });
  }
  return err;
}

/** Opens a decoder for any supported file. See the module comment for the formats. */
export async function openAudio(source: ByteSource, opts: OpenAudioOptions = {}): Promise<OpenedAudio> {
  const { signal, env = {} } = opts;
  const kind = await sniffContainer(source);
  checkAborted(signal);
  let opened: OpenedAudio;
  if (kind === 'mp3') {
    const tags = await readTags(source, { maxTagBytes: 16 << 20 }).catch(() => null);
    const reader = await Mp3PcmReader.open(source, { signal, decoderFactory: env.mpegDecoderFactory });
    const chapters = tags?.id3v2 ? chaptersFromId3(tags.id3v2).map((c) => ({ startSec: c.startSec, title: c.title })) : [];
    const audioBytes = reader.probe.tags.audioEnd - reader.probe.firstFrame;
    opened = {
      reader,
      progress: () => reader.progress(),
      container: 'mp3',
      codec: 'mp3',
      bitrateKbps: reader.durationSec > 0 ? Math.round((audioBytes * 8) / reader.durationSec / 1000) : undefined,
      chapters: chapters.length > 0 ? chapters : undefined,
    };
  } else if (kind === 'wav' || kind === 'aiff') {
    const reader = await WavPcmReader.open(source, { signal });
    const info = reader.info;
    opened = {
      reader,
      progress: () => reader.progress(),
      container: kind,
      codec: info.formatTag === 3 ? 'pcm-float' : 'pcm',
      bitrateKbps: Math.round((info.sampleRate * info.blockAlign * 8) / 1000),
    };
  } else if (PACKET_CONTAINERS.includes(kind)) {
    const packets = await openPackets(source, kind, signal).catch((err: unknown) => {
      throw withFallback(err, { container: kind });
    });
    const info = packets.info;
    if (info.drm) {
      await packets.close();
      throw new AudioError('drm-protected');
    }
    const api = env.webCodecs === undefined ? browserWebCodecs() : env.webCodecs;
    const details = { durationSec: info.durationExact ? info.durationSec : undefined, container: kind, codec: info.codec };
    if (!api) {
      await packets.close();
      throw new AudioError('unsupported-format', undefined, { details: { ...details, fallback: true } });
    }
    let reader: WebCodecsPcmReader;
    try {
      reader = await WebCodecsPcmReader.open(packets, api, signal);
    } catch (err) {
      await packets.close();
      throw withFallback(err, details);
    }
    opened = { reader, progress: () => reader.progress(), container: kind, codec: info.codec, bitrateKbps: info.bitrateKbps, chapters: info.chapters };
  } else if (kind === 'webm') {
    // WebM/Matroska: the browser's own decoder may know it. Its codec and length tell whether it can, and whether the file fits in memory.
    const probe = await probeWebm(source).catch(() => ({ codec: undefined, durationSec: undefined }));
    throw new AudioError('unsupported-format', undefined, { details: { container: kind, codec: probe.codec, durationSec: probe.durationSec, fallback: true } });
  } else {
    // Unknown files: maybe the browser's own decoder knows them. WMA never works in browsers.
    throw new AudioError('unsupported-format', undefined, { details: { container: kind, fallback: kind !== 'asf' } });
  }
  if (opts.targetSampleRate && opened.reader.sampleRate !== opts.targetSampleRate) {
    opened = { ...opened, reader: withSampleRate(opened.reader, opts.targetSampleRate) };
  }
  return opened;
}

export interface AnalyzeAudioOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  windowSec?: number;
  env?: DecodeEnv;
}

/** Streams a whole file through the loudness meter: power envelope, LUFS, chapters. */
export async function analyzeAudio(source: ByteSource, opts: AnalyzeAudioOptions = {}): Promise<AudioAnalysis> {
  const opened = await openAudio(source, { signal: opts.signal, env: opts.env });
  try {
    const analysis = await analyzePcm(opened.reader, {
      windowSec: opts.windowSec,
      onProgress: opts.onProgress,
      signal: opts.signal,
      progressOf: () => opened.progress(),
    });
    let bitrateKbps = opened.bitrateKbps;
    if (!bitrateKbps && analysis.durationSec > 0) bitrateKbps = Math.round((source.size * 8) / analysis.durationSec / 1000);
    return { ...analysis, chapters: opened.chapters, codec: opened.codec, bitrateKbps };
  } finally {
    await opened.reader.close();
  }
}
