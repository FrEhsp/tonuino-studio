/**
 * Hand-drawn shapes for the Lötplan (LoetplanSketch.tsx): rectangles,
 * circles and wires as SVG paths whose points stray a little, the same way
 * every time (the key seeds the stray). No SVG filter is involved, so every
 * browser and the desktop app draw them alike, at any size.
 */

interface P {
  x: number;
  y: number;
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

const r1 = (n: number) => Math.round(n * 10) / 10;
const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** A smooth closed line through the points (each point pulls the curve, corners round off a little). */
function closed(pts: P[]): string {
  const n = pts.length;
  const m = mid(pts[n - 1], pts[0]);
  let d = `M${r1(m.x)},${r1(m.y)}`;
  for (let i = 0; i < n; i++) {
    const q = mid(pts[i], pts[(i + 1) % n]);
    d += ` Q${r1(pts[i].x)},${r1(pts[i].y)} ${r1(q.x)},${r1(q.y)}`;
  }
  return `${d}Z`;
}

/** A rectangle drawn by hand: points along the edges, each a little off. */
export function wobblyRect(x: number, y: number, w: number, h: number, amp: number, key: string): string {
  const rnd = random(key);
  const off = () => (rnd() - 0.5) * 2 * amp;
  const corners: P[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  const pts: P[] = [];
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // Short steps near the corner keep it from rounding off like a pill.
    const step = Math.min(28, len / 2);
    const n = Math.max(2, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      pts.push({ x: a.x + (b.x - a.x) * t + off(), y: a.y + (b.y - a.y) * t + off() });
    }
  });
  return closed(pts);
}

/** A circle drawn by hand. */
export function wobblyCircle(cx: number, cy: number, r: number, amp: number, key: string): string {
  const rnd = random(key);
  const n = Math.max(10, Math.round((2 * Math.PI * r) / 18));
  const pts: P[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * 2 * Math.PI;
    const rr = r + (rnd() - 0.5) * 2 * amp;
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
  }
  return closed(pts);
}

/**
 * A wire drawn by hand: the path "M x,y C x1,y1 x2,y2 x,y" sampled and
 * nudged sideways a little. Both ends stay exactly on their pads. Any
 * other path comes back as it is.
 */
export function wobblyLine(d: string, amp: number, key: string): string {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (!/^M[^A-Za-z]*C[^A-Za-z]*$/.test(d.trim()) || !nums || nums.length !== 8) return d;
  const [p0, p1, p2, p3] = [0, 2, 4, 6].map((i) => ({ x: nums[i], y: nums[i + 1] }));
  const at = (t: number): P => {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const e = t * t * t;
    return { x: a * p0.x + b * p1.x + c * p2.x + e * p3.x, y: a * p0.y + b * p1.y + c * p2.y + e * p3.y };
  };
  const len = Math.hypot(p3.x - p0.x, p3.y - p0.y) + Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.5;
  const n = Math.max(3, Math.round(len / 34));
  const rnd = random(key);
  const pts: P[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const p = at(t);
    if (k === 0 || k === n) {
      pts.push(p);
      continue;
    }
    const q = at(Math.min(1, t + 0.01));
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const l = Math.hypot(dx, dy) || 1;
    const o = (rnd() - 0.5) * 2 * amp;
    pts.push({ x: p.x - (dy / l) * o, y: p.y + (dx / l) * o });
  }
  let out = `M${r1(pts[0].x)},${r1(pts[0].y)}`;
  for (let k = 1; k < pts.length - 1; k++) {
    const q = mid(pts[k], pts[k + 1]);
    const end = k === pts.length - 2 ? pts[k + 1] : q;
    out += ` Q${r1(pts[k].x)},${r1(pts[k].y)} ${r1(end.x)},${r1(end.y)}`;
  }
  return out;
}
