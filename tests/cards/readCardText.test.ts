import { afterEach, describe, expect, it } from 'vitest';
import { encodeCard } from '../../src/core/tonuino/card';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { card } from '../../src/app/state';
import { readCardText } from '../../src/features/cards/ReadCardActions';

afterEach(() => {
  card.value = null;
});

describe('readCardText', () => {
  it('names the folder inside the sentence', () => {
    const catalog = newCatalog();
    catalog.folders['04'] = { title: 'Die Olchis', tracks: [], addedAt: 1, updatedAt: 1 };
    card.value = { catalog } as never;
    expect(readCardText(encodeCard({ folder: 4, mode: 5, special: 0, special2: 0 }))).toBe('Hörbuch: Ordner 04 („Die Olchis“).');
  });

  it('says plainly what is on a card without a known folder', () => {
    expect(readCardText(encodeCard({ folder: 4, mode: 5, special: 0, special2: 0 }))).toBe('Hörbuch: Ordner 04.');
    expect(readCardText(new Uint8Array(16))).toBe('Die Karte ist leer.');
  });
});
