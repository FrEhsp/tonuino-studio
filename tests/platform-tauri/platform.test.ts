import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFrame, f32FromBytes, deinterleave } from '../../src/platform/tauri/binary';
import { detectOs } from '../../src/platform/tauri/bridge';
import { messageFor, toPlatformError, TauriPlatformError } from '../../src/platform/tauri/errors';
import { createTauriPlatform, isTauri } from '../../src/platform/tauri';
import { FakeIpc, f32Bytes, fakeBridge, frame } from './fake-ipc';
import { TauriSerial } from '../../src/platform/tauri/serial';
import { TauriNfc } from '../../src/platform/tauri/nfc';

describe('binary frames', () => {
  it('parses TSB1 frames with an aligned payload for every header length', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd']) {
      const { header, payload } = parseFrame<{ t: string }>(frame({ t: text }, f32Bytes([1.5, -2])));
      expect(header.t).toBe(text);
      expect(payload.byteOffset % 4).toBe(0);
      expect(Array.from(f32FromBytes(payload))).toEqual([1.5, -2]);
    }
    expect(() => parseFrame(new Uint8Array([1, 2, 3]))).toThrow(TypeError);
  });

  it('reads unaligned little-endian floats and splits channels', () => {
    const bytes = new Uint8Array(9);
    bytes.set(f32Bytes([0.25, -1]), 1);
    expect(Array.from(f32FromBytes(bytes.subarray(1)))).toEqual([0.25, -1]);
    const [l, r] = deinterleave(new Float32Array([1, 2, 3, 4, 5, 6]), 2);
    expect([Array.from(l), Array.from(r)]).toEqual([
      [1, 3, 5],
      [2, 4, 6],
    ]);
  });
});

describe('errors', () => {
  it('turns backend codes into German messages with hints', () => {
    const e = toPlatformError({ code: 'pcsc-unavailable', detail: 'context: service not available', hints: ['linux-install-pcscd', 'linux-blacklist-pn533'] }, 'nfc');
    expect(e).toBeInstanceOf(TauriPlatformError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('pcsc-unavailable');
    expect(e.message).toMatch(/NFC-Leser/);
    expect(e.hints.map((h) => h.id)).toEqual(['linux-install-pcscd', 'linux-blacklist-pn533']);
    expect(e.hints[0].command).toBe('sudo apt install pcscd libacsccid1');
    expect(e.hints[1].command).toMatch(/blacklist pn533_usb/);
  });

  it('falls back to generic messages and wraps foreign errors', () => {
    expect(messageFor('busy', 'nfc')).toMatch(/NFC-Leser/);
    expect(messageFor('busy', 'audio')).toMatch(/anderen Programm/);
    expect(messageFor('weird-code', 'fs')).toMatch(/schiefgelaufen/);
    const e = toPlatformError('IPC failed', 'serial');
    expect(e).toMatchObject({ code: 'other', detail: 'IPC failed' });
    expect(toPlatformError({ code: 'cancelled' }, 'audio').name).toBe('AbortError');
  });

  it('says why an audio file cannot be opened', () => {
    expect(toPlatformError({ code: 'drm-protected', detail: '/x/buch.m4b: copy protected' }, 'audio').message).toMatch(/kopiergeschützt/);
    expect(messageFor('unsupported-format', 'audio')).toMatch(/Audioformat/);
  });
});

describe('serial and nfc', () => {
  it('writes raw bytes with the handle in a header and never fails on read timeouts', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('serial_list', () => [
      { id: '/dev/ttyUSB0', label: 'USB-Serial CH340 (ttyUSB0)', path: '/dev/ttyUSB0', usbVendorId: 0x1a86, usbProductId: 0x7523, manufacturer: null, product: 'USB Serial', serialNumber: null },
    ]);
    ipc.on('serial_open', () => ({ handle: 3, path: '/dev/ttyUSB0', baudRate: 115200 }));
    ipc.on('serial_write', () => null);
    ipc.on('serial_read', () => new ArrayBuffer(0));
    ipc.on('serial_set_signals', () => null);
    ipc.on('serial_close', () => null);
    const serial = new TauriSerial(bridge);
    const [port] = await serial.list();
    expect(port).toEqual({ id: '/dev/ttyUSB0', label: 'USB-Serial CH340 (ttyUSB0)', path: '/dev/ttyUSB0', usbVendorId: 0x1a86, usbProductId: 0x7523, product: 'USB Serial' });
    const conn = await serial.open(port, 115200);
    await conn.write(new Uint8Array([0x30, 0x20]));
    expect(ipc.callsOf('serial_write')[0]).toEqual({ cmd: 'serial_write', args: new Uint8Array([0x30, 0x20]), headers: { 'x-handle': '3' } });
    expect(await conn.read(50)).toEqual(new Uint8Array(0));
    expect(ipc.callsOf('serial_read')[0].args).toEqual({ handle: 3, timeoutMs: 50, maxBytes: 4096 });
    await conn.setSignals({ dtr: false });
    expect(ipc.callsOf('serial_set_signals')[0].args).toEqual({ handle: 3, dtr: false, rts: undefined });
    await conn.close();
    await expect(conn.write(new Uint8Array([1]))).rejects.toMatchObject({ code: 'closed' });
  });

  it('maps a missing serial permission to the USB setup message', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('serial_open', () => {
      throw { code: 'permission', detail: '/dev/ttyUSB0: Permission denied' };
    });
    const err = await new TauriSerial(bridge).open({ id: '/dev/ttyUSB0', label: 'x' }, 57600).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'permission' });
    expect((err as Error).message).toMatch(/USB-Zugriff einmalig/);
  });

  it('reads and writes the 16 TonUINO bytes', async () => {
    const { ipc, bridge } = fakeBridge();
    const bytes = [0x13, 0x37, 0xb3, 0x47, 2, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    ipc.on('nfc_read', () => ({ uid: '04:A2:3B:12', cardType: 'mifare-classic-1k', atr: '3B 8F 80 01', data: bytes }));
    ipc.on('nfc_write', () => ({ uid: '04:A2:3B:12', cardType: 'mifare-classic-1k', atr: '' }));
    ipc.on('nfc_wait_card', () => null);
    const nfc = new TauriNfc(bridge);
    const r = await nfc.read('ACS ACR122U PICC Interface 00 00');
    expect(r).toEqual({ uid: '04:A2:3B:12', type: 'mifare-classic-1k', details: 'ATR 3B 8F 80 01', data: Uint8Array.from(bytes) });
    await nfc.write('ACS ACR122U PICC Interface 00 00', Uint8Array.from(bytes));
    expect(ipc.callsOf('nfc_write')[0].args).toEqual({ reader: 'ACS ACR122U PICC Interface 00 00', data: bytes });
    await expect(nfc.write('r', new Uint8Array(4))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(await nfc.waitForCard('r', 99_999_999)).toBeNull();
    expect(ipc.callsOf('nfc_wait_card')[0].args).toEqual({ reader: 'r', timeoutMs: 600_000 });
  });
});

describe('createTauriPlatform', () => {
  it('implements the Platform with desktop capabilities', async () => {
    const ipc = new FakeIpc();
    ipc.on('open_external', () => null);
    ipc.on('dialog_save', () => '/home/anna/Sticker.pdf');
    ipc.on('fs_write', () => null);
    const p = createTauriPlatform({ ipc, os: 'linux' });
    expect(p.kind).toBe('desktop');
    expect(p.os).toBe('linux');
    expect(p.capabilities).toEqual({ sd: true, sdPackage: false, sdAutoDetect: true, eject: true, fsDetails: true, serial: true, nfcReader: true, wifiBox: true, builtInMic: false });
    expect(p.serial.supported && p.nfc.supported).toBe(true);
    await p.openExternal('https://www.tonuino.de');
    expect(ipc.callsOf('open_external')[0].args).toEqual({ url: 'https://www.tonuino.de' });
    expect(await p.files.save('Sticker.pdf', new Blob(['%PDF']))).toBe(true);
    expect(ipc.callsOf('fs_write')[0].headers).toEqual({ 'x-path': encodeURIComponent('/home/anna/Sticker.pdf') });
    ipc.on('dialog_save', () => null);
    expect(await p.files.save('Sticker.pdf', new Blob(['%PDF']))).toBe(false);
    expect(typeof p.onFileDrop).toBe('function');
  });

  it('gives the window frame the theme of the app, which the app may set', async () => {
    const ipc = new FakeIpc();
    ipc.on('plugin:window|set_theme', () => null);
    const p = createTauriPlatform({ ipc, os: 'windows' });
    await p.setWindowTheme?.('dark');
    await p.setWindowTheme?.(null);
    expect(ipc.callsOf('plugin:window|set_theme').map((c) => c.args)).toEqual([
      { label: 'main', value: 'dark' },
      { label: 'main', value: null },
    ]);
    // Tauri refuses the command unless the app's capabilities allow it.
    const capabilities = JSON.parse(readFileSync(fileURLToPath(new URL('../../src-tauri/capabilities/default.json', import.meta.url)), 'utf8')) as { windows: string[]; permissions: string[] };
    expect(capabilities.permissions).toContain('core:window:allow-set-theme');
    expect(capabilities.windows).toContain('main');
    const conf = JSON.parse(readFileSync(fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url)), 'utf8')) as { app: { windows: { label?: string }[] } };
    expect(conf.app.windows.map((w) => w.label)).toEqual(['main']);
  });

  it('detects the desktop runtime and OS', () => {
    expect(isTauri()).toBe(false);
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe('linux');
    expect(detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/129.0')).toBe('windows');
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('macos');
  });
});
