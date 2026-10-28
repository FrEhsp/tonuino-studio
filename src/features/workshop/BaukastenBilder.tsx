/**
 * The pictures of the Firmware-Baukasten and of „Verhalten“ (design
 * 06-umbau/loetplan/quelle/werkstatt.js): the box seen from the front with
 * what is chosen, the small pictures of the tiles, the two marks „in die
 * Firmware“ and „an der Box“, and the tick box drawn with ink.
 */
import type { KnobKind, LightKind } from '../../core/firmware/baukasten';
import type { BildArt } from './baukastenWahl';

const INK = '#2a1f16';
const FARBEN = ['#e5483b', '#f7941d', '#f6c12c', '#58ad46', '#12a89d', '#3f8fd6', '#7b4fc8', '#ed207b'];
const KAPPEN = ['#e5483b', '#f6c12c', '#3f8fd6'];

/** The holes of the speaker, ring by ring. */
const LOECHER: [number, number][] = [];
for (const [rr, n] of [
  [0, 1],
  [11, 6],
  [22, 12],
  [33, 18],
] as const) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rr * 0.05;
    LOECHER.push([+(130 + rr * Math.cos(a)).toFixed(1), +(112 + rr * Math.sin(a)).toFixed(1)]);
  }
}

/** The box from the front, as chosen: knob top right, the ring around the speaker, the buttons below. */
export function BoxVorne({ knob, light, width = 250 }: { knob?: KnobKind; light?: LightKind; width?: number }) {
  const ring = light === 'ring' || light === 'ringVolume';
  const led = light === 'ledButtons';
  return (
    <svg class="bk-box" width={width} viewBox="0 0 260 240" role="img" aria-label={boxLabel(knob, light)}>
      <g stroke-linejoin="round" stroke-linecap="round">
        <rect x="16" y="14" width="228" height="214" rx="6" fill="#c98c50" stroke={INK} stroke-width="3.4" />
        <g fill="none" stroke="#8c6238" stroke-width="1.6" opacity="0.7">
          <path d="M26 30 C70 26 120 33 170 28 S220 31 236 27" />
          <path d="M28 220 C80 216 140 222 234 216" />
          <path d="M30 160 C60 157 90 162 110 158" />
        </g>
        {ring ? (
          <g>
            <circle cx="130" cy="112" r="49" fill="#1f1f1f" stroke={INK} stroke-width="2.4" />
            <circle cx="130" cy="112" r="39" fill="#c98c50" />
            {Array.from({ length: 24 }, (_, i) => {
              const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
              const an = light === 'ring' || i < 15;
              return <circle key={i} cx={(130 + 44 * Math.cos(a)).toFixed(1)} cy={(112 + 44 * Math.sin(a)).toFixed(1)} r="3.2" fill={an ? (light === 'ring' ? FARBEN[i % 8] : '#58ad46') : '#4a4540'} />;
            })}
          </g>
        ) : null}
        <g fill={INK}>
          {LOECHER.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="2.6" />
          ))}
        </g>
        {[92, 130, 168].map((cx, i) => (
          <g key={cx}>
            {led ? <circle cx={cx} cy="196" r="20" fill={KAPPEN[i]} opacity="0.28" /> : null}
            <circle cx={cx} cy="196" r="15" fill="#3a2a1d" stroke={INK} stroke-width="2.6" />
            <circle cx={cx} cy="196" r="11" fill={KAPPEN[i]} stroke={INK} stroke-width="2.2" />
          </g>
        ))}
        {knob === 'encoder' || knob === 'encoderSkip' ? (
          <g>
            <circle cx="214" cy="46" r="17" fill="#3d3a36" stroke={INK} stroke-width="2.6" />
            <circle cx="214" cy="46" r="12" fill="#9a958d" stroke={INK} stroke-width="2" />
            <path d="M214 36v9" stroke={INK} stroke-width="3" />
          </g>
        ) : knob === 'poti' ? (
          <g>
            <circle cx="214" cy="46" r="17" fill="#f2efe8" stroke={INK} stroke-width="2.6" />
            <path d="M200 58 A19 19 0 1 1 228 58" fill="none" stroke={INK} stroke-width="1.6" stroke-dasharray="2 4" />
            <path d="M214 46l-8 -8" stroke={INK} stroke-width="3" />
          </g>
        ) : null}
      </g>
    </svg>
  );
}

function boxLabel(knob?: KnobKind, light?: LightKind): string {
  const teile = [knob ? (knob === 'poti' ? 'Knopf ohne Raster' : 'Drehregler') : '', light === 'ledButtons' ? 'leuchtenden Tasten' : light ? 'Leuchtring' : ''].filter(Boolean);
  return teile.length ? `Deine Box von vorn, mit ${teile.join(' und ')}` : 'Deine Box von vorn';
}

const I = '#1f1a16';

function MiniRing({ teil }: { teil: boolean }) {
  return (
    <>
      <circle cx="60" cy="32" r="26" fill="#1f1f1f" stroke={I} stroke-width="2" />
      <circle cx="60" cy="32" r="16" fill="#fffdf8" />
      {Array.from({ length: 16 }, (_, i) => {
        const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
        return <circle key={i} cx={(60 + 21 * Math.cos(a)).toFixed(1)} cy={(32 + 21 * Math.sin(a)).toFixed(1)} r="2.6" fill={teil ? (i < 10 ? '#58ad46' : '#4a4540') : FARBEN[i % 8]} />;
      })}
    </>
  );
}

function Leer() {
  return (
    <>
      <circle class="bk-leer" cx="60" cy="32" r="22" fill="none" stroke-width="2" stroke-dasharray="5 4" />
      <path class="bk-leer" d="M50 32h20" stroke-width="2.4" stroke-linecap="round" />
    </>
  );
}

function Dreh() {
  return (
    <>
      <rect x="34" y="12" width="52" height="40" rx="3" fill="#2d6a3e" stroke={I} stroke-width="2" />
      <circle cx="60" cy="32" r="13" fill="#9a958d" stroke={I} stroke-width="2" />
      <path d="M60 22v9" stroke={I} stroke-width="2.6" stroke-linecap="round" />
    </>
  );
}

/** A small picture of a tile, 120 × 64. */
export function BildWahl({ art }: { art: BildArt }) {
  let inhalt;
  switch (art) {
    case 'knopfKein':
    case 'lichtKein':
      inhalt = <Leer />;
      break;
    case 'drehgeber':
      inhalt = <Dreh />;
      break;
    case 'drehgeberSkip':
      inhalt = (
        <>
          <Dreh />
          <path class="bk-pfeil" d="M24 22 L16 32 L24 42" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
          <path class="bk-pfeil" d="M96 22 L104 32 L96 42" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
        </>
      );
      break;
    case 'poti':
      inhalt = (
        <>
          <rect x="38" y="24" width="44" height="30" rx="3" fill="#3f6fb3" stroke={I} stroke-width="2" />
          <rect x="55" y="6" width="10" height="20" rx="2" fill="#c9ccd2" stroke={I} stroke-width="2" />
          <path class="bk-pfeil" d="M44 60v-6M60 60v-6M76 60v-6" stroke-width="2.2" />
        </>
      );
      break;
    case 'ring':
      inhalt = <MiniRing teil={false} />;
      break;
    case 'ringVolume':
      inhalt = <MiniRing teil />;
      break;
    case 'ledButtons':
      inhalt = (
        <>
          {[40, 60, 80].map((x, i) => (
            <g key={x}>
              <circle cx={x} cy="36" r="13" fill={KAPPEN[i]} opacity="0.3" />
              <circle cx={x} cy="36" r="8" fill={KAPPEN[i]} stroke={I} stroke-width="2" />
            </g>
          ))}
          <path class="bk-pfeil" d="M60 8v6M44 12l3 5M76 12l-3 5" stroke-width="2" stroke-linecap="round" />
        </>
      );
      break;
  }
  return (
    <svg class="bk-bildchen" width="120" height="64" viewBox="0 0 120 64" aria-hidden="true">
      {inhalt}
    </svg>
  );
}

/** The mark of the firmware: a sheet with lines. */
export function ZeichenFw() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" fill="#fff" stroke={I} stroke-width="1.6" />
      <path d="M5 6.5h6M5 9.5h4" stroke={I} stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

/** The mark of the box: a small box with three buttons. */
export function ZeichenBox() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="3" width="13" height="11" rx="1.5" fill="#c98c50" stroke={I} stroke-width="1.6" />
      <circle cx="5" cy="10.5" r="1.7" fill="#e5483b" />
      <circle cx="8" cy="10.5" r="1.7" fill="#f6c12c" />
      <circle cx="11" cy="10.5" r="1.7" fill="#3f8fd6" />
    </svg>
  );
}

/** „kommt in die Firmware“ or „stellst du an der Box ein“, as a small label. */
export function Marke({ wo, children }: { wo: 'firmware' | 'box'; children: string }) {
  return (
    <span class={wo === 'firmware' ? 'marke-fw' : 'marke-box'}>
      {wo === 'firmware' ? <ZeichenFw /> : <ZeichenBox />}
      {children}
    </span>
  );
}

/** A tick box drawn with ink, the tick in pencil (design kastenJa). */
export function KastenJa({ an }: { an: boolean }) {
  return (
    <svg class="lp-kasten" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <path class="lp-kasten-rand" d="M3.2 3.6 L18.6 3.1 L18.9 18.7 L3.4 19 Z" stroke-width="2" stroke-linejoin="round" />
      {an ? <path class="lp-kasten-haken" d="M5.4 11.6 C7.2 12.8 8.6 14.4 9.6 16.6 C12 11 15.6 6.4 20.4 2.2" fill="none" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" /> : null}
    </svg>
  );
}
