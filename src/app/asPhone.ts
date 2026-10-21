/**
 * Dev and bench builds only (main.tsx loads this behind `import.meta.env.DEV`
 * or VITE_BENCH_HANDY=1): "?als=handy" in the address shows the web app as
 * the Android app, so its layout can be looked at and photographed in any
 * browser (scripts/bench/shots.mjs with SHOT_QUERY=?als=handy). There is no
 * Android SDK on the build machines, and the layout of the phone app is
 * decided by `mobile`, `handheld` and the capabilities alone.
 *
 * The SD card stays the browser's (the made-up card of the bench). The
 * phone's NFC is on and no card is ever held to it.
 */
import type { NfcAccess, Platform } from '../platform/types';

/** The phone's reader, always on, never with a card: enough for the cards page to show its phone side. */
const quietPhoneNfc: NfcAccess = {
  supported: true,
  phone: true,
  listReaders: async () => ['Handy'],
  waitForCard: (_reader, timeoutMs) => new Promise((resolve) => setTimeout(() => resolve(null), Math.min(timeoutMs, 60_000))),
  read: async () => {
    throw new Error('Keine Karte am Handy.');
  },
  write: async () => {
    throw new Error('Keine Karte am Handy.');
  },
  openSettings: () => undefined,
  onStateChange: () => () => undefined,
  onTap: () => () => undefined,
};

/**
 * "&karte=belegt": a card that already holds folder 12 (Album) lies on the reader and stays there,
 * so the question before overwriting it can be looked at (src/features/cards/readerRun.ts).
 * Writing it works; the card then holds the new content.
 */
function cardOnReader(phone: boolean): NfcAccess {
  let data: Uint8Array = new Uint8Array([0x13, 0x37, 0xb3, 0x47, 0x02, 12, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const card = { uid: '04A1B2C3D4E5F6', type: 'ntag215' as const };
  return {
    ...quietPhoneNfc,
    phone,
    listReaders: async () => [phone ? 'Handy' : 'ACS ACR122U'],
    waitForCard: () => new Promise((resolve) => setTimeout(() => resolve(card), 600)),
    read: async () => ({ ...card, data }),
    write: async (_reader, bytes) => {
      data = bytes.slice();
    },
  };
}

function fakeNfc(phone: boolean): NfcAccess {
  return new URLSearchParams(location.search).get('karte') === 'belegt' ? cardOnReader(phone) : { ...quietPhoneNfc, phone };
}

/** "?als=leser": the web app with a USB card reader as in the desktop app, for the cards page on a computer. */
export function asReaderApp(p: Platform): Platform {
  return { ...p, nfc: fakeNfc(false), capabilities: { ...p.capabilities, nfcReader: true } };
}

export function asPhoneApp(p: Platform): Platform {
  // The window stands for the whole made-up device: its screen is the window, so a 390 px picture shows a
  // phone and an 800 px one a tablet (handheldWord), whatever display the bench browser runs on.
  try {
    Object.defineProperty(screen, 'width', { get: () => window.innerWidth, configurable: true });
    Object.defineProperty(screen, 'height', { get: () => window.innerHeight, configurable: true });
  } catch {
    // A browser that keeps its screen: the word then follows the real display.
  }
  return {
    ...p,
    kind: 'desktop',
    os: 'other',
    mobile: true,
    handheld: true,
    nfc: fakeNfc(true),
    // The phone prints through its own print dialog; here the PDF is saved like any file.
    printPdf: async (name, pdf) => {
      await p.files.save(name, pdf);
    },
    capabilities: { ...p.capabilities, nfcReader: true, wifiBox: true, builtInMic: true, sdPackage: false },
  };
}
