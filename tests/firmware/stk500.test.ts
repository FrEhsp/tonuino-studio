import { describe, expect, it } from 'vitest';
import {
  FlashError,
  STK_PARAM,
  checkSignature,
  flashImage,
  getParameter,
  readBytes,
  readSignature,
  resetBoard,
  sync,
  type FlashErrorCode,
} from '../../src/core/firmware/stk500';
import type { SerialConnection, SerialSignals } from '../../src/platform/types';
import { FAST_TIMING, SIM_PORT, SimConnection, aioPlusBoard, firmwareBytes, nanoBoard, type SimulatedBoard } from './simulator';

const opts = { timing: FAST_TIMING };

/** Opens a simulated port and resets the board into its bootloader. */
async function connect(board: SimulatedBoard, baud = board.baudRate): Promise<SimConnection> {
  const conn = new SimConnection(board, SIM_PORT, baud);
  await resetBoard(conn, opts);
  return conn;
}

async function connected(board: SimulatedBoard): Promise<SimConnection> {
  const conn = await connect(board);
  await sync(conn, opts);
  return conn;
}

async function flashError(promise: Promise<unknown>, code: FlashErrorCode): Promise<FlashError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(FlashError);
    expect((e as FlashError).code).toBe(code);
    return e as FlashError;
  }
  throw new Error(`expected FlashError "${code}"`);
}

/** Plays back prepared chunks; records signals and discards. */
class ScriptedConnection implements SerialConnection {
  readonly port = SIM_PORT;
  readonly baudRate = 115200;
  readonly signals: SerialSignals[] = [];
  discards = 0;
  private readonly chunks: Uint8Array[];

  constructor(chunks: number[][]) {
    this.chunks = chunks.map((c) => Uint8Array.from(c));
  }

  async write(): Promise<void> {}

  async read(_timeoutMs: number, maxBytes = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
    const chunk = this.chunks.shift();
    if (!chunk) return new Uint8Array(0);
    if (chunk.length > maxBytes) this.chunks.unshift(chunk.slice(maxBytes));
    return chunk.slice(0, maxBytes);
  }

  async discardInput(): Promise<void> {
    this.discards++;
  }

  async setSignals(signals: SerialSignals): Promise<void> {
    this.signals.push(signals);
  }

  async close(): Promise<void> {}
}

describe('serial helpers', () => {
  it('collects partial and empty reads until enough bytes arrived', async () => {
    const conn = new ScriptedConnection([[0x14], [], [0x01, 0x02], [], [0x03, 0x10, 0x99]]);
    expect([...(await readBytes(conn, 5, 500))]).toEqual([0x14, 1, 2, 3, 0x10]);
    expect([...(await readBytes(conn, 1, 50))]).toEqual([0x99]);
  });

  it('returns what arrived when the time is up', async () => {
    const conn = new ScriptedConnection([[1]]);
    const started = Date.now();
    expect([...(await readBytes(conn, 3, 30))]).toEqual([1]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('resets the board like avrdude: DTR and RTS off, then on, then drops old input', async () => {
    const conn = new ScriptedConnection([]);
    await resetBoard(conn, opts);
    expect(conn.signals).toEqual([
      { dtr: false, rts: false },
      { dtr: true, rts: true },
    ]);
    expect(conn.discards).toBe(1);
  });
});

describe('STK500 with a simulated bootloader', () => {
  it('syncs and reads signature and bootloader version', async () => {
    const board = nanoBoard('optiboot');
    const conn = await connected(board);
    expect(board.resets).toBe(1);
    expect(board.commands.filter((c) => c === 'GET_SYNC')).toHaveLength(3);
    expect(await readSignature(conn, opts)).toEqual([0x1e, 0x95, 0x0f]);
    expect(await getParameter(conn, STK_PARAM.SW_MAJOR, opts)).toBe(8);
    expect(await getParameter(conn, STK_PARAM.SW_MINOR, opts)).toBe(0);
  });

  it('writes and checks a Nano image with word addresses', async () => {
    const board = nanoBoard('optiboot');
    const conn = await connected(board);
    const image = firmwareBytes(1000);
    const progress: [string, number, number][] = [];
    const result = await flashImage(conn, image, { ...opts, pageSize: 128, onProgress: (p, d, t) => progress.push([p, d, t]) });

    expect(result).toEqual({ firstAddress: 0, bytesWritten: 1024, pages: 8, verified: true });
    expect(board.read(0, 1000)).toEqual(image);
    expect(board.read(1000, 24)).toEqual(new Uint8Array(24).fill(0xff));
    expect(board.violations).toEqual([]);
    expect(board.commands.filter((c) => c === 'PROG_PAGE 128')).toHaveLength(8);
    // Page 7 starts at byte 0x380; the bootloader got word address 0x1C0.
    expect(board.commands).toContain('LOAD_ADDRESS 0x0380');
    expect(board.commands.at(-1)).toBe('LEAVE_PROGMODE');
    expect(board.mode).toBe('app');

    expect(progress[0]).toEqual(['write', 0, 1024]);
    expect(progress).toContainEqual(['write', 1024, 1024]);
    expect(progress.at(-1)).toEqual(['verify', 1024, 1024]);
  });

  it('copes with answers that arrive one byte at a time and late', async () => {
    const board = nanoBoard('optiboot', { chunkSize: 1, replyDelayMs: 2 });
    const conn = await connected(board);
    const image = firmwareBytes(300, 7);
    await flashImage(conn, image, { ...opts, pageSize: 128 });
    expect(board.read(0, 300)).toEqual(image);
  });

  it('writes an AiO+ image behind the bootloader with byte addresses', async () => {
    const board = aioPlusBoard();
    const conn = await connected(board);
    expect(await readSignature(conn, opts)).toEqual([0x1e, 0x96, 0x51]);
    const data = firmwareBytes(700, 3);
    const result = await flashImage(conn, { data, startAddress: 0x200 }, { ...opts, pageSize: 128, byteAddressing: true });

    expect(result.firstAddress).toBe(0x200);
    expect(board.read(0x200, 700)).toEqual(data);
    expect(board.commands).toContain('LOAD_ADDRESS 0x0200');
    expect(board.commands).not.toContain('LOAD_ADDRESS 0x0000');
    expect(board.violations).toEqual([]);
    expect([...board.read(0, 4)]).toEqual([0x0c, 0x94, 0x0c, 0x94]);
  });

  it('fails the check when the addressing does not fit the bootloader', async () => {
    const board = aioPlusBoard();
    const conn = await connected(board);
    const data = firmwareBytes(256, 5);
    // Word addresses on optiboot_x land at half the address, inside the bootloader.
    await flashError(flashImage(conn, { data, startAddress: 0x200 }, { ...opts, pageSize: 128, byteAddressing: false }), 'verify');
    expect(board.violations[0]).toBe('page write into bootloader at 0x100');
  });

  it('gets no answer at the wrong baud rate', async () => {
    const board = nanoBoard('optiboot');
    const conn = await connect(board, 57600);
    const error = await flashError(sync(conn, opts), 'no-sync');
    expect(error.detail).toContain('57600');
    expect(board.mode).toBe('app');
  });

  it('finds the answer behind noise on the line', async () => {
    const board = nanoBoard('optiboot', { garbage: [0x00, 0x14, 0x00, 0xff, 0x14] });
    const conn = await connected(board);
    expect(await readSignature(conn, opts)).toEqual([0x1e, 0x95, 0x0f]);
  });

  it('keeps asking while the bootloader is still starting', async () => {
    const board = nanoBoard('old', { listenAfterMs: 20 });
    const conn = await connected(board);
    expect(await getParameter(conn, STK_PARAM.SW_MINOR, opts)).toBe(16);
  });

  it('reports a different chip', async () => {
    const board = aioPlusBoard();
    const conn = await connected(board);
    const error = await flashError(checkSignature(conn, [0x1e, 0x95, 0x0f], opts), 'signature');
    expect(error.data.signature).toEqual([0x1e, 0x96, 0x51]);
  });

  it('finds a flash cell that does not keep its value', async () => {
    const image = firmwareBytes(600, 9);
    const board = nanoBoard('optiboot', { stuck: { 0x123: image[0x123] ^ 0xff } });
    const conn = await connected(board);
    const error = await flashError(flashImage(conn, image, { ...opts, pageSize: 128 }), 'verify');
    expect(error.data).toEqual({ address: 0x123, expected: image[0x123], actual: image[0x123] ^ 0xff });
  });

  it('times out when the board stops answering in the middle', async () => {
    const board = nanoBoard('optiboot', { dieAfterPages: 3 });
    const conn = await connected(board);
    const error = await flashError(flashImage(conn, firmwareBytes(1000), { ...opts, pageSize: 128 }), 'timeout');
    expect(error.detail).toBe('no answer to PROG_PAGE');
    expect(board.pagesWritten).toBe(3);
  });

  it('stops when aborted', async () => {
    const board = nanoBoard('optiboot');
    const conn = await connected(board);
    const abort = new AbortController();
    const onProgress = (_phase: string, done: number) => {
      if (done >= 256) abort.abort();
    };
    await flashError(flashImage(conn, firmwareBytes(1000), { ...opts, pageSize: 128, signal: abort.signal, onProgress }), 'aborted');
    expect(board.pagesWritten).toBe(2);
  });

  it('refuses an image beyond the limit before writing anything', async () => {
    const board = nanoBoard('optiboot');
    const conn = await connected(board);
    await flashError(flashImage(conn, firmwareBytes(600), { ...opts, pageSize: 128, maxAddress: 512 }), 'too-large');
    expect(board.commands).not.toContain('SET_DEVICE');
    expect(board.pagesWritten).toBe(0);
  });

  it('turns a pulled cable into a port error', async () => {
    const board = nanoBoard('optiboot', { unplugAfterWrites: 8 });
    const conn = await connected(board);
    const error = await flashError(flashImage(conn, firmwareBytes(1000), { ...opts, pageSize: 128 }), 'port');
    expect(error.detail).toBe('write failed: The device has been lost.');
  });
});
