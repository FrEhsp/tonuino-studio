/**
 * Stickers from own pictures (no SD card): "Anderes Bild" swaps the picture,
 * keeps title and number, and forgets what was chosen for the old picture.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addLooseStickers, imageBlobOf, looseIdOf, looseStickers, removeAllLooseStickers, removeLooseSticker, replaceLoosePicture, setLooseSelected, stickerItems, updateLooseSticker } from '../../src/features/stickers/content';
import type { ByteSource } from '../../src/platform/types';
import { tinyJpeg, tinyPng } from './fixtures';

afterEach(() => {
  for (const l of looseStickers.value) removeLooseSticker(l.id);
});

describe('"Anderes Bild" for an own picture', () => {
  it('takes the new picture and keeps title and number', () => {
    addLooseStickers([{ name: '05_Bibi Blocksberg.jpg', blob: new Blob([tinyJpeg() as BlobPart], { type: 'image/jpeg' }) }]);
    const [before] = stickerItems.value;
    const id = looseIdOf(before)!;
    expect(id).toBe(looseStickers.value[0].id);
    updateLooseSticker(id, { color: '#336699', zoom: 2, focusX: 0.2, focusY: 0.7, orientation: 'portrait', title: 'Bibi' });

    const png = new Blob([tinyPng() as BlobPart], { type: 'image/png' });
    replaceLoosePicture(id, png);
    const [after] = stickerItems.value;
    expect(after.key).toBe(before.key);
    expect(after.title).toBe('Bibi');
    expect(after.number).toBe('05');
    expect(after.picture?.kind === 'blob' && after.picture.blob).toBe(png);
    // A picture id of its own: the sheet draws and measures the new picture, not the cached old one.
    expect(after.picture?.kind === 'blob' && before.picture?.kind === 'blob' && after.picture.id !== before.picture.id).toBe(true);
    // Colour, section and orientation were chosen for the old picture.
    expect(after).toMatchObject({ color: undefined, zoom: undefined, focusX: undefined, focusY: undefined, orientation: undefined });

    // Saving the dialog afterwards still finds the sticker by its id.
    updateLooseSticker(looseIdOf(after)!, { color: '#112233' });
    expect(stickerItems.value[0].color).toBe('#112233');
    replaceLoosePicture(id, png);
    expect(stickerItems.value[0].picture?.kind === 'blob' && stickerItems.value[0].picture.id).toBe(`${id}~2`);
  });

  it('only for stickers from own pictures', () => {
    expect(looseIdOf({ key: 'f3', loose: undefined })).toBeUndefined();
    expect(looseIdOf({ key: 'l:abc', loose: true })).toBe('abc');
    // An id that is gone changes nothing.
    replaceLoosePicture('gone', new Blob([]));
    expect(looseStickers.value).toEqual([]);
  });

  it('gives a picture without a type the type of its content', async () => {
    const source = (data: Uint8Array): ByteSource => ({ name: 'bild', size: data.length, read: async (o: number, n: number) => data.subarray(o, o + n) }) as ByteSource;
    expect((await imageBlobOf(source(tinyPng()))).type).toBe('image/png');
    expect((await imageBlobOf(source(tinyJpeg()))).type).toBe('image/jpeg');
  });
});

describe('choosing own pictures for the sheet', () => {
  const jpeg = () => new Blob([tinyJpeg() as BlobPart], { type: 'image/jpeg' });

  it('leaves out pictures that are not chosen, one or all, and keeps their colour by place', () => {
    addLooseStickers([{ name: 'Eins.jpg', blob: jpeg() }, { name: 'Zwei.jpg', blob: jpeg() }, { name: 'Drei.jpg', blob: jpeg() }]);
    const colourOfDrei = stickerItems.value[2].flatColor;
    const [one] = looseStickers.value;
    setLooseSelected(false, one.id);
    expect(stickerItems.value.map((s) => s.title)).toEqual(['Zwei', 'Drei']);
    expect(stickerItems.value[1].flatColor).toBe(colourOfDrei);
    // "Keine": none of them on the sheet, all still in the list.
    setLooseSelected(false);
    expect(stickerItems.value).toEqual([]);
    expect(looseStickers.value).toHaveLength(3);
    // "Alle" chooses them again.
    setLooseSelected(true);
    expect(stickerItems.value.map((s) => s.title)).toEqual(['Eins', 'Zwei', 'Drei']);
  });

  it('keeps a picture left out when it gets another picture, and removes all at once', () => {
    addLooseStickers([{ name: 'Eins.jpg', blob: jpeg() }, { name: 'Zwei.jpg', blob: jpeg() }]);
    const [one] = looseStickers.value;
    setLooseSelected(false, one.id);
    replaceLoosePicture(one.id, new Blob([tinyPng() as BlobPart], { type: 'image/png' }));
    expect(looseStickers.value[0].off).toBe(true);
    expect(stickerItems.value.map((s) => s.title)).toEqual(['Zwei']);
    removeAllLooseStickers();
    expect(looseStickers.value).toEqual([]);
  });
});
