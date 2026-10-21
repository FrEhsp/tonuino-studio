/**
 * Tasten und Teile testen: after soldering, press every button and see it
 * ticked off, plus a card, a played title and a volume change. Read from the
 * serial log (the connection of the Box-Logbuch).
 *
 * What TonUINO TNG (V3.3.3) logs, and so what this test can tick:
 * - commands.cpp logs one "btn/cmd: <raw>/<command>" per press, but only when
 *   the press does something in the current state (command not "none"). With
 *   5 buttons, Lauter and Leiser held long do nothing while the box is idle
 *   or paused, and so they are only logged while it plays. The raw names are
 *   pause/pauseLong, up/upLong, down/downLong and, with 5 buttons,
 *   four/fourLong and five/fiveLong (buttons.cpp). Holding a button on adds
 *   "…LongRepeat" every 200 ms; those are not rows of their own.
 * - With the 3×3 button board, a key of the board logs "btn3x3: n".
 * - The original AiO board (not the AiO+) logs "btn/cmd" only at debug level
 *   and with numbers, and no card events: the test cannot run there.
 * - mp3.cpp logs "play f-t", "play mp3 n" or "play adv: n" when the box asks
 *   the MP3 player for a title, and "Volume: n" whenever the volume is set,
 *   once already at the start. Whether sound comes out, nobody logs.
 * - Rotary encoder and potentiometer log only at debug level; a volume change
 *   through them shows up as "Volume: n".
 * - TonUINO 2.1 does not log button presses in a form the app reads.
 *
 * Pure logic: the page feeds lines and times and shows the rows.
 */
import { buttonLabel, COMMAND_LABELS } from '../../core/firmware/logexplain';
import { parseLogLine, type BoxButtons, type FirmwareFamily, type LogRecord } from '../../core/firmware/logline';
import type { BoardId } from '../../core/firmware/variants';

/** The five buttons as buttons.cpp names them. */
export type ButtonKey = 'up' | 'down' | 'four' | 'five' | 'pause';
export type PressKind = 'short' | 'long';

export type PartId = `${ButtonKey}:${PressKind}` | 'card' | 'sound' | 'volume' | 'keypad';

export interface PartRow {
  id: PartId;
  kind: 'button' | 'card' | 'sound' | 'volume' | 'keypad';
  label: string;
  /** When the firmware reported it first; undefined while the row waits. */
  at?: number;
  /** For a button: what the box did ("nächster Titel"). Otherwise a short note on what came, e.g. "Titel 5-1". */
  detail?: string;
  /** Guided press of this button, but the box reported another one (its label). Cleared once this one arrives. */
  reportedInstead?: string;
  /** One press arrived twice within a moment: a loose contact. */
  doubled?: boolean;
  /** Card row: the reader noticed a card but could not read it. */
  unreadable?: boolean;
}

/** A line about a button the test does not expect, e.g. "updownLong" or a number. */
export interface OtherReport {
  at: number;
  /** As logged, e.g. "updownLong/to_first". */
  text: string;
  label: string;
  /** Two buttons at once that the user may not have pressed together: a solder bridge is possible. */
  combo: boolean;
}

/** ok: the test can run; aio: the firmware of the AiO board does not log presses; classic21: TonUINO 2.1 does not either. */
export type PartsSupport = 'ok' | 'aio' | 'classic21';

export const BUTTON_NAMES: Record<ButtonKey, string> = {
  up: 'Vor',
  down: 'Zurück',
  four: 'Lauter',
  five: 'Leiser',
  pause: 'Play/Pause',
};

/** The raw name TNG logs for a button and press. */
const RAW_OF: Record<`${ButtonKey}:${PressKind}`, string> = {
  'up:short': 'up',
  'up:long': 'upLong',
  'down:short': 'down',
  'down:long': 'downLong',
  'four:short': 'four',
  'four:long': 'fourLong',
  'five:short': 'five',
  'five:long': 'fiveLong',
  'pause:short': 'pause',
  'pause:long': 'pauseLong',
};

const BUTTON_OF_RAW: Record<string, `${ButtonKey}:${PressKind}`> = Object.fromEntries(
  Object.entries(RAW_OF).map(([id, raw]) => [raw, id as `${ButtonKey}:${PressKind}`]),
);

/** Held on: repeats of a long press, not a press of their own. */
const REPEATS = new Set(['upLongRepeat', 'downLongRepeat', 'fourLongRepeat', 'fiveLongRepeat']);
/** Two or three buttons held together. */
const COMBOS = new Set(['allLong', 'updownLong']);

/**
 * Order of the guide. Play/Pause comes last: a short press pauses, and while
 * paused a long press switches the box off and Lauter/Leiser held long are not
 * logged at all.
 */
const BUTTON_ORDER: ButtonKey[] = ['up', 'down', 'four', 'five', 'pause'];

/** A press that arrives again within this time was one press (a bouncing contact), not two. */
export const DOUBLE_MS = 300;
/** A "Volume" line this soon after a volume command is that command's doing. */
const VOLUME_AFTER_COMMAND_MS = 3000;
const MAX_OTHERS = 12;

export function buttonId(key: ButtonKey, press: PressKind): `${ButtonKey}:${PressKind}` {
  return `${key}:${press}`;
}

export function rawLabel(raw: string, buttons?: BoxButtons): string {
  return buttonLabel(raw, buttons);
}

export class PartsTest {
  firmware?: FirmwareFamily;
  board?: BoardId;
  /** From the start of the box ("C 3", "A+ 5"). */
  buttons?: BoxButtons;
  /** IB:1, only matters with 3 buttons. */
  invertVolumeButtons?: boolean;
  /** Pressed "Fertig": rows still open get their hint. */
  finished = false;
  /** The row ticked or reported last, for the highlight. */
  lastHit?: { id: PartId; at: number };
  /** The last guided press that came as another button: what the page says right now. */
  lastMismatch?: { want: PartId; got: string; at: number };
  readonly others: OtherReport[] = [];
  /** "com to mfrc broken" at the start. */
  rfidBroken = false;
  /** "Com to DFPlayer broken" at the start. */
  mp3Broken = false;
  /** Error codes of the MP3 player ("DfPl Err: n"). */
  readonly mp3Errors: number[] = [];

  private readonly hits = new Map<PartId, PartRow>();
  /** Guided presses that came as another button: label of what came, by the row the guide asked for. */
  private readonly mismatches = new Map<PartId, string>();
  private readonly keys = new Set<number>();
  private sawFive = false;
  private lastRaw?: { raw: string; at: number };
  private lastVolumeCommandAt?: number;
  private volume?: number;

  /** What the Box-Logbuch already knows from the start of the box. */
  seed(info: { firmware?: FirmwareFamily; board?: BoardId; buttons?: BoxButtons; settings?: { invertVolumeButtons?: boolean } }): void {
    if (info.firmware) this.firmware = info.firmware;
    if (info.board) this.board = info.board;
    if (info.buttons) this.buttons = info.buttons;
    if (info.settings?.invertVolumeButtons !== undefined) this.invertVolumeButtons = info.settings.invertVolumeButtons;
  }

  get support(): PartsSupport {
    if (this.firmware === 'classic21') return 'classic21';
    if (this.board === 'aio') return 'aio';
    return 'ok';
  }

  /** 3 or 5 buttons; until the start of the box was seen, 3 unless Lauter or Leiser came. */
  get buttonCount(): 3 | 5 {
    if (this.buttons === '5') return 5;
    if (this.buttons === '3' || this.buttons === '3x3') return 3;
    return this.sawFive ? 5 : 3;
  }

  /** True once the start of the box said how many buttons the firmware is built for. */
  get variantKnown(): boolean {
    return this.buttons !== undefined;
  }

  get hasKeypad(): boolean {
    return this.buttons === '3x3' || this.keys.size > 0;
  }

  /** Feeds one line of the log. Returns true when something on the page changed. */
  observe(line: string, at: number): boolean {
    const rec = parseLogLine(line);
    return rec ? this.record(rec, at) : false;
  }

  record(rec: LogRecord, at: number): boolean {
    switch (rec.kind) {
      case 'banner':
        this.firmware = rec.firmware;
        // The volume set at the start is no change.
        this.volume = undefined;
        return true;
      case 'hardware':
        this.board = rec.board;
        this.buttons = rec.buttons;
        return true;
      case 'setting':
        if (rec.patch.invertVolumeButtons === undefined) return false;
        this.invertVolumeButtons = rec.patch.invertVolumeButtons;
        return true;
      case 'rfid-broken':
        this.rfidBroken = true;
        return true;
      case 'mp3-broken':
        this.mp3Broken = true;
        return true;
      case 'mp3-error':
        if (!this.mp3Errors.includes(rec.code)) this.mp3Errors.push(rec.code);
        return true;
      case 'button':
        return this.onButton(rec.raw, rec.command, at);
      case 'button3x3':
        this.keys.add(rec.index);
        this.hit('keypad', at, `Taste ${[...this.keys].sort((a, b) => a - b).join(', ')}`);
        return true;
      case 'card':
        if (rec.event !== 'inserted') return false;
        this.hit('card', at, 'Karte bemerkt');
        return true;
      case 'card-data':
      case 'card-bad-version':
        this.hit('card', at, 'Karte gelesen', true).unreadable = false;
        return true;
      case 'card-error': {
        if (rec.op === 'write') return false;
        const row = this.hit('card', at, 'Karte bemerkt');
        // Noticed but not read; once a card was read, the reader works.
        if (row.detail !== 'Karte gelesen') row.unreadable = true;
        return true;
      }
      case 'play':
        this.hit('sound', at, `Titel ${rec.folder}-${rec.track}`);
        return true;
      case 'play-mp3':
      case 'play-advert':
        this.hit('sound', at, `Ansage ${rec.track}`);
        return true;
      case 'volume': {
        const before = this.volume;
        this.volume = rec.volume;
        const byCommand = this.lastVolumeCommandAt !== undefined && at - this.lastVolumeCommandAt <= VOLUME_AFTER_COMMAND_MS;
        if (!byCommand && (before === undefined || before === rec.volume)) return false;
        this.hit('volume', at, before !== undefined && before !== rec.volume ? `von ${before} auf ${rec.volume}` : `Lautstärke ${rec.volume}`);
        return true;
      }
      default:
        return false;
    }
  }

  /** All rows the firmware of this box can tick, in the order of the guide. */
  rows(): PartRow[] {
    if (this.support !== 'ok') return [];
    const out: PartRow[] = [this.row('card', 'card', 'Karte erkannt'), this.row('sound', 'sound', 'Titel gestartet')];
    for (const key of BUTTON_ORDER) {
      if ((key === 'four' || key === 'five') && this.buttonCount !== 5) continue;
      // Play/Pause: long before short (see BUTTON_ORDER).
      const presses: PressKind[] = key === 'pause' ? ['long', 'short'] : ['short', 'long'];
      for (const press of presses) out.push(this.row(buttonId(key, press), 'button', `${BUTTON_NAMES[key]} ${press === 'short' ? 'kurz' : 'lang'}`));
    }
    out.push(this.row('volume', 'volume', 'Lautstärke geändert'));
    if (this.hasKeypad) out.push(this.row('keypad', 'keypad', '3×3-Tastenfeld'));
    return out;
  }

  /** The next row to do: the first that still waits. */
  current(): PartRow | undefined {
    return this.rows().find((r) => r.at === undefined);
  }

  /** How many rows are done, of how many. */
  progress(): { done: number; total: number } {
    const rows = this.rows();
    return { done: rows.filter((r) => r.at !== undefined).length, total: rows.length };
  }

  finish(): void {
    this.finished = true;
  }

  resume(): void {
    this.finished = false;
  }

  private row(id: PartId, kind: PartRow['kind'], label: string): PartRow {
    const hit = this.hits.get(id);
    if (hit) return { ...hit, label };
    const other = this.mismatches.get(id);
    return other ? { id, kind, label, reportedInstead: other } : { id, kind, label };
  }

  /** Ticks a row the first time; `update` replaces its note on later reports. */
  private hit(id: PartId, at: number, detail?: string, update = false): PartRow {
    let row = this.hits.get(id);
    if (!row) {
      row = { id, kind: kindOf(id), label: '', at, detail };
      this.hits.set(id, row);
      this.mismatches.delete(id);
    } else if (update || id === 'keypad') {
      row.detail = detail;
    }
    this.lastHit = { id, at };
    return row;
  }

  private onButton(raw: string, command: string, at: number): boolean {
    if (REPEATS.has(raw)) return false;
    const id = BUTTON_OF_RAW[raw];
    const doubled = this.lastRaw?.raw === raw && at - this.lastRaw.at <= DOUBLE_MS;
    this.lastRaw = { raw, at };
    if (command === 'volume_up' || command === 'volume_down') this.lastVolumeCommandAt = at;
    if (id && (id.startsWith('four') || id.startsWith('five'))) this.sawFive = true;
    if (!id || (this.buttonCount === 3 && (id.startsWith('four') || id.startsWith('five')))) {
      this.others.push({ at, text: `${raw}/${command}`, label: rawLabel(raw, this.buttons), combo: COMBOS.has(raw) });
      if (this.others.length > MAX_OTHERS) this.others.shift();
      return true;
    }
    if (doubled) {
      const row = this.hits.get(id);
      if (row) row.doubled = true;
      return true;
    }
    // A guided press that came as another button: say so at the button the guide asked for.
    const want = this.current();
    if (want && want.kind === 'button' && want.id !== id) {
      this.mismatches.set(want.id, rawLabel(raw, this.buttons));
      this.lastMismatch = { want: want.id, got: rawLabel(raw, this.buttons), at };
    } else {
      this.lastMismatch = undefined;
    }
    this.hit(id, at, COMMAND_LABELS[command] ?? command);
    return true;
  }
}

function kindOf(id: PartId): PartRow['kind'] {
  return id === 'card' || id === 'sound' || id === 'volume' || id === 'keypad' ? id : 'button';
}

/* ------------------------------------------------------------------ texts */

/** What the guide says for the row that is next. */
export function instruction(t: PartsTest, row: PartRow): { say: string; sub: string } {
  switch (row.kind) {
    case 'card':
      return { say: 'Lege eine Karte auf die Box.', sub: 'Nimm eine Karte, die schon Musik abspielt. Lasse die Box während des ganzen Tests spielen.' };
    case 'sound':
      return { say: 'Lasse die Box einen Titel spielen.', sub: 'Lege dafür eine Karte mit Musik auf. Höre hin, ob Ton kommt.' };
    case 'volume':
      return { say: 'Mache die Box lauter oder leiser.', sub: volumeHowTo(t) };
    case 'keypad':
      return { say: 'Drücke eine Taste am 3×3-Tastenfeld.', sub: 'Die Box spielt dann, was auf dieser Taste gespeichert ist.' };
    default: {
      const [key, press] = row.id.split(':') as [ButtonKey, PressKind];
      const name = BUTTON_NAMES[key];
      if (press === 'short') return { say: `Drücke kurz auf ${name}.`, sub: 'Einmal kurz drücken und loslassen.' };
      return {
        say: `Halte ${name} gedrückt.`,
        sub: key === 'pause' ? 'Etwa eine Sekunde, während die Box spielt. Ist sie angehalten, schaltet sie sich sonst aus.' : 'Etwa eine Sekunde, bis die Box reagiert. Dann loslassen.',
      };
    }
  }
}

function volumeHowTo(t: PartsTest): string {
  if (t.buttonCount === 5) return 'Drücke kurz auf Lauter oder Leiser, während die Box spielt.';
  return t.invertVolumeButtons
    ? 'Drücke kurz auf Vor oder Zurück, während die Box spielt.'
    : 'Halte Vor oder Zurück lang gedrückt, während die Box spielt.';
}

export interface RowHint {
  text: string;
  /** The reader test helps further. */
  readerTest?: boolean;
  /** The Box-Logbuch explains the lines. */
  logbook?: boolean;
}

/**
 * A plain hint for a row: for a row still open after "Fertig", and for rows
 * that came in a suspicious way (doubled, unreadable card) at any time.
 */
export function rowHint(t: PartsTest, row: PartRow): RowHint | undefined {
  if (row.kind === 'button') return buttonHint(t, row);
  if (row.kind === 'card') {
    if (t.rfidBroken) return { text: 'Beim Start hat der Kartenleser nicht geantwortet. Prüfe seine Kabel und Lötstellen und ob er 3,3 V bekommt.', readerTest: true };
    if (row.at !== undefined && row.unreadable) return { text: 'Der Kartenleser hat die Karte bemerkt, konnte sie aber nicht lesen. Probiere eine andere Karte.', readerTest: true };
    if (row.at === undefined && t.finished) return { text: 'Die Box hat keine Karte gemeldet. Prüfe Kabel und Lötstellen am Kartenleser.', readerTest: true };
    return undefined;
  }
  if (row.kind === 'sound') {
    if (t.mp3Broken) return { text: 'Beim Start hat der MP3-Player nicht geantwortet. Prüfe die Kabel zwischen Platine und MP3-Player (DFPlayer) und ob die SD-Karte richtig steckt.' };
    if (t.mp3Errors.length) return { text: 'Der MP3-Player hat Fehler gemeldet. Was sie heißen, steht im Box-Logbuch. Prüfe die SD-Karte und die Kabel zum MP3-Player (DFPlayer).', logbook: true };
    if (row.at === undefined && t.finished) {
      return { text: 'Die Box hat keinen Titel gestartet. Lege eine Karte mit Musik auf. Hörst du trotzdem nichts, prüfe Lautsprecher, die Kabel zum MP3-Player (DFPlayer) und die SD-Karte.' };
    }
    if (row.at !== undefined) return { text: 'Die Box meldet nur, dass sie den Titel startet. Hörst du nichts, prüfe Lautsprecher, die Kabel zum MP3-Player (DFPlayer) und die SD-Karte.' };
    return undefined;
  }
  if (row.kind === 'volume') {
    return row.at === undefined && t.finished ? { text: `Die Box hat keine neue Lautstärke gemeldet. ${volumeHowTo(t)}` } : undefined;
  }
  // keypad
  return row.at === undefined && t.finished ? { text: 'Die Box hat keine Taste am Tastenfeld gemeldet. Prüfe das Kabel zum Tastenfeld und seine Lötstellen.' } : undefined;
}

const CHECK_BUTTON = 'Prüfe Lötstelle und Kabel an dieser Taste.';

function buttonHint(t: PartsTest, row: PartRow): RowHint | undefined {
  const [key, press] = row.id.split(':') as [ButtonKey, PressKind];
  if (row.doubled) return { text: `Ein Druck kam doppelt an. Vielleicht ein Wackelkontakt. ${CHECK_BUTTON}` };
  if (row.at !== undefined || !t.finished) return undefined;
  const name = BUTTON_NAMES[key];
  const other = row.reportedInstead;
  if (other) {
    const swapped = (key === 'up' && other.startsWith('Zurück')) || (key === 'down' && other.startsWith('Vor'));
    if (other.startsWith(name)) {
      return { text: `Statt „${row.label}“ kam „${other}“. ${press === 'long' ? 'Halte die Taste länger, etwa eine Sekunde.' : 'Drücke nur kurz.'}` };
    }
    // The other press of this button came through: its wire is right, so not swapped but loose or bridged.
    const siblingOk = t.rows().some((r) => r.id === buttonId(key, press === 'short' ? 'long' : 'short') && r.at !== undefined);
    const cause = siblingOk ? 'Vielleicht ein Wackelkontakt, oder eine Lötstelle berührt die Nachbarin.' : 'Vielleicht sind Kabel vertauscht, oder eine Lötstelle berührt die Nachbarin.';
    return {
      text:
        `Als du ${name} drücken solltest, hat die Box „${other}“ gemeldet. ${cause} ${CHECK_BUTTON} Neu aufspielen musst du die Firmware dafür nicht.` +
        (swapped ? ' Sind nur Vor und Zurück vertauscht, ist vielleicht die Tastenplatine verkehrt herum eingebaut.' : ''),
    };
  }
  const shortOk = press === 'long' && t.rows().some((r) => r.id === buttonId(key, 'short') && r.at !== undefined);
  if (shortOk) {
    const playing = key === 'four' || key === 'five' ? ' Lang meldet die Box diese Taste nur, während sie spielt.' : '';
    return { text: `Kurz drücken kam an, lang nicht.${playing} Halte die Taste etwa eine Sekunde gedrückt.` };
  }
  return { text: `Die Box hat diese Taste nie gemeldet. ${CHECK_BUTTON} Oft ist es eine kalte Lötstelle: Sie sieht matt oder rissig aus statt glatt und glänzend.` };
}

/** What the page says about a line that fits no row. */
export function otherHint(o: OtherReport): string {
  return o.combo
    ? 'Das meldet die Box, wenn mehrere Tasten zugleich gedrückt sind. Hast du nur eine gedrückt, berühren sich vielleicht zwei Lötstellen.'
    : 'Diese Meldung gehört zu keiner Taste deiner Box.';
}

/** Every point has arrived: the moment of the last tick, for the double knock (src/ui/sound.ts). */
export function allArrived(t: PartsTest): boolean {
  const { done, total } = t.progress();
  return total > 0 && done === total;
}

/** The summary after "Fertig". */
export function summary(t: PartsTest): { tone: 'ok' | 'warn'; title: string; text: string } {
  const { done, total } = t.progress();
  const open = total - done;
  const doubled = t.rows().some((r) => r.doubled);
  if (!open && !doubled && !t.rfidBroken && !t.mp3Broken && !t.mp3Errors.length) {
    return { tone: 'ok', title: 'Alles ist angekommen', text: 'Jede Taste, der Kartenleser und der MP3-Player haben sich gemeldet. Ob auch Ton kam, hörst du selbst.' };
  }
  if (!open) return { tone: 'warn', title: 'Alles kam an, aber nicht ganz sauber', text: 'Schaue dir die Hinweise unten an.' };
  return {
    tone: 'warn',
    title: open === 1 ? 'Ein Punkt fehlt noch' : `${open} Punkte fehlen noch`,
    text: 'Bei jedem offenen Punkt steht, was du prüfen kannst.',
  };
}
