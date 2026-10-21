/**
 * The hand-drawn look shared by the Lötplan pictures (LoetplanSketch.tsx for
 * the Classic v1.7 board, LoetplanSchema.tsx for the other boards and the
 * extras): bodies with the style's ink edge and hard shadow, wires with a
 * dark edge, and labels on a small plate drawn on top of everything, so no
 * wire or pad can ever cover a pin name.
 *
 * Fonts come from CSS (src/ui/styles/loetplan.css): --lp-schrift for the
 * print on boards and parts, --lp-hand for notes and names on paper. Change
 * them there, not here.
 */
import type { JSX } from 'preact';
import { pfad, type Anker, type Draht, type Etikett, type Hindernisse, type Kreis, type Pt, type Rect } from './loetplanGeo';
import { wobblyCircle, wobblyRect } from './wobbly';

export interface Look {
  /** Width of a letter of the handwriting, in font sizes (for the tape). */
  handWidth: number;
  /** How far the hand-drawn lines stray, in drawing units. */
  wobble: number;
  /** Ink edge around the bodies of the parts. */
  ink?: { color: string; width: number };
  /** Hard shadow behind the parts, offset in drawing units. */
  shadow?: number;
}

/** The look of the Holzwerkstatt, the only style since 0.2. */
export const LOOK: Look = {
  handWidth: 0.5,
  wobble: 3.4,
  ink: { color: '#2a1f16', width: 2.6 },
  shadow: 3,
};

export const look = () => LOOK;

/** The print on boards and parts: one place to change it, in loetplan.css. */
export const SCHRIFT = 'var(--lp-schrift)';
/** Handwriting for names and notes on paper. */
export const HAND = 'var(--lp-hand)';

/** Outer width of a wire: the coloured core and its dark edge. */
export const DRAHT_BREITE = 7.5;
export const FLACH_BREITE = 12;

/** Everything a picture is laid out from: the tests check these numbers. */
export interface Szene extends Hindernisse {
  /** Labels that found no free place. Kept empty by the tests. */
  konflikte: string[];
}

export const neueSzene = (): Szene => ({
  kreise: [],
  draehte: [],
  etiketten: [],
  flaechen: [],
  konflikte: [],
});

/** A body of a part: wobbly, with the style's ink edge and hard shadow. */
export function body(l: Look, key: string, shape: 'rect' | 'circle', props: Record<string, number | string>, ownStroke?: { stroke: string; 'stroke-width': number }) {
  const amp = l.wobble / 2;
  const n = (k: string) => Number(props[k] ?? 0);
  const d = shape === 'rect' ? wobblyRect(n('x'), n('y'), n('width'), n('height'), amp, key) : wobblyCircle(n('cx'), n('cy'), n('r'), amp, key);
  const edge = l.ink ? { stroke: l.ink.color, 'stroke-width': l.ink.width } : (ownStroke ?? {});
  return (
    <g key={key}>
      {l.shadow ? <path d={d} fill={l.ink?.color ?? '#000'} transform={`translate(${l.shadow} ${l.shadow})`} /> : null}
      <path d={d} fill={String(props.fill)} {...edge} />
    </g>
  );
}

/**
 * A wire: dark edge, coloured core. Light colours get a grey edge. Black
 * wires (ground, speaker minus) take their edge from loetplan.css: dark on
 * the light sheet, light in dark mode, where they would vanish otherwise.
 */
export function drahtSvg(d: Draht, farbe: string, op: number, flach = false) {
  const p = pfad(d.pts);
  const hell = farbe === '#e8e8e8' || farbe === '#f2c500';
  const schwarz = farbe === '#1b1b1b';
  return (
    <g key={d.key} opacity={op} data-lp-wire="">
      <path
        d={p}
        fill="none"
        stroke={hell ? '#555' : '#000'}
        stroke-width={flach ? FLACH_BREITE : DRAHT_BREITE}
        stroke-linecap="round"
        stroke-linejoin="round"
        opacity={0.55}
        style={schwarz ? { stroke: 'var(--lp-rand-schwarz, #000)', opacity: 'var(--lp-rand-schwarz-deckung, 0.55)' } : undefined}
      />
      <path d={p} fill="none" stroke={farbe} stroke-width={flach ? FLACH_BREITE - 3 : 5} stroke-linecap="round" stroke-linejoin="round" />
      {flach ? <path d={p} fill="none" stroke="#9a9a9a" stroke-width={1.2} stroke-dasharray="1 3" /> : null}
    </g>
  );
}

/** A pad or pin; registered so no label is put on it. */
export function padSvg(
  s: Szene,
  k: Kreis,
  key: string,
  look: {
    fill: string;
    stroke: string;
    width: number;
    hole?: boolean;
    eckig?: boolean;
  },
) {
  s.kreise.push(k);
  return (
    <g key={key} data-lp-pad="">
      {look.eckig ? (
        <rect x={k.x - k.r} y={k.y - k.r} width={2 * k.r} height={2 * k.r} fill={look.fill} stroke={look.stroke} stroke-width={look.width} />
      ) : (
        <circle cx={k.x} cy={k.y} r={k.r} fill={look.fill} stroke={look.stroke} stroke-width={look.width} />
      )}
      {look.hole ? <circle cx={k.x} cy={k.y} r={k.r * 0.38} fill="#2a2622" /> : null}
    </g>
  );
}

export type Platte = string | 'papier' | null;

/** A placed label: plate behind, text in front. Drawn last, on top of everything. */
export function etikettSvg(
  e: Etikett,
  o: {
    fill: string;
    plate: Platte;
    hand?: boolean;
    op?: number;
    weight?: number;
  },
) {
  const b = e.box;
  return (
    <g key={`et-${e.key}`} opacity={o.op ?? 1} data-lp-label="">
      {o.plate ? o.plate === 'papier' ? <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={3} opacity={0.85} style={{ fill: 'var(--surface)' }} /> : <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={3} fill={o.plate} opacity={0.9} /> : null}
      <text
        x={e.x}
        y={e.y}
        font-size={e.size}
        font-weight={o.weight ?? 700}
        text-anchor={e.anchor}
        style={o.fill.startsWith('var(') ? { fill: o.fill, fontFamily: o.hand ? HAND : SCHRIFT } : { fontFamily: o.hand ? HAND : SCHRIFT }}
        fill={o.fill.startsWith('var(') ? undefined : o.fill}
      >
        {e.txt}
      </text>
    </g>
  );
}

/**
 * A note in the style's handwriting on a small straight label with a pen
 * edge (0.4.1: no masking tape, nothing crooked on the page).
 */
export function tapeSvg(l: Look, x: number, y: number, txt: string, gr: number, key: string) {
  const w = tapeBreite(l, txt, gr);
  return (
    <g key={key} transform={`translate(${x},${y})`}>
      <path
        d={wobblyRect(-w / 2, -gr * 0.95, w, gr * 1.65, l.wobble / 2, `tape-${txt}`)}
        style={{
          fill: 'var(--surface)',
          stroke: 'var(--ink)',
          strokeWidth: 1.5,
        }}
      />
      <text x={0} y={gr * 0.32} text-anchor="middle" font-weight={700} font-size={gr} style={{ fill: 'var(--text)', fontFamily: HAND }}>
        {txt}
      </text>
    </g>
  );
}

export const tapeBreite = (l: Look, txt: string, gr: number) => txt.length * gr * Math.max(l.handWidth, 0.6) + 18;

/** The area a note covers, with a little room around it. */
export function tapeBox(l: Look, x: number, y: number, txt: string, gr: number): Rect {
  const w = tapeBreite(l, txt, gr);
  return {
    x: x - w / 2 - 2,
    y: y - gr * 0.95 - 6,
    w: w + 4,
    h: gr * 1.65 + 12,
  };
}

/** Width of handwriting, generous: the hand faces run wide. */
export const handBreite = (txt: string, size: number) => txt.length * size * 0.66;

export type { Anker, Pt };

/** A plain text that is not a label (titles inside parts); still kept off wires by the layout. */
export function freiText(x: number, y: number, txt: string, size: number, anchor: Anker, fill: string, hand = false): JSX.Element {
  return (
    <text x={x} y={y} text-anchor={anchor} font-size={size} font-weight={700} fill={fill} style={{ fontFamily: hand ? HAND : SCHRIFT }}>
      {txt}
    </text>
  );
}
