/**
 * Slot positions on a sheet and the distribution of stickers onto sheets.
 * Slots are numbered row-major from 0 (top-left) to cols × rows - 1.
 */

import type { LabelTemplate } from './templates';

/** Axis-aligned rectangle in millimetres, origin top-left, y down. */
export interface RectMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SlotRect extends RectMm {
  /** 0-based slot number, row-major. */
  index: number;
  row: number;
  col: number;
}

export function slotsPerSheet(template: LabelTemplate): number {
  return Math.max(0, template.grid.cols) * Math.max(0, template.grid.rows);
}

/** Trim rectangles of all slots on one sheet, row-major. Round labels report their bounding square. */
export function slotRects(template: LabelTemplate): SlotRect[] {
  const { cols, rows, marginLeftMm, marginTopMm, pitchXMm, pitchYMm } = template.grid;
  const { widthMm, heightMm } = template.label;
  const out: SlotRect[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out.push({
        index: row * cols + col,
        row,
        col,
        x: round4(marginLeftMm + col * pitchXMm),
        y: round4(marginTopMm + row * pitchYMm),
        width: widthMm,
        height: heightMm,
      });
    }
  }
  return out;
}

export function slotRect(template: LabelTemplate, index: number): SlotRect {
  const n = slotsPerSheet(template);
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new RangeError(`Etikett ${index + 1} gibt es auf diesem Bogen nicht (1 bis ${n}).`);
  }
  return slotRects(template)[index];
}

export interface PaginateOptions {
  /** Slots on the first sheet that are already used (0-based), in addition to those before `startSlot`. */
  skipSlots?: Iterable<number>;
}

/**
 * Distributes items onto sheets. Returns one array per sheet with exactly
 * `slotsPerSheet` entries; `null` means "leave this label empty".
 *
 * `startSlot` (0-based) lets a half-used sheet continue at label N + 1: the
 * first sheet skips slots 0 … startSlot - 1 (and `skipSlots`); later sheets
 * start at slot 0. A `null` item keeps its slot empty. Sheets without any
 * sticker are left out.
 */
export function paginate<T>(
  items: readonly (T | null | undefined)[],
  template: LabelTemplate,
  startSlot = 0,
  options: PaginateOptions = {},
): (T | null)[][] {
  const perSheet = slotsPerSheet(template);
  if (perSheet === 0) return [];
  const start = Number.isFinite(startSlot) ? Math.min(Math.max(Math.floor(startSlot), 0), perSheet - 1) : 0;
  const skip = new Set<number>();
  for (const s of options.skipSlots ?? []) {
    if (Number.isInteger(s) && s >= 0 && s < perSheet) skip.add(s);
  }

  const sheets: (T | null)[][] = [];
  let sheet = emptySheet<T>(perSheet);
  let firstSheet = true;
  let slot = start;
  for (const item of items) {
    while (firstSheet && slot < perSheet && skip.has(slot)) slot++;
    if (slot >= perSheet) {
      sheets.push(sheet);
      sheet = emptySheet<T>(perSheet);
      firstSheet = false;
      slot = 0;
    }
    sheet[slot++] = item ?? null;
  }
  sheets.push(sheet);
  return sheets.filter((s) => s.some((x) => x !== null));
}

/** Number of sheets `paginate` produces for `count` stickers. */
export function sheetCount(count: number, template: LabelTemplate, startSlot = 0, options: PaginateOptions = {}): number {
  if (count <= 0) return 0;
  return paginate(new Array<true>(count).fill(true), template, startSlot, options).length;
}

export function growRect(r: RectMm, left: number, top = left, right = left, bottom = top): RectMm {
  return { x: r.x - left, y: r.y - top, width: r.width + left + right, height: r.height + top + bottom };
}

export function rectsOverlap(a: RectMm, b: RectMm, epsilon = 1e-6): boolean {
  return (
    a.x < b.x + b.width - epsilon &&
    b.x < a.x + a.width - epsilon &&
    a.y < b.y + b.height - epsilon &&
    b.y < a.y + a.height - epsilon
  );
}

export function rectInside(inner: RectMm, outer: RectMm, epsilon = 1e-6): boolean {
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon
  );
}

function emptySheet<T>(n: number): (T | null)[] {
  return new Array<T | null>(n).fill(null);
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
