/**
 * Paints a card plan (plan.ts) with the original cover: flat colour with
 * the cover's own grain, the cover, real parts lifted off their plain ground
 * and put down again, then title and number. Canvas only, no filters (they
 * are missing in the Linux app's web view).
 */
import { stackBlur, createCanvas, get2d, imageSize, type CanvasLike, type Context2D, type DrawableImage } from '../stickers/image';
import { toCss, type RGB } from '../stickers/color';
import { ellipseCut, growAlpha, partAlpha, type PartShape } from './analyse';
import { seededRandom, type Frac } from './pixels';
import type { CardPlan, MmRect } from './plan';
import type { FontChoice } from './recipe';

export interface Face {
  family: string;
  weight: number;
}

/** The app's fonts for a choice, loaded before painting. */
export type FaceFor = (choice: FontChoice) => { title: Face; text: Face };

export interface PaintOptions {
  pxPerMm: number;
  faces: FaceFor;
  seed?: number;
}

const css = (f: Face, px: number) => `${f.weight} ${px.toFixed(2)}px '${f.family}', sans-serif`;

/** The source rectangle on the whole picture for a box on the cover without its frame. */
function srcRect(image: DrawableImage, inner: Frac, f: Frac = [0, 0, 1, 1]) {
  const { width, height } = imageSize(image);
  const x = (inner[0] + f[0] * inner[2]) * width;
  const y = (inner[1] + f[1] * inner[3]) * height;
  return { x, y, w: f[2] * inner[2] * width, h: f[3] * inner[3] * height };
}

/** Grain like the cover's own over everything outside `keep`, so an extended sky does not look like plastic. */
function addGrain(ctx: Context2D, w: number, h: number, amount: number, keep: MmRect | null, k: number, seed: number) {
  if (amount < 0.6) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const rnd = seededRandom(seed);
  const kx0 = keep ? keep.x * k : 0;
  const ky0 = keep ? keep.y * k : 0;
  const kx1 = keep ? (keep.x + keep.w) * k : 0;
  const ky1 = keep ? (keep.y + keep.h) * k : 0;
  const s = amount * 0.55;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (keep && x >= kx0 && x < kx1 && y >= ky0 && y < ky1) continue;
      const i = (y * w + x) * 4;
      // About normal (sum of three uniforms), the same on all channels.
      const n = (rnd() + rnd() + rnd() - 1.5) * 2 * s;
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      // Weaker in very dark and very light areas, as on a print.
      const wgt = Math.min(1, Math.max(0.25, Math.min(l, 255 - l) / 40));
      d[i] += n * wgt;
      d[i + 1] += n * wgt;
      d[i + 2] += n * wgt;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** A part of the cover at `w` × `h` pixels with its plain ground made transparent (soft edge). */
function liftPart(image: DrawableImage, inner: Frac, src: Frac, w: number, h: number, ground: RGB, shape: PartShape = 'rect', extraGrow = 0): CanvasLike {
  const c = createCanvas(w, h);
  const g = get2d(c, { willReadFrequently: true });
  const r = srcRect(image, inner, src);
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  let alpha = partAlpha(img, ground);
  if (extraGrow) alpha = growAlpha(alpha, c.width, c.height, extraGrow);
  // A round part ends at its circle: whatever lies near its box corners stays where it is.
  if (shape === 'ellipse') alpha = ellipseCut(alpha, c.width, c.height, extraGrow ? 1.035 : 1.02);
  // Soften the edge: blur the alpha as grey pixels.
  const tmp = new Uint8ClampedArray(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) {
    tmp[i * 4] = tmp[i * 4 + 1] = tmp[i * 4 + 2] = alpha[i];
    tmp[i * 4 + 3] = 255;
  }
  stackBlur(tmp, c.width, c.height, Math.max(1, Math.round(Math.min(c.width, c.height) / 120)));
  // Nothing at the very border of the box: the ground is there, a hard cut would show.
  const edge = Math.max(1, Math.round(Math.min(c.width, c.height) * 0.015));
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = y * c.width + x;
      const border = Math.min(x, y, c.width - 1 - x, c.height - 1 - y);
      const fade = border >= edge ? 1 : border / edge;
      img.data[i * 4 + 3] = tmp[i * 4] * fade;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * Fills the place a part was lifted from with the plain ground it lay on,
 * a little past its box (4 % of its shorter side, at least 2 px): the part's soft rim lies
 * right at the box, and the ring around it is plain ground (checked by
 * groundAround), so painting it over is safe. Drawn twice, so the soft
 * edge of the mask covers the rim fully on small cards too.
 */
function closeGap(ctx: Context2D, image: DrawableImage, inner: Frac, src: Frac, at: MmRect, ground: RGB, k: number, shape: PartShape = 'rect') {
  // Inside the ring groundAround checked: 6 % of the shorter side for a box, 1.04 to 1.12 of the radii for a circle.
  const m = Math.max(2 / k, 0.04 * Math.min(at.w, at.h));
  const fx = Math.min((m / at.w) * src[2], src[0], 1 - src[0] - src[2]);
  const fy = Math.min((m / at.h) * src[3], src[1], 1 - src[1] - src[3]);
  const mx = (fx / src[2]) * at.w;
  const my = (fy / src[3]) * at.h;
  const wide: Frac = [src[0] - fx, src[1] - fy, src[2] + 2 * fx, src[3] + 2 * fy];
  const w = Math.max(1, Math.round((at.w + 2 * mx) * k));
  const h = Math.max(1, Math.round((at.h + 2 * my) * k));
  const mask = liftPart(image, inner, wide, w, h, ground, shape, Math.max(2, Math.round(Math.min(w, h) / 40)));
  const g = get2d(mask);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = toCss(ground);
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2; i++) ctx.drawImage(mask as CanvasImageSource, (at.x - mx) * k, (at.y - my) * k, w, h);
}

/** Draws the cover; sides in `seams` fade into the ground over about a millimetre, so no line shows. */
function drawCover(ctx: Context2D, image: DrawableImage, plan: CardPlan, k: number) {
  const r = srcRect(image, plan.inner);
  const d = { x: plan.cover.x * k, y: plan.cover.y * k, w: plan.cover.w * k, h: plan.cover.h * k };
  if (!plan.seams.length) {
    ctx.drawImage(image, r.x, r.y, r.w, r.h, d.x, d.y, d.w, d.h);
    return;
  }
  const c = createCanvas(Math.round(d.w), Math.round(d.h));
  const g = get2d(c);
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in';
  const f = Math.max(2, 1.1 * k);
  for (const s of plan.seams) {
    const grad =
      s === 'top'
        ? g.createLinearGradient(0, 0, 0, f)
        : s === 'bottom'
          ? g.createLinearGradient(0, c.height, 0, c.height - f)
          : s === 'left'
            ? g.createLinearGradient(0, 0, f, 0)
            : g.createLinearGradient(c.width, 0, c.width - f, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(c as CanvasImageSource, d.x, d.y, d.w, d.h);
}

/** Breaks `text` into at most `maxLines` lines of at most `width` px; null when a word does not fit. */
function wrap(ctx: Context2D, text: string, width: number, maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (ctx.measureText(w).width > width) return null;
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= width) line = next;
    else {
      lines.push(line);
      line = w;
      if (lines.length >= maxLines) return null;
    }
  }
  if (line) lines.push(line);
  return lines.length <= maxLines ? lines : null;
}

function drawTitle(ctx: Context2D, plan: CardPlan, faces: FaceFor, k: number) {
  const t = plan.title;
  if (!t) return;
  const face = faces(t.font);
  const box = { x: t.box.x * k, y: t.box.y * k, w: t.box.w * k, h: t.box.h * k };
  const maxLines = box.h / box.w > 1.2 ? 5 : box.h > 14 * k ? 3 : 2;
  const subPx = Math.max(2.2 * k, Math.min(3.2 * k, box.h * 0.16));
  const sub = t.subtitle && box.h > 12 * k ? t.subtitle : undefined;
  const room = box.h - (sub ? subPx * 1.5 : 0);
  let size = Math.min(room / 1.15, 8.5 * k);
  let lines: string[] | null = null;
  for (; size >= 2.6 * k; size *= 0.94) {
    ctx.font = css(face.title, size);
    lines = wrap(ctx, t.text, box.w, maxLines);
    if (lines && lines.length * size * 1.08 <= room) break;
    lines = null;
  }
  if (!lines) {
    // Smallest size, cut with "…" on the last line.
    size = 2.6 * k;
    ctx.font = css(face.title, size);
    const max = Math.max(1, Math.floor(room / (size * 1.08)));
    lines = [];
    let rest = t.text;
    while (rest && lines.length < max) {
      let n = rest.length;
      while (n > 1 && ctx.measureText(rest.slice(0, n) + (n < rest.length && lines.length === max - 1 ? '…' : '')).width > box.w) n--;
      const cut = lines.length === max - 1 && n < rest.length;
      lines.push(rest.slice(0, n).trim() + (cut ? '…' : ''));
      rest = rest.slice(n).trim();
    }
  }
  const lineH = size * 1.08;
  const block = lines.length * lineH + (sub ? subPx * 1.5 : 0);
  let y = box.y + (box.h - block) / 2 + size * 0.86;
  ctx.fillStyle = toCss(t.ink);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const l of lines) {
    ctx.font = css(face.title, size);
    ctx.fillText(l, box.x, y);
    y += lineH;
  }
  if (sub) {
    ctx.font = css(face.text, subPx);
    ctx.globalAlpha = 0.82;
    let s = sub;
    while (s.length > 3 && ctx.measureText(s).width > box.w) s = s.slice(0, -2).trimEnd() + '…';
    ctx.fillText(s, box.x, y - lineH + size * 0.25 + subPx * 1.35);
    ctx.globalAlpha = 1;
  }
}

/** The number: a white disc with a dark ring, the figures big (smaller from three digits on, the disc stays). */
function drawBadge(ctx: Context2D, plan: CardPlan, faces: FaceFor, k: number) {
  const b = plan.badge;
  if (!b) return;
  const cx = b.cx * k;
  const cy = b.cy * k;
  const r = b.r * k;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fffdf7';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.11);
  ctx.strokeStyle = '#1f1a16';
  ctx.stroke();
  const face = faces('round').title;
  const size = r * (b.text.length >= 3 ? 0.8 : 1.05);
  ctx.font = css(face, size);
  ctx.fillStyle = '#1f1a16';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.text, cx, cy + size * 0.04);
}

/** Paints the plan at `pxPerMm` with the whole original picture `image`. */
export function paintCard(plan: CardPlan, image: DrawableImage, o: PaintOptions): CanvasLike {
  const k = o.pxPerMm;
  const W = Math.max(1, Math.round(plan.card.w * k));
  const H = Math.max(1, Math.round(plan.card.h * k));
  const canvas = createCanvas(W, H);
  const ctx = get2d(canvas, { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = toCss(plan.ground);
  ctx.fillRect(0, 0, W, H);
  addGrain(ctx, W, H, plan.grain, null, k, o.seed ?? 1);
  drawCover(ctx, image, plan, k);
  // Lift every moved part off first, then put them down: none lands on a gap of another.
  for (const m of plan.moves) {
    const at = { x: plan.cover.x + m.src[0] * plan.cover.w, y: plan.cover.y + m.src[1] * plan.cover.h, w: m.src[2] * plan.cover.w, h: m.src[3] * plan.cover.h };
    closeGap(ctx, image, plan.inner, m.src, at, m.ground, k, m.shape);
  }
  if (plan.moves.length && plan.grain >= 0.6) {
    // The closed gaps get the grain of the ground too (only there: the rest of the cover keeps its own).
    for (const m of plan.moves) {
      const at = { x: plan.cover.x + m.src[0] * plan.cover.w, y: plan.cover.y + m.src[1] * plan.cover.h, w: m.src[2] * plan.cover.w, h: m.src[3] * plan.cover.h };
      grainIn(ctx, at, plan.grain, k, (o.seed ?? 1) + 17, m.ground);
    }
  }
  for (const m of plan.moves) {
    const w = Math.max(1, Math.round(m.dst.w * k));
    const h = Math.max(1, Math.round(m.dst.h * k));
    ctx.drawImage(liftPart(image, plan.inner, m.src, w, h, m.ground, m.shape) as CanvasImageSource, m.dst.x * k, m.dst.y * k, w, h);
  }
  for (const c of plan.copies) {
    const first = c.dsts[0];
    if (!first) continue;
    const big = Math.max(...c.dsts.map((d) => Math.max(d.w, d.h)));
    const scale = (big * k) / Math.max(first.w, first.h);
    const piece = liftPart(image, plan.inner, c.src, Math.max(1, Math.round(first.w * scale)), Math.max(1, Math.round(first.h * scale)), c.ground, c.shape);
    for (const d of c.dsts) {
      ctx.save();
      ctx.translate((d.x + d.w / 2) * k, (d.y + d.h / 2) * k);
      ctx.rotate((d.rot * Math.PI) / 180);
      ctx.drawImage(piece as CanvasImageSource, (-d.w / 2) * k, (-d.h / 2) * k, d.w * k, d.h * k);
      ctx.restore();
    }
  }
  drawTitle(ctx, plan, o.faces, k);
  drawBadge(ctx, plan, o.faces, k);
  return canvas;
}

/** Grain inside one box, only on pixels that are the ground colour. */
function grainIn(ctx: Context2D, at: MmRect, amount: number, k: number, seed: number, ground: RGB) {
  const x = Math.max(0, Math.floor(at.x * k));
  const y = Math.max(0, Math.floor(at.y * k));
  const w = Math.min(ctx.canvas.width - x, Math.ceil(at.w * k));
  const h = Math.min(ctx.canvas.height - y, Math.ceil(at.h * k));
  if (w < 1 || h < 1) return;
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  const rnd = seededRandom(seed);
  const s = amount * 0.55;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() + rnd() + rnd() - 1.5) * 2 * s;
    const close = Math.abs(d[i] - ground.r) + Math.abs(d[i + 1] - ground.g) + Math.abs(d[i + 2] - ground.b) < 6;
    if (!close) continue;
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    const wgt = Math.min(1, Math.max(0.25, Math.min(l, 255 - l) / 40));
    d[i] += n * wgt;
    d[i + 1] += n * wgt;
    d[i + 2] += n * wgt;
  }
  ctx.putImageData(img, x, y);
}
