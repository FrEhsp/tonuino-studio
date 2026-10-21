import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { saveCatalog, type Catalog } from '../../src/core/tonuino/catalog';
import { loadCovers, saveCovers } from '../../src/core/tonuino/covers';
import { checkHealth, type HealthContext } from '../../src/core/tonuino/health';
import { packageContent } from '../../src/core/tonuino/package';
import { checkRenumbered, checkSwapped, executePlan, planFix, planRenumberFolder, planReorder, planSwapFolders, repairAll } from '../../src/core/tonuino/repair';
import { CATALOG_FILE, COVERS_FILE, scanSd } from '../../src/core/tonuino/sd';
import { installSystemSounds, readSoundPackage } from '../../src/core/tonuino/soundsinstall';
import { diffForPackage } from '../../src/core/tonuino/writeplan';
import { memTreeNames, type MemTree } from '../../src/platform/memory';
import { createOverlay, memoryScratch } from '../../src/platform/overlay';
import { SNAPSHOT_LISTING_IS_FAT_ORDER } from '../../src/platform/snapshot';
import { blobTree } from '../platform/blobfixtures';

/** As the app checks a card that was read as a snapshot. */
const ctx: HealthContext = { profile: 'tng', trustsDirectoryOrder: SNAPSHOT_LISTING_IS_FAT_ORDER };

function setup(tree: MemTree) {
  const base = blobTree(tree, 'TONUINO');
  const ov = createOverlay(base, memoryScratch(), 'TONUINO');
  return { base, ov, plan: () => diffForPackage(base, ov.tree) };
}

const hasTemp = (names: unknown) => Object.keys(names as object).some((n) => n.startsWith('_tonuino-studio-temp'));

describe('the existing repairs on a snapshot copy', () => {
  it('"Alles reparieren" turns into whole folders for the Paket, with no helper folder left', async () => {
    const { ov, plan } = setup({
      mp3: { '0001.mp3': 1 },
      '01': { '001.mp3': 1, '003.mp3': 3, '._001.mp3': 1 },
      '02': { '001.mp3': 1 },
      '_tonuino-studio-temp-02': { '002.mp3': 2 },
      '03': { '001.mp3': 5 },
    });
    const r = await repairAll(ov.root, (s) => checkHealth(s, ctx));
    expect(r.error).toBeUndefined();
    const names = await memTreeNames(ov.root);
    expect(hasTemp(names)).toBe(false);
    expect(names).toMatchObject({ '01': { '001.mp3': 1, '002.mp3': 3 }, '02': { '001.mp3': 1, '002.mp3': 2 }, '03': { '001.mp3': 5 } });
    const p = plan();
    expect(p.changes.map((c) => [c.kind, c.name])).toEqual([
      ['replace', '01'],
      ['replace', '02'],
      ['remove', '_tonuino-studio-temp-02'],
    ]);
    expect(p.deleteFirst).toEqual(['01', '02', '_tonuino-studio-temp-02']);
    // Junk never goes into the Paket.
    const items = packageContent(p, ov.tree, 'changes').items.map((i) => i.path);
    expect(items).toEqual(['01/', '01/001.mp3', '01/002.mp3', '02/', '02/001.mp3', '02/002.mp3']);
  });

  it('a new order for a folder replaces it, through the helper folder that goes again', async () => {
    const { ov, plan } = setup({ '01': { '001.mp3': 1, '002.mp3': 2, '003.mp3': 3 }, '02': { '001.mp3': 1 } });
    const scan = await scanSd(ov.root);
    const reorder = planReorder(scan.folders[0], ['003.mp3', '001.mp3', '002.mp3']);
    expect((await executePlan(ov.root, reorder)).error).toBeUndefined();
    const fix = planFix(await scanSd(ov.root), { kind: 'rebuild-order', folder: 2 });
    expect((await executePlan(ov.root, fix)).error).toBeUndefined();
    const names = await memTreeNames(ov.root);
    expect(names).toEqual({ '01': { '001.mp3': 3, '002.mp3': 1, '003.mp3': 2 }, '02': { '001.mp3': 1 } });
    // Folder 02 was rebuilt with the same files in the same order: on the card nothing changes.
    expect(plan().changes.map((c) => [c.kind, c.name])).toEqual([['replace', '01']]);
  });

  it('a folder with another number becomes a new folder in the Paket, and the old one goes', async () => {
    const { ov, plan } = setup({ '03': { '001.mp3': 1 }, '45': { '001.mp3': 1, '002.mp3': 2 } });
    const scan = await scanSd(ov.root);
    const renumber = planRenumberFolder(scan, 45, 5);
    expect((await executePlan(ov.root, renumber)).error).toBeUndefined();
    const after = await scanSd(ov.root);
    expect(checkRenumbered(scan.folders[1], after, 5)).toBeNull();
    expect(plan().changes.map((c) => [c.kind, c.name])).toEqual([
      ['add', '05'],
      ['remove', '45'],
    ]);
  });

  it('two folders that swap their numbers both come into the Paket whole, with no helper folder left', async () => {
    const { ov, plan } = setup({ '03': { '001.mp3': 1 }, '05': { '001.mp3': 5, '002.mp3': 6 }, '12': { '001.mp3': 12 } });
    const scan = await scanSd(ov.root);
    const swap = planSwapFolders(scan, 5, 12);
    expect((await executePlan(ov.root, swap)).error).toBeUndefined();
    const after = await scanSd(ov.root);
    expect(checkSwapped(scan.folders[1], scan.folders[2], after)).toBeNull();
    expect(hasTemp(await memTreeNames(ov.root))).toBe(false);
    const p = plan();
    expect(p.changes.map((c) => [c.kind, c.name])).toEqual([
      ['replace', '05'],
      ['replace', '12'],
    ]);
    expect(packageContent(p, ov.tree, 'changes').items.map((i) => i.path)).toEqual(['05/', '05/001.mp3', '12/', '12/001.mp3', '12/002.mp3']);
  });

  it('new system sounds replace mp3 and advert', async () => {
    const { ov, plan } = setup({ MP3: { '0001.mp3': 9 }, '01': { '001.mp3': 1 } });
    const z = new JSZip();
    z.file('sd-card/mp3/0001.mp3', new Uint8Array(1));
    z.file('sd-card/mp3/0002.mp3', new Uint8Array(2));
    z.file('sd-card/advert/0001.mp3', new Uint8Array(3));
    await installSystemSounds(ov.root, await readSoundPackage(await z.generateAsync({ type: 'uint8array' })));
    const p = plan();
    expect(p.changes.map((c) => [c.kind, c.name])).toEqual([
      ['replace', 'mp3'],
      ['add', 'advert'],
    ]);
    expect(p.deleteFirst).toEqual(['mp3']);
  });

  it('names, titles and covers become the app files of the Paket', async () => {
    const { ov, plan } = setup({ '01': { '001.mp3': 1 }, [CATALOG_FILE]: '{}' });
    const catalog = { version: 1, folders: {} } as unknown as Catalog;
    await saveCatalog(ov.root, catalog);
    await saveCovers(ov.root, new Map([['01.jpg', new Uint8Array([1, 2, 3])]]));
    expect(plan().appFiles).toEqual([{ name: CATALOG_FILE }, { name: COVERS_FILE }]);
    expect((await loadCovers(ov.root)).get('01.jpg')).toEqual(new Uint8Array([1, 2, 3]));
    expect(plan().changes).toEqual([]);
    expect(plan().count).toBe(1);
  });

  it('the last cover removed gives an empty covers file instead of a delete', async () => {
    const z = new JSZip();
    z.file('01.jpg', new Uint8Array([1]));
    const { ov, plan } = setup({ '01': { '001.mp3': 1 }, [COVERS_FILE]: await z.generateAsync({ type: 'uint8array' }) });
    await saveCovers(ov.root, new Map());
    expect(plan().appFiles).toEqual([{ name: COVERS_FILE, empty: true }]);
    expect(plan().deleteFirst).toEqual([]);
  });
});
