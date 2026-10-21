/**
 * Boards and ready-made firmware builds of TonUINO-TNG.
 *
 * Environment names, button variants and upload settings follow
 * TonUINO-TNG platformio.ini (V3.3.3) and the official web uploader pages
 * (.github/online_upload: boards nanoOldBootloader, lgt8f328p, avr4809 of
 * arduino-web-uploader). The GitHub workflow (build_and_run_tests.yml)
 * builds every environment of platformio.ini (`pio run`) and deploys
 * .pio/build/<env>/firmware.hex and firmware.bin to GitHub Pages, so each
 * build lives at https://tonuino.github.io/TonUINO-TNG/<env>/firmware.hex
 * (ESP32: firmware.bin) with <env> = <pioEnv>_<variant>. The web uploader
 * pages only offer 3, 5 and 3x3, but the 5f builds are published as well.
 */

export type BoardId = 'classic' | 'aio' | 'aioplus' | 'every' | 'every4808' | 'esp32nano' | 'esp32wroom';

/** 3 buttons, 5 buttons, 3x3 button board, 5 buttons with all extras ("full"). */
export type ButtonVariant = '3' | '5' | '3x3' | '5f';

export type FlashMethod = 'stk500' | 'unsupported' | 'esp32';

export const FIRMWARE_BASE_URL = 'https://tonuino.github.io/TonUINO-TNG';
/** System announcements (mp3/ and advert/) matching the current firmware. */
export const SD_CARD_ZIP_URL = 'https://tonuino.github.io/TonUINO-TNG/sd-card.zip';

/**
 * CH340 driver downloads of the chip maker WCH. The official uploader pages
 * link the Chinese wch.cn pages over http; these are the English ones.
 */
export const CH340_DRIVER_URLS = {
  /** Installer CH341SER.EXE: start it and click "INSTALL". */
  windows: 'https://www.wch-ic.com/downloads/CH341SER_EXE.html',
  /** Only older macOS versions need it. */
  macos: 'https://www.wch-ic.com/downloads/CH34XSER_MAC_ZIP.html',
} as const;

export const VARIANTS: Record<ButtonVariant, { label: string; description: string }> = {
  '3': { label: '3 Tasten', description: 'Play/Pause, Vor und Zurück.' },
  '5': { label: '5 Tasten', description: 'Play/Pause, Vor, Zurück, Lauter und Leiser.' },
  '3x3': { label: '3×3-Tastenfeld', description: '3 Tasten plus ein Tastenfeld mit 9 Kurzwahltasten.' },
  '5f': {
    label: '5 Tasten mit allen Extras',
    description: '5 Tasten, dazu Quiz, Memory und Jukebox-Karte, je nach Platine auch LED-Ring und Kopfhörer-Erkennung.',
  },
};

export interface UsbId {
  vendorId: number;
  /** Missing: any product of this vendor. */
  productId?: number;
  /** USB-serial chip or device, e.g. "CH340". */
  chip: string;
}

export interface Stk500Params {
  /** Tried in this order. */
  baudRates: readonly number[];
  signature: readonly [number, number, number];
  pageSize: number;
  /** LOAD_ADDRESS takes byte addresses (optiboot_x on the ATmega4809). */
  byteAddressing: boolean;
  /** First address of the firmware (0x200 behind the AiO+ bootloader). */
  appStart: number;
  /** Largest firmware in bytes. */
  maxBytes: number;
  /**
   * More room behind a smaller bootloader, known by the baud rate it answers
   * at: a Nano with the new bootloader (Optiboot, 512 bytes, 115200 baud)
   * takes 32256 bytes instead of 30720 (Arduino AVR boards.txt, nano
   * atmega328 / atmega328old). Builds of the Firmware-Baukasten with the
   * light ring need it.
   */
  largerAt?: { baud: number; maxBytes: number };
}

/** The largest firmware a board can take with any of its bootloaders. */
export function largestFirmware(p: Stk500Params): number {
  return Math.max(p.maxBytes, p.largerAt?.maxBytes ?? 0);
}

/** Room for the firmware behind the bootloader that answered at `baud`. */
export function maxBytesAt(p: Stk500Params, baud: number): number {
  return p.largerAt && p.largerAt.baud === baud ? p.largerAt.maxBytes : p.maxBytes;
}

export interface Esp32Update {
  /** Update page of the box's own web interface (HTTP basic auth). */
  otaPath: string;
  otaUser: string;
  otaPassword: string;
  /** Wi-Fi the box opens when it cannot join the home network (open, or with the password set on its WLAN page). */
  apSsid: string;
  apUrl: string;
  /** Native USB DFU (Arduino Nano ESP32 only): dfu-util --device 2341:0070 -D firmware.bin. */
  dfu?: { vendorId: number; productId: number; hint: string };
  steps: string[];
}

interface BoardBase {
  id: BoardId;
  /** German display name. */
  name: string;
  shortName: string;
  description: string;
  mcu: string;
  /** PlatformIO environment prefix, e.g. "ALLinONE_Plus". */
  pioEnv: string;
  variants: readonly ButtonVariant[];
  usb: readonly UsbId[];
  /** Shown before flashing. */
  hints: readonly string[];
}

export interface Stk500Board extends BoardBase {
  method: 'stk500';
  flash: Stk500Params;
  /** Play/Pause must be held during the whole upload, or the board switches itself off. */
  holdPlayPause: boolean;
}

export interface UnsupportedBoard extends BoardBase {
  method: 'unsupported';
  reason: string;
  alternative: string;
}

export interface Esp32Board extends BoardBase {
  method: 'esp32';
  update: Esp32Update;
}

export type BoardInfo = Stk500Board | UnsupportedBoard | Esp32Board;

const CH340: UsbId = { vendorId: 0x1a86, productId: 0x7523, chip: 'CH340' };
const SIG_328P = [0x1e, 0x95, 0x0f] as const;
const SIG_4809 = [0x1e, 0x96, 0x51] as const;
const ALL: readonly ButtonVariant[] = ['3', '5', '3x3', '5f'];
const NO_FULL: readonly ButtonVariant[] = ['3', '5', '3x3'];

const HOLD_PLAY =
  'Halte die Play/Pause-Taste gedrückt, bevor du startest, und lasse sie erst los, wenn „Fertig“ erscheint. Sonst geht die Platine mittendrin aus.';

const EVERY_REASON =
  'Der Nano Every wird auf eine andere Art bespielt (über UPDI). Das kann ich noch nicht.';

// From TonUINO-TNG webservice.cpp: AP "TonUINO" at 192.168.4.1, optional AP
// password (at least 8 characters), "up" button at power-on forces the open AP,
// /upgrade behind basic auth admin/admin.
const esp32Steps = (dfu: boolean): string[] => [
  'Lade die passende Datei firmware.bin herunter.',
  'Öffne die Webseite der Box. Ist sie mit deinem WLAN verbunden, findest du ihre Adresse in deinem Router. Sonst öffnet sie ihr eigenes WLAN „TonUINO“: Verbinde dich damit und öffne http://192.168.4.1.',
  'Hast du das Passwort für das Box-WLAN vergessen, halte beim Einschalten die Taste „Vor“ gedrückt. Dann öffnet die Box ihr WLAN ohne Passwort.',
  'Öffne auf der Webseite der Box die Seite /upgrade, zum Beispiel http://192.168.4.1/upgrade. Benutzername und Passwort sind beide „admin“.',
  'Wähle dort die Datei firmware.bin aus und starte das Update. Die Box startet danach von selbst neu.',
  ...(dfu
    ? ['Ohne WLAN geht es per USB: Drücke die Reset-Taste zweimal kurz hintereinander, bis die LED grün leuchtet, und spiele die Datei mit dem Programm dfu-util auf.']
    : ['Ist noch keine TonUINO-Firmware auf der Box, spielst du sie einmalig mit PlatformIO oder der Arduino IDE auf.']),
];

export const BOARDS: readonly BoardInfo[] = [
  {
    id: 'classic',
    name: 'TonUINO Classic (Arduino Nano)',
    shortName: 'Classic',
    description: 'Selbst gebaute Box mit Arduino Nano, MP3-Modul und Kartenleser.',
    mcu: 'ATmega328P',
    pioEnv: 'TonUINO_Classic',
    variants: NO_FULL,
    method: 'stk500',
    flash: {
      // 57600: old Nano bootloader (the official web uploader uses only this).
      // 115200: new bootloader (Optiboot), where the web uploader fails with "receiveData timeout".
      baudRates: [57600, 115200],
      signature: SIG_328P,
      pageSize: 128,
      byteAddressing: false,
      appStart: 0,
      maxBytes: 30720,
      largerAt: { baud: 115200, maxBytes: 32256 },
    },
    holdPlayPause: false,
    usb: [CH340, { vendorId: 0x0403, productId: 0x6001, chip: 'FTDI FT232R' }, { vendorId: 0x2341, chip: 'Arduino' }],
    hints: [
      'Es gibt Nanos mit altem und mit neuem Startprogramm (Bootloader). TonUINO Studio probiert beide Geschwindigkeiten nacheinander.',
      'Unter Windows und auf älteren Macs brauchen Nano-Nachbauten mit CH340-Chip einmalig einen Treiber.',
    ],
  },
  {
    id: 'aio',
    name: 'All-in-One-Platine (AiO, Version 1)',
    shortName: 'AiO',
    description: 'Fertige Platine der Leiterkartenpiraten mit LGT8F328P.',
    mcu: 'LGT8F328P',
    pioEnv: 'ALLinONE',
    variants: NO_FULL,
    method: 'stk500',
    flash: {
      baudRates: [57600],
      // The LGT8F328P bootloader reports the ATmega328P signature.
      signature: SIG_328P,
      pageSize: 128,
      byteAddressing: false,
      appStart: 0,
      maxBytes: 29696,
    },
    holdPlayPause: true,
    // Port filter of the official aio_update.html.
    usb: [{ vendorId: 0x04d9, productId: 0xb534, chip: 'HT42B534' }],
    hints: [HOLD_PLAY],
  },
  {
    id: 'aioplus',
    name: 'All-in-One-Plus-Platine (AiO+, Version 2)',
    shortName: 'AiO+',
    description: 'Fertige Platine der Leiterkartenpiraten mit ATmega4809.',
    mcu: 'ATmega4809',
    pioEnv: 'ALLinONE_Plus',
    variants: ALL,
    method: 'stk500',
    flash: {
      baudRates: [115200],
      signature: SIG_4809,
      pageSize: 128,
      byteAddressing: true,
      // PlatformIO links with .text=0x200 when upload_protocol = arduino.
      appStart: 0x200,
      maxBytes: 48640,
    },
    holdPlayPause: true,
    usb: [CH340],
    hints: [HOLD_PLAY, 'Unter Windows und auf älteren Macs braucht der USB-Chip der AiO+ (CH340) einmalig einen Treiber.'],
  },
  {
    id: 'every',
    name: 'TonUINO Classic mit Arduino Nano Every',
    shortName: 'Nano Every',
    description: 'Classic-Aufbau mit dem Nano Every (ATmega4809).',
    mcu: 'ATmega4809',
    pioEnv: 'TonUINO_Every',
    variants: ALL,
    method: 'unsupported',
    reason: EVERY_REASON,
    alternative:
      'Spiele die Firmware mit der Arduino IDE, mit PlatformIO (Umgebung „TonUINO_Every_…“) oder mit dem Programm „TonUINO-TNG-Upload“ auf. SD-Karte und Karten richtest du danach ganz normal mit TonUINO Studio ein.',
    usb: [{ vendorId: 0x2341, productId: 0x0058, chip: 'Arduino Nano Every' }],
    hints: [EVERY_REASON],
  },
  {
    id: 'every4808',
    name: 'TonUINO Classic mit Nano Every 4808',
    shortName: 'Nano Every 4808',
    description: 'Classic-Aufbau mit einem Nano-Every-Nachbau mit ATmega4808.',
    mcu: 'ATmega4808',
    pioEnv: 'TonUINO_Every4808',
    variants: ALL,
    method: 'unsupported',
    reason: EVERY_REASON,
    alternative:
      'Spiele die Firmware mit der Arduino IDE, mit PlatformIO (Umgebung „TonUINO_Every4808_…“) oder mit dem Programm „TonUINO-TNG-Upload“ auf. SD-Karte und Karten richtest du danach ganz normal mit TonUINO Studio ein.',
    usb: [],
    hints: [EVERY_REASON],
  },
  {
    id: 'esp32nano',
    name: 'TonUINO mit Arduino Nano ESP32',
    shortName: 'ESP32 Nano',
    description: 'Classic-Aufbau mit dem Nano ESP32, mit WLAN und eigener Webseite.',
    mcu: 'ESP32-S3',
    pioEnv: 'TonUINO_Esp32',
    variants: ALL,
    method: 'esp32',
    update: {
      otaPath: '/upgrade',
      otaUser: 'admin',
      otaPassword: 'admin',
      apSsid: 'TonUINO',
      apUrl: 'http://192.168.4.1',
      dfu: {
        vendorId: 0x2341,
        productId: 0x0070,
        hint: 'Drücke die Reset-Taste zweimal kurz hintereinander, bis die LED grün leuchtet.',
      },
      steps: esp32Steps(true),
    },
    usb: [{ vendorId: 0x2341, productId: 0x0070, chip: 'Arduino Nano ESP32' }],
    hints: ['Die ESP32-Box aktualisierst du am einfachsten über ihre eigene Webseite im WLAN.'],
  },
  {
    id: 'esp32wroom',
    name: 'TonUINO mit ESP32-WROOM-32',
    shortName: 'ESP32 WROOM',
    description: 'Box mit ESP32-WROOM-32-Entwicklerboard, mit WLAN und eigener Webseite.',
    mcu: 'ESP32',
    pioEnv: 'TonUINO_Esp32_W',
    variants: ALL,
    method: 'esp32',
    update: {
      otaPath: '/upgrade',
      otaUser: 'admin',
      otaPassword: 'admin',
      apSsid: 'TonUINO',
      apUrl: 'http://192.168.4.1',
      steps: esp32Steps(false),
    },
    usb: [
      { vendorId: 0x10c4, productId: 0xea60, chip: 'CP2102' },
      { vendorId: 0x1a86, productId: 0x55d4, chip: 'CH9102' },
      CH340,
    ],
    hints: ['Die ESP32-Box aktualisierst du über ihre eigene Webseite im WLAN, nicht über das USB-Kabel.'],
  },
];

export function getBoard(id: BoardId): BoardInfo {
  const board = BOARDS.find((b) => b.id === id);
  if (!board) throw new RangeError(`unknown board ${String(id)}`);
  return board;
}

function resolve(board: BoardId | BoardInfo): BoardInfo {
  return typeof board === 'string' ? getBoard(board) : board;
}

export function boardSupportsVariant(board: BoardId | BoardInfo, variant: ButtonVariant): boolean {
  return resolve(board).variants.includes(variant);
}

/** Name of the build, e.g. "ALLinONE_Plus_5". */
export function firmwareEnv(board: BoardId | BoardInfo, variant: ButtonVariant): string {
  const b = resolve(board);
  if (!b.variants.includes(variant)) {
    throw new RangeError(`no ready-made build ${b.pioEnv}_${variant}: "${variant}" is not available for ${b.shortName}`);
  }
  return `${b.pioEnv}_${variant}`;
}

/** Download URL of the ready-made firmware (firmware.bin for ESP32 boards). */
export function firmwareUrl(board: BoardId | BoardInfo, variant: ButtonVariant): string {
  const b = resolve(board);
  return `${FIRMWARE_BASE_URL}/${firmwareEnv(b, variant)}/firmware.${b.method === 'esp32' ? 'bin' : 'hex'}`;
}

export interface FirmwareBuild {
  board: BoardId;
  variant: ButtonVariant;
  /** PlatformIO environment, e.g. "ALLinONE_Plus_5f". */
  env: string;
  url: string;
}

/** Every ready-made build (one per PlatformIO environment of TonUINO-TNG). */
export function firmwareBuilds(): FirmwareBuild[] {
  return BOARDS.flatMap((b) => b.variants.map((variant) => ({ board: b.id, variant, env: firmwareEnv(b, variant), url: firmwareUrl(b, variant) })));
}

/** File name for saving a download, e.g. "TonUINO_Classic_3.hex". */
export function firmwareFileName(board: BoardId | BoardInfo, variant: ButtonVariant): string {
  const b = resolve(board);
  return `${firmwareEnv(b, variant)}.${b.method === 'esp32' ? 'bin' : 'hex'}`;
}

/**
 * Boards that may sit behind a USB device. Exact vendor and product matches
 * come first; vendor-only entries (any Arduino) only count when nothing
 * matched exactly. Several results mean: ask the user.
 */
export function boardsForUsb(vendorId: number | undefined, productId?: number): BoardInfo[] {
  if (vendorId === undefined) return [];
  const exact = BOARDS.filter((b) => b.usb.some((u) => u.vendorId === vendorId && u.productId === productId));
  if (exact.length) return exact;
  return BOARDS.filter((b) => b.usb.some((u) => u.vendorId === vendorId && u.productId === undefined));
}

/** USB ids of WCH's CH340 and CH341, the chips the CH341SER driver is for. */
const CH34X_PRODUCTS = new Set([0x7523, 0x5523]);

/**
 * Whether the USB chip of a box is a CH340, the one that needs a driver
 * on Windows and older Macs. The port's USB ids decide when they are known:
 * an original Nano with FTDI or a CP210x adapter needs no CH340 driver.
 * Otherwise the board decides; without one the answer is yes, to be safe.
 */
export function usesCh340(port?: { usbVendorId?: number; usbProductId?: number }, board?: BoardId | BoardInfo): boolean {
  if (port?.usbVendorId !== undefined) {
    return port.usbVendorId === CH340.vendorId && (port.usbProductId === undefined || CH34X_PRODUCTS.has(port.usbProductId));
  }
  return board ? resolve(board).usb.some((u) => u.chip === 'CH340') : true;
}

/** Web Serial port filters for one board (empty when it has no known USB id). */
export function usbFiltersFor(board: BoardId | BoardInfo): { usbVendorId: number; usbProductId?: number }[] {
  return resolve(board).usb.map((u) => (u.productId === undefined ? { usbVendorId: u.vendorId } : { usbVendorId: u.vendorId, usbProductId: u.productId }));
}

export interface ChipGuess {
  chip: string;
  /** Boards that use this chip. */
  boards: BoardId[];
  /** Plain German, e.g. "Das sieht nach einer AiO+-Platine aus." */
  hint: string;
}

const SIGNATURES: { sig: readonly [number, number, number]; guess: ChipGuess }[] = [
  {
    sig: SIG_328P,
    guess: {
      chip: 'ATmega328P',
      boards: ['classic', 'aio'],
      hint: 'Das sieht nach einer Classic-Box mit Arduino Nano oder nach einer AiO-Platine (Version 1) aus.',
    },
  },
  { sig: SIG_4809, guess: { chip: 'ATmega4809', boards: ['aioplus', 'every'], hint: 'Das sieht nach einer AiO+-Platine aus.' } },
  { sig: [0x1e, 0x96, 0x50], guess: { chip: 'ATmega4808', boards: ['every4808'], hint: 'Das sieht nach einem Nano Every mit ATmega4808 aus.' } },
  {
    sig: [0x1e, 0x95, 0x14],
    guess: { chip: 'ATmega328', boards: [], hint: 'Das ist ein Nano mit ATmega328 ohne „P“. Die fertige Classic-Firmware ist für den ATmega328P gebaut.' },
  },
  {
    sig: [0x1e, 0x95, 0x16],
    guess: { chip: 'ATmega328PB', boards: [], hint: 'Das ist ein Nano-Nachbau mit ATmega328PB. Die fertige Classic-Firmware ist für den ATmega328P gebaut.' },
  },
  {
    sig: [0x1e, 0x94, 0x06],
    guess: { chip: 'ATmega168', boards: [], hint: 'Das ist ein älterer Nano mit ATmega168. Sein Speicher ist für TonUINO zu klein.' },
  },
  {
    sig: [0x1e, 0x94, 0x0b],
    guess: { chip: 'ATmega168P', boards: [], hint: 'Das ist ein älterer Nano mit ATmega168P. Sein Speicher ist für TonUINO zu klein.' },
  },
  { sig: [0x1e, 0x98, 0x01], guess: { chip: 'ATmega2560', boards: [], hint: 'Das ist ein Arduino Mega. Für ihn gibt es keine fertige TonUINO-Firmware.' } },
  { sig: [0x1e, 0x95, 0x87], guess: { chip: 'ATmega32U4', boards: [], hint: 'Das ist ein Arduino Leonardo oder Micro. Für ihn gibt es keine fertige TonUINO-Firmware.' } },
];

/** Explains a signature read from the bootloader, or null when it is unknown. */
export function signatureToChip(signature: ArrayLike<number>): ChipGuess | null {
  const hit = SIGNATURES.find((s) => s.sig.every((b, i) => signature[i] === b));
  return hit ? hit.guess : null;
}

/* ------------------------------------------------------------- shutdown */

/**
 * How a box switches itself off: with a plain switch or a power bank (no
 * shutdown board), with a Pololu power switch, or with a CubieKid board or
 * the carrier board ("Trägerplatine"), which want the shutdown pin the
 * other way round.
 */
export type ShutdownKind = 'switch' | 'pololu' | 'traeger' | 'unknown';

/**
 * Boards whose ready-made build drives a shutdown pin that boxes wire in
 * different ways. AiO and AiO+ have a fixed power circuit on the board, so
 * their build always fits; the Nano Every boards are not flashed by the app.
 */
const SHUTDOWN_ASKED: ReadonlySet<BoardId> = new Set<BoardId>(['classic', 'esp32nano', 'esp32wroom']);

/** Whether the wizard asks how the box switches off before it offers the ready-made build. */
export function askShutdown(board: BoardId | BoardInfo): boolean {
  return SHUTDOWN_ASKED.has(resolve(board).id);
}

/** Boards whose ready-made build drives the shutdown pin active-high (constants.hpp: TonUINO_Classic, TonUINO_Every, TonUINO_Every_4808 and TonUINO_Esp32 == 100). */
const HIGH_SHUTDOWN: ReadonlySet<BoardId> = new Set<BoardId>(['classic', 'every', 'every4808', 'esp32nano']);

/**
 * Whether the ready-made build switches this box off the right way.
 *
 * TonUINO-TNG constants.hpp (V3.3.3; changed in 3.3.2, Issue_292): Classic,
 * Every and ESP32 Nano drive the shutdown pin (D7) active-high, which is what
 * a Pololu switch needs, unless USE_TRAEGER_PLATINE_SHUTDOWN is set (then
 * active-low, for CubieKid and the carrier board). The ESP32 WROOM drives
 * pin 13 active-low unless USE_POLOLU_SHUTDOWN is set. The published builds
 * set neither define. With the wrong polarity the idle level of the pin
 * already means "off", so the box goes off right after it was switched on.
 * Check this again with every new TNG release.
 */
export function readyMadeShutdownFits(board: BoardId | BoardInfo, kind: ShutdownKind): boolean {
  const id = resolve(board).id;
  if (kind === 'traeger') return !HIGH_SHUTDOWN.has(id);
  if (kind === 'pololu') return id !== 'esp32wroom';
  return true;
}
