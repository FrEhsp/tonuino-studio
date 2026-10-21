/**
 * Own pictures (no SD card) stay on this computer: after a reload they are
 * back with what was chosen for them, and the same file is not added twice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tinyJpeg, tinyPng } from './fixtures';

/** IndexedDB of the page, shared by the "page loads" below. */
const db = new Map<string, unknown>();

vi.mock('../../src/platform/web/idb', () => ({
  kv: {
    get: async (key: string) => db.get(key),
    set: async (key: string, value: unknown) => void db.set(key, value),
    delete: async (key: string) => void db.delete(key),
    keys: async (prefix = '') => [...db.keys()].filter((k) => k.startsWith(prefix)),
  },
}));

/** A fresh page load: new modules, the same store. */
async function load() {
  vi.resetModules();
  const content = await import('../../src/features/stickers/content');
  const store = await import('../../src/features/stickers/looseStore');
  await store.restoreLooseStickers();
  return { ...content, ...store };
}

const jpeg = () => new Blob([tinyJpeg() as BlobPart], { type: 'image/jpeg' });
const png = () => new Blob([tinyPng() as BlobPart], { type: 'image/png' });

afterEach(() => db.clear());

describe('own pictures after a reload', () => {
  it('come back with title, number, colour and section', async () => {
    const first = await load();
    first.addLooseStickers([{ name: '05_Bibi Blocksberg.jpg', blob: jpeg() }, { name: 'Strand.png', blob: png() }]);
    const id = first.looseStickers.value[0].id;
    first.updateLooseSticker(id, { color: '#336699', zoom: 1.5, focusY: 0.2, title: 'Bibi' });
    await first.looseStickersSaved();

    const again = await load();
    const [bibi, beach] = again.looseStickers.value;
    expect(bibi).toMatchObject({ id, title: 'Bibi', number: 5, color: '#336699', zoom: 1.5, focusY: 0.2 });
    expect(bibi.blob.type).toBe('image/jpeg');
    expect(bibi.blob.size).toBe(tinyJpeg().length);
    expect(beach).toMatchObject({ title: 'Strand' });
    expect(again.stickerItems.value.map((s) => s.title)).toEqual(['Bibi', 'Strand']);
  });

  it('stay left out of the sheet when they were not chosen', async () => {
    const first = await load();
    first.addLooseStickers([{ name: 'Eins.jpg', blob: jpeg() }, { name: 'Zwei.jpg', blob: jpeg() }]);
    first.setLooseSelected(false, first.looseStickers.value[0].id);
    await first.looseStickersSaved();

    const again = await load();
    expect(again.looseStickers.value.map((l) => l.title)).toEqual(['Eins', 'Zwei']);
    expect(again.stickerItems.value.map((s) => s.title)).toEqual(['Zwei']);
  });

  it('forget a removed picture and the old one after "Anderes Bild"', async () => {
    const first = await load();
    first.addLooseStickers([{ name: 'Eins.jpg', blob: jpeg() }, { name: 'Zwei.jpg', blob: jpeg() }]);
    const [one, two] = first.looseStickers.value;
    first.removeLooseSticker(two.id);
    first.replaceLoosePicture(one.id, png());
    await first.looseStickersSaved();
    const pictures = [...db.keys()].filter((k) => k.startsWith('sticker-loose:'));
    expect(pictures).toEqual([`sticker-loose:${one.id}~1`]);

    const again = await load();
    expect(again.looseStickers.value.map((l) => l.title)).toEqual(['Eins']);
    expect(again.looseStickers.value[0].blob.type).toBe('image/png');
  });
});

describe('a pictogram for an own picture (no SD card)', () => {
  it('stays after a reload and after "Anderes Bild", and takes the picture\'s place on a Bildkarte only', async () => {
    const first = await load();
    first.addLooseStickers([{ name: 'Hund.jpg', blob: jpeg() }]);
    const id = first.looseStickers.value[0].id;
    first.updateLooseSticker(id, { pictogram: 2517 });
    first.replaceLoosePicture(id, png());
    await first.looseStickersSaved();

    const again = await load();
    const [item] = again.stickerItems.value;
    expect(item).toMatchObject({ title: 'Hund', pictogram: 2517, loose: true });
    const { pictogramInstead } = await import('../../src/features/stickers/pipeline');
    const { getTemplate } = await import('../../src/core/stickers/templates');
    const { DEFAULT_DESIGN } = await import('../../src/features/stickers/design');
    const setup = (style: string, template: string) => ({ design: { ...DEFAULT_DESIGN, style }, template: getTemplate(template)!, bleedMm: 1 }) as unknown as Parameters<typeof pictogramInstead>[1];
    expect(pictogramInstead(item, setup('bild', 'card-a4'))).toBe(true);
    expect(pictogramInstead(item, setup('tape', 'card-a4'))).toBe(false);
    expect(pictogramInstead(item, setup('bild', 'round-30'))).toBe(false);
    expect(pictogramInstead({ ...item, loose: undefined }, setup('bild', 'card-a4'))).toBe(false);
  });
});


describe('adding the same picture again', () => {
  it('leaves it out and says how many were there already', async () => {
    const page = await load();
    expect(page.addLooseStickers([{ name: 'Eins.jpg', blob: jpeg() }, { name: 'Zwei.png', blob: png() }])).toBe(0);
    expect(page.addLooseStickers([{ name: 'Eins.jpg', blob: jpeg() }, { name: 'Zwei.png', blob: png() }, { name: 'Drei.jpg', blob: jpeg() }])).toBe(2);
    // Twice in one go counts too; another file of the same name but a different size is another picture.
    expect(page.addLooseStickers([{ name: 'Vier.jpg', blob: jpeg() }, { name: 'Vier.jpg', blob: jpeg() }, { name: 'Eins.jpg', blob: png() }])).toBe(1);
    expect(page.looseStickers.value.map((l) => l.title)).toEqual(['Eins', 'Zwei', 'Drei', 'Vier', 'Eins']);
  });
});
