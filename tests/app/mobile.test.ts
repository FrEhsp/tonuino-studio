import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, chooseCardMethod, resetSettings, settings } from '../../src/app/state';
import { cardMethodsFor, CARD_METHODS } from '../../src/features/settings/options';
import type { Platform } from '../../src/platform/types';

/** Only what boot() asks of the platform. */
function phone(mobile: boolean): Platform {
  return {
    mobile,
    volumes: {
      subscribe: (cb: (v: never[]) => void) => {
        cb([]);
        return () => undefined;
      },
    },
  } as unknown as Platform;
}

function storage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as Storage;
}

describe('the Android app writes cards with the phone', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers the phone first and no QR code for another phone', () => {
    expect(cardMethodsFor(false)).toBe(CARD_METHODS);
    const methods = cardMethodsFor(true);
    expect(methods.map((m) => m.value)).toEqual(['reader', 'box', 'wifi']);
    expect(methods[0].label).toBe('Mit diesem Handy');
    // A tablet is no „Handy“ (audit 0.4 #29).
    expect(cardMethodsFor(true, 'Tablet')[0]).toMatchObject({ label: 'Mit diesem Tablet', text: 'Halte die Karte an die Rückseite. Das Tablet schreibt sie selbst.' });
  });

  it('calls a device with a short side of 600 px or more a tablet, as Android does', async () => {
    const { handheldWord } = await import('../../src/app/device');
    vi.stubGlobal('screen', { width: 390, height: 844 });
    expect(handheldWord()).toBe('Handy');
    vi.stubGlobal('screen', { width: 1280, height: 800 });
    expect(handheldWord()).toBe('Tablet');
  });

  it('starts with the phone as the way to write, until the user picks another', () => {
    vi.stubGlobal('localStorage', storage());
    boot(phone(false));
    expect(settings.value.cardMethod).toBe('box');
    boot(phone(true));
    expect(settings.value.cardMethod).toBe('reader');
    chooseCardMethod('box');
    boot(phone(true));
    expect(settings.value.cardMethod).toBe('box');
    // Back to the defaults: on the phone that is the phone again.
    resetSettings();
    expect(settings.value.cardMethod).toBe('reader');
  });
});

describe('the Android app with its bridges does what the desktop app does', () => {
  const caps = (sd: boolean, serial: boolean) => ({ sd, serial, builtInMic: true }) as unknown as Platform['capabilities'];
  const android = (sd: boolean, serial: boolean, printing: boolean) =>
    ({ mobile: true, capabilities: caps(sd, serial), printPdf: printing ? async () => undefined : undefined }) as unknown as Platform;

  it('opens every page once the phone can reach the SD card, print and talk to the box', async () => {
    const { isComputerOnly, needsComputer } = await import('../../src/app/HandheldNotice');
    const full = android(true, true, true);
    for (const page of ['box', 'folder', 'add', 'stickers'] as const) expect(needsComputer(page, full)).toBe(false);
    // An APK without the bridges keeps the honest notice.
    const bare = android(false, false, false);
    for (const page of ['box', 'folder', 'add', 'stickers'] as const) expect(needsComputer(page, bare)).toBe(true);
    // The Werkstatt always opens: only its tools for the USB cable say they need a computer (audit 0.4 #28).
    expect(isComputerOnly('workshop')).toBe(false);
    // Each page asks for what it needs.
    expect(needsComputer('stickers', android(true, true, false))).toBe(true);
    expect(needsComputer('add', android(true, false, false))).toBe(false);
    // Not the Android app: never.
    expect(needsComputer('box', { ...bare, mobile: false } as Platform)).toBe(false);
  });

  it('prints through the phone’s print service, never through the WebView’s empty window.print', async () => {
    const { printWay } = await import('../../src/features/stickers/print');
    vi.stubGlobal('window', { print: () => undefined });
    expect(printWay(android(true, true, true))).toBe('pdf');
    expect(printWay(android(true, true, false))).toBeNull();
    expect(printWay({ mobile: false } as Platform)).toBe('dialog');
  });

  it('offers recording on a device with its own microphone without the switch', async () => {
    const { platform, recordingOffered } = await import('../../src/app/state');
    vi.stubGlobal('localStorage', storage());
    resetSettings();
    platform.value = { capabilities: { builtInMic: false } } as Platform;
    expect(recordingOffered()).toBe(false);
    platform.value = { capabilities: { builtInMic: true } } as Platform;
    expect(recordingOffered()).toBe(true);
    platform.value = null;
  });

  it('says where the microphone is allowed, on the phone in the app’s permissions', async () => {
    const { micDenied, micProblem } = await import('../../src/features/add/RecordDialog');
    const denied = new DOMException('no', 'NotAllowedError');
    expect(micDenied(denied)).toBe(true);
    expect(micProblem(denied, 'phone')).toMatch(/Berechtigungen der App/);
    expect(micProblem(denied, 'desktop')).toMatch(/Einstellungen deines Computers/);
    expect(micProblem(new DOMException('busy', 'NotReadableError'), 'phone')).toMatch(/anderen App/);
    expect(micDenied(new DOMException('gone', 'NotFoundError'))).toBe(false);
  });

  it('helps with the box at the phone instead of drivers for Windows and Linux', async () => {
    const { chooserMissHint, usbHelp } = await import('../../src/features/workshop/usbhelp');
    const help = usbHelp({ os: 'other', kind: 'desktop', serialSupported: true, canSetupAccess: false, phone: true });
    expect(help.sections.map((s) => s.id)).toEqual(['otg', 'allow', 'chip', 'power', 'cable']);
    expect(help.later).toEqual([]);
    expect(JSON.stringify(help)).not.toMatch(/Windows|Treiber|udev/);
    expect(chooserMissHint({ os: 'other', filtered: false, ch340: true, desktop: true, phone: true }).lines.join(' ')).toMatch(/OTG/);
  });

  it('tells to plug the box and the card in at the phone', async () => {
    const { platform } = await import('../../src/app/state');
    const { cardIntoDevice, theDevice, toDevice } = await import('../../src/app/device');
    platform.value = { mobile: true } as Platform;
    expect([theDevice(), toDevice(), cardIntoDevice()]).toEqual(['das Handy', 'ans Handy', 'in einen SD-Kartenleser am Handy']);
    platform.value = { mobile: false } as Platform;
    expect([theDevice(), toDevice(), cardIntoDevice()]).toEqual(['der Computer', 'an den Computer', 'in den Computer']);
    platform.value = null;
  });
});

describe('the Android app opens at the cards', () => {
  it('marks „Musik“ with a dot while an SD card waits there, until it is opened', async () => {
    // A test above leaves a made-up window behind.
    vi.unstubAllGlobals();
    const { card, platform } = await import('../../src/app/state');
    const { route } = await import('../../src/app/router');
    const { cardWaits } = await import('../../src/app/Kopf');
    const sd = (id: string) => ({ status: 'ready', volume: { id } }) as unknown as NonNullable<typeof card.value>;
    route.value = { page: 'karte' };
    platform.value = { mobile: true } as Platform;
    card.value = sd('leser-1');
    expect(cardWaits.value).toBe(true);
    route.value = { page: 'musik' };
    expect(cardWaits.value).toBe(false);
    // Back at the cards, the same card has been seen.
    route.value = { page: 'karte' };
    expect(cardWaits.value).toBe(false);
    // Another card comes: the dot again; Meine Box counts as seen too.
    card.value = sd('leser-2');
    expect(cardWaits.value).toBe(true);
    route.value = { page: 'box' };
    expect(cardWaits.value).toBe(false);
    // The computer starts at the music anyway: never a dot.
    card.value = sd('leser-3');
    platform.value = { mobile: false } as Platform;
    expect(cardWaits.value).toBe(false);
    card.value = null;
    platform.value = null;
  });
});
