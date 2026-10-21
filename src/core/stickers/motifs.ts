/**
 * The motifs of the sticker style "Bildkarte" (style audit 20.10.2026,
 * TODO #91), for cards without an album cover (special cards, Kita and word
 * cards, own recordings). Our own drawings, as a felt pen draws them;
 * not Lucide or emoji (on stickers those read as made by a machine). The
 * same hand as the key symbols (keysymbols.ts): straight edges bow a little,
 * round outlines are drawn through a few points set by hand, lines take one of
 * two pens (PEN, FINE). Seeded, so a motif looks the same on every print. Pure geometry
 * in a box from -0.5 to 0.5, y down; drawn in features/stickers/bildkarte.ts.
 */
import { handDrawn, symbolShapes, type Pt } from './keysymbols';

export const MOTIFS = [
  'moon', 'stop', 'louder', 'quieter', 'pause', 'next', 'prev', 'dice', 'repeat', 'lock',
  'note', 'sing', 'mic', 'book', 'headphones', 'blocks',
  'cat', 'dog', 'bird', 'fish', 'pig',
  'tree', 'cake',
] as const;

export type MotifId = (typeof MOTIFS)[number];

/**
 * One part of a motif, drawn in order: a filled outline (with holes), or a
 * line drawn with the pen. A `cut` part is drawn in the colour of the ground,
 * a gap through what lies under it (the eyes of the cat, the letters on the
 * stop sign). `gap` puts a thin ground-coloured border round an outline, so
 * it stands apart from a part under it (the ears of the dog).
 */
export interface MotifPart {
  outline?: Pt[];
  holes?: Pt[][];
  line?: Pt[];
  /** A line that closes on itself (a ring). */
  closed?: boolean;
  /** Pen width of a line; PEN unless given. */
  width?: number;
  cut?: boolean;
  gap?: number;
}

/**
 * The two pens of every motif, as one felt pen draws them all: PEN for what is drawn as a line (the
 * stand of the microphone, the bow of the headphones, sound waves), FINE for the details cut into a
 * shape or added to it (eyes, whiskers, the lines of a page). GAP is the narrow ground between two
 * shapes lying on each other.
 */
export const PEN = 0.07;
export const FINE = 0.04;
const GAP = 0.03;

/** The word a motif goes with when the card has no title of its own. */
export const MOTIF_WORDS: Record<MotifId, string> = {
  moon: 'Schlafen',
  stop: 'Stopp',
  louder: 'Lauter',
  quieter: 'Leiser',
  pause: 'Pause',
  next: 'Weiter',
  prev: 'Zurück',
  dice: 'Zufall',
  repeat: 'Nochmal',
  lock: 'Gesperrt',
  note: 'Musik',
  sing: 'Mitsingen',
  mic: 'Aufnahme',
  book: 'Vorlesen',
  headphones: 'Hörspiel',
  blocks: 'Kita',
  cat: 'Tiere',
  dog: 'Hund',
  bird: 'Vögel',
  fish: 'Fische',
  pig: 'Bauernhof',
  tree: 'Weihnachten',
  cake: 'Geburtstag',
};

/**
 * Which motif goes with which words of a card's name, in this order: the
 * first match wins, so "Stopptanz" is a stop card (not dancing music),
 * "Weihnachtslieder" a Christmas card, "Schlaflieder" a sleep card. Words of
 * the box's keys (lauter, Pause, weiter …) count only in a short name, so
 * "Leise rieselt der Schnee" stays a Christmas song.
 */
const WORDS: readonly { motif: MotifId; re: RegExp; short?: boolean }[] = [
  { motif: 'stop', re: /stopp|stop\b|stoptanz|freeze|einfrier|halt\b/ },
  { motif: 'tree', re: /weihnacht|advent|nikolaus|christkind|tannenbaum|x-?mas|lebkuchen/ },
  { motif: 'cake', re: /geburtstag|birthday|happy birthday|kindergeburtstag/ },
  { motif: 'louder', re: /\blauter\b|lautstärke \+|volume up/, short: true },
  { motif: 'quieter', re: /\bleiser\b|\bleise\b|volume down/, short: true },
  { motif: 'pause', re: /\bpause\b|anhalten/, short: true },
  { motif: 'next', re: /nächst|naechst|\bweiter\b|vorspul|überspring|skip/, short: true },
  { motif: 'prev', re: /vorig|vorherig|zurück|zurueck/, short: true },
  { motif: 'dice', re: /zufall|zufäll|zufaell|shuffle|würfel|wuerfel|überrasch|ueberrasch|mix\b/ },
  { motif: 'repeat', re: /wiederhol|nochmal|noch mal|noch einmal|endlos|repeat|schleife/ },
  { motif: 'lock', re: /sperr|krabbel|kindersicher|\bschloss\b(?! )/, short: true },
  { motif: 'moon', re: /schlaf|schlummer|gute ?nacht|gute-nacht|einschlaf|sandm|wiegenl|träum|traeum|\bnacht\b|abendlied|bettzeit|mittagsruhe/ },
  { motif: 'mic', re: /aufnahme|aufgenommen|stimme|sprachnachricht|nachricht von|grüße|gruesse|grüsse|selbst gesungen|selbst gelesen/ },
  { motif: 'sing', re: /mitsing|zum singen|singen|sing ?along|karaoke|singt\b|sing mit/ },
  { motif: 'blocks', re: /\bkita\b|kita-|kindergarten|kiga\b|krippe|kinderkrippe|tagesmutter|spielgruppe/ },
  { motif: 'cat', re: /katze|kater|kätzchen|kaetzchen|miau/ },
  { motif: 'dog', re: /\bhund|hunde|welpe|wau ?wau|dackel/ },
  { motif: 'bird', re: /vogel|vögel|voegel|piep|amsel|meise|spatz|eule|rabe/ },
  { motif: 'fish', re: /fisch|meer\b|meeres|unterwasser|ozean|aquarium|wal\b|wale\b|hai\b/ },
  { motif: 'pig', re: /schwein|ferkel|bauernhof|\bkuh\b|kühe|kuehe|bauer\b|auf dem hof/ },
  { motif: 'cat', re: /tier|zoo|dschungel|wald ?tiere/ },
  { motif: 'book', re: /liest|lesen|vorles|geschicht|märchen|maerchen|buch|erzähl|erzaehl|gedicht/ },
  { motif: 'headphones', re: /hörspiel|hoerspiel|podcast|hörbuch|hoerbuch/ },
  { motif: 'note', re: /musik|lied|song|tanz|disco|konzert|kinderlieder|playlist|jukebox/ },
];

/**
 * What a card does, from its symbol (the Lucide name the app gives it, see
 * cards/SpecialCardDialog.tsx and ui/components/Cover.tsx), when its name
 * says nothing: a calm fallback, else no motif and the word alone.
 */
const SYMBOLS: Readonly<Record<string, MotifId>> = {
  Moon: 'moon',
  PersonStanding: 'stop',
  Baby: 'lock',
  Lock: 'lock',
  Shield: 'lock',
  School: 'blocks',
  Repeat1: 'repeat',
  Infinity: 'repeat',
  RotateCcw: 'repeat',
  ListMusic: 'note',
  Pause: 'pause',
  Music: 'note',
  Music2: 'note',
  BookOpen: 'book',
  Headphones: 'headphones',
};

/** Which motif a card gets: by the words of its title, else by what it does (symbol), else none. */
export function motifFor(o: { title: string; symbol?: string; music?: boolean }): MotifId | undefined {
  const t = o.title.toLowerCase().replace(/\s+/g, ' ').trim();
  const short = t.split(' ').filter(Boolean).length <= 3;
  for (const w of WORDS) if ((!w.short || short) && w.re.test(t)) return w.motif;
  const bySymbol = o.symbol ? SYMBOLS[o.symbol] : undefined;
  if (bySymbol) return bySymbol;
  return o.music ? 'note' : undefined;
}

/* ------------------------------------------------------------- geometry */

const TAU = Math.PI * 2;

function ellipse(cx: number, cy: number, rx: number, ry: number, rot = 0, n = 48): Pt[] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * TAU;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    return [cx + x * c - y * s, cy + x * s + y * c] as Pt;
  });
}

function polygon(cx: number, cy: number, r: number, n: number, start: number): Pt[] {
  return Array.from({ length: n }, (_, i) => [cx + r * Math.cos(start + (i / n) * TAU), cy + r * Math.sin(start + (i / n) * TAU)] as Pt);
}

function star(cx: number, cy: number, r: number, rot = 0): Pt[] {
  return Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + rot + (i / 10) * TAU;
    const rr = i % 2 ? r * 0.45 : r;
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)] as Pt;
  });
}

/** A rectangle from (x0, y0) to (x1, y1). */
function box(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** A rectangle with round corners (radius r), as a closed outline. */
function rounded(x0: number, y0: number, x1: number, y1: number, r: number, n = 6): Pt[] {
  const corner = (cx: number, cy: number, a0: number) => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos(a0 + (i / n) * (Math.PI / 2)), cy + r * Math.sin(a0 + (i / n) * (Math.PI / 2))] as Pt);
  return [...corner(x1 - r, y0 + r, -Math.PI / 2), ...corner(x1 - r, y1 - r, 0), ...corner(x0 + r, y1 - r, Math.PI / 2), ...corner(x0 + r, y0 + r, Math.PI)];
}

/** Points along a circle from angle a0 to a1 (an open arc). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 20): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

/** Turns and moves points: rotation `rot` about (cx, cy), then by (dx, dy). */
function turn(pts: Pt[], rot: number, cx = 0, cy = 0, dx = 0, dy = 0): Pt[] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s + dx, cy + (x - cx) * s + (y - cy) * c + dy] as Pt);
}

/** Points from a small box (0 … 1 each way) into the box x, y, w, h: for letters. */
function inBox(pts: [number, number][], x: number, y: number, w: number, h: number): Pt[] {
  return pts.map(([u, v]) => [x + u * w, y + v * h] as Pt);
}

/**
 * A smooth line through points set by hand (Catmull-Rom): how round outlines
 * are drawn here, so they are uneven the way a hand is, not by a filter.
 */
function curve(pts: Pt[], closed: boolean, per = 8): Pt[] {
  const n = pts.length;
  const at = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out: Pt[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let j = 0; j < per; j++) {
      const t = j / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

/** A small seeded random (as keysymbols.ts), for lines. */
function random(key: string): () => number {
  let s = 2166136261;
  for (let i = 0; i < key.length; i++) s = Math.imul(s ^ key.charCodeAt(i), 16777619);
  s >>>= 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** An open line as a pen draws it: each straight piece bowed a little, the ends a little off. */
function stroke(pts: Pt[], key: string, amp = 0.012): Pt[] {
  const rnd = random(key);
  const corners: Pt[] = pts.map(([x, y]) => [x + (rnd() - 0.5) * amp, y + (rnd() - 0.5) * amp]);
  const out: Pt[] = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const [a, b] = [corners[i], corners[i + 1]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const bow = (rnd() - 0.5) * 2 * amp * Math.min(1, len / 0.4);
    const n = Math.max(1, Math.round(len / 0.05));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const h = bow * Math.sin(Math.PI * t);
      out.push([a[0] + dx * t + (dy / (len || 1)) * h, a[1] + dy * t - (dx / (len || 1)) * h]);
    }
  }
  out.push(corners[corners.length - 1]);
  return out;
}

/** The crescent: the part of the big circle outside the small one. */
function crescent(): Pt[] {
  const ro = 0.36;
  const c: Pt = [0.15, -0.11];
  const ri = 0.31;
  const outside = (p: Pt) => Math.hypot(p[0] - c[0], p[1] - c[1]) > ri;
  const inside = (p: Pt) => Math.hypot(p[0], p[1]) < ro;
  const n = 120;
  const outer = Array.from({ length: n }, (_, i) => [ro * Math.cos((i / n) * TAU), ro * Math.sin((i / n) * TAU)] as Pt);
  const inner = Array.from({ length: n }, (_, i) => [c[0] + ri * Math.cos((i / n) * TAU), c[1] + ri * Math.sin((i / n) * TAU)] as Pt);
  // Start each arc where it leaves the other circle, so it runs in one piece.
  const run = (pts: Pt[], keep: (p: Pt) => boolean) => {
    const start = pts.findIndex((p, i) => keep(p) && !keep(pts[(i - 1 + pts.length) % pts.length]));
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(start + i) % pts.length];
      if (!keep(p)) break;
      out.push(p);
    }
    return out;
  };
  return [...run(outer, outside), ...run(inner, inside).reverse()];
}

/**
 * A round outline swaying a little, as a hand draws a circle: a slow wave
 * along the outline (two to three swells), not a jitter.
 */
function sway(pts: Pt[], key: string, amp = 0.012): Pt[] {
  let s = 0;
  for (let i = 0; i < key.length; i++) s = (s * 31 + key.charCodeAt(i)) >>> 0;
  const phase = ((s % 1000) / 1000) * TAU;
  const swells = 2 + (s % 2);
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return pts.map(([x, y], i) => {
    const t = i / pts.length;
    const d = Math.hypot(x - cx, y - cy) || 1;
    const k = amp * Math.sin(swells * TAU * t + phase);
    return [x + ((x - cx) / d) * k, y + ((y - cy) / d) * k] as Pt;
  });
}

/* ------------------------------------------------------------- letters */

/** Centre lines of the few capitals the motifs carry, in a box 0 … 1, each a list of strokes. */
const LETTERS: Record<string, { strokes: [number, number][][]; smooth?: boolean[]; closed?: boolean[] }> = {
  S: { strokes: [[[0.92, 0.17], [0.62, 0.0], [0.22, 0.04], [0.06, 0.25], [0.3, 0.46], [0.72, 0.56], [0.95, 0.77], [0.76, 0.98], [0.3, 1.0], [0.04, 0.84]]], smooth: [true] },
  T: { strokes: [[[0.0, 0.0], [1.0, 0.0]], [[0.5, 0.0], [0.5, 1.0]]] },
  O: { strokes: [[[0.5, 0.0], [0.93, 0.18], [1.0, 0.55], [0.8, 0.93], [0.45, 1.0], [0.08, 0.84], [0.0, 0.42], [0.18, 0.08]]], smooth: [true], closed: [true] },
  P: { strokes: [[[0.04, 1.0], [0.04, 0.0], [0.55, 0.0], [0.92, 0.16], [0.9, 0.42], [0.55, 0.55], [0.04, 0.55]]] },
  A: { strokes: [[[0.0, 1.0], [0.5, 0.0], [1.0, 1.0]], [[0.22, 0.62], [0.78, 0.62]]] },
  B: { strokes: [[[0.08, 0.0], [0.08, 1.0], [0.62, 1.0], [0.95, 0.8], [0.66, 0.5], [0.08, 0.5]], [[0.08, 0.0], [0.55, 0.0], [0.85, 0.22], [0.6, 0.48]]] },
};

/** A word in pen strokes, `h` high, centred on (cx, cy): the letters of the stop sign and the toy blocks. */
function lettering(word: string, cx: number, cy: number, w: number, h: number, key: string, width: number, cut: boolean): MotifPart[] {
  const n = word.length;
  const gap = 0.5;
  const lw = w / (n + gap * (n - 1));
  const parts: MotifPart[] = [];
  [...word].forEach((ch, i) => {
    const l = LETTERS[ch];
    const x = cx - w / 2 + i * lw * (1 + gap);
    l.strokes.forEach((s, j) => {
      const pts = inBox(s, x, cy - h / 2, lw, h);
      const closed = l.closed?.[j] ?? false;
      const line = l.smooth?.[j] ? curve(pts, closed) : stroke(pts, `${key}${i}${j}`, 0.006);
      parts.push({ line, closed, width, cut });
    });
  });
  return parts;
}

/* -------------------------------------------------------------- motifs */

/** The loudspeaker of the volume keys, with its waves and a big plus or minus as on the keys of the box. */
function speaker(id: MotifId, hand: (pts: Pt[], key: string) => Pt[]): MotifPart[] {
  const body: Pt[] = [[-0.47, -0.11], [-0.35, -0.11], [-0.17, -0.29], [-0.17, 0.29], [-0.35, 0.11], [-0.47, 0.11]];
  const louder = id === 'louder';
  const waves = louder ? [0.1, 0.2] : [0.1];
  const s = 0.155;
  const t = 0.055;
  const c = 0.31;
  const sign: Pt[][] = louder ? [box(c - s, -t, c + s, t), box(c - t, -s, c + t, s)] : [box(c - s, -t, c + s, t)];
  return [
    { outline: hand(body, 'body') },
    ...waves.map((r) => ({ line: arc(-0.17, 0, r, -0.75, 0.75, 12) })),
    ...sign.map((b, i) => ({ outline: hand(b, `sign${i}`) })),
  ];
}

/** The parts of a motif, drawn by hand (seeded by the motif). */
export function motifParts(id: MotifId): MotifPart[] {
  const hand = (pts: Pt[], key: string, amp = 0.014) => handDrawn(pts, `${id}/${key}`, amp);
  const line = (pts: Pt[], key: string, width = PEN, cut = false): MotifPart => ({ line: stroke(pts, `${id}/${key}`), width, cut });
  const smooth = (pts: Pt[], width = PEN, cut = false, closed = false): MotifPart => ({ line: curve(pts, closed), width, cut, closed });
  switch (id) {
    case 'moon':
      return [
        { outline: sway(crescent(), 'moon', 0.008) },
        { outline: hand(star(0.17, -0.1, 0.085), 's1') },
        { outline: hand(star(0.37, -0.34, 0.055), 's2') },
      ];
    case 'stop': {
      // The stop sign as it stands at the road: a light rim and STOP on the red of the ground.
      const start = Math.PI / 8;
      return [
        { outline: hand(polygon(0, 0, 0.48, 8, start), 'o'), holes: [hand(polygon(0, 0, 0.405, 8, start), 'h')] },
        ...lettering('STOP', 0, 0.005, 0.64, 0.22, 'stop', FINE * 1.25, false),
      ];
    }
    case 'louder':
    case 'quieter':
      return speaker(id, hand);
    case 'pause':
      return [{ outline: hand(box(-0.25, -0.33, -0.07, 0.33), 'l') }, { outline: hand(box(0.07, -0.33, 0.25, 0.33), 'r') }];
    case 'next':
    case 'prev':
      // The two triangles of the Vor and Zurück key stickers, in the same hand.
      return symbolShapes(id).map((s, i) => ({ outline: hand(s.map(([x, y]) => [x * 0.86, y * 0.86] as Pt), `t${i}`, 0.02) }));
    case 'dice': {
      // Two dice thrown: one big showing five, a small one showing two.
      const pips = (cx: number, cy: number, side: number, rot: number, n: number) => {
        const q = side * 0.27;
        const at: [number, number][] = n === 5 ? [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]] : n === 3 ? [[-1, -1], [0, 0], [1, 1]] : [[-1, -1], [1, 1]];
        return at.map(([u, v]) => turn(ellipse(cx + u * q, cy + v * q, side * 0.085, side * 0.085, 0, 20), rot, cx, cy).reverse());
      };
      const die = (cx: number, cy: number, side: number, rot: number, n: number, key: string): MotifPart => ({
        outline: sway(turn(rounded(cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2, side * 0.17), rot, cx, cy), key, 0.006),
        holes: pips(cx, cy, side, rot, n),
        gap: GAP * 1.4,
      });
      return [die(0.27, -0.2, 0.32, 0.38, 3, 'small'), die(-0.12, 0.1, 0.54, -0.16, 5, 'big')];
    }
    case 'repeat': {
      // A circle drawn round once, the arrow at its end: play it again.
      const r = 0.3;
      const a1 = -Math.PI / 2 + 0.25 + TAU * 0.8;
      const end: Pt = [r * Math.cos(a1), r * Math.sin(a1) + 0.02];
      const dir = a1 + Math.PI / 2;
      const head: Pt[] = [
        [end[0] + Math.cos(dir) * 0.15, end[1] + Math.sin(dir) * 0.15],
        [end[0] + Math.cos(dir + 2.2) * 0.13, end[1] + Math.sin(dir + 2.2) * 0.13],
        [end[0] + Math.cos(dir - 2.2) * 0.13, end[1] + Math.sin(dir - 2.2) * 0.13],
      ];
      return [{ line: arc(0, 0.02, r, -Math.PI / 2 + 0.25, a1, 40), width: PEN * 1.25 }, { outline: hand(head, 'head') }];
    }
    case 'lock': {
      const shackle: Pt[] = [[-0.19, 0.02], ...arc(0, -0.18, 0.19, Math.PI, TAU, 16), [0.19, 0.02]];
      const keyhole: Pt[] = [...arc(0, 0.14, 0.065, -Math.PI * 1.3, Math.PI * 0.3, 14), [0.04, 0.3], [-0.04, 0.3]];
      return [{ line: shackle, width: PEN * 1.3 }, { outline: hand(rounded(-0.33, -0.04, 0.33, 0.45, 0.06), 'body', 0.01), holes: [keyhole.reverse()] }];
    }
    case 'note': {
      // Two eighth notes on one beam.
      const heads = [ellipse(-0.24, 0.3, 0.13, 0.095, -0.35), ellipse(0.2, 0.22, 0.13, 0.095, -0.35)];
      const stems: Pt[][] = [
        [[-0.135, 0.29], [-0.135, -0.32], [-0.065, -0.33], [-0.065, 0.28]],
        [[0.295, 0.21], [0.295, -0.4], [0.365, -0.41], [0.365, 0.2]],
      ];
      const beam: Pt[] = [[-0.135, -0.33], [0.365, -0.45], [0.365, -0.32], [-0.135, -0.2]];
      return [...heads.map((h, i) => ({ outline: sway(h, `h${i}`, 0.006) })), ...stems.map((s, i) => ({ outline: hand(s, `st${i}`) })), { outline: hand(beam, 'beam') }];
    }
    case 'sing': {
      // A child from the side singing, mouth open, notes flying out.
      const head = curve([[-0.14, -0.4], [0.05, -0.34], [0.14, -0.18], [0.15, -0.06], [0.2, 0.02], [0.14, 0.06], [0.15, 0.2], [0.05, 0.27], [-0.03, 0.28], [-0.02, 0.44], [-0.24, 0.44], [-0.25, 0.26], [-0.39, 0.14], [-0.45, -0.1], [-0.36, -0.32]], true);
      const note = (x: number, y: number, s: number, key: string): MotifPart[] => [
        { outline: ellipse(x, y, 0.075 * s, 0.055 * s, -0.4, 24) },
        { outline: hand([[x + 0.05 * s, y - 0.01], [x + 0.05 * s, y - 0.3 * s], [x + 0.05 * s + FINE * 1.2, y - 0.3 * s], [x + 0.05 * s + FINE * 1.2, y - 0.01]], `${key}s`, 0.006) },
        smooth([[x + 0.075 * s, y - 0.28 * s], [x + 0.17 * s, y - 0.2 * s], [x + 0.16 * s, y - 0.1 * s]], FINE * 1.2),
      ];
      return [
        { outline: head },
        { outline: ellipse(0.155, 0.12, 0.065, 0.075, 0.2, 24), cut: true },
        smooth([[0.0, -0.11], [0.04, -0.08], [0.08, -0.11]], FINE, true),
        ...note(0.29, -0.12, 1.0, 'n1'),
        ...note(0.33, 0.32, 0.75, 'n2'),
      ];
    }
    case 'mic': {
      // A microphone on its stand: the box hears you.
      const head = rounded(-0.15, -0.47, 0.15, 0.08, 0.15, 10);
      return [
        { outline: hand(head, 'head', 0.006) },
        line([[-0.15, -0.17], [0.15, -0.17]], 'g1', FINE, true),
        line([[-0.15, -0.05], [0.15, -0.05]], 'g2', FINE, true),
        smooth([[-0.25, -0.12], [-0.24, 0.07], [-0.12, 0.2], [0, 0.22], [0.12, 0.2], [0.24, 0.07], [0.25, -0.12]]),
        line([[0, 0.22], [0, 0.42]], 'stem'),
        line([[-0.18, 0.43], [0.18, 0.43]], 'foot', PEN * 1.2),
      ];
    }
    case 'book': {
      // An open picture book: pages bowing from the spine, a picture on the left, lines on the right, a ribbon.
      const left = curve([[-0.02, -0.22], [-0.2, -0.29], [-0.45, -0.26], [-0.46, 0], [-0.45, 0.25], [-0.2, 0.22], [-0.02, 0.28]], false, 6);
      const right = left.map(([x, y]) => [-x, y] as Pt).reverse();
      return [
        { outline: [...curve([[-0.49, 0.3], [-0.2, 0.28], [0, 0.36], [0.2, 0.28], [0.49, 0.3]], false, 6), [0.49, 0.36], [0.2, 0.34], [0, 0.42], [-0.2, 0.34], [-0.49, 0.36]] },
        { outline: left, gap: GAP },
        { outline: right, gap: GAP },
        { outline: sway(ellipse(-0.27, -0.06, 0.085, 0.08, 0, 28), 'crown', 0.006), cut: true },
        line([[-0.27, 0.0], [-0.275, 0.14]], 'trunk', FINE * 1.2, true),
        smooth([[-0.41, 0.15], [-0.3, 0.13], [-0.2, 0.15], [-0.12, 0.13]], FINE, true),
        line([[0.1, -0.13], [0.38, -0.15]], 'r1', FINE, true),
        line([[0.1, -0.02], [0.4, -0.04]], 'r2', FINE, true),
        line([[0.1, 0.09], [0.31, 0.08]], 'r3', FINE, true),
      ];
    }
    case 'headphones': {
      const cup = (s: number): Pt[] => rounded(s > 0 ? 0.26 : -0.44, -0.02, s > 0 ? 0.44 : -0.26, 0.38, 0.07);
      return [
        { line: arc(0, 0.04, 0.37, Math.PI * 1.02, Math.PI * 1.98, 24), width: PEN * 1.2 },
        { outline: hand(cup(-1), 'l', 0.01) },
        { outline: hand(cup(1), 'r', 0.01) },
        line([[-0.24, 0.04], [-0.24, 0.32]], 'pl', PEN),
        line([[0.24, 0.04], [0.24, 0.32]], 'pr', PEN),
      ];
    }
    case 'blocks': {
      // Toy blocks as in every Kita: A and B below, a block with a star on them, a roof on top.
      const block = (cx: number, cy: number, s: number, rot: number, key: string): MotifPart => ({ outline: turn(hand(box(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2), key, 0.012), rot, cx, cy), gap: GAP });
      return [
        block(-0.2, 0.29, 0.34, -0.03, 'a'),
        ...lettering('A', -0.2, 0.29, 0.17, 0.19, 'la', FINE, true),
        block(0.19, 0.29, 0.34, 0.04, 'b'),
        ...lettering('B', 0.19, 0.29, 0.15, 0.19, 'lb', FINE, true),
        block(0.0, -0.06, 0.32, 0.02, 'c'),
        { outline: hand(star(0.0, -0.05, 0.11, 0.05), 'star', 0.006), cut: true },
        { outline: hand([[-0.2, -0.24], [0.0, -0.47], [0.2, -0.24]], 'roof', 0.012), gap: GAP },
      ];
    }
    case 'cat': {
      // A cat sitting, seen from the front: pointed ears, whiskers, its tail laid round.
      const head = curve([[0, -0.33], [0.15, -0.31], [0.22, -0.2], [0.2, -0.07], [0.1, 0.0], [-0.1, 0.0], [-0.2, -0.07], [-0.22, -0.2], [-0.15, -0.31]], true);
      const body = curve([[-0.1, -0.06], [0.1, -0.06], [0.2, 0.1], [0.27, 0.3], [0.24, 0.44], [0, 0.46], [-0.24, 0.44], [-0.27, 0.3], [-0.2, 0.1]], true);
      const ears: Pt[][] = [
        [[-0.21, -0.2], [-0.2, -0.47], [-0.04, -0.32]],
        [[0.21, -0.2], [0.21, -0.46], [0.04, -0.32]],
      ];
      return [
        smooth([[0.2, 0.42], [0.36, 0.42], [0.45, 0.3], [0.44, 0.15], [0.37, 0.09]]),
        { outline: body },
        ...ears.map((e, i) => ({ outline: hand(e, `ear${i}`, 0.014) })),
        { outline: head },
        { outline: ellipse(-0.085, -0.17, 0.032, 0.048, 0.15, 20), cut: true },
        { outline: ellipse(0.085, -0.17, 0.032, 0.048, -0.15, 20), cut: true },
        { outline: hand([[-0.035, -0.1], [0.035, -0.1], [0, -0.06]], 'nose', 0.004), cut: true },
        line([[-0.16, -0.1], [-0.38, -0.15]], 'w1', FINE),
        line([[-0.16, -0.05], [-0.37, -0.03]], 'w2', FINE),
        line([[0.16, -0.1], [0.38, -0.15]], 'w3', FINE),
        line([[0.16, -0.05], [0.37, -0.03]], 'w4', FINE),
        line([[-0.06, 0.22], [-0.055, 0.45]], 'leg1', FINE, true),
        line([[0.06, 0.22], [0.055, 0.45]], 'leg2', FINE, true),
      ];
    }
    case 'dog': {
      // A dog's face with long floppy ears, a big nose and its tongue out.
      const head = curve([[0, -0.36], [0.2, -0.32], [0.26, -0.08], [0.25, 0.18], [0.12, 0.36], [-0.12, 0.36], [-0.25, 0.18], [-0.26, -0.08], [-0.2, -0.32]], true);
      const ear = (s: number) => curve([[0.14 * s, -0.33], [0.36 * s, -0.33], [0.47 * s, -0.08], [0.45 * s, 0.17], [0.36 * s, 0.24], [0.27 * s, 0.12], [0.22 * s, -0.15]], true);
      return [
        { outline: head },
        { outline: ear(-1), gap: GAP },
        { outline: ear(1), gap: GAP },
        { outline: ellipse(-0.1, -0.06, 0.045, 0.06, 0, 20), cut: true },
        { outline: ellipse(0.1, -0.06, 0.045, 0.06, 0, 20), cut: true },
        { outline: curve([[0, 0.06], [0.08, 0.08], [0.06, 0.14], [0, 0.16], [-0.06, 0.14], [-0.08, 0.08]], true), cut: true },
        smooth([[0, 0.16], [0, 0.22], [-0.08, 0.27]], FINE, true),
        smooth([[0, 0.22], [0.08, 0.27]], FINE, true),
      ];
    }
    case 'bird': {
      // A small bird from the side: round body, beak, tail up, a wing, two thin legs.
      const body = curve([[0.21, -0.37], [0.34, -0.27], [0.33, -0.08], [0.22, 0.12], [0.0, 0.25], [-0.2, 0.22], [-0.33, 0.06], [-0.47, -0.2], [-0.24, -0.08], [-0.02, -0.12], [0.07, -0.3]], true);
      return [
        { outline: hand([[0.31, -0.29], [0.48, -0.22], [0.31, -0.16]], 'beak', 0.008) },
        { outline: body },
        { outline: ellipse(0.19, -0.23, 0.04, 0.045, 0, 20), cut: true },
        smooth([[-0.17, -0.02], [-0.02, 0.0], [0.11, -0.05], [0.04, 0.09], [-0.12, 0.1]], FINE, true),
        line([[-0.04, 0.24], [-0.06, 0.42], [-0.13, 0.44]], 'leg1', FINE),
        line([[0.06, 0.21], [0.07, 0.42], [0.0, 0.44]], 'leg2', FINE),
      ];
    }
    case 'fish': {
      const body = curve([[0.44, 0.0], [0.3, -0.18], [0.05, -0.24], [-0.17, -0.15], [-0.26, 0.0], [-0.17, 0.15], [0.05, 0.23], [0.3, 0.17]], true);
      const tail: Pt[] = [[-0.21, 0.0], [-0.47, -0.2], [-0.42, 0.0], [-0.47, 0.2]];
      return [
        { outline: hand(tail, 'tail', 0.014) },
        { outline: hand([[-0.04, -0.22], [0.06, -0.36], [0.2, -0.2]], 'fin', 0.01) },
        { outline: body },
        { outline: ellipse(0.25, -0.05, 0.04, 0.045, 0, 20), cut: true },
        smooth([[0.12, -0.15], [0.07, 0.0], [0.12, 0.14]], FINE, true),
        { line: ellipse(0.35, -0.33, 0.045, 0.045, 0, 20), closed: true, width: FINE },
        { line: ellipse(0.43, -0.43, 0.03, 0.03, 0, 16), closed: true, width: FINE },
      ];
    }
    case 'pig': {
      // A pig's face: ears flopping forward, a big snout with two nostrils, little eyes.
      const head = curve([[0, -0.3], [0.25, -0.27], [0.4, -0.08], [0.37, 0.18], [0.18, 0.34], [-0.18, 0.34], [-0.37, 0.18], [-0.4, -0.08], [-0.25, -0.27]], true);
      const ear = (s: number) => curve([[0.12 * s, -0.27], [0.36 * s, -0.47], [0.46 * s, -0.3], [0.4 * s, -0.12], [0.3 * s, -0.2]], true, 6);
      return [
        { outline: head },
        { outline: ear(-1), gap: GAP },
        { outline: ear(1), gap: GAP },
        { outline: ellipse(-0.14, -0.07, 0.035, 0.045, 0, 16), cut: true },
        { outline: ellipse(0.14, -0.07, 0.035, 0.045, 0, 16), cut: true },
        { outline: sway(ellipse(0, 0.13, 0.17, 0.115, 0, 36), 'snout', 0.005), gap: GAP * 1.2 },
        { outline: ellipse(-0.06, 0.13, 0.03, 0.05, 0.1, 16), cut: true },
        { outline: ellipse(0.06, 0.13, 0.03, 0.05, -0.1, 16), cut: true },
      ];
    }
    case 'tree': {
      // A Christmas tree: three layers of branches, a star on top, a few baubles.
      const layer = (top: number, bottom: number, half: number): Pt[] => [[0, top], [half, bottom], [half * 0.4, bottom - 0.02], [-half * 0.4, bottom - 0.02], [-half, bottom]];
      const balls: Pt[] = [[-0.12, -0.08], [0.1, 0.06], [-0.2, 0.25], [0.2, 0.26]];
      return [
        { outline: hand(box(-0.06, 0.3, 0.06, 0.46), 'trunk', 0.008) },
        { outline: hand(layer(0.0, 0.33, 0.36), 'l3') },
        { outline: hand(layer(-0.18, 0.13, 0.28), 'l2'), gap: GAP },
        { outline: hand(layer(-0.34, -0.06, 0.2), 'l1'), gap: GAP },
        { outline: hand(star(0, -0.39, 0.1), 'star', 0.008), gap: GAP },
        ...balls.map(([x, y]) => ({ outline: ellipse(x, y, 0.035, 0.035, 0, 16), cut: true })),
      ];
    }
    case 'cake': {
      // A birthday cake: icing running down, three candles with their flames.
      const flame = (x: number): Pt[] => curve([[x, -0.47], [x + 0.045, -0.36], [x, -0.3], [x - 0.045, -0.36]], true, 6);
      return [
        { outline: hand(box(-0.4, 0.0, 0.4, 0.4), 'cake', 0.012) },
        smooth([[-0.4, 0.1], [-0.3, 0.16], [-0.22, 0.09], [-0.12, 0.17], [0.0, 0.1], [0.1, 0.18], [0.2, 0.1], [0.3, 0.16], [0.4, 0.1]], FINE, true),
        line([[-0.46, 0.45], [0.46, 0.45]], 'plate', PEN),
        ...[-0.22, 0, 0.22].flatMap((x, i) => [
          { outline: hand(box(x - 0.035, -0.24, x + 0.035, 0.0), `c${i}`, 0.006) },
          { outline: flame(x) },
        ]),
      ];
    }
  }
}
