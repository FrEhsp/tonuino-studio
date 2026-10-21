import { describe, expect, it } from 'vitest';
import { getBoard } from '../../src/core/firmware/variants';
import { desktopSerial, needsChooser, portDetail, portFits, portForRetry, preselectPort, rankPorts, suggestBoards } from '../../src/features/workshop/ports';
import type { SerialPortInfo } from '../../src/platform/types';
import { AIO_PORT, BUILTIN_PORT, CH340_PORT, CP2102_PORT, FakeSerial } from './fakes';

describe('board suggestions from USB ids', () => {
  it('names every board with a CH340, and the AiO by its own chip', () => {
    expect(suggestBoards([])).toEqual({ boards: [], ports: [] });
    expect(suggestBoards([CH340_PORT]).boards).toEqual(['classic', 'aioplus', 'esp32wroom']);
    expect(suggestBoards([AIO_PORT])).toEqual({ boards: ['aio'], ports: [AIO_PORT] });
    expect(suggestBoards([BUILTIN_PORT]).boards).toEqual([]);
  });

  it('joins several devices in the order of the board list', () => {
    const s = suggestBoards([CP2102_PORT, BUILTIN_PORT, AIO_PORT]);
    expect(s.boards).toEqual(['aio', 'esp32wroom']);
    expect(s.ports).toEqual([CP2102_PORT, AIO_PORT]);
  });

  it('does not take a Nano Every for a Classic Nano although both are Arduino', () => {
    const every = { id: 'e', label: 'Nano Every', usbVendorId: 0x2341, usbProductId: 0x0058 };
    const uno = { id: 'u', label: 'Arduino', usbVendorId: 0x2341, usbProductId: 0x0043 };
    expect(portFits(every, getBoard('classic'))).toBe(false);
    expect(portFits(every, getBoard('every'))).toBe(true);
    expect(portFits(uno, getBoard('classic'))).toBe(true);
  });
});

describe('port for another try', () => {
  const classic = getBoard('classic');
  const replugged = { ...CH340_PORT, id: 'web-serial-7' };

  it('keeps the port while it is there', () => {
    expect(portForRetry([AIO_PORT, CH340_PORT], CH340_PORT, classic)).toBe(CH340_PORT);
  });

  it('finds the box under its new port after a pulled cable', () => {
    expect(portForRetry([BUILTIN_PORT, replugged], CH340_PORT, classic)).toBe(replugged);
    // An unknown USB chip the user chose on purpose: the same ids find it again.
    const odd = { id: 'COM9', label: 'USB-Serial', usbVendorId: 0x067b, usbProductId: 0x2303 };
    expect(portForRetry([{ ...odd, id: 'COM10' }], odd, classic)?.id).toBe('COM10');
  });

  it('asks when the box is not there or it is not clear which one it is', () => {
    // A CH340 without serial number needs the browser's chooser again after replugging.
    expect(portForRetry([], CH340_PORT, classic)).toBeUndefined();
    expect(portForRetry([BUILTIN_PORT], CH340_PORT, classic)).toBeUndefined();
    expect(portForRetry([replugged, { ...CH340_PORT, id: 'web-serial-8' }], CH340_PORT, classic)).toBeUndefined();
  });
});

describe('port choice', () => {
  it('puts fitting devices first, then other USB devices, then built-in ports', () => {
    const ranked = rankPorts([BUILTIN_PORT, CP2102_PORT, CH340_PORT, AIO_PORT], getBoard('classic'));
    expect(ranked.map((r) => [r.port.id, r.fits])).toEqual([
      ['/dev/ttyUSB0', true],
      ['COM5', false],
      ['COM4', false],
      ['COM1', false],
    ]);
  });

  it('without a board, ranks devices of any TonUINO board first', () => {
    const unknown: SerialPortInfo = { id: 'COM7', label: 'USB Serial Device (COM7)', usbVendorId: 0x1234, usbProductId: 0x0001 };
    const ranked = rankPorts([BUILTIN_PORT, unknown, AIO_PORT, CP2102_PORT]);
    expect(ranked.map((r) => [r.port.id, r.fits])).toEqual([
      ['COM4', true],
      ['COM5', true],
      ['COM7', false],
      ['COM1', false],
    ]);
    expect(preselectPort(rankPorts([BUILTIN_PORT, unknown, AIO_PORT]))).toEqual(AIO_PORT);
  });

  it('preselects the previous port, the only fitting one or the only USB device', () => {
    const classic = getBoard('classic');
    const both = rankPorts([CH340_PORT, AIO_PORT], classic);
    expect(preselectPort(both)).toEqual(CH340_PORT);
    expect(preselectPort(both, 'COM4')).toEqual(AIO_PORT);
    expect(preselectPort(both, 'gone')).toEqual(CH340_PORT);

    const twoFitting = rankPorts([CH340_PORT, { ...CH340_PORT, id: '/dev/ttyUSB1', path: '/dev/ttyUSB1' }], classic);
    expect(preselectPort(twoFitting)).toBeUndefined();

    expect(preselectPort(rankPorts([BUILTIN_PORT, CP2102_PORT], classic))).toEqual(CP2102_PORT);
    expect(preselectPort(rankPorts([BUILTIN_PORT], classic))).toBeUndefined();
    expect(preselectPort([])).toBeUndefined();
  });

  it('describes a port in small print', () => {
    expect(portDetail(CH340_PORT)).toBe('/dev/ttyUSB0 · USB 1a86:7523');
    expect(portDetail({ id: 'web-serial-1', label: 'USB-Seriell (CH340)', usbVendorId: 0x1a86 })).toBe('USB 1a86:????');
    expect(portDetail(BUILTIN_PORT)).toBe('COM1');
  });

  it('finds the desktop extras and the browser chooser', () => {
    const plain = new FakeSerial();
    expect(desktopSerial(plain)).toBeNull();
    expect(needsChooser(plain)).toBe(false);
    const desktop = Object.assign(new FakeSerial(), { diagnose: async () => [], setupAccess: async () => undefined });
    expect(desktopSerial(desktop)).toBe(desktop);
    const web = Object.assign(new FakeSerial(), { request: async () => null });
    expect(needsChooser(web)).toBe(true);
  });
});
