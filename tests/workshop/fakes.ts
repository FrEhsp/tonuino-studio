/**
 * Sample logs and a scriptable serial port for the workshop tests.
 */
import type { SerialAccess, SerialConnection, SerialPortInfo, SerialSignals } from '../../src/platform/types';

/** Start of a Classic box with TonUINO TNG 3.3.3 (CR LF, as the firmware prints it). */
export const CLASSIC_LOG =
  [
    ' _____         _____ _____ _____ _____ ',
    '|_   _|___ ___|  |  |     |   | |     |',
    'TonUINO Version 3.x - refactored by Boerge1',
    'created by Thorsten Voß and licensed under GNU/GPL.',
    'V3.3.3 17.09.26',
    'C 3',
    'Ver:2',
    'Vol:25 5 15 25 5 15',
    'EQ:1',
    'ST:0',
    'IB:1',
    'AL:0',
    'AP:1111',
    'PCR:0',
    'MFRC522:146',
    'track_count: 312',
    'enter Idle',
    'Card Ins',
    'play 5-1',
    'Volume: 16',
  ].join('\r\n') + '\r\n';

/** An AiO+ whose card reader and MP3 player do not answer. */
export const AIOPLUS_BROKEN_LOG =
  [
    'TonUINO Version 3.x - refactored by Boerge1',
    'V3.3.3 17.09.26',
    'A+ 5',
    'Ver:2',
    'Vol:20 3 10 18 2 8',
    'EQ:3',
    'ST:10',
    'IB:0',
    'AL:2',
    'AP:1231',
    'PCR:1',
    'MFRC522:0',
    'com to mfrc broken',
    'Com to DFPlayer broken',
    'track_count: 0',
    'enter Idle',
  ].join('\n') + '\n';

export const CH340_PORT: SerialPortInfo = { id: '/dev/ttyUSB0', label: 'USB-Serial CH340 (ttyUSB0)', path: '/dev/ttyUSB0', usbVendorId: 0x1a86, usbProductId: 0x7523 };
export const AIO_PORT: SerialPortInfo = { id: 'COM4', label: 'USB-Serial HT42B534 (LKP AiO) (COM4)', path: 'COM4', usbVendorId: 0x04d9, usbProductId: 0xb534 };
export const CP2102_PORT: SerialPortInfo = { id: 'COM5', label: 'USB-Serial CP2102 (COM5)', path: 'COM5', usbVendorId: 0x10c4, usbProductId: 0xea60 };
export const BUILTIN_PORT: SerialPortInfo = { id: 'COM1', label: 'Serieller Anschluss (COM1)', path: 'COM1' };

/** An error like the platforms throw for a pulled cable. */
export function lostError(): Error {
  return Object.assign(new Error('Die Verbindung zur Box ist abgebrochen. Prüfe das USB-Kabel und stecke die Box neu ein.'), { code: 'disconnected' });
}

/** A serial connection fed by the test: send() queues bytes, unplug() makes reads fail. */
export class FakeConnection implements SerialConnection {
  readonly signals: SerialSignals[] = [];
  closed = false;
  private queue: Uint8Array[] = [];
  private failure: unknown;
  private waiters: (() => void)[] = [];

  constructor(
    readonly port: SerialPortInfo,
    readonly baudRate: number,
  ) {}

  send(data: string | Uint8Array): void {
    this.queue.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    this.wake();
  }

  /** Reads reject with `error` from now on (default: a pulled cable). */
  unplug(error: unknown = lostError()): void {
    this.failure = error;
    this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async write(): Promise<void> {
    if (this.closed) throw Object.assign(new Error('closed'), { code: 'closed' });
    if (this.failure) throw this.failure;
  }

  async read(timeoutMs: number): Promise<Uint8Array> {
    if (this.closed) throw Object.assign(new Error('closed'), { code: 'closed' });
    if (!this.queue.length && !this.failure) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const next = this.queue.shift();
    if (next) return next;
    if (this.failure && !this.closed) throw this.failure;
    return new Uint8Array(0);
  }

  async discardInput(): Promise<void> {
    this.queue = [];
  }

  async setSignals(signals: SerialSignals): Promise<void> {
    if (this.closed) throw Object.assign(new Error('closed'), { code: 'closed' });
    if (this.failure) throw this.failure;
    this.signals.push(signals);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wake();
  }
}

export class FakeSerial implements SerialAccess {
  readonly supported = true;
  readonly connections: FakeConnection[] = [];
  ports: SerialPortInfo[] = [CH340_PORT];
  /** open() rejects with this when set. */
  openError: unknown;

  async list(): Promise<SerialPortInfo[]> {
    return [...this.ports];
  }

  async open(port: SerialPortInfo, baudRate: number): Promise<SerialConnection> {
    if (this.openError) throw this.openError;
    const conn = new FakeConnection(port, baudRate);
    this.connections.push(conn);
    return conn;
  }

  get last(): FakeConnection {
    const c = this.connections.at(-1);
    if (!c) throw new Error('nothing opened');
    return c;
  }
}

/** Resolves when `check` holds, polling every few ms (fails after `ms`). */
export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}
