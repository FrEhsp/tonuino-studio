/**
 * Which way the web app takes to the card is decided by features alone:
 * folder access (Chrome, Edge), a folder chooser (Firefox, Safari), or
 * neither. Chrome and Edge must keep the full experience.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioBackend } from '../../src/platform/types';
import { createWebPlatform } from '../../src/platform/web/index';

interface Browser {
  /** showDirectoryPicker and showOpenFilePicker */
  fsa?: boolean;
  /** showSaveFilePicker */
  save?: boolean;
  /** navigator.serial */
  serial?: boolean;
  /** <input webkitdirectory> */
  folderInput?: boolean;
}

function browser(b: Browser) {
  const win: Record<string, unknown> = {};
  if (b.fsa) {
    win.showDirectoryPicker = () => undefined;
    win.showOpenFilePicker = () => undefined;
  }
  if (b.save) win.showSaveFilePicker = () => undefined;
  vi.stubGlobal('window', win);
  const nav: Record<string, unknown> = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' };
  if (b.serial) nav.serial = new EventTarget();
  vi.stubGlobal('navigator', nav);
  class Input {}
  if (b.folderInput !== false) Object.defineProperty(Input.prototype, 'webkitdirectory', { value: false, writable: true });
  vi.stubGlobal('HTMLInputElement', Input);
  // The drive list looks for remembered cards in IndexedDB, which Node lacks: it then finds none.
  vi.stubGlobal('IDBKeyRange', { bound: () => undefined });
  return createWebPlatform({} as AudioBackend);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the way to the card, by features', () => {
  it('Chrome and Edge: straight onto the card, no Paket, no Firefox hints', () => {
    const p = browser({ fsa: true, save: true, serial: true });
    expect(p.capabilities.sd).toBe(true);
    expect(p.capabilities.sdPackage).toBe(false);
    expect(p.cardSnapshot).toBeUndefined();
    expect(p.files.downloadsOnly).toBe(false);
    expect(p.capabilities.serial).toBe(true);
    expect(p.serial.mayAskForAddon).toBe(false);
  });

  it('Firefox from 151: the card through Pakete, USB with the add-on question', () => {
    const p = browser({ serial: true });
    expect(p.capabilities.sd).toBe(false);
    expect(p.capabilities.sdPackage).toBe(true);
    expect(p.cardSnapshot).toBeDefined();
    expect(p.files.downloadsOnly).toBe(true);
    expect(p.capabilities.serial).toBe(true);
    expect(p.serial.mayAskForAddon).toBe(true);
  });

  it('Safari and older Firefox: the card through Pakete, no USB', () => {
    const p = browser({});
    expect(p.capabilities.sdPackage).toBe(true);
    expect(p.cardSnapshot).toBeDefined();
    expect(p.capabilities.serial).toBe(false);
    expect(p.serial.mayAskForAddon).toBe(false);
  });

  it('a browser with neither: no card at all, and nothing pretends otherwise', () => {
    const p = browser({ folderInput: false });
    expect(p.capabilities.sd).toBe(false);
    expect(p.capabilities.sdPackage).toBe(false);
    expect(p.cardSnapshot).toBeUndefined();
  });

  it('never asks the browser for its name', () => {
    // A Firefox user agent in a browser with folder access still gets the direct way.
    const p = browser({ fsa: true, save: true });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0' });
    expect(p.capabilities.sd).toBe(true);
    const q = createWebPlatform({} as AudioBackend);
    expect(q.capabilities.sd).toBe(true);
    expect(q.capabilities.sdPackage).toBe(false);
  });
});
