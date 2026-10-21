/**
 * "Weißer Rand": a white margin around every sticker, for printers that put
 * some stickers a few millimetres off while others sit right (the paper is
 * fed unevenly). Aligning the printer (calibration.ts) corrects one offset
 * and one scale for the whole sheet, so it cannot help there.
 *
 * With a margin every motif is printed smaller by the margin on every side
 * and without bleed; the label around it stays white paper. An offset up to
 * the margin then keeps the motif on its own label, never on the neighbour.
 * The motif is laid out as a sticker of its own size (layout.ts), so every
 * style, the backs, the PDF and the single pictures treat it the same, and
 * text sizes follow the smaller room.
 *
 * Pure geometry in millimetres, like layout.ts.
 */
import type { Box, StickerGeometry } from './layout';
import type { LabelTemplate } from './templates';

/** The margins offered, mm. 0 is "Ohne", as before. */
export const MARGIN_CHOICES: readonly number[] = [0, 1, 2, 3];

/** A margin takes at most this share of the label's shorter side, so a small round label keeps a motif worth having. */
const MARGIN_SHARE = 0.1;

/**
 * Text, number and logo keep at least this far from the motif's edge, mm.
 * The motif's edge is printed, not cut, so less than the label's safe margin
 * will do there; from the label's edge they keep at least its safe margin.
 */
export const MOTIF_SAFE_MIN_MM = 1.5;

/** The margins that suit a label of this size. */
export function marginChoices(label: { widthMm: number; heightMm: number }): number[] {
  const most = Math.min(label.widthMm, label.heightMm) * MARGIN_SHARE;
  return MARGIN_CHOICES.filter((m) => m <= most + 1e-9);
}

/**
 * A stored margin as one this label offers: anything else (nothing stored, a
 * number from an older version, a larger margin than a small label allows)
 * becomes the largest choice not above it.
 */
export function usableMargin(value: unknown, label: { widthMm: number; heightMm: number }): number {
  const m = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  let best = 0;
  for (const c of marginChoices(label)) if (c <= m + 1e-9) best = c;
  return best;
}

export interface MotifFrame {
  /** The motif as a sticker of its own: the label less the margin, without bleed. */
  geometry: StickerGeometry;
  /** Where the motif sits on the label (0, 0 is the label's top left corner). */
  box: Box;
  /** Corner radius of the motif: the label's corners, drawn the margin further in. */
  radius: number;
}

/**
 * Where the motif goes inside a margin of `marginMm` on a label of geometry
 * `g` (already turned) with corners of `cornerRadiusMm`. Its safe margin
 * shrinks by the margin, but not below MOTIF_SAFE_MIN_MM: text stays as far
 * from the label's edge as without a margin, or further.
 */
export function motifFrame(g: StickerGeometry, cornerRadiusMm: number, marginMm: number): MotifFrame {
  const m = Math.max(0, marginMm);
  const width = Math.max(1, g.widthMm - 2 * m);
  const height = Math.max(1, g.heightMm - 2 * m);
  return {
    geometry: { widthMm: width, heightMm: height, bleedMm: 0, safeMm: Math.max(MOTIF_SAFE_MIN_MM, g.safeMm - m), shape: g.shape },
    box: { x: m, y: m, width, height },
    radius: g.shape === 'round' ? Math.min(width, height) / 2 : Math.min(Math.max(0, cornerRadiusMm - m), width / 2, height / 2),
  };
}

/**
 * Labels that touch their neighbours on the sheet (no gap between two rows
 * or columns, as the rows of HERMA 5028). There the bleed has nowhere to go
 * (pdf.ts gives it half the gap), and a sticker printed a little off lands
 * on the next one at once: label makers advise a white margin for such sheets.
 */
export function labelsTouch(t: Pick<LabelTemplate, 'grid' | 'label'>): boolean {
  return narrowestGapMm(t) < 0.5;
}

/** Below this gap between the labels of a pre-cut sheet a margin is set from the start. */
export const AUTO_MARGIN_GAP_MM = 2;

/** The margin set from the start on such sheets, mm. */
export const AUTO_MARGIN_MM = 1;

/** The smallest gap between two neighbouring labels of the sheet, mm; Infinity with only one label. */
export function narrowestGapMm(t: Pick<LabelTemplate, 'grid' | 'label'>): number {
  const gapX = t.grid.cols > 1 ? t.grid.pitchXMm - t.label.widthMm : Infinity;
  const gapY = t.grid.rows > 1 ? t.grid.pitchYMm - t.label.heightMm : Infinity;
  return Math.min(gapX, gapY);
}

/**
 * The margin a paper gets while nobody chose one for it: 1 mm on pre-cut
 * sheets whose labels lie closer than 2 mm (HERMA 5028, Labelident), where
 * the bleed has no room and a sticker printed half a millimetre off already
 * shows as a stripe on its neighbour (sticker audit 16.10.2026, Avery's advice
 * for such sheets). Paper the user cuts needs none: the cut follows the print.
 */
export function autoMarginMm(t: Pick<LabelTemplate, 'grid' | 'label' | 'kind'>): number {
  if (t.kind !== 'die-cut' || !(narrowestGapMm(t) < AUTO_MARGIN_GAP_MM)) return 0;
  return marginChoices(t.label).includes(AUTO_MARGIN_MM) ? AUTO_MARGIN_MM : 0;
}

/**
 * The margin to print with: the one the user chose for this paper, else the
 * one it gets from the start (autoMarginMm), as one the label offers.
 */
export function chosenMargin(stored: Readonly<Record<string, number>> | undefined, t: Pick<LabelTemplate, 'id' | 'grid' | 'label' | 'kind'>): number {
  const own = stored?.[t.id];
  return usableMargin(own === undefined ? autoMarginMm(t) : own, t.label);
}
