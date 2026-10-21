/**
 * One card from an original cover: measure it, plan it with its recipe (or
 * without one: the safe form), check the plan, paint it.
 */
import { createCanvas, get2d, imageSize, type CanvasLike, type DrawableImage } from '../stickers/image';
import { analyseCover, type CoverAnalysis } from './analyse';
import { paintCard, type FaceFor } from './paint';
import { planCard, type CardGeometry, type CardPlan, type CardText } from './plan';
import { resolveLayout, type CardFormat, type Recipe } from './recipe';

/** Longest side of the copy a cover is measured on. */
export const ANALYSIS_EDGE = 420;

/** Measures a decoded picture (a small copy of it). */
export function analyseImage(image: DrawableImage): CoverAnalysis {
  const { width, height } = imageSize(image);
  const s = Math.min(1, ANALYSIS_EDGE / Math.max(width, height));
  const c = createCanvas(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)));
  const g = get2d(c, { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, 0, 0, c.width, c.height);
  return analyseCover(g.getImageData(0, 0, c.width, c.height));
}

export interface BuildInput {
  image: DrawableImage;
  recipe: Recipe | null;
  episode?: number;
  format: CardFormat;
  geometry: CardGeometry;
  text: CardText;
  pxPerMm: number;
  faces: FaceFor;
  /** Same seed, same card. */
  seed?: number;
  /** A measurement of this very picture, to skip measuring again. */
  analysis?: CoverAnalysis;
}

export interface BuiltCard {
  canvas: CanvasLike;
  plan: CardPlan;
  analysis: CoverAnalysis;
}

/** Plans one card (no painting): for the folder page and the tests. */
export function planFor(input: Omit<BuildInput, 'pxPerMm' | 'faces'> & { analysis: CoverAnalysis }): CardPlan {
  const { width, height } = imageSize(input.image);
  return planCard({
    analysis: input.analysis,
    layout: resolveLayout(input.recipe, input.format, input.episode),
    format: input.format,
    geometry: input.geometry,
    text: input.text,
    sourceSize: { width, height },
    seed: input.seed,
  });
}

export function buildCard(input: BuildInput): BuiltCard {
  const analysis = input.analysis ?? analyseImage(input.image);
  const plan = planFor({ ...input, analysis });
  const canvas = paintCard(plan, input.image, { pxPerMm: input.pxPerMm, faces: input.faces, seed: input.seed });
  return { canvas, plan, analysis };
}
