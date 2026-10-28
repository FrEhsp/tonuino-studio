/**
 * Lötplan: what goes where on a TonUINO Classic v1.7, for "Lötplan" in the
 * Werkstatt (LoetplanTool.tsx, drawing in LoetplanSketch.tsx).
 *
 * Ported from the stand-alone "Lötbild" page of the build assistant
 * (bauassistent/loetbild/index.html): the geometry, the wires with their
 * colours and sources, the steps and the warnings are the same, only typed.
 * Pin names are the print on the board v1.7, the pins of the buttons come
 * from TonUINO TNG (src/constants.hpp, table in tngPins.ts).
 *
 * Every wire names its proofs (loetplanBelege.ts); a wire without a proof,
 * or with only an "ungeprüft" one, is never drawn (tests/workshop/
 * loetplan-belege.test.ts). The other boards (Classic without board, AiO,
 * AiO+) and the extras are plain wiring pictures, see loetplanVerdrahtung.ts.
 */
import { signal } from '@preact/signals';
import type { BelegId } from './loetplanBelege';
import type { TngFunktion, TngPlatine } from './tngPins';

/** Which board: the Classic v1.7 board, the Classic wired by hand, the AiO, the AiO+. */
export type Platine = 'classic' | 'frei' | 'aio' | 'aioplus';
export const PLATINEN: readonly Platine[] = ['classic', 'frei', 'aio', 'aioplus'];
export const PLATINEN_NAMEN: Record<Platine, string> = {
  classic: 'Classic-Platine v1.7',
  frei: 'Classic ohne Platine',
  aio: 'All-in-One (AiO)',
  aioplus: 'All-in-One Plus (AiO+)',
};

export type Tasten = 3 | 5;
/** Headphone socket: the small headphone board, a single socket, or none. */
export type Kopfhoerer = 'platine' | 'buchse' | 'keine';
/** From above (parts side) or from below (solder side, mirrored). */
export type Ansicht = 'oben' | 'unten';

/** Which Arduino sits on the Classic (with or without board): the Nano or the Nano Every. Same pins (TNG constants.hpp:549). */
export type Arduino = 'nano' | 'every';

/**
 * The extras, each with its own picture or, where nothing is proven well
 * enough to draw, an explanation (loetplanVerdrahtung.ts extras()).
 */
export const EXTRAS = ['drehgeber', 'poti', 'ring', 'ledtasten', 'schalter', 'pololu', 'dauerled', 'akku', 'lsaus', 'hperkennung', 'wecker', 'akkumessung', 'usbc'] as const;
export type ExtraId = (typeof EXTRAS)[number];

export interface LoetplanWahl {
  platine: Platine;
  tasten: Tasten;
  kh: Kopfhoerer;
  ansicht: Ansicht;
  nano: Arduino;
  /** The extras chosen under "Extras", in the order of EXTRAS. */
  extras: ExtraId[];
  /** Extra „Ein/Aus-Schalter“: how many legs the switch has; unset until answered. */
  schalter?: SchalterPins;
}

/** Legs of an on/off switch: 2 (on/off), 3 (a changeover switch), 4 (often with a light). */
export type SchalterPins = 2 | 3 | 4;

/** 0 = the whole picture, 1–5 = one step lit, the rest faded. */
export type Schritt = 0 | 1 | 2 | 3 | 4 | 5;

export const DEFAULT_WAHL: LoetplanWahl = { platine: 'classic', tasten: 3, kh: 'platine', ansicht: 'oben', nano: 'nano', extras: [] };

export interface Pt {
  x: number;
  y: number;
}

/* ------------------------------------------------- geometry of the Classic v1.7 */

/*
 * Every hole sits where the 3D data of the board puts it
 * (bauassistent/classic-3d/TU_CLASSIC_V1.7_20210617.step, board 67.31 ×
 * 30.48 mm, read 13.10.2026): u along the long side from the end with the
 * Nano's USB socket, v across from the edge with the card-reader row. The
 * drawing works in pixels of the photo it was first traced on; one
 * millimetre is MM pixels both ways, so the board is to scale.
 */
const MM = 27.71;
/** The board in photo pixels, seen from above. */
export const B = { x0: 1200 - 30.48 * MM, y0: 50, x1: 1200, y1: 50 + 67.31 * MM };
/** A point of the board in millimetres (u along, v across) to photo pixels. */
export function mm(u: number, v: number): Pt {
  return { x: B.x1 - v * MM, y: B.y0 + u * MM };
}
/** Photo pixels to drawing: scale, offset, size of the drawing. */
const K = 0.42;
const OX = 322;
const OY = 130;
export const W = 1000;
export const H = 1070;
const RASTER = 2.54;

/** The sockets of the Nano: 2 × 15 holes, v 7.41 (right) and 22.66 (left), u from 5.53. */
export function nano(i: number, re: boolean | number): Pt {
  return mm(5.53 + i * RASTER, re ? 7.41 : 22.66);
}
export const LINKS_INNEN = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'GND', 'GND', 'D8', 'D7', 'D6', 'D5', 'GND'] as const;
/** The left row of 15 holes (v 26.55, u from 8.05). */
export function linksInnen(i: number): Pt {
  return mm(8.05 + i * RASTER, 26.55);
}
/** The ground column beside A0 to A5 (6 holes, v 29.09, u from 8.03). */
export function linksGnd(i: number): Pt {
  return mm(8.03 + i * RASTER, 29.09);
}
export const RFID = ['3V3', 'RST', 'GND', 'IRQ', 'SO', 'SI', 'SCK', 'SDA'] as const;
/** The card-reader row of 8 holes (v 2.56, u from 8.04). */
export function rfid(i: number): Pt {
  return mm(8.04 + i * RASTER, 2.56);
}
export const AUDIO = ['5V', 'GND', 'GND', 'R', 'L', '+', '−'] as const;
/** The audio row of 7 holes (v 2.64, u from 44.07). */
export function audio(i: number): Pt {
  return mm(44.07 + i * RASTER, 2.64);
}
/** The two rows of 8 holes of the MP3 player (u 46.91 and 64.68, v from 6.12). */
export function dfp(i: number, unten: boolean | number): Pt {
  return mm(unten ? 64.68 : 46.91, 6.12 + i * RASTER);
}
/** The 5 mounting holes (radius 1.55 mm). */
export const LOECHER: readonly Pt[] = [mm(2.53, 2.54), mm(2.53, 27.94), mm(64.76, 2.54), mm(64.76, 27.94), mm(55.7, 25.08)];
export const LOCH_R = 1.55 * MM * K;

/** The small resistor R7 (1 kΩ on the line to the MP3 player), already on the board (from the photo). */
export const R7: Pt = { x: 1075, y: 1115 };

/**
 * The pins of the Nano's sockets, from the USB end: the right column (v 7.41,
 * beside the card-reader row) D12 … D2, GND, RST, RX0, TX1, the left column
 * D13, 3V3, AREF, A0 … A7, 5V, RST, GND, VIN. This is the pin-out of the
 * Nano (bauassistent geprueft/classic.json, "physische_anordnung":
 * wahrscheinlich), so Box testen says "nach dem Aufdruck am Nano" next to it.
 */
export const NANO_RECHTS = ['D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'GND', 'RST', 'RX0', 'TX1'] as const;
export const NANO_LINKS = ['D13', '3V3', 'AREF', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', '5V', 'RST', 'GND', 'VIN'] as const;
/**
 * The 8 pins of the MP3 player's row next to the print „1“ (square pad), from
 * that pad: DFPlayer Mini manual, pins 1–8. The other row holds 9–16, pin 16
 * (BUSY) across from pin 1.
 */
export const DFP_OBEN = ['VCC', 'RX', 'TX', 'DAC_R', 'DAC_L', 'SPK1', 'GND', 'SPK2'] as const;

/**
 * Where a solder joint of Box testen (boxbefund.ts StelleId) sits on the
 * Classic v1.7, in photo pixels; undefined when the board has no such joint.
 */
export function stellePunkt(id: string): Pt | undefined {
  const [ort, pin] = id.split(':');
  const at = (list: readonly string[]) => list.indexOf(pin);
  switch (ort) {
    case 'leiste': {
      const i = at(LINKS_INNEN);
      return i < 0 ? undefined : linksInnen(i);
    }
    case 'gnd': {
      const i = Number(pin);
      return Number.isInteger(i) && i >= 0 && i < 6 ? linksGnd(i) : undefined;
    }
    case 'rfid': {
      const i = at(RFID);
      return i < 0 ? undefined : rfid(i);
    }
    case 'audio': {
      const i = at(AUDIO);
      return i < 0 ? undefined : audio(i);
    }
    case 'nano': {
      const r = at(NANO_RECHTS);
      if (r >= 0) return nano(r, true);
      const l = at(NANO_LINKS);
      return l < 0 ? undefined : nano(l, false);
    }
    case 'dfp': {
      if (pin === 'BUSY') return dfp(0, true);
      const i = at(DFP_OBEN);
      return i < 0 ? undefined : dfp(i, false);
    }
    default:
      return undefined;
  }
}

/** Photo pixel to drawing; from below everything is mirrored left to right. */
export function toSvg(p: Pt, ansicht: Ansicht): Pt {
  const x = ansicht === 'unten' ? B.x1 - p.x : p.x - B.x0;
  return { x: OX + x * K, y: OY + (p.y - B.y0) * K };
}

/** Which side of the drawing a point of the board is on. */
export function seite(px: number, ansicht: Ansicht): 'L' | 'R' {
  let links = px < (B.x0 + B.x1) / 2;
  if (ansicht === 'unten') links = !links;
  return links ? 'L' : 'R';
}

/* ------------------------------------------------- wires and parts per choice */

/** Wire colours: red 5 V, black ground, orange 3.3 V, otherwise one colour per wire. */
export const F = {
  gnd: '#1b1b1b',
  v33: '#f08a00',
  rst: '#e8e8e8',
  so: '#2f9e44',
  si: '#1f6fd1',
  sck: '#f2c500',
  sda: '#9b3fc8',
  play: '#d62828',
  vor: '#2f9e44',
  zur: '#f2c500',
  laut: '#1f6fd1',
  leis: '#e8e8e8',
  r: '#e64980',
  l: '#12b5b0',
  plus: '#d62828',
  minus: '#1b1b1b',
  v5: '#d62828',
  usb: '#6b6b6b',
  /** Data lines of the MP3 player: D4 to BUSY, D2 to TX, D3 to RX. */
  busy: '#8d5524',
  tx: '#74c0fc',
  rx: '#ffb000',
  /** IRQ of the card reader on the AiO, the same brown as BUSY. */
  irq: '#8d5524',
  /** The other leg of Play/Pause where it does not go to ground (AiO PBN, Pololu A). */
  pbn: '#7a1f1f',
} as const;

/** The names of the colours, for the wire list. */
export const FARBNAMEN: Record<string, string> = {
  [F.gnd]: 'schwarz',
  [F.v33]: 'orange',
  [F.rst]: 'weiß',
  [F.so]: 'grün',
  [F.si]: 'blau',
  [F.sck]: 'gelb',
  [F.sda]: 'lila',
  [F.play]: 'rot',
  [F.r]: 'pink',
  [F.l]: 'türkis',
  [F.usb]: 'grau',
  [F.busy]: 'braun',
  [F.tx]: 'hellblau',
  [F.rx]: 'dunkelgelb',
  [F.pbn]: 'dunkelrot',
};

export type Gruppe = 'rfid' | 'taste' | 'kh' | 'ls' | 'strom';

/** One line of the wire list, for every board. */
export interface ListenKabel {
  /** null: the pin stays free. */
  farbe: string | null;
  text: string;
  /** Where it comes from (loetplanBelege.ts); the weakest proof sets the level. */
  belege: BelegId[];
  /**
   * The pin of the microcontroller this wire ends at, as TNG names it: the
   * tests check it against the pin table (tngPins.ts) and that `text` names
   * the pin.
   */
  tng?: { platine: TngPlatine; funktion: TngFunktion; pin: string };
}

export interface Kabel extends ListenKabel {
  schritt: Schritt;
  gruppe: Gruppe;
  /** Button index, for the buttons. */
  taste?: number;
  /** 0: to the A pin, 1: to the ground next to it. */
  beinchen?: 0 | 1;
  von: { p?: Pt; teil?: string; txt: string };
  nach: { teil: string; pin?: number; txt?: string };
  frei?: boolean;
}

export interface Teil {
  id: string;
  seite: 'L' | 'R';
  name?: string;
  farbe?: string;
  pinY?: number;
  typ?: 'platine' | 'buchse';
}

export interface Aufbau {
  kabel: Kabel[];
  teile: Teil[];
  /** Pin, name, colour of each button, in the order of the drawing. */
  tasten: [string, string, string][];
}

export function aufbau(w: LoetplanWahl): Aufbau {
  const kabel: Kabel[] = [];
  const teile: Teil[] = [];
  // Card reader RC522: 1:1 by the print, IRQ stays free.
  const rfFarben = [F.v33, F.rst, F.gnd, null, F.so, F.si, F.sck, F.sda];
  const rcName = ['3.3V', 'RST', 'GND', 'IRQ', 'MISO', 'MOSI', 'SCK', 'SDA'];
  RFID.forEach((n, i) => {
    const belege: BelegId[] = n === 'IRQ' ? ['cl-v15'] : n === 'SO' || n === 'SI' ? ['v17-foto-rfid', 'v17-so-si'] : ['v17-foto-rfid'];
    kabel.push({
      schritt: 2,
      gruppe: 'rfid',
      von: { p: rfid(i), txt: n },
      nach: { teil: 'rc522', pin: i, txt: rcName[i] },
      farbe: rfFarben[i],
      frei: !rfFarben[i],
      text: n === 'IRQ' ? 'IRQ bleibt frei' : `Platine ${n} → Kartenleser ${rcName[i]}`,
      belege,
    });
  });
  teile.push({ id: 'rc522', seite: seite(1150, w.ansicht) });
  // Buttons
  const tasten = tastenDerClassic(w.tasten);
  tasten.forEach((t, i) => {
    const idx = LINKS_INNEN.indexOf(t[0] as (typeof LINKS_INNEN)[number]);
    kabel.push({
      schritt: 3,
      gruppe: 'taste',
      taste: i,
      beinchen: 0,
      von: { p: linksInnen(idx), txt: t[0] },
      nach: { teil: `taste${i}`, txt: 'Beinchen' },
      farbe: t[2],
      text: `Platine ${t[0]} → Taste „${t[1]}“`,
      belege: ['v17-foto-links', t[3]],
      tng: { platine: 'classic', funktion: t[4], pin: t[0] },
    });
    kabel.push({
      schritt: 3,
      gruppe: 'taste',
      taste: i,
      beinchen: 1,
      von: { p: linksGnd(idx), txt: 'GND' },
      nach: { teil: `taste${i}`, txt: 'Beinchen' },
      farbe: F.gnd,
      text: `Platine GND (daneben) → andere Seite der Taste „${t[1]}“`,
      belege: ['v17-foto-links', 'cl-v19'],
    });
    teile.push({
      id: `taste${i}`,
      name: t[1],
      farbe: t[2],
      pinY: linksInnen(idx).y,
      seite: seite(440, w.ansicht),
    });
  });
  // Sound
  if (w.kh === 'platine') {
    const khPins = ['G', 'DR', 'DL', 'SK', 'SK'];
    const khF = [F.gnd, F.r, F.l, F.plus, F.minus];
    for (let i = 0; i < 5; i++) {
      kabel.push({
        schritt: 4,
        gruppe: 'kh',
        von: { p: audio(i + 2), txt: AUDIO[i + 2] },
        nach: { teil: 'kh', pin: i, txt: khPins[i] },
        farbe: khF[i],
        text: `Platine ${AUDIO[i + 2]} → Kopfhörerplatine ${khPins[i]}`,
        belege: ['v17-foto-audio', 'oas-v10'],
      });
    }
    kabel.push({
      schritt: 4,
      gruppe: 'ls',
      von: { teil: 'kh', txt: 'Speaker' },
      nach: { teil: 'ls' },
      farbe: F.plus,
      text: 'Kopfhörerplatine „Speaker“ → Lautsprecher (2 Kabel)',
      belege: ['oas-v14'],
    });
    teile.push({ id: 'kh', typ: 'platine', seite: seite(1150, w.ansicht) });
  } else if (w.kh === 'buchse') {
    const bPins = ['1', '4', '3', '5'];
    const bF = [F.gnd, F.r, F.l, F.plus];
    const bWas = ['Masse', 'rechts', 'links', 'Schalter'];
    const bBeleg: BelegId[] = ['oas-v64', 'oas-v63', 'oas-v62', 'oas-v60'];
    for (let i = 0; i < 4; i++) {
      kabel.push({
        schritt: 4,
        gruppe: 'kh',
        von: { p: audio(i + 2), txt: AUDIO[i + 2] },
        nach: { teil: 'kh', pin: i, txt: bPins[i] },
        farbe: bF[i],
        text: `Platine ${AUDIO[i + 2]} → Buchse Pin ${bPins[i]} (${bWas[i]})`,
        belege: ['v17-foto-audio', bBeleg[i]],
      });
    }
    kabel.push({
      schritt: 4,
      gruppe: 'ls',
      von: { teil: 'kh', txt: '7' },
      nach: { teil: 'ls', pin: 1 },
      farbe: F.plus,
      text: 'Buchse Pin 7 → Lautsprecher',
      belege: ['oas-v61'],
    });
    kabel.push({
      schritt: 4,
      gruppe: 'ls',
      von: { p: audio(6), txt: '−' },
      nach: { teil: 'ls', pin: 0, txt: '−' },
      farbe: F.minus,
      text: 'Platine − → Lautsprecher (andere Seite)',
      belege: ['v17-foto-audio', 'oas-v03'],
    });
    teile.push({ id: 'kh', typ: 'buchse', seite: seite(1150, w.ansicht) });
  } else {
    kabel.push({
      schritt: 4,
      gruppe: 'ls',
      von: { p: audio(5), txt: '+' },
      nach: { teil: 'ls', pin: 0, txt: '+' },
      farbe: F.plus,
      text: 'Platine + → Lautsprecher',
      belege: ['v17-foto-audio', 'oas-v03'],
    });
    kabel.push({
      schritt: 4,
      gruppe: 'ls',
      von: { p: audio(6), txt: '−' },
      nach: { teil: 'ls', pin: 1, txt: '−' },
      farbe: F.minus,
      text: 'Platine − → Lautsprecher',
      belege: ['v17-foto-audio', 'oas-v03'],
    });
  }
  teile.push({ id: 'ls', seite: seite(1150, w.ansicht) });
  // Power: a USB cable into the Nano.
  kabel.push({
    schritt: 5,
    gruppe: 'strom',
    von: { teil: 'strom', txt: 'USB' },
    nach: { teil: 'nano', txt: 'USB-Buchse' },
    farbe: F.usb,
    text: 'USB-Kabel: Netzteil oder Powerbank → USB-Buchse am Nano',
    belege: ['usb'],
  });
  teile.push({ id: 'strom', seite: 'R' });
  return { kabel, teile, tasten: tasten.map(([pin, name, farbe]) => [pin, name, farbe]) };
}

/** Pin, name, colour, proof and TNG function of the buttons of the Classic and the Nano Every (TNG constants.hpp:549–567). */
export function tastenDerClassic(n: Tasten): [string, string, string, BelegId, TngFunktion][] {
  return n === 5
    ? [
        ['A0', 'Play/Pause', F.play, 'cl-v16', 'pause'],
        ['A1', 'Lauter', F.laut, 'cl-v20a', 'four5'],
        ['A2', 'Leiser', F.leis, 'cl-v20b', 'five5'],
        ['A3', 'Vor', F.vor, 'cl-v20c', 'up5'],
        ['A4', 'Zurück', F.zur, 'cl-v20d', 'down5'],
      ]
    : [
        ['A0', 'Play/Pause', F.play, 'cl-v16', 'pause'],
        ['A1', 'Vor / lauter', F.vor, 'cl-v17', 'up3'],
        ['A2', 'Zurück / leiser', F.zur, 'cl-v18', 'down3'],
      ];
}

/* ------------------------------------------------- steps and what they say */

export interface SchrittText {
  /** Short name on its button. */
  t: string;
  h: string;
  li: string[];
}

export const SCHRITTE: readonly SchrittText[] = [
  {
    t: 'Alles',
    h: 'Das ganze Bild',
    li: ['Erst die Buchsenleisten einlöten (Schritt 1), dann Kabel (Schritt 2 bis 4).', 'Zum Schluss Nano und MP3-Player einstecken (Schritt 5).'],
  },
  {
    t: '1 Buchsenleisten',
    h: 'Schritt 1: Buchsenleisten einlöten',
    li: [
      '2 lange Buchsenleisten (15 Löcher) für den Arduino Nano.',
      '2 kurze Buchsenleisten (8 Löcher) für den MP3-Player (DFPlayer).',
      'Leisten von oben einstecken, von unten löten. Erst ein Beinchen löten, gerade richten, dann den Rest.',
      'Die kleinen Bauteile R1 bis R8 sind schon drauf. Nicht anfassen.',
      'Darunter ist R7: der Widerstand mit 1 kΩ für die Leitung zum MP3-Player. Den musst du nicht selbst einlöten.',
    ],
  },
  {
    t: '2 Kartenleser',
    h: 'Schritt 2: Kartenleser (RC522)',
    li: [
      '7 Kabel, jedes geht zum gleichnamigen Anschluss am Kartenleser. SO heißt am Leser MISO, SI heißt MOSI.',
      'SO und SI vor dem Löten nachsehen: Mit dem Durchgangsprüfer (Multimeter, piept bei Verbindung) muss SO zum Beinchen D12 des Nano piepen und SI zu D11.',
      'Immer nach dem Aufdruck am Leser verbinden, nicht nach der Lage. Je nachdem, wie herum der Leser liegt, ist die Reihenfolge umgedreht, und manche Leser sind anders sortiert.',
      'IRQ bleibt frei.',
      'Orange ist 3,3 Volt: Der Kartenleser darf nie an 5 Volt.',
    ],
  },
  {
    t: '3 Tasten',
    h: 'Schritt 3: Tasten',
    li: ['Jede Taste hat zwei Beinchen. Ein Kabel zum A-Anschluss, das andere (schwarz) zum GND direkt daneben.', 'Bei Tasten ist egal, welches Beinchen wohin.'],
  },
  { t: '4 Ton', h: 'Schritt 4: Lautsprecher und Kopfhörer', li: [] },
  {
    t: '5 Einstecken',
    h: 'Schritt 5: Einstecken und Strom',
    li: [
      'Arduino Nano einstecken: USB-Buchse zeigt nach oben zum Rand (siehe Umriss).',
      'MP3-Player einstecken: SD-Karten-Schlitz zeigt zur Seite mit „SD Card“.',
      'SD-Karte rein, USB-Kabel mit Netzteil oder Powerbank in den Nano (graues Kabel im Bild). Fertig.',
      'Am Computer reicht der Strom bei großer Lautstärke oft nicht. Besser ein Handy-Netzteil mit 5 Volt.',
    ],
  },
];

/** What speaker fits (shop page of the Classic board, shop.voss.earth). */
const LAUTSPRECHER = 'Lautsprecher: ein passiver mit mindestens 3 Watt und 4 oder 8 Ohm.';

export function tonText(kh: Kopfhoerer): string[] {
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

/** The lines of a step for this choice. */
export function schrittText(s: Schritt, w: LoetplanWahl): string[] {
  return s === 4 ? [...tonText(w.kh), LAUTSPRECHER] : SCHRITTE[s].li;
}

/** The "Achtung" of a step, if it has one. */
export function warnung(s: Schritt, w: LoetplanWahl): string {
  if (s === 3 && w.tasten === 5) return '5 Tasten gehen nur mit der Firmware-Variante für 5 Tasten (Classic, 5 Tasten). Mit der normalen Firmware tun A3 und A4 nichts.';
  if (s === 4 && w.kh === 'platine') return 'Nach dem Aufdruck auf der Kopfhörerplatine verbinden (G, DR, DL, SK, SK). JD und NC frei lassen. SK nie an GND.';
  if (s === 2) return 'Kartenleser nur an 3V3 (orange). 5 Volt machen ihn kaputt.';
  if (s === 4 && w.kh === 'keine') return 'Lautsprecher nur an + und −, nie an GND.';
  if (s === 4 && w.kh === 'buchse') return 'Nur eine Buchse mit getrennten Schaltkontakten nehmen (z. B. FC68129). Bei einer einfachen Buchse landet der Lautsprecher-Ausgang an Masse, das kann den Verstärker zerstören.';
  if (s === 0) return 'Vor dem Löten Strom ab. Vor dem ersten Einschalten: Lötstellen ansehen, keine Brücken zwischen Nachbarn.';
  return '';
}

export const KH_NAMEN: Record<Kopfhoerer, string> = {
  platine: 'Kopfhörerplatine',
  buchse: 'einzelne Buchse',
  keine: 'keine Kopfhörerbuchse',
};

/** Whether the headphone choice and the view from below apply to this board. */
export const mitKopfhoerer = (p: Platine) => p === 'classic' || p === 'frei';
export const mitAnsicht = (p: Platine) => p === 'classic';
/** Whether the board takes a Nano or a Nano Every. */
export const mitArduino = (p: Platine) => p === 'classic' || p === 'frei';

/** One line for the picture: what it shows. */
export function wahlText(w: LoetplanWahl): string {
  if (w.platine === 'aio' || w.platine === 'aioplus') return `TonUINO ${PLATINEN_NAMEN[w.platine]} · ${w.tasten} Tasten · Kopfhörerbuchse ist eingebaut`;
  const arduino = w.nano === 'every' ? ' · Arduino Nano Every' : '';
  if (w.platine === 'frei') return `TonUINO Classic ohne Platine (frei verdrahtet)${arduino} · ${w.tasten} Tasten · ${KH_NAMEN[w.kh]}`;
  return `TonUINO Classic v1.7${arduino} · ${w.tasten} Tasten · ${KH_NAMEN[w.kh]}${w.ansicht === 'unten' ? ' · von unten (Lötseite)' : ''}`;
}

/* ------------------------------------------------- the choice, kept for next time */

export const STORE_KEY = 'tonuino-studio:loetplan';

/** A saved or handed-in value as a choice; anything unknown falls back to the default. */
export function toWahl(raw: unknown): LoetplanWahl {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  // The source page saved "kh" as true/false at first.
  const kh = typeof o.kh === 'boolean' ? (o.kh ? 'platine' : 'keine') : o.kh;
  return {
    platine: PLATINEN.includes(o.platine as Platine) ? (o.platine as Platine) : 'classic',
    tasten: o.tasten === 5 ? 5 : 3,
    kh: kh === 'buchse' || kh === 'keine' || kh === 'platine' ? kh : DEFAULT_WAHL.kh,
    ansicht: o.ansicht === 'unten' ? 'unten' : 'oben',
    nano: o.nano === 'every' ? 'every' : 'nano',
    extras: Array.isArray(o.extras) ? EXTRAS.filter((x) => (o.extras as unknown[]).includes(x)) : [],
    ...(o.schalter === 2 || o.schalter === 3 || o.schalter === 4 ? { schalter: o.schalter } : {}),
  };
}

/**
 * Extras that exclude each other, because they use the same pin (TNG
 * constants.hpp: A3 for knob and poti, D5 for ring and LED buttons, A5 for
 * the LED of Play/Pause and the battery measurement, D6 for the LED of
 * „Vor“ and SPKONOFF) or because there is one way for the power (switch in
 * the cable, Pololu, battery, USB-C socket): one picture can only show one.
 */
export const SCHLIESST_AUS: Partial<Record<ExtraId, ExtraId[]>> = {
  drehgeber: ['poti'],
  poti: ['drehgeber'],
  ring: ['ledtasten'],
  ledtasten: ['ring', 'akkumessung', 'lsaus'],
  akkumessung: ['ledtasten'],
  lsaus: ['ledtasten'],
  schalter: ['pololu', 'akku', 'usbc'],
  pololu: ['schalter', 'akku', 'usbc'],
  akku: ['schalter', 'pololu', 'usbc'],
  usbc: ['schalter', 'pololu', 'akku'],
};

/** What the last click switched off, so the page can say so; null when nothing. */
export const zuletztWeg = signal<{ an: ExtraId; weg: ExtraId[] } | null>(null);

/** Switches an extra on or off; switching one on switches off what it excludes. */
export function schalteExtra(id: ExtraId) {
  const jetzt = loetplanWahl.value.extras;
  const an = !jetzt.includes(id);
  const weg = new Set(an ? (SCHLIESST_AUS[id] ?? []) : [id]);
  const aus = an ? jetzt.filter((x) => weg.has(x)) : [];
  zuletztWeg.value = aus.length ? { an: id, weg: aus } : null;
  waehle({ extras: an ? [...jetzt.filter((x) => !weg.has(x)), id] : jetzt.filter((x) => !weg.has(x)) });
}

/** The answer to „Wie viele Beinchen hat dein Schalter?“; the Pololu switch is one of the answers. */
export type SchalterArt = SchalterPins | 'pololu';

export function schalterArt(w: LoetplanWahl): SchalterArt | undefined {
  if (w.extras.includes('pololu')) return 'pololu';
  return w.extras.includes('schalter') ? w.schalter : undefined;
}

/** Sets the kind of switch: the Pololu answer swaps the extra „schalter“ for „pololu“ and back. */
export function waehleSchalter(art: SchalterArt) {
  const w = loetplanWahl.value;
  const ohne = w.extras.filter((x) => x !== 'schalter' && x !== 'pololu');
  const mit = art === 'pololu' ? 'pololu' : 'schalter';
  const weg = new Set(SCHLIESST_AUS[mit] ?? []);
  waehle({ extras: [...ohne.filter((x) => !weg.has(x)), mit], ...(art === 'pololu' ? {} : { schalter: art }) });
}

function load(): LoetplanWahl {
  try {
    return toWahl(JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_WAHL };
  }
}

export const loetplanWahl = signal<LoetplanWahl>(load());

export function waehle(change: Partial<LoetplanWahl>) {
  const next = toWahl({ ...loetplanWahl.value, ...change });
  loetplanWahl.value = next;
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Private window or blocked storage: the choice holds for this visit.
  }
}
