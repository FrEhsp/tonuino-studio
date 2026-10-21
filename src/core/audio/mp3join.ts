/**
 * Joining several MP3s into one ("Titel zusammenfügen", an extra of the
 * settings page): chapters of a book become one track, to stay below 99
 * folders or to have one card per episode.
 *
 * When all files share MPEG version, sample rate and channel count, their
 * frames are copied one after the other, without converting: [small tag]
 * [fresh Xing/Info frame for the whole] [frames of file 1] [frames of 2] …
 * Their own tags and Xing/Info frames stay behind, so the new tag frame
 * counts every frame and players show the right length. The LAME tag keeps
 * the encoder delay of the first file and the padding of the last; the
 * short silences of the files in between stay as they were.
 *
 * Bit reservoir: a file that was itself cut (mp3cut) may begin with frames
 * that reach back into bytes before them. Behind another file those bytes
 * would be that file's, and the first frame would crackle. Such a file gets
 * a silent frame in front (one frame, 26 ms) that carries the bytes it
 * needs, as the tag frame of a cut part does.
 *
 * Files that differ (mono and stereo, 44.1 and 48 kHz, not MP3) are
 * converted together into one new MP3 instead (mergeMp3Files).
 */
import type { AudioBackend, ByteSource, PcmChunk, PcmReader } from '../../platform/types';
import { crc16Arc } from './bits';
import { encodeFromReader } from './encode';
import { AudioError, checkAborted, isAbortError } from './errors';
import { buildSmallId3, type SmallTags } from './id3';
import { buildXingFrame, gatherReservoir, LAME_ENCODER, mainDataBegin, mainDataSize, maxReservoir } from './mp3cut';
import { MP3_SAMPLE_RATE } from './mp3encoder';
import { bitrateTable, decodeHeader, frameLengthFor, readU32, scanMp3, sideInfoSizeFor, versionBitsOf, type FrameHeader, type Mp3Index } from './mp3frames';
import { downmix, withSampleRate } from './pcm';
import { BlobCollector, CHUNK_SIZE, readRange } from './source';

export interface JoinInput {
  source: ByteSource;
  index: Mp3Index;
}

/** Why files cannot be joined frame by frame: not Layer III, or a different format than the first. */
export type JoinProblem = 'layer' | 'format';

/** Null when the frames of all files can follow each other in one stream. */
export function joinProblem(indexes: readonly Pick<Mp3Index, 'layer' | 'version' | 'sampleRate' | 'channels'>[]): JoinProblem | null {
  const first = indexes[0];
  if (!first) return null;
  if (indexes.some((x) => x.layer !== 3)) return 'layer';
  if (indexes.some((x) => x.version !== first.version || x.sampleRate !== first.sampleRate || x.channels !== first.channels)) return 'format';
  return null;
}

/**
 * A silent Layer III frame (side information zero) with `reservoir` at the
 * end of its main data, in the format of `like`. The smallest bitrate from
 * that of `like` up whose frame holds the bytes.
 */
export function bridgeFrame(like: FrameHeader, reservoir: Uint8Array): Uint8Array {
  const room = (kbps: number) => frameLengthFor(like.version, 3, kbps, like.sampleRate, 0) - 4 - sideInfoSizeFor(like.version, like.channels);
  const table = bitrateTable(like.version, 3);
  const pick = table.find((b) => b.kbps >= like.bitrateKbps && room(b.kbps) >= reservoir.length) ?? table.find((b) => room(b.kbps) >= reservoir.length);
  if (!pick) throw new RangeError('Reservoir does not fit into one frame');
  const f = new Uint8Array(frameLengthFor(like.version, 3, pick.kbps, like.sampleRate, 0));
  f[0] = 0xff;
  f[1] = 0xe0 | (versionBitsOf(like.version) << 3) | (1 << 1) | 1; // Layer III, no CRC
  f[2] = (pick.index << 4) | (like.sampleRateIndex << 2);
  // Channel mode, copyright, original and emphasis as in `like`; no mode extension.
  f[3] = like.raw & 0xcf;
  f.set(reservoir, f.length - reservoir.length);
  return f;
}

export interface JoinOptions {
  /** Small ID3 tag for the start of the new file (buildSmallId3), or null for none. */
  tag?: Uint8Array | null;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** What joinMp3 made, for tests and for the catalog. */
export interface JoinedMp3 {
  blob: Blob;
  /** Audio frames after the tag frame, silent bridges included. */
  frames: number;
  /** Silent frames put in front of files that reached back into bytes before them. */
  bridges: number;
}

/**
 * Joins MP3s losslessly (see the top of this file). Throws AudioError
 * 'unsupported-layer' or 'mixed-format' when joinProblem() says no.
 */
export async function joinMp3(inputs: readonly JoinInput[], opts: JoinOptions = {}): Promise<JoinedMp3> {
  const { signal, onProgress } = opts;
  if (!inputs.length) throw new AudioError('no-audio');
  const problem = joinProblem(inputs.map((x) => x.index));
  if (problem) throw new AudioError(problem === 'layer' ? 'unsupported-layer' : 'mixed-format');

  const out = new BlobCollector();
  const totalFrames = inputs.reduce((n, x) => n + x.index.frameCount, 0) + inputs.length;
  // Byte offset (behind the tag frame) of every frame, for the seek table.
  const starts = new Float64Array(totalFrames);
  let frames = 0;
  let bridges = 0;
  let audioBytes = 0;
  let crc = 0;
  let minBr = 15;
  let maxBr = 0;
  let firstHeader: FrameHeader | null = null;
  let headReservoir: Uint8Array | undefined;
  const totalRead = Math.max(1, inputs.reduce((n, x) => n + (x.index.audioEnd - (x.index.frameOffsets[0] ?? x.index.audioEnd)), 0));
  let read = 0;

  const push = (bytes: Uint8Array, h: FrameHeader) => {
    starts[frames++] = audioBytes;
    audioBytes += bytes.length;
    crc = crc16Arc(bytes, 0, bytes.length, crc);
    if (h.bitrateIndex < minBr) minBr = h.bitrateIndex;
    if (h.bitrateIndex > maxBr) maxBr = h.bitrateIndex;
  };

  for (let n = 0; n < inputs.length; n++) {
    const { source, index } = inputs[n];
    if (!index.frameCount) continue;
    const offsets = index.frameOffsets;
    let need = 0;
    let cumMain = 0;
    let reservoirDone = false;
    let k = 0;
    let first = true;
    while (k < index.frameCount) {
      checkAborted(signal);
      const k0 = k;
      const chunkStart = offsets[k0];
      let k1 = k0 + 1;
      while (k1 < index.frameCount && offsets[k1] - chunkStart < CHUNK_SIZE) k1++;
      const chunkEnd = k1 < index.frameCount ? offsets[k1] : index.audioEnd;
      const buf = await readRange(source, chunkStart, chunkEnd - chunkStart);
      const chunk: { bytes: Uint8Array; h: FrameHeader }[] = [];
      for (k = k0; k < k1; k++) {
        const i = offsets[k] - chunkStart;
        const h = i + 4 <= buf.length ? decodeHeader(readU32(buf, i)) : null;
        if (!h || i + h.frameLength > buf.length) throw new AudioError('read-failed');
        if (!reservoirDone) {
          need = Math.max(need, mainDataBegin(buf, i, h) - cumMain);
          cumMain += mainDataSize(h);
          if (cumMain >= maxReservoir(h.version)) reservoirDone = true;
        }
        chunk.push({ bytes: buf.subarray(i, i + h.frameLength), h });
      }
      if (first) {
        first = false;
        const h0 = chunk[0].h;
        // The first file hands its reservoir bytes to the tag frame, the others to a silent frame in front.
        if (need > 0) {
          const bytes = await gatherReservoir(source, index, 0, need);
          if (!firstHeader) headReservoir = bytes;
          else {
            const bridge = bridgeFrame(h0, bytes);
            push(bridge, decodeHeader(readU32(bridge, 0)) as FrameHeader);
            out.push([bridge]);
            bridges++;
          }
        }
        firstHeader ??= h0;
      }
      for (const c of chunk) push(c.bytes, c.h);
      // Runs of whole frames go out as they lie in the chunk.
      out.push(chunk.map((c) => c.bytes));
      read += chunkEnd - chunkStart;
      onProgress?.(Math.min(0.99, read / totalRead));
    }
  }
  if (!firstHeader) throw new AudioError('no-audio');

  const tocOffsets = new Float64Array(100);
  for (let i = 0; i < 100; i++) tocOffsets[i] = starts[Math.floor((i * frames) / 100)];
  const firstIndex = inputs[0].index;
  const lastIndex = inputs[inputs.length - 1].index;
  const h = firstHeader;
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
    {
      kind: minBr === maxBr ? 'Info' : 'Xing',
      frames,
      audioBytes,
      tocOffsets,
      reservoir: headReservoir,
      lame: firstIndex.lame
        ? {
            encoderDelay: firstIndex.lame.encoderDelay,
            padding: lastIndex.lame?.padding ?? 0,
            encoder: LAME_ENCODER.test(firstIndex.lame.encoder) ? firstIndex.lame.encoder : undefined,
            musicCrc: crc,
          }
        : undefined,
    },
  );
  onProgress?.(1);
  return { blob: out.toBlob([opts.tag ?? new Uint8Array(0), xing]), frames, bridges };
}

/* ------------------------------------------------------------ converting together */

/**
 * One PcmReader over several files, one after the other, mixed to
 * `channels`. Each file is opened when the one before has ended, so only
 * one decoder runs at a time.
 */
export class ChainedPcmReader implements PcmReader {
  private current: PcmReader | null = null;
  private opened = 0;
  private closed = false;

  constructor(
    private readonly open: readonly (() => Promise<PcmReader>)[],
    readonly channels: 1 | 2,
    readonly sampleRate: number,
    readonly durationSec: number,
  ) {}

  async next(maxFrames: number): Promise<PcmChunk | null> {
    while (!this.closed) {
      if (!this.current) {
        if (this.opened >= this.open.length) return null;
        this.current = await this.open[this.opened++]();
      }
      const chunk = await this.current.next(maxFrames);
      if (chunk) return { channels: downmix(chunk.channels, this.channels), sampleRate: chunk.sampleRate };
      await this.current.close().catch(() => undefined);
      this.current = null;
    }
    return null;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.current?.close().catch(() => undefined);
    this.current = null;
  }
}

export interface MergeOptions {
  /** Tag of the new file (title of the first track, artist, album). */
  tags?: SmallTags;
  /** Bitrate when the files have to be converted. */
  bitrateKbps?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Passed to the encoder (tests run without a Worker). */
  useWorker?: boolean;
}

export interface MergedMp3 {
  blob: Blob;
  /** Joined frame by frame, without converting. */
  lossless: boolean;
}

/** The frame index, or null for a file whose frames cannot simply be copied (no MP3, a rare variant, changes its format). */
async function indexOrNull(source: ByteSource, signal?: AbortSignal): Promise<Mp3Index | null> {
  try {
    return await scanMp3(source, { signal });
  } catch (e) {
    if (isAbortError(e) || !(e instanceof AudioError) || e.code === 'read-failed') throw e;
    return null;
  }
}

/**
 * Joins `sources` into one MP3: frame by frame when joinProblem() allows it,
 * otherwise by converting them together with `backend` (as the import
 * does: 44.1 kHz, `bitrateKbps`, mono only when every file is mono).
 */
export async function mergeMp3Files(backend: AudioBackend, sources: readonly ByteSource[], opts: MergeOptions = {}): Promise<MergedMp3> {
  const { signal, onProgress } = opts;
  const indexes: (Mp3Index | null)[] = [];
  // Looking at the frames is quick next to reading and writing them: a tenth of the bar.
  for (let i = 0; i < sources.length; i++) {
    indexes.push(await indexOrNull(sources[i], signal));
    onProgress?.((0.1 * (i + 1)) / sources.length);
  }
  const later = (f: number) => onProgress?.(0.1 + 0.9 * f);
  const tag = opts.tags ? buildSmallId3(opts.tags) : null;
  if (indexes.every((x): x is Mp3Index => !!x && x.frameCount > 0) && !joinProblem(indexes)) {
    const joined = await joinMp3(
      sources.map((source, i) => ({ source, index: indexes[i] as Mp3Index })),
      { tag, signal, onProgress: later },
    );
    return { blob: joined.blob, lossless: true };
  }
  checkAborted(signal);
  const mono = indexes.every((x) => x?.channels === 1);
  const duration = indexes.reduce((n, x) => n + (x?.durationSec ?? 0), 0);
  const chain = new ChainedPcmReader(
    sources.map((s) => async () => withSampleRate(await backend.openPcm(s, { targetSampleRate: MP3_SAMPLE_RATE, signal }), MP3_SAMPLE_RATE)),
    mono ? 1 : 2,
    MP3_SAMPLE_RATE,
    duration,
  );
  const blob = await encodeFromReader(chain, { bitrateKbps: opts.bitrateKbps, tags: opts.tags, signal, onProgress: later, useWorker: opts.useWorker });
  return { blob, lossless: false };
}
