/**
 * „Über USB an die Box“: the box writes the cards itself (TODO #93). One card
 * after the other: send WRITECARD, the box asks for the card, writes it and
 * says OK once the card is off again; then the card is laid on once more and
 * the box reads it back (its log shows the bytes on a Classic; elsewhere the
 * user listens). The protocol and its traps live in
 * core/firmware/writecard.ts; this drives it for a list of cards and knows
 * nothing about the page.
 */
import type { CardData } from '../../core/tonuino/card';
import { CANCEL_LINE, WriteCardRun, isFinished, readBack, writeCardCommand, type ReadBack, type RunPhase } from '../../core/firmware/writecard';

/** The connection to the box (logsession.ts in the app, a fake in the tests). */
export interface BoxLink {
  send(line: string): Promise<void>;
  onLine(listener: (line: string, now: number) => void): () => void;
}

export interface UsbCard {
  key: string;
  title: string;
  data: CardData;
}

export type UsbProblem =
  /** The box did not react: it plays, is in its menu, or a card lies on it. */
  | 'no-answer'
  /** The box refused the values at once. */
  | 'refused'
  /** Writing failed (the box played its error sound), or it wrote something else. */
  | 'failed'
  | 'cancelled'
  /** The box restarted meanwhile. */
  | 'interrupted'
  /** The line could not be sent (connection gone). */
  | 'send-failed'
  /** This card cannot be written over USB (writecard.ts writeCardCommand). */
  | 'not-possible';

export type UsbStep =
  | { kind: 'idle' }
  /** Sent; waiting for the box to start. */
  | { kind: 'starting'; index: number }
  | { kind: 'place'; index: number }
  | { kind: 'remove'; index: number }
  /** Written. Lay the card on again: `log` the box's log shows what it read, `listen` the user checks by ear. */
  | { kind: 'check'; index: number; how: 'log' | 'listen'; result?: ReadBack }
  | { kind: 'problem'; index: number; problem: UsbProblem; detail?: string }
  /** All cards went through. */
  | { kind: 'done' };

export type CardOutcome = 'written' | 'checked' | 'wrong' | 'failed';

export interface WriterOptions {
  now?: () => number;
  /** How long the box may take to start (writecard.ts RunOptions.startMs). */
  startMs?: number;
}

export class UsbCardWriter {
  step: UsbStep = { kind: 'idle' };
  readonly outcomes = new Map<string, CardOutcome>();
  private run: WriteCardRun | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly stopLines: () => void;
  private readonly now: () => number;

  constructor(
    readonly cards: readonly UsbCard[],
    private readonly link: BoxLink,
    private readonly opts: WriterOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.stopLines = link.onLine((line, now) => this.line(line, now));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.stopLines();
    this.listeners.clear();
  }

  /** Busy with a card: the box waits for it, or is about to. */
  get running(): boolean {
    const k = this.step.kind;
    return k === 'starting' || k === 'place' || k === 'remove';
  }

  /** The first card not written yet that the box can write, or -1. */
  firstOpen(): number {
    return this.cards.findIndex((c) => this.open(c));
  }

  private open(c: UsbCard): boolean {
    return !isWritten(this.outcomes.get(c.key)) && writeCardCommand(c.data).ok;
  }

  /** Why a card cannot be written over USB, or undefined. */
  static problemOf(card: CardData): string | undefined {
    const c = writeCardCommand(card);
    return c.ok ? undefined : c.reason;
  }

  /** Sends the command for card `index`. */
  async start(index: number): Promise<void> {
    if (this.running) return;
    const card = this.cards[index];
    if (!card) {
      this.set({ kind: 'done' });
      return;
    }
    const cmd = writeCardCommand(card.data);
    if (!cmd.ok) {
      this.set({ kind: 'problem', index, problem: 'not-possible', detail: cmd.reason });
      return;
    }
    const run = new WriteCardRun(card.data, this.now(), { startMs: this.opts.startMs });
    this.run = run;
    this.set({ kind: 'starting', index });
    try {
      await this.link.send(cmd.line);
    } catch (e) {
      if (this.run !== run) return;
      this.run = null;
      this.set({ kind: 'problem', index, problem: 'send-failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Abbrechen: the box stops waiting for the card (it answers ERR). */
  async cancel(): Promise<void> {
    const run = this.run;
    if (!run || isFinished(run.phase)) {
      this.set({ kind: 'idle' });
      return;
    }
    run.cancelSent();
    try {
      await this.link.send(CANCEL_LINE);
    } catch {
      // Gone anyway.
    }
    // Without an answer (the box never started) nothing else would end it.
    if (run.phase.kind === 'sent' && this.run === run) {
      this.run = null;
      this.set({ kind: 'idle' });
    }
  }

  /** The user's answer when the box's log does not show the card. */
  confirmCheck(right: boolean): void {
    const s = this.step;
    if (s.kind !== 'check') return;
    this.outcomes.set(this.cards[s.index].key, right ? 'checked' : 'wrong');
    this.emit();
  }

  /** Goes on with the next card that is not written yet (after `index`, else from the start). */
  async next(): Promise<void> {
    const s = this.step;
    const from = 'index' in s ? s.index + 1 : 0;
    const later = this.cards.findIndex((c, i) => i >= from && this.open(c));
    const open = later >= 0 ? later : this.firstOpen();
    if (open < 0) this.set({ kind: 'done' });
    else await this.start(open);
  }

  /** Back to the start screen; what was written stays written. */
  reset(): void {
    this.run = null;
    this.set({ kind: 'idle' });
  }

  tick(now = this.now()): void {
    const run = this.run;
    if (run && run.tick(now)) this.follow(run);
  }

  private line(line: string, now: number): void {
    const run = this.run;
    if (run && !isFinished(run.phase)) {
      if (run.observe(line, now)) this.follow(run);
      return;
    }
    const s = this.step;
    if (s.kind === 'check' && s.how === 'log' && !s.result) {
      const r = readBack(line, this.cards[s.index].data);
      if (!r) return;
      this.outcomes.set(this.cards[s.index].key, r.kind === 'match' ? 'checked' : 'wrong');
      this.set({ ...s, result: r });
    }
  }

  private follow(run: WriteCardRun): void {
    const s = this.step;
    if (!('index' in s)) return;
    const index = s.index;
    const p: RunPhase = run.phase;
    const key = this.cards[index].key;
    switch (p.kind) {
      case 'sent':
        return;
      case 'place-card':
        this.set({ kind: 'place', index });
        return;
      case 'remove-card':
        this.set({ kind: 'remove', index });
        return;
      case 'done':
        this.run = null;
        this.outcomes.set(key, 'written');
        // The box logs the bytes it wrote only where it also logs those it reads (TNG card_log at info).
        this.set({ kind: 'check', index, how: p.logged ? 'log' : 'listen' });
        return;
      case 'failed':
        this.run = null;
        this.outcomes.set(key, 'failed');
        this.set({ kind: 'problem', index, problem: 'failed', detail: p.detail });
        return;
      default:
        this.run = null;
        if (p.kind === 'cancelled' && s.kind !== 'problem') {
          this.set({ kind: 'idle' });
          return;
        }
        this.set({ kind: 'problem', index, problem: p.kind });
    }
  }

  private set(step: UsbStep): void {
    this.step = step;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

function isWritten(o: CardOutcome | undefined): boolean {
  return o === 'written' || o === 'checked';
}

/** What to tell when the box did not do it, in plain words. */
export function problemText(problem: UsbProblem, detail?: string): { title: string; text: string } {
  switch (problem) {
    case 'no-answer':
      return {
        title: 'Die Box hat nicht reagiert',
        text: 'Sie nimmt den Auftrag nur, wenn keine Musik läuft und keine Karte auf ihr liegt. Halte die Musik mit Play/Pause an, nimm die Karte runter und versuche es noch einmal.',
      };
    case 'refused':
      return { title: 'Die Box hat die Karte abgelehnt', text: 'Ordner, Titel oder Bereich passen für die Box nicht. Prüfe die Karte in der Liste oben.' };
    case 'failed':
      return {
        title: 'Die Karte wurde nicht beschrieben',
        text: `Die Box konnte nicht auf die Karte schreiben (sie sagt dann „Oh weh! Das hat leider nicht geklappt!“). Lege die Karte mittig auf und lasse sie liegen, bis die Box „OK“ sagt. Klappt es wieder nicht, nimm eine andere Karte.${detail ? ` Die Box meldete: ${detail}` : ''}`,
      };
    case 'cancelled':
      return { title: 'Abgebrochen', text: 'Die Box hat das Schreiben abgebrochen, zum Beispiel durch einen langen Druck auf Play/Pause.' };
    case 'interrupted':
      return { title: 'Die Box ist neu gestartet', text: 'Dabei ging der Auftrag verloren. Warte, bis sie fertig gestartet ist, und versuche es noch einmal.' };
    case 'send-failed':
      return { title: 'Die Box ist nicht mehr verbunden', text: `Stecke sie wieder an und verbinde sie neu.${detail ? ` (${detail})` : ''}` };
    case 'not-possible':
      return { title: 'Diese Karte geht so nicht', text: detail ?? '' };
  }
}
