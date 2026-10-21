/**
 * "Nummer ändern oder tauschen …" on the folder page: two folders swap
 * their numbers ("05" ↔ "12") and nothing else moves. Titles, covers,
 * sticker settings, episodes and extra cards go with each folder, it works
 * with all 99 folders taken, and an interruption at any point is put right
 * by "Dateien zurücklegen" without losing or mixing a single file.
 */
import { describe, expect, it } from 'vitest';
import { applyPlanToCatalog, newCatalog, parseCatalog, rangeCardsTouching, serializeCatalog, type Catalog } from '../../src/core/tonuino/catalog';
import { swapCovers } from '../../src/core/tonuino/covers';
import { checkHealth } from '../../src/core/tonuino/health';
import { checkSwapped, doneSteps, executePlan, planFix, planRenumberFolder, planSwapFolders, renumberTargets, swapTargets, type PlanStep } from '../../src/core/tonuino/repair';
import { helperFolders, parseSwapDir, parseTempDir, scanSd, swapHelperName, swapMarkerName, tempDirName } from '../../src/core/tonuino/sd';
import { memDir, memTreeNames, type MemTree } from '../../src/platform/memory';

/** Bibi in 05 (files of 11 and 12 bytes), Paw Patrol in 12 (21, 22, 23 bytes). */
const tree = (more: MemTree = {}): MemTree => ({
  '03': { '001.mp3': 31 },
  '05': { '001.mp3': 11, '002.mp3': 12 },
  '12': { '001.mp3': 21, '002.mp3': 22, '003.mp3': 23 },
  ...more,
});

function catalogFor(): Catalog {
  const c = newCatalog('Box', 'tng');
  c.folders['03'] = { title: 'Drei', tracks: [{ file: '001.mp3', title: 'Drei eins' }], addedAt: 0, updatedAt: 0 };
  c.folders['05'] = {
    title: 'Bibi',
    tracks: [
      { file: '001.mp3', title: 'Bibi eins', size: 11, episode: 'Folge 1' },
      { file: '002.mp3', title: 'Bibi zwei', size: 12, episode: 'Folge 2' },
    ],
    cover: '05.jpg',
    color: '#aa0000',
    sticker: { title: 'Bibi B.', zoom: 2 },
    card: { mode: 5 },
    addedAt: 0,
    updatedAt: 0,
  };
  c.folders['12'] = {
    title: 'Paw Patrol',
    tracks: [
      { file: '001.mp3', title: 'Paw eins', size: 21 },
      { file: '002.mp3', title: 'Paw zwei', size: 22 },
      { file: '003.mp3', title: 'Paw drei', size: 23 },
    ],
    cover: '12.png',
    card: { mode: 2 },
    addedAt: 0,
    updatedAt: 0,
  };
  c.extraCards = [
    // Episode cards of Bibi ("von … bis …").
    { id: 'folge-1', label: 'Folge 1', folder: 5, mode: 7, special: 1, special2: 1 },
    { id: 'folge-2', label: 'Folge 2', folder: 5, mode: 7, special: 2, special2: 2 },
    { id: 'paw-lied', label: 'Lied', folder: 12, mode: 4, special: 3, special2: 0 },
    { id: 'drei', label: 'Drei', folder: 3, mode: 2, special: 0, special2: 0 },
  ];
  return c;
}

/** Which folder each title sits in, and the sizes of its files: titles and files have to stay together. */
async function contents(root: ReturnType<typeof memDir>, c: Catalog) {
  const scan = await scanSd(root);
  return Object.fromEntries(
    scan.folders.map((f) => [
      f.name,
      {
        title: c.folders[f.name]?.title,
        files: f.tracks.map((t) => t.size),
        titles: f.tracks.map((t) => c.folders[f.name]?.tracks.find((x) => x.file === t.name)?.title),
      },
    ]),
  );
}

const ORIGINAL = {
  '03': { title: 'Drei', files: [31], titles: ['Drei eins'] },
  '05': { title: 'Bibi', files: [11, 12], titles: ['Bibi eins', 'Bibi zwei'] },
  '12': { title: 'Paw Patrol', files: [21, 22, 23], titles: ['Paw eins', 'Paw zwei', 'Paw drei'] },
};
const SWAPPED = {
  '03': ORIGINAL['03'],
  '05': { title: 'Paw Patrol', files: [21, 22, 23], titles: ['Paw eins', 'Paw zwei', 'Paw drei'] },
  '12': { title: 'Bibi', files: [11, 12], titles: ['Bibi eins', 'Bibi zwei'] },
};

describe('swapping the numbers of two folders', () => {
  it('names its helper folders after both numbers, outside 01 to 99', () => {
    expect(swapHelperName(5, 12)).toBe('_tonuino-studio-temp-05-nach-12');
    expect(swapMarkerName(5, 12)).toBe('_tonuino-studio-temp-05-tausch-12');
    expect(parseTempDir('_tonuino-studio-temp-05-nach-12')).toBe(5);
    expect(parseTempDir('_tonuino-studio-temp-05-tausch-12')).toBe(5);
    expect(parseSwapDir('_tonuino-studio-temp-05-nach-12')).toEqual({ from: 5, to: 12, marker: false });
    expect(parseSwapDir('_tonuino-studio-temp-05-tausch-12')).toEqual({ from: 5, to: 12, marker: true });
    expect(parseSwapDir('_tonuino-studio-temp-05')).toBeNull();
    expect(parseSwapDir('_tonuino-studio-temp-05-nach-05')).toBeNull();
    expect(parseTempDir('_tonuino-studio-temp-05-zu-12')).toBeUndefined();
    expect(helperFolders({ folder: 5, swap: { to: 12, marker: false } })).toEqual([5, 12]);
  });

  it('swaps the two folders as wholes, and titles, covers, stickers, episodes and extra cards go with them', async () => {
    const root = memDir(tree());
    const scan = await scanSd(root);
    const catalog = catalogFor();
    const plan = planSwapFolders(scan, 5, 12);
    expect(plan.leftovers).toEqual([]);
    expect(plan.summary).toEqual(['Ordner 05 wird 12, Ordner 12 wird 05.']);
    // Whole folders only: no step at which the tracks of one folder are split up.
    expect(plan.steps.every((s) => s.op !== 'move')).toBe(true);
    expect(plan.steps[plan.commitAt!]).toEqual({ op: 'mkdir', path: [swapMarkerName(5, 12)], fresh: true });

    const result = await executePlan(root, plan, { beforeCommit: async (sofar) => applyPlanToCatalog(catalog, plan, [...sofar, plan.steps[plan.commitAt!]]) });
    expect(result.error).toBeUndefined();
    // As runRepair does it after the commit: only the steps from there on; they must not swap back.
    applyPlanToCatalog(catalog, plan, doneSteps(plan, result).slice(plan.commitAt));

    const after = await scanSd(root);
    expect(after.tempDirs).toEqual([]);
    expect(checkSwapped(scan.folders[1], scan.folders[2], after)).toBeNull();
    expect(await contents(root, catalog)).toEqual(SWAPPED);
    // No other folder changed its number.
    expect(after.folders.map((f) => f.name)).toEqual(['03', '05', '12']);
    expect(catalog.folders['12']).toMatchObject({ title: 'Bibi', cover: '05.jpg', color: '#aa0000', sticker: { title: 'Bibi B.', zoom: 2 }, card: { mode: 5 } });
    expect(catalog.folders['12'].tracks.map((t) => t.episode)).toEqual(['Folge 1', 'Folge 2']);
    expect(catalog.folders['05']).toMatchObject({ title: 'Paw Patrol', cover: '12.png', card: { mode: 2 } });
    expect(catalog.extraCards.map((x) => [x.id, x.folder])).toEqual([
      ['folge-1', 12],
      ['folge-2', 12],
      ['paw-lied', 5],
      ['drei', 3],
    ]);
    expect(catalog.swap).toEqual({ a: 5, b: 12 });
  });

  it('works with all 99 folders taken', async () => {
    const full: MemTree = {};
    for (let n = 1; n <= 99; n++) full[String(n).padStart(2, '0')] = { '001.mp3': n };
    const root = memDir(full);
    const scan = await scanSd(root);
    expect(renumberTargets(scan, null)).toEqual([]);
    expect(swapTargets(scan, 40)).toHaveLength(98);
    expect(swapTargets(scan, 40)).not.toContain(40);
    const plan = planSwapFolders(scan, 40, 41);
    expect(plan.leftovers).toEqual([]);
    expect((await executePlan(root, plan)).error).toBeUndefined();
    const after = await scanSd(root);
    expect(after.folders).toHaveLength(99);
    expect(after.tempDirs).toEqual([]);
    expect(after.folders[39].tracks[0].size).toBe(41);
    expect(after.folders[40].tracks[0].size).toBe(40);
    expect(checkHealth(after, { profile: 'tng' }).issues.filter((i) => i.severity === 'error').map((i) => i.id)).toEqual(['system-missing']);
  });

  it('refuses while files of an earlier change wait, for a folder that is gone, and for a write-protected one', async () => {
    const waiting = await scanSd(memDir(tree({ [tempDirName(3)]: { '002.mp3': 1 } })));
    expect(planSwapFolders(waiting, 5, 12).leftovers[0]).toContain('Lege sie erst zurück');
    const scan = await scanSd(memDir(tree()));
    expect(planSwapFolders(scan, 5, 7).leftovers).toEqual(['Ordner 07 gibt es auf der Karte nicht mehr. Lies die Karte neu ein.']);
    expect(planSwapFolders({ ...scan, readOnly: ['12'] }, 5, 12).leftovers[0]).toContain('schreibgeschützt');
    // Giving a folder a free number stays a free number: a taken one is no target there.
    expect(planRenumberFolder(scan, 5, 12).steps).toEqual([]);
  });

  it('swaps the cover pictures in the cover file', () => {
    const covers = new Map([
      ['05.jpg', new Uint8Array([5])],
      ['12.png', new Uint8Array([12])],
      ['03.jpg', new Uint8Array([3])],
    ]);
    const { covers: out, renamed } = swapCovers(covers, 5, 12);
    expect([...out.keys()].sort()).toEqual(['03.jpg', '05.png', '12.jpg']);
    expect(out.get('12.jpg')).toEqual(new Uint8Array([5]));
    expect(out.get('05.png')).toEqual(new Uint8Array([12]));
    expect([...renamed]).toEqual([
      ['05.jpg', '12.jpg'],
      ['12.png', '05.png'],
    ]);
  });

  it('keeps the note of a swap under way in the catalog file', () => {
    const c = catalogFor();
    c.swap = { a: 5, b: 12 };
    expect(parseCatalog(serializeCatalog(c))?.swap).toEqual({ a: 5, b: 12 });
    expect(parseCatalog(serializeCatalog({ ...c, swap: undefined }))?.swap).toBeUndefined();
    expect(parseCatalog(serializeCatalog({ ...c, swap: { a: 5, b: 5 } }))?.swap).toBeUndefined();
  });

  it('names the cards that play one of several folders around either number', () => {
    const c = catalogFor();
    c.folders['10'] = { title: 'Gute Nacht', tracks: [], card: { mode: 5, special: 0, special2: 4 }, addedAt: 0, updatedAt: 0 };
    expect(rangeCardsTouching(c, 5, 12)).toEqual([{ folder: 10, title: 'Gute Nacht', last: 14 }]);
  });
});

/**
 * Runs the first `count` steps of the swap, as an app that stops there for
 * good. `committed`: the catalog was written right before the marker step,
 * as runRepair does it (also when the marker step itself then did not run).
 */
async function stopAfter(count: number, committed: boolean) {
  const root = memDir(tree());
  const scan = await scanSd(root);
  const plan = planSwapFolders(scan, 5, 12);
  const card = catalogFor();
  const steps: PlanStep[] = plan.steps.slice(0, count);
  const result = await executePlan(root, { ...plan, steps });
  expect(result.error).toBeUndefined();
  if (committed) applyPlanToCatalog(card, plan, [...plan.steps.slice(0, plan.commitAt), plan.steps[plan.commitAt!]]);
  return { root, card };
}

/** The next start of the app: "Dateien zurücklegen" with the catalog from the card. */
async function putRight(root: ReturnType<typeof memDir>, card: Catalog) {
  const scan = await scanSd(root);
  if (scan.tempDirs.length) {
    const recover = planFix(scan, { kind: 'recover-temp' }, { catalog: card });
    expect(recover.leftovers).toEqual([]);
    const result = await executePlan(root, recover);
    expect(result.error).toBeUndefined();
    applyPlanToCatalog(card, recover, doneSteps(recover, result));
  }
  expect((await scanSd(root)).tempDirs).toEqual([]);
  return contents(root, card);
}

describe('a swap that stops in the middle', () => {
  it('is undone before the catalog has the new numbers, and finished after, wherever it stops', async () => {
    const plan = planSwapFolders(await scanSd(memDir(tree())), 5, 12);
    const commitAt = plan.commitAt!;
    for (let count = 0; count <= plan.steps.length; count++) {
      // Up to the commit nothing is written; from the marker step on the catalog was written before it.
      for (const committed of count < commitAt ? [false] : count === commitAt ? [false, true] : [true]) {
        const { root, card } = await stopAfter(count, committed);
        expect(await putRight(root, card), `after ${count} steps${committed ? ', catalog written' : ''}`).toEqual(committed ? SWAPPED : ORIGINAL);
      }
    }
  });

  it('follows the marker on the card when there is no catalog to ask', async () => {
    const root = memDir(tree());
    const plan = planSwapFolders(await scanSd(root), 5, 12);
    // Marker made, one folder already out under its new number.
    await executePlan(root, { ...plan, steps: plan.steps.slice(0, plan.commitAt! + 2) });
    const recover = planFix(await scanSd(root), { kind: 'recover-temp' });
    expect((await executePlan(root, recover)).error).toBeUndefined();
    expect(await memTreeNames(root)).toEqual({ '03': { '001.mp3': 31 }, '05': { '001.mp3': 21, '002.mp3': 22, '003.mp3': 23 }, '12': { '001.mp3': 11, '002.mp3': 12 } });
  });

  it('joins what a browser moved file by file with what still waits', async () => {
    // Stopped while the browser moved Paw Patrol into 05 one file at a time: the marker is there.
    const forward = memDir({
      '03': { '001.mp3': 31 },
      '05': { '001.mp3': 21 },
      [swapHelperName(12, 5)]: { '002.mp3': 22, '003.mp3': 23 },
      [swapHelperName(5, 12)]: { '001.mp3': 11, '002.mp3': 12 },
      [swapMarkerName(5, 12)]: {},
    });
    const scan = await scanSd(forward);
    expect(scan.tempDirs.map((t) => [t.name, t.folder, t.swap])).toEqual([
      [swapHelperName(12, 5), 12, { to: 5, marker: false }],
      [swapHelperName(5, 12), 5, { to: 12, marker: false }],
      [swapMarkerName(5, 12), 5, { to: 12, marker: true }],
    ]);
    const recover = planFix(scan, { kind: 'recover-temp' });
    // The marker goes last, when every file is where it belongs.
    expect(recover.steps.at(-1)).toEqual({ op: 'rmdir', path: [swapMarkerName(5, 12)] });
    expect(recover.summary).toEqual(['2 Dateien kommen in Ordner 05.', '2 Dateien kommen in Ordner 12.']);
    expect((await executePlan(forward, recover)).error).toBeUndefined();
    expect(await memTreeNames(forward)).toEqual({ '03': { '001.mp3': 31 }, '05': { '001.mp3': 21, '002.mp3': 22, '003.mp3': 23 }, '12': { '001.mp3': 11, '002.mp3': 12 } });

    // Stopped while Bibi went into its helper file by file: no marker, so it goes back.
    const back = memDir({ '03': { '001.mp3': 31 }, '05': { '002.mp3': 12 }, [swapHelperName(5, 12)]: { '001.mp3': 11 }, '12': { '001.mp3': 21 } });
    const undo = planFix(await scanSd(back), { kind: 'recover-temp' });
    expect(undo.summary).toEqual(['1 Datei kommt zurück in Ordner 05.']);
    expect((await executePlan(back, undo)).error).toBeUndefined();
    expect(await memTreeNames(back)).toEqual({ '03': { '001.mp3': 31 }, '05': { '002.mp3': 12, '001.mp3': 11 }, '12': { '001.mp3': 21 } });
  });

  it('keeps the other folder free of new albums while its files wait', async () => {
    const scan = await scanSd(memDir({ '05': { '001.mp3': 1 }, [swapHelperName(12, 5)]: { '001.mp3': 2 } }));
    // 12 is gone from the card for a moment, but its files come back there (or go to 05).
    expect(renumberTargets(scan, null)).not.toContain(12);
    expect(planRenumberFolder(scan, 5, 30).steps).toEqual([]);
  });
});
