/**
 * Reads a box's serial log: opens the port at 115200 baud, hands every chunk
 * to the caller and tells when the connection ends. The port is always
 * closed at the end, whatever ended it.
 */
import type { SerialAccess, SerialConnection, SerialPortInfo } from '../../platform/types';

/** TonUINO prints its log at this speed (Serial.begin(115200)). */
export const LOG_BAUD_RATE = 115200;

export type MonitorEnd =
  /** stop() was called. */
  | { reason: 'stopped' }
  /** The device went away: cable pulled, box switched off. */
  | { reason: 'lost'; error: unknown }
  /** Reading failed for another reason. */
  | { reason: 'error'; error: unknown };

export interface MonitorHandlers {
  onData(bytes: Uint8Array): void;
  /** Called once, after the port is closed. */
  onEnd(end: MonitorEnd): void;
}

export interface Monitor {
  readonly port: SerialPortInfo;
  readonly baudRate: number;
  /** Restarts the box through the DTR and RTS lines, like its reset button. */
  restartBox(): Promise<void>;
  /** Sends bytes to the box (a WRITECARD line, writecard.ts). */
  write(data: Uint8Array): Promise<void>;
  /** Stops reading and closes the port. Safe to call more than once. */
  stop(): Promise<void>;
  /** Resolves once the port is closed. */
  readonly closed: Promise<void>;
}

export interface MonitorOptions {
  baudRate?: number;
  /** How long one read waits (default 200 ms); short so stop() is quick. */
  readSliceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** True for errors that mean the device is gone (both platforms use these codes). */
export function isConnectionLost(error: unknown): boolean {
  const e = error as { code?: unknown; name?: unknown } | null;
  return e?.code === 'disconnected' || e?.code === 'not-found' || e?.code === 'closed' || e?.name === 'NetworkError';
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Opens the port and starts reading. Rejects when the port does not open
 * (with the platform's error, which says why).
 */
export async function openMonitor(serial: SerialAccess, port: SerialPortInfo, handlers: MonitorHandlers, opts: MonitorOptions = {}): Promise<Monitor> {
  const baudRate = opts.baudRate ?? LOG_BAUD_RATE;
  const slice = opts.readSliceMs ?? 200;
  const sleep = opts.sleep ?? defaultSleep;
  const conn: SerialConnection = await serial.open(port, baudRate);
  let stopping = false;

  const loop = async (): Promise<MonitorEnd> => {
    for (;;) {
      if (stopping) return { reason: 'stopped' };
      let chunk: Uint8Array;
      try {
        chunk = await conn.read(slice, 4096);
      } catch (error) {
        if (stopping) return { reason: 'stopped' };
        return isConnectionLost(error) ? { reason: 'lost', error } : { reason: 'error', error };
      }
      if (chunk.length) {
        try {
          handlers.onData(chunk);
        } catch {
          // A broken handler must not stop the log.
        }
      }
    }
  };

  const closed = loop().then(async (end) => {
    await conn.close().catch(() => undefined);
    try {
      handlers.onEnd(end);
    } catch {
      // Nothing left to do.
    }
  });

  return {
    port,
    baudRate,
    closed,
    async restartBox() {
      // A Nano resets on the falling DTR edge (DTR asserted after released).
      // ESP32 boards reset while RTS alone is asserted and boot normally once
      // both are asserted. This order serves both and ends like a fresh port.
      await conn.setSignals({ dtr: false, rts: false });
      await sleep(100);
      await conn.setSignals({ dtr: false, rts: true });
      await sleep(100);
      await conn.setSignals({ dtr: true, rts: true });
    },
    write(data: Uint8Array) {
      return conn.write(data);
    },
    async stop() {
      stopping = true;
      // Closing ends a waiting read at once instead of after its time slice.
      await conn.close().catch(() => undefined);
      await closed;
    },
  };
}
