/**
 * The drawn box of "Box testen": the plywood box of the button test, now
 * with every part the guided test checks: the card on the lid with the blue
 * card reader under it, the speaker (and the LED ring around it), the red,
 * green and yellow arcade buttons, the headphone socket and the volume knob
 * on the side, the USB cable and the battery. The SD card has no slot on
 * the box: on nearly every TonUINO it sits inside on the MP3 module (Frank),
 * so it is a pencil note under the box, pointing in. Each part turns green
 * with a tick when it works and red with a cross when not; the part of the
 * current step has a pulsing ring.
 *
 * Plain function of its input, no hooks (the tests call it).
 */
import type { JSX } from 'preact';
import type { TeilId } from './boxbefund';
import { B_INK, CAP_HOLZ, PAPER, speakerHoles, wobblyCircle, wobblyQuad } from './BoxSketch';
import type { TasteStand, TeilStatus } from './boxtest';

export interface BoxTestBild {
  teile: { id: TeilId; status: TeilStatus }[];
  tasten: TasteStand[];
  /** The part of the current step. */
  jetzt?: TeilId;
  /** The button asked for now. */
  wantTaste?: string;
  /** The button reported just now. */
  litTaste?: string;
  reducedMotion?: boolean;
}

const GREEN = '#1f7a3a';
const RED = '#d22a2a';
const RING = '#7b3f86';
const f = (n: number) => n.toFixed(1);

/** What a screen reader hears instead of the drawing. */
export function boxTestLabel(b: BoxTestBild, namen: Record<TeilId, string>): string {
  const ok = b.teile.filter((t) => t.status === 'ok').map((t) => namen[t.id]);
  const bad = b.teile.filter((t) => t.status === 'fehler').map((t) => namen[t.id]);
  const parts = ['Skizze deiner Box.'];
  if (b.jetzt) parts.push(`Jetzt dran: ${namen[b.jetzt]}.`);
  if (ok.length) parts.push(`Geht: ${ok.join(', ')}.`);
  if (bad.length) parts.push(`Problem: ${bad.join(', ')}.`);
  return parts.join(' ');
}

/**
 * Tick, cross or nothing next to a part; the pulsing ring around the part of the step.
 * `rx` makes the ring an oval as wide as a written note (the circle stretched, its line kept as thick).
 */
function Mark({ x, y, r, rx, status, jetzt, reducedMotion, seed }: { x: number; y: number; r: number; rx?: number; status: TeilStatus; jetzt: boolean; reducedMotion?: boolean; seed: number }) {
  const out: JSX.Element[] = [];
  const oval = rx ? `translate(${f(x)} ${f(y)}) scale(${(rx / r).toFixed(3)} 1) translate(${f(-x)} ${f(-y)})` : undefined;
  if (jetzt)
    out.push(
      <path key="want" d={wobblyCircle(x, y, r + 7, seed + 5, 0.06)} transform={oval} vector-effect={oval ? 'non-scaling-stroke' : undefined} fill="none" stroke-width={2.8} stroke-dasharray="7 4" style={{ stroke: RING }}>
        {reducedMotion ? null : <animate attributeName="opacity" values="1;0.3;1" dur="1.6s" repeatCount="indefinite" />}
      </path>,
    );
  if (status === 'fehler') {
    out.push(<path key="bad" d={wobblyCircle(x, y, r + 4, seed + 9, 0.05)} transform={oval} vector-effect={oval ? 'non-scaling-stroke' : undefined} fill="none" stroke={RED} stroke-width={3.4} />);
    const cx = x + (rx ?? r) * 0.9;
    const cy = y - r * 0.9;
    out.push(
      <g key="x" stroke-width={3.4} fill="none">
        <circle cx={cx} cy={cy} r={9} fill="#fff" stroke={RED} stroke-width={2} />
        <path d={`M${f(cx - 4)} ${f(cy - 4)} l8 8 M${f(cx + 4)} ${f(cy - 4)} l-8 8`} stroke={RED} />
      </g>,
    );
  } else if (status === 'ok') {
    const cx = x + (rx ?? r) * 0.9;
    const cy = y - r * 0.9;
    const d = `M${f(cx - 6)} ${f(cy)} l4 4.5 c2 -5 5 -9 9 -12.5`;
    out.push(
      <g key="ok" fill="none">
        <circle cx={cx} cy={cy - 1} r={10} fill="#fff" stroke={GREEN} stroke-width={1.6} />
        <path d={d} stroke={GREEN} stroke-width={3.2} />
      </g>,
    );
  }
  return <g data-mark={status}>{out}</g>;
}

/** A handwritten name; `aussen` for names beside the box, on the page, which follow the theme. */
function label(x: number, y: number, txt: string, anchor: 'start' | 'middle' | 'end' = 'middle', size = 13, aussen = true) {
  return (
    <text x={f(x)} y={f(y)} text-anchor={anchor} class="sketch-hand" fill={aussen ? 'currentColor' : B_INK} stroke="none" font-size={size}>
      {txt}
    </text>
  );
}

export function BoxTestSketch(b: BoxTestBild & { label: string }) {
  const st = (id: TeilId) => b.teile.find((t) => t.id === id)?.status;
  const has = (id: TeilId) => st(id) !== undefined && st(id) !== 'aus';
  const mark = (id: TeilId, x: number, y: number, r: number, seed: number, rx?: number) => {
    const s = st(id);
    if (!s || s === 'aus') return null;
    return <Mark key={`m-${id}`} x={x} y={y} r={r} rx={rx} status={s} jetzt={b.jetzt === id} reducedMotion={b.reducedMotion} seed={seed} />;
  };
  const five = b.tasten.length === 5;
  const xs = five ? [162, 220, 277, 334, 392] : [200, 275, 350];
  // Left to right as on most boxes: Zurück, Play/Pause, Vor (and Leiser, Lauter outside).
  const order = five ? ['five', 'down', 'pause', 'up', 'four'] : ['down', 'pause', 'up'];
  const tasten = order.map((key, i) => ({ t: b.tasten.find((t) => t.key === key)!, x: xs[i] })).filter((x) => x.t);
  const ringOn = st('ring') === 'ok';

  return (
    <svg class="pt-sketch sketch-art bt-sketch" viewBox="0 0 540 312" role="img" aria-label={b.label} style={{ display: 'block', width: '100%', maxWidth: '620px', height: 'auto', margin: '0 auto', overflow: 'visible' }}>
      <g stroke-linejoin="round" stroke-linecap="round">
        {/* table */}
        <path d="M8 268 C130 263 300 270 532 264" fill="none" stroke="currentColor" stroke-width="2.6" opacity="0.6" />
        {/* the box: front, lid, side */}
        <g stroke={B_INK} stroke-width="3.4">
          <path
            d={wobblyQuad(
              [
                [24, 124],
                [420, 122],
                [423, 256],
                [21, 259],
              ],
              5,
            )}
            fill="#c98c50"
          />
          <path
            d={wobblyQuad(
              [
                [24, 124],
                [72, 84],
                [466, 82],
                [420, 122],
              ],
              3,
            )}
            fill="#ddb07a"
          />
          <path
            d={wobblyQuad(
              [
                [420, 122],
                [466, 82],
                [469, 214],
                [423, 256],
              ],
              7,
            )}
            fill="#a8723e"
          />
        </g>
        <g fill="none" stroke="#8c6238" stroke-width="1.6" opacity="0.75">
          <path d="M36 136 C100 132 160 140 230 135 S340 138 408 133" />
          <path d="M160 248 C220 244 300 250 410 245" />
        </g>
        {/* card reader (blue, under the lid) and the card on it */}
        <g transform="rotate(-6 250 60)">
          <path
            d={wobblyQuad(
              [
                [196, 30],
                [304, 28],
                [306, 92],
                [194, 94],
              ],
              21,
              1.4,
            )}
            fill="#1d5aa6"
            stroke="#0d3466"
            stroke-width="2.4"
            stroke-dasharray="6 4"
          />
          <path d="M206 40 h84 v44 h-84 z M214 48 h68 v28 h-68 z" fill="none" stroke="#9cc3f0" stroke-width="1.6" opacity="0.8" />
          <path
            d={wobblyQuad(
              [
                [214, 16],
                [292, 15],
                [293, 62],
                [213, 63],
              ],
              11,
              1.6,
            )}
            fill={PAPER}
            stroke={B_INK}
            stroke-width="2.6"
          />
          <path
            d={wobblyQuad(
              [
                [220, 22],
                [254, 22],
                [254, 56],
                [220, 56],
              ],
              12,
              1.2,
            )}
            fill="#12a89d"
            stroke={B_INK}
            stroke-width="1.6"
          />
          <path d="M237 28 L240.5 36 L249 36 L242.5 41 L245 49 L237 44.5 L229 49 L231.5 41 L225 36 L233.5 36 Z" fill="#fdd459" stroke={B_INK} stroke-width="1.4" />
        </g>
        {label(318, 30, 'Kartenleser in der Box', 'start')}
        {mark('leser', 250, 58, 40, 31)}
        {/* speaker, the LED ring around it */}
        <g fill={B_INK} stroke="none">
          {speakerHoles(90, 190)}
        </g>
        {has('ring')
          ? Array.from({ length: 16 }, (_, i) => {
              const a = (i / 16) * Math.PI * 2;
              const hue = (i * 360) / 16;
              return <circle key={`led${i}`} cx={f(90 + 44 * Math.cos(a))} cy={f(190 + 44 * Math.sin(a))} r={4.2} fill={ringOn ? `hsl(${hue} 85% 55%)` : '#e9e2d4'} stroke={B_INK} stroke-width={1.2} />;
            })
          : null}
        {label(90, 252, has('ring') ? 'Lautsprecher, LED-Ring' : 'Lautsprecher', 'middle', 13, false)}
        {mark('lautsprecher', 90, 190, has('ring') ? 50 : 36, 41)}
        {has('ring') ? mark('ring', 54, 152, 10, 43) : null}
        {/* buttons */}
        {tasten.map(({ t, x }, i) => {
          const cy = 180;
          const r = t.key === 'pause' ? 15.6 : 13;
          const lit = b.litTaste === t.key;
          const want = b.jetzt === 'tasten' && b.wantTaste === t.key;
          return (
            <g key={t.key} data-key={t.key} data-state={t.status} stroke={B_INK}>
              {lit ? <path d={wobblyCircle(x, cy, r * 2.1, i + 3, 0.1)} fill="#ffd23f" opacity="0.75" stroke="none" /> : null}
              <path d={wobblyCircle(x, cy, r * 1.32, i + 20, 0.06)} fill="#3a2a1d" stroke-width="2.6" />
              <path d={wobblyCircle(x, cy + (lit ? 1.5 : 0), r, i + 21, 0.07)} fill={CAP_HOLZ[t.key]} stroke-width="2" />
              <path d={`M${f(x - r * 0.55)} ${f(cy - r * 0.35)} C${f(x - r * 0.4)} ${f(cy - r * 0.62)} ${f(x - r * 0.1)} ${f(cy - r * 0.72)} ${f(x + r * 0.15)} ${f(cy - r * 0.68)}`} fill="none" stroke={PAPER} stroke-width="2" opacity="0.8" />
              <Mark x={x} y={cy} r={r * 1.35} status={t.status === 'offen' ? 'offen' : t.status} jetzt={want} reducedMotion={b.reducedMotion} seed={i + 50} />
              <text x={f(x)} y={f(cy + r + 26 + (five && i % 2 ? 16 : 0))} text-anchor="middle" class="sketch-hand" fill={B_INK} stroke="none" font-size={five ? 14 : 16} font-weight={want || lit ? 700 : 400}>
                {t.name}
              </text>
            </g>
          );
        })}
        {b.jetzt === 'tasten' && !b.wantTaste ? mark('tasten', 275, 180, 90, 61) : null}
        {/* The SD card sits inside on the MP3 module, no slot on the box: a pencil note under it, pointing in. */}
        <path d="M346 278 C348 268 356 258 368 250 M358 250 L368 249.5 L366 259" fill="none" stroke="currentColor" stroke-width="1.8" opacity="0.8" />
        {label(342, 294, 'SD-Karte (innen)', 'middle', 13)}
        {mark('mp3', 342, 289, 12, 71, 58)}
        {/* side: headphone socket, knob */}
        {has('kopfhoerer') ? (
          <g>
            <circle cx="444" cy="118" r="7.5" fill="#2b2b2b" stroke={B_INK} stroke-width="2" />
            <circle cx="444" cy="118" r="3" fill="#000" />
            {label(476, 104, 'Kopfhörer', 'start', 12)}
          </g>
        ) : null}
        {mark('kopfhoerer', 444, 118, 10, 81)}
        {has('knopf') ? (
          <g>
            <ellipse cx="446" cy="162" rx="11" ry="12" fill="#3a3a3a" stroke={B_INK} stroke-width="2" />
            <path d="M446 152 v8" stroke="#eee" stroke-width="2.4" />
            {label(476, 158, 'Knopf', 'start', 12)}
          </g>
        ) : null}
        {mark('knopf', 446, 162, 13, 91)}
        {/* USB cable to the computer */}
        <path d="M447 200 C470 214 486 236 520 246" fill="none" stroke="#4a4a4a" stroke-width="5" />
        <rect x="438" y="192" width="16" height="11" rx="2" fill="#bbb" stroke={B_INK} stroke-width="1.6" />
        {label(476, 196, 'USB', 'start', 12)}
        {mark('usb', 446, 198, 12, 101)}
        {/* power: a lightning on the cable */}
        <path d="M498 222 l-7 10 h6 l-5 10 l12 -13 h-6 l5 -7 z" fill="#ffd23f" stroke={B_INK} stroke-width="1.4" />
        {mark('strom', 497, 232, 12, 111)}
        {/* battery, if the box has one */}
        {has('akku') ? (
          <g>
            <rect x="476" y="256" width="40" height="18" rx="3" fill="#58ad46" stroke={B_INK} stroke-width="2" />
            <rect x="516" y="261" width="4" height="8" fill={B_INK} />
            {label(496, 290, 'Akku', 'middle', 12)}
          </g>
        ) : null}
        {mark('akku', 496, 265, 18, 121)}
      </g>
    </svg>
  );
}
