/**
 * "Nummer ändern oder tauschen …" on the folder page (audit 0.4 #6): a folder moves
 * to a free number as a whole, its titles, cover and extra cards go with it,
 * and the move is checked against the card afterwards.
 */
import { describe, expect, it } from 'vitest';
import { memDir, type MemTree } from '../../src/platform/memory';
import type { Dir } from '../../src/platform/types';
import { applyPlanToCatalog, moveExtraCards, newCatalog, rangeCardsTouching, type Catalog } from '../../src/core/tonuino/catalog';
import { renumberCovers } from '../../src/core/tonuino/covers';
import { checkRenumbered, doneSteps, executePlan, planRenumberFolder, renumberTargets } from '../../src/core/tonuino/repair';
import { scanSd, tempDirName } from '../../src/core/tonuino/sd';

function catalogFor(): Catalog {
  const c = newCatalog('Box', 'tng');
  c.folders['45'] = {
    title: 'Der Räuber Hotzenplotz',
    tracks: [
      { file: '001.mp3', title: 'Kasperl' },
      { file: '002.mp3', title: 'Seppel' },
    ],
    cover: '45.jpg',
    card: { mode: 2 },
    addedAt: 0,
    updatedAt: 0,
  };
  c.extraCards = [
    { id: 'lied-1', label: 'Kasperl', folder: 45, mode: 4, special: 1, special2: 0 },
    { id: 'andere', label: 'Bibi', folder: 3, mode: 2, special: 0, special2: 0 },
  ];
  return c;
}

const tree = (more: MemTree = {}): MemTree => ({ '03': { '001.mp3': 10 }, '45': { '001.mp3': 100, '002.mp3': 200, 'cover.jpg': 5 }, ...more });

describe('giving a folder another number', () => {
  it('moves the folder as a whole, and its titles and extra cards with it', async () => {
    const root = memDir(tree());
    const scan = await scanSd(root);
    const catalog = catalogFor();
    const plan = planRenumberFolder(scan, 45, 5, catalog);
    // One rename: no step at which half of the tracks are under each number.
    expect(plan.steps).toEqual([{ op: 'rename', dir: [], from: '45', to: '05' }]);
    expect(plan.leftovers).toEqual([]);
    expect(plan.summary).toEqual(['„Der Räuber Hotzenplotz“ liegt danach in Ordner 05, mit allen Titeln und dem Cover.']);

    const before = scan.folders.find((f) => f.number === 45)!;
    const result = await executePlan(root, plan);
    expect(result.error).toBeUndefined();
    const done = doneSteps(plan, result);
    // As runRepair does it: prepare, then follow the steps.
    const moved = moveExtraCards(catalog, 45, 5);
    applyPlanToCatalog(catalog, plan, done);

    const after = await scanSd(root);
    expect(after.folders.map((f) => f.name)).toEqual(['03', '05']);
    expect(checkRenumbered(before, after, 5)).toBeNull();
    expect(catalog.folders['45']).toBeUndefined();
    expect(catalog.folders['05']).toMatchObject({ title: 'Der Räuber Hotzenplotz', card: { mode: 2 } });
    expect(catalog.folders['05'].tracks.map((t) => t.title)).toEqual(['Kasperl', 'Seppel']);
    expect(moved).toEqual(['lied-1']);
    expect(catalog.extraCards.map((x) => x.folder)).toEqual([5, 3]);
  });

  it('changes nothing when the rename fails', async () => {
    const root = memDir(tree());
    const failing: Dir = Object.assign(Object.create(root), {
      rename: async () => {
        throw new Error('Die Karte ist schreibgeschützt.');
      },
    });
    const scan = await scanSd(root);
    const catalog = catalogFor();
    const plan = planRenumberFolder(scan, 45, 5, catalog);
    const result = await executePlan(failing, plan);
    expect(result.error?.message).toBe('Die Karte ist schreibgeschützt.');
    const done = doneSteps(plan, result);
    expect(done).toEqual([]);
    applyPlanToCatalog(catalog, plan, done);
    expect(Object.keys(catalog.folders)).toEqual(['45']);
    expect((await scanSd(root)).folders.map((f) => f.name)).toEqual(['03', '45']);
  });

  it('offers only numbers no folder has or waits for', async () => {
    const root = memDir(tree({ '7': { '001.mp3': 1 }, '08 Bibi': { '001.mp3': 1 }, [tempDirName(9)]: { 'x.mp3': 1 } }));
    const scan = await scanSd(root);
    const catalog = catalogFor();
    // Missing on the card, but its title and cover are still in the catalog.
    catalog.folders['10'] = { title: 'Verschwunden', tracks: [], addedAt: 0, updatedAt: 0 };
    const free = renumberTargets(scan, catalog);
    expect(free.slice(0, 5)).toEqual([1, 2, 4, 5, 6]);
    for (const n of [3, 7, 8, 9, 10, 45]) expect(free).not.toContain(n);
    expect(free.at(-1)).toBe(99);
    for (const n of [3, 7, 8, 10, 45, 0, 100]) {
      const plan = planRenumberFolder(scan, 3, n, catalog);
      expect(plan.steps).toEqual([]);
      expect(plan.leftovers.length).toBe(1);
    }
  });

  it('waits while files of the folder are still in the helper folder', async () => {
    const scan = await scanSd(memDir(tree({ [tempDirName(45)]: { '001.mp3': 1 } })));
    const plan = planRenumberFolder(scan, 45, 5);
    expect(plan.steps).toEqual([]);
    expect(plan.leftovers[0]).toContain('Lege sie erst zurück');
  });

  it('notices a file that did not arrive whole, and an old folder that stayed', async () => {
    const scan = await scanSd(memDir(tree()));
    const before = scan.folders.find((f) => f.number === 45)!;
    const short = await scanSd(memDir({ '03': { '001.mp3': 10 }, '05': { '001.mp3': 100, '002.mp3': 199, 'cover.jpg': 5 } }));
    expect(checkRenumbered(before, short, 5)).toBe('In Ordner 05 fehlt eine Datei oder ist anders groß als vorher (002.mp3).');
    const both = await scanSd(memDir(tree({ '05': { '001.mp3': 100, '002.mp3': 200, 'cover.jpg': 5 } })));
    expect(checkRenumbered(before, both, 5)).toBe('Ordner 45 ist noch auf der Karte.');
    expect(checkRenumbered(before, scan, 5)).toBe('Ordner 05 ist nicht auf der Karte.');
  });

  it('stores the cover under the new number, and drops a stale one there', () => {
    const covers = new Map([
      ['45.png', new Uint8Array([1])],
      ['05.jpg', new Uint8Array([2])],
      ['03.jpg', new Uint8Array([3])],
    ]);
    const { covers: out, entry } = renumberCovers(covers, 45, 5);
    expect(entry).toBe('05.png');
    expect([...out.keys()].sort()).toEqual(['03.jpg', '05.png']);
    expect(out.get('05.png')).toEqual(new Uint8Array([1]));
    expect(renumberCovers(new Map([['03.jpg', new Uint8Array([3])]]), 45, 5).entry).toBeUndefined();
  });

  it('names the cards that play one of several folders around the old or new number', () => {
    const c = catalogFor();
    // Hörbuch from 40 to 50: holds 45.
    c.folders['40'] = { title: 'Gute Nacht', tracks: [], card: { mode: 5, special: 0, special2: 10 }, addedAt: 0, updatedAt: 0 };
    // From 02 to 06: holds the new number 05.
    c.folders['02'] = { title: 'Pippi', tracks: [], card: { mode: 5, special: 0, special2: 4 }, addedAt: 0, updatedAt: 0 };
    // From 20 to 22: neither.
    c.folders['20'] = { title: 'Jim Knopf', tracks: [], card: { mode: 5, special: 0, special2: 2 }, addedAt: 0, updatedAt: 0 };
    // Album with a stray special2: not a range of folders.
    c.folders['44'] = { title: 'Lieder', tracks: [], card: { mode: 2, special: 0, special2: 3 }, addedAt: 0, updatedAt: 0 };
    expect(rangeCardsTouching(c, 45, 5)).toEqual([
      { folder: 2, title: 'Pippi', last: 6 },
      { folder: 40, title: 'Gute Nacht', last: 50 },
    ]);
  });
});
