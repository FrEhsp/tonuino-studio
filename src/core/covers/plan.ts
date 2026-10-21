/**
 * From a measured cover and a recipe to a plan for the card: where the
 * cover goes, which flat colour runs on or fills the panel, which real parts
 * move or are copied, where title and number sit. Then the automatic check
 * of analysis section C: nothing cut, no traces of copying, enough
 * resolution, no big empty area, nothing under the number. A plan that fails
 * is replaced by the safe form (the whole cover next to a flat colour panel).
 *
 * All sizes in millimetres on the card; no canvas here.
 */
import { bestTextColor, type RGB } from '../stickers/color';
import { groundAround, type CoverAnalysis, type Side } from './analyse';
import { busyGrid, colorDistance, largestRect, seededRandom, type Frac, type Pixels } from './pixels';
import type { CardForm, CardFormat, FontChoice, LayoutSpec, NumberChoice } from './recipe';

export interface MmRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The card as it stands (hoch: taller than wide). */
export interface CardGeometry {
  widthMm: number;
  heightMm: number;
  /** Distance from the edge that printing may cut into; text and moved parts stay inside. */
  cutMm: number;
}

export interface CardText {
  title: string;
  subtitle?: string;
  /** Folder number, "05". */
  folder?: string;
  episode?: number;
}

export type ProblemCode = 'angeschnitten' | 'kopierspuren' | 'aufloesung' | 'leer' | 'nummer';

export interface Problem {
  code: ProblemCode;
  text: string;
  /** False: worth knowing, but the safe form would not be better. */
  blocking: boolean;
}

export interface MovePlan {
  name?: string;
  src: Frac;
  shape?: 'rect' | 'ellipse';
  dst: MmRect;
  ground: RGB;
}

export interface CopyPlan {
  name?: string;
  src: Frac;
  shape?: 'rect' | 'ellipse';
  dsts: (MmRect & { rot: number })[];
  ground: RGB;
}

export interface CardPlan {
  form: 'verlaengern' | 'farbfeld' | 'fuellen';
  format: CardFormat;
  card: { w: number; h: number };
  /** Where the cover without its frame is drawn; may reach past the card when it is filled. */
  cover: MmRect;
  /** The cover without its frame, in parts of the whole picture. */
  inner: Frac;
  /** Colour of everything that is not cover: the flat colour run on, or the panel. */
  ground: RGB;
  grain: number;
  /** Sides of the cover that run into the ground without a visible seam. */
  seams: Side[];
  /** The panel next to the cover in the safe form. */
  panel?: MmRect;
  moves: MovePlan[];
  copies: CopyPlan[];
  title?: { box: MmRect; text: string; subtitle?: string; font: FontChoice; ink: RGB };
  badge?: { cx: number; cy: number; r: number; text: string };
  /** Text and logos of the cover where they end up on the card. */
  texts: MmRect[];
  problems: Problem[];
  /** The safe form taken because the planned one failed: what was wrong with it. */
  simplified?: Problem[];
}

export interface PlanInput {
  analysis: CoverAnalysis;
  layout: LayoutSpec;
  format: CardFormat;
  geometry: CardGeometry;
  text: CardText;
  /** Pixel size of the original picture (for the resolution check). */
  sourceSize: { width: number; height: number };
  /** For the scattering of copies: the same card every time. */
  seed?: number;
}

/** Below this the print gets soft (LOW_PRINT_DPI of the sticker printer). */
export const MIN_DPI = 150;
/** The largest empty rectangle may cover at most this share of the card. */
export const MAX_EMPTY = 0.25;
/** A copied part may be at most this share of the card ("small things like stars"). */
const MAX_COPY_AREA = 0.02;
const MAX_COPIES = 8;
/** Within this the cover is simply filled (cut a little), no panel. */
const FILL_SLACK = 0.035;
/** Mean busyness under the number above which it would cover something. */
const BUSY_UNDER_NUMBER = 5;

const MM_PER_INCH = 25.4;

/* ------------------------------------------------------------------ helpers */

const inside = (r: MmRect, box: MmRect, slack = 0.01) =>
  r.x >= box.x - slack && r.y >= box.y - slack && r.x + r.w <= box.x + box.w + slack && r.y + r.h <= box.y + box.h + slack;

const overlaps = (a: MmRect, b: MmRect, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

function fracOnCover(cover: MmRect, f: Frac): MmRect {
  return { x: cover.x + f[0] * cover.w, y: cover.y + f[1] * cover.h, w: f[2] * cover.w, h: f[3] * cover.h };
}

function circleBox(cx: number, cy: number, r: number): MmRect {
  return { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
}

function numberText(choice: NumberChoice | undefined, t: CardText): string | undefined {
  switch (choice ?? 'ordner') {
    case 'folge':
      return t.episode !== undefined ? String(t.episode) : t.folder;
    case 'ordner':
      return t.folder;
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ where things are */

/**
 * The card in cells of a millimetre: how busy each one is and whether it is
 * plain ground of the card's colour. The cover's cells come from its pixels;
 * everything outside the cover is ground.
 */
class Occupancy {
  readonly cols: number;
  readonly rows: number;
  readonly busy: Float32Array;
  readonly ground: Uint8Array;
  constructor(
    readonly plan: CardPlan,
    pixels: Pixels,
  ) {
    this.cols = Math.max(1, Math.round(plan.card.w));
    this.rows = Math.max(1, Math.round(plan.card.h));
    this.busy = new Float32Array(this.cols * this.rows);
    this.ground = new Uint8Array(this.cols * this.rows).fill(1);
    const c = plan.cover;
    const gc = Math.max(1, Math.round(c.w));
    const gr = Math.max(1, Math.round(c.h));
    const busy = busyGrid(pixels, gc, gr);
    const means = meanGrid(pixels, gc, gr);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const u = (x + 0.5 - c.x) / c.w;
        const v = (y + 0.5 - c.y) / c.h;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const k = Math.min(gr - 1, Math.floor(v * gr)) * gc + Math.min(gc - 1, Math.floor(u * gc));
        this.busy[y * this.cols + x] = busy[k];
        this.ground[y * this.cols + x] = busy[k] < 4 && colorDistance(means[k], plan.ground) < 30 ? 1 : 0;
      }
    }
  }
  private cells(r: MmRect, fn: (i: number) => void) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(this.cols, Math.ceil(r.x + r.w));
    const y1 = Math.min(this.rows, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) fn(y * this.cols + x);
  }
  /** Share of the cells in `r` that are plain ground. */
  groundShare(r: MmRect): number {
    let n = 0;
    let g = 0;
    this.cells(r, (i) => {
      n++;
      g += this.ground[i];
    });
    return n ? g / n : 0;
  }
  meanBusy(r: MmRect): number {
    let n = 0;
    let s = 0;
    this.cells(r, (i) => {
      n++;
      s += this.ground[i] ? 0 : Math.max(this.busy[i], 6);
    });
    return n ? s / n : 99;
  }
  clear(r: MmRect) {
    this.cells(r, (i) => {
      this.busy[i] = 0;
      this.ground[i] = 1;
    });
  }
  fill(r: MmRect) {
    this.cells(r, (i) => {
      this.busy[i] = Math.max(this.busy[i], 12);
      this.ground[i] = 0;
    });
  }
  /** The largest empty rectangle, as a share of the card. */
  largestEmpty(): { share: number; rect: MmRect } {
    const best = largestRect(this.ground, this.cols, this.rows);
    return { share: best.area / (this.cols * this.rows), rect: { x: best.x, y: best.y, w: best.w, h: best.h } };
  }
}

/** Mean colour of each cell of a grid. */
function meanGrid(p: Pixels, cols: number, rows: number): RGB[] {
  const sum = new Float64Array(cols * rows * 3);
  const n = new Float64Array(cols * rows);
  for (let y = 0; y < p.height; y++) {
    const cy = Math.min(rows - 1, Math.floor((y * rows) / p.height));
    for (let x = 0; x < p.width; x++) {
      const cx = Math.min(cols - 1, Math.floor((x * cols) / p.width));
      const k = cy * cols + cx;
      const o = (y * p.width + x) * 4;
      sum[k * 3] += p.data[o];
      sum[k * 3 + 1] += p.data[o + 1];
      sum[k * 3 + 2] += p.data[o + 2];
      n[k]++;
    }
  }
  const out: RGB[] = [];
  for (let k = 0; k < cols * rows; k++) {
    const m = n[k] || 1;
    out.push({ r: sum[k * 3] / m, g: sum[k * 3 + 1] / m, b: sum[k * 3 + 2] / m });
  }
  return out;
}

/* ------------------------------------------------------------------ planning */

/** Size and place of the cover on the card for an anchor (0 = top/left … 1 = bottom/right). */
function placeCover(aspect: number, format: CardFormat, card: { w: number; h: number }, anchor: number): { cover: MmRect; gap: number } {
  if (format === 'hoch') {
    const w = card.w;
    const h = w * aspect;
    return { cover: { x: 0, y: (card.h - h) * anchor, w, h }, gap: card.h - h };
  }
  const h = card.h;
  const w = h / aspect;
  return { cover: { x: (card.w - w) * anchor, y: 0, w, h }, gap: card.w - w };
}

/** The sides of the cover that face the open space for an anchor. */
function openSides(format: CardFormat, anchor: number): Side[] {
  const [first, last]: Side[] = format === 'hoch' ? ['top', 'bottom'] : ['left', 'right'];
  if (anchor >= 0.999) return [first];
  if (anchor <= 0.001) return [last];
  return [first, last];
}

function base(input: PlanInput, form: CardPlan['form'], cover: MmRect, ground: RGB, grain: number): CardPlan {
  const { geometry: g, format, analysis: a } = input;
  return { form, format, card: { w: g.widthMm, h: g.heightMm }, cover, inner: a.inner, ground, grain, seams: [], moves: [], copies: [], texts: [], problems: [] };
}

/** Resolution of the cover where it is drawn, in dpi. */
function coverDpi(input: PlanInput, cover: MmRect): number {
  const srcW = input.sourceSize.width * input.analysis.inner[2];
  return srcW / (cover.w / MM_PER_INCH);
}

/**
 * The plan for a card. Tries the form the recipe asks for; when the check
 * finds a blocking problem, the safe form, with the problems kept in
 * `simplified`.
 */
export function planCard(input: PlanInput): CardPlan {
  const form: CardForm = input.layout.form ?? 'auto';
  const wantsParts = !!input.layout.teile?.length;
  if (form === 'verlaengern' || (form === 'auto' && wantsParts)) {
    const plan = planExtended(input);
    if (plan && !plan.problems.some((p) => p.blocking)) return plan;
    const safe = planSafe(input);
    safe.simplified = plan?.problems.filter((p) => p.blocking) ?? [{ code: 'kopierspuren', text: 'Kein Rand ist einfarbig, verlängern ginge nur mit erfundenem Muster.', blocking: true }];
    return safe;
  }
  return planSafe(input);
}

/** The cover fills the card, a flat edge colour runs on, real parts fill the space. Null when no edge is flat. */
export function planExtended(input: PlanInput): CardPlan | null {
  const { analysis: a, layout, format, geometry: g } = input;
  const card = { w: g.widthMm, h: g.heightMm };
  const aspect = a.pixels.height / a.pixels.width;
  // Where the open space may be: a flat edge, preferring the top (left) for "auto".
  let anchor: number;
  if (typeof layout.anker === 'number') anchor = layout.anker;
  else {
    const [first, last]: Side[] = format === 'hoch' ? ['top', 'bottom'] : ['left', 'right'];
    if (a.edges[first].flat) anchor = 1;
    else if (a.edges[last].flat) anchor = 0;
    else return null;
  }
  const { cover, gap } = placeCover(aspect, format, card, anchor);
  if (gap <= 0) return null;
  const sides = openSides(format, anchor);
  const edges = sides.map((s) => a.edges[s]);
  const ground = edges[0].color;
  const plan = base(input, 'verlaengern', cover, ground, Math.max(...edges.map((e) => e.grain)));
  plan.seams = sides;
  const problems = plan.problems;
  // (b) Only flat colour runs on.
  for (const s of sides) {
    if (!a.edges[s].flat) problems.push({ code: 'kopierspuren', text: `Der Rand ${sideName(s)} ist nicht einfarbig: verlängert sähe man ein erfundenes Muster.`, blocking: true });
  }
  if (edges.length === 2 && colorDistance(edges[0].color, edges[1].color) > 20) {
    problems.push({ code: 'kopierspuren', text: 'Die beiden Ränder haben verschiedene Farben.', blocking: true });
  }
  const occ = new Occupancy(plan, a.pixels);
  const safeBox: MmRect = { x: g.cutMm, y: g.cutMm, w: card.w - 2 * g.cutMm, h: card.h - 2 * g.cutMm };
  const srcPx = { w: input.sourceSize.width * a.inner[2], h: input.sourceSize.height * a.inner[3] };

  // Text zones: those inside a moved part move with it.
  const texts = (layout.texte ?? []).map((t) => ({ frac: t, at: fracOnCover(cover, t) }));
  const parts = layout.teile ?? [];
  // First lift every moved part off (its place becomes plain ground), then put them down.
  const moves: MovePlan[] = [];
  for (const p of parts) {
    if (p.tun !== 'versetzen' || !p.ziel) continue;
    const label = p.name ? `„${p.name}“` : 'Ein Teil';
    const gr = groundAround(a.pixels, p.quelle, p.maske);
    if (!gr.plain) problems.push({ code: 'kopierspuren', text: `${label} liegt nicht auf einfarbigem Grund: die Lücke müsste erfunden werden.`, blocking: true });
    else if (colorDistance(gr.color, ground) > 28) problems.push({ code: 'kopierspuren', text: `${label} liegt auf einer anderen Farbe als der verlängerte Rand.`, blocking: true });
    const aspectPart = (p.quelle[3] * srcPx.h) / (p.quelle[2] * srcPx.w);
    const w = p.ziel[2] * card.w;
    const dst: MmRect = { x: p.ziel[0] * card.w, y: p.ziel[1] * card.h, w, h: w * aspectPart };
    moves.push({ name: p.name, src: p.quelle, shape: p.maske, dst, ground: gr.color });
    occ.clear(fracOnCover(cover, p.quelle));
    // (c) Enough pixels for its new size.
    const dpi = (p.quelle[2] * srcPx.w) / (dst.w / MM_PER_INCH);
    if (dpi < MIN_DPI) problems.push({ code: 'aufloesung', text: `${label} wäre zu groß für seine Auflösung (${Math.round(dpi)} dpi).`, blocking: true });
    // (a) Nothing of it cut.
    if (!inside(dst, safeBox)) problems.push({ code: 'angeschnitten', text: `${label} ragt an den Rand der Karte.`, blocking: true });
  }
  // (b) Each lands on plain ground, not on other parts of the picture or on each other.
  moves.forEach((m, i) => {
    const label = m.name ? `„${m.name}“` : 'Ein Teil';
    if (occ.groundShare(m.dst) < 0.9) problems.push({ code: 'kopierspuren', text: `${label} käme auf andere Teile des Bildes.`, blocking: true });
    if (moves.some((o, j) => j < i && overlaps(o.dst, m.dst))) problems.push({ code: 'kopierspuren', text: `${label} läge auf einem anderen Teil.`, blocking: true });
  });
  for (const m of moves) occ.fill(m.dst);
  plan.moves = moves;
  // (a) Text and logos of the cover stay whole: moved ones inside the safe area; the others
  // stay where the cover itself has them, so only the card's edge may not cut them.
  const cardBox: MmRect = { x: 0, y: 0, w: card.w, h: card.h };
  plan.texts = texts.map(({ frac, at }) => {
    const m = moves.find((mv) => containsFrac(mv.src, frac));
    if (!m) {
      if (!inside(at, cardBox, 0.3)) problems.push({ code: 'angeschnitten', text: 'Ein Text des Covers käme an den Rand.', blocking: true });
      return at;
    }
    const sx = m.dst.w / m.src[2];
    const sy = m.dst.h / m.src[3];
    const t = { x: m.dst.x + (frac[0] - m.src[0]) * sx, y: m.dst.y + (frac[1] - m.src[1]) * sy, w: frac[2] * sx, h: frac[3] * sy };
    if (!inside(t, safeBox)) problems.push({ code: 'angeschnitten', text: 'Ein versetzter Text käme an den Rand.', blocking: true });
    return t;
  });

  // Small things copied into the empty space.
  for (const p of parts) {
    if (p.tun !== 'kopieren') continue;
    const label = p.name ? `„${p.name}“` : 'Ein Teil';
    const gr = groundAround(a.pixels, p.quelle, p.maske);
    const size = fracOnCover(cover, p.quelle);
    if (!gr.plain || colorDistance(gr.color, ground) > 28) {
      problems.push({ code: 'kopierspuren', text: `${label} liegt nicht auf einfarbigem Grund und wird nicht kopiert.`, blocking: true });
      continue;
    }
    if (size.w * size.h > MAX_COPY_AREA * card.w * card.h) {
      problems.push({ code: 'kopierspuren', text: `${label} ist zu groß zum Kopieren; große Teile werden versetzt.`, blocking: true });
      continue;
    }
    const dsts = scatter(occ, size, Math.min(MAX_COPIES, p.anzahl ?? 3), safeBox, input.seed ?? 1);
    for (const d of dsts) occ.fill(d);
    plan.copies.push({ name: p.name, src: p.quelle, shape: p.maske, dsts, ground: gr.color });
  }
  // (b) Copies apart and never in a row.
  const all = plan.copies.flatMap((c) => c.dsts);
  if (copiesTouch(all)) problems.push({ code: 'kopierspuren', text: 'Kopien berühren sich.', blocking: true });
  if (inARow(all)) problems.push({ code: 'kopierspuren', text: 'Kopien stehen in einer Reihe.', blocking: true });

  // The number in the quietest place that covers nothing.
  const number = numberText(layout.nummer, input.text);
  if (number) {
    const r = Math.min(card.w, card.h) * 0.12;
    const spot = quietSpot(occ, r, safeBox, [...plan.texts, ...moves.map((m) => m.dst)], layout);
    plan.badge = { cx: spot.cx, cy: spot.cy, r, text: number };
    if (spot.busy > BUSY_UNDER_NUMBER) problems.push({ code: 'nummer', text: 'Für die Nummer ist kein ruhiger Platz frei: sie läge auf Bild oder Schrift.', blocking: true });
    occ.fill(circleBox(spot.cx, spot.cy, r));
  }
  // (d) No big empty area left.
  const empty = occ.largestEmpty();
  if (empty.share > MAX_EMPTY) problems.push({ code: 'leer', text: `Eine leere Fläche nimmt ${Math.round(empty.share * 100)} % der Karte ein.`, blocking: true });
  // (c) The cover itself (no better in the safe form, so only a note).
  const dpi = coverDpi(input, cover);
  if (dpi < MIN_DPI) problems.push({ code: 'aufloesung', text: `Das Cover hat wenig Auflösung (${Math.round(dpi)} dpi).`, blocking: false });
  return plan;
}

function containsFrac(outer: Frac, f: Frac): boolean {
  const ix = Math.max(0, Math.min(outer[0] + outer[2], f[0] + f[2]) - Math.max(outer[0], f[0]));
  const iy = Math.max(0, Math.min(outer[1] + outer[3], f[1] + f[3]) - Math.max(outer[1], f[1]));
  return ix * iy >= 0.8 * f[2] * f[3];
}

function sideName(s: Side): string {
  return s === 'top' ? 'oben' : s === 'bottom' ? 'unten' : s === 'left' ? 'links' : 'rechts';
}

/** Places `n` copies of a part of size `size` on empty ground, spread out, slightly turned and sized. */
function scatter(occ: Occupancy, size: MmRect, n: number, box: MmRect, seed: number): (MmRect & { rot: number })[] {
  const rnd = seededRandom(seed * 7919 + Math.round(size.w * 100));
  const out: (MmRect & { rot: number })[] = [];
  for (let k = 0; k < n; k++) {
    let best: (MmRect & { rot: number }) | null = null;
    let bestScore = -1;
    for (let t = 0; t < 160; t++) {
      const s = 0.75 + rnd() * 0.4;
      const w = size.w * s;
      const h = size.h * s;
      const x = box.x + rnd() * (box.w - w);
      const y = box.y + rnd() * (box.h - h);
      const r: MmRect & { rot: number } = { x, y, w, h, rot: (rnd() - 0.5) * 50 };
      const margin = Math.max(1.5, Math.max(w, h) * 0.6);
      if (occ.groundShare({ x: x - margin, y: y - margin, w: w + 2 * margin, h: h + 2 * margin }) < 0.999) continue;
      const near = out.length ? Math.min(...out.map((o) => Math.hypot(o.x + o.w / 2 - x - w / 2, o.y + o.h / 2 - y - h / 2))) : 50;
      if (near < Math.max(w, h) * 2.5 + 2) continue;
      if (inARow([...out, r])) continue;
      const score = near + rnd() * 4;
      if (score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (!best) break;
    out.push(best);
    occ.fill(best);
  }
  return out;
}

function copiesTouch(c: readonly MmRect[]): boolean {
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) if (overlaps(c[i], c[j], 1)) return true;
  return false;
}

/** Three or more copies nearly on one straight line, evenly or not: a row the eye sees at once. */
export function inARow(c: readonly MmRect[]): boolean {
  const p = c.map((r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 }));
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      for (let k = j + 1; k < p.length; k++) {
        const area = Math.abs((p[j].x - p[i].x) * (p[k].y - p[i].y) - (p[k].x - p[i].x) * (p[j].y - p[i].y)) / 2;
        const longest = Math.max(Math.hypot(p[j].x - p[i].x, p[j].y - p[i].y), Math.hypot(p[k].x - p[i].x, p[k].y - p[i].y), Math.hypot(p[k].x - p[j].x, p[k].y - p[j].y));
        // Height of the triangle over its longest side, against that side.
        if (longest > 0 && (2 * area) / longest < longest * 0.12) return true;
      }
    }
  }
  return false;
}

/** The quietest place for the number: corners first, then the middle of the sides; never on text or moved parts. */
function quietSpot(occ: Occupancy, r: number, box: MmRect, avoid: readonly MmRect[], layout: LayoutSpec): { cx: number; cy: number; busy: number } {
  const x0 = box.x + r + 0.5;
  const x1 = box.x + box.w - r - 0.5;
  const y0 = box.y + r + 0.5;
  const y1 = box.y + box.h - r - 0.5;
  const ym = (y0 + y1) / 2;
  const xm = (x0 + x1) / 2;
  const spots = [
    { cx: x1, cy: y1, bias: 0 },
    { cx: x0, cy: y1, bias: 0.3 },
    { cx: x1, cy: y0, bias: 0.3 },
    { cx: x0, cy: y0, bias: 0.5 },
    { cx: x1, cy: ym, bias: 1 },
    { cx: x0, cy: ym, bias: 1 },
    { cx: xm, cy: y1, bias: 1.2 },
    { cx: xm, cy: y0, bias: 1.2 },
  ];
  if (layout.nummerOrt) spots.unshift({ cx: layout.nummerOrt[0] * occ.plan.card.w, cy: layout.nummerOrt[1] * occ.plan.card.h, bias: -10 });
  let best = { cx: spots[0].cx, cy: spots[0].cy, busy: 99 };
  let bestScore = Infinity;
  for (const s of spots) {
    const c = circleBox(s.cx, s.cy, r);
    const hits = avoid.some((a) => overlaps(a, c, 0.5));
    const busy = hits ? 99 : occ.meanBusy(c);
    const score = busy + s.bias;
    if (score < bestScore) {
      bestScore = score;
      best = { cx: s.cx, cy: s.cy, busy };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ the safe form */

/** The whole cover next to a flat colour panel with number and title. Always possible. */
export function planSafe(input: PlanInput): CardPlan {
  const { analysis: a, layout, format, geometry: g } = input;
  const card = { w: g.widthMm, h: g.heightMm };
  const aspect = a.pixels.height / a.pixels.width;
  const long = format === 'hoch' ? card.h : card.w;
  const [first, last]: Side[] = format === 'hoch' ? ['top', 'bottom'] : ['left', 'right'];
  // The panel goes where an edge is flat (then it is that very colour, seamless); else after the cover (below, right).
  let anchor: number;
  if (typeof layout.anker === 'number') anchor = layout.anker;
  else anchor = a.edges[last].flat && !a.edges[first].flat ? 0 : a.edges[first].flat && !a.edges[last].flat ? 1 : 0;
  let { cover, gap } = placeCover(aspect, format, card, anchor);
  const open = openSides(format, anchor);
  // Nearly the shape of the card: filled, cut a little at both ends.
  if (Math.abs(gap) <= FILL_SLACK * long) {
    const s = Math.max(card.w / cover.w, card.h / cover.h);
    const w = cover.w * s;
    const h = cover.h * s;
    cover = { x: (card.w - w) / 2, y: (card.h - h) / 2, w, h };
    const plan = base(input, 'fuellen', cover, a.panel, 0);
    plan.texts = (layout.texte ?? []).map((t) => fracOnCover(cover, t));
    const box: MmRect = { x: g.cutMm, y: g.cutMm, w: card.w - 2 * g.cutMm, h: card.h - 2 * g.cutMm };
    for (const t of plan.texts) if (!inside(t, { x: 0, y: 0, w: card.w, h: card.h }, 0.3)) plan.problems.push({ code: 'angeschnitten', text: 'Ein Text des Covers käme an den Rand.', blocking: false });
    const number = numberText(layout.nummer, input.text);
    if (number) {
      const occ = new Occupancy(plan, a.pixels);
      const r = Math.min(card.w, card.h) * 0.12;
      const spot = quietSpot(occ, r, box, plan.texts, layout);
      plan.badge = { cx: spot.cx, cy: spot.cy, r, text: number };
      if (spot.busy > BUSY_UNDER_NUMBER) plan.problems.push({ code: 'nummer', text: 'Die Nummer liegt auf dem Bild.', blocking: false });
    }
    return plan;
  }
  if (gap < 0) {
    // Longer than the card (rare): the whole cover across the card, panels at the sides.
    const s = format === 'hoch' ? card.h / cover.h : card.w / cover.w;
    cover = { x: (card.w - cover.w * s) / 2, y: (card.h - cover.h * s) / 2, w: cover.w * s, h: cover.h * s };
  }
  // The panel colour: given, the printed frame, the flat edge it continues, or from the cover.
  const edge = gap > 0 && open.length === 1 ? a.edges[open[0]] : undefined;
  let color: RGB;
  let seamless = false;
  if (layout.farbe && /^#[0-9a-f]{6}$/i.test(layout.farbe)) color = hexToRgb(layout.farbe);
  else if (layout.farbe === 'rahmen' && a.frame) color = a.frame.color;
  else if (edge?.flat) {
    color = edge.color;
    seamless = true;
  } else color = a.frame?.color ?? a.panel;
  const plan = base(input, 'farbfeld', cover, color, seamless ? edge!.grain : 0);
  if (seamless) plan.seams = open;
  plan.texts = (layout.texte ?? []).map((t) => fracOnCover(cover, t));
  const dpi = coverDpi(input, cover);
  if (dpi < MIN_DPI) plan.problems.push({ code: 'aufloesung', text: `Das Cover hat wenig Auflösung (${Math.round(dpi)} dpi).`, blocking: false });
  if (gap <= 0) return plan;
  const panel: MmRect =
    format === 'hoch'
      ? { x: 0, y: anchor > 0.5 ? 0 : cover.y + cover.h, w: card.w, h: gap }
      : { x: anchor > 0.5 ? 0 : cover.x + cover.w, y: 0, w: gap, h: card.h };
  plan.panel = panel;
  const number = numberText(layout.nummer, input.text);
  const wantTitle = layout.titel !== false && !!input.text.title.trim();
  const font = layout.schrift ?? 'round';
  const ink = bestTextColor(color);
  const pad = Math.max(g.cutMm, 2.2);
  if (format === 'hoch') {
    const inner = { x: pad, y: panel.y + (anchor > 0.5 ? pad : 1.8), w: card.w - 2 * pad, h: panel.h - pad - 1.8 };
    if (inner.h < 4) return plan;
    let titleRight = inner.x + inner.w;
    if (number) {
      const r = Math.min(wantTitle ? card.w * 0.13 : card.w * 0.17, inner.h * 0.46);
      const cx = wantTitle ? inner.x + inner.w - r : card.w / 2;
      plan.badge = { cx, cy: inner.y + inner.h / 2, r, text: number };
      titleRight = cx - r - 2.5;
    }
    if (wantTitle && titleRight - inner.x > 12 && inner.h >= 7) {
      plan.title = { box: { x: inner.x, y: inner.y, w: titleRight - inner.x, h: inner.h }, text: input.text.title, subtitle: input.text.subtitle, font, ink };
    }
  } else {
    const inner = { x: panel.x + (anchor > 0.5 ? pad : 1.8), y: pad, w: panel.w - pad - 1.8, h: card.h - 2 * pad };
    if (inner.w < 4) return plan;
    let titleBottom = inner.y + inner.h;
    if (number) {
      const r = Math.min(wantTitle ? card.h * 0.15 : card.h * 0.2, inner.w * 0.46);
      const cy = wantTitle ? inner.y + inner.h - r : card.h / 2;
      plan.badge = { cx: inner.x + inner.w / 2, cy, r, text: number };
      titleBottom = cy - r - 2.5;
    }
    if (wantTitle && titleBottom - inner.y > 8 && inner.w >= 12) {
      plan.title = { box: { x: inner.x, y: inner.y, w: inner.w, h: titleBottom - inner.y }, text: input.text.title, subtitle: input.text.subtitle, font, ink };
    }
  }
  return plan;
}

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
