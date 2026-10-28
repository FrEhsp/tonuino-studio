/**
 * The automatic cover run on an open card (src/features/covers/autoCovers.ts),
 * with a card in memory and the services answered here: sure hits go on the
 * card, unsure ones are offered, a cover there is never replaced, and one the
 * run saved and someone took off does not come back.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNet } from '../../src/core/covers/net';
import { newCatalog, serializeCatalog, type Catalog, type CatalogFolder } from '../../src/core/tonuino/catalog';
import { loadCovers, packCovers } from '../../src/core/tonuino/covers';
import { boot, card, closeCard, openVolume, setCovers, settings } from '../../src/app/state';
import { memDir } from '../../src/platform/memory';
import type { Platform, Volume } from '../../src/platform/types';
import { tinyJpeg } from '../stickers/fixtures';

const JPEG = (n: number) => {
  const b = tinyJpeg();
  b[b.length - 3] = n;
  return b;
};

// Pictures are not decoded in node: prepareCover passes the bytes on.
vi.mock('../../src/features/box/CoverDialog', () => ({
  prepareCover: async (input: Blob | Uint8Array, mimeType: string, source: string) => ({
    data: input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer()),
    mimeType,
    source,
  }),
}));

const requests: string[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
/** iTunes and Deezer know two albums; MusicBrainz nothing. */
async function services(url: string): Promise<Response> {
  requests.push(url);
  const term = decodeURIComponent((url.split(/[?&](?:term|q|query)=/)[1] ?? '').split('&')[0]).replace(/\+/g, ' ').toLowerCase();
  const albums = [
    { id: 1, artist: 'Rolf Zuckowski', title: 'Die Weihnachtsbäckerei' },
    { id: 2, artist: 'Die drei ???', title: 'Folge 126: Feuermond' },
  ].filter((a) => term.includes(a.title.toLowerCase().split(/\W+/).filter((w) => w.length > 5)[0] ?? '###'));
  if (url.startsWith('https://itunes.apple.com/')) return json({ resultCount: albums.length, results: albums.map((a) => ({ wrapperType: 'collection', collectionId: a.id, artistName: a.artist, collectionName: a.title, artworkUrl100: `https://is1-ssl.mzstatic.com/${a.id}/100x100bb.jpg` })) });
  if (url.startsWith('https://api.deezer.com/')) return json({ data: albums.map((a) => ({ id: a.id, title: a.title, artist: { name: a.artist }, cover_medium: `https://e-cdns-images.dzcdn.net/${a.id}/250x250.jpg` })), total: albums.length });
  if (url.startsWith('https://musicbrainz.org/')) return json({ releases: [] });
  return new Response(JPEG(7), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
}

vi.mock('../../src/features/box/CoverSearch', () => ({
  coverFetch: (url: string) => services(url),
  loadSearchCover: async () => new Blob([JPEG(7)], { type: 'image/jpeg' }),
  SOURCE_LABEL: { itunes: 'iTunes', deezer: 'Deezer', musicbrainz: 'MusicBrainz' },
}));

const entry = (title: string, more: Partial<CatalogFolder> = {}): CatalogFolder => ({ title, tracks: [{ file: '001.mp3' }], addedAt: 1, updatedAt: 1, ...more });

async function testCard() {
  const c: Catalog = newCatalog('Lenas Box');
  c.folders['01'] = entry('Die Weihnachtsbäckerei', { artist: 'Rolf Zuckowski' });
  c.folders['02'] = entry('Hexen gibt es doch', { artist: 'Bibi Blocksberg', cover: '02.jpg', coverSource: 'Datei' });
  c.folders['03'] = entry('Feuermond', { series: 'Die drei ???', episode: 125 });
  c.folders['04'] = entry('Unser Urlaub');
  c.folders['05'] = entry('Ordner 05');
  const tree: Record<string, Record<string, number | Uint8Array> | string | Uint8Array> = {
    'tonuino-studio.json': serializeCatalog(c),
    'tonuino-studio-covers.zip': await packCovers(new Map([['02.jpg', JPEG(2)]])),
    '01': { '001.mp3': 1000 },
    '02': { '001.mp3': 1000 },
    '03': { '001.mp3': 1000 },
    // Folder 04 brings its own picture.
    '04': { '001.mp3': 1000, 'cover.jpg': JPEG(4) },
    '05': { '001.mp3': 1000 },
  };
  const root = memDir(tree as never);
  return { id: 'auto', label: 'SD', root, info: { removable: true }, canEject: true } as unknown as Volume;
}

describe('covers by themselves', () => {
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
  beforeEach(() => {
    resetNet();
    requests.length = 0;
    settings.value = { ...settings.value, findCovers: true };
  });
  afterEach(() => closeCard());

  it('saves sure covers and the folder\'s own picture, offers the unsure, leaves a cover there alone', async () => {
    const { autoCovers, runAutoCovers } = await import('../../src/features/covers/autoCovers');
    const volume = await testCard();
    await openVolume(volume);
    await runAutoCovers();
    const folders = card.value!.catalog!.folders;
    expect(folders['01']).toMatchObject({ cover: '01.jpg', coverSource: 'iTunes' });
    expect(folders['02']).toMatchObject({ cover: '02.jpg', coverSource: 'Datei' });
    expect(folders['03'].cover).toBeUndefined();
    expect(folders['04']).toMatchObject({ cover: '04.jpg', coverSource: 'Datei' });
    expect(folders['05'].cover).toBeUndefined();
    const zip = await loadCovers(volume.root);
    expect(zip.get('02.jpg')).toEqual(JPEG(2));
    expect(zip.get('04.jpg')).toEqual(JPEG(4));
    const st = autoCovers.value;
    expect([...st.saved].sort()).toEqual([1, 4]);
    expect(st.fromFiles).toBe(1);
    // Episode 126 for a folder of episode 125: to choose from, not saved.
    expect([...st.proposals.keys()]).toEqual([3]);
    expect(st.phase).toBe('idle');
    // The folder with its own picture and the one without a name asked no service.
    expect(requests.some((u) => /urlaub|ordner/i.test(u))).toBe(false);
    // MusicBrainz only for the rest: the folder without a sure hit (with and without the series).
    const mb = requests.filter((u) => u.includes('musicbrainz'));
    expect(mb.length).toBeGreaterThan(0);
    expect(mb.every((u) => /feuermond/i.test(decodeURIComponent(u)))).toBe(true);
  });

  it('does not bring back a cover someone took off, and does nothing with the setting off', async () => {
    const { runAutoCovers, declineProposal, autoCovers } = await import('../../src/features/covers/autoCovers');
    const volume = await testCard();
    await openVolume(volume);
    await runAutoCovers();
    declineProposal(3);
    expect(autoCovers.value.proposals.size).toBe(0);
    await setCovers([{ folder: 1, data: null }]);
    requests.length = 0;
    await runAutoCovers();
    expect(card.value!.catalog!.folders['01'].cover).toBeUndefined();
    expect(requests).toEqual([]);

    settings.value = { ...settings.value, findCovers: false };
    await runAutoCovers({ folders: [5] });
    expect(autoCovers.value.phase).toBe('off');
    // Asked for on purpose: it looks again, still never over a cover.
    await runAutoCovers({ folders: [1, 2], asked: true });
    expect(card.value!.catalog!.folders['01']).toMatchObject({ cover: '01.jpg' });
    expect((await loadCovers(volume.root)).get('02.jpg')).toEqual(JPEG(2));
  });

  it('waits with its covers while a Paket is packed and not yet saved: it would be stale', async () => {
    const { autoCovers, runAutoCovers } = await import('../../src/features/covers/autoCovers');
    const { holdForPackage } = await import('../../src/app/packageHold');
    // Loaded before: the run asks it whether Hinzufügen is writing, and loading it takes a while here.
    await import('../../src/features/add/session');
    await openVolume(await testCard());
    const release = holdForPackage();
    // Only the folder with a sure hit: nothing else (MusicBrainz waits a second between questions) holds the run up.
    const run = runAutoCovers({ folders: [1] });
    await vi.waitFor(() => expect(autoCovers.value.done).toBe(1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 500));
    expect(card.value!.catalog!.folders['01'].cover).toBeUndefined();
    release();
    release();
    await run;
    expect(card.value!.catalog!.folders['01']).toMatchObject({ cover: '01.jpg', coverSource: 'iTunes' });
  });

  it('accepts a hit to choose from', async () => {
    const { runAutoCovers, acceptProposal, autoCovers } = await import('../../src/features/covers/autoCovers');
    const volume = await testCard();
    await openVolume(volume);
    // A new catalog id per test card: nothing remembered from the tests before.
    await runAutoCovers({ asked: true });
    const offered = autoCovers.value.proposals.get(3);
    expect(offered?.candidates[0].title).toBe('Folge 126: Feuermond');
    expect(await acceptProposal(3, offered!.candidates[0].id)).toBe(true);
    expect(card.value!.catalog!.folders['03']).toMatchObject({ cover: '03.jpg' });
    expect(autoCovers.value.proposals.has(3)).toBe(false);
  });
});
