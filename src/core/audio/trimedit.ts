/**
 * What the trim editor (src/features/trim) makes of a track: a new start, a
 * new end, and pieces cut out in between. Written without converting, like
 * "Anfang und Ende abschneiden" before it (mp3trim.ts): all cuts land on
 * frame boundaries (±13 ms at 44.1 kHz). With only a new start and end the
 * file comes out exactly as trimMp3 makes it. Pieces cut out in between
 * leave parts that are joined frame by frame (joinMp3); where a part reaches
 * back into bytes before it, a silent frame (26 ms) carries them, which is
 * inaudible in the pause the editor snaps the cut to.
 */
import type { ByteSource } from '../../platform/types';
import { AudioError } from './errors';
import { cutMp3Parts } from './mp3cut';
import { frameAtTime, scanMp3, timeOfFrame, type Mp3Index } from './mp3frames';
import { joinMp3 } from './mp3join';
import { leadingTags, MIN_TRIMMED_SEC, trimMp3 } from './mp3trim';
import { fileSource } from './source';

/** A piece cut out of the middle, in seconds of decoded audio. */
export interface TrimCut {
  fromSec: number;
  toSec: number;
}

/** What stays of a track: from startSec to endSec (seconds of decoded audio), without the cuts. */
export interface TrimEdit {
  startSec: number;
  endSec: number;
  /** Sorted, apart from each other, inside (startSec, endSec). */
  cuts: TrimCut[];
}

/** The untouched track. */
export function wholeTrack(durationSec: number): TrimEdit {
  return { startSec: 0, endSec: durationSec, cuts: [] };
}

/** True when the edit leaves the track as it is (within half a frame). */
export function isUntouched(edit: TrimEdit, durationSec: number, slackSec = 0.013): boolean {
  return edit.startSec <= slackSec && edit.endSec >= durationSec - slackSec && edit.cuts.length === 0;
}

/** The stretches that stay, in order (seconds). */
export function keptStretches(edit: TrimEdit): { fromSec: number; toSec: number }[] {
  const out: { fromSec: number; toSec: number }[] = [];
  let at = edit.startSec;
  for (const c of edit.cuts) {
    if (c.fromSec > at) out.push({ fromSec: at, toSec: Math.min(c.fromSec, edit.endSec) });
    at = Math.max(at, c.toSec);
  }
  if (edit.endSec > at) out.push({ fromSec: at, toSec: edit.endSec });
  return out.filter((s) => s.toSec > s.fromSec);
}

/**
 * Where second `sec` of the whole track lands in the cut one. A spot in a
 * piece that is cut away lands where that piece was.
 */
export function timeAfterEdit(edit: TrimEdit, sec: number): number {
  let out = 0;
  for (const s of keptStretches(edit)) {
    if (sec <= s.fromSec) break;
    out += Math.min(sec, s.toSec) - s.fromSec;
    if (sec < s.toSec) break;
  }
  return out;
}

/** The other way round: where second `sec` of the cut track was in the whole one. */
export function timeBeforeEdit(edit: TrimEdit, sec: number): number {
  let left = Math.max(0, sec);
  const kept = keptStretches(edit);
  for (const s of kept) {
    const len = s.toSec - s.fromSec;
    if (left <= len) return s.fromSec + left;
    left -= len;
  }
  return kept.length ? kept[kept.length - 1].toSec : edit.startSec;
}

/** Playing time of what stays. */
export function keptSec(edit: TrimEdit): number {
  return keptStretches(edit).reduce((n, s) => n + s.toSec - s.fromSec, 0);
}

export interface TrimEditPlan {
  /** Frames that stay: [startFrame, endFrame) each, in order, apart from each other. */
  parts: { startFrame: number; endFrame: number }[];
  /** Playing time afterwards. */
  durationSec: number;
  /** Seconds really cut at the start and at the end (on frame boundaries). */
  cutStartSec: number;
  cutEndSec: number;
}

/**
 * Where the cuts of `edit` land in the frames of `index`. Null when less
 * than MIN_TRIMMED_SEC would be left.
 */
export function planTrimEdit(index: Mp3Index, edit: TrimEdit): TrimEditPlan | null {
  const boundary = (t: number) => (t <= 0 ? 0 : t >= index.durationSec ? index.frameCount : frameAtTime(index, t));
  const frameSec = index.samplesPerFrame / index.sampleRate;
  const parts: { startFrame: number; endFrame: number }[] = [];
  // A cut thinner than a frame cuts nothing.
  for (const s of keptStretches({ ...edit, cuts: edit.cuts.filter((c) => c.toSec - c.fromSec >= frameSec) })) {
    const a = boundary(s.fromSec);
    const b = boundary(s.toSec);
    if (b <= a) continue;
    const last = parts[parts.length - 1];
    if (last && a <= last.endFrame) last.endFrame = Math.max(last.endFrame, b);
    else parts.push({ startFrame: a, endFrame: b });
  }
  if (!parts.length) return null;
  const timeAt = (f: number) => (f >= index.frameCount ? index.durationSec : f <= 0 ? 0 : timeOfFrame(index, f));
  const durationSec = parts.reduce((n, p) => n + timeAt(p.endFrame) - timeAt(p.startFrame), 0);
  if (durationSec < MIN_TRIMMED_SEC) return null;
  return {
    parts,
    durationSec,
    cutStartSec: timeAt(parts[0].startFrame),
    cutEndSec: Math.max(0, index.durationSec - timeAt(parts[parts.length - 1].endFrame)),
  };
}

export interface TrimEditOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * The MP3 as `edit` says, without converting (see the top of this file).
 * The ID3v2 tags in front stay. Throws AudioError 'no-audio' when too
 * little would be left.
 */
export async function writeTrimEdit(source: ByteSource, index: Mp3Index, edit: TrimEdit, opts: TrimEditOptions = {}): Promise<Blob> {
  const plan = planTrimEdit(index, edit);
  if (!plan) throw new AudioError('no-audio', 'Nach dem Schneiden bliebe von diesem Titel nichts übrig. Lasse mehr übrig.');
  if (plan.parts.length === 1) {
    const p = plan.parts[0];
    const end = p.endFrame >= index.frameCount ? 0 : index.durationSec - timeOfFrame(index, p.endFrame);
    return trimMp3(source, index, p.startFrame > 0 ? timeOfFrame(index, p.startFrame) : 0, end, opts);
  }
  // Cut at every boundary, keep every other part, join them.
  const bounds = plan.parts.flatMap((p) => [p.startFrame, p.endFrame]).filter((f) => f > 0 && f < index.frameCount);
  const keep = new Set<number>();
  let part = 0;
  for (let f = 0, b = 0; b <= bounds.length; b++) {
    const next = b < bounds.length ? bounds[b] : index.frameCount;
    if (plan.parts.some((p) => p.startFrame <= f && next <= p.endFrame)) keep.add(part);
    f = next;
    part++;
  }
  const kept: Blob[] = [];
  let n = 0;
  const cutting = (x: number) => opts.onProgress?.(0.5 * x);
  for await (const blob of cutMp3Parts(source, index, bounds.map((f) => timeOfFrame(index, f)), { tagFor: () => null, signal: opts.signal, onProgress: cutting })) {
    if (keep.has(n++)) kept.push(blob);
  }
  if (!kept.length) throw new AudioError('read-failed');
  const inputs = [];
  for (const blob of kept) {
    const s = fileSource(blob, 'teil.mp3');
    inputs.push({ source: s, index: await scanMp3(s, { signal: opts.signal }) });
  }
  const { blob } = await joinMp3(inputs, { tag: await leadingTags(source, index), signal: opts.signal, onProgress: (x) => opts.onProgress?.(0.5 + 0.5 * x) });
  return blob;
}

/**
 * The same new start and end for another track (the same title music
 * before every episode): as many seconds off its start and its end as
 * `edit` takes off a track of `durationSec`. Pieces in the middle stay
 * with the one track they were cut from.
 */
export function sameEndsFor(edit: TrimEdit, durationSec: number, otherSec: number): TrimEdit {
  return { startSec: edit.startSec, endSec: otherSec - Math.max(0, durationSec - edit.endSec), cuts: [] };
}
