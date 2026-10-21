/**
 * A Hörspiel in one file, as video sites and downloaders name it, found at
 * the shops by its real name and cut at its real tracks (TODO 0.5 #81). The
 * shops cannot be reached from the test machine: the answers here have the
 * form of real iTunes and MusicBrainz answers (fixtures/library/*-bibi-tina.json),
 * with made-up track names and lengths.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { kindOfAlbum, shopSearchSec, wholeAlbumQueries } from '../../src/core/library/albumcut';
import { RateLimiter } from '../../src/core/stickers/coversearch';
import { lookupCoverAlbum, lookupWholeAlbum, parseItunesAlbums, parseMusicBrainzTracks, tracksTotal, wholeAlbumMisfit } from '../../src/core/library/tracklookup';

const json = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/library/${name}`, import.meta.url), 'utf8')) as unknown;
const ITUNES_SEARCH = json('itunes-search-bibi-tina.json');
const ITUNES_LOOKUP = json('itunes-lookup-bibi-tina.json');
const MB_SEARCH = json('musicbrainz-search-bibi-tina.json');
const MB_RELEASE = json('musicbrainz-release-bibi-tina.json');

/** A file named the way video sites name them: 41:04, no tags but its name. */
const FILE = 'Bibi & Tina - Das Kürbisfest (Folge 50) | HÖRSPIEL DES MONATS OKTOBER [Xq7Lm2Pz9Rt]';
const FILE_SEC = 41 * 60 + 4;

type Route = [RegExp, unknown | ((url: string) => unknown)];

function fakeFetch(routes: Route[]) {
  const seen: string[] = [];
  const fetchFn = async (url: string) => {
    seen.push(url);
    for (const [re, body] of routes) {
      if (!re.test(url)) continue;
      const answer = typeof body === 'function' ? (body as (u: string) => unknown)(url) : body;
      return new Response(JSON.stringify(answer), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchFn, seen };
}

const unreachable = () => {
  throw new TypeError('Failed to fetch');
};
const noWait = new RateLimiter(0);

/** What the add page does: the album's name (here the file's, no tags), then the file's own name. */
async function lookFor(name: string, totalSec: number, routes: Route[]) {
  const shop = fakeFetch(routes);
  for (const q of wholeAlbumQueries(name, name)) {
    const found = await lookupWholeAlbum({ ...q, totalSec }, { fetchFn: shop.fetchFn, rateLimiter: noWait });
    if (found) return { found, seen: shop.seen };
  }
  return { found: null, seen: shop.seen };
}

describe('a Bibi & Tina episode in one file', () => {
  it('is found at iTunes as "Folge 50: Das Kürbisfest", also when its tracks are 24 seconds shorter', async () => {
    const { found, seen } = await lookFor(FILE, FILE_SEC, [
      [/itunes\.apple\.com\/search/, ITUNES_SEARCH],
      [/itunes\.apple\.com\/lookup/, ITUNES_LOOKUP],
      [/musicbrainz/, unreachable],
    ]);
    expect(found?.album).toBe('Folge 50: Das Kürbisfest');
    expect(found?.artist).toBe('Bibi und Tina');
    expect(found?.tracks).toHaveLength(8);
    expect(FILE_SEC - tracksTotal(found!.tracks)!).toBeCloseTo(24, 3);
    // Searched as series and title: nothing of the video site goes to the shop.
    const term = new URL(seen[0]).searchParams.get('term');
    expect(term).toBe('Bibi Tina Das Kürbisfest');
    // Episode 50 of Bibi & Tina in one request: not 51, not Bibi Blocksberg's Kürbisfest.
    const lookups = seen.filter((u) => u.includes('/lookup'));
    expect(lookups).toHaveLength(1);
    expect(new URL(lookups[0]).searchParams.get('id')).toBe('1440000050,1440000150');
  });

  it('takes the MusicBrainz edition "050/Das Kürbisfest" when its length fits better', async () => {
    const { found, seen } = await lookFor(FILE, FILE_SEC, [
      [/itunes\.apple\.com\/search/, ITUNES_SEARCH],
      [/itunes\.apple\.com\/lookup/, ITUNES_LOOKUP],
      [/musicbrainz\.org\/ws\/2\/release\/\?query/, MB_SEARCH],
      [/musicbrainz\.org\/ws\/2\/release\/8e2b4c1d/, MB_RELEASE],
    ]);
    expect(found?.source).toBe('MusicBrainz');
    expect(found?.album).toBe('050/Das Kürbisfest');
    expect(found?.genre).toBe('Audio drama');
    expect(FILE_SEC - tracksTotal(found!.tracks)!).toBeCloseTo(4, 3);
    const query = decodeURIComponent(seen.find((u) => u.includes('query='))!);
    expect(query).toContain('release:"Das Kürbisfest"');
    expect(query).toContain('artist:(bibi tina)');
    // The cassette (2 tracks) and episode 51 are not looked at.
    expect(seen.filter((u) => /release\/[0-9a-f-]{36}\?/.test(u))).toHaveLength(1);
  });

  it('is nothing when no edition is that long, not even nearly', async () => {
    const { found } = await lookFor(FILE, FILE_SEC + 120, [
      [/itunes\.apple\.com\/search/, ITUNES_SEARCH],
      [/itunes\.apple\.com\/lookup/, ITUNES_LOOKUP],
      [/musicbrainz\.org\/ws\/2\/release\/\?query/, MB_SEARCH],
      [/musicbrainz\.org\/ws\/2\/release\/8e2b4c1d/, MB_RELEASE],
    ]);
    expect(found).toBeNull();
  });

  it('is a Hörspiel and gives the cuts room for the 24 seconds', () => {
    const album = parseItunesAlbums(ITUNES_LOOKUP)[0];
    expect(album.genre).toBe('Hörspiele');
    expect(kindOfAlbum(album)).toBe('hoerspiel');
    expect(kindOfAlbum(parseMusicBrainzTracks(MB_RELEASE)!)).toBe('hoerspiel');
    expect(kindOfAlbum({ album: 'Folge 1: Als Wetterelefant', artist: 'Benjamin Blümchen', genre: 'Kinder & Familie' })).toBe('hoerspiel');
    expect(kindOfAlbum({ album: 'Die 30 besten Kinderlieder', genre: 'Kindermusik' })).toBe('lieder');
    expect(kindOfAlbum({ album: 'Der kleine Prinz', genre: 'Hörbücher' })).toBe('hoerbuch');
    expect(kindOfAlbum({ album: 'Lieder vom Apfelbaum', genre: 'Pop' })).toBeUndefined();
    expect(shopSearchSec(album.tracks, FILE_SEC)).toBeCloseTo(16, 3);
    expect(shopSearchSec(album.tracks, 2440)).toBe(6);
    expect(shopSearchSec(album.tracks, 2440 + 100)).toBe(20);
  });
});

describe('the album of a chosen cover', () => {
  it('gives its track list at once, from iTunes by its id', async () => {
    const { fetchFn, seen } = fakeFetch([[/itunes\.apple\.com\/lookup\?id=1440000050&/, ITUNES_LOOKUP]]);
    const found = await lookupCoverAlbum({ id: 'itunes:1440000050' }, FILE_SEC, { fetchFn, rateLimiter: noWait });
    expect(found?.album).toBe('Folge 50: Das Kürbisfest');
    expect(seen).toHaveLength(1);
  });

  it('gives its track list from MusicBrainz by its release group, the edition that fits', async () => {
    const { fetchFn, seen } = fakeFetch([
      [/musicbrainz\.org\/ws\/2\/release\/\?query=rgid/, MB_SEARCH],
      [/musicbrainz\.org\/ws\/2\/release\/8e2b4c1d/, MB_RELEASE],
    ]);
    const found = await lookupCoverAlbum({ id: 'musicbrainz:3c1d7a52-0b6e-4f0e-9d1a-5e2f6b7c8d90' }, FILE_SEC, { fetchFn, rateLimiter: noWait });
    expect(found?.album).toBe('050/Das Kürbisfest');
    expect(decodeURIComponent(seen[0])).toContain('query=rgid:3c1d7a52-0b6e-4f0e-9d1a-5e2f6b7c8d90');
  });

  it('is nothing when the file is much longer than the album', async () => {
    const { fetchFn } = fakeFetch([[/itunes\.apple\.com\/lookup/, ITUNES_LOOKUP]]);
    expect(await lookupCoverAlbum({ id: 'itunes:1440000050' }, FILE_SEC + 300, { fetchFn, rateLimiter: noWait })).toBeNull();
    expect(await lookupCoverAlbum({ id: 'datei:1' }, FILE_SEC, { fetchFn, rateLimiter: noWait })).toBeNull();
  });
});

describe('how much the length of a sure match may differ', () => {
  const tracks = (sum: number) => [
    { title: 'a', durationSec: sum / 2 },
    { title: 'b', durationSec: sum / 2 },
  ];
  it('is a percent (at most 20 s), or 2.5 % (at most a minute) when the name leaves no doubt', () => {
    expect(wholeAlbumMisfit(2464, tracks(2440))).toBeUndefined();
    expect(wholeAlbumMisfit(2464, tracks(2440), true)).toBe(24);
    expect(wholeAlbumMisfit(2464, tracks(2400), true)).toBeUndefined();
    expect(wholeAlbumMisfit(600, tracks(612), true)).toBe(12);
    expect(wholeAlbumMisfit(2464, tracks(2450))).toBe(14);
  });
});

/* ------------------------------------------------------------ typical downloads */

/** A shop that knows these albums (in the form of iTunes' answers); each track is five minutes or so. */
interface ShopAlbum {
  id: number;
  album: string;
  artist: string;
  genre: string;
  /** Length of all tracks together, in seconds. */
  total: number;
  tracks: number;
}

const SHOP: ShopAlbum[] = [
  { id: 1, album: 'Folge 50: Das Kürbisfest', artist: 'Bibi und Tina', genre: 'Hörspiele', total: 2440, tracks: 8 },
  { id: 2, album: 'Folge 51: Der Pferdedieb', artist: 'Bibi und Tina', genre: 'Hörspiele', total: 2440, tracks: 8 },
  { id: 3, album: 'Folge 99: Das Kürbisfest', artist: 'Bibi Blocksberg', genre: 'Hörspiele', total: 2440, tracks: 9 },
  { id: 4, album: 'Folge 29: Der Ameisenmensch', artist: 'Die drei ???', genre: 'Hörspiele', total: 2905, tracks: 6 },
  { id: 5, album: 'Folge 29: Tatort Kletterwand', artist: 'Die drei !!!', genre: 'Hörspiele', total: 2905, tracks: 6 },
  { id: 6, album: 'Folge 125: Feuermond', artist: 'Die drei ???', genre: 'Hörspiele', total: 4620, tracks: 30 },
  { id: 7, album: 'Folge 200: Die Rache des Bombenlegers', artist: 'TKKG', genre: 'Hörspiele', total: 3910, tracks: 10 },
  { id: 8, album: 'Folge 201: Gefährliche Diamanten', artist: 'TKKG', genre: 'Hörspiele', total: 3910, tracks: 10 },
  { id: 9, album: 'Folge 1: Fünf Freunde beim Wanderzirkus', artist: 'Fünf Freunde', genre: 'Kinder & Familie', total: 2718, tracks: 7 },
  { id: 10, album: 'Folge 1: Hui Buh, das Schloßgespenst', artist: 'Hui Buh', genre: 'Hörspiele', total: 2264, tracks: 5 },
  { id: 11, album: '001/als Wetterelefant', artist: 'Benjamin Blümchen', genre: 'Hörspiele', total: 2522, tracks: 6 },
  { id: 12, album: '002/Der Zoo', artist: 'Benjamin Blümchen', genre: 'Hörspiele', total: 2522, tracks: 6 },
  { id: 13, album: '001/Hexen gibt es doch', artist: 'Bibi Blocksberg', genre: 'Hörspiele', total: 2380, tracks: 6 },
  { id: 14, album: 'Conni geht zum Zahnarzt (Neu)', artist: 'Conni', genre: 'Hörspiele', total: 1830, tracks: 9 },
  { id: 15, album: 'Conni kommt in den Kindergarten (Neu)', artist: 'Conni', genre: 'Hörspiele', total: 1830, tracks: 9 },
  { id: 16, album: 'Die 30 besten Kinderlieder', artist: 'Simone Sommerland, Karsten Glück & die Kita-Frösche', genre: 'Kindermusik', total: 4380, tracks: 30 },
  { id: 17, album: 'Die 30 besten Weihnachtslieder', artist: 'Simone Sommerland, Karsten Glück & die Kita-Frösche', genre: 'Kindermusik', total: 4380, tracks: 30 },
  { id: 18, album: 'Rolfs Vogelhochzeit', artist: 'Rolf Zuckowski und seine Freunde', genre: 'Kindermusik', total: 2795, tracks: 17 },
];

/** iTunes' search finds every album that shares a word (the order says nothing); its lookup gives the albums asked for. */
function itunesShop(): Route[] {
  const collection = (a: ShopAlbum) => ({ wrapperType: 'collection', collectionType: 'Album', collectionId: a.id, artistName: a.artist, collectionName: a.album, trackCount: a.tracks, primaryGenreName: a.genre, country: 'DEU' });
  const songs = (a: ShopAlbum) =>
    Array.from({ length: a.tracks }, (_, i) => ({
      wrapperType: 'track',
      kind: 'song',
      collectionId: a.id,
      artistName: a.artist,
      collectionName: a.album,
      trackName: `${a.album} - Teil ${i + 1}`,
      trackNumber: i + 1,
      discNumber: 1,
      trackTimeMillis: Math.round((a.total * 1000) / a.tracks),
    }));
  return [
    [/itunes\.apple\.com\/search/, { resultCount: SHOP.length, results: [...SHOP].reverse().map(collection) }],
    [
      /itunes\.apple\.com\/lookup/,
      (url: string) => {
        const ids = new URL(url).searchParams.get('id')!.split(',').map(Number);
        const asked = SHOP.filter((a) => ids.includes(a.id));
        return { resultCount: asked.length, results: asked.flatMap((a) => [collection(a), ...songs(a)]) };
      },
    ],
    [/musicbrainz/, { releases: [] }],
  ];
}

/** Names of downloads (video sites, rips, file names), the album they are, and how much longer the file is than its tracks. */
const DOWNLOADS: [name: string, album: number, offSec: number][] = [
  [FILE, 1, 24],
  ['Bibi & Tina - Das Kürbisfest', 1, 3],
  ['Die drei ??? - Der Ameisenmensch (Folge 29) | Hörspiel komplett', 4, 12],
  ['Die drei ??? Folge 125', 6, -5],
  ['TKKG - Folge 200 - Die Rache des Bombenlegers [Full Album]', 7, 31],
  ['5 Freunde - Folge 1 - Fünf Freunde beim Wanderzirkus [Hörspiel] #fünffreunde #hörspiel', 9, 8],
  ['HUI BUH - Folge 1 - Das Schlossgespenst (Hörspiel)-aB3dE6gH9jK', 10, 2],
  ['Benjamin Bluemchen 001 als Wetterelefant (Hörspiel)', 11, -14],
  ['Bibi Blocksberg - Hexen gibt es doch - Hörspiel - Folge 1 [Full Episode] 🧹✨', 13, 40],
  ['Meine Freundin Conni - Conni geht zum Zahnarzt (Hörbuch komplett)', 14, 6],
  ['Simone Sommerland, Karsten Glück & die Kita-Frösche - Die 30 besten Kinderlieder (Full Album)', 16, 9],
  ['Rolf Zuckowski | Rolfs Vogelhochzeit | Full Album', 18, -3],
];

describe('typical downloads of Hörspiele and children\'s songs', () => {
  it.each(DOWNLOADS)('find their album: %s', async (name, id, off) => {
    const want = SHOP.find((a) => a.id === id)!;
    const { found, seen } = await lookFor(name, want.total + off, itunesShop());
    expect(found?.album).toBe(want.album);
    expect(found?.artist).toBe(want.artist);
    expect(found?.tracks).toHaveLength(want.tracks);
    // Never a video id or "HÖRSPIEL DES MONATS" in the search.
    expect(decodeURIComponent(seen[0])).not.toMatch(/Xq7Lm2Pz9Rt|aB3dE6gH9jK|MONATS|Full|komplett|#/i);
  });

  it('find nothing when the name fits but the length is far off, or only the length fits', async () => {
    expect((await lookFor('Die drei ??? - Der Ameisenmensch (Folge 29)', 2905 + 300, itunesShop())).found).toBeNull();
    expect((await lookFor('Die drei ??? - Der Super-Papagei (Folge 1)', 2905, itunesShop())).found).toBeNull();
    // Without a number and not word for word, a percent is all the room there is.
    expect((await lookFor('Rolfs Vogelhochzeit Live', 2795 + 40, itunesShop())).found).toBeNull();
  });
});
