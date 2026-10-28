/**
 * The Box-Logbuch: lines from the box's serial log with their German
 * explanations, plus what the parser learned about the box. Live lines and
 * lines from a saved file go through the same model, and a file saved here
 * reads back to the same Steckbrief and the same issues.
 */
import { BootLogParser, type BootLogEvent, type BoxInfo, type LineExplanation, type LogIssue } from '../../core/firmware/bootlog';
import type { ByteSource } from '../../platform/types';
import { formatBytes } from '../../app/format';
import { summaryLines } from './boxfacts';

export type EntryTone = 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Increasing, never reused, so the page can key rows. */
  id: number;
  /** line: from the box; boot: the box (re)started; note: something the app did or noticed. */
  kind: 'line' | 'boot' | 'note';
  /** When the line was complete (live, or from the time in a saved file), in ms since epoch. */
  time?: number;
  /** Line number in the file, for files without times. */
  lineNo?: number;
  /** The raw line, or the German text of a boot or note entry. */
  text: string;
  explanation?: LineExplanation | null;
  tone?: EntryTone;
}

export type LogFilter = 'important' | 'all';

/**
 * The notes the app writes between the lines. Reading a saved file replays
 * them (a new connection starts the Steckbrief over, a requested restart is
 * no surprise), so they are fixed texts.
 */
export const NOTES = {
  connected: (label: string) => `Verbunden mit ${label}.`,
  restartRequested: 'Neustart angestoßen …',
  noRestart: 'Die Box hat nicht neu gestartet. Schalte sie aus und wieder ein, dann siehst du ihren Start.',
  disconnected: 'Verbindung getrennt.',
  lost: 'Die Verbindung ist weg. Wurde das USB-Kabel abgezogen oder die Box ausgeschaltet?',
  broken: (message: string) => `Die Verbindung ist abgebrochen: ${message}`,
} as const;

const CONNECTED_PREFIX = 'Verbunden mit ';
const BROKEN_PREFIX = 'Die Verbindung ist abgebrochen: ';
const BOOT_TEXT = 'Die Box startet';
const REBOOT_TEXT = 'Die Box ist neu gestartet';
const EXPORT_TITLE = 'TonUINO Studio: Box-Logbuch';
const FORUM_TITLE = 'Box-Logbuch aus TonUINO Studio';
/** The time the Box-Logbuch writes in front of every line: "[15:40:01.123] ". */
const STAMP_RE = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\] ?/;

export interface LogbookOptions {
  /** Entries kept; older ones are dropped (default 3000). */
  maxEntries?: number;
  now?: () => number;
  /** Every live line as it arrives (not the lines of a saved file): card writing over USB listens here (writecard.ts). */
  onLine?: (line: string) => void;
  /** Names of the folders on the card, for the cards the box reads. */
  folderTitle?: (folder: number) => string | undefined;
}

export interface LoadOptions {
  signal?: AbortSignal;
  /** Called between slices with the share read so far (0..1). */
  onProgress?: (share: number) => void;
  /** How long one slice may take before the page gets a turn (default 30 ms; 0 yields after every check). */
  sliceMs?: number;
  /** Lines between two looks at the clock (default 256). */
  checkLines?: number;
  /** Gives the page a turn between slices (default: a zero timeout). */
  yieldTurn?: () => Promise<void>;
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Logbook {
  // The Logbook reads the info only when the page renders, not per line.
  private parser: BootLogParser;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly onLine: ((line: string) => void) | undefined;
  private nextId = 1;
  /** True while a file is read: entries get the file's time or line number instead of the clock. */
  private reading = false;
  private fileTime: number | undefined;
  private fileLineNo: number | undefined;
  entries: LogEntry[] = [];
  /** Entries dropped because of the limit (since the last clear()), plus those a loaded file already left out. */
  dropped = 0;
  /** Lines added since the logbook was created, dropped and cleared ones included; counts what arrives during a pause. */
  totalLines = 0;
  /** Connections and starts of the box seen so far; only grows, so a new reading of the box can be told from an old one. */
  readings = 0;

  constructor(opts: LogbookOptions = {}) {
    this.maxEntries = Math.max(10, opts.maxEntries ?? 3000);
    this.now = opts.now ?? Date.now;
    this.onLine = opts.onLine;
    this.parser = new BootLogParser({ infoEvents: false, folderTitle: opts.folderTitle });
  }

  /** Feeds bytes from the port (or text). Returns true when something visible changed. */
  push(chunk: Uint8Array | string): boolean {
    const changed = this.take(this.parser.push(chunk));
    this.trim();
    return changed;
  }

  /** Ends a half line, e.g. when the connection closes. */
  flush(): boolean {
    const changed = this.take(this.parser.flush());
    this.trim();
    return changed;
  }

  /** Something the app did or noticed, shown between the lines. */
  note(text: string, tone: EntryTone = 'info'): void {
    this.add('note', text, tone);
    this.trim();
  }

  /**
   * A connection is open; it may lead to another box, so the Steckbrief and
   * the issues start over. Call it only once the port is open: a connection
   * that fails keeps what is known.
   */
  connected(label: string): void {
    this.flush();
    this.parser.reset();
    this.readings++;
    this.note(NOTES.connected(label));
  }

  /**
   * Call right before the app restarts the box: its next start is not
   * reported as unexpected. What is known stays until that start arrives, so
   * a box that does not restart keeps its Steckbrief and issues.
   */
  restartRequested(): void {
    this.flush();
    this.parser.expectBoot(true);
    this.note(NOTES.restartRequested);
  }

  /** The restart could not be sent: the next start is a surprise again. */
  restartFailed(): void {
    this.parser.expectBoot(false);
  }

  /**
   * No start came after restartRequested(). The note asks to switch the box
   * off and on, so the start that follows is still the expected one.
   */
  restartMissed(): void {
    this.note(NOTES.noRestart, 'warn');
  }

  /** The connection ended; says why between the lines. */
  connectionEnded(end: { reason: 'stopped' } | { reason: 'lost' } | { reason: 'error'; message: string }): void {
    this.flush();
    if (end.reason === 'stopped') this.note(NOTES.disconnected);
    else if (end.reason === 'lost') this.note(NOTES.lost, 'warn');
    else this.note(NOTES.broken(end.message), 'error');
  }

  /** Empties the list. The Steckbrief and the issues stay; they describe the box since its last start. */
  clear(): void {
    this.entries = [];
    this.dropped = 0;
  }

  /**
   * Reads a whole saved log into this (new) logbook, in slices with a turn
   * for the page in between, so a big file does not freeze it. A file saved
   * or copied for the forum by the Box-Logbuch gets its times and notes back,
   * and its connections and requested restarts are replayed, so the
   * Steckbrief and the issues come out as they were. Other logs get line
   * numbers. Returns false when `signal` aborted the reading.
   */
  async loadText(text: string, opts: LoadOptions = {}): Promise<boolean> {
    if (opts.signal?.aborted) return false;
    const saved = splitSavedLog(text);
    const sliceMs = Math.max(0, opts.sliceMs ?? 30);
    const checkLines = Math.max(1, opts.checkLines ?? 256);
    const yieldTurn = opts.yieldTurn ?? nextTurn;
    const total = saved.lines.length;
    this.dropped += saved.dropped ?? 0;
    this.reading = true;
    try {
      let sliceStart = clock();
      for (let i = 0; i < total; i++) {
        if (i > 0 && i % checkLines === 0 && clock() - sliceStart >= sliceMs) {
          this.trim();
          opts.onProgress?.(i / total);
          await yieldTurn();
          if (opts.signal?.aborted) return false;
          sliceStart = clock();
        }
        this.readSavedLine(saved, i);
      }
      this.flush();
      opts.onProgress?.(1);
      return true;
    } finally {
      this.reading = false;
      this.fileTime = undefined;
      this.fileLineNo = undefined;
    }
  }

  get info(): BoxInfo {
    return this.parser.info;
  }

  get issues(): LogIssue[] {
    return this.parser.issues;
  }

  get bootCount(): number {
    return this.parser.bootCount;
  }

  /** Id of the newest entry (0 when empty). */
  get lastId(): number {
    return this.entries.length ? this.entries[this.entries.length - 1].id : 0;
  }

  private readSavedLine(saved: SavedLog, index: number): void {
    const raw = saved.lines[index];
    if (raw.length === 0) return;
    const stamp = raw.charCodeAt(0) === 0x5b /* [ */ ? STAMP_RE.exec(raw) : null;
    if (stamp) {
      this.fileTime = stampTime(stamp, saved.savedAt ?? this.now());
      this.fileLineNo = undefined;
    } else {
      this.fileTime = undefined;
      this.fileLineNo = saved.firstLineNo + index;
    }
    const text = stamp ? raw.slice(stamp[0].length) : raw;
    if ((stamp || saved.kind !== 'plain') && text.startsWith('## ')) this.replayNote(text.slice(3));
    else this.take(this.parser.push(`${text}\n`));
  }

  /** A note of a saved file: what it stood for happens again. */
  private replayNote(text: string): void {
    // The banner line that follows brings its start back.
    if (text === BOOT_TEXT || text === REBOOT_TEXT) return;
    if (text.startsWith(CONNECTED_PREFIX)) {
      this.parser.reset();
      this.readings++;
    } else if (text === NOTES.restartRequested) this.parser.expectBoot(true);
    this.add('note', text, noteTone(text));
  }

  private take(events: BootLogEvent[]): boolean {
    let changed = false;
    for (const e of events) {
      if (e.type === 'boot') {
        this.readings++;
        this.add('boot', e.unexpected ? REBOOT_TEXT : BOOT_TEXT, e.unexpected ? 'warn' : 'info');
        changed = true;
      } else if (e.type === 'line') {
        this.totalLines++;
        this.add('line', e.line, undefined, e.explanation);
        changed = true;
        if (!this.reading && this.onLine) {
          try {
            this.onLine(e.line);
          } catch {
            // A broken listener must not stop the log.
          }
        }
      }
    }
    return changed;
  }

  private add(kind: LogEntry['kind'], text: string, tone?: EntryTone, explanation?: LineExplanation | null): void {
    const e: LogEntry = { id: this.nextId++, kind, text };
    if (!this.reading) e.time = this.now();
    else if (this.fileTime !== undefined) e.time = this.fileTime;
    else if (this.fileLineNo !== undefined) e.lineNo = this.fileLineNo;
    if (tone) e.tone = tone;
    if (explanation !== undefined) e.explanation = explanation;
    this.entries.push(e);
    // Dropping the oldest entry for every new line would move the whole list
    // each time; let it grow to twice the limit and drop in bulk.
    if (this.entries.length >= this.maxEntries * 2) this.trim();
  }

  /** Drops the oldest entries beyond the limit. */
  private trim(): void {
    const over = this.entries.length - this.maxEntries;
    if (over <= 0) return;
    this.entries.splice(0, over);
    this.dropped += over;
  }
}

function noteTone(text: string): EntryTone {
  if (text === NOTES.lost || text === NOTES.noRestart) return 'warn';
  if (text.startsWith(BROKEN_PREFIX)) return 'error';
  return 'info';
}

/** The time of a "[15:40:01.123]" stamp, on the day of `base` (the day before when it would be later than `base`). */
function stampTime(m: RegExpExecArray, base: number): number {
  const d = new Date(base);
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
  // "Gespeichert" has minutes only, so allow one minute before stepping back a day.
  if (d.getTime() > base + 60_000) d.setDate(d.getDate() - 1);
  return d.getTime();
}

export interface SavedLog {
  /** export: a file saved by the Box-Logbuch; forum: its forum post; plain: any other log. */
  kind: 'export' | 'forum' | 'plain';
  /** The log lines, without header and summary. */
  lines: string[];
  /** Line number of lines[0] in the file. */
  firstLineNo: number;
  /** When the file was saved, from its header. */
  savedAt?: number;
  /** Lines the file says it left out. */
  dropped?: number;
}

/** Finds the log part of a saved file: the Box-Logbuch's own files carry a header and a summary in front of it. */
export function splitSavedLog(text: string): SavedLog {
  const all = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const first = all.findIndex((l) => l.trim() !== '');
  const title = first >= 0 ? all[first].trim() : '';
  const lineIs = (want: string, from: number) => all.findIndex((l, i) => i >= from && l.trim() === want);
  const firstStamped = (from: number) => {
    const i = all.findIndex((l, j) => j >= from && STAMP_RE.test(l));
    return i >= 0 ? i : all.length;
  };
  const part = (kind: SavedLog['kind'], start: number, end = all.length): SavedLog => ({ kind, lines: all.slice(start, end), firstLineNo: start + 1 });

  if (title === EXPORT_TITLE) {
    let i = first + 1;
    let savedAt: number | undefined;
    let dropped: number | undefined;
    for (; i < all.length && all[i].trim() !== ''; i++) {
      const line = all[i].trim();
      const at = /^Gespeichert: (\d{2})\.(\d{2})\.(\d{4}), (\d{2}):(\d{2})$/.exec(line);
      const left = /^Ältere Zeilen ausgelassen: (\d+)$/.exec(line);
      if (at) savedAt = new Date(Number(at[3]), Number(at[2]) - 1, Number(at[1]), Number(at[4]), Number(at[5])).getTime();
      else if (left) dropped = Number(left[1]);
    }
    const log = lineIs('Log', i);
    const saved = part('export', log >= 0 ? log + 1 : firstStamped(i));
    if (savedAt !== undefined) saved.savedAt = savedAt;
    if (dropped) saved.dropped = dropped;
    return saved;
  }
  if (title.startsWith(FORUM_TITLE)) {
    const open = lineIs('```', first + 1);
    if (open < 0) return part('forum', firstStamped(first + 1));
    const close = lineIs('```', open + 1);
    return part('forum', open + 1, close >= 0 ? close : all.length);
  }
  return part('plain', 0);
}

/** "Nur Wichtiges": explained lines, starts and notes. "Alles": every line. */
export function visibleEntries(entries: readonly LogEntry[], filter: LogFilter): LogEntry[] {
  return filter === 'all' ? [...entries] : entries.filter((e) => e.kind !== 'line' || !!e.explanation);
}

/** The level a row shows: from its explanation, or its own tone. */
export function entryLevel(e: LogEntry): EntryTone | undefined {
  return e.explanation?.level ?? e.tone;
}

/** While paused, the list keeps the rows it showed; new lines are only counted. */
export interface PauseSnapshot {
  book: Logbook;
  entries: readonly LogEntry[];
  /** book.totalLines when the pause began. */
  totalLines: number;
}

export function pauseSnapshot(book: Logbook): PauseSnapshot {
  return { book, entries: [...book.entries], totalLines: book.totalLines };
}

/** Lines that arrived since the pause began. */
export function waitingLines(pause: PauseSnapshot): number {
  return pause.book.totalLines - pause.totalLines;
}

export interface EmptyLogState {
  /** The entries the list shows before filtering (while paused: those of the pause). */
  shown: readonly LogEntry[];
  filter: LogFilter;
  paused: boolean;
  /** Connected or connecting. */
  live: boolean;
  /** This platform can talk to a box over USB. */
  canConnect: boolean;
}

/** What an empty list says, so it never claims "no messages" while lines are only filtered out or paused. */
export function emptyLogText(s: EmptyLogState): string {
  if (s.filter === 'important' && s.shown.some((e) => e.kind === 'line')) return 'Noch nichts Wichtiges dabei. Unter „Alles“ siehst du jede Zeile.';
  if (s.paused) return 'Angehalten, bevor eine Meldung kam. Klicke auf „Weiter“, dann siehst du die neuen Meldungen.';
  if (s.live) return 'Warte auf Meldungen der Box … Kommt nichts, klicke auf „Box neu starten“ oder schalte die Box aus und wieder ein. Bleibt es still, nimm ein anderes USB-Kabel: Manche Kabel laden nur.';
  if (!s.canConnect) return 'Noch keine Meldungen. Öffne eine gespeicherte Logbuch-Datei, dann siehst du sie hier.';
  return 'Noch keine Meldungen. Verbinde die Box, dann erscheinen hier ihre Meldungen.';
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** "15:40:01", or with milliseconds "15:40:01.123", in local time. */
export function clockTime(ms: number, withMs = false): string {
  const d = new Date(ms);
  const base = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return withMs ? `${base}.${String(d.getMilliseconds()).padStart(3, '0')}` : base;
}

/** "05.10.2026, 15:40" */
export function dateTime(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The log as plain text: raw lines with their times, app notes marked with "##". */
export function logText(entries: readonly LogEntry[]): string {
  return entries
    .map((e) => {
      const stamp = e.time !== undefined ? `[${clockTime(e.time, true)}] ` : '';
      return e.kind === 'line' ? `${stamp}${e.text}` : `${stamp}## ${e.text}`;
    })
    .join('\n');
}

export interface ExportMeta {
  /** When the export was made. */
  at: number;
  /** Port and speed, e.g. "USB-Seriell (CH340), 115200 Baud", or the file name. */
  source?: string;
  dropped?: number;
}

/** A .txt file: header, Steckbrief, issues, then the full log. "Logbuch-Datei öffnen" reads it back. */
export function exportText(entries: readonly LogEntry[], info: BoxInfo, issues: readonly LogIssue[], meta: ExportMeta): string {
  const head = [EXPORT_TITLE, `Gespeichert: ${dateTime(meta.at)}`];
  if (meta.source) head.push(`Quelle: ${meta.source}`);
  if (meta.dropped) head.push(`Ältere Zeilen ausgelassen: ${meta.dropped}`);
  return [...head, '', ...summaryLines(info, issues), '', 'Log', logText(entries), ''].join('\n');
}

/** For a forum post: the summary as text and the log in a code block, which Discourse shows unchanged. */
export function forumText(entries: readonly LogEntry[], info: BoxInfo, issues: readonly LogIssue[], meta: ExportMeta): string {
  const head = meta.source ? [`${FORUM_TITLE} (${meta.source})`, ''] : [FORUM_TITLE, ''];
  return [...head, ...summaryLines(info, issues, true), '', '```', logText(entries), '```', ''].join('\n');
}

/** "TonUINO-Logbuch-2026-10-05-1540.txt" */
export function logFileName(ms: number): string {
  const d = new Date(ms);
  return `TonUINO-Logbuch-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}.txt`;
}

/** Whether a scroll box shows its end, so new lines may scroll it along. */
export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, slack = 32): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= slack;
}

/** A saved log is text; a file far bigger than this is something else. */
export const MAX_LOG_FILE = 8 * 1024 * 1024;

/** Reads a saved log file. Returns its text, or a German sentence saying what is wrong with it. */
export async function readLogFile(source: ByteSource): Promise<{ text: string } | { error: string }> {
  if (source.size > MAX_LOG_FILE) {
    return { error: `„${source.name}“ ist mit ${formatBytes(source.size)} zu groß für ein Logbuch. Wähle die .txt-Datei, die du gespeichert hast.` };
  }
  let bytes: Uint8Array;
  try {
    bytes = await source.read(0, source.size);
  } catch {
    return { error: `„${source.name}“ ließ sich nicht lesen. Vielleicht wurde die Datei verschoben oder gelöscht. Wähle sie noch einmal aus.` };
  }
  // Text has (almost) no zero bytes; images, archives and firmware files have many.
  const sample = bytes.subarray(0, 4096);
  const zeros = sample.reduce((n, b) => n + (b === 0 ? 1 : 0), 0);
  if (sample.length && zeros > sample.length / 100) {
    return { error: `„${source.name}“ ist keine Textdatei. Wähle eine Logbuch-Datei (.txt oder .log).` };
  }
  return { text: new TextDecoder('utf-8').decode(bytes) };
}

/** What the "Karte neu aufbauen" button of the Box-Logbuch does with the SD card the app has open (or none). */
export type RebuildWay = 'rebuild' | 'package' | 'open-card';

/**
 * Chrome, Edge and the desktop app rebuild the open card in place; Firefox and
 * Safari read it as a snapshot and build a Paket instead. Without a card that
 * is read and ready there is nothing to back up yet: the page first sends the
 * user to "Meine Box".
 */
export function rebuildWay(card: { status: string; volume: { access?: string } } | null | undefined): RebuildWay {
  if (!card || card.status !== 'ready') return 'open-card';
  return card.volume.access === 'snapshot' ? 'package' : 'rebuild';
}
