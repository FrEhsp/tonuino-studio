import { afterEach, describe, expect, it } from 'vitest';
import { boxScan, card, cardCatalog, catalog, closeCard, coverUrlFor, NEEDS_CARD, profileDecision, remembered, setProfile, shownMemory, transferredToCard, updateCatalog, type CardState } from '../../src/app/state';
import { markOffered, offerRemember, setRemembering } from '../../src/app/remembered';
import { newCatalog, type Catalog } from '../../src/core/tonuino/catalog';
import { buildBoxMemory, memoryCatalog, memoryScan } from '../../src/core/tonuino/remember';
import { scanSd } from '../../src/core/tonuino/sd';
import { addExtraCard, canRemoveExtra, cardItems, extras, looseExtras } from '../../src/features/cards/items';
import { memDir } from '../../src/platform/memory';

const AT = new Date(2026, 9, 13, 18, 30).getTime();

async function rememberedBox() {
  const root = memDir({ mp3: { '0262.mp3': new Uint8Array(10) }, '01': { '001.mp3': new Uint8Array(100) }, '02': { '001.mp3': new Uint8Array(50) } });
  const scan = await scanSd(root);
  const c: Catalog = newCatalog('Emmas TonUINO', 'tng');
  c.folders['01'] = { title: 'Bibi Blocksberg', tracks: [{ file: '001.mp3', title: 'Hexen-Ei' }], cover: '01.jpg', addedAt: AT, updatedAt: AT };
  c.extraCards = [{ id: 'x1', label: 'Schlummerkarte, 15 Minuten', folder: 0, mode: 1, special: 15, special2: 0 }];
  const memory = buildBoxMemory(scan, c, { label: 'TONUINO', at: AT });
  remembered.value = { memory, scan: memoryScan(memory, true), catalog: memoryCatalog(memory)!, coverUrls: new Map([['01.jpg', 'blob:thumb-01']]) };
  return { root, scan, catalog: c };
}

describe('the remembered box in place of the card', () => {
  afterEach(() => {
    remembered.value = null;
    looseExtras.value = [];
    closeCard();
  });

  it('shows its folders, names, covers and cards while no card is open', async () => {
    await rememberedBox();
    expect(shownMemory.value).not.toBeNull();
    expect(cardCatalog.value).toBeNull();
    expect(catalog.value?.name).toBe('Emmas TonUINO');
    expect(boxScan.value?.folders.map((f) => f.number)).toEqual([1, 2]);
    expect(coverUrlFor(1)).toBe('blob:thumb-01');
    expect(coverUrlFor(2)).toBeUndefined();
    expect(cardItems.value.map((i) => i.title)).toEqual(['Bibi Blocksberg', 'Ordner 02', 'Schlummerkarte, 15 Minuten']);
    // The firmware as its announcements said, though the memory has none of them.
    expect(profileDecision.value).toMatchObject({ profile: 'tng', source: 'sounds' });
  });

  it('is never changed: catalog changes say that the card is needed', async () => {
    await rememberedBox();
    await expect(updateCatalog((c) => (c.name = 'Anders'))).rejects.toThrow(NEEDS_CARD);
    expect(catalog.value?.name).toBe('Emmas TonUINO');
  });

  it('keeps its own cards; cards made meanwhile wait in the app, for the card', async () => {
    await rememberedBox();
    const own = cardItems.value.find((i) => i.extra?.id === 'x1')!;
    expect(canRemoveExtra(own)).toBe(false);
    await addExtraCard({ folder: 0, mode: 3, special: 0, special2: 0 }, 'Alles gesperrt');
    expect(looseExtras.value.map((x) => x.label)).toEqual(['Alles gesperrt']);
    expect(extras.value.map((x) => x.label)).toEqual(['Schlummerkarte, 15 Minuten', 'Alles gesperrt']);
    const made = cardItems.value.find((i) => i.title === 'Alles gesperrt')!;
    expect(canRemoveExtra(made)).toBe(true);
  });

  it('follows a firmware chosen by hand while it shows, without writing anything', async () => {
    await rememberedBox();
    await setProfile('classic21');
    expect(profileDecision.value).toMatchObject({ profile: 'classic21', source: 'manual' });
    expect(remembered.value?.memory.catalog).toContain('"profile": "tng"');
    await setProfile('tng');
  });

  it('steps back as soon as a card is open', async () => {
    const { root, scan, catalog: c } = await rememberedBox();
    const state: CardState = { volume: { id: 'v', label: 'SD', root, info: {}, canEject: false }, status: 'ready', scan, catalog: { ...c, name: 'Die Karte' }, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
    card.value = state;
    expect(shownMemory.value).toBeNull();
    expect(catalog.value?.name).toBe('Die Karte');
    expect(boxScan.value).toBe(scan);
    expect(coverUrlFor(1)).toBeUndefined();
  });
});

describe('the question on "Meine Box"', () => {
  afterEach(() => closeCard());

  it('comes after the first transfer to a card set up by the app, and goes with the switch', async () => {
    const root = memDir({ '01': { '001.mp3': new Uint8Array(10) } });
    const scan = await scanSd(root);
    const base: CardState = { volume: { id: 'v', label: 'SD', root, info: {}, canEject: false }, status: 'ready', scan, catalog: newCatalog('Box'), catalogOnCard: false, covers: new Map(), coverUrls: new Map(), info: {} };
    card.value = { ...base, catalogOnCard: true };
    // Not on the first look at the shelf: only after something went onto the card.
    expect(offerRemember.value).toBe(false);
    transferredToCard.value = true;
    card.value = base;
    // A card without the app's catalog has no id to remember it by.
    expect(offerRemember.value).toBe(false);
    card.value = { ...base, catalogOnCard: true };
    expect(offerRemember.value).toBe(true);
    // Shown once, it stays for this session (the next start does not ask again).
    markOffered();
    expect(offerRemember.value).toBe(true);
    card.value = { ...base, catalogOnCard: true, status: 'scanning' };
    expect(offerRemember.value).toBe(false);
    card.value = { ...base, catalogOnCard: true };
    setRemembering(true);
    expect(offerRemember.value).toBe(false);
    setRemembering(false);
    // Answered once (the switch counts as an answer): not asked again.
    expect(offerRemember.value).toBe(false);
  });
});
