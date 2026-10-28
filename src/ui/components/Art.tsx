/**
 * The pictures of the app, drawn by hand: ink lines that wobble a little
 * (the filter from SketchDefs), flat colours of wood, paper and the forum
 * stickers, handwritten notes. Objects keep their black-brown outline in
 * both themes; notes and arrows written next to them take the theme's ink
 * (currentColor).
 */

/**
 * An SD card, alone and a little tilted. No card reader under it: drawn,
 * the reader at the computer looked odd (Frank), and the words next to the
 * picture say where the card goes.
 */
export function SdCardArt({ size = 160 }: { size?: number }) {
  return <HolzSdCard size={size} />;
}

/**
 * Meine Box without a card: the box, big, as in 0.3. No card reader beside
 * it (Frank: it looked odd), and no notes for buttons and speaker, which
 * everyone knows (Frank). One note says the SD card is inside; the speech
 * bubble under the button says where it goes.
 */
export function WelcomeBoxArt() {
  return <HolzBoxSlot />;
}

const B_INK = '#2a1f16';

/** A round arcade button seen from the front: the bezel ring, the cap and a light lip. */
function arcade(cx: number, cy: number, r: number, color: string, sw = 3) {
  return (
    <g stroke={B_INK}>
      <circle cx={cx} cy={cy} r={r + r * 0.32} fill="#3a2a1d" stroke-width={sw} />
      <circle cx={cx} cy={cy} r={r} fill={color} stroke-width={sw * 0.75} />
      <path d={`M${cx - r * 0.55} ${cy - r * 0.35} C${cx - r * 0.4} ${cy - r * 0.62} ${cx - r * 0.1} ${cy - r * 0.72} ${cx + r * 0.15} ${cy - r * 0.68}`} fill="none" stroke="#fffcf5" stroke-width={sw * 0.8} opacity="0.85" />
    </g>
  );
}

/** Holes drilled in a circle, like the speaker grille of a home-made box. */
function drilledHoles(cx: number, cy: number, rings: [radius: number, count: number][], r: number) {
  const out = [<circle cx={cx} cy={cy} r={r} />];
  for (const [radius, count] of rings) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + radius * 0.07;
      out.push(<circle cx={(cx + radius * Math.cos(a)).toFixed(1)} cy={(cy + radius * Math.sin(a)).toFixed(1)} r={r} />);
    }
  }
  return out;
}

/**
 * The purple SD card with a little box drawn on its label, upright, its
 * bottom edge at 0 0 and 76 wide. `k` thickens the lines for a card drawn
 * smaller, so its outline matches the rest of the picture.
 */
function sdCard(k = 1) {
  return (
    <g transform="translate(-83 -136)">
      <path d="M52 17 L103 18 L121 36 L120 129 C120 133 117 136 113 136 L53 135 C48 135 45 132 45 128 L45 25 C45 20 48 17 52 17 Z" fill="#9c5d98" stroke-width={3.5 * k} />
      <g fill="#fdd459" stroke-width={2 * k}>
        <rect x="55" y="23" width="8" height="18" rx="1.5" />
        <rect x="68" y="23" width="8" height="18" rx="1.5" />
        <rect x="81" y="23" width="8" height="18" rx="1.5" />
        <rect x="94" y="23" width="8" height="18" rx="1.5" />
      </g>
      <rect x="54" y="60" width="57" height="64" rx="4" fill="#fffcf5" stroke-width={3 * k} />
      <path d="M64 82 L101 81 L102 110 L63 111 Z" fill="#c98c50" stroke-width={2.6 * k} />
      <circle cx="76" cy="96" r="7" fill="none" stroke-width={2.4 * k} />
      <circle cx="76" cy="96" r="1.8" fill={B_INK} stroke="none" />
      <circle cx="92" cy="88" r="2.6" fill="#e5483b" stroke-width={1.6 * k} />
      <circle cx="92" cy="96" r="2.6" fill="#f6c12c" stroke-width={1.6 * k} />
      <circle cx="92" cy="104" r="2.6" fill="#3f8fd6" stroke-width={1.6 * k} />
      <path d="M70 73 L82 70 L84 79 L72 81 Z" fill="#fffcf5" stroke-width={2 * k} />
    </g>
  );
}

/** Holz: the SD card, tilted, on a pencil line for the table. */
function HolzSdCard({ size = 160 }: { size?: number }) {
  return (
    <svg class="sketch-art" width={size} height={size} viewBox="0 0 160 160" aria-hidden="true">
      <g filter="url(#ts-wobble-art)" stroke={B_INK} stroke-linejoin="round" stroke-linecap="round">
        <path d="M30 148 C60 144 100 146 132 143" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.5" />
        <g transform="rotate(-8 80 80) translate(83 136)">{sdCard()}</g>
      </g>
    </svg>
  );
}

/**
 * The box of the start page, drawn by hand without a filter: the lines are
 * crooked in the drawing itself, so nothing is worked out while the page
 * shows. Front, top and side of a plywood box, the drilled speaker, three
 * arcade buttons, a card with a sticker coming down. The box has no slot for
 * the SD card: on nearly every TonUINO it sits inside on the MP3 module, and
 * you open the box to take it out (Frank).
 */
function HolzBoxSlot() {
  return (
    <svg class="sketch-art welcome-box-art" viewBox="0 0 480 322" aria-hidden="true">
      <g stroke-linejoin="round" stroke-linecap="round">
        {/* table */}
        <path d="M14 305 C118 300 262 307 470 300" fill="none" stroke="currentColor" stroke-width="3" />
        <path d="M30 312 C90 310 140 313 190 311" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.45" />

        {/* the box: front, top, side, each edge a little off */}
        <g stroke={B_INK} stroke-width="3.6">
          <path d="M70 173.5 L277 169.5 L280.5 299 L68.5 301.5 Z" fill="#c98c50" />
          <path d="M70.5 173 L121 131.5 L326 129 L277.5 170 Z" fill="#ddb07a" />
          <path d="M277 170 L326.5 129.5 L330 257 L280.5 299 Z" fill="#a8723e" />
        </g>
        <path d="M66 175 L72 171 M324 127 L329 132" fill="none" stroke={B_INK} stroke-width="2.4" />
        {/* wood grain */}
        <g fill="none" stroke="#8c6238" stroke-width="1.8" opacity="0.75">
          <path d="M80 185 C120 181 160 189 200 184 S250 187 268 183" />
          <path d="M150 292 C180 288 220 294 270 289" />
          <path d="M110 153 C150 149 200 155 250 150 S290 151 306 147" />
          <path d="M140 142 C180 139 230 145 300 140" />
          <path d="M292 182 C296 196 293 208 296 222" />
          <ellipse cx="228" cy="276" rx="9" ry="4" />
        </g>
        {/* drilled speaker */}
        <g fill={B_INK} stroke="none">{drilledHoles(128, 237, [[13, 7], [25, 13], [37, 19]], 3)}</g>
        {/* three arcade buttons, the middle one plays */}
        {arcade(199, 239, 9.5, '#e5483b')}
        {arcade(229, 239, 11, '#f6c12c')}
        {arcade(259, 239, 9.5, '#3f8fd6')}

        {/* the card with its sticker, coming down */}
        <g transform="translate(204 66) rotate(-11)">
          <rect x="-33" y="-50" width="66" height="100" rx="7" fill="#fffcf5" stroke={B_INK} stroke-width="3.5" />
          <rect x="-26" y="-43" width="52" height="52" rx="3" fill="#12a89d" stroke={B_INK} stroke-width="2.5" />
          <path d="M-2 -32 L4 -20 L17 -19 L7 -10 L10 3 L-2 -4 L-14 3 L-11 -10 L-21 -19 L-8 -20 Z" fill="#fdd459" stroke={B_INK} stroke-width="2.2" />
          <text x="-24" y="38" class="sketch-marker" fill={B_INK} stroke="none" font-size="22">
            07
          </text>
          <path d="M12 23c2.6 3 2.6 7 0 10 M18 20c4 4.5 4 11.5 0 16" fill="none" stroke={B_INK} stroke-width="2.2" opacity="0.6" />
        </g>
        <g fill="none" stroke="currentColor" stroke-width="2.6">
          <path d="M158 92 C154 104 154 112 158 122" />
          <path d="M250 84 C256 96 256 106 252 118" />
        </g>

        {/* notes in pencil: the card with its sticker, and where the SD card is (inside, no slot) */}
        <g fill="none" stroke="currentColor" stroke-width="2.4">
          <path d="M84 62 C112 60 134 64 156 76" />
          <path d="M147 68 L157 77 L144 81" />
        </g>
        <g class="sketch-hand" fill="currentColor" stroke="none" font-size="23">
          <text x="20" y="34">Karte mit</text>
          <text x="34" y="58">Sticker</text>
        </g>
        {/* A mouse can follow it to the help; the keyboard and screen readers have the same link in the text under the button. */}
        <a href="#/hilfe/sd-karte-herausnehmen" tabIndex={-1} class="welcome-box-link">
          <g fill="none" stroke="currentColor" stroke-width="2.4">
            <path d="M346 244 C336 258 318 256 300 238" />
            <path d="M301 251 L299 237 L312 239" />
            <path d="M352 236 C378 233 412 236 446 232" stroke-width="1.8" opacity="0.7" />
          </g>
          <g class="sketch-hand" fill="currentColor" stroke="none" font-size="22">
            <text x="340" y="200">Da drin steckt</text>
            <text x="352" y="226">die SD-Karte</text>
          </g>
        </a>

        {/* the box tells a story */}
        <path d="M352 22 C394 14 462 20 468 48 C474 76 434 88 396 86 L368 110 L374 84 C338 80 320 68 324 48 C327 32 338 25 352 22 Z" fill="#fffcf5" stroke={B_INK} stroke-width="3" />
        <text x="335" y="58" class="sketch-hand" fill={B_INK} stroke="none" font-size="15.5">
          Es war einmal …
        </text>
      </g>
    </svg>
  );
}

/**
 * The box with a card dropping in, beside the field for the music
 * (06-entwuerfe, „Musik auf die SD-Karte“): the one drawing of that screen.
 * The card carries a star, not a folder number, as in 0.5.
 */
export function KisteArt({ width = 300 }: { width?: number }) {
  return (
    <svg width={width} viewBox="40 20 310 295" aria-hidden="true" class="kiste-art">
      <g stroke-linejoin="round" stroke-linecap="round">
        <path d="M44 305 C118 300 262 307 340 300" fill="none" stroke={B_INK} stroke-width="3" opacity="0.6" />
        <g stroke={B_INK} stroke-width="3.6">
          <path d="M70 173.5 L277 169.5 L280.5 299 L68.5 301.5 Z" fill="#c98c50" />
          <path d="M70.5 173 L121 131.5 L326 129 L277.5 170 Z" fill="#ddb07a" />
          <path d="M277 170 L326.5 129.5 L330 257 L280.5 299 Z" fill="#a8723e" />
        </g>
        <g fill="none" stroke="#8c6238" stroke-width="1.8" opacity="0.75">
          <path d="M80 185 C120 181 160 189 200 184 S250 187 268 183" />
          <path d="M150 292 C180 288 220 294 270 289" />
          <path d="M110 153 C150 149 200 155 250 150 S290 151 306 147" />
          <path d="M292 182 C296 196 293 208 296 222" />
        </g>
        <g fill={B_INK}>{drilledHoles(128, 237, [[13, 7], [25, 13], [37, 19]], 3)}</g>
        {arcade(199, 239, 9.5, '#e5483b', 3)}
        {arcade(229, 239, 11, '#f6c12c', 3)}
        {arcade(259, 239, 9.5, '#3f8fd6', 3)}
        <g transform="translate(204 70) rotate(-11)">
          <rect x="-33" y="-50" width="66" height="100" rx="7" fill="#fffcf5" stroke={B_INK} stroke-width="3.5" />
          <rect x="-26" y="-43" width="52" height="52" rx="3" fill="#12a89d" stroke={B_INK} stroke-width="2.5" />
          <path d="M-2 -32 L4 -20 L17 -19 L7 -10 L10 3 L-2 -4 L-14 3 L-11 -10 L-21 -19 L-8 -20 Z" fill="#fdd459" stroke={B_INK} stroke-width="2.2" />
          <path d="M12 23c2.6 3 2.6 7 0 10 M18 20c4 4.5 4 11.5 0 16" fill="none" stroke={B_INK} stroke-width="2.2" opacity="0.6" />
        </g>
        <g fill="none" stroke={B_INK} stroke-width="2.6">
          <path d="M158 96 C154 108 154 116 158 126" />
          <path d="M250 88 C256 100 256 110 252 122" />
        </g>
      </g>
    </svg>
  );
}
