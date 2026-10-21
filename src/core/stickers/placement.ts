/**
 * Which sticker goes on which label (forum wish of 13.10.2026: move the
 * stickers on the sheet by dragging them).
 *
 * Left alone, the stickers fill the labels in order and skip the labels on
 * the first sheet that are gone already, as paginate does. Once a sticker is
 * moved, every sticker keeps its label ("pins"): one left out leaves its
 * label empty, a new one takes the first free label, and none of the others
 * moves. Sheets left without a sticker drop out, the ones after move up.
 * On another paper, or once labels are marked as gone or back, the pins no
 * longer fit: the stickers then fill the labels anew in the order they had.
 *
 * Pure: no drawing, no state; the page keeps the pins (features/stickers/placement.ts).
 */

/** A label: sheet from 0, slot from 0 in the row-major order of slotRects. */
export interface Spot {
  sheet: number;
  slot: number;
}

/** Where each sticker was put, by its key. */
export type Pins = Readonly<Record<string, Spot>>;

/** Pins with the labels they were made on (see `place`). */
export interface Moved {
  pins: Pins;
  perSheet: number;
  /** The labels gone on the first sheet then, as blockedSlots gives them, sorted. */
  blocked: readonly number[];
}

export interface Grid {
  cols: number;
  rows: number;
}

/**
 * Labels on the first sheet that cannot take a sticker. All of them gone
 * means a fresh sheet goes in, so none is skipped then.
 */
export function blockedSlots(perSheet: number, used: Iterable<number> = []): Set<number> {
  const out = new Set<number>();
  for (const s of used) if (Number.isInteger(s) && s >= 0 && s < perSheet) out.add(s);
  return out.size >= perSheet ? new Set() : out;
}

/** True when nothing can go onto this label. */
export function isBlocked(spot: Spot, perSheet: number, blocked: ReadonlySet<number>): boolean {
  return !validSpot(spot, perSheet) || (spot.sheet === 0 && blocked.has(spot.slot));
}

/**
 * The label of every sticker, in the order of `keys`: pinned ones where they
 * were put (if that label still exists, is free and not gone), the others in
 * the first free labels. The sheets come out without gaps, each with at
 * least one sticker.
 */
export function arrange(keys: readonly string[], perSheet: number, used: Iterable<number> = [], pins: Pins | null = null): Spot[] {
  if (perSheet <= 0) return keys.map(() => ({ sheet: 0, slot: 0 }));
  const blocked = blockedSlots(perSheet, used);
  let out: (Spot | null)[] = keys.map(() => null);
  if (pins) {
    const seen = new Set<number>();
    keys.forEach((key, i) => {
      const p = Object.prototype.hasOwnProperty.call(pins, key) ? pins[key] : undefined;
      if (!p || !validSpot(p, perSheet)) return;
      const at = p.sheet * perSheet + p.slot;
      if (seen.has(at)) return;
      seen.add(at);
      out[i] = { sheet: p.sheet, slot: p.slot };
    });
    // Sheets that lost all their stickers drop out.
    const sheets = [...new Set(out.flatMap((s) => (s ? [s.sheet] : [])))].sort((a, b) => a - b);
    const renumber = new Map(sheets.map((s, n) => [s, n]));
    out = out.map((s) => (s ? { sheet: renumber.get(s.sheet)!, slot: s.slot } : null));
    // A label marked as gone since: that sticker looks for a new one.
    out = out.map((s) => (s && isBlocked(s, perSheet, blocked) ? null : s));
  }
  const taken = new Set(out.flatMap((s) => (s ? [s.sheet * perSheet + s.slot] : [])));
  let next = 0;
  return out.map((s) => {
    if (s) return s;
    while (taken.has(next) || (next < perSheet && blocked.has(next))) next++;
    taken.add(next);
    return { sheet: Math.floor(next / perSheet), slot: next % perSheet };
  });
}

/** The pins as `place` takes them, for the labels they were made on. */
export function movedOf(pins: Pins, perSheet: number, used: Iterable<number> = []): Moved {
  return { pins, perSheet, blocked: [...blockedSlots(perSheet, used)].sort((a, b) => a - b) };
}

/**
 * The label of every sticker for the paper and the gone labels now. Pins made
 * on the same labels stay as they are (arrange). Made on another paper or
 * before labels were marked as gone or back, they would leave labels empty or
 * whole sheets nearly so: then the stickers fill the free labels again from
 * the start, in the order they had on the old labels.
 */
export function place(keys: readonly string[], perSheet: number, used: Iterable<number> = [], moved: Moved | null = null): Spot[] {
  const gone = [...used];
  if (!moved) return arrange(keys, perSheet, gone);
  const blocked = [...blockedSlots(perSheet, gone)].sort((a, b) => a - b);
  if (moved.perSheet === perSheet && moved.blocked.length === blocked.length && moved.blocked.every((s, i) => s === blocked[i])) {
    return arrange(keys, perSheet, gone, moved.pins);
  }
  const before = arrange(keys, moved.perSheet, moved.blocked, moved.pins);
  const at = (s: Spot) => s.sheet * moved.perSheet + s.slot;
  const order = keys.map((_, i) => i).sort((a, b) => at(before[a]) - at(before[b]) || a - b);
  const packed = arrange(order.map((i) => keys[i]), perSheet, gone);
  const out = new Array<Spot>(keys.length);
  order.forEach((i, n) => (out[i] = packed[n]));
  return out;
}

/** The sheets for `arrange`'s spots: one array per sheet with `perSheet` entries, null for an empty label. */
export function layOut<T>(items: readonly T[], spots: readonly Spot[], perSheet: number): (T | null)[][] {
  if (perSheet <= 0 || !items.length) return [];
  const count = Math.max(...spots.slice(0, items.length).map((s) => s.sheet)) + 1;
  const sheets = Array.from({ length: count }, () => new Array<T | null>(perSheet).fill(null));
  items.forEach((item, i) => {
    const s = spots[i];
    if (s) sheets[s.sheet][s.slot] = item;
  });
  return sheets;
}

/** Every sticker pinned where it is now. */
export function pinsOf(keys: readonly string[], spots: readonly Spot[]): Pins {
  const out: Record<string, Spot> = {};
  keys.forEach((key, i) => {
    if (spots[i]) out[key] = { sheet: spots[i].sheet, slot: spots[i].slot };
  });
  return out;
}

/**
 * Pins after putting the sticker on `from` onto `to`: onto an empty label it
 * moves, onto another sticker the two swap. Null when nothing changes or `to`
 * cannot take it (label gone, outside the sheets in use).
 */
export function moveSticker(keys: readonly string[], spots: readonly Spot[], from: Spot, to: Spot, perSheet: number, used: Iterable<number> = []): Pins | null {
  const sheets = spots.reduce((n, s) => Math.max(n, s.sheet + 1), 0);
  if (sameSpot(from, to) || to.sheet >= sheets || isBlocked(to, perSheet, blockedSlots(perSheet, used))) return null;
  const i = spots.findIndex((s) => sameSpot(s, from));
  if (i < 0) return null;
  const j = spots.findIndex((s) => sameSpot(s, to));
  const next = spots.map((s, n) => (n === i ? to : n === j ? from : s));
  return pinsOf(keys, next);
}

export function sameSpot(a: Spot, b: Spot): boolean {
  return a.sheet === b.sheet && a.slot === b.slot;
}

export function sameSpots(a: readonly Spot[], b: readonly Spot[]): boolean {
  return a.length === b.length && a.every((s, i) => sameSpot(s, b[i]));
}

export type Step = 'left' | 'right' | 'up' | 'down' | 'prevSheet' | 'nextSheet';

/**
 * The next label for moving with the keyboard. Left and right go on to the
 * row above or below and to the sheet before or after; up and down stay on
 * the sheet. Labels that are gone are skipped; with nowhere to go it stays.
 */
export function stepSpot(from: Spot, step: Step, grid: Grid, sheets: number, blocked: ReadonlySet<number>): Spot {
  const perSheet = grid.cols * grid.rows;
  const open = (s: Spot) => s.sheet >= 0 && s.sheet < sheets && !isBlocked(s, perSheet, blocked);
  if (step === 'prevSheet' || step === 'nextSheet') {
    const sheet = from.sheet + (step === 'nextSheet' ? 1 : -1);
    if (sheet < 0 || sheet >= sheets) return from;
    for (let d = 0; d < perSheet; d++) {
      // The same label, else the nearest one after it that is free.
      const s = { sheet, slot: (from.slot + d) % perSheet };
      if (open(s)) return s;
    }
    return from;
  }
  if (step === 'left' || step === 'right') {
    const dir = step === 'right' ? 1 : -1;
    for (let at = from.sheet * perSheet + from.slot + dir; at >= 0 && at < sheets * perSheet; at += dir) {
      const s = { sheet: Math.floor(at / perSheet), slot: at % perSheet };
      if (open(s)) return s;
    }
    return from;
  }
  const dir = step === 'down' ? grid.cols : -grid.cols;
  for (let slot = from.slot + dir; slot >= 0 && slot < perSheet; slot += dir) {
    const s = { sheet: from.sheet, slot };
    if (open(s)) return s;
  }
  return from;
}

function validSpot(s: Spot, perSheet: number): boolean {
  return Number.isInteger(s.sheet) && Number.isInteger(s.slot) && s.sheet >= 0 && s.slot >= 0 && s.slot < perSheet;
}
