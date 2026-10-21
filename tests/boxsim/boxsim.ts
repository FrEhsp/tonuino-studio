/**
 * The bridge to the box simulator (scripts/firmware/boxsim.c, TODO #66): the
 * real TonUINO-TNG firmware of a Baukasten build in simavr, with a pretend
 * DFPlayer, card reader and keys. A test drives the box with the simulator's
 * script commands (do(): press, card, power, until, …) and the app talks to
 * it like to a real box through `serial` (SerialAccess).
 *
 * Two ways to run it:
 * - lockstep (default): simulated time passes only while a command runs, as
 *   fast as the computer can. For the app's pure parts, which get the lines.
 * - realtime: the box runs at wall-clock speed, so the app's own timers
 *   (probeBox, the WRITECARD run, …) see it like a real box.
 *
 * Set up by scripts/firmware/boxsim-run.mjs (`npm run test:boxsim`): it builds
 * the simulator and unpacks the firmware into BOXSIM_DIR. Without it the
 * tests of tests/boxsim are skipped.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SerialAccess, SerialConnection, SerialPortInfo, SerialSignals } from '../../src/platform/types';
import { CH340_PORT, lostError } from '../workshop/fakes';

export const SIM_DIR = process.env.BOXSIM_DIR ?? '';
export const SIM_BIN = SIM_DIR ? join(SIM_DIR, 'boxsim') : '';
const SOUNDS = fileURLToPath(new URL('../../scripts/firmware/boxsim-sounds.tsv', import.meta.url));
/** True when `npm run test:boxsim` prepared the simulator. */
export const canSimulate = !!SIM_DIR && existsSync(SIM_BIN);

export interface SimEvent {
  /** Simulated seconds since power on. */
  t: number;
  /** box (the USB serial log), mp3, rfid, key, sim, > (command), =ok, =fail */
  tag: string;
  text: string;
}

export interface BoxSimOptions {
  /** A build of the Baukasten manifest, e.g. "classic-3"; boxsim-run.mjs unpacks it. */
  build: string;
  /** Run at this many times real time; leave out for lockstep. */
  realtime?: number;
  /** Folders and their track counts, "1:12,2:5". */
  sd?: string;
  trackSeconds?: number;
  /** More simulator options, e.g. ["--no-rfid"]. */
  args?: string[];
}

export class SimError extends Error {}

/** One line of the simulator: "[   1.234] box| text". */
const LINE = /^\[\s*([\d.]+)\] ([^|]+)\| ?(.*)$/;

export class BoxSim {
  readonly events: SimEvent[] = [];
  readonly serial: SimSerial;
  private readonly proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private sent = 0;
  private readonly waiting = new Map<number, { resolve: (ev: SimEvent[]) => void; reject: (e: Error) => void; from: number; allowFail: boolean }>();
  private exited = false;
  private readonly listeners = new Set<(e: SimEvent) => void>();

  private constructor(readonly opts: BoxSimOptions) {
    const firmware = join(SIM_DIR, `${opts.build}.bin`);
    if (!existsSync(firmware)) throw new SimError(`${firmware} fehlt: boxsim-run.mjs packt nur die Builds aus, die in BUILDS stehen.`);
    const args = ['--sounds', SOUNDS];
    if (opts.build.startsWith('aio')) args.push('--board', 'aio');
    if (opts.realtime) args.push(`--realtime=${opts.realtime}`);
    if (opts.sd) args.push('--sd', opts.sd);
    if (opts.trackSeconds) args.push('--track-seconds', String(opts.trackSeconds));
    args.push(...(opts.args ?? []), firmware);
    this.proc = spawn(SIM_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onOutput(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.proc.on('exit', () => {
      this.exited = true;
      for (const w of this.waiting.values()) w.reject(new SimError('Der Simulator hat sich beendet.'));
      this.waiting.clear();
      this.serial.lost();
    });
    this.serial = new SimSerial(this);
  }

  static start(opts: BoxSimOptions): BoxSim {
    return new BoxSim(opts);
  }

  /** Runs a script command; resolves with the events it caused once the simulator answers "=ok". */
  do(command: string, allowFail = false): Promise<SimEvent[]> {
    if (this.exited) return Promise.reject(new SimError('Der Simulator läuft nicht mehr.'));
    const no = ++this.sent;
    const from = this.events.length;
    const done = new Promise<SimEvent[]>((resolve, reject) => this.waiting.set(no, { resolve, reject, from, allowFail }));
    this.proc.stdin.write(`${command.replace(/\n/g, ' ')}\n`);
    return done;
  }

  /** Several commands in a row. */
  async script(commands: string): Promise<SimEvent[]> {
    const out: SimEvent[] = [];
    for (const line of commands.split('\n')) if (line.trim() && !line.trim().startsWith('#')) out.push(...(await this.do(line.trim())));
    return out;
  }

  /** Runs until a box line or event contains `text` (simulated seconds). */
  until(text: string, seconds = 30): Promise<SimEvent[]> {
    return this.do(`until ${text} ${seconds}`);
  }

  /** Runs until `text` came, or `seconds` passed; true when it came. */
  async waitFor(text: string, seconds = 30): Promise<boolean> {
    const ev = await this.do(`until ${text} ${seconds}`, true);
    return ev.at(-1)?.tag === '=ok';
  }

  /** Everything the box wrote on its serial port, one line each. */
  boxLines(from = 0): string[] {
    return this.events.slice(from).filter((e) => e.tag === 'box').map((e) => e.text);
  }

  /** The serial log as the app reads it: lines with CR LF. */
  boxText(from = 0): string {
    return this.boxLines(from).map((l) => `${l}\r\n`).join('');
  }

  /** Called for every event from now on; returns the unsubscribe. */
  onEvent(listener: (e: SimEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The 16 data bytes of every card the simulation knows, by UID (from the "cards" command). */
  async cards(): Promise<Map<string, { type: string; data: number[]; onReader: boolean }>> {
    const ev = await this.do('cards');
    const out = new Map<string, { type: string; data: number[]; onReader: boolean }>();
    for (const e of ev) {
      const m = e.tag === 'rfid' ? e.text.match(/^(on reader|known) (\w+) ([0-9a-f]+): ([0-9a-f ]+)$/) : null;
      if (m) out.set(m[3], { type: m[2], data: m[4].trim().split(' ').map((h) => parseInt(h, 16)), onReader: m[1] === 'on reader' });
    }
    return out;
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    const gone = new Promise<void>((resolve) => this.proc.on('exit', () => resolve()));
    this.proc.stdin.end();
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 3000);
    await gone;
    clearTimeout(timer);
  }

  /** The log of this run, for a failing test. */
  dump(last = 120): string {
    return this.events
      .slice(-last)
      .map((e) => `[${e.t.toFixed(3).padStart(9)}] ${e.tag}| ${e.text}`)
      .join('\n');
  }

  private onOutput(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const m = line.match(LINE);
      if (!m) continue;
      const e: SimEvent = { t: Number(m[1]), tag: m[2], text: m[3] };
      this.events.push(e);
      if (e.tag === 'box') this.serial.boxLine(e.text);
      for (const l of this.listeners) l(e);
      if (e.tag === '=ok' || e.tag === '=fail') {
        const [no, ...reason] = e.text.split(' ');
        const w = this.waiting.get(Number(no));
        if (!w) continue;
        this.waiting.delete(Number(no));
        if (e.tag === '=fail' && !w.allowFail) w.reject(new SimError(`Simulator: ${reason.join(' ')}\n${this.dump(40)}`));
        else w.resolve(this.events.slice(w.from));
      }
    }
  }
}

/**
 * The box's USB port as the app sees it. Opening it restarts the box (the
 * CH340 of a Nano pulls DTR), and so does DTR going on again after it was off
 * (monitor.ts restartBox). Another speed than 115200 baud gives noise.
 */
export class SimSerial implements SerialAccess {
  readonly supported = true;
  conn: SimConnection | undefined;
  /** Every byte string the app sent. */
  readonly written: string[] = [];
  /** Opening the port restarts the box (default true, like a Nano with a CH340). */
  resetOnOpen = true;

  constructor(private readonly sim: BoxSim) {}

  async list(): Promise<SerialPortInfo[]> {
    return [CH340_PORT];
  }

  async open(port: SerialPortInfo, baudRate: number): Promise<SerialConnection> {
    const conn = new SimConnection(port, baudRate, this.sim, this);
    this.conn = conn;
    if (this.resetOnOpen) await this.sim.do('reset');
    return conn;
  }

  boxLine(text: string): void {
    this.conn?.push(`${text}\r\n`);
  }

  lost(): void {
    this.conn?.unplug();
  }
}

class SimConnection implements SerialConnection {
  private queue: Uint8Array[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;
  private gone = false;
  private dtr = true;

  constructor(
    readonly port: SerialPortInfo,
    readonly baudRate: number,
    private readonly sim: BoxSim,
    private readonly owner: SimSerial,
  ) {}

  push(text: string): void {
    if (this.closed) return;
    let bytes = new TextEncoder().encode(text);
    // At another speed the UART sees noise: every byte comes out garbled.
    if (this.baudRate !== 115200) bytes = bytes.map((b) => 0x80 | ((b * 7) & 0x7f));
    this.queue.push(bytes);
    this.wake();
  }

  unplug(): void {
    this.gone = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private check(): void {
    if (this.closed) throw Object.assign(new Error('closed'), { code: 'closed' });
    if (this.gone) throw lostError();
  }

  async write(data: Uint8Array): Promise<void> {
    this.check();
    this.owner.written.push(new TextDecoder().decode(data));
    const hex = [...data].map((b) => b.toString(16).padStart(2, '0')).join('');
    await this.sim.do(`tx ${hex}`);
  }

  async read(timeoutMs: number, maxBytes = 4096): Promise<Uint8Array> {
    if (this.closed) throw Object.assign(new Error('closed'), { code: 'closed' });
    if (!this.queue.length && !this.gone) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const next = this.queue.shift();
    if (next) {
      if (next.length > maxBytes) {
        this.queue.unshift(next.slice(maxBytes));
        return next.slice(0, maxBytes);
      }
      return next;
    }
    if (this.gone && !this.closed) throw lostError();
    return new Uint8Array(0);
  }

  async discardInput(): Promise<void> {
    this.queue = [];
  }

  async setSignals(signals: SerialSignals): Promise<void> {
    this.check();
    if (signals.dtr !== undefined) {
      const rising = signals.dtr && !this.dtr;
      this.dtr = signals.dtr;
      if (rising) await this.sim.do('reset');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.owner.conn === this) this.owner.conn = undefined;
    this.wake();
  }
}
