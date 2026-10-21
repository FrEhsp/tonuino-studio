/**
 * "Reihe in einen Ordner packen" (pack.ts): the folders of a series go into
 * the lowest of their numbers as episodes, at most 255 tracks per folder,
 * no other folder changes its number, and a run that stops never loses a
 * track or leaves one in two places without a note.
 */
import { describe, expect, it } from 'vitest';
import { memDir, memTreeNames, type MemTree } from '../../src/platform/memory';
import type { Dir } from '../../src/platform/types';
import { newCatalog, type Catalog } from '../../src/core/tonuino/catalog';
import { detectEpisodes } from '../../src/core/tonuino/episodes';
import { applyArrival, applyRemoval, cardsBefore, coversToDrop, planPack, remapCards, reorderList, runPack, type PackPlan, type PackRunOptions } from '../../src/core/tonuino/pack';
import { scanSd } from '../../src/core/tonuino/sd';
import { WrapDir } from './dirwrap';

/** A track whose bytes say which one it is, so a copy can be told from another file. */
const track = (folder: number, n: number, size = 40) => {
  const b = new Uint8Array(size);
  b.fill(folder * 7 + n);
  return b;
};

function tracks(folder: number, count: number, from = 1): MemTree {
  const out: MemTree = {};
  for (let n = from; n < from + count; n++) out[`${String(n).padStart(3, '0')}.mp3`] = track(folder, n);
  return out;
}

function seriesCard(): MemTree {
  return {
    '02': tracks(2, 3),
    '05': { '001.mp3': track(5, 1, 100) },
    '07': tracks(7, 2),
    '09': tracks(9, 4),
  };
}

function seriesCatalog(): Catalog {
  const c = newCatalog('Box', 'tng');
  const f = (title: string, extra: object = {}) => ({ title, tracks: [], addedAt: 0, updatedAt: 0, ...extra });
  c.folders['02'] = f('Unter meinem Bett 1', { cover: '02.jpg', color: '#112233', sticker: { title: 'Bett 1', zoom: 1, recipe: 'serie-x' }, tracks: [{ file: '001.mp3', title: 'Anfang', durationSec: 60 }] });
  c.folders['05'] = f('Konzert am Herd');
  c.folders['07'] = f('Unter meinem Bett 2', {
    cover: '07.jpg',
    color: '#445566',
    card: { mode: 3 },
    tracks: [
      { file: '001.mp3', title: 'Erstes Lied', durationSec: 90, durationExact: true, origin: 'o1' },
      { file: '002.mp3', title: 'Zweites Lied', titleAuto: true },
    ],
    origins: [{ id: 'o1', entry: 'e', item: 'i', title: 'Folge', publisher: 'Verlag', pageUrl: 'https://example.org', licence: { kind: 'cc', label: 'CC BY' }, credit: 'c', changes: [], retrievedAt: 0 }],
  });
  c.folders['09'] = f('Unter meinem Bett 3');
  c.extraCards = [
    { id: 'lied', label: 'Zweites Lied', folder: 7, mode: 4, special: 2, special2: 0 },
    { id: 'alles', label: 'Album', folder: 9, mode: 2, special: 0, special2: 0 },
    { id: 'anders', label: 'Konzert', folder: 5, mode: 4, special: 1, special2: 0 },
  ];
  return c;
}

let ids = 0;
const makeId = () => `k${++ids}`;

/** As the app runs it: the catalog follows every folder that arrived or went. */
function runner(c: Catalog, written: string[] = [], more: Partial<PackRunOptions> = {}): PackRunOptions {
  return {
    how: 'copy',
    arrived: async (g, m, first) => {
      written.push(...applyArrival(c, g, m, { first, coverReady: true }));
    },
    removed: async (_g, m) => applyRemoval(c, m),
    ...more,
  };
}

async function plan(root: Dir, c: Catalog | null, numbers: number[], name = 'Unter meinem Bett', extra: Partial<Parameters<typeof planPack>[0]> = {}): Promise<PackPlan> {
  ids = 0;
  return planPack({ scan: await scanSd(root), catalog: c, numbers, name, profile: 'tng', pureNumbers: true, makeId, ...extra });
}

describe('planning', () => {
  it('packs into the lowest number, in the order of the numbers, and frees the others', async () => {
    const root = memDir(seriesCard());
    const p = await plan(root, seriesCatalog(), [9, 2, 7]);
    expect(p.problems).toEqual([]);
    expect(p.groups).toHaveLength(1);
    const g = p.groups[0];
    expect(g.target).toBe(2);
    expect(g.members.map((m) => [m.number, m.first, m.last])).toEqual([
      [2, 1, 3],
      [7, 4, 5],
      [9, 6, 9],
    ]);
    expect(g.members[1].tracks.map((t) => `${t.from}→${t.to}`)).toEqual(['001.mp3→004.mp3', '002.mp3→005.mp3']);
    expect(p.freed).toEqual([7, 9]);
    expect(p.episodes).toBe(3);
    expect(p.largest).toBe(160);
    // The cover goes along under a name of its own; 09 has none.
    expect(g.members.map((m) => m.cover)).toEqual([{ from: '02.jpg', to: 'folge-k1.jpg' }, { from: '07.jpg', to: 'folge-k2.jpg' }, undefined]);
  });

  it('keeps the file name text when the card does not want pure numbers', async () => {
    const root = memDir({ '01': { '001 Intro.mp3': 10 }, '02': { '001 Lied.mp3': 10, '002 Ende.wav': 10 } });
    const p = await plan(root, null, [1, 2], 'X', { pureNumbers: false });
    expect(p.groups[0].members[1].tracks.map((t) => t.to)).toEqual(['002 Lied.mp3', '003 Ende.wav']);
  });

  it('splits into as few folders as 255 tracks allow, from the chosen numbers', async () => {
    const root = memDir({ '10': tracks(10, 100), '11': tracks(11, 100), '12': tracks(12, 100), '13': tracks(13, 100), '14': tracks(14, 30) });
    const p = await plan(root, null, [10, 11, 12, 13, 14], 'Hörbuch');
    expect(p.problems).toEqual([]);
    expect(p.groups.map((g) => [g.target, g.members.map((m) => m.number), g.total, g.title])).toEqual([
      [10, [10, 11], 200, 'Hörbuch (Teil 1)'],
      [12, [12, 13, 14], 230, 'Hörbuch (Teil 2)'],
    ]);
    expect(p.freed).toEqual([11, 13, 14]);
    expect(p.groups.every((g) => g.members.every((m) => m.last <= 255))).toBe(true);
  });

  it('counts the target by its highest track number, a gap included', async () => {
    const root = memDir({ '01': { '001.mp3': 5, '250.mp3': 5 }, '02': tracks(2, 5), '03': tracks(3, 3) });
    const p = await plan(root, null, [1, 2, 3], 'X');
    // 250 + 5 = 255 fits exactly, the next folder starts a part of its own and stays alone.
    expect(p.groups.map((g) => g.members.map((m) => m.number))).toEqual([[1, 2]]);
    expect(p.groups[0].members[1].last).toBe(255);
    expect(p.alone).toEqual([3]);
  });

  it('says what keeps a folder from being packed', async () => {
    const root = memDir({ '01': tracks(1, 2), '02': { '001.mp3': 5, 'cover.jpg': 3 }, '03': {}, '04': { '001.mp3': 4, '01.mp3': 4 } });
    const p = await plan(root, null, [1, 2, 3, 4, 8], 'X');
    expect(p.problems).toEqual([
      'In Ordner 02 liegen noch andere Dateien (cover.jpg). Räume ihn erst unter „Meine Box“ mit „Ansehen und reparieren“ auf.',
      'Ordner 03 ist leer.',
      'In Ordner 04 liegen Titel ohne passende Nummer. Räume ihn erst unter „Meine Box“ mit „Ansehen und reparieren“ auf.',
      'Ordner 08 ist nicht mehr auf der Karte. Lies die Karte neu ein.',
    ]);
    expect((await plan(root, null, [1], 'X')).problems).toEqual(['Wähle mindestens zwei Ordner.']);
    expect((await plan(memDir({ '01': tracks(1, 1), '02': tracks(2, 1) }), null, [1, 2], '  ')).problems).toEqual(['Gib dem Ordner einen Namen.']);
  });

  it('gives episodes in a row with the same name different names', async () => {
    const root = memDir({ '01': tracks(1, 1), '02': tracks(2, 1) });
    const c = newCatalog('Box', 'tng');
    c.folders['01'] = { title: 'Weihnachten', tracks: [], addedAt: 0, updatedAt: 0 };
    c.folders['02'] = { title: 'weihnachten', tracks: [], addedAt: 0, updatedAt: 0 };
    const p = await plan(root, c, [1, 2], 'Weihnachten');
    expect(p.groups[0].members.flatMap((m) => m.episodes.map((e) => e.title))).toEqual(['Weihnachten', 'weihnachten (2)']);
  });

  it('counts the cards the folders have today', async () => {
    const root = memDir(seriesCard());
    const c = seriesCatalog();
    expect(cardsBefore(await plan(root, c, [2, 7, 9]), c)).toBe(3 + 2);
  });
});

describe('the order of the episodes', () => {
  /** 02 is episode 3, 05 episode 1, 07 episode 2: the target's own episode is not the first. */
  function shuffled() {
    const root = memDir({ '02': tracks(2, 2), '05': tracks(5, 3), '07': tracks(7, 1) });
    const c = newCatalog('Box', 'tng');
    const f = (title: string) => ({ title, tracks: [], addedAt: 0, updatedAt: 0 });
    c.folders['02'] = f('Reihe 3');
    c.folders['05'] = f('Reihe');
    c.folders['07'] = f('Reihe 2');
    return { root, c };
  }

  it('follows the numbers in the titles; the lowest folder number stays the target', async () => {
    const { root, c } = shuffled();
    const p = await plan(root, c, [2, 5, 7], 'Reihe');
    const g = p.groups[0];
    expect(g.target).toBe(2);
    expect(g.order).toEqual([5, 7, 2]);
    expect(g.reorder).toBe(true);
    // While packing the others go behind the target's own tracks, in the order of the episodes.
    expect(g.members.map((m) => [m.number, m.first, m.last])).toEqual([
      [2, 1, 2],
      [5, 3, 5],
      [7, 6, 6],
    ]);
  });

  it('takes an order chosen in the dialog, and needs no reorder when the target comes first', async () => {
    const { root, c } = shuffled();
    const p = await plan(root, c, [2, 5, 7], 'Reihe', { order: [2, 7, 5] });
    expect(p.groups[0].order).toEqual([2, 7, 5]);
    expect(p.groups[0].reorder).toBe(false);
    expect(p.groups[0].members.map((m) => m.number)).toEqual([2, 7, 5]);
  });

  it('splits in the order of the episodes, each part into its lowest number', async () => {
    const root = memDir({ '10': tracks(10, 100), '11': tracks(11, 100), '12': tracks(12, 100) });
    const c = newCatalog('Box', 'tng');
    c.folders['10'] = { title: 'Buch 3', tracks: [], addedAt: 0, updatedAt: 0 };
    c.folders['11'] = { title: 'Buch 1', tracks: [], addedAt: 0, updatedAt: 0 };
    c.folders['12'] = { title: 'Buch 2', tracks: [], addedAt: 0, updatedAt: 0 };
    const p = await plan(root, c, [10, 11, 12], 'Buch');
    expect(p.groups.map((g) => [g.target, g.order])).toEqual([[11, [11, 12]]]);
    expect(p.alone).toEqual([10]);
  });

  it('lists the packed folder in the order of the episodes for the reorder, and moves the cards along', async () => {
    const { root, c } = shuffled();
    const p = await plan(root, c, [2, 5, 7], 'Reihe');
    const result = await runPack(root, p, runner(c));
    expect(result.error).toBeUndefined();
    const folder = (await scanSd(root)).folders.find((f) => f.number === 2)!;
    const list = reorderList(p.groups[0], folder)!;
    // Episode 1 (from 05, now 003–005), episode 2 (from 07, now 006), then the target's own (001–002).
    expect(list).toEqual(['003.mp3', '004.mp3', '005.mp3', '006.mp3', '001.mp3', '002.mp3']);
    const before = c.extraCards.map((x) => [x.label, x.special, x.special2]);
    expect(before).toEqual([
      ['Reihe 3', 1, 2],
      ['Reihe', 3, 5],
      ['Reihe 2', 6, 6],
    ]);
    const moved = remapCards(c, 2, list);
    expect(moved).toHaveLength(3);
    expect(c.extraCards.map((x) => [x.label, x.special, x.special2])).toEqual([
      ['Reihe 3', 5, 6],
      ['Reihe', 1, 3],
      ['Reihe 2', 4, 4],
    ]);
  });

  it('needs no reorder when the folder is in order already', async () => {
    const { root, c } = shuffled();
    const p = await plan(root, c, [2, 5, 7], 'Reihe', { order: [2, 5, 7] });
    await runPack(root, p, runner(c));
    const folder = (await scanSd(root)).folders.find((f) => f.number === 2)!;
    expect(reorderList(p.groups[0], folder)).toBeNull();
  });
});

describe('packing', () => {
  it('copies, checks, notes and only then deletes; other folders keep their numbers', async () => {
    const root = memDir(seriesCard());
    const c = seriesCatalog();
    const p = await plan(root, c, [2, 7, 9]);
    const written: string[] = [];
    const result = await runPack(root, p, runner(c, written));
    expect(result).toEqual({ packed: expect.any(Array), stuck: [] });
    expect(result.packed.map((x) => x.member.number)).toEqual([7, 9]);

    const scan = await scanSd(root);
    expect(scan.folders.map((f) => f.name)).toEqual(['02', '05']);
    const into = await root.dir('02');
    expect((await into.list()).map((e) => e.name)).toEqual(['001.mp3', '002.mp3', '003.mp3', '004.mp3', '005.mp3', '006.mp3', '007.mp3', '008.mp3', '009.mp3']);
    // The copies are the originals, byte for byte.
    expect(await into.read('004.mp3')).toEqual(track(7, 1));
    expect(await into.read('009.mp3')).toEqual(track(9, 4));

    // The catalog: one folder named like the series, every track with its episode, the old entries gone.
    expect(Object.keys(c.folders)).toEqual(['02', '05']);
    const f = c.folders['02'];
    expect(f.title).toBe('Unter meinem Bett');
    expect(f.series).toBe('Unter meinem Bett');
    expect(f.sticker).toEqual({ zoom: 1, recipe: 'serie-x' });
    expect(f.tracks.map((t) => [t.file, t.episode])).toEqual([
      ['001.mp3', 'Unter meinem Bett 1'],
      ['002.mp3', 'Unter meinem Bett 1'],
      ['003.mp3', 'Unter meinem Bett 1'],
      ['004.mp3', 'Unter meinem Bett 2'],
      ['005.mp3', 'Unter meinem Bett 2'],
      ['006.mp3', 'Unter meinem Bett 3'],
      ['007.mp3', 'Unter meinem Bett 3'],
      ['008.mp3', 'Unter meinem Bett 3'],
      ['009.mp3', 'Unter meinem Bett 3'],
    ]);
    expect(f.tracks[3]).toMatchObject({ title: 'Erstes Lied', durationSec: 90, durationExact: true, origin: 'o1', size: 40 });
    expect(f.tracks[4]).toMatchObject({ title: 'Zweites Lied', titleAuto: true });
    expect(f.origins?.map((o) => o.id)).toEqual(['o1']);
    // The folder page finds the same episodes from the catalog.
    expect(detectEpisodes(f.tracks.map((t, i) => ({ number: i + 1, episode: t.episode })), f.title).map((e) => [e.title, e.first, e.last])).toEqual([
      ['Unter meinem Bett 1', 1, 3],
      ['Unter meinem Bett 2', 4, 5],
      ['Unter meinem Bett 3', 6, 9],
    ]);

    // One card per old folder, with its cover, sticker and colour; the further cards went along.
    expect([...c.extraCards].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'anders', label: 'Konzert', folder: 5, mode: 4, special: 1, special2: 0 },
      { id: 'k1', label: 'Unter meinem Bett 1', folder: 2, mode: 8, special: 1, special2: 3, sticker: { title: 'Bett 1', zoom: 1 }, color: '#112233', cover: 'folge-k1.jpg' },
      { id: 'k2', label: 'Unter meinem Bett 2', folder: 2, mode: 9, special: 4, special2: 5, color: '#445566', cover: 'folge-k2.jpg' },
      { id: 'k3', label: 'Unter meinem Bett 3', folder: 2, mode: 8, special: 6, special2: 9 },
      { id: 'lied', label: 'Zweites Lied', folder: 2, mode: 4, special: 5, special2: 0 },
    ]);
    // Exactly the cards to write anew: the three episodes and the moved one.
    expect(written.sort()).toEqual(['k1', 'k2', 'k3', 'lied']);
    expect(coversToDrop(result.packed.map((x) => x.member))).toEqual(['07.jpg']);
  });

  it('moves the files of a snapshot instead of copying them', async () => {
    const root = memDir(seriesCard());
    const c = seriesCatalog();
    const p = await plan(root, c, [2, 7, 9]);
    const log: string[] = [];
    const wrapped = new WrapDir(root, log, { noRemove: false });
    const result = await runPack(wrapped, p, runner(c, [], { how: 'move' }));
    expect(result.error).toBeUndefined();
    expect(log).toEqual([]);
    expect((await scanSd(root)).folders.map((f) => [f.name, f.tracks.length])).toEqual([
      ['02', 9],
      ['05', 1],
    ]);
  });

  it('packs several parts, each into its own target', async () => {
    const root = memDir({ '10': tracks(10, 100), '11': tracks(11, 100), '12': tracks(12, 100), '13': tracks(13, 100) });
    const c = newCatalog('Box', 'tng');
    const p = await plan(root, c, [10, 11, 12, 13], 'Hörbuch');
    const result = await runPack(root, p, runner(c));
    expect(result.error).toBeUndefined();
    expect((await scanSd(root)).folders.map((f) => [f.name, f.tracks.length])).toEqual([
      ['10', 200],
      ['12', 200],
    ]);
    expect([c.folders['10'].title, c.folders['12'].title]).toEqual(['Hörbuch (Teil 1)', 'Hörbuch (Teil 2)']);
  });
});

describe('a run that stops', () => {
  it('when stopped on purpose: what is packed stays, the rest stays as it was, no copy is left behind', async () => {
    const root = memDir(seriesCard());
    const c = seriesCatalog();
    const p = await plan(root, c, [2, 7, 9]);
    const ctrl = new AbortController();
    // Stop while the second folder is copied, after its second track.
    let copied = 0;
    const result = await runPack(root, p, {
      ...runner(c),
      onProgress: (x) => {
        if (x.folder === 9 && x.done >= 80 + 80) {
          if (++copied === 1) ctrl.abort();
        }
      },
      signal: ctrl.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.packed.map((x) => x.member.number)).toEqual([7]);
    expect(await memTreeNames(await root.dir('02'))).toEqual({ '001.mp3': 40, '002.mp3': 40, '003.mp3': 40, '004.mp3': 40, '005.mp3': 40 });
    expect(await memTreeNames(await root.dir('09'))).toEqual({ '001.mp3': 40, '002.mp3': 40, '003.mp3': 40, '004.mp3': 40 });
    expect(Object.keys(c.folders)).toEqual(['02', '05', '09']);
    expect(c.folders['09'].title).toBe('Unter meinem Bett 3');

    // Packing again goes on with the rest: the target is named like the series now and keeps its episodes.
    const again = await plan(root, c, [2, 9]);
    expect(again.problems).toEqual([]);
    expect(again.groups[0].members[0].episodes.map((e) => [e.title, e.first, e.last])).toEqual([
      ['Unter meinem Bett 1', 1, 3],
      ['Unter meinem Bett 2', 4, 5],
    ]);
    const done = await runPack(root, again, runner(c));
    expect(done.error).toBeUndefined();
    expect((await scanSd(root)).folders.map((f) => [f.name, f.tracks.length])).toEqual([
      ['02', 9],
      ['05', 1],
    ]);
    // The cards of the first run stay, none twice.
    expect(c.extraCards.filter((x) => x.folder === 2 && x.mode !== 4).map((x) => [x.label, x.special, x.special2])).toEqual([
      ['Unter meinem Bett 1', 1, 3],
      ['Unter meinem Bett 2', 4, 5],
      ['Unter meinem Bett 3', 6, 9],
    ]);
  });

  it('when the card is pulled while copying: only junk is left, the old folder and the catalog are as they were', async () => {
    const root = memDir(seriesCard());
    const c = seriesCatalog();
    const before = structuredClone(c);
    const p = await plan(root, c, [2, 7]);
    let writes = 0;
    // The card is gone after the first copy: nothing can be written or removed any more.
    const pulled = new WrapDir(root, [], {
      noRemove: true,
      onWrite: () => {
        if (++writes > 1) throw new Error('Das Gerät ist nicht bereit.');
      },
    });
    const result = await runPack(pulled, p, runner(c));
    expect(result.error).toBe('Das Gerät ist nicht bereit.');
    expect(result.packed).toEqual([]);
    expect(c).toEqual(before);
    const scan = await scanSd(root);
    // The box does not play the half-done copy, and the health check takes it for junk.
    expect(scan.folders.find((f) => f.number === 2)?.tracks.map((t) => t.name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    expect(scan.folders.find((f) => f.number === 2)?.junk.map((e) => e.name)).toEqual(['004.mp3.tonuino-tmp']);
    expect(scan.folders.find((f) => f.number === 7)?.tracks.length).toBe(2);
    // Next time the same plan goes through, over the junk.
    expect((await runPack(root, await plan(root, c, [2, 7]), runner(c))).error).toBeUndefined();
    expect((await scanSd(root)).folders.find((f) => f.number === 2)?.junk).toEqual([]);
  });

  it('when a copy does not come out right: tried once more, then the folder stays as it was', async () => {
    const root = memDir(seriesCard());
    const c = seriesCatalog();
    const p = await plan(root, c, [2, 7]);
    let bad = 0;
    const broken = new WrapDir(root, [], {
      noRemove: false,
      onWrite: (path, data) => {
        if (path === '02/005.mp3.tonuino-tmp') {
          bad++;
          const out = data.slice();
          out[3] ^= 0xff;
          return out;
        }
      },
    });
    const result = await runPack(broken, p, runner(c));
    expect(bad).toBe(2);
    expect(result.error).toBe('„002.mp3“ kam nicht heil an: Die Kopie weicht vom Original ab.');
    expect(await memTreeNames(await root.dir('02'))).toEqual({ '001.mp3': 40, '002.mp3': 40, '003.mp3': 40 });
    expect(await memTreeNames(await root.dir('07'))).toEqual({ '001.mp3': 40, '002.mp3': 40 });
  });

  it('when the catalog cannot be written: the copies go again, the old folder stays', async () => {
    const root = memDir(seriesCard());
    const c = seriesCatalog();
    const p = await plan(root, c, [2, 7]);
    const result = await runPack(root, p, {
      how: 'copy',
      arrived: async () => {
        throw new Error('tonuino-studio.json ließ sich nicht schreiben.');
      },
      removed: async () => undefined,
    });
    expect(result.error).toBe('tonuino-studio.json ließ sich nicht schreiben.');
    expect(await memTreeNames(await root.dir('02'))).toEqual({ '001.mp3': 40, '002.mp3': 40, '003.mp3': 40 });
    expect(await memTreeNames(await root.dir('07'))).toEqual({ '001.mp3': 40, '002.mp3': 40 });
  });

  it('stops before anything when a folder changed since the plan', async () => {
    const root = memDir(seriesCard());
    const c = seriesCatalog();
    const p = await plan(root, c, [2, 7]);
    await (await root.dir('07')).write('002.mp3', new Uint8Array(3));
    const result = await runPack(root, p, runner(c));
    expect(result.error).toBe('In Ordner 07 hat sich etwas geändert. Lies die Karte neu ein.');
    expect((await scanSd(root)).folders.map((f) => [f.name, f.tracks.length])).toEqual([
      ['02', 3],
      ['05', 1],
      ['07', 2],
      ['09', 4],
    ]);
  });
});
