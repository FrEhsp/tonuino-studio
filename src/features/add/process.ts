/**
 * Turns an album draft into the files for the SD card.
 *
 * - MP3 files are copied. With "same loudness" every frame's gain changes
 *   losslessly by the same steps for the whole album; with "remove tags",
 *   pictures and big tags make way for a small text tag.
 * - MP3 files that are damaged or joined from several files are converted
 *   anew (the box's MP3 player stumbles over them), and so are the MP3s of a
 *   quiet album that whole steps cannot bring to its level (boostQuietMp3).
 * - Other formats are converted to MP3, at the album's loudness.
 * - Long files are cut at chapters or at speech pauses near the wanted
 *   length: MP3 losslessly, everything else while converting. A whole
 *   album in one file is cut where its tracks begin (albumCuts).
 *
 * The heavy work happens when the session asks for a file, in the order it
 * writes them. Conversions of the next files run ahead while one is written,
 * and the parts of a long file are handed over as soon as they exist.
 *
 * A transfer that stopped can go on where it stopped: the parts already on
 * the card are left out, and the album keeps the loudness change it had.
 *
 * With the extra "Titelansagen" every file gets its spoken title in front
 * once it is made (`announce`), except files whose publisher allows no
 * changes or that came with a licence from "Entdecken".
 */
import { deferred, mapLimit, throttle, type Deferred } from '../../core/async';
import {
  albumLoudness,
  applyGain,
  AudioError,
  blobOfRange,
  buildSmallId3,
  checkMp3,
  convertToMp3,
  convertToMp3Parts,
  cutMp3Parts,
  cutsFromChapters,
  decodedTooShort,
  effectiveBitrate,
  findPauses,
  isAbortError,
  isClipped,
  levelTarget,
  MP3_SAMPLE_RATE,
  planAlbumGain,
  planSplits,
  rebuildReason,
  replaceTags,
  scanMp3,
  snapCuts,
  type AlbumGain,
  type ChapterMark,
  type Mp3Index,
  type Mp3Rebuild,
  type SmallTags,
  type SplitPlan,
} from '../../core/audio';
import type { AlbumDraft, DraftTrack } from '../../core/library/grouping';
import type { ContentKind } from '../../core/tonuino/catalog';
import { hasAlbumCuts, isLongTrack, isPlayableAsIs, SPLIT_TOLERANCE } from '../../core/library/grouping';
import type { Change } from '../../core/sources/licence';
import { changesFor, UNCHANGED_NOT_MP3, type TrackOrigin } from '../../core/sources/origin';
import type { AudioAnalysis, AudioBackend, ByteSource } from '../../platform/types';

export { TARGET_LUFS, MAX_BOOST_DB, type AlbumGain } from '../../core/audio';

/** Why a file is left out when it cannot be read as MP3 nor decoded (as on reading it). */
export const UNREADABLE = 'Lässt sich nicht lesen. Ist die Datei beschädigt?';

/** What happens to a file besides copying, for the progress text. */
export type TrackWork = 'copy' | 'adjust' | 'convert' | 'cut';

/** One file that ends up on the card. */
export interface TrackJob {
  /** The file it comes from; the parts of a long file share it. */
  track: DraftTrack;
  /** Its source (the track's). */
  source: ByteSource;
  /** Its place among the parts of that file (0 when the file is not cut), and how many parts there are. */
  part: number;
  parts: number;
  title: string;
  durationSec?: number;
  /** Rough size on the card, for the progress bar and the space check. */
  estimateBytes: number;
  work: TrackWork;
  /** Produces the MP3 bytes. `onFraction` reports 0..1 of the work for this file. */
  produce(onFraction: (f: number) => void, signal: AbortSignal): Promise<Blob>;
  /** Work done for this file so far, 0..1. Conversions run ahead of the writing, so it can grow before produce() is called. */
  worked(): number;
  /** Source and licence of a file from "Entdecken"; the parts of a cut file share it. */
  origin?: TrackOrigin;
  /** What the app changes in the file, for the credit. Final once produce() resolved. */
  changes: Change[];
}

export interface PreparedAlbum {
  /** In the order they go to the card. */
  jobs: TrackJob[];
  /** The loudness change the jobs apply (to go on with it later). */
  gain: AlbumGain;
  /** The change in dB the album got from measuring it now (with „Gleiche Lautstärke“); undefined when it was not measured. */
  levelDb?: number;
  /** Files that were clipped before they came here (isClipped): they crackle anyway. */
  clipped?: DraftTrack[];
  /** Long files left out because they could not be read: cutting them needs a look at the whole file first. */
  skipped: FileError[];
  /** MP3 files that are converted anew because they are damaged or joined from several files. */
  rebuilt: { track: DraftTrack; reason: Mp3Rebuild }[];
  /** Stops work that runs ahead and lets go of what it holds. Call it when the album is written or has failed. */
  close(): void;
}

export interface ProcessOptions {
  audio: AudioBackend;
  normalizeLoudness: boolean;
  stripTags: boolean;
  bitrateKbps: number;
  signal: AbortSignal;
  /** Long preparation (finding pauses, measuring loudness): 0..1. */
  onPrepare?: (label: string, fraction: number) => void;
  /** Shortest part when cutting (default 60 s). */
  minPartSec?: number;
  /** Conversions running at the same time (default: processor cores - 1, 1 to 4). */
  parallel?: number;
  /** Going on with a transfer that stopped: leading parts of a file that are on the card already. */
  skipParts?: ReadonlyMap<ByteSource, number>;
  /** The loudness change the album had in that transfer (measured again when missing). */
  gain?: AlbumGain;
  /** Converts the MP3s of a quiet album that whole gain steps leave too quiet (see planAlbumGain). */
  boostQuietMp3?: boolean;
  /** Tracks added to a folder made quieter or louder on purpose get its level (CatalogFolder.levelOffsetDb, levelTarget). */
  levelOffsetDb?: number;
  /** A file measured already in the review (a whole album whose cuts were looked at): not decoded again. */
  analysisOf?: (source: ByteSource) => AudioAnalysis | undefined;
  /** Hörspiele and Hörbücher that are converted become mono at half the bitrate (see conversionFor). */
  monoSpeech?: boolean;
  /** More tags for a file whose tags are written (credit and licence), given what the app changes in it. */
  tagsFor?: (track: DraftTrack, changes: Change[]) => Partial<SmallTags> | undefined;
  /**
   * The extra "Titelansagen": the finished MP3 of a file with its title
   * spoken in front, and how many seconds that added.
   */
  announce?: (title: string, mp3: Blob, signal: AbortSignal) => Promise<{ blob: Blob; addedSec: number }>;
  /** A title that could not be announced: the file goes to the card without. */
  onAnnounceFailed?: (job: TrackJob, error: unknown) => void;
}

/** How converted files are encoded. */
export interface Conversion {
  bitrateKbps: number;
  mono: boolean;
}

/**
 * The extra "Hörspiele in Mono speichern": spoken albums are converted to
 * mono at half the bitrate (raised to 64 kbit/s, see effectiveBitrate), so
 * they take half the room. Music stays as set.
 */
export function conversionFor(kind: ContentKind, bitrateKbps: number, monoSpeech: boolean | undefined): Conversion {
  if (!monoSpeech || (kind !== 'hoerspiel' && kind !== 'hoerbuch')) return { bitrateKbps, mono: false };
  return { bitrateKbps: Math.round(bitrateKbps / 2), mono: true };
}

/** Size of the MP3 the converter makes. */
function convertedBytes(durationSec: number, conv: Conversion, channels: number | undefined): number {
  return Math.round((durationSec * effectiveBitrate(conv.bitrateKbps, channels === 1 || conv.mono ? 1 : 2) * 1000) / 8);
}

/** Goes to the card as the MP3 it is (maybe with other tags or loudness): not damaged, not joined. */
function copiedAsMp3(t: DraftTrack, album: Pick<AlbumDraft, 'unchanged'>): boolean {
  return isPlayableAsIs(t) && (!!album.unchanged || !t.info?.mp3Check?.rebuild);
}

/** Size estimate for the space check before anything is written. */
export function estimateAlbumBytes(album: AlbumDraft, bitrateKbps: number, monoSpeech?: boolean): number {
  const conv = conversionFor(album.kind, bitrateKbps, monoSpeech);
  let sum = 0;
  for (const t of album.tracks) {
    if (copiedAsMp3(t, album) || !t.info?.durationSec) sum += t.source.size;
    else sum += convertedBytes(t.info.durationSec, conv, t.info.channels);
  }
  return Math.round(sum);
}

/** Work that has to happen besides copying, in words for the review screen. */
export function albumWork(album: AlbumDraft): { convert: number; split: boolean } {
  return { convert: album.tracks.filter((t) => !copiedAsMp3(t, album)).length, split: album.tracks.some((t) => splitOf(album, t) !== 'none') };
}

/* ------------------------------------------------------------------ plan */

type Split = 'none' | 'chapters' | 'pauses' | 'tracks';

interface Item {
  track: DraftTrack;
  /** Goes to the card as MP3 without converting. */
  mp3: boolean;
  split: Split;
  analysis?: AudioAnalysis;
  /** Frames of an MP3 that is cut. */
  index?: Mp3Index;
  /** An MP3 that is converted anew because it is damaged or joined from several files. */
  rebuild?: Mp3Rebuild;
  /** Why the file is left out. */
  failed?: FileError;
}

interface Context {
  album: AlbumDraft;
  opts: ProcessOptions;
  signal: AbortSignal;
  parallel: number;
  /** Lossless gain for the MP3 files, in global_gain steps. */
  steps: number;
  /** Gain for converted files, in dB. */
  convertDb: number;
  /** Bitrate and channels of converted files. */
  conv: Conversion;
  /** Run by close(). */
  cleanups: (() => void)[];
}

function defaultParallel(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, cores - 1));
}

function splitOf(album: Pick<AlbumDraft, 'split'>, t: DraftTrack): Split {
  if (album.split === 'tracks' && hasAlbumCuts(t)) return 'tracks';
  if (album.split === 'none' || !isLongTrack(t)) return 'none';
  if (album.split === 'chapters' && (t.info?.chapters?.length ?? 0) > 1) return 'chapters';
  return 'pauses';
}

/** Turns an album draft into the files for the card. */
export async function prepareAlbum(album: AlbumDraft, opts: ProcessOptions): Promise<PreparedAlbum> {
  if (album.unchanged) {
    // The publisher allows no changes: every file goes to the card exactly as it came.
    const other = album.tracks.find((t) => !isPlayableAsIs(t));
    if (other) throw new Error(`„${other.source.name}“: ${UNCHANGED_NOT_MP3}`);
    album = { ...album, split: 'none' };
    opts = { ...opts, normalizeLoudness: false, stripTags: false };
  }
  const ctl = new AbortController();
  const stop = () => ctl.abort(opts.signal.reason);
  if (opts.signal.aborted) stop();
  else opts.signal.addEventListener('abort', stop, { once: true });
  const cleanups: (() => void)[] = [];
  const close = () => {
    opts.signal.removeEventListener('abort', stop);
    if (!ctl.signal.aborted) ctl.abort(new DOMException('Abgebrochen.', 'AbortError'));
    for (const c of cleanups.splice(0)) c();
  };
  const ctx: Context = { album, opts, signal: ctl.signal, parallel: Math.max(1, opts.parallel ?? defaultParallel()), steps: 0, convertDb: 0, conv: conversionFor(album.kind, opts.bitrateKbps, opts.monoSpeech), cleanups };
  try {
    const items: Item[] = album.tracks.map((track) => {
      // Found while reading the files; a publisher that allows no changes gets them as they are.
      const rebuild = album.unchanged || !isPlayableAsIs(track) ? undefined : track.info?.mp3Check?.rebuild;
      return { track, mp3: isPlayableAsIs(track) && !rebuild, split: splitOf(album, track), rebuild };
    });
    await analyze(items, ctx);
    await scanForCutting(items, ctx);
    if (!album.unchanged) await checkFiles(items, ctx);
    const planned = opts.gain ? undefined : albumGain(items, ctx);
    const gain = opts.gain ?? planned?.gain ?? { steps: 0, convertDb: 0 };
    ctx.steps = gain.steps;
    ctx.convertDb = gain.convertDb;
    // A quiet album: its MP3s are converted too, with the album's whole change (also when going on with a transfer).
    if (gain.boosted) {
      for (const it of items) {
        if (!it.mp3) continue;
        it.mp3 = false;
        it.index = undefined;
      }
    }
    const jobs = buildJobs(items, ctx);
    const announce = opts.announce;
    if (announce && !album.unchanged) for (const job of jobs) if (!job.origin) withAnnouncement(job, announce, opts.onAnnounceFailed);
    return {
      jobs,
      gain,
      ...(planned?.measured ? { levelDb: gain.convertDb } : {}),
      clipped: items.flatMap((it) => (!it.failed && it.analysis && isClipped(it.analysis) ? [it.track] : [])),
      skipped: items.flatMap((it) => (it.failed ? [it.failed] : [])),
      rebuilt: items.flatMap((it) => (it.rebuild && !it.failed ? [{ track: it.track, reason: it.rebuild }] : [])),
      close,
    };
  } catch (e) {
    close();
    throw e;
  }
}

/** Measures the files that are cut or brought to the album's loudness. */
async function analyze(items: Item[], ctx: Context): Promise<void> {
  const { opts, signal } = ctx;
  // A loudness change from before needs no measuring; cutting still needs the analysis.
  const todo = items.filter((it) => (opts.normalizeLoudness && !opts.gain) || it.split !== 'none');
  if (!todo.length) return;
  const label = todo.some((it) => it.split === 'pauses')
    ? 'Sucht Sprechpausen'
    : opts.normalizeLoudness
      ? 'Misst die Lautstärke'
      : todo.some((it) => it.split === 'chapters')
        ? 'Liest die Kapitel'
        : 'Bereitet das Teilen vor';
  const weights = todo.map((it) => Math.max(1, it.track.info?.durationSec ?? it.track.source.size / 16_000));
  const total = weights.reduce((a, b) => a + b, 0);
  const done = todo.map(() => 0);
  const report = throttle(() => opts.onPrepare?.(label, done.reduce((sum, f, i) => sum + f * weights[i], 0) / total), 100);
  report(true);
  await mapLimit(todo, 3, async (it, i) => {
    const measured = opts.analysisOf?.(it.track.source);
    if (measured) {
      it.analysis = measured;
      done[i] = 1;
      report();
      return;
    }
    try {
      it.analysis = await opts.audio.analyze(
        it.track.source,
        (f) => {
          done[i] = f;
          report();
        },
        signal,
      );
    } catch (e) {
      if (signal.aborted || isAbortError(e)) throw e;
      // Cutting needs the analysis: without it the file is left out. For the loudness alone it is just not measured.
      if (it.split !== 'none') it.failed = failure(it, e);
    }
    done[i] = 1;
    report();
  });
  report(true);
}

/** Frame index of every MP3 that is cut; MP3s that cannot be cut frame by frame are converted instead. */
async function scanForCutting(items: Item[], ctx: Context): Promise<void> {
  const todo = items.filter((it) => it.mp3 && it.split !== 'none' && !it.failed);
  for (const [n, it] of todo.entries()) {
    try {
      const { check, index } = await checkMp3(it.track.source, { signal: ctx.signal, onProgress: (f) => ctx.opts.onPrepare?.('Bereitet das Teilen vor', (n + f) / todo.length) });
      if (index?.layer === 3) {
        it.index = index;
      } else {
        // MP2, a rare variant, a joined file in two formats or no MP3 at all: the converter can still read it.
        it.mp3 = false;
        if (!ctx.album.unchanged) it.rebuild = check.rebuild;
      }
    } catch (e) {
      if (ctx.signal.aborted || isAbortError(e)) throw e;
      if (!(e instanceof AudioError) || e.code === 'read-failed') it.failed = new FileError(it.track, e);
      else it.mp3 = false;
    }
  }
}

/**
 * Looks at every frame of the MP3s that would be copied: damaged files and
 * files joined from several files are converted anew. Most files were
 * looked at when they were read; for those the decoder's playing time is
 * compared with their frames. The others are read once more here.
 */
async function checkFiles(items: Item[], ctx: Context): Promise<void> {
  const rebuild = (it: Item, reason: Mp3Rebuild | undefined) => {
    if (!reason) return;
    it.rebuild = reason;
    it.mp3 = false;
    it.index = undefined;
  };
  const todo: Item[] = [];
  for (const it of items) {
    if (!it.mp3 || it.failed) continue;
    const check = it.track.info?.mp3Check;
    const decodedSec = it.analysis?.durationSec ?? 0;
    if (it.index) rebuild(it, rebuildReason(it.index, it.analysis));
    else if (check) rebuild(it, check.durationSec && decodedSec > 0 && decodedTooShort(check.durationSec, decodedSec) ? 'damaged' : undefined);
    else todo.push(it);
  }
  if (!todo.length) return;
  const sizes = todo.map((it) => Math.max(1, it.track.source.size));
  const total = sizes.reduce((a, b) => a + b, 0);
  let before = 0;
  let current = 0;
  const report = throttle(() => ctx.opts.onPrepare?.('Prüft die Dateien', (before + current) / total), 100);
  report(true);
  for (const [n, it] of todo.entries()) {
    try {
      const { check, index } = await checkMp3(it.track.source, {
        signal: ctx.signal,
        onProgress: (f) => {
          current = f * sizes[n];
          report();
        },
      });
      rebuild(it, index ? rebuildReason(index, it.analysis) : check.rebuild);
    } catch (e) {
      if (ctx.signal.aborted || isAbortError(e)) throw e;
      // Not readable at all: left out with the reason. A rare variant goes on as before (copied).
      if (!(e instanceof AudioError) || e.code === 'read-failed') it.failed = new FileError(it.track, e);
    }
    before += sizes[n];
    current = 0;
  }
  report(true);
}

/**
 * The album's loudness change (see planAlbumGain), from the analyses. MP3s
 * that are converted anew count like other converted files: the
 * converter's limiter keeps their peaks in check.
 */
function albumGain(items: Item[], ctx: Context): { gain: AlbumGain; measured: boolean } {
  const none = { gain: { steps: 0, convertDb: 0 }, measured: false };
  if (!ctx.opts.normalizeLoudness) return none;
  const measured = items.map((it) => it.analysis).filter((a): a is AudioAnalysis => !!a && a.power.length > 0);
  if (!measured.length) return none;
  const lufs = albumLoudness(measured);
  if (!Number.isFinite(lufs)) return none;
  const mp3Peaks = items.filter((it) => it.mp3 && !it.failed).map((it) => it.analysis?.peak);
  return { gain: planAlbumGain({ lufs, mp3Peaks, boostQuietMp3: ctx.opts.boostQuietMp3, ...levelTarget(ctx.opts.levelOffsetDb) }), measured: true };
}

/* ------------------------------------------------------------------ jobs */

function buildJobs(items: Item[], ctx: Context): TrackJob[] {
  const ahead = new RunAhead(ctx.parallel);
  const jobs: TrackJob[] = [];
  for (const it of items) {
    if (it.failed) continue;
    // Parts on the card already (going on with a transfer that stopped).
    const skip = ctx.opts.skipParts?.get(it.track.source) ?? 0;
    const plan = it.split !== 'none' && it.analysis ? splitPlan(it, ctx) : undefined;
    if (plan && plan.cuts.length) jobs.push(...partJobs(it, plan, ctx, skip));
    else if (!skip) jobs.push(singleJob(it, ctx, ahead));
  }
  return jobs;
}

function chaptersOf(it: Item): ChapterMark[] {
  const marks = it.analysis?.chapters?.length ? it.analysis.chapters : (it.track.info?.chapters ?? []);
  return [...marks].sort((a, b) => a.startSec - b.startSec);
}

function splitPlan(it: Item, ctx: Context): SplitPlan {
  const a = it.analysis as AudioAnalysis;
  const minPartSec = ctx.opts.minPartSec ?? 60;
  if (it.split === 'tracks') {
    // The cuts were chosen in the review (pauses found, maybe moved by hand): taken as they are.
    const starts = (it.track.albumCuts?.tracks ?? []).map((t) => t.startSec).filter((t) => t > 0 && t < a.durationSec);
    const cuts = starts.map((timeSec) => ({ timeSec, kind: 'chapter' as const, confidence: 1 }));
    return { cuts, parts: [0, ...starts].map((startSec, i) => ({ startSec, endSec: starts[i] ?? a.durationSec })) };
  }
  const chapters = chaptersOf(it);
  if (it.split === 'chapters' && chapters.length > 1) return cutsFromChapters(chapters, a.durationSec, { minPartSec });
  return planSplits({
    durationSec: a.durationSec,
    pauses: findPauses(a.power, a.windowSec),
    targetSec: ctx.album.splitMinutes * 60,
    toleranceRatio: SPLIT_TOLERANCE,
    minPartSec,
    power: a.power,
    windowSec: a.windowSec,
    chapters,
  });
}

function smallTags(ctx: Context, title: string, track: DraftTrack, changes: Change[]): SmallTags {
  const tags: SmallTags = { title, artist: ctx.album.artist?.trim() || undefined, album: ctx.album.title.trim() || undefined };
  const extra = ctx.opts.tagsFor?.(track, changes);
  return extra ? { ...tags, ...extra } : tags;
}

/** The job's origin, only when the track has one. */
function originOf(t: DraftTrack): { origin?: TrackOrigin } {
  return t.origin ? { origin: t.origin } : {};
}

async function wholeFile(src: ByteSource, signal: AbortSignal): Promise<Blob> {
  return src.blob ?? (await blobOfRange(src, 0, src.size, signal));
}

/**
 * A file that cannot be read or converted. Its path as picked comes in front
 * of the message, so people know which file it was even when every album has
 * a "01.flac".
 */
export class FileError extends Error {
  readonly track: DraftTrack;
  /** The file's path as picked, e.g. "Sammlung/CD 2/01.flac". */
  readonly file: string;
  readonly reason: string;

  constructor(track: DraftTrack, cause: unknown) {
    const file = track.source.relativePath ?? track.source.name;
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`„${file}“: ${reason}`, { cause });
    this.name = 'FileError';
    this.track = track;
    this.file = file;
    this.reason = reason;
  }
}

function fileError(t: DraftTrack, e: unknown): unknown {
  if (isAbortError(e) || e instanceof FileError) return e;
  return new FileError(t, e);
}

/** The same for a file that is converted: a damaged MP3 that the converter cannot read either gets the words used when reading files. */
function convertError(it: Item, e: unknown): unknown {
  if (it.rebuild && e instanceof AudioError && e.code !== 'read-failed') return new FileError(it.track, new Error(UNREADABLE, { cause: e }));
  return fileError(it.track, e);
}

/** The same while measuring a file that is cut. */
function failure(it: Item, e: unknown): FileError {
  const err = convertError(it, e);
  return err instanceof FileError ? err : new FileError(it.track, e);
}

/** A job whose work only happens while it is produced. */
function onDemand(
  t: DraftTrack,
  fields: Omit<TrackJob, 'produce' | 'worked' | 'track' | 'source' | 'part' | 'parts'>,
  run: (onFraction: (f: number) => void) => Promise<Blob>,
): TrackJob {
  let worked = 0;
  return {
    ...fields,
    track: t,
    source: t.source,
    part: 0,
    parts: 1,
    ...originOf(t),
    worked: () => worked,
    produce: async (onFraction) => {
      try {
        const blob = await run((f) => {
          worked = f;
          onFraction(f);
        });
        worked = 1;
        return blob;
      } catch (e) {
        throw fileError(t, e);
      }
    },
  };
}

function singleJob(it: Item, ctx: Context, ahead: RunAhead): TrackJob {
  const t = it.track;
  const src = t.source;
  const title = t.title;
  const durationSec = it.analysis?.durationSec ?? t.info?.durationSec;
  const strip = ctx.opts.stripTags;
  if (it.mp3) {
    const copied = changesFor('copy', { tagsWritten: strip, gainApplied: false });
    const copy = () => (strip ? replaceTags(src, buildSmallId3(smallTags(ctx, title, t, copied))) : wholeFile(src, ctx.signal));
    if (!ctx.steps) return onDemand(t, { title, durationSec, estimateBytes: src.size, work: 'copy', changes: copied }, copy);
    const steps = ctx.steps;
    const adjusted = changesFor('adjust', { tagsWritten: strip, gainApplied: true });
    const job = onDemand(t, { title, durationSec, estimateBytes: src.size, work: 'adjust', changes: adjusted }, async (onFraction) => {
      try {
        const index = await scanMp3(src, { signal: ctx.signal });
        return await applyGain(src, index, steps, { tag: strip ? buildSmallId3(smallTags(ctx, title, t, adjusted)) : undefined, signal: ctx.signal, onProgress: onFraction });
      } catch (e) {
        if (ctx.signal.aborted || isAbortError(e)) throw e;
        // MP2 or a rare MP3 variant: the box gets it unchanged.
        if (e instanceof AudioError && e.code !== 'read-failed') {
          job.changes = copied;
          return copy();
        }
        throw e;
      }
    });
    return job;
  }
  const converted = changesFor('convert', { tagsWritten: true, gainApplied: ctx.convertDb !== 0 });
  const tags = smallTags(ctx, title, t, converted);
  const task = ahead.add((onProgress) =>
    convertToMp3(ctx.opts.audio, src, { ...ctx.conv, gainDb: ctx.convertDb, tags, signal: ctx.signal, onProgress }),
  );
  return {
    track: t,
    source: src,
    part: 0,
    parts: 1,
    title,
    durationSec,
    estimateBytes: durationSec ? convertedBytes(durationSec, ctx.conv, it.analysis?.channels ?? t.info?.channels) : src.size,
    work: 'convert',
    ...originOf(t),
    changes: converted,
    worked: task.worked,
    produce: (onFraction) => task.take(onFraction).catch((e: unknown) => Promise.reject(convertError(it, e))),
  };
}

/** Share of a file's work bar for speaking its title. */
const ANNOUNCE_SHARE = 0.1;

/**
 * Puts the spoken title in front of what `job` produces. A title that
 * cannot be announced (no voice, an odd MP3) leaves the file as it is: it
 * still goes to the card.
 */
function withAnnouncement(job: TrackJob, announce: NonNullable<ProcessOptions['announce']>, failed: ProcessOptions['onAnnounceFailed']): void {
  const produce = job.produce;
  job.produce = async (onFraction, signal) => {
    const blob = await produce((f) => onFraction(f * (1 - ANNOUNCE_SHARE)), signal);
    try {
      const r = await announce(job.title, blob, signal);
      if (job.durationSec !== undefined) job.durationSec += r.addedSec;
      onFraction(1);
      return r.blob;
    } catch (e) {
      if (signal.aborted || isAbortError(e)) throw e;
      failed?.(job, e);
      return blob;
    }
  };
}

/** Titles of the parts: the album track's or the chapter's own name, else "Title – Teil n". */
function partTitles(it: Item, starts: readonly number[]): string[] {
  if (it.split === 'tracks') {
    // Cut times move a little (to MP3 frames, whole samples): the track that begins closest.
    const tracks = it.track.albumCuts?.tracks ?? [];
    return starts.map((s, i) => tracks.find((t) => Math.abs(t.startSec - s) < 0.5)?.title.trim() || `${it.track.title} – Teil ${i + 1}`);
  }
  const chapters = it.split === 'chapters' ? chaptersOf(it) : [];
  return starts.map((s, i) => {
    const chapter = chapters.filter((c) => c.startSec <= s + 0.5).pop();
    return chapter?.title?.trim() || (starts.length > 1 ? `${it.track.title} – Teil ${i + 1}` : it.track.title);
  });
}

/** The parts of a cut file, without the first `skip` (on the card already). */
function partJobs(it: Item, plan: SplitPlan, ctx: Context, skip: number): TrackJob[] {
  const a = it.analysis as AudioAnalysis;
  const wanted = plan.cuts.map((c) => c.timeSec);
  let cuts: number[];
  let bounds: number[];
  if (it.mp3 && it.index) {
    // Cuts move to frame boundaries; cutMp3Parts snaps them the same way.
    cuts = wanted;
    bounds = [0, ...snapCuts(it.index, wanted).timesSec, it.index.durationSec];
  } else {
    // The converter cuts at whole samples of 44.1 kHz and drops duplicates: the same here, so the parts match.
    const total = Math.round(a.durationSec * MP3_SAMPLE_RATE);
    const samples = [...new Set(wanted.map((t) => Math.round(t * MP3_SAMPLE_RATE)))].filter((s) => s > 0 && s < total).sort((x, y) => x - y);
    cuts = samples.map((s) => s / MP3_SAMPLE_RATE);
    bounds = [0, ...cuts, a.durationSec];
  }
  const count = bounds.length - 1;
  const titles = partTitles(it, bounds.slice(0, -1));
  const changes = it.mp3 && it.index ? changesFor('cut', { tagsWritten: true, gainApplied: ctx.steps !== 0 }) : changesFor('convert', { tagsWritten: true, gainApplied: ctx.convertDb !== 0, split: true });
  const tagFor = (i: number) => buildSmallId3(smallTags(ctx, titles[i], it.track, changes));
  const whole = bounds[count] || 1;
  const parts = it.mp3 && it.index ? mp3Parts(it, cuts, bounds, tagFor, ctx) : convertedParts(it, cuts, bounds, tagFor, ctx, skip);
  const jobs = titles.map((title, i): TrackJob => {
    const durationSec = bounds[i + 1] - bounds[i];
    return {
      track: it.track,
      source: it.track.source,
      part: i,
      parts: count,
      title,
      durationSec,
      estimateBytes: it.mp3 ? Math.round((it.track.source.size * durationSec) / whole) : convertedBytes(durationSec, ctx.conv, a.channels),
      work: it.mp3 ? 'cut' : 'convert',
      ...originOf(it.track),
      changes,
      worked: () => parts.worked(i),
      produce: (onFraction) => parts.take(i, onFraction).catch((e: unknown) => Promise.reject(it.mp3 ? fileError(it.track, e) : convertError(it, e))),
    };
  });
  return jobs.slice(skip);
}

interface Parts {
  take(index: number, onFraction: (f: number) => void): Promise<Blob>;
  worked(index: number): number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Parts of an MP3, cut losslessly one after the other when they are asked for. */
function mp3Parts(it: Item, cuts: number[], bounds: number[], tagFor: (i: number) => Uint8Array, ctx: Context): Parts {
  let parts: AsyncGenerator<Blob, void, undefined> | undefined;
  let next = 0;
  let progress = 0;
  let listener: (() => void) | undefined;
  ctx.cleanups.push(() => void parts?.return(undefined).catch(() => undefined));
  const whole = bounds[bounds.length - 1] || 1;
  // The cutter reports progress over the whole file; this is the share of part i.
  const worked = (i: number) => (i < next ? 1 : clamp01((progress - bounds[i] / whole) / Math.max(1e-9, (bounds[i + 1] - bounds[i]) / whole)));
  return {
    worked,
    take: async (i, onFraction) => {
      if (i < next) throw new Error(`Teil ${i + 1} wurde vor Teil ${next + 1} angefordert.`);
      listener = () => onFraction(worked(i));
      listener();
      parts ??= cutMp3Parts(it.track.source, it.index as Mp3Index, cuts, {
        gainSteps: ctx.steps,
        tagFor,
        signal: ctx.signal,
        onProgress: (f) => {
          progress = f;
          listener?.();
        },
      });
      try {
        // Parts before this one that are not wanted (on the card already) are cut and dropped.
        for (;;) {
          const r = await parts.next();
          if (r.done) throw new AudioError('read-failed');
          next++;
          if (next > i) return r.value;
        }
      } finally {
        listener = undefined;
      }
    },
  };
}

/**
 * Parts of a file that is converted: encoded several at a time, handed out
 * in order. The first `skip` parts are not kept (on the card already).
 */
function convertedParts(it: Item, cuts: number[], bounds: number[], tagFor: (i: number) => Uint8Array, ctx: Context, skip: number): Parts {
  const count = bounds.length - 1;
  // Parts on the card already are not kept, and count as taken: the parts after them do not wait for them.
  const ready: (Deferred<Blob> | undefined)[] = Array.from({ length: count }, (_, i) => (i < skip ? undefined : deferred<Blob>()));
  const taken = Array.from({ length: count }, (_, i) => {
    const d = deferred<void>();
    if (i < skip) d.resolve();
    return d;
  });
  const progress = Array.from({ length: count }, (_, i): number => (i < skip ? 1 : 0));
  let started = false;
  let listener: (() => void) | undefined;
  const start = () => {
    if (started) return;
    started = true;
    convertToMp3Parts(ctx.opts.audio, it.track.source, cuts, {
      ...ctx.conv,
      gainDb: ctx.convertDb,
      analysis: it.analysis,
      parallel: ctx.parallel,
      signal: ctx.signal,
      tagFor,
      // A part starts once the part `parallel` places before it is on its way to the card, so few finished parts wait in memory.
      beforePart: (i) => (i < ctx.parallel ? Promise.resolve() : taken[i - ctx.parallel].promise),
      onPartProgress: (i, f) => {
        progress[i] = f;
        listener?.();
      },
      onPart: (i, blob) => {
        progress[i] = 1;
        ready[i]?.resolve(blob);
        listener?.();
      },
    }).then(
      () => ready.forEach((d) => d?.reject(new AudioError('decode-failed'))), // parts that never came
      (e: unknown) => ready.forEach((d) => d?.reject(e)),
    );
  };
  return {
    worked: (i) => progress[i],
    take: async (i, onFraction) => {
      const part = ready[i];
      if (!part) throw new Error(`Teil ${i + 1} wurde schon abgeholt.`);
      taken[i].resolve();
      start();
      listener = () => onFraction(progress[i]);
      listener();
      try {
        return await part.promise;
      } finally {
        listener = undefined;
        ready[i] = undefined; // the card gets it now; nothing here holds on to it
      }
    },
  };
}

/**
 * Conversions of whole files. When one is asked for, the next ones start as
 * well, so up to `width` files are converted at the same time while the
 * session writes.
 */
class RunAhead {
  private readonly tasks: { run: (onProgress: (f: number) => void) => Promise<Blob>; promise?: Promise<Blob>; progress: number; listener?: (f: number) => void }[] = [];

  constructor(private readonly width: number) {}

  add(run: (onProgress: (f: number) => void) => Promise<Blob>): { take: (onFraction: (f: number) => void) => Promise<Blob>; worked: () => number } {
    const position = this.tasks.push({ run, progress: 0 }) - 1;
    return { take: (onFraction) => this.take(position, onFraction), worked: () => this.tasks[position].progress };
  }

  private start(position: number): Promise<Blob> {
    const task = this.tasks[position];
    if (!task.promise) {
      task.promise = task.run((f) => {
        task.progress = f;
        task.listener?.(f);
      });
      task.promise.catch(() => undefined); // reported to whoever takes it
    }
    return task.promise;
  }

  private async take(position: number, onFraction: (f: number) => void): Promise<Blob> {
    // The file asked for starts first: it is first in line where conversions wait (one in-memory decode at a time).
    const own = this.start(position);
    for (let k = position + 1; k < Math.min(this.tasks.length, position + this.width); k++) this.start(k);
    const task = this.tasks[position];
    task.listener = onFraction;
    onFraction(task.progress);
    try {
      const blob = await own;
      task.progress = 1;
      return blob;
    } finally {
      task.listener = undefined;
      task.promise = undefined;
      task.run = () => Promise.reject(new Error('Diese Datei wurde schon umgewandelt.'));
    }
  }
}
