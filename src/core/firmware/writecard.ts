/**
 * Writing cards through the box over USB (TODO #93): TonUINO TNG's serial
 * command WRITECARD, built in with -D SerialWriteCard. Written by donschoof
 * (TNG PR #344), so far only on TNG's branch issue_345 (PR #346 to main is
 * open); the Firmware-Baukasten builds it as a preview
 * (docs/FIRMWARE-BAUKASTEN.md). Research: recherche/donschoof-kartenschreiben.md.
 *
 * Protocol (TNG issue_345, serial_input.cpp:57-104, state_machine.cpp:
 * 483-528 and 690-740), 115200 baud, one line each:
 *   WRITECARD <mode>[,<folder>[,<special>[,<special2>]]]   exactly the parameters of the mode's group
 *   WRITECARD CANCEL
 * Answers: "WRITECARD: ERR" at once for bad parameters and for CANCEL
 * without a running write; "WRITECARD: OK" only after the card was written
 * AND taken off again, also when writing failed (then "Auth  failed" or
 * "MIFARE_Write  failed" came before); "WRITECARD: ERR" after a cancel. No
 * answer at all while the box plays, is in its admin menu, or a card lies on
 * it when the command comes.
 *
 * Everything here is pure: the page feeds lines and the clock in.
 */
import { ADMIN_MODE, CARD_COOKIE, CARD_VERSION, type CardData } from '../tonuino/card';
import { parseLogLine } from './logline';

/** Every answer of the command starts so (str_WRITECARD, state_machine.cpp:58). */
export const ANSWER_PREFIX = 'WRITECARD: ';
/** Harmless: with WRITECARD the box answers "WRITECARD: ERR" at once (nothing to cancel), without it nothing. */
export const PROBE_LINE = 'WRITECARD CANCEL';
export const CANCEL_LINE = PROBE_LINE;

/** What goes over the wire for a line (the firmware drops the line end, serial_input.cpp:125). */
export function lineBytes(line: string): Uint8Array {
  return new TextEncoder().encode(`${line}\n`);
}

/* ------------------------------------------------------------ the command */

/** How many numbers the firmware reads after the mode (serial_input.cpp:72-96). */
function paramCount(mode: number): 0 | 1 | 2 | 3 {
  if (mode === 11 || mode === 14) return 0;
  if (mode === 4 || mode === 10) return 2;
  if (mode === 7 || mode === 8 || mode === 9 || mode === 12 || mode === 16) return 3;
  return 1;
}

/**
 * The card the box writes for `WRITECARD mode,params…`, or undefined when it
 * answers ERR. Follows the parser and validateWriteCard() of
 * serial_input.cpp:16-104, including the cut to one byte (folder 300 is 44).
 */
export function boxWrites(mode: number, params: readonly number[]): Required<CardData> | undefined {
  const byte = (n: number | undefined) => (n ?? 0) & 0xff;
  const m = byte(mode);
  const card = { version: CARD_VERSION, folder: 0, mode: m, special: 0, special2: 0 };
  const n = paramCount(m);
  if (n >= 1) card.folder = byte(params[0]);
  if (n >= 2) card.special = byte(params[1]);
  if (n >= 3) card.special2 = byte(params[2]);
  if (m === 0) return undefined;
  if (m === 4 && card.special < 1) return undefined;
  if ((m === 7 || m === 8 || m === 9 || m === 16) && (card.special < 1 || card.special > card.special2)) return undefined;
  if (m === 10 && card.special >= 30) return undefined;
  if (m === 12 && (![0, 2, 4].includes(card.special) || ![0, 1].includes(card.special2))) return undefined;
  if (m === 11 || m === 14) card.folder = 0xff;
  return card;
}

export type CommandResult = { ok: true; line: string } | { ok: false; reason: string };

export const MODIFIER_REASON = 'Spezialkarten wie die Schlummerkarte schreibt die Box über USB nicht. Nimm dafür das Handy, den NFC-Leser oder das Menü der Box.';
export const NOT_EXACT_REASON = 'So kann die Box diese Karte über USB nicht schreiben. Nimm dafür das Handy, den NFC-Leser oder das Menü der Box.';

/**
 * The line that makes the box write exactly this card, or why it cannot.
 * The firmware checks the folder not at all (0 would give a modifier card,
 * over 255 wraps around), so this does: folders 1-99. The admin card is
 * mode 255 with folder 0 ("WRITECARD 255,0"; the box menu's 6 would give a
 * modifier card). Cards whose fields the command cannot carry (a Hörbuch over
 * several folders: the box reads only the folder) are refused, not written
 * differently.
 */
export function writeCardCommand(card: CardData): CommandResult {
  if ((card.version ?? CARD_VERSION) !== CARD_VERSION) return { ok: false, reason: 'Die Box schreibt Karten immer im Format von TonUINO TNG, nicht im alten Format.' };
  let params: number[];
  if (card.mode === ADMIN_MODE) {
    if (card.folder !== 0) return { ok: false, reason: NOT_EXACT_REASON };
    params = [0];
  } else if (card.folder === 0) {
    return { ok: false, reason: MODIFIER_REASON };
  } else if (card.mode < 1 || card.mode > 16 || card.mode === 6) {
    return { ok: false, reason: `Den Modus ${card.mode} kennt die Box nicht.` };
  } else {
    const n = paramCount(card.mode);
    if (n > 0 && (card.folder < 1 || card.folder > 99)) return { ok: false, reason: 'Die Box schreibt über USB nur Karten für die Ordner 1 bis 99.' };
    params = [card.folder, card.special, card.special2].slice(0, n);
  }
  const written = boxWrites(card.mode, params);
  if (!written) return { ok: false, reason: 'Die Box würde diese Karte ablehnen: Titel oder Bereich passen nicht.' };
  if (written.folder !== card.folder || written.mode !== card.mode || written.special !== card.special || written.special2 !== card.special2) {
    return { ok: false, reason: NOT_EXACT_REASON };
  }
  return { ok: true, line: ['WRITECARD', [card.mode, ...params].join(',')].join(' ') };
}

/* ---------------------------------------------------------------- lines */

export type WriteLine =
  | { kind: 'answer'; ok: boolean }
  /** The box entered its write-card state ("enter WriteC"). */
  | { kind: 'started' }
  /** Before writing, the bytes it writes ("Writing: 13 37 B3 47 02 05 01 00 00"; not on the AiO, its card log is quieter). */
  | { kind: 'writing'; bytes: number[] }
  /** Auth or MIFARE_Write failed (s_error, also on the AiO). */
  | { kind: 'write-failed'; text: string }
  /** The box read a card (Classic: "CardData: …"). */
  | { kind: 'card-data'; bytes: number[] }
  | { kind: 'state'; state: string }
  /** The box (re)started: the banner. */
  | { kind: 'boot' };

const HEX_BYTES = /^((?:[0-9a-fA-F]{2}\s*)+)$/;

export function classifyLine(raw: string): WriteLine | undefined {
  const s = raw.trim();
  if (s.startsWith(ANSWER_PREFIX)) {
    const rest = s.slice(ANSWER_PREFIX.length).trim();
    // Older states of donschoof's fork said "ERROR" with a German detail line; ERR and ERROR alike.
    if (rest === 'OK') return { kind: 'answer', ok: true };
    if (rest.startsWith('ERR')) return { kind: 'answer', ok: false };
    return undefined;
  }
  const w = /^Writing:\s*(.*)$/.exec(s);
  if (w && HEX_BYTES.test(w[1].trim())) return { kind: 'writing', bytes: w[1].trim().split(/\s+/).map((h) => parseInt(h, 16)) };
  if (/^(?:Auth|MIFARE_Write)\s+(?:\d+\s+)?failed\b/.test(s)) return { kind: 'write-failed', text: s };
  const rec = parseLogLine(s);
  if (!rec) return undefined;
  if (rec.kind === 'card-data') return { kind: 'card-data', bytes: rec.bytes };
  if (rec.kind === 'banner') return { kind: 'boot' };
  if (rec.kind === 'state') return rec.state === 'WriteC' ? { kind: 'started' } : { kind: 'state', state: rec.state };
  return undefined;
}

/** States in which the box takes the command (commands.cpp: only idle and pause). */
export function acceptsCommand(state: string | undefined): boolean {
  return state === 'Idle' || state === 'Pause';
}

/* ---------------------------------------------------------------- probe */

export type WriteAbility =
  /** Not asked yet (no box, or still starting). */
  | 'unknown'
  | 'checking'
  /** Answered at once: the firmware has WRITECARD. */
  | 'yes'
  /** No answer while idle: the firmware does not have it. */
  | 'no'
  /** No answer, but the box was playing or in its menu: cannot tell. */
  | 'busy';

export interface ProbeOptions {
  /** Earliest time after connecting (a Nano restarts when the port opens; default 2500 ms). */
  settleMs?: number;
  /** The box has to be quiet this long before asking (default 700 ms). */
  quietMs?: number;
  /** Asked at the latest after this long, quiet or not (default 9000 ms). */
  maxWaitMs?: number;
  /** How long the answer may take (default 1500 ms; the box answers within a few ms). */
  answerMs?: number;
}

/**
 * Asks a freshly connected box whether it can write cards: once it is quiet
 * after its start, `WRITECARD CANCEL` is sent; "WRITECARD: ERR" means yes.
 * The page calls due() on a timer, sends PROBE_LINE when it says so and
 * then sent(); lines go to observe().
 */
export class WriteCardProbe {
  result: WriteAbility = 'checking';
  /** For 'no': the box was known to be idle or paused, so the answer is sure. */
  certain = false;
  private readonly opts: Required<ProbeOptions>;
  private lastLineAt: number;
  private sentAt: number | undefined;
  private state: string | undefined;

  constructor(
    private readonly connectedAt: number,
    opts: ProbeOptions = {},
  ) {
    this.opts = { settleMs: 2500, quietMs: 700, maxWaitMs: 9000, answerMs: 1500, ...opts };
    this.lastLineAt = connectedAt;
  }

  /** A line from the box; returns true when the result changed. */
  observe(line: string, now: number): boolean {
    this.lastLineAt = now;
    const l = classifyLine(line);
    if (!l) return false;
    if (l.kind === 'state') this.state = l.state;
    if (l.kind === 'boot') {
      // A start after the question: ask again once it is over.
      this.state = undefined;
      if (this.sentAt !== undefined && this.result === 'checking') this.sentAt = undefined;
    }
    if (l.kind === 'answer' && this.sentAt !== undefined && this.result === 'checking') {
      this.result = 'yes';
      return true;
    }
    return false;
  }

  /** True once: now is the time to send PROBE_LINE. */
  due(now: number): boolean {
    if (this.sentAt !== undefined || this.result !== 'checking') return false;
    const since = now - this.connectedAt;
    if (since >= this.opts.maxWaitMs) return true;
    return since >= this.opts.settleMs && now - this.lastLineAt >= this.opts.quietMs;
  }

  sent(now: number): void {
    this.sentAt = now;
  }

  /** Ends the wait for the answer; returns true when the result changed. */
  tick(now: number): boolean {
    if (this.sentAt === undefined || this.result !== 'checking' || now - this.sentAt < this.opts.answerMs) return false;
    if (this.state !== undefined && !acceptsCommand(this.state)) {
      this.result = 'busy';
    } else {
      this.result = 'no';
      this.certain = this.state !== undefined;
    }
    return true;
  }
}

/* ------------------------------------------------------------- one card */

export type RunPhase =
  /** The command is out; the box should say "enter WriteC" at once. */
  | { kind: 'sent' }
  /** The box waits for a card (and says „Bitte lege nun die Karte auf!“). */
  | { kind: 'place-card' }
  /** Written (or failed): the box waits until the card is taken off. */
  | { kind: 'remove-card' }
  /** "WRITECARD: OK" without an error line before it. `logged`: the bytes the box wrote, when its log shows them. */
  | { kind: 'done'; logged?: number[] }
  /** "WRITECARD: OK", but writing failed (Auth or MIFARE_Write), or it wrote other bytes. */
  | { kind: 'failed'; detail: string }
  /** "WRITECARD: ERR" at once: the box did not take the parameters. */
  | { kind: 'refused' }
  /** "WRITECARD: ERR" after it started: cancelled (here or with a long press on Play/Pause). */
  | { kind: 'cancelled' }
  /** Nothing came back: the box plays, is in its menu, or a card lies on it. */
  | { kind: 'no-answer' }
  /** The box restarted meanwhile. */
  | { kind: 'interrupted' };

export function isFinished(p: RunPhase): boolean {
  return p.kind !== 'sent' && p.kind !== 'place-card' && p.kind !== 'remove-card';
}

export interface RunOptions {
  /** How long to wait for "enter WriteC" (default 3000 ms). */
  startMs?: number;
}

/**
 * One card written by the box: fed with the lines after the command was
 * sent. Success only on "WRITECARD: OK" without an Auth/MIFARE_Write error
 * since the command, because the firmware says OK in both cases.
 */
export class WriteCardRun {
  phase: RunPhase = { kind: 'sent' };
  private failure: string | undefined;
  private logged: number[] | undefined;
  private cancelAsked = false;
  private readonly startMs: number;

  constructor(
    readonly card: CardData,
    private readonly sentAt: number,
    opts: RunOptions = {},
  ) {
    this.startMs = opts.startMs ?? 3000;
  }

  /** Returns true when the phase changed. */
  observe(line: string, now: number): boolean {
    void now;
    if (isFinished(this.phase)) return false;
    const l = classifyLine(line);
    if (!l) return false;
    const before = this.phase.kind;
    switch (l.kind) {
      case 'started':
        if (this.phase.kind === 'sent') this.phase = { kind: 'place-card' };
        break;
      case 'writing': {
        this.logged = l.bytes;
        const want = expectedBytes(this.card);
        if (!sameBytes(l.bytes, want)) this.failure = `Die Box hat andere Daten geschrieben: ${hex(l.bytes)} statt ${hex(want)}.`;
        this.phase = { kind: 'remove-card' };
        break;
      }
      case 'write-failed':
        this.failure = l.text;
        this.phase = { kind: 'remove-card' };
        break;
      case 'answer':
        if (!l.ok) this.phase = this.phase.kind === 'sent' && !this.cancelAsked ? { kind: 'refused' } : { kind: 'cancelled' };
        else if (this.failure) this.phase = { kind: 'failed', detail: this.failure };
        else this.phase = this.logged ? { kind: 'done', logged: this.logged } : { kind: 'done' };
        return true;
      case 'boot':
        this.phase = { kind: 'interrupted' };
        return true;
      default:
        break;
    }
    return this.phase.kind !== before;
  }

  /** CANCEL_LINE was sent. */
  cancelSent(): void {
    this.cancelAsked = true;
  }

  /** Returns true when the phase changed (no start within startMs). */
  tick(now: number): boolean {
    if (this.phase.kind !== 'sent' || now - this.sentAt < this.startMs) return false;
    this.phase = { kind: 'no-answer' };
    return true;
  }
}

/** The first nine bytes as TNG logs them (cookie, version, folder, mode, special, special2). */
export function expectedBytes(card: CardData): number[] {
  return [...CARD_COOKIE, card.version ?? CARD_VERSION, card.folder & 0xff, card.mode & 0xff, card.special & 0xff, card.special2 & 0xff];
}

function sameBytes(a: readonly number[], b: readonly number[]): boolean {
  return b.every((x, i) => a[i] === x);
}

function hex(bytes: readonly number[]): string {
  return bytes
    .slice(0, 9)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

/* -------------------------------------------------------------- read back */

export type ReadBack = { kind: 'match' } | { kind: 'differs'; read: string; want: string };

/**
 * The card laid on again after writing: the box logs what it read
 * ("CardData: …", Classic; the AiO keeps its card log quiet, so there the
 * user listens instead). Undefined for lines that are not card data.
 */
export function readBack(line: string, card: CardData): ReadBack | undefined {
  const l = classifyLine(line);
  if (!l || l.kind !== 'card-data') return undefined;
  const want = expectedBytes(card);
  return sameBytes(l.bytes, want) ? { kind: 'match' } : { kind: 'differs', read: hex(l.bytes), want: hex(want) };
}
