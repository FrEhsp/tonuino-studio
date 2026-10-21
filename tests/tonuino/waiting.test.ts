import { describe, expect, it } from 'vitest';
import { newCatalog, type Catalog } from '../../src/core/tonuino/catalog';
import { applyLooks, hasWaiting, noWaiting, parseWaiting, waitingCoverEntry, withWaiting } from '../../src/core/tonuino/waiting';

function box(): Catalog {
  const c = newCatalog('Emmas Box');
  c.folders['01'] = { title: 'Das Kürbisfest', tracks: [], addedAt: 1, updatedAt: 100, cover: '01.jpg', color: '#ff0000', sticker: { title: 'Kürbis', zoom: 1.2, recipe: '-' } };
  c.folders['02'] = { title: 'Spuckepack', tracks: [], addedAt: 1, updatedAt: 100 };
  c.extraCards = [{ id: 'x1', label: 'Folge 2', folder: 2, mode: 1, special: 0, special2: 0 }];
  return c;
}

describe('sticker changes without the card', () => {
  it('shows looks and covers in the remembered catalog, leaving the original as it was', () => {
    const w = noWaiting();
    w.looks['02'] = { sticker: { zoom: 0.8 }, color: '#00ff00', at: 200 };
    w.extras.x1 = { sticker: { title: 'Zwei' }, at: 200 };
    w.covers['01'] = { data: new Uint8Array([1, 2]), mimeType: 'image/png', source: 'Datei', orientation: 'portrait', at: 150 };
    const c = box();
    const shown = withWaiting(c, w);
    expect(shown.folders['02'].sticker).toEqual({ zoom: 0.8 });
    expect(shown.folders['02'].color).toBe('#00ff00');
    expect(shown.extraCards[0].sticker).toEqual({ title: 'Zwei' });
    // A new cover drops colour and section chosen for the old one; text and recipe stay.
    expect(shown.folders['01'].cover).toBe(waitingCoverEntry('01', 'image/png'));
    expect(shown.folders['01'].color).toBeUndefined();
    expect(shown.folders['01'].sticker).toEqual({ title: 'Kürbis', recipe: '-', orientation: 'portrait' });
    expect(c.folders['01'].cover).toBe('01.jpg');
  });

  it('puts onto the card only what is newer than the folder there and than its new cover', () => {
    const w = noWaiting();
    w.looks['01'] = { sticker: { zoom: 2 }, at: 140 };
    w.covers['01'] = { data: new Uint8Array([1]), at: 150 };
    w.looks['02'] = { color: '#123456', at: 90 };
    const c = box();
    const n = applyLooks(c, w, (name) => c.folders[name]?.updatedAt ?? 0);
    expect(n).toBe(0);
    expect(c.folders['01'].sticker?.zoom).toBe(1.2);
    expect(c.folders['02'].color).toBeUndefined();
    w.looks['02'] = { color: '#123456', at: 300 };
    expect(applyLooks(c, w, (name) => c.folders[name]?.updatedAt ?? 0)).toBe(1);
    expect(c.folders['02'].color).toBe('#123456');
    expect(c.folders['02'].updatedAt).toBe(300);
  });

  it('reads what was kept leniently', () => {
    expect(hasWaiting(parseWaiting(undefined))).toBe(false);
    expect(hasWaiting(parseWaiting({ looks: { '01': { at: 'x' } }, covers: { '02': { data: 'nope', at: 1 } } }))).toBe(false);
    const w = parseWaiting({ looks: { '01': { color: '#fff', at: 5 } }, covers: { '02': { data: null, at: 6 } } });
    expect(w.looks['01']).toEqual({ sticker: undefined, color: '#fff', at: 5 });
    expect(w.covers['02'].data).toBeNull();
    expect(hasWaiting(w)).toBe(true);
  });
});
