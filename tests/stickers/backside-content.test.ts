/** What the back of a sticker shows (extra "Sticker-Rückseite"). */
import { afterEach, describe, expect, it } from 'vitest';
import { card, settings } from '../../src/app/state';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { scanSd } from '../../src/core/tonuino/sd';
import { memDir } from '../../src/platform/memory';
import { cardItems } from '../../src/features/cards/items';
import { stickerFromCard } from '../../src/features/stickers/content';
import { backContentFor, backMode } from '../../src/features/stickers/backside';
import { design, printSetup } from '../../src/features/stickers/design';
import { PICTOGRAM_CREDIT } from '../../src/core/stickers/arasaac';

const defaults = settings.value;
const print = printSetup.value;
afterEach(() => {
  settings.value = defaults;
  printSetup.value = print;
  card.value = null;
});

async function useCard() {
  const scan = await scanSd(memDir({ '03': { '001.mp3': 10, '002_Das Lied.mp3': 10, '003.mp3': 10, '004.mp3': 10 } }));
  const cat = newCatalog();
  cat.folders['03'] = { title: 'Sammlung', tracks: [{ file: '001.mp3', title: 'Anfang' }, { file: '003.mp3', title: 'Mitte' }], addedAt: 1, updatedAt: 1 };
  cat.extraCards = [
    { id: 'e1', label: 'Folge 2', folder: 3, mode: 8, special: 3, special2: 4 },
    { id: 's1', label: 'Schlummerkarte, 15 Minuten', folder: 0, mode: 1, special: 15, special2: 0 },
  ];
  card.value = { volume: { id: 'sd', label: 'SD', root: memDir({}), info: {}, canEject: false }, status: 'ready', scan, catalog: cat, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
}

const sticker = (key: string) => stickerFromCard(cardItems.value.find((c) => c.key === key)!);

describe('backContentFor', () => {
  it('lists every track of a folder card, with titles from the catalog or the file name', async () => {
    await useCard();
    const back = backContentFor(sticker('f3'))!;
    expect(back.number).toBe('03');
    expect(back.heading).toBe('Sammlung');
    expect(back.tracks).toEqual([
      { number: 1, title: 'Anfang' },
      { number: 2, title: 'Das Lied' },
      { number: 3, title: 'Mitte' },
      { number: 4, title: 'Titel 4' },
    ]);
  });

  it('lists only the tracks of a card "von … bis …", named after the episode', async () => {
    await useCard();
    const back = backContentFor(sticker('x:e1'))!;
    expect(back.heading).toBe('Folge 2');
    expect(back.subheading).toBe('Sammlung');
    expect(back.tracks?.map((t) => t.number)).toEqual([3, 4]);
  });

  it('says what a special card does, and leaves own pictures blank', async () => {
    await useCard();
    const back = backContentFor(sticker('x:s1'))!;
    expect(back.tracks).toBeUndefined();
    expect(back.text).toMatch(/15 Minuten/);
    expect(back.text).toMatch(/Lege die Karte kurz auf/);
    expect(backContentFor({ ...sticker('f3'), key: 'l:1', loose: true })).toBeUndefined();
  });

  it('names the source of an ARASAAC pictogram on the back of a Bildkarte that shows one', async () => {
    await useCard();
    const cat = card.value!.catalog!;
    cat.folders['03'].sticker = { pictogram: 2382 };
    card.value = { ...card.value!, catalog: { ...cat } };
    const folder = sticker('f3');
    expect(folder.pictogram).toBe(2382);
    // A further card of the folder shows the folder's choice.
    expect(sticker('x:e1').pictogram).toBe(2382);
    const designBefore = design.value;
    try {
      design.value = { ...designBefore, style: 'bild' };
      expect(backContentFor(folder)!.credit).toBe(PICTOGRAM_CREDIT);
      // A cover wins over the pictogram: then there is nothing to name.
      expect(backContentFor({ ...folder, picture: { kind: 'url', url: 'blob:x' } })!.credit).toBeUndefined();
      design.value = { ...designBefore, style: 'tape' };
      expect(backContentFor(folder)!.credit).toBeUndefined();
    } finally {
      design.value = designBefore;
    }
  });

  it('prints backs only with the extra switched on and on paper printed at home', () => {
    printSetup.value = { ...print, templateId: 'card-a4', back: 'list' };
    expect(backMode.value).toBe('none');
    settings.value = { ...defaults, stickerBacks: true };
    expect(backMode.value).toBe('list');
    printSetup.value = { ...print, templateId: 'photo-13x18', back: 'list' };
    expect(backMode.value).toBe('none');
  });
});
