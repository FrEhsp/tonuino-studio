/**
 * A simulated Arduino bootloader (STK500v1 like Optiboot, ATmegaBOOT and
 * optiboot_x) behind fake SerialConnection / SerialAccess implementations.
 *
 * It behaves like the real thing where the flash code depends on it:
 * - a rising DTR (false -> true) resets the board into the bootloader,
 * - talking at the wrong baud rate is garbage to it, so it starts the app
 *   and stays silent,
 * - a frame that does not end with CRC_EOP makes it start the app,
 * - without input for a while it starts the app,
 * - LOAD_ADDRESS is a word address, or a byte address with byteAddressing,
 * - PROG_PAGE erases the page and writes it; writes into the bootloader
 *   area are ignored and recorded as violations.
 */
import type { SerialAccess, SerialConnection, SerialPortInfo, SerialSignals } from '../../src/platform/types';

export interface SimOptions {
  /** Default 1e 95 0f (ATmega328P). */
  signature?: readonly [number, number, number];
  /** Speed of the bootloader (default 115200). */
  baudRate?: number;
  /** Default 32768. */
  flashSize?: number;
  /** Default 128. */
  pageSize?: number;
  /** LOAD_ADDRESS carries byte addresses (optiboot_x). Default false: word addresses. */
  byteAddressing?: boolean;
  /** Address ranges [start, end) holding the bootloader. Default: the last 512 bytes. */
  protectedRanges?: [number, number][];
  /** SW_MAJOR and SW_MINOR for GET_PARAMETER (default 8.0, Optiboot 8). */
  version?: [number, number];
  /** The bootloader starts the app after this long without input (default 1000 ms). */
  bootTimeoutMs?: number;
  /** The bootloader ignores input for this long after a reset (old bootloaders blink first). */
  listenAfterMs?: number;
  /** At most this many bytes per read() call (default: no limit). */
  chunkSize?: number;
  /** Delay before reply bytes arrive (default 0). */
  replyDelayMs?: number;
  /** Bytes in front of the first answer after each reset (noise, the old firmware talking). */
  garbage?: number[];
  /** Flash cells that always read this value. */
  stuck?: Record<number, number>;
  /** The board stops answering for good after this many page writes (power lost). */
  dieAfterPages?: number;
  /** The board stops answering for good after this many page reads (power lost while it is read). */
  dieAfterReads?: number;
  /** write() rejects after this many successful calls (cable pulled). */
  unplugAfterWrites?: number;
}

type Mode = 'bootloader' | 'app' | 'dead';

interface TxByte {
  value: number;
  at: number;
}

export class SimulatedBoard {
  readonly signature: readonly [number, number, number];
  readonly baudRate: number;
  readonly pageSize: number;
  readonly byteAddressing: boolean;
  readonly flash: Uint8Array;
  readonly protectedRanges: [number, number][];
  /** Every frame the bootloader executed, e.g. "LOAD_ADDRESS 0x0200", "PROG_PAGE 128". */
  readonly commands: string[] = [];
  /** Things a real bootloader would have done wrong or refused. */
  readonly violations: string[] = [];
  mode: Mode = 'app';
  resets = 0;
  pagesWritten = 0;
  pagesRead = 0;
  unplugged = false;

  private readonly opts: SimOptions;
  private dtr = false;
  private rx: number[] = [];
  private tx: TxByte[] = [];
  private address = 0;
  private lastInput = 0;
  private resetAt = 0;
  private garbagePending = false;
  private writes = 0;

  constructor(opts: SimOptions = {}) {
    this.opts = opts;
    this.signature = opts.signature ?? [0x1e, 0x95, 0x0f];
    this.baudRate = opts.baudRate ?? 115200;
    this.pageSize = opts.pageSize ?? 128;
    this.byteAddressing = opts.byteAddressing ?? false;
    const size = opts.flashSize ?? 32768;
    this.flash = new Uint8Array(size).fill(0xff);
    this.protectedRanges = opts.protectedRanges ?? [[size - 512, size]];
    // Something recognisable in the bootloader area, so overwriting it shows.
    for (const [start, end] of this.protectedRanges) {
      for (let a = start; a < end; a++) this.flash[a] = a & 1 ? 0x94 : 0x0c;
    }
  }

  /** Bytes of the flash, e.g. to compare with the image. */
  read(address: number, length: number): Uint8Array {
    return this.flash.slice(address, address + length);
  }

  // ---- called by SimConnection

  setSignals(signals: SerialSignals): void {
    if (signals.dtr !== undefined) {
      if (!this.dtr && signals.dtr) this.reset();
      this.dtr = signals.dtr;
    }
  }

  disconnect(): void {
    this.dtr = false;
    this.tx = [];
    this.rx = [];
  }

  write(data: Uint8Array, baudRate: number): void {
    this.writes++;
    if (this.opts.unplugAfterWrites !== undefined && this.writes > this.opts.unplugAfterWrites) this.unplugged = true;
    if (this.unplugged) throw lost();
    const now = Date.now();
    this.tick(now);
    if (this.mode !== 'bootloader') return;
    if (now - this.resetAt < (this.opts.listenAfterMs ?? 0)) return;
    if (baudRate !== this.baudRate) {
      // Garbage to the bootloader: it fails verifySpace and starts the app.
      this.commands.push(`garbage at ${baudRate} baud`);
      this.mode = 'app';
      return;
    }
    this.lastInput = now;
    this.rx.push(...data);
    this.process(now);
  }

  /** Bytes that have arrived by `now`, at most `max`. */
  take(now: number, max: number): Uint8Array {
    if (this.unplugged) throw lost();
    let n = 0;
    while (n < this.tx.length && n < max && this.tx[n].at <= now) n++;
    return Uint8Array.from(this.tx.splice(0, n), (b) => b.value);
  }

  /** When the next byte arrives (Infinity: nothing on the way). */
  nextArrival(): number {
    return this.tx.length ? this.tx[0].at : Number.POSITIVE_INFINITY;
  }

  discard(now: number): void {
    if (this.unplugged) throw lost();
    this.tx = this.tx.filter((b) => b.at > now);
  }

  get chunkSize(): number {
    return this.opts.chunkSize ?? Number.POSITIVE_INFINITY;
  }

  // ---- bootloader

  private reset(): void {
    this.resets++;
    this.mode = 'bootloader';
    this.rx = [];
    this.tx = [];
    this.resetAt = Date.now();
    this.lastInput = this.resetAt;
    this.garbagePending = (this.opts.garbage?.length ?? 0) > 0;
  }

  private tick(now: number): void {
    if (this.mode === 'bootloader' && now - this.lastInput > (this.opts.bootTimeoutMs ?? 1000)) this.mode = 'app';
  }

  private process(now: number): void {
    while (this.mode === 'bootloader' && this.rx.length > 0) {
      const need = frameLength(this.rx);
      if (need === undefined || this.rx.length < need) return;
      this.execute(this.rx.splice(0, need), now);
    }
  }

  private execute(frame: number[], now: number): void {
    if (frame[frame.length - 1] !== 0x20) {
      // verifySpace() failed: watchdog reset into the app.
      this.commands.push(`bad frame 0x${frame[0].toString(16)}`);
      this.mode = 'app';
      return;
    }
    const cmd = frame[0];
    switch (cmd) {
      case 0x30:
        this.commands.push('GET_SYNC');
        return this.reply([], now);
      case 0x41: {
        this.commands.push(`GET_PARAMETER 0x${frame[1].toString(16)}`);
        const [major, minor] = this.opts.version ?? [8, 0];
        return this.reply([frame[1] === 0x81 ? major : frame[1] === 0x82 ? minor : 0x03], now);
      }
      case 0x42:
        this.commands.push('SET_DEVICE');
        return this.reply([], now);
      case 0x50:
        this.commands.push('ENTER_PROGMODE');
        return this.reply([], now);
      case 0x51:
        this.commands.push('LEAVE_PROGMODE');
        this.reply([], now);
        this.mode = 'app';
        return;
      case 0x55: {
        const value = frame[1] | (frame[2] << 8);
        this.address = this.byteAddressing ? value : value * 2;
        this.commands.push(`LOAD_ADDRESS 0x${this.address.toString(16).padStart(4, '0')}`);
        return this.reply([], now);
      }
      case 0x64: {
        const length = (frame[1] << 8) | frame[2];
        this.commands.push(`PROG_PAGE ${length}`);
        if (this.opts.dieAfterPages !== undefined && this.pagesWritten >= this.opts.dieAfterPages) {
          this.mode = 'dead';
          return;
        }
        if (frame[3] !== 0x46) this.violations.push(`PROG_PAGE memtype 0x${frame[3].toString(16)}`);
        this.programPage(this.address, frame.slice(4, 4 + length));
        this.pagesWritten++;
        return this.reply([], now);
      }
      case 0x74: {
        const length = (frame[1] << 8) | frame[2];
        this.commands.push(`READ_PAGE ${length}`);
        if (this.opts.dieAfterReads !== undefined && this.pagesRead >= this.opts.dieAfterReads) {
          this.mode = 'dead';
          return;
        }
        this.pagesRead++;
        const out: number[] = [];
        for (let i = 0; i < length; i++) {
          const a = this.address + i;
          out.push(this.opts.stuck?.[a] ?? this.flash[a] ?? 0xff);
        }
        return this.reply(out, now);
      }
      case 0x75:
        this.commands.push('READ_SIGN');
        return this.reply([...this.signature], now);
      default:
        // Optiboot answers unknown commands with a plain OK.
        this.commands.push(`unknown 0x${cmd.toString(16)}`);
        return this.reply([], now);
    }
  }

  private programPage(address: number, data: number[]): void {
    const at = `0x${address.toString(16)}`;
    if (address % this.pageSize !== 0) this.violations.push(`page write at unaligned address ${at}`);
    if (data.length > this.pageSize) this.violations.push(`page write of ${data.length} bytes at ${at}`);
    const end = address + data.length;
    if (end > this.flash.length) {
      this.violations.push(`page write beyond flash end at ${at}`);
      return;
    }
    if (this.protectedRanges.some(([s, e]) => address < e && end > s)) {
      this.violations.push(`page write into bootloader at ${at}`);
      return;
    }
    // The page is erased first; bytes not sent stay 0xFF.
    const page = address - (address % this.pageSize);
    this.flash.fill(0xff, page, page + this.pageSize);
    this.flash.set(data, address);
  }

  private reply(data: number[], now: number): void {
    const at = now + (this.opts.replyDelayMs ?? 0);
    const bytes = [0x14, ...data, 0x10];
    if (this.garbagePending) {
      this.garbagePending = false;
      bytes.unshift(...(this.opts.garbage ?? []));
    }
    for (const value of bytes) this.tx.push({ value, at });
  }
}

/** Total frame length including CRC_EOP, or undefined while the header is incomplete. */
function frameLength(rx: number[]): number | undefined {
  switch (rx[0]) {
    case 0x41:
      return 3;
    case 0x42:
      return 22;
    case 0x45:
      return 7;
    case 0x55:
      return 4;
    case 0x56:
      return 6;
    case 0x64:
      return rx.length < 3 ? undefined : 4 + ((rx[1] << 8) | rx[2]) + 1;
    case 0x74:
      return 5;
    default:
      return 2;
  }
}

function lost(): Error {
  const e = new Error('The device has been lost.');
  e.name = 'NetworkError';
  return e;
}

export const SIM_PORT: SerialPortInfo = { id: 'sim', label: 'Simulierte Box', usbVendorId: 0x1a86, usbProductId: 0x7523 };

export class SimConnection implements SerialConnection {
  readonly port: SerialPortInfo;
  readonly baudRate: number;
  closed = false;
  private readonly board: SimulatedBoard;

  constructor(board: SimulatedBoard, port: SerialPortInfo, baudRate: number) {
    this.board = board;
    this.port = port;
    this.baudRate = baudRate;
  }

  async write(data: Uint8Array): Promise<void> {
    this.check();
    this.board.write(data, this.baudRate);
  }

  async read(timeoutMs: number, maxBytes = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
    this.check();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const now = Date.now();
      const got = this.board.take(now, Math.min(maxBytes, this.board.chunkSize));
      if (got.length > 0) return got;
      if (now >= deadline) return new Uint8Array(0);
      const wake = Math.min(deadline, this.board.nextArrival());
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, wake - now)));
    }
  }

  async discardInput(): Promise<void> {
    this.check();
    this.board.discard(Date.now());
  }

  async setSignals(signals: SerialSignals): Promise<void> {
    this.check();
    if (this.board.unplugged) throw lost();
    this.board.setSignals(signals);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.board.disconnect();
  }

  private check(): void {
    if (this.closed) throw new Error('port is closed');
  }
}

export class SimulatedSerialAccess implements SerialAccess {
  readonly supported = true;
  readonly connections: SimConnection[] = [];
  /** open() rejects with this error when set. */
  openError: Error | undefined;
  readonly board: SimulatedBoard;
  readonly portInfo: SerialPortInfo;

  constructor(board: SimulatedBoard, portInfo: SerialPortInfo = SIM_PORT) {
    this.board = board;
    this.portInfo = portInfo;
  }

  async list(): Promise<SerialPortInfo[]> {
    return [this.portInfo];
  }

  async open(port: SerialPortInfo, baudRate: number): Promise<SerialConnection> {
    if (this.openError) throw this.openError;
    const conn = new SimConnection(this.board, port, baudRate);
    this.connections.push(conn);
    return conn;
  }

  get openedBauds(): number[] {
    return this.connections.map((c) => c.baudRate);
  }

  get allClosed(): boolean {
    return this.connections.every((c) => c.closed);
  }
}

/** Short timeouts so the tests run fast. */
export const FAST_TIMING = {
  resetLowMs: 5,
  resetHighMs: 2,
  syncTimeoutMs: 25,
  syncAttempts: 3,
  syncConfirmations: 3,
  drainMs: 3,
  commandTimeoutMs: 80,
};

/** Pseudo-random firmware bytes (deterministic). */
export function firmwareBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

/** A board like a Nano with Optiboot (115200) or the old bootloader (57600, 2 KB). */
export function nanoBoard(kind: 'optiboot' | 'old', opts: SimOptions = {}): SimulatedBoard {
  return new SimulatedBoard(
    kind === 'optiboot'
      ? { baudRate: 115200, version: [8, 0], protectedRanges: [[0x7e00, 0x8000]], ...opts }
      : { baudRate: 57600, version: [1, 16], protectedRanges: [[0x7800, 0x8000]], ...opts },
  );
}

/** A board like the AiO+ (ATmega4809, optiboot_x: byte addresses, bootloader in the first 512 bytes). */
export function aioPlusBoard(opts: SimOptions = {}): SimulatedBoard {
  return new SimulatedBoard({
    signature: [0x1e, 0x96, 0x51],
    baudRate: 115200,
    flashSize: 49152,
    byteAddressing: true,
    protectedRanges: [[0, 0x200]],
    ...opts,
  });
}
