import { describe, expect, it } from 'vitest';
import { CHECKED_TNG, standTitle } from '../../src/core/firmware/tngstands';
import { afterBoxReport, boxDisagrees, decideProfile, profileFromBox, profileFromSounds, tngReleaseOf, tngStandOf } from '../../src/core/tonuino/firmwaredetect';
import type { SdScan, SdSystemDir, SdTrack } from '../../src/core/tonuino/sd';

function dir(name: 'mp3' | 'advert', numbers: number[], size = 5000): SdSystemDir {
  const files: SdTrack[] = numbers.map((n, order) => ({ number: n, name: `${String(n).padStart(4, '0')}.mp3`, size, suffix: '', ext: 'mp3', order }) as SdTrack);
  return { name, dirName: name, files, wrongDigits: [], others: [], junk: [], empty: [], totalBytes: 0 };
}

function scan(mp3?: number[], advert?: number[], size?: number): Pick<SdScan, 'system'> {
  const system: SdScan['system'] = {};
  if (mp3) system.mp3 = dir('mp3', mp3, size);
  if (advert) system.advert = dir('advert', advert, size);
  return { system };
}

const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
/** The TonUINO 2.1 set (xfjx/TonUINO DEV, sd-card). */
const CLASSIC21_MP3 = [...span(1, 255), 300, 301, ...span(310, 322), 330, 331, 332, 400, 401, 800, 802, ...span(900, 912), ...span(920, 926), ...span(930, 936), ...span(940, 944), ...span(960, 965), ...span(970, 976), ...span(980, 984), ...span(991, 994), 999];
const CLASSIC21_ADVERT = [...span(1, 255), 260, 261, ...span(300, 305)];

describe('profileFromSounds', () => {
  it('knows the TNG set by its start tone', () => {
    expect(profileFromSounds(scan([...span(1, 255), 262, 300], span(1, 255)))).toEqual({ profile: 'tng', files: ['mp3/0262.mp3'] });
  });

  it('knows the TNG set by the game and admin-lock announcements', () => {
    expect(profileFromSounds(scan([500, 501, 987]))?.profile).toBe('tng');
    expect(profileFromSounds(scan(undefined, [320]))?.profile).toBe('tng');
  });

  it('knows the 2.1 set by mp3/0982–0984', () => {
    const r = profileFromSounds(scan(CLASSIC21_MP3, CLASSIC21_ADVERT));
    expect(r).toEqual({ profile: 'classic21', files: ['mp3/0982.mp3', 'mp3/0983.mp3', 'mp3/0984.mp3'] });
  });

  it('a TNG set copied over a 2.1 set is TNG', () => {
    expect(profileFromSounds(scan([...CLASSIC21_MP3, 262, 985, 986, 987]))?.profile).toBe('tng');
  });

  it('says nothing for the numbers both sets have, or no announcements', () => {
    expect(profileFromSounds(scan(span(1, 255), span(1, 255)))).toBeUndefined();
    expect(profileFromSounds(scan()))
      .toBeUndefined();
  });

  it('empty files prove nothing', () => {
    expect(profileFromSounds(scan([262, 982], undefined, 0))).toBeUndefined();
  });
});

describe('decideProfile', () => {
  const tngCard = scan([262]);
  const oldCard = scan([982]);

  it('a choice by hand wins over the announcements', () => {
    expect(decideProfile({ profile: 'tng', from: 'manual' }, oldCard, 'tng')).toEqual({ profile: 'tng', source: 'manual' });
  });

  it('what the box said wins over the announcements', () => {
    expect(decideProfile({ profile: 'classic21', from: 'box' }, tngCard, 'tng')).toEqual({ profile: 'classic21', source: 'box' });
  });

  it('the announcements decide over the default', () => {
    expect(decideProfile({ profile: 'tng', from: 'default' }, oldCard, 'tng')).toMatchObject({ profile: 'classic21', source: 'sounds' });
    expect(decideProfile(undefined, tngCard, 'classic21')).toMatchObject({ profile: 'tng', source: 'sounds', files: ['mp3/0262.mp3'] });
  });

  it('old catalogs: 2.1 was chosen by hand, TNG may be the default', () => {
    expect(decideProfile({ profile: 'classic21' }, tngCard, 'tng')).toEqual({ profile: 'classic21', source: 'manual' });
    expect(decideProfile({ profile: 'tng' }, oldCard, 'tng')).toMatchObject({ profile: 'classic21', source: 'sounds' });
  });

  it('nothing to go by: the stored or the default profile, to be chosen', () => {
    expect(decideProfile({ profile: 'tng' }, scan(), 'classic21')).toEqual({ profile: 'tng', source: 'default' });
    expect(decideProfile(undefined, undefined, 'classic21')).toEqual({ profile: 'classic21', source: 'default' });
  });
});

describe('box reports', () => {
  it('takes over what the box said, unless chosen by hand', () => {
    expect(profileFromBox({ firmware: 'classic21' })).toBe('classic21');
    expect(profileFromBox({})).toBeUndefined();
    expect(afterBoxReport({ profile: 'tng', from: 'default' }, 'classic21')).toEqual({ profile: 'classic21', from: 'box' });
    expect(afterBoxReport({ profile: 'tng' }, 'tng')).toEqual({ profile: 'tng', from: 'box' });
    expect(afterBoxReport({ profile: 'tng', from: 'box' }, 'tng')).toBeUndefined();
    expect(afterBoxReport({ profile: 'tng', from: 'manual' }, 'classic21')).toBeUndefined();
    expect(afterBoxReport({ profile: 'classic21' }, 'tng')).toBeUndefined();
  });

  it('says when the box contradicts a hand choice', () => {
    expect(boxDisagrees({ profile: 'tng', source: 'manual' }, 'classic21')).toBe(true);
    expect(boxDisagrees({ profile: 'tng', source: 'manual' }, 'tng')).toBe(false);
    expect(boxDisagrees({ profile: 'tng', source: 'sounds' }, 'classic21')).toBe(false);
  });
});

describe('TNG release from the version the box names', () => {
  it('tells the two 3.3.3 releases apart by their date, and leaves builds in between open', () => {
    expect(tngReleaseOf({ version: '3.3.3', date: '2026-09-17' })).toBe('newer');
    expect(tngReleaseOf({ version: '3.3.3', date: '2026-10-05' })).toBe('newer');
    expect(tngReleaseOf({ version: '3.3.3', date: '2026-02-25' })).toBe('older');
    expect(tngReleaseOf({ version: '3.3.3', date: '2026-06-11' })).toBeUndefined();
    expect(tngReleaseOf({ version: '3.3.3' })).toBeUndefined();
    expect(tngReleaseOf({ version: '3.3.2', date: '2025-12-28' })).toBe('older');
    expect(tngReleaseOf({ version: '3.4.0' })).toBe('newer');
    expect(tngReleaseOf({})).toBeUndefined();
    expect(tngReleaseOf(undefined)).toBeUndefined();
  });
  it('names the known states of TNG by the date in the version line', () => {
    expect(tngStandOf({ version: '3.3.3', date: '2026-02-25' })).toMatchObject({ label: 'Release vom 25.02.2026' });
    // The state the app puts on boxes (CHECKED_TNG): main of 17.09.2026, never a tagged release.
    expect(tngStandOf({ version: '3.3.3', date: '2026-09-17' })).toMatchObject({ label: 'Stand vom 17.09.2026', checked: true });
    const october = tngStandOf({ version: '3.3.3', date: '2026-10-16' })!;
    expect(october).toMatchObject({ label: 'Testversion vom 16.10.2026', preview: true });
    expect(october.note).toContain('nach einer Ansage hängen');
    expect(october.note).toContain(standTitle(CHECKED_TNG));
    expect(tngReleaseOf({ version: '3.3.3', date: '2026-10-16' })).toBe('newer');
    expect(tngStandOf({ version: '3.3.3', date: '2026-06-11' })?.label).toBe('Zwischenstand vom 11.06.2026');
    expect(tngStandOf({ version: '3.3.3', date: '2026-11-02' })?.label).toBe('Stand vom 02.11.2026');
    expect(tngStandOf({ version: '3.3.3', date: '2026-11-02' })?.note).toContain('Neuer als die Firmware, die TonUINO Studio aufspielt');
    expect(tngStandOf({ version: '3.3.3' })).toBeUndefined();
    // main of 26.10.2026: version string 3.3.4 while the README says 3.4.0; settings layout 3.
    expect(tngStandOf({ version: '3.3.4', date: '2026-10-26' })).toMatchObject({ label: 'Stand vom 26.10.2026' });
    expect(tngStandOf({ version: '3.3.4', date: '2026-10-26' })?.checked).toBeUndefined();
    expect(tngReleaseOf({ version: '3.3.4', date: '2026-10-26' })).toBe('newer');
    expect(tngStandOf({ version: '3.4.0', date: '2027-01-01' })?.note).toContain('Neuer als');
    expect(tngStandOf({ version: '3.3.2', date: '2025-12-28' })?.note).toContain('Älter als die Firmware');
  });
});
