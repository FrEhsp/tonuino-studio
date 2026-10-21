/**
 * STK500 version 1 client: the protocol of the Arduino bootloaders
 * (ATmegaBOOT on old Nanos, Optiboot, the LGT8F328P bootloader of the AiO
 * and optiboot_x of the AiO+). Follows avrdude "-c arduino" and the official
 * TonUINO web uploader (arduino-web-uploader with js-stk500v1).
 *
 * Every command ends with CRC_EOP (0x20). The bootloader answers INSYNC
 * (0x14), optional data and OK (0x10).
 */
import type { SerialConnection } from '../../platform/types';

export const STK = {
  OK: 0x10,
  FAILED: 0x11,
  INSYNC: 0x14,
  NOSYNC: 0x15,
  CRC_EOP: 0x20,
  GET_SYNC: 0x30,
  GET_PARAMETER: 0x41,
  SET_DEVICE: 0x42,
  ENTER_PROGMODE: 0x50,
  LEAVE_PROGMODE: 0x51,
  LOAD_ADDRESS: 0x55,
  PROG_PAGE: 0x64,
  READ_PAGE: 0x74,
  READ_SIGN: 0x75,
} as const;

/** Parameters for GET_PARAMETER. */
export const STK_PARAM = { HW_VER: 0x80, SW_MAJOR: 0x81, SW_MINOR: 0x82 } as const;

/** Memory type of PROG_PAGE and READ_PAGE: 'F' = flash. */
const MEMTYPE_FLASH = 0x46;
/** Longest single wait inside a read loop, so an abort is noticed quickly. */
const READ_SLICE_MS = 100;

export type FlashErrorCode =
  | 'no-sync'
  | 'signature'
  | 'timeout'
  | 'verify'
  | 'protocol'
  | 'too-large'
  | 'aborted'
  | 'port';

export interface FlashErrorData {
  /** What the device reported for READ_SIGN ('signature'). */
  signature?: number[];
  /** Address of the first differing byte ('verify') or of the page in trouble. */
  address?: number;
  expected?: number;
  actual?: number;
}

/**
 * A failed bootloader conversation. `detail` is technical English for logs
 * and support; for 'port' the platform's own error is kept as `cause`.
 */
export class FlashError extends Error {
  readonly code: FlashErrorCode;
  readonly detail: string;
  readonly data: FlashErrorData;

  constructor(code: FlashErrorCode, detail: string, data: FlashErrorData = {}, options?: { cause?: unknown }) {
    super(`${code}: ${detail}`, options);
    this.name = 'FlashError';
    this.code = code;
    this.detail = detail;
    this.data = data;
  }
}

export interface Stk500Timing {
  /** DTR/RTS released before the reset edge (avrdude: 250 ms). */
  resetLowMs: number;
  /** Wait after the reset edge before talking (avrdude: 50 ms). */
  resetHighMs: number;
  /** Wait for the answer to one GET_SYNC. */
  syncTimeoutMs: number;
  /** Unanswered GET_SYNC attempts before giving up. */
  syncAttempts: number;
  /** Answered GET_SYNC in a row before we trust the line (the web uploader sends three). */
  syncConfirmations: number;
  /** Quiet time that ends draining stale input after the sync. */
  drainMs: number;
  /** Wait for the answer to any other command (a page write takes about 5 ms). */
  commandTimeoutMs: number;
}

export const DEFAULT_TIMING: Readonly<Stk500Timing> = {
  resetLowMs: 250,
  resetHighMs: 50,
  syncTimeoutMs: 300,
  syncAttempts: 6,
  syncConfirmations: 3,
  drainMs: 30,
  commandTimeoutMs: 1000,
};

export interface Stk500Options {
  timing?: Partial<Stk500Timing>;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------- low level */

/**
 * Reads until `count` bytes arrived or `timeoutMs` passed. `conn.read` may
 * deliver partial chunks or nothing at all, so this keeps asking until the
 * deadline. Returns what arrived, which can be fewer than `count` bytes.
 */
export async function readBytes(
  conn: SerialConnection,
  count: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const out = new Uint8Array(count);
  const deadline = Date.now() + timeoutMs;
  let got = 0;
  while (got < count) {
    throwIfAborted(signal);
    const left = deadline - Date.now();
    if (left <= 0) break;
    const started = Date.now();
    const chunk = await io('read', () => conn.read(Math.min(left, READ_SLICE_MS), count - got));
    if (chunk.length === 0) {
      // Guard against implementations that return at once instead of waiting.
      if (Date.now() - started < 1) await sleep(2, signal);
      continue;
    }
    const n = Math.min(chunk.length, count - got);
    out.set(chunk.subarray(0, n), got);
    got += n;
  }
  return got === count ? out : out.slice(0, got);
}

/**
 * Resets the board into its bootloader like avrdude's "arduino" programmer:
 * DTR and RTS low for 250 ms, then high (the falling edge on the
 * USB-serial chip's DTR pin pulls RESET low through a capacitor), wait 50 ms,
 * drop whatever the running sketch sent.
 */
export async function resetBoard(conn: SerialConnection, opts: Stk500Options = {}): Promise<void> {
  const t = timingOf(opts);
  await io('set signals', () => conn.setSignals({ dtr: false, rts: false }));
  await sleep(t.resetLowMs, opts.signal);
  await io('set signals', () => conn.setSignals({ dtr: true, rts: true }));
  await sleep(t.resetHighMs, opts.signal);
  await io('discard input', () => conn.discardInput());
}

/**
 * Gets in sync with the bootloader. Sends GET_SYNC until it was answered
 * `syncConfirmations` times in a row, ignoring garbage on the line (a
 * running sketch, noise right after the reset). Throws 'no-sync' when the
 * bootloader stays silent, which mostly means the wrong baud rate, no
 * bootloader or a board that lost power.
 */
export async function sync(conn: SerialConnection, opts: Stk500Options = {}): Promise<void> {
  const t = timingOf(opts);
  const need = Math.max(1, t.syncConfirmations);
  let inRow = 0;
  let failed = 0;
  while (inRow < need) {
    throwIfAborted(opts.signal);
    await io('discard input', () => conn.discardInput());
    await io('write', () => conn.write(Uint8Array.of(STK.GET_SYNC, STK.CRC_EOP)));
    if (await waitForSyncReply(conn, t.syncTimeoutMs, opts.signal)) {
      inRow++;
      continue;
    }
    inRow = 0;
    failed++;
    if (failed >= t.syncAttempts) {
      throw new FlashError('no-sync', `no answer to GET_SYNC at ${conn.baudRate} baud (${failed} attempts)`);
    }
  }
  // Late answers to earlier attempts must not be taken for the next reply.
  await drain(conn, t.drainMs, opts.signal);
}

async function waitForSyncReply(conn: SerialConnection, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  for (;;) {
    throwIfAborted(signal);
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const chunk = await io('read', () => conn.read(Math.min(left, READ_SLICE_MS), 64));
    for (const b of chunk) {
      if (previous === STK.INSYNC && b === STK.OK) return true;
      previous = b;
    }
  }
}

async function drain(conn: SerialConnection, quietMs: number, signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < 20; i++) {
    throwIfAborted(signal);
    const chunk = await io('read', () => conn.read(quietMs, 256));
    if (chunk.length === 0) break;
  }
  await io('discard input', () => conn.discardInput());
}

/** Sends one command (CRC_EOP appended) and returns the data between INSYNC and OK. */
async function command(
  conn: SerialConnection,
  bytes: ArrayLike<number>,
  replyLength: number,
  what: string,
  opts: Stk500Options,
): Promise<Uint8Array> {
  const t = timingOf(opts);
  throwIfAborted(opts.signal);
  const frame = new Uint8Array(bytes.length + 1);
  frame.set(bytes);
  frame[bytes.length] = STK.CRC_EOP;
  await io('write', () => conn.write(frame));

  const deadline = Date.now() + t.commandTimeoutMs;
  const head = await readBytes(conn, 1, t.commandTimeoutMs, opts.signal);
  if (head.length === 0) throw new FlashError('timeout', `no answer to ${what}`);
  if (head[0] === STK.NOSYNC) throw new FlashError('protocol', `${what}: bootloader answered NOSYNC`);
  if (head[0] !== STK.INSYNC) throw new FlashError('protocol', `${what}: expected INSYNC (0x14), got ${hex(head[0])}`);
  const rest = await readBytes(conn, replyLength + 1, Math.max(0, deadline - Date.now()), opts.signal);
  if (rest.length < replyLength + 1) {
    throw new FlashError('timeout', `${what}: incomplete answer (${rest.length + 1} of ${replyLength + 2} bytes)`);
  }
  if (rest[replyLength] !== STK.OK) {
    throw new FlashError('protocol', `${what}: expected OK (0x10), got ${hex(rest[replyLength])}`);
  }
  return rest.subarray(0, replyLength);
}

/* -------------------------------------------------------------- commands */

export async function readSignature(conn: SerialConnection, opts: Stk500Options = {}): Promise<[number, number, number]> {
  const d = await command(conn, [STK.READ_SIGN], 3, 'READ_SIGN', opts);
  return [d[0], d[1], d[2]];
}

/** Reads the signature and throws 'signature' when it is not the expected one. */
export async function checkSignature(
  conn: SerialConnection,
  expected: ArrayLike<number>,
  opts: Stk500Options = {},
): Promise<[number, number, number]> {
  const sig = await readSignature(conn, opts);
  if (sig.some((b, i) => b !== expected[i])) {
    throw new FlashError('signature', `device signature ${formatBytes(sig)}, expected ${formatBytes(Array.from(expected))}`, {
      signature: sig,
    });
  }
  return sig;
}

export async function getParameter(conn: SerialConnection, param: number, opts: Stk500Options = {}): Promise<number> {
  const d = await command(conn, [STK.GET_PARAMETER, param], 1, `GET_PARAMETER ${hex(param)}`, opts);
  return d[0];
}

/** SET_DEVICE with 20 zero parameter bytes, as the official uploader sends it. Bootloaders ignore the values. */
export async function setDevice(conn: SerialConnection, opts: Stk500Options = {}): Promise<void> {
  await command(conn, [STK.SET_DEVICE, ...new Array<number>(20).fill(0)], 0, 'SET_DEVICE', opts);
}

export async function enterProgMode(conn: SerialConnection, opts: Stk500Options = {}): Promise<void> {
  await command(conn, [STK.ENTER_PROGMODE], 0, 'ENTER_PROGMODE', opts);
}

/** Leaves the bootloader; it then starts the new firmware. */
export async function leaveProgMode(conn: SerialConnection, opts: Stk500Options = {}): Promise<void> {
  await command(conn, [STK.LEAVE_PROGMODE], 0, 'LEAVE_PROGMODE', opts);
}

/**
 * LOAD_ADDRESS, little endian. Classic AVR bootloaders take a word address
 * (byte address / 2); optiboot_x on the ATmega4809 (AiO+) takes the byte
 * address itself.
 */
export async function loadAddress(
  conn: SerialConnection,
  byteAddress: number,
  byteAddressing: boolean,
  opts: Stk500Options = {},
): Promise<void> {
  if (!byteAddressing && byteAddress % 2 !== 0) throw new RangeError(`odd byte address ${hex(byteAddress)} with word addressing`);
  const value = byteAddressing ? byteAddress : byteAddress / 2;
  if (value > 0xffff) throw new FlashError('too-large', `address ${hex(byteAddress)} is beyond 16-bit addressing`, { address: byteAddress });
  await command(conn, [STK.LOAD_ADDRESS, value & 0xff, value >> 8], 0, `LOAD_ADDRESS ${hex(byteAddress)}`, opts);
}

/** Writes one page of flash at the loaded address. */
export async function programPage(conn: SerialConnection, data: Uint8Array, opts: Stk500Options = {}): Promise<void> {
  const frame = new Uint8Array(4 + data.length);
  frame.set([STK.PROG_PAGE, data.length >> 8, data.length & 0xff, MEMTYPE_FLASH]);
  frame.set(data, 4);
  await command(conn, frame, 0, 'PROG_PAGE', opts);
}

/** Reads `length` bytes of flash from the loaded address. */
export async function readPage(conn: SerialConnection, length: number, opts: Stk500Options = {}): Promise<Uint8Array> {
  return command(conn, [STK.READ_PAGE, length >> 8, length & 0xff, MEMTYPE_FLASH], length, 'READ_PAGE', opts);
}

/**
 * Reads `length` bytes of flash from `start`, page by page (LOAD_ADDRESS +
 * READ_PAGE, as avrdude reads), e.g. to keep the firmware that is on the
 * box before it is overwritten. The bootloader must be in sync.
 */
export async function readFlash(
  conn: SerialConnection,
  start: number,
  length: number,
  opts: Stk500Options & { pageSize: number; byteAddressing?: boolean; onProgress?: (done: number, total: number) => void },
): Promise<Uint8Array> {
  const { pageSize, byteAddressing = false, onProgress } = opts;
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize % 2 !== 0) throw new RangeError(`bad page size ${pageSize}`);
  const out = new Uint8Array(length);
  await enterProgMode(conn, opts);
  onProgress?.(0, length);
  for (let done = 0; done < length; done += pageSize) {
    throwIfAborted(opts.signal);
    const n = Math.min(pageSize, length - done);
    await loadAddress(conn, start + done, byteAddressing, opts);
    out.set(await readPage(conn, n, opts), done);
    onProgress?.(done + n, length);
  }
  return out;
}

/* ----------------------------------------------------------------- flash */

/** A plain array starts at address 0; a parsed HEX image brings its own start address. */
export type FlashImageInput = Uint8Array | { data: Uint8Array; startAddress: number };

export type FlashPhase = 'write' | 'verify';

export interface FlashImageOptions extends Stk500Options {
  pageSize: number;
  /** Byte instead of word addresses for LOAD_ADDRESS (ATmega4809 / AiO+). */
  byteAddressing?: boolean;
  /** Read every page back and compare (default true). */
  verify?: boolean;
  /** Exclusive upper address limit; a larger image fails with 'too-large' before anything is written. */
  maxAddress?: number;
  /** Progress in bytes per phase. */
  onProgress?: (phase: FlashPhase, done: number, total: number) => void;
}

export interface FlashImageResult {
  /** Page-aligned address of the first written page. */
  firstAddress: number;
  /** Bytes written, whole pages. */
  bytesWritten: number;
  pages: number;
  verified: boolean;
}

/**
 * Programs an image into flash with a bootloader that is already in sync:
 * SET_DEVICE, ENTER_PROGMODE, every page (LOAD_ADDRESS + PROG_PAGE, padded
 * with 0xFF to whole pages like avrdude does), optional read-back check,
 * LEAVE_PROGMODE. Only pages that hold image bytes are touched.
 */
export async function flashImage(
  conn: SerialConnection,
  image: FlashImageInput,
  opts: FlashImageOptions,
): Promise<FlashImageResult> {
  const { pageSize, byteAddressing = false, verify = true, onProgress } = opts;
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize % 2 !== 0) throw new RangeError(`bad page size ${pageSize}`);
  const pages = paginate(image, pageSize);
  if (pages.length === 0) throw new RangeError('empty image');
  const firstAddress = pages[0].address;
  const end = pages[pages.length - 1].address + pageSize;
  const imageEnd = imageStart(image) + imageData(image).length;
  if (opts.maxAddress !== undefined && imageEnd > opts.maxAddress) {
    throw new FlashError('too-large', `image ends at ${hex(imageEnd)}, limit is ${hex(opts.maxAddress)}`, { address: imageEnd });
  }
  const total = end - firstAddress;

  await setDevice(conn, opts);
  await enterProgMode(conn, opts);

  let done = 0;
  onProgress?.('write', 0, total);
  for (const page of pages) {
    throwIfAborted(opts.signal);
    await loadAddress(conn, page.address, byteAddressing, opts);
    await programPage(conn, page.bytes, opts);
    done += pageSize;
    onProgress?.('write', done, total);
  }

  if (verify) {
    done = 0;
    onProgress?.('verify', 0, total);
    for (const page of pages) {
      throwIfAborted(opts.signal);
      await loadAddress(conn, page.address, byteAddressing, opts);
      const back = await readPage(conn, pageSize, opts);
      const i = page.bytes.findIndex((b, k) => back[k] !== b);
      if (i >= 0) {
        const address = page.address + i;
        throw new FlashError('verify', `flash differs at ${hex(address)}: wrote ${hex(page.bytes[i])}, read ${hex(back[i])}`, {
          address,
          expected: page.bytes[i],
          actual: back[i],
        });
      }
      done += pageSize;
      onProgress?.('verify', done, total);
    }
  }

  await leaveProgMode(conn, opts);
  return { firstAddress, bytesWritten: total, pages: pages.length, verified: verify };
}

interface Page {
  address: number;
  bytes: Uint8Array;
}

function paginate(image: FlashImageInput, pageSize: number): Page[] {
  const data = imageData(image);
  const start = imageStart(image);
  const end = start + data.length;
  const pages: Page[] = [];
  for (let address = Math.floor(start / pageSize) * pageSize; address < end; address += pageSize) {
    const bytes = new Uint8Array(pageSize).fill(0xff);
    const from = Math.max(address, start);
    const to = Math.min(address + pageSize, end);
    bytes.set(data.subarray(from - start, to - start), from - address);
    pages.push({ address, bytes });
  }
  return pages;
}

function imageData(image: FlashImageInput): Uint8Array {
  return image instanceof Uint8Array ? image : image.data;
}

function imageStart(image: FlashImageInput): number {
  return image instanceof Uint8Array ? 0 : image.startAddress;
}

/* --------------------------------------------------------------- helpers */

function timingOf(opts: Stk500Options): Stk500Timing {
  return { ...DEFAULT_TIMING, ...opts.timing };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FlashError('aborted', 'cancelled');
}

/** Turns failures of the port itself (unplugged, closed) into FlashError 'port'. */
async function io<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FlashError) throw e;
    throw new FlashError('port', `${what} failed: ${e instanceof Error ? e.message : String(e)}`, {}, { cause: e });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new FlashError('aborted', 'cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function hex(n: number): string {
  return '0x' + n.toString(16).padStart(2, '0');
}

export function formatBytes(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
