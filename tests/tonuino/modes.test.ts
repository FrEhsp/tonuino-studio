import { describe, expect, it } from 'vitest';
import { describeCard, foldersInRowAfter, specialSummary, modifierNeeds, modifiersFor, modifierUnsupportedFor, TNG_SEPTEMBER_2026 } from '../../src/core/tonuino/modes';

describe('describeCard', () => {
  it('Hörbuch over several folders is a random folder, not a continuation', () => {
    // TNG tonuino.cpp: random(folder, folder + special2 + 1), preferring a started folder.
    expect(describeCard({ folder: 5, mode: 5, special: 0, special2: 2 })).toBe('Hörbuch: zufällig einer der Ordner 05 bis 07.');
    expect(describeCard({ folder: 3, mode: 10, special: 1, special2: 2 })).toBe('Hörbuch Stück für Stück: zufällig einer der Ordner 03 bis 05, 2 Titel pro Auflegen.');
    expect(describeCard({ folder: 5, mode: 5, special: 0, special2: 0 })).toBe('Hörbuch: Ordner 05.');
  });
});

describe('TNG special cards on a TonUINO 2.1 box', () => {
  it('are named, not shown as a bare code', () => {
    expect(specialSummary({ folder: 0, mode: 8, special: 0, special2: 0 }, 'classic21')).toBe('Gibt es nur bei TonUINO TNG.');
    expect(describeCard({ folder: 0, mode: 11, special: 0, special2: 0 }, 'classic21')).toBe('Endlos: gibt es nur bei TonUINO TNG.');
    // A code no firmware knows stays one.
    expect(specialSummary({ folder: 0, mode: 42, special: 0, special2: 0 }, 'classic21')).toBe('Unbekannte Spezialkarte (Code 42).');
  });
});

describe('modifierNeeds', () => {
  const needs = (code: number) => {
    const mod = modifiersFor('tng').find((m) => m.code === code);
    if (!mod) throw new Error(`no modifier ${code}`);
    return modifierNeeds(mod);
  };

  it('names the firmware a card needs', () => {
    // MODIFICATION_CARD_JUKEBOX is only in the "5f" builds, MODIFICATION_CARD_PAUSE_AFTER_TRACK in none.
    expect(needs(8)).toContain('5 Tasten mit allen Extras');
    expect(needs(9)).toContain('selbst gebauten');
    expect(needs(7)).toContain('Bluetooth');
    // The Endlos card came with the release of 17.09.2026.
    expect(needs(11)).toContain(TNG_SEPTEMBER_2026);
    // "Disable standby timer" came with TNG 3.3.2 (15.11.2025, issue 284).
    expect(needs(10)).toContain('erst ab TNG 3.3.2');
  });

  it('follows the TNG release the family names', () => {
    const mod = (code: number) => modifiersFor('tng').find((m) => m.code === code)!;
    // A box of 17.09.2026 or later knows every card.
    expect(modifierNeeds(mod(11), 'newer')).toBeUndefined();
    expect(modifierNeeds(mod(10), 'newer')).toBeUndefined();
    expect(modifierNeeds(mod(8), 'newer')).toContain('5 Tasten mit allen Extras');
    // An older box surely lacks only what came on 17.09.2026; it may have 3.3.2 or the first 3.3.3.
    expect(modifierUnsupportedFor(mod(11), 'older')).toContain(`älter als TNG ${TNG_SEPTEMBER_2026}`);
    expect(modifierUnsupportedFor(mod(10), 'older')).toBeUndefined();
    expect(modifierUnsupportedFor(mod(11), 'unknown')).toBeUndefined();
    expect(modifierUnsupportedFor(mod(11))).toBeUndefined();
  });

  it('says nothing for cards every box knows', () => {
    for (const code of [1, 2, 3, 4, 5, 6]) expect(needs(code)).toBeUndefined();
    for (const mod of modifiersFor('classic21')) expect(modifierNeeds(mod)).toBeUndefined();
  });
});

describe('foldersInRowAfter', () => {
  it('offers only folders that are on the card, without a gap', () => {
    // A card with four folders: from 01 the random choice reaches 04 at most.
    expect(foldersInRowAfter(1, new Set([1, 2, 3, 4]))).toBe(3);
    expect(foldersInRowAfter(4, new Set([1, 2, 3, 4]))).toBe(0);
    expect(foldersInRowAfter(1, new Set([1, 2, 4, 5]))).toBe(1);
  });

  it('stops at 20 folders and at folder 99', () => {
    const all = new Set(Array.from({ length: 99 }, (_, i) => i + 1));
    expect(foldersInRowAfter(1, all)).toBe(20);
    expect(foldersInRowAfter(95, all)).toBe(4);
  });
});
