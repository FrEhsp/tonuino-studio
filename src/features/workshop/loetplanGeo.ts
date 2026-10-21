/**
 * Geometry of the Lötplan pictures (LoetplanSketch.tsx, LoetplanSchema.tsx):
 * wires as lists of points, the size of a label, where a label may go and
 * the check that no wire, pad or other label lies on top of a label.
 *
 * Every picture is first laid out as a "Szene" (pads, wires, labels) and
 * only then drawn, so the tests can check the same numbers the screen shows:
 * a pin name must always be free to read.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pad or pin: a circle nothing may cover a label with. */
export interface Kreis {
  x: number;
  y: number;
  r: number;
}

/** A wire as drawn: its points (wobble included) and its width with the dark edge. */
export interface Draht {
  key: string;
  pts: Pt[];
  breite: number;
}

export type Anker = 'start' | 'middle' | 'end';

/** A label as placed: its text, where it sits and the box it covers. */
export interface Etikett {
  key: string;
  txt: string;
  x: number;
  /** Baseline. */
  y: number;
  size: number;
  anchor: Anker;
  box: Rect;
  /** The part the label is printed on: its own area does not count as covering it. */
  auf?: Rect;
}

/* ------------------------------------------------------------------ text size */

/**
 * The width of a text in bold, on the generous side: wide enough for the
 * face the app uses for the print (Fira Sans Bold, measured: every label of
 * the pictures is at least 1.9 units wider here than in the font) and for the
 * usual fallbacks. The screenshots of the check measure the real width.
 */
export function textBreite(txt: string, size: number): number {
  let w = 0;
  for (const ch of txt) {
    if (ch === ' ') w += 0.3;
    else if (/[.,:;!|'’ıil]/.test(ch)) w += 0.34;
    else if (/[MWmw]/.test(ch)) w += 1.0;
    else if (/[A-ZÄÖÜ0-9+−<>=Ω]/.test(ch)) w += 0.82;
    else w += 0.66;
  }
  return w * size;
}

/** Room around a label: the plate behind it reaches this far beyond the letters. */
export const RAND = 2.5;

/** The box a text covers, plate included. */
export function textBox(x: number, y: number, txt: string, size: number, anchor: Anker, breite = textBreite(txt, size)): Rect {
  const w = breite + 2 * RAND;
  const left = anchor === 'start' ? x - RAND : anchor === 'end' ? x - w + RAND : x - w / 2;
  // Ascent of capitals about 0.76, descent about 0.22 of the size.
  return { x: left, y: y - size * 0.8 - RAND, w, h: size * 1.02 + 2 * RAND };
}

/* ------------------------------------------------------------------ wires */

const lerp = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** A cubic Bézier, sampled every few units. */
export function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, step = 3): Pt[] {
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const n = Math.max(2, Math.ceil(len / step));
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

/** An S-shaped wire between two pins that both face sideways. */
export function sKurve(a: Pt, b: Pt): Pt[] {
  const mx = (a.x + b.x) / 2;
  return bezier(a, { x: mx, y: a.y }, { x: mx, y: b.y }, b);
}

/** An S-shaped wire between two pins that both face up or down. */
export function sKurveV(a: Pt, b: Pt): Pt[] {
  const my = (a.y + b.y) / 2;
  return bezier(a, { x: a.x, y: my }, { x: b.x, y: my }, b);
}

/** A wire along straight runs with rounded bends. */
export function strecke(pts: Pt[], radius = 12, step = 3): Pt[] {
  if (pts.length < 3) return line(pts[0], pts[pts.length - 1], step);
  const out: Pt[] = [];
  let from = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i];
    const nx = pts[i + 1];
    const lin = Math.hypot(c.x - from.x, c.y - from.y);
    const lout = Math.hypot(nx.x - c.x, nx.y - c.y);
    const r = Math.min(radius, lin / 2, lout / 2);
    const a = lerp(c, from, lin ? r / lin : 0);
    const b = lerp(c, nx, lout ? r / lout : 0);
    out.push(...line(from, a, step).slice(out.length ? 1 : 0));
    // Quadratic bend through the corner.
    const n = Math.max(2, Math.ceil((2 * r) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      out.push({
        x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
        y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
      });
    }
    from = b;
  }
  out.push(...line(from, pts[pts.length - 1], step).slice(1));
  return out;
}

function line(a: Pt, b: Pt, step = 3): Pt[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push(lerp(a, b, k / n));
  return out;
}

/** A small seeded random: the same key always wobbles the same way. */
function random(key: string): () => number {
  let s = 2166136261;
  for (let i = 0; i < key.length; i++) s = Math.imul(s ^ key.charCodeAt(i), 16777619);
  s >>>= 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A wire drawn by hand: the points pushed sideways a little, smoothly, the
 * same way every time. The ends and the last bit before each end stay where
 * they are, so a wire meets its pad straight and never brushes the print
 * next to it.
 */
export function wackeln(pts: Pt[], amp: number, key: string): Pt[] {
  if (amp <= 0 || pts.length < 3) return pts;
  // Arc length along the wire.
  const s: number[] = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = s[s.length - 1];
  if (total < 40) return pts;
  // Random offsets at knots every ~34 units, smoothly in between.
  const rnd = random(key);
  const n = Math.max(2, Math.round(total / 34));
  const knots = Array.from({ length: n + 1 }, (_, k) => (k === 0 || k === n ? 0 : (rnd() - 0.5) * 2 * amp));
  const quiet = 14;
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    const f = (s[i] / total) * n;
    const k = Math.min(n - 1, Math.floor(f));
    const t = f - k;
    const smooth = t * t * (3 - 2 * t);
    let o = knots[k] + (knots[k + 1] - knots[k]) * smooth;
    // Fade out near the ends.
    const edge = Math.min(s[i], total - s[i]);
    if (edge < quiet * 2) o *= Math.max(0, (edge - quiet) / quiet);
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: p.x - (dy / l) * o, y: p.y + (dx / l) * o };
  });
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Points to an SVG path; dense enough that straight pieces between them look round. */
export function pfad(pts: Pt[]): string {
  let d = `M${r1(pts[0].x)},${r1(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += ` L${r1(pts[i].x)},${r1(pts[i].y)}`;
  return d;
}

/* ------------------------------------------------------------------ collisions */

export const ueberlappt = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function abstandPunktRect(p: Pt, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export const kreisTrifft = (k: Kreis, r: Rect, rand = 0.5) => abstandPunktRect(k, r) < k.r + rand;

export function drahtTrifft(d: Draht, r: Rect, rand = 0.5): boolean {
  const half = d.breite / 2 + rand;
  // Quick reject on the bounding box.
  for (let i = 0; i < d.pts.length; i++) {
    const p = d.pts[i];
    if (abstandPunktRect(p, r) < half) return true;
    // Between two samples farther apart than the margin, check the middle too.
    const q = d.pts[i + 1];
    if (q && Math.hypot(q.x - p.x, q.y - p.y) > half) {
      const steps = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / half);
      for (let k = 1; k < steps; k++) if (abstandPunktRect(lerp(p, q, k / steps), r) < half) return true;
    }
  }
  return false;
}

/** Everything a label must keep clear of. */
export interface Hindernisse {
  kreise: Kreis[];
  draehte: Draht[];
  etiketten: Etikett[];
  /** Areas labels must stay out of (parts drawn on top, notes). */
  flaechen: Rect[];
}

/** What a label touches, in words, empty when it is free to read. */
export function treffer(box: Rect, h: Hindernisse, eigen?: string, auf?: Rect): string[] {
  const out: string[] = [];
  h.kreise.forEach((k, i) => kreisTrifft(k, box) && out.push(`Lötpunkt ${i}`));
  h.draehte.forEach((d) => drahtTrifft(d, box) && out.push(`Kabel ${d.key}`));
  h.etiketten.forEach((e) => e.key !== eigen && ueberlappt(e.box, box) && out.push(`Beschriftung ${e.txt}`));
  h.flaechen.forEach((f, i) => f !== auf && ueberlappt(f, box) && out.push(`Fläche ${i}`));
  return out;
}

export interface Vorschlag {
  x: number;
  y: number;
  anchor: Anker;
}

/**
 * Puts a label at the first of its places that is free. When none is free
 * the first is taken and the label goes on the list of conflicts, which the
 * tests keep empty.
 */
export function platziere(key: string, txt: string, size: number, orte: Vorschlag[], h: Hindernisse, konflikte: string[], breite?: number, auf?: Rect): Etikett {
  for (const o of orte) {
    const box = textBox(o.x, o.y, txt, size, o.anchor, breite);
    if (!treffer(box, h, undefined, auf).length) {
      const e = { key, txt, size, ...o, box, auf };
      h.etiketten.push(e);
      return e;
    }
  }
  const o = orte[0];
  const box = textBox(o.x, o.y, txt, size, o.anchor, breite);
  konflikte.push(`${txt}: ${treffer(box, h, undefined, auf).join(', ')}`);
  const e = { key, txt, size, ...o, box, auf };
  h.etiketten.push(e);
  return e;
}

/** Checks every label of a finished picture again, against everything in it. */
export function pruefe(etiketten: Etikett[], h: Omit<Hindernisse, 'etiketten'>): string[] {
  const out: string[] = [];
  for (const e of etiketten) {
    const t = treffer(e.box, { ...h, etiketten }, e.key, e.auf);
    if (t.length) out.push(`${e.txt}: ${t.join(', ')}`);
  }
  return out;
}
