/**
 * Cutting off the start and the end of an MP3 ("Anfang und Ende
 * abschneiden", an extra of the settings page): the same intro before
 * every episode, an outro after it. Without converting: the cuts land on
 * frame boundaries (±13 ms at 44.1 kHz) and the kept frames are copied as
 * cutMp3 copies a part, with a fresh Xing/Info frame and the bit reservoir
 * the first frames need.
 */
import type { ByteSource } from '../../platform/types';
import { AudioError } from './errors';
import { cutMp3Parts, snapCuts } from './mp3cut';
import { frameAtTime, timeOfFrame, type Mp3Index } from './mp3frames';
import { readRange } from './source';

/** Shortest track that may be left over: less is a mistake in the numbers, not a trimmed episode. */
export const MIN_TRIMMED_SEC = 1;

export interface TrimPlan {
  /** First frame kept and the frame after the last one kept. */
  startFrame: number;
  endFrame: number;
  /** Seconds really cut at the start and at the end (on frame boundaries). */
  cutStartSec: number;
  cutEndSec: number;
  /** Playing time afterwards. */
  durationSec: number;
}

/**
 * Where the cuts land for `startSec` off the start and `endSec` off the end
 * (seconds of decoded audio, as the player shows them). Null when less than
 * MIN_TRIMMED_SEC would be left.
 */
export function planTrim(index: Mp3Index, startSec: number, endSec: number): TrimPlan | null {
  const start = Number.isFinite(startSec) ? Math.max(0, startSec) : 0;
  const end = Number.isFinite(endSec) ? Math.max(0, endSec) : 0;
  const startFrame = start > 0 ? frameAtTime(index, start) : 0;
  const endFrame = end > 0 ? frameAtTime(index, index.durationSec - end) : index.frameCount;
  if (endFrame <= startFrame) return null;
  const from = startFrame > 0 ? timeOfFrame(index, startFrame) : 0;
  const to = endFrame < index.frameCount ? timeOfFrame(index, endFrame) : index.durationSec;
  if (to - from < MIN_TRIMMED_SEC) return null;
  return { startFrame, endFrame, cutStartSec: from, cutEndSec: Math.max(0, index.durationSec - to), durationSec: to - from };
}

/** The ID3v2 tags in front of the audio, as they are; empty when there are none. */
export async function leadingTags(source: ByteSource, index: Mp3Index): Promise<Uint8Array> {
  const blocks = index.tags.id3v2;
  if (!blocks.length) return new Uint8Array(0);
  const end = Math.max(...blocks.map((b) => b.offset + b.size));
  return readRange(source, 0, Math.min(end, index.tags.audioStart));
}

export interface TrimOptions {
  /** Tag for the new file: by default the ID3v2 tags the file had in front. Null for none. */
  tag?: Uint8Array | null;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * The MP3 without `startSec` at the start and `endSec` at the end (see
 * planTrim). The encoder delay stays when nothing is cut at the start, the
 * padding when nothing is cut at the end. Throws AudioError 'no-audio' when
 * too little would be left.
 */
export async function trimMp3(source: ByteSource, index: Mp3Index, startSec: number, endSec: number, opts: TrimOptions = {}): Promise<Blob> {
  const plan = planTrim(index, startSec, endSec);
  if (!plan) throw new AudioError('no-audio', 'Nach dem Abschneiden bliebe von diesem Titel nichts übrig. Schneide weniger ab.');
  const tag = opts.tag === undefined ? await leadingTags(source, index) : opts.tag;
  const cuts = [...(plan.startFrame > 0 ? [plan.cutStartSec] : []), ...(plan.endFrame < index.frameCount ? [timeOfFrame(index, plan.endFrame)] : [])];
  const { frames } = snapCuts(index, cuts);
  const keep = [0, ...frames].indexOf(plan.startFrame);
  if (keep < 0 || (frames[keep] ?? index.frameCount) !== plan.endFrame) throw new AudioError('read-failed');
  let part = 0;
  // Parts before the kept one are read and dropped (an intro is short); the ones after it are never read.
  for await (const blob of cutMp3Parts(source, index, cuts, { tagFor: (i) => (i === keep ? tag : null), signal: opts.signal, onProgress: opts.onProgress })) {
    if (part++ === keep) {
      opts.onProgress?.(1);
      return blob;
    }
  }
  throw new AudioError('read-failed');
}
