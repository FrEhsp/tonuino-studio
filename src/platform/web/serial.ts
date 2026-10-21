import type { SerialAccess, SerialConnection, SerialPortInfo, SerialSignals } from '../types';

/** USB-serial chips found on TonUINO boards: CH340, FTDI, CP210x, Arduino, AiO (LGT8F328P). */
export const TONUINO_USB_FILTERS = [
  { usbVendorId: 0x1a86 },
  { usbVendorId: 0x0403 },
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x2341 },
  { usbVendorId: 0x04d9, usbProductId: 0xb534 },
];

const CHIP_NAMES: Record<number, string> = {
  0x1a86: 'CH340',
  0x0403: 'FTDI',
  0x10c4: 'CP210x',
  0x2341: 'Arduino',
  0x04d9: 'AiO',
};

/** Devices whose product id tells more than the vendor. */
const PRODUCT_NAMES: Record<string, string> = {
  '1a86:55d4': 'CH9102',
  '2341:0058': 'Arduino Nano Every',
  '2341:0070': 'Arduino Nano ESP32',
};

/** Data kept for a reader that falls behind; older bytes are dropped like an overflowing UART buffer. */
const MAX_BUFFERED = 1 << 20;

const MESSAGES = {
  disconnected: 'Die Verbindung zur Box ist abgebrochen. Prüfe das USB-Kabel und stecke die Box neu ein.',
  closed: 'Die Verbindung zur Box ist schon geschlossen. Verbinde dich neu.',
  'not-found': 'Der Anschluss ist nicht mehr da. Stecke die Box wieder ein und wähle sie noch einmal aus.',
} as const;

/** Chrome gives no reason when a port does not open: in use, missing driver or missing rights. */
const OPEN_FAILED = 'Der Anschluss lässt sich nicht öffnen. Meist benutzt ihn gerade ein anderes Programm, oder es fehlt ein Treiber oder die Berechtigung.';

/**
 * A port that went away, was closed, or is no longer there to open. `code`
 * uses the same words as the desktop platform ('disconnected', 'closed',
 * 'not-found'), so callers such as the flasher can tell a pulled cable from
 * other failures.
 */
export class SerialPortError extends Error {
  readonly code: keyof typeof MESSAGES;
  /** What the browser reported, for logs and support. */
  readonly detail?: string;

  constructor(code: keyof typeof MESSAGES, detail?: string) {
    super(MESSAGES[code]);
    this.name = 'SerialPortError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

/**
 * Ids for the ports the page may use. A replugged device comes back as a new
 * SerialPort object (and a CH340 without serial number needs the chooser
 * again), so ports whose device went away are forgotten: the old object can
 * never open again.
 */
const ports = new Map<string, SerialPort>();
let counter = 0;

function forget(port: SerialPort): void {
  for (const [id, p] of ports) if (p === port) ports.delete(id);
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

function describe(port: SerialPort): SerialPortInfo {
  let id = [...ports].find(([, p]) => p === port)?.[0];
  if (!id) {
    id = `web-serial-${++counter}`;
    ports.set(id, port);
  }
  const info = port.getInfo();
  const vid = info.usbVendorId;
  const pid = info.usbProductId;
  const chip =
    vid === undefined ? undefined : ((pid !== undefined ? PRODUCT_NAMES[`${hex4(vid)}:${hex4(pid)}`] : undefined) ?? CHIP_NAMES[vid]);
  return {
    id,
    label: chip ? `USB-Seriell (${chip})` : 'Serieller Anschluss',
    usbVendorId: vid,
    usbProductId: pid,
  };
}

function errorDetail(e: unknown): string | undefined {
  if (e === undefined || e === null) return undefined;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Chrome rejects stream operations on a vanished device with "NetworkError: The device has been lost." */
function isDeviceLost(e: unknown): boolean {
  const err = e as { name?: unknown; message?: unknown } | null;
  return (
    (typeof err?.name === 'string' && err.name === 'NetworkError') ||
    (typeof err?.message === 'string' && /device has been lost|disconnected/i.test(err.message))
  );
}

/**
 * One open Web Serial port. A pump reads the port's stream into a buffer that
 * read() serves. When the device disappears, the stream breaks and
 * `port.readable` turns null (Web Serial: a fatal read error), or a
 * "disconnect" event arrives first; either way the connection is lost for
 * good and reads and writes reject with a SerialPortError 'disconnected'
 * instead of quietly timing out.
 */
export class WebSerialConnection implements SerialConnection {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private waiters: (() => void)[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private lost: SerialPortError | null = null;
  private lastStreamError: unknown;
  private readonly readLoop: Promise<void>;
  private readonly onPortDisconnect = () => this.markLost('disconnect event');

  constructor(
    readonly serialPort: SerialPort,
    readonly port: SerialPortInfo,
    readonly baudRate: number,
    private readonly onClose?: () => void,
  ) {
    serialPort.addEventListener('disconnect', this.onPortDisconnect);
    this.readLoop = this.pump();
  }

  /** True once the device went away; the connection cannot be used again. */
  get isLost(): boolean {
    return this.lost !== null;
  }

  private async pump(): Promise<void> {
    let ended = false;
    while (!this.closed && !ended) {
      const readable = this.serialPort.readable;
      if (!readable) break;
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = readable.getReader();
      } catch (e) {
        this.lastStreamError = e;
        break;
      }
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          // Only close() ends a stream on purpose; one that ends by itself brings no more data.
          if (done) {
            ended = true;
            break;
          }
          if (value?.length) this.receive(value);
        }
      } catch (e) {
        // Framing errors and buffer overruns end this stream only: the port
        // hands out a fresh one. A lost device leaves `readable` null instead.
        this.lastStreamError = e;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Already released.
        }
        this.reader = null;
      }
    }
    // The stream is gone although nobody closed the port: the device was lost.
    if (!this.closed) this.markLost(errorDetail(this.lastStreamError) ?? 'readable stream is gone');
  }

  private receive(bytes: Uint8Array): void {
    this.chunks.push(bytes.slice());
    this.buffered += bytes.length;
    while (this.buffered > MAX_BUFFERED && this.chunks.length > 1) {
      this.buffered -= this.chunks.shift()!.length;
    }
    this.wake();
  }

  /** Ends the connection for good. Bytes that already arrived can still be read. */
  markLost(detail?: string): void {
    if (this.closed || this.lost) return;
    this.lost = new SerialPortError('disconnected', detail);
    this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private check(): void {
    if (this.closed) throw new SerialPortError('closed');
    if (this.lost) throw this.lost;
  }

  /** The error to throw for a failed port operation: the lost error once the device is gone. */
  private failure(e: unknown): unknown {
    if (!this.closed && !this.lost && (isDeviceLost(e) || this.serialPort.readable === null)) this.markLost(errorDetail(e));
    return this.lost ?? e;
  }

  private take(maxBytes: number): Uint8Array {
    const want = Math.max(1, Math.min(Math.floor(maxBytes), this.buffered));
    const out = new Uint8Array(want);
    let n = 0;
    while (n < want) {
      const head = this.chunks[0];
      const part = Math.min(head.length, want - n);
      out.set(head.subarray(0, part), n);
      n += part;
      if (part === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(part);
    }
    this.buffered -= want;
    return out;
  }

  async write(data: Uint8Array): Promise<void> {
    this.check();
    const writable = this.serialPort.writable;
    if (!writable) throw this.failure(new SerialPortError('disconnected', 'writable stream is gone'));
    let writer: WritableStreamDefaultWriter<Uint8Array>;
    try {
      writer = writable.getWriter();
    } catch (e) {
      throw this.failure(e);
    }
    try {
      await writer.write(data);
    } catch (e) {
      throw this.failure(e);
    } finally {
      writer.releaseLock();
    }
  }

  async read(timeoutMs: number, maxBytes = 4096): Promise<Uint8Array> {
    if (this.closed) throw new SerialPortError('closed');
    if (!this.buffered && !this.lost && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== done);
          resolve();
        }, timeoutMs);
        this.waiters.push(done);
      });
    }
    if (this.buffered) return this.take(maxBytes);
    if (this.lost) throw this.lost;
    return new Uint8Array(0);
  }

  async discardInput(): Promise<void> {
    this.check();
    this.chunks = [];
    this.buffered = 0;
  }

  async setSignals(signals: SerialSignals): Promise<void> {
    this.check();
    const s: SerialOutputSignals = {};
    if (signals.dtr !== undefined) s.dataTerminalReady = signals.dtr;
    if (signals.rts !== undefined) s.requestToSend = signals.rts;
    try {
      await this.serialPort.setSignals(s);
    } catch (e) {
      throw this.failure(e);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.serialPort.removeEventListener('disconnect', this.onPortDisconnect);
    this.wake();
    this.closing = (async () => {
      await this.reader?.cancel().catch(() => undefined);
      await this.readLoop.catch(() => undefined);
      await this.serialPort.close().catch(() => undefined);
      this.onClose?.();
    })();
    return this.closing;
  }
}

function browserSerial(): Serial | undefined {
  return typeof navigator !== 'undefined' && 'serial' in navigator ? navigator.serial : undefined;
}

/** The browser's SerialAccess, which always has the port chooser. */
export type WebSerialAccess = SerialAccess & Required<Pick<SerialAccess, 'request'>>;

/** SerialAccess over Web Serial. `api` is navigator.serial; tests pass a fake. */
export function webSerial(api: Serial | undefined = browserSerial()): WebSerialAccess {
  const supported = !!api;
  const connections = new Set<WebSerialConnection>();
  // The event is fired at the port and bubbles to navigator.serial; older
  // Chrome versions only fire it at navigator.serial.
  const onDisconnect = (e: Event) => {
    const gone = e.target as SerialPort | null;
    for (const c of connections) if (c.serialPort === gone) c.markLost('disconnect event');
    if (gone) forget(gone);
  };
  api?.addEventListener('disconnect', onDisconnect);
  // Web Serial without folder access: a guess from capabilities, not a browser check. Firefox looks
  // like this and asks once whether it may add a helper add-on; another engine may too (Brave
  // without File System Access), so every text behind this flag stays true when nothing is asked.
  const mayAskForAddon = supported && typeof window !== 'undefined' && !('showDirectoryPicker' in window);
  return {
    supported,
    mayAskForAddon,
    async list() {
      if (!api) return [];
      const granted = await api.getPorts();
      // getPorts() lists connected ports only; the others cannot come back.
      for (const p of ports.values()) if (!granted.includes(p)) forget(p);
      return granted.map(describe);
    },
    async request(filters = TONUINO_USB_FILTERS) {
      if (!api) return null;
      try {
        return describe(await api.requestPort({ filters }));
      } catch (e) {
        if (e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'AbortError')) return null;
        throw e;
      }
    },
    async open(info, baudRate) {
      const sp = ports.get(info.id);
      if (!api || !sp) throw new SerialPortError('not-found', `no port ${info.id}`);
      try {
        await sp.open({ baudRate, bufferSize: 64 * 1024 });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'InvalidStateError') {
          throw new Error('Der Anschluss ist schon geöffnet, vielleicht in einem anderen Tab oder Programm (z. B. der Arduino IDE). Schließe es und versuche es noch einmal.');
        }
        // The device went away (cable pulled), maybe before the browser said so.
        const listed = await api.getPorts().then(
          (granted) => granted.includes(sp),
          () => true,
        );
        if (!listed) {
          forget(sp);
          throw new SerialPortError('not-found', errorDetail(e));
        }
        throw Object.assign(new Error(OPEN_FAILED), { detail: errorDetail(e) });
      }
      const conn: WebSerialConnection = new WebSerialConnection(sp, info, baudRate, () => connections.delete(conn));
      connections.add(conn);
      return conn;
    },
  };
}
