/**
 * The box over a USB cable at the phone (USB-OTG) in the Android app.
 * Android has no serial ports for apps: the app opens the USB device itself
 * and talks to its serial chip (./usbChips.ts) through the small Kotlin
 * bridge (src-tauri/android/TonuinoUsb.kt), which claims the device, sends
 * control transfers and bytes, and reads the chip's bulk-in endpoint in a
 * thread of its own.
 *
 *   window.TonuinoUsb   devices(), permission(id, name), open(id, name, interfaces, in, out, header),
 *                       control(id, handle, type, request, value, index, data, length),
 *                       write(id, handle, data), drop(handle), close(handle)
 *   events              usb-data {handle, gen, data: [base64…]}, usb-gone {handle}, usb-devices {}
 *
 * Android asks the user once per plugged-in device whether the app may use
 * it; that question comes when the box is opened, not when it is listed.
 */
import type { SerialAccess, SerialConnection, SerialPortInfo, SerialSignals } from '../types';
import { SerialPortError } from '../web/serial';
import { type AndroidCalls, AndroidBridgeError, fromBase64, NO_TIMEOUT, toBase64 } from './androidBridge';
import { type ChipDriver, type Control, driverFor, type UsbDeviceInfo } from './usbChips';

/** What MainActivity adds to the page as window.TonuinoUsb. */
export interface UsbBridge {
  /** JSON [UsbDeviceInfo]: every USB device at the phone. */
  devices(): string;
  /** Android's question "Zugriff auf … erlauben?". done: {granted}. */
  permission(id: string, name: string): void;
  /**
   * Claims the interfaces (comma separated numbers) and starts reading
   * `inEndpoint`; packets no longer than `header` bytes are not passed on.
   * done: {handle}.
   */
  open(id: string, name: string, interfaces: string, inEndpoint: number, outEndpoint: number, header: number): void;
  /** done: {data?: base64} (the bytes of an IN transfer). */
  control(id: string, handle: number, requestType: number, request: number, value: number, index: number, data: string, length: number): void;
  /** done: {} once every byte went out. */
  write(id: string, handle: number, data: string): void;
  /** Forgets bytes read but not yet handed to the page; returns the new generation of the data events. */
  drop(handle: number): number;
  /** Releases the device; never answers. */
  close(handle: number): void;
}

/** Longest a control transfer or a write may take before the page gives up. */
const IO_TIMEOUT_MS = 5000;
/** Data kept for a reader that falls behind (like web/serial.ts). */
const MAX_BUFFERED = 1 << 20;

const PERMISSION_DENIED =
  'Das Handy hat den Zugriff auf die Box nicht erlaubt. Stecke die Box noch einmal ein, öffne sie wieder und tipp bei der Frage des Handys auf „Zulassen“.';
const OPEN_FAILED = 'Die Box ließ sich nicht öffnen. Stecke das USB-Kabel noch einmal ein und versuche es wieder.';

function parseDevices(text: string): UsbDeviceInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is UsbDeviceInfo => !!d && typeof d.name === 'string' && typeof d.vendorId === 'number' && typeof d.productId === 'number' && Array.isArray(d.interfaces));
}

/** The port the app shows for a device it can talk to. */
export function portOf(device: UsbDeviceInfo, driver: ChipDriver): SerialPortInfo {
  return { id: `usb:${device.name}`, label: `USB-Seriell (${driver.label})`, usbVendorId: device.vendorId, usbProductId: device.productId };
}

interface DataEvent {
  handle: number;
  gen: number;
  data: string[];
}

export class AndroidUsbSerial implements SerialAccess {
  readonly supported = true;
  private readonly connections = new Map<number, AndroidUsbConnection>();

  constructor(
    private readonly bridge: UsbBridge,
    private readonly calls: AndroidCalls,
  ) {
    calls.on('usb-data', (raw) => {
      const e = raw as DataEvent;
      if (!e || typeof e.handle !== 'number' || !Array.isArray(e.data)) return;
      this.connections.get(e.handle)?.receive(e.gen, e.data);
    });
    calls.on('usb-gone', (raw) => {
      const handle = (raw as { handle?: unknown } | null)?.handle;
      if (typeof handle === 'number') this.connections.get(handle)?.markLost('device detached');
    });
  }

  private devices(): UsbDeviceInfo[] {
    try {
      return parseDevices(this.bridge.devices());
    } catch {
      return [];
    }
  }

  /** Every device at the phone that has a serial chip the app knows. No question to the user yet. */
  async list(): Promise<SerialPortInfo[]> {
    return this.devices().flatMap((d) => {
      const driver = driverFor(d);
      return driver ? [portOf(d, driver)] : [];
    });
  }

  async open(port: SerialPortInfo, baudRate: number): Promise<SerialConnection> {
    const name = port.id.startsWith('usb:') ? port.id.slice(4) : port.id;
    const device = this.devices().find((d) => d.name === name);
    if (!device) throw new SerialPortError('not-found', `no USB device ${name}`);
    const driver = driverFor(device);
    if (!driver) throw new SerialPortError('not-found', `no driver for ${device.vendorId.toString(16)}:${device.productId.toString(16)}`);
    if (!device.permission) {
      const r = await this.calls.call<{ granted?: unknown }>((id) => this.bridge.permission(id, device.name), NO_TIMEOUT);
      if (r.granted !== true) throw Object.assign(new Error(PERMISSION_DENIED), { code: 'denied' });
    }
    let handle: number;
    try {
      const plan = driver.plan;
      const r = await this.calls.call<{ handle: number }>((id) => this.bridge.open(id, device.name, plan.interfaces.join(','), plan.inEndpoint, plan.outEndpoint, driver.header), IO_TIMEOUT_MS);
      handle = r.handle;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code === 'not-found') throw new SerialPortError('not-found', (e as Error).message);
      if (code === 'denied') throw Object.assign(new Error(PERMISSION_DENIED), { code: 'denied' });
      throw Object.assign(new Error(OPEN_FAILED), { detail: e instanceof AndroidBridgeError ? (e.detail ?? e.message) : String(e) });
    }
    const conn = new AndroidUsbConnection(this.bridge, this.calls, handle, driver, port, baudRate, () => this.connections.delete(handle));
    this.connections.set(handle, conn);
    try {
      await driver.open(conn.control, baudRate);
    } catch (e) {
      await conn.close();
      throw Object.assign(new Error(OPEN_FAILED), { detail: e instanceof Error ? e.message : String(e) });
    }
    return conn;
  }
}

/** One open device, read into a buffer like the browser's port (web/serial.ts). */
export class AndroidUsbConnection implements SerialConnection {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private waiters: (() => void)[] = [];
  private closed = false;
  private lost: SerialPortError | null = null;
  /** Data events of an older generation came before discardInput(). */
  private gen = 0;

  constructor(
    private readonly bridge: UsbBridge,
    private readonly calls: AndroidCalls,
    readonly handle: number,
    private readonly driver: ChipDriver,
    readonly port: SerialPortInfo,
    readonly baudRate: number,
    private readonly onClose: () => void,
  ) {}

  /** Sends one control transfer of the chip driver. */
  readonly control: Control = async (t) => {
    this.check();
    try {
      const r = await this.calls.call<{ data?: unknown }>(
        (id) => this.bridge.control(id, this.handle, t.requestType, t.request, t.value, t.index, t.data ? toBase64(t.data) : '', t.length ?? 0),
        IO_TIMEOUT_MS,
      );
      return typeof r.data === 'string' ? fromBase64(r.data) : new Uint8Array(0);
    } catch (e) {
      throw this.failure(e);
    }
  };

  get isLost(): boolean {
    return this.lost !== null;
  }

  /** Bytes from the Kotlin reader. */
  receive(gen: number, data: string[]): void {
    if (this.closed || gen < this.gen) return;
    for (const b64 of data) {
      let bytes: Uint8Array;
      try {
        bytes = this.driver.unframe(fromBase64(b64));
      } catch {
        continue;
      }
      if (!bytes.length) continue;
      this.chunks.push(bytes);
      this.buffered += bytes.length;
    }
    while (this.buffered > MAX_BUFFERED && this.chunks.length > 1) this.buffered -= this.chunks.shift()!.length;
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

  /** A failed transfer: the lost error once the device is gone. */
  private failure(e: unknown): unknown {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'gone' || code === 'not-found') this.markLost(e instanceof Error ? e.message : String(e));
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
    if (!data.byteLength) return;
    try {
      await this.calls.call((id) => this.bridge.write(id, this.handle, toBase64(data)), IO_TIMEOUT_MS + data.byteLength);
    } catch (e) {
      throw this.failure(e);
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
    try {
      this.gen = this.bridge.drop(this.handle);
    } catch {
      // Without the bridge's help the bytes on their way still arrive; the protocols cope with that.
    }
    this.chunks = [];
    this.buffered = 0;
  }

  async setSignals(signals: SerialSignals): Promise<void> {
    this.check();
    if (signals.dtr === undefined && signals.rts === undefined) return;
    // The chips set both lines in one go: a line not named keeps what it had.
    this.dtr = signals.dtr ?? this.dtr;
    this.rts = signals.rts ?? this.rts;
    await this.driver.setSignals(this.control, this.dtr, this.rts);
  }

  /** Both lines are active after open (ChipDriver.open). */
  private dtr = true;
  private rts = true;

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.wake();
    try {
      this.bridge.close(this.handle);
    } catch {
      // Gone already.
    }
    this.onClose();
  }
}
