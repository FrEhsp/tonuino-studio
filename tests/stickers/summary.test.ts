import { describe, expect, it } from 'vitest';
import { getTemplate } from '../../src/core/stickers/templates';
import { slotsPerSheet } from '../../src/core/stickers/slots';
import { folderRuns, paperName, paperSize } from '../../src/features/stickers/summary';

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
