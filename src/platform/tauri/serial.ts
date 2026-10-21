/**
 * SerialAccess on top of the serial commands. Reads never fail on timeout:
 * they resolve with whatever arrived (possibly nothing).
 */
import type { SerialAccess, SerialConnection, SerialPortInfo, SerialSignals } from '../types';
import { toBytes } from './binary';
import type { Bridge } from './bridge';
import { hintInfo, platformError, type HintInfo } from './errors';

export interface PortDto {
  id: string;
  label: string;
  path: string;
  usbVendorId: number | null;
  usbProductId: number | null;
  manufacturer: string | null;
  product: string | null;
  serialNumber: string | null;
}

interface OpenedDto {
  handle: number;
  path: string;
  baudRate: number;
}

/** Desktop extras beyond `SerialPortInfo`. */
export interface TauriSerialPortInfo extends SerialPortInfo {
  manufacturer?: string;
  product?: string;
  serialNumber?: string;
}

export function toPortInfo(dto: PortDto): TauriSerialPortInfo {
  const info: TauriSerialPortInfo = { id: dto.id, label: dto.label, path: dto.path };
  if (dto.usbVendorId != null) info.usbVendorId = dto.usbVendorId;
  if (dto.usbProductId != null) info.usbProductId = dto.usbProductId;
  if (dto.manufacturer) info.manufacturer = dto.manufacturer;
  if (dto.product) info.product = dto.product;
  if (dto.serialNumber) info.serialNumber = dto.serialNumber;
  return info;
}

/** Largest single read the backend accepts. */
const MAX_READ = 1 << 20;

export class TauriSerialConnection implements SerialConnection {
  private closed = false;

  constructor(
    private readonly bridge: Bridge,
    private readonly handle: number,
    readonly port: SerialPortInfo,
    readonly baudRate: number,
  ) {}

  private check(): void {
    if (this.closed) throw platformError('closed', 'serial', `handle ${this.handle} is closed`);
  }

  async write(data: Uint8Array): Promise<void> {
    this.check();
    if (data.byteLength === 0) return;
    await this.bridge.call('serial', 'serial_write', data, { headers: { 'x-handle': String(this.handle) } });
  }

  async read(timeoutMs: number, maxBytes = 4096): Promise<Uint8Array> {
    this.check();
    const max = Math.max(1, Math.min(MAX_READ, Math.floor(maxBytes)));
    const timeout = Math.max(0, Math.floor(timeoutMs));
    return toBytes(await this.bridge.call('serial', 'serial_read', { handle: this.handle, timeoutMs: timeout, maxBytes: max }));
  }

  async discardInput(): Promise<void> {
    this.check();
    await this.bridge.call('serial', 'serial_discard', { handle: this.handle });
  }

  async setSignals(signals: SerialSignals): Promise<void> {
    this.check();
    if (signals.dtr === undefined && signals.rts === undefined) return;
    await this.bridge.call('serial', 'serial_set_signals', { handle: this.handle, dtr: signals.dtr, rts: signals.rts });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Callers close in `finally` blocks; a failing close has nothing left to tell them.
    await this.bridge.call('serial', 'serial_close', { handle: this.handle }).catch(() => undefined);
  }
}

export class TauriSerial implements SerialAccess {
  readonly supported = true;

  constructor(private readonly bridge: Bridge) {}

  async list(): Promise<SerialPortInfo[]> {
    const ports = await this.bridge.call<PortDto[]>('serial', 'serial_list');
    return ports.map(toPortInfo);
  }

  async open(port: SerialPortInfo, baudRate: number): Promise<SerialConnection> {
    const path = port.path ?? port.id;
    const opened = await this.bridge.call<OpenedDto>('serial', 'serial_open', { path, baud: baudRate });
    return new TauriSerialConnection(this.bridge, opened.handle, port, opened.baudRate);
  }

  /**
   * Desktop extra: why a box may not show up or open (Linux: missing group,
   * brltty grabbing the CH340, ModemManager). Empty when nothing is wrong.
   */
  async diagnose(): Promise<HintInfo[]> {
    const hints = await this.bridge.call<{ id: string; detail?: string; command?: string }[]>('serial', 'serial_diagnose');
    return hints.map(hintInfo);
  }

  /** Desktop extra (Linux): installs the udev rules once; asks for the admin password. */
  async setupAccess(): Promise<void> {
    await this.bridge.call('serial', 'serial_setup_access');
  }
}
