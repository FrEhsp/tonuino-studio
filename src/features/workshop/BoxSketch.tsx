/**
 * A drawing of a home-built box for "Box testen" (tab "Tasten"): the rough
 * plywood box of the welcome picture, drilled speaker, sawn edges, a card
 * on the lid and a row of arcade buttons with handwritten names, wobbling
 * through the filters of SketchDefs. The button the box just reported lights
 * up, the one the guide asks for has a pulsing ring, and a button with both
 * presses done gets a tick. The row shows which button is meant, not where
 * it sits on your box.
 *
 * Objects keep their colours in both themes, and so do the marks of the test
 * (ring, tick), so they stay visible on the wood in the dark theme. No
 * hooks: the drawings are plain functions (the tests call them).
 */
import { BUTTON_NAMES, buttonId, type ButtonKey, type PartsTest } from './partstest';

/** How long a reported button stays lit. */
export const LIT_MS = 1000;

/** Cap colours per button: blue, yellow, red, green and purple, as on the boxes in the forum. */
export const CAP_HOLZ: Record<ButtonKey, string> = {
  five: '#3f8fd6',
  down: '#f6c12c',
  pause: '#e5483b',
  up: '#58ad46',
  four: '#9c5d98',
};

export interface SketchButton {
  key: ButtonKey;
  label: string;
  /** Reported by the box less than LIT_MS ago. */
  lit: boolean;
  /** The guide asks for this button now. */
  want: boolean;
  /** Short and long press both came. */
  done: boolean;
}

/** The buttons of the drawing, left to right, with their state at `now`. */
export function sketchButtons(t: PartsTest, now: number): SketchButton[] {
  const keys: ButtonKey[] = t.buttonCount === 5 ? ['five', 'down', 'pause', 'up', 'four'] : ['down', 'pause', 'up'];
  const rows = t.rows();
  const next = t.finished ? undefined : t.current();
  const hit = t.lastHit;
  return keys.map((key) => ({
    key,
    label: BUTTON_NAMES[key],
    lit: !!hit && hit.id.startsWith(`${key}:`) && now - hit.at < LIT_MS && now >= hit.at - LIT_MS,
    want: next?.kind === 'button' && next.id.startsWith(`${key}:`),
    done: (['short', 'long'] as const).every((p) => rows.some((r) => r.id === buttonId(key, p) && r.at !== undefined)),
  }));
}

/** What a screen reader hears instead of the drawing. */
export function sketchLabel(buttons: SketchButton[]): string {
  const parts = [`Skizze der Box mit ${buttons.length} Tasten.`];
  const lit = buttons.find((b) => b.lit);
  const want = buttons.find((b) => b.want);
  const done = buttons.filter((b) => b.done);
  if (lit) parts.push(`Gerade gemeldet: ${lit.label}.`);
  if (want) parts.push(`Jetzt dran: ${want.label}.`);
  if (done.length) parts.push(`Fertig: ${done.map((b) => b.label).join(', ')}.`);
  return parts.join(' ');
}

/* ------------------------------------------------------------ wobbly lines */

/** A fixed pseudo-random number in -1..1, so the drawing looks the same on every render. */
function jitter(seed: number, i: number): number {
  const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

const f = (n: number) => n.toFixed(1);

/** A closed, smooth line through the points (quadratic curves between their midpoints). */
function closedCurve(pts: [number, number][]): string {
  const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const n = pts.length;
  const start = mid(pts[n - 1], pts[0]);
  let d = `M${f(start[0])} ${f(start[1])}`;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const m = mid(p, pts[(i + 1) % n]);
    d += ` Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`;
  }
  return `${d} Z`;
}

/** A circle drawn by hand: a little egg-shaped and bumpy. */
export function wobblyCircle(cx: number, cy: number, r: number, seed: number, wobble = 0.07): string {
  const n = 9;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + seed;
    const rr = r * (1 + wobble * jitter(seed, i));
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return closedCurve(pts);
}

/** A four-cornered shape with edges that bulge a bit, like a sawn board. */
export function wobblyQuad(corners: [number, number][], seed: number, bulge = 2.2): string {
  let d = `M${f(corners[0][0])} ${f(corners[0][1])}`;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const mx = (a[0] + b[0]) / 2 + bulge * jitter(seed, i);
    const my = (a[1] + b[1]) / 2 + bulge * jitter(seed, i + 7);
    d += ` Q${f(mx)} ${f(my)} ${f(b[0])} ${f(b[1])}`;
  }
  return `${d} Z`;
}

/** Holes drilled roughly in rings, a few slightly off. */
export function speakerHoles(cx: number, cy: number) {
  const out = [<path key="c" d={wobblyCircle(cx, cy, 2.6, 1, 0.2)} />];
  const rings: [number, number][] = [
    [10, 7],
    [19, 12],
    [28, 16],
  ];
  for (const [radius, count] of rings) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + radius * 0.07 + 0.08 * jitter(radius, i);
      const rr = radius + 1.4 * jitter(radius + 3, i);
      out.push(<path key={`${radius}-${i}`} d={wobblyCircle(cx + rr * Math.cos(a), cy + rr * Math.sin(a), 2.6, radius + i, 0.2)} />);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ layout */

interface Spot {
  b: SketchButton;
  cx: number;
  cy: number;
  r: number;
  /** Where the label's baseline sits. */
  labelY: number;
  /** The baseline of the upper line of names (labels that are not dropped). */
  rowY: number;
  /** Position in the row, from 0. */
  index: number;
  seed: number;
}

/**
 * On a phone the drawing shrinks and the names with it (to about 8 px).
 * There they grow to `size` and take turns on two lines, every second one
 * a line lower, so the bigger names do not run into each other. The values
 * go to readertest.css as custom properties; on a wide screen nothing
 * changes.
 */
export function labelStyle(index: number, labelY: number, rowY: number, lineGap: number, size: number): Record<string, string> {
  const target = rowY + (index % 2 ? lineGap : 0);
  return { '--pt-label-size': `${size}px`, '--pt-label-shift': `${f(target - labelY)}px` };
}

/**
 * Where the buttons sit: in a row from `from` to `to`, the middle one
 * (Play/Pause) a bit bigger, its label a line lower so long names do not
 * run into each other (with 5 buttons, or always with `dropAlways`).
 */
function spots(buttons: SketchButton[], from: number, to: number, cy: number, r: number, labelGap: number, lineGap: number, dropAlways = false): Spot[] {
  const n = buttons.length;
  const step = n > 1 ? (to - from) / (n - 1) : 0;
  const start = n > 1 ? from : (from + to) / 2;
  return buttons.map((b, i) => {
    const big = b.key === 'pause';
    const rr = big ? r * 1.2 : r;
    const rowY = cy + r * 1.2 + labelGap;
    return {
      b,
      cx: start + i * step,
      cy,
      r: rr,
      labelY: rowY + (big && (n === 5 || dropAlways) ? lineGap : 0),
      rowY,
      index: i,
      seed: i + 20,
    };
  });
}

function stateOf(b: SketchButton): string {
  return [b.lit && 'lit', b.want && 'want', b.done && 'done'].filter(Boolean).join(' ') || 'idle';
}

/** The pulsing ring around the button the guide asks for. */
function WantRing({ s, color, reducedMotion, width = 2.6 }: { s: Spot; color: string; reducedMotion: boolean; width?: number }) {
  return (
    <path d={wobblyCircle(s.cx, s.cy, s.r * 1.85, s.seed + 5, 0.06)} fill="none" stroke-width={width} stroke-dasharray="7 4" style={{ stroke: color }}>
      {reducedMotion ? null : <animate attributeName="opacity" values="1;0.3;1" dur="1.6s" repeatCount="indefinite" />}
    </path>
  );
}

/** Fixed colours of the marks on wood: they must not follow the theme, the wood does not either. */
const MARK_GREEN = '#1f7a3a';
const MARK_RING = '#7b3f86';

/**
 * A tick next to a button with both presses done: green with a thin ink
 * edge. `up` lifts it above a burst or glow, so it does not sit on it.
 */
function Tick({ s, ink, width = 3, up = false }: { s: Spot; ink: string; width?: number; up?: boolean }) {
  const x = s.cx + s.r * (up ? 1.15 : 1.3);
  const y = s.cy - s.r * (up ? 2.15 : 0.9);
  const d = `M${f(x)} ${f(y)} l4 4.5 c2 -5 5 -9 9 -12.5`;
  return (
    <g fill="none">
      <path d={d} stroke={ink} stroke-width={width + 2.4} />
      <path d={d} stroke={MARK_GREEN} stroke-width={width} />
    </g>
  );
}

/** "zack": three short strokes flying off the button. */
function Zack({ s, width = 2.4 }: { s: Spot; width?: number }) {
  return (
    <g fill="none" stroke-width={width}>
      <path d={`M${f(s.cx - s.r * 1.55)} ${f(s.cy - s.r * 1.05)} l-7 -4`} />
      <path d={`M${f(s.cx - s.r * 0.95)} ${f(s.cy - s.r * 1.7)} l-4 -7`} />
      <path d={`M${f(s.cx + 1)} ${f(s.cy - s.r * 2)} l1 -8`} />
    </g>
  );
}

function svgProps(buttons: SketchButton[], viewBox: string, cls: string) {
  return {
    class: `pt-sketch ${cls}`,
    viewBox,
    role: 'img' as const,
    'aria-label': sketchLabel(buttons),
    style: {
      display: 'block',
      width: '100%',
      maxWidth: '560px',
      height: 'auto',
      margin: '0 auto',
      overflow: 'visible',
    },
  };
}

/* ------------------------------------------------------------------ drawing */

export function BoxSketch({ buttons, reducedMotion = false }: { buttons: SketchButton[]; reducedMotion?: boolean }) {
  return <HolzBox buttons={buttons} reducedMotion={reducedMotion} />;
}

/* ------------------------------------------------------------------ Holz */

export const B_INK = '#2a1f16';
export const PAPER = '#fffcf5';

/**
 * Holz: the rough plywood box of the welcome picture, front, lid and side
 * sawn a little crooked, a drilled speaker, a card with a sticker lying on
 * the lid and the arcade buttons with handwritten names.
 */
function HolzBox({ buttons, reducedMotion }: { buttons: SketchButton[]; reducedMotion: boolean }) {
  const five = buttons.length === 5;
  const row = spots(buttons, five ? 162 : 200, five ? 392 : 350, 160, 13, 19, 16, true);
  return (
    <svg {...svgProps(buttons, '0 0 480 262', 'sketch-art')}>
      <g filter="url(#ts-wobble-art)" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
        {/* table */}
        <path d="M8 248 C130 243 300 250 472 244" fill="none" stroke="currentColor" stroke-width="2.6" opacity="0.6" />
        {/* the box: front, lid, side */}
        <g stroke={B_INK} stroke-width="3.4">
          <path
            d={wobblyQuad(
              [
                [24, 104],
                [420, 102],
                [423, 236],
                [21, 239],
              ],
              5,
            )}
            fill="#c98c50"
          />
          <path
            d={wobblyQuad(
              [
                [24, 104],
                [72, 64],
                [466, 62],
                [420, 102],
              ],
              3,
            )}
            fill="#ddb07a"
          />
          <path
            d={wobblyQuad(
              [
                [420, 102],
                [466, 62],
                [469, 194],
                [423, 236],
              ],
              7,
            )}
            fill="#a8723e"
          />
        </g>
        {/* wood grain */}
        <g fill="none" stroke="#8c6238" stroke-width="1.6" opacity="0.75">
          <path d="M36 116 C100 112 160 120 230 115 S340 118 408 113" />
          <path d="M160 228 C220 224 300 230 410 225" />
          <path d="M100 82 C160 78 240 84 330 79 S420 80 450 76" />
          <path d="M440 116 C446 140 444 172 448 196" />
          <ellipse cx="46" cy="222" rx="9" ry="3.6" />
        </g>
        {/* a card with a sticker on the lid */}
        <g transform="translate(70 4) rotate(-7 168 50)">
          <path
            d={wobblyQuad(
              [
                [126, 20],
                [212, 19],
                [213, 70],
                [125, 71],
              ],
              11,
              1.6,
            )}
            fill={PAPER}
            stroke={B_INK}
            stroke-width="2.8"
          />
          <path
            d={wobblyQuad(
              [
                [132, 26],
                [170, 26],
                [170, 64],
                [132, 64],
              ],
              12,
              1.2,
            )}
            fill="#12a89d"
            stroke={B_INK}
            stroke-width="1.8"
          />
          <path d="M151 32 L155 41 L164 41 L157 47 L160 56 L151 51 L142 56 L145 47 L138 41 L147 41 Z" fill="#fdd459" stroke={B_INK} stroke-width="1.6" />
          <text x="178" y="58" class="sketch-marker" fill={B_INK} stroke="none" font-size="17">
            07
          </text>
        </g>
        {/* drilled speaker */}
        <g fill={B_INK} stroke="none">
          {speakerHoles(90, 170)}
        </g>
        {/* buttons */}
        {/* the light of the button just pressed, under all buttons and names */}
        {row.map((s) =>
          s.b.lit ? (
            <g key={`glow-${s.b.key}`} stroke="none">
              <path d={wobblyCircle(s.cx, s.cy, s.r * 2.1, s.seed + 3, 0.1)} fill="#ffd23f" opacity="0.75" />
              <path d={wobblyCircle(s.cx, s.cy, s.r * 1.65, s.seed + 4, 0.08)} fill="#fff3a8" opacity="0.85" />
            </g>
          ) : null,
        )}
        {row.map((s) => (
          <g key={s.b.key} data-key={s.b.key} data-state={stateOf(s.b)} stroke={B_INK}>
            {s.b.want ? <WantRing s={s} color={MARK_RING} reducedMotion={reducedMotion} /> : null}
            <path d={wobblyCircle(s.cx, s.cy, s.r * 1.32, s.seed, 0.06)} fill="#3a2a1d" stroke-width="2.6" />
            <path d={wobblyCircle(s.cx, s.cy + (s.b.lit ? 1.5 : 0), s.r, s.seed + 1, 0.07)} fill={CAP_HOLZ[s.b.key]} stroke-width="2" />
            <path
              d={`M${f(s.cx - s.r * 0.55)} ${f(s.cy - s.r * 0.35)} C${f(s.cx - s.r * 0.4)} ${f(s.cy - s.r * 0.62)} ${f(s.cx - s.r * 0.1)} ${f(s.cy - s.r * 0.72)} ${f(s.cx + s.r * 0.15)} ${f(s.cy - s.r * 0.68)}`}
              fill="none"
              stroke={PAPER}
              stroke-width="2"
              opacity={s.b.lit ? 1 : 0.8}
            />
            {s.b.lit ? <Zack s={s} /> : null}
            {s.b.done ? <Tick s={s} ink={B_INK} /> : null}
            <text
              x={f(s.cx)}
              y={f(s.labelY)}
              text-anchor="middle"
              class="sketch-hand pt-label"
              style={labelStyle(s.index, s.labelY, s.rowY, 21, 21)}
              fill={B_INK}
              stroke="none"
              font-size={five ? 15 : 17}
              font-weight={s.b.lit || s.b.want ? 700 : 400}
            >
              {s.b.label}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}
