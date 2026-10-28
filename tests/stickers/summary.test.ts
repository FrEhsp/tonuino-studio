import { describe, expect, it } from 'vitest';
import { getTemplate } from '../../src/core/stickers/templates';
import { slotsPerSheet } from '../../src/core/stickers/slots';
import { chosenLine, firstField, folderRuns, paperName, paperSize, sheetLine } from '../../src/features/stickers/summary';

describe('folderRuns', () => {
  it('writes runs of folders as "bis", two in a row as two', () => {
    expect(folderRuns(Array.from({ length: 47 }, (_, i) => i + 1))).toBe('01 bis 47');
    expect(folderRuns([3, 1, 2, 7, 9, 10])).toBe('01 bis 03, 07, 09, 10');
    expect(folderRuns([5])).toBe('05');
  });

  it('cuts off after four runs', () => {
    expect(folderRuns([1, 3, 5, 7, 9, 11])).toBe('01, 03, 05, 07 …');
  });
});

describe('paper line', () => {
  const line = (id: string, images = false) => {
    const t = getTemplate(id)!;
    return paperName(t) + paperSize(t, slotsPerSheet(t), images);
  };

  it('names the packet and what a sheet holds, the size once', () => {
    expect(line('herma-5028')).toBe('HERMA 5028, 10 Sticker je 83,8 × 50,8 mm');
    expect(line('round-30')).toBe('Runde Sticker Ø 30 mm, 40 Sticker je Bogen');
    expect(line('photo-sticker-82x57', true)).toBe('Fotosticker 82 × 57 mm, jeder Sticker ein eigenes Bild');
  });
});

describe('the short lines of „Sticker drucken“ (0.6)', () => {
  it('names what is chosen', () => {
    expect(chosenLine({ folders: 7, allFolders: 52, fresh: true, specials: 0, pictures: 0 })).toBe('7 Ordner ohne Sticker');
    expect(chosenLine({ folders: 52, allFolders: 52, fresh: false, specials: 0, pictures: 0 })).toBe('Alle 52 Ordner');
    expect(chosenLine({ folders: 3, allFolders: 52, fresh: false, specials: 1, pictures: 2 })).toBe('3 Ordner, 1 Spezialkarte und 2 eigene Bilder');
    expect(chosenLine({ folders: 0, allFolders: 0, fresh: false, specials: 0, pictures: 1, words: 3 })).toBe('1 eigenes Bild und 3 Wortkarten');
    expect(chosenLine({ folders: 0, allFolders: 52, fresh: false, specials: 0, pictures: 0 })).toBe('Noch keine ausgewählt');
  });

  it('finds the first field still there', () => {
    expect(firstField([], 10)).toBe(1);
    expect(firstField([0, 1], 10)).toBe(3);
    expect(firstField([1], 10)).toBe(1);
    expect(firstField([0, 1, 2], 3)).toBe(1);
  });

  it('says what a sheet holds', () => {
    const herma = getTemplate('herma-5028')!;
    expect(sheetLine(herma, 10, false)).toBe('10 Stück · 83,8 × 50,8 mm');
  });
});
