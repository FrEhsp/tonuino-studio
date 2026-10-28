import { describe, expect, it } from 'vitest';
import { cardLine, firstFreeFolder, folderWords, FRONT_MODES, isFrontCard, modeName, nextFolder, singleItem } from '../../src/features/cards/single';

describe('one card at a time („Karte beschreiben“)', () => {
  it('has the four ways in front, each with one short sentence', () => {
    expect(FRONT_MODES.map((m) => `${m.name}: ${m.text}`)).toEqual(['Hörspiel: ein Titel per Zufall', 'Album: alles der Reihe nach', 'Party: alles durcheinander', 'Hörbuch: merkt sich, wo ihr wart']);
    expect(modeName(1)).toBe('Hörspiel');
    expect(modeName(4)).toBe('Einzeltitel');
  });

  it('says in one line what is on the card', () => {
    expect(cardLine({ folder: 14, mode: 5, special: 0, special2: 0 })).toBe('Ordner 14 · Hörbuch');
    expect(cardLine({ folder: 3, mode: 4, special: 4, special2: 0 })).toBe('Ordner 03 · Einzeltitel · Titel 4');
    expect(isFrontCard({ mode: 5, special: 0, special2: 2 })).toBe(false);
  });

  it('goes on with the next folder, up to 99', () => {
    expect(nextFolder(14)).toBe(15);
    expect(nextFolder(99)).toBeNull();
    expect(firstFreeFolder(new Set([1, 2, 3, 5]))).toBe(4);
    expect(firstFreeFolder(new Set([1, 2, 3, 5]), 5)).toBe(6);
    expect(firstFreeFolder(new Set(Array.from({ length: 99 }, (_, i) => i + 1)))).toBeNull();
  });

  it('builds the one item the ways of writing take, with what the SD card says about it', () => {
    const counts = new Map([[14, 12]]);
    const item = singleItem({ folder: 14, mode: 5, special: 0, special2: 0 }, { title: 'Der Hobbit', trackCount: (n) => counts.get(n), profile: 'tng' });
    expect(item).toMatchObject({ folder: 14, title: 'Der Hobbit', problems: [], summary: 'Hörbuch · 12 Titel' });
    expect(item.unsupported).toBeUndefined();
    const missing = singleItem({ folder: 53, mode: 2, special: 0, special2: 0 }, { trackCount: (n) => counts.get(n), profile: 'tng' });
    expect(missing.title).toBe('Ordner 53');
    expect(missing.problems).toEqual(['Ordner 53 gibt es auf der SD-Karte nicht.']);
    // Without an SD card nothing is checked: the phone writes cards for any folder.
    expect(singleItem({ folder: 53, mode: 2, special: 0, special2: 0 }, { profile: 'tng' }).problems).toEqual([]);
    // Each copy is its own item, so the same card can be written twice in a row.
    expect(singleItem(item.data, { profile: 'tng', copy: 1 }).key).not.toBe(singleItem(item.data, { profile: 'tng', copy: 2 }).key);
  });
});

describe('what „Bei dir“ says about the folder (Prüfrunde 1, bastler 16)', () => {
  it('follows the scan the card beside it shows', () => {
    expect(folderWords('Der Hobbit', 12)).toBe('Bei dir: Der Hobbit');
    expect(folderWords(undefined, 2)).toBe('Bei dir: 2 Titel, noch ohne Namen.');
    expect(folderWords(undefined, 1)).toBe('Bei dir: 1 Titel, noch ohne Namen.');
    expect(folderWords(undefined, 0)).toBe('Bei dir ist der Ordner noch leer.');
    expect(folderWords(undefined, undefined)).toBe('');
  });
});
