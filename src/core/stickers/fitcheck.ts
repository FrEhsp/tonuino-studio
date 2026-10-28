/**
 * "Sitzt es?" after the first print on a printer (Frank, 25.10.2026, TODO #128): instead of a test page
 * and a ruler, the user says where the printed sheet shows a white strip at the edge of the stickers
 * and about how wide it is; the whole print then moves that far the other way, through the printer
 * correction the test page also sets (calibration.ts). A white strip at the top of every sticker means
 * the print came out too low, so it moves up, and so on.
 *
 * Sides are those of the sheet as it lies in front of the user the way it came out of the printer,
 * printed side up and the hint line at the bottom (portrait stickers on it included).
 */
import { calibrationKey, normalizeCalibration, type Calibration } from './calibration';

export type FitSide = 'top' | 'bottom' | 'left' | 'right';

/** Where a white strip shows, on each axis at most one side; missing: none there. */
export interface FitAnswer {
  vertical?: { side: 'top' | 'bottom'; mm: number };
  horizontal?: { side: 'left' | 'right'; mm: number };
}

/** The widths to choose from, mm: from a hair to about a card's thickness three times over. */
export const FIT_AMOUNTS: readonly number[] = [0.5, 1, 1.5, 2, 3];

/** More than this in all, mm: the quick question is not enough, the test page measures it. */
export const FIT_MAX_MM = 3;

/** The correction after the answer, on top of the one the print was made with. */
export function correctionFor(current: Partial<Calibration> | null | undefined, answer: FitAnswer): Calibration {
  const c = normalizeCalibration(current);
  const dy = answer.vertical ? (answer.vertical.side === 'top' ? -1 : 1) * clampMm(answer.vertical.mm) : 0;
  const dx = answer.horizontal ? (answer.horizontal.side === 'left' ? -1 : 1) * clampMm(answer.horizontal.mm) : 0;
  const out: Calibration = { offsetXMm: round2(c.offsetXMm + dx), offsetYMm: round2(c.offsetYMm + dy) };
  if (c.scaleX !== 1) out.scaleX = c.scaleX;
  if (c.scaleY !== 1) out.scaleY = c.scaleY;
  return out;
}

/** Whether the answer moves anything. */
export function movesPrint(answer: FitAnswer): boolean {
  return (answer.vertical?.mm ?? 0) > 0 || (answer.horizontal?.mm ?? 0) > 0;
}

/** "Ich rücke den Druck 1,5 mm nach oben und 0,5 mm nach links." Empty when nothing moves. */
export function describeShift(answer: FitAnswer): string {
  const parts: string[] = [];
  const v = answer.vertical;
  const h = answer.horizontal;
  // White at the top: the print moves up into it.
  if (v && v.mm > 0) parts.push(`${mm(v.mm)} nach ${v.side === 'top' ? 'oben' : 'unten'}`);
  if (h && h.mm > 0) parts.push(`${mm(h.mm)} nach ${h.side === 'left' ? 'links' : 'rechts'}`);
  return parts.length ? `Ich rücke den Druck ${parts.join(' und ')}.` : '';
}

/** Key under which a printer counts as asked for one paper. */
export function fitKey(printer: string, templateId: string): string {
  return calibrationKey(printer, templateId);
}

function clampMm(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 10) : 0;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

function mm(v: number): string {
  return `${String(round2(v)).replace('.', ',')} mm`;
}
