import { describe, expect, it } from 'vitest';
import {
  CHECKED_TNG,
  TNG_STANDS,
  compareStand,
  factoryInvert,
  invertKind,
  invertText,
  invertWorksOnFiveButtons,
  isChecked,
  knownStand,
  standTitle,
} from '../../src/core/firmware/tngstands';

describe('TNG states', () => {
  it('knows its states oldest first, and the one the app puts on boxes', () => {
    const dates = TNG_STANDS.map((s) => s.date);
    expect([...dates].sort()).toEqual(dates);
    for (const s of TNG_STANDS) expect(s.versionString).toBe(`V${s.version} ${s.date.slice(8, 10)}.${s.date.slice(5, 7)}.${s.date.slice(2, 4)}`);
    expect(CHECKED_TNG).toMatchObject({ versionString: 'V3.3.3 17.09.26', commit: 'd527ca5f3c5090a74ccdf5505202db352d7531c8', kind: 'main' });
    expect(standTitle(CHECKED_TNG)).toBe('TonUINO TNG 3.3.3 vom 17.09.2026');
  });

  it('tells states apart by number, then by date', () => {
    expect(compareStand({ version: '3.3.4', date: '2026-10-26' }, CHECKED_TNG)).toBe(1);
    expect(compareStand({ version: '3.3.3', date: '2026-02-25' }, CHECKED_TNG)).toBe(-1);
    expect(compareStand({ version: '3.3.3', date: '2026-09-17' }, CHECKED_TNG)).toBe(0);
    expect(compareStand({ version: '3.4.0' }, CHECKED_TNG)).toBe(1);
    expect(compareStand({ version: '3.3.3' }, CHECKED_TNG)).toBeUndefined();
    expect(compareStand({ version: 'x' }, CHECKED_TNG)).toBeUndefined();
    expect(isChecked({ version: '3.3.3', date: '2026-09-17' })).toBe(true);
    expect(isChecked({ version: '3.3.4', date: '2026-10-26' })).toBe(false);
    expect(isChecked(undefined)).toBe(false);
    expect(knownStand({ version: '3.3.4', date: '2026-10-26' })).toMatchObject({ settingsLayout: 3, configHpp: true, batCalibration: true });
    expect(knownStand({ version: '3.3.4' })).toBeUndefined();
  });

  it('knows what „Tasten umdrehen“ does on each box', () => {
    expect(invertKind({ buttons: '3' })).toBe('three');
    expect(invertKind({ buttons: '3x3', version: '3.3.4', date: '2026-10-26' })).toBe('three');
    expect(invertKind({ buttons: '5', version: '3.3.3', date: '2026-09-17' })).toBe('none');
    expect(invertKind({ buttons: '5', version: '3.3.4', date: '2026-10-26' })).toBe('five');
    // A later state keeps it; a smaller number is older; the same number without a date cannot be told.
    expect(invertKind({ buttons: '5', version: '3.4.0', date: '2027-01-10' })).toBe('five');
    expect(invertWorksOnFiveButtons({ version: '3.3.3' })).toBe(false);
    expect(invertWorksOnFiveButtons({ version: '3.3.4' })).toBeUndefined();
    expect(invertKind({ buttons: '5' })).toBeUndefined();
    expect(invertKind({})).toBeUndefined();
    // TNG Settings::resetSettings: 1, but 0 for 5 buttons since 26.10.2026.
    expect(factoryInvert('three')).toBe(true);
    expect(factoryInvert('none')).toBe(true);
    expect(factoryInvert(undefined)).toBe(true);
    expect(factoryInvert('five')).toBe(false);
    expect(invertText('five', true)).toContain('getauscht');
    expect(invertText('five', false)).toContain('wie beschriftet');
    expect(invertText('none', true)).toBeUndefined();
    expect(invertText('three', true)).toBe('kurz drücken: Lautstärke, lang: Titel');
  });
});
