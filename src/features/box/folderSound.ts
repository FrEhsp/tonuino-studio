/**
 * "Lautstärke anpassen" and "Kleiner machen" for a folder that is on the
 * card already (TODO #94.1, #95a; forum 2866, 3050, 14978#68–73): the same
 * work as when adding (process.ts), for files that were copied before.
 *
 * - Loudness: one change for the whole folder towards TARGET_LUFS, or
 *   quieter or louder on purpose by the folder's offset (levelTarget), via
 *   planAlbumGain, so the levels between its tracks stay. MP3s change
 *   losslessly like MP3Gain (global_gain steps, applyGain); a quiet folder
 *   whose loudest sample leaves no room is converted anew with the
 *   converter's true-peak limiter, when "Leise MP3s lauter machen" is on.
 * - Smaller: converted anew in mono and/or at a lower bitrate, only files
 *   that really get smaller; optionally with the folder's loudness on the way.
 *
 * Every new file is checked before it may replace the old one (its frames
 * and length), and read back after writing. The old file goes only once the
 * new one is complete on the card (platform write()).
 */
import { mapLimit, throttle } from '../../core/async';
import {
  albumLoudness,
  applyGain,
  blobOfRange,
  convertToMp3,
  effectiveBitrate,
  fileSource,
  isAbortError,
  levelTarget,
  planAlbumGain,
  readTags,
  scanMp3,
  type AlbumGain,
  type BasicTags,
  type Mp3Index,
  type SmallTags,
} from '../../core/audio';
import type { AudioAnalysis, AudioBackend, ByteSource, Dir } from '../../platform/types';

export type SoundJob = 'level' | 'shrink';

/** A folder closer to the target than this keeps its loudness (Tonuino-Manager: ±1 LU). */
export const LEVEL_TOLERANCE_DB = 1;

/** A file is converted to save room only when it gets at least this much smaller. */
const WORTH_SHRINKING = 0.85;

/** Highest bitrate a converted file keeps (the converter's table ends at 320). */
const MAX_KEPT_KBPS = 320;

/** One file of the folder as measured. */
export interface Measured {
  file: string;
  source: ByteSource;
  /** Frames of a layer III MP3; undefined for anything else (WAV, MP2, unreadable). */
  index?: Mp3Index;
  /** Decoded and measured (loudness, peak); only when the job needs it. */
  analysis?: AudioAnalysis;
}

/** What happens to one file. */
export type FileAction =
  | { kind: 'keep'; reason?: 'not-mp3' | 'small' }
  /** Lossless: every frame's global_gain moves by `steps` (1.5 dB each). */
  | { kind: 'gain'; steps: number }
  | { kind: 'convert'; gainDb: number; bitrateKbps: number; mono: boolean };

export interface FolderPlan {
  job: SoundJob;
  /** Same order as the measured files. */
  actions: FileAction[];
  /** The folder's loudness as heard on the box (LUFS); undefined when not measured or silent. */
  lufs?: number;
  /** The change the folder gets (planAlbumGain); undefined when it is close enough or not measured. */
  gain?: AlbumGain;
  /** Loudness: the folder is within LEVEL_TOLERANCE_DB of the target already. */
  already?: boolean;
  /** The offset the loudness was planned with (dB from TARGET_LUFS, see levelTarget); 0 when as loud as the others. */
  offsetDb: number;
  /** Bytes of the files that change, before and (estimated) after. */
  bytesBefore: number;
  bytesAfter: number;
}

export interface ShrinkTarget {
  mono: boolean;
  bitrateKbps: number;
}

/** The two choices of "Kleiner machen": speech in mono, or music in stereo at the app's bitrate (at most 128 kbit/s). */
export function shrinkTarget(kind: 'speech' | 'music', bitrateKbps: number): ShrinkTarget {
  return kind === 'speech' ? { mono: true, bitrateKbps: 64 } : { mono: false, bitrateKbps: Math.min(128, bitrateKbps) };
}

/** Size of the converted audio, in bytes. */
export function convertedSize(durationSec: number, target: ShrinkTarget, channels: 1 | 2): number {
  const kbps = effectiveBitrate(target.bitrateKbps, target.mono || channels === 1 ? 1 : 2);
  return Math.round((durationSec * kbps * 1000) / 8);
}

/** Whether converting saves enough room to be worth it. */
export function worthShrinking(index: Pick<Mp3Index, 'durationSec' | 'audioBytes' | 'channels'>, target: ShrinkTarget): boolean {
  return convertedSize(index.durationSec, target, index.channels) < index.audioBytes * WORTH_SHRINKING;
}

/**
 * Reads the frames of every MP3 and, with `analyze`, decodes it once to
 * measure its loudness and peak. A file that cannot be read stays as it is.
 */
export async function measureFolder(
  files: readonly { file: string; source: ByteSource }[],
  audio: AudioBackend,
  opts: { analyze: boolean; signal?: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<Measured[]> {
  const weights = files.map((f) => Math.max(1, f.source.size));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const done = files.map(() => 0);
  const report = throttle(() => opts.onProgress?.(done.reduce((sum, d, i) => sum + d * weights[i], 0) / total), 100);
  // Scanning the frames is quick next to decoding: a tenth of each file's share.
  const scanShare = opts.analyze ? 0.1 : 1;
  const out = await mapLimit(files, 3, async (f, i): Promise<Measured> => {
    const m: Measured = { file: f.file, source: f.source };
    try {
      if (/\.mp3$/i.test(f.file)) {
        const index = await scanMp3(f.source, { signal: opts.signal });
        if (index.layer === 3 && index.frameCount > 0) m.index = index;
      }
    } catch (e) {
      if (opts.signal?.aborted || isAbortError(e)) throw e;
    }
    done[i] = scanShare;
    report();
    if (m.index && opts.analyze) {
      try {
        m.analysis = await audio.analyze(
          f.source,
          (x) => {
            done[i] = scanShare + x * (1 - scanShare);
            report();
          },
          opts.signal,
        );
      } catch (e) {
        if (opts.signal?.aborted || isAbortError(e)) throw e;
      }
    }
    done[i] = 1;
    report();
    return m;
  });
  report(true);
  return out;
}

/** The measured MP3s that took part in the loudness measurement. */
function measuredLoudness(measured: readonly Measured[]): { lufs: number; analyses: AudioAnalysis[] } | undefined {
  const analyses = measured.flatMap((m) => (m.index && m.analysis && m.analysis.power.length ? [m.analysis] : []));
  if (!analyses.length) return undefined;
  const lufs = albumLoudness(analyses);
  return Number.isFinite(lufs) ? { lufs, analyses } : undefined;
}

/** Bitrate of a file converted for its loudness: the app's setting, but never below what the file had. */
function keptBitrate(index: Mp3Index, bitrateKbps: number): number {
  return Math.min(MAX_KEPT_KBPS, Math.max(bitrateKbps, Math.round(index.avgBitrateKbps)));
}

function sizes(measured: readonly Measured[], actions: readonly FileAction[], after: (m: Measured, a: FileAction) => number): { bytesBefore: number; bytesAfter: number } {
  let bytesBefore = 0;
  let bytesAfter = 0;
  measured.forEach((m, i) => {
    const a = actions[i];
    if (a.kind === 'keep') return;
    bytesBefore += m.source.size;
    bytesAfter += after(m, a);
  });
  return { bytesBefore, bytesAfter };
}

/**
 * "Lautstärke anpassen": the folder's change towards TARGET_LUFS, as when
 * adding an album, or towards its own level with `offsetDb` (levelTarget).
 * `bitrateKbps`: the app's setting, for files that are converted (a quiet
 * folder with boostQuietMp3).
 */
export function planLevel(measured: readonly Measured[], opts: { boostQuietMp3: boolean; bitrateKbps: number; offsetDb?: number }): FolderPlan {
  const offsetDb = opts.offsetDb ?? 0;
  const keepAll = (extra: Partial<FolderPlan> = {}): FolderPlan => ({
    job: 'level',
    actions: measured.map((m) => ({ kind: 'keep', ...(m.index ? {} : { reason: 'not-mp3' as const }) })),
    bytesBefore: 0,
    bytesAfter: 0,
    offsetDb,
    ...extra,
  });
  const loud = measuredLoudness(measured);
  if (!loud) return keepAll();
  const { targetLufs, ceilingDb } = levelTarget(offsetDb);
  if (Math.abs(targetLufs - loud.lufs) < LEVEL_TOLERANCE_DB) return keepAll({ lufs: loud.lufs, already: true });
  const gain = planAlbumGain({ lufs: loud.lufs, mp3Peaks: measured.filter((m) => m.index && m.analysis).map((m) => m.analysis!.peak), boostQuietMp3: opts.boostQuietMp3, targetLufs, ceilingDb });
  const actions = measured.map((m): FileAction => {
    if (!m.index) return { kind: 'keep', reason: 'not-mp3' };
    if (gain.boosted) return { kind: 'convert', gainDb: gain.convertDb, bitrateKbps: keptBitrate(m.index, opts.bitrateKbps), mono: m.index.channels === 1 };
    return gain.steps ? { kind: 'gain', steps: gain.steps } : { kind: 'keep' };
  });
  const bytes = sizes(measured, actions, (m, a) => (a.kind === 'convert' ? convertedSize(m.index!.durationSec, a, m.index!.channels) + m.index!.tags.audioStart : m.source.size));
  return { job: 'level', actions, lufs: loud.lufs, gain, offsetDb, ...bytes };
}

/**
 * "Kleiner machen": the MP3s that get smaller in `target` are converted;
 * with `level`, the folder also gets its loudness on the way (the files that
 * stay get the matching lossless steps, see planAlbumGain), with its
 * offset when it was made quieter or louder on purpose.
 */
export function planShrink(measured: readonly Measured[], target: ShrinkTarget, opts: { level: boolean; offsetDb?: number }): FolderPlan {
  const offsetDb = opts.level ? (opts.offsetDb ?? 0) : 0;
  const { targetLufs, ceilingDb } = levelTarget(offsetDb);
  const converts = measured.map((m) => !!m.index && worthShrinking(m.index, target));
  let gain: AlbumGain | undefined;
  let lufs: number | undefined;
  const loud = opts.level ? measuredLoudness(measured) : undefined;
  if (loud) {
    lufs = loud.lufs;
    if (Math.abs(targetLufs - loud.lufs) >= LEVEL_TOLERANCE_DB) {
      // The files that stay MP3 limit the change, as when adding: the converted ones match them.
      const peaks = measured.filter((m, i) => m.index && !converts[i] && m.analysis).map((m) => m.analysis!.peak);
      gain = planAlbumGain({ lufs: loud.lufs, mp3Peaks: peaks, boostQuietMp3: false, targetLufs, ceilingDb });
    }
  }
  const actions = measured.map((m, i): FileAction => {
    if (!m.index) return { kind: 'keep', reason: 'not-mp3' };
    if (converts[i]) return { kind: 'convert', gainDb: gain?.convertDb ?? 0, mono: target.mono, bitrateKbps: target.bitrateKbps };
    return gain?.steps ? { kind: 'gain', steps: gain.steps } : { kind: 'keep', reason: 'small' };
  });
  const bytes = sizes(measured, actions, (m, a) => (a.kind === 'convert' ? convertedSize(m.index!.durationSec, target, m.index!.channels) : m.source.size));
  return { job: 'shrink', actions, ...(lufs !== undefined ? { lufs } : {}), ...(gain ? { gain } : {}), already: opts.level && !!loud && !gain, offsetDb, ...bytes };
}

/** The tags a converted file gets: what the old one said in words (no pictures), without a spoken title's note (its frames change). */
function wordTags(tags: BasicTags): SmallTags {
  const rest: SmallTags = { ...tags };
  delete rest.announcement;
  return rest;
}

/**
 * The new file for one action. Converted for the loudness alone, the file
 * keeps its tags as they were (pictures too); converted to be smaller, it
 * gets a small tag with the words of the old one.
 */
export async function produceFile(m: Measured, action: Exclude<FileAction, { kind: 'keep' }>, opts: { job: SoundJob; audio: AudioBackend; signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<Blob> {
  const index = m.index;
  if (!index) throw new Error(`„${m.file}“ ist keine MP3-Datei.`);
  if (action.kind === 'gain') return applyGain(m.source, index, action.steps, { signal: opts.signal, onProgress: opts.onProgress });
  const enc = { bitrateKbps: action.bitrateKbps, mono: action.mono, gainDb: action.gainDb, signal: opts.signal, onProgress: opts.onProgress };
  if (opts.job === 'shrink') {
    const tags = await readTags(m.source)
      .then((r) => wordTags(r.tags))
      .catch(() => undefined);
    return convertToMp3(opts.audio, m.source, { ...enc, tags });
  }
  const lead = index.tags.audioStart > 0 ? await blobOfRange(m.source, 0, index.tags.audioStart, opts.signal) : undefined;
  const mp3 = await convertToMp3(opts.audio, m.source, enc);
  return lead ? new Blob([lead, mp3], { type: 'audio/mpeg' }) : mp3;
}

/** Longest difference in playing time a converted file may have (resampling, encoder padding). */
function lengthTolerance(sec: number): number {
  return Math.max(0.5, sec * 0.01);
}

/**
 * Looks at a new file before it may replace the old one: readable MP3
 * frames, and as long as before (the same frames after a lossless change).
 * Returns why it must not go to the card, or the new file's frames.
 */
export async function checkNewFile(m: Measured, action: Exclude<FileAction, { kind: 'keep' }>, blob: Blob, signal?: AbortSignal): Promise<{ ok: true; index: Mp3Index } | { ok: false; reason: string }> {
  const old = m.index!;
  let index: Mp3Index;
  try {
    index = await scanMp3(fileSource(blob, m.file), { signal });
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) throw e;
    return { ok: false, reason: 'Die neue Datei ließ sich nicht lesen.' };
  }
  if (index.layer !== 3 || index.frameCount === 0) return { ok: false, reason: 'Die neue Datei ließ sich nicht lesen.' };
  if (action.kind === 'gain') {
    if (index.frameCount !== old.frameCount || blob.size !== m.source.size) return { ok: false, reason: 'Die neue Datei ist anders aufgebaut als die alte.' };
    return { ok: true, index };
  }
  // The decoder's length counts: a damaged old file may claim more frames than it plays.
  const before = m.analysis?.durationSec ?? old.durationSec;
  if (Math.abs(index.durationSec - before) > lengthTolerance(before)) return { ok: false, reason: 'Die neue Datei ist anders lang als die alte.' };
  return { ok: true, index };
}

/** Bytes compared at the start and the end when a written file is read back. */
const READ_BACK_BYTES = 64 * 1024;

/** The size and the first and last bytes of a new file, to compare it with what is on the card after writing. */
export interface FileEdges {
  size: number;
  parts: { start: number; bytes: Uint8Array }[];
}

/**
 * The edges of a new file, read before it is written: its tags are slices of
 * the old file (blobOfRange), which a browser cannot read any more once
 * that file has been written over (Chrome: NotReadableError).
 */
export async function fileEdges(blob: Blob): Promise<FileEdges> {
  const n = Math.min(READ_BACK_BYTES, blob.size);
  const parts = await Promise.all([...new Set([0, blob.size - n])].map(async (start) => ({ start, bytes: new Uint8Array(await blob.slice(start, start + n).arrayBuffer()) })));
  return { size: blob.size, parts };
}

/** Whether the file on the card is the one just written: its size, and its first and last bytes. */
export async function sameOnCard(dir: Dir, file: string, expected: Blob | FileEdges): Promise<boolean> {
  const want = expected instanceof Blob ? await fileEdges(expected) : expected;
  const src = await dir.source(file);
  if (src.size !== want.size) return false;
  for (const { start, bytes } of want.parts) {
    const card = await src.read(start, bytes.length);
    if (card.length !== bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) if (card[i] !== bytes[i]) return false;
  }
  return true;
}

/** A file that stays as it was, and why. */
export interface LeftAlone {
  file: string;
  reason: string;
}

export interface FolderRun {
  /** Files with their new contents on the card. */
  written: { file: string; oldSize: number; size: number; durationSec: number }[];
  /** Files whose new version did not pass the check: the old one stays. */
  left: LeftAlone[];
}

/**
 * Makes, checks and writes the new files one after the other. A new file
 * that fails its check leaves the old one in place; a file that is not the
 * same once read back from the card stops the run (the card misbehaves).
 * `onFile(done, total, fraction)` reports the progress. Stopping keeps what
 * is written; the result says what (also in `into` when the run throws).
 */
export async function runFolderPlan(
  dir: Dir,
  measured: readonly Measured[],
  plan: FolderPlan,
  opts: { audio: AudioBackend; signal: AbortSignal; onFile?: (done: number, total: number, fraction: number) => void; into?: FolderRun },
): Promise<FolderRun> {
  const run: FolderRun = opts.into ?? { written: [], left: [] };
  const todo = measured.flatMap((m, i) => {
    const a = plan.actions[i];
    return a.kind === 'keep' ? [] : [{ m, a }];
  });
  for (const [n, { m, a }] of todo.entries()) {
    if (opts.signal.aborted) break;
    opts.onFile?.(n, todo.length, 0);
    let blob: Blob;
    try {
      blob = await produceFile(m, a, { job: plan.job, audio: opts.audio, signal: opts.signal, onProgress: (f) => opts.onFile?.(n, todo.length, f) });
    } catch (e) {
      if (opts.signal.aborted || isAbortError(e)) break;
      run.left.push({ file: m.file, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const check = await checkNewFile(m, a, blob, opts.signal);
    if (!check.ok) {
      run.left.push({ file: m.file, reason: check.reason });
      continue;
    }
    // Made to be smaller but it is not: the old one stays.
    if (plan.job === 'shrink' && a.kind === 'convert' && blob.size >= m.source.size) {
      run.left.push({ file: m.file, reason: 'Kleiner wurde sie nicht.' });
      continue;
    }
    if (opts.signal.aborted) break;
    const edges = await fileEdges(blob);
    await dir.write(m.file, blob);
    if (!(await sameOnCard(dir, m.file, edges))) {
      throw new Error(`„${m.file}“ steht nach dem Schreiben nicht richtig auf der SD-Karte. Prüfe die Karte am Computer und lies sie neu ein.`);
    }
    run.written.push({ file: m.file, oldSize: m.source.size, size: blob.size, durationSec: check.index.durationSec });
  }
  opts.onFile?.(todo.length, todo.length, 1);
  return run;
}
