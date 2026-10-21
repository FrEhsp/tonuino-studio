import { describe, expect, it } from 'vitest';
import { judgeSettings, readStartSettings, type ReadStartOptions, type StartRead } from '../../src/features/workshop/aftercheck';
import { AIOPLUS_BROKEN_LOG, CH340_PORT, CLASSIC_LOG, FakeSerial, until } from './fakes';

const FAST: ReadStartOptions = { timeoutMs: 1500, settledMs: 200, monitor: { readSliceMs: 5, sleep: async () => undefined } };

const read = (settings: StartRead['info']['settings'], extra: Partial<StartRead> = {}): StartRead => ({ info: { settings, folderTracks: {} }, invalid: [], heard: true, ...extra });

describe('settings after a firmware update', () => {
  it('reads the start of the box until its settings are through', async () => {
    const serial = new FakeSerial();
    const reading = readStartSettings(serial, CH340_PORT, FAST);
    await until(() => serial.connections.length === 1);
    serial.last.send(CLASSIC_LOG);
    const r = await reading;
    expect(r.heard).toBe(true);
    expect(r.info.settings).toMatchObject({ speakerVolume: { max: 25, min: 5, init: 15 }, standbyTimerMinutes: 0, invertVolumeButtons: true, pauseWhenCardRemoved: false });
    expect(serial.last.closed).toBe(true);
  });

  it('gives up on a silent box', async () => {
    const serial = new FakeSerial();
    const r = await readStartSettings(serial, CH340_PORT, { ...FAST, timeoutMs: 80 });
    expect(r.heard).toBe(false);
    expect(judgeSettings(r, 'classic')).toMatchObject({ silent: true, findings: [{ tone: 'info', text: expect.stringContaining('nichts gemeldet') }] });
  });

  it('says when the box is at the factory state', () => {
    const v = judgeSettings(read({ speakerVolume: { max: 25, min: 5, init: 15 }, standbyTimerMinutes: 0, invertVolumeButtons: true, adminLock: { kind: 'none', raw: 0 }, pauseWhenCardRemoved: false }), 'classic');
    expect(v.facts.map((f) => f.label)).toEqual(['Lautstärke', 'Ausschalt-Timer', 'Kurz drücken', 'Sperre des Admin-Menüs', 'Karte abnehmen']);
    expect(v.findings).toEqual([{ tone: 'info', text: expect.stringContaining('ab Werk') }]);
  });

  it('warns about a timer that is off on a box with a battery', () => {
    const v = judgeSettings(read({ speakerVolume: { max: 20, min: 3, init: 10 }, standbyTimerMinutes: 0 }), 'aioplus');
    expect(v.findings.map((f) => f.tone)).toEqual(['warning']);
    expect(v.findings[0].text).toContain('Akku');
    expect(judgeSettings(read({ speakerVolume: { max: 20, min: 3, init: 10 }, standbyTimerMinutes: 0 }), 'classic').findings).toEqual([{ tone: 'ok', text: 'Die Einstellungen sind da und passen.' }]);
  });

  it('warns about values the box cannot use and a PIN that cannot be typed', () => {
    const v = judgeSettings(read({ speakerVolume: { max: 5, min: 10, init: 7 }, adminLock: { kind: 'pin', raw: 2 }, adminPin: [1, 4, 2, 3], standbyTimerMinutes: 10 }, { invalid: ['EQ'] }), 'classic');
    expect(v.findings.map((f) => f.text)).toEqual([
      expect.stringContaining('(EQ)'),
      expect.stringContaining('Die Lautstärke passt nicht'),
      expect.stringContaining('PIN'),
    ]);
  });

  it('takes the AiO+ start with its own settings as fine', async () => {
    const serial = new FakeSerial();
    const reading = readStartSettings(serial, CH340_PORT, FAST);
    await until(() => serial.connections.length === 1);
    serial.last.send(AIOPLUS_BROKEN_LOG);
    const v = judgeSettings(await reading, 'aioplus');
    expect(v.facts.find((f) => f.label === 'Ausschalt-Timer')?.value).toBe('10 Minuten');
    expect(v.facts.find((f) => f.label === 'Kopfhörer')?.value).toBe('2 bis 18, beim Einschalten 8');
    expect(v.findings).toEqual([{ tone: 'ok', text: 'Die Einstellungen sind da und passen.' }]);
  });
});
