import { describe, expect, it } from 'vitest';
import { describePortError, flashFirmware, type FlashResult } from '../../src/core/firmware/flash';
import { SerialPortError, TONUINO_USB_FILTERS, webSerial } from '../../src/platform/web/serial';
import type { SerialConnection } from '../../src/platform/types';
import { FAST_TIMING, firmwareBytes, nanoBoard, type SimulatedBoard } from '../firmware/simulator';

function lostError(): DOMException {
  return new DOMException('The device has been lost.', 'NetworkError');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * A Web Serial port in memory, close to Chrome where the connection depends
 * on it: a pulled cable errors the stream with NetworkError and leaves
 * `readable` null; a framing error errors only the current stream; close()
 * refuses while a stream is locked.
 */
class FakePort extends EventTarget implements SerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  isOpen = false;
  gone = false;
  /** open() fails like Chrome's "Failed to open serial port" (in use, driver, rights) while the device is there. */
  refuseOpen = false;
  baudRate = 0;
  closeCalls = 0;
  readonly openedBauds: number[] = [];
  readonly written: number[] = [];
  readonly signals: SerialOutputSignals[] = [];
  private source: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(private readonly info: SerialPortInfoWeb = { usbVendorId: 0x1a86, usbProductId: 0x7523 }) {
    super();
  }

  getInfo(): SerialPortInfoWeb {
    return this.info;
  }

  async open(options: SerialOptions): Promise<void> {
    if (this.isOpen) throw new DOMException('The port is already open.', 'InvalidStateError');
    if (this.gone || this.refuseOpen) throw new DOMException('Failed to open serial port.', 'NetworkError');
    this.isOpen = true;
    this.baudRate = options.baudRate;
    this.openedBauds.push(options.baudRate);
    this.freshReadable();
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.gone) throw lostError();
        this.written.push(...chunk);
        this.received(chunk);
      },
    });
  }

  /** Bytes the app sent; BoardPort passes them on to the simulated bootloader. */
  protected received(_chunk: Uint8Array): void {}

  private freshReadable(): void {
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.source = c;
      },
      cancel: () => {
        this.source = null;
      },
    });
  }

  /** Bytes from the box arrive. */
  send(data: ArrayLike<number> | string): void {
    this.source?.enqueue(typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data));
  }

  /** A framing error (wrong speed, noise) ends the current stream; the port offers a fresh one. */
  framingError(): void {
    const old = this.source;
    this.freshReadable();
    old?.error(new DOMException('A framing error has been detected.', 'FramingError'));
  }

  /** The cable is pulled. `event` says whether the port itself fires "disconnect". */
  unplug(event: 'port' | 'none' = 'port'): void {
    if (this.gone) return;
    this.gone = true;
    const old = this.source;
    this.source = null;
    this.readable = null;
    old?.error(lostError());
    if (event === 'port') this.dispatchEvent(new Event('disconnect'));
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    if (!this.isOpen) throw new DOMException('The port is closed.', 'InvalidStateError');
    if (this.gone) throw lostError();
    this.signals.push(signals);
  }

  async close(): Promise<void> {
    this.closeCalls++;
    if (!this.isOpen) throw new DOMException('The port is already closed.', 'InvalidStateError');
    if (this.readable?.locked || this.writable?.locked) throw new TypeError('Cannot cancel a locked stream');
    await this.readable?.cancel();
    await this.writable?.abort();
    this.readable = null;
    this.writable = null;
    this.isOpen = false;
  }
}

/** navigator.serial in memory. */
class FakeSerial extends EventTarget implements Serial {
  readonly granted: FakePort[] = [];
  /** What the browser's chooser returns next; undefined: the user cancels. */
  offer: FakePort | undefined;
  lastFilters: unknown;

  /** Like Chrome: only ports whose device is connected. */
  async getPorts(): Promise<SerialPort[]> {
    return this.granted.filter((p) => !p.gone);
  }

  async requestPort(options?: SerialPortRequestOptions): Promise<SerialPort> {
    this.lastFilters = options?.filters;
    const port = this.offer;
    if (!port) throw new DOMException('No port selected by the user.', 'NotFoundError');
    if (!this.granted.includes(port)) this.granted.push(port);
    return port;
  }

  /** Older Chrome versions fire "disconnect" only here, with the port as target. */
  fireDisconnect(port: SerialPort): void {
    const event = new Event('disconnect');
    Object.defineProperty(event, 'target', { value: port });
    this.dispatchEvent(event);
  }
}

async function connect(port = new FakePort(), baudRate = 115200) {
  const api = new FakeSerial();
  api.offer = port;
  const access = webSerial(api);
  const info = await access.request();
  if (!info) throw new Error('no port');
  const conn = await access.open(info, baudRate);
  return { api, access, info, port, conn };
}

async function rejection(p: Promise<unknown>): Promise<SerialPortError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!(e instanceof SerialPortError)) throw new Error(`expected a SerialPortError, got ${String(e)}`);
  return e;
}

describe('web serial connection', () => {
  it('reads what arrived in pieces and waits until the timeout otherwise', async () => {
    const { api, info, port, conn } = await connect();
    expect(api.lastFilters).toEqual(TONUINO_USB_FILTERS);
    expect(info).toMatchObject({ label: 'USB-Seriell (CH340)', usbVendorId: 0x1a86, usbProductId: 0x7523 });
    expect(port.baudRate).toBe(115200);

    port.send('Hallo');
    expect(text(await conn.read(100, 3))).toBe('Hal');
    expect(text(await conn.read(100))).toBe('lo');

    const started = Date.now();
    expect(await conn.read(30)).toHaveLength(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);

    const waiting = conn.read(5000);
    setTimeout(() => port.send([1, 2]), 10);
    expect(Array.from(await waiting)).toEqual([1, 2]);

    await conn.write(Uint8Array.of(0x30, 0x20));
    expect(port.written).toEqual([0x30, 0x20]);
    await conn.setSignals({ dtr: false, rts: true });
    expect(port.signals).toEqual([{ dataTerminalReady: false, requestToSend: true }]);

    port.send([9, 9]);
    await flush();
    await conn.discardInput();
    expect(await conn.read(0)).toHaveLength(0);
    await conn.close();
  });

  it('hands out what still arrived, then rejects instead of timing out once the cable is pulled', async () => {
    const { port, conn } = await connect();
    port.send('Rest');
    await flush();
    port.unplug('none');

    expect(text(await conn.read(100))).toBe('Rest');
    const started = Date.now();
    const err = await rejection(conn.read(1000));
    expect(Date.now() - started).toBeLessThan(500);
    expect(err.code).toBe('disconnected');
    expect(err.message).toBe('Die Verbindung zur Box ist abgebrochen. Prüfe das USB-Kabel und stecke die Box neu ein.');
    expect(err.detail).toMatch(/NetworkError/);
    expect((await rejection(conn.write(Uint8Array.of(1)))).code).toBe('disconnected');
    expect((await rejection(conn.setSignals({ dtr: true }))).code).toBe('disconnected');
    expect((conn as SerialConnection & { isLost: boolean }).isLost).toBe(true);

    await conn.close();
    expect(port.isOpen).toBe(false);
    expect((await rejection(conn.read(10))).code).toBe('closed');
  });

  it('ends a waiting read at once when the cable is pulled', async () => {
    const { port, conn } = await connect();
    const started = Date.now();
    const pending = rejection(conn.read(5000));
    setTimeout(() => port.unplug(), 10);
    expect((await pending).code).toBe('disconnected');
    expect(Date.now() - started).toBeLessThan(1000);
    await conn.close();
    expect(port.isOpen).toBe(false);
  });

  it('notices a write that fails because the device is gone', async () => {
    const { port, conn } = await connect();
    // The device vanished, but the browser has not told the read side yet.
    port.gone = true;
    const err = await rejection(conn.write(Uint8Array.of(0x30, 0x20)));
    expect(err.code).toBe('disconnected');
    expect((await rejection(conn.read(1000))).code).toBe('disconnected');
    await conn.close();
  });

  it('hears the disconnect event at navigator.serial and leaves other ports alone', async () => {
    const { api, access, port, conn } = await connect();
    const other = new FakePort({ usbVendorId: 0x04d9, usbProductId: 0xb534 });
    api.offer = other;
    const otherInfo = await access.request();
    expect(otherInfo?.label).toBe('USB-Seriell (AiO)');
    const otherConn = await access.open(otherInfo!, 57600);

    api.fireDisconnect(port);
    expect((await rejection(conn.read(1000))).code).toBe('disconnected');
    other.send('noch da');
    expect(text(await otherConn.read(100))).toBe('noch da');
    await Promise.all([conn.close(), otherConn.close()]);
  });

  it('keeps going after a framing error', async () => {
    const { port, conn } = await connect();
    port.framingError();
    await flush();
    port.send('weiter');
    expect(text(await conn.read(200))).toBe('weiter');
    expect((conn as SerialConnection & { isLost: boolean }).isLost).toBe(false);
    await conn.close();
  });

  it('closes once, ends a waiting read and refuses everything afterwards', async () => {
    const { access, info, port, conn } = await connect();
    const waiting = conn.read(5000);
    const started = Date.now();
    await Promise.all([conn.close(), conn.close()]);
    expect(await waiting).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(port.isOpen).toBe(false);
    expect(port.closeCalls).toBe(1);
    await conn.close();
    for (const call of [() => conn.read(10), () => conn.write(Uint8Array.of(1)), () => conn.setSignals({ dtr: true }), () => conn.discardInput()]) {
      expect((await rejection(call())).code).toBe('closed');
    }
    // The port can be opened again, for example at another speed.
    const again = await access.open(info, 57600);
    expect(port.openedBauds).toEqual([115200, 57600]);
    await again.close();
  });

  it('explains ports that do not open and knows when the user cancelled', async () => {
    const { api, access, info, conn } = await connect();
    await expect(access.open(info, 115200)).rejects.toThrow(/schon geöffnet/);
    await expect(access.open({ id: 'web-serial-unknown', label: 'x' }, 115200)).rejects.toThrow(/nicht mehr da/);
    await conn.close();

    api.offer = undefined;
    expect(await access.request()).toBeNull();
    api.granted.push(new FakePort({ usbVendorId: 0x2341, usbProductId: 0x0058 }), new FakePort({}));
    const listed = await access.list();
    expect(listed.map((p) => p.label)).toEqual(['USB-Seriell (CH340)', 'USB-Seriell (Arduino Nano Every)', 'Serieller Anschluss']);
    expect((await access.list()).map((p) => p.id)).toEqual(listed.map((p) => p.id));
    expect(listed[0].id).toBe(info.id);
  });

  it('forgets a port whose device was unplugged, so trying it again says the box is gone', async () => {
    const { access, info, port, conn } = await connect();
    port.unplug();
    await conn.close();
    expect(await access.list()).toEqual([]);
    const err = await rejection(access.open(info, 115200));
    expect(err.code).toBe('not-found');
    expect(err.message).toBe('Der Anschluss ist nicht mehr da. Stecke die Box wieder ein und wähle sie noch einmal aus.');
    expect(describePortError(err, { os: 'windows', port: info })).toMatchObject({ code: 'port-missing', title: 'Der Anschluss wurde nicht gefunden' });
  });

  it('notices a gone device on open, also when the browser has not said so yet', async () => {
    const api = new FakeSerial();
    const port = new FakePort();
    api.offer = port;
    const access = webSerial(api);
    const info = (await access.request())!;
    port.gone = true;
    const err = await rejection(access.open(info, 115200));
    expect(err.code).toBe('not-found');
    expect(err.detail).toBe('NetworkError: Failed to open serial port.');
  });

  it('says what usually keeps a connected port from opening', async () => {
    const api = new FakeSerial();
    const port = new FakePort();
    port.refuseOpen = true;
    api.offer = port;
    const access = webSerial(api);
    const info = (await access.request())!;
    const err = await access.open(info, 115200).then(
      () => undefined,
      (e: unknown) => e as Error & { detail?: string },
    );
    expect(err?.message).toBe('Der Anschluss lässt sich nicht öffnen. Meist benutzt ihn gerade ein anderes Programm, oder es fehlt ein Treiber oder die Berechtigung.');
    expect(err?.detail).toBe('NetworkError: Failed to open serial port.');
    expect(await access.list()).toHaveLength(1);
    const problem = describePortError(err, { os: 'windows', port: info });
    expect(problem).toMatchObject({ code: 'port-busy', title: 'Der Anschluss lässt sich nicht öffnen' });
    expect(problem.steps.join(' ')).toContain('CH340');
    expect(problem.technical).toContain('Failed to open serial port');
  });

  it('reports no support without Web Serial', async () => {
    const access = webSerial(undefined);
    expect(access.supported).toBe(false);
    expect(await access.list()).toEqual([]);
    expect(await access.request()).toBeNull();
  });
});

/** A FakePort wired to the simulated bootloader. */
class BoardPort extends FakePort {
  /** Pull the cable this long after the bootloader took this many pages, while the flasher waits for the answer. */
  unplugAfterPages: number | undefined;

  constructor(readonly board: SimulatedBoard) {
    super();
  }

  protected override received(chunk: Uint8Array): void {
    try {
      this.board.write(chunk, this.baudRate);
    } catch (e) {
      this.unplug();
      throw e;
    }
    if (this.unplugAfterPages !== undefined && this.board.pagesWritten >= this.unplugAfterPages) {
      setTimeout(() => this.unplug('none'), 10);
      return;
    }
    const bytes = this.board.take(Date.now(), Number.POSITIVE_INFINITY);
    if (bytes.length) this.send(bytes);
  }

  override async setSignals(signals: SerialOutputSignals): Promise<void> {
    await super.setSignals(signals);
    this.board.setSignals({ dtr: signals.dataTerminalReady, rts: signals.requestToSend });
  }
}

async function flashOver(port: BoardPort, image: Uint8Array): Promise<FlashResult> {
  const api = new FakeSerial();
  api.offer = port;
  const serial = webSerial(api);
  const info = await serial.request();
  return flashFirmware({ serial, port: info!, board: 'classic', image, timing: FAST_TIMING });
}

describe('flashing over web serial', () => {
  it('flashes a Nano, reopening the port at the second speed', async () => {
    const board = nanoBoard('optiboot');
    const port = new BoardPort(board);
    const image = firmwareBytes(1000);
    const result = await flashOver(port, image);
    expect(result).toMatchObject({ ok: true, baud: 115200, verified: true });
    expect(board.read(0, image.length)).toEqual(image);
    expect(port.openedBauds).toEqual([57600, 115200]);
    expect(port.isOpen).toBe(false);
  });

  it('says the box is gone when the cable is pulled during a write', async () => {
    const port = new BoardPort(nanoBoard('old', { unplugAfterWrites: 10 }));
    const result = await flashOver(port, firmwareBytes(1000));
    if (result.ok) throw new Error('expected a problem');
    expect(result.problem).toMatchObject({ code: 'port-missing', title: 'Die Box ist nicht mehr verbunden' });
    expect(result.problem.technical).toMatch(/^write failed: Die Verbindung zur Box ist abgebrochen/);
    expect(port.isOpen).toBe(false);
  });

  it('says the box is gone, not busy, when the old port is tried again after a pulled cable', async () => {
    const port = new BoardPort(nanoBoard('old', { unplugAfterWrites: 10 }));
    const api = new FakeSerial();
    api.offer = port;
    const serial = webSerial(api);
    const info = (await serial.request())!;
    const first = await flashFirmware({ serial, port: info, board: 'classic', image: firmwareBytes(1000), timing: FAST_TIMING });
    expect(first.ok).toBe(false);
    const again = await flashFirmware({ serial, port: info, board: 'classic', image: firmwareBytes(1000), timing: FAST_TIMING });
    if (again.ok) throw new Error('expected a problem');
    expect(again.problem).toMatchObject({ code: 'port-missing', title: 'Der Anschluss wurde nicht gefunden' });
  });

  it('says the box is gone when the cable is pulled while waiting for an answer', async () => {
    const port = new BoardPort(nanoBoard('old'));
    port.unplugAfterPages = 3;
    const result = await flashOver(port, firmwareBytes(1000));
    if (result.ok) throw new Error('expected a problem');
    expect(result.problem).toMatchObject({ code: 'port-missing', title: 'Die Box ist nicht mehr verbunden' });
    expect(result.problem.technical).toMatch(/^read failed: Die Verbindung zur Box ist abgebrochen/);
    expect(port.isOpen).toBe(false);
  });
});
