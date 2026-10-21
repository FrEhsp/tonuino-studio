/**
 * The folder stickers on the shelf of "Meine Box": the same look as in print,
 * kept across sessions, and standing as cut on round and square labels.
 */
import { describe, expect, it } from 'vitest';
import { scanSd } from '../../src/core/tonuino/sd';
import { memDir } from '../../src/platform/memory';
import { buildCardItems } from '../../src/features/cards/items';
import { folderSeries, folderSticker, folderSubtitle, stickerFromCard } from '../../src/features/stickers/content';
import { shelfGeometry, shelfStickerId } from '../../src/features/stickers/FolderSticker';
import type { StickerGeometry } from '../../src/core/stickers/layout';

describe('shelf sticker', () => {
  it('has the key of its card in print, so "Hörspiel" draws the same frame and tape', async () => {
    const scan = await scanSd(memDir({ '03': { '001.mp3': 10 } }));
    const [card] = buildCardItems(scan, null, [], 'tng');
    expect(folderSticker(3, 'Ordner 03').key).toBe(stickerFromCard(card).key);
  });

  it('keeps its id when the covers get new addresses, and gets a new one with another cover', () => {
    const at = (url: string) => {
      const item = { ...folderSticker(3, 'Bibi'), picture: { kind: 'url' as const, url } };
      return shelfStickerId(JSON.stringify([item.key, item.picture.url, 'design']), item, '03.jpg:1000:42');
    };
    expect(at('blob:http://x/aaa')).toBe(at('blob:http://x/bbb'));
    const item = { ...folderSticker(3, 'Bibi'), picture: { kind: 'url' as const, url: 'blob:http://x/aaa' } };
    const key = JSON.stringify([item.key, item.picture.url, 'design']);
    expect(shelfStickerId(key, item, '03.jpg:1000:43')).not.toBe(shelfStickerId(key, item, '03.jpg:1000:42'));
    // Not the id of the same sticker kept by an app without a drawing version.
    expect(shelfStickerId(key, item, '03.jpg:1000:42')).not.toBe(String(hashOld(key.replace(JSON.stringify(item.picture.url), JSON.stringify('03.jpg:1000:42')))));
  });

  it('stands as cut on round and square labels, also when it is meant to stand upright', () => {
    const round: StickerGeometry = { widthMm: 30, heightMm: 30, bleedMm: 1, safeMm: 2, shape: 'round' };
    const square: StickerGeometry = { ...round, shape: 'rect' };
    for (const g of [round, square]) {
      expect(shelfGeometry(g, 'portrait')).toEqual({ geometry: g, orientation: 'landscape' });
      expect(shelfGeometry(g, 'landscape')).toEqual({ geometry: g, orientation: 'landscape' });
    }
    const wide: StickerGeometry = { widthMm: 85, heightMm: 54, bleedMm: 1, safeMm: 2, shape: 'rect' };
    expect(shelfGeometry(wide, 'portrait')).toEqual({ geometry: { ...wide, widthMm: 54, heightMm: 85 }, orientation: 'portrait' });
    expect(shelfGeometry(wide, 'landscape')).toEqual({ geometry: wide, orientation: 'landscape' });
  });
});

describe('the line under the title', () => {
  it('names series and episode, but not what the title says already', () => {
    expect(folderSubtitle({ title: 'Das Pferd im Schnee', series: 'Bibi & Tina', episode: 5 })).toBe('Bibi & Tina, Folge 5');
    expect(folderSubtitle({ title: 'Bibi & Tina – Das Pferd im Schnee', series: 'Bibi & Tina', episode: 5 })).toBe('Folge 5');
    expect(folderSubtitle({ title: 'Bibi & Tina – Das Pferd im Schnee', series: 'Bibi & Tina' })).toBeUndefined();
    expect(folderSubtitle({ title: 'Bibi & Tina Folge 5', series: 'Bibi & Tina', episode: 5 })).toBeUndefined();
    expect(folderSubtitle({ title: 'Kinderlieder', artist: 'Rolf Zuckowski' })).toBe('Rolf Zuckowski');
    expect(folderSubtitle({ title: 'Rolf Zuckowski: Kinderlieder', artist: 'Rolf Zuckowski' })).toBeUndefined();
  });

  it('names the series in full in the head band of a cassette sticker, with or without a title', () => {
    // The title names the series already: under it only "Folge 5", the head band still says whose episode it is.
    const named = { title: 'Bibi & Tina – Das Pferd im Schnee', series: 'Bibi & Tina', episode: 5 };
    expect(folderSubtitle(named)).toBe('Folge 5');
    expect(folderSeries(named)).toBe('Bibi & Tina, Folge 5');
    expect(folderSeries({ series: 'Bibi & Tina' })).toBe('Bibi & Tina');
    expect(folderSeries({ artist: 'Rolf Zuckowski' })).toBe('Rolf Zuckowski');
    expect(folderSeries({})).toBeUndefined();
    expect(folderSeries(undefined)).toBeUndefined();
  });
});

/** The id as kept before stickers had a drawing version. */
function hashOld(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
