import { afterEach, describe, expect, it } from 'vitest';
import { boot, card, chooseOtherCard, closeCard, healthContext, looksLikeCard, saveAfterRepair, updateCatalog } from '../../src/app/state';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { scanSd, tempDirName } from '../../src/core/tonuino/sd';
import { memDir, type MemTree } from '../../src/platform/memory';
import type { Dir, Platform, Volume } from '../../src/platform/types';

/** A drive with a few top-level folders; everything else is not needed here. */
function drive(id: string, removable: boolean | undefined, folders: string[], more: Volume['info'] = {}): Volume {
  const root = {
    name: id,
    list: async () => folders.map((name) => ({ name, kind: 'directory' as const })),
    dir: async () => {
      throw new Error('not needed');
    },
    exists: async () => false,
  } as unknown as Dir;
  return { id, label: id, root, info: { removable, ...more }, canEject: removable !== false };
}

function platformWith(list: Volume[]): Platform {
  return {
    volumes: {
      subscribe: (cb: (v: Volume[]) => void) => {
        cb(list);
        return () => undefined;
      },
      info: async (v: Volume) => v.info,
    },
  } as unknown as Platform;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('opening a card by itself', () => {
  afterEach(() => closeCard());

  it('never opens a built-in drive on its own', async () => {
    // A second partition under /media, even one with folders named like a card.
    boot(platformWith([drive('/media/anna/Daten', false, ['01', '02', 'Fotos'])]));
    await settle();
    expect(card.value).toBeNull();
  });

  it('does not open a big USB hard disk on its own', async () => {
    // Frank's PC, 0.2.0: a 937 GB USB disk (Steam, Timeshift) opened as "Meine TonUINO-Box".
    boot(platformWith([drive('/media/ben/Daten', true, ['SteamLibrary', 'timeshift'], { fsType: 'ext4', totalBytes: 937.5 * 1024 ** 3 })]));
    await settle();
    expect(card.value).toBeNull();
  });

  it('still opens a big USB drive that holds TonUINO folders', async () => {
    boot(platformWith([drive('/media/ben/Gross', true, ['01', 'mp3'], { fsType: 'exfat', totalBytes: 1000 * 1024 ** 3 })]));
    await settle();
    expect(card.value?.volume.id).toBe('/media/ben/Gross');
  });

  it('does not take a big photo disk with folders 01–12 for a card (Testlabor)', async () => {
    const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
    boot(platformWith([drive('/media/ben/Fotos', true, [...months, 'DCIM'], { fsType: 'fuseblk', totalBytes: 1000 * 1000 ** 4 })]));
    await settle();
    expect(card.value).toBeNull();
  });

  it('opens a fresh, empty card on its own', async () => {
    boot(platformWith([drive('/media/ben/SD', true, [], { fsType: 'vfat', totalBytes: 32 * 1000 ** 3 })]));
    await settle();
    expect(card.value?.volume.id).toBe('/media/ben/SD');
  });

  it('does not open a card again by itself after "Andere Karte wählen"', async () => {
    const sd = drive('/media/ben/SD', true, ['01']);
    let push: (v: Volume[]) => void = () => undefined;
    const p = { volumes: { subscribe: (cb: (v: Volume[]) => void) => ((push = cb), cb([sd]), () => undefined), info: async (v: Volume) => v.info } } as unknown as Platform;
    boot(p);
    await settle();
    expect(card.value?.volume.id).toBe('/media/ben/SD');
    chooseOtherCard();
    push([sd]);
    await settle();
    expect(card.value).toBeNull();
  });

  it('forgets a picked folder in the browser, so a reload does not open it again', async () => {
    const wrong = drive('web-1', undefined, ['Fotos']);
    const forgotten: string[] = [];
    const p = {
      capabilities: { sdAutoDetect: false },
      volumes: { subscribe: (cb: (v: Volume[]) => void) => (cb([wrong]), () => undefined), info: async (v: Volume) => v.info, forget: async (v: Volume) => void forgotten.push(v.id) },
    } as unknown as Platform;
    boot(p);
    await settle();
    expect(card.value?.volume.id).toBe('web-1');
    await chooseOtherCard();
    expect(card.value).toBeNull();
    expect(forgotten).toEqual(['web-1']);
  });

  it('keeps a real box remembered in the browser after "Andere Karte wählen"', async () => {
    const root = memDir({ '01': { '001.mp3': 'eins' } });
    const box: Volume = { id: 'web-2', label: 'web-2', root, info: {}, canEject: false };
    const forgotten: string[] = [];
    const p = {
      capabilities: { sdAutoDetect: false },
      volumes: { subscribe: (cb: (v: Volume[]) => void) => (cb([]), () => undefined), info: async (v: Volume) => v.info, forget: async (v: Volume) => void forgotten.push(v.id) },
    } as unknown as Platform;
    boot(p);
    await settle();
    card.value = { volume: box, status: 'ready', scan: await scanSd(root), catalog: newCatalog(), catalogOnCard: false, covers: new Map(), coverUrls: new Map(), info: {} };
    await chooseOtherCard();
    expect(card.value).toBeNull();
    expect(forgotten).toEqual([]);
  });

  it('tells a card from other drives', () => {
    const d = (info: Volume['info']) => drive('x', true, [], info);
    expect(looksLikeCard(d({ fsType: 'vfat', totalBytes: 64 * 1000 ** 3 }))).toBe(true);
    expect(looksLikeCard(d({ fsType: 'FAT32' }))).toBe(true);
    expect(looksLikeCard(d({ fsType: 'fuseblk', totalBytes: 128 * 1000 ** 3 }))).toBe(true);
    expect(looksLikeCard(d({}))).toBe(true);
    expect(looksLikeCard(d({ fsType: 'ntfs', totalBytes: 64 * 1000 ** 3 }))).toBe(false);
    expect(looksLikeCard(d({ fsType: 'ext4' }))).toBe(false);
    expect(looksLikeCard(d({ fsType: 'exfat', totalBytes: 2000 * 1000 ** 3 }))).toBe(false);
  });

  it('does not open a big Linux disk by itself, even with a catalog on it', async () => {
    boot(platformWith([drive('/mnt/SD', true, ['Steam', 'timeshift', 'tonuino-studio.json'], { fsType: 'ext4', totalBytes: 937 * 1000 ** 3 })]));
    await settle();
    expect(card.value).toBeNull();
  });

  it('opens the card next to a built-in drive', async () => {
    boot(platformWith([drive('/media/anna/Daten', false, ['01', 'mp3']), drive('/media/anna/SD', true, ['01'])]));
    await settle();
    expect(card.value?.volume.id).toBe('/media/anna/SD');
  });
});

/** An open card whose catalog knows folder 05 with these track files. */
async function openCard(tree: MemTree, files: string[]) {
  const root = memDir(tree);
  const catalog = newCatalog();
  catalog.folders['05'] = { title: 'Fünf', tracks: files.map((file) => ({ file, title: `Titel ${file}` })), addedAt: 0, updatedAt: 0 };
  const volume: Volume = { id: 'sd', label: 'SD', root, info: {}, canEject: false };
  card.value = { volume, status: 'ready', scan: await scanSd(root), catalog, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
  return root;
}

const files = () => card.value!.catalog!.folders['05'].tracks.map((t) => t.file);

describe('noting folders in the catalog', () => {
  afterEach(() => closeCard());

  it('keeps the titles of tracks that wait in a helper folder', async () => {
    // A reorder stopped half way: 003.mp3 waits in the helper folder.
    await openCard({ '05': { '001.mp3': 1 }, [tempDirName(5)]: { umsortieren: {}, '002=003.mp3': 3 } }, ['001.mp3', '003.mp3']);
    await updateCatalog((c) => (c.folders['05'].tracks[0].title = 'Eins'), { touchFolders: [5] });
    expect(files()).toEqual(['001.mp3', '003.mp3']);
    expect(card.value!.catalog!.folders['05'].tracks[0].title).toBe('Eins');
  });

  it('tells the health check once someone saw FAT32 for this card', async () => {
    await openCard({ '05': { '001.mp3': 1 } }, ['001.mp3']);
    expect(healthContext(card.value!).formatChecked).toBe(false);
    await updateCatalog((c) => (c.formatChecked = 1));
    expect(healthContext(card.value!).formatChecked).toBe(true);
  });

  it('notes a folder after a repair only with a fresh look at the card', async () => {
    const root = await openCard({ '05': { '001.mp3': 1, '003.mp3': 3 } }, ['001.mp3', '003.mp3']);
    // A repair renamed 003 to 002 and the catalog followed, but reading the card again failed.
    await (await root.dir('05')).rename('003.mp3', '002.mp3');
    const s = card.value!;
    card.value = { ...s, catalog: { ...s.catalog!, folders: { '05': { ...s.catalog!.folders['05'], tracks: [{ file: '001.mp3' }, { file: '002.mp3', title: 'Drei' }] } } } };
    await saveAfterRepair([5], undefined);
    expect(files()).toEqual(['001.mp3', '002.mp3']);
    expect(card.value!.catalog!.folders['05'].fingerprint).toBeUndefined();

    const scan = await scanSd(root);
    card.value = { ...card.value!, scan };
    await saveAfterRepair([5], scan);
    expect(files()).toEqual(['001.mp3', '002.mp3']);
    expect(card.value!.catalog!.folders['05'].fingerprint).toBe('2:4');
  });
});
