/**
 * The USB-serial chips of TonUINO boards, spoken to directly over USB (the
 * Android app has no serial driver of the system to lean on). Each chip is
 * set up with a few control transfers; they are written here as plain data
 * and sent by the Kotlin side (src-tauri/android/TonuinoUsb.kt), which only
 * moves bytes. The sequences follow the Linux kernel drivers (ch341.c,
 * cp210x.c, ftdi_sio.c, cdc-acm.c), which every Nano clone works with.
 *
 *   CH340/CH341   QinHeng 1a86:7523, 1a86:5523 (most Nano clones, AiO+)
 *   CP210x        Silicon Labs 10c4:ea60 and family
 *   FTDI FT232R   0403:6001, FT-X 0403:6015 (original Nanos)
 *   CDC-ACM       Arduino 2341:*, Holtek HT42B534 04d9:b534 (AiO), CH9102 1a86:55d4,
 *                 and any other device that says it is a USB modem
 *
 * Signals: dtr/rts `true` means the line is active, as in Web Serial and
 * the desktop app. The reset of resetBoard (core/firmware/stk500.ts) needs
 * nothing else.
 */

export interface UsbEndpointInfo {
  /** bEndpointAddress, with the direction bit (0x80 = in). */
  address: number;
  type: 'control' | 'iso' | 'bulk' | 'interrupt';
  dir: 'in' | 'out';
  /** wMaxPacketSize. */
  packetSize: number;
}

export interface UsbInterfaceInfo {
  /** bInterfaceNumber. */
  id: number;
  cls: number;
  subclass: number;
  protocol: number;
  endpoints: UsbEndpointInfo[];
}

/** A USB device as the Kotlin side lists it. */
export interface UsbDeviceInfo {
  /** Android's name for it, e.g. "/dev/bus/usb/001/004"; new after every replug. */
  name: string;
  vendorId: number;
  productId: number;
  manufacturer?: string;
  product?: string;
  /** The app may open it (the user allowed it). */
  permission: boolean;
  interfaces: UsbInterfaceInfo[];
}

/** One control transfer (USB 2.0 §9.3). Direction is bit 7 of requestType. */
export interface ControlTransfer {
  requestType: number;
  request: number;
  value: number;
  index: number;
  /** Data stage of an OUT transfer. */
  data?: Uint8Array;
  /** Bytes wanted in an IN transfer. */
  length?: number;
}

/** Sends a control transfer; resolves with the bytes of an IN transfer (empty for OUT). */
export type Control = (t: ControlTransfer) => Promise<Uint8Array>;

/** What to claim and where the data flows. */
export interface ChipPlan {
  interfaces: number[];
  inEndpoint: number;
  outEndpoint: number;
  inPacketSize: number;
}

export type ChipKind = 'ch34x' | 'cp210x' | 'ftdi' | 'cdc';

export interface ChipDriver {
  readonly kind: ChipKind;
  /** For the port's name, e.g. "CH340". */
  readonly label: string;
  readonly plan: ChipPlan;
  /**
   * Bytes at the start of every packet the chip sends that are no data
   * (FTDI: 2). The Kotlin reader does not pass on packets that hold nothing
   * else: an FTDI sends such a packet every few milliseconds.
   */
  readonly header: number;
  /** Sets the chip up for 8N1 at `baud`, DTR and RTS active. */
  open(ctl: Control, baud: number): Promise<void>;
  setSignals(ctl: Control, dtr: boolean, rts: boolean): Promise<void>;
  /** The bytes of one bulk-in transfer without the chip's own framing (FTDI: two status bytes per packet). */
  unframe(chunk: Uint8Array): Uint8Array;
}

/* bmRequestType */
const VENDOR_OUT = 0x40;
const VENDOR_IN = 0xc0;
const VENDOR_IFACE_OUT = 0x41;
const CLASS_IFACE_OUT = 0x21;

const CDC_CLASS = 0x02;
const CDC_ACM_SUBCLASS = 0x02;
const CDC_DATA_CLASS = 0x0a;

/** The first bulk in and out endpoints of an interface. */
function bulkPair(itf: UsbInterfaceInfo | undefined): { inEp: UsbEndpointInfo; outEp: UsbEndpointInfo } | null {
  if (!itf) return null;
  const inEp = itf.endpoints.find((e) => e.type === 'bulk' && e.dir === 'in');
  const outEp = itf.endpoints.find((e) => e.type === 'bulk' && e.dir === 'out');
  return inEp && outEp ? { inEp, outEp } : null;
}

/** The single-interface chips: data on interface 0 (the lowest number). */
function firstInterfacePlan(device: UsbDeviceInfo): ChipPlan | null {
  const itf = [...device.interfaces].sort((a, b) => a.id - b.id).find((i) => bulkPair(i));
  const pair = bulkPair(itf);
  if (!itf || !pair) return null;
  return { interfaces: [itf.id], inEndpoint: pair.inEp.address, outEndpoint: pair.outEp.address, inPacketSize: pair.inEp.packetSize };
}

/* ------------------------------------------------------------- CH340/CH341 */

export const CH341 = {
  READ_VERSION: 0x5f,
  WRITE_REG: 0x9a,
  SERIAL_INIT: 0xa1,
  MODEM_CTRL: 0xa4,
  REG_PRESCALER: 0x12,
  REG_DIVISOR: 0x13,
  REG_LCR: 0x18,
  REG_LCR2: 0x25,
  /** Enable RX and TX, 8 data bits, no parity, 1 stop bit. */
  LCR_8N1: 0x80 | 0x40 | 0x03,
  BIT_DTR: 1 << 5,
  BIT_RTS: 1 << 6,
} as const;

const CH341_CLK = 48_000_000;
const ch341ClkDiv = (ps: number, fact: number) => 1 << (12 - 3 * ps - fact);
const CH341_MIN_RATES = [0, 1, 2, 3].map((ps) => Math.floor(CH341_CLK / (ch341ClkDiv(ps, 1) * 512)));
const CH341_MIN_BPS = Math.ceil(CH341_CLK / (ch341ClkDiv(0, 0) * 256));
const CH341_MAX_BPS = Math.floor(CH341_CLK / (ch341ClkDiv(3, 0) * 2));

/**
 * The divisor word of the CH341 for a baud rate: (0x100 - div) << 8 | fact << 2 | ps,
 * exactly as ch341_get_divisor() of Linux computes it (115200 → 0xcc03,
 * 57600 → 0x9803, 9600 → 0xb202).
 */
export function ch341Divisor(baud: number): number {
  const speed = Math.min(CH341_MAX_BPS, Math.max(CH341_MIN_BPS, Math.floor(baud)));
  let fact = 1;
  let ps = 3;
  for (; ps >= 0; ps--) if (speed > CH341_MIN_RATES[ps]) break;
  if (ps < 0) throw new Error(`CH341: no divisor for ${baud} baud`);
  let clkDiv = ch341ClkDiv(ps, fact);
  let div = Math.floor(CH341_CLK / (clkDiv * speed));
  if (div < 9 || div > 255) {
    div = Math.floor(div / 2);
    clkDiv *= 2;
    fact = 0;
  }
  if (div < 2) throw new Error(`CH341: no divisor for ${baud} baud`);
  // The next divisor when it comes closer to the wanted rate (scaled by 16 against rounding, like Linux).
  if (Math.floor((16 * CH341_CLK) / (clkDiv * div)) - 16 * speed >= 16 * speed - Math.floor((16 * CH341_CLK) / (clkDiv * (div + 1)))) div++;
  // The lower base clock where the divisor is even: the receiver is more tolerant then.
  if (fact === 1 && div % 2 === 0) {
    div /= 2;
    fact = 0;
  }
  return ((0x100 - div) << 8) | (fact << 2) | ps;
}

class Ch34x implements ChipDriver {
  readonly kind = 'ch34x';
  readonly header = 0;
  /** Chip version from READ_VERSION; decides two details of the setup. */
  version = 0;

  constructor(
    readonly plan: ChipPlan,
    readonly label: string,
  ) {}

  async open(ctl: Control, baud: number): Promise<void> {
    const v = await ctl({ requestType: VENDOR_IN, request: CH341.READ_VERSION, value: 0, index: 0, length: 2 });
    this.version = v[0] ?? 0;
    await ctl({ requestType: VENDOR_OUT, request: CH341.SERIAL_INIT, value: 0, index: 0 });
    let div = ch341Divisor(baud);
    // Without bit 7 a CH341A holds data back until 32 bytes are there (version 0x27 has it the other way round).
    if (this.version > 0x27) div |= 0x80;
    await ctl({ requestType: VENDOR_OUT, request: CH341.WRITE_REG, value: (CH341.REG_DIVISOR << 8) | CH341.REG_PRESCALER, index: div });
    // From version 0x30 on the line settings live in LCR alone (LCR2 stays 0).
    if (this.version >= 0x30) await ctl({ requestType: VENDOR_OUT, request: CH341.WRITE_REG, value: (CH341.REG_LCR2 << 8) | CH341.REG_LCR, index: CH341.LCR_8N1 });
    await this.setSignals(ctl, true, true);
  }

  async setSignals(ctl: Control, dtr: boolean, rts: boolean): Promise<void> {
    const bits = (dtr ? CH341.BIT_DTR : 0) | (rts ? CH341.BIT_RTS : 0);
    // The chip takes the lines inverted.
    await ctl({ requestType: VENDOR_OUT, request: CH341.MODEM_CTRL, value: ~bits & 0xffff, index: 0 });
  }

  unframe(chunk: Uint8Array): Uint8Array {
    return chunk;
  }
}

/* ------------------------------------------------------------------ CP210x */

export const CP210X = {
  IFC_ENABLE: 0x00,
  SET_LINE_CTL: 0x03,
  SET_MHS: 0x07,
  SET_BAUDRATE: 0x1e,
  UART_ENABLE: 0x0001,
  /** 8 data bits, no parity, 1 stop bit. */
  LINE_8N1: 0x0800,
  CONTROL_DTR: 0x0001,
  CONTROL_RTS: 0x0002,
  CONTROL_WRITE_DTR: 0x0100,
  CONTROL_WRITE_RTS: 0x0200,
} as const;

function le32(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

class Cp210x implements ChipDriver {
  readonly kind = 'cp210x';
  readonly header = 0;
  readonly label = 'CP210x';

  constructor(readonly plan: ChipPlan) {}

  private get iface(): number {
    return this.plan.interfaces[0];
  }

  async open(ctl: Control, baud: number): Promise<void> {
    await ctl({ requestType: VENDOR_IFACE_OUT, request: CP210X.IFC_ENABLE, value: CP210X.UART_ENABLE, index: this.iface });
    await ctl({ requestType: VENDOR_IFACE_OUT, request: CP210X.SET_BAUDRATE, value: 0, index: this.iface, data: le32(Math.floor(baud)) });
    await ctl({ requestType: VENDOR_IFACE_OUT, request: CP210X.SET_LINE_CTL, value: CP210X.LINE_8N1, index: this.iface });
    await this.setSignals(ctl, true, true);
  }

  async setSignals(ctl: Control, dtr: boolean, rts: boolean): Promise<void> {
    const value = CP210X.CONTROL_WRITE_DTR | CP210X.CONTROL_WRITE_RTS | (dtr ? CP210X.CONTROL_DTR : 0) | (rts ? CP210X.CONTROL_RTS : 0);
    await ctl({ requestType: VENDOR_IFACE_OUT, request: CP210X.SET_MHS, value, index: this.iface });
  }

  unframe(chunk: Uint8Array): Uint8Array {
    return chunk;
  }
}

/* -------------------------------------------------------------------- FTDI */

export const FTDI = {
  RESET: 0,
  MODEM_CTRL: 1,
  SET_FLOW_CTRL: 2,
  SET_BAUD_RATE: 3,
  SET_DATA: 4,
  SET_LATENCY_TIMER: 9,
  RESET_SIO: 0,
  /** 8 data bits, no parity, 1 stop bit. */
  DATA_8N1: 0x0008,
  /** Set DTR and RTS both: the mask bits in the high byte, the levels in the low byte. */
  MODEM_WRITE_BOTH: 0x0300,
  /**
   * Milliseconds the chip waits before it sends a part-filled packet: 16 by
   * default, which makes every short answer of the bootloader that much
   * later. 2 keeps flashing quick without a packet every millisecond.
   */
  LATENCY_MS: 2,
} as const;

const FTDI_DIVFRAC = [0, 3, 2, 4, 1, 5, 6, 7];

/**
 * The 17-bit divisor of the FT232BM/FT232R/FT-X for a baud rate (Linux
 * ftdi_232bm_baud_base_to_divisor with 48 MHz: 115200 → 0x1a, 57600 → 0xc034).
 * The low 16 bits go in wValue, bit 16 in wIndex.
 */
export function ftdiDivisor(baud: number): number {
  const divisor3 = Math.round(48_000_000 / (2 * baud));
  let divisor = (divisor3 >> 3) | (FTDI_DIVFRAC[divisor3 & 7] << 14);
  if (divisor === 1) divisor = 0;
  else if (divisor === 0x4001) divisor = 1;
  return divisor;
}

class Ftdi implements ChipDriver {
  readonly kind = 'ftdi';
  readonly header = 2;

  constructor(
    readonly plan: ChipPlan,
    readonly label: string,
  ) {}

  async open(ctl: Control, baud: number): Promise<void> {
    await ctl({ requestType: VENDOR_OUT, request: FTDI.RESET, value: FTDI.RESET_SIO, index: 0 });
    const div = ftdiDivisor(baud);
    await ctl({ requestType: VENDOR_OUT, request: FTDI.SET_BAUD_RATE, value: div & 0xffff, index: (div >> 16) & 0xffff });
    await ctl({ requestType: VENDOR_OUT, request: FTDI.SET_DATA, value: FTDI.DATA_8N1, index: 0 });
    await ctl({ requestType: VENDOR_OUT, request: FTDI.SET_FLOW_CTRL, value: 0, index: 0 });
    await ctl({ requestType: VENDOR_OUT, request: FTDI.SET_LATENCY_TIMER, value: FTDI.LATENCY_MS, index: 0 });
    await this.setSignals(ctl, true, true);
  }

  async setSignals(ctl: Control, dtr: boolean, rts: boolean): Promise<void> {
    await ctl({ requestType: VENDOR_OUT, request: FTDI.MODEM_CTRL, value: FTDI.MODEM_WRITE_BOTH | (dtr ? 1 : 0) | (rts ? 2 : 0), index: 0 });
  }

  /** Every packet of the chip starts with two status bytes (modem and line status); they are no data. */
  unframe(chunk: Uint8Array): Uint8Array {
    const size = this.plan.inPacketSize > 2 ? this.plan.inPacketSize : 64;
    if (chunk.length <= 2) return new Uint8Array(0);
    const out = new Uint8Array(chunk.length);
    let n = 0;
    for (let at = 0; at < chunk.length; at += size) {
      const end = Math.min(chunk.length, at + size);
      if (end - at > 2) {
        out.set(chunk.subarray(at + 2, end), n);
        n += end - at - 2;
      }
    }
    return out.subarray(0, n);
  }
}

/* ----------------------------------------------------------------- CDC-ACM */

export const CDC = {
  SET_LINE_CODING: 0x20,
  SET_CONTROL_LINE_STATE: 0x22,
} as const;

class CdcAcm implements ChipDriver {
  readonly kind = 'cdc';
  readonly header = 0;

  constructor(
    readonly plan: ChipPlan,
    readonly label: string,
    /** The interface that takes the class requests (the communication interface). */
    private readonly control: number,
  ) {}

  async open(ctl: Control, baud: number): Promise<void> {
    // dwDTERate, bCharFormat 0 (1 stop bit), bParityType 0 (none), bDataBits 8.
    const coding = new Uint8Array(7);
    coding.set(le32(Math.floor(baud)), 0);
    coding[6] = 8;
    await ctl({ requestType: CLASS_IFACE_OUT, request: CDC.SET_LINE_CODING, value: 0, index: this.control, data: coding });
    await this.setSignals(ctl, true, true);
  }

  async setSignals(ctl: Control, dtr: boolean, rts: boolean): Promise<void> {
    await ctl({ requestType: CLASS_IFACE_OUT, request: CDC.SET_CONTROL_LINE_STATE, value: (dtr ? 1 : 0) | (rts ? 2 : 0), index: this.control });
  }

  unframe(chunk: Uint8Array): Uint8Array {
    return chunk;
  }
}

/** The communication and data interfaces of a CDC-ACM device; also one-interface devices with all endpoints together. */
function cdcPlan(device: UsbDeviceInfo): { plan: ChipPlan; control: number } | null {
  const comm = device.interfaces.find((i) => i.cls === CDC_CLASS && i.subclass === CDC_ACM_SUBCLASS);
  // The data interface: the next CDC data interface after the communication one, else the first.
  const dataIfs = device.interfaces.filter((i) => i.cls === CDC_DATA_CLASS && bulkPair(i));
  const data = (comm && dataIfs.find((i) => i.id > comm.id)) ?? dataIfs[0];
  if (comm && data) {
    const pair = bulkPair(data)!;
    return { plan: { interfaces: [comm.id, data.id], inEndpoint: pair.inEp.address, outEndpoint: pair.outEp.address, inPacketSize: pair.inEp.packetSize }, control: comm.id };
  }
  if (comm && bulkPair(comm)) {
    const pair = bulkPair(comm)!;
    return { plan: { interfaces: [comm.id], inEndpoint: pair.inEp.address, outEndpoint: pair.outEp.address, inPacketSize: pair.inEp.packetSize }, control: comm.id };
  }
  return null;
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/** Names of devices whose product tells more than the vendor (as in web/serial.ts). */
const PRODUCT_LABELS: Record<string, string> = {
  '1a86:7523': 'CH340',
  '1a86:5523': 'CH341',
  '1a86:7522': 'CH340',
  '1a86:55d4': 'CH9102',
  '0403:6001': 'FTDI',
  '0403:6015': 'FTDI',
  '2341:0058': 'Arduino Nano Every',
  '2341:0070': 'Arduino Nano ESP32',
  '04d9:b534': 'AiO',
};

/** FTDI chips with more than one port or high speed: another divisor and other packets. */
const FTDI_UNSUPPORTED = new Set([0x6010, 0x6011, 0x6014]);

/**
 * The driver for a device, or null when the app cannot talk to it. A
 * device that says it is a USB modem (CDC-ACM) always gets the class
 * driver, also from a vendor with its own chips (the CH9102 does that).
 */
export function driverFor(device: UsbDeviceInfo): ChipDriver | null {
  const key = `${hex4(device.vendorId)}:${hex4(device.productId)}`;
  const cdc = cdcPlan(device);
  if (cdc) return new CdcAcm(cdc.plan, PRODUCT_LABELS[key] ?? (device.vendorId === 0x2341 ? 'Arduino' : 'USB-Modem'), cdc.control);
  const plan = firstInterfacePlan(device);
  if (!plan) return null;
  switch (device.vendorId) {
    case 0x1a86:
      return new Ch34x(plan, PRODUCT_LABELS[key] ?? 'CH340');
    case 0x10c4:
      return new Cp210x(plan);
    case 0x0403:
      return FTDI_UNSUPPORTED.has(device.productId) ? null : new Ftdi(plan, PRODUCT_LABELS[key] ?? 'FTDI');
  }
  return null;
}
