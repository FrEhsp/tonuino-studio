/**
 * Lötplan 0.6: one big, colourful picture per board (Classic v1.7, AiO,
 * AiO+), with every chosen extra drawn into the same picture
 * (design/06-umbau/loetplan, entwurf-loetplan-*.png, quelle/plan.js).
 *
 * The picture is plain data: SVG strings for the parts that never change,
 * and the wires as points with their colour, step and proofs, so the page
 * can light up one step and fade the rest, and the tests can check every
 * wire against the pin table of the firmware (tngPins.ts).
 *
 * How sure a wire is decides how it is drawn (loetplanBelege.ts):
 * - geprueft: solid, the colour of the wire with an ink edge;
 * - nachsehen: solid, with a note slip "!" (check before soldering);
 * - ungeprueft: pencil, dashed, with a "?" (not proven yet). Never solid.
 *
 * Pins: TonUINO TNG d527ca5 (src/constants.hpp, tests/fixtures/tng). The
 * geometry of the Classic is the board in its true size (3D data, see
 * loetplan.ts), ×8.6 px per mm; the AiO boards are simplified.
 * The Classic without board and the view from below keep their old
 * pictures (LoetplanSchema.tsx, LoetplanSketch.tsx).
 */
import { ALARM_TEXT } from '../../core/firmware/baukasten';
import { F, LINKS_INNEN, type ExtraId, type LoetplanWahl } from './loetplan';
import { stufeVon, type BelegId, type Stufe } from './loetplanBelege';
import { extras as extraPlaene, type ExtraPlan } from './loetplanVerdrahtung';
import type { TngFunktion, TngPlatine } from './tngPins';

export type Pkt = [number, number];
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A pad or pin someone solders to. `pin`: the pin of the microcontroller as TNG names it, when the pad is one. */
export interface Anker {
  p: Pkt;
  label: string;
  pin?: string;
}

export interface Draht {
  pts: Pkt[];
  farbe: string;
  /** The key of its step (BildSchritt.key). */
  schritt: string;
  belege: BelegId[];
  stufe: Stufe;
  /** For the list: from where to where, e.g. "A0" → "Taste Play/Pause, ein Bein". */
  von: string;
  nach: string;
  /** The anchors at its ends, where it sits on a pad of the picture. */
  a?: string;
  b?: string;
  /** The pin of the microcontroller it ends at, as TNG has it (checked against tngPins.ts). */
  tng?: { platine: TngPlatine; funktion: TngFunktion; pin: string };
  dick?: boolean;
  /** Where the "!" or "?" sits; else halfway. */
  marke?: Pkt;
}

/** A line of the list that is not a wire: a pin that stays free. */
export interface Frei {
  schritt: string;
  text: string;
  belege: BelegId[];
}

export interface BildSchritt {
  key: string;
  nr: number;
  titel: string;
  /** One line for the list next to the picture. */
  kurz: string;
  /** All that the old steps said, for the step view and the print. */
  text: string[];
  /** One short hint under the wires of the step view. */
  hinweis?: string;
  achtung?: string;
  /** Where on the board, for the step view: "Classic v1.7 · linke Lötreihe". */
  ort: string;
  extra?: ExtraId;
  /** The part of the picture the step view zooms to. */
  bereich: Rect;
  /**
   * The step's pins and wire ends with their names: what a phone must show
   * at the least, also when the parts around do not fit (Prüfrunde 1, bastler 8).
   */
  kern?: Rect;
}

/** Something in the picture that is not proven yet, or to check before soldering. */
export interface Offen {
  stufe: 'nachsehen' | 'ungeprueft';
  /** The extra it belongs to; none for the board itself. */
  extra?: ExtraId;
  titel: string;
  warum: string;
  bitte?: string;
}

export interface Bild {
  platine: 'classic' | 'aio' | 'aioplus';
  /** "Classic v1.7 · Nano · MP3-Player · 3 Tasten · 2 Extras" */
  kopf: string;
  /** The muted line beside it. */
  unter: string;
  /** Where the picture is cropped to (viewBox). */
  box: Rect;
  teile: string;
  ueber: string;
  drahte: Draht[];
  frei: Frei[];
  schritte: BildSchritt[];
  offen: Offen[];
  anker: Record<string, Anker>;
  /** The smallest text in the picture, in picture units: the phone zooms so it is at least 14 px. */
  minSchrift: number;
  /** The extras drawn (chosen, possible on this board). */
  extras: ExtraPlan[];
}

/* ------------------------------------------------------------------ colours of the picture */

/** Ink of outlines and labels on paper; the page sets it by class (dark mode). */
const INK = '#1f1a16';
/** Pencil: not proven yet. */
export const BLEI = '#8a8174';
/** Wire colours (plan.js): the ones of loetplan.ts plus the extras. */
export const C = {
  ...F,
  din: '#1f6fd1',
  clk: '#9b3fc8',
  dt: '#12b5b0',
  weck: '#ff7a00',
  led: '#e64980',
  hp: F.busy,
  stumm: '#9b3fc8',
  aus: '#9b3fc8',
  akku: '#d62828',
} as const;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/* ------------------------------------------------------------------ the drawing context */

interface TextOpt {
  fs?: number;
  fw?: number;
  a?: 'start' | 'middle' | 'end';
  /** A fixed colour (print on a board); without: ink, by class. */
  fill?: string;
  /** Ink with a paper edge, drawn above the wires. */
  hal?: boolean;
  rot?: number;
  op?: number;
}

class Zeichnung {
  teile: string[] = [];
  ueber: string[] = [];
  halos: string[] = [];
  drahte: Draht[] = [];
  frei: Frei[] = [];
  anker: Record<string, Anker> = {};
  rects: Rect[] = [];
  bereiche = new Map<string, Rect[]>();
  /** Per step: its pins and wire ends only (BildSchritt.kern). */
  kerne = new Map<string, Rect[]>();
  /** Per step: its own parts, without the routes of its wires. */
  teileJe = new Map<string, Rect[]>();
  min = 99;
  offen: Offen[] = [];

  constructor(readonly platine: TngPlatine) {}

  /** A text; ink by class unless it has its own colour. */
  t(x: number, y: number, s: string, o: TextOpt = {}): string {
    const fs = o.fs ?? 12;
    this.min = Math.min(this.min, fs);
    const cls = o.fill ? '' : o.hal ? ' class="lp-ti lp-hal"' : ' class="lp-ti"';
    const fill = o.fill ? ` fill="${o.fill}"` : '';
    const rot = o.rot ? ` transform="rotate(${o.rot} ${n1(x)} ${n1(y)})"` : '';
    const op = o.op ? ` opacity="${o.op}"` : '';
    const out = `<text x="${n1(x)}" y="${n1(y)}" text-anchor="${o.a ?? 'middle'}" font-size="${fs}" font-weight="${o.fw ?? 700}"${fill}${cls}${rot}${op}>${esc(s)}</text>`;
    if (o.hal) this.halos.push(out);
    return o.hal ? '' : out;
  }

  /** Marks a rectangle as used by a part, and by a step's view. */
  platz(r: Rect, schritt?: string) {
    this.rects.push(r);
    if (!schritt) return;
    this.bereich(schritt, r);
    const l = this.teileJe.get(schritt) ?? [];
    l.push(r);
    this.teileJe.set(schritt, l);
  }

  bereich(schritt: string, r: Rect, kern = false) {
    for (const map of kern ? [this.bereiche, this.kerne] : [this.bereiche]) {
      const l = map.get(schritt) ?? [];
      l.push(r);
      map.set(schritt, l);
    }
  }

  /** A pad: gold ring, dark hole, its name beside it. */
  auge(x: number, y: number, label = '', seite: 'o' | 'u' | 'l' | 'r' = 'o', o: { fs?: number; schrift?: string; eckig?: boolean; ink?: boolean } = {}): string {
    const fs = o.fs ?? 11;
    const dx = { o: 0, u: 0, l: -9, r: 9 }[seite];
    const dy = { o: -10, u: 18, l: 4, r: 4 }[seite];
    const a = ({ o: 'middle', u: 'middle', l: 'end', r: 'start' } as const)[seite];
    const pad = o.eckig
      ? `<rect x="${n1(x - 5.5)}" y="${n1(y - 5.5)}" width="11" height="11" rx="1" fill="#e2c675" stroke="${INK}" stroke-width="1.4"/>`
      : `<circle cx="${n1(x)}" cy="${n1(y)}" r="5.6" fill="#e2c675" stroke="${INK}" stroke-width="1.4"/>`;
    const txt = label ? this.t(x + dx, y + dy, label, { fs, a, ...(o.ink ? {} : { fill: o.schrift ?? '#fff' }) }) : '';
    return `${pad}<circle cx="${n1(x)}" cy="${n1(y)}" r="2.1" fill="${INK}"/>${txt}`;
  }

  /** A part as a box with its name (board look: colour, ink edge, a hard shadow). `offen`: not proven, hatched in pencil. */
  kasten(x: number, y: number, w: number, h: number, farbe: string, name: string, o: { sub?: string; nameY?: number; fs?: number; schrift?: string; offen?: boolean; r?: number; schritt?: string } = {}): string {
    const r = o.r ?? 7;
    this.platz({ x0: x, y0: y, x1: x + w + 4, y1: y + h + 5 }, o.schritt);
    const offen = !!o.offen;
    const fill = offen ? '#fbf8f2' : farbe;
    const schrift = offen ? INK : (o.schrift ?? '#fff');
    const nameY = o.nameY ?? y + 22;
    const dash = offen ? ' stroke-dasharray="9 6"' : '';
    const hatch = offen ? `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${r}" fill="url(#lp-schraffur)"/>` : '';
    const name1 = name ? this.t(x + w / 2, nameY, name, { fs: o.fs ?? 15, fw: 800, fill: schrift }) : '';
    const sub = o.sub ? this.t(x + w / 2, nameY + 17, o.sub, { fs: 12, fw: 600, fill: schrift, op: 0.92 }) : '';
    return `<rect x="${n1(x + 4)}" y="${n1(y + 5)}" width="${n1(w)}" height="${n1(h)}" rx="${r}" fill="rgb(31 26 22 / 0.16)"/><rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${r}" fill="${fill}" stroke="${offen ? BLEI : INK}" stroke-width="2.6"${dash}/>${hatch}${name1}${sub}`;
  }

  taste(cx: number, cy: number, farbe: string, name: string, schritt: string, r = 27): string {
    this.platz({ x0: cx - r - 3, y0: cy - r - 3, x1: cx + r + 6, y1: cy + r + (name ? 30 : 6) }, schritt);
    return `<circle cx="${cx + 2}" cy="${cy + 4}" r="${r + 3}" fill="rgb(31 26 22 / 0.18)"/><circle cx="${cx}" cy="${cy}" r="${r + 3}" fill="#2a2622" stroke="${INK}" stroke-width="2"/><circle cx="${cx}" cy="${cy}" r="${r - 3}" fill="${farbe}" stroke="${INK}" stroke-width="2.4"/>${name ? this.t(cx, cy + r + 24, name, { fs: 14, fw: 800 }) : ''}`;
  }

  lautsprecher(cx: number, cy: number, r: number, schritt: string): string {
    this.platz({ x0: cx - r, y0: cy - r, x1: cx + r + 5, y1: cy + r + 28 }, schritt);
    let holes = '';
    for (const [a, rr] of [[0, 0], ...[0, 60, 120, 180, 240, 300].map((x) => [x, r * 0.42])]) {
      holes += `<circle cx="${n1(cx + rr * Math.cos((a * Math.PI) / 180))}" cy="${n1(cy + rr * Math.sin((a * Math.PI) / 180))}" r="4" fill="${INK}"/>`;
    }
    return `<circle cx="${cx + 3}" cy="${cy + 5}" r="${r}" fill="rgb(31 26 22 / 0.16)"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="#4a4540" stroke="${INK}" stroke-width="2.6"/><circle cx="${cx}" cy="${cy}" r="${n1(r * 0.72)}" fill="#6d665e" stroke="${INK}" stroke-width="2"/>${holes}${this.t(cx, cy + r + 22, 'Lautsprecher', { fs: 14, fw: 800 })}`;
  }

  ring(cx: number, cy: number, r: number, schritt: string): string {
    this.platz({ x0: cx - r, y0: cy - r, x1: cx + r + 4, y1: cy + r + 30 }, schritt);
    const farben = ['#e5483b', '#f7941d', '#f6c12c', '#58ad46', '#12a89d', '#3f8fd6', '#7b4fc8', '#ed207b'];
    let leds = '';
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      leds += `<rect x="${n1(cx + r * 0.8 * Math.cos(a) - 5)}" y="${n1(cy + r * 0.8 * Math.sin(a) - 5)}" width="10" height="10" rx="1.5" fill="${farben[i % 8]}" stroke="${INK}" stroke-width="1.2"/>`;
    }
    return `<circle cx="${cx + 3}" cy="${cy + 5}" r="${r}" fill="rgb(31 26 22 / 0.14)"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="#1f1f1f" stroke="${INK}" stroke-width="2.4"/><circle cx="${cx}" cy="${cy}" r="${n1(r * 0.6)}" class="lp-papier" stroke="${INK}" stroke-width="2.2"/>${leds}${this.t(cx, cy + r + 24, 'Leuchtring', { fs: 14, fw: 800 })}`;
  }

  /** Three pins in a row, the names small under them (between pin and part). */
  stifte(x0: number, y: number, namen: string[], schritt: string, dx = 20, ankerPrefix = ''): string {
    let s = '';
    namen.forEach((t, i) => {
      const x = x0 + i * dx;
      s += this.auge(x, y) + this.t(x, y + 15, t, { fs: 9.5, fw: 800, hal: true });
      if (ankerPrefix) this.anker[`${ankerPrefix}:${t}`] = { p: [x, y], label: t };
    });
    this.bereich(schritt, { x0: x0 - 10, y0: y - 10, x1: x0 + (namen.length - 1) * dx + 10, y1: y + 18 }, true);
    return s;
  }

  widerstand(x: number, y: number, w: number, wert: string, schritt: string, senkrecht = false): string {
    if (senkrecht) {
      this.platz({ x0: x - 7, y0: y, x1: x + 50, y1: y + w }, schritt);
      return `<rect x="${n1(x - 7)}" y="${n1(y)}" width="14" height="${n1(w)}" rx="6" fill="#d8b98a" stroke="${INK}" stroke-width="1.8"/>${[0.25, 0.42, 0.59].map((tt, i) => `<rect x="${n1(x - 7)}" y="${n1(y + w * tt)}" width="14" height="4" fill="${['#e5483b', '#1b1b1b', '#f6c12c'][i]}"/>`).join('')}${this.t(x + 12, y + w / 2 + 5, wert, { fs: 12.5, fw: 800, a: 'start', hal: true })}`;
    }
    this.platz({ x0: x, y0: y - 26, x1: x + w, y1: y + 7 }, schritt);
    return `<rect x="${n1(x)}" y="${n1(y - 7)}" width="${n1(w)}" height="14" rx="6" fill="#d8b98a" stroke="${INK}" stroke-width="1.8"/>${[0.25, 0.42, 0.59].map((tt, i) => `<rect x="${n1(x + w * tt)}" y="${n1(y - 7)}" width="4" height="14" fill="${['#f6c12c', '#7b4fc8', '#8d5524'][i]}"/>`).join('')}${this.t(x + w / 2, y - 12, wert, { fs: 12.5, fw: 800, hal: true })}`;
  }

  elko(x: number, y: number, schritt: string, tief = false): string {
    this.platz({ x0: x - 10, y0: y, x1: x + 10, y1: y + (tief ? 62 : 50) }, schritt);
    const ly = tief ? y + 58 : y + 46;
    return `<rect x="${n1(x - 10)}" y="${n1(y)}" width="20" height="30" rx="4" fill="#2f5fb3" stroke="${INK}" stroke-width="1.8"/><rect x="${n1(x + 4)}" y="${n1(y)}" width="6" height="30" fill="#cfd8e8" opacity="0.9"/>${this.t(x + 7, y + 19, '−', { fs: 11, fw: 900, fill: INK })}${this.t(x, ly, 'Elko', { fs: 12, hal: true })}`;
  }

  /** A paper label; `dash`: drawn in pencil (something that is missing). */
  etikett(x: number, y: number, text: string, o: { fs?: number; fw?: number; dash?: boolean; schritt?: string } = {}): string {
    const fs = o.fs ?? 13;
    const w = text.length * fs * 0.56 + 18;
    this.platz({ x0: x, y0: y, x1: x + w, y1: y + fs + 12 }, o.schritt);
    return `<g><rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${fs + 12}" rx="3" class="lp-zettel" stroke="${o.dash ? BLEI : INK}" stroke-width="1.6"${o.dash ? ' stroke-dasharray="6 4"' : ''}/>${this.t(x + 9, y + fs + 3, text, { fs, fw: o.fw ?? 700, a: 'start' })}</g>`;
  }

  /** A pencil note where no ready firmware has this extra; `text` says what there is instead. */
  firmwareFehlt(x: number, y: number, schritt: string, text = 'Firmware fehlt noch'): string {
    return this.etikett(x, y, text, { fs: 12.5, dash: true, schritt });
  }

  /** A wire; its level comes from its proofs. */
  w(pts: Pkt[], farbe: string, schritt: string, belege: BelegId[], o: Omit<Draht, 'pts' | 'farbe' | 'schritt' | 'belege' | 'stufe'>): Draht {
    const d: Draht = { pts, farbe, schritt, belege, stufe: stufeVon(belege), ...o };
    this.drahte.push(d);
    // The names of the pins stand up to about 40 above or 22 below a pad (auge, rotated labels of a module).
    for (const p of pts) this.bereich(schritt, { x0: p[0] - 6, y0: p[1] - 6, x1: p[0] + 6, y1: p[1] + 6 });
    const [a, e] = [pts[0], pts[pts.length - 1]];
    for (const p of [a, e]) this.bereich(schritt, { x0: p[0] - 12, y0: p[1] - 40, x1: p[0] + 12, y1: p[1] + 22 }, true);
    return d;
  }

  /** The point of an anchor; throws on a typo, so a wire never ends nowhere. */
  at(id: string): Pkt {
    const a = this.anker[id];
    if (!a) throw new Error(`Lötplan: kein Anker ${id}`);
    return a.p;
  }

  tng(funktion: TngFunktion, pin: string) {
    return { platine: this.platine, funktion, pin };
  }
}

/* ------------------------------------------------------------------ helpers for the wires */

/** Rounded polyline through the points. */
export function weg(pts: Pkt[], r = 16): string {
  if (pts.length === 2) return `M${n1(pts[0][0])} ${n1(pts[0][1])}L${n1(pts[1][0])} ${n1(pts[1][1])}`;
  let d = `M${n1(pts[0][0])} ${n1(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const [cx, cy] = pts[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay) || 1;
    const l2 = Math.hypot(cx - bx, cy - by) || 1;
    const k1 = Math.min(r, l1 / 2);
    const k2 = Math.min(r, l2 / 2);
    d += `L${n1(bx - ((bx - ax) / l1) * k1)} ${n1(by - ((by - ay) / l1) * k1)}`;
    d += `Q${n1(bx)} ${n1(by)} ${n1(bx + ((cx - bx) / l2) * k2)} ${n1(by + ((cy - by) / l2) * k2)}`;
  }
  const z = pts[pts.length - 1];
  return `${d}L${n1(z[0])} ${n1(z[1])}`;
}

/** The point halfway along a polyline. */
export function mitte(pts: Pkt[]): Pkt {
  let total = 0;
  const seg: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(l);
    total += l;
  }
  let d = total / 2;
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i]) {
      const t = d / (seg[i] || 1);
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    d -= seg[i];
  }
  return pts[0];
}

const DUNKEL = new Set<string>([F.gnd, F.minus, '#1b1b1b']);

/** One wire as SVG: ink edge and colour; in pencil and dashed when it is not proven; with its mark. */
export function drahtSvg(d: Draht): string {
  const path = weg(d.pts);
  let s = `<g class="lp-draht${DUNKEL.has(d.farbe) ? ' schwarz' : ''}">`;
  if (d.stufe === 'ungeprueft') {
    s += `<path d="${path}" fill="none" stroke="${BLEI}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="11 8"/>`;
  } else {
    s += `<path class="rand" d="${path}" fill="none" stroke="${INK}" stroke-width="${d.dick ? 13 : 7.5}" stroke-linecap="round" stroke-linejoin="round"/>`;
    s += `<path d="${path}" fill="none" stroke="${d.farbe}" stroke-width="${d.dick ? 9 : 4.6}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (d.stufe !== 'geprueft') {
    const [x, y] = d.marke ?? mitte(d.pts);
    s += d.stufe === 'nachsehen' ? markeAusruf(x, y) : markeFrage(x, y);
  }
  return `${s}</g>`;
}

/** Check before soldering: a small note slip with "!" (paper, no signal colour). */
export function markeAusruf(x: number, y: number): string {
  return `<g transform="translate(${n1(x)} ${n1(y)}) rotate(-6)"><rect x="-10" y="-11" width="20" height="22" rx="1.5" fill="#fffbea" stroke="${INK}" stroke-width="2"/><path d="M0 -6V2" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/><circle cy="6" r="1.7" fill="${INK}"/></g>`;
}

/** Not proven yet: a pencil circle with "?". */
export function markeFrage(x: number, y: number): string {
  return `<g transform="translate(${n1(x)} ${n1(y)})"><circle r="11" class="lp-papier" stroke="${BLEI}" stroke-width="2.4" stroke-dasharray="4 3"/><text y="5.6" text-anchor="middle" font-size="16" font-weight="800" class="lp-ti">?</text></g>`;
}

export const DEFS = `<defs><pattern id="lp-schraffur" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="9" stroke="${BLEI}" stroke-width="1.6" stroke-opacity="0.7"/></pattern><marker id="lp-pfeil" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="${INK}" stroke-width="2"/></marker></defs>`;

/* ------------------------------------------------------------------ the extras of each board */

/** The extras of the chooser above the picture, with a short name for the chip. */
export const CHIP_NAMEN: Record<ExtraId, string> = {
  drehgeber: 'Drehregler',
  poti: 'Poti',
  ring: 'Leuchtring',
  ledtasten: 'LED-Tasten',
  schalter: 'Ein/Aus-Schalter',
  pololu: 'Ein/Aus-Schalter',
  dauerled: 'Dauerlicht',
  akku: 'Akku',
  lsaus: 'Stumm',
  hperkennung: 'Kopfhörer-Erkennung',
  wecker: 'Wecker',
  akkumessung: 'Akku-Anzeige',
  usbc: 'USB-C',
};

/** The chips of a board, in the order of the design (pololu is an answer of „Ein/Aus-Schalter“). */
export function chipsVon(platine: LoetplanWahl['platine']): ExtraId[] {
  return platine === 'aio' || platine === 'aioplus'
    ? ['drehgeber', 'poti', 'ring', 'akku']
    : ['drehgeber', 'poti', 'ring', 'ledtasten', 'schalter', 'akku', 'akkumessung', 'hperkennung', 'lsaus', 'wecker', 'usbc', 'dauerled'];
}

/** Whether a chip is chosen (the switch chip also when the Pololu answer is). */
export function chipAn(w: LoetplanWahl, id: ExtraId): boolean {
  return id === 'schalter' ? w.extras.includes('schalter') || w.extras.includes('pololu') : w.extras.includes(id);
}

/* ------------------------------------------------------------------ Classic v1.7 */

const S = 8.6;
const X0 = 232;
const Y0 = 196;
const P = (u: number, v: number): Pkt => [+(X0 + u * S).toFixed(1), +(Y0 + v * S).toFixed(1)];
const R = 2.54;
const rf = (i: number) => P(8.04 + i * R, 2.56);
const au = (i: number) => P(44.07 + i * R, 2.64);
const li = (i: number) => P(8.05 + i * R, 26.55);
const lg = (i: number) => P(8.03 + i * R, 29.09);

const RFID = ['3V3', 'RST', 'GND', 'IRQ', 'SO', 'SI', 'SCK', 'SDA'];
const AUDIO = ['5V', 'GND', 'GND', 'R', 'L', '+', '−'];
const NR = ['D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'GND', 'RST', 'RX0', 'TX1'];
const NL = ['D13', '3V3', 'AREF', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', '5V', 'RST', 'GND', 'VIN'];
const DFO = ['VCC', 'RX', 'TX', 'DAC_R', 'DAC_L', 'SPK1', 'GND', 'SPK2'];
const DFU = ['BUSY', 'USB−', 'USB+', 'ADK2', 'ADK1', 'IO2', 'GND', 'IO1'];
/** The ids of the pads of the left row: GND has three (index 8, 9, 14). */
const LI_ID = LINKS_INNEN.map((n, i) => (n === 'GND' ? `GND${i}` : n));

/** Picks the extra plans of the chosen extras, in the order of the chips. */
function gewaehlt(w: LoetplanWahl): ExtraPlan[] {
  return extraPlaene(w).filter((x) => w.extras.includes(x.id) && !x.gesperrt);
}

function classic(w: LoetplanWahl): Bild {
  const z = new Zeichnung('classic');
  const xs = gewaehlt(w);
  const has = (id: ExtraId) => xs.some((x) => x.id === id);
  const every = w.nano === 'every';
  const nanoName = every ? 'Nano Every' : 'Nano';
  const schalter = has('schalter') ? w.schalter : undefined;
  const fremdStrom = has('pololu') || has('akku') || has('usbc');

  // --- the board
  const [bx0, by0] = P(0, 0);
  const [bx1, by1] = P(67.31, 30.48);
  z.platz({ x0: bx0, y0: by0, x1: bx1 + 5, y1: by1 + 6 }, 'buchsen');
  let b = `<rect x="${bx0 + 5}" y="${by0 + 6}" width="${n1(bx1 - bx0)}" height="${n1(by1 - by0)}" rx="10" fill="rgb(31 26 22 / 0.2)"/><rect x="${bx0}" y="${by0}" width="${n1(bx1 - bx0)}" height="${n1(by1 - by0)}" rx="10" fill="#1d1d1f" stroke="${INK}" stroke-width="3"/>`;
  for (const [u, v] of [
    [2.53, 2.54],
    [2.53, 27.94],
    [64.76, 2.54],
    [64.76, 27.94],
    [55.7, 25.08],
  ]) {
    const [x, y] = P(u, v);
    b += `<circle cx="${x}" cy="${y}" r="${n1(1.55 * S)}" fill="#f6f1e8" stroke="#8a8174" stroke-width="2"/>`;
  }
  const [nx0, ny0] = P(3.6, 5.4);
  const [nx1, ny1] = P(43.0, 24.6);
  const [ux0, uy0] = P(0.6, 12.0);
  const [ux1, uy1] = P(6.4, 18.0);
  b += `<rect x="${nx0}" y="${ny0}" width="${n1(nx1 - nx0)}" height="${n1(ny1 - ny0)}" rx="4" fill="#20578f" stroke="${INK}" stroke-width="2.2"/><rect x="${ux0}" y="${uy0}" width="${n1(ux1 - ux0)}" height="${n1(uy1 - uy0)}" rx="2" fill="#b9bcc2" stroke="${INK}" stroke-width="2"/>`;
  b += z.t((nx0 + nx1) / 2 + 10, (ny0 + ny1) / 2 + 6, every ? 'Arduino Nano Every' : 'Arduino Nano', { fs: 17, fw: 800, fill: '#fff' });
  b += z.t((nx0 + nx1) / 2 + 10, (ny0 + ny1) / 2 + 24, 'USB-Buchse nach links', { fs: 12, fw: 600, fill: '#dbe7f5' });
  NR.forEach((t, i) => {
    const [x, y] = P(5.53 + i * R, 7.41);
    b += z.auge(x, y) + z.t(x, y + 17, t, { fs: 9, fill: '#cfe0f2' });
  });
  NL.forEach((t, i) => {
    const [x, y] = P(5.53 + i * R, 22.66);
    b += z.auge(x, y) + z.t(x, y - 10, t, { fs: 9, fill: '#cfe0f2' });
  });
  // The MP3 player, plugged in: its pins with their numbers 1–16 (data sheet FN-M16P), so BUSY (16) and SPK (6, 8) can be found.
  const [dx0, dy0] = P(45.4, 4.8);
  const [dx1, dy1] = P(66.2, 25.4);
  const dmx = (dx0 + dx1) / 2;
  b += `<rect x="${dx0}" y="${dy0}" width="${n1(dx1 - dx0)}" height="${n1(dy1 - dy0)}" rx="4" fill="#b8322a" stroke="${INK}" stroke-width="2.2"/><rect x="${n1(dmx - 28)}" y="${n1(dy0 + 42)}" width="56" height="62" rx="3" fill="#d8d3c9" stroke="${INK}" stroke-width="1.6"/>`;
  b += z.t(dmx, dy0 + 66, 'MP3-', { fs: 13, fw: 800, fill: INK }) + z.t(dmx, dy0 + 82, 'Player', { fs: 13, fw: 800, fill: INK }) + z.t(dmx, dy0 + 98, 'SD-Karte', { fs: 9.5, fw: 600, fill: INK });
  DFO.forEach((t, i) => {
    const [x, y] = P(46.91, 6.12 + i * R);
    b += z.auge(x, y, '', 'r', { eckig: i === 0 }) + z.t(x + 9, y + 4, `${i + 1} ${t}`, { fs: 9, a: 'start', fill: '#ffe1dc' });
  });
  DFU.forEach((t, i) => {
    const [x, y] = P(64.68, 6.12 + i * R);
    b += z.auge(x, y) + z.t(x - 9, y + 4, `${t} ${16 - i}`, { fs: 9, a: 'end', fill: '#ffe1dc' });
  });
  // The rows to solder.
  RFID.forEach((t, i) => {
    const [x, y] = rf(i);
    b += z.auge(x, y, t, 'u', { fs: 10 });
    z.anker[`rf:${t}`] = { p: [x, y], label: t };
  });
  AUDIO.forEach((t, i) => {
    const [x, y] = au(i);
    b += z.auge(x, y, t, 'u', { fs: 11 });
    z.anker[`au:${i === 1 ? 'GNDa' : i === 2 ? 'GNDb' : t}`] = { p: [x, y], label: t };
  });
  LINKS_INNEN.forEach((t, i) => {
    const [x, y] = li(i);
    b += z.auge(x, y, t, 'o', { fs: 10.5 });
    z.anker[`li:${LI_ID[i]}`] = { p: [x, y], label: t, ...(t === 'GND' ? {} : { pin: t }) };
  });
  for (let i = 0; i < 6; i++) {
    const [x, y] = lg(i);
    // The name of the first ground pad sits further out: the Play/Pause wire passes between pad and name (Prüfrunde 1, bastler 5).
    b += z.auge(x, y, '', 'l', { fs: 10 }) + (i === 0 ? z.t(x - 16, y + 4, 'GND', { fs: 10, a: 'end', fill: '#fff' }) : '');
    z.anker[`lg:${i}`] = { p: [x, y], label: 'GND' };
  }
  const [r7x, r7y] = P(38.43, 4.51);
  b += `<rect x="${n1(r7x - 6)}" y="${n1(r7y - 3)}" width="12" height="6" fill="#d8d3c9" stroke="#000" stroke-width="1"/>` + z.t(r7x - 9, r7y + 4, 'R7 1 kΩ', { fs: 9, a: 'end', fill: '#cfe0f2' });
  b += z.t(X0 + 61.4 * S, by1 - 28, 'TonUINO Classic v1.7', { fs: 12, a: 'end', fill: '#9a958d' });
  z.teile.push(b);

  // --- card reader: 7 wires, same names (print of the board v1.7, photos)
  const r0x = rf(0)[0];
  const r7xx = rf(7)[0];
  const rcX = r0x - 30;
  const rcW = r7xx - r0x + 60;
  z.teile.push(z.kasten(rcX, 38, rcW, 104, '#2a63b8', 'Kartenleser RC522', { nameY: 62, schritt: 'rfid' }));
  const RCN = ['3.3V', 'RST', 'GND', 'IRQ', 'MISO', 'MOSI', 'SCK', 'SDA'];
  const rfC = [C.v33, C.rst, C.gnd, null, C.so, C.si, C.sck, C.sda];
  RCN.forEach((t, i) => {
    const x = rf(i)[0];
    z.ueber.push(z.auge(x, 130) + z.t(x - 2, 118, t, { fs: 10, fill: '#fff', a: 'start', rot: -50 }));
    z.anker[`rc:${t}`] = { p: [x, 130], label: t };
    const farbe = rfC[i];
    if (farbe)
      z.w([[x, 130], rf(i)], farbe, 'rfid', RFID[i] === 'SO' || RFID[i] === 'SI' ? ['v17-foto-rfid', 'v17-so-si'] : ['v17-foto-rfid'], {
        von: RFID[i],
        nach: `Kartenleser ${t}`,
        a: `rf:${RFID[i]}`,
        b: `rc:${t}`,
        marke: [x, 166 + (i % 2) * 6],
      });
  });
  z.frei.push({ schritt: 'rfid', text: 'IRQ bleibt frei', belege: ['cl-v15'] });
  z.ueber.push(z.etikett(rcX + rcW + 8, 96, 'IRQ bleibt frei', { fs: 12, fw: 600, schritt: 'rfid' }));

  // --- buttons: one leg at A…, the other at the GND beside it
  const tasten: [string, string, string, BelegId, TngFunktion][] =
    w.tasten === 5
      ? [
          ['A0', 'Play/Pause', C.play, 'cl-v16', 'pause'],
          ['A1', 'Lauter', C.laut, 'cl-v20a', 'four5'],
          ['A2', 'Leiser', C.leis, 'cl-v20b', 'five5'],
          ['A3', 'Vor', C.vor, 'cl-v20c', 'up5'],
          ['A4', 'Zurück', C.zur, 'cl-v20d', 'down5'],
        ]
      : [
          ['A0', 'Play/Pause', C.play, 'cl-v16', 'pause'],
          ['A1', 'Vor / lauter', C.vor, 'cl-v17', 'up3'],
          ['A2', 'Zurück / leiser', C.zur, 'cl-v18', 'down3'],
        ];
  const tastenX = w.tasten === 5 ? [96, 176, 256, 336, 416] : [126, 224, 322];
  const TY = 566;
  tasten.forEach(([pin, name, farbe, beleg, fn], i) => {
    const cx = tastenX[i];
    z.teile.push(z.taste(cx, TY, farbe, name, 'tasten'));
    z.anker[`taste${i}:a`] = { p: [cx - 12, TY - 28], label: name };
    z.anker[`taste${i}:b`] = { p: [cx + 13, TY - 28], label: name };
    const [ax, ay] = li(i);
    const [gx, gy] = lg(i);
    z.w(
      [
        [ax, ay],
        [ax - 10, ay + 12],
        [ax - 10, 488 + i * 6],
        [cx - 12, 506 + i * 4],
        [cx - 12, TY - 28],
      ],
      farbe,
      'tasten',
      ['v17-foto-links', beleg],
      { von: pin, nach: `Taste ${name}, ein Bein`, a: `li:${pin}`, b: `taste${i}:a`, tng: z.tng(fn, pin) },
    );
    // With the Pololu switch the other leg of Play/Pause goes to its A, not to ground.
    if (i === 0 && has('pololu')) return;
    z.w(
      [
        [gx, gy],
        [gx + 4, 472],
        [cx + 13, 520 + i * 3],
        [cx + 13, TY - 28],
      ],
      C.gnd,
      'tasten',
      ['v17-foto-links', 'cl-v19'],
      { von: 'GND', nach: 'das andere Bein jeder Taste', a: `lg:${i}`, b: `taste${i}:b` },
    );
  });

  // --- sound: headphone board, single socket or speaker alone
  const lsx = 905;
  const lsy = 96;
  z.teile.push(z.lautsprecher(lsx, lsy, 40, 'ton'));
  z.anker['ls:+'] = { p: [lsx - 40, 84], label: '+' };
  z.anker['ls:−'] = { p: [lsx - 40, 104], label: '−' };
  // The speaker wires pass the box of „Stumm“ when that extra is chosen.
  const stummX = has('lsaus') ? 800 : 0;
  const zumLautsprecher = (from: Pkt, y: number): Pkt[] => (stummX && from[0] < stummX ? [from, [stummX - 4, y]] : [from, [lsx - 40, y]]);
  if (w.kh === 'platine') {
    const khPins = ['G', 'DR', 'DL', 'SK', 'SK'];
    const khC = [C.gnd, C.r, C.l, C.plus, C.minus];
    const k0x = au(2)[0];
    const k4x = au(6)[0];
    z.teile.push(z.kasten(k0x - 34, 52, k4x - k0x + 68, 90, '#3f8a54', 'Kopfhörerplatine', { nameY: 78, fs: 14, schritt: 'ton' }));
    khPins.forEach((t, i) => {
      const [x, y] = au(i + 2);
      z.ueber.push(z.auge(x, 130, t, 'o', { fs: 10.5 }));
      z.anker[`kh:${i}`] = { p: [x, 130], label: t };
      z.w([[x, 130], [x, y]], khC[i], 'ton', ['v17-foto-audio', 'oas-v10'], { von: AUDIO[i + 2], nach: `Kopfhörerplatine ${t}`, a: `au:${i === 0 ? 'GNDb' : AUDIO[i + 2]}`, b: `kh:${i}` });
    });
    z.w(zumLautsprecher([k4x + 34, 84], 84), C.plus, 'ton', ['oas-v14'], { von: 'Speaker', nach: 'Lautsprecher, beide Kabel' });
    z.w(zumLautsprecher([k4x + 34, 104], 104), C.minus, 'ton', ['oas-v14'], { von: 'Speaker', nach: 'Lautsprecher, beide Kabel' });
    z.ueber.push(z.t(k4x + 40, 76, 'Speaker', { fs: 11, a: 'start', hal: true }));
  } else if (w.kh === 'buchse') {
    // Socket FC68129: GND to 1, R to 4, L to 3, + to 5; 7 to the speaker (forum 96 #146).
    const bx = au(2)[0] - 30;
    const bw = au(5)[0] + 14 - bx;
    z.teile.push(z.kasten(bx, 52, bw, 90, '#3f8a54', 'Buchse', { nameY: 76, fs: 14, sub: 'FC68129', schritt: 'ton' }));
    const pins: [number, string, string, BelegId, string][] = [
      [2, '1', C.gnd, 'oas-v64', 'Masse'],
      [3, '4', C.r, 'oas-v63', 'rechts'],
      [4, '3', C.l, 'oas-v62', 'links'],
      [5, '5', C.plus, 'oas-v60', 'Schalter'],
    ];
    pins.forEach(([i, t, farbe, beleg, was]) => {
      const [x, y] = au(i);
      z.ueber.push(z.auge(x, 130, t, 'o', { fs: 10.5 }));
      z.anker[`kh:${t}`] = { p: [x, 130], label: t };
      z.w([[x, 130], [x, y]], farbe, 'ton', ['v17-foto-audio', beleg], { von: AUDIO[i], nach: `Buchse Pin ${t} (${was})`, a: `au:${i === 2 ? 'GNDb' : AUDIO[i]}`, b: `kh:${t}` });
    });
    z.ueber.push(z.auge(bx + bw, 84, '7', 'l', { fs: 10.5 }));
    z.w(zumLautsprecher([bx + bw, 84], 84), C.plus, 'ton', ['oas-v61'], { von: 'Buchse Pin 7', nach: 'Lautsprecher' });
    const [mx, my] = au(6);
    z.w([[mx, my], [mx, 104], ...zumLautsprecher([mx, 104], 104).slice(1)], C.minus, 'ton', ['v17-foto-audio', 'oas-v03'], { von: '−', nach: 'Lautsprecher, anderes Kabel', a: 'au:−' });
  } else {
    const [px, py] = au(5);
    const [mx, my] = au(6);
    z.w([[px, py], [px, 84], ...zumLautsprecher([px, 84], 84).slice(1)], C.plus, 'ton', ['v17-foto-audio', 'oas-v03'], { von: '+', nach: 'Lautsprecher', a: 'au:+' });
    z.w([[mx, my], [mx, 104], ...zumLautsprecher([mx, 104], 104).slice(1)], C.minus, 'ton', ['v17-foto-audio', 'oas-v03'], { von: '−', nach: 'Lautsprecher', a: 'au:−' });
  }

  // --- power: mains adapter or power bank into the Nano (unless an extra brings it)
  if (!fremdStrom) {
    z.teile.push(z.kasten(24, 300, 150, 62, '#4a4a4a', 'Netzteil oder', { sub: 'Powerbank, 5 V', nameY: 325, schritt: 'strom' }));
    // With the switch, only the red wire of this cable runs through it (extra „Ein/Aus-Schalter“ below).
    z.w([[174, 331], [ux0 - 2, 331]], C.usb, 'strom', ['usb'], { von: 'Netzteil', nach: `USB-Buchse am ${nanoName}`, dick: true });
  }
  z.bereich('strom', { x0: nx0, y0: ny0, x1: dx1, y1: dy1 });

  /* ---------------- extras ---------------- */
  const v5: Pkt = au(0);
  const gndA: Pkt = au(1);
  /** From a point below the board up the right side to 5V of the audio row (the "5V-Schiene" of the design). */
  const nach5V = (from: Pkt, lane: number, y = 532): Pkt[] => [from, [from[0], y], [lane, y], [lane, 168], [v5[0] + 4, 168], v5];

  if (has('drehgeber')) {
    const kx = 466;
    const ky = 548;
    z.teile.push(z.kasten(kx, ky, 128, 86, '#2d6a3e', 'Drehregler', { nameY: ky + 78, fs: 14, schritt: 'drehgeber' }));
    z.teile.push(`<circle cx="${kx + 64}" cy="${ky + 46}" r="12" fill="#9a958d" stroke="${INK}" stroke-width="2"/><path d="M${kx + 64} ${ky + 35}V${ky + 46}" stroke="${INK}" stroke-width="3"/>`);
    const pinx = (i: number) => kx + 16 + i * 24;
    ['CLK', 'DT', 'SW', '+', 'GND'].forEach((t, i) => {
      z.ueber.push(z.auge(pinx(i), ky, t, 'u', { schrift: '#fff', fs: 10 }));
      z.anker[`ky:${t}`] = { p: [pinx(i), ky], label: t };
    });
    const [a3x, a3y] = li(3);
    const [a4x, a4y] = li(4);
    const [g3x, g3y] = lg(3);
    z.w([[a3x, a3y], [a3x + 11, a3y + 12], [a3x + 11, 480], [pinx(0), 508], [pinx(0), ky]], C.clk, 'drehgeber', ['cl-enc-clk'], { von: 'A3', nach: 'Drehregler CLK', a: 'li:A3', b: 'ky:CLK', tng: z.tng('encClk', 'A3') });
    z.w([[a4x, a4y], [a4x + 11, a4y + 12], [a4x + 11, 474], [pinx(1), 500], [pinx(1), ky]], C.dt, 'drehgeber', ['cl-enc-dt'], { von: 'A4', nach: 'Drehregler DT', a: 'li:A4', b: 'ky:DT', tng: z.tng('encDt', 'A4') });
    z.w([[g3x, g3y], [g3x + 5, 466], [pinx(4) + 6, 466], [pinx(4), ky]], C.gnd, 'drehgeber', ['v17-foto-links', 'cl-enc-gnd'], { von: 'GND', nach: 'Drehregler GND', a: 'lg:3', b: 'ky:GND' });
    z.w(nach5V([pinx(3), ky], 944), C.v5, 'drehgeber', ['cl-enc-plus', 'v17-5v'], { von: '5V', nach: 'Drehregler +', a: 'ky:+', b: 'au:5V', marke: [944, 360] });
    z.frei.push({ schritt: 'drehgeber', text: 'Drehregler SW bleibt frei (oder an A0, parallel zur Play/Pause-Taste)', belege: ['cl-enc-sw'] });
  }
  if (has('poti')) {
    const kx = 466;
    const ky = 548;
    z.teile.push(z.kasten(kx, ky, 128, 86, '#2f4f7f', 'Poti 10 kΩ', { nameY: ky + 78, fs: 14, schritt: 'poti' }));
    z.teile.push(`<rect x="${kx + 52}" y="${ky + 30}" width="24" height="18" rx="2" fill="#9a958d" stroke="${INK}" stroke-width="2"/><path d="M${kx + 64} ${ky + 20}V${ky + 36}" stroke="${INK}" stroke-width="4"/>`);
    const pinx = (i: number) => kx + 24 + i * 40;
    ['Ende', 'Mitte', 'Ende'].forEach((t, i) => {
      z.ueber.push(z.auge(pinx(i), ky, t, 'u', { schrift: '#fff', fs: 10 }));
      z.anker[`poti:${i}`] = { p: [pinx(i), ky], label: t };
    });
    const [a3x, a3y] = li(3);
    const [g3x, g3y] = lg(3);
    z.w([[a3x, a3y], [a3x + 11, a3y + 12], [a3x + 11, 480], [pinx(1), 506], [pinx(1), ky]], C.sda, 'poti', ['cl-poti-s'], { von: 'A3', nach: 'Poti, Mitte', a: 'li:A3', b: 'poti:1', tng: z.tng('poti', 'A3') });
    z.w([[g3x, g3y], [g3x + 5, 466], [pinx(2) + 6, 466], [pinx(2), ky]], C.gnd, 'poti', ['v17-foto-links', 'cl-poti-gnd'], { von: 'GND', nach: 'Poti, ein äußeres Bein', a: 'lg:3', b: 'poti:2' });
    if (every) {
      // Nano Every: 3V3 is the better end (it measures against 2.5 V), derived from the source, not tried (recherche-extras.md 6).
      const [tx, ty] = rf(0);
      z.w([[pinx(0), ky], [pinx(0), 532], [958, 532], [958, 18], [262, 18], [262, 176], [tx - 4, 176], [tx, ty]], C.v33, 'poti', ['ev-poti-3v3'], { von: '3V3', nach: 'Poti, anderes äußeres Bein', a: 'poti:0', b: 'rf:3V3', marke: [958, 300] });
    } else z.w(nach5V([pinx(0), ky], 944), C.v5, 'poti', ['cl-poti-vcc', 'v17-5v'], { von: '5V', nach: 'Poti, anderes äußeres Bein', a: 'poti:0', b: 'au:5V', marke: [944, 360] });
  }
  if (has('ring')) {
    const rx = 790;
    const ry = 574;
    z.teile.push(z.ring(rx, ry, 52, 'ring'));
    const [d5x, d5y] = li(13);
    const [gx, gy] = li(14);
    z.teile.push(z.widerstand(652, 498, 46, '470 Ω', 'ring'));
    z.ueber.push(z.stifte(rx - 20, ry - 66, ['DIN', '5V', 'GND'], 'ring', 20, 'ring'));
    z.anker['r470:a'] = { p: [652, 498], label: '470 Ω' };
    z.anker['r470:b'] = { p: [698, 498], label: '470 Ω' };
    z.w([[d5x, d5y], [d5x, 498], [652, 498]], C.din, 'ring', ['cl-neo-din'], { von: 'D5', nach: 'Widerstand 470 Ω', a: 'li:D5', b: 'r470:a', tng: z.tng('ring', 'D5') });
    z.w([[698, 498], [rx - 20, 498], [rx - 20, ry - 66]], C.din, 'ring', ['neo-widerstand'], { von: 'Widerstand 470 Ω', nach: 'Leuchtring DIN', a: 'r470:b', b: 'ring:DIN' });
    z.w([[gx, gy], [gx + 4, 478], [rx + 20, 478], [rx + 20, ry - 66]], C.gnd, 'ring', ['cl-neo-gnd'], { von: 'GND', nach: 'Leuchtring GND', a: 'li:GND14', b: 'ring:GND' });
    z.w([v5, [v5[0] + 4, 168], [930, 168], [930, 462], [rx, 462], [rx, ry - 66]], C.v5, 'ring', ['cl-neo-5v', 'v17-5v'], { von: '5V', nach: 'Leuchtring 5V', a: 'au:5V', b: 'ring:5V', marke: [930, 300] });
    z.teile.push(z.elko(884, 486, 'ring'));
    z.w([[884, 486], [884, 470], [930, 470]], C.v5, 'ring', ['cl-neo-elko'], { von: 'Elko +', nach: '5V des Rings (langes Bein)' });
    z.w([[884, 516], [884, 528], [rx + 34, 528], [rx + 34, 478], [rx + 20, 478]], C.gnd, 'ring', ['cl-neo-elko'], { von: 'Elko −', nach: 'GND des Rings (Streifen)' });
    z.frei.push({ schritt: 'ring', text: 'Leuchtring DOUT (Daten raus) bleibt frei', belege: ['cl-neo-din'] });
  }
  if (has('ledtasten')) {
    // The LEDs inside the buttons: + through 1 kΩ to A5 (Play/Pause), D6 (Vor), D5 (Zurück), − of all three to GND (TNG constants.hpp:508–510).
    const leds: [string, number, string, BelegId, TngFunktion][] = [
      ['A5', 0, 'Play/Pause', 'cl-led-play', 'ledPlay'],
      ['D6', w.tasten === 5 ? 3 : 1, 'Vor', 'cl-led-vor', 'ledUp'],
      ['D5', w.tasten === 5 ? 4 : 2, 'Zurück', 'cl-led-zurueck', 'ledDown'],
    ];
    const ly = 644;
    leds.forEach(([pin, ti, name, beleg, fn], k) => {
      const cx = tastenX[ti];
      z.ueber.push(z.auge(cx - 12, ly, '+', 'l', { fs: 11, ink: true }) + z.auge(cx + 12, ly, '−', 'r', { fs: 11, ink: true }));
      z.anker[`led${k}:+`] = { p: [cx - 12, ly], label: '+' };
      z.anker[`led${k}:−`] = { p: [cx + 12, ly], label: '−' };
      z.bereich('ledtasten', { x0: cx - 30, y0: TY - 30, x1: cx + 30, y1: ly + 12 });
      const lane = 690 + k * 18;
      const rxx = cx - 60;
      z.teile.push(z.widerstand(rxx, lane, 34, '1 kΩ', 'ledtasten'));
      const [px, py] = li(LI_ID.indexOf(pin));
      const riser = pin === 'A5' ? 432 + 11 - 22 : pin === 'D6' ? 612 : 626;
      const start: Pkt[] = pin === 'A5' ? [[px, py], [px + 11, py + 12], [riser, 470]] : [[px, py], [px, py + 14], [riser, py + 30]];
      z.w([...start, [riser, lane], [rxx + 34, lane]], C.led, 'ledtasten', [beleg], { von: pin, nach: `Widerstand 1 kΩ, LED ${name}`, a: `li:${pin}`, tng: z.tng(fn, pin) });
      z.w([[rxx, lane], [cx - 26, lane], [cx - 26, ly + 10], [cx - 12, ly]], C.led, 'ledtasten', [beleg], { von: 'Widerstand 1 kΩ', nach: `LED + in der Taste ${name}`, b: `led${k}:+` });
    });
    // − chained from button to button, then to GND14.
    const minus = leds.map(([, ti]) => tastenX[ti] + 12);
    for (let k = 0; k < 2; k++) z.w([[minus[k], ly], [minus[k], ly - 14], [minus[k + 1] - 6, ly - 14], [minus[k + 1], ly]], C.gnd, 'ledtasten', ['cl-led-gnd'], { von: `LED − ${leds[k][2]}`, nach: `LED − ${leds[k + 1][2]}` });
    const [gx, gy] = li(14);
    z.w([[minus[2], ly], [minus[2] + 14, ly + 14], [640, ly + 14], [640, 470], [gx + 4, 456], [gx, gy]], C.gnd, 'ledtasten', ['cl-led-gnd'], { von: 'GND', nach: 'LED − aller Tasten', b: 'li:GND14' });
  }
  if (has('wecker')) {
    // A6 with 100 kΩ to GND (TNG author, forum 13947 #2); how the alarm clock drives A6 is in no source.
    const [a6x, a6y] = li(6);
    const [g8x, g8y] = li(8);
    const rx = 487;
    z.teile.push(z.widerstand(rx, 478, 36, '100 kΩ', 'wecker', true));
    z.anker['r100:a'] = { p: [rx, 478], label: '100 kΩ' };
    z.anker['r100:b'] = { p: [rx, 514], label: '100 kΩ' };
    z.w([[a6x, a6y], [a6x + 11, a6y + 12], [a6x + 11, 462], [rx, 462], [rx, 478]], C.weck, 'wecker', ['wecker-pulldown'], { von: 'A6', nach: 'Widerstand 100 kΩ', a: 'li:A6', b: 'r100:a', tng: z.tng('specialStart', 'A6') });
    z.w([[rx, 514], [rx, 526], [g8x - 11, 526], [g8x - 11, g8y + 14], [g8x, g8y]], C.gnd, 'wecker', ['wecker-pulldown'], { von: 'Widerstand 100 kΩ', nach: 'GND', a: 'r100:b', b: 'li:GND8' });
    // The box stays clear of the wires of „Akku-Anzeige“ (Prüfrunde 1, bastler 5).
    // With LED buttons their resistors take the row under the buttons: the box goes below them.
    const wx = 200;
    const wy = has('ledtasten') ? 752 : 672;
    const quer = wy - 16;
    z.teile.push(z.kasten(wx, wy, 150, 50, '#fff', 'Wecker', { offen: true, nameY: wy + 22, sub: 'noch nicht belegt', fs: 14, schritt: 'wecker' }));
    z.w([[a6x, a6y], [a6x, quer], [wx + 120, quer], [wx + 120, wy]], C.weck, 'wecker', ['wecker-kontakt'], { von: 'A6', nach: 'Wecker, Schaltausgang', a: 'li:A6', tng: z.tng('specialStart', 'A6'), marke: [a6x, 600] });
  }
  if (has('akkumessung')) {
    // A5 between two 100 kΩ: one to the cell (+), one to GND (TNG constants.hpp:405, 415).
    const [a5x, a5y] = li(5);
    const [g5x, g5y] = lg(5);
    const mx = 548;
    z.teile.push(z.widerstand(mx, 690, 36, '100 kΩ', 'akkumessung', true));
    z.teile.push(z.widerstand(mx + 64, 690, 36, '100 kΩ', 'akkumessung', true));
    z.w([[a5x, a5y], [a5x + 11, a5y + 12], [a5x + 11, 470], [a5x + 33, 476], [a5x + 33, 676], [mx + 32, 676], [mx + 32, 690], [mx, 690]], C.dt, 'akkumessung', ['akkumessung-teiler'], { von: 'A5', nach: 'zwischen die beiden 100 kΩ', a: 'li:A5', tng: z.tng('batVoltage', 'A5') });
    z.w([[mx + 64, 690], [mx + 32, 690]], C.dt, 'akkumessung', ['akkumessung-teiler'], { von: '100 kΩ', nach: '100 kΩ' });
    z.w([[mx, 726], [mx, 740], [g5x - 26, 740], [g5x - 26, g5y + 12], [g5x, g5y]], C.gnd, 'akkumessung', ['akkumessung-teiler'], { von: 'Widerstand 100 kΩ', nach: 'GND', b: 'lg:5' });
    if (has('akku')) z.w([[mx + 64, 726], [mx + 64, 760], [12, 760], [12, 214], [40, 214]], C.akku, 'akkumessung', ['akkumessung-zelle'], { von: 'Widerstand 100 kΩ', nach: 'Akku + (an der Zelle, nicht hinter dem Wandler)', b: 'akku:+', marke: [12, 500] });
    else {
      // Below the resistor, clear of the box of „Kopfhörer erkennen“ (Prüfrunde 1, bastler 5).
      z.teile.push(z.kasten(mx - 11, 790, 150, 46, '#fff', 'Akku +', { offen: true, nameY: 810, sub: 'an der Zelle', fs: 13, schritt: 'akkumessung' }));
      z.w([[mx + 64, 726], [mx + 64, 790]], C.akku, 'akkumessung', ['akkumessung-zelle'], { von: 'Widerstand 100 kΩ', nach: 'Akku + (an der Zelle)', marke: [mx + 64, 762] });
    }
  }
  if (has('hperkennung')) {
    // A socket with a switch contact (PJ-307): JD (pin 6) to D8 (forum 13613), the other side of the contact to GND: not proven.
    const [d8x, d8y] = li(10);
    const hx = 700;
    const hy = 700;
    z.teile.push(z.kasten(hx, hy, 170, 70, '#3f8a54', 'Buchse mit', { nameY: hy + 24, sub: 'Schaltkontakt (PJ-307)', fs: 13, schritt: 'hperkennung' }));
    // The pin names beside the wires that come down onto them, not under them.
    z.ueber.push(z.auge(hx + 30, hy) + z.t(hx + 39, hy - 7, '6 JD', { fs: 10.5, a: 'start' }) + z.auge(hx + 130, hy) + z.t(hx + 121, hy - 7, 'GND', { fs: 10.5, a: 'end' }));
    z.anker['hp:JD'] = { p: [hx + 30, hy], label: 'JD' };
    z.anker['hp:GND'] = { p: [hx + 130, hy], label: 'GND' };
    z.w([[d8x, d8y], [d8x - 6, d8y + 14], [598, 454], [598, 664], [hx + 30, 664], [hx + 30, hy]], C.hp, 'hperkennung', ['hp-pj307'], { von: 'D8', nach: 'Buchse Pin 6 (JD)', a: 'li:D8', b: 'hp:JD', tng: z.tng('hpDetect', 'D8'), marke: [650, 664] });
    const [gx, gy] = li(14);
    z.w([[hx + 130, hy], [hx + 130, 652], [960, 652], [960, 446], [gx + 14, 446], [gx, gy]], C.gnd, 'hperkennung', ['hp-gnd-seite'], { von: 'GND', nach: 'Schaltkontakt der Buchse, ohne Stecker an GND', a: 'hp:GND', b: 'li:GND14', marke: [960, 560] });
  }
  if (has('lsaus')) {
    // D6 HIGH = speaker on (TNG constants.hpp:284); the circuit between D6 and the speaker is not proven.
    const sx = stummX;
    z.teile.push(z.kasten(sx, 58, 60, 72, '#fff', 'Stumm', { offen: true, nameY: 98, fs: 12, schritt: 'lsaus' }));
    z.w([[sx + 60, 84], [lsx - 40, 84]], C.plus, 'lsaus', ['spkonoff-schaltung'], { von: 'Stumm-Schaltung', nach: 'Lautsprecher' });
    z.w([[sx + 60, 104], [lsx - 40, 104]], C.minus, 'lsaus', ['spkonoff-schaltung'], { von: 'Stumm-Schaltung', nach: 'Lautsprecher' });
    const [d6x, d6y] = li(12);
    z.w([[d6x, d6y], [d6x, d6y + 16], [612, 456], [1010, 456], [1010, 22], [sx + 30, 22], [sx + 30, 58]], C.stumm, 'lsaus', ['spkonoff-schaltung'], { von: 'D6', nach: 'Stumm-Schaltung (Relais oder MOSFET)', a: 'li:D6', tng: z.tng('spkOnOff', 'D6'), marke: [1010, 240] });
  }
  if (has('dauerled')) {
    // A white LED with 120 Ω between 5V and GND keeps many power banks awake (Ohm's law, forum 6179).
    const lx = 980;
    z.teile.push(z.widerstand(lx, 196, 40, '120 Ω', 'dauerled', true));
    z.teile.push(`<path d="M${lx - 12} 270h24l-12 18z" fill="#fff8d6" stroke="${INK}" stroke-width="1.8"/><path d="M${lx - 12} 288h24" stroke="${INK}" stroke-width="2.4"/>` + z.t(lx + 18, 284, 'LED weiß', { fs: 12, a: 'start', hal: true }));
    z.platz({ x0: lx - 14, y0: 266, x1: lx + 80, y1: 292 }, 'dauerled');
    z.w([v5, [v5[0] - 4, 176], [lx, 176], [lx, 196]], C.v5, 'dauerled', ['ohm-led', 'v17-5v'], { von: '5V', nach: 'Widerstand 120 Ω', a: 'au:5V', marke: [lx - 60, 176] });
    z.w([[lx, 236], [lx, 270]], C.v5, 'dauerled', ['ohm-led'], { von: 'Widerstand 120 Ω', nach: 'LED + (langes Bein)' });
    // Up beside the board and over the audio row, not across the MP3 player (Prüfrunde 1, bastler 5).
    z.w([[lx, 288], [lx, 304], [lx - 30, 304], [lx - 30, 190], [gndA[0] + 4, 190], gndA], C.gnd, 'dauerled', ['ohm-led'], { von: 'LED − (kurzes Bein)', nach: 'GND', b: 'au:GNDa' });
  }

  // --- the power extras: one way for the power (they exclude each other, loetplan.ts SCHLIESST_AUS)
  if (has('pololu')) {
    const px = 24;
    const py = 380;
    z.teile.push(z.kasten(px, py, 170, 120, '#2a6db0', 'Pololu-Schalter', { nameY: py + 24, fs: 13, schritt: 'pololu' }));
    ['A', 'OFF', 'VOUT', 'GND'].forEach((t, i) => {
      const x = px + 22 + i * 40;
      z.ueber.push(z.auge(x, py + 120, t, 'o', { fs: 10, schrift: '#fff' }));
      z.anker[`pol:${t}`] = { p: [x, py + 120], label: t };
    });
    ['VIN', 'GND'].forEach((t, i) => {
      z.ueber.push(z.auge(px, py + 50 + i * 26, t, 'r', { fs: 10, schrift: '#fff' }));
      z.anker[`pol:${t}in`] = { p: [px, py + 50 + i * 26], label: t };
    });
    z.teile.push(z.kasten(24, 270, 150, 62, '#4a4a4a', 'Powerbank', { sub: 'Kabel aufgeschnitten', nameY: 295, schritt: 'pololu' }));
    z.w([[40, 332], [12, 352], [12, py + 50], [px, py + 50]], C.v5, 'pololu', ['oas-v30'], { von: 'Powerbank + (rot)', nach: 'Pololu VIN', b: 'pol:VINin' });
    z.w([[60, 332], [4, 366], [4, py + 76], [px, py + 76]], C.gnd, 'pololu', ['oas-v31'], { von: 'Powerbank −', nach: 'Pololu GND', b: 'pol:GNDin' });
    const play = z.at('taste0:b');
    z.w([[px + 22, py + 120], [px + 22, 520], [play[0], 520], play], C.pbn, 'pololu', ['oas-v35'], { von: 'Pololu A', nach: 'Taste Play/Pause, anderes Bein (statt GND)', a: 'pol:A', b: 'taste0:b' });
    const [d7x, d7y] = li(11);
    z.w([[d7x, d7y], [d7x, d7y + 18], [d7x - 10, 456], [px + 62, 456], [px + 62, py + 120]], C.aus, 'pololu', ['oas-v34'], { von: 'D7', nach: 'Pololu OFF', a: 'li:D7', b: 'pol:OFF', tng: z.tng('shutdown', 'D7') });
    z.w([[px + 102, py + 120], [px + 102, 534], [206, 534], [206, 24], [v5[0] - 8, 24], [v5[0] - 8, 186], v5], C.v5, 'pololu', ['oas-v32', 'v17-5v'], { von: 'Pololu VOUT', nach: '5V der Audio-Leiste', a: 'pol:VOUT', b: 'au:5V', marke: [206, 120] });
    z.w([[px + 142, py + 120], [px + 142, 526], [218, 526], [218, 30], [gndA[0] - 6, 30], [gndA[0] - 6, 186], gndA], C.gnd, 'pololu', ['oas-v33'], { von: 'Pololu GND', nach: 'GND der Audio-Leiste', a: 'pol:GND', b: 'au:GNDa' });
  }
  if (has('akku')) {
    // Cell, charger with protection (TP4056), switch, step-up to 5 V (forum 744), into 5V and GND of the audio row.
    z.teile.push(z.kasten(24, 190, 120, 50, '#c9b458', 'Akku', { sub: '1 Zelle', nameY: 210, fs: 14, schrift: INK, schritt: 'akku' }));
    z.anker['akku:+'] = { p: [40, 214], label: '+' };
    z.teile.push(z.kasten(24, 270, 150, 56, '#2a6db0', 'Lademodul', { sub: 'mit Schutz (TP4056)', nameY: 292, fs: 13, schritt: 'akku' }));
    z.teile.push(z.kasten(24, 420, 150, 56, '#3f8a54', 'Wandler', { sub: 'auf 5 V (Step-Up)', nameY: 442, fs: 13, schritt: 'akku' }));
    z.teile.push(z.kasten(120, 352, 70, 40, '#e5483b', 'Schalter', { nameY: 377, fs: 12, schritt: 'akku' }));
    z.w([[100, 240], [100, 270]], C.akku, 'akku', ['akku-module'], { von: 'Akku +', nach: 'Lademodul B+' });
    z.w([[124, 240], [124, 270]], C.gnd, 'akku', ['akku-module'], { von: 'Akku −', nach: 'Lademodul B−' });
    z.w([[150, 326], [150, 352]], C.akku, 'akku', ['akku-module'], { von: 'Lademodul OUT+', nach: 'Schalter' });
    z.w([[150, 392], [150, 420]], C.akku, 'akku', ['akku-module'], { von: 'Schalter', nach: 'Wandler IN+' });
    z.w([[60, 326], [60, 420]], C.gnd, 'akku', ['akku-module'], { von: 'Lademodul OUT−', nach: 'Wandler IN−' });
    z.w([[174, 448], [206, 448], [206, 24], [v5[0] - 8, 24], [v5[0] - 8, 186], v5], C.v5, 'akku', ['akku-module', 'v17-5v'], { von: 'Wandler OUT+ (5 V)', nach: '5V der Audio-Leiste', b: 'au:5V', marke: [206, 120] });
    z.w([[174, 462], [218, 462], [218, 30], [gndA[0] - 6, 30], [gndA[0] - 6, 186], gndA], C.gnd, 'akku', ['akku-module'], { von: 'Wandler OUT−', nach: 'GND der Audio-Leiste', b: 'au:GNDa' });
  }
  if (has('usbc')) {
    // USB-C socket on a small board: VBUS to 5V, GND to GND, CC1 and CC2 each 5.1 kΩ to GND (USB-C spec, forum 12878).
    z.teile.push(z.kasten(24, 300, 150, 62, '#4a4a4a', 'USB-C-Netzteil', { sub: '5 V', nameY: 325, schritt: 'usbc' }));
    z.teile.push(z.kasten(40, 400, 134, 80, '#20578f', 'USB-C-Buchse', { nameY: 422, fs: 13, schritt: 'usbc' }));
    z.teile.push(z.widerstand(56, 452, 34, '5,1 kΩ', 'usbc') + z.widerstand(124, 452, 34, '5,1 kΩ', 'usbc'));
    z.ueber.push(z.t(73, 474, 'CC1', { fs: 10, fill: '#fff' }) + z.t(141, 474, 'CC2', { fs: 10, fill: '#fff' }));
    z.w([[100, 362], [100, 400]], C.usb, 'usbc', ['usb'], { von: 'Netzteil', nach: 'USB-C-Buchse', dick: true });
    z.w([[174, 420], [206, 420], [206, 24], [v5[0] - 8, 24], [v5[0] - 8, 186], v5], C.v5, 'usbc', ['usbc-einbau', 'v17-5v'], { von: 'VBUS', nach: '5V der Audio-Leiste', b: 'au:5V', marke: [206, 120] });
    z.w([[174, 440], [218, 440], [218, 30], [gndA[0] - 6, 30], [gndA[0] - 6, 186], gndA], C.gnd, 'usbc', ['usbc-einbau'], { von: 'GND', nach: 'GND der Audio-Leiste', b: 'au:GNDa' });
    z.frei.push({ schritt: 'usbc', text: 'CC1 und CC2 je mit 5,1 kΩ an GND (oft schon auf der Buchsen-Platine)', belege: ['usbc-rd'] });
  }
  if (schalter) {
    // In the USB cable between power bank and box only the red wire runs through the switch.
    const sx = 96;
    const sy = 390;
    const offen4 = schalter === 4;
    z.teile.push(z.kasten(sx, sy, 90, 48, '#e5483b', schalter === 3 ? 'Umschalter' : 'Schalter', { nameY: sy + 30, fs: 12.5, schritt: 'schalter' }));
    const beleg: BelegId[] = offen4 ? ['schalter-4'] : schalter === 3 ? ['schalter-rot', 'schalter-mitte'] : ['schalter-rot'];
    z.w([[150, 331], [150, 360], [sx + 20, 360], [sx + 20, sy]], C.v5, 'schalter', beleg, { von: 'Rote Ader, Ende zur Powerbank', nach: schalter === 3 ? 'Umschalter, mittleres Bein' : 'Schalter, ein Bein' });
    z.w([[sx + 70, sy], [sx + 70, 370], [206, 370], [206, 331]], C.v5, 'schalter', beleg, { von: schalter === 3 ? 'Umschalter, äußeres Bein' : 'Schalter, anderes Bein', nach: 'Rote Ader, Ende zur Box' });
    z.frei.push({ schritt: 'schalter', text: 'Schwarz, Grün und Weiß: nicht durchschneiden, sie bleiben ganz', belege: ['schalter-rot'] });
  }

  // --- steps
  const schritte: Omit<BildSchritt, 'nr' | 'bereich' | 'kern'>[] = [
    {
      key: 'buchsen',
      titel: 'Buchsenleisten',
      kurz: `Buchsenleisten für ${nanoName} und MP3-Player einlöten`,
      text: [
        '2 lange Buchsenleisten (15 Löcher) für den Arduino Nano.',
        '2 kurze Buchsenleisten (8 Löcher) für den MP3-Player (DFPlayer).',
        'Leisten von oben einstecken, von unten löten. Erst ein Beinchen löten, gerade richten, dann den Rest.',
        'Die kleinen Bauteile R1 bis R8 sind schon drauf. Nicht anfassen.',
        'Darunter ist R7: der Widerstand mit 1 kΩ für die Leitung zum MP3-Player. Den musst du nicht selbst einlöten.',
      ],
      hinweis: 'Erst ein Beinchen löten, die Leiste gerade richten, dann den Rest.',
      achtung: 'Vor dem Löten Strom ab. Vor dem ersten Einschalten: Lötstellen ansehen, keine Brücken zwischen Nachbarn.',
      ort: 'Classic v1.7 · Mitte',
    },
    {
      key: 'rfid',
      titel: 'Kartenleser',
      kurz: '7 Drähte, gleiche Namen. IRQ bleibt frei. SO = MISO, SI = MOSI',
      text: [
        '7 Kabel, jedes geht zum gleichnamigen Anschluss am Kartenleser. SO heißt am Leser MISO, SI heißt MOSI.',
        'SO und SI vor dem Löten nachsehen: Mit dem Durchgangsprüfer (Multimeter, piept bei Verbindung) muss SO zum Beinchen D12 des Nano piepen und SI zu D11.',
        'Immer nach dem Aufdruck am Leser verbinden, nicht nach der Lage. Je nachdem, wie herum der Leser liegt, ist die Reihenfolge umgedreht, und manche Leser sind anders sortiert.',
        'IRQ bleibt frei.',
        'Orange ist 3,3 Volt: Der Kartenleser darf nie an 5 Volt.',
      ],
      hinweis: 'Immer nach dem Aufdruck am Leser verbinden, nicht nach der Lage.',
      achtung: 'Kartenleser nur an 3V3 (orange). 5 Volt machen ihn kaputt.',
      ort: 'Classic v1.7 · obere Lötreihe, links',
    },
    {
      key: 'tasten',
      titel: 'Tasten',
      kurz: w.tasten === 5 ? 'Je ein Bein an A0 bis A4, das andere an GND daneben' : 'Je ein Bein an A0, A1, A2, das andere an GND daneben',
      text: ['Jede Taste hat zwei Beinchen. Ein Kabel zum A-Anschluss, das andere (schwarz) zum GND direkt daneben.', 'Bei Tasten ist egal, welches Beinchen wohin.'],
      hinweis: 'Tasten haben keine Richtung: Welches Bein, ist egal.',
      ...(w.tasten === 5 ? { achtung: '5 Tasten gehen nur mit der Firmware-Variante für 5 Tasten (Classic, 5 Tasten). Mit der normalen Firmware tun A3 und A4 nichts.' } : {}),
      ort: 'Classic v1.7 · linke Lötreihe',
    },
    {
      key: 'ton',
      titel: w.kh === 'platine' ? 'Kopfhörer und Lautsprecher' : w.kh === 'buchse' ? 'Buchse und Lautsprecher' : 'Lautsprecher',
      kurz:
        w.kh === 'platine'
          ? 'GND, R, L, +, − an die Kopfhörerplatine, Lautsprecher an „Speaker“'
          : w.kh === 'buchse'
            ? 'GND, R, L, + an die Buchse, Lautsprecher an Pin 7 und −'
            : 'Lautsprecher an + und − der Audio-Leiste',
      text: [...tonTextVon(w.kh), 'Lautsprecher: ein passiver mit mindestens 3 Watt und 4 oder 8 Ohm.'],
      hinweis: w.kh === 'platine' ? 'Der Lautsprecher kommt an „Speaker“ der Kopfhörerplatine. 5V ganz außen bleibt frei.' : w.kh === 'buchse' ? 'Die Nummern gelten für die Buchse FC68129: vorher durchpiepen.' : 'Lautsprecher nur an + und −.',
      achtung:
        w.kh === 'platine'
          ? 'Nach dem Aufdruck auf der Kopfhörerplatine verbinden (G, DR, DL, SK, SK). JD und NC frei lassen. SK nie an GND.'
          : w.kh === 'buchse'
            ? 'Nur eine Buchse mit getrennten Schaltkontakten nehmen (z. B. FC68129). Bei einer einfachen Buchse landet der Lautsprecher-Ausgang an Masse, das kann den Verstärker zerstören.'
            : 'Lautsprecher nur an + und −, nie an GND.',
      ort: 'Classic v1.7 · obere Lötreihe, rechts',
    },
    ...xs.map((x) => extraSchritt(x, w, 'classic')),
    {
      key: 'strom',
      titel: 'Einstecken und Strom',
      kurz: fremdStrom ? `${nanoName} und MP3-Player einstecken. Der Strom kommt über ${has('akku') ? 'den Akku' : has('pololu') ? 'den Pololu-Schalter' : 'die USB-C-Buchse'}` : `${nanoName} und MP3-Player einstecken, Netzteil oder Powerbank an die USB-Buchse vom ${nanoName}`,
      text: [
        'Arduino Nano einstecken: USB-Buchse zeigt nach links zum Rand (siehe Umriss).',
        'MP3-Player einstecken: Pin 1 (eckiges Lötauge) zeigt zum Kartenleser, der SD-Karten-Schlitz zur Seite mit „SD Card“.',
        fremdStrom ? 'SD-Karte rein. Kein USB-Kabel im Nano, solange der Strom über das Extra kommt.' : 'SD-Karte rein, USB-Kabel mit Netzteil oder Powerbank in den Nano (graues Kabel im Bild). Fertig.',
        'Am Computer reicht der Strom bei großer Lautstärke oft nicht. Besser ein Handy-Netzteil mit 5 Volt.',
      ],
      hinweis: 'Am Computer reicht der Strom oft nicht: besser ein Handy-Netzteil mit 5 Volt.',
      ort: 'Classic v1.7 · Nano und MP3-Player',
    },
  ];
  const n = xs.length;
  return fertig(z, w, schritte, {
    kopf: `Classic v1.7 · ${nanoName} · MP3-Player · ${w.tasten} Tasten${n ? ` · ${n} ${n === 1 ? 'Extra' : 'Extras'}` : ''}`,
    unter: 'Pins aus der Firmware TNG 3.3.3 · Platine vergrößert',
    xs,
  });
}

/** The lines of the sound step (loetplan.ts tonText, kept word for word). */
function tonTextVon(kh: LoetplanWahl['kh']): string[] {
  if (kh === 'buchse')
    return [
      '4 Kabel von der Audio-Leiste zur Buchse: GND an 1, R an 4, L an 3, + an 5.',
      'Pin 7 der Buchse an den Lautsprecher, das andere Lautsprecherkabel an −.',
      'Die Nummern gelten für die Buchse FC68129. Andere Buchsen sind anders nummeriert. Vorher durchpiepen: Ohne Stecker hat 5 mit 7 Durchgang, mit Stecker nicht. 5 und 7 dürfen nie Durchgang zu 1, 3 oder 4 haben.',
      'Zu laut im Kopfhörer? Je einen Widerstand 470 Ω bis 1 kΩ in die Kabel L und R löten.',
      '5V ganz außen bleibt frei.',
    ];
  return kh === 'platine'
    ? [
        'Kopfhörerplatine mit 5 Kabeln an die Audio-Leiste: GND, R, L, +, − (der Reihe nach, 1:1).',
        'Der Lautsprecher kommt an „Speaker“ der Kopfhörerplatine, nicht an die Hauptplatine. Sonst schaltet er beim Einstecken nicht ab.',
        '5V ganz außen bleibt frei.',
        'Die Buchse gehört auf die Seite mit dem Logo der Kopfhörerplatine.',
      ]
    : ['Lautsprecher an + und − der Audio-Leiste.', 'Nie an GND: Das kann den Verstärker im MP3-Player zerstören.'];
}

const SCHRITT_TITEL: Partial<Record<ExtraId, string>> = {
  pololu: 'Pololu-Schalter',
  lsaus: 'Lautsprecher stumm',
  wecker: ALARM_TEXT.label,
  hperkennung: 'Kopfhörer erkennen',
};

/** The step of an extra: its one line for the list from the design, its text from loetplanVerdrahtung.ts. */
function extraSchritt(x: ExtraPlan, w: LoetplanWahl, platine: 'classic' | 'aio' | 'aioplus'): Omit<BildSchritt, 'nr' | 'bereich' | 'kern'> {
  const plus = platine === 'aioplus';
  const aio = platine === 'aio';
  const every = w.nano === 'every';
  const KURZ: Partial<Record<ExtraId, string>> = {
    drehgeber: aio
      ? 'CLK an V− (A3), DT an V+ (A4), + an 3V3 der Leiste „Diverse“, GND am Button-Adapter. Nur mit 3 Tasten'
      : plus
        ? 'CLK an PF2, DT an PF3, + an 3,3V, GND am Button-Adapter. Die Firmware dafür baust du selbst'
        : 'CLK an A3, DT an A4, + an 5V oben, GND daneben. SW bleibt frei',
    poti: aio ? 'Mitte an V− (A3), Enden an 3V3 und GND der Leiste „Diverse“. Nur mit 3 Tasten' : plus ? 'Mitte an PF4, Enden an 3,3V und GND am Button-Adapter. Die Firmware dafür baust du selbst' : `Mitte an A3, Enden an ${every ? '3V3' : '5V'} und GND`,
    ring: aio
      ? 'D5 über 470 Ω an DIN, 5V und GND von „Diverse“, Elko dazwischen. Firmware fehlt (zu wenig Speicher)'
      : plus
        ? `PB2 über 470 Ω an DIN, 5V und GND vom Button-Adapter, Elko dazu. Nicht an WS. ${w.tasten === 5 ? 'Firmware: „5 Tasten mit allen Extras“' : 'Fertige Firmware nur mit 5 Tasten'}`
        : 'D5 über 470 Ω an DIN, 5V und GND, Elko dazwischen',
    ledtasten: 'LED + über 1 kΩ an A5, D6, D5; LED − an GND',
    schalter: w.schalter === 4 ? 'Schalter mit 4 Beinen: welche Beine, steht am Schalter. Noch nicht belegt' : 'Nur die rote Ader im USB-Kabel durch den Schalter',
    pololu: 'D7 an OFF, Play/Pause an A, VOUT an 5V, Powerbank an VIN',
    akku: aio ? 'Nur LiFePO4 mit Schutzschaltung, in BATTERY (11), + ist markiert' : plus ? 'In BATTERY, + ist markiert. Welche Akkuart: Anleitung der AiO+ ansehen' : 'Akku, Lademodul, Schalter und Wandler auf 5 V an 5V und GND',
    akkumessung: 'A5 zwischen zwei Widerstände 100 kΩ: einer an GND, einer an Akku +',
    hperkennung: 'D8 an Pin 6 (JD) einer Buchse mit Schaltkontakt. Die GND-Seite: noch nicht belegt',
    lsaus: 'D6 schaltet den Lautsprecher. Die Schaltung dazwischen: noch nicht belegt',
    wecker: 'A6 mit 100 kΩ an GND. Wie der Wecker A6 schaltet: noch nicht belegt',
    usbc: 'VBUS an 5V, GND an GND, CC1 und CC2 je 5,1 kΩ an GND',
    dauerled: 'Weiße LED mit 120 Ω zwischen 5V und GND',
  };
  const HINWEIS: Partial<Record<ExtraId, string>> = {
    drehgeber: 'Die Anschlüsse am Modul nach dem Aufdruck verbinden, nicht abzählen.',
    poti: 'Dreht er falsch herum, tausche die beiden äußeren Beine.',
    ring: 'Elko richtig herum: Minus (Streifen) an GND.',
    ledtasten: 'Leuchtet eine LED nicht, sind + und − vertauscht.',
    schalter: 'Schwarz, Grün und Weiß bleiben ganz.',
    pololu: 'Beim Testen kein USB-Kabel im Nano.',
    akku: 'Den Wandler vorher mit dem Messgerät auf 5 V einstellen.',
    akkumessung: 'An die Zelle, nicht hinter den Wandler.',
    hperkennung: 'Erst mit dem Messgerät nachmessen, welcher Kontakt ohne Stecker an GND liegt.',
    lsaus: 'Nicht zusammen mit LED-Tasten: beide brauchen D6.',
    wecker: 'Die Box schaut nur beim Einschalten auf A6.',
    usbc: 'Ohne die Widerstände an CC liefern viele USB-C-Netzteile keinen Strom.',
    dauerled: 'Nur weiß oder blau: rote und gelbe LEDs bekommen zu viel Strom.',
  };
  return {
    key: x.id,
    titel: SCHRITT_TITEL[x.id] ?? CHIP_NAMEN[x.id],
    kurz: KURZ[x.id] ?? x.kurz,
    text: x.text,
    ...(HINWEIS[x.id] ? { hinweis: HINWEIS[x.id] } : {}),
    ...(x.warnung ? { achtung: x.warnung } : {}),
    ort: platine === 'classic' ? `Classic v1.7 · Extra` : `${platine === 'aio' ? 'AiO' : 'AiO+'} · Extra`,
    extra: x.id,
  };
}

/* ------------------------------------------------------------------ AiO and AiO+ */

function aioBild(w: LoetplanWahl, plus: boolean): Bild {
  const platine = plus ? 'aioplus' : 'aio';
  const z = new Zeichnung(platine);
  const xs = gewaehlt(w);
  const has = (id: ExtraId) => xs.some((x) => x.id === id);
  const bx = 400;
  const by = 236;
  const bw = 360;
  const bh = 250;
  const tx = plus ? bx + 230 : bx + bw / 2;
  const name = plus ? 'AiO+' : 'AiO';
  z.platz({ x0: bx - 12, y0: by - 10, x1: bx + bw + 12, y1: by + bh + 6 });
  let b = `<rect x="${bx + 5}" y="${by + 6}" width="${bw}" height="${bh}" rx="10" fill="rgb(31 26 22 / 0.2)"/><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="10" fill="#1d1d1f" stroke="${INK}" stroke-width="3"/>`;
  b += z.t(tx, by + 100, name, { fs: 22, fw: 800, fill: '#fff' });
  b += z.t(tx, by + 122, 'MP3-Player, Verstärker,', { fs: 12.5, fw: 600, fill: '#bdb8ae' });
  b += z.t(tx, by + 138, 'Kopfhörerbuchse, SD-Karte', { fs: 12.5, fw: 600, fill: '#bdb8ae' });
  b += z.t(tx, by + 154, 'sind schon drauf', { fs: 12.5, fw: 600, fill: '#bdb8ae' });
  const buchse = (x: number, y: number, ww: number, h: number, t: string) => `<rect x="${x}" y="${y}" width="${ww}" height="${h}" rx="2" fill="#f2efe8" stroke="${INK}" stroke-width="1.8"/>${t ? z.t(x + ww / 2, y + h / 2 + 4.5, t, { fs: 11.5, fw: 800, fill: INK }) : ''}`;
  b += buchse(bx - 12, by + 22, 52, 30, 'USB-C 1');
  b += buchse(bx + bw - 120, by - 10, 92, 24, 'NFC 13');
  b += buchse(bx - 12, by + 150, 46, 64, '') + z.t(bx + 42, by + 186, 'Tasten 10', { fs: 11.5, fw: 800, a: 'start', fill: '#fff' });
  b += buchse(bx + bw - 34, by + 40, 46, 40, '') + z.t(bx + bw - 40, by + 64, `SPEAKER${plus ? ' 8' : ''}`, { fs: 11.5, fw: 800, a: 'end', fill: '#fff' });
  b += buchse(bx + bw - 34, by + 150, 46, 34, '') + z.t(bx + bw - 40, by + 171, 'BATTERY 11', { fs: 11.5, fw: 800, a: 'end', fill: '#fff' });
  z.teile.push(b);
  // The rows at the bottom: „Diverse“ on the AiO; OPT and the extension row on the AiO+ (order of their pins not described).
  if (!plus) {
    const DIV = ['GND', 'A7', 'A6', 'D5', 'RX', 'TX', '3V3', '5V'];
    const x0 = bx + 118;
    const y0 = by + bh - 34;
    let s = `<rect x="${x0 - 14}" y="${y0 - 14}" width="${DIV.length * 26 + 2}" height="28" rx="2" fill="#2d2d30" stroke="#6d665e" stroke-width="1.4"/>${z.t(x0 - 22, y0 + 4, 'Diverse', { fs: 11.5, fw: 800, a: 'end', fill: '#fff' })}`;
    DIV.forEach((t, i) => {
      s += z.auge(x0 + i * 26, y0, t, 'u', { fs: 10.5, schrift: '#fff' });
      z.anker[`div:${t}`] = { p: [x0 + i * 26, y0], label: t, ...(/^[AD]\d$/.test(t) ? { pin: t } : {}) };
    });
    z.ueber.push(s);
  } else {
    const ox = bx + 186;
    const oy = by + bh - 34;
    let s = `<rect x="${ox - 14}" y="${oy - 14}" width="${7 * 24 + 4}" height="28" rx="2" fill="#2d2d30" stroke="#6d665e" stroke-width="1.4"/>${z.t(ox - 22, oy + 4, 'OPT 9', { fs: 11.5, fw: 800, a: 'end', fill: '#fff' })}`;
    ['PF2', 'PF3', 'PF4', '?', '?', '?', '?'].forEach((t, i) => {
      s += z.auge(ox + i * 24, oy, t === '?' ? '' : t, 'u', { fs: 10.5, schrift: '#fff' });
      if (t === '?') s += z.t(ox + i * 24, oy + 18, '?', { fs: 11, fw: 800, fill: '#d8d2c6' });
      else z.anker[`opt:${t}`] = { p: [ox + i * 24, oy], label: t, pin: t };
    });
    s += z.t(ox + 3 * 24, oy - 22, 'Reihenfolge nach Aufdruck', { fs: 11.5, fill: '#d8d2c6' });
    const fx = bx + 70;
    const fy = by + 34;
    s += `<rect x="${fx - 14}" y="${fy - 14}" width="${5 * 24 + 4}" height="28" rx="2" fill="#2d2d30" stroke="#6d665e" stroke-width="1.4"/>${z.t(fx - 10, fy - 20, 'Erweiterung 7', { fs: 11.5, fw: 800, a: 'start', fill: '#fff' })}`;
    ['PB2', '?', '?', '?', '?'].forEach((t, i) => {
      s += z.auge(fx + i * 24, fy, t === '?' ? '' : t, 'u', { fs: 10.5, schrift: '#fff' });
      if (t === '?') s += z.t(fx + i * 24, fy + 18, '?', { fs: 11, fw: 800, fill: '#d8d2c6' });
      else z.anker[`erw:${t}`] = { p: [fx + i * 24, fy], label: t, pin: t };
    });
    z.ueber.push(s);
  }

  // --- card reader: header strip, plugged onto the NFC adapter, cable into 13
  const nx = 560;
  const ny = 40;
  z.teile.push(z.kasten(nx - 8, ny + 10, 230, 104, '#2a63b8', 'Kartenleser RC522', { nameY: ny + 38, schritt: 'rfid' }));
  z.teile.push(z.kasten(nx + 20, ny + 118, 176, 44, '#3f8a54', 'NFC-Adapter', { nameY: ny + 146, fs: 13.5, schritt: 'rfid' }));
  let pins = '';
  ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3.3V'].forEach((t, i) => {
    const x = nx + 24 + i * 24;
    pins += z.auge(x, ny + 104) + z.t(x, ny + 96, t, { fs: 9, fill: '#fff', rot: -50 });
  });
  z.ueber.push(`${pins}<path d="M${nx + 206} ${ny + 96} q22 10 0 28" fill="none" stroke="${INK}" stroke-width="2.4" marker-end="url(#lp-pfeil)"/>${z.t(nx + 232, ny + 116, 'aufstecken', { fs: 12.5, fw: 800, a: 'start', hal: true })}`);
  z.platz({ x0: nx + 200, y0: ny + 100, x1: nx + 310, y1: ny + 124 }, 'rfid');
  z.w([[nx + 108, ny + 162], [nx + 108, by - 10]], C.usb, 'rfid', [plus ? 'ap-nfc-kabel' : 'aio-nfc-kabel', 'aio-aufstecken'], { von: 'NFC-Adapter', nach: 'Buchse NFC 13 (Kabel liegt bei)', dick: true });

  // --- button adapter and buttons
  const ax = 190;
  const ay = 318;
  const gruppen: [string, string][] = [
    ['V−', 'A3'],
    ['<', 'A1'],
    ['PBP', 'A0'],
    ['>', 'A2'],
    ['V+', 'A4'],
  ];
  // The AiO+ adapter has a second row of pads: a little wider, so its names keep apart from the first row's (Prüfrunde 2, bastler 3).
  const aw = plus ? 100 : 92;
  z.teile.push(z.kasten(ax, ay, aw, 5 * 54 + 10, '#3f8a54', '', { schritt: 'tasten' }));
  z.teile.push(z.t(ax + aw / 2, ay - 10, 'Button-Adapter', { fs: 13.5, fw: 800 }));
  gruppen.forEach(([s, pin], i) => {
    const y = ay + 20 + i * 54;
    const g = s === 'PBP' ? 'PBN' : 'GND';
    z.ueber.push(z.auge(ax + 14, y, s, 'r', { fs: 11 }) + z.auge(ax + 14, y + 22, g, 'r', { fs: 10.5 }));
    z.anker[`ba:${s}`] = { p: [ax + 14, y], label: s, pin };
    z.anker[`ba:${s}g`] = { p: [ax + 14, y + 22], label: g };
  });
  if (plus) {
    const lx = ax + 80;
    ['3,3V', 'GND', '5V', 'WS'].forEach((t, i) => {
      const y = ay + 30 + i * 22;
      z.ueber.push(z.auge(lx, y, t, 'l', { fs: 10 }));
      z.anker[`ba:L${t}`] = { p: [lx, y], label: t };
    });
  }
  z.w([[ax + aw, ay + 140], [bx - 12, ay + 140], [bx - 12, by + 182]], C.usb, 'tasten', [plus ? 'ap-button-kabel' : 'aio-button-kabel'], { von: 'Button-Adapter', nach: 'Buchse Tasten 10 (Kabel liegt bei)', dick: true });
  const sig: BelegId = plus ? 'ap-taster' : 'aio-taster-signal';
  const playB: BelegId = plus ? 'ap-taster-play' : 'aio-taster-play';
  const gndB: BelegId = plus ? 'ap-taster' : 'aio-taster-gnd';
  const tf: Record<string, [string, string, TngFunktion, BelegId]> = {
    '<': [C.zur, 'Zurück', 'down3', sig],
    PBP: [C.play, 'Play/Pause', 'pause', playB],
    '>': [C.vor, 'Vor', 'up3', sig],
    'V−': [C.leis, 'Leiser', 'five5', sig],
    'V+': [C.laut, 'Lauter', 'four5', sig],
  };
  const reihe = w.tasten === 5 ? ['V−', '<', 'PBP', '>', 'V+'] : ['<', 'PBP', '>'];
  reihe.forEach((s) => {
    const [farbe, tname, fn, beleg] = tf[s];
    const pin = gruppen.find((g) => g[0] === s)![1];
    const [px, py] = z.at(`ba:${s}`);
    const [gx, gy] = z.at(`ba:${s}g`);
    const cx = 74;
    const cy = py + 10;
    z.teile.push(z.taste(cx, cy - 4, farbe, '', 'tasten', 22));
    z.teile.push(z.t(cx - 30, cy + 2, tname, { fs: 13, fw: 800, a: 'end' }));
    z.platz({ x0: cx - 110, y0: cy - 12, x1: cx - 30, y1: cy + 6 }, 'tasten');
    z.anker[`taste${s}:a`] = { p: [cx + 22, cy - 12], label: tname };
    z.w([[cx + 22, cy - 12], [px, py]], farbe, 'tasten', [beleg], { von: `${s} (${pin})`, nach: `Taste ${tname}, ein Bein`, a: `ba:${s}`, b: `taste${s}:a`, tng: z.tng(fn === 'down3' && w.tasten === 5 ? 'down5' : fn === 'up3' && w.tasten === 5 ? 'up5' : fn, pin) });
    z.w([[cx + 22, cy + 6], [gx, gy]], s === 'PBP' ? C.pbn : C.gnd, 'tasten', s === 'PBP' ? [playB] : [gndB], { von: s === 'PBP' ? 'PBN' : 'GND', nach: s === 'PBP' ? 'Taste Play/Pause, anderes Bein (nicht an GND)' : 'das andere Bein jeder Taste', a: `ba:${s}g`, marke: [cx + 46, cy + 4] });
  });

  // --- speaker
  z.teile.push(z.lautsprecher(902, 300, 44, 'ton'));
  z.w([[bx + bw + 12, 284], [858, 290]], C.plus, 'ton', [plus ? 'ap-lautsprecher' : 'aio-lautsprecher'], { von: `SPEAKER${plus ? ' 8' : ''}`, nach: 'Lautsprecher (Kabel liegt bei)' });
  z.w([[bx + bw + 12, 300], [858, 306]], C.minus, 'ton', [plus ? 'ap-lautsprecher' : 'aio-lautsprecher'], { von: `SPEAKER${plus ? ' 8' : ''}`, nach: 'Lautsprecher (Kabel liegt bei)' });

  // --- power
  z.teile.push(z.kasten(40, 210, 160, 62, '#4a4a4a', 'USB-Netzteil', { sub: '5 V, 2–3 A', nameY: 236, schritt: 'strom' }));
  z.w([[200, 252], [bx - 12, 252]], C.usb, 'strom', [plus ? 'ap-usb' : 'aio-usb'], { von: 'USB-Netzteil', nach: 'USB-C (1)', dick: true });

  /* ---------------- extras ---------------- */
  const knopf = (id: 'drehgeber' | 'poti') => {
    const kx = 196;
    const ky = 640;
    const dreh = id === 'drehgeber';
    z.teile.push(z.kasten(kx, ky, 128, 60, dreh ? '#2d6a3e' : '#2f4f7f', dreh ? 'Drehregler' : 'Poti 10 kΩ', { nameY: ky + 44, fs: 14, schritt: id }));
    const namen = dreh ? ['CLK', 'DT', 'SW', '+', 'GND'] : ['Ende', 'Mitte', 'Ende'];
    const pinx = (i: number) => (dreh ? kx + 16 + i * 24 : kx + 24 + i * 40);
    namen.forEach((t, i) => {
      z.ueber.push(z.auge(pinx(i), ky, t, 'u', { schrift: '#fff', fs: 10 }));
      z.anker[`kn:${i}`] = { p: [pinx(i), ky], label: t };
    });
    const iPlus = dreh ? 3 : 0;
    const iGnd = dreh ? 4 : 2;
    const iSig = dreh ? 0 : 1;
    if (!plus) {
      const [vmx, vmy] = z.at('ba:V−');
      const [vgx, vgy] = z.at('ba:V+g');
      z.w([[pinx(iSig), ky], [pinx(iSig), 618], [ax - 22, 618], [ax - 22, vmy], [vmx, vmy]], dreh ? C.clk : C.sda, id, ['aio-v-a3-a4'], { von: 'V− (A3)', nach: dreh ? 'Drehregler CLK' : 'Poti, Mitte', a: 'ba:V−', b: `kn:${iSig}`, tng: z.tng(dreh ? 'encClk' : 'poti', 'A3') });
      if (dreh) {
        const [vpx, vpy] = z.at('ba:V+');
        z.w([[pinx(1), ky], [pinx(1), 610], [ax - 12, 610], [ax - 12, vpy], [vpx, vpy]], C.dt, id, ['aio-v-a3-a4'], { von: 'V+ (A4)', nach: 'Drehregler DT', a: 'ba:V+', b: 'kn:1', tng: z.tng('encDt', 'A4') });
      }
      z.w([[pinx(iGnd), ky], [pinx(iGnd), 604], [ax + 30, 604], [ax + 30, vgy + 10], [vgx, vgy]], C.gnd, id, dreh ? ['aio-taster-gnd'] : ['aio-taster-gnd', 'aio-poti-enden'], { von: 'GND', nach: dreh ? 'Drehregler GND' : 'Poti, ein äußeres Bein', a: 'ba:V+g', b: `kn:${iGnd}`, marke: [ax + 30, 590] });
      const [t3x, t3y] = z.at('div:3V3');
      z.w([[pinx(iPlus), ky], [pinx(iPlus), 596], [t3x, 596], [t3x, t3y]], C.v33, id, dreh ? ['aio-diverse-3v3'] : ['aio-diverse-3v3', 'aio-poti-enden'], { von: '3V3', nach: dreh ? 'Drehregler +' : 'Poti, anderes äußeres Bein', a: 'div:3V3', b: `kn:${iPlus}`, ...(dreh ? {} : { marke: [t3x, 560] as Pkt }) });
      if (dreh) z.frei.push({ schritt: id, text: 'Drehregler SW bleibt frei (TNG nutzt ihn an der AiO nicht)', belege: ['aio-v-a3-a4'] });
    } else {
      const [p2x, p2y] = z.at('opt:PF2');
      if (dreh) {
        const [p3x, p3y] = z.at('opt:PF3');
        z.w([[pinx(0), ky], [pinx(0), 612], [p2x, 612], [p2x, p2y]], C.clk, id, ['ap-enc-pf'], { von: 'PF2', nach: 'Drehregler CLK', a: 'opt:PF2', b: 'kn:0', tng: z.tng('encClk', 'PF2') });
        z.w([[pinx(1), ky], [pinx(1), 604], [p3x, 604], [p3x, p3y]], C.dt, id, ['ap-enc-pf'], { von: 'PF3', nach: 'Drehregler DT', a: 'opt:PF3', b: 'kn:1', tng: z.tng('encDt', 'PF3') });
      } else {
        const [p4x, p4y] = z.at('opt:PF4');
        z.w([[pinx(1), ky], [pinx(1), 612], [p4x, 612], [p4x, p4y]], C.sda, id, ['ap-poti-pf4'], { von: 'PF4', nach: 'Poti, Mitte', a: 'opt:PF4', b: 'kn:1', tng: z.tng('poti', 'PF4') });
      }
      const [lx, l3y] = z.at('ba:L3,3V');
      const [, lgy] = z.at('ba:LGND');
      z.w([[pinx(iPlus), ky], [pinx(iPlus), 626], [ax + 112, 626], [ax + 112, l3y], [lx, l3y]], C.v33, id, ['ap-knopf-strom'], { von: '3,3V am Button-Adapter', nach: dreh ? 'Drehregler +' : 'Poti, ein äußeres Bein', a: 'ba:L3,3V', b: `kn:${iPlus}`, marke: [ax + 112, 560] });
      z.w([[pinx(iGnd), ky], [pinx(iGnd), 632], [ax + 124, 632], [ax + 124, lgy], [lx, lgy]], C.gnd, id, ['ap-knopf-strom'], { von: 'GND am Button-Adapter', nach: dreh ? 'Drehregler GND' : 'Poti, anderes äußeres Bein', a: 'ba:LGND', b: `kn:${iGnd}`, marke: [ax + 124, 500] });
      z.teile.push(z.firmwareFehlt(kx + 136, ky + 18, id, 'Firmware: selbst bauen'));
    }
  };
  if (has('drehgeber')) knopf('drehgeber');
  if (has('poti')) knopf('poti');
  if (has('ring')) {
    const rx = 806;
    const ry = 660;
    z.teile.push(z.ring(rx, ry, 50, 'ring'));
    const pinY = ry - 64;
    z.ueber.push(z.stifte(rx - 20, pinY, ['DIN', '5V', 'GND'], 'ring', 20, 'ring'));
    z.teile.push(z.widerstand(652, 580, 44, '470 Ω', 'ring'));
    z.teile.push(z.elko(900, 600, 'ring', true));
    if (!plus) {
      const [d5x, d5y] = z.at('div:D5');
      const [v5x, v5y] = z.at('div:5V');
      const [gx, gy] = z.at('div:GND');
      z.w([[d5x, d5y], [d5x, 580], [652, 580]], C.din, 'ring', ['aio-neo-d5'], { von: 'D5', nach: 'Widerstand 470 Ω', a: 'div:D5', tng: z.tng('ring', 'D5') });
      z.w([[gx, gy], [gx, 548], [922, 548], [922, 640], [900, 640], [900, 630]], C.gnd, 'ring', ['aio-neo-d5'], { von: 'GND (Diverse)', nach: 'Leuchtring GND und Elko −', a: 'div:GND' });
      z.w([[v5x, v5y], [v5x, 564], [900, 564], [900, 600]], C.v5, 'ring', ['aio-neo-d5'], { von: '5V (Diverse)', nach: 'Leuchtring 5V und Elko +', a: 'div:5V', marke: [v5x, 530] });
      z.teile.push(z.firmwareFehlt(rx - 64, ry + 86, 'ring'));
    } else {
      const [pbx, pby] = z.at('erw:PB2');
      const [lx, l5y] = z.at('ba:L5V');
      const [, lgy] = z.at('ba:LGND');
      const [, wsy] = z.at('ba:LWS');
      z.w([[pbx, pby], [pbx, pby + 30], [bx + 120, pby + 30], [bx + 120, 580], [652, 580]], C.din, 'ring', ['ap-ring-din'], { von: 'PB2', nach: 'Widerstand 470 Ω', a: 'erw:PB2', tng: z.tng('ring', 'PB2'), marke: [bx + 120, 420] });
      z.w([[lx, lgy], [ax + 152, lgy], [ax + 152, 548], [922, 548], [922, 640], [900, 640], [900, 630]], C.gnd, 'ring', ['ap-ring-pwr'], { von: 'GND am Button-Adapter', nach: 'Leuchtring GND und Elko −', a: 'ba:LGND', marke: [ax + 152, 520] });
      z.w([[lx, l5y], [ax + 140, l5y], [ax + 140, 564], [900, 564], [900, 600]], C.v5, 'ring', ['ap-ring-pwr'], { von: '5V am Button-Adapter', nach: 'Leuchtring 5V und Elko +', a: 'ba:L5V', marke: [ax + 140, 470] });
      z.ueber.push(z.etikett(ax + aw, wsy - 10, 'WS frei', { fs: 11.5, schritt: 'ring' }));
      z.frei.push({ schritt: 'ring', text: 'WS am Button-Adapter bleibt frei: TNG nutzt PB2', belege: ['ap-ring-din'] });
      if (w.tasten !== 5) z.teile.push(z.firmwareFehlt(rx - 64, ry + 86, 'ring', 'Fertig nur mit 5 Tasten'));
    }
    z.w([[696, 580], [rx - 20, 580], [rx - 20, pinY]], C.din, 'ring', ['neo-widerstand'], { von: 'Widerstand 470 Ω', nach: 'Leuchtring DIN', b: 'ring:DIN' });
    z.w([[rx, 564], [rx, pinY]], C.v5, 'ring', ['cl-neo-elko'], { von: '5V', nach: 'Leuchtring 5V', b: 'ring:5V' });
    z.w([[rx + 20, 548], [rx + 20, pinY]], C.gnd, 'ring', ['cl-neo-elko'], { von: 'GND', nach: 'Leuchtring GND', b: 'ring:GND' });
    // The source of the board's own ring pin, not the Classic's D5 (Prüfrunde 2, bastler 7).
    z.frei.push({ schritt: 'ring', text: 'Leuchtring DOUT (Daten raus) bleibt frei', belege: [plus ? 'ap-ring-din' : 'aio-neo-d5'] });
  }
  if (has('akku')) {
    const kx = 860;
    const ky = 400;
    z.teile.push(z.kasten(kx - 40, ky, 140, 70, '#c9b458', 'Akku', { schrift: INK, sub: plus ? 'Art laut Anleitung' : 'LiFePO4, 1 Zelle', nameY: ky + 28, schritt: 'akku' }));
    const beleg: BelegId = plus ? 'ap-akku' : 'aio-akku';
    z.w([[bx + bw + 12, by + 160], [kx - 40, ky + 26]], C.plus, 'akku', [beleg], { von: 'BATTERY + (11)', nach: 'Akku + (rotes Kabel)' });
    z.w([[bx + bw + 12, by + 174], [kx - 40, ky + 44]], C.minus, 'akku', [beleg], { von: 'BATTERY − (11)', nach: 'Akku −' });
    z.ueber.push(z.t(kx - 36, ky - 8, 'rotes Kabel = +', { fs: 12.5, fw: 800, a: 'start', hal: true }));
  }

  const schritte: Omit<BildSchritt, 'nr' | 'bereich' | 'kern'>[] = [
    {
      key: 'rfid',
      titel: 'Kartenleser',
      kurz: 'Stiftleiste an den Leser löten, auf den NFC-Adapter stecken, Kabel in 13',
      text: [
        'Der Kartenleser wird nicht mit einzelnen Drähten verlötet: Löte die beiliegende Stiftleiste an den Leser und stecke ihn auf den NFC-Adapter.',
        'Die Beschriftung auf dem Adapter ist dieselbe wie auf dem Leser (SDA SCK MOSI MISO IRQ GND RST 3.3V). Passt sie nicht, nach der Beschriftung verbinden, nicht nach der Lage.',
        'Dann das 8-adrige Kabel in die Buchse 13.',
      ],
      hinweis: 'Beschriftung von Leser und Adapter vergleichen, bevor du steckst.',
      achtung: 'Den Kartenleser nie an 5 Volt.',
      ort: `${name} · NFC-Adapter`,
    },
    {
      key: 'tasten',
      titel: 'Tasten',
      kurz: 'Zurück an <, Vor an >, je GND daneben. Play/Pause an PBP und PBN',
      text: [
        'Play/Pause kommt an PBP und PBN. Die anderen Tasten an ihr Zeichen und an GND daneben.',
        ...(w.tasten === 3 ? ['Bei 3 Tasten bleiben V+ und V− frei.'] : ['Lauter kommt an V+, Leiser an V−.']),
        'Den Jumper auf dem Button-Adapter nach dem Aufspielen der Firmware abziehen, sonst reagieren die Tasten nicht.',
      ],
      hinweis: 'GND neben den Tasten am Button-Adapter: Aufdruck prüfen.',
      achtung: 'Play/Pause nie an GND: Sonst lässt sich die Box nicht einschalten.',
      ort: `${name} · Button-Adapter`,
    },
    {
      key: 'ton',
      titel: 'Lautsprecher',
      kurz: `Beiliegendes Kabel in SPEAKER${plus ? ' (8)' : ''}, Enden an den Lautsprecher`,
      text: [`Das beiliegende Kabel in SPEAKER${plus ? ' (8)' : ''}, die Enden an den Lautsprecher.`, 'Lautsprecher: 4 bis 8 Ohm.', 'Die Kopfhörerbuchse ist schon eingebaut.'],
      hinweis: 'Lautsprecher mit 4 bis 8 Ohm.',
      ort: `${name} · SPEAKER`,
    },
    ...xs.map((x) => extraSchritt(x, w, platine)),
    {
      key: 'strom',
      titel: 'Strom',
      kurz: 'USB-Netzteil an USB-C (1). Kein Schnellladegerät',
      text: ['Netzteil: 5 Volt, 2 bis 3 Ampere, kein Schnellladegerät.', `Nur die Firmware für die ${name} aufspielen.`],
      hinweis: 'Kein Schnellladegerät: Es kann die Ladeelektronik beschädigen.',
      ort: `${name} · USB-C`,
    },
  ];
  const n = xs.length;
  return fertig(z, w, schritte, {
    kopf: `${name} · ${w.tasten} Tasten${n ? ` · ${n} ${n === 1 ? 'Extra' : 'Extras'}` : ''}`,
    unter: 'Pins aus der Firmware TNG 3.3.3 · Platine vereinfacht, Lage der Buchsen nicht maßstäblich',
    xs,
  });
}

/* ------------------------------------------------------------------ putting it together */

function vereinige(rs: Rect[]): Rect {
  return rs.reduce((a, r) => ({ x0: Math.min(a.x0, r.x0), y0: Math.min(a.y0, r.y0), x1: Math.max(a.x1, r.x1), y1: Math.max(a.y1, r.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
}

/** What to check before soldering and what is not proven yet, for the box next to the steps. */
function offenVon(z: Zeichnung, w: LoetplanWahl, xs: ExtraPlan[]): Offen[] {
  const out: Offen[] = [];
  for (const x of xs) {
    if (z.drahte.some((d) => d.schritt === x.id && d.stufe === 'ungeprueft')) {
      const titel: Partial<Record<ExtraId, string>> = {
        wecker: 'Wecker an A6',
        lsaus: 'Stumm-Schaltung an D6',
        hperkennung: 'GND-Seite der Buchse an D8',
        drehgeber: '3,3 V und GND am Button-Adapter',
        poti: '3,3 V und GND am Button-Adapter',
        schalter: 'Schalter mit 4 Beinen',
      };
      out.push({
        stufe: 'ungeprueft',
        extra: x.id,
        titel: titel[x.id] ?? CHIP_NAMEN[x.id],
        warum: x.fehlt?.warum ?? 'In keiner geprüften Quelle beschrieben.',
        ...(x.fehlt?.beweis ? { bitte: x.fehlt.beweis } : {}),
      });
    }
  }
  const nach = (schritt: string, titel: string, warum: string, extra?: ExtraId) => {
    if (z.drahte.some((d) => d.schritt === schritt && d.stufe === 'nachsehen')) out.push({ stufe: 'nachsehen', titel, warum, ...(extra ? { extra } : {}) });
  };
  if (w.platine === 'classic') {
    nach('rfid', 'SO und SI am Kartenleser', 'Mit dem Durchgangsprüfer: SO muss zu D12 am Nano piepen, SI zu D11.');
    nach('ton', 'Kopfhörerplatine', 'Die Reihenfolge G, DR, DL, SK, SK steht so im Forum: nach dem Aufdruck auf der Kopfhörerplatine verbinden.');
  } else nach('tasten', 'GND neben den Tasten', 'GND neben den Tasten am Button-Adapter: so im Forum beschrieben, Aufdruck prüfen.');
  for (const x of xs) {
    // What is not proven at all says enough for that extra.
    if (out.some((o) => o.extra === x.id)) continue;
    const t: Partial<Record<ExtraId, string>> = {
      drehgeber: w.platine === 'classic' ? '+ des Drehreglers an 5V: Durchgang vom Punkt 5V zum Pin 5V am Nano prüfen.' : 'GND am Button-Adapter: nur auf Fotos gesehen, Aufdruck prüfen.',
      poti: w.platine === 'classic' ? (w.nano === 'every' ? '3V3 ist beim Nano Every besser als 5V: aus dem Quelltext abgeleitet, noch nicht ausprobiert.' : 'Die äußeren Beine an 5V und GND: so im Forum. Dreht er falsch herum, tauschen.') : 'Die Enden an 3V3 und GND: abgeleitet, nicht ausprobiert.',
      ring: w.platine === 'classic' ? '5V für den Ring: Durchgang vom Punkt 5V zum Pin 5V am Nano prüfen.' : w.platine === 'aioplus' ? 'Wo PB2 auf der Leiste sitzt, und 5V/GND am Button-Adapter: Aufdruck prüfen.' : '5V an „Diverse“ für den Ring: so im Forum beschrieben.',
      pololu: 'VOUT an 5V und die Adern im Kabel: vor dem Löten mit dem Messgerät prüfen.',
      akku: w.platine === 'classic' ? 'Lademodul und Wandler: nach dem Aufdruck löten, den Wandler vorher auf 5 V einstellen.' : '',
      akkumessung: 'Der Teiler kommt an die Zelle, nicht hinter den Wandler.',
      hperkennung: 'Pin 6 (JD) der Buchse an D8: vorher nachmessen.',
      usbc: 'VBUS an 5V: Durchgang vom Punkt 5V zum Pin 5V am Nano prüfen.',
      dauerled: 'Ob die LED deine Powerbank wach hält, hängt vom Modell ab.',
      schalter: 'Welche Ader 5 V führt: vorher mit dem Messgerät prüfen.',
    };
    const text = t[x.id];
    if (text) nach(x.id, CHIP_NAMEN[x.id], text, x.id);
  }
  return out;
}

function fertig(z: Zeichnung, w: LoetplanWahl, schritte: Omit<BildSchritt, 'nr' | 'bereich' | 'kern'>[], o: { kopf: string; unter: string; xs: ExtraPlan[] }): Bild {
  // Every point of every wire is part of the picture, too.
  const alle = [...z.rects, ...z.drahte.flatMap((d) => d.pts.map(([x, y]) => ({ x0: x - 8, y0: y - 8, x1: x + 8, y1: y + 8 })))];
  const r = vereinige(alle);
  const box = { x0: Math.floor(r.x0 - 14), y0: Math.floor(r.y0 - 14), x1: Math.ceil(r.x1 + 14), y1: Math.ceil(r.y1 + 14) };
  const mitBereich = schritte.map((s, i) => {
    const rs = z.bereiche.get(s.key) ?? [];
    const b = rs.length ? vereinige(rs) : box;
    // An extra's step shows its own parts too, not only the pins: on a phone the part at the far end of a wire
    // (the poti, the USB-C socket) lay outside the view (Prüfrunde 2, bastler 2).
    const ks = [...(z.kerne.get(s.key) ?? []), ...(s.extra && z.kerne.get(s.key)?.length ? (z.teileJe.get(s.key) ?? []) : [])];
    const k = ks.length ? vereinige(ks) : undefined;
    const bereich = { x0: b.x0 - 24, y0: b.y0 - 24, x1: b.x1 + 24, y1: b.y1 + 24 };
    return { ...s, nr: i + 1, bereich, kern: k ? { x0: k.x0 - 12, y0: k.y0 - 12, x1: k.x1 + 12, y1: k.y1 + 12 } : undefined };
  });
  return {
    platine: z.platine,
    kopf: o.kopf,
    unter: o.unter,
    box,
    teile: z.teile.join(''),
    ueber: z.ueber.join('') + z.halos.join(''),
    drahte: z.drahte,
    frei: z.frei,
    schritte: mitBereich,
    offen: offenVon(z, w, o.xs),
    anker: z.anker,
    minSchrift: z.min,
    extras: o.xs,
  };
}

/** The picture of a choice; null for the Classic without board and the view from below (they keep their old pictures). */
export function bild(w: LoetplanWahl): Bild | null {
  if (w.platine === 'frei' || (w.platine === 'classic' && w.ansicht === 'unten')) return null;
  return w.platine === 'classic' ? classic(w) : aioBild(w, w.platine === 'aioplus');
}

/** The wires of the picture with one step lit: the others fade. */
export function drahtLagen(b: Bild, schritt: string | null): { blass: string; kraeftig: string } {
  let blass = '';
  let kraeftig = '';
  for (const d of b.drahte) {
    if (schritt && d.schritt !== schritt) blass += drahtSvg(d);
    else kraeftig += drahtSvg(d);
  }
  return { blass, kraeftig };
}

/** One row of the wire list of a step: the same colour, start and end only once (three GND legs are one row). */
export interface ListenZeile {
  farbe: string | null;
  von: string;
  nach: string;
  stufe: Stufe;
  belege: BelegId[];
}

export function listeVon(b: Bild, schritt: string): ListenZeile[] {
  const out: ListenZeile[] = [];
  for (const d of b.drahte.filter((x) => x.schritt === schritt)) {
    const da = out.find((r) => r.farbe === d.farbe && r.von === d.von && r.nach === d.nach);
    if (da) {
      for (const id of d.belege) if (!da.belege.includes(id)) da.belege.push(id);
      da.stufe = stufeVon(da.belege);
      // A wire shared by several parts (GND of each button) comes after the parts' own wires.
      out.splice(out.indexOf(da), 1);
      out.push(da);
    } else out.push({ farbe: d.farbe, von: d.von, nach: d.nach, stufe: d.stufe, belege: [...d.belege] });
  }
  for (const f of b.frei.filter((x) => x.schritt === schritt)) out.push({ farbe: null, von: f.text, nach: '', stufe: stufeVon(f.belege), belege: f.belege });
  return out;
}

/** How many marks of each kind the picture has (the line at the bottom of a phone). */
export function zaehle(b: Bild): { nachsehen: number; offen: number } {
  return { nachsehen: b.drahte.filter((d) => d.stufe === 'nachsehen').length, offen: b.drahte.filter((d) => d.stufe === 'ungeprueft').length };
}

/* ------------------------------------------------------------------ small pictures for the chips */

const MINI: Record<ExtraId, string> = {
  drehgeber: '<circle cx="12" cy="13" r="8" fill="#9a958d"/><path d="M12 5v8" stroke-width="2.6"/>',
  poti: '<rect x="4" y="8" width="16" height="11" rx="2" fill="#5f8fd6"/><path d="M12 3v6" stroke-width="3"/>',
  ring: '<circle cx="12" cy="12" r="8.5" fill="#1f1f1f"/><circle cx="12" cy="12" r="4.5" fill="#fff"/><circle cx="12" cy="3.8" r="1.6" fill="#e5483b" stroke="none"/><circle cx="20" cy="12" r="1.6" fill="#58ad46" stroke="none"/><circle cx="12" cy="20" r="1.6" fill="#3f8fd6" stroke="none"/><circle cx="4" cy="12" r="1.6" fill="#f6c12c" stroke="none"/>',
  ledtasten: '<circle cx="12" cy="12" r="8" fill="#f6c12c"/><path d="M12 1.5v2.5M3 4.5l1.8 1.8M21 4.5l-1.8 1.8" stroke-width="1.8"/>',
  schalter: '<rect x="4" y="6" width="16" height="12" rx="2" fill="#e5483b"/><path d="M9 12h6" stroke-width="2.4"/>',
  pololu: '<rect x="4" y="5" width="16" height="14" rx="1.5" fill="#3f8a54"/><circle cx="9" cy="12" r="2.2" fill="#fff"/>',
  dauerled: '<path d="M8 15c0-5 8-5 8 0v3H8z" fill="#ffd43b"/><path d="M8 18v3M16 18v3" stroke-width="2"/>',
  akku: '<rect x="3" y="7" width="16" height="11" rx="2" fill="#c9b458"/><path d="M21 10.5v4" stroke-width="2.6"/>',
  lsaus: '<path d="M4 9h4l5-4v14l-5-4H4z" fill="#9a958d"/><path d="M16 9l5 6M21 9l-5 6" stroke-width="2.2"/>',
  hperkennung: '<path d="M5 15a7 7 0 0 1 14 0" fill="none" stroke-width="2.4"/><rect x="3" y="14" width="4" height="6" rx="1.5" fill="#12b5b0"/><rect x="17" y="14" width="4" height="6" rx="1.5" fill="#12b5b0"/>',
  wecker: '<circle cx="12" cy="13" r="7.5" fill="#fff4f2"/><path d="M12 9v4.5l3 1.8M5 5l3-2M19 5l-3-2" stroke-width="2"/>',
  akkumessung: '<rect x="3" y="7" width="16" height="11" rx="2" fill="#fff"/><rect x="5.5" y="9.5" width="7" height="6" fill="#58ad46" stroke="none"/><path d="M21 10.5v4" stroke-width="2.6"/>',
  usbc: '<rect x="4" y="8.5" width="16" height="7.5" rx="3.7" fill="#b9bcc2"/><path d="M8 12.2h8" stroke-width="2"/>',
};

/** The small drawing of an extra (ink, one colour as accent), as SVG markup. */
export function miniSvg(id: ExtraId): string {
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MINI[id]}</svg>`;
}

/** Extras with places not proven yet: their chip carries a "?" (design: TEILWEISE_OFFEN). */
export function teilsOffen(w: LoetplanWahl, id: ExtraId): boolean {
  if (w.platine === 'classic') return id === 'lsaus' || id === 'wecker' || id === 'hperkennung' || (id === 'schalter' && w.schalter === 4 && !w.extras.includes('pololu'));
  if (w.platine === 'aioplus') return id === 'drehgeber' || id === 'poti';
  return false;
}
