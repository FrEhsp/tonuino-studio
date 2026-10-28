import { describe, expect, it } from 'vitest';
import { FACTORY_SETTINGS } from '../../src/core/tonuino/settingsguide';
import { NOTHING_ON, boxPunkte, draftFrom, firmwareSatz, fromStored, ortVon, toStored, visibleParts, volumeOf, wishOf, type Draft, type Kontext } from '../../src/features/workshop/verhalten';

const all = visibleParts('tng', 3, 'three');

function answered(patch: Partial<Draft>, on: Partial<Draft['on']>): Draft {
  return { ...draftFrom({}), ...patch, on: { ...NOTHING_ON, ...on } };
}

describe('where a sentence goes', () => {
  const wizard = (fits = true, ownFile = false): Kontext => ({ board: 'classic', prof: 'tng', bau: { choice: { knob: 'encoder' }, fits: () => fits, ownFile } });

  it('puts „Play ohne Karte“ into the firmware, as „Weitermachen“', () => {
    expect(ortVon('weiter', wizard())).toEqual({ wo: 'firmware', text: 'als „Weitermachen“' });
    // On „Box einstellen“ the board may be unknown: it still is a matter of the firmware.
    expect(ortVon('weiter', { prof: 'tng' }).wo).toBe('firmware');
  });

  it('says when „Play ohne Karte“ cannot go into this firmware, and why', () => {
    expect(ortVon('weiter', wizard(false))).toMatchObject({ wo: 'nicht', text: expect.stringMatching(/Speicher/) });
    expect(ortVon('weiter', wizard(true, true))).toMatchObject({ wo: 'nicht', text: expect.stringMatching(/eigene Datei/) });
    expect(ortVon('weiter', { board: 'aioplus', prof: 'tng' })).toMatchObject({ wo: 'nicht', text: expect.stringMatching(/Classic und AiO/) });
  });

  it('sets everything else at the box, „Karte wegnehmen“ only on TNG', () => {
    for (const p of ['volume', 'standby', 'buttons', 'lock', 'shortcut', 'eq', 'reset'] as const) expect(ortVon(p, wizard()).wo).toBe('box');
    expect(ortVon('cardRemoved', { prof: 'tng' })).toEqual({ wo: 'box', text: 'im Admin-Menü, „Karte wegnehmen = Pause“' });
    expect(ortVon('cardRemoved', { prof: 'classic21' }).wo).toBe('nicht');
  });
});

describe('the sentences as settings for the box', () => {
  it('asks for nothing while no sentence is answered', () => {
    expect(wishOf(draftFrom({}), all)).toEqual({});
    expect(boxPunkte({})).toEqual([]);
  });

  it('makes the lines of „Was dafür passiert“ in the order of the sentences', () => {
    const d = answered({ pauseWhenCardRemoved: true, preset: 'kinderzimmer' }, { cardRemoved: true, volume: true });
    const wish = wishOf(d, all);
    expect(wish).toEqual({ pauseWhenCardRemoved: true, volume: { max: 20, min: 1, init: 8 } });
    // As in the design: „Karte wegnehmen = Pause“, „Lautstärke 20 / 1 / 8“.
    expect(boxPunkte(wish)).toEqual(['Karte wegnehmen = Pause', 'Lautstärke 20 / 1 / 8']);
  });

  it('says every setting in a short line', () => {
    expect(
      boxPunkte({ reset: true, standby: 0, shortPressVolume: false, lock: 'card', shortcut: { slot: 2, folder: 7, mode: 3 }, eq: 5 }),
    ).toEqual(['Vorher alles zurücksetzen', 'Nicht von selbst ausschalten', 'Kurz drücken: Titel', 'Admin-Menü nur mit Admin-Karte', 'Kurzwahl: Ordner 7 als Party', 'Klang: Klassik']);
    expect(boxPunkte({ standby: 15 })).toEqual(['Ausschalten nach 15 Min.']);
  });

  it('leaves out what this box does not have', () => {
    const d = answered({ pauseWhenCardRemoved: true, shortPressVolume: false }, { cardRemoved: true, buttons: true });
    expect(wishOf(d, visibleParts('classic21', 3, 'three'))).toEqual({ shortPressVolume: false });
    // 5 buttons swap only on TNG from 26.10.2026 (tngstands.ts).
    expect(visibleParts('tng', 5, 'none').buttons).toBe(false);
    expect(visibleParts('tng', 5, 'five').buttons).toBe(true);
  });

  it('keeps own volumes as typed until they are checked, and the PIN only when complete', () => {
    const own = answered({ preset: 'eigene', volume: { max: '18', min: '', init: '6' } }, { volume: true });
    expect(volumeOf(own).min).toBeNaN();
    const pin = answered({ lock: 'pin', pin: ['up', 'down', '', 'pause'] }, { lock: true });
    expect(wishOf(pin, all)).toEqual({ lock: 'pin', pin: ['up', 'down', 'pause'] });
  });

  it('starts from what the box has, or from the factory', () => {
    expect(draftFrom({}).preset).toBe('werk');
    expect(draftFrom({ volume: { max: 20, min: 1, init: 8 } }).preset).toBe('kinderzimmer');
    expect(draftFrom({}).standby).toBe(FACTORY_SETTINGS.standby);
    // With 5 swapping buttons the factory has them as printed.
    expect(draftFrom({}, 'five').shortPressVolume).toBe(false);
  });
});

describe('the firmware in one sentence', () => {
  it('lists the parts as the design does', () => {
    expect(firmwareSatz(['Drehregler', 'Leuchtring', 'Kopfhörer-Erkennung', 'Weitermachen'])).toBe('Mit Drehregler, Leuchtring, Kopfhörer-Erkennung und Weitermachen.');
    expect(firmwareSatz(['Drehregler'])).toBe('Mit Drehregler.');
    expect(firmwareSatz([])).toBe('Ohne Extras, so wie TonUINO TNG ab Werk ist.');
  });
});

describe('the sentences kept for the box', () => {
  it('keeps the answers but never the PIN', () => {
    const d = answered({ lock: 'pin', pin: ['up', 'up', 'down', 'pause'], pauseWhenCardRemoved: true, weiter: true }, { lock: true, cardRemoved: true });
    const raw = toStored(d);
    expect(JSON.parse(raw)).not.toHaveProperty('pin');
    expect(raw).not.toMatch(/"up","up"/);
    const back = fromStored(raw)!;
    expect(back.pin).toEqual(['', '', '', '']);
    // Without its PIN the lock is asked again.
    expect(back.on.lock).toBe(false);
    expect(back.on.cardRemoved).toBe(true);
    expect(back.pauseWhenCardRemoved).toBe(true);
    expect(back.weiter).toBe(true);
  });

  it('forgets what it cannot read', () => {
    expect(fromStored(undefined)).toBeUndefined();
    expect(fromStored('kaputt')).toBeUndefined();
    expect(fromStored('{"on":1}')).toBeUndefined();
    expect(fromStored(JSON.stringify({ on: { volume: 'ja' }, volume: { max: '1', min: '1', init: '1' } }))!.on.volume).toBe(false);
  });
});
