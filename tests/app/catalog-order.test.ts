import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { boot, card, closeCard, openVolume, setCover, updateCatalog } from '../../src/app/state';
import { newCatalog, parseCatalog, serializeCatalog, type Catalog } from '../../src/core/tonuino/catalog';
import { loadCovers } from '../../src/core/tonuino/covers';
import { memDir, type MemDir } from '../../src/platform/memory';
import type { Dir, Platform, Volume } from '../../src/platform/types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

interface TestCard {
  volume: Volume;
  mem: MemDir;
  /** Names of the files written, in the order the writes started. */
  writes: string[];
  /** Files whose next write the card refuses, as a write-protected card does. */
  refuse: Set<string>;
}

/** A card with folders 01 and 02 whose writes take a while, like a FAT card behind a USB reader. */
function slowCard(id: string, boxName: string, delays: Record<string, number> = {}): TestCard {
  const c = newCatalog(boxName);
  for (const n of ['01', '02']) c.folders[n] = { title: `Ordner ${n}`, tracks: [{ file: '001.mp3' }], addedAt: 1, updatedAt: 1 };
  const mem = memDir({ '01': { '001.mp3': 1000 }, '02': { '001.mp3': 2000 }, 'tonuino-studio.json': serializeCatalog(c) });
  const writes: string[] = [];
  const refuse = new Set<string>();
  const root = new Proxy(mem, {
    get(target, prop) {
      if (prop === 'write') {
        return async (name: string, data: Uint8Array | Blob) => {
          writes.push(name);
          await sleep(delays[name] ?? 0);
          if (refuse.delete(name)) throw new Error('write-protected');
          return target.write(name, data);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Dir;
  return { volume: { id, label: id, root, info: { removable: true }, canEject: true }, mem, writes, refuse };
}

async function catalogOnCard(t: TestCard): Promise<Catalog> {
  const c = parseCatalog(new TextDecoder().decode(await t.mem.read('tonuino-studio.json')));
  if (!c) throw new Error('no catalog on the card');
  return c;
}

beforeAll(() => {
  boot({
    volumes: {
      subscribe: (cb: (v: Volume[]) => void) => {
        cb([]);
        return () => undefined;
      },
      info: async (v: Volume) => v.info,
    },
  } as unknown as Platform);
});

afterEach(() => closeCard());

describe('catalog changes in quick succession', () => {
  it('keeps both of two quick edits (a title, then a click on a kind)', async () => {
    const t = slowCard('A', 'Lenas Box', { 'tonuino-studio.json': 60 });
    await openVolume(t.volume);
    // Leaving the title field and clicking "Hörbuch" saves twice within milliseconds.
    const title = updateCatalog((c) => {
      c.folders['01'].title = 'Bibi Blocksberg';
    });
    const kind = updateCatalog((c) => {
      c.folders['01'].kind = 'hoerbuch';
    });
    await Promise.all([title, kind]);
    expect(card.value?.catalog?.folders['01']).toMatchObject({ title: 'Bibi Blocksberg', kind: 'hoerbuch' });
    expect((await catalogOnCard(t)).folders['01']).toMatchObject({ title: 'Bibi Blocksberg', kind: 'hoerbuch' });
  });

  it('does not undo an edit saved while a cover was being written', async () => {
    const t = slowCard('A', 'Lenas Box', { 'tonuino-studio.json': 10, 'tonuino-studio-covers.zip': 120 });
    await openVolume(t.volume);
    const cover = setCover(1, JPEG, 'image/jpeg', 'Datei');
    const rename = updateCatalog((c) => {
      c.folders['01'].title = 'Bibi Blocksberg - Folge 1';
    });
    await Promise.all([cover, rename]);
    const expected = { title: 'Bibi Blocksberg - Folge 1', cover: '01.jpg', coverSource: 'Datei' };
    expect(card.value?.catalog?.folders['01']).toMatchObject(expected);
    expect((await catalogOnCard(t)).folders['01']).toMatchObject(expected);
    expect([...(card.value?.covers.keys() ?? [])]).toEqual(['01.jpg']);
  });

  it('turns the sticker upright for a cassette cover and drops what fit the old picture', async () => {
    const t = slowCard('A', 'Lenas Box');
    await openVolume(t.volume);
    await updateCatalog((c) => {
      c.folders['01'].sticker = { title: 'Wecker', zoom: 0.4, orientation: 'landscape' };
    });
    await setCover(1, JPEG, 'image/jpeg', 'MusicBrainz', 'portrait');
    expect((await catalogOnCard(t)).folders['01'].sticker).toEqual({ title: 'Wecker', orientation: 'portrait' });
    // Any other new picture follows the design again.
    await setCover(1, JPEG, 'image/jpeg', 'iTunes');
    expect((await catalogOnCard(t)).folders['01'].sticker).toEqual({ title: 'Wecker' });
  });

  it('keeps both covers when two are set at the same time', async () => {
    const t = slowCard('A', 'Lenas Box', { 'tonuino-studio.json': 10, 'tonuino-studio-covers.zip': 40 });
    await openVolume(t.volume);
    await Promise.all([setCover(1, JPEG), setCover(2, JPEG, 'image/png')]);
    expect([...(card.value?.covers.keys() ?? [])].sort()).toEqual(['01.jpg', '02.png']);
    expect([...(await loadCovers(t.mem)).keys()].sort()).toEqual(['01.jpg', '02.png']);
    const onCard = await catalogOnCard(t);
    expect([onCard.folders['01'].cover, onCard.folders['02'].cover]).toEqual(['01.jpg', '02.png']);
  });

  it('writes one change after the other, in the order they were made', async () => {
    const t = slowCard('A', 'Lenas Box', { 'tonuino-studio.json': 30 });
    await openVolume(t.volume);
    const names = ['Eins', 'Zwei', 'Drei'];
    await Promise.all(
      names.map((name) =>
        updateCatalog((c) => {
          c.name = name;
          c.folders['01'].tracks.push({ file: `00${c.folders['01'].tracks.length + 1}.mp3`, title: name });
        }),
      ),
    );
    const onCard = await catalogOnCard(t);
    expect(onCard.name).toBe('Drei');
    expect(onCard.folders['01'].tracks.map((x) => x.title)).toEqual([undefined, 'Eins', 'Zwei', 'Drei']);
    expect(card.value?.catalog).toEqual(onCard);
  });

  it('goes on after a failed write, and the caller hears about it', async () => {
    const t = slowCard('A', 'Lenas Box');
    await openVolume(t.volume);
    // The card refuses the first write; the second change fails before it writes.
    t.refuse.add('tonuino-studio.json');
    const refused = updateCatalog((c) => {
      c.name = 'Abgelehnt';
    });
    const failing = updateCatalog((c) => {
      c.name = 'Kaputt';
      throw new Error('mutation failed');
    });
    const next = updateCatalog((c) => {
      c.folders['01'].title = 'Heil';
    });
    const settled = await Promise.allSettled([refused, failing, next]);
    expect(settled.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'ok'))).toEqual(['write-protected', 'mutation failed', 'ok']);
    // Neither failed change shows up, on the card or on screen; the one after them does.
    const onCard = await catalogOnCard(t);
    expect(onCard.name).toBe('Lenas Box');
    expect(onCard.folders['01'].title).toBe('Heil');
    expect(card.value?.catalog).toEqual(onCard);
  });

  it('never carries a change over to another card opened meanwhile', async () => {
    const a = slowCard('A', 'Lenas Box', { 'tonuino-studio.json': 10, 'tonuino-studio-covers.zip': 80 });
    const b = slowCard('B', 'Pauls Box');
    await openVolume(a.volume);
    const cover = setCover(1, JPEG);
    const edit = updateCatalog((c) => {
      c.folders['01'].title = 'Nur für Lena';
    });
    await sleep(20);
    await openVolume(b.volume);
    await Promise.all([cover, edit]);
    expect(card.value?.volume.id).toBe('B');
    expect(card.value?.catalog?.name).toBe('Pauls Box');
    expect(card.value?.catalog?.folders['01'].title).toBe('Ordner 01');
    expect(b.writes).toEqual([]);
    expect((await catalogOnCard(b)).folders['01'].title).toBe('Ordner 01');
  });

  it('never carries a change over to another card put into the same reader', async () => {
    // Same drive id (same mount point, or the same remembered folder in the browser), another box.
    const a = slowCard('A', 'Lenas Box', { 'tonuino-studio.json': 10, 'tonuino-studio-covers.zip': 80 });
    const b = slowCard('A', 'Pauls Box');
    await openVolume(a.volume);
    const cover = setCover(1, JPEG);
    const edit = updateCatalog((c) => {
      c.folders['01'].title = 'Nur für Lena';
    });
    await sleep(20);
    await openVolume(b.volume);
    await Promise.all([cover, edit]);
    expect(card.value?.catalog?.name).toBe('Pauls Box');
    expect(card.value?.catalog?.folders['01'].title).toBe('Ordner 01');
    expect(card.value?.catalog?.folders['01'].cover).toBeUndefined();
    expect([...(card.value?.covers.keys() ?? [])]).toEqual([]);
    expect(b.writes).toEqual([]);
    expect((await catalogOnCard(b)).folders['01'].title).toBe('Ordner 01');
  });
});
