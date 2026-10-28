/**
 * Wiring pictures of the Lötplan for everything that is not the Classic v1.7
 * board itself: the Classic wired by hand (no board), the AiO and the AiO+,
 * and the extras. Drawn by LoetplanSchema.tsx: parts as boxes with their
 * pins, one coloured wire per connection, the pin names inside the parts.
 *
 * Every wire names its proofs (loetplanBelege.ts) and, where it ends at a pin
 * of the microcontroller, the TNG function of that pin (tngPins.ts); the tests
 * check both (tests/workshop/loetplan-belege.test.ts). Only proven wires are
 * drawn: "geprüft", or "vor dem Löten nachsehen" (said in the list). What is
 * not proven well enough is not drawn; the extra says instead why, and what
 * would prove it (`fehlt`).
 */
import { ALARM_TEXT, D6_WARNING, HEADPHONES_TEXT } from '../../core/firmware/baukasten';
import { knopfName, lichtName } from './baukastenWahl';
import { firmwareEnv } from '../../core/firmware/variants';
import { AUDIO, EXTRAS, F, LINKS_INNEN, SCHLIESST_AUS, tastenDerClassic, type ExtraId, type ListenKabel, type LoetplanWahl, type Pt, type SchalterPins } from './loetplan';
import type { BelegId } from './loetplanBelege';
import { tngPin, type TngFunktion, type TngPlatine } from './tngPins';

export type Seite = 'L' | 'R' | 'O' | 'U';

export interface SPin {
  id: string;
  /** The print next to the pin; empty: no print (the legs of a button). */
  txt: string;
  seite: Seite;
  /** Distance from the top (L, R) or the left (O, U) edge of the part. */
  at: number;
  /** A second, smaller line: the number of a DFPlayer pin. */
  nr?: string;
  /** Pin 1 of a module: drawn square. */
  eckig?: boolean;
}

export type Form = 'kasten' | 'taste' | 'lautsprecher' | 'ring' | 'widerstand' | 'elko' | 'drehknopf' | 'led';

export interface STeil {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Body colour; the print on it is white unless `schrift` says otherwise. */
  farbe: string;
  schrift?: string;
  form?: Form;
  pins: SPin[];
  /** Name above the part instead of inside at the top. */
  nameAussen?: boolean;
  /** Small lines inside, under the name. */
  notiz?: string[];
}

export interface SKabel extends ListenKabel {
  von: [string, string];
  nach: [string, string];
  farbe: string;
  /** Bends on the way, for wires that go round a part. */
  via?: Pt[];
  /** A flat cable with many wires: drawn thick and grey. */
  flach?: boolean;
}

export interface SchemaPlan {
  id: string;
  breite: number;
  hoehe: number;
  teile: STeil[];
  kabel: SKabel[];
  /** Lines of the wire list that are not a wire (a pin that stays free). */
  frei?: ListenKabel[];
}

export interface ExtraPlan {
  id: ExtraId;
  titel: string;
  /** One line under its name in the chooser. */
  kurz: string;
  /** What to do, in short lines. */
  text: string[];
  warnung: string;
  /** null: not drawn, `fehlt` says why. */
  plan: SchemaPlan | null;
  /** What to buy. */
  teile: string[];
  /** Which firmware it needs. */
  firmware: string;
  /** Something in the picture is not proven yet (drawn in pencil with "?"): what, and what would prove it. */
  fehlt?: { warum: string; beweis: string };
  /** Cannot be chosen with this choice (5 buttons, a board without it): why. */
  gesperrt?: string;
  /** A page of the help that says more. */
  hilfe?: { href: string; label: string };
  /** Asked before the picture, e.g. how many legs the switch has; no picture until it is answered. */
  frage?: { text: string; optionen: { wert: SchalterPins; titel: string; text: string }[]; gewaehlt?: SchalterPins };
  /** A small table under the text, e.g. the colours of a USB cable. */
  tabelle?: { titel: string; kopf: [string, string]; zeilen: [string, string][] };
  /** Pages on the web that show more (forum, Kompendium). */
  links?: { href: string; label: string }[];
}

/* ------------------------------------------------------------------ helpers */

const NANO = '#1d5f8f';
const RC522 = '#1d5aa6';
const DFP = '#3d3d3d';
const KH = '#2f7d3a';
const BOARD = '#141414';
const AIO = '#1c3f2a';
const ADAPTER = '#1f6b46';
/** Colours of the extra wires. */
const LILA = '#9b3fc8';
const BLAU = '#1f6fd1';

/** Where a pin sits and which way its wire leaves. */
export function pinPunkt(t: STeil, p: SPin): Pt & { dx: number; dy: number } {
  switch (p.seite) {
    case 'L':
      return { x: t.x, y: t.y + p.at, dx: -1, dy: 0 };
    case 'R':
      return { x: t.x + t.w, y: t.y + p.at, dx: 1, dy: 0 };
    case 'O':
      return { x: t.x + p.at, y: t.y, dx: 0, dy: -1 };
    default:
      return { x: t.x + p.at, y: t.y + t.h, dx: 0, dy: 1 };
  }
}

const pins = (seite: Seite, start: number, step: number, namen: string[]): SPin[] => namen.map((n, i) => ({ id: n, txt: n, seite, at: start + i * step }));

const arduinoName = (w: LoetplanWahl) => (w.nano === 'every' ? 'Arduino Nano Every' : 'Arduino Nano');
const kurzName = (w: LoetplanWahl) => (w.nano === 'every' ? 'Nano Every' : 'Nano');

function rc522(x: number, y: number): STeil {
  return {
    id: 'rc522',
    name: 'Kartenleser RC522',
    x,
    y,
    w: 200,
    h: 290,
    farbe: RC522,
    pins: pins('L', 50, 30, ['3.3V', 'RST', 'GND', 'IRQ', 'MISO', 'MOSI', 'SCK', 'SDA']),
  };
}

/** A push button, its two legs on the given sides. */
function taste(id: string, name: string, kappe: string, cx: number, cy: number, beine: [Seite, Seite], r = 30): STeil {
  const pin = (pid: string, s: Seite, off: number): SPin => ({
    id: pid,
    txt: '',
    seite: s,
    at: s === 'L' || s === 'R' ? r + off : r,
  });
  const off = beine[0] === beine[1] ? 12 : 0;
  return {
    id,
    name,
    x: cx - r,
    y: cy - r,
    w: 2 * r,
    h: 2 * r,
    farbe: kappe,
    form: 'taste',
    pins: [pin('a', beine[0], -off), pin('b', beine[1], off)],
  };
}

function lautsprecher(cx: number, cy: number): STeil {
  return {
    id: 'ls',
    name: 'Lautsprecher',
    x: cx - 44,
    y: cy - 44,
    w: 88,
    h: 88,
    farbe: '#2b2b2b',
    form: 'lautsprecher',
    pins: [
      { id: '1', txt: '', seite: 'O', at: 30 },
      { id: '2', txt: '', seite: 'O', at: 58 },
    ],
  };
}

/** A resistor lying down, wire in on the left, out on the right. */
function widerstand(id: string, name: string, x: number, cy: number): STeil {
  return {
    id,
    name,
    x,
    y: cy - 7,
    w: 54,
    h: 14,
    farbe: '#d9c7a0',
    form: 'widerstand',
    pins: [
      { id: 'a', txt: '', seite: 'L', at: 7 },
      { id: 'b', txt: '', seite: 'R', at: 7 },
    ],
  };
}

/** The capacitor, its minus leg (and stripe) on the left or the right. */
function elko(x: number, y: number, minus: 'links' | 'rechts' = 'rechts'): STeil {
  return {
    id: 'elko',
    name: '1000 µF',
    x,
    y,
    w: 46,
    h: 70,
    farbe: '#20307a',
    form: 'elko',
    pins: [
      { id: '+', txt: '+', seite: 'O', at: minus === 'links' ? 34 : 12 },
      { id: '−', txt: '−', seite: 'O', at: minus === 'links' ? 12 : 34 },
    ],
  };
}

/** The LED ring, its pads in the given order from the top. */
function ringTeil(x: number, y: number, reihe: ('DIN' | '5V' | 'GND')[]): STeil {
  return {
    id: 'ring',
    name: 'LED-Ring (24 LEDs)',
    x,
    y,
    w: 260,
    h: 260,
    farbe: '#2b2b2b',
    form: 'ring',
    pins: pins('L', 92, 38, reihe),
  };
}

/* ------------------------------------------------------------------ Classic without board */

function frei(w: LoetplanWahl): SchemaPlan {
  const n = w.tasten;
  const teile: STeil[] = [];
  const kabel: SKabel[] = [];
  const mcu = kurzName(w);
  const nano: STeil = {
    id: 'nano',
    name: arduinoName(w),
    x: 380,
    y: 150,
    w: 240,
    h: 420,
    farbe: NANO,
    notiz: ['Beinchen nach Aufdruck', `auf dem ${mcu} löten`],
    pins: [
      ...pins('L', 50, 30, ['A0', 'A1', 'A2', 'A3', 'A4'].slice(0, n)),
      { id: 'GNDl', txt: 'GND', seite: 'L', at: 380 },
      ...pins('R', 50, 30, ['3V3', 'D9', 'GND', 'IRQ-frei', 'D12', 'D11', 'D13', 'D10']).filter((p) => p.id !== 'IRQ-frei'),
      // Towards the MP3 player: D2, D3 and 5V go round its left side to its bottom row.
      ...pins('U', 30, 40, ['D2', 'D3', '5V']),
      { id: 'D4', txt: 'D4', seite: 'U', at: 160 },
      { id: 'GNDu', txt: 'GND', seite: 'U', at: 210 },
      { id: 'USB', txt: 'USB', seite: 'O', at: 120 },
    ],
  };
  teile.push(nano);
  teile.push({
    id: 'strom',
    name: 'Netzteil oder Powerbank (5 V)',
    x: 340,
    y: 22,
    w: 320,
    h: 56,
    farbe: '#4a4a4a',
    pins: [{ id: 'USB', txt: '', seite: 'U', at: 160 }],
  });
  kabel.push({
    von: ['strom', 'USB'],
    nach: ['nano', 'USB'],
    farbe: F.usb,
    flach: true,
    text: `USB-Kabel: Netzteil oder Powerbank → USB-Buchse am ${mcu}`,
    belege: ['usb'],
  });

  // Card reader, 1:1 by name.
  teile.push(rc522(770, 150));
  const rf: [string, string, string, BelegId, TngFunktion?][] = [
    ['3V3', '3.3V', F.v33, 'cl-v08'],
    ['D9', 'RST', F.rst, 'cl-v10', 'rfidRst'],
    ['GND', 'GND', F.gnd, 'cl-v09'],
    ['D12', 'MISO', F.so, 'cl-v13'],
    ['D11', 'MOSI', F.si, 'cl-v12'],
    ['D13', 'SCK', F.sck, 'cl-v14'],
    ['D10', 'SDA', F.sda, 'cl-v11', 'rfidSs'],
  ];
  for (const [a, b, f, q, fn] of rf)
    kabel.push({
      von: ['nano', a],
      nach: ['rc522', b],
      farbe: f,
      text: `${mcu} ${a} → Kartenleser ${b}`,
      belege: [q],
      ...(fn ? { tng: { platine: 'classic' as const, funktion: fn, pin: a } } : {}),
    });

  // Buttons on the left, their ground legs chained from button to button.
  const namen = tastenDerClassic(n);
  const cy0 = 190;
  const dy = n === 5 ? 92 : 110;
  namen.forEach(([pin, name, farbe, beleg, fn], i) => {
    const t = taste(`taste${i}`, name, farbe, 175, cy0 + i * dy, ['R', 'L']);
    teile.push(t);
    kabel.push({
      von: [t.id, 'a'],
      nach: ['nano', pin],
      farbe,
      text: `${mcu} ${pin} → Taste „${name}“`,
      belege: [beleg],
      tng: { platine: 'classic', funktion: fn, pin },
    });
  });
  const lastCy = cy0 + (n - 1) * dy;
  const busX = 62;
  for (let i = 0; i < n - 1; i++) {
    const y1 = cy0 + i * dy;
    const y2 = y1 + dy;
    kabel.push({
      von: [`taste${i}`, 'b'],
      nach: [`taste${i + 1}`, 'b'],
      farbe: F.gnd,
      via: [
        { x: busX, y: y1 },
        { x: busX, y: y2 },
      ],
      text: `Masse von Taste „${namen[i][1]}“ weiter zu Taste „${namen[i + 1][1]}“`,
      belege: ['cl-v19'],
    });
  }
  const gndY = nano.y + 380;
  const unten = Math.max(lastCy + 74, gndY);
  kabel.push({
    von: ['nano', 'GNDl'],
    nach: [`taste${n - 1}`, 'b'],
    farbe: F.gnd,
    via:
      unten > gndY
        ? [
            { x: 330, y: gndY },
            { x: 330, y: unten },
            { x: busX, y: unten },
            { x: busX, y: lastCy },
          ]
        : [
            { x: busX, y: gndY },
            { x: busX, y: lastCy },
          ],
    text: `${mcu} GND → Taste „${namen[n - 1][1]}“ (Masse für alle Tasten)`,
    belege: ['cl-v19'],
  });

  /*
   * DFPlayer seen from above (the side with the SD card slot), as in the
   * size drawing of its data sheet (FN-M16P, p. 22): pin 1 with the square
   * pad bottom left, 1 … 8 left to right, 16 … 9 above them, the SD card
   * goes in on the right (towards pins 8 and 9). Same view as the Classic
   * v1.7 picture, only turned half round so the BUSY row faces the Nano.
   */
  const dx = 50;
  const reiheUnten = ['VCC', 'RX', 'TX', 'DAC_R', 'DAC_L', 'SPK_1', 'GND', 'SPK_2'];
  const reiheOben = ['BUSY', 'USB−', 'USB+', 'ADKEY_2', 'ADKEY_1', 'IO_2', 'GND', 'IO_1'];
  const dfp: STeil = {
    id: 'dfp',
    name: 'DFPlayer Mini',
    x: 300,
    y: 720,
    w: 400,
    h: 160,
    farbe: DFP,
    notiz: ['von oben gesehen · SD-Karte rechts rein →'],
    pins: [
      ...reiheOben.map(
        (t, i): SPin => ({
          id: `p${16 - i}`,
          txt: ['GND', 'BUSY'].includes(t) ? t : '',
          nr: String(16 - i),
          seite: 'O',
          at: 25 + i * dx,
        }),
      ),
      ...reiheUnten.map(
        (t, i): SPin => ({
          id: `p${1 + i}`,
          txt: t,
          nr: String(1 + i),
          seite: 'U',
          at: 25 + i * dx,
          eckig: i === 0,
        }),
      ),
    ],
  };
  teile.push(dfp);
  kabel.push({
    von: ['nano', 'GNDu'],
    nach: ['dfp', 'p10'],
    farbe: F.gnd,
    text: `${mcu} GND → MP3-Player GND (Pin 10)`,
    belege: ['cl-v05'],
  });
  kabel.push({
    von: ['nano', 'D4'],
    nach: ['dfp', 'p16'],
    farbe: F.busy,
    via: [
      { x: 540, y: 702 },
      { x: 325, y: 702 },
    ],
    text: `${mcu} D4 → MP3-Player BUSY (Pin 16)`,
    belege: ['cl-v03'],
    tng: { platine: 'classic', funktion: 'busy', pin: 'D4' },
  });
  // Round the left of the player to its bottom row: D2 outside, then D3 with the resistor, 5V inside.
  kabel.push({
    von: ['nano', 'D2'],
    nach: ['dfp', 'p3'],
    farbe: F.tx,
    via: [
      { x: 410, y: 648 },
      { x: 205, y: 648 },
      { x: 205, y: 1010 },
      { x: 425, y: 1010 },
    ],
    text: `${mcu} D2 → MP3-Player TX (Pin 3), über Kreuz`,
    belege: ['cl-v01'],
    tng: { platine: 'classic', funktion: 'dfRx', pin: 'D2' },
  });
  teile.push({
    id: 'r1k',
    name: '1 kΩ',
    x: 368,
    y: 902,
    w: 14,
    h: 54,
    farbe: '#d9c7a0',
    form: 'widerstand',
    pins: [
      { id: 'a', txt: '', seite: 'U', at: 7 },
      { id: 'b', txt: '', seite: 'O', at: 7 },
    ],
  });
  kabel.push({
    von: ['nano', 'D3'],
    nach: ['r1k', 'a'],
    farbe: F.rx,
    via: [
      { x: 450, y: 666 },
      { x: 245, y: 666 },
      { x: 245, y: 985 },
      { x: 375, y: 985 },
    ],
    text: `${mcu} D3 → Widerstand 1 kΩ`,
    belege: ['cl-v02'],
    tng: { platine: 'classic', funktion: 'dfTx', pin: 'D3' },
  });
  kabel.push({
    von: ['r1k', 'b'],
    nach: ['dfp', 'p2'],
    farbe: F.rx,
    via: [],
    text: 'Widerstand 1 kΩ → MP3-Player RX (Pin 2)',
    belege: ['cl-v02'],
  });
  kabel.push({
    von: ['nano', '5V'],
    nach: ['dfp', 'p1'],
    farbe: F.v5,
    via: [
      { x: 490, y: 684 },
      { x: 285, y: 684 },
      { x: 285, y: 910 },
      { x: 325, y: 910 },
    ],
    text: `${mcu} 5V → MP3-Player VCC (Pin 1)`,
    belege: ['cl-v04'],
  });

  // Sound below the right half of the player, where its sound pins are.
  const spk = (a: string, b: string, f: string, txt: string, belege: BelegId[]): SKabel => ({
    von: ['dfp', a],
    nach: b.split(':') as [string, string],
    farbe: f,
    text: txt,
    belege,
  });
  if (w.kh === 'platine') {
    teile.push({
      id: 'kh',
      name: 'Kopfhörerplatine',
      x: 440,
      y: 960,
      w: 270,
      h: 140,
      farbe: KH,
      pins: [
        ...pins('O', 35, 50, ['G', 'DR', 'DL', 'SK', 'SK']).map((p, i) => ({
          ...p,
          id: ['G', 'DR', 'DL', 'SK1', 'SK2'][i],
        })),
        { id: 'S2', txt: '', seite: 'L', at: 95 },
        { id: 'S1', txt: '', seite: 'L', at: 120 },
      ],
      notiz: ['← Speaker'],
    });
    kabel.push(spk('p8', 'kh:SK2', F.minus, 'MP3-Player SPK_2 (Pin 8) → Kopfhörerplatine SK', ['oas-v18']));
    kabel.push(spk('p6', 'kh:SK1', F.plus, 'MP3-Player SPK_1 (Pin 6) → Kopfhörerplatine SK', ['oas-v18']));
    kabel.push(spk('p5', 'kh:DL', F.l, 'MP3-Player DAC_L (Pin 5) → Kopfhörerplatine DL', ['oas-v17']));
    kabel.push(spk('p4', 'kh:DR', F.r, 'MP3-Player DAC_R (Pin 4) → Kopfhörerplatine DR', ['oas-v16']));
    kabel.push(spk('p7', 'kh:G', F.gnd, 'MP3-Player GND (Pin 7, zwischen SPK_1 und SPK_2) → Kopfhörerplatine G', ['oas-v15']));
    teile.push(lautsprecher(310, 1110));
    kabel.push({
      von: ['kh', 'S1'],
      nach: ['ls', '2'],
      farbe: F.minus,
      text: 'Kopfhörerplatine „Speaker“ → Lautsprecher',
      belege: ['oas-v14'],
    });
    kabel.push({
      von: ['kh', 'S2'],
      nach: ['ls', '1'],
      farbe: F.plus,
      text: 'Kopfhörerplatine „Speaker“ → Lautsprecher (zweites Kabel)',
      belege: ['oas-v14'],
    });
  } else if (w.kh === 'buchse') {
    teile.push({
      id: 'kh',
      name: 'Buchse FC68129',
      x: 440,
      y: 960,
      w: 210,
      h: 120,
      farbe: '#5d5d5d',
      pins: [...pins('O', 35, 50, ['4', '3', '5', '1']), { id: '7', txt: '7', seite: 'R', at: 80 }],
      notiz: ['Nummern vorher durchpiepen!'],
    });
    kabel.push(spk('p7', 'kh:1', F.gnd, 'MP3-Player GND (Pin 7) → Buchse Pin 1', ['oas-v64']));
    kabel.push(spk('p6', 'kh:5', F.plus, 'MP3-Player SPK_1 (Pin 6) → Buchse Pin 5', ['oas-v60']));
    kabel.push(spk('p5', 'kh:3', F.l, 'MP3-Player DAC_L (Pin 5) → Buchse Pin 3', ['oas-v62']));
    kabel.push(spk('p4', 'kh:4', F.r, 'MP3-Player DAC_R (Pin 4) → Buchse Pin 4', ['oas-v63']));
    teile.push(lautsprecher(830, 1060));
    kabel.push({
      von: ['dfp', 'p8'],
      nach: ['ls', '2'],
      farbe: F.minus,
      via: [
        { x: 675, y: 925 },
        { x: 844, y: 925 },
      ],
      text: 'MP3-Player SPK_2 (Pin 8) → Lautsprecher',
      belege: ['cl-v07', 'oas-v60'],
    });
    kabel.push({
      von: ['kh', '7'],
      nach: ['ls', '1'],
      farbe: F.plus,
      text: 'Buchse Pin 7 → Lautsprecher',
      belege: ['oas-v61'],
    });
  } else {
    teile.push(lautsprecher(615, 1060));
    kabel.push({
      von: ['dfp', 'p8'],
      nach: ['ls', '2'],
      farbe: F.minus,
      text: 'MP3-Player SPK_2 (Pin 8) → Lautsprecher',
      belege: ['cl-v07'],
    });
    kabel.push({
      von: ['dfp', 'p6'],
      nach: ['ls', '1'],
      farbe: F.plus,
      text: 'MP3-Player SPK_1 (Pin 6) → Lautsprecher',
      belege: ['cl-v06'],
    });
  }
  const hoehe = Math.max(...teile.map((t) => t.y + t.h + (t.form === 'lautsprecher' ? 40 : 30)));
  return {
    id: 'frei',
    breite: 1000,
    hoehe,
    teile,
    kabel,
    frei: [{ farbe: null, text: 'Kartenleser IRQ bleibt frei', belege: ['cl-v15'] }],
  };
}

/* ------------------------------------------------------------------ AiO and AiO+ */

function aio(w: LoetplanWahl, plus: boolean): SchemaPlan {
  const teile: STeil[] = [];
  const kabel: SKabel[] = [];
  const platine: TngPlatine = plus ? 'aioplus' : 'aio';
  const board: STeil = {
    id: 'aio',
    name: plus ? 'AiO+-Platine' : 'AiO-Platine',
    x: 400,
    y: 420,
    w: 300,
    h: 300,
    farbe: AIO,
    notiz: ['Kopfhörerbuchse (Nr. 4)', 'und SD-Karte sind schon drauf'],
    pins: [
      { id: 'usb', txt: 'USB-C (1)', seite: 'O', at: 70 },
      { id: 'nfc', txt: 'NFC (13)', seite: 'O', at: 225 },
      { id: 'tasten', txt: 'Tasten (10)', seite: 'L', at: 150 },
      {
        id: 'speaker',
        txt: plus ? 'SPEAKER (8)' : 'SPEAKER',
        seite: 'R',
        at: 150,
      },
    ],
  };
  teile.push(board);
  teile.push({
    id: 'strom',
    name: 'USB-Netzteil 5 V, 2–3 A',
    x: 300,
    y: 250,
    w: 240,
    h: 60,
    farbe: '#4a4a4a',
    pins: [{ id: 'usb', txt: '', seite: 'U', at: 170 }],
  });
  kabel.push({
    von: ['strom', 'usb'],
    nach: ['aio', 'usb'],
    farbe: F.usb,
    flach: true,
    text: 'USB-C-Kabel: Netzteil → USB-C-Buchse (Nr. 1)',
    belege: [plus ? 'ap-usb' : 'aio-usb'],
  });

  // Card reader to the NFC adapter, 1:1 by name, the adapter's cable into the board.
  teile.push(rc522(770, 40));
  const nfcNamen = ['3.3V', 'RST', 'GND', 'IRQ', 'MISO', 'MOSI', 'SCK', 'SDA'];
  teile.push({
    id: 'nfc',
    name: 'NFC-Adapter',
    x: 560,
    y: 40,
    w: 140,
    h: 290,
    farbe: ADAPTER,
    pins: [...pins('R', 50, 30, nfcNamen), { id: 'kabel', txt: '', seite: 'U', at: 65 }],
  });
  const rfF = [F.v33, F.rst, F.gnd, F.irq, F.so, F.si, F.sck, F.sda];
  nfcNamen.forEach((n, i) =>
    kabel.push({
      von: ['rc522', n],
      nach: ['nfc', n],
      farbe: rfF[i],
      text: `Kartenleser ${n} → NFC-Adapter ${n}`,
      belege: [plus ? 'ap-nfc-adapter' : 'aio-rc522'],
    }),
  );
  kabel.push({
    von: ['nfc', 'kabel'],
    nach: ['aio', 'nfc'],
    farbe: F.usb,
    flach: true,
    text: 'Beiliegendes 8-adriges Kabel: NFC-Adapter → Anschluss NFC (Nr. 13), nur stecken',
    belege: [plus ? 'ap-nfc-kabel' : 'aio-nfc-kabel'],
  });

  // Buttons to the button adapter: signal and the ground next to it, Play/Pause on PBP and PBN.
  const f5 = w.tasten === 5;
  const gruppen: [string, string, string, string, boolean, TngFunktion][] = [
    ['V-', 'GND', 'Leiser', F.leis, f5, 'five5'],
    ['<', 'GND', f5 ? 'Zurück' : 'Zurück / leiser', F.zur, true, f5 ? 'down5' : 'down3'],
    ['PBP', 'PBN', 'Play/Pause', F.play, true, 'pause'],
    ['>', 'GND', f5 ? 'Vor' : 'Vor / lauter', F.vor, true, f5 ? 'up5' : 'up3'],
    ['V+', 'GND', 'Lauter', F.laut, f5, 'four5'],
  ];
  const gy = 80;
  const ad: STeil = {
    id: 'adapter',
    name: 'Button-Adapter',
    nameAussen: true,
    x: 220,
    y: 380 - 10,
    w: 110,
    h: 5 * gy + 10,
    farbe: ADAPTER,
    pins: [
      ...gruppen.flatMap(([s, g], i): SPin[] => [
        { id: `s${i}`, txt: s, seite: 'L', at: 30 + i * gy },
        { id: `g${i}`, txt: g, seite: 'L', at: 52 + i * gy },
      ]),
      { id: 'kabel', txt: '', seite: 'R', at: 200 },
    ],
  };
  teile.push(ad);
  kabel.push({
    von: ['adapter', 'kabel'],
    nach: ['aio', 'tasten'],
    farbe: F.usb,
    flach: true,
    text: 'Beiliegendes 10-adriges Kabel: Button-Adapter → Anschluss Tasten (Nr. 10), nur stecken',
    belege: [plus ? 'ap-button-kabel' : 'aio-button-kabel'],
  });
  gruppen.forEach(([s, , name, farbe, an, fn], i) => {
    if (!an) return;
    const cy = ad.y + 41 + i * gy;
    teile.push(taste(`taste${i}`, name, farbe, 112, cy, ['R', 'R'], 22));
    const play = s === 'PBP';
    // The adapter passes its cable 1:1 to the board; the pin is the one of TNG for this button.
    const pin = tngPin(platine, fn).pin;
    kabel.push({
      von: [`taste${i}`, 'a'],
      nach: ['adapter', `s${i}`],
      farbe,
      text: `Taste „${name}“ → Button-Adapter ${s} (${pin})`,
      belege: [play ? (plus ? 'ap-taster-play' : 'aio-taster-play') : plus ? 'ap-taster' : 'aio-taster-signal'],
      tng: { platine, funktion: fn, pin },
    });
    kabel.push({
      von: [`taste${i}`, 'b'],
      nach: ['adapter', `g${i}`],
      farbe: play ? F.pbn : F.gnd,
      text: play ? 'Taste „Play/Pause“, anderes Beinchen → Button-Adapter PBN (nicht an GND!)' : `Taste „${name}“, anderes Beinchen → GND daneben`,
      belege: [play ? (plus ? 'ap-taster-play' : 'aio-taster-play') : plus ? 'ap-taster' : 'aio-taster-gnd'],
    });
  });

  teile.push(lautsprecher(850, 600));
  kabel.push({
    von: ['aio', 'speaker'],
    nach: ['ls', '1'],
    farbe: F.plus,
    via: [{ x: 790, y: 570 }],
    text: plus ? 'Beiliegendes Lautsprecherkabel: Stecker in SPEAKER (Nr. 8), rote Ader an + am Lautsprecher' : 'Beiliegendes Lautsprecherkabel: Stecker in SPEAKER, freie Enden an den Lautsprecher löten',
    belege: [plus ? 'ap-lautsprecher' : 'aio-lautsprecher'],
  });
  kabel.push({
    von: ['aio', 'speaker'],
    nach: ['ls', '2'],
    farbe: F.minus,
    via: [{ x: 790, y: 570 }],
    text: 'Zweite Ader des Lautsprecherkabels → Lautsprecher',
    belege: [plus ? 'ap-lautsprecher' : 'aio-lautsprecher'],
  });
  return {
    id: plus ? 'aioplus' : 'aio',
    breite: 1000,
    hoehe: 840,
    teile,
    kabel,
    frei: [
      {
        farbe: null,
        text: 'Kopfhörer: einfach einstecken, die Buchse ist schon auf der Platine',
        belege: [plus ? 'ap-kopfhoerer' : 'aio-kopfhoerer'],
      },
    ],
  };
}

/** The wiring picture of a board without its own board drawing; null for the Classic v1.7. */
export function schema(w: LoetplanWahl): SchemaPlan | null {
  if (w.platine === 'frei') return frei(w);
  if (w.platine === 'aio' || w.platine === 'aioplus') return aio(w, w.platine === 'aioplus');
  return null;
}

/* ------------------------------------------------------------------ extras: where they connect on the Classic */

/*
 * On the Classic v1.7 board the extras go to the left row (print, top to
 * bottom: A0 … A7, GND, GND, D8, D7, D6, D5, GND) and to the audio row
 * (5V, GND, GND, R, L, +, −), both drawn whole with their print, so the
 * right hole can be counted off. Without board the same wires go straight to
 * the Nano, drawn as a stub with only those pins.
 */
const PITCH = 32;
const OBEN = 30;
/** Pin ids of the left row: the print, the three GND numbered by their place. */
const LINKS_IDS = LINKS_INNEN.map((n, i) => (n === 'GND' ? `GND${i}` : n));
const AUDIO_IDS = ['5V', 'GNDa', 'GNDb', 'R', 'L', '+', '−'];
const STUMMEL_W = 200;

/** Where an extra's wire starts: the part, the pin, how the list names it, the proofs of that hole. */
interface Ende {
  teil: string;
  pin: string;
  name: string;
  belege: BelegId[];
}

function ende(w: LoetplanWahl, id: string): Ende {
  const links = LINKS_IDS.indexOf(id);
  const txt = links >= 0 ? LINKS_INNEN[links] : AUDIO[AUDIO_IDS.indexOf(id)];
  if (w.platine === 'frei') return { teil: 'nano', pin: id, name: `${kurzName(w)} ${txt}`, belege: [] };
  if (links >= 0) return { teil: 'leiste', pin: id, name: `Platine ${txt} (linke Leiste)`, belege: ['v17-foto-links'] };
  if (id === '5V') return { teil: 'audio', pin: id, name: 'Platine 5V (Audio-Leiste, ganz außen)', belege: ['v17-foto-audio', 'v17-5v'] };
  return { teil: 'audio', pin: id, name: 'Platine GND (Audio-Leiste, neben 5V)', belege: ['v17-foto-audio'] };
}

/** y of a pin of the Classic stubs, the left row from the top, the audio row from `audioY`. */
function stummelY(id: string, audioY: number): number {
  const links = LINKS_IDS.indexOf(id);
  return links >= 0 ? OBEN + 56 + links * PITCH : audioY + 56 + AUDIO_IDS.indexOf(id) * PITCH;
}

/** The stubs an extra needs: the board's left and audio rows, or a Nano with just these pins. */
function stummel(w: LoetplanWahl, ids: string[], audioY: number): STeil[] {
  if (w.platine === 'frei') {
    const at = ids.map((id) => stummelY(id, audioY) - OBEN);
    return [
      {
        id: 'nano',
        name: arduinoName(w),
        x: 30,
        y: OBEN,
        w: STUMMEL_W,
        h: Math.max(...at) + 34,
        farbe: NANO,
        notiz: ['Beinchen nach Aufdruck', `am ${kurzName(w)} löten`],
        pins: ids.map((id, i) => ({ id, txt: id.startsWith('GND') ? 'GND' : id, seite: 'R', at: at[i] })),
      },
    ];
  }
  const out: STeil[] = [];
  if (ids.some((id) => LINKS_IDS.includes(id)))
    out.push({
      id: 'leiste',
      name: 'Classic-Platine',
      notiz: ['linke Leiste'],
      x: 30,
      y: OBEN,
      w: STUMMEL_W,
      h: 56 + 14 * PITCH + 30,
      farbe: BOARD,
      pins: LINKS_IDS.map((id, i) => ({ id, txt: LINKS_INNEN[i], seite: 'R', at: 56 + i * PITCH })),
    });
  if (ids.some((id) => AUDIO_IDS.includes(id)))
    out.push({
      id: 'audio',
      name: 'Classic-Platine',
      notiz: ['Audio-Leiste'],
      x: 30,
      y: audioY,
      w: STUMMEL_W,
      h: 56 + 6 * PITCH + 30,
      farbe: BOARD,
      pins: AUDIO_IDS.map((id, i) => ({ id, txt: AUDIO[i], seite: 'R', at: 56 + i * PITCH })),
    });
  return out;
}

/** A wire from the board (or Nano) to a part. */
function vomBrett(w: LoetplanWahl, id: string, nach: [string, string], farbe: string, wohin: string, belege: BelegId[], tng?: TngFunktion, via?: Pt[]): SKabel {
  const e = ende(w, id);
  return {
    von: [e.teil, e.pin],
    nach,
    farbe,
    text: `${e.name} → ${wohin}`,
    belege: [...e.belege, ...belege],
    ...(tng ? { tng: { platine: 'classic' as const, funktion: tng, pin: LINKS_INNEN[LINKS_IDS.indexOf(id)] } } : {}),
    ...(via ? { via } : {}),
  };
}

/** Bottom of the picture: below the lowest part. */
const hoeheVon = (teile: STeil[]) => Math.max(...teile.map((t) => t.y + t.h + (['ring', 'elko', 'taste', 'led', 'widerstand'].includes(t.form ?? '') ? 44 : 30)));

const AUDIO_Y = 600;

/* ------------------------------------------------------------------ extras on the Classic and Nano Every */

/**
 * Where the firmware for an extra comes from. The Firmware-Baukasten of the
 * app builds the Classic (Nano) and the AiO with extras (docs/
 * FIRMWARE-BAUKASTEN.md, labels from core/firmware/baukasten.ts); the Nano
 * Every and the AiO+ it cannot build.
 */
const BAUKASTEN = (label: string, extra = '') => `In TonUINO Studio: „Firmware aufspielen“, im Schritt „Extras“ „${label}“ wählen.${extra ? ` ${extra}` : ''}`;
const EVERY_SELBST = (define: string, w: LoetplanWahl) =>
  `Keine fertige Firmware für den Nano Every hat das. Du brauchst eine Fassung mit ${define}${w.tasten === 3 ? ' und 3 Tasten' : ''}, gebaut und aufgespielt mit der Arduino IDE oder PlatformIO.`;
const FW_KNOPF = (kind: 'encoder' | 'poti', define: string, w: LoetplanWahl) => (w.nano === 'every' ? EVERY_SELBST(define, w) : BAUKASTEN(knopfName(kind), 'Geht nur mit 3 Tasten.'));

function drehgeber(w: LoetplanWahl): ExtraPlan {
  const base = {
    id: 'drehgeber' as const,
    titel: 'Drehknopf für die Lautstärke',
    kurz: 'Endlos-Drehknopf (KY-040) für lauter und leiser',
    warnung: '+ am Drehknopf nur an 5V, nie an eine höhere Spannung.',
    teile: ['Drehknopf-Modul KY-040 (kleine Platine mit 5 Anschlüssen)', '4 Kabel'],
    firmware: FW_KNOPF('encoder', 'ROTARY_ENCODER', w),
  };
  if (w.tasten === 5)
    return {
      ...base,
      text: [],
      plan: null,
      gesperrt: 'Geht nur mit 3 Tasten: Der Drehknopf braucht A3 und A4, und da hängen bei 5 Tasten „Vor“ und „Zurück“ (TNG constants.hpp:209–210, 560–561).',
    };
  const teile: STeil[] = [
    ...stummel(w, ['A3', 'A4', '5V', 'GNDa'], AUDIO_Y),
    {
      id: 'ky',
      name: 'Drehknopf KY-040',
      x: 620,
      y: 200,
      w: 220,
      h: 300,
      farbe: '#1d5aa6',
      form: 'drehknopf',
      pins: pins('L', 80, 40, ['CLK', 'DT', 'SW', '+', 'GND']),
    },
  ];
  const kabel: SKabel[] = [
    vomBrett(w, 'A3', ['ky', 'CLK'], F.sck, 'Drehknopf CLK', ['cl-enc-clk'], 'encClk'),
    vomBrett(w, 'A4', ['ky', 'DT'], F.so, 'Drehknopf DT', ['cl-enc-dt'], 'encDt'),
    vomBrett(w, '5V', ['ky', '+'], F.v5, 'Drehknopf +', ['cl-enc-plus']),
    vomBrett(w, 'GNDa', ['ky', 'GND'], F.gnd, 'Drehknopf GND', ['cl-enc-gnd']),
  ];
  return {
    ...base,
    text: [
      'Ein Drehknopf ohne Anschlag: Drehen macht lauter oder leiser, während die Box spielt (TNG commands.cpp).',
      'Nimm das Modul auf der kleinen Platine: TNG schaltet an A3 und A4 keine eingebauten Widerstände ein (constants.hpp:214), das Modul bringt sie mit. Ein nackter Drehknopf ohne Platine braucht zwei Widerstände 10 kΩ von CLK und DT nach 5V.',
      'Die Anschlüsse am Modul nach dem Aufdruck verbinden, nicht abzählen.',
      'SW ist der Druckknopf in der Achse. Er darf frei bleiben. Willst du ihn als Play/Pause nutzen: SW an dasselbe Loch wie die Play/Pause-Taste (A0).',
    ],
    plan: {
      id: 'drehgeber',
      breite: 1000,
      hoehe: hoeheVon(teile),
      teile,
      kabel,
      frei: [{ farbe: null, text: 'Drehknopf SW bleibt frei (oder parallel zur Play/Pause-Taste an A0)', belege: ['cl-enc-sw'] }],
    },
  };
}

function poti(w: LoetplanWahl): ExtraPlan {
  const base = {
    id: 'poti' as const,
    titel: 'Lautstärke-Regler mit Anschlag (Poti)',
    kurz: 'Drehregler wie am Radio: links leise, rechts laut',
    warnung: 'Die beiden äußeren Beinchen nur an 5V und GND, nie an eine höhere Spannung.',
    teile: ['Poti 10 kΩ, logarithmisch, mit 3 Beinchen', 'Drehknopf zum Aufstecken', '3 Kabel'],
    firmware: FW_KNOPF('poti', 'POTI', w),
  };
  if (w.tasten === 5)
    return {
      ...base,
      text: [],
      plan: null,
      gesperrt: 'Geht nur mit 3 Tasten: Das Poti braucht A3, und da hängt bei 5 Tasten „Vor“ (TNG constants.hpp:232, 560).',
    };
  if (w.nano === 'every')
    return {
      ...base,
      text: [
        'Die Mitte des Potis kommt an A3, ein äußeres Beinchen an GND (TNG constants.hpp:232).',
        'Das andere äußere Beinchen an 3V3: Der Nano Every misst mit 2,5 V (TNG tonuino.cpp:190), an 5V wäre schon ab der Hälfte des Drehwegs „ganz laut“. Aus dem Quelltext abgeleitet, noch nicht ausprobiert. Gefährlich ist beides nicht.',
        'Wenn du magst: Im Box-Logbuch über den ganzen Drehweg „poti volume“ ansehen.',
      ],
      warnung: 'Die äußeren Beinchen an 3V3 und GND, nie an mehr als 5 V.',
      plan: null,
    };
  const teile: STeil[] = [
    ...stummel(w, ['A3', '5V', 'GNDa'], AUDIO_Y),
    {
      id: 'poti',
      name: 'Poti 10 kΩ',
      x: 620,
      y: 260,
      w: 220,
      h: 240,
      farbe: '#2f4f7f',
      form: 'drehknopf',
      pins: [
        { id: 'e1', txt: 'Ende', seite: 'L', at: 70 },
        { id: 'm', txt: 'Mitte', seite: 'L', at: 120 },
        { id: 'e2', txt: 'Ende', seite: 'L', at: 170 },
      ],
    },
  ];
  const kabel: SKabel[] = [
    vomBrett(w, 'A3', ['poti', 'm'], LILA, 'Poti Mitte (Schleifer)', ['cl-poti-s'], 'poti'),
    vomBrett(w, '5V', ['poti', 'e1'], F.v5, 'Poti, ein äußeres Beinchen', ['cl-poti-vcc']),
    vomBrett(w, 'GNDa', ['poti', 'e2'], F.gnd, 'Poti, anderes äußeres Beinchen', ['cl-poti-gnd']),
  ];
  return {
    ...base,
    text: [
      'Ein Drehregler mit Anschlag: ganz links ist die kleinste, ganz rechts die größte Lautstärke aus den Einstellungen der Box.',
      'Die Mitte kommt an A3, die beiden äußeren Beinchen an 5V und GND.',
      'Dreht er falsch herum, tausche 5V und GND an den äußeren Beinchen.',
      'Nimm entweder den Drehknopf (KY-040) oder das Poti, nicht beides: Beide brauchen A3.',
    ],
    plan: { id: 'poti', breite: 1000, hoehe: hoeheVon(teile), teile, kabel },
  };
}

function ringClassic(w: LoetplanWahl): ExtraPlan {
  const teile: STeil[] = [...stummel(w, ['D5', '5V', 'GNDa'], AUDIO_Y), widerstand('r470', '470 Ω', 430, 392), ringTeil(640, 300, ['DIN', '5V', 'GND']), elko(470, 600)];
  const kabel: SKabel[] = [
    vomBrett(w, 'D5', ['r470', 'a'], BLAU, 'Widerstand 470 Ω', ['cl-neo-din'], 'ring'),
    { von: ['r470', 'b'], nach: ['ring', 'DIN'], farbe: BLAU, text: 'Widerstand 470 Ω → LED-Ring DIN (Daten rein)', belege: ['neo-widerstand'] },
    vomBrett(w, '5V', ['ring', '5V'], F.v5, 'LED-Ring 5V', ['cl-neo-5v']),
    vomBrett(w, 'GNDa', ['ring', 'GND'], F.gnd, 'LED-Ring GND', ['cl-neo-gnd']),
    { von: ['elko', '+'], nach: ['ring', '5V'], farbe: F.v5, text: 'Elko Plus (langes Bein) → LED-Ring 5V', belege: ['cl-neo-elko'] },
    { von: ['elko', '−'], nach: ['ring', 'GND'], farbe: F.gnd, text: 'Elko Minus (Streifen) → LED-Ring GND', belege: ['cl-neo-elko'] },
  ];
  const every = w.nano === 'every';
  return {
    ...RING_BASE,
    firmware: every
      ? w.tasten === 5
        ? 'Fertig gibt es TonUINO_Every_5f. Achtung: Die schaltet auch die Kopfhörer-Erkennung an D8 ein. Ohne Kabel an D8 meint die Box, ein Kopfhörer steckt, und nimmt dessen Lautstärke-Grenzen (TNG mp3.cpp:407, gpioHelper.hpp:21). Sonst eine eigene Fassung mit NEO_RING.'
        : 'Fertig gibt es den Ring beim Nano Every nur mit 5 Tasten (TonUINO_Every_5f). Mit 3 Tasten brauchst du eine eigene Fassung mit NEO_RING. Den Nano Every bespielst du mit der Arduino IDE oder PlatformIO.'
      : BAUKASTEN(lichtName('ring'), 'Der Leuchtring braucht einen Nano mit neuem Bootloader; das prüfe ich beim Aufspielen, bevor ich etwas schreibe.'),
    text: [...RING_BASE.text, 'Der Widerstand 470 Ω kommt in die Datenleitung, möglichst nah an den Ring.', 'Nimm entweder den LED-Ring oder LED-Tasten, nicht beides: Beide brauchen D5.'],
    plan: { id: 'ring', breite: 1000, hoehe: hoeheVon(teile), teile, kabel, frei: [{ farbe: null, text: 'LED-Ring DOUT (Daten raus) bleibt frei', belege: ['cl-neo-din'] }] },
  };
}

const RING_BASE = {
  id: 'ring' as const,
  titel: 'LED-Ring',
  kurz: 'Ring mit 24 bunten LEDs: zeigt, ob die Box spielt, pausiert oder auf eine Karte wartet',
  text: [
    'Ein Ring mit 24 bunten LEDs (WS2812B, „NeoPixel“). Am Ring gibt es DIN (Daten rein) und DOUT (Daten raus): DIN nehmen, DOUT bleibt frei.',
    'Den Elko direkt am Ring zwischen 5V und GND löten. Der Streifen am Elko ist Minus und kommt an GND.',
    'Erst GND verbinden, dann den Rest.',
  ],
  warnung: 'Elko richtig herum: Minus (Streifen) an GND. Falsch herum kann er platzen.',
  teile: ['LED-Ring mit genau 24 LEDs (WS2812B)', 'Widerstand 470 Ω', 'Elko 1000 µF, mindestens 6,3 V', '3 Kabel'],
};

function ledtasten(w: LoetplanWahl): ExtraPlan {
  // TNG: led_play_pin A5, led_up_pin D6, led_down_pin D5 (constants.hpp:508–510): the LEDs of Play/Pause, Vor and Zurück.
  const leds: [string, string, string, string, BelegId, TngFunktion][] = [
    ['A5', 'Play/Pause', F.play, '#fff', 'cl-led-play', 'ledPlay'],
    ['D6', 'Vor', F.vor, '#000', 'cl-led-vor', 'ledUp'],
    ['D5', 'Zurück', F.zur, '#000', 'cl-led-zurueck', 'ledDown'],
  ];
  const teile: STeil[] = [...stummel(w, ['A5', 'D6', 'D5', 'GND14'], AUDIO_Y)];
  const kabel: SKabel[] = [];
  const cys = [190, 380, 570];
  leds.forEach(([pin, name, farbe, schrift, beleg, fn], i) => {
    const cy = cys[i];
    teile.push(widerstand(`r${i}`, '1 kΩ', 560, cy - 12));
    teile.push({
      id: `led${i}`,
      name: `LED ${name}`,
      x: 780 - 34,
      y: cy - 34,
      w: 68,
      h: 68,
      farbe,
      schrift,
      form: 'taste',
      pins: [
        { id: '+', txt: '+', seite: 'L', at: 22 },
        { id: '−', txt: '−', seite: 'R', at: 46 },
      ],
    });
    kabel.push(vomBrett(w, pin, [`r${i}`, 'a'], farbe, `Widerstand 1 kΩ (LED „${name}“)`, [beleg], fn));
    kabel.push({ von: [`r${i}`, 'b'], nach: [`led${i}`, '+'], farbe, text: `Widerstand 1 kΩ → LED + der Taste „${name}“`, belege: [beleg] });
  });
  for (let i = 0; i < 2; i++)
    kabel.push({
      von: [`led${i}`, '−'],
      nach: [`led${i + 1}`, '−'],
      farbe: F.gnd,
      via: [
        { x: 880, y: cys[i] + 12 },
        { x: 880, y: cys[i + 1] + 12 },
      ],
      text: `LED − der Taste „${leds[i][1]}“ weiter zu LED − der Taste „${leds[i + 1][1]}“`,
      belege: ['cl-led-gnd'],
    });
  kabel.push(
    vomBrett(w, 'GND14', ['led2', '−'], F.gnd, `LED − der Taste „${leds[2][1]}“ (Masse für alle drei LEDs)`, ['cl-led-gnd'], undefined, [
      { x: 300, y: stummelY('GND14', AUDIO_Y) },
      { x: 300, y: 650 },
      { x: 880, y: 650 },
      { x: 880, y: cys[2] + 12 },
    ]),
  );
  return {
    id: 'ledtasten',
    titel: 'Tasten mit LED',
    kurz: 'Play/Pause, Vor und Zurück leuchten und blinken',
    text: [
      'Die Tasten selbst bleiben angeschlossen wie im großen Bild. Hier kommen nur die LEDs in den Tasten dazu.',
      'Jede LED bekommt einen Widerstand mit 1 kΩ in die Plus-Leitung.',
      'Plus und Minus stehen meist an der Taste. Leuchtet eine LED nicht, sind Plus und Minus vertauscht: dann die LED umdrehen.',
      'Beim Spielen leuchten alle LEDs, in der Pause blinkt Play/Pause.',
      'Nimm entweder LED-Tasten oder den LED-Ring, nicht beides: Beide brauchen D5.',
      'Nimm entweder LED-Tasten oder die Akku-Anzeige, nicht beides: Beide brauchen A5.',
      D6_WARNING,
    ],
    warnung: 'Nie eine LED ohne Widerstand an den Arduino: Das kann den Pin zerstören.',
    teile: ['3 Tasten mit eingebauter LED', '3 Widerstände 1 kΩ', '7 Kabel'],
    firmware: w.nano === 'every' ? EVERY_SELBST('USE_LED_BUTTONS', { ...w, tasten: 5 }) : BAUKASTEN(lichtName('ledButtons'), 'Nicht zusammen mit „Lautsprecher stumm“: Beide brauchen D6.'),
    plan: { id: 'ledtasten', breite: 1000, hoehe: 690, teile, kabel },
  };
}

function pololu(w: LoetplanWahl): ExtraPlan {
  const brett = w.platine === 'classic';
  const teile: STeil[] = [
    ...stummel(w, ['A0', 'D7', '5V', 'GNDa'], AUDIO_Y),
    {
      id: 'pololu',
      name: 'Pololu-Schalter (LV)',
      x: 470,
      y: 380,
      w: 170,
      h: 250,
      farbe: '#2a6db0',
      pins: [
        ...pins('L', 50, 40, ['A', 'OFF', 'VOUT', 'GND']),
        ...pins('R', 50, 40, ['VIN', 'GND']).map((x) => ({
          ...x,
          id: `${x.id}r`,
        })),
      ],
    },
    {
      id: 'pb',
      name: 'Powerbank',
      x: 770,
      y: 380,
      w: 200,
      h: 140,
      farbe: '#4a4a4a',
      notiz: ['USB-Kabel aufgeschnitten'],
      pins: pins('L', 50, 40, ['+ rot', '− schwarz']),
    },
    taste('play', 'Play/Pause', F.play, 400, 260, ['L', 'R'], 30),
  ];
  const kabel: SKabel[] = [
    vomBrett(w, 'A0', ['play', 'a'], F.play, 'Taste „Play/Pause“ (wie bisher)', ['cl-v16'], 'pause'),
    { von: ['play', 'b'], nach: ['pololu', 'A'], farbe: F.pbn, text: 'Taste „Play/Pause“, anderes Beinchen → Pololu A (statt an GND)', belege: ['oas-v35'] },
    vomBrett(w, 'D7', ['pololu', 'OFF'], LILA, 'Pololu OFF', ['oas-v34'], 'shutdown'),
    vomBrett(w, '5V', ['pololu', 'VOUT'], F.v5, `Pololu VOUT${brett ? '' : ' (nicht VIN!)'}`, ['oas-v32']),
    vomBrett(w, 'GNDa', ['pololu', 'GND'], F.gnd, 'Pololu GND', ['oas-v33']),
    { von: ['pb', '+ rot'], nach: ['pololu', 'VINr'], farbe: F.v5, text: 'Powerbank-Kabel Plus (rot) → Pololu VIN', belege: ['oas-v30'] },
    { von: ['pb', '− schwarz'], nach: ['pololu', 'GNDr'], farbe: F.gnd, text: 'Powerbank-Kabel Minus → Pololu GND', belege: ['oas-v31'] },
  ];
  return {
    id: 'pololu',
    titel: 'Ein/Aus mit Pololu-Schalter und Powerbank',
    kurz: 'Einschalten mit Play/Pause, die Box schaltet sich selbst ganz aus',
    text: [
      'Der Pololu-Schalter schaltet die Box mit der Play/Pause-Taste ein. Nach dem Ausschalt-Timer schaltet die Box sich selbst ganz aus.',
      'Nimm die LV-Version (Pololu Nr. 2808) und eine Powerbank ohne automatisches Abschalten.',
      'Das USB-Kabel der Powerbank aufschneiden: Rot ist Plus. Bei mehr als zwei Adern lieber nachmessen. Eine Feinsicherung (1 A) in der roten Ader wird im Forum empfohlen.',
      brett
        ? 'Der Strom kommt jetzt über den Punkt 5V der Audio-Leiste, nicht mehr über die USB-Buchse vom Nano. Prüfe mit dem Messgerät, ob dieser Punkt Durchgang zum Pin 5V am Nano hat.'
        : `Der Strom kommt jetzt über den Pin 5V am ${kurzName(w)}, nicht über die USB-Buchse. Nie an VIN.`,
    ],
    warnung: 'Beim Löten und Testen kein USB-Kabel im Nano: Sonst bekommt die Box weiter Strom, und du kannst das Ausschalten nicht prüfen.',
    teile: ['Pololu Mini Pushbutton Power Switch LV (Nr. 2808)', 'Powerbank ohne automatisches Abschalten', 'USB-Kabel zum Aufschneiden', 'Feinsicherung 1 A mit Halter (empfohlen)'],
    firmware: 'Keine eigene Firmware nötig: Die fertige Firmware für Classic und Nano Every schaltet D7 beim Ausschalten (TNG constants.hpp:602).',
    plan: { id: 'pololu', breite: 1000, hoehe: hoeheVon(teile), teile, kabel },
  };
}

function dauerled(w: LoetplanWahl): ExtraPlan {
  const teile: STeil[] = [
    ...stummel(w, ['5V', 'GNDa'], OBEN),
    widerstand('r120', '120 Ω', 420, 86),
    {
      id: 'led',
      name: 'LED weiß',
      x: 640,
      y: 50,
      w: 70,
      h: 110,
      farbe: '#eef4ff',
      schrift: '#000',
      form: 'led',
      pins: [
        { id: '+', txt: '+', seite: 'L', at: 36 },
        { id: '−', txt: '−', seite: 'L', at: 68 },
      ],
    },
  ];
  const kabel: SKabel[] = [
    vomBrett(w, '5V', ['r120', 'a'], F.v5, 'Widerstand 120 Ω', ['ohm-led']),
    { von: ['r120', 'b'], nach: ['led', '+'], farbe: F.v5, text: 'Widerstand 120 Ω → LED + (langes Bein)', belege: ['ohm-led'] },
    vomBrett(w, 'GNDa', ['led', '−'], F.gnd, 'LED − (kurzes Bein, flache Seite)', ['ohm-led']),
  ];
  return {
    id: 'dauerled',
    titel: 'Dauerlicht gegen das Abschalten der Powerbank',
    kurz: 'Eine LED, die immer leuchtet, damit die Powerbank in der Pause wach bleibt',
    text: [
      'Viele Powerbanks schalten ab, wenn die Box in der Pause wenig Strom braucht. Eine LED, die immer leuchtet, zieht etwa 17 mA und hält manche Powerbank wach.',
      'Nimm eine weiße oder blaue LED mit Widerstand 120 Ω. Das lange Beinchen ist Plus.',
      'Reicht das bei deiner Powerbank nicht, hilft eher eine andere Powerbank, ein Netzteil oder der Pololu-Schalter mit Akku.',
      'Die LED verhindert auch, dass die Powerbank abschaltet, wenn die Box schläft. Mit Pololu-Schalter brauchst du sie nicht.',
    ],
    warnung: 'Keine rote oder gelbe LED mit 120 Ω: Durch die fließt zu viel Strom.',
    teile: ['LED 5 mm, weiß oder blau', 'Widerstand 120 Ω, ¼ W', '2 Kabel'],
    firmware: 'Keine Firmware nötig: Die LED leuchtet, sobald die Box Strom hat.',
    hilfe: { href: '#/hilfe/powerbank', label: 'Die Powerbank schaltet ab' },
    plan: { id: 'dauerled', breite: 1000, hoehe: hoeheVon(teile), teile, kabel },
  };
}

function lsaus(w: LoetplanWahl): ExtraPlan {
  return {
    id: 'lsaus',
    titel: 'Kein Knacken beim Ein- und Ausschalten',
    kurz: 'Lautsprecher erst nach dem Start einschalten (SPKONOFF)',
    text: [
      'Die Firmware kann dafür D6 schalten (Einstellung SPKONOFF, TNG constants.hpp:284): D6 HIGH heißt Lautsprecher an. Bei der AiO und AiO+ ist das schon eingebaut.',
      'Dazwischen gehört eine Schaltung, die die Lautsprecherkabel trennt (Relais oder MOSFET). Für den Nano ist sie noch nicht belegt; im Bild ist sie ein Kasten mit „?“.',
      D6_WARNING,
    ],
    warnung: '',
    plan: null,
    teile: ['Schaltung zum Stummschalten (Relais oder MOSFET), noch nicht belegt'],
    firmware:
      w.nano === 'every'
        ? 'TonUINO_Every_5f hat es schon eingeschaltet, sonst eine eigene Fassung mit SPKONOFF. Nicht zusammen mit LED-Tasten (beide D6).'
        : BAUKASTEN('Lautsprecher stumm', 'Nicht zusammen mit „Leuchtende Tasten“: Beide brauchen D6.'),
    fehlt: {
      warum: 'Der MP3-Player hat keinen Eingang zum Stummschalten. Eine Schaltung gibt es nur für den ESP32 (Forum 14972), nicht für den Nano (Notiz oas-v29: unsicher).',
      beweis: 'Ein Schaltplan oder Forumsbericht mit TNG, der zeigt, was an D6 hängt (zum Beispiel ein Verstärker mit Ein/Aus-Eingang), am besten mit Foto.',
    },
  };
}

function hperkennung(w: LoetplanWahl): ExtraPlan {
  return {
    id: 'hperkennung',
    titel: 'Kopfhörer erkennen',
    kurz: 'Eigene Lautstärke für Kopfhörer (HPJACKDETECT)',
    text: [
      'Die Firmware liest dafür D8 (TNG constants.hpp:303): D8 an GND heißt „kein Kopfhörer“, D8 offen heißt „Kopfhörer steckt“. Dann gelten eigene Lautstärke-Grenzen.',
      'Die Kopfhörerplatine (G, DR, DL, SK, SK) hat dafür keinen Kontakt. Du brauchst eine Buchse mit Schaltkontakt, zum Beispiel PJ-307: Pin 6 (JD) kommt an D8 (Forum 13613).',
      'Achtung: Das TNG-Wiki und die Platine „Easy Headphone“ beschreiben es umgekehrt. Mit TNG gilt: ohne Stecker an GND, mit Stecker offen.',
      'Für den Lautsprecher allein brauchst du das nicht: Die Kopfhörerplatine schaltet ihn beim Einstecken selbst ab.',
    ],
    warnung: '',
    plan: null,
    teile: ['Kopfhörerbuchse mit Schaltkontakt (z. B. PJ-307)', '2 Kabel'],
    firmware: w.nano === 'every' ? 'TonUINO_Every_5f hat sie schon eingeschaltet, sonst eine eigene Fassung mit HPJACKDETECT.' : BAUKASTEN(HEADPHONES_TEXT.label),
    fehlt: {
      warum: 'Welcher Kontakt der Buchse ohne Stecker an GND liegt, steht nur in einem Bild (Forum 13613 #22). Pin 6 an D8 ist im Forum mit Erfolg berichtet.',
      beweis: 'Messgerät auf Durchgang. Ohne Stecker: Welcher Kontakt piept gegen GND? Stecker rein: Hört das Piepen auf? Dieser Kontakt gehört an D8. Danach im Box-Logbuch beim Einstecken auf „hpJackDetect: 1“ achten.',
    },
  };
}

/**
 * SPECIAL_START_SHORTCUT (constants.hpp:352–371, tonuino.cpp:136–151): A6,
 * active high, read once at the start, on the Classic with analogRead (512
 * and up is high), on the Every with digitalRead; the pin is an input
 * without pull-up (gpioHelper.hpp:21). How the alarm clock drives A6 and
 * switches the box on is in no source: only the facts, no picture.
 */
function wecker(w: LoetplanWahl): ExtraPlan {
  const every = w.nano === 'every';
  return {
    id: 'wecker',
    titel: ALARM_TEXT.label,
    kurz: 'Schaltet ein Wecker die Box ein, spielt sie Ordner 01 (SPECIAL_START_SHORTCUT)',
    text: [
      'Die Firmware schaut beim Einschalten ein einziges Mal auf A6 (TNG constants.hpp:365, tonuino.cpp:136–151). Ist A6 dann „high“, spielt die Box Titel 1 aus Ordner 01 statt der Begrüßung.',
      every
        ? 'Der Nano Every liest A6 als gewöhnlichen Eingang: 5 V an A6 zählen als „high“.'
        : 'Der Nano misst A6 dafür: Ab dem Messwert 512 von 1023 zählt es als „high“, also ab etwa 2,5 V bei 5 V Betriebsspannung.',
      'Nach dem Start schaut die Firmware nicht mehr auf A6: Der Wecker muss A6 schon hochhalten, wenn die Box angeht.',
      'Die Firmware schaltet an A6 keinen Pull-up-Widerstand ein (gpioHelper.hpp:21). Darum kommt ein Widerstand 100 kΩ von A6 an GND, sonst spielt die Box zufällig den Weckton (TNG-Autor, Forum 13947 #2).',
    ],
    warnung: '',
    plan: null,
    teile: ['Widerstand 100 kΩ', 'Wecker mit Schaltausgang'],
    firmware: every ? EVERY_SELBST('SPECIAL_START_SHORTCUT', w) : BAUKASTEN(ALARM_TEXT.label, 'Steht dort unter „Mehr“ und geht nur ohne Licht, „Lautsprecher stumm“ und Kopfhörer-Erkennung.'),
    fehlt: {
      warum:
        'Wie der Wecker A6 hochzieht und dabei die Box einschaltet, steht nirgends: TNG nennt nur einen „externen Wecker mit Signalausgang“. Der Widerstand 100 kΩ nach GND ist belegt.',
      beweis: 'Hast du einen Wecker mit Schaltausgang? Ein Foto seiner Anschlüsse und ein Bericht mit TNG würden helfen.',
    },
  };
}

const SCHALTER_FRAGE: NonNullable<ExtraPlan['frage']>['optionen'] = [
  { wert: 2, titel: '2 Beinchen', text: 'Ein einfacher Ein/Aus-Schalter, ohne Licht.' },
  { wert: 3, titel: '3 Beinchen', text: 'Ein Umschalter. Du brauchst davon nur zwei.' },
  { wert: 4, titel: '4 Beinchen', text: 'Oft ein Schalter mit Licht.' },
];

const USB_FARBEN: [string, string][] = [
  ['Rot', '+5 V: nur diese Ader geht durch den Schalter'],
  ['Schwarz', 'Minus (GND): bleibt ganz'],
  ['Grün und Weiß', 'Daten, zum Aufspielen der Firmware: nicht anfassen'],
];

/**
 * A plain on/off switch in the power line (forum 14673): the USB cable from
 * the power bank is cut open and only its red wire runs through the switch.
 * The switch type is asked first (2, 3 or 4 legs): an LED switch is wired
 * differently, and someone with a 2-leg switch got lost in guides for those.
 */
function schalter(w: LoetplanWahl): ExtraPlan {
  const pins = w.schalter;
  const basis = {
    id: 'schalter' as const,
    titel: 'Ein/Aus-Schalter',
    kurz: 'Ein Schalter im Stromkabel: Die Box ist ganz aus',
    warnung: 'Schneide nicht den Stecker am Nano ab und löte das Kabel an 5V und GND: Dann fehlen Grün und Weiß, und du kannst keine Firmware mehr aufspielen. Schneide das Kabel in der Mitte auf.',
    teile: ['Schalter', 'USB-Kabel zum Aufschneiden (Powerbank zur Box)', 'Schrumpfschlauch'],
    firmware: 'Keine eigene Firmware nötig.',
    frage: { text: 'Wie viele Beinchen hat dein Schalter?', optionen: SCHALTER_FRAGE, ...(pins ? { gewaehlt: pins } : {}) },
    tabelle: { titel: 'Die Adern im USB-Kabel', kopf: ['Farbe', 'Was sie tut'] as [string, string], zeilen: USB_FARBEN },
    links: [
      { href: 'https://bluetchen.de/FSU/TonUINO_FSU.html', label: 'TonUINO-Kompendium: Stromversorgung' },
      { href: 'https://discourse.voss.earth/t/usb-kabel-aufdroesseln-um-schalter-einzubauen/952/9', label: 'Forum: USB-Kabel für den Schalter aufdröseln (mit Foto)' },
    ],
  };
  const akkuText =
    'Mit Akku statt Powerbank (Battery Shield): Nimm nur ein Shield mit 5-V-Ausgang (Aufdruck GND und 5V). Ein Shield mit 12 V (Aufdruck + und −) zerstört Nano und MP3-Player. GND kommt an GND, 5V an 5V der Box, der Schalter in die Plus-Leitung. Prüfe die Polung vorher mit dem Messgerät.';
  if (!pins) return { ...basis, text: ['Schaue dir deinen Schalter an und zähle die Beinchen. Dann zeige ich dir, wie er angeschlossen wird.'], plan: null };
  if (pins === 4) {
    return {
      ...basis,
      text: [
        'Bei 4 Beinchen sind meist zwei für den Schalter und zwei für sein Licht. Welche welche sind, steht auf dem Schalter oder in seiner Beschreibung.',
        'Für den Schalter gilt dasselbe wie bei 2 Beinchen: Nur die rote Ader geht hindurch.',
        akkuText,
      ],
      plan: null,
      fehlt: {
        warum: 'Schalter mit 4 Beinchen sind je nach Modell anders belegt, und das Licht braucht zusätzlich Minus. Eine geprüfte Anleitung für einen bestimmten Schalter gibt es noch nicht.',
        beweis: 'Ein Foto oder Datenblatt deines Schalters mit der Beschriftung der Beinchen (zum Beispiel „+“, „−“ oder „Lamp“) und ein Bericht aus dem Forum, dass es so an einer TonUINO-Box läuft.',
      },
    };
  }
  const teile: STeil[] = [
    {
      id: 'pb',
      name: 'Powerbank',
      x: 30,
      y: 60,
      w: 220,
      h: 150,
      farbe: '#4a4a4a',
      notiz: ['USB-Kabel, Ende zur Powerbank'],
      pins: [{ id: 'rot', txt: '+ rot', seite: 'R', at: 90 }],
    },
    {
      id: 'sw',
      name: pins === 2 ? 'Schalter (2 Beinchen)' : 'Umschalter (3 Beinchen)',
      x: 400,
      y: 60,
      w: 200,
      h: 150,
      farbe: '#2a6db0',
      pins:
        pins === 2
          ? [
              { id: '1', txt: '1', seite: 'L', at: 90 },
              { id: '2', txt: '2', seite: 'R', at: 90 },
            ]
          : [
              { id: 'M', txt: 'Mitte', seite: 'L', at: 90 },
              { id: 'A', txt: 'außen', seite: 'R', at: 60 },
              { id: 'B', txt: 'außen', seite: 'R', at: 120 },
            ],
    },
    {
      id: 'box',
      name: 'Zur Box',
      x: 750,
      y: 60,
      w: 220,
      h: 150,
      farbe: '#4a4a4a',
      notiz: ['USB-Kabel, Ende zur Box'],
      pins: [{ id: 'rot', txt: '+ rot', seite: 'L', at: 90 }],
    },
  ];
  const kabel: SKabel[] =
    pins === 2
      ? [
          { von: ['pb', 'rot'], nach: ['sw', '1'], farbe: F.v5, text: 'Rote Ader vom Ende zur Powerbank → Schalter, ein Beinchen', belege: ['schalter-rot'] },
          { von: ['sw', '2'], nach: ['box', 'rot'], farbe: F.v5, text: 'Schalter, anderes Beinchen → rote Ader vom Ende zur Box', belege: ['schalter-rot'] },
        ]
      : [
          { von: ['pb', 'rot'], nach: ['sw', 'M'], farbe: F.v5, text: 'Rote Ader vom Ende zur Powerbank → Umschalter, mittleres Beinchen', belege: ['schalter-rot', 'schalter-mitte'] },
          { von: ['sw', 'A'], nach: ['box', 'rot'], farbe: F.v5, text: 'Umschalter, ein äußeres Beinchen → rote Ader vom Ende zur Box', belege: ['schalter-rot', 'schalter-mitte'] },
        ];
  const frei: ListenKabel[] = [
    { farbe: null, text: 'Schwarz, Grün und Weiß: nicht durchschneiden, sie bleiben ganz', belege: ['schalter-rot'] },
    ...(pins === 3 ? [{ farbe: null, text: 'Das andere äußere Beinchen bleibt frei', belege: ['schalter-mitte'] as BelegId[] }] : []),
  ];
  return {
    ...basis,
    text: [
      'Schneide das USB-Kabel zwischen Powerbank und Box in der Mitte vorsichtig auf. Durchtrenne nur die rote Ader.',
      pins === 2 ? 'Löte die zwei Enden der roten Ader an die zwei Beinchen des Schalters. Welches an welches, ist egal.' : 'Löte das Ende von der Powerbank an das mittlere Beinchen und das Ende zur Box an ein äußeres. In der anderen Stellung ist die Box aus.',
      'Isoliere die Lötstellen mit Schrumpfschlauch. Prüfe danach: Schalter an, Box geht an. Schalter aus, Box ist aus.',
      akkuText,
    ],
    plan: { id: 'schalter', breite: 1000, hoehe: 280, teile, kabel, frei },
  };
}

function akkumessung(): ExtraPlan {
  return {
    id: 'akkumessung',
    titel: 'Akku-Anzeige',
    kurz: 'Die Box warnt, wenn der Akku leer wird',
    text: [
      'Die Firmware misst dafür an A5 über einen Spannungsteiler aus zwei Widerständen 100 kΩ (TNG constants.hpp:405, 415): einer von A5 an GND, einer von A5 an Plus der Akku-Zelle. Für die Classic steht im Quelltext: „nicht empfohlen“.',
      'Gemessen wird an der Zelle, nicht hinter dem Wandler auf 5 V (TNG-Wiki, Forum 13947).',
      'Nicht zusammen mit „Tasten mit LED“: Deren Play/Pause-LED hängt auch an A5 (constants.hpp:508).',
      'Bei der AiO+ ist die Messung schon eingebaut.',
      'Heute bringt das Löten allein nichts: Erst eine Firmware mit Akku-Messung warnt. Läuft sie, gleichst du die Messung im Box-Logbuch ab („Akku-Messung abgleichen“, oben rechts, solange die Box verbunden ist).',
    ],
    warnung: '',
    plan: null,
    teile: ['2 Widerstände 100 kΩ', 'Akku mit Lade- und Schutzschaltung'],
    firmware:
      'Keine fertige Firmware hat das, auch der Firmware-Baukasten der App nicht. Du brauchst eine eigene Fassung mit BAT_VOLTAGE_MEASUREMENT. Nimm dafür nicht TonUINO TNG vom 26.10.2026: Es rechnet die Messung auf Classic, Nano Every und AiO+ falsch, die Box hält den Akku dann für leer und geht aus.',
  };
}

function usbc(w: LoetplanWahl): ExtraPlan {
  return {
    id: 'usbc',
    titel: 'USB-C-Buchse',
    kurz: 'Strom über eine USB-C-Buchse in der Gehäusewand',
    text: [
      'Eine USB-C-Buchse auf einer kleinen Platine: VBUS an 5V, GND an GND. CC1 und CC2 brauchen je einen Widerstand 5,1 kΩ nach GND, sonst liefern viele USB-C-Netzteile keinen Strom (USB-C-Norm). Viele kleine Buchsen-Platinen haben sie schon: Aufdruck „5.1k“ suchen.',
      'Die Datenleitungen gehen nicht zum Nano: Firmware aufspielen weiter über die Buchse am Nano.',
      `Hat dein ${w.nano === 'every' ? 'Nano Every' : 'Nano'} selbst eine USB-C-Buchse, ändert das an der Verdrahtung nichts: Löte jeden Pin nach dem Aufdruck auf dem Arduino, nicht nach seiner Lage.`,
    ],
    warnung: 'Nie zugleich ein Kabel im Nano und in der USB-C-Buchse: Dann kommen zwei Netzteile zusammen.',
    plan: null,
    teile: ['USB-C-Buchse auf kleiner Platine (mit 5,1 kΩ an CC1 und CC2)', 'USB-C-Netzteil 5 V', '2 Kabel'],
    firmware: 'Keine Firmware nötig.',
  };
}

/** Battery on the Classic: cell, charger with protection, switch and step-up to 5 V (forum 744, recherche-extras.md 1). */
function akkuClassic(w: LoetplanWahl): ExtraPlan {
  return {
    id: 'akku',
    titel: 'Akku statt Powerbank',
    kurz: 'Akku mit Ladeplatine und Wandler auf 5 V',
    text: [
      'Akku + an B+, Akku − an B− des Lademoduls (mit Schutzschaltung, z. B. TP4056).',
      'OUT+ des Lademoduls über den Schalter an IN+ des Wandlers, OUT− an IN−.',
      `Den Wandler vorher mit dem Messgerät auf 5 V einstellen. Dann OUT+ an 5V und OUT− an GND der Audio-Leiste${w.nano === 'every' ? '' : ''}.`,
      'Geladen wird über die USB-Buchse des Lademoduls. Kein Kabel im Nano, wenn der Akku dran ist.',
      'Module unterscheiden sich: nach dem Aufdruck löten.',
    ],
    warnung: 'Nur Akkus mit Schutzschaltung. Laden nur unter Aufsicht, nicht über Nacht.',
    plan: null,
    teile: ['Akku, 1 Zelle, mit Schutzschaltung', 'Lademodul mit Schutz (TP4056)', 'Wandler auf 5 V (Step-Up)', 'Schalter', '6 Kabel'],
    firmware: 'Für den Akku allein keine eigene Firmware nötig.',
    links: [{ href: 'https://discourse.voss.earth/t/tutorial-bau-dir-deine-eigene-powerbank/744', label: 'Forum: Tutorial zur eigenen Powerbank' }],
  };
}

/* ------------------------------------------------------------------ extras on the AiO and AiO+ */

function ringAio(): ExtraPlan {
  const teile: STeil[] = [
    {
      id: 'diverse',
      name: 'AiO-Platine',
      notiz: ['Leiste „Diverse“'],
      x: 30,
      y: OBEN,
      w: STUMMEL_W,
      h: 56 + 7 * PITCH + 30,
      farbe: AIO,
      pins: pins('R', 56, PITCH, ['GND', 'A7', 'A6', 'D5', 'RX', 'TX', '3V3', '5V']),
    },
    widerstand('r470', '470 Ω', 430, 170),
    ringTeil(640, 40, ['GND', 'DIN', '5V']),
    elko(560, 330, 'links'),
  ];
  const kabel: SKabel[] = [
    { von: ['diverse', 'D5'], nach: ['r470', 'a'], farbe: BLAU, text: 'AiO D5 (Leiste „Diverse“) → Widerstand 470 Ω', belege: ['aio-neo-d5'], tng: { platine: 'aio', funktion: 'ring', pin: 'D5' } },
    { von: ['r470', 'b'], nach: ['ring', 'DIN'], farbe: BLAU, text: 'Widerstand 470 Ω → LED-Ring DIN (Daten rein)', belege: ['neo-widerstand'] },
    { von: ['diverse', 'GND'], nach: ['ring', 'GND'], farbe: F.gnd, text: 'AiO GND (Leiste „Diverse“) → LED-Ring GND', belege: ['aio-neo-d5'] },
    { von: ['diverse', '5V'], nach: ['ring', '5V'], farbe: F.v5, text: 'AiO 5V (Leiste „Diverse“) → LED-Ring 5V', belege: ['aio-neo-d5'] },
    { von: ['elko', '+'], nach: ['ring', '5V'], farbe: F.v5, text: 'Elko Plus (langes Bein) → LED-Ring 5V', belege: ['cl-neo-elko'] },
    { von: ['elko', '−'], nach: ['ring', 'GND'], farbe: F.gnd, text: 'Elko Minus (Streifen) → LED-Ring GND', belege: ['cl-neo-elko'] },
  ];
  return {
    ...RING_BASE,
    text: [
      ...RING_BASE.text,
      'An der AiO kommt der Ring an die Leiste „Diverse“: D5, 5V und GND. Die Leiste ist beschriftet: nach dem Aufdruck löten.',
      'Die AiO gibt die Daten mit 3,3 V aus, knapp unter dem, was der Ring laut Datenblatt verlangt. Im Forum wird er so angeschlossen (Thema 11634).',
    ],
    firmware: 'Für die AiO gibt es keine fertige Firmware mit LED-Ring: Er passt nicht mehr in ihren Speicher, darum hat ihn auch der Firmware-Baukasten der App nicht. Löte den Ring erst, wenn du eine passende Firmware (mit NEO_RING) hast.',
    plan: { id: 'ring', breite: 1000, hoehe: hoeheVon(teile), teile, kabel, frei: [{ farbe: null, text: 'LED-Ring DOUT (Daten raus) bleibt frei', belege: ['cl-neo-din'] }] },
  };
}

function ringAioPlus(w: LoetplanWahl): ExtraPlan {
  const teile: STeil[] = [
    {
      id: 'leiste',
      name: 'AiO+-Platine',
      notiz: ['Erweiterungsleiste'],
      x: 30,
      y: OBEN,
      w: STUMMEL_W,
      h: 130,
      farbe: AIO,
      pins: [{ id: 'PB2', txt: 'PB2', seite: 'R', at: 100 }],
    },
    {
      id: 'adapter',
      name: 'Button-Adapter',
      notiz: ['LED-Anschluss'],
      x: 30,
      y: 220,
      w: STUMMEL_W,
      h: 190,
      farbe: ADAPTER,
      pins: pins('R', 90, PITCH, ['WS', '5V', 'GND']),
    },
    widerstand('r470', '470 Ω', 430, 130),
    ringTeil(640, 40, ['DIN', '5V', 'GND']),
    elko(470, 380),
  ];
  const kabel: SKabel[] = [
    { von: ['leiste', 'PB2'], nach: ['r470', 'a'], farbe: BLAU, text: 'AiO+ PB2 (Erweiterungsleiste) → Widerstand 470 Ω', belege: ['ap-ring-din'], tng: { platine: 'aioplus', funktion: 'ring', pin: 'PB2' } },
    { von: ['r470', 'b'], nach: ['ring', 'DIN'], farbe: BLAU, text: 'Widerstand 470 Ω → LED-Ring DIN (Daten rein)', belege: ['neo-widerstand'] },
    { von: ['adapter', '5V'], nach: ['ring', '5V'], farbe: F.v5, text: 'Button-Adapter 5V (LED-Anschluss) → LED-Ring 5V', belege: ['ap-ring-pwr'] },
    { von: ['adapter', 'GND'], nach: ['ring', 'GND'], farbe: F.gnd, text: 'Button-Adapter GND (LED-Anschluss) → LED-Ring GND', belege: ['ap-ring-pwr'] },
    { von: ['elko', '+'], nach: ['ring', '5V'], farbe: F.v5, text: 'Elko Plus (langes Bein) → LED-Ring 5V', belege: ['cl-neo-elko'] },
    { von: ['elko', '−'], nach: ['ring', 'GND'], farbe: F.gnd, text: 'Elko Minus (Streifen) → LED-Ring GND', belege: ['cl-neo-elko'] },
  ];
  return {
    ...RING_BASE,
    text: [
      ...RING_BASE.text,
      'Die Daten kommen an PB2 der Erweiterungsleiste, nicht an WS am Button-Adapter: WS benutzt TNG nicht.',
      'Wo PB2 auf der Leiste sitzt, ist nirgends beschrieben. Suche den Aufdruck auf deiner Platine, bevor du lötest.',
      'Strom und Masse holst du vom LED-Anschluss am Button-Adapter. Halte die Helligkeit niedrig: Wie viel Strom dieser Anschluss verträgt, ist nicht bekannt.',
    ],
    firmware:
      w.tasten === 5
        ? 'Fertig dabei: Wähle unter „Firmware aufspielen“ die AiO+ und „5 Tasten mit allen Extras“ (ALLinONE_Plus_5f). Darin ist der LED-Ring schon eingeschaltet.'
        : `Fertig gibt es den Ring für die AiO+ nur mit 5 Tasten: „5 Tasten mit allen Extras“ (ALLinONE_Plus_5f). Für 3 Tasten: ${AIOPLUS_SELBST('NEO_RING')}`,
    plan: {
      id: 'ring',
      breite: 1000,
      hoehe: hoeheVon(teile),
      teile,
      kabel,
      frei: [
        { farbe: null, text: 'Button-Adapter WS bleibt frei (TNG nutzt PB2)', belege: ['ap-ring-din'] },
        { farbe: null, text: 'LED-Ring DOUT (Daten raus) bleibt frei', belege: ['cl-neo-din'] },
      ],
    },
  };
}

/**
 * Why the app has no AiO+ firmware with extras: its ATmega4809 is neither in
 * the avr-gcc the Baukasten builds with nor in the box simulator (simavr) that
 * checks every build (docs/FIRMWARE-BAUKASTEN.md). Unchecked firmware it does not offer.
 */
const AIOPLUS_SELBST = (define: string) =>
  `Baue sie selbst mit PlatformIO (${define} einschalten) und spiele sie unter „Firmware aufspielen“ → „Eigene Datei“ auf. TonUINO Studio kann für den Chip der AiO+ (ATmega4809) noch keine Firmware bauen und vorher prüfen, darum bietet es dafür keine an.`;

function knopfAio(w: LoetplanWahl, id: 'drehgeber' | 'poti'): ExtraPlan {
  const plus = w.platine === 'aioplus';
  const dreh = id === 'drehgeber';
  const base = {
    id,
    titel: dreh ? 'Drehknopf für die Lautstärke' : 'Lautstärke-Regler mit Anschlag (Poti)',
    kurz: dreh ? 'Endlos-Drehknopf (KY-040) für lauter und leiser' : 'Drehregler wie am Radio: links leise, rechts laut',
    warnung: '+ nur an 3,3 V: Die Platine arbeitet mit 3,3-V-Pegeln.',
    plan: null,
    teile: dreh ? ['Drehknopf-Modul KY-040 (kleine Platine mit 5 Anschlüssen)', '4 Kabel'] : ['Poti 10 kΩ mit 3 Beinchen', '3 Kabel'],
    firmware: plus
      ? `Fertige Firmware mit ${dreh ? 'Drehknopf' : 'Poti'} gibt es für die AiO+ noch nicht. ${AIOPLUS_SELBST(dreh ? 'ROTARY_ENCODER' : 'POTI')}`
      : BAUKASTEN(knopfName(dreh ? 'encoder' : 'poti'), 'Geht nur mit 3 Tasten.'),
  };
  if (!plus && w.tasten === 5)
    return {
      ...base,
      text: [],
      gesperrt: dreh
        ? 'Geht nur mit 3 Tasten: TNG nutzt dafür A3 und A4, die bei 5 Tasten „Leiser“ und „Lauter“ sind (constants.hpp:209–210, 705–706).'
        : 'Geht nur mit 3 Tasten: TNG nutzt dafür A3, das bei 5 Tasten „Leiser“ ist (constants.hpp:232, 706).',
    };
  if (plus)
    return {
      ...base,
      text: dreh
        ? ['CLK kommt an PF2, DT an PF3 der OPT-Leiste (TNG constants.hpp:201–202, Pintabelle der Leiterkartenpiraten). Wo die beiden auf der Leiste sitzen: nach dem Aufdruck.', '+ an 3,3 V, nicht an 5 V: TNG schaltet keine eigenen Widerstände ein (constants.hpp:214), das Modul braucht +.']
        : ['Die Mitte des Potis kommt an PF4 der OPT-Leiste (TNG constants.hpp:226, Pintabelle der Leiterkartenpiraten).', 'Die AiO+ misst mit 2,5 V: An 3,3 V ist ab etwa drei Vierteln des Drehwegs schon „ganz laut“. Das schadet nicht.'],
      fehlt: {
        warum: 'Woher 3,3 V und GND kommen, nennt nur ein Forumsbeitrag (14193 #1): die Stifte 3,3V, GND, 5V und WS am Button-Adapter. Die OPT-Leiste hat laut Pintabelle keinen Strom-Pin.',
        beweis: 'Wer eine AiO+ hat: ein Foto vom Button-Adapter von oben, oder Durchgang messen: Stift „3,3V“ am Button-Adapter gegen „3.3V“ am NFC-Adapter.',
      },
    };
  return {
    ...base,
    text: dreh
      ? [
          'CLK an V− (das ist A3), DT an V+ (A4) am Button-Adapter. So steht es in der Original-Firmware für die AiO (Lauter an A4, Leiser an A3) und in TNG (constants.hpp:209–210).',
          '+ an 3V3 der Leiste „Diverse“, GND an GND daneben oder am Button-Adapter. SW bleibt frei.',
          'Geht nur mit 3 Tasten: V− und V+ sind sonst Leiser und Lauter.',
        ]
      : [
          'Die Mitte an V− (A3) am Button-Adapter (TNG constants.hpp:232), die äußeren Beine an 3V3 und GND der Leiste „Diverse“.',
          'Die AiO misst mit 2,048 V: An 3,3 V ist ab gut der Hälfte des Drehwegs schon „ganz laut“. Abgeleitet, nicht ausprobiert. Besser ist der Drehregler.',
          'Geht nur mit 3 Tasten.',
        ],
  };
}

function akku(w: LoetplanWahl): ExtraPlan {
  const plus = w.platine === 'aioplus';
  const beleg: BelegId = plus ? 'ap-akku' : 'aio-akku';
  const teile: STeil[] = [
    {
      id: 'brett',
      name: plus ? 'AiO+-Platine' : 'AiO-Platine',
      x: 30,
      y: 60,
      w: 280,
      h: 160,
      farbe: AIO,
      pins: [
        { id: '+', txt: 'BATTERY + (11)', seite: 'R', at: 70 },
        { id: '−', txt: 'BATTERY − (11)', seite: 'R', at: 110 },
      ],
    },
    {
      id: 'akku',
      name: 'LiFePO4-Akku 3,2 V',
      x: 640,
      y: 50,
      w: 250,
      h: 170,
      farbe: '#2f6b3a',
      notiz: ['mit Schutzschaltung', 'Stecker JST-PH 2 mm'],
      pins: [
        { id: '+', txt: '+ rot', seite: 'L', at: 80 },
        { id: '−', txt: '−', seite: 'L', at: 120 },
      ],
    },
  ];
  const kabel: SKabel[] = [
    { von: ['akku', '+'], nach: ['brett', '+'], farbe: F.v5, text: 'Akku Plus (rot) → BATTERY, Seite mit +', belege: [beleg] },
    { von: ['akku', '−'], nach: ['brett', '−'], farbe: F.gnd, text: 'Akku Minus → BATTERY, andere Seite', belege: [beleg] },
  ];
  return {
    id: 'akku',
    titel: 'Akku',
    kurz: 'Die Box läuft ohne Kabel, geladen wird über USB-C',
    text: [
      'Den Akku nur einstecken: Stecker in BATTERY (Nr. 11). Geladen wird über die USB-C-Buchse.',
      'Vorher nachsehen: Das rote Kabel muss auf der Seite mit + liegen. Manche Akku-Stecker sind verdreht.',
      'Nur LiFePO4-Akkus mit einer Zelle (3,2 V), Rundzelle, mit Schutzschaltung. Keine LiPo- oder Flachzellen.',
      plus ? 'Die AiO+ misst die Akku-Spannung selbst und warnt, wenn er leer wird. Dafür musst du nichts löten.' : 'Laden nur unter Aufsicht.',
    ],
    warnung: 'Falsch herum eingesteckt kann der Akku die Platine beschädigen. Laden nur unter Aufsicht, nicht über Nacht.',
    teile: ['LiFePO4-Akku 3,2 V, eine Zelle, mit Schutzschaltung und Stecker JST-PH 2 mm'],
    firmware: 'Keine eigene Firmware nötig.',
    plan: { id: 'akku', breite: 1000, hoehe: 280, teile, kabel },
  };
}

/** Every extra that fits this board, in the order of EXTRAS: with its picture, or with why it is not drawn. */
export function extras(w: LoetplanWahl): ExtraPlan[] {
  const aioBoard = w.platine === 'aio' || w.platine === 'aioplus';
  const liste: ExtraPlan[] = aioBoard
    ? [knopfAio(w, 'drehgeber'), knopfAio(w, 'poti'), w.platine === 'aio' ? ringAio() : ringAioPlus(w), akku(w)]
    : [drehgeber(w), poti(w), ringClassic(w), ledtasten(w), schalter(w), pololu(w), dauerled(w), akkuClassic(w), lsaus(w), hperkennung(w), wecker(w), akkumessung(), usbc(w)];
  return liste.sort((a, b) => EXTRAS.indexOf(a.id) - EXTRAS.indexOf(b.id));
}

/** The extras chosen and possible with this choice. */
export function gewaehlteExtras(w: LoetplanWahl): ExtraPlan[] {
  return extras(w).filter((x) => w.extras.includes(x.id) && !x.gesperrt);
}

/** Both chosen extras want D6 (SPKONOFF and the LED of „Vor“, constants.hpp:284, 509): the warning above them, else undefined. */
export function d6Konflikt(w: LoetplanWahl): string | undefined {
  const ids = gewaehlteExtras(w).map((x) => x.id);
  return ids.includes('lsaus') && ids.includes('ledtasten') ? `„Tasten mit LED“ und „Kein Knacken beim Ein- und Ausschalten“ brauchen beide D6. ${D6_WARNING}` : undefined;
}

/** Both chosen extras want A5 (the LED of Play/Pause and the battery measurement, constants.hpp:405, 508): the warning above them, else undefined. */
export function a5Konflikt(w: LoetplanWahl): string | undefined {
  const ids = gewaehlteExtras(w).map((x) => x.id);
  return ids.includes('ledtasten') && ids.includes('akkumessung')
    ? '„Tasten mit LED“ und „Akku-Anzeige“ brauchen beide A5: Dort hängt die LED von Play/Pause, und dort misst die Firmware den Akku. Schließe an A5 nur eins davon an.'
    : undefined;
}

/** Which chosen extras another chosen one rules out (they share a pin). */
export function konflikte(w: LoetplanWahl): [ExtraId, ExtraId][] {
  const out: [ExtraId, ExtraId][] = [];
  for (const a of w.extras) for (const b of SCHLIESST_AUS[a] ?? []) if (w.extras.includes(b) && a < b) out.push([a, b]);
  return out;
}

/* ------------------------------------------------------------------ firmware */

/** The ready-made firmware for the board and buttons, and how it gets onto the box. */
export function firmwareText(w: LoetplanWahl): string {
  const v = w.tasten === 5 ? '5' : '3';
  if (w.platine === 'aio') return `Firmware: ${firmwareEnv('aio', v)}. Aufspielen in der Werkstatt unter „Firmware“.`;
  if (w.platine === 'aioplus') return `Firmware: ${firmwareEnv('aioplus', v)}. Aufspielen in der Werkstatt unter „Firmware“.`;
  if (w.nano === 'every') return `Firmware: ${firmwareEnv('every', v)}. Den Nano Every kann ich noch nicht bespielen: mit der Arduino IDE oder PlatformIO aufspielen.`;
  return `Firmware: ${firmwareEnv('classic', v)}. Aufspielen in der Werkstatt unter „Firmware“.`;
}

/* ------------------------------------------------------------------ what to do, in short */

export interface SchemaText {
  li: string[];
  warnung: string;
}

/** The short instructions under the picture of a board without its own board drawing. */
export function schemaText(w: LoetplanWahl): SchemaText {
  if (w.platine === 'frei') {
    const mcu = kurzName(w);
    const ton =
      w.kh === 'platine'
        ? 'Kopfhörerplatine: G an GND (Pin 7, zwischen SPK_1 und SPK_2), DR an DAC_R, DL an DAC_L, die beiden SK an SPK_1 und SPK_2. Der Lautsprecher kommt an „Speaker“ der Kopfhörerplatine.'
        : w.kh === 'buchse'
          ? 'Buchse FC68129: GND (Pin 7) an 1, DAC_L an 3, DAC_R an 4, SPK_1 an 5. Pin 7 der Buchse an den Lautsprecher, SPK_2 direkt an den Lautsprecher. Andere Buchsen sind anders nummeriert: vorher durchpiepen.'
          : 'Lautsprecher an SPK_1 und SPK_2 vom MP3-Player.';
    return {
      li: [
        'Alles wird mit Kabeln verbunden, ohne fertige Platine. Lochraster oder Steckbrett geht auch.',
        `Die Beinchen am ${mcu} sind beschriftet: nach dem Aufdruck löten, nicht nach der Lage im Bild.`,
        ...(w.nano === 'every' ? ['Der Nano Every wird genau wie der Nano verdrahtet: Die Firmware nutzt bei beiden dieselben Pins (TNG constants.hpp:549).'] : []),
        'Der MP3-Player hat meist keinen Aufdruck. Im Bild siehst du ihn von oben, also von der Seite mit dem SD-Karten-Schlitz. Die SD-Karte steckt rechts. Pin 1 (VCC) ist links unten und hat ein eckiges Lötauge. Gegenüber von 1 ist 16, gegenüber von 8 ist 9.',
        'Von unten, auf der Lötseite, ist der MP3-Player seitenverkehrt. Zähle die Pins dort immer vom eckigen Lötauge aus.',
        'D2 kommt an TX und D3 an RX, also über Kreuz. In die Leitung von D3 zu RX kommt ein Widerstand mit 1 kΩ.',
        'D4 an BUSY nicht vergessen: Ohne diese Leitung springt die Box nach wenigen Sekunden zum nächsten Titel.',
        'Alle Tasten teilen sich ein Masse-Kabel, von Taste zu Taste.',
        ton,
        `Strom über die USB-Buchse am ${mcu}: Netzteil oder Powerbank.`,
      ],
      warnung: 'Kartenleser nur an 3V3 (orange), 5 Volt machen ihn kaputt. Lautsprecher nie an GND.',
    };
  }
  const plus = w.platine === 'aioplus';
  return {
    li: [
      `Bei der ${plus ? 'AiO+' : 'AiO'} ist fast alles schon auf der Platine: MP3-Player, Verstärker, Kopfhörerbuchse und SD-Karten-Schlitz. Gelötet werden nur Tasten, Kartenleser und Lautsprecher.`,
      'Den Kartenleser nach Aufdruck 1:1 an den NFC-Adapter löten (SDA an SDA, 3.3V an 3.3V und so weiter), dann das Kabel einstecken.',
      'Play/Pause kommt an PBP und PBN. Die anderen Tasten an ihr Zeichen und an GND daneben.',
      ...(w.tasten === 3 ? ['Bei 3 Tasten bleiben V+ und V− frei.'] : []),
      'Netzteil: 5 Volt, 2 bis 3 Ampere, kein Schnellladegerät.',
      'Den Jumper auf dem Button-Adapter nach dem Aufspielen der Firmware abziehen, sonst reagieren die Tasten nicht.',
      `Nur die Firmware für die ${plus ? 'AiO+' : 'AiO'} aufspielen.`,
    ],
    warnung: 'Play/Pause nie an GND: Sonst lässt sich die Box nicht einschalten.',
  };
}
