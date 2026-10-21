/**
 * Phones and tablets get "Bitte am Computer öffnen" instead of the Paket
 * mode that their folder chooser would otherwise switch on. Computers keep
 * what their browser can do, also in a narrow window or with a touch screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioBackend } from '../../src/platform/types';
import { isHandheld, type DeviceHints } from '../../src/platform/web/handheld';
import { createWebPlatform } from '../../src/platform/web/index';

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:151.0) Gecko/151.0 Firefox/151.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  // iPadOS Safari asks for desktop sites and says "Macintosh".
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
};

const computer: DeviceHints = { userAgent: UA.linuxFirefox, maxTouchPoints: 0, touchOnly: false, screenLongSide: 1920 };
const hints = (h: Partial<DeviceHints>): DeviceHints => ({ ...computer, ...h });

describe('phone or tablet', () => {
  it('knows phones and tablets by their system', () => {
    expect(isHandheld(hints({ userAgent: UA.androidChrome, touchOnly: true, screenLongSide: 915 }))).toBe(true);
    expect(isHandheld(hints({ userAgent: UA.androidFirefox, touchOnly: true, screenLongSide: 915 }))).toBe(true);
    expect(isHandheld(hints({ userAgent: UA.androidTablet, touchOnly: true, screenLongSide: 1280 }))).toBe(true);
    expect(isHandheld(hints({ userAgent: UA.iphone, maxTouchPoints: 5, touchOnly: true, screenLongSide: 844 }))).toBe(true);
    expect(isHandheld(hints({ userAgent: UA.ipad, maxTouchPoints: 5, touchOnly: true, screenLongSide: 1180 }))).toBe(true);
    // Chromium says so itself.
    expect(isHandheld(hints({ userAgent: UA.linuxFirefox, mobileHint: true }))).toBe(true);
  });

  it('knows an Android tablet that asks for the desktop site by its touch screen', () => {
    expect(isHandheld(hints({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36', touchOnly: true, screenLongSide: 1280 }))).toBe(true);
  });

  it('leaves computers alone, also in a narrow window or with a touch screen', () => {
    expect(isHandheld(computer)).toBe(false);
    expect(isHandheld(hints({ userAgent: UA.macSafari }))).toBe(false);
    expect(isHandheld(hints({ userAgent: UA.macFirefox }))).toBe(false);
    expect(isHandheld(hints({ userAgent: UA.windowsFirefox, maxTouchPoints: 10 }))).toBe(false);
    // A Windows tablet without keyboard still has a card reader and a real Firefox.
    expect(isHandheld(hints({ userAgent: UA.windowsFirefox, maxTouchPoints: 10, touchOnly: true, screenLongSide: 1200 }))).toBe(false);
    expect(isHandheld(hints({ userAgent: UA.chromebook, touchOnly: true, screenLongSide: 1280 }))).toBe(false);
    // A Linux laptop with a touch screen has a touchpad too; a big touch screen is no tablet.
    expect(isHandheld(hints({ maxTouchPoints: 10 }))).toBe(false);
    expect(isHandheld(hints({ touchOnly: true, screenLongSide: 2560 }))).toBe(false);
    expect(isHandheld(hints({ mobileHint: false }))).toBe(false);
  });
});

describe('the platform on a phone', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function browserWithFolderChooser(fsa: boolean) {
    vi.stubGlobal('window', fsa ? { showDirectoryPicker: () => undefined, showOpenFilePicker: () => undefined } : {});
    vi.stubGlobal('navigator', { userAgent: UA.androidChrome, serial: new EventTarget() });
    class Input {}
    Object.defineProperty(Input.prototype, 'webkitdirectory', { value: false, writable: true });
    vi.stubGlobal('HTMLInputElement', Input);
    vi.stubGlobal('IDBKeyRange', { bound: () => undefined });
  }

  it('offers no Paket mode, no card and no USB, and says it is a phone', async () => {
    browserWithFolderChooser(false);
    const p = createWebPlatform({} as AudioBackend, hints({ userAgent: UA.androidChrome, touchOnly: true, screenLongSide: 915 }));
    expect(p.handheld).toBe(true);
    expect(p.capabilities).toMatchObject({ sd: false, sdPackage: false, serial: false });
    expect(p.cardSnapshot).toBeUndefined();
    const seen: unknown[] = [];
    p.volumes.subscribe((list) => seen.push(list));
    expect(seen).toEqual([[]]);
    expect(await p.volumes.pick()).toBeNull();
  });

  it('does not open a card directly either, even where the browser could', () => {
    browserWithFolderChooser(true);
    const p = createWebPlatform({} as AudioBackend, hints({ userAgent: UA.androidChrome, touchOnly: true, screenLongSide: 915 }));
    expect(p.capabilities).toMatchObject({ sd: false, sdPackage: false });
  });

  it('keeps the Paket mode of Firefox and Safari on a computer', () => {
    browserWithFolderChooser(false);
    const p = createWebPlatform({} as AudioBackend, hints({ userAgent: UA.macSafari }));
    expect(p.handheld).toBeUndefined();
    expect(p.capabilities.sdPackage).toBe(true);
    expect(p.cardSnapshot).toBeDefined();
  });
});
