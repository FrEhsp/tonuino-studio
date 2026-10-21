import { describe, expect, it } from 'vitest';
import type { ExtraCard } from '../../src/core/tonuino/catalog';
import { newCatalog, parseCatalog, serializeCatalog } from '../../src/core/tonuino/catalog';
import { asFormat20, format20Problem, FORMAT20_NOTE } from '../../src/features/cards/format20';
import { buildCardItems, sameCard } from '../../src/features/cards/items';

describe('card format of TonUINO 2.0', () => {
  it('turns every card into version 1 and marks what 2.0 cannot play', () => {
    const extras: ExtraCard[] = [
      { id: 's', label: 'Schlummerkarte, 15 Minuten', folder: 0, mode: 1, special: 15, special2: 0 },
      { id: 'p', label: 'Titel 3', folder: 4, mode: 4, special: 3, special2: 0 },
      { id: 'r', label: 'Wiederholen', folder: 4, mode: 12, special: 0, special2: 0 },
    ];
    const items = asFormat20(buildCardItems(undefined, null, extras, 'tng'));
    expect(items.every((i) => i.data.version === 1)).toBe(true);
    expect(items.find((i) => i.key === 'x:s')!.unsupported).toBe('TonUINO 2.0 kennt keine Spezialkarten.');
    expect(items.find((i) => i.key === 'x:p')!.unsupported).toBeUndefined();
    expect(format20Problem({ data: { folder: 4, mode: 12, special: 0, special2: 0 } })).toBe('Diesen Modus kennt TonUINO 2.0 nicht.');
  });

  it('names the old format on single cards, but not when the whole list has it', () => {
    const one: ExtraCard[] = [{ id: 'a', label: 'Hörspiel', folder: 0, mode: 1, special: 15, special2: 0, version: 1 }];
    const items = buildCardItems(undefined, null, one, 'tng');
    expect(items[0].data.version).toBe(1);
    expect(items[0].summary.startsWith(`${FORMAT20_NOTE} · `)).toBe(true);
    expect(asFormat20(items)[0].summary.startsWith(FORMAT20_NOTE)).toBe(false);
  });

  it('keeps version 1 in the catalog and tells the two formats apart', () => {
    const c = newCatalog();
    c.extraCards = [
      { id: 'a', label: 'x', folder: 3, mode: 2, special: 0, special2: 0, version: 1 },
      { id: 'b', label: 'y', folder: 3, mode: 2, special: 0, special2: 0, version: 7 },
    ];
    const cat = parseCatalog(serializeCatalog(c));
    expect(cat?.extraCards.map((x) => x.version)).toEqual([1, undefined]);
    expect(sameCard({ folder: 3, mode: 2, special: 0, special2: 0 }, { folder: 3, mode: 2, special: 0, special2: 0, version: 2 })).toBe(true);
    expect(sameCard({ folder: 3, mode: 2, special: 0, special2: 0 }, { folder: 3, mode: 2, special: 0, special2: 0, version: 1 })).toBe(false);
  });
});
