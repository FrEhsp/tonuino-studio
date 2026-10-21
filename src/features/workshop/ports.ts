/**
 * Which board may sit behind which USB port. The USB ids of the serial chip
 * narrow the choice but cannot decide it: a CH340 sits on Classic Nanos, on
 * the AiO+ and on ESP32 boards alike. So the app suggests and preselects,
 * and the user confirms.
 */
import { BOARDS, boardsForUsb, type BoardId, type BoardInfo } from '../../core/firmware/variants';
import type { SerialAccess, SerialPortInfo } from '../../platform/types';
import type { HintInfo } from '../../platform/tauri/errors';

export interface BoardSuggestion {
  /** Boards that fit a plugged-in device, in the order of BOARDS. */
  boards: BoardId[];
  /** The ports that led to them. */
  ports: SerialPortInfo[];
}

/** Boards that fit the USB devices the app can see right now. */
export function suggestBoards(ports: readonly SerialPortInfo[]): BoardSuggestion {
  const ids = new Set<BoardId>();
  const used: SerialPortInfo[] = [];
  for (const port of ports) {
    const boards = boardsForUsb(port.usbVendorId, port.usbProductId);
    if (!boards.length) continue;
    used.push(port);
    for (const b of boards) ids.add(b.id);
  }
  return { boards: BOARDS.filter((b) => ids.has(b.id)).map((b) => b.id), ports: used };
}

/** True when the port's USB ids belong to this board (same rules as boardsForUsb). */
export function portFits(port: SerialPortInfo, board: BoardInfo): boolean {
  return boardsForUsb(port.usbVendorId, port.usbProductId).some((b) => b.id === board.id);
}

export interface RankedPort {
  port: SerialPortInfo;
  /** The USB ids belong to the chosen board (without a board: to any TonUINO board). */
  fits: boolean;
}

/**
 * Ports for a board, best first: fitting USB devices, then other USB
 * devices, then ports without USB ids (built-in COM ports, Bluetooth).
 * Keeps the platform's order within each group.
 */
export function rankPorts(ports: readonly SerialPortInfo[], board?: BoardInfo): RankedPort[] {
  const fits = (port: SerialPortInfo) => (board ? portFits(port, board) : boardsForUsb(port.usbVendorId, port.usbProductId).length > 0);
  const rank = (r: RankedPort) => (r.fits ? 0 : r.port.usbVendorId !== undefined ? 1 : 2);
  // Array sort is stable, so the platform's order survives within a group.
  return ports.map((port) => ({ port, fits: fits(port) })).sort((a, b) => rank(a) - rank(b));
}

/**
 * The port to select without asking: the one chosen before while it is
 * still there, else the only fitting one, else the only USB device.
 */
export function preselectPort(ranked: readonly RankedPort[], previousId?: string): SerialPortInfo | undefined {
  if (previousId) {
    const previous = ranked.find((r) => r.port.id === previousId);
    if (previous) return previous.port;
  }
  const fitting = ranked.filter((r) => r.fits);
  if (fitting.length === 1) return fitting[0].port;
  if (fitting.length > 1) return undefined;
  const usb = ranked.filter((r) => r.port.usbVendorId !== undefined);
  return usb.length === 1 ? usb[0].port : undefined;
}

/**
 * The port for "Noch einmal versuchen": the same one while it is listed.
 * After a pulled cable the box comes back under a new port (the browser
 * hands out a new one, the desktop may count up to ttyUSB1), so then the
 * only port with the same USB ids, else the only one that fits the board.
 * Undefined when the user has to choose.
 */
export function portForRetry(ports: readonly SerialPortInfo[], previous: SerialPortInfo, board?: BoardInfo): SerialPortInfo | undefined {
  const same = ports.find((p) => p.id === previous.id);
  if (same) return same;
  if (previous.usbVendorId !== undefined) {
    const twins = ports.filter((p) => p.usbVendorId === previous.usbVendorId && p.usbProductId === previous.usbProductId);
    if (twins.length === 1) return twins[0];
    if (twins.length > 1) return undefined;
  }
  const fitting = rankPorts(ports, board).filter((r) => r.fits);
  return fitting.length === 1 ? fitting[0].port : undefined;
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

/** Small print under a port's name, e.g. "/dev/ttyUSB0 · USB 1a86:7523". */
export function portDetail(port: SerialPortInfo): string {
  const parts: string[] = [];
  if (port.path) parts.push(port.path);
  if (port.usbVendorId !== undefined) {
    parts.push(`USB ${hex4(port.usbVendorId)}:${port.usbProductId === undefined ? '????' : hex4(port.usbProductId)}`);
  }
  return parts.join(' · ');
}

/** Extras of the desktop app's SerialAccess (see platform/tauri/serial.ts). */
export interface DesktopSerial extends SerialAccess {
  /** Why a box may not show up or open (Linux); empty when nothing is wrong. */
  diagnose(): Promise<HintInfo[]>;
  /** Linux: installs the udev rules once; asks for the admin password. */
  setupAccess(): Promise<void>;
}

/** The desktop extras, when this SerialAccess has them. */
export function desktopSerial(serial: SerialAccess): DesktopSerial | null {
  const s = serial as Partial<DesktopSerial>;
  return typeof s.diagnose === 'function' && typeof s.setupAccess === 'function' ? (serial as DesktopSerial) : null;
}

/** Web Serial lets the page see a port only after the user picked it once in the browser's chooser. */
export function needsChooser(serial: SerialAccess): boolean {
  return typeof serial.request === 'function';
}

/** From this long on, an empty answer of the chooser may mean the browser blocked the site. */
export const NO_CHOOSER_HINT_MS = 3000;

/**
 * Firefox, after "Nie erlauben": no chooser shows, and after a few seconds
 * the request comes back empty. Whether to say how to lift the block.
 */
export function noChooserHint(elapsedMs: number, mayAskForAddon: boolean | undefined): boolean {
  return !!mayAskForAddon && elapsedMs >= NO_CHOOSER_HINT_MS;
}
