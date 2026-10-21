/**
 * AudioBackend on top of the Rust decoder (symphonia). The backend streams
 * the file, so a 10-hour audiobook is never held in memory on either side.
 *
 * `audio_analyze` answers with a TSB1 frame: the JSON header below plus one
 * little-endian f32 per 10 ms window (K-weighted power, BS.1770-4).
 * `audio_pcm_read` answers with raw interleaved f32 samples.
 *
 * Sources without a path (data that only exists in memory) are written to a
 * temp file first, which is removed again afterwards.
 */
import type { AudioAnalysis, AudioBackend, AudioProbe, ByteSource, PcmChunk, PcmReader } from '../types';
import { deinterleave, f32FromBytes, parseFrame, toBytes } from './binary';
import { uniqueId, type Bridge } from './bridge';
import { abortReason, platformError } from './errors';
import { writeSource } from './fs';

export const EVENT_AUDIO_PROGRESS = 'audio-progress';

export interface AnalysisHeaderDto {
  durationSec: number;
  sampleRate: number;
  channels: number;
  windowSec: number;
  windowCount: number;
  lufs: number | null;
  peak?: number | null;
  /** Flat tops at the loudest level (src-tauri/src/loudness.rs ClipCounter). */
  clips?: number | null;
  chapters: { startSec: number; title?: string | null }[];
  codec: string;
  bitrateKbps: number | null;
}

interface PcmOpenedDto {
  handle: number;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

interface ProgressDto {
  jobId: string;
  fraction: number;
}

/** Largest block one `audio_pcm_read` returns. */
const MAX_PCM_FRAMES = 1 << 20;

/** A file the backend can open, and how to give it back. */
interface LocalFile {
  path: string;
  release(): Promise<void>;
}

export function extensionOf(name: string): string | undefined {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : undefined;
}

export function toAnalysis(header: AnalysisHeaderDto, payload: Uint8Array): AudioAnalysis {
  const all = f32FromBytes(payload);
  const power = all.length > header.windowCount ? all.subarray(0, header.windowCount) : all;
  const out: AudioAnalysis = {
    durationSec: header.durationSec,
    sampleRate: header.sampleRate,
    channels: header.channels,
    windowSec: header.windowSec,
    power,
  };
  if (header.lufs != null && Number.isFinite(header.lufs)) out.lufs = header.lufs;
  if (header.peak != null && Number.isFinite(header.peak)) out.peak = header.peak;
  if (header.clips != null && Number.isFinite(header.clips)) out.clips = header.clips;
  if (header.chapters?.length) {
    out.chapters = header.chapters.map((c) => (c.title ? { startSec: c.startSec, title: c.title } : { startSec: c.startSec }));
  }
  if (header.codec) out.codec = header.codec;
  if (header.bitrateKbps != null) out.bitrateKbps = header.bitrateKbps;
  return out;
}

export class TauriPcmReader implements PcmReader {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSec: number;
  private readonly handle: number;
  private closed = false;
  private ended = false;

  constructor(
    private readonly bridge: Bridge,
    opened: PcmOpenedDto,
    private readonly release: () => Promise<void> = async () => undefined,
  ) {
    this.handle = opened.handle;
    this.sampleRate = opened.sampleRate;
    this.channels = opened.channels;
    this.durationSec = opened.durationSec;
  }

  async next(maxFrames: number): Promise<PcmChunk | null> {
    if (this.closed || this.ended) return null;
    const frames = Math.max(1, Math.min(MAX_PCM_FRAMES, Math.floor(maxFrames) || 1));
    const bytes = toBytes(await this.bridge.call('audio', 'audio_pcm_read', { handle: this.handle, maxFrames: frames }));
    if (bytes.byteLength === 0) {
      this.ended = true;
      return null;
    }
    return { channels: deinterleave(f32FromBytes(bytes), this.channels), sampleRate: this.sampleRate };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.bridge.call('audio', 'audio_pcm_close', { handle: this.handle });
    } finally {
      await this.release();
    }
  }
}

export class TauriAudio implements AudioBackend {
  constructor(private readonly bridge: Bridge) {}

  /** The source's own file, or a temp copy of in-memory data. */
  private async local(input: ByteSource, signal?: AbortSignal): Promise<LocalFile> {
    if (input.path) return { path: input.path, release: async () => undefined };
    const path = await this.bridge.call<string>('audio', 'fs_temp_file', { extension: extensionOf(input.name) ?? null });
    const release = () => this.bridge.ipc.invoke('fs_temp_remove', { path }).then(
      () => undefined,
      () => undefined,
    );
    try {
      await writeSource(this.bridge, path, input, { signal, area: 'audio' });
    } catch (e) {
      await release();
      throw e;
    }
    return { path, release };
  }

  async analyze(input: ByteSource, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<AudioAnalysis> {
    if (signal?.aborted) throw abortReason(signal);
    const file = await this.local(input, signal);
    const jobId = uniqueId('audio');
    let unlisten: (() => void) | undefined;
    const onAbort = () => void this.bridge.ipc.invoke('audio_cancel', { jobId }).catch(() => undefined);
    try {
      if (onProgress) {
        unlisten = await this.bridge.ipc.listen<ProgressDto>(EVENT_AUDIO_PROGRESS, (p) => {
          if (p.jobId === jobId) onProgress(p.fraction);
        });
      }
      if (signal?.aborted) throw abortReason(signal);
      signal?.addEventListener('abort', onAbort, { once: true });
      const reply = await this.bridge.call<unknown>('audio', 'audio_analyze', { path: file.path, jobId });
      let frame: { header: AnalysisHeaderDto; payload: Uint8Array };
      try {
        frame = parseFrame<AnalysisHeaderDto>(reply);
      } catch (e) {
        throw platformError('other', 'audio', e instanceof Error ? e.message : String(e));
      }
      return toAnalysis(frame.header, frame.payload);
    } catch (e) {
      if (signal?.aborted) throw abortReason(signal);
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      unlisten?.();
      await file.release();
    }
  }

  async check(input: ByteSource, signal?: AbortSignal): Promise<AudioProbe> {
    if (signal?.aborted) throw abortReason(signal);
    const reader = await this.openPcm(input, { signal });
    await reader.close();
    return { durationSec: reader.durationSec > 0 ? reader.durationSec : undefined, sampleRate: reader.sampleRate, channels: reader.channels };
  }

  async openPcm(input: ByteSource, opts: { targetSampleRate?: number; signal?: AbortSignal } = {}): Promise<PcmReader> {
    if (opts.signal?.aborted) throw abortReason(opts.signal);
    const file = await this.local(input, opts.signal);
    try {
      const opened = await this.bridge.call<PcmOpenedDto>('audio', 'audio_pcm_open', {
        path: file.path,
        targetSampleRate: opts.targetSampleRate ?? null,
      });
      return new TauriPcmReader(this.bridge, opened, file.release);
    } catch (e) {
      await file.release();
      throw e;
    }
  }
}
