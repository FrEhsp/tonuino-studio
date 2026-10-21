/**
 * The catalog keeps every title with its track whatever happens to a repair
 * on the way: the app closed or the card pulled in the middle of a reorder,
 * a name taken when the files come back, a title saved while a repair runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPlanToCatalog, loadCatalog, newCatalog, saveCatalog, touchFolder, trackRows, type Catalog } from '../../src/core/tonuino/catalog';
import { doneSteps, executePlan, planFix, planReorder, planSwapFolders } from '../../src/core/tonuino/repair';
import { REORDER_DONE_MARKER, scanSd, tempDirName } from '../../src/core/tonuino/sd';
import { memDir, type MemTree } from '../../src/platform/memory';
import type { ByteSource, Dir, DirEntry, Platform, Volume, WriteOptions } from '../../src/platform/types';

/**
 * A card whose computer stops for good after `budget` changes: every later
 * change never finishes, like an app that was closed or a card pulled out.
 */
class FreezeDir implements Dir {
  constructor(
    readonly inner: Dir,
    private readonly left: { n: number },
  ) {}
  get name() {
    return this.inner.name;
  }
  private change<T>(op: () => Promise<T>): Promise<T> {
    if (this.left.n <= 0) return new Promise<T>(() => undefined);
    this.left.n--;
    return op();
  }
  list(): Promise<DirEntry[]> {
    return this.inner.list();
  }
  async dir(name: string, opts?: { create?: boolean }): Promise<Dir> {
    const make = () => this.inner.dir(name, opts);
    const d = opts?.create && !(await this.inner.exists(name)) ? await this.change(make) : await make();
    return new FreezeDir(d, this.left);
  }
  exists(name: string) {
    return this.inner.exists(name);
  }
  read(name: string) {
    return this.inner.read(name);
  }
  readRange(name: string, start: number, length: number) {
    return this.inner.readRange(name, start, length);
  }
  source(name: string): Promise<ByteSource> {
    return this.inner.source(name);
  }
  write(name: string, data: Uint8Array | Blob, opts?: WriteOptions) {
    return this.change(() => this.inner.write(name, data, opts));
  }
  remove(name: string, opts?: { recursive?: boolean }) {
    return this.change(() => this.inner.remove(name, opts));
  }
  rename(from: string, to: string) {
    return this.change(() => this.inner.rename(from, to));
  }
  move(name: string, target: Dir, newName?: string) {
    return this.change(() => this.inner.move(name, target instanceof FreezeDir ? target.inner : target, newName));
  }
}

const TITLES: Record<number, string> = { 1: 'Eins', 2: 'Zwei', 3: 'Drei', 4: 'Vier' };
const TREE: MemTree = { '03': { '001.mp3': 1, '002.mp3': 2, '003.mp3': 3, '004.mp3': 4 } };

function catalogFor(files: string[]): Catalog {
  const c = newCatalog();
  c.folders['03'] = { title: 'Drei Titel', tracks: files.map((file) => ({ file, title: TITLES[Number(file.slice(0, 3))] })), addedAt: 0, updatedAt: 0 };
  return c;
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

/** What the next start of the app shows: the catalog on the card, after "Dateien zurücklegen". */
async function afterRestart(root: Dir) {
  const c = (await loadCatalog(root))!;
  const scan = await scanSd(root);
  if (scan.tempDirs.length) {
    const recover = planFix(scan, { kind: 'recover-temp' });
    const result = await executePlan(root, recover);
    expect(result.error).toBeUndefined();
    applyPlanToCatalog(c, recover, doneSteps(recover, result));
  }
  const after = await scanSd(root);
  touchFolder(c, after.folders[0]);
  return trackRows(after.folders[0], c.folders['03']);
}

describe('a reorder that stops for good', () => {
  afterEach(() => vi.resetModules());

  it('leaves titles on the card that fit the tracks, wherever it stops', async () => {
    const plan = planReorder((await scanSd(memDir(TREE))).folders[0], ['003.mp3', '001.mp3', '002.mp3'], { pureNumbers: true });
    expect(plan.steps[plan.commitAt!]).toEqual({ op: 'mkdir', path: [tempDirName(3), REORDER_DONE_MARKER] });
    // Every change of the run counted, one catalog write included, and a few more to get to the end.
    for (let budget = 0; budget <= plan.steps.length + 4; budget++) {
      // A fresh app each time: a run that never ends would hold the catalog queue of the last one.
      const { card, runRepair } = await import('../../src/app/state');
      const root = memDir(TREE);
      const catalog = catalogFor(['001.mp3', '002.mp3', '003.mp3', '004.mp3']);
      await saveCatalog(root, catalog);
      const volume: Volume = { id: 'sd', label: 'SD', root: new FreezeDir(root, { n: budget }), info: {}, canEject: false };
      card.value = { volume, status: 'ready', scan: await scanSd(root), catalog, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
      void runRepair(plan, { kind: 'order', folders: () => [3] });
      await settle();

      const rows = await afterRestart(root);
      for (const r of rows) expect(r.title, `after ${budget} changes: ${r.file}`).toBe(TITLES[r.size]);
      vi.resetModules();
    }
  });

  it('stops before the new numbers when the catalog cannot be written', async () => {
    const { card, runRepair } = await import('../../src/app/state');
    const inner = memDir(TREE);
    const catalog = catalogFor(['001.mp3', '002.mp3', '003.mp3', '004.mp3']);
    await saveCatalog(inner, catalog);
    // The card takes the files, but writing the catalog fails.
    const root = new Proxy(inner, {
      get(target, prop, receiver) {
        // As the web platform says it: the file name in front of the cause.
        if (prop === 'write') return async () => Promise.reject(new Error('tonuino-studio.json schreiben: Die Datei ist gesperrt oder schreibgeschützt. Ist der Schreibschutzschalter der SD-Karte auf „Lock“?'));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Dir;
    const volume: Volume = { id: 'sd', label: 'SD', root, info: {}, canEject: false };
    card.value = { volume, status: 'ready', scan: await scanSd(inner), catalog, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
    const plan = planReorder((await scanSd(inner)).folders[0], ['003.mp3', '001.mp3', '002.mp3'], { pureNumbers: true });
    const run = await runRepair(plan, { kind: 'order', folders: () => [3] });
    expect(run.result.error?.step).toBe(plan.steps[plan.commitAt!]);
    expect(run.result.error?.message).toBe(
      'Die neue Reihenfolge ließ sich nicht auf der Karte speichern. Deshalb hab ich aufgehört. Die Datei ist gesperrt oder schreibgeschützt. Ist der Schreibschutzschalter der SD-Karte auf „Lock“?',
    );
    // Put back, the tracks have their old names, and the old titles fit.
    const scan = await scanSd(inner);
    expect(scan.tempDirs[0].newNumbers).toBe(false);
    const rows = await afterRestart(inner);
    expect(rows.map((r) => [r.file, r.title])).toEqual([
      ['001.mp3', 'Eins'],
      ['002.mp3', 'Zwei'],
      ['003.mp3', 'Drei'],
    ]);
  });
});

describe('putting files back from the helper folder', () => {
  it('takes the title along when the old name is taken meanwhile', async () => {
    // 003.mp3 waits in the helper folder; another program put a new 003.mp3 into the folder.
    const root = memDir({ '05': { '001.mp3': 1, '003.mp3': 99 }, [tempDirName(5)]: { '003.mp3': 3 } });
    const c = newCatalog();
    c.folders['05'] = { title: 'Fünf', tracks: [{ file: '001.mp3', title: 'Eins' }, { file: '003.mp3', title: 'Drei' }], addedAt: 0, updatedAt: 0 };
    const recover = planFix(await scanSd(root), { kind: 'recover-temp' });
    const result = await executePlan(root, recover);
    expect(result.error).toBeUndefined();
    applyPlanToCatalog(c, recover, doneSteps(recover, result));
    const after = await scanSd(root);
    touchFolder(c, after.folders[0]);
    expect(trackRows(after.folders[0], c.folders['05']).map((r) => [r.file, r.size, r.title])).toEqual([
      ['001.mp3', 1, 'Eins'],
      ['003.mp3', 99, 'Titel 3'],
      ['004.mp3', 3, 'Drei'],
    ]);
  });
});

describe('the catalog after a repair', () => {
  afterEach(() => vi.resetModules());

  it('waits for a title being saved, so neither change is lost', async () => {
    const { card, catalogAfterRepair, updateCatalog } = await import('../../src/app/state');
    const inner = memDir({ '05': { '001.mp3': 1, '003.mp3': 3 } });
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const root = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'write') return async (name: string, data: Uint8Array) => slow.then(() => target.write(name, data));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Dir;
    const catalog = newCatalog();
    catalog.folders['05'] = { title: 'Fünf', tracks: [{ file: '001.mp3', title: 'Eins' }, { file: '003.mp3', title: 'Drei' }], addedAt: 0, updatedAt: 0 };
    const volume: Volume = { id: 'sd', label: 'SD', root, info: {}, canEject: false };
    card.value = { volume, status: 'ready', scan: await scanSd(inner), catalog, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };

    // A title is being saved (the card is slow) while a repair renames 003 to 002.
    const saving = updateCatalog((c) => (c.folders['05'].tracks[0].title = 'Erster'));
    const plan = planFix(await scanSd(inner), { kind: 'close-gaps', folder: 5 }, { pureNumbers: true });
    const after = catalogAfterRepair(plan, plan.steps);
    release();
    await Promise.all([saving, after]);
    expect(card.value!.catalog!.folders['05'].tracks.map((t) => [t.file, t.title])).toEqual([
      ['001.mp3', 'Erster'],
      ['002.mp3', 'Drei'],
    ]);
  });
});

describe('a swap of two folders that stops for good', () => {
  afterEach(() => vi.resetModules());

  // Bibi in 05 (files of 11 and 12 bytes), Paw Patrol in 12 (21, 22, 23 bytes).
  const SWAP_TREE: MemTree = { '05': { '001.mp3': 11, '002.mp3': 12 }, '12': { '001.mp3': 21, '002.mp3': 22, '003.mp3': 23 } };
  const BY_SIZE: Record<number, string> = { 11: 'Bibi eins', 12: 'Bibi zwei', 21: 'Paw eins', 22: 'Paw zwei', 23: 'Paw drei' };

  function swapCatalog(): Catalog {
    const c = newCatalog();
    c.folders['05'] = { title: 'Bibi', tracks: [{ file: '001.mp3', title: 'Bibi eins' }, { file: '002.mp3', title: 'Bibi zwei' }], addedAt: 0, updatedAt: 0 };
    c.folders['12'] = {
      title: 'Paw Patrol',
      tracks: [{ file: '001.mp3', title: 'Paw eins' }, { file: '002.mp3', title: 'Paw zwei' }, { file: '003.mp3', title: 'Paw drei' }],
      addedAt: 0,
      updatedAt: 0,
    };
    c.extraCards = [{ id: 'folge', label: 'Folge 1', folder: 5, mode: 7, special: 1, special2: 1 }];
    return c;
  }

  /** The next start of the app: the catalog on the card, "Dateien zurücklegen" with it, and every title next to its file. */
  async function afterSwapRestart(root: Dir) {
    const c = (await loadCatalog(root))!;
    const scan = await scanSd(root);
    if (scan.tempDirs.length) {
      const recover = planFix(scan, { kind: 'recover-temp' }, { catalog: c });
      const result = await executePlan(root, recover);
      expect(result.error).toBeUndefined();
      applyPlanToCatalog(c, recover, doneSteps(recover, result));
    }
    const after = await scanSd(root);
    expect(after.tempDirs).toEqual([]);
    const sizes = after.folders.flatMap((f) => f.tracks.map((t) => t.size)).sort();
    expect(sizes).toEqual([11, 12, 21, 22, 23]);
    for (const f of after.folders) touchFolder(c, f);
    return { c, rows: after.folders.flatMap((f) => trackRows(f, c.folders[f.name]).map((r) => ({ ...r, folder: f.name, folderTitle: c.folders[f.name].title }))) };
  }

  it('leaves titles on the card that fit the files, wherever it stops', async () => {
    const plan = planSwapFolders(await scanSd(memDir(SWAP_TREE)), 5, 12);
    const outcomes = new Set<string>();
    for (let budget = 0; budget <= plan.steps.length + 4; budget++) {
      const { card, runRepair } = await import('../../src/app/state');
      const root = memDir(SWAP_TREE);
      const catalog = swapCatalog();
      await saveCatalog(root, catalog);
      const volume: Volume = { id: 'sd', label: 'SD', root: new FreezeDir(root, { n: budget }), info: {}, canEject: false };
      card.value = { volume, status: 'ready', scan: await scanSd(root), catalog, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
      void runRepair(plan, { kind: 'repair', folders: () => [5, 12] });
      await settle();

      const { c, rows } = await afterSwapRestart(root);
      for (const r of rows) expect(r.title, `after ${budget} changes: ${r.folder}/${r.file}`).toBe(BY_SIZE[r.size]);
      // The folder title and the episode card went the same way as the files.
      const bibi = rows.find((r) => r.size === 11)!.folder;
      expect(c.folders[bibi].title).toBe('Bibi');
      expect(c.extraCards[0].folder).toBe(Number(bibi));
      outcomes.add(bibi);
      vi.resetModules();
    }
    // Undone when it stopped early, finished when it stopped late.
    expect([...outcomes].sort()).toEqual(['05', '12']);
  });

  it('drops the note of the swap from the catalog once it is done', async () => {
    const { card, platform, runRepair } = await import('../../src/app/state');
    // Enough of a platform for reading the card again afterwards.
    platform.value = { volumes: { info: async () => ({}) } } as unknown as Platform;
    const root = memDir(SWAP_TREE);
    const catalog = swapCatalog();
    await saveCatalog(root, catalog);
    const volume: Volume = { id: 'sd', label: 'SD', root, info: {}, canEject: false };
    card.value = { volume, status: 'ready', scan: await scanSd(root), catalog, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
    const plan = planSwapFolders(await scanSd(root), 5, 12);
    const run = await runRepair(plan, { kind: 'repair', folders: () => [5, 12] });
    expect(run.result.error).toBeUndefined();
    const onCard = (await loadCatalog(root))!;
    expect(onCard.swap).toBeUndefined();
    expect(onCard.folders['05'].title).toBe('Paw Patrol');
    expect(onCard.folders['12'].title).toBe('Bibi');
    expect(onCard.folders['05'].renumbered).toBeUndefined();
    expect(card.value!.catalog!.extraCards[0].folder).toBe(12);
  });

  it('goes back to the old numbers when the catalog cannot be written', async () => {
    const { card, runRepair } = await import('../../src/app/state');
    const inner = memDir(SWAP_TREE);
    const catalog = swapCatalog();
    await saveCatalog(inner, catalog);
    const root = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'write') return async () => Promise.reject(new Error('Die Datei ist gesperrt.'));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Dir;
    const volume: Volume = { id: 'sd', label: 'SD', root, info: {}, canEject: false };
    card.value = { volume, status: 'ready', scan: await scanSd(inner), catalog, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
    const plan = planSwapFolders(await scanSd(inner), 5, 12);
    const run = await runRepair(plan, { kind: 'repair', folders: () => [5, 12] });
    expect(run.result.error?.step).toBe(plan.steps[plan.commitAt!]);
    expect(run.result.error?.message).toBe('Die neuen Nummern ließen sich nicht auf der Karte speichern. Deshalb hab ich aufgehört. Die Datei ist gesperrt.');
    const { rows } = await afterSwapRestart(inner);
    expect(rows.map((r) => [r.folder, r.title])).toEqual([
      ['05', 'Bibi eins'],
      ['05', 'Bibi zwei'],
      ['12', 'Paw eins'],
      ['12', 'Paw zwei'],
      ['12', 'Paw drei'],
    ]);
  });
});
