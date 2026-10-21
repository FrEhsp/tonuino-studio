/**
 * The live side of the Box-Logbuch: one connection at a time, its state as
 * signals, and the lines in a Logbook. It lives outside the page so the
 * lines survive a visit to another page; the page disconnects when it is
 * left, so the firmware wizard can use the port.
 */
import { effect, signal } from '@preact/signals';
import { describePortError, type FlashProblem, type HostOs } from '../../core/firmware/flash';
import type { SerialAccess, SerialPortInfo } from '../../platform/types';
import type { Route } from '../../app/router';
import { catalog, noteBoxFirmware } from '../../app/state';
import { folderName } from '../../core/tonuino/sd';
import { PROBE_LINE, WriteCardProbe, lineBytes, type ProbeOptions, type WriteAbility } from '../../core/firmware/writecard';
import { rememberBoxWritesCards } from './writeability';
import { Logbook } from './logbook';
import { LOG_BAUD_RATE, openMonitor, type Monitor, type MonitorEnd, type MonitorOptions } from './monitor';

export type LinkState =
  | { kind: 'idle' }
  | { kind: 'connecting'; port: SerialPortInfo }
  | { kind: 'connected'; port: SerialPortInfo; baudRate: number }
  /** The device went away. */
  | { kind: 'lost'; port: SerialPortInfo }
  /** open: the port did not open; read: reading broke off for another reason than a pulled cable. */
  | { kind: 'error'; phase: 'open' | 'read'; port?: SerialPortInfo; error: unknown };

/** A saved log being read; the old lines stay until it is done. */
export interface FileLoad {
  name: string;
  /** 0..1 */
  progress: number;
}

export interface LogSessionOptions {
  /** Waits this long between screen updates while lines pour in (default 80 ms). */
  throttleMs?: number;
  /** After "Box neu starten", how long to wait for the start before saying it did not work (default 6 s). */
  restartWatchMs?: number;
  now?: () => number;
  monitor?: MonitorOptions;
  /** Passed to Logbook.loadText (tests make the slices small). */
  load?: { sliceMs?: number; checkLines?: number; yieldTurn?: () => Promise<void> };
  /** The WRITECARD question after connecting (writecard.ts); false leaves it out. */
  probe?: ProbeOptions | false;
  /** How often the question looks at the clock (default 200 ms). */
  probeTickMs?: number;
}

/** The note in the log when the app asks, so nobody wonders where "WRITECARD: ERR" comes from. */
export const PROBE_NOTE = 'Frage die Box, ob sie Karten selbst beschreiben kann (WRITECARD CANCEL).';


function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * What the connect card shows for a failed or broken connection: the same
 * advice as the firmware wizard, with the desktop app's hints and its
 * "USB-Zugriff einrichten" button.
 */
export function linkProblem(link: Extract<LinkState, { kind: 'error' }>, os?: HostOs): FlashProblem {
  if (link.phase === 'open') return describePortError(link.error, { os, port: link.port });
  return {
    code: 'connection-lost',
    title: 'Die Verbindung ist abgebrochen',
    explanation: 'Beim Mitlesen ist die Verbindung zur Box gestört worden.',
    steps: [
      'Ziehe das USB-Kabel ab, stecke es wieder ein und verbinde die Box neu.',
      'Probiere ein anderes USB-Kabel. Viele Kabel laden nur und übertragen keine Daten.',
      'Stecke die Box direkt am Computer ein, nicht über einen USB-Hub.',
    ],
    technical: messageOf(link.error),
  };
}

/**
 * The pages that read the box through this session: the Box-Logbuch, the
 * reader test, the parts test and the guided Box testen, plus the Lötplan
 * (Box testen sends you there to look at a joint), and „Karten beschreiben“. Going from one to the other keeps the connection, so nobody has
 * to pick the port again; any other page frees it for the firmware wizard.
 */
export function keepsLogConnection(next: Route): boolean {
  // „Karten beschreiben“ writes over the same connection (Über USB an die Box, TODO #93).
  if (next.page === 'cards') return true;
  return next.page === 'workshop' && (next.tool === 'logbuch' || next.tool === 'kartenleser' || next.tool === 'tasten' || next.tool === 'testen' || next.tool === 'loetplan');
}

interface Active {
  seq: number;
  monitor: Monitor;
  port: SerialPortInfo;
}

export class LogSession {
  readonly link = signal<LinkState>({ kind: 'idle' });
  /** Bumped when the lines or the Steckbrief changed. */
  readonly revision = signal(0);
  /** Set while a saved log is read. */
  readonly loading = signal<FileLoad | null>(null);
  book: Logbook;
  /** The port used last, to offer "Neu verbinden". */
  lastPort: SerialPortInfo | undefined;
  /** Where the lines come from: the box, or a saved file. */
  source: { kind: 'live' } | { kind: 'file'; name: string } = { kind: 'live' };
  /** Whether the box of the last connection can write cards over USB (WRITECARD), asked after connecting. */
  readonly writeAbility = signal<WriteAbility>('unknown');
  private readonly lineListeners = new Set<(line: string, now: number) => void>();
  private probe: { check: WriteCardProbe; timer: ReturnType<typeof setInterval>; seq: number } | null = null;

  private active: Active | null = null;
  private seq = 0;
  private bumpTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private fileLoad: AbortController | null = null;
  private readonly opts: LogSessionOptions;

  constructor(opts: LogSessionOptions = {}) {
    this.opts = opts;
    this.book = this.newBook();
  }

  get connected(): boolean {
    return this.active !== null;
  }

  /**
   * Opens the port and starts reading. Failures end up in `link` as 'error'.
   * The Steckbrief starts over only once the port is open, so a connection
   * that fails keeps what is known (and a saved file stays on screen).
   */
  async connect(serial: SerialAccess, port: SerialPortInfo): Promise<void> {
    // Taken before anything is awaited, so a disconnect() right after this call cancels it.
    const seq = ++this.seq;
    this.cancelLoad();
    const previous = this.active;
    if (previous) await previous.monitor.stop();
    if (seq !== this.seq) return;
    this.lastPort = port;
    this.link.value = { kind: 'connecting', port };
    // Until this connection is the active one, its data and its end wait here.
    const early: { data: Uint8Array[]; end?: MonitorEnd; opened: boolean } = { data: [], opened: false };
    let monitor: Monitor;
    try {
      monitor = await openMonitor(
        serial,
        port,
        {
          onData: (bytes) => {
            if (!early.opened) early.data.push(bytes);
            else if (seq === this.active?.seq && this.book.push(bytes)) this.bump();
          },
          onEnd: (end) => {
            if (early.opened) this.ended(seq, end);
            else early.end = end;
          },
        },
        this.opts.monitor,
      );
    } catch (error) {
      if (seq === this.seq) this.link.value = { kind: 'error', phase: 'open', port, error };
      return;
    }
    early.opened = true;
    if (seq !== this.seq) {
      // disconnect() or another connect() came in while the port opened.
      await monitor.stop();
      return;
    }
    if (this.source.kind === 'file') {
      // Lines of a saved file and of the box would mix up two different starts.
      this.book = this.newBook();
      this.source = { kind: 'live' };
    }
    this.active = { seq, monitor, port };
    this.link.value = { kind: 'connected', port, baudRate: monitor.baudRate };
    // Opening the port restarts most boxes; that start is the one we want to see.
    this.book.connected(port.label);
    this.startProbe(this.now());
    for (const bytes of early.data) this.book.push(bytes);
    this.bump(true);
    if (early.end) this.ended(seq, early.end);
  }

  /** Lines from the box as they arrive; returns the function that stops listening. */
  onLine(listener: (line: string, now: number) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  /** Sends one line to the box (writecard.ts). Rejects without a connection. */
  async send(line: string): Promise<void> {
    const a = this.active;
    if (!a) throw new Error('Die Box ist nicht verbunden.');
    await a.monitor.write(lineBytes(line));
  }

  /** Asks the connected box again whether it can write cards, e.g. after the music was stopped. */
  checkWriteAbility(): void {
    if (!this.active) return;
    // Already settled: ask as soon as the box is quiet.
    const settle = this.opts.probe ? (this.opts.probe.settleMs ?? 2500) : 2500;
    this.startProbe(this.now() - settle);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private startProbe(connectedAt: number): void {
    this.stopProbe();
    const a = this.active;
    if (!a || this.opts.probe === false) return;
    const check = new WriteCardProbe(connectedAt, this.opts.probe || {});
    this.writeAbility.value = 'checking';
    const timer = setInterval(() => {
      if (this.probe?.check !== check) return;
      const now = this.now();
      if (check.due(now)) {
        check.sent(now);
        this.book.note(PROBE_NOTE);
        this.bump();
        a.monitor.write(lineBytes(PROBE_LINE)).catch(() => {
          if (this.probe?.check !== check) return;
          this.stopProbe();
          this.writeAbility.value = 'unknown';
        });
      }
      if (check.tick(now)) this.probeSettled(check);
    }, this.opts.probeTickMs ?? 200);
    this.probe = { check, timer, seq: a.seq };
  }

  private probeSettled(check: WriteCardProbe): void {
    this.stopProbe();
    this.writeAbility.value = check.result;
    if (check.result === 'yes') rememberBoxWritesCards(true);
    else if (check.result === 'no' && check.certain) rememberBoxWritesCards(false);
  }

  private stopProbe(): void {
    if (this.probe) clearInterval(this.probe.timer);
    this.probe = null;
  }

  private lineArrived(line: string): void {
    const now = this.now();
    const check = this.probe?.check;
    if (check && check.observe(line, now)) this.probeSettled(check);
    for (const l of this.lineListeners) {
      try {
        l(line, now);
      } catch {
        // A broken listener must not stop the log.
      }
    }
  }

  /** Stops reading and closes the port. Lines and Steckbrief stay. */
  async disconnect(): Promise<void> {
    this.seq++;
    if (this.link.value.kind === 'connecting') this.link.value = { kind: 'idle' };
    const a = this.active;
    if (a) await a.monitor.stop();
  }

  /**
   * Restarts the box so its Steckbrief shows up. What is known stays until
   * the new start arrives. Rejects when the lines cannot be switched.
   */
  async restartBox(): Promise<void> {
    const a = this.active;
    if (!a) return;
    const boots = this.book.bootCount;
    const book = this.book;
    book.restartRequested();
    this.bump(true);
    try {
      await a.monitor.restartBox();
    } catch (e) {
      book.restartFailed();
      throw e;
    }
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.active !== a || this.book !== book || book.bootCount !== boots) return;
      book.restartMissed();
      this.bump(true);
    }, this.opts.restartWatchMs ?? 6000);
  }

  clear(): void {
    this.book.clear();
    this.bump(true);
  }

  /**
   * Shows a saved log instead of the live lines. The file is read in slices
   * (see `loading`); the live connection ends only once it is read, and
   * cancelLoad() leaves everything as it was. Returns false when cancelled.
   */
  async openFile(name: string, text: string): Promise<boolean> {
    this.cancelLoad();
    const ctl = new AbortController();
    this.fileLoad = ctl;
    const book = this.newBook();
    this.loading.value = { name, progress: 0 };
    let done = false;
    try {
      done = await book.loadText(text, {
        ...this.opts.load,
        signal: ctl.signal,
        onProgress: (progress) => {
          if (this.fileLoad === ctl) this.loading.value = { name, progress };
        },
      });
    } finally {
      if (this.fileLoad === ctl) {
        this.fileLoad = null;
        this.loading.value = null;
      }
    }
    if (!done || ctl.signal.aborted) return false;
    await this.disconnect();
    this.book = book;
    this.source = { kind: 'file', name };
    this.link.value = { kind: 'idle' };
    this.bump(true);
    return true;
  }

  /** Stops reading a saved log; the lines shown before stay. */
  cancelLoad(): void {
    const ctl = this.fileLoad;
    if (!ctl) return;
    this.fileLoad = null;
    ctl.abort();
    this.loading.value = null;
  }

  /** For the saved file and the forum post, e.g. "USB-Serial CH340 (ttyUSB0), 115200 Baud". */
  sourceText(): string | undefined {
    if (this.source.kind === 'file') return `Datei „${this.source.name}“`;
    const port = this.lastPort;
    return port ? `${port.label}, ${LOG_BAUD_RATE} Baud` : undefined;
  }

  private newBook(): Logbook {
    return new Logbook({ now: this.opts.now, onLine: (line) => this.lineArrived(line), folderTitle: (n) => catalog.peek()?.folders[folderName(n)]?.title });
  }

  private ended(seq: number, end: MonitorEnd): void {
    const a = this.active;
    if (!a || a.seq !== seq) return;
    this.active = null;
    if (this.probe) {
      this.stopProbe();
      if (this.writeAbility.value === 'checking') this.writeAbility.value = 'unknown';
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (end.reason === 'stopped') {
      this.book.connectionEnded({ reason: 'stopped' });
      this.link.value = { kind: 'idle' };
    } else if (end.reason === 'lost') {
      this.book.connectionEnded({ reason: 'lost' });
      this.link.value = { kind: 'lost', port: a.port };
    } else {
      this.book.connectionEnded({ reason: 'error', message: messageOf(end.error) });
      this.link.value = { kind: 'error', phase: 'read', port: a.port, error: end.error };
    }
    this.bump(true);
  }

  /** Coalesces screen updates while lines pour in; `now` skips the wait. */
  private bump(now = false): void {
    if (now) {
      if (this.bumpTimer) clearTimeout(this.bumpTimer);
      this.bumpTimer = null;
      this.revision.value++;
      return;
    }
    if (this.bumpTimer) return;
    this.bumpTimer = setTimeout(() => {
      this.bumpTimer = null;
      this.revision.value++;
    }, this.opts.throttleMs ?? 80);
  }
}

/** One session for the whole app, so the lines survive a visit to another page. */
export const logSession = new LogSession();

/**
 * The start of a live box names its firmware: the app takes it over for the
 * open card (#29, „Automatisch erkannt“ on „Karten beschreiben“).
 */
let notedBox = '';
effect(() => {
  void logSession.revision.value;
  if (logSession.source.kind !== 'live') return;
  const info = logSession.book.info;
  if (!info.firmware) return;
  const key = `${info.firmware}|${info.version ?? ''}|${info.versionDate ?? ''}|${info.board ?? ''}`;
  if (key === notedBox) return;
  notedBox = key;
  void noteBoxFirmware({ firmware: info.firmware, version: info.version, versionDate: info.versionDate, board: info.board }).catch(() => undefined);
});
