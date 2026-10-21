import { afterEach, describe, expect, it } from 'vitest';
import { AndroidCalls, fromBase64, toBase64 } from '../../src/platform/tauri/androidBridge';
import { AndroidUsbSerial, type UsbBridge } from '../../src/platform/tauri/androidUsb';
import { CH341, ch341Divisor, CP210X, driverFor, FTDI, ftdiDivisor, type ControlTransfer, type UsbDeviceInfo, type UsbInterfaceInfo } from '../../src/platform/tauri/usbChips';
import { flashFirmware } from '../../src/core/firmware/flash';
import { FAST_TIMING, firmwareBytes, nanoBoard, type SimulatedBoard } from '../firmware/simulator';
import type { Host } from './fake-android';

/* ------------------------------------------------------------ devices */

const bulk = (inAddr = 0x82, outAddr = 0x02, size = 32): UsbInterfaceInfo['endpoints'] => [
  { address: 0x81, type: 'interrupt', dir: 'in', packetSize: 8 },
  { address: inAddr, type: 'bulk', dir: 'in', packetSize: size },
  { address: outAddr, type: 'bulk', dir: 'out', packetSize: size },
];

const vendorIf = (size = 32): UsbInterfaceInfo => ({ id: 0, cls: 0xff, subclass: 1, protocol: 2, endpoints: bulk(0x82, 0x02, size) });

const CH340: UsbDeviceInfo = { name: '/dev/bus/usb/001/004', vendorId: 0x1a86, productId: 0x7523, permission: false, interfaces: [vendorIf()] };
const FT232R: UsbDeviceInfo = { name: '/dev/bus/usb/001/005', vendorId: 0x0403, productId: 0x6001, permission: true, interfaces: [{ ...vendorIf(64), endpoints: [{ address: 0x81, type: 'bulk', dir: 'in', packetSize: 64 }, { address: 0x02, type: 'bulk', dir: 'out', packetSize: 64 }] }] };
const CP2102: UsbDeviceInfo = { name: '/dev/bus/usb/001/006', vendorId: 0x10c4, productId: 0xea60, permission: true, interfaces: [{ ...vendorIf(64), endpoints: [{ address: 0x81, type: 'bulk', dir: 'in', packetSize: 64 }, { address: 0x01, type: 'bulk', dir: 'out', packetSize: 64 }] }] };
/** An Arduino with a CDC-ACM chip: communication interface 0 (interrupt), data interface 1 (bulk). */
const cdcDevice = (vendorId: number, productId: number, name = '/dev/bus/usb/001/007'): UsbDeviceInfo => ({
  name,
  vendorId,
  productId,
  permission: true,
  interfaces: [
    { id: 0, cls: 2, subclass: 2, protocol: 1, endpoints: [{ address: 0x82, type: 'interrupt', dir: 'in', packetSize: 8 }] },
    { id: 1, cls: 10, subclass: 0, protocol: 0, endpoints: [{ address: 0x04, type: 'bulk', dir: 'out', packetSize: 64 }, { address: 0x83, type: 'bulk', dir: 'in', packetSize: 64 }] },
  ],
});

/* ------------------------------------------------------------ the chips, byte for byte */

function recorder(answer: (t: ControlTransfer) => Uint8Array = () => new Uint8Array(0)) {
  const sent: ControlTransfer[] = [];
  const ctl = async (t: ControlTransfer) => {
    sent.push(t);
    return answer(t);
  };
  return { sent, ctl };
}

const hex = (t: ControlTransfer) =>
  [t.requestType, t.request, t.value, t.index].map((n) => n.toString(16).padStart(2, '0')).join(' ') + (t.data ? ` [${[...t.data].map((b) => b.toString(16).padStart(2, '0')).join(' ')}]` : '') + (t.length ? ` in ${t.length}` : '');

describe('USB-serial chips as control transfers', () => {
  it('computes the divisors of Linux for the CH341 and the FTDI', () => {
    // Values of ch341_get_divisor() and of the old table of usb-serial-for-android.
    expect(ch341Divisor(115200)).toBe(0xcc03);
    expect(ch341Divisor(57600)).toBe(0x9803);
    expect(ch341Divisor(9600)).toBe(0xb202);
    expect(ch341Divisor(38400)).toBe(0x6403);
    expect(ch341Divisor(19200)).toBe(0xd902);
    // ftdi_232bm_baud_base_to_divisor(baud, 48 MHz).
    expect(ftdiDivisor(115200)).toBe(0x001a);
    expect(ftdiDivisor(57600)).toBe(0xc034);
    expect(ftdiDivisor(9600)).toBe(0x4138);
    expect(ftdiDivisor(3_000_000)).toBe(0);
  });

  it('sets up a CH340 like the Linux driver, the lines inverted', async () => {
    const d = driverFor(CH340)!;
    expect(d.kind).toBe('ch34x');
    expect(d.plan).toEqual({ interfaces: [0], inEndpoint: 0x82, outEndpoint: 0x02, inPacketSize: 32 });
    const { sent, ctl } = recorder((t) => (t.request === CH341.READ_VERSION ? Uint8Array.of(0x31, 0x00) : new Uint8Array(0)));
    await d.open(ctl, 57600);
    expect(sent.map(hex)).toEqual(['c0 5f 00 00 in 2', '40 a1 00 00', '40 9a 1312 9883', '40 9a 2518 c3', '40 a4 ff9f 00']);
    sent.length = 0;
    await d.setSignals(ctl, false, false);
    await d.setSignals(ctl, true, false);
    expect(sent.map(hex)).toEqual(['40 a4 ffff 00', '40 a4 ffdf 00']);
  });

  it('leaves out bit 7 and LCR on old CH341 versions', async () => {
    const d = driverFor(CH340)!;
    const { sent, ctl } = recorder((t) => (t.request === CH341.READ_VERSION ? Uint8Array.of(0x27, 0x00) : new Uint8Array(0)));
    await d.open(ctl, 115200);
    expect(sent.map(hex)).toEqual(['c0 5f 00 00 in 2', '40 a1 00 00', '40 9a 1312 cc03', '40 a4 ff9f 00']);
  });

  it('sets up a CP210x on its interface', async () => {
    const d = driverFor(CP2102)!;
    expect(d.kind).toBe('cp210x');
    const { sent, ctl } = recorder();
    await d.open(ctl, 115200);
    expect(sent.map(hex)).toEqual(['41 00 01 00', '41 1e 00 00 [00 c2 01 00]', '41 03 800 00', '41 07 303 00']);
    sent.length = 0;
    await d.setSignals(ctl, false, true);
    expect(sent.map(hex)).toEqual(['41 07 302 00']);
    expect(CP210X.SET_MHS).toBe(7);
  });

  it('sets up an FTDI and strips its two status bytes from every packet', async () => {
    const d = driverFor(FT232R)!;
    expect(d.kind).toBe('ftdi');
    const { sent, ctl } = recorder();
    await d.open(ctl, 57600);
    expect(sent.map(hex)).toEqual(['40 00 00 00', '40 03 c034 00', '40 04 08 00', '40 02 00 00', '40 09 02 00', '40 01 303 00']);
    sent.length = 0;
    await d.setSignals(ctl, false, false);
    expect(sent.map(hex)).toEqual(['40 01 300 00']);
    // Two full packets of 64 and a short one: 62 + 62 + 3 data bytes.
    const packet = (fill: number, n: number) => [0x01, 0x60, ...new Array(n).fill(fill)];
    const chunk = Uint8Array.from([...packet(1, 62), ...packet(2, 62), ...packet(3, 3)]);
    const data = d.unframe(chunk);
    expect(data.length).toBe(127);
    expect([data[0], data[61], data[62], data[123], data[124], data[126]]).toEqual([1, 1, 2, 2, 3, 3]);
    // Only status: nothing new.
    expect(d.unframe(Uint8Array.of(0x01, 0x60)).length).toBe(0);
    expect([d.header, driverFor(CH340)!.header]).toEqual([2, 0]);
  });

  it('speaks CDC-ACM to Arduinos, the AiO and the CH9102', async () => {
    for (const [vid, pid, label] of [
      [0x2341, 0x0043, 'Arduino'],
      [0x04d9, 0xb534, 'AiO'],
      [0x1a86, 0x55d4, 'CH9102'],
    ] as const) {
      const d = driverFor(cdcDevice(vid, pid))!;
      expect([d.kind, d.label]).toEqual(['cdc', label]);
      expect(d.plan).toEqual({ interfaces: [0, 1], inEndpoint: 0x83, outEndpoint: 0x04, inPacketSize: 64 });
      const { sent, ctl } = recorder();
      await d.open(ctl, 115200);
      expect(sent.map(hex)).toEqual(['21 20 00 00 [00 c2 01 00 00 00 08]', '21 22 03 00']);
    }
  });

  it('knows which devices it cannot talk to', () => {
    expect(driverFor({ ...FT232R, productId: 0x6010 })).toBeNull();
    expect(driverFor({ name: 'x', vendorId: 0x046d, productId: 0xc52b, permission: true, interfaces: [vendorIf()] })).toBeNull();
    expect(driverFor({ ...CH340, interfaces: [] })).toBeNull();
  });
});

/* ------------------------------------------------------------ a fake TonuinoUsb with a board behind it */

type Chip = 'ch34x' | 'ftdi' | 'cp210x' | 'cdc';
const RATES = [9600, 19200, 38400, 57600, 115200];

/**
 * TonuinoUsb.kt as the page sees it, with a USB-serial chip that understands
 * the control transfers (baud rate and DTR) and a simulated bootloader on
 * its serial side.
 */
class FakeUsb implements UsbBridge {
  devicesList: UsbDeviceInfo[];
  /** The answer to Android's permission question. */
  grant = true;
  asked = 0;
  claimed: string[] = [];
  closed: number[] = [];
  baud = 0;
  dtr = false;
  gen = 0;
  /** Bytes the chip sends back when the page writes, for loopback tests. */
  echo = false;
  private pump: ReturnType<typeof setInterval> | undefined;
  private handle = 0;

  constructor(
    readonly host: Host,
    readonly chip: Chip,
    readonly device: UsbDeviceInfo,
    readonly board?: SimulatedBoard,
  ) {
    this.devicesList = [device];
  }

  private done(id: string, result: Record<string, unknown>) {
    setTimeout(() => this.host.__tonuinoAndroid!.done(id, { ok: true, ...result }), 0);
  }

  private fail(id: string, code: string) {
    setTimeout(() => this.host.__tonuinoAndroid!.done(id, { ok: false, code, message: code }), 0);
  }

  devices() {
    return JSON.stringify(this.devicesList);
  }

  permission(id: string) {
    this.asked++;
    if (this.grant) this.devicesList = this.devicesList.map((d) => ({ ...d, permission: true }));
    this.done(id, { granted: this.grant });
  }

  open(id: string, name: string, interfaces: string, inEp: number, outEp: number, header: number) {
    if (!this.devicesList.some((d) => d.name === name)) return this.fail(id, 'not-found');
    this.claimed.push(`${interfaces} ${inEp.toString(16)} ${outEp.toString(16)} ${header}`);
    this.handle++;
    const handle = this.handle;
    this.pump = setInterval(() => this.flow(handle), 1);
    this.done(id, { handle });
  }

  /** The chip hands what arrived from the board to the page, framed like the real one. */
  private flow(handle: number) {
    if (!this.board) return;
    let bytes: Uint8Array;
    try {
      bytes = this.board.take(Date.now(), this.chip === 'ftdi' ? 62 : 64);
    } catch {
      this.stop();
      this.host.__tonuinoAndroid!.event('usb-gone', { handle });
      return;
    }
    if (!bytes.length) return;
    const framed = this.chip === 'ftdi' ? Uint8Array.from([0x01, 0x60, ...bytes]) : bytes;
    this.host.__tonuinoAndroid!.event('usb-data', { handle, gen: this.gen, data: [toBase64(framed)] });
  }

  private stop() {
    clearInterval(this.pump);
    this.pump = undefined;
  }

  control(id: string, _handle: number, requestType: number, request: number, value: number, index: number, data: string) {
    const bytes = data ? fromBase64(data) : new Uint8Array(0);
    const setDtr = (on: boolean) => {
      this.board?.setSignals({ dtr: on });
      this.dtr = on;
    };
    const rateOf = (match: (rate: number) => boolean) => RATES.find(match) ?? -1;
    switch (this.chip) {
      case 'ch34x':
        if (request === CH341.READ_VERSION) return this.done(id, { data: toBase64(Uint8Array.of(0x31, 0)) });
        if (request === CH341.WRITE_REG && value === 0x1312) this.baud = rateOf((r) => (ch341Divisor(r) | 0x80) === index);
        if (request === CH341.MODEM_CTRL) setDtr((~value & CH341.BIT_DTR) !== 0);
        break;
      case 'ftdi':
        if (request === FTDI.SET_BAUD_RATE) this.baud = rateOf((r) => ftdiDivisor(r) === (value | (index << 16)));
        if (request === FTDI.MODEM_CTRL && value & 0x100) setDtr((value & 1) !== 0);
        break;
      case 'cp210x':
        if (request === CP210X.SET_BAUDRATE) this.baud = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
        if (request === CP210X.SET_MHS && value & 0x100) setDtr((value & 1) !== 0);
        break;
      case 'cdc':
        if (requestType === 0x21 && request === 0x20) this.baud = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
        if (requestType === 0x21 && request === 0x22) setDtr((value & 1) !== 0);
        break;
    }
    this.done(id, {});
  }

  write(id: string, handle: number, data: string) {
    const bytes = fromBase64(data);
    try {
      this.board?.write(bytes, this.baud);
    } catch {
      this.stop();
      this.host.__tonuinoAndroid!.event('usb-gone', { handle });
      return this.fail(id, 'gone');
    }
    if (this.echo) this.host.__tonuinoAndroid!.event('usb-data', { handle, gen: this.gen, data: [data] });
    this.done(id, {});
  }

  drop() {
    // What the reader thread had not handed on yet goes, like bytes already in the chip's buffer.
    this.board?.discard(Date.now());
    return ++this.gen;
  }

  close(handle: number) {
    this.closed.push(handle);
    this.stop();
    this.board?.disconnect();
  }
}

const fakes: FakeUsb[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.close(0);
});

function serialWith(chip: Chip, device: UsbDeviceInfo, board?: SimulatedBoard) {
  const host: Host = {};
  const usb = new FakeUsb(host, chip, device, board);
  fakes.push(usb);
  const calls = new AndroidCalls(host);
  return { host, usb, serial: new AndroidUsbSerial(usb, calls) };
}

describe('AndroidUsbSerial', () => {
  it('lists the boxes it can talk to, without asking yet', async () => {
    const { usb, serial } = serialWith('ch34x', CH340);
    usb.devicesList.push({ name: 'mouse', vendorId: 0x046d, productId: 0xc52b, permission: false, interfaces: [vendorIf()] });
    expect(await serial.list()).toEqual([{ id: 'usb:/dev/bus/usb/001/004', label: 'USB-Seriell (CH340)', usbVendorId: 0x1a86, usbProductId: 0x7523 }]);
    expect(usb.asked).toBe(0);
  });

  it('asks Android once when opening, and says so when the user says no', async () => {
    const { usb, serial } = serialWith('ch34x', CH340);
    const [port] = await serial.list();
    usb.grant = false;
    await expect(serial.open(port, 115200)).rejects.toMatchObject({ code: 'denied', message: expect.stringMatching(/Zulassen/) });
    usb.grant = true;
    const conn = await serial.open(port, 115200);
    expect(usb.asked).toBe(2);
    expect(usb.claimed).toEqual(['0 82 2 0']);
    expect([usb.baud, usb.dtr]).toEqual([115200, true]);
    await conn.close();
    await conn.close();
    expect(usb.closed).toEqual([1]);
    await expect(conn.write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'closed' });
    // Opened again: no question, Android remembers until the box is unplugged.
    await (await serial.open(port, 57600)).close();
    expect(usb.asked).toBe(2);
    await expect(serial.open({ ...port, id: 'usb:/dev/bus/usb/009/009' }, 57600)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('reads what arrives, drops what came before discardInput, and keeps the other line when one changes', async () => {
    const { host, usb, serial } = serialWith('ch34x', { ...CH340, permission: true });
    usb.echo = true;
    const conn = await serial.open((await serial.list())[0], 115200);
    await conn.write(Uint8Array.of(1, 2, 3));
    expect([...(await conn.read(100))]).toEqual([1, 2, 3]);
    expect((await conn.read(5)).length).toBe(0);
    // A late event of before the discard does not count.
    const old = usb.gen;
    await conn.discardInput();
    host.__tonuinoAndroid!.event('usb-data', { handle: 1, gen: old, data: [toBase64(Uint8Array.of(9))] });
    expect((await conn.read(5)).length).toBe(0);
    await conn.setSignals({ dtr: false });
    expect(usb.dtr).toBe(false);
    await conn.close();
  });

  it('turns a pulled cable into "disconnected" after the last bytes', async () => {
    const { host, usb, serial } = serialWith('ch34x', { ...CH340, permission: true });
    const conn = await serial.open((await serial.list())[0], 115200);
    host.__tonuinoAndroid!.event('usb-data', { handle: 1, gen: usb.gen, data: [toBase64(Uint8Array.of(7))] });
    host.__tonuinoAndroid!.event('usb-gone', { handle: 1 });
    expect([...(await conn.read(10))]).toEqual([7]);
    await expect(conn.read(10)).rejects.toMatchObject({ code: 'disconnected' });
    await expect(conn.write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'disconnected' });
    await conn.close();
  });
});

describe('flashing a Nano over the phone\'s USB', () => {
  const cases: [Chip, UsbDeviceInfo][] = [
    ['ch34x', { ...CH340, permission: true }],
    ['ftdi', FT232R],
    ['cp210x', CP2102],
    ['cdc', cdcDevice(0x2341, 0x0043)],
  ];

  for (const [chip, device] of cases) {
    it(`flashes and verifies through a ${chip} chip, old and new bootloader`, async () => {
      for (const kind of ['old', 'optiboot'] as const) {
        const board = nanoBoard(kind);
        const { serial } = serialWith(chip, device, board);
        const [port] = await serial.list();
        const image = firmwareBytes(3000, 7);
        const result = await flashFirmware({ serial, port: { ...port, usbVendorId: 0x1a86, usbProductId: 0x7523 }, board: 'classic', image, timing: FAST_TIMING });
        expect(result, `${chip} ${kind}`).toMatchObject({ ok: true, baud: kind === 'old' ? 57600 : 115200, verified: true });
        expect(Buffer.compare(board.read(0, image.length), image)).toBe(0);
        expect(board.violations).toEqual([]);
      }
    }, 20_000);
  }
});
