import { describe, expect, it } from 'vitest';
import { manualSections, shortcutKeys, type ManualBox } from '../../src/core/tonuino/manual';
import { adminCard, modifierCard } from '../../src/core/tonuino/modes';
import { manualAbout, manualFacts, manualTitle } from '../../src/features/manual/manualbox';
import type { BoxInfo } from '../../src/core/firmware/bootlog';

const rows = (box: ManualBox, title: string) => Object.fromEntries((manualSections(box).find((s) => s.title === title)?.rows ?? []).map((r) => [r.what, r.does]));

describe('Bedienkarte', () => {
  it('follows the TNG key table for 3 keys, as from the factory', () => {
    const keys = rows({ profile: 'tng', buttons: 3, shortPressVolume: true }, 'Tasten');
    expect(keys['Vor kurz']).toBe('Lauter');
    expect(keys['Vor lang']).toBe('Nächster Titel');
    expect(keys['Zurück lang']).toBe('Voriger Titel');
    expect(keys['Play/Pause lang']).toMatch(/In der Pause: ausschalten/);
    expect(keys['Vor + Zurück lang']).toBe('Beim Hören: zurück zum ersten Titel');
    expect(keys['Play/Pause + Vor + Zurück lang']).toBe('Admin-Menü für Erwachsene');
  });

  it('swaps short and long when short press skips (IB:0)', () => {
    const keys = rows({ profile: 'tng', buttons: 3, shortPressVolume: false }, 'Tasten');
    expect(keys['Vor kurz']).toBe('Nächster Titel');
    expect(keys['Vor lang']).toMatch(/^Lauter/);
  });

  it('has jumps of ten and volume keys with 5 keys', () => {
    const keys = rows({ profile: 'tng', buttons: 5, shortPressVolume: true }, 'Tasten');
    expect(keys['Vor lang']).toBe('10 Titel weiter');
    expect(keys['Lauter / Leiser']).toBeDefined();
    // commands.cpp, FIVEBUTTONS: updownLong while playing is to_first, as with 3 keys.
    expect(keys['Vor + Zurück lang']).toBe('Beim Hören: zurück zum ersten Titel');
    // buttons.cpp: allLong names the keys, never "alle drei" on a box with five.
    expect(keys['Play/Pause + Vor + Zurück lang']).toBe('Admin-Menü für Erwachsene');
    expect(keys['Play/Pause + Lauter + Leiser lang']).toBe('Auch das öffnet das Admin-Menü');
    expect(Object.keys(keys).join(' ')).not.toMatch(/alle drei/i);
  });

  it('knows TonUINO 2.1 has neither "zum ersten Titel" nor switching off by key', () => {
    const keys = rows({ profile: 'classic21', buttons: 3, shortPressVolume: true }, 'Tasten');
    expect(keys['Vor + Zurück lang']).toBeUndefined();
    expect(keys['Play/Pause lang']).not.toMatch(/ausschalten/);
    expect(shortcutKeys('classic21')[1]).toBe('Play/Pause lang');
    expect(shortcutKeys('tng')[1]).toBe('Vor + Zurück lang');
  });

  it('lists only the Kurzwahlen that are filled in', () => {
    const box: ManualBox = { profile: 'tng', buttons: 3, shortPressVolume: true, shortcuts: { 2: 'Schlaflieder', 3: '  ', 4: 'Radio' } };
    expect(rows(box, 'Kurzwahlen')).toEqual({ 'Vor lang, wenn nichts läuft': 'Schlaflieder', 'Beim Einschalten': 'Radio' });
    expect(manualSections({ ...box, shortcuts: {} }).some((s) => s.title === 'Kurzwahlen')).toBe(false);
  });

  it('names the special cards once, but never the admin card', () => {
    const box: ManualBox = { profile: 'tng', buttons: 3, shortPressVolume: true, specials: [modifierCard(1, 30), modifierCard(1, 30), adminCard()] };
    const specials = manualSections(box).find((s) => s.title === 'Spezialkarten')!.rows;
    expect(specials).toHaveLength(1);
    expect(specials[0].does).toBe('Schaltet nach 30 Minuten ab');
  });

  it('says what the settings, the lock and the extras do', () => {
    const box: ManualBox = { profile: 'tng', buttons: 3, shortPressVolume: true, standby: 20, pauseWhenCardRemoved: true, lock: 'card', knob: 'encoder', headphones: true, light: 'ring', preset: 'weiter' };
    expect(rows(box, 'Tasten')['Play/Pause + Vor + Zurück lang']).toMatch(/Admin-Karte/);
    expect(rows(box, 'Tasten')['Drehregler']).toBe('Lauter und leiser');
    expect(rows(box, 'Karten')['Karte abnehmen']).toBe('Die Musik hält an');
    expect(rows(box, 'Karten')['Dieselbe Karte noch mal']).toBeDefined();
    expect(rows(box, 'Gut zu wissen')['Ausschalten']).toMatch(/20 Minuten/);
    expect(rows({ ...box, standby: 0 }, 'Gut zu wissen')['Ausschalten']).toMatch(/bleibt an/);
    expect(rows(box, 'Gut zu wissen')['Kopfhörer einstecken']).toBeDefined();
  });
});

describe('what the Bedienkarte knows about the box', () => {
  const info: BoxInfo = {
    firmware: 'tng',
    buttons: '5',
    settings: { invertVolumeButtons: false, standbyTimerMinutes: 10, pauseWhenCardRemoved: false, adminLock: { kind: 'pin', raw: 2 } },
    folderTracks: {},
    headphones: false,
  };

  it('takes the start of the box as "automatisch erkannt"', () => {
    const f = manualFacts({ info, profile: 'classic21' });
    expect(f.box).toMatchObject({ profile: 'tng', buttons: 5, shortPressVolume: false, standby: 10, pauseWhenCardRemoved: false, lock: 'pin', headphones: true });
    expect([...f.detected].sort()).toEqual(['buttons', 'headphones', 'lock', 'pauseWhenCardRemoved', 'profile', 'shortPressVolume', 'standby']);
  });

  it('falls back to the app and the factory, and a choice by hand is no longer "erkannt"', () => {
    const plain = manualFacts({ profile: 'tng' });
    expect(plain.box).toMatchObject({ profile: 'tng', buttons: 3, shortPressVolume: true });
    expect(plain.detected.size).toBe(0);
    const changed = manualFacts({ info, profile: 'tng', choice: { buttons: 3 } });
    expect(changed.box.buttons).toBe(3);
    expect(changed.detected.has('buttons')).toBe(false);
  });

  it('takes knob and light from a known Baukasten build of the same keys', () => {
    const build = { id: 'x', board: 'classic' as const, buttons: '3' as const, knob: 'poti' as const, light: 'ledButtons' as const, from: 'read' as const, at: 0 };
    expect(manualFacts({ profile: 'tng', build }).box).toMatchObject({ knob: 'poti', light: 'ledButtons' });
    expect(manualFacts({ profile: 'tng', build, choice: { buttons: 5 } }).box.knob).toBeUndefined();
  });

  it('names the box in the title and says firmware and keys', () => {
    expect(manualTitle('Emmas Box')).toBe('So geht Emmas Box');
    expect(manualTitle('Meine TonUINO-Box')).toBe('So geht die Box');
    expect(manualTitle(undefined)).toBe('So geht die Box');
    expect(manualAbout({ profile: 'classic21', buttons: 3, shortPressVolume: true })).toBe('TonUINO 2.1 · 3 Tasten');
  });
});

describe('manualPdf', () => {
  it('puts the card twice on an A4 sheet across, with the contact or a line to write on', async () => {
    const { manualPdf } = await import('../../src/features/manual/manualpdf');
    const sections = manualSections({ profile: 'tng', buttons: 3, shortPressVolume: true, standby: 20 });
    const text = new TextDecoder('latin1').decode(await (await manualPdf(sections, { title: 'So geht die Box', about: 'TonUINO TNG · 3 Tasten', contact: 'Tante Uta' })).arrayBuffer());
    expect(text.match(/\(Vor \+ Zur.ck lang\)/g)).toHaveLength(2);
    expect(text.match(/\(Tante Uta\)/g)).toHaveLength(2);
    expect(text).toContain('(hier durchschneiden)');
    expect(text).toMatch(/MediaBox \[0 0 841\.8\d* 595\.2\d*\]/);
  });

  it('makes the type smaller for a long card, so it still fits', async () => {
    const { manualPdf } = await import('../../src/features/manual/manualpdf');
    const box: ManualBox = { profile: 'tng', buttons: 3, shortPressVolume: true, standby: 20, pauseWhenCardRemoved: true, knob: 'encoderSkip', light: 'ring', headphones: true, preset: 'weiter', shortcuts: { 1: 'Eins', 2: 'Zwei', 3: 'Drei', 4: 'Vier' }, specials: [1, 2, 3, 4, 5, 6, 7, 8].map((m) => modifierCard(m, 15)) };
    const blob = await manualPdf(manualSections(box), { title: 'So geht die Box' });
    expect(blob.size).toBeGreaterThan(1000);
  });
});
