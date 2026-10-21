/**
 * The pictures of the help, drawn like the other pictures of the app
 * (src/ui/components/Art.tsx, BoxSketch.tsx): felt-pen lines that wobble
 * through the filter of SketchDefs, flat colours of wood, paper and parts,
 * handwritten notes. Objects keep their dark outline in both themes; notes
 * written next to them take the theme's ink (currentColor). Writing on the
 * wood or on paper stays dark, so it can be read in the dark theme too.
 *
 * They explain or decorate; they never copy a real cover or product photo.
 */
import type { JSX } from 'preact';

export type HelpArtId =
  | 'kat-probleme'
  | 'kat-musik'
  | 'kat-karten'
  | 'kat-werkstatt'
  | 'kat-app'
  | 'loetstelle'
  | 'wackeltest'
  | 'box-innen'
  | 'sd-ordner'
  | 'karte-auflegen'
  | 'schreibschutz'
  | 'sd-herausnehmen'
  | 'weg-der-karte'
  | 'handy-karte'
  | 'admin-tasten'
  | 'nano-pins'
  | 'stickerbogen'
  | 'daneben'
  | 'karte-ordner';

export const HELP_ART_IDS: readonly HelpArtId[] = [
  'kat-probleme',
  'kat-musik',
  'kat-karten',
  'kat-werkstatt',
  'kat-app',
  'loetstelle',
  'wackeltest',
  'box-innen',
  'sd-ordner',
  'karte-auflegen',
  'schreibschutz',
  'sd-herausnehmen',
  'weg-der-karte',
  'handy-karte',
  'admin-tasten',
  'nano-pins',
  'stickerbogen',
  'daneben',
  'karte-ordner',
];

const INK = '#2a1f16';
const PAPER = '#fffcf5';
const WOOD = '#c98c50';
const WOOD_LIGHT = '#ddb07a';
const WOOD_DARK = '#a8723e';
const RED = '#e5483b';
const YELLOW = '#f6c12c';
const BLUE = '#3f8fd6';
const GREEN = '#58ad46';
const PURPLE = '#9c5d98';
const METAL = '#cfd3d8';
/** The floor inside the open box. */
const FLOOR = '#ecd3ad';

const VIEW: Record<HelpArtId, string> = {
  'kat-probleme': '0 0 160 112',
  'kat-musik': '0 0 160 112',
  'kat-karten': '0 0 160 112',
  'kat-werkstatt': '0 0 160 112',
  'kat-app': '0 0 160 112',
  loetstelle: '0 0 380 210',
  wackeltest: '0 0 420 290',
  'box-innen': '0 0 420 262',
  'sd-ordner': '0 0 400 236',
  'karte-auflegen': '0 0 380 210',
  schreibschutz: '0 0 340 200',
  'sd-herausnehmen': '0 0 360 200',
  'weg-der-karte': '0 0 340 236',
  'handy-karte': '0 0 380 230',
  'admin-tasten': '0 0 400 230',
  'nano-pins': '0 0 500 330',
  stickerbogen: '0 0 400 280',
  daneben: '0 0 420 236',
  'karte-ordner': '0 0 420 244',
};

/** One picture of the help. Its meaning is said in the caption next to it, so the drawing itself is hidden from screen readers. */
export function HelpArt({ art, class: cls }: { art: HelpArtId; class?: string }) {
  return (
    <svg class={`sketch-art help-art help-art-${art} ${cls ?? ''}`} viewBox={VIEW[art]} aria-hidden="true" focusable="false">
      <g filter="url(#ts-wobble-art)" stroke-linejoin="round" stroke-linecap="round">
        {DRAW[art]()}
      </g>
    </svg>
  );
}

const DRAW: Record<HelpArtId, () => JSX.Element> = {
  'kat-probleme': katProbleme,
  'kat-musik': katMusik,
  'kat-karten': katKarten,
  'kat-werkstatt': katWerkstatt,
  'kat-app': katApp,
  loetstelle: loetstelle,
  wackeltest: () => boxInside(true),
  'box-innen': () => boxInside(false),
  'sd-ordner': sdOrdner,
  'karte-auflegen': karteAuflegen,
  schreibschutz: schreibschutz,
  'sd-herausnehmen': sdHerausnehmen,
  'weg-der-karte': wegDerKarte,
  'handy-karte': handyKarte,
  'admin-tasten': adminTasten,
  'nano-pins': nanoPins,
  stickerbogen: stickerbogen,
  daneben: daneben,
  'karte-ordner': karteOrdner,
};

/* ------------------------------------------------------------------ small parts */

function arcade(cx: number, cy: number, r: number, color: string, sw = 2.6) {
  return (
    <g stroke={INK}>
      <circle cx={cx} cy={cy} r={r * 1.32} fill="#3a2a1d" stroke-width={sw} />
      <circle cx={cx} cy={cy} r={r} fill={color} stroke-width={sw * 0.75} />
      <path d={`M${cx - r * 0.55} ${cy - r * 0.35} C${cx - r * 0.4} ${cy - r * 0.62} ${cx - r * 0.1} ${cy - r * 0.72} ${cx + r * 0.15} ${cy - r * 0.68}`} fill="none" stroke={PAPER} stroke-width={sw * 0.7} opacity="0.85" />
    </g>
  );
}

/** A tick in green or a cross in red, drawn with a thick pen. */
function tick(x: number, y: number, s = 1) {
  return <path d={`M${x} ${y} l${8 * s} ${9 * s} l${16 * s} ${-22 * s}`} fill="none" stroke={GREEN} stroke-width={5 * s} />;
}

function cross(x: number, y: number, s = 1) {
  return (
    <g fill="none" stroke={RED} stroke-width={5 * s}>
      <path d={`M${x} ${y} l${20 * s} ${20 * s}`} />
      <path d={`M${x + 20 * s} ${y} l${-20 * s} ${20 * s}`} />
    </g>
  );
}

/** A note in the hand font, in the theme's ink. */
function note(x: number, y: number, text: string, size = 19, anchor: 'start' | 'middle' | 'end' = 'start') {
  return (
    <text x={x} y={y} class="sketch-hand" fill="currentColor" stroke="none" font-size={size} text-anchor={anchor}>
      {text}
    </text>
  );
}

/** Writing on wood or paper: always dark. */
function label(x: number, y: number, text: string, size = 15, anchor: 'start' | 'middle' | 'end' = 'start', halo?: string) {
  // With a halo the writing keeps a rim of the paper around it, so a cable drawn under it does not cut through the letters.
  const rim = halo ? { stroke: halo, 'stroke-width': 4, 'stroke-linejoin': 'round' as const, 'paint-order': 'stroke' } : { stroke: 'none' };
  return (
    <text x={x} y={y} class="sketch-hand" fill={INK} {...rim} font-size={size} text-anchor={anchor}>
      {text}
    </text>
  );
}

/** The purple SD card, upright, top left corner at x y, `w` wide. */
function sdCard(x: number, y: number, w: number, sw = 2.6) {
  const k = w / 76;
  return (
    <g transform={`translate(${x} ${y}) scale(${k})`} stroke={INK}>
      <path d="M7 0 L58 1 L76 19 L75 112 C75 116 72 119 68 119 L8 118 C3 118 0 115 0 111 L0 8 C0 3 3 0 7 0 Z" fill={PURPLE} stroke-width={sw / k} />
      <g fill="#fdd459" stroke-width={(sw * 0.6) / k}>
        <rect x="10" y="6" width="8" height="18" rx="1.5" />
        <rect x="23" y="6" width="8" height="18" rx="1.5" />
        <rect x="36" y="6" width="8" height="18" rx="1.5" />
        <rect x="49" y="6" width="8" height="18" rx="1.5" />
      </g>
      <rect x="9" y="43" width="57" height="64" rx="4" fill={PAPER} stroke-width={(sw * 0.8) / k} />
    </g>
  );
}

/* ------------------------------------------------------------------ the five tiles of the start page */

/** A box that does not play: a wooden box with its buttons and a speech bubble with a question mark. */
function katProbleme() {
  return (
    <>
      <path d="M8 104 C50 101 110 104 152 101" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.5" />
      <g stroke={INK} stroke-width="2.8">
        <path d="M14 52 L104 51 L105 100 L13 101 Z" fill={WOOD} />
        <path d="M14 52 L32 38 L122 37 L104 51 Z" fill={WOOD_LIGHT} />
        <path d="M104 51 L122 37 L123 86 L105 100 Z" fill={WOOD_DARK} />
      </g>
      <g fill={INK} stroke="none">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <circle cx={40 + 11 * Math.cos((i / 7) * 6.283)} cy={76 + 11 * Math.sin((i / 7) * 6.283)} r="2" />
        ))}
        <circle cx="40" cy="76" r="2" />
      </g>
      {arcade(68, 76, 5.5, RED, 2.2)}
      {arcade(86, 76, 5.5, YELLOW, 2.2)}
      <path d="M112 6 C134 2 156 8 156 24 C156 38 140 44 126 42 L114 52 L117 40 C104 36 98 28 100 20 C102 12 106 8 112 6 Z" fill={PAPER} stroke={INK} stroke-width="2.6" />
      <text x="128" y="34" class="sketch-marker" fill={RED} stroke="none" font-size="26" text-anchor="middle">
        ?
      </text>
    </>
  );
}

/** The SD card with notes flying out of it. */
function katMusik() {
  return (
    <>
      <path d="M10 104 C50 100 110 104 150 100" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.5" />
      <g transform="rotate(-9 52 60)">{sdCard(26, 22, 54)}</g>
      <g fill="none" stroke="currentColor" stroke-width="3">
        <path d="M104 64 L104 30 L128 24 L128 56" />
        <path d="M104 30 L128 24" stroke-width="5" />
      </g>
      <g fill="currentColor" stroke="currentColor" stroke-width="2">
        <ellipse cx="98" cy="66" rx="7" ry="5.5" transform="rotate(-20 98 66)" />
        <ellipse cx="122" cy="58" rx="7" ry="5.5" transform="rotate(-20 122 58)" />
      </g>
      <g fill="none" stroke="currentColor" stroke-width="2.6">
        <path d="M140 80 L140 94" />
        <ellipse cx="135.5" cy="95" rx="5" ry="4" fill="currentColor" transform="rotate(-20 135.5 95)" />
        <path d="M140 80 C146 82 150 86 148 92" />
      </g>
    </>
  );
}

/** A card with a sticker, a second one behind it. */
function katKarten() {
  return (
    <>
      <path d="M10 104 C50 100 110 104 150 100" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.5" />
      <g transform="rotate(8 104 56)" stroke={INK}>
        <rect x="80" y="14" width="50" height="76" rx="6" fill={PAPER} stroke-width="2.6" />
        <rect x="86" y="20" width="38" height="38" rx="3" fill={YELLOW} stroke-width="2" />
        <circle cx="105" cy="39" r="10" fill={RED} stroke-width="2" />
      </g>
      <g transform="rotate(-10 62 58)" stroke={INK}>
        <rect x="36" y="16" width="52" height="80" rx="6" fill={PAPER} stroke-width="2.8" />
        <rect x="42" y="22" width="40" height="40" rx="3" fill="#12a89d" stroke-width="2" />
        <path d="M62 30 L66 39 L76 40 L68 46 L71 56 L62 50 L53 56 L56 46 L48 40 L58 39 Z" fill="#fdd459" stroke-width="1.8" />
        <text x="44" y="86" class="sketch-marker" fill={INK} stroke="none" font-size="17">
          07
        </text>
      </g>
    </>
  );
}

/** A soldering iron over a small board, a curl of smoke. */
function katWerkstatt() {
  return (
    <>
      <path d="M8 104 C50 100 110 104 152 100" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.5" />
      <g stroke={INK} stroke-width="2.6">
        <path d="M16 70 L112 68 L114 96 L17 98 Z" fill="#3d8b5a" />
        <rect x="30" y="76" width="22" height="12" rx="2" fill="#2a1f16" />
        <circle cx="70" cy="82" r="4.5" fill={METAL} />
        <circle cx="86" cy="82" r="4.5" fill={METAL} />
        <circle cx="102" cy="82" r="4.5" fill={METAL} />
      </g>
      <g stroke={INK} stroke-width="2.6">
        <path d="M150 12 L122 40 L114 34 L142 6 Z" fill={RED} />
        <path d="M122 40 L104 58 L98 52 L114 34 Z" fill={METAL} />
        <path d="M104 58 L88 76 L98 52 Z" fill="#8a8f96" />
      </g>
      <g fill="none" stroke="currentColor" stroke-width="2.2" opacity="0.7">
        <path d="M80 64 C72 56 84 50 76 42 C70 36 78 30 74 22" />
      </g>
    </>
  );
}

/** A laptop showing a little box, a padlock beside it for the privacy. */
function katApp() {
  return (
    <>
      <path d="M6 104 C50 100 110 104 154 100" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.5" />
      <g stroke={INK} stroke-width="2.8">
        <path d="M22 18 L112 16 L114 78 L21 80 Z" fill="#3a2a1d" />
        <path d="M28 24 L106 23 L108 72 L27 73 Z" fill={PAPER} stroke-width="2" />
        <path d="M8 80 L128 78 L136 94 L2 96 Z" fill="#8a8f96" />
      </g>
      <g stroke={INK} stroke-width="2">
        <path d="M46 46 L86 45 L87 66 L45 67 Z" fill={WOOD} />
        <path d="M46 46 L54 39 L94 38 L86 45 Z" fill={WOOD_LIGHT} />
        <circle cx="72" cy="56" r="3" fill={RED} />
        <circle cx="80" cy="56" r="3" fill={YELLOW} />
      </g>
      <g stroke={INK} stroke-width="2.6">
        <path d="M128 52 C128 38 150 38 150 52" fill="none" stroke-width="4" />
        <rect x="122" y="52" width="34" height="30" rx="4" fill={YELLOW} />
        <circle cx="139" cy="64" r="3.5" fill={INK} />
        <path d="M139 66 L139 74" />
      </g>
    </>
  );
}

/* ------------------------------------------------------------------ explaining pictures */

/**
 * A good and a cold solder joint side by side on a board: the good one
 * shiny and shaped like a little volcano around the pin, the cold one a
 * dull ball that does not flow onto the copper ring.
 */
function loetstelle() {
  return (
    <>
      {/* the board, seen from the side */}
      <path d="M14 150 L366 148 L367 176 L13 178 Z" fill="#3d8b5a" stroke={INK} stroke-width="3" />
      <g fill="none" stroke="#2a6b43" stroke-width="2" opacity="0.8">
        <path d="M30 166 C90 163 160 168 240 164 S330 166 352 163" />
      </g>

      {/* good: a cone that hugs the pin and covers the copper ring */}
      <path d="M96 62 L104 62 L104 150 L96 150 Z" fill="#b9b2a6" stroke={INK} stroke-width="2.6" />
      <path d="M60 149 C70 146 76 144 82 146 L118 146 C124 144 130 146 140 149 Z" fill="#d9a35b" stroke={INK} stroke-width="2.4" />
      <path d="M62 148 C80 144 92 126 96 86 L104 86 C108 126 120 144 138 148 Z" fill="#dfe3e8" stroke={INK} stroke-width="3" />
      <path d="M78 140 C88 132 93 116 95 98" fill="none" stroke="#ffffff" stroke-width="3.4" opacity="0.95" />
      <path d="M114 136 C110 128 108 118 107 106" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.7" />
      {tick(150, 76, 1.2)}

      {/* cold: a dull ball, the copper ring still showing, a dark gap under it */}
      <path d="M266 62 L274 62 L274 150 L266 150 Z" fill="#b9b2a6" stroke={INK} stroke-width="2.6" />
      <path d="M228 149 C238 146 244 144 250 146 L290 146 C296 144 302 146 312 149 Z" fill="#d9a35b" stroke={INK} stroke-width="2.4" />
      <path d="M244 136 C248 141 262 143 270 143 C280 143 292 141 296 136" fill="none" stroke={INK} stroke-width="3" />
      <circle cx="270" cy="112" r="27" fill="#9d9d94" stroke={INK} stroke-width="3" />
      <g fill="#7d7d74" stroke="none">
        <circle cx="258" cy="104" r="2.2" />
        <circle cx="281" cy="100" r="2" />
        <circle cx="266" cy="124" r="2.4" />
        <circle cx="284" cy="120" r="1.8" />
        <circle cx="252" cy="118" r="1.6" />
      </g>
      <path d="M286 92 L280 102 L288 108" fill="none" stroke={INK} stroke-width="2" />
      {cross(318, 64, 1.1)}

      {note(18, 26, 'gut: glänzt,')}
      {note(18, 48, 'wie ein Vulkan')}
      {note(362, 26, 'kalt: matt,', 19, 'end')}
      {note(362, 48, 'wie eine Kugel', 19, 'end')}
      {note(190, 204, 'kalt? Nachlöten, bis das Zinn fließt.', 18, 'middle')}
    </>
  );
}

/**
 * The open box from above: power, card reader, MP3 player with its SD card,
 * the little computer, speaker and buttons, joined by cables. With `stick`,
 * a wooden stick taps a cable while the box plays: the wobble test.
 */
function boxInside(stick: boolean) {
  const onFloor = (x: number, y: number, text: string, size = 15) => label(x, y, text, size, 'start', FLOOR);
  return (
    <>
      {/* the box: a wooden frame and its floor */}
      <path d="M10 12 L410 10 L412 250 L9 252 Z" fill={WOOD} stroke={INK} stroke-width="3.4" />
      <path d="M28 28 L392 27 L394 234 L27 235 Z" fill={FLOOR} stroke={INK} stroke-width="2.6" />
      <g fill="none" stroke="#8c6238" stroke-width="1.6" opacity="0.7">
        <path d="M14 18 C120 15 260 19 404 16" />
        <path d="M16 244 C140 240 280 246 404 242" />
      </g>

      {/* cables, under the parts */}
      <g fill="none" stroke-width="3.2">
        <path d="M110 70 C150 80 160 140 186 172" stroke={RED} />
        <path d="M110 80 C140 92 150 150 180 182" stroke={INK} />
        <path d="M232 108 C236 130 230 150 228 168" stroke={YELLOW} />
        <path d="M312 108 C306 140 290 160 272 172" stroke={BLUE} />
        <path d="M128 168 C150 180 160 188 176 188" stroke={INK} />
        <path d="M282 186 C300 196 312 196 326 200" stroke={GREEN} />
      </g>

      {/* power */}
      <path d="M42 46 L112 45 L113 92 L42 93 Z" fill="#59544f" stroke={INK} stroke-width="2.6" />
      <circle cx="56" cy="58" r="3" fill="#7fc97a" stroke={INK} stroke-width="1.4" />
      {onFloor(48, 112, 'Strom')}

      {/* card reader: a blue board with its antenna */}
      <path d="M186 40 L268 39 L269 106 L185 107 Z" fill={BLUE} stroke={INK} stroke-width="2.6" />
      <path d="M196 50 L258 49 L259 96 L195 97 Z" fill="none" stroke="#f0c76a" stroke-width="2.4" />
      <path d="M203 57 L251 56 L252 89 L202 90 Z" fill="none" stroke="#f0c76a" stroke-width="2" />
      {onFloor(186, 126, 'Kartenleser')}

      {/* MP3 player: a red board, the SD card sticking out of its slot */}
      <path d="M290 54 L352 53 L353 106 L289 107 Z" fill={RED} stroke={INK} stroke-width="2.6" />
      {sdCard(304, 34, 30, 2.2)}
      <path d="M298 54 L344 53 L344 70 L298 71 Z" fill={METAL} stroke={INK} stroke-width="2.2" />
      {onFloor(286, 126, 'MP3-Player')}
      {onFloor(286, 144, 'mit SD-Karte', 13)}

      {/* the little computer */}
      <path d="M176 166 L284 165 L285 200 L176 201 Z" fill="#2f6fb0" stroke={INK} stroke-width="2.6" />
      <rect x="214" y="174" width="30" height="18" rx="2" fill={INK} stroke="none" />
      {onFloor(180, 222, 'kleiner Rechner')}

      {/* speaker */}
      <circle cx="88" cy="168" r="44" fill="#3a2a1d" stroke={INK} stroke-width="3" />
      <circle cx="88" cy="168" r="30" fill="#57412f" stroke={INK} stroke-width="2" />
      <circle cx="88" cy="168" r="12" fill={INK} stroke={INK} stroke-width="2" />
      {onFloor(52, 228, 'Lautsprecher', 14)}

      {/* buttons */}
      {arcade(322, 190, 9, RED)}
      {arcade(350, 190, 9, YELLOW)}
      {arcade(378, 190, 9, BLUE)}
      {onFloor(326, 174, 'Tasten')}

      {stick ? (
        <>
          {/* a wooden stick from outside, its tip on the yellow cable */}
          <path d="M236 142 L404 286 L412 278 L244 136 Z" fill="#f0d29c" stroke={INK} stroke-width="2.6" />
          <path d="M244 140 L392 266" fill="none" stroke="#c9a06a" stroke-width="1.6" />
          <g fill="none" stroke={INK} stroke-width="2.6">
            <path d="M222 156 C216 150 216 142 222 136" />
            <path d="M212 162 C202 152 202 138 212 128" />
          </g>
          {note(16, 280, 'tipp, tipp … knackt’s?', 18)}
        </>
      ) : null}
    </>
  );
}

/** The folders on the SD card as the box needs them, and names it does not find, crossed out. */
function sdOrdner() {
  const folder = (x: number, y: number, name: string, fill = YELLOW) => (
    <g>
      <path d={`M${x} ${y} L${x + 14} ${y} L${x + 18} ${y + 5} L${x + 40} ${y + 5} L${x + 40} ${y + 28} L${x} ${y + 28} Z`} fill={fill} stroke={INK} stroke-width="2.4" />
      {note(x + 48, y + 22, name, 19)}
    </g>
  );
  const file = (x: number, y: number, name: string) => (
    <g>
      <path d={`M${x} ${y} L${x + 14} ${y} L${x + 20} ${y + 6} L${x + 20} ${y + 24} L${x} ${y + 24} Z`} fill={PAPER} stroke={INK} stroke-width="2.2" />
      {note(x + 28, y + 18, name, 17)}
    </g>
  );
  return (
    <>
      {sdCard(12, 12, 34)}
      <path d="M30 70 L30 216" fill="none" stroke="currentColor" stroke-width="2.4" />
      <g fill="none" stroke="currentColor" stroke-width="2.4">
        <path d="M30 82 L48 82" />
        <path d="M30 118 L48 118" />
        <path d="M30 154 L48 154" />
        <path d="M30 216 L48 216" />
      </g>
      {folder(50, 68, 'mp3')}
      {folder(50, 104, 'advert')}
      {folder(50, 140, '01')}
      <path d="M70 170 L70 186 L104 186" fill="none" stroke="currentColor" stroke-width="2" />
      {file(106, 174, '001.mp3')}
      {folder(50, 202, '02')}
      {tick(176, 108, 1)}
      {note(206, 98, 'so findet', 19)}
      {note(206, 120, 'die Box alles', 19)}

      <path d="M244 140 L244 228" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.4" />
      {file(258, 140, '1.mp3')}
      {file(258, 174, '01.mp3')}
      <g>
        <path d="M258 208 L272 208 L276 213 L298 213 L298 230 L258 230 Z" fill={YELLOW} stroke={INK} stroke-width="2.2" />
        {note(306, 226, '02 Bibi', 17)}
      </g>
      <g fill="none" stroke={RED} stroke-width="3.2">
        <path d="M282 156 L334 154" />
        <path d="M282 190 L344 188" />
        <path d="M302 222 L370 220" />
      </g>
      {cross(356, 140, 0.9)}
      {note(392, 30, 'Titel: 001.mp3,', 17, 'end')}
      {note(392, 52, '002.mp3 …', 17, 'end')}
    </>
  );
}

/** The lid of a box seen from above, the reader under it dashed: one card flat in the middle, one at the edge. */
function karteAuflegen() {
  return (
    <>
      <path d="M12 30 L262 28 L264 196 L11 198 Z" fill={WOOD_LIGHT} stroke={INK} stroke-width="3.2" />
      <g fill="none" stroke="#8c6238" stroke-width="1.6" opacity="0.7">
        <path d="M20 46 C90 42 170 48 254 44" />
        <path d="M22 182 C100 178 180 184 254 180" />
      </g>
      <path d="M86 70 L186 69 L187 160 L85 161 Z" fill="none" stroke={INK} stroke-width="2.4" stroke-dasharray="8 7" opacity="0.7" />
      {label(92, 176, 'hier liegt der Leser', 13, 'start', WOOD_LIGHT)}
      {/* the card, flat and in the middle */}
      <g transform="rotate(-4 136 114)" stroke={INK}>
        <rect x="104" y="66" width="62" height="94" rx="7" fill={PAPER} stroke-width="3" />
        <rect x="111" y="73" width="48" height="48" rx="3" fill="#12a89d" stroke-width="2.2" />
        <path d="M135 82 L140 93 L152 94 L143 101 L146 113 L135 106 L124 113 L127 101 L118 94 L130 93 Z" fill="#fdd459" stroke-width="1.8" />
      </g>
      {tick(196, 60, 1.1)}
      {/* a card at the edge, with a key in between */}
      <g transform="rotate(14 330 120)" stroke={INK}>
        <rect x="296" y="66" width="56" height="86" rx="7" fill={PAPER} stroke-width="3" />
        <rect x="302" y="72" width="44" height="44" rx="3" fill={YELLOW} stroke-width="2.2" />
      </g>
      <g stroke={INK} stroke-width="2.4">
        <circle cx="300" cy="170" r="10" fill={METAL} />
        <path d="M309 172 L346 176 L346 184 L338 184 L338 179 L330 179 L330 184 L322 183 L322 178 L309 177 Z" fill={METAL} />
      </g>
      {cross(346, 30, 0.9)}
      {note(286, 202, 'nicht am Rand', 17)}
      {note(16, 22, 'flach und mittig', 19)}
      {note(376, 22, 'kein Metall', 17, 'end')}
    </>
  );
}

/** Two SD adapters: the little switch up means it can be written, down means locked. */
function schreibschutz() {
  const adapter = (x: number, down: boolean) => (
    <g stroke={INK}>
      <path d={`M${x + 8} 30 L${x + 74} 30 L${x + 96} 52 L${x + 96} 168 C${x + 96} 173 ${x + 92} 176 ${x + 87} 176 L${x + 9} 176 C${x + 4} 176 ${x} 172 ${x} 167 L${x} 38 C${x} 33 ${x + 4} 30 ${x + 8} 30 Z`} fill="#45403b" stroke-width="3" />
      <g fill="#fdd459" stroke-width="1.8">
        {[0, 1, 2, 3, 4].map((i) => (
          <rect x={x + 14 + i * 14} y="36" width="8" height="20" rx="1.5" />
        ))}
      </g>
      <rect x={x + 16} y="84" width="66" height="72" rx="4" fill={PAPER} stroke-width="2.4" />
      {/* the slot of the switch on the left edge, the switch in it */}
      <rect x={x - 6} y="70" width="10" height="56" rx="2" fill="#2a1f16" stroke-width="2" />
      <rect x={x - 9} y={down ? 100 : 72} width="15" height="22" rx="3" fill={down ? RED : '#f2f2ee'} stroke-width="2.4" />
      {label(x + 49, 118, down ? 'LOCK' : 'frei', 17, 'middle')}
    </g>
  );
  return (
    <>
      {adapter(40, false)}
      {adapter(220, true)}
      {tick(150, 82, 1)}
      {cross(318, 64, 0.9)}
      <g fill="none" stroke="currentColor" stroke-width="2.6">
        <path d="M18 120 C14 104 16 92 24 80" />
        <path d="M16 86 L24 78 L30 88" />
      </g>
      {note(88, 196, 'oben: App darf schreiben', 16, 'middle')}
      {note(268, 196, 'unten: gesperrt', 16, 'middle')}
    </>
  );
}

/** The MP3 player in the box, the card pulled straight out of its slot, and a lever crossed out. */
function sdHerausnehmen() {
  return (
    <>
      <path d="M20 140 L180 138 L181 186 L19 188 Z" fill={RED} stroke={INK} stroke-width="3" />
      <path d="M50 120 L150 119 L151 150 L49 151 Z" fill={METAL} stroke={INK} stroke-width="2.6" />
      <path d="M62 151 L138 150" stroke={INK} stroke-width="4" fill="none" />
      <g transform="rotate(-1 100 70)">{sdCard(72, 30, 56)}</g>
      <g fill="none" stroke="currentColor" stroke-width="3">
        <path d="M150 96 L150 30" />
        <path d="M140 42 L150 28 L160 42" />
      </g>
      {tick(166, 88, 1)}
      {note(196, 50, 'gerade', 20)}
      {note(196, 74, 'herausziehen', 20)}
      {/* crossed-out lever */}
      <g fill="none" stroke="currentColor" stroke-width="2.6" opacity="0.8">
        <path d="M232 168 C252 140 280 128 312 128" />
        <path d="M300 120 L314 128 L302 138" />
      </g>
      {cross(258, 110, 0.9)}
      {note(228, 194, 'nicht hebeln', 18)}
    </>
  );
}

/** A screw head seen from above: a metal disc with its slot. */
function screw(x: number, y: number, r = 4.5) {
  return (
    <g stroke={INK}>
      <circle cx={x} cy={y} r={r} fill={METAL} stroke-width="1.8" />
      <path d={`M${x - r * 0.65} ${y + r * 0.3} L${x + r * 0.65} ${y - r * 0.3}`} stroke-width="1.6" fill="none" />
    </g>
  );
}

/** A round stamp with a step number, like the numbers of the help index. */
function stepStamp(x: number, y: number, n: string) {
  return (
    <g>
      <circle cx={x} cy={y} r="13" fill={YELLOW} stroke={INK} stroke-width="2.4" />
      <text x={x} y={y + 6} class="sketch-marker" fill={INK} stroke="none" font-size="17" text-anchor="middle">
        {n}
      </text>
    </g>
  );
}

/**
 * The way of the SD card: the box opened (the lid with its screws lifted
 * off) and the card pulled straight out of the MP3 player inside. No slot
 * on the box, the card sits inside. No card reader either (Frank: drawn,
 * it looked odd); where it goes next the text says.
 */
function wegDerKarte() {
  return (
    <>
      <path d="M8 222 C110 218 230 224 332 219" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.5" />

      {/* the box without its lid: front, side, and the dark inside with the MP3 player and its card */}
      <g stroke={INK} stroke-width="3">
        <path d="M24 134 L50 110 L204 108 L178 132 Z" fill="#5a4330" />
        <path d="M24 134 L178 132 L180 214 L23 216 Z" fill={WOOD} />
        <path d="M178 132 L204 108 L205 190 L180 214 Z" fill={WOOD_DARK} />
      </g>
      <path d="M78 128 L132 127 L146 116 L92 117 Z" fill={RED} stroke={INK} stroke-width="2.2" />
      {sdCard(104, 92, 20, 2)}
      <g fill={INK} stroke="none">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <circle cx={62 + 13 * Math.cos((i / 7) * 6.283)} cy={176 + 13 * Math.sin((i / 7) * 6.283)} r="2.3" />
        ))}
        <circle cx="62" cy="176" r="2.3" />
      </g>
      {arcade(110, 178, 6.5, RED, 2.2)}
      {arcade(132, 178, 7.5, YELLOW, 2.2)}
      {arcade(154, 178, 6.5, BLUE, 2.2)}

      {/* the lid, lifted off, with its four screws */}
      <g transform="rotate(-9 120 52)">
        <path d="M34 62 L178 60 L178 68 L34 70 Z" fill={WOOD} stroke={INK} stroke-width="2.6" />
        <path d="M34 62 L58 42 L202 40 L178 60 Z" fill={WOOD_LIGHT} stroke={INK} stroke-width="2.8" />
        {screw(50, 58)}
        {screw(172, 56)}
        {screw(68, 46)}
        {screw(190, 44)}
      </g>
      {stepStamp(22, 34, '1')}
      {note(42, 26, 'aufschrauben', 18)}

      {/* the card on its way: straight up and out */}
      <path d="M116 88 C130 50 200 20 262 40" fill="none" stroke="currentColor" stroke-width="2.2" stroke-dasharray="7 6" />
      <g transform="rotate(16 286 52)">{sdCard(274, 32, 26, 2.2)}</g>
      {stepStamp(244, 70, '2')}
      {note(232, 104, 'gerade raus', 18)}

    </>
  );
}

/** A phone from the back, a card held flat against it, the radio waves between them. */
function handyKarte() {
  return (
    <>
      {/* the phone, seen from the back */}
      <g transform="rotate(-7 140 120)" stroke={INK}>
        <rect x="80" y="10" width="124" height="214" rx="20" fill="#454a52" stroke-width="3" />
        <rect x="94" y="24" width="38" height="56" rx="11" fill="#2b2f35" stroke-width="2.2" />
        <circle cx="113" cy="40" r="8" fill="#14181d" stroke={METAL} stroke-width="2.4" />
        <circle cx="113" cy="64" r="8" fill="#14181d" stroke={METAL} stroke-width="2.4" />
      </g>
      {/* the card, flat on its back */}
      <g transform="rotate(5 150 128)" stroke={INK}>
        <rect x="104" y="84" width="92" height="128" rx="8" fill={PAPER} stroke-width="3" />
        <rect x="113" y="93" width="74" height="74" rx="4" fill={YELLOW} stroke-width="2.2" />
        <text x="115" y="200" class="sketch-marker" fill={INK} stroke="none" font-size="20">
          07
        </text>
      </g>
      <g fill="none" stroke="currentColor" stroke-width="2.8">
        <path d="M214 112 C222 122 222 138 214 148" />
        <path d="M226 102 C240 118 240 142 226 158" />
        <path d="M238 92 C258 114 258 146 238 168" />
        <path d="M84 116 C76 126 76 142 84 152" />
        <path d="M72 106 C58 122 58 146 72 162" />
      </g>
      {tick(258, 40, 1)}
      {note(290, 34, 'flach an die', 19)}
      {note(290, 58, 'Rückseite', 19)}
      {note(268, 196, 'kurz hin und her,', 17)}
      {note(268, 218, 'bis es klappt', 17)}
    </>
  );
}

/**
 * The front of a box with its three arcade buttons, all three pressed and
 * held at once: the box opens its admin menu and starts to speak.
 */
function adminTasten() {
  return (
    <>
      <path d="M8 218 C120 214 280 219 392 215" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.5" />
      <g stroke={INK} stroke-width="3.2">
        <path d="M22 96 L306 94 L308 210 L20 212 Z" fill={WOOD} />
        <path d="M22 96 L52 70 L336 68 L306 94 Z" fill={WOOD_LIGHT} />
        <path d="M306 94 L336 68 L338 184 L308 210 Z" fill={WOOD_DARK} />
      </g>
      <g fill="none" stroke="#8c6238" stroke-width="1.6" opacity="0.7">
        <path d="M30 108 C110 104 200 110 298 106" />
        <path d="M60 82 C150 79 240 84 320 79" />
      </g>
      <g fill={INK} stroke="none">{[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => <circle cx={76 + 26 * Math.cos((i / 10) * 6.283)} cy={154 + 26 * Math.sin((i / 10) * 6.283)} r="2.6" />)}
        {[0, 1, 2, 3, 4].map((i) => <circle cx={76 + 13 * Math.cos((i / 5) * 6.283)} cy={154 + 13 * Math.sin((i / 5) * 6.283)} r="2.6" />)}
        <circle cx="76" cy="154" r="2.6" />
      </g>
      {arcade(170, 156, 13, RED)}
      {arcade(218, 156, 15, YELLOW)}
      {arcade(266, 156, 13, BLUE)}

      {/* three thick arrows: Zurück, Play/Pause and Vor at the same time, and hold */}
      <g fill="none" stroke="currentColor" stroke-width="4.2">
        <path d="M170 38 L170 128" />
        <path d="M160 116 L170 130 L180 116" />
        <path d="M218 30 L218 124" />
        <path d="M208 112 L218 126 L228 112" />
        <path d="M266 38 L266 128" />
        <path d="M256 116 L266 130 L276 116" />
      </g>
      <path d="M156 24 C180 14 256 14 280 24" fill="none" stroke="currentColor" stroke-width="2.4" />
      {note(218, 12, 'diese drei zugleich', 18, 'middle')}

      {/* the box starts to speak */}
      <g fill="none" stroke="currentColor" stroke-width="2.6">
        <path d="M110 148 C116 140 116 132 110 124" />
        <path d="M120 156 C130 142 130 126 120 112" />
      </g>
      <path d="M352 104 C346 96 346 88 352 80" fill="none" stroke="currentColor" stroke-width="2.6" />
      <path d="M364 112 C354 98 354 82 364 70" fill="none" stroke="currentColor" stroke-width="2.6" />
      {note(14, 36, 'lang halten,', 17)}
      {note(14, 58, 'bis die Box spricht', 17)}
    </>
  );
}

/**
 * The Arduino Nano from above, USB at the top, with its pins as printed on
 * it (src/features/workshop/loetplan.ts, NANO_LINKS and NANO_RECHTS), and
 * the first eight pins of the MP3 player (DFP_OBEN). Marked are the places
 * Box testen names: D9 to D13 for the card reader, A0 to A2 for the three
 * buttons, D2 and D3 for the MP3 player, D3 through the 1 kΩ resistor.
 */
const NANO_LEFT = ['D13', '3V3', 'AREF', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', '5V', 'RST', 'GND', 'VIN'];
const NANO_RIGHT = ['D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'GND', 'RST', 'RX0', 'TX1'];
const MP3_PINS = ['VCC', 'RX', 'TX', 'DAC_R', 'DAC_L', 'SPK1', 'GND', 'SPK2'];

function nanoPins() {
  const y = (i: number) => 70 + i * 16;
  const print = (x: number, yy: number, text: string, anchor: 'start' | 'end', on: boolean) => (
    <text x={x} y={yy + 4.5} fill={on ? '#fff3b0' : PAPER} stroke="none" font-size="12.5" font-weight={on ? 700 : 400} text-anchor={anchor} class="help-art-print">
      {text}
    </text>
  );
  const marked = (name: string) => ['D13', 'D12', 'D11', 'D10', 'D9', 'A0', 'A1', 'A2', 'D2', 'D3'].includes(name);
  return (
    <>
      {/* the Nano: a blue board, the USB socket at the top */}
      <path d="M110 44 L232 43 L233 320 L109 321 Z" fill="#2f6fb0" stroke={INK} stroke-width="3" />
      <rect x="150" y="26" width="42" height="28" rx="3" fill={METAL} stroke={INK} stroke-width="2.4" />
      {NANO_LEFT.map((n, i) => (
        <g>
          <circle cx="124" cy={y(i)} r="4.6" fill="#e9c35b" stroke={INK} stroke-width="1.6" />
          {print(134, y(i), n, 'start', marked(n))}
        </g>
      ))}
      {NANO_RIGHT.map((n, i) => (
        <g>
          <circle cx="218" cy={y(i)} r="4.6" fill="#e9c35b" stroke={INK} stroke-width="1.6" />
          {print(208, y(i), n, 'end', marked(n))}
        </g>
      ))}

      {/* brackets and notes beside the marked pins */}
      <g fill="none" stroke="currentColor" stroke-width="2.4">
        <path d="M100 62 C94 64 94 76 100 78" />
        <path d="M100 110 C92 112 92 148 100 150" />
        <path d="M242 62 C250 64 250 124 242 126" />
      </g>
      {note(88, 76, 'Kartenleser', 16, 'end')}
      {note(88, 136, 'Tasten', 18, 'end')}
      {note(256, 92, 'Kartenleser', 16)}
      {note(256, 112, 'D9 bis D13', 15)}

      {/* the MP3 player, its first row of pins, pin 1 square */}
      <path d="M372 148 L484 146 L486 330 L371 331 Z" fill={RED} stroke={INK} stroke-width="3" />
      {MP3_PINS.map((n, i) => (
        <g>
          {i === 0 ? (
            <rect x="380" y={166 + i * 20} width="11" height="11" fill="#e9c35b" stroke={INK} stroke-width="1.6" />
          ) : (
            <circle cx="385.5" cy={171.5 + i * 20} r="5" fill="#e9c35b" stroke={INK} stroke-width="1.6" />
          )}
          {print(397, 171.5 + i * 20, n, 'start', n === 'RX' || n === 'TX')}
        </g>
      ))}
      {note(368, 178, '1', 15, 'end')}
      {note(428, 138, 'MP3-Player', 16, 'middle')}

      {/* D3 through the resistor to RX, D2 to TX */}
      <g fill="none" stroke-width="3">
        <path d="M218 214 C270 214 300 192 380 191.5" stroke={YELLOW} />
        <path d="M218 230 C280 232 312 212 380 211.5" stroke={GREEN} />
      </g>
      <rect x="282" y="194" width="26" height="12" rx="3" fill="#d9c7a3" stroke={INK} stroke-width="1.8" transform="rotate(-24 295 200)" />
      {note(264, 186, '1 kΩ', 15)}
      {note(246, 262, 'D3 an RX,', 16)}
      {note(246, 282, 'D2 an TX', 16)}
    </>
  );
}

/**
 * A sheet of HERMA 5028 (templates.ts: 2 × 5 labels on A4), one label
 * peeled off and on its way onto a card. The labels carry only their folder
 * number and a scribbled title: no cover is drawn.
 */
function stickerbogen() {
  const labelAt = (x: number, y: number, num: string, gone = false) =>
    gone ? (
      <rect x={x} y={y} width="68" height="41" rx="4" fill="#efe6d2" stroke={INK} stroke-width="1.6" stroke-dasharray="5 4" />
    ) : (
      <g>
        <rect x={x} y={y} width="68" height="41" rx="4" fill="#fdfaf2" stroke={INK} stroke-width="1.8" />
        <text x={x + 6} y={y + 18} class="sketch-marker" fill={INK} stroke="none" font-size="14">
          {num}
        </text>
        <path d={`M${x + 30} ${y + 13} L${x + 60} ${y + 12} M${x + 8} ${y + 30} L${x + 52} ${y + 29}`} fill="none" stroke="#8a7a66" stroke-width="2.2" />
      </g>
    );
  const cols = [44, 116];
  const rows = [34, 75, 116, 157, 198];
  return (
    <>
      <g transform="rotate(-3 115 136)">
        <path d="M30 16 L200 15 L201 256 L29 257 Z" fill={PAPER} stroke={INK} stroke-width="2.6" />
        {rows.map((y, r) => cols.map((x, c) => labelAt(x, y, String(r * 2 + c + 1).padStart(2, '0'), r === 1 && c === 1)))}
      </g>
      {/* the peeled label, on its way */}
      <path d="M182 92 C214 70 236 66 258 70" fill="none" stroke="currentColor" stroke-width="2.2" stroke-dasharray="6 5" />
      <g transform="rotate(7 314 74)">
        <rect x="258" y="46" width="112" height="68" rx="5" fill="#fdfaf2" stroke={INK} stroke-width="2.4" />
        <text x="267" y="74" class="sketch-marker" fill={INK} stroke="none" font-size="22">
          04
        </text>
        <path d="M310 64 L358 63 M268 94 L346 92" fill="none" stroke="#8a7a66" stroke-width="3" />
        <path d="M370 96 C360 100 356 108 358 114 L370 114 Z" fill="#efe6d2" stroke={INK} stroke-width="2" />
      </g>
      <g fill="none" stroke="currentColor" stroke-width="2.8">
        <path d="M318 128 L318 152" />
        <path d="M309 142 L318 154 L327 142" />
      </g>
      {/* the card it goes on: a little bigger than the label */}
      <rect x="252" y="162" width="130" height="82" rx="8" fill={PAPER} stroke={INK} stroke-width="3" />
      <rect x="256" y="166" width="122" height="74" rx="5" fill="none" stroke={INK} stroke-width="1.4" stroke-dasharray="4 4" opacity="0.6" />
      {note(392, 22, 'HERMA 5028', 17, 'end')}
      {note(392, 42, 'mit 10 Stickern', 17, 'end')}
      {note(318, 270, 'passt auf die Karte', 17, 'middle')}
    </>
  );
}

/**
 * Three ways stickers land off their labels (sticker audit 16.10.2026, item
 * 6): the whole print moved, printed too small (the middle fits, the edges do
 * not), and fed crooked (worse towards the bottom). Each a small sheet with
 * its die-cut labels dashed and the print as coloured fields.
 */
function daneben() {
  const W = 44;
  const H = 25;
  const cols = [8, 58];
  const rows = [12, 41, 70, 99, 128];
  const fills = [BLUE, YELLOW, GREEN, RED, PURPLE];
  const sheet = (x0: number, print: (x: number, y: number) => { x: number; y: number; w: number; h: number }, tilt = 0) => (
    <g>
      <rect x={x0} y={14} width="110" height="166" rx="2" fill={PAPER} stroke={INK} stroke-width="2.4" />
      <g transform={tilt ? `rotate(${tilt} ${x0 + 8} ${14 + 12})` : undefined}>
        {rows.map((y, r) =>
          cols.map((x, c) => {
            const p = print(x0 + x, 14 + y);
            return <rect key={`${r}-${c}`} x={p.x} y={p.y} width={p.w} height={p.h} rx="2" fill={fills[(r + c) % fills.length]} stroke="none" opacity="0.8" />;
          }),
        )}
      </g>
      {rows.map((y, r) =>
        cols.map((x, c) => <rect key={`d${r}-${c}`} x={x0 + x} y={14 + y} width={W} height={H} rx="2.5" fill="none" stroke={INK} stroke-width="1.4" stroke-dasharray="4 3" />),
      )}
    </g>
  );
  // Too small: scaled to 90 % about the middle of the sheet.
  const small = (cx: number, cy: number) => (x: number, y: number) => ({ x: cx + (x - cx) * 0.9, y: cy + (y - cy) * 0.9, w: W * 0.9, h: H * 0.9 });
  return (
    <>
      {sheet(12, (x, y) => ({ x: x + 4, y: y + 3, w: W, h: H }))}
      {sheet(155, small(155 + 55, 14 + 83))}
      {sheet(298, (x, y) => ({ x, y, w: W, h: H }), 3)}
      {note(67, 206, 'verschoben', 18, 'middle')}
      {note(210, 206, 'zu klein', 18, 'middle')}
      {note(353, 206, 'schief', 18, 'middle')}
      {note(67, 228, 'ausrichten', 15, 'middle')}
      {note(210, 228, '100 % einstellen', 15, 'middle')}
      {note(353, 228, 'Papier, Rand', 15, 'middle')}
    </>
  );
}

/** What a card holds: only the folder number and how it plays; the titles stay in the folder on the SD card. */
function karteOrdner() {
  const file = (x: number, y: number, name: string) => (
    <g>
      <path d={`M${x} ${y} L${x + 13} ${y} L${x + 19} ${y + 6} L${x + 19} ${y + 23} L${x} ${y + 23} Z`} fill={PAPER} stroke={INK} stroke-width="2" />
      {note(x + 27, y + 17, name, 16)}
    </g>
  );
  return (
    <>
      {/* the card, as if you could see inside: the copper loop, the chip, and what it remembers */}
      <g transform="rotate(-5 84 110)">
        <rect x="30" y="28" width="108" height="164" rx="9" fill={PAPER} stroke={INK} stroke-width="3" />
        <rect x="42" y="40" width="84" height="140" rx="7" fill="none" stroke="#c98c50" stroke-width="2.2" stroke-dasharray="6 3" />
        <rect x="76" y="150" width="16" height="14" rx="2" fill={INK} stroke="none" />
        {label(50, 84, 'Ordner', 17)}
        <text x="52" y="122" class="sketch-marker" fill={INK} stroke="none" font-size="34">
          07
        </text>
        {label(50, 142, 'Hörbuch', 15)}
      </g>
      <g fill="none" stroke="currentColor" stroke-width="3">
        <path d="M150 96 C172 84 194 84 214 92" />
        <path d="M204 82 L216 93 L202 100" />
      </g>
      {sdCard(222, 14, 26, 2.2)}
      <path d="M236 58 L236 186" fill="none" stroke="currentColor" stroke-width="2.2" />
      <path d="M236 74 L250 74" fill="none" stroke="currentColor" stroke-width="2.2" />
      <path d="M252 62 L266 62 L270 67 L294 67 L294 88 L252 88 Z" fill={YELLOW} stroke={INK} stroke-width="2.4" />
      {note(302, 84, '07', 20)}
      <g fill="none" stroke="currentColor" stroke-width="2">
        <path d="M262 92 L262 196" />
        <path d="M262 112 L274 112 M262 140 L274 140 M262 168 L274 168 M262 196 L274 196" />
      </g>
      {file(276, 100, '001.mp3')}
      {file(276, 128, '002.mp3')}
      {file(276, 156, '003.mp3')}
      {file(276, 184, '004.mp3')}
      {tick(380, 190, 0.8)}
      {note(414, 176, 'neu', 16, 'end')}
      {note(14, 232, 'Die Karte merkt sich nur die Nummer.', 17)}
    </>
  );
}
