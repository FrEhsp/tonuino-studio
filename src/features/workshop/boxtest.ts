/**
 * Box testen: one guided test for a box that was just soldered, step by step
 * (BoxTestTool.tsx shows it). Pure logic: the page feeds the lines of the
 * Box-Logbuch connection and the user's answers, with the time.
 *
 *   verbinden → tasten → karte → ton → kopfhoerer → extras → wackeln → ergebnis
 *
 * What the box tells by itself (TonUINO TNG 3.3.3, see partstest.ts for the
 * details): every button press that does something ("btn/cmd: up/…"; right
 * after the start the box is idle, and there a short press of every button
 * does something, commands.cpp cmd_table), a card ("Card Ins", "CardData"),
 * a title it starts ("play 1-1"), the volume ("Volume: n", also when the knob
 * is turned), headphones ("hpJackDetect", only with HPJACKDETECT) and the
 * problems of boxbefund.ts. Whether sound comes out or the LED ring lights,
 * nobody logs: the user answers. The AiO board logs buttons only at debug
 * level and cards only from warning up, TonUINO 2.1 not at all in a form we
 * read: there the user answers for the buttons and the card too.
 */
import type { KnobKind } from '../../core/firmware/baukasten';
import { ExtrasLogWatcher } from '../../core/firmware/extraslog';
import { parseLogLine, type BoxButtons, type FirmwareFamily, type LogRecord } from '../../core/firmware/logline';
import type { BoardId } from '../../core/firmware/variants';
import { befundAus, Befunde, neustartBefund, tastenStellen, usbWegBefund, type Befund, type BefundKontext, type TeilId } from './boxbefund';
import type { LoetplanWahl, Platine, Tasten } from './loetplan';

export type BoxSchritt = 'verbinden' | 'tasten' | 'karte' | 'ton' | 'kopfhoerer' | 'extras' | 'wackeln' | 'ergebnis';
export const SCHRITT_NAMEN: Record<BoxSchritt, string> = {
  verbinden: 'Verbinden',
  tasten: 'Tasten',
  karte: 'Kartenleser',
  ton: 'Ton',
  kopfhoerer: 'Kopfhörer',
  extras: 'Extras',
  wackeln: 'Wackeltest',
  ergebnis: 'Ergebnis',
};

/** offen: not checked yet; aus: not in this box, or skipped. */
export type TeilStatus = 'offen' | 'ok' | 'fehler' | 'aus';

export type TastenKey = 'pause' | 'up' | 'down' | 'four' | 'five';
export const TASTEN_NAMEN: Record<TastenKey, string> = { pause: 'Play/Pause', up: 'Vor', down: 'Zurück', four: 'Lauter', five: 'Leiser' };

export interface Ausstattung {
  platine: Platine;
  tasten: Tasten;
  /** A headphone socket. */
  kopfhoerer: boolean;
  ring: boolean;
  knopf: boolean;
  /** Which knob, when the Lötplan knows it: tells a turn of the encoder from a button (extraslog.ts). */
  knopfArt?: KnobKind;
  akku: boolean;
}

/** What the Lötplan knows about the box: its choice is the best first guess. */
export function ausstattungAus(w: LoetplanWahl): Ausstattung {
  const aio = w.platine === 'aio' || w.platine === 'aioplus';
  return {
    platine: w.platine,
    tasten: w.tasten,
    kopfhoerer: aio || w.kh !== 'keine',
    ring: w.extras.includes('ring'),
    knopf: w.extras.includes('drehgeber') || w.extras.includes('poti'),
    knopfArt: w.extras.includes('drehgeber') ? 'encoder' : w.extras.includes('poti') ? 'poti' : undefined,
    akku: w.extras.includes('akkumessung') || w.extras.includes('akku'),
  };
}

export interface TasteStand {
  key: TastenKey;
  name: string;
  status: TeilStatus;
  /** The box reported another button when this one was asked for. */
  statt?: string;
  at?: number;
}

/** A line of the live list in the Wackeltest. */
export interface WackelEreignis {
  at: number;
  text: string;
  ton: 'ok' | 'warn' | 'fehler';
  befund?: string;
}

/** How long after connecting or "Box neu starten" a start of the box is expected. */
export const NEUSTART_MS = 8000;

const RAW_KEY: Record<string, TastenKey> = { pause: 'pause', up: 'up', down: 'down', four: 'four', five: 'five' };

export class BoxTest {
  schritt: BoxSchritt = 'verbinden';
  ausstattung: Ausstattung;
  readonly befunde = new Befunde();
  readonly wackelLog: WackelEreignis[] = [];
  firmware?: FirmwareFamily;
  board?: BoardId;
  buttons?: BoxButtons;
  verbunden = false;
  /** Lines from the box since the connection, so the page can say it talks. */
  zeilen = 0;
  /** The start of the box was seen (banner or hardware line). */
  gestartet = false;
  /** Last volume and when it came; knob: changed without a button. */
  lautstaerke?: number;
  lautstaerkeAt?: number;
  /** The box reported headphones in (true) or out (false); undefined without HPJACKDETECT. */
  kopfhoererGemeldet?: boolean;
  akkuVolt?: number;
  /** Card read (or a title started) in the card step. */
  karteGelesen = false;
  /** The box asked the MP3 player for a title. */
  titelGestartet?: string;
  wackelStart?: number;
  wackelEnde?: number;
  /** The button reported last, to light it in the drawing. */
  zuletztTaste?: { key: TastenKey; at: number };
  /** The user's answers to the questions only they can answer. */
  readonly antworten: Partial<Record<TeilId, boolean>> = {};

  private readonly status: Partial<Record<TeilId, TeilStatus>> = {};
  private readonly tastenStand = new Map<TastenKey, TasteStand>();
  /** Starts of the box until this time are expected: the connection and "Box neu starten" restart it, a Nano once or twice. */
  private neustartBis = -Infinity;
  /** The volume and its cause (start, knob, button, headphones): the firmware part's reading of the log. */
  private readonly extrasLog: ExtrasLogWatcher;
  private knopfStart?: number;

  constructor(ausstattung: Ausstattung) {
    this.ausstattung = { ...ausstattung };
    this.extrasLog = new ExtrasLogWatcher({ knob: ausstattung.knopfArt });
  }

  /* -------------------------------------------------------------- facts */

  get kontext(): BefundKontext {
    return {
      platine: this.ausstattung.platine,
      tasten: this.ausstattung.tasten,
      wackeln: this.schritt === 'wackeln' && this.wackelStart !== undefined && this.wackelEnde === undefined,
      ohneKopfhoerer: this.schritt !== 'kopfhoerer',
    };
  }

  /** The box logs button presses and cards in a form we read. */
  get liestTasten(): boolean {
    return this.firmware !== 'classic21' && this.board !== 'aio';
  }

  get liestKarten(): boolean {
    return this.firmware !== 'classic21';
  }

  /** The buttons of this box in the order the test asks for them. */
  tasten(): TasteStand[] {
    const keys: TastenKey[] = this.ausstattung.tasten === 5 ? ['pause', 'up', 'down', 'four', 'five'] : ['pause', 'up', 'down'];
    return keys.map((key) => this.tastenStand.get(key) ?? { key, name: TASTEN_NAMEN[key], status: 'offen' });
  }

  /** The button the test asks for now. */
  wantTaste(): TasteStand | undefined {
    return this.tasten().find((t) => t.status === 'offen');
  }

  /** The steps of this box; Kopfhörer only with a socket. */
  schritte(): BoxSchritt[] {
    const all: BoxSchritt[] = ['verbinden', 'tasten', 'karte', 'ton', 'kopfhoerer', 'extras', 'wackeln', 'ergebnis'];
    return all.filter((s) => s !== 'kopfhoerer' || this.ausstattung.kopfhoerer);
  }

  /** The parts of this box with their state, for the drawing and the result. */
  teile(): { id: TeilId; status: TeilStatus }[] {
    const a = this.ausstattung;
    const ids: TeilId[] = ['usb', 'strom', 'tasten', 'leser', 'mp3', 'lautsprecher'];
    if (a.kopfhoerer) ids.push('kopfhoerer');
    if (a.ring) ids.push('ring');
    if (a.knopf) ids.push('knopf');
    if (a.akku) ids.push('akku');
    return ids.map((id) => ({ id, status: this.teilStatus(id) }));
  }

  /**
   * What the result says about a part. A part that works but is named in a
   * hint below (the card dropped while knocking) says so, so "geht" does not
   * contradict the hint.
   */
  teilWort(id: TeilId): { wort: string; hinweis: boolean } {
    const s = this.teilStatus(id);
    if (s === 'fehler') return { wort: 'Problem', hinweis: false };
    if (s !== 'ok') return { wort: 'nicht getestet', hinweis: false };
    const hinweis = this.befunde.von(id).some((b) => b.ton === 'warn');
    return { wort: hinweis ? 'geht, Hinweis unten' : 'geht', hinweis };
  }

  teilStatus(id: TeilId): TeilStatus {
    if (this.befunde.von(id).some((b) => b.ton === 'fehler')) return 'fehler';
    if (id === 'tasten') {
      const t = this.tasten();
      if (t.some((x) => x.status === 'fehler')) return 'fehler';
      if (t.every((x) => x.status === 'ok')) return 'ok';
      return this.status.tasten ?? 'offen';
    }
    if (id === 'strom') return this.status.strom ?? (this.wackelEnde !== undefined ? 'ok' : 'offen');
    return this.status[id] ?? 'offen';
  }

  /** The part the current step is about, for the pulsing ring in the drawing. */
  teilJetzt(): TeilId | undefined {
    switch (this.schritt) {
      case 'verbinden':
        return 'usb';
      case 'tasten':
        return 'tasten';
      case 'karte':
        return 'leser';
      case 'ton':
        return this.titelGestartet ? 'lautsprecher' : 'mp3';
      case 'kopfhoerer':
        return 'kopfhoerer';
      case 'extras':
        return this.extraJetzt();
      default:
        return undefined;
    }
  }

  /** The extra still to check, in the order ring, knob, battery. */
  extraJetzt(): TeilId | undefined {
    const a = this.ausstattung;
    const extras: TeilId[] = [...(a.ring ? (['ring'] as const) : []), ...(a.knopf ? (['knopf'] as const) : []), ...(a.akku ? (['akku'] as const) : [])];
    return extras.find((id) => this.teilStatus(id) === 'offen');
  }

  /* -------------------------------------------------------------- input */

  /** What the Box-Logbuch already knows from the start of the box (opened on a live connection). */
  kennt(info: { firmware?: FirmwareFamily; board?: BoardId; buttons?: BoxButtons }): void {
    if (info.firmware) this.firmware = info.firmware;
    if (info.board) this.record({ kind: 'hardware', board: info.board, buttons: info.buttons ?? (this.ausstattung.tasten === 5 ? '5' : '3') }, 0);
    if (info.firmware || info.board) this.gestartet = true;
  }

  /** The port is open; opening it restarts most boxes. */
  verbindet(at: number): void {
    this.verbunden = true;
    this.neustartBis = at + NEUSTART_MS;
    this.status.usb = 'ok';
    this.befunde.remove('usb-weg');
  }

  /** The connection ended (cable pulled, box off, or the user disconnected). */
  getrennt(at: number, verloren: boolean): void {
    this.verbunden = false;
    if (verloren && this.kontext.wackeln) {
      const b = this.befunde.add(usbWegBefund(), at);
      this.wackelLog.push({ at, text: b.titel, ton: 'fehler', befund: b.id });
    }
  }

  /** The app restarts the box itself ("Box neu starten"): that start is no problem. */
  neustartAngestossen(at: number): void {
    this.neustartBis = at + NEUSTART_MS;
  }

  /** One line of the log. Returns true when something on the page changed. */
  zeile(line: string, at: number): boolean {
    this.zeilen++;
    const ev = this.extrasLog.push(line, at);
    if (ev?.kind === 'volume') this.lautstaerkeEreignis(ev.volume, ev.previous, ev.cause, at);
    const rec = parseLogLine(line);
    return rec ? this.record(rec, at, line) : this.schritt === 'wackeln';
  }

  record(rec: LogRecord, at: number, line?: string): boolean {
    const ctx = this.kontext;
    const befund = befundAus(rec, ctx);
    if (befund) {
      const b = this.befunde.add(befund, at, line);
      if (ctx.wackeln) this.wackelLog.push({ at, text: b.titel, ton: b.ton, befund: b.id });
    }
    switch (rec.kind) {
      case 'banner':
        this.firmware = rec.firmware;
        this.gestartet = true;
        if (at > this.neustartBis) {
          const b = this.befunde.add(neustartBefund(ctx), at, line);
          if (ctx.wackeln) this.wackelLog.push({ at, text: b.titel, ton: 'fehler', befund: b.id });
        }
        // The volume set at the start is no turn of the knob.
        this.lautstaerke = undefined;
        return true;
      case 'hardware':
        this.board = rec.board;
        this.buttons = rec.buttons;
        this.gestartet = true;
        if (rec.buttons === '5') this.ausstattung.tasten = 5;
        else if (rec.buttons === '3') this.ausstattung.tasten = 3;
        if (rec.board === 'aio' || rec.board === 'aioplus') this.ausstattung.platine = rec.board;
        else if (this.ausstattung.platine === 'aio' || this.ausstattung.platine === 'aioplus') this.ausstattung.platine = 'classic';
        return true;
      case 'button':
        return this.taste(rec.raw, at);
      case 'card':
        if (rec.event === 'inserted' && ctx.wackeln) this.wackelLog.push({ at, text: 'Karte wieder da', ton: 'ok' });
        return befund !== null || this.schritt === 'karte';
      case 'card-data':
      case 'card-bad-version':
        this.karteOk();
        return true;
      case 'play':
      case 'play-mp3':
      case 'play-advert':
        this.titelGestartet = rec.kind === 'play' ? `${rec.folder}-${rec.track}` : `Ansage ${rec.track}`;
        if (!this.befunde.von('mp3').some((b) => b.ton === 'fehler')) this.status.mp3 = 'ok';
        // On the AiO and with cards it cannot report, a title from a card says the reader works.
        if (this.schritt === 'karte' && rec.kind === 'play') this.karteOk();
        if (ctx.wackeln && this.wackelLog.length < 200) this.wackelLog.push({ at, text: `Titel ${this.titelGestartet} startet`, ton: 'ok' });
        return true;
      case 'volume':
        // Fed through lautstaerkeEreignis (zeile), which knows the cause.
        return true;
      case 'headphones':
        this.kopfhoererGemeldet = rec.plugged;
        // A change to "out" shows the detection works: the earlier "in" was a real plug.
        if (!rec.plugged) this.befunde.remove('kh-falsch');
        return true;
      case 'battery-voltage':
        this.akkuVolt = rec.volts;
        if (this.teilStatus('akku') === 'offen' && this.ausstattung.akku) this.status.akku = 'ok';
        return true;
      case 'rfid-broken':
        this.status.leser = 'fehler';
        return true;
      case 'mp3-broken':
        this.status.mp3 = 'fehler';
        return true;
      default:
        return befund !== null;
    }
  }

  /**
   * A volume from the box. A turn of the knob: what the firmware part calls
   * "knob", and while the test asks to turn the knob, any change not caused by
   * the start or the headphones (the AiO does not log the encoder's presses,
   * a Lötplan without a knob kind does not say which it is).
   */
  private lautstaerkeEreignis(volume: number, previous: number | undefined, cause: string, at: number): void {
    this.lautstaerke = volume;
    this.lautstaerkeAt = at;
    if (previous === undefined || previous === volume) return;
    const imKnopfSchritt = this.schritt === 'extras' && this.extraJetzt() === 'knopf' && cause !== 'start' && cause !== 'headphones';
    if (cause === 'knob' || imKnopfSchritt) this.knopfGedreht(at);
  }

  private knopfGedreht(at: number): boolean {
    if (!this.ausstattung.knopf) return false;
    if (this.knopfStart === undefined) this.knopfStart = at;
    if (this.teilStatus('knopf') === 'offen') this.status.knopf = 'ok';
    return true;
  }

  private karteOk(): void {
    this.karteGelesen = true;
    if (this.status.leser !== 'fehler') this.status.leser = 'ok';
    this.befunde.remove('leser-lesefehler');
    if (this.schritt === 'karte') this.weiter();
  }

  private taste(raw: string, at: number): boolean {
    const key = RAW_KEY[raw.replace(/(LongRepeat|Long)$/, '')];
    const ctx = this.kontext;
    if (raw === 'allLong' || raw === 'updownLong') {
      if (this.schritt !== 'tasten') return false;
      this.befunde.add(
        {
          id: 'tasten-zugleich',
          teil: 'tasten',
          ton: 'warn',
          titel: 'Mehrere Tasten zugleich gemeldet',
          // updownLong is two keys, allLong three (buttons.cpp).
          text: 'Die Box meldet mehrere Tasten auf einmal. Hast du nur eine gedrückt, berühren sich vielleicht zwei Lötstellen an der linken Leiste. Schaue genau hin, ob Lötzinn zwei Anschlüsse verbindet.',
          stellen: [...tastenStellen('up', ctx), ...tastenStellen('down', ctx)].filter((s) => s.startsWith('leiste:')),
        },
        at,
      );
      return true;
    }
    if (!key) return false;
    this.zuletztTaste = { key, at };
    if (this.schritt !== 'tasten') return false;
    const want = this.wantTaste();
    if (!want) return false;
    if (key === want.key) {
      this.tastenStand.set(key, { ...want, status: 'ok', statt: undefined, at });
      this.befunde.remove(`taste-statt-${key}`);
      if (!this.wantTaste()) this.weiter();
      return true;
    }
    // Another button than asked: perhaps the wrong one pressed, perhaps wires swapped.
    const got = TASTEN_NAMEN[key];
    this.tastenStand.set(want.key, { ...want, statt: got });
    this.befunde.add(
      {
        id: `taste-statt-${want.key}`,
        teil: 'tasten',
        ton: 'warn',
        titel: `Statt „${want.name}“ kam „${got}“`,
        text: `Hast du wirklich ${want.name} gedrückt? Dann sind vielleicht die Kabel von ${want.name} und ${got} vertauscht, oder eine Lötstelle berührt die Nachbarin.`,
        stellen: [...tastenStellen(want.key, ctx), ...tastenStellen(key, ctx)].filter((s) => s.startsWith('leiste:')),
      },
      at,
    );
    return true;
  }

  /**
   * "Passiert nichts": the button asked for (tasten) or the card (karte) did
   * not come. Marks it as broken with the joints to check and goes on.
   */
  passiertNichts(at: number): void {
    const ctx = this.kontext;
    if (this.schritt === 'tasten') {
      const want = this.wantTaste();
      if (!want) return;
      this.tastenStand.set(want.key, { ...want, status: 'fehler', at });
      const stellen = tastenStellen(want.key, ctx);
      this.befunde.add(
        {
          id: `taste-tot-${want.key}`,
          teil: 'tasten',
          ton: 'fehler',
          titel: `${want.name} meldet sich nicht`,
          text:
            ctx.platine === 'aio' || ctx.platine === 'aioplus'
              ? `Prüfe das Kabel von ${want.name} zum Button-Adapter und beide Lötstellen an der Taste.`
              : `Prüfe die Lötstelle an ${stellen[0]?.slice(7) ?? 'der Leiste'}, die Masse daneben und beide Beinchen der Taste. Oft ist es eine kalte Lötstelle: matt oder rissig statt glatt und glänzend.`,
          stellen,
        },
        at,
      );
      if (!this.wantTaste()) this.weiter();
      return;
    }
    if (this.schritt === 'karte') {
      this.status.leser = 'fehler';
      this.befunde.add(
        {
          id: 'leser-nichts',
          teil: 'leser',
          ton: 'fehler',
          titel: 'Der Kartenleser meldet keine Karte',
          text: 'Lege die Karte flach mitten auf die Stelle über dem Kartenleser. Kommt trotzdem nichts, prüfe alle Kabel zum Kartenleser, zuerst 3V3 und GND. Klappt es mit einer anderen Karte?',
          stellen: ['rfid:3V3', 'rfid:GND', 'rfid:SDA', 'rfid:SCK', 'rfid:SI', 'rfid:SO', 'rfid:RST'],
        },
        at,
      );
      this.weiter();
    }
  }

  /**
   * An answer only the user can give: hört Ton (lautsprecher), Kopfhörer,
   * LED-Ring leuchtet, Knopf geht, and on boxes that do not report them,
   * Tasten and Karte.
   */
  antwort(teil: TeilId, ja: boolean, at: number): void {
    this.antworten[teil] = ja;
    if (teil === 'tasten' && !ja) this.passiertNichtsAlleTasten(at);
    this.status[teil] = ja ? 'ok' : 'fehler';
    if (!ja) {
      const b = antwortBefund(teil, this);
      if (b) this.befunde.add(b, at);
    } else if (teil === 'lautsprecher') {
      this.befunde.remove('ls-still');
    }
  }

  private passiertNichtsAlleTasten(at: number): void {
    for (const t of this.tasten()) if (t.status === 'offen') this.tastenStand.set(t.key, { ...t, status: 'fehler', at });
  }

  /** Not in this box, or the user skips it. */
  ueberspringe(teil: TeilId): void {
    this.status[teil] = 'aus';
  }

  /** Extras on the box, changed on the extras step. */
  setzeExtra(teil: 'ring' | 'knopf' | 'akku', an: boolean): void {
    this.ausstattung[teil] = an;
  }

  starteWackeln(at: number): void {
    this.wackelStart = at;
    this.wackelEnde = undefined;
    this.wackelLog.length = 0;
  }

  beendeWackeln(at: number): void {
    if (this.wackelStart === undefined) this.wackelStart = at;
    this.wackelEnde = at;
    if (this.teilStatus('strom') !== 'fehler') this.status.strom = 'ok';
    this.weiter();
  }

  /* -------------------------------------------------------------- moving */

  weiter(): void {
    const s = this.schritte();
    const i = s.indexOf(this.schritt);
    if (i < s.length - 1) this.schritt = s[i + 1];
  }

  zurueck(): void {
    const s = this.schritte();
    const i = s.indexOf(this.schritt);
    if (i > 0) this.schritt = s[i - 1];
  }

  gehe(schritt: BoxSchritt): void {
    if (this.schritte().includes(schritt)) this.schritt = schritt;
  }

  /** Done steps, of all, for "Schritt 3 von 8". */
  position(): { nr: number; von: number } {
    const s = this.schritte();
    return { nr: s.indexOf(this.schritt) + 1, von: s.length };
  }

  /* -------------------------------------------------------------- result */

  ergebnis(): { ton: 'ok' | 'warn' | 'fehler'; titel: string; text: string } {
    const teile = this.teile();
    const kaputt = teile.filter((t) => t.status === 'fehler');
    const offen = teile.filter((t) => t.status === 'offen');
    const warn = this.befunde.list().filter((b) => b.ton === 'warn');
    if (kaputt.length)
      return {
        ton: 'fehler',
        titel: kaputt.length === 1 ? 'Ein Teil hat ein Problem' : `${kaputt.length} Teile haben ein Problem`,
        text: 'Bei jedem steht, welche Stelle du prüfen sollst. Nachlöten, dann teste noch einmal.',
      };
    if (offen.length || warn.length)
      return {
        ton: 'warn',
        titel: 'Fast alles geht',
        text: offen.length ? 'Ein paar Teile hast du nicht getestet. Du kannst zurückgehen und sie nachholen.' : 'Schaue dir die Hinweise unten an.',
      };
    return { ton: 'ok', titel: 'Deine Box ist fertig', text: 'Alles hat sich gemeldet, und beim Klopfen ist nichts ausgefallen. Viel Spaß damit!' };
  }
}

/** What a "Nein" means, with the joints to check. */
function antwortBefund(teil: TeilId, t: BoxTest): Omit<Befund, 'at' | 'zuletzt' | 'anzahl'> | null {
  const p = t.ausstattung.platine;
  const aio = p === 'aio' || p === 'aioplus';
  switch (teil) {
    case 'lautsprecher':
      if (t.kopfhoererGemeldet) return null; // kh-falsch already says why
      return {
        id: 'ls-still',
        teil: 'lautsprecher',
        ton: 'fehler',
        titel: 'Kein Ton aus dem Lautsprecher',
        text: aio
          ? 'Die Box startet einen Titel, aber du hörst nichts. Prüfe die beiden Kabel zum Lautsprecher und ob die Lautstärke nicht ganz unten ist.'
          : p === 'frei'
            ? 'Die Box startet einen Titel, aber du hörst nichts. Prüfe die beiden Kabel vom Lautsprecher zu SPK_1 und SPK_2 am MP3-Player. Steckt die SD-Karte richtig?'
            : 'Die Box startet einen Titel, aber du hörst nichts. Prüfe die Lötstellen an + und − der Audio-Leiste und an den beiden Anschlüssen des Lautsprechers. Mit Kopfhörerplatine geht der Lautsprecher über sie: Prüfe auch SK.',
        stellen: aio || p === 'frei' ? [] : ['audio:+', 'audio:−'],
      };
    case 'kopfhoerer':
      return {
        id: 'kh-still',
        teil: 'kopfhoerer',
        ton: 'fehler',
        titel: 'Kein Ton im Kopfhörer',
        text: aio ? 'Steckt der Stecker ganz drin? Probiere einen anderen Kopfhörer.' : 'Steckt der Stecker ganz drin? Probiere einen anderen Kopfhörer. Hilft das nicht, prüfe die Lötstellen an R, L und GND der Audio-Leiste und an der Kopfhörerbuchse.',
        stellen: aio || p === 'frei' ? [] : ['audio:R', 'audio:L', 'audio:GND'],
      };
    case 'ring':
      return {
        id: 'ring-dunkel',
        teil: 'ring',
        ton: 'fehler',
        titel: 'Der LED-Ring bleibt dunkel',
        text: aio
          ? 'Prüfe die drei Kabel zum Ring (Daten, 5V, GND) und ob die Firmware mit LED-Ring gebaut ist.'
          : 'Prüfe die Leitung von D5 über den Widerstand zum Eingang des Rings (DIN oder DI, nicht DOUT), dazu 5V und GND. Und: Ist eine Firmware mit Leuchtring drauf? Die bekommst du unter „Firmware aufspielen“ bei den Extras.',
        stellen: aio || p === 'frei' ? [] : ['leiste:D5', 'audio:5V', 'audio:GND'],
      };
    case 'knopf':
      return {
        id: 'knopf-tot',
        teil: 'knopf',
        ton: 'fehler',
        titel: 'Der Lautstärke-Knopf ändert nichts',
        text: aio
          ? 'Prüfe die Kabel zum Knopf und ob die Firmware mit Drehgeber oder Poti gebaut ist.'
          : 'Prüfe die Kabel an A3 und A4 (Drehgeber) oder A3 (Poti), dazu Plus und GND am Knopf. Und: Ist eine Firmware mit Drehregler oder Poti drauf? Die bekommst du unter „Firmware aufspielen“ bei den Extras.',
        stellen: aio || p === 'frei' ? [] : ['leiste:A3', 'leiste:A4'],
      };
    case 'tasten':
      return {
        id: 'tasten-tot',
        teil: 'tasten',
        ton: 'fehler',
        titel: 'Die Box reagiert nicht auf jede Taste',
        text: 'Prüfe bei der Taste, die nichts tut, ihre Lötstellen am Button-Adapter oder an der Leiste und an der Taste selbst.',
        stellen: [],
      };
    case 'leser':
      return {
        id: 'leser-nichts',
        teil: 'leser',
        ton: 'fehler',
        titel: 'Die Box reagiert nicht auf die Karte',
        text: 'Prüfe alle Kabel zum Kartenleser, zuerst 3,3 V und GND. Klappt es mit einer anderen Karte?',
        stellen: aio ? [] : ['rfid:3V3', 'rfid:GND', 'rfid:SDA', 'rfid:SCK', 'rfid:SI', 'rfid:SO', 'rfid:RST'],
      };
    default:
      return null;
  }
}
