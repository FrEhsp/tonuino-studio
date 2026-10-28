/** Stickers for the cards of the cards list: further cards for a folder and special cards. */
import { afterEach, describe, expect, it } from 'vitest';
import { CircleHelp, KeyRound } from 'lucide-preact';
import { card, settings } from '../../src/app/state';
import { newCatalog, type ExtraCard } from '../../src/core/tonuino/catalog';
import { scanSd } from '../../src/core/tonuino/sd';
import { memDir } from '../../src/platform/memory';
import { buildCardItems } from '../../src/features/cards/items';
import { MODIFIER_ICONS } from '../../src/features/cards/SpecialCardDialog';
import { renderKey, type RenderSetup } from '../../src/features/stickers/pipeline';
import { folderPart, stickerFromCard } from '../../src/features/stickers/content';
import { badgeText, titleShown } from '../../src/features/stickers/render';
import { pictogramWord } from '../../src/features/stickers/pictogramWord';
import type { StickerDesign } from '../../src/features/stickers/design';

const defaults = settings.value;
afterEach(() => {
  settings.value = defaults;
  card.value = null;
});

const extra = (x: Partial<ExtraCard>): ExtraCard => ({ id: 'x1', label: 'Das Hexenfest', folder: 0, mode: 0, special: 0, special2: 0, ...x });

describe('stickerFromCard', () => {
  it('writes the name of a further card for a folder big, the folder under it', async () => {
    const scan = await scanSd(memDir({ '03': { '001.mp3': 10, '002.mp3': 10 } }));
    const cat = newCatalog();
    cat.folders['03'] = { title: 'Bibi Blocksberg', tracks: [], addedAt: 1, updatedAt: 1 };
    card.value = { volume: { id: 'sd', label: 'SD', root: memDir({}), info: {}, canEject: false }, status: 'ready', scan, catalog: cat, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
    const items = buildCardItems(scan, cat, [extra({ folder: 3, mode: 4, special: 2 })], 'tng');
    const item = items.find((i) => i.extra)!;
    expect(item.title).toBe('Bibi Blocksberg · Das Hexenfest');
    const s = stickerFromCard(item);
    expect(s.title).toBe('Das Hexenfest');
    expect(s.subtitle).toBe('Bibi Blocksberg');
  });

  it('keeps the symbol of a TNG card on a 2.1 box, the key stays the Admin-Karte\'s', () => {
    settings.value = { ...defaults, profile: 'classic21' };
    const [jukebox] = buildCardItems(undefined, null, [extra({ label: 'Jukebox', mode: 8 })], 'classic21');
    const s = stickerFromCard(jukebox);
    expect(s.icon).toBe(MODIFIER_ICONS['list-music']);
    expect(s.icon).not.toBe(KeyRound);
    const [unknown] = buildCardItems(undefined, null, [extra({ label: 'Was ist das?', mode: 99 })], 'tng');
    expect(stickerFromCard(unknown).icon).toBe(CircleHelp);
  });

  it('draws a special card anew when its symbol changes with the firmware', () => {
    const [jukebox] = buildCardItems(undefined, null, [extra({ label: 'Jukebox', mode: 8 })], 'tng');
    const s = stickerFromCard(jukebox);
    const setup = { design: {}, template: { id: 't', label: 'T', safeMarginMm: 1 }, bleedMm: 1 } as unknown as RenderSetup;
    expect(renderKey(s, setup, 10)).not.toBe(renderKey({ ...s, icon: KeyRound, flatColor: '#000000' }, setup, 10));
  });

  it('gives a special card the pictogram chosen for it, its text and colour stay (TODO 0.3 #103)', () => {
    const [plain] = buildCardItems(undefined, null, [extra({ label: 'Schlummerkarte', mode: 1, special: 15 })], 'tng');
    const [withPicto] = buildCardItems(undefined, null, [extra({ label: 'Schlummerkarte', mode: 1, special: 15, sticker: { pictogram: 2369 } })], 'tng');
    const a = stickerFromCard(plain);
    const b = stickerFromCard(withPicto);
    expect(a.pictogram).toBeUndefined();
    expect('pictogram' in a).toBe(false);
    expect(b.pictogram).toBe(2369);
    expect(b.title).toBe(a.title);
    expect(b.flatColor).toBe(a.flatColor);
    const setup = { design: {}, template: { id: 't', label: 'T', safeMarginMm: 1 }, bleedMm: 1 } as unknown as RenderSetup;
    expect(renderKey(b, setup, 10)).not.toBe(renderKey(a, setup, 10));
    const [again] = buildCardItems(undefined, null, [extra({ label: 'Nochmal', folder: 0xff, mode: 0, sticker: { pictogram: 7 } })], 'tng');
    expect(stickerFromCard(again).pictogram).toBe(7);
  });
});

describe('the word the pictogram search starts with', () => {
  it('is what a special card does, not its name', () => {
    expect(pictogramWord('Schlummerkarte', true)).toBe('schlafen');
    expect(pictogramWord('Stopptanz', true)).toBe('tanzen');
    expect(pictogramWord('Admin-Karte', true)).toBe('Schlüssel');
    expect(pictogramWord('Titel wiederholen', true)).toBe('wiederholen');
    expect(pictogramWord('Etwas Neues', true)).toBe('Etwas Neues');
  });

  it('is the first three words of any other title', () => {
    expect(pictogramWord('  Der kleine Drache Kokosnuss 3 ')).toBe('Der kleine Drache');
    expect(pictogramWord('Schlummerkarte')).toBe('Schlummerkarte');
  });
});

describe('several cards of one folder', () => {
  const design = { showTitle: false, showNumber: true } as StickerDesign;

  it('each have a sticker of their own, also with "Titel zeigen" off', async () => {
    const scan = await scanSd(memDir({ '14': Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${String(i + 1).padStart(3, '0')}.mp3`, 10])) }));
    const cat = newCatalog();
    cat.folders['14'] = { title: 'Die drei ???', tracks: [], addedAt: 1, updatedAt: 1, sticker: { focusY: 0.2, zoom: 2 } };
    card.value = { volume: { id: 'sd', label: 'SD', root: memDir({}), info: {}, canEject: false }, status: 'ready', scan, catalog: cat, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
    const episodes = [
      extra({ id: 'a', label: 'Folge eins', folder: 14, mode: 7, special: 1, special2: 12 }),
      extra({ id: 'b', label: 'Folge zwei', folder: 14, mode: 7, special: 13, special2: 15, sticker: { title: 'Zwei', zoom: 1 }, color: '#123456' }),
      extra({ id: 'c', label: 'Titel 16', folder: 14, mode: 4, special: 16 }),
    ];
    const stickers = buildCardItems(scan, cat, episodes, 'tng')
      .filter((i) => i.extra)
      .map(stickerFromCard)
      .sort((a, b) => a.key.localeCompare(b.key));
    expect(stickers.map((s) => s.part)).toEqual(['1–12', '13–15', '16']);
    expect(stickers.map((s) => s.title)).toEqual(['Folge eins', 'Zwei', 'Titel 16']);
    expect(stickers.every((s) => titleShown(s, design))).toBe(true);
    // Round stickers show no title: the tracks stand where the number would.
    expect(stickers.map((s) => badgeText(s, design, true))).toEqual(['1–12', '13–15', '16']);
    // On a sticker with a picture: folder and tracks, so the card can be told from the folder's own (Frank 16.10.).
    expect(badgeText({ ...stickers[0], picture: { kind: 'url', url: 'cover.jpg' } }, design)).toBe('14 · 1–12');
    // On the generated picture the folder number is big already: the tracks in words below it.
    expect(stickers.map((s) => badgeText(s, design))).toEqual(['Titel 1–12', 'Titel 13–15', 'Titel 16']);
    expect(badgeText(stickers[0], { ...design, showNumber: false })).toBe('14 · 1–12');
    // Adjusted on its own; what it leaves out still follows the folder.
    expect(stickers[1]).toMatchObject({ zoom: 1, focusY: 0.2, color: '#123456' });
    expect(stickers[0]).toMatchObject({ zoom: 2, focusY: 0.2 });
  });

  it('an episode of a packed series shows the picture it had as a folder, with its own section', async () => {
    const scan = await scanSd(memDir({ '02': { '001.mp3': 10, '002.mp3': 10 } }));
    const cat = newCatalog();
    cat.folders['02'] = { title: 'Unter meinem Bett', cover: '02.jpg', tracks: [], addedAt: 1, updatedAt: 1, sticker: { focusY: 0.2, zoom: 2 } };
    const coverUrls = new Map([
      ['02.jpg', 'blob:ordner'],
      ['folge-a.jpg', 'blob:folge'],
    ]);
    card.value = { volume: { id: 'sd', label: 'SD', root: memDir({}), info: {}, canEject: false }, status: 'ready', scan, catalog: cat, catalogOnCard: true, covers: new Map(), coverUrls, info: {} };
    const [own, plain] = buildCardItems(scan, cat, [extra({ id: 'a', label: 'Unter meinem Bett 2', folder: 2, mode: 8, special: 2, special2: 2, cover: 'folge-a.jpg', sticker: { zoom: 1 } }), extra({ id: 'b', label: 'Lied', folder: 2, mode: 4, special: 1 })], 'tng')
      .filter((i) => i.extra)
      .map(stickerFromCard)
      .sort((a, b) => a.key.localeCompare(b.key));
    expect(own).toMatchObject({ title: 'Unter meinem Bett 2', subtitle: 'Unter meinem Bett', number: '02', part: '2', picture: { kind: 'url', url: 'blob:folge' }, zoom: 1 });
    expect(own.focusY).toBeUndefined();
    expect(plain).toMatchObject({ picture: { kind: 'url', url: 'blob:ordner' }, zoom: 2, focusY: 0.2 });
    expect(badgeText(own, design)).toBe('02 · 2');
  });

  it('a folder\'s own sticker keeps following "Titel zeigen"', () => {
    expect(titleShown({ title: 'x' } as never, design)).toBe(false);
    expect(folderPart({ mode: 5, special: 0, special2: 0 })).toBe('Hörbuch');
    expect(folderPart({ mode: 8, special: 4, special2: 4 })).toBe('4');
  });
});

