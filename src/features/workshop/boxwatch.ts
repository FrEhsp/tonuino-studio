/**
 * Box-Meldungen: while a box is connected (Box-Logbuch, Box testen, reader
 * test, Lötplan), its problems are collected in the background and shown at
 * the top of the Werkstatt pages, like the check of the SD card on the box
 * page. Same findings as Box testen (boxbefund.ts), from the same lines.
 */
import { effect, signal } from '@preact/signals';
import { parseLogLine } from '../../core/firmware/logline';
import { befundAus, Befunde, neustartBefund, type Befund, type BefundKontext } from './boxbefund';
import { NEUSTART_MS } from './boxtest';
import { loetplanWahl, type Platine } from './loetplan';
import { NOTES, type LogEntry, type Logbook } from './logbook';
import { logSession } from './logsession';

/** NOTES.connected(label) starts with this. */
const CONNECTED_PREFIX = NOTES.connected('\u0000').split('\u0000')[0];

/**
 * Calls `onEntry` for every entry the Box-Logbuch connection adds from now on
 * (and, with `vonAnfang`, for those already there). Returns the stop function.
 */
export function folgeLog(onEntry: (e: LogEntry, book: Logbook) => void, vonAnfang = false): () => void {
  let book = logSession.book;
  let lastId = vonAnfang ? 0 : book.lastId;
  return effect(() => {
    void logSession.revision.value;
    const b = logSession.book;
    if (b !== book) {
      book = b;
      lastId = 0;
    }
    const entries = b.entries;
    let i = entries.length;
    while (i > 0 && entries[i - 1].id > lastId) i--;
    for (; i < entries.length; i++) {
      const e = entries[i];
      lastId = e.id;
      onEntry(e, b);
    }
  });
}

/** Kind of an entry for the box tests: a new connection, a restart the app asked for, a line of the box. */
export function eintragArt(e: LogEntry): 'verbunden' | 'neustart' | 'zeile' | undefined {
  if (e.kind === 'line') return 'zeile';
  if (e.kind !== 'note') return undefined;
  if (e.text.startsWith(CONNECTED_PREFIX)) return 'verbunden';
  if (e.text === NOTES.restartRequested) return 'neustart';
  return undefined;
}

/** Collects the problems of the box since the last connection. */
export class BoxWaechter {
  readonly befunde = new Befunde();
  platine: Platine = 'classic';
  tasten: 3 | 5 = 3;
  private neustartBis = -Infinity;

  constructor(platine: Platine = 'classic', tasten: 3 | 5 = 3) {
    this.platine = platine;
    this.tasten = tasten;
  }

  verbunden(at: number): void {
    this.befunde.clear();
    this.neustartBis = at + NEUSTART_MS;
  }

  neustart(at: number): void {
    this.neustartBis = at + NEUSTART_MS;
  }

  /** One line; true when the findings changed. */
  zeile(line: string, at: number): boolean {
    const rec = parseLogLine(line);
    if (!rec) return false;
    const ctx: BefundKontext = { platine: this.platine, tasten: this.tasten };
    if (rec.kind === 'hardware') {
      if (rec.board === 'aio' || rec.board === 'aioplus') this.platine = rec.board;
      if (rec.buttons === '5' || rec.buttons === '3') this.tasten = rec.buttons === '5' ? 5 : 3;
      return false;
    }
    if (rec.kind === 'banner') {
      if (at <= this.neustartBis) return false;
      this.befunde.add(neustartBefund(ctx), at, line);
      return true;
    }
    const b = befundAus(rec, ctx);
    if (!b) return false;
    this.befunde.add(b, at, line);
    return true;
  }
}

/** The findings of the box connected now (or last), for the banner. */
export const boxMeldungen = signal<Befund[]>([]);
/** The user hid the banner; it comes back with the next new finding. */
export const boxMeldungenAus = signal<number>(0);

let started = false;

/** Starts the background watch once; the Werkstatt calls it. */
export function starteBoxWaechter(): void {
  if (started) return;
  started = true;
  const w = new BoxWaechter(loetplanWahl.peek().platine, loetplanWahl.peek().tasten);
  folgeLog((e) => {
    // A saved file is no box on the table.
    if (logSession.source.kind !== 'live') return;
    const art = eintragArt(e);
    if (art === 'verbunden') {
      w.platine = loetplanWahl.peek().platine;
      w.tasten = loetplanWahl.peek().tasten;
      w.verbunden(e.time ?? Date.now());
      boxMeldungen.value = [];
    } else if (art === 'neustart') w.neustart(e.time ?? Date.now());
    else if (art === 'zeile' && w.zeile(e.text, e.time ?? Date.now())) boxMeldungen.value = w.befunde.list();
  }, true);
}
