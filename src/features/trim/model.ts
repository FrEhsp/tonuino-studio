/**
 * The trim editor's rules without the screen (TrimEditor.tsx): where the
 * grips may go, a piece cut out of the middle, snapping to pauses, undo and
 * redo, and the part of the track that shows (zoom). All times are seconds
 * of decoded audio, as in TrimEdit.
 */
import { MIN_TRIMMED_SEC } from '../../core/audio/mp3trim';
import type { TrimCut, TrimEdit } from '../../core/audio/trimedit';

/** A piece cut out of the middle is at least this long, and stays this far from the other grips. */
export const MIN_CUT_SEC = 0.2;
export const MIN_GAP_SEC = 0.2;

/** A grip within this many pixels of a pause jumps into it. */
export const SNAP_PX = 14;

/** The grips: new start, new end, and both edges of each piece cut out. */
export type Grip = { kind: 'start' } | { kind: 'end' } | { kind: 'from'; cut: number } | { kind: 'to'; cut: number };

export function sameGrip(a: Grip | null, b: Grip | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && ('cut' in a ? a.cut : -1) === ('cut' in b ? b.cut : -1);
}

/** Where a grip is. */
export function gripTime(edit: TrimEdit, g: Grip): number {
  if (g.kind === 'start') return edit.startSec;
  if (g.kind === 'end') return edit.endSec;
  const c = edit.cuts[g.cut];
  return g.kind === 'from' ? c.fromSec : c.toSec;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The edit with grip `g` moved to `t`, as far as it may go: the start
 * before the first piece cut out and at least MIN_TRIMMED_SEC before the
 * end, a piece's edges between their neighbours and MIN_CUT_SEC apart.
 */
export function moveGrip(edit: TrimEdit, g: Grip, t: number, durationSec: number): TrimEdit {
  const cuts = edit.cuts;
  if (g.kind === 'start') {
    const hi = Math.min(edit.endSec - MIN_TRIMMED_SEC, cuts.length ? cuts[0].fromSec - MIN_GAP_SEC : Infinity);
    return { ...edit, startSec: clamp(t, 0, Math.max(0, hi)) };
  }
  if (g.kind === 'end') {
    const lo = Math.max(edit.startSec + MIN_TRIMMED_SEC, cuts.length ? cuts[cuts.length - 1].toSec + MIN_GAP_SEC : -Infinity);
    return { ...edit, endSec: clamp(t, Math.min(durationSec, lo), durationSec) };
  }
  const i = g.cut;
  const c = cuts[i];
  if (!c) return edit;
  const next: TrimCut[] = cuts.slice();
  if (g.kind === 'from') {
    const lo = (i > 0 ? cuts[i - 1].toSec : edit.startSec) + MIN_GAP_SEC;
    next[i] = { ...c, fromSec: clamp(t, lo, c.toSec - MIN_CUT_SEC) };
  } else {
    const hi = (i + 1 < cuts.length ? cuts[i + 1].fromSec : edit.endSec) - MIN_GAP_SEC;
    next[i] = { ...c, toSec: clamp(t, c.fromSec + MIN_CUT_SEC, hi) };
  }
  return { ...edit, cuts: next };
}

/**
 * A new piece to cut out, `widthSec` wide around `centerSec` (made smaller
 * to fit between its neighbours). Null when there is no room for one there.
 */
export function addCut(edit: TrimEdit, centerSec: number, widthSec: number): TrimEdit | null {
  const at = clamp(centerSec, edit.startSec, edit.endSec);
  // The room around the place: between the grips left and right of it.
  let lo = edit.startSec;
  let hi = edit.endSec;
  let insert = edit.cuts.length;
  for (let i = 0; i < edit.cuts.length; i++) {
    const c = edit.cuts[i];
    if (at >= c.fromSec && at <= c.toSec) return null; // already cut out
    if (c.toSec <= at) lo = c.toSec;
    else {
      hi = c.fromSec;
      insert = i;
      break;
    }
  }
  lo += MIN_GAP_SEC;
  hi -= MIN_GAP_SEC;
  if (hi - lo < MIN_CUT_SEC) return null;
  const half = Math.min(widthSec, hi - lo) / 2;
  const mid = clamp(at, lo + half, hi - half);
  const cut = { fromSec: mid - half, toSec: mid + half };
  // Something must be left besides.
  const cuts = [...edit.cuts.slice(0, insert), cut, ...edit.cuts.slice(insert)];
  const kept = edit.endSec - edit.startSec - cuts.reduce((n, c) => n + c.toSec - c.fromSec, 0);
  return kept >= MIN_TRIMMED_SEC ? { ...edit, cuts } : null;
}

export function removeCut(edit: TrimEdit, i: number): TrimEdit {
  return { ...edit, cuts: edit.cuts.filter((_, k) => k !== i) };
}

/** True when two edits are the same (within a millisecond). */
export function sameEdit(a: TrimEdit, b: TrimEdit): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) < 0.001;
  return eq(a.startSec, b.startSec) && eq(a.endSec, b.endSec) && a.cuts.length === b.cuts.length && a.cuts.every((c, i) => eq(c.fromSec, b.cuts[i].fromSec) && eq(c.toSec, b.cuts[i].toSec));
}

/* ------------------------------------------------------------ undo */

export interface History {
  edit: TrimEdit;
  past: TrimEdit[];
  future: TrimEdit[];
}

/** Steps kept for undo. */
const MAX_UNDO = 100;

export function startHistory(edit: TrimEdit): History {
  return { edit, past: [], future: [] };
}

/** One step: `edit` becomes the current one (nothing when it is the same). */
export function commit(h: History, edit: TrimEdit): History {
  if (sameEdit(h.edit, edit)) return h;
  return { edit, past: [...h.past, h.edit].slice(-MAX_UNDO), future: [] };
}

export function undo(h: History): History {
  const prev = h.past[h.past.length - 1];
  return prev ? { edit: prev, past: h.past.slice(0, -1), future: [h.edit, ...h.future] } : h;
}

export function redo(h: History): History {
  const next = h.future[0];
  return next ? { edit: next, past: [...h.past, h.edit], future: h.future.slice(1) } : h;
}

/* ------------------------------------------------------------ snapping */

/**
 * The pause nearest to `t` within `toleranceSec` (`places`: where each
 * pause is best cut, sorted), or `t` itself.
 */
export function snapToPause(t: number, places: readonly number[], toleranceSec: number): { sec: number; snapped: boolean } {
  let lo = 0;
  let hi = places.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (places[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let dist = toleranceSec;
  for (const k of [lo - 1, lo]) {
    if (k < 0 || k >= places.length) continue;
    const d = Math.abs(places[k] - t);
    if (d <= dist) {
      dist = d;
      best = k;
    }
  }
  return best < 0 ? { sec: t, snapped: false } : { sec: places[best], snapped: true };
}

/* ------------------------------------------------------------ the part that shows */

export interface View {
  fromSec: number;
  toSec: number;
}

/** Shortest part that can show: a few seconds, where a frame (26 ms) is a few pixels wide. */
export const MIN_VIEW_SEC = 2;

/** The whole track. */
export function wholeView(durationSec: number): View {
  return { fromSec: 0, toSec: Math.max(durationSec, MIN_VIEW_SEC) };
}

/** `view` moved back inside the track, `span` kept where it fits. */
function inside(fromSec: number, span: number, durationSec: number): View {
  const total = Math.max(durationSec, MIN_VIEW_SEC);
  const s = clamp(span, Math.min(MIN_VIEW_SEC, total), total);
  const from = clamp(fromSec, 0, total - s);
  return { fromSec: from, toSec: from + s };
}

/** Zoomed by `factor` (less than 1: closer) around `anchorSec`, which stays where it is on the screen. */
export function zoomView(view: View, factor: number, anchorSec: number, durationSec: number): View {
  const span = view.toSec - view.fromSec;
  const next = clamp(span * factor, Math.min(MIN_VIEW_SEC, durationSec), Math.max(durationSec, MIN_VIEW_SEC));
  const rel = span > 0 ? (anchorSec - view.fromSec) / span : 0.5;
  return inside(anchorSec - rel * next, next, durationSec);
}

export function panView(view: View, deltaSec: number, durationSec: number): View {
  return inside(view.fromSec + deltaSec, view.toSec - view.fromSec, durationSec);
}

/** The view moved just enough that `t` shows with a margin (a tenth of the view). */
export function showTime(view: View, t: number, durationSec: number): View {
  const span = view.toSec - view.fromSec;
  const margin = span / 10;
  if (t < view.fromSec + margin) return inside(t - margin, span, durationSec);
  if (t > view.toSec - margin) return inside(t - span + margin, span, durationSec);
  return view;
}

/** A view of `span` seconds centred on `t`. */
export function viewAround(t: number, span: number, durationSec: number): View {
  return inside(t - span / 2, span, durationSec);
}

/* ------------------------------------------------------------ playing */

/**
 * Where playing from `t` goes on: past a piece cut out it jumps to its end;
 * null after the new end. Lets the preview play the track as it will be.
 */
export function playableFrom(edit: TrimEdit, t: number): number | null {
  let at = Math.max(t, edit.startSec);
  for (const c of edit.cuts) if (at >= c.fromSec && at < c.toSec) at = c.toSec;
  return at < edit.endSec ? at : null;
}

/** "1:02:03,4" or "3:05,2": hours only when there are some, tenths always (a nudge shows). */
export function clockTime(sec: number, tenths = true): string {
  const t = Math.max(0, sec);
  const total = tenths ? Math.round(t * 10) : Math.round(t) * 10;
  const h = Math.floor(total / 36000);
  const m = Math.floor((total % 36000) / 600);
  const s = Math.floor((total % 600) / 10);
  const head = h ? `${h}:${String(m).padStart(2, '0')}` : String(m);
  return `${head}:${String(s).padStart(2, '0')}${tenths ? `,${total % 10}` : ''}`;
}
