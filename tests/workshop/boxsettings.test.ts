import { describe, expect, it } from 'vitest';
import { analyzeBootLog } from '../../src/core/firmware/bootlog';
import { settingsGuide } from '../../src/core/tonuino/settingsguide';
import { basisOf, buttonsOptions, currentValues, lockOf, pinUnusable, standbyOffText, valuesFromInfo, type Applied } from '../../src/features/workshop/BoxSettingsTool';
import { Logbook } from '../../src/features/workshop/logbook';
import { AIOPLUS_BROKEN_LOG, CLASSIC_LOG } from './fakes';

describe('Box einstellen with a Steckbrief', () => {
  it('takes the values the box reported at start', () => {
    expect(valuesFromInfo(analyzeBootLog(CLASSIC_LOG).info)).toEqual({
      volume: { max: 25, min: 5, init: 15 },
      standby: 0,
      shortPressVolume: true,
      pauseWhenCardRemoved: false,
      eq: 1,
      lock: 'buttons',
      pin: ['pause', 'pause', 'pause', 'pause'],
    });
    expect(valuesFromInfo(analyzeBootLog(AIOPLUS_BROKEN_LOG).info)).toMatchObject({
      volume: { max: 20, min: 3, init: 10 },
      standby: 10,
      shortPressVolume: false,
      pauseWhenCardRemoved: true,
      lock: 'pin',
      pin: ['pause', 'up', 'down', 'pause'],
    });
  });

  it('names the lock a saved Steckbrief reports, so the page can warn about it', () => {
    expect(lockOf(analyzeBootLog(AIOPLUS_BROKEN_LOG).info)).toBe('pin');
    expect(lockOf(analyzeBootLog(CLASSIC_LOG).info)).toBeUndefined();
    expect(lockOf({ settings: {}, folderTracks: {} })).toBeUndefined();
  });

  it('knows nothing without a start in the log', () => {
    expect(valuesFromInfo({ settings: {}, folderTracks: {} })).toEqual({});
  });

  it('leaves out what is already set, so known values give exact presses', () => {
    const now = valuesFromInfo(analyzeBootLog(CLASSIC_LOG).info);
    const result = settingsGuide('tng', { volume: { max: 25, min: 5, init: 15 }, standby: 30 }, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.guide.unchanged.length).toBeGreaterThan(0);
    expect(result.guide.steps.some((s) => /Maximale Lautstärke/.test(s.hear ?? ''))).toBe(false);
  });

  it('keeps what was set with „Erledigt“ only until a newer Steckbrief arrives', () => {
    const book = {};
    const old = valuesFromInfo(analyzeBootLog(CLASSIC_LOG).info);
    const basis = basisOf(book, 1, old);
    const done: Applied = { values: { volume: { max: 20, min: 1, init: 8 } }, basis };
    // Same Steckbrief: the values set at the box count.
    expect(currentValues(old, basis, done).volume).toEqual({ max: 20, min: 1, init: 8 });
    // The box was read again and reports other values: the reading wins.
    const read = { ...old, volume: { max: 25, min: 5, init: 15 }, standby: 30 };
    expect(currentValues(read, basisOf(book, 2, read), done)).toEqual(read);
    // A new start that reports the very same values as before still wins (the changes did not stick).
    expect(currentValues(old, basisOf(book, 2, old), done)).toEqual(old);
    // Another log (a second box, a file) wins as well.
    expect(currentValues({}, basisOf({}, 1, {}), done)).toEqual({});
  });

  it('counts every connection and start of the box, also after the parser starts over', () => {
    const book = new Logbook();
    expect(book.readings).toBe(0);
    book.connected('USB');
    book.push(CLASSIC_LOG);
    const first = book.readings;
    expect(first).toBeGreaterThanOrEqual(2);
    book.connected('USB');
    expect(book.readings).toBe(first + 1);
    book.push(CLASSIC_LOG);
    // bootCount starts over with every connection; readings does not.
    expect(book.bootCount).toBe(1);
    expect(book.readings).toBe(first + 2);
  });

  it('opens the menu with the admin card when the stored PIN cannot be typed', () => {
    const locked = CLASSIC_LOG.replace('AL:0', 'AL:2').replace('AP:1111', 'AP:0255255255');
    const info = analyzeBootLog(locked).info;
    expect(info.settings.adminLock?.kind).toBe('pin');
    expect(pinUnusable(info)).toBe(true);
    expect(pinUnusable(analyzeBootLog(CLASSIC_LOG).info)).toBe(false);
    const now = valuesFromInfo(info);
    const result = settingsGuide('tng', { standby: 30 }, now, { open: 'card' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.guide.steps[0].text).toContain('Admin-Karte');
    expect(result.guide.steps.some((s) => /PIN/.test(s.text))).toBe(false);
  });

  it('tells TNG boxes about the Pause key when the timer is off, and 2.1 boxes about their switch', () => {
    expect(standbyOffText('tng')).toContain('Halte die Play/Pause-Taste lang gedrückt, während nichts läuft');
    expect(standbyOffText('tng')).not.toContain('nur mit ihrem Schalter');
    expect(standbyOffText('classic21')).toBe('Dann geht die Box nur mit ihrem Schalter aus. Hat sie keinen, ist der Akku irgendwann leer.');
  });
});

describe('Box einstellen: the key setting', () => {
  it('offers what „Tasten umdrehen“ does on the box, with the factory choice named', () => {
    const five = buttonsOptions('five');
    expect(five.label).toBe('Tasten bei 5 Tasten');
    expect(five.options.find((o) => o.text.includes('ab Werk'))?.value).toBe(false);
    expect(five.now(true)).toContain('getauscht');
    const three = buttonsOptions('three');
    expect(three.label).toBe('Kurz drücken');
    expect(three.options.find((o) => o.text.includes('ab Werk'))?.value).toBe(true);
    expect(buttonsOptions(undefined)).toMatchObject({ label: 'Kurz drücken' });
  });
});
