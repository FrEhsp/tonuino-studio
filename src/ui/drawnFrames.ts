/**
 * Holz: the frames look drawn with a pen. Each framed box (FRAMED) has a
 * layer on ::before (the edge of the sidebar on ::after) that carries its
 * line as a plain CSS border; here that line is replaced by a pen stroke:
 *
 * - every side is one slightly bowed stroke, thin at its ends and thicker
 *   in the middle, as a pen is pressed harder in the middle of a line;
 * - small corners are not rounded off: the strokes meet there, and on at
 *   most two corners of a box one of them runs a little past the other;
 * - larger rounded corners are drawn as arcs;
 * - dashed lines become straight dashes of uneven length.
 *
 * The stroke is a filled shape, used as clip-path of the layer, whose
 * background is the line colour. The shape is made in JS from the size of
 * the box, its line and corners, and a seed (the same box always looks the
 * same), synchronously in the ResizeObserver callback: that runs after
 * layout and before the browser paints, so a box shows with its finished
 * frame in its very first frame. Colours stay in the CSS, so hover and
 * focus cost nothing here. No SVG filter runs on any frame any more: those
 * were slow to repaint (above all in the Linux app) and their fine,
 * even wobble looked like a picture filter rather than a drawing.
 */
import { stil } from './stil';

/**
 * The boxes with a drawn frame (stil-holz.css). One missing here keeps its plain straight line.
 * Only buttons and menu entries that carry a frame layer are named: a quiet button (ghost,
 * soft) has none, and watching the two of them on every row of a long track list cost
 * time while it scrolled.
 */
const FRAMED =
  ".card, .dialog, .choice, .trouble, .menu, .segmented, .dropzone, .bubble, .shelf, .tile-cover, .feature, .health-banner, .sd-status, .import-bar, .style-choice, .font-choice, .paper-option, .ws-tool, .help-topic-card, .source-card, .source-pick, .picks-teaser, .qr-block, .guide, .page > .package-gate, .btn:not(.ghost, .soft), .dialog-foot .btn, .nav a[aria-current='page'], .sidebar";
const PSEUDOS = ['before', 'after'] as const;
type Pseudo = (typeof PSEUDOS)[number];

/**
 * WebKit (the Linux app, Safari) mixes up the layers' shapes when they take
 * them with `inherit` from a property that is not inherited (stil-holz.css):
 * a layer showed the frame of another box, a narrow one on a wide card. There
 * the shape goes into a plain custom property, which the layer inherits the
 * ordinary way, as up to 0.2.2.
 */
const PLAIN = typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR/.test(navigator.userAgent);
const prop = (p: Pseudo) => (PLAIN ? `--fcw-${p}` : `--fc-${p}`);

/** How far the frame layer reaches beyond its plain box on each side, for bows and overshoots (stil-holz.css). */
export const FRAME_PAD = 6;

/* ------------------------------------------------------------------ shapes */

/** Small, fast, seeded random numbers (mulberry32). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const n = (v: number) => +v.toFixed(1);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Pt = [number, number];

/** A point of a pen line: where its middle runs and how wide it is there. */
interface Ink {
  x: number;
  y: number;
  w: number;
}

/**
 * The outline of a pen line through `pts` as one closed shape: each point
 * pushed out by half its width to both sides, joined by smooth curves, with
 * round ends where the line is open.
 */
export function outline(pts: Ink[], closed = false): string {
  if (pts.length < 2) return '';
  const m = pts.length;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < m; i++) {
    const a = pts[closed ? (i - 1 + m) % m : Math.max(0, i - 1)];
    const b = pts[closed ? (i + 1) % m : Math.min(m - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const h = pts[i].w / 2;
    left.push([pts[i].x + (dy / len) * h, pts[i].y - (dx / len) * h]);
    right.push([pts[i].x - (dy / len) * h, pts[i].y + (dx / len) * h]);
  }
  const p = (q: Pt) => `${n(q[0])} ${n(q[1])}`;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // Smooth: straight to the middle of the first piece, then curves through the middles, each point a control point.
  const smooth = (side: Pt[], loop: boolean) => {
    let d = '';
    const k = side.length;
    const last = loop ? k : k - 1;
    for (let i = 1; i < last; i++) d += `Q${p(side[i])} ${p(mid(side[i], side[(i + 1) % k]))}`;
    return d;
  };
  if (closed) {
    // A closed line: the outer and the inner edge as two rings (even-odd leaves the inside open).
    const ring = (side: Pt[]) => `M${p(mid(side[0], side[1]))}${smooth([...side.slice(1), side[0]], true)}Z`;
    return ring(left) + ring(right.reverse());
  }
  // A round end: a curve around the end point, a little past it, to the other edge.
  const end = (a: Ink, b: Ink, to: Pt) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const len = Math.hypot(dx, dy) || 1;
    const h = a.w / 2;
    return `Q${n(a.x + (dx / len) * h * 1.3)} ${n(a.y + (dy / len) * h * 1.3)} ${p(to)}`;
  };
  let d = `M${p(left[0])}L${p(mid(left[0], left[1]))}${smooth(left, false)}L${p(left[m - 1])}`;
  d += end(pts[m - 1], pts[m - 2], right[m - 1]);
  const r = right.slice().reverse();
  d += `L${p(mid(r[0], r[1]))}${smooth(r, false)}L${p(r[m - 1])}`;
  d += end(pts[0], pts[1], left[0]);
  return d + 'Z';
}

/**
 * Points along a straight side from a to b as a hand draws it: one gentle
 * bow (`bow` px off the middle, to the left of the direction of travel when
 * positive) and on long sides one slow wave of under a pixel per ~400 px.
 * `width(t)` gives the line width along the way (t from 0 to 1).
 */
function side(a: Pt, b: Pt, bow: number, wave: number, phase: number, width: (t: number) => number, step = 10): Ink[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = dy / len;
  const ny = -dx / len;
  const count = Math.max(2, Math.ceil(len / step));
  const waves = Math.max(1, Math.round(len / 400));
  const out: Ink[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const off = bow * 4 * t * (1 - t) + wave * Math.sin(Math.PI * t) * Math.sin(2 * Math.PI * waves * t + phase);
    out.push({ x: a[0] + dx * t + nx * off, y: a[1] + dy * t + ny * off, w: width(t) });
  }
  return out;
}

export interface RingSpec {
  /** Size of the plain frame layer (its border box), in px. */
  width: number;
  height: number;
  /** Line width. */
  line: number;
  /** Corner radii (outer, as CSS), clockwise from top left, [x, y]. */
  radii: [number, number][];
  dashed: boolean;
  seed: number;
}

/** Up to this radius corners are drawn as two strokes meeting; above it the line goes round. */
const SHARP = 4;

/** How the pen presses along one side: thin at both ends, fullest in the middle. */
const press = (w0: number, k: number, start = 1) => (t: number) => w0 * k * (0.7 + 0.45 * Math.sin(Math.PI * t)) * (t < 0.12 ? start + (1 - start) * (t / 0.12) : 1);

/**
 * The frame as a path in the coordinates of the frame layer, which reaches
 * FRAME_PAD beyond the plain box on every side.
 */
export function ringPath(s: RingSpec): string {
  const rnd = random(s.seed);
  const r = (lo: number, hi: number) => lo + rnd() * (hi - lo);
  const P = FRAME_PAD;
  const h = s.line / 2;
  // The middle of the line, as a CSS border draws it.
  const x0 = P + h;
  const y0 = P + h;
  const x1 = P + s.width - h;
  const y1 = P + s.height - h;
  const W = x1 - x0;
  const H = y1 - y0;
  if (W <= 0 || H <= 0) return '';
  const rad = s.radii.map(([rx, ry]) => [Math.min(Math.max(0, rx - h), W / 2), Math.min(Math.max(0, ry - h), H / 2)] as Pt);
  if (s.dashed) return dashes(s, rad, x0, y0, W, H, rnd);

  // Small things (buttons, fields) get calmer lines and no corners that run on.
  const small = s.height < 48 || s.width < 120 || s.line < 2;
  // Bows mostly outward: bowing in, the line would uncover the paper's edge underneath.
  const bowOf = (len: number) => {
    const a = clamp(len * 0.005, 0.6, 3.5) * r(0.5, 1);
    return rnd() < 0.7 ? a : -Math.min(a, h * 0.6);
  };
  const waveOf = (len: number) => (len > 300 ? r(0.4, 0.9) : 0);
  const sharp = rad.every(([rx, ry]) => Math.max(rx, ry) <= SHARP);

  if (sharp) {
    const corners: Pt[] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    // How far each side's stroke reaches past its start and end corner.
    const past: [number, number][] = [0, 1, 2, 3].map(() => [h, h]);
    if (!small) {
      const order = [0, 1, 2, 3].sort(() => rnd() - 0.5);
      for (const c of order.slice(0, rnd() < 0.35 ? 1 : 2)) {
        // Corner c ends side c-1 and starts side c: one of them runs on.
        if (rnd() < 0.5) past[(c + 3) % 4][1] = h + r(2, 4);
        else past[c][0] = h + r(2, 4);
      }
    }
    const parts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ux = (b[0] - a[0]) / len;
      const uy = (b[1] - a[1]) / len;
      const jit = () => (small ? r(-0.5, 0.5) : r(-1, 1));
      const A: Pt = [a[0] - ux * past[i][0] + uy * jit(), a[1] - uy * past[i][0] - ux * jit()];
      const B: Pt = [b[0] + ux * past[i][1] + uy * jit(), b[1] + uy * past[i][1] - ux * jit()];
      // Clockwise, the outside is to the left.
      parts.push(outline(side(A, B, bowOf(len), waveOf(len), r(0, 6.28), press(s.line, r(0.9, 1.1), 0.85))));
    }
    return parts.join('');
  }

  // Rounded corners: one line all around, its sides bowed, thinner in the corners,
  // starting somewhere on the top and running a little past its start at the end.
  const [tl, tr, br, bl] = rad;
  const corner = (c: Pt, rx: number, ry: number, q: number, w: number): Ink[] => {
    const steps = Math.max(2, Math.ceil(Math.max(rx, ry) / 3));
    const out: Ink[] = [];
    for (let k = 1; k < steps; k++) {
      const ang = ((q + k / steps) * Math.PI) / 2;
      out.push({ x: c[0] + Math.cos(ang) * rx, y: c[1] + Math.sin(ang) * ry, w });
    }
    return out;
  };
  const ends = s.line * 0.75;
  const sideAt = (a: Pt, b: Pt) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1) return [{ x: a[0], y: a[1], w: ends }];
    const k = r(0.9, 1.1);
    return side(a, b, bowOf(len) * 0.7, waveOf(len), r(0, 6.28), (t) => ends + (s.line * k * 1.25 - ends) * Math.sin(Math.PI * t));
  };
  const pts: Ink[] = [
    ...sideAt([x0 + tl[0], y0], [x1 - tr[0], y0]),
    ...corner([x1 - tr[0], y0 + tr[1]], tr[0], tr[1], 3, ends),
    ...sideAt([x1, y0 + tr[1]], [x1, y1 - br[1]]),
    ...corner([x1 - br[0], y1 - br[1]], br[0], br[1], 0, ends),
    ...sideAt([x1 - br[0], y1], [x0 + bl[0], y1]),
    ...corner([x0 + bl[0], y1 - bl[1]], bl[0], bl[1], 1, ends),
    ...sideAt([x0, y1 - bl[1]], [x0, y0 + tl[1]]),
    ...corner([x0 + tl[0], y0 + tl[1]], tl[0], tl[1], 2, ends),
  ];
  if (small || pts.length < 12) return outline(pts, true);
  // Start the pen on the top side and let it run past the start, a hair off the first line.
  const topCount = Math.max(2, Math.ceil((W - tl[0] - tr[0]) / 10));
  const at = 1 + Math.floor(r(0.15, 0.6) * (topCount - 1));
  const loop = [...pts.slice(at), ...pts.slice(0, at)];
  const over = Math.min(loop.length - 2, Math.round(r(2, 4)));
  const shift = r(0.6, 1.2);
  const tail = pts.slice(at, at + over + 1).map((q, i) => ({ x: q.x, y: q.y - shift * ((i + 1) / (over + 1)), w: q.w * (1 - (0.4 * i) / (over + 1)) }));
  const open = [...loop, ...tail];
  open[0] = { ...open[0], w: open[0].w * 0.8 };
  return outline(open);
}

/** A dashed frame: straight dashes of uneven length along the rounded box, like drawn one by one. */
function dashes(s: RingSpec, rad: Pt[], x0: number, y0: number, W: number, H: number, rnd: () => number): string {
  // The middle line of the box as straight pieces (corners in a few short steps).
  const pts: Pt[] = [];
  const corner = (cx: number, cy: number, rx: number, ry: number, q: number) => {
    for (let k = 0; k <= 4; k++) {
      const ang = ((q + k / 4) * Math.PI) / 2;
      pts.push([cx + Math.cos(ang) * rx, cy + Math.sin(ang) * ry]);
    }
  };
  const [tl, tr, br, bl] = rad.map(([rx, ry]) => [Math.min(rx, W / 2), Math.min(ry, H / 2)] as Pt);
  corner(x0 + tl[0], y0 + tl[1], tl[0], tl[1], 2);
  corner(x0 + W - tr[0], y0 + tr[1], tr[0], tr[1], 3);
  corner(x0 + W - br[0], y0 + H - br[1], br[0], br[1], 0);
  corner(x0 + bl[0], y0 + H - bl[1], bl[0], bl[1], 1);
  pts.push(pts[0]);
  const seg: number[] = [0];
  for (let i = 1; i < pts.length; i++) seg.push(seg[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = seg[seg.length - 1];
  const at = (d: number): Pt => {
    let i = 1;
    while (i < seg.length - 1 && seg[i] < d) i++;
    const t = (d - seg[i - 1]) / (seg[i] - seg[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  const parts: string[] = [];
  const scale = clamp(s.line / 2, 0.75, 1.25);
  let d = rnd() * 4;
  while (d < total - 3) {
    const len = Math.min((6 + rnd() * 5) * scale, total - d - 1);
    if (len > 2) parts.push(outline(side(at(d), at(d + len), 0, 0, 0, (t) => s.line * (0.85 + 0.15 * Math.sin(Math.PI * t)), 4)));
    d += len + (4 + rnd() * 2.5) * scale;
  }
  return parts.join('');
}

/** One drawn line along a side of the box (the edge of the sidebar's paper). */
export function edgePath(length: number, line: number, vertical: boolean, seed: number): string {
  const rnd = random(seed);
  const c = FRAME_PAD + 1;
  const r = (lo: number, hi: number) => lo + rnd() * (hi - lo);
  const bow = (rnd() < 0.5 ? -1 : 1) * clamp(length * 0.004, 0.6, 3);
  const width = press(line, 1);
  const wave = r(0.5, 1);
  return outline(vertical ? side([c, -4], [c, length + 4], bow, wave, rnd() * 6.28, width, 12) : side([-4, c], [length + 4, c], bow, wave, rnd() * 6.28, width, 12));
}

/* ------------------------------------------------------------------ boxes on the page */

const px = (v: string) => parseFloat(v) || 0;

function radius(v: string, w: number, h: number): [number, number] {
  const [a, b = a] = v.split(' ');
  const r = (s: string, of: number) => (s.endsWith('%') ? (px(s) / 100) * of : px(s));
  return [r(a, w), r(b, h)];
}

/** Shapes by everything they depend on; equal buttons share one. */
const paths = new Map<string, string>();
const PATHS_MAX = 600;

function cached(key: string, make: () => string): string {
  let p = paths.get(key);
  if (p === undefined) {
    if (paths.size >= PATHS_MAX) paths.clear();
    p = make();
    paths.set(key, p);
  }
  return p;
}

const seeds = new WeakMap<HTMLElement, Partial<Record<Pseudo, number>>>();

/**
 * The seed of a box's pen line: taken from its first size and then kept, so
 * a box that grows or shrinks (a hint appearing in a dialog, a resized
 * window) stretches its strokes instead of getting a whole new line, which
 * looked like flickering. Boxes of other sizes still get other lines.
 */
function seedOf(el: HTMLElement, p: Pseudo, first: string): number {
  const own = seeds.get(el) ?? {};
  let seed = own[p];
  if (seed === undefined) {
    seed = hash(first);
    own[p] = seed;
    seeds.set(el, own);
  }
  return seed;
}

/** The shape for one pseudo element, or null when it has no line this draws. */
function shapeFor(el: HTMLElement, p: Pseudo): string | null {
  const cs = getComputedStyle(el, `::${p}`);
  if (cs.content === 'none' || cs.content === 'normal' || cs.display === 'none') return null;
  const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px);
  const st = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  const sides = [0, 1, 2, 3].filter((i) => bw[i] > 0 && st[i] !== 'none' && st[i] !== 'hidden');
  const seedText = el.dataset.frameSeed ?? '';
  const drawn = el.hasAttribute(`data-fc-${p}`);

  if (sides.length === 1 && (sides[0] === 1 || sides[0] === 2)) {
    // The edge of the sidebar: one line along its right side, or its foot on narrow screens.
    const vertical = sides[0] === 1;
    const length = vertical ? el.clientHeight : el.clientWidth;
    const line = bw[sides[0]];
    const seed = seedOf(el, p, `e|${vertical}|${Math.round(length)}|${line}|${seedText}`);
    return cached(`e|${vertical}|${Math.round(length)}|${line}|${seed}`, () => edgePath(length, line, vertical, seed));
  }
  if (sides.length !== 4 || bw.some((v) => v !== bw[0]) || st.some((v) => v !== st[0])) return null;
  if (st[0] !== 'solid' && st[0] !== 'dashed') return null;

  let w = px(cs.width);
  let h = px(cs.height);
  if (cs.boxSizing !== 'border-box') {
    w += px(cs.paddingLeft) + px(cs.paddingRight) + bw[1] + bw[3];
    h += px(cs.paddingTop) + px(cs.paddingBottom) + bw[0] + bw[2];
  }
  // Once drawn, the layer reaches FRAME_PAD further on every side (stil-holz.css).
  if (drawn) {
    w -= 2 * FRAME_PAD;
    h -= 2 * FRAME_PAD;
  }
  if (!(w > 0 && h > 0)) return null;
  // The layer's corners follow the box (border-radius: inherit); once drawn, the layer's own are 0.
  const ec = getComputedStyle(el);
  const c = [ec.borderTopLeftRadius, ec.borderTopRightRadius, ec.borderBottomRightRadius, ec.borderBottomLeftRadius].map((v) => radius(v, w, h));
  // Too large radii shrink together, as the browser draws them.
  const f = Math.min(1, w / (c[0][0] + c[1][0] || 1), w / (c[3][0] + c[2][0] || 1), h / (c[0][1] + c[3][1] || 1), h / (c[1][1] + c[2][1] || 1));
  const radii = c.map(([x, y]) => [x * f, y * f] as [number, number]);
  const W = Math.round(w * 2) / 2;
  const H = Math.round(h * 2) / 2;
  const look = `${bw[0]}|${st[0]}|${radii.map((q) => q.map(n).join(',')).join(';')}`;
  const seed = seedOf(el, p, `r|${W}|${H}|${look}|${seedText}`);
  return cached(`r|${W}|${H}|${look}|${seed}`, () => ringPath({ width: W, height: H, line: bw[0], radii, dashed: st[0] === 'dashed', seed }));
}

/** The pen frame of a box's ::before layer as a path (in that layer's coordinates), or null. */
export function frameShape(el: HTMLElement): string | null {
  return shapeFor(el, 'before');
}

const current = new WeakMap<Element, Partial<Record<Pseudo, string>>>();
const tracked = new Set<HTMLElement>();
let resizeObs: ResizeObserver | null = null;
let mutationObs: MutationObserver | null = null;
let pending = new Set<HTMLElement>();
let frame = 0;
let running = false;

/** Only the sidebar draws a line on ::after (its edge, stil-holz.css); every other box only on ::before. */
const pseudosOf = (el: HTMLElement): readonly Pseudo[] => (el.classList.contains('sidebar') ? PSEUDOS : BEFORE);
const BEFORE: readonly Pseudo[] = ['before'];

type Measured = [HTMLElement, Partial<Record<Pseudo, string | null>>];

/** What each box's frame should be now: reads only, so the browser works out its styles once for all. */
function measure(els: Iterable<HTMLElement>): Measured[] {
  const out: Measured[] = [];
  for (const el of els) {
    if (!el.isConnected) {
      forget(el);
      continue;
    }
    // A page kept hidden (App.tsx) is looked at when it shows again (its slot's class changes, see start()):
    // measured while built ahead, its boxes made the shelf in front of it stutter.
    if (el.closest('.page-slot-hidden')) continue;
    const shapes: Partial<Record<Pseudo, string | null>> = {};
    for (const p of pseudosOf(el)) shapes[p] = shapeFor(el, p);
    out.push([el, shapes]);
  }
  return out;
}

/**
 * Sets the measured frames: writes only. Reading one box's style after
 * writing another's made the browser work out the styles again for each
 * box (a folder with a hundred titles took a moment to open).
 */
function commit(measured: Measured[]) {
  for (const [el, shapes] of measured) {
    const now = current.get(el) ?? {};
    for (const p of pseudosOf(el)) {
      const shape = shapes[p] ?? null;
      if (shape === (now[p] ?? null)) continue;
      if (shape) {
        el.style.setProperty(prop(p), `path('${shape}')`);
        el.setAttribute(`data-fc-${p}`, '');
        now[p] = shape;
      } else {
        clear(el, p);
        delete now[p];
      }
    }
    current.set(el, now);
  }
}

function apply(els: Iterable<HTMLElement>) {
  commit(measure(els));
}

function clear(el: HTMLElement, p: Pseudo) {
  el.removeAttribute(`data-fc-${p}`);
  el.style.removeProperty(prop(p));
}

function forget(el: HTMLElement) {
  tracked.delete(el);
  resizeObs?.unobserve(el);
  for (const p of PSEUDOS) clear(el, p);
  current.delete(el);
}

function track(el: Element) {
  if (!(el instanceof HTMLElement) || tracked.has(el)) return;
  tracked.add(el);
  // The first callback comes after the next layout, before that frame is painted.
  resizeObs?.observe(el);
}

function collect(root: Element) {
  if (root.matches(FRAMED)) track(root);
  root.querySelectorAll(FRAMED).forEach(track);
}

/**
 * Boxes whose class or state changed (their line may be wider now): looked
 * at again in the next animation frame, which still comes before that
 * frame is painted.
 */
function later(el: HTMLElement) {
  pending.add(el);
  if (!frame) {
    frame = requestAnimationFrame(() => {
      frame = 0;
      const batch = pending;
      pending = new Set();
      apply([...batch].filter((e) => tracked.has(e)));
    });
  }
}

function start() {
  if (running || typeof ResizeObserver === 'undefined') return;
  running = true;
  if (PLAIN) document.documentElement.setAttribute('data-fc-webkit', '');
  resizeObs = new ResizeObserver((entries) => apply(entries.map((e) => e.target as HTMLElement)));
  mutationObs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        r.addedNodes.forEach((node) => node instanceof Element && collect(node));
        r.removedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (tracked.has(node)) forget(node);
          node.querySelectorAll<HTMLElement>(FRAMED).forEach((e) => tracked.has(e) && forget(e));
        });
      } else if (r.target === document.documentElement) {
        tracked.forEach(later);
      } else if (r.target instanceof HTMLElement) {
        if (tracked.has(r.target)) later(r.target);
        else if (r.target.matches(FRAMED)) track(r.target);
        r.target.querySelectorAll<HTMLElement>(FRAMED).forEach((e) => tracked.has(e) && later(e));
      }
    }
  });
  mutationObs.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'aria-checked', 'aria-pressed', 'aria-selected', 'aria-current', 'aria-expanded', 'open', 'disabled'],
  });
  collect(document.documentElement);
}

function stop() {
  if (!running) return;
  running = false;
  document.documentElement.removeAttribute('data-fc-webkit');
  resizeObs?.disconnect();
  mutationObs?.disconnect();
  resizeObs = mutationObs = null;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  for (const el of [...tracked]) forget(el);
  pending.clear();
}

/** Runs while the Holz style is on (called from SketchDefs). */
export function syncDrawnFrames(): () => void {
  if (stil.value === 'holz') start();
  return stop;
}
