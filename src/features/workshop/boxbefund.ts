/**
 * Box testen: what a line of the box's log means for the soldering, in
 * plain German, and which solder joint to check ("prüf diese Stelle").
 *
 * The lines are the ones of TonUINO TNG 3.3.3 (parsed by core/firmware/
 * logline.ts). Which joint belongs to which line:
 * - "Com to DFPlayer broken" (mp3.cpp:76): the box gets no answer from the MP3
 *   player. TNG talks to it on D2 (dfPlayer_receivePin, constants.hpp:585)
 *   and D3 (dfPlayer_transmitPin, :586); at the player that is TX (pin 3)
 *   and RX (pin 2) (DFPlayer Mini manual, pin table). On the Classic board
 *   those are traces, so the joints are the socket pins.
 * - "DfPl Err: n" (mp3.cpp:16): an error code of the MP3 player; 3, 4 and
 *   0x81–0x84 are transmission errors (same RX/TX line), 1 and 8 mean the
 *   SD card, 5 and 6 a missing file (explainDfPlayerError).
 * - "com to mfrc broken" (chip_card.cpp:266): the card reader does not answer
 *   on SPI at all. "Auth failed" / "MIFARE_Read failed": it saw a card but
 *   could not read it: the card, or the data lines SO/SI/SCK.
 * - "TonUINO Version …" while nobody restarted the box: the power was gone
 *   for a moment.
 * - "hpJackDetect: 1" (mp3.cpp:413): the box thinks headphones are in and
 *   switches the speaker off. TNG reads D8 (constants.hpp:303, active low
 *   with pull-up): D8 open counts as "headphones in".
 *
 * The joints are named like the print of the Classic v1.7 board; the
 * Lötplan draws a red ring around them (stellePunkt in loetplan.ts).
 */
import { explainDfPlayerError } from '../../core/firmware/logexplain';
import type { LogRecord } from '../../core/firmware/logline';
import type { Platine, Tasten } from './loetplan';

/** The parts of the box the test checks, also the parts of the drawn box. */
export type TeilId = 'usb' | 'strom' | 'tasten' | 'leser' | 'mp3' | 'lautsprecher' | 'kopfhoerer' | 'ring' | 'knopf' | 'akku';

export const TEIL_NAMEN: Record<TeilId, string> = {
  usb: 'USB-Verbindung',
  strom: 'Stromversorgung',
  tasten: 'Tasten',
  leser: 'Kartenleser in der Box',
  mp3: 'MP3-Player und SD-Karte',
  lautsprecher: 'Lautsprecher',
  kopfhoerer: 'Kopfhörer',
  ring: 'LED-Ring',
  knopf: 'Lautstärke-Knopf',
  akku: 'Akku',
};

/**
 * A solder joint, named after the print of the Classic v1.7 board:
 * "leiste:A1" (left row), "gnd:1" (ground column beside A0–A5, from A0),
 * "rfid:SO", "audio:+", "nano:D2" (socket of the Nano), "dfp:RX" (socket of
 * the MP3 player).
 */
export type StelleId = string;

export interface Befund {
  /** Same for the same problem, so it is listed once (with a count). */
  id: string;
  teil: TeilId;
  ton: 'warn' | 'fehler';
  titel: string;
  text: string;
  /** "Prüf diese Stelle": joints to check, most likely first. Empty when it is no solder joint (SD card, firmware). */
  stellen: StelleId[];
  /** First and last time, and how often. */
  at: number;
  zuletzt: number;
  anzahl: number;
  /** The line of the box it comes from. */
  zeile?: string;
}

export interface BefundKontext {
  platine: Platine;
  tasten: Tasten;
  /** During the Wackeltest: a card lies on the box, nobody touches it. */
  wackeln?: boolean;
  /** The user said there are no headphones in. */
  ohneKopfhoerer?: boolean;
}

type Neu = Omit<Befund, 'at' | 'zuletzt' | 'anzahl'>;

/** Every joint of the card-reader row except IRQ, power first. */
export const LESER_STELLEN: StelleId[] = ['rfid:3V3', 'rfid:GND', 'rfid:SDA', 'rfid:SCK', 'rfid:SI', 'rfid:SO', 'rfid:RST'];
const DATEN_STELLEN: StelleId[] = ['rfid:SO', 'rfid:SI', 'rfid:SCK'];
/** The line to the MP3 player: Nano D2/D3 and the player's TX/RX. */
export const MP3_STELLEN: StelleId[] = ['nano:D3', 'dfp:RX', 'nano:D2', 'dfp:TX'];
const STROM_STELLEN: StelleId[] = ['nano:5V', 'nano:GND'];

const AIO = (p: Platine) => p === 'aio' || p === 'aioplus';

/** Plain name of a joint, for the text next to the ring. */
export function stelleName(id: StelleId, platine: Platine = 'classic'): string {
  const [ort, pin] = id.split(':');
  switch (ort) {
    case 'leiste':
      return platine === 'frei' ? `${pin} am Nano` : `${pin} an der linken Leiste`;
    case 'gnd':
      return platine === 'frei' ? 'GND am Nano' : 'GND daneben';
    case 'rfid':
      return platine === 'frei' ? `${pin} am Kartenleser` : `${pin} an der Kartenleser-Leiste`;
    case 'audio':
      return `${pin} an der Audio-Leiste`;
    case 'nano':
      return `Beinchen ${pin} des Nano`;
    case 'dfp':
      return `${pin} am MP3-Player`;
    default:
      return id;
  }
}

/** "SO, SI und SCK an der Kartenleser-Leiste" for the text. */
export function stellenText(ids: StelleId[], platine: Platine = 'classic'): string {
  const names = ids.map((i) => stelleName(i, platine));
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

/** The pins of the buttons on the Classic and the Classic without board (TNG constants.hpp:549 ff., see tastenDerClassic). */
export function tastenPin(key: 'pause' | 'up' | 'down' | 'four' | 'five', tasten: Tasten): string {
  if (tasten === 5) return { pause: 'A0', four: 'A1', five: 'A2', up: 'A3', down: 'A4' }[key];
  return { pause: 'A0', up: 'A1', down: 'A2', four: 'A1', five: 'A2' }[key];
}

/** The joints of one button: its A pin and the ground beside it. */
export function tastenStellen(key: 'pause' | 'up' | 'down' | 'four' | 'five', ctx: Pick<BefundKontext, 'platine' | 'tasten'>): StelleId[] {
  if (AIO(ctx.platine)) return [];
  const pin = tastenPin(key, ctx.tasten);
  return [`leiste:${pin}`, `gnd:${Number(pin.slice(1))}`];
}

function mp3Leitung(platine: Platine): string {
  if (AIO(platine)) return 'Der MP3-Player ist auf der AiO fest verbaut, da gibt es nichts zu löten. Stecke die SD-Karte neu ein. Hilft das nicht, frage im Forum nach.';
  if (platine === 'frei') return 'Prüfe die Leitung zwischen Nano und MP3-Player: D3 des Nano über den 1-kΩ-Widerstand zu RX (Beinchen 2) und D2 zu TX (Beinchen 3). Prüfe auch 5V (VCC) und GND am MP3-Player.';
  return 'Auf der Platine sind das Leiterbahnen. Prüfe die Lötstellen an den Sockeln: D2 und D3 am Nano, RX (Beinchen 2) und TX (Beinchen 3) am MP3-Player. Steckt der MP3-Player richtig herum, Beinchen 1 am Aufdruck „1“?';
}

/** What a line means for the box, or null when it is no problem. */
export function befundAus(rec: LogRecord, ctx: BefundKontext): Neu | null {
  const aio = AIO(ctx.platine);
  switch (rec.kind) {
    case 'mp3-broken':
      return {
        id: 'mp3-weg',
        teil: 'mp3',
        ton: 'fehler',
        titel: 'Der MP3-Player antwortet nicht',
        text: `Die Box bekommt keine Antwort vom MP3-Player, darum spielt sie nichts. ${mp3Leitung(ctx.platine)}`,
        stellen: aio ? [] : MP3_STELLEN,
      };
    case 'mp3-error': {
      const e = explainDfPlayerError(rec.code);
      const leitung = rec.code === 3 || rec.code === 4 || (rec.code >= 0x81 && rec.code <= 0x84);
      if (e.level === 'info') return null;
      return {
        id: `mp3-fehler-${leitung ? 'leitung' : rec.code}`,
        teil: 'mp3',
        ton: e.level === 'error' ? 'fehler' : 'warn',
        titel: `MP3-Player: ${e.title}`,
        text: leitung ? `${e.explanation} Oft wackelt die Leitung zum MP3-Player. ${mp3Leitung(ctx.platine)}` : `${e.explanation}${e.fix ? ` ${e.fix}` : ''}`,
        stellen: leitung && !aio ? MP3_STELLEN : [],
      };
    }
    case 'rfid-broken':
      return {
        id: 'leser-weg',
        teil: 'leser',
        ton: 'fehler',
        titel: 'Der Kartenleser antwortet nicht',
        text: 'Die Box findet den Kartenleser nicht. Prüfe zuerst 3V3 und GND, dann SDA, SCK, SI (MOSI), SO (MISO) und RST. Jeder Anschluss muss zum gleichnamigen am Kartenleser gehen.',
        stellen: LESER_STELLEN,
      };
    case 'card-error':
      if (rec.op === 'write') return null;
      return {
        id: 'leser-lesefehler',
        teil: 'leser',
        ton: 'warn',
        titel: 'Karte bemerkt, aber nicht gelesen',
        text: 'Der Kartenleser hat eine Karte bemerkt, konnte sie aber nicht lesen. Probiere eine andere Karte. Passiert es mit jeder Karte, prüfe die Datenleitungen SO (MISO), SI (MOSI) und SCK zum Kartenleser.',
        stellen: DATEN_STELLEN,
      };
    case 'card':
      if (!ctx.wackeln || rec.event !== 'removed') return null;
      return {
        id: 'leser-karte-weg',
        teil: 'leser',
        ton: 'warn',
        titel: 'Der Kartenleser hat die Karte verloren',
        text: 'Hast du die Karte nicht bewegt? Dann war der Kartenleser kurz weg: Eine Lötstelle oder ein Kabel am Kartenleser wackelt. Klopfe noch einmal dort und schaue, ob es wieder passiert.',
        stellen: LESER_STELLEN,
      };
    case 'headphones':
      if (!rec.plugged || !ctx.ohneKopfhoerer) return null;
      return {
        id: 'kh-falsch',
        teil: 'lautsprecher',
        ton: 'fehler',
        titel: 'Die Box meint, ein Kopfhörer steckt',
        text: aio
          ? 'Darum schaltet sie den Lautsprecher stumm. Stecke einen Kopfhörer ein und ziehe ihn wieder ab. Bleibt es so, frage im Forum nach.'
          : 'Darum schaltet sie den Lautsprecher stumm. Deine Firmware fragt an D8, ob ein Kopfhörer steckt, und ist D8 nicht angeschlossen, meint sie: ja. Hast du keine Kopfhörer-Erkennung gelötet, spiele eine Firmware ohne sie auf. Hast du sie gelötet, prüfe die Leitung an D8.',
        stellen: aio ? [] : ['leiste:D8'],
      };
    case 'battery-empty':
      return {
        id: 'akku-leer',
        teil: 'akku',
        ton: 'warn',
        titel: 'Der Akku ist leer',
        text: 'Die Box misst einen leeren Akku und schaltet sich gleich aus. Lade ihn. Ist er voll und die Meldung kommt trotzdem, prüfe das Kabel zur Akku-Messung.',
        stellen: [],
      };
    default:
      return null;
  }
}

/** The box started while nobody restarted it. */
export function neustartBefund(ctx: BefundKontext): Neu {
  return {
    id: 'neustart',
    teil: 'strom',
    ton: 'fehler',
    titel: 'Die Box ist neu gestartet',
    text: ctx.wackeln
      ? 'Beim Klopfen war der Strom kurz weg. Prüfe 5V und GND: das USB-Kabel und die USB-Buchse, das Kabel zur Powerbank oder zum Akku und die Lötstellen an 5V und GND.'
      : 'Hast du sie nicht selbst neu gestartet, war der Strom kurz weg. Das passiert bei einem schwachen Netzteil, einem leeren Akku oder einem Wackelkontakt an 5V und GND.',
    stellen: AIO(ctx.platine) ? [] : STROM_STELLEN,
  };
}

/** The USB connection broke off while the box was being tapped. */
export function usbWegBefund(): Neu {
  return {
    id: 'usb-weg',
    teil: 'usb',
    ton: 'fehler',
    titel: 'Die USB-Verbindung ist abgerissen',
    text: 'Beim Klopfen ist die Verbindung zum Computer weggebrochen. Meist wackelt das USB-Kabel oder die USB-Buchse. Stecke das Kabel fest ein, probiere ein anderes und verbinde neu.',
    stellen: [],
  };
}

/** A list of findings, the same problem counted once. */
export class Befunde {
  private readonly map = new Map<string, Befund>();

  add(b: Neu, at: number, zeile?: string): Befund {
    const old = this.map.get(b.id);
    if (old) {
      old.zuletzt = at;
      old.anzahl++;
      return old;
    }
    const neu: Befund = { ...b, at, zuletzt: at, anzahl: 1, zeile };
    this.map.set(b.id, neu);
    return neu;
  }

  remove(id: string): void {
    this.map.delete(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  clear(): void {
    this.map.clear();
  }

  /** Errors first, then by time. */
  list(): Befund[] {
    return [...this.map.values()].sort((a, b) => (a.ton === b.ton ? a.at - b.at : a.ton === 'fehler' ? -1 : 1));
  }

  von(teil: TeilId): Befund[] {
    return this.list().filter((b) => b.teil === teil);
  }

  get size(): number {
    return this.map.size;
  }
}
