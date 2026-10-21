/**
 * The symbols on the arcade buttons of the menu, the tab bar of a phone
 * and the narrow menu of a tablet. The scribbled icons of 0.4 turned into
 * specks at menu size (Frank could not tell what the "Karten beschreiben"
 * one was), so the menu shows what 0.3 had and he liked: a round coloured
 * button cap for every page, as on the front of a box, with one plain, bold
 * symbol on it. The lines still wobble a little,
 * drawn by hand, but each symbol is a single idea that reads at 16 px.
 * Fixed paths: nothing is worked out while the app runs.
 */
import type { ComponentChildren } from 'preact';
import type { Icon, IconProps } from './index';

function glyph(name: string, body: ComponentChildren, width = 2.6): Icon {
  const Glyph = ({ size = 24, strokeWidth: _w, color, plain: _p, class: cls, ...rest }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      stroke-width={width}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...rest}
      class={cls ? `cap-glyph cg-${name} ${String(cls)}` : `cap-glyph cg-${name}`}
    >
      {body}
    </svg>
  );
  Glyph.displayName = name;
  return Glyph;
}

/** Meine Box: the front of a box, the speaker in the middle and three buttons under it, as on the logo. */
export const CapBox = glyph(
  'box',
  <>
    <path d="M3.2 5.6 L20.8 5.2 L21 19.2 L3 19.5 Z" stroke-width="2.5" />
    <circle cx="12" cy="10.6" r="2.7" stroke-width="2.3" />
    <circle cx="7.6" cy="15.6" r="1.45" fill="currentColor" stroke="none" />
    <circle cx="12" cy="15.6" r="1.45" fill="currentColor" stroke="none" />
    <circle cx="16.4" cy="15.5" r="1.45" fill="currentColor" stroke="none" />
  </>,
);

/** Hinzufügen: a plus. */
export const CapPlus = glyph(
  'plus',
  <>
    <path d="M12.1 4.6 C12 9 12.2 15 11.9 19.4" />
    <path d="M4.6 12.2 C9 11.9 15 12.1 19.4 11.8" />
  </>,
  3.2,
);

/** Entdecken: a compass. */
export const CapKompass = glyph(
  'kompass',
  <>
    <path d="M12.2 3.3 C17.4 3.2 20.8 6.9 20.7 12.1 C20.6 17.2 17 20.8 11.8 20.7 C6.8 20.6 3.3 17 3.3 11.9 C3.4 6.9 7 3.4 12.2 3.3 Z" stroke-width="2.3" />
    <path d="M15.6 8.3 L13.4 13.4 L8.4 15.6 L10.6 10.5 Z" fill="currentColor" stroke-width="1.6" />
  </>,
);

/** Sticker drucken: a printer with a sheet coming out. */
export const CapDrucker = glyph(
  'drucker',
  <>
    <path d="M7.1 9.2 L7.2 4.1 L16.9 4.3 L16.8 9.2" stroke-width="2.3" />
    <path d="M6.6 17.3 L3.9 17.2 L4.1 9.4 L20 9.2 L20.1 17.1 L17.4 17.2" />
    <path d="M7.1 13.9 L16.9 13.8 L17 20.4 L7 20.5 Z" stroke-width="2.3" />
  </>,
);

/** Karten beschreiben: a card with a sticker, the waves of the reader beside it. */
export const CapKarte = glyph(
  'karte',
  <>
    <path d="M4.4 4.9 L13.6 4.5 L14 19.5 L4.8 19.8 Z" stroke-width="2.4" />
    <path d="M6.9 7.4 L11.4 7.3 L11.5 11.9 L7 12 Z" fill="currentColor" stroke-width="1.4" />
    <path d="M16.7 9.3 C18 10.8 18 13.4 16.7 14.9" stroke-width="2.3" />
    <path d="M19.4 7 C21.9 9.8 21.9 14.4 19.4 17.2" stroke-width="2.3" />
  </>,
);

/**
 * Werkstatt: a spanner. A soldering iron was tried first; at menu size it
 * read as a pen, the spanner reads at once. The iron hangs on the Werkstatt
 * page itself, where it is big enough to be one.
 */
export const CapSchluessel = glyph(
  'schluessel',
  <>
    <path d="M12.6 11.4 L4.4 19.6" stroke-width="4.2" />
    <path d="M20.9 5.5 L21.4 7.4 L21.1 9.4 L20 11.1 L18.4 12.2 L16.5 12.6 L14.5 12.2 L12.9 11.1 L11.8 9.5 L11.4 7.5 L11.8 5.6 L12.9 4 L14.6 2.9 L16.6 2.6 L18.5 3.1 L17 4.5 L19.5 7 Z" fill="currentColor" stroke-width="1.4" />
  </>,
);

/** Hilfe: a question mark. */
export const CapFrage = glyph(
  'frage',
  <>
    <path d="M8.4 8.9 C8.2 5.7 10.6 4.3 12.5 4.4 C14.9 4.5 16.4 6.4 15.8 8.7 C15.2 10.9 12.3 11.4 12.1 14.4" stroke-width="3" />
    <circle cx="12.1" cy="18.9" r="1.8" fill="currentColor" stroke="none" />
  </>,
);

/** Einstellungen: a cog. */
export const CapZahnrad = glyph(
  'zahnrad',
  <>
    <path d="M18.8 9.7 L21.4 10.1 L21.4 13.9 L18.8 14.3 L18.5 15.2 L20 17.3 L17.3 20 L15.2 18.5 L14.3 18.8 L13.9 21.4 L10.1 21.4 L9.7 18.8 L8.8 18.5 L6.7 20 L4 17.3 L5.5 15.2 L5.2 14.3 L2.6 13.9 L2.6 10.1 L5.2 9.7 L5.5 8.8 L4 6.7 L6.7 4 L8.8 5.5 L9.7 5.2 L10.1 2.6 L13.9 2.6 L14.3 5.2 L15.2 5.5 L17.3 4 L20 6.7 L18.5 8.8 Z" stroke-width="2.3" />
    <circle cx="12" cy="12" r="2.9" stroke-width="2.4" />
  </>,
);

/** Mehr: three dots. */
export const CapMehr = glyph(
  'mehr',
  <>
    <circle cx="5.4" cy="12.3" r="2.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="11.9" r="2.1" fill="currentColor" stroke="none" />
    <circle cx="18.6" cy="12.2" r="2.1" fill="currentColor" stroke="none" />
  </>,
);

/** Hinzufügen, the big button of the drop field (as in 0.3): an arrow going up out of a tray. */
export const CapHoch = glyph(
  'hoch',
  <>
    <path d="M12.1 15 C12 11.4 12.2 8 12 4.2" stroke-width="3" />
    <path d="M7.6 8.4 L12 3.9 L16.5 8.5" stroke-width="3" />
    <path d="M4 13.6 L4.2 19.6 L19.9 19.4 L20 13.4" stroke-width="2.6" />
  </>,
);

/** A list: three lines with a dot each (the Spotify list). */
export const CapListe = glyph(
  'liste',
  <>
    <circle cx="5.4" cy="7" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="5.4" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="5.4" cy="17" r="1.6" fill="currentColor" stroke="none" />
    <path d="M9.6 7.1 L19.2 6.8 M9.6 12.1 L19 12 M9.6 17 L17.2 17.2" />
  </>,
);

/** Selbst aufnehmen: a microphone on its stand. */
export const CapMikro = glyph(
  'mikro',
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" stroke-width="2.4" />
    <path d="M5.8 11.2 C5.9 18.2 18.1 18.2 18.2 11.2" stroke-width="2.2" />
    <path d="M12 17.4 L12 20.8 M8.6 21 L15.4 20.8" stroke-width="2.4" />
  </>,
);

/** Aufnahme beenden: a square, filled in with the pen, as on a tape recorder. */
export const CapStopp = glyph(
  'stopp',
  <path d="M7.2 7.4 L16.9 7 L17.1 16.8 L7 17.1 Z" fill="currentColor" stroke-width="2.2" />,
);

/** Aussehen: a circle, half light and half dark. */
export const CapHellDunkel = glyph(
  'hell-dunkel',
  <>
    <path d="M12 3.6 C16.8 3.5 20.5 7.2 20.4 12.1 C20.3 16.8 16.7 20.5 11.9 20.4 C7.2 20.3 3.6 16.7 3.6 12 C3.7 7.2 7.2 3.7 12 3.6 Z" stroke-width="2.3" />
    <path d="M12 3.8 C16.6 3.9 20.2 7.4 20.2 12 C20.2 16.6 16.6 20.2 12 20.2 Z" fill="currentColor" stroke="none" />
  </>,
);

/** The SD card, with its cut corner and contacts. */
export const CapSd = glyph(
  'sd',
  <>
    <path d="M6.6 3.4 L15.4 3.3 L18.7 6.7 L18.8 20.6 L5.4 20.7 L5.4 4.7 Z" stroke-width="2.4" />
    <path d="M9 5.4 L9 8.6 M12 5.4 L12 8.6 M15 6.4 L15 8.6" stroke-width="2" />
  </>,
);

/** Zusatzfunktionen: a piece of a jigsaw. */
export const CapPuzzle = glyph(
  'puzzle',
  <>
    <path d="M4.6 8.2 L8.8 8.2 C8.4 4.6 13.8 4.6 13.3 8.2 L17.4 8.1 L17.5 11.9 C21 11.4 21 16.8 17.5 16.3 L17.6 20.3 L4.5 20.4 Z" stroke-width="2.3" />
  </>,
);

/** Firmware: a chip with its legs. */
export const CapChip = glyph(
  'chip',
  <>
    <path d="M7.2 7.1 L16.9 6.9 L17.1 16.9 L7 17.1 Z" stroke-width="2.5" />
    <path d="M9.6 3.4 L9.6 6.6 M14.4 3.4 L14.4 6.6 M9.6 17.4 L9.6 20.6 M14.4 17.4 L14.4 20.6 M3.4 9.6 L6.6 9.6 M3.4 14.4 L6.6 14.4 M17.4 9.6 L20.6 9.6 M17.4 14.4 L20.6 14.4" stroke-width="2.2" />
    <circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none" />
  </>,
);

/** Box einstellen: two sliders. */
export const CapRegler = glyph(
  'regler',
  <>
    <path d="M3.8 8.1 L20.2 7.8 M3.8 16.1 L20.2 16.3" stroke-width="2.2" />
    <path d="M8.6 5.1 L8.7 11" stroke-width="4.2" />
    <path d="M15.4 13.2 L15.3 19.1" stroke-width="4.2" />
  </>,
);

/** Box testen: a tick, as on a list of things that work. */
export const CapHaken = glyph(
  'haken',
  <path d="M4.6 12.8 C6.4 14.2 8.2 16.2 9.6 18.6 C12.4 12.6 15.6 8.4 19.8 5" stroke-width="3.4" />,
);

/** Box-Logbuch: a notebook with a spiral and lines. */
export const CapHeft = glyph(
  'heft',
  <>
    <path d="M6.2 3.6 L18.8 3.4 L19 20.5 L6.1 20.6 Z" stroke-width="2.4" />
    <path d="M3.6 7.4 L7.6 7.4 M3.6 12 L7.6 12 M3.6 16.6 L7.6 16.6" stroke-width="2.2" />
    <path d="M10.4 8.2 L16 8 M10.4 12.1 L16 12.2 M10.4 16 L14 16" stroke-width="2" />
  </>,
);

/** Lötplan: a wire with a bend and a plug at each end. */
export const CapKabel = glyph(
  'kabel',
  <>
    <path d="M5.4 7 C5.6 12.6 9.4 13.4 12 12.2 C14.8 10.8 18.4 11.6 18.6 17" stroke-width="2.4" />
    <path d="M3.4 3.2 L7.4 3.2 L7.2 7.4 L3.6 7.4 Z" fill="currentColor" stroke-width="1.6" />
    <path d="M16.6 16.8 L20.6 16.8 L20.4 21 L16.8 21 Z" fill="currentColor" stroke-width="1.6" />
  </>,
);

/** Systemansagen: a speaker with its sound. */
export const CapLautsprecher = glyph(
  'lautsprecher',
  <>
    <path d="M3.6 9.2 L7.4 9.1 L12.2 4.8 L12.4 19.2 L7.4 14.9 L3.7 14.8 Z" fill="currentColor" stroke-width="1.8" />
    <path d="M15.6 9 C16.8 10.6 16.8 13.4 15.6 15" stroke-width="2.3" />
    <path d="M18.4 6.4 C20.9 9.4 20.9 14.6 18.4 17.6" stroke-width="2.3" />
  </>,
);

/** Bedienkarte: a sheet with a folded corner and lines on it. */
export const CapZettel = glyph(
  'zettel',
  <>
    <path d="M5.4 3.4 L14.6 3.3 L18.8 7.6 L18.9 20.6 L5.3 20.7 Z" stroke-width="2.4" />
    <path d="M14.4 3.6 L14.5 7.8 L18.6 7.7" stroke-width="2" />
    <path d="M8.4 11.4 L15.6 11.3 M8.4 15.4 L14.2 15.5" stroke-width="2" />
  </>,
);

/** Paket: a parcel with tape across it. */
export const CapPaket = glyph(
  'paket',
  <>
    <path d="M3.6 7.6 L20.4 7.3 L20.2 20.3 L3.8 20.5 Z" stroke-width="2.4" />
    <path d="M3.6 7.6 L6.4 3.6 L17.8 3.4 L20.4 7.3" stroke-width="2.2" />
    <path d="M12 3.6 L12.1 20.4" stroke-width="3" />
  </>,
);

/** Mit dem Handy: a phone, its button at the bottom. */
export const CapHandy = glyph(
  'handy',
  <>
    <path d="M7.4 3.2 L16.8 3.1 L16.9 20.8 L7.2 20.9 Z" stroke-width="2.5" />
    <circle cx="12" cy="17.6" r="1.4" fill="currentColor" stroke="none" />
    <path d="M10.4 5.8 L13.6 5.8" stroke-width="2" />
  </>,
);

/** Mit dem Kartenleser: a flat reader, a card held over it, the waves between. */
export const CapLeser = glyph(
  'leser',
  <>
    <path d="M3.2 15.8 L20.8 15.6 L20.6 20.6 L3.4 20.7 Z" stroke-width="2.4" />
    <path d="M7.6 3.4 L16.4 3.3 L16.5 9.4 L7.5 9.5 Z" fill="currentColor" stroke-width="1.8" />
    <path d="M9.2 12.6 C11 11.6 13 11.6 14.8 12.6" stroke-width="2.2" />
  </>,
);

/** Über WLAN: the three arcs and the dot. */
export const CapWlan = glyph(
  'wlan',
  <>
    <path d="M3.4 9.4 C8.4 4.6 15.6 4.6 20.6 9.4" stroke-width="2.6" />
    <path d="M6.6 12.8 C9.8 9.9 14.2 9.9 17.4 12.8" stroke-width="2.6" />
    <path d="M9.6 16.1 C11.1 14.9 12.9 14.9 14.4 16.1" stroke-width="2.6" />
    <circle cx="12" cy="19.4" r="1.7" fill="currentColor" stroke="none" />
  </>,
);

/** The colours of the buttons on a box. White is for a cap that is always lit and stands on its own (the Paket tag in the Werkstatt), never in the menu. */
export type CapColor = 'rot' | 'gelb' | 'gruen' | 'blau' | 'weiss';

/** A round button cap with a symbol on it, coloured like the buttons on a box front. */
export function ArcadeCap({ icon: G, color, size = 30 }: { icon: Icon; color: CapColor; size?: number }) {
  return (
    <span class={`arcade-cap cap-${color}`} style={{ width: size, height: size }} aria-hidden="true">
      <G size={Math.round(size * 0.72)} />
    </span>
  );
}
