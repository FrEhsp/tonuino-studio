/**
 * Kartenleser testen: a guided test of the card reader in the box, read from
 * its serial log (the connection of the Box-Logbuch).
 *
 * First the start of the box tells whether the reader answers at all. Then
 * each card is laid on and taken off a few times. Per round the log says:
 * - TonUINO TNG: "Card Ins" when the reader notices a card, then "CardData: …"
 *   or "Auth failed: n" / "MIFARE_Read failed: n", later "Card Rem".
 * - TonUINO 2.1: "Card UID: …" and "PICC type: …", then "Data on Card :" with
 *   the bytes on the next line, or "PCD_Authenticate() failed: …" /
 *   "MIFARE_Read() failed: …". It does not report a removed card.
 * A card the reader does not notice leaves no line at all, so "not noticed"
 * comes from the time a round waits. The AiO board (not the AiO+) does not
 * log card events, so the test cannot run there.
 *
 * Nothing here writes to a card or the SD card. Pure logic: the page feeds
 * lines, times and clicks and shows the state.
 */
import { parseLogLine, rfidChip, stripLogPrefix, type FirmwareFamily } from '../../core/firmware/bootlog';
import { getBoard, type BoardId } from '../../core/firmware/variants';
import { ADMIN_MODE, decodeCard } from '../../core/tonuino/card';

/* ------------------------------------------------------------------ lines */

/** Classic = MIFARE Classic, Mini, 1K, 4K; ultralight = MIFARE Ultralight and NTAG; other = types the box cannot read. */
export type CardFamily = 'classic' | 'ultralight' | 'other';

export type ReaderLineEvent =
  | { kind: 'boot'; firmware: FirmwareFamily }
  | { kind: 'version'; version: string }
  | { kind: 'hardware'; board: BoardId }
  | { kind: 'reader'; version: number }
  | { kind: 'reader-broken' }
  /** The reader noticed a card. tng: "Card Ins"; classic21: "Card UID: …". */
  | { kind: 'detected'; dialect: FirmwareFamily }
  | { kind: 'removed' }
  /** label: what the firmware printed, in plain words; empty when only the family is known. */
  | { kind: 'type'; label: string; family: CardFamily }
  | { kind: 'data'; bytes: number[] }
  | { kind: 'bad-version'; version: number }
  /** The card was noticed but not read. `line` is the line as printed, for the forum. */
  | { kind: 'error'; op: 'auth' | 'read'; line: string }
  /** The box switched itself off (standby or sleep timer, a long press, a low battery). It reads no card until it is on again. */
  | { kind: 'power-off' };

/** "PICC type: …" of the MFRC522 library (TonUINO 2.1; TNG prints it only in debug builds). */
function piccType(name: string): { label: string; family: CardFamily } {
  const n = name.trim();
  if (/^MIFARE (1KB|4KB|Mini)/i.test(n)) {
    const size = /4KB/i.test(n) ? '4K' : /Mini/i.test(n) ? 'Mini' : '1K';
    return { label: `MIFARE Classic ${size}`, family: 'classic' };
  }
  if (/Ultralight/i.test(n)) return { label: 'MIFARE Ultralight oder NTAG', family: 'ultralight' };
  if (/DESFire/i.test(n)) return { label: 'MIFARE DESFire', family: 'other' };
  if (/Plus/i.test(n)) return { label: 'MIFARE Plus', family: 'other' };
  if (/14443-4/.test(n)) return { label: 'Karte nach ISO 14443-4, etwa DESFire', family: 'other' };
  if (/18092/.test(n)) return { label: 'NFC-Karte nach ISO 18092', family: 'other' };
  return { label: 'unbekannter Kartentyp', family: 'other' };
}

const HEX_BYTES = /^(?:[0-9a-fA-F]{2}\s+){8,}[0-9a-fA-F]{2}$/;

/**
 * Turns log lines into what the reader test needs. Uses the parser of the
 * Box-Logbuch and adds the card lines of TonUINO 2.1, which it does not know.
 * Keeps one bit of state: 2.1 prints the bytes of a card on the line after
 * "Data on Card :".
 */
export class ReaderLineParser {
  private awaitingData = false;

  reset(): void {
    this.awaitingData = false;
  }

  read(raw: string): ReaderLineEvent | null {
    const s = stripLogPrefix(raw);
    if (s === '') return null;
    if (this.awaitingData) {
      this.awaitingData = false;
      if (HEX_BYTES.test(s))
        return {
          kind: 'data',
          bytes: s.split(/\s+/).map((h) => parseInt(h, 16)),
        };
    }
    let m: RegExpMatchArray | null;
    // ---- TonUINO 2.1 (MFRC522 library texts)
    if (/^Card UID:/.test(s)) return { kind: 'detected', dialect: 'classic21' };
    if ((m = s.match(/^PICC type:\s*(.+)$/))) return { kind: 'type', ...piccType(m[1]) };
    if (/^PCD_Authenticate\(\) failed:/.test(s)) return { kind: 'error', op: 'auth', line: s.replace(/\s+/g, ' ') };
    if (/^MIFARE_Read(?:_\d)?\(\) failed:/.test(s)) return { kind: 'error', op: 'read', line: s.replace(/\s+/g, ' ') };
    if (/^Data on Card\s*:?$/.test(s)) {
      this.awaitingData = true;
      return null;
    }
    if ((m = s.match(/^Firmware Version: 0x([0-9a-fA-F]{1,2})\b/))) return { kind: 'reader', version: parseInt(m[1], 16) };
    if (/^WARNING: Communication failure/.test(s)) return { kind: 'reader-broken' };
    if (/^=== power off!$/.test(s)) return { kind: 'power-off' };
    // ---- TNG: the probe of an Ultralight/NTAG card failed; "Auth failed" follows.
    if (/^MIFARE_Read\s+3\s+failed:/.test(s)) return { kind: 'type', label: '', family: 'ultralight' };

    const rec = parseLogLine(raw);
    if (!rec) return null;
    switch (rec.kind) {
      case 'banner':
        return { kind: 'boot', firmware: rec.firmware };
      case 'version':
        return { kind: 'version', version: rec.version };
      case 'hardware':
        return { kind: 'hardware', board: rec.board };
      case 'rfid-version':
        return { kind: 'reader', version: rec.version };
      case 'rfid-broken':
        return { kind: 'reader-broken' };
      case 'card':
        return rec.event === 'inserted' ? { kind: 'detected', dialect: 'tng' } : { kind: 'removed' };
      case 'card-type':
        return {
          kind: 'type',
          label: rec.type.startsWith('NTAG?') ? 'NTAG (unbekannter Typ)' : rec.type,
          family: 'ultralight',
        };
      case 'card-data':
        return { kind: 'data', bytes: rec.bytes };
      case 'card-bad-version':
        return { kind: 'bad-version', version: rec.version };
      case 'card-error':
        return rec.op === 'write' ? null : { kind: 'error', op: rec.op, line: s.replace(/\s+/g, ' ') };
      case 'standby':
        return rec.event === 'power-off' ? { kind: 'power-off' } : null;
      default:
        return null;
    }
  }
}

/* ------------------------------------------------------------------ model */

/**
 * read: the box read the card. bad-version: read, but written for another
 * firmware. foreign: read, but no TonUINO data on it. unreadable: noticed,
 * not read. missed: not noticed within the time of the round.
 */
export type RoundOutcome = 'read' | 'bad-version' | 'foreign' | 'unreadable' | 'missed';

export interface RoundResult {
  outcome: RoundOutcome;
  /** The error line of an unreadable round, as the firmware printed it. */
  error?: string;
}

/**
 * Why a card was stopped before all rounds: blank or admin cards make the box
 * open a menu, and in a menu it no longer reads cards; busy: the box noticed
 * the card several times without reading it.
 */
export type CardStop = 'blank' | 'admin' | 'busy';

export interface CardResult {
  /** Name the user gave it; empty for "Karte 1" etc. */
  name: string;
  rounds: RoundResult[];
  /** Rounds where the box noticed the card but did not try to read it. They are repeated and not counted. */
  skipped: number;
  /** Card types as the firmware printed them. */
  types: string[];
  family?: CardFamily;
  /** The first bytes the box read from the card. */
  data?: number[];
  stop?: CardStop;
}

export type ReaderState = 'ok' | 'warn' | 'broken' | 'unknown';

export interface ReaderStatus {
  state: ReaderState;
  /** Value of the version register, when the start log printed it. */
  version?: number;
  /** "MFRC522 v2.0", "FM17522 (Nachbau)", … */
  chip?: string;
}

export interface BoxContext {
  firmware?: FirmwareFamily;
  /** "3.3.3" */
  version?: string;
  board?: BoardId;
}

export type Phase =
  /** Waiting for a connection. */
  | { kind: 'connect' }
  /** Connected; waiting for the start of the box and its reader line. */
  | { kind: 'reader-check'; since: number }
  /** No start came: the box did not restart when the port opened. */
  | { kind: 'reader-missed' }
  /** The reader check is done; `reader` says how it went. */
  | { kind: 'reader-done' }
  /** Card `card` is next: the user may name it and starts it. */
  | { kind: 'card-ready'; card: number }
  /** A card still lies on the box: it has to go first. */
  | { kind: 'clear'; card: number; since: number }
  /** Waiting for the card to be laid on. */
  | { kind: 'lay'; card: number; since: number }
  /** The reader noticed the card; waiting for what the box read. */
  | { kind: 'reading'; card: number; since: number }
  /** The round is done; waiting for the card to be taken off (TNG: until "Card Rem" plus a moment; 2.1: a fixed time). */
  | { kind: 'remove'; card: number; since: number; removedAt?: number }
  | { kind: 'card-done'; card: number }
  | { kind: 'results' };

export interface ReaderTestOptions {
  /** Rounds per card (default 5). */
  rounds?: number;
  /** Cards per test (default 8). */
  maxCards?: number;
  /** How long a round waits for the card (default 6 s). */
  layWaitMs?: number;
  /** After the card was noticed, how long to wait for what the box read (default 1.5 s). */
  readWaitMs?: number;
  /** After the card left the reader, a moment before the next round (default 0.6 s). */
  settleMs?: number;
  /** TonUINO 2.1 does not report a removed card: time to take it off (default 2.5 s). */
  removeMs?: number;
  /** After connecting, how long to wait for the start of the box (default 6 s). */
  bootWaitMs?: number;
  /** After the start, how long to wait for the reader line (default 5 s; TonUINO 2.1 waits 2 s for the MP3 player first). */
  readerLineWaitMs?: number;
}

export const DEFAULT_ROUNDS = 5;
export const MAX_CARDS = 8;

/** The box noticed the card this often without reading it: then it is busy, e.g. in a menu. */
const MAX_SKIPPED = 3;

type Running = Extract<Phase, { card: number }>;

export class ReaderTest {
  readonly rounds: number;
  readonly maxCards: number;
  phase: Phase = { kind: 'connect' };
  cards: CardResult[] = [];
  reader: ReaderStatus = { state: 'unknown' };
  box: BoxContext = {};
  /** The reader check is behind us (done or skipped). */
  readerChecked = false;
  /** The user went on without the reader check. */
  readerSkipped = false;
  /** The box switched itself off (standby timer) and has not started again since. */
  poweredOff = false;
  /** Starts of the box during the card tests that the app did not ask for. */
  reboots = 0;
  /** Restarts the app asked for while checking the reader. */
  restarts = 0;
  /** The box noticed at least one card during the test. */
  sawCard = false;
  /** The last round that ended, for the screen. */
  last: { card: number; outcome: RoundOutcome | 'skipped' } | undefined;
  /** A card lies on the reader (TNG only: 2.1 does not report removals). */
  present: boolean | undefined;
  /** The connection broke off during a card; its rounds were dropped. */
  interrupted = false;

  private readonly o: Required<Omit<ReaderTestOptions, 'rounds' | 'maxCards'>>;
  private parser = new ReaderLineParser();
  private bootAt: number | undefined;
  /** Until then a start of the box is one that opening the port or the app caused. */
  private bootExpectedUntil = -Infinity;
  /** The dialect of the last detection: decides how a round waits for the card to go. */
  private dialect: FirmwareFamily | undefined;
  /** The last round ended on the card data and the card has not left yet: a "bad ver" line may still follow. */
  private dataRound: { card: number; index: number } | undefined;

  constructor(opts: ReaderTestOptions = {}) {
    this.rounds = Math.max(1, opts.rounds ?? DEFAULT_ROUNDS);
    this.maxCards = Math.max(1, opts.maxCards ?? MAX_CARDS);
    this.o = {
      layWaitMs: opts.layWaitMs ?? 6000,
      readWaitMs: opts.readWaitMs ?? 1500,
      settleMs: opts.settleMs ?? 600,
      removeMs: opts.removeMs ?? 2500,
      bootWaitMs: opts.bootWaitMs ?? 6000,
      readerLineWaitMs: opts.readerLineWaitMs ?? 5000,
    };
  }

  /** The card the test is busy with, if any. */
  get current(): CardResult | undefined {
    const p = this.phase;
    return 'card' in p ? this.cards[p.card] : undefined;
  }

  /** The AiO board (not the AiO+) does not log card events: the card rounds cannot work there. */
  get cardsUntestable(): boolean {
    return this.box.board === 'aio';
  }

  /** How long the current timed phase still runs, 0..1 of its time; undefined when it waits without a limit. */
  remaining(at: number): number | undefined {
    const p = this.phase;
    if (p.kind === 'lay') return clamp01(1 - (at - p.since) / this.o.layWaitMs);
    if (p.kind === 'remove' && this.removeIsTimed()) return clamp01(1 - (at - p.since) / this.o.removeMs);
    return undefined;
  }

  /* -------------------------------------------------------------- inputs */

  /** The port is open. Opening it usually restarts the box, so its start log follows. */
  connected(at: number): void {
    this.parser.reset();
    this.present = undefined;
    this.bootAt = undefined;
    const p = this.phase;
    if (!this.readerChecked) {
      this.phase = { kind: 'reader-check', since: at };
    } else if (isRunning(p)) {
      this.dropCurrent(p.card);
    }
    // Opening the port restarts most boxes; that start is not one to count.
    this.bootExpectedUntil = at + this.o.bootWaitMs * 2;
  }

  /** The connection ended. A card in the middle of its rounds starts over once the box is back. */
  disconnected(): void {
    const p = this.phase;
    if (p.kind === 'reader-check' || p.kind === 'reader-missed') this.phase = { kind: 'connect' };
    else if (isRunning(p)) this.dropCurrent(p.card);
    this.present = undefined;
  }

  /** What the Box-Logbuch already knows from the start of the box, when the test opens on a live connection. */
  seed(info: { firmware?: FirmwareFamily; version?: string; board?: BoardId; rfid?: { ok: boolean; version?: number } }): void {
    if (info.firmware) this.box.firmware = info.firmware;
    if (info.version) this.box.version = info.version;
    if (info.board) this.box.board = info.board;
    if (info.rfid) {
      this.reader = info.rfid.ok && info.rfid.version !== undefined ? readerFromVersion(info.rfid.version) : info.rfid.ok ? { state: 'unknown' } : { state: 'broken', version: info.rfid.version };
    }
    if (this.phase.kind === 'reader-check' && (this.reader.state !== 'unknown' || this.box.board === 'aio')) this.readerDone();
  }

  /** The app restarts the box (DTR). The start that follows is expected. */
  restartRequested(at: number): void {
    this.bootExpectedUntil = at + this.o.bootWaitMs * 2;
    const p = this.phase;
    // A reader that did not answer is checked again, too: the user may have fixed a cable. Until the box starts, the last result stays.
    if (p.kind === 'reader-missed' || (p.kind === 'reader-done' && (this.reader.state === 'unknown' || this.reader.state === 'broken'))) {
      this.restarts++;
      this.readerChecked = false;
      this.readerSkipped = false;
      this.phase = { kind: 'reader-check', since: at };
      this.bootAt = undefined;
    }
  }

  /** Goes on without knowing whether the reader answers. */
  skipReaderCheck(): void {
    if (this.phase.kind !== 'reader-missed' && this.phase.kind !== 'reader-check') return;
    this.readerChecked = true;
    this.readerSkipped = true;
    this.phase = { kind: 'card-ready', card: this.cards.length };
  }

  /** From the reader result to the first card. */
  startCards(): void {
    if (this.phase.kind !== 'reader-done') return;
    this.phase = this.cards.length < this.maxCards ? { kind: 'card-ready', card: this.cards.length } : { kind: 'results' };
  }

  /** Starts the rounds of the card that is ready. */
  startCard(name: string, at: number): void {
    const p = this.phase;
    if (p.kind !== 'card-ready') return;
    this.cards[p.card] = {
      name: name.trim().slice(0, 60),
      rounds: [],
      skipped: 0,
      types: [],
    };
    this.interrupted = false;
    this.last = undefined;
    this.beginRound(p.card, at);
  }

  /** Stops the card in the middle; its rounds are dropped. */
  cancelCard(): void {
    const p = this.phase;
    if (!isRunning(p)) return;
    this.cards.splice(p.card, 1);
    this.phase = { kind: 'card-ready', card: this.cards.length };
    this.last = undefined;
    this.dataRound = undefined;
  }

  /** The card that was just tested, once more with the same name. */
  repeatCard(at: number): void {
    const p = this.phase;
    if (p.kind !== 'card-done') return;
    const name = this.cards[p.card].name;
    this.cards.splice(p.card, 1);
    this.phase = { kind: 'card-ready', card: p.card };
    this.startCard(name, at);
  }

  nextCard(): void {
    if (this.phase.kind !== 'card-done' || this.cards.length >= this.maxCards) return;
    this.phase = { kind: 'card-ready', card: this.cards.length };
    this.last = undefined;
  }

  finish(): void {
    const p = this.phase;
    if (p.kind === 'card-done' || p.kind === 'card-ready' || p.kind === 'reader-done') this.phase = { kind: 'results' };
  }

  /** A line of the serial log. Returns true when the state changed. */
  observe(line: string, at: number): boolean {
    const ev = this.parser.read(line);
    if (!ev) return false;
    switch (ev.kind) {
      case 'boot':
        this.onBoot(ev.firmware, at);
        return true;
      case 'version':
        this.box.version = ev.version;
        return true;
      case 'hardware':
        this.box.board = ev.board;
        return true;
      case 'reader':
        this.reader = readerFromVersion(ev.version);
        if (this.phase.kind === 'reader-check') this.readerDone();
        return true;
      case 'reader-broken':
        this.reader = { ...this.reader, state: 'broken' };
        if (this.phase.kind === 'reader-check') this.readerDone();
        return true;
      case 'detected':
        return this.onDetected(ev.dialect, at);
      case 'removed':
        return this.onRemoved(at);
      case 'type':
        return this.onType(ev.label, ev.family);
      case 'data':
        return this.onData(ev.bytes, at);
      case 'bad-version':
        return this.onBadVersion(at);
      case 'power-off':
        return this.onPowerOff();
      case 'error':
        if (this.phase.kind !== 'reading') return false;
        this.endRound({ outcome: 'unreadable', error: ev.line }, at);
        return true;
    }
  }

  /** Time passes. Returns true when the state changed. */
  tick(at: number): boolean {
    const p = this.phase;
    switch (p.kind) {
      case 'reader-check':
        if (this.bootAt !== undefined) {
          // The AiO prints nothing about the reader unless it is broken.
          if (at - this.bootAt >= (this.box.board === 'aio' ? 2500 : this.o.readerLineWaitMs)) {
            this.readerDone();
            return true;
          }
        } else if (at - p.since >= this.o.bootWaitMs) {
          this.phase = { kind: 'reader-missed' };
          return true;
        }
        return false;
      case 'lay':
        if (at - p.since < this.o.layWaitMs) return false;
        this.endRound({ outcome: 'missed' }, at);
        return true;
      case 'reading':
        if (at - p.since < this.o.readWaitMs) return false;
        this.skipRound(p.card, at);
        return true;
      case 'remove':
        if (this.removeIsTimed() ? at - p.since >= this.o.removeMs : p.removedAt !== undefined && at - p.removedAt >= this.o.settleMs) {
          this.afterRemoval(p.card, at);
          return true;
        }
        return false;
      case 'clear':
        return false;
      default:
        return false;
    }
  }

  /* -------------------------------------------------------------- inner workings */

  private readerDone(): void {
    this.readerChecked = true;
    this.phase = { kind: 'reader-done' };
  }

  private onBoot(firmware: FirmwareFamily, at: number): void {
    const expected = at <= this.bootExpectedUntil;
    // After switching itself off, the box starts because someone switched it on again.
    const wasOff = this.poweredOff;
    this.poweredOff = false;
    this.bootExpectedUntil = -Infinity;
    this.box = { firmware };
    this.bootAt = at;
    this.present = false;
    this.dataRound = undefined;
    this.parser.reset();
    const p = this.phase;
    if (p.kind === 'reader-check') {
      this.reader = { state: 'unknown' };
      return;
    }
    if (!expected && !wasOff && this.readerChecked) this.reboots++;
    // A start in the middle of a round: what the box was doing is gone.
    if (p.kind === 'reading') this.skipRound(p.card, at);
    else if (p.kind === 'clear' || p.kind === 'remove') this.afterRemoval(p.card, at);
  }

  private onDetected(dialect: FirmwareFamily, at: number): boolean {
    this.sawCard = true;
    this.dialect = dialect;
    this.dataRound = undefined;
    if (dialect === 'tng') this.present = true;
    const p = this.phase;
    if (p.kind === 'lay') {
      this.phase = { kind: 'reading', card: p.card, since: at };
      return true;
    }
    if (p.kind === 'remove' && dialect === 'classic21') {
      // TonUINO 2.1 sends the card to sleep after reading it; it only answers again once it was taken off.
      // So a second detection means the card was laid on again before the timed wait was over: that is the next round.
      if (this.cards[p.card].rounds.length >= this.rounds) return false;
      this.phase = { kind: 'reading', card: p.card, since: at };
      return true;
    }
    if (p.kind === 'remove' && p.removedAt !== undefined) {
      // Laid on again before the next round started: wait for it to go.
      this.phase = { kind: 'remove', card: p.card, since: p.since };
      return true;
    }
    return dialect === 'tng';
  }

  /**
   * TNG prints "bad ver" after "CardData", which already ended the round. Older
   * TNG versions reject cards of version 1 that way, which the app still
   * takes for good: then the round counts as written for another firmware.
   */
  private onBadVersion(at: number): boolean {
    const p = this.phase;
    if (p.kind === 'reading') {
      this.endRound({ outcome: 'bad-version' }, at);
      return true;
    }
    const d = this.dataRound;
    this.dataRound = undefined;
    const round = d && this.cards[d.card]?.rounds[d.index];
    if (!d || !round || round.outcome !== 'read') return false;
    round.outcome = 'bad-version';
    if (this.last?.card === d.card) this.last = { card: d.card, outcome: 'bad-version' };
    return true;
  }

  /** The box switched itself off: a card in the middle of its rounds starts over once it is on again. */
  private onPowerOff(): boolean {
    this.poweredOff = true;
    this.present = undefined;
    this.dataRound = undefined;
    const p = this.phase;
    if (isRunning(p)) {
      this.cards.splice(p.card, 1);
      this.phase = { kind: 'card-ready', card: this.cards.length };
      this.last = undefined;
    }
    return true;
  }

  private onRemoved(at: number): boolean {
    this.present = false;
    this.dataRound = undefined;
    const p = this.phase;
    switch (p.kind) {
      case 'reading':
        // Gone before the box said anything: it did not try to read the card.
        this.skipRound(p.card, at);
        return true;
      case 'remove':
        if (p.removedAt === undefined) this.phase = { ...p, removedAt: at };
        return true;
      case 'clear':
        this.phase = { kind: 'remove', card: p.card, since: at, removedAt: at };
        return true;
      default:
        return true;
    }
  }

  private onType(label: string, family: CardFamily): boolean {
    const p = this.phase;
    if (p.kind !== 'reading') return false;
    const card = this.cards[p.card];
    if (label && !card.types.includes(label)) card.types.push(label);
    if (!card.family || card.family === 'classic') card.family = family;
    return true;
  }

  private onData(bytes: number[], at: number): boolean {
    const p = this.phase;
    if (p.kind !== 'reading') return false;
    const card = this.cards[p.card];
    card.data ??= bytes.slice(0, 9);
    // TNG logs the type of every Ultralight/NTAG card; a card read without one is a MIFARE Classic.
    if (this.dialect === 'tng' && !card.family) card.family = 'classic';
    const decoded = decodeCard(Uint8Array.from(bytes));
    switch (decoded.kind) {
      case 'empty':
        card.stop = 'blank';
        break;
      case 'foreign':
        // TNG ignores such a card; TonUINO 2.1 takes it for a new one and opens its menu.
        if (this.dialect === 'classic21') card.stop = 'blank';
        break;
      case 'tonuino':
        if (decoded.data.folder === 0 && decoded.data.mode === ADMIN_MODE) card.stop = 'admin';
        break;
      case 'bad-version':
        break;
    }
    const outcome: RoundOutcome = decoded.kind === 'foreign' ? 'foreign' : decoded.kind === 'bad-version' && this.dialect === 'tng' ? 'bad-version' : 'read';
    this.endRound({ outcome }, at);
    this.dataRound = { card: p.card, index: card.rounds.length - 1 };
    return true;
  }

  private beginRound(card: number, at: number): void {
    this.dataRound = undefined;
    // A TNG box says when a card lies on it; it has to go before the round can count.
    this.phase = this.present ? { kind: 'clear', card, since: at } : { kind: 'lay', card, since: at };
  }

  private endRound(result: RoundResult, at: number): void {
    const p = this.phase as Running;
    const card = this.cards[p.card];
    card.rounds.push(result);
    this.last = { card: p.card, outcome: result.outcome };
    if (card.stop) {
      this.phase = { kind: 'card-done', card: p.card };
      return;
    }
    if (result.outcome === 'missed') {
      if (card.rounds.length >= this.rounds) this.phase = { kind: 'card-done', card: p.card };
      else this.phase = { kind: 'lay', card: p.card, since: at };
      return;
    }
    this.phase = {
      kind: 'remove',
      card: p.card,
      since: at,
      removedAt: this.present === false && !this.removeIsTimed() ? at : undefined,
    };
  }

  /** The box noticed the card but did not read it. The round is repeated; a box that keeps doing so is busy. */
  private skipRound(cardIndex: number, at: number): void {
    const card = this.cards[cardIndex];
    card.skipped++;
    this.last = { card: cardIndex, outcome: 'skipped' };
    if (card.skipped >= MAX_SKIPPED) {
      card.stop = 'busy';
      this.phase = { kind: 'card-done', card: cardIndex };
      return;
    }
    this.phase = {
      kind: 'remove',
      card: cardIndex,
      since: at,
      removedAt: this.present === false && !this.removeIsTimed() ? at : undefined,
    };
  }

  private afterRemoval(cardIndex: number, at: number): void {
    const card = this.cards[cardIndex];
    if (card.rounds.length >= this.rounds) this.phase = { kind: 'card-done', card: cardIndex };
    else this.beginRound(cardIndex, at);
  }

  /** TonUINO 2.1 does not say when a card leaves; then the round waits a fixed time. */
  private removeIsTimed(): boolean {
    return this.dialect !== 'tng';
  }

  private dropCurrent(cardIndex: number): void {
    this.cards.splice(cardIndex, 1);
    this.phase = { kind: 'card-ready', card: this.cards.length };
    this.interrupted = true;
    this.last = undefined;
    this.dataRound = undefined;
  }
}

function isRunning(p: Phase): p is Extract<Phase, { kind: 'clear' | 'lay' | 'reading' | 'remove' }> {
  return p.kind === 'clear' || p.kind === 'lay' || p.kind === 'reading' || p.kind === 'remove';
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function readerFromVersion(version: number): ReaderStatus {
  const { chip, ok } = rfidChip(version);
  if (!ok) return { state: 'broken', version, chip };
  const doubtful = version === 0x12 || chip.startsWith('unbekannt');
  return { state: doubtful ? 'warn' : 'ok', version, chip };
}

/* ------------------------------------------------------------------ verdicts */

export interface CardStats {
  /** Rounds counted. */
  total: number;
  /** Rounds the box read the card, whatever was on it. */
  ok: number;
  read: number;
  badVersion: number;
  foreign: number;
  unreadable: number;
  missed: number;
}

export function cardStats(card: CardResult): CardStats {
  const s: CardStats = {
    total: card.rounds.length,
    ok: 0,
    read: 0,
    badVersion: 0,
    foreign: 0,
    unreadable: 0,
    missed: 0,
  };
  for (const r of card.rounds) {
    if (r.outcome === 'read') s.read++;
    else if (r.outcome === 'bad-version') s.badVersion++;
    else if (r.outcome === 'foreign') s.foreign++;
    else if (r.outcome === 'unreadable') s.unreadable++;
    else s.missed++;
  }
  s.ok = s.read + s.badVersion + s.foreign;
  return s;
}

export type Tone = 'ok' | 'warn' | 'error' | 'neutral';

export type CardVerdictKind =
  /** Read every time. */
  | 'good'
  /** One round of four or more went wrong. */
  | 'mostly'
  /** Read every time, but written for another firmware. */
  | 'wrong-version'
  /** Read every time, but without TonUINO data. */
  | 'foreign'
  /** Read in some rounds only. */
  | 'flaky'
  /** Noticed, never read. */
  | 'never-read'
  /** Never noticed. */
  | 'never-seen'
  | 'blank'
  | 'admin'
  | 'busy'
  | 'untested';

export interface CardVerdict {
  kind: CardVerdictKind;
  tone: Tone;
  title: string;
  text: string;
}

export interface HelpLinkRef {
  label: string;
  href: string;
}

export const CARD_TYPES_HELP: HelpLinkRef = {
  label: 'Welche Karten passen?',
  href: '#/hilfe/kartentypen',
};
export const WRITE_CARDS: HelpLinkRef = {
  label: 'Karten beschreiben',
  href: '#/karten',
};

/** "Karte 2" or "Karte 2 „Biene Maja“". */
export function cardLabel(card: CardResult, index: number): string {
  return card.name ? `Karte ${index + 1} „${card.name}“` : `Karte ${index + 1}`;
}

/** The kind of the card the firmware reported, in plain words: "NTAG213", "MIFARE Classic 1K". */
export function cardTypeText(card: CardResult): string | undefined {
  return card.types.length ? card.types.join(', ') : undefined;
}

/** Compares "3.2.0" with "3.2.1". */
function versionBefore(version: string, than: string): boolean {
  const a = version.split('.').map(Number);
  const b = than.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** The firmware cannot read NTAG215 (TonUINO 2.1 and TNG before 3.2.1), or it is not known. */
function ntag215Unsupported(box: BoxContext): boolean | undefined {
  if (box.firmware === 'classic21') return true;
  if (box.firmware === 'tng' && box.version) return versionBefore(box.version, '3.2.1');
  return undefined;
}

/** A sentence about NTAG215, when the firmware may be the reason an NTAG card fails. */
function ntag215Hint(card: CardResult | undefined, box: BoxContext): string {
  const unsupported = ntag215Unsupported(box);
  if (unsupported === false) return '';
  // TNG names the NTAG type; 2.1 cannot tell NTAG215 from the others.
  if (card && card.types.some((t) => /^NTAG21[36]$/.test(t))) return '';
  const firmware = box.firmware === 'classic21' ? 'TonUINO 2.1' : box.firmware === 'tng' && box.version ? `TonUINO TNG ${box.version}` : 'TonUINO 2.1 und TNG vor Version 3.2.1';
  const reads = box.firmware ? 'liest' : 'lesen';
  return ` Steht auf der Packung NTAG215? Das ${reads} ${firmware} nicht. Nimm NTAG213 oder NTAG216, oder spiele eine neuere Firmware auf.`;
}

export function cardVerdict(card: CardResult, box: BoxContext = {}): CardVerdict {
  const s = cardStats(card);
  if (card.stop === 'blank') {
    return {
      kind: 'blank',
      tone: 'neutral',
      title: 'Leere Karte',
      text:
        box.firmware === 'classic21' && s.foreign
          ? 'Auf der Karte stehen keine Daten für TonUINO. Die Box hat sie gelesen und will sie jetzt neu anlernen. Beschreibe die Karte erst, dann teste sie noch einmal.'
          : 'Die Box hat die Karte gelesen, aber sie ist noch leer. Dann will die Box sie anlernen. Beschreibe die Karte erst, dann teste sie noch einmal.',
    };
  }
  if (card.stop === 'admin') {
    return {
      kind: 'admin',
      tone: 'neutral',
      title: 'Admin-Karte',
      text: 'Die Box hat die Karte gelesen und das Admin-Menü geöffnet. Nimm für den Test Karten, die Musik abspielen.',
    };
  }
  if (card.stop === 'busy' && s.total === 0) {
    return {
      kind: 'busy',
      tone: 'neutral',
      title: 'Nicht getestet',
      text: 'Die Box hat die Karte bemerkt, aber nicht gelesen. Sie war wohl gerade in einem Menü. Starte die Box neu und teste die Karte noch einmal.',
    };
  }
  if (s.total === 0)
    return {
      kind: 'untested',
      tone: 'neutral',
      title: 'Nicht getestet',
      text: 'Für diese Karte gibt es kein Ergebnis.',
    };

  const failures = s.total - s.ok;
  if (failures === 0) {
    if (s.badVersion) {
      return {
        kind: 'wrong-version',
        tone: 'warn',
        title: 'Gelesen, aber falsch beschrieben',
        text: `Die Box liest die Karte jedes Mal. Sie ist aber für eine andere TonUINO-Version beschrieben, darum spielt die Box nichts. Beschreibe sie neu.${
          box.firmware === 'tng' && card.data?.[4] === 1 ? ' Oder spiele eine neuere Firmware auf: Neuere Versionen von TonUINO TNG lesen auch solche älteren Karten.' : ''
        }`,
      };
    }
    if (s.foreign) {
      return {
        kind: 'foreign',
        tone: 'warn',
        title: 'Gelesen, aber nicht für TonUINO',
        text: 'Die Box liest die Karte jedes Mal. Es stehen aber keine Daten für TonUINO darauf. Beschreibe sie neu.',
      };
    }
    return {
      kind: 'good',
      tone: 'ok',
      title: 'Klappt',
      text: 'Die Box hat die Karte jedes Mal gelesen.',
    };
  }
  if (failures === 1 && s.total >= 4) {
    return {
      kind: 'mostly',
      tone: 'ok',
      title: 'Klappt fast immer',
      text: s.missed
        ? 'Einmal hat die Box die Karte nicht bemerkt. Vielleicht lag sie zu kurz oder nicht mittig auf.'
        : 'Einmal konnte die Box die Karte nicht lesen. Das passiert, wenn sie zu schnell wieder weggenommen wird.',
    };
  }
  if (s.ok === 0 && s.unreadable === 0) {
    return {
      kind: 'never-seen',
      tone: 'error',
      title: 'Wird gar nicht bemerkt',
      text: 'Die Box hat die Karte kein einziges Mal bemerkt. Karten mit 125 kHz statt 13,56 MHz bemerkt sie nie. Sonst ist die Karte vielleicht kaputt, etwa geknickt oder beim Lochen beschädigt, oder sie stammt aus einer schlechten Packung.',
    };
  }
  if (s.ok === 0) {
    let why: string;
    if (card.family === 'other') {
      const type = cardTypeText(card);
      why = `Diesen Kartentyp${type ? ` (${type})` : ''} kann die Box nicht lesen.`;
    } else if (card.family === 'ultralight') {
      why = `Vielleicht passt der Kartentyp nicht.${ntag215Hint(card, box)}`;
    } else {
      why = 'Vielleicht passt der Kartentyp nicht, oder eine Handy-App hat die Karte verändert.';
    }
    return {
      kind: 'never-read',
      tone: 'error',
      title: 'Bemerkt, aber nie gelesen',
      text: `Die Box bemerkt die Karte, kann sie aber nicht lesen. ${why}`,
    };
  }
  const mostlyMissed = s.missed >= s.unreadable;
  return {
    kind: 'flaky',
    tone: 'warn',
    title: 'Klappt nur manchmal',
    text: mostlyMissed ? 'Oft hat die Box die Karte gar nicht bemerkt.' : 'Oft hat die Box die Karte bemerkt, konnte sie aber nicht lesen.',
  };
}

export type OverallKind =
  | 'reader-dead'
  | 'aio'
  | 'no-cards'
  | 'all-good'
  | 'no-signal'
  | 'one-card-only'
  | 'sees-nothing'
  | 'reader-weak'
  | 'type-fails'
  | 'one-card'
  | 'some-cards'
  /** Many cards fail completely: the cards or the reader. */
  | 'cards-or-reader'
  | 'cards-content';

export interface Advice {
  kind: OverallKind;
  tone: Tone;
  title: string;
  text: string;
  /** What to try, in this order. */
  steps: string[];
  links: HelpLinkRef[];
  /** Further things worth knowing: a doubtful reader chip, starts of the box during the test. */
  notes: string[];
}

export interface TestResult {
  reader: ReaderStatus;
  box: BoxContext;
  cards: CardResult[];
  reboots: number;
  /** The box noticed at least one card. */
  sawCard: boolean;
  /** The reader check ran (it may still not know). */
  readerChecked: boolean;
  /** The user went on without the reader check. */
  readerSkipped?: boolean;
}

export function resultOf(t: ReaderTest): TestResult {
  return {
    reader: t.reader,
    box: t.box,
    cards: t.cards,
    reboots: t.reboots,
    sawCard: t.sawCard,
    readerChecked: t.readerChecked,
    readerSkipped: t.readerSkipped,
  };
}

const READER_HELP: HelpLinkRef = {
  label: 'Was die Ergebnisse vom Kartenleser-Test heißen',
  href: '#/hilfe/kartenleser-testen',
};

/** What to check when the reader does not answer, by board. */
function wiringSteps(board: BoardId | undefined): string[] {
  if (board === 'aio' || board === 'aioplus') {
    return [
      'Prüfe das Kabel zwischen Platine und Kartenleser und ob der Stecker richtig herum steckt.',
      'Hilft das nicht, tausche den Kartenleser aus. Bleibt es dabei, frage im TonUINO-Forum (discourse.voss.earth) nach.',
    ];
  }
  return [
    'Prüfe die Kabel und Lötstellen zwischen Kartenleser und Platine. Steckkabel gehen auch mal kaputt: Tausche sie testweise aus.',
    'Verkable nach der Beschriftung an den Pins, nicht nach ihrer Lage: Bei manchen Kartenlesern liegen die Anschlüsse anders.',
    'Der Kartenleser braucht 3,3 V, nicht 5 V. Miss nach, ob die 3,3 V wirklich ankommen.',
    'Hilft das nicht, tausche den Kartenleser aus.',
  ];
}

/** What to check when the reader answers but reads badly. */
function weakReaderSteps(board: BoardId | undefined): string[] {
  const steps = [
    'Lege die Karten mittig auf die Stelle über dem Kartenleser. Klappt es nur ganz nah, ist der Kartenleser zu schwach oder zu weit weg.',
    'Zwischen Kartenleser und Karte darf nichts stören: eine dicke Gehäusewand, Metall, ein LED-Ring oder ein Akku.',
  ];
  if (board === 'aio' || board === 'aioplus') steps.push('Prüfe das Kabel zwischen Platine und Kartenleser.');
  else steps.push('Prüfe die Kabel und Lötstellen zum Kartenleser und ob er stabil 3,3 V bekommt.');
  steps.push('Probiere ein anderes Netzteil oder einen vollen Akku.');
  steps.push('Hilft das alles nicht, tausche den Kartenleser aus (RC522).');
  return steps;
}

const FAILING = new Set<CardVerdictKind>(['flaky', 'never-read', 'never-seen']);
/** The reader read these cards; what is on them is another matter. */
const READ_FINE = new Set<CardVerdictKind>(['good', 'mostly', 'wrong-version', 'foreign']);

const FAMILY_NAMES: Record<CardFamily, string> = {
  classic: 'MIFARE Classic',
  ultralight: 'NTAG oder MIFARE Ultralight',
  other: 'anderer Kartentyp',
};

export function overallVerdict(r: TestResult): Advice {
  const notes = readerNotes(r);
  const advice = (kind: OverallKind, tone: Tone, title: string, text: string, steps: string[] = [], links: HelpLinkRef[] = []): Advice => ({
    kind,
    tone,
    title,
    text,
    steps,
    links,
    notes,
  });

  if (r.reader.state === 'broken') {
    return advice(
      'reader-dead',
      'error',
      'Der Kartenleser in der Box antwortet nicht',
      'Beim Start bekommt die Box keine Antwort vom Kartenleser. Dann erkennt sie keine einzige Karte. An den Karten liegt es nicht.',
      wiringSteps(r.box.board),
      [READER_HELP],
    );
  }
  if (r.box.board === 'aio' && !r.sawCard) {
    return advice(
      'aio',
      'neutral',
      'Mit dieser Box geht der Test nicht',
      'Die Firmware der AiO-Platine meldet aufgelegte Karten nicht über USB. Darum kann ich nicht mitzählen. Fehler beim Lesen einer Karte meldet sie aber, die siehst du im Box-Logbuch.',
      [
        'Öffne das Box-Logbuch und lege eine Karte auf, die nicht klappt. Steht dort eine Fehlermeldung, kann die Box diese Karte nicht lesen.',
        'Probiere auch eine Karte, die sicher klappt, etwa eine frisch angelernte. Reagiert die Box auch auf sie nicht, liegt es eher am Kartenleser oder an seinem Kabel.',
      ],
    );
  }

  const verdicts = r.cards.map((c) => ({ card: c, v: cardVerdict(c, r.box) }));
  const tested = verdicts.filter((x) => READ_FINE.has(x.v.kind) || FAILING.has(x.v.kind));
  const good = tested.filter((x) => READ_FINE.has(x.v.kind));
  const bad = tested.filter((x) => FAILING.has(x.v.kind));

  if (!tested.length) {
    return advice(
      'no-cards',
      'neutral',
      r.reader.state === 'ok' || r.reader.state === 'warn' ? 'Der Kartenleser antwortet' : 'Noch keine Karte getestet',
      r.reader.state === 'ok' || r.reader.state === 'warn'
        ? 'Beim Start hat sich der Kartenleser gemeldet. Ob er Karten gut liest, zeigt erst der Test mit Karten. Nimm dafür Karten, die schon Musik abspielen.'
        : 'Teste mindestens eine Karte, die schon Musik abspielt. Am besten zwei oder mehr, gern aus verschiedenen Packungen.',
    );
  }

  // Rounds that went wrong on cards that worked otherwise: a single slip is nothing, slips on several cards are.
  const slips = good.filter((x) => x.v.kind === 'mostly');
  let rounds = 0;
  let failed = 0;
  for (const x of tested) {
    const s = cardStats(x.card);
    rounds += s.total;
    failed += s.total - s.ok;
  }

  if (!bad.length) {
    const content = good.filter((x) => x.v.kind === 'wrong-version' || x.v.kind === 'foreign');
    const contentText = (lead: string, verb = '') =>
      `${lead} ${content.length === 1 ? 'einer Karte' : `${content.length} Karten`}${verb ? ` ${verb}` : ''} Daten, mit denen die Box nichts anfangen kann. Beschreibe ${content.length === 1 ? 'sie' : 'diese Karten'} neu.`;
    if (slips.length >= 2 && failed * 10 >= rounds) {
      return advice(
        'reader-weak',
        'warn',
        'Die Box liest die Karten nicht immer',
        `Jede Karte hat meistens geklappt. Aber bei ${slips.length} von ${good.length} Karten ging eine Runde schief. Das spricht eher für den Kartenleser in der Box als für die Karten.${content.length ? ` ${contentText('Außerdem stehen auf')}` : ''}`,
        weakReaderSteps(r.box.board),
        content.length ? [READER_HELP, WRITE_CARDS] : [READER_HELP],
      );
    }
    const reliably = slips.length ? '' : ' zuverlässig';
    const slipText = !slips.length
      ? ''
      : slips.length === 1
        ? ' Bei einer Karte ging einmal eine Runde schief. Das passiert, wenn sie zu kurz oder nicht mittig liegt.'
        : ` Bei ${slips.length} Karten ging je einmal eine Runde schief. Passiert das öfter, teste noch einmal.`;
    if (content.length) {
      return advice('cards-content', 'warn', 'Der Kartenleser funktioniert', `Die Box hat alle Karten${reliably} gelesen.${slipText} ${contentText('Auf', 'stehen aber')}`, [], [WRITE_CARDS]);
    }
    return advice(
      'all-good',
      'ok',
      'Der Kartenleser funktioniert',
      good.length === 1
        ? `Die Box hat die Karte ${slips.length ? 'fast jedes Mal' : 'zuverlässig'} gelesen. Klappt eine andere Karte nicht, teste sie hier auch: Dann siehst du, ob es an ihr liegt.`
        : `Die Box hat alle ${good.length} Karten${reliably} gelesen.${slipText}`,
    );
  }

  // Nothing was ever noticed and the start of the box is unknown: maybe the firmware just does not report cards.
  if (!r.sawCard && r.reader.state === 'unknown') {
    return advice(
      'no-signal',
      'warn',
      'Die Box hat keine Karte gemeldet',
      'Während des Tests kam keine einzige Meldung über eine Karte. Entweder erkennt der Kartenleser keine Karte, oder die Firmware deiner Box meldet aufgelegte Karten nicht. So ist es zum Beispiel bei der AiO-Platine. Starte die Box neu und teste noch einmal: Dann sehe ich beim Start, ob der Kartenleser antwortet.',
      [],
      [READER_HELP],
    );
  }

  const typeRule = typePattern(
    good.map((x) => x.card),
    bad.map((x) => x.card),
  );
  if (typeRule) {
    const failing = bad[0].card;
    const goodNames = typeRule.good ? `Karten vom Typ ${FAMILY_NAMES[typeRule.good]}` : 'die anderen Karten';
    let text: string;
    if (typeRule.bad === 'ultralight') {
      text = `Karten vom Typ ${FAMILY_NAMES.ultralight}, etwa Sticker oder Anhänger, liest die Box nicht, ${goodNames} schon.${ntag215Hint(failing, r.box)} Sticker mit „Ultralight C“ werden manchmal als NTAG verkauft und nur ganz nah am Kartenleser gelesen. Kleine Sticker liest die Box oft schlecht.`;
    } else if (typeRule.bad === 'other') {
      const type = cardTypeText(failing);
      text = `Diesen Kartentyp${type ? ` (${type})` : ''} kann die Box nicht lesen, ${goodNames} schon. Nimm Karten vom Typ MIFARE Classic, NTAG213 oder NTAG216.`;
    } else {
      text = `Karten vom Typ ${FAMILY_NAMES.classic} liest die Box nicht, ${goodNames} schon. Vielleicht hat eine Handy-App diese Karten verändert, oder sie sind aus einer schlechten Packung.`;
    }
    return advice('type-fails', 'warn', 'Nur ein Kartentyp macht Probleme', `Der Kartenleser funktioniert. ${text}`, [], [CARD_TYPES_HELP]);
  }

  if (!good.length) {
    // All noticed, none read, all of one type the box may not read: compare with another type first.
    const family = bad[0].card.family;
    if (bad.length > 1 && (family === 'ultralight' || family === 'other') && bad.every((x) => x.v.kind === 'never-read' && x.card.family === family)) {
      const type = cardTypeText(bad[0].card);
      const why =
        family === 'other'
          ? `Diesen Kartentyp${type ? ` (${type})` : ''} kann die Box nicht lesen. Nimm Karten vom Typ MIFARE Classic, NTAG213 oder NTAG216.`
          : `Alle sind vom Typ ${FAMILY_NAMES.ultralight}. Vielleicht passt der Kartentyp nicht.${ntag215Hint(bad[0].card, r.box)}`;
      return advice(
        'type-fails',
        'warn',
        'Die Box liest keine dieser Karten',
        family === 'other'
          ? `Die Box bemerkt die Karten, kann aber keine lesen. ${why}`
          : `Die Box bemerkt die Karten, kann aber keine lesen. ${why} Teste zum Vergleich eine Karte vom Typ MIFARE Classic. Klappt auch die nicht, liegt es am Kartenleser in der Box.`,
        [],
        [CARD_TYPES_HELP, READER_HELP],
      );
    }
    if (bad.length === 1) {
      return advice(
        'one-card-only',
        'warn',
        `${capitalize(cardLabel(bad[0].card, r.cards.indexOf(bad[0].card)))} klappt nicht`,
        'Ob die Karte oder der Kartenleser schuld ist, zeigt erst eine zweite Karte. Teste noch eine Karte, die woanders schon geklappt hat oder aus einer anderen Packung kommt.',
        [],
        [CARD_TYPES_HELP],
      );
    }
    if (bad.every((x) => x.v.kind === 'never-seen')) {
      return advice(
        'sees-nothing',
        'error',
        'Die Box bemerkt keine Karte',
        `${r.reader.state === 'unknown' ? 'Die Box' : 'Der Kartenleser antwortet zwar, aber die Box'} hat keine der Karten bemerkt. Haben alle Karten 13,56 MHz? Karten mit 125 kHz bemerkt die Box nie. Sonst liegt es am Kartenleser in der Box, an seiner Verbindung oder an etwas, das zwischen Karte und Kartenleser stört.`,
        [...weakReaderSteps(r.box.board)],
        [CARD_TYPES_HELP, READER_HELP],
      );
    }
    return advice('reader-weak', 'error', 'Keine Karte klappt zuverlässig', 'Machen alle Karten Probleme, liegt es eher am Kartenleser in der Box als an den Karten.', weakReaderSteps(r.box.board), [
      READER_HELP,
      CARD_TYPES_HELP,
    ]);
  }

  const flaky = bad.filter((x) => x.v.kind === 'flaky').length;
  if (bad.length === 1) {
    const b = bad[0];
    const name = cardLabel(b.card, r.cards.indexOf(b.card));
    if (good.length >= 2) {
      return advice(
        'one-card',
        'warn',
        `Nur ${name} macht Probleme`,
        `Der Kartenleser funktioniert: Die anderen Karten liest die Box gut. ${capitalize(name)} ist wahrscheinlich kaputt oder passt nicht. ${b.v.text} Nimm eine andere Karte.`,
        [],
        [CARD_TYPES_HELP],
      );
    }
    // One good card against one bad one: the bad card is the likely reason, but not for sure.
    return advice(
      'one-card',
      'warn',
      `Nur ${name} macht Probleme`,
      `Die andere Karte liest die Box gut. Darum liegt es wohl eher an dieser Karte als am Kartenleser. ${b.v.text}${
        flaky ? ' Klappt eine Karte nur manchmal, kann aber auch der Kartenleser schuld sein.' : ''
      } Teste zur Sicherheit noch eine Karte. Klappt sie, nimm statt ${name} eine andere Karte.`,
      flaky ? weakReaderSteps(r.box.board) : [],
      flaky ? [CARD_TYPES_HELP, READER_HELP] : [CARD_TYPES_HELP],
    );
  }

  if (flaky >= 2) {
    return advice(
      'reader-weak',
      'warn',
      'Mehrere Karten klappen nur manchmal',
      'Klappen mehrere Karten nur ab und zu, liegt es eher am Kartenleser in der Box als an den Karten.',
      weakReaderSteps(r.box.board),
      [READER_HELP, CARD_TYPES_HELP],
    );
  }
  const earlier = 'Haben die Karten, die nicht klappen, früher in dieser Box geklappt, oder klappen sie in einer anderen Box? Dann liegt es am Kartenleser in der Box.';
  // A card the box read now and then is not one it does not read at all.
  const notRead = flaky ? 'nicht oder nur manchmal' : 'nicht';
  if (good.length > bad.length) {
    // The failing cards are a clear minority: most likely the cards.
    return advice(
      'some-cards',
      'warn',
      'Einige Karten klappen nicht',
      `${capitalize(countWord(good.length))} Karten liest die Box gut, ${countWord(bad.length)} ${notRead}. Darum liegt es wohl eher an diesen ${countWord(bad.length)} Karten: Sie sind vielleicht kaputt oder passen nicht. Kommen sie aus derselben Packung, ist vielleicht die ganze Packung schlecht.${
        flaky ? ' Klappt eine Karte nur manchmal, kann aber auch der Kartenleser schuld sein.' : ''
      } ${earlier}`,
      flaky ? weakReaderSteps(r.box.board) : [],
      [CARD_TYPES_HELP, READER_HELP],
    );
  }
  return advice(
    'cards-or-reader',
    'warn',
    'Viele Karten klappen nicht',
    `Nur ${countWord(good.length)} ${good.length === 1 ? 'Karte' : 'Karten'} liest die Box gut, ${countWord(bad.length)} ${notRead}. Das kann an den Karten liegen oder am Kartenleser in der Box. ${earlier} Sonst sind die Karten wohl kaputt oder passen nicht.`,
    weakReaderSteps(r.box.board),
    [READER_HELP, CARD_TYPES_HELP],
  );
}

/**
 * Failing cards are all of one known type, and the working cards of other
 * types: then the type is the reason. Only cards the box never read count: a
 * card it read now and then shows that it can read that type. One card of each
 * type is too little to tell the type from that one card.
 */
function typePattern(good: CardResult[], bad: CardResult[]): { bad: CardFamily; good?: CardFamily } | null {
  if (!bad.length || !bad.every((c) => cardStats(c).ok === 0)) return null;
  const badFamily = bad[0].family;
  if (!badFamily || !bad.every((c) => c.family === badFamily)) return null;
  if (!good.length || good.some((c) => !c.family || c.family === badFamily)) return null;
  if (bad.length < 2 && good.length < 2) return null;
  const goodFamilies = new Set(good.map((c) => c.family));
  return {
    bad: badFamily,
    good: goodFamilies.size === 1 ? good[0].family : undefined,
  };
}

/** The reader chip, in plain words for the screen. */
export function readerChipNote(reader: ReaderStatus): string | undefined {
  if (reader.state !== 'warn' || reader.version === undefined) return undefined;
  return reader.version === 0x12
    ? 'Der Kartenleser meldet sich als Nachbau. Viele davon funktionieren. Werden Karten schlecht erkannt, tausche ihn testweise aus.'
    : 'Den Chip im Kartenleser kenne ich nicht. Vielleicht ist es ein Nachbau. Werden Karten schlecht erkannt, tausche den Kartenleser testweise aus.';
}

function readerNotes(r: TestResult): string[] {
  const notes: string[] = [];
  const chip = readerChipNote(r.reader);
  if (chip) notes.push(chip);
  if (r.reboots > 0) {
    notes.push(
      `Die Box ist während des Tests ${r.reboots === 1 ? 'einmal' : `${r.reboots}-mal`} neu gestartet. Hast du sie nicht selbst neu gestartet, ist vielleicht kurz der Strom weggebrochen. Probiere ein anderes Netzteil oder einen vollen Akku.`,
    );
  }
  return notes;
}

const COUNT_WORDS = ['keine', 'eine', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht'];

/** "zwei" for 2: reads better in a sentence than the digit. */
function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "5 von 5" */
export function rateText(card: CardResult): string {
  const s = cardStats(card);
  return `${s.ok} von ${s.total}`;
}

/** "2 × nicht bemerkt, 1 × nicht lesbar" for the rounds that went wrong; empty when none did. */
export function failureText(card: CardResult): string {
  const s = cardStats(card);
  const parts: string[] = [];
  if (s.unreadable) parts.push(`${s.unreadable} × bemerkt, aber nicht lesbar`);
  if (s.missed) parts.push(`${s.missed} × nicht bemerkt`);
  return parts.join(', ');
}

/**
 * What the reader check found, in one line. On screen in plain words; for the
 * forum (`forum`) with the chip and the value of its version register.
 */
export function readerText(r: Pick<TestResult, 'reader' | 'box' | 'readerChecked' | 'readerSkipped'>, forum = false): string {
  const { reader } = r;
  switch (reader.state) {
    case 'ok':
      return forum ? `antwortet (${reader.chip}, Kennung ${reader.version})` : 'antwortet';
    case 'warn': {
      const what = reader.version === 0x12 ? 'Nachbau-Chip' : 'Chip unbekannt';
      return forum ? `antwortet, ${what} (Kennung ${reader.version})` : `antwortet, ${what}`;
    }
    case 'broken':
      return forum && reader.version !== undefined ? `antwortet nicht (Kennung ${reader.version})` : 'antwortet nicht';
    case 'unknown':
      if (r.box.board === 'aio') return 'keine Meldung beim Start (die AiO meldet ihn nur, wenn er nicht antwortet)';
      return r.readerChecked && !r.readerSkipped ? 'keine Meldung beim Start' : 'nicht geprüft';
  }
}

function boxText(box: BoxContext): string | undefined {
  const parts: string[] = [];
  if (box.firmware === 'tng') parts.push(`TonUINO TNG${box.version ? ` ${box.version}` : ''}`);
  else if (box.firmware === 'classic21') parts.push('TonUINO 2.1');
  if (box.board) parts.push(`Platine ${getBoard(box.board).shortName}`);
  return parts.length ? parts.join(', ') : undefined;
}

function germanDate(at: number): string {
  const d = new Date(at);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

/** The result as plain text for a forum post. */
export function resultText(r: TestResult, rounds: number, at: number): string {
  const lines: string[] = [`Kartenleser-Test aus TonUINO Studio, ${germanDate(at)}`];
  const box = boxText(r.box);
  if (box) lines.push(`Box: ${box}`);
  lines.push(`Kartenleser: ${readerText(r, true)}`);
  if (r.cards.length) lines.push(`Jede Karte ${rounds}-mal aufgelegt und wieder weggenommen.`);
  lines.push('');
  r.cards.forEach((card, i) => {
    const v = cardVerdict(card, r.box);
    const s = cardStats(card);
    const bits: string[] = [];
    if (s.total) bits.push(`${rateText(card)} gelesen`);
    const fail = failureText(card);
    if (fail) bits.push(fail);
    const type = cardTypeText(card);
    if (type) bits.push(type);
    const error = card.rounds.find((x) => x.error)?.error;
    if (error) bits.push(`Meldung: ${error}`);
    lines.push(`${cardLabel(card, i)}: ${bits.length ? `${bits.join(', ')}. ` : ''}${v.title}.`);
  });
  if (r.cards.length) lines.push('');
  const a = overallVerdict(r);
  lines.push(`Ergebnis: ${a.title}. ${a.text}`);
  for (const n of a.notes) lines.push(n);
  return lines.join('\n');
}
