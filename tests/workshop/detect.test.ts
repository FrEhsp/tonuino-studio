import { describe, expect, it } from 'vitest';
import { probeBox, type ProbeOptions } from '../../src/features/workshop/detect';
import { AIOPLUS_BROKEN_LOG, CH340_PORT, CLASSIC_LOG, FakeSerial, until } from './fakes';

/** Short waits; the restart's pauses are skipped. */
const FAST: ProbeOptions = { timeoutMs: 2000, quietMs: 1000, monitor: { readSliceMs: 5, sleep: async () => undefined } };

const RESTART = [
  { dtr: false, rts: false },
  { dtr: false, rts: true },
  { dtr: true, rts: true },
];

describe('Box erkennen', () => {
  it('reads board, buttons and version from the start of the box', async () => {
    const serial = new FakeSerial();
    const probing = probeBox(serial, CH340_PORT, FAST);
    await until(() => serial.connections.length === 1);
    serial.last.send(CLASSIC_LOG);
    const { info, heard } = await probing;
    expect(heard).toBe(true);
    expect(info).toMatchObject({ board: 'classic', buttons: '3', firmware: 'tng', version: '3.3.3', versionDate: '2026-09-17' });
    // It answered on its own, so it was not restarted.
    expect(serial.last.signals).toEqual([]);
    expect(serial.last.closed).toBe(true);
    expect(serial.last.baudRate).toBe(115200);
  });

  it('restarts a quiet box once', async () => {
    const serial = new FakeSerial();
    const probing = probeBox(serial, CH340_PORT, { ...FAST, quietMs: 20 });
    await until(() => serial.connections.length === 1 && serial.last.signals.length === 3);
    serial.last.send(AIOPLUS_BROKEN_LOG);
    const { info } = await probing;
    expect(info).toMatchObject({ board: 'aioplus', buttons: '5' });
    expect(serial.last.signals).toEqual(RESTART);
    expect(serial.last.closed).toBe(true);
  });

  it('gives up on a box that stays silent', async () => {
    const serial = new FakeSerial();
    const { info, heard } = await probeBox(serial, CH340_PORT, { ...FAST, timeoutMs: 120, quietMs: 20 });
    expect(heard).toBe(false);
    expect(info.board).toBeUndefined();
    expect(serial.last.signals).toEqual(RESTART);
    expect(serial.last.closed).toBe(true);
  });

  it('notices a box that talks, but names no board', async () => {
    const serial = new FakeSerial();
    const probing = probeBox(serial, CH340_PORT, { ...FAST, timeoutMs: 150 });
    await until(() => serial.connections.length === 1);
    // Another firmware, or the wrong speed.
    serial.last.send('ðþ hello\r\n');
    const { info, heard } = await probing;
    expect(heard).toBe(true);
    expect(info.board).toBeUndefined();
    // Something came, so it was not restarted.
    expect(serial.last.signals).toEqual([]);
  });

  it('ends when the cable is pulled or the user stops it', async () => {
    const serial = new FakeSerial();
    const probing = probeBox(serial, CH340_PORT, FAST);
    await until(() => serial.connections.length === 1);
    serial.last.unplug();
    const started = Date.now();
    expect((await probing).heard).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);

    const abort = new AbortController();
    const stopped = probeBox(serial, CH340_PORT, { ...FAST, signal: abort.signal });
    await until(() => serial.connections.length === 2);
    abort.abort();
    expect((await stopped).info.board).toBeUndefined();
    expect(serial.last.closed).toBe(true);
  });

  it('rejects with the platform error when the port does not open', async () => {
    const serial = new FakeSerial();
    const busy = Object.assign(new Error('Der Anschluss ist belegt.'), { code: 'busy' });
    serial.openError = busy;
    await expect(probeBox(serial, CH340_PORT, FAST)).rejects.toBe(busy);
  });
});
