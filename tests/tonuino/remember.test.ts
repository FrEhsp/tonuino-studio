import { describe, expect, it } from 'vitest';
import { buildShelf, newCatalog, trackRows, type Catalog } from '../../src/core/tonuino/catalog';
import {
  buildBoxMemory,
  coverStamps,
  isStale,
  memoryBytes,
  memoryCatalog,
  memoryScan,
  memorySummary,
  mergeThumbs,
  parseBoxMemory,
  rememberedDate,
  sameMemory,
  sameThumbs,
  thumbPlan,
  THUMB_PX,
  type CoverStamp,
  type MemoryThumbs,
} from '../../src/core/tonuino/remember';
import { scanSd } from '../../src/core/tonuino/sd';
import { crc32 } from '../../src/core/zip/crc32';
import { buildCardItems } from '../../src/features/cards/items';
import { memDir } from '../../src/platform/memory';

const AT = new Date(2026, 9, 13, 18, 30).getTime();
const DAY = 24 * 3600 * 1000;

async function box() {
  const root = memDir({
    mp3: { '0001.mp3': new Uint8Array(10) },
    advert: { '0001.mp3': new Uint8Array(10) },
    '01': { '001.mp3': new Uint8Array(100), '002 Zweites Lied.mp3': new Uint8Array(200) },
    '02': { '001.mp3': new Uint8Array(50) },
    'Fotos': { 'a.jpg': new Uint8Array(5) },
    '._01': new Uint8Array(1),
  });
  const scan = await scanSd(root);
  const catalog: Catalog = newCatalog('Emmas TonUINO', 'tng');
  catalog.folders['01'] = {
    title: 'Bibi Blocksberg 1',
    artist: 'Bibi',
    kind: 'hoerspiel',
    card: { mode: 3, special: 0, special2: 0 },
    tracks: [
      { file: '001.mp3', title: 'Hexen-Ei', durationSec: 60 },
      { file: '002 Zweites Lied.mp3', title: 'Hexkraft', durationSec: 90 },
    ],
    fingerprint: '2:300',
    cover: '01.jpg',
    addedAt: AT,
    updatedAt: AT,
  };
  catalog.extraCards = [{ id: 'x1', label: 'Schlummerkarte, 15 Minuten', folder: 0, mode: 1, special: 15, special2: 0 }];
  return { scan, catalog };
}

describe('buildBoxMemory', () => {
  it('keeps numbers, names, titles, card modes and extra cards, and no audio', async () => {
    const { scan, catalog } = await box();
    const m = buildBoxMemory(scan, catalog, { label: 'TONUINO', at: AT });
    expect(m.id).toBe(catalog.id);
    expect(m.name).toBe('Emmas TonUINO');
    expect(m.since).toBe(AT);
    expect(m.folders).toEqual([
      { number: 1, tracks: [{ number: 1, name: '001.mp3', size: 100 }, { number: 2, name: '002 Zweites Lied.mp3', size: 200 }] },
      { number: 2, tracks: [{ number: 1, name: '001.mp3', size: 50 }] },
    ]);
    const c = memoryCatalog(m)!;
    expect(c.folders['01'].title).toBe('Bibi Blocksberg 1');
    expect(c.folders['01'].card).toEqual({ mode: 3, special: 0, special2: 0 });
    expect(c.extraCards).toHaveLength(1);
    // Nothing of the files themselves: no bytes, only names and sizes.
    expect(JSON.stringify(m)).not.toMatch(/Uint8Array|"data"/);
    expect(memorySummary(m)).toEqual({ id: catalog.id, name: 'Emmas TonUINO', at: AT, folders: 2 });
  });

  it('keeps the day a box was first remembered when it is refreshed', async () => {
    const { scan, catalog } = await box();
    const first = buildBoxMemory(scan, catalog, { label: 'TONUINO', at: AT });
    const again = buildBoxMemory(scan, catalog, { label: 'TONUINO', at: AT + 3 * DAY, before: first });
    expect(again.since).toBe(AT);
    expect(again.at).toBe(AT + 3 * DAY);
    // Another box's memory says nothing about this one.
    const other = buildBoxMemory(scan, { ...catalog, id: 'other' }, { label: 'TONUINO', at: AT + 5 * DAY, before: first });
    expect(other.since).toBe(AT + 5 * DAY);
  });
});

describe('memoryScan', () => {
  it('gives the same shelf, track titles and card list as the card did', async () => {
    const { scan, catalog } = await box();
    const m = buildBoxMemory(scan, catalog, { label: 'TONUINO', at: AT });
    const again = memoryScan(m, true);
    const shelf = (s: typeof scan) => buildShelf(s, catalog).map((i) => [i.number, i.title, i.state, i.trackCount, i.durationSec]);
    expect(shelf(again)).toEqual(shelf(scan));
    expect(trackRows(again.folders[0], catalog.folders['01']).map((r) => r.title)).toEqual(['Hexen-Ei', 'Hexkraft']);
    const cards = (s: typeof scan) => buildCardItems(s, catalog, catalog.extraCards, 'tng').map((i) => [i.key, i.title, i.summary, i.data, i.problems]);
    expect(cards(again)).toEqual(cards(scan));
    expect(again.scannedAt).toBe(AT);
    expect(again.hasCovers).toBe(true);
  });

  it('has nothing to judge: no system folders, junk or file times', async () => {
    const { scan, catalog } = await box();
    const again = memoryScan(buildBoxMemory(scan, catalog, { label: 'TONUINO', at: AT }));
    expect(again.system).toEqual({});
    expect(again.rootOthers).toEqual([]);
    expect(again.rootJunk).toEqual([]);
    expect(again.fileTimes).toEqual([]);
    expect(again.rootOrder).toEqual(['01', '02']);
  });

  it('keeps what the announcements said about the firmware, not the announcements', async () => {
    const root = memDir({ mp3: { '0262.mp3': new Uint8Array(10) }, '01': { '001.mp3': new Uint8Array(10) } });
    const m = buildBoxMemory(await scanSd(root), newCatalog('TNG-Box'), { label: 'X', at: AT });
    expect(m.sounds).toEqual({ profile: 'tng', files: ['mp3/0262.mp3'] });
    expect(parseBoxMemory(structuredClone(m))?.sounds).toEqual(m.sounds);
    expect(memoryScan(m).system).toEqual({});
  });

  it('is an empty card when the box had no folders yet', async () => {
    const m = buildBoxMemory(await scanSd(memDir({ mp3: { '0001.mp3': new Uint8Array(10) } })), newCatalog('Leer'), { label: 'X', at: AT });
    expect(m.folders).toEqual([]);
    expect(memoryScan(m).kind).toBe('empty');
  });
});

describe('staleness', () => {
  it('only a memory older than a month counts as stale', () => {
    expect(isStale(AT, AT + 29 * DAY)).toBe(false);
    expect(isStale(AT, AT + 31 * DAY)).toBe(true);
    expect(isStale(AT, AT + 3 * DAY, 2)).toBe(true);
  });

  it('a refresh that finds the same box changes nothing but the time', async () => {
    const { scan, catalog } = await box();
    const first = buildBoxMemory(scan, catalog, { label: 'TONUINO', at: AT });
    const later = buildBoxMemory(scan, { ...catalog, updatedAt: AT + DAY }, { label: 'TONUINO', at: AT + DAY, before: first });
    expect(sameMemory(first, later)).toBe(true);
    expect(sameMemory(null, later)).toBe(false);
    const renamed = structuredClone(catalog);
    renamed.folders['01'].title = 'Bibi Blocksberg 2';
    expect(sameMemory(first, buildBoxMemory(scan, renamed, { label: 'TONUINO', at: AT + DAY, before: first }))).toBe(false);
  });

  it('says the day as the page shows it', () => {
    expect(rememberedDate(AT)).toBe('13.10.2026');
    expect(rememberedDate(new Date(2027, 0, 5, 0, 1).getTime())).toBe('05.01.2027');
  });
});

describe('parseBoxMemory', () => {
  it('reads back what was stored, and nothing else', async () => {
    const { scan, catalog } = await box();
    const m = buildBoxMemory(scan, catalog, { label: 'TONUINO', at: AT });
    expect(parseBoxMemory(structuredClone(m))).toEqual(m);
    expect(parseBoxMemory(null)).toBeNull();
    expect(parseBoxMemory({ ...m, format: 2 })).toBeNull();
    expect(parseBoxMemory({ ...m, folders: [{ number: 100, tracks: [] }] })).toBeNull();
    expect(parseBoxMemory({ ...m, folders: [{ number: 1, tracks: [{ number: 1, name: 5, size: 1 }] }] })).toBeNull();
    // Older memories without a first day take the day they were taken.
    const { since: _since, ...without } = m;
    expect(parseBoxMemory(without)?.since).toBe(AT);
  });
});

describe('covers on refresh', () => {
  const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
  const thumb = (stamp: CoverStamp, n = 3): MemoryThumbs[string] => ({ stamp, type: 'image/jpeg', data: bytes(n, 7), px: THUMB_PX });

  it('stamps the covers the catalog names and the card has', async () => {
    const { catalog } = await box();
    catalog.folders['02'] = { title: 'Ohne Bild', tracks: [], cover: '02.jpg', addedAt: AT, updatedAt: AT };
    const cover = bytes(40, 1);
    const stamps = coverStamps(catalog, new Map([['01.jpg', cover]]), crc32);
    expect(stamps).toEqual({ '01': { entry: '01.jpg', size: 40, crc: crc32(cover) } });
  });

  it('keeps thumbnails of unchanged covers, makes new ones and drops the rest', () => {
    const a: CoverStamp = { entry: '01.jpg', size: 10, crc: 1 };
    const b: CoverStamp = { entry: '02.jpg', size: 20, crc: 2 };
    const c: CoverStamp = { entry: '03.png', size: 30, crc: 3 };
    const have: MemoryThumbs = { '01': thumb(a), '02': thumb(b), '04': thumb({ entry: '04.jpg', size: 1, crc: 4 }) };
    const b2 = { ...b, crc: 22 };
    const want = { '01': a, '02': b2, '03': c };
    expect(thumbPlan(have, want)).toEqual({ keep: ['01'], make: ['02', '03'], drop: ['02', '04'] });
    expect(thumbPlan(undefined, want)).toEqual({ keep: [], make: ['01', '02', '03'], drop: [] });
    // Kept small before 0.5 (360 px): made again at print size.
    expect(thumbPlan({ '01': { ...thumb(a), px: undefined } }, { '01': a })).toEqual({ keep: [], make: ['01'], drop: ['01'] });

    const made: MemoryThumbs = { '02': thumb(b2, 5) };
    const merged = mergeThumbs(have, made, want);
    // 03 could not be made smaller: no thumbnail rather than an old picture.
    expect(Object.keys(merged)).toEqual(['01', '02']);
    expect(merged['01']).toBe(have['01']);
    expect(merged['02'].stamp).toEqual(b2);
    expect(sameThumbs(have, merged)).toBe(false);
    expect(sameThumbs(merged, mergeThumbs(merged, {}, { '01': a, '02': b2 }))).toBe(true);
  });

  it('stays small: thumbnails and lists, about what they hold', async () => {
    const { scan, catalog } = await box();
    const m = buildBoxMemory(scan, catalog, { label: 'TONUINO', at: AT });
    const stamp: CoverStamp = { entry: '01.jpg', size: 10, crc: 1 };
    const without = memoryBytes(m, {});
    expect(without).toBeLessThan(3000);
    const thumbs = { '01': thumb(stamp, 20_000) };
    expect(memoryBytes(m, thumbs)).toBe(without + 20_000);
    // Noted when taken, so the list of memories does not read the thumbnails.
    const noted = buildBoxMemory(scan, catalog, { label: 'TONUINO', at: AT, thumbs });
    expect(noted.thumbBytes).toBe(20_000);
    expect(memoryBytes(noted)).toBe(without + 20_000);
    expect(parseBoxMemory(structuredClone(noted))?.thumbBytes).toBe(20_000);
  });
});
