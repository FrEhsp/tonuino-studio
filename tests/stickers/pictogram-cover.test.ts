/**
 * A pictogram as a card's cover (TODO #113): pictogram and credit sit where every style shows them,
 * and the search starts with the words of the title.
 */
import { describe, expect, it } from 'vitest';
import { PICTOGRAM_CREDIT } from '../../src/core/stickers/arasaac';
import { CARD_HEIGHT_MM, CARD_WIDTH_MM } from '../../src/core/stickers/templates';
import { creditLines, PLATE_H, PLATE_SAFE, PLATE_W, plateLayout } from '../../src/features/stickers/pictogramCover';
import { pictogramQuery } from '../../src/features/stickers/PictogramCoverSearch';

describe('the pictogram cover', () => {
  const l = plateLayout();

  it('has the shape of the card lying', () => {
    expect(PLATE_W / PLATE_H).toBeCloseTo(CARD_WIDTH_MM / CARD_HEIGHT_MM, 1);
  });

  it('keeps pictogram and credit out of the lower quarter, where the band of "Vollbild" lies', () => {
    expect(l.pictogram.y + l.pictogram.size).toBeLessThanOrEqual(PLATE_H * 0.75);
    expect(l.credit.baselines[1]).toBeLessThan(l.pictogram.y);
    expect(l.credit.baselines[0]).toBeGreaterThan(l.credit.size);
  });

  it('keeps them in the middle an upright sticker shows', () => {
    // An upright sticker shows the middle of a lying cover: 54 / (85.6 * 85.6 / 54) of its width.
    const shown = CARD_HEIGHT_MM / ((CARD_WIDTH_MM * PLATE_W) / PLATE_H);
    expect(PLATE_SAFE).toBeLessThanOrEqual(shown);
    expect(l.pictogram.x).toBeGreaterThanOrEqual((PLATE_W * (1 - PLATE_SAFE)) / 2);
    expect(l.pictogram.x + l.pictogram.size).toBeLessThanOrEqual((PLATE_W * (1 + PLATE_SAFE)) / 2);
    expect(l.credit.maxWidth).toBeLessThanOrEqual(PLATE_W * PLATE_SAFE);
  });

  it('names the whole source, in two lines', () => {
    expect(creditLines().join(' ')).toBe(PICTOGRAM_CREDIT);
    expect(creditLines()[0]).toBe('Piktogramm: Sergio Palao, ARASAAC');
  });
});

describe('pictogramQuery', () => {
  it('starts with the first words of the title, without the episode', () => {
    expect(pictogramQuery('Die kleine Hexe - Folge 3')).toBe('Die kleine Hexe');
    expect(pictogramQuery('Katze')).toBe('Katze');
    expect(pictogramQuery('Folge 12: Räuber Hotzenplotz')).toBe('Räuber Hotzenplotz');
  });
});
