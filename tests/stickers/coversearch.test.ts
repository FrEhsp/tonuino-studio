import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noteUnreachable, resetNet, type Limiter } from '../../src/core/covers/net';
import {
  buildDeezerUrl,
  buildItunesUrl,
  buildMusicBrainzQuery,
  buildMusicBrainzUrl,
  downloadCoverImage,
  embeddedCover,
  episodeNumbers,
  itunesArtworkUrl,
  keepShownOrder,
  NO_CASSETTE_PHOTO,
  NO_CASSETTE_SEARCH,
  normalizeForMatch,
  parseDeezerResults,
  parseItunesResults,
  parseMusicBrainzResults,
  pickFolderImage,
  RateLimiter,
  rankCandidates,
  scoreCandidate,
  searchCovers,
  type CoverCandidate,
  type CoverQuery,
  type CoverSource,
} from '../../src/core/stickers/coversearch';
import { tinyJpeg, tinyPng } from './fixtures';

// ---------------------------------------------------------------------------
// Recorded-looking API responses (shortened)

const art = (id: string) => `https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/${id}/source/100x100bb.jpg`;

const ITUNES_DDF = {
  resultCount: 5,
  results: [
    {
      wrapperType: 'collection',
      collectionType: 'Album',
      artistId: 129417573,
      collectionId: 1440806591,
      artistName: 'Die drei ???',
      collectionName: 'Folge 125: Feuermond (Teil 1 - Das Rätsel der Meister)',
      collectionCensoredName: 'Folge 125: Feuermond (Teil 1 - Das Rätsel der Meister)',
      artworkUrl60: art('5c/0a/3e/5c0a3e1d/886447').replace('100x100bb', '60x60bb'),
      artworkUrl100: art('5c/0a/3e/5c0a3e1d/886447'),
      collectionPrice: 6.99,
      trackCount: 13,
      copyright: '℗ 2008 Europa (Sony Music)',
      country: 'DEU',
      currency: 'EUR',
      releaseDate: '2008-04-11T07:00:00Z',
      primaryGenreName: 'Hörspiele',
    },
    {
      wrapperType: 'collection',
      collectionType: 'Album',
      artistId: 129417573,
      collectionId: 1440729154,
      artistName: 'Die drei ???',
      collectionName: 'Folge 12: Der seltsame Wecker',
      artworkUrl60: art('a1/2b/9f/a12b9f00/886443').replace('100x100bb', '60x60bb'),
      artworkUrl100: art('a1/2b/9f/a12b9f00/886443'),
      trackCount: 9,
      copyright: '℗ 1980 Europa (Sony Music)',
      country: 'DEU',
      currency: 'EUR',
      releaseDate: '1980-01-01T08:00:00Z',
      primaryGenreName: 'Hörspiele',
    },
    {
      wrapperType: 'collection',
      collectionType: 'Album',
      artistId: 129417573,
      collectionId: 1441100045,
      artistName: 'Die drei ???',
      collectionName: 'Box 04 (Folgen 10-12)',
      artworkUrl100: art('0f/ee/12/0fee1200/886445'),
      releaseDate: '2009-11-13T08:00:00Z',
      primaryGenreName: 'Hörspiele',
    },
    {
      wrapperType: 'collection',
      collectionType: 'Album',
      artistId: 288017164,
      collectionId: 1442368873,
      artistName: 'Die drei !!!',
      collectionName: 'Folge 12: Tanz der Hexen',
      artworkUrl100: art('77/31/c0/7731c0aa/886446'),
      releaseDate: '2008-02-15T08:00:00Z',
      primaryGenreName: 'Kinder & Familie',
    },
    // An entry without artwork cannot be offered.
    { wrapperType: 'collection', collectionId: 1, artistName: 'Die drei ???', collectionName: 'Folge 12 (ohne Bild)' },
  ],
};

const MUSICBRAINZ_DDF = {
  created: '2026-10-05T09:12:44.351Z',
  count: 31,
  offset: 0,
  releases: [
    {
      id: '3f6d5b1e-6c1e-4a52-9d36-0d5ff4f0b6a1',
      score: 100,
      'status-id': '4e304316-386d-3409-af2e-78857eec5cfe',
      count: 1,
      title: 'Der seltsame Wecker',
      status: 'Official',
      'text-representation': { language: 'deu', script: 'Latn' },
      'artist-credit': [{ name: 'Die drei ???', artist: { id: '19a0f7e5-6a2a-4c6c-8b3f-3e3a9a33f7c2', name: 'Die drei ???', 'sort-name': 'drei ???, Die' } }],
      'release-group': {
        id: 'b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12',
        title: 'Der seltsame Wecker',
        'primary-type': 'Album',
        'secondary-types': ['Audio drama'],
      },
      date: '1980',
      country: 'DE',
      'track-count': 9,
      media: [{ format: 'Cassette', 'disc-count': 0, 'track-count': 9 }],
    },
    {
      // CD re-release of the same release group: merged into the first.
      id: '8a1c0b22-1d5b-4e5f-a0c8-1b9e4b7d2c33',
      score: 97,
      title: 'Der seltsame Wecker',
      'artist-credit': [{ name: 'Die drei ???' }],
      'release-group': { id: 'b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12', 'primary-type': 'Album' },
      date: '2001-06-11',
      media: [{ format: 'CD', 'track-count': 9 }],
    },
    {
      id: 'c2d4e6f8-0a1b-4c3d-9e8f-7a6b5c4d3e2f',
      score: 88,
      title: 'Folge 12: Der seltsame Wecker',
      'artist-credit': [
        { name: 'Die drei ???', joinphrase: ' & ' },
        { name: 'Oliver Rohrbeck', artist: { name: 'Oliver Rohrbeck' } },
      ],
      'release-group': { id: 'd1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6' },
      date: '2019-03-01',
    },
    {
      // No release group: the release's own cover is used.
      id: 'e5f6a7b8-c9d0-4e1f-a2b3-c4d5e6f7a8b9',
      score: '61',
      title: 'Tanz der Hexen',
      'artist-credit': [{ name: 'Die drei !!!' }],
    },
    { id: 'broken', score: 50 },
  ],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DEEZER_DDF = {
  data: [
    {
      id: 302127,
      title: 'Folge 12: Der seltsame Wecker',
      cover_medium: 'https://e-cdns-images.dzcdn.net/images/cover/2e018122cb56986277102d2041a592c8/250x250-000000-80-0-0.jpg',
      cover_big: 'https://e-cdns-images.dzcdn.net/images/cover/2e018122cb56986277102d2041a592c8/500x500-000000-80-0-0.jpg',
      cover_xl: 'https://e-cdns-images.dzcdn.net/images/cover/2e018122cb56986277102d2041a592c8/1000x1000-000000-80-0-0.jpg',
      artist: { id: 5352, name: 'Die drei ???' },
      type: 'album',
    },
    {
      id: 302128,
      title: 'Folge 12: Der seltsame Wecker (Hörprobe)',
      cover_medium: 'https://e-cdns-images.dzcdn.net/images/cover/aa/250x250-000000-80-0-0.jpg',
      artist: { id: 99, name: 'Hörbuch Hamburg' },
      type: 'album',
    },
    { id: 1, title: 'Ohne Bild', artist: { name: 'X' } },
  ],
  total: 3,
};

/** fetch stand-in answering the three APIs; `override` replaces one of them. */
function mockFetch(override: { itunes?: FetchFn; deezer?: FetchFn; musicbrainz?: FetchFn } = {}) {
  return vi.fn<FetchFn>(async (url, init) => {
    if (url.startsWith('https://itunes.apple.com/search?')) return override.itunes ? override.itunes(url, init) : jsonResponse(ITUNES_DDF);
    if (url.startsWith('https://api.deezer.com/search/album?')) return override.deezer ? override.deezer(url, init) : jsonResponse(DEEZER_DDF);
    if (url.startsWith('https://musicbrainz.org/ws/2/release/?')) {
      return override.musicbrainz ? override.musicbrainz(url, init) : jsonResponse(MUSICBRAINZ_DDF);
    }
    throw new Error(`unexpected request ${url}`);
  });
}

/** A queue that gives every turn at once. */
const instant = (): Limiter => ({ wait: async (signal) => void signal?.throwIfAborted() });
const quick = () => ({ itunes: instant(), deezer: instant(), musicbrainz: instant() });

beforeEach(() => resetNet());
const DDF_12: CoverQuery = { query: 'Die drei ??? Folge 12' };

// ---------------------------------------------------------------------------

describe('request URLs', () => {
  it('asks iTunes for German albums', () => {
    expect(buildItunesUrl({ artist: 'Die drei ???', album: 'Folge 12' })).toBe(
      'https://itunes.apple.com/search?term=Die+drei+%3F%3F%3F+Folge+12&entity=album&limit=12&country=DE',
    );
  });

  it('builds a safe Lucene query for MusicBrainz', () => {
    expect(buildMusicBrainzQuery({ artist: 'Die drei ???', album: 'Der seltsame Wecker' })).toBe(
      'artist:"Die drei ???" AND release:(der seltsame wecker)',
    );
    expect(buildMusicBrainzQuery({ query: 'Bibi Blocksberg: Folge 3 AND (Hexen)' })).toBe(
      'release:"bibi blocksberg folge 3 and hexen"^3 OR release:(bibi blocksberg folge 3 hexen) OR artist:(bibi blocksberg folge 3 hexen)',
    );
    expect(buildMusicBrainzQuery({ artist: 'Sänger "X"' })).toBe('artist:"Sänger \\"X\\""');
    expect(buildMusicBrainzUrl({ artist: 'TKKG', album: 'Folge 125' })).toBe(
      'https://musicbrainz.org/ws/2/release/?query=artist%3A%22TKKG%22%20AND%20release%3A(folge%20125)&fmt=json&limit=8',
    );
  });
});

describe('parsing', () => {
  it('turns iTunes albums into candidates with print-sized artwork', () => {
    const list = parseItunesResults(ITUNES_DDF);
    expect(list).toHaveLength(4);
    expect(list[1]).toEqual({
      id: 'itunes:1440729154',
      source: 'itunes',
      title: 'Folge 12: Der seltsame Wecker',
      artist: 'Die drei ???',
      year: 1980,
      thumbUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/a1/2b/9f/a12b9f00/886443/source/250x250bb.jpg',
      mediumUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/a1/2b/9f/a12b9f00/886443/source/600x600bb.jpg',
      fullUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/a1/2b/9f/a12b9f00/886443/source/1200x1200bb.jpg',
      sizeHint: 1200,
      score: 0,
    });
    expect(itunesArtworkUrl('https://x.mzstatic.com/a/100x100bb.png', 600)).toBe('https://x.mzstatic.com/a/600x600bb.png');
    expect(parseItunesResults({ resultCount: 0, results: [] })).toEqual([]);
    expect(() => parseItunesResults({ errorMessage: 'Invalid value(s) for key(s): [entity]' })).toThrow();
  });

  it('turns MusicBrainz releases into Cover Art Archive candidates, one per release group', () => {
    const list = parseMusicBrainzResults(MUSICBRAINZ_DDF);
    expect(list.map((c) => c.id)).toEqual([
      'musicbrainz:b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12',
      'musicbrainz:d1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6',
      'musicbrainz:e5f6a7b8-c9d0-4e1f-a2b3-c4d5e6f7a8b9',
    ]);
    expect(list[0]).toMatchObject({
      source: 'musicbrainz',
      title: 'Der seltsame Wecker',
      artist: 'Die drei ???',
      year: 1980,
      thumbUrl: 'https://coverartarchive.org/release-group/b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12/front-250',
      mediumUrl: 'https://coverartarchive.org/release-group/b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12/front-500',
      fullUrl: 'https://coverartarchive.org/release-group/b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12/front-1200',
      sizeHint: 1200,
    });
    expect(list[1].artist).toBe('Die drei ??? & Oliver Rohrbeck');
    expect(list[2].fullUrl).toBe('https://coverartarchive.org/release/e5f6a7b8-c9d0-4e1f-a2b3-c4d5e6f7a8b9/front-1200');
    expect(list[2].year).toBeUndefined();
    expect(() => parseMusicBrainzResults({ error: 'Invalid query' })).toThrow();
  });
});

describe('Deezer', () => {
  it('turns Deezer albums into candidates with pictures up to 1000 px', () => {
    const list = parseDeezerResults(DEEZER_DDF);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      id: 'deezer:302127',
      source: 'deezer',
      title: 'Folge 12: Der seltsame Wecker',
      artist: 'Die drei ???',
      year: undefined,
      thumbUrl: DEEZER_DDF.data[0].cover_medium,
      mediumUrl: DEEZER_DDF.data[0].cover_big,
      fullUrl: DEEZER_DDF.data[0].cover_xl,
      sizeHint: 1000,
      score: 0,
    });
    // Only a small picture: no size promised.
    expect(list[1]).toMatchObject({ fullUrl: DEEZER_DDF.data[1].cover_medium, sizeHint: undefined });
    expect(parseDeezerResults({ data: [], total: 0 })).toEqual([]);
    // Too many requests: as busy as a 429; anything else is an error.
    expect(() => parseDeezerResults({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } })).toThrow('HTTP 429');
    expect(() => parseDeezerResults({ error: { type: 'DataException', message: 'no data', code: 800 } })).toThrow('HTTP 500');
    expect(() => parseDeezerResults('<html>')).toThrow();
  });

  it('asks Deezer for the cleaned name', () => {
    expect(buildDeezerUrl({ query: 'SpotiDownloader.com - Die drei ??? Folge 12 (Remastered 2009)' })).toBe(
      'https://api.deezer.com/search/album?q=Die+drei+%3F%3F%3F+Folge+12&limit=12',
    );
  });
});

describe('matching', () => {
  it('normalises umlauts, punctuation, numbers and series names', () => {
    expect(normalizeForMatch('Die drei ??? – Folge 012: Der seltsame Wecker')).toBe('die drei fragezeichen folge 12 der seltsame wecker');
    expect(normalizeForMatch('Die 3 ???')).toBe('die drei fragezeichen');
    expect(normalizeForMatch('DIE DREI !!!')).toBe('die drei ausrufezeichen');
    expect(normalizeForMatch('Bibi & Tina')).toBe('bibi und tina');
    expect(normalizeForMatch('Benjamin Blümchen')).toBe('benjamin bluemchen');
    // Decomposed umlaut, as in macOS file names.
    expect(normalizeForMatch('Benjamin Blümchen')).toBe('benjamin bluemchen');
    expect(normalizeForMatch('T.K.K.G.')).toBe('tkkg');
    expect(normalizeForMatch('Fünf Freunde')).toBe(normalizeForMatch('5 Freunde'));
    expect(normalizeForMatch('Pokémon – Straße')).toBe('pokemon strasse');
  });

  it('finds episode numbers but not years', () => {
    expect(episodeNumbers('Die drei ??? Folge 12')).toEqual([12]);
    expect(episodeNumbers('TKKG 125 – Gefangen in Mauern')).toEqual([125]);
    expect(episodeNumbers('Die 3 ??? Kids 5')).toEqual([5]);
    expect(episodeNumbers('Folgen 10-12')).toEqual([10, 12]);
    expect(episodeNumbers('Hörspiel 2019')).toEqual([]);
    expect(episodeNumbers('Folge 2019')).toEqual([2019]);
    expect(episodeNumbers('Der seltsame Wecker')).toEqual([]);
  });

  const candidate = (title: string, artist: string, source: CoverCandidate['source'] = 'itunes'): CoverCandidate => ({
    id: `${source}:${title}`,
    source,
    title,
    artist,
    thumbUrl: 'https://example.org/t.jpg',
    fullUrl: 'https://example.org/f.jpg',
    score: 0,
  });

  it('ranks the right episode of the right series first', () => {
    const ranked = rankCandidates(DDF_12, [
      candidate('Folge 125: Feuermond', 'Die drei ???'),
      candidate('Folge 12: Tanz der Hexen', 'Die drei !!!'),
      candidate('Box 04 (Folgen 10-12)', 'Die drei ???'),
      candidate('Der seltsame Wecker', 'Die drei ???', 'musicbrainz'),
      candidate('Folge 12: Der seltsame Wecker', 'Die drei ???'),
    ]);
    expect(ranked.map((c) => c.title)).toEqual([
      'Folge 12: Der seltsame Wecker',
      'Box 04 (Folgen 10-12)',
      'Der seltsame Wecker',
      'Folge 12: Tanz der Hexen',
      'Folge 125: Feuermond',
    ]);
    // Scores are sorted and stored on the candidates.
    const scores = ranked.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('matches across spellings and prefers the asked artist', () => {
    const q = { artist: 'Benjamin Bluemchen', album: 'Folge 3' };
    const right = scoreCandidate(q, candidate('Folge 3: ...als Wetterelefant', 'Benjamin Blümchen'));
    const otherArtist = scoreCandidate(q, candidate('Folge 3: Hexen gibt es doch', 'Bibi Blocksberg'));
    const otherEpisode = scoreCandidate(q, candidate('Folge 4: ...als Koch', 'Benjamin Blümchen'));
    expect(right).toBeGreaterThan(otherArtist);
    expect(right).toBeGreaterThan(otherEpisode);
    expect(right).toBeGreaterThan(0.9);
  });

  it('drops duplicates and keeps the iTunes one on a tie', () => {
    const ranked = rankCandidates({ artist: 'TKKG', album: 'Folge 125' }, [
      { ...candidate('Folge 125: Gefangen in Mauern', 'TKKG', 'musicbrainz'), mbScore: 100 },
      candidate('Folge 125: Gefangen in Mauern', 'TKKG'),
      candidate('Folge 125 – Gefangen in Mauern', 'T.K.K.G.', 'musicbrainz'),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].source).toBe('itunes');
    expect(ranked[0]).not.toHaveProperty('mbScore');
  });
});

describe('tiles while a search runs', () => {
  const hit = (title: string, artist: string, source: CoverCandidate['source'] = 'itunes', score = 0): CoverCandidate => ({
    id: `${source}:${title}`,
    source,
    title,
    artist,
    thumbUrl: 'https://example.org/t.jpg',
    fullUrl: 'https://example.org/f.jpg',
    score,
  });

  it('keeps the tiles on the screen where they are and adds the slower service\'s hits after them', () => {
    const q = { query: 'Die drei ??? Folge 12' };
    const fromItunes = [hit('Box 04 (Folgen 10-12)', 'Die drei ???'), hit('Folge 125: Feuermond', 'Die drei ???')];
    const first = keepShownOrder([], rankCandidates(q, fromItunes));
    // MusicBrainz has the best hit, and the ranking puts it on top …
    const all = rankCandidates(q, [...fromItunes, hit('Folge 12: Der seltsame Wecker', 'Die drei ???', 'musicbrainz')]);
    expect(all[0].title).toBe('Folge 12: Der seltsame Wecker');
    // … but on the screen it joins at the end: nothing moves under the pointer.
    const next = keepShownOrder(first, all);
    expect(next.slice(0, first.length)).toEqual(first);
    expect(next.map((c) => c.title)).toEqual([...first.map((c) => c.title), 'Folge 12: Der seltsame Wecker']);
  });

  it('shows an album only once, also when the slower service has it too', () => {
    const shown = [hit('Folge 12: Der seltsame Wecker', 'Die drei ???')];
    const ranked = [hit('Folge 12 – Der seltsame Wecker', 'Die Drei ???', 'musicbrainz', 1), hit('Folge 13', 'Die drei ???', 'itunes', 0.5)];
    expect(keepShownOrder(shown, ranked).map((c) => c.id)).toEqual(['itunes:Folge 12: Der seltsame Wecker', 'itunes:Folge 13']);
  });

  it('keeps a tile that the full ranking would drop, and stops at the limit', () => {
    const shown = [hit('A', 'x'), hit('B', 'x')];
    expect(keepShownOrder(shown, [hit('C', 'x')]).map((c) => c.title)).toEqual(['A', 'B', 'C']);
    expect(keepShownOrder(shown, [hit('C', 'x'), hit('D', 'x')], 3).map((c) => c.title)).toEqual(['A', 'B', 'C']);
    // Nothing on the screen yet: just the ranking.
    expect(keepShownOrder([], [hit('C', 'x'), hit('D', 'x')], 1).map((c) => c.title)).toEqual(['C']);
  });
});

describe('searchCovers', () => {
  it('asks the three services in parallel and merges the ranked results', async () => {
    const fetchFn = mockFetch();
    const limiters = quick();
    const wait = vi.spyOn(limiters.musicbrainz, 'wait');
    const result = await searchCovers(DDF_12, { fetchFn, limiters });
    expect(result.warnings).toEqual([]);
    expect(result.asked).toEqual(['itunes', 'deezer', 'musicbrainz']);
    expect(result.failed).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(1);
    const urls = fetchFn.mock.calls.map(([url]) => url);
    expect(urls).toContain(buildItunesUrl(DDF_12));
    expect(urls).toContain(buildDeezerUrl(DDF_12));
    expect(urls).toContain(buildMusicBrainzUrl(DDF_12));
    for (const [, init] of fetchFn.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toEqual({ Accept: 'application/json' });
    }
    const top = result.candidates[0];
    expect(top).toMatchObject({ id: 'itunes:1440729154', title: 'Folge 12: Der seltsame Wecker', artist: 'Die drei ???' });
    expect(top.fullUrl).toMatch(/\/1200x1200bb\.jpg$/);
    // Deezer has the same album: it is no second tile, but counts as a second source.
    expect(top.alsoFrom).toEqual(['deezer']);
    expect(result.candidates.map((c) => c.source)).toContain('musicbrainz');
    // Right episode first (from both services; the second has another artist credit, so it is no
    // duplicate), then the box with the episode, the right series without a number, the wrong
    // series with the right number, the wrong episode, and the wrong series without a number.
    expect(result.candidates.map((c) => c.id)).toEqual([
      'itunes:1440729154',
      'musicbrainz:d1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6',
      'itunes:1441100045',
      'musicbrainz:b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12',
      'itunes:1442368873',
      'itunes:1440806591',
      'musicbrainz:e5f6a7b8-c9d0-4e1f-a2b3-c4d5e6f7a8b9',
    ]);
  });

  it('leaves a service that fails out without a word while another answers', async () => {
    const opts = { limiters: quick(), cache: false, retries: 0 };
    const busy = await searchCovers(DDF_12, { ...opts, fetchFn: mockFetch({ itunes: async () => new Response('Service Unavailable', { status: 503 }) }) });
    expect(busy.warnings).toEqual([]);
    expect(busy.failed).toEqual(['itunes']);
    expect(busy.candidates.length).toBeGreaterThan(0);
    expect(busy.candidates.some((c) => c.source === 'itunes')).toBe(false);

    const offline = await searchCovers(DDF_12, { ...opts, fetchFn: mockFetch({ musicbrainz: async () => Promise.reject(new TypeError('Failed to fetch')) }) });
    expect(offline.warnings).toEqual([]);
    expect(offline.failed).toEqual(['musicbrainz']);
    expect(offline.candidates.some((c) => c.source === 'musicbrainz')).toBe(false);

    const html = await searchCovers(DDF_12, { ...opts, fetchFn: mockFetch({ deezer: async () => new Response('<html>Gesperrt</html>', { status: 200 }) }) });
    expect(html.warnings).toEqual([]);
    expect(html.failed).toEqual(['deezer']);
    expect(html.candidates[0].id).toBe('itunes:1440729154');
  });

  it('says what went wrong only when no service answers', async () => {
    const down: FetchFn = async () => Promise.reject(new TypeError('NetworkError when attempting to fetch resource.'));
    const result = await searchCovers(DDF_12, { fetchFn: mockFetch({ itunes: down, deezer: down, musicbrainz: down }), limiters: quick() });
    expect(result.candidates).toEqual([]);
    expect(result.failed).toEqual(['itunes', 'deezer', 'musicbrainz']);
    expect(result.warnings).toEqual([
      'Die Suche bei iTunes hat nicht geklappt. Prüfe die Internetverbindung. Blockiert vielleicht ein Filter? Dann gib dort itunes.apple.com, is1-ssl.mzstatic.com, is2-ssl.mzstatic.com, is3-ssl.mzstatic.com, is4-ssl.mzstatic.com, is5-ssl.mzstatic.com frei.',
      'Die Suche bei Deezer hat nicht geklappt. Prüfe die Internetverbindung. Blockiert vielleicht ein Filter? Dann gib dort api.deezer.com, cdn-images.dzcdn.net, e-cdns-images.dzcdn.net frei.',
      'Die Suche bei MusicBrainz hat nicht geklappt. Prüfe die Internetverbindung. Blockiert vielleicht ein Filter? Dann gib dort musicbrainz.org frei.',
    ]);

    const opts = { limiters: quick(), cache: false, retries: 0 };
    const busy = await searchCovers(DDF_12, { ...opts, fetchFn: mockFetch({ itunes: async () => new Response('', { status: 503 }), deezer: async () => new Response('', { status: 429 }), musicbrainz: async () => new Response('', { status: 500 }) }) });
    expect(busy.warnings).toEqual([
      'iTunes ist gerade ausgelastet. Warte ein paar Minuten und suche noch einmal.',
      'Deezer ist gerade ausgelastet. Warte ein paar Minuten und suche noch einmal.',
      'MusicBrainz hat mit einem Fehler geantwortet (500). Versuche es später noch einmal.',
    ]);

    const odd = await searchCovers(DDF_12, {
      ...opts,
      sources: ['itunes', 'musicbrainz'],
      fetchFn: mockFetch({ itunes: async () => new Response('<html>Wartung</html>', { status: 200 }), musicbrainz: async () => jsonResponse({ error: 'Invalid query' }) }),
    });
    expect(odd.warnings).toEqual([
      'iTunes hat eine unerwartete Antwort geschickt. Versuche es später noch einmal.',
      'MusicBrainz hat eine unerwartete Antwort geschickt. Versuche es später noch einmal.',
    ]);
  });

  it('gives up on a service that does not answer in time', async () => {
    const hang: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    const result = await searchCovers(DDF_12, { fetchFn: mockFetch({ musicbrainz: hang }), limiters: quick(), timeoutMs: 20 });
    expect(result.warnings).toEqual([]);
    expect(result.failed).toEqual(['musicbrainz']);
    expect(result.candidates.length).toBeGreaterThan(0);

    const alone = await searchCovers(DDF_12, { fetchFn: mockFetch({ musicbrainz: hang }), limiters: quick(), timeoutMs: 20, sources: ['musicbrainz'], cache: false });
    expect(alone.warnings).toEqual(['MusicBrainz antwortet gerade nicht. Blockiert vielleicht ein Filter? Dann gib dort musicbrainz.org frei. Sonst versuche es später noch einmal.']);
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    const hang: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    const search = searchCovers(DDF_12, { fetchFn: mockFetch({ itunes: hang, deezer: hang, musicbrainz: hang }), limiters: quick(), signal: controller.signal });
    controller.abort();
    await expect(search).rejects.toMatchObject({ name: 'AbortError' });
    await expect(searchCovers(DDF_12, { fetchFn: mockFetch(), signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    // Also while MusicBrainz waits for the others in "rest" mode.
    const later = new AbortController();
    const rest = searchCovers(DDF_12, { fetchFn: mockFetch({ itunes: hang, deezer: hang }), limiters: quick(), signal: later.signal, musicBrainz: 'rest' });
    later.abort();
    await expect(rest).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('shows the hits of the first services while another is still searching', async () => {
    let answerMusicBrainz: (r: Response) => void = () => undefined;
    const slow: FetchFn = () => new Promise((resolve) => (answerMusicBrainz = resolve));
    const progress: { ids: string[]; warnings: string[] }[] = [];
    const search = searchCovers(DDF_12, {
      fetchFn: mockFetch({ musicbrainz: slow }),
      limiters: quick(),
      onProgress: (partial) => progress.push({ ids: partial.candidates.map((c) => c.id), warnings: partial.warnings }),
    });
    await vi.waitFor(() => expect(progress).toHaveLength(2));
    // iTunes and Deezer so far, already ranked; MusicBrainz is still open.
    expect(progress[1].warnings).toEqual([]);
    expect(progress[1].ids).toEqual(['itunes:1440729154', 'itunes:1441100045', 'itunes:1442368873', 'itunes:1440806591']);
    answerMusicBrainz(jsonResponse(MUSICBRAINZ_DDF));
    const result = await search;
    expect(progress).toHaveLength(2);
    expect(result.candidates.map((c) => c.source)).toContain('musicbrainz');
    expect(result.candidates[0].id).toBe('itunes:1440729154');
  });

  it('asks MusicBrainz only for what iTunes and Deezer did not find, in "rest" mode', async () => {
    const fetchFn = mockFetch();
    const found = await searchCovers(DDF_12, { fetchFn, limiters: quick(), musicBrainz: 'rest' });
    expect(found.asked).toEqual(['itunes', 'deezer']);
    expect(fetchFn.mock.calls.map(([url]) => url).some((u) => u.includes('musicbrainz'))).toBe(false);
    expect(found.candidates[0].id).toBe('itunes:1440729154');

    const progress: CoverSource[][] = [];
    const notEnough = await searchCovers(DDF_12, {
      fetchFn: mockFetch(),
      limiters: quick(),
      musicBrainz: 'rest',
      enough: () => false,
      onProgress: (p) => progress.push([...new Set(p.candidates.map((c) => c.source))]),
    });
    expect(notEnough.asked).toEqual(['itunes', 'deezer', 'musicbrainz']);
    // The hits of the fast two show while MusicBrainz searches (Deezer's are the same albums as iTunes').
    expect(progress.at(-1)).toEqual(['itunes']);
    expect(progress).toHaveLength(2);
  });

  it('frees the turn of a service that is not needed any more', async () => {
    // Deezer's queue is full: its turn would only come after a long wait.
    const stuck: Limiter = {
      wait: (signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    };
    const fetchFn = mockFetch();
    const r = await searchCovers(DDF_12, { fetchFn, limiters: { ...quick(), deezer: stuck }, musicBrainz: 'rest' });
    expect(r.asked).toEqual(['itunes']);
    expect(r.failed).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('lets MusicBrainz in at once when a fast service did not answer the last times', async () => {
    noteUnreachable('deezer');
    noteUnreachable('deezer');
    const fetchFn = mockFetch();
    const r = await searchCovers(DDF_12, { fetchFn, limiters: quick(), musicBrainz: 'rest' });
    const urls = fetchFn.mock.calls.map(([url]) => url);
    expect(urls.some((u) => u.includes('deezer'))).toBe(false);
    expect(urls.some((u) => u.includes('musicbrainz'))).toBe(true);
    expect(r.failed).toEqual(['deezer']);
    expect(r.warnings).toEqual([]);
  });

  it('asks again without the artist when the artist tag finds nothing', async () => {
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      const term = new URL(url).searchParams.get('term') ?? '';
      return jsonResponse(term.startsWith('Track 1') ? { resultCount: 0, results: [] } : ITUNES_DDF);
    });
    const r = await searchCovers({ artist: 'Track 1', album: 'Die drei ??? Folge 12' }, { fetchFn, limiters: quick(), sources: ['itunes'] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(new URL(fetchFn.mock.calls[1][0]).searchParams.get('term')).toBe('Die drei ??? Folge 12');
    expect(r.candidates[0].id).toBe('itunes:1440729154');
  });

  it('reuses an answer given a little earlier', async () => {
    const fetchFn = mockFetch();
    await searchCovers(DDF_12, { fetchFn, limiters: quick() });
    await searchCovers(DDF_12, { fetchFn, limiters: quick() });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await searchCovers(DDF_12, { fetchFn, limiters: quick(), cache: false });
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('needs a search text and can ask a single service', async () => {
    const fetchFn = mockFetch();
    expect(await searchCovers({ artist: '  ', query: '' }, { fetchFn })).toEqual({
      candidates: [],
      warnings: ['Gib einen Namen ein, zum Beispiel „Die drei ??? Folge 12“.'],
    });
    expect(fetchFn).not.toHaveBeenCalled();
    const onlyItunes = await searchCovers(DDF_12, { fetchFn, sources: ['itunes'], limit: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onlyItunes.candidates).toHaveLength(2);
    expect(onlyItunes.candidates[0].title).toBe('Folge 12: Der seltsame Wecker');
  });
});

describe('RateLimiter', () => {
  it('spaces requests one interval apart, also for concurrent callers', async () => {
    let now = 10_000;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(1100, () => now, async (ms) => {
      sleeps.push(ms);
    });
    await Promise.all([limiter.wait(), limiter.wait(), limiter.wait()]);
    expect(sleeps).toEqual([1100, 2200]);
    now += 10_000;
    await limiter.wait();
    expect(sleeps).toEqual([1100, 2200]);
    now += 300;
    await limiter.wait();
    expect(sleeps).toEqual([1100, 2200, 800]);
  });

  it('can be aborted while waiting', async () => {
    const limiter = new RateLimiter(60_000);
    await limiter.wait();
    const controller = new AbortController();
    const waiting = limiter.wait(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(limiter.wait(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('gives the slot of an abandoned search back, unless someone queued behind it', async () => {
    const sleeps: number[] = [];
    // Waits without a signal end at once; waits with one last until it aborts.
    const sleep = (ms: number, signal?: AbortSignal) => {
      sleeps.push(ms);
      return new Promise<void>((resolve, reject) => {
        if (!signal) return resolve();
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    };
    const limiter = new RateLimiter(1100, () => 10_000, sleep);
    await limiter.wait();
    const abandoned = new AbortController();
    const first = limiter.wait(abandoned.signal);
    abandoned.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    // The next search gets the freed slot instead of waiting one more second.
    await limiter.wait();
    expect(sleeps).toEqual([1100, 1100]);

    const second = new AbortController();
    const queued = limiter.wait(second.signal);
    await limiter.wait();
    second.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await limiter.wait();
    expect(sleeps).toEqual([1100, 1100, 2200, 3300, 4400]);
  });
});

describe('downloadCoverImage', () => {
  const candidate = {
    fullUrl: 'https://img.example/1200.jpg',
    mediumUrl: 'https://img.example/600.jpg',
    thumbUrl: 'https://img.example/250.jpg',
  };
  const picture = (bytes: Uint8Array) => new Response(new Blob([Uint8Array.from(bytes)]), { status: 200 });
  const hang: FetchFn = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });

  it('loads the largest size and tells the type from the bytes', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => picture(tinyPng()));
    const blob = await downloadCoverImage(candidate, { fetchFn });
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(tinyPng());
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe(candidate.fullUrl);
    expect(fetchFn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to smaller sizes when the server refuses or sends no picture', async () => {
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      if (url === candidate.fullUrl) return new Response('', { status: 404 });
      if (url === candidate.mediumUrl) return new Response('<html>Nicht da</html>', { status: 200 });
      return picture(tinyJpeg());
    });
    const blob = await downloadCoverImage(candidate, { fetchFn });
    expect(blob.type).toBe('image/jpeg');
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([candidate.fullUrl, candidate.mediumUrl, candidate.thumbUrl]);
  });

  it('moves on when a size does not answer in time', async () => {
    const fetchFn = vi.fn<FetchFn>((url, init) => (url === candidate.fullUrl ? hang(url, init) : Promise.resolve(picture(tinyJpeg()))));
    const blob = await downloadCoverImage(candidate, { fetchFn, timeoutMs: 20 });
    expect(blob.type).toBe('image/jpeg');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('explains in German what to do when no size can be loaded', async () => {
    await expect(downloadCoverImage(candidate, { fetchFn: async () => new Response('', { status: 403 }) })).rejects.toThrow(
      'Der Server gibt das Bild nicht heraus. Speichere es selbst auf deinem Computer und wähle es dann unter „Eigenes Bild“ aus.',
    );
    await expect(downloadCoverImage(candidate, { fetchFn: hang, timeoutMs: 10 })).rejects.toThrow(
      'Der Server antwortet gerade nicht. Blockiert vielleicht ein Filter? Versuche es gleich noch einmal oder nimm ein anderes Bild.',
    );
  });

  it('stops at once when the caller aborts, without trying other sizes', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<FetchFn>(hang);
    const loading = downloadCoverImage(candidate, { fetchFn, signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await expect(downloadCoverImage(candidate, { fetchFn, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('covers from files', () => {
  it('picks the cover image of a folder', () => {
    expect(pickFolderImage(['01.mp3', 'Folder.jpg', 'cover.png', 'AlbumArtSmall.jpg'])).toBe('cover.png');
    expect(pickFolderImage(['cover.png', 'Cover.JPG'])).toBe('Cover.JPG');
    expect(pickFolderImage(['AlbumArtSmall.jpg', 'AlbumArt_{7A3F}_Large.jpg', 'AlbumArt_{7A3F}_Small.jpg'])).toBe('AlbumArt_{7A3F}_Large.jpg');
    expect(pickFolderImage(['._cover.jpg', 'back.jpg', 'front.jpeg'])).toBe('front.jpeg');
    expect(pickFolderImage(['CD1/cover.jpg', 'cover.jpg'])).toBe('cover.jpg');
    expect(pickFolderImage(['Scans/Cover (Rückseite).jpg', 'Scans/Cover vorne.jpg'])).toBe('Scans/Cover vorne.jpg');
    expect(pickFolderImage(['scan001.jpg', '01.mp3'])).toBe('scan001.jpg');
    expect(pickFolderImage(['a.jpg', 'b.jpg'])).toBeNull();
    expect(pickFolderImage(['booklet.jpg', 'notes.txt'])).toBeNull();
    expect(pickFolderImage([])).toBeNull();
  });

  /** A short MP3: ID3v2.3 tag with an APIC frame, then three silent MPEG-1 Layer III frames. */
  function mp3WithCover(picture: Uint8Array | null): Blob {
    const enc = new TextEncoder();
    const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    const syncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
    const frames: number[] = [];
    const title = [0, ...enc.encode('Der seltsame Wecker')];
    frames.push(...enc.encode('TIT2'), ...u32(title.length), 0, 0, ...title);
    if (picture) {
      const body = [0, ...enc.encode('image/jpeg'), 0, 3, ...enc.encode('Cover'), 0, ...picture];
      frames.push(...enc.encode('APIC'), ...u32(body.length), 0, 0, ...body);
    }
    const tag = [...enc.encode('ID3'), 3, 0, 0, ...syncsafe(frames.length), ...frames];
    const audio = new Uint8Array(417 * 3);
    for (let i = 0; i < 3; i++) audio.set([0xff, 0xfb, 0x90, 0x64], i * 417);
    return new Blob([Uint8Array.from(tag), audio], { type: 'audio/mpeg' });
  }

  it('reads the front cover embedded in an MP3', async () => {
    const cover = await embeddedCover(mp3WithCover(tinyJpeg()));
    expect(cover).not.toBeNull();
    expect(cover?.type).toBe('image/jpeg');
    expect(new Uint8Array(await cover!.arrayBuffer())).toEqual(tinyJpeg());
  });

  it('returns null without a cover or for files it cannot read', async () => {
    expect(await embeddedCover(mp3WithCover(null))).toBeNull();
    expect(await embeddedCover(new Blob([tinyPng()], { type: 'image/png' }))).toBeNull();
    expect(await embeddedCover(new Blob(['kein Audio'], { type: 'text/plain' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cassette covers

/** Release search answer in the documented JSON shape (ws/2/release?query=…&fmt=json), shortened. */
const MUSICBRAINZ_DDF_MC = {
  created: '2026-10-09T08:01:12.004Z',
  count: 6,
  offset: 0,
  releases: [
    {
      id: '1a2b3c4d-0000-4000-8000-000000000001',
      score: 100,
      title: 'Der seltsame Wecker',
      status: 'Official',
      'artist-credit': [{ name: 'Die drei ???', artist: { id: '19a0f7e5-6a2a-4c6c-8b3f-3e3a9a33f7c2', name: 'Die drei ???' } }],
      'release-group': { id: 'b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12', 'primary-type': 'Album', 'secondary-types': ['Audio drama'] },
      date: '1980',
      country: 'DE',
      'label-info': [{ 'catalog-number': '115 512.2', label: { name: 'Europa' } }],
      'track-count': 2,
      media: [{ format: 'Cassette', 'disc-count': 0, 'track-count': 2 }],
    },
    {
      // A later cassette of the same album, often with a new inlay: shown on its own.
      id: '1a2b3c4d-0000-4000-8000-000000000002',
      score: 98,
      title: 'Der seltsame Wecker',
      'artist-credit': [{ name: 'Die drei ???' }],
      'release-group': { id: 'b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12' },
      date: '1993',
      media: [{ format: 'Cassette', 'track-count': 2 }],
    },
    {
      // A CD the search brought along anyway: left out.
      id: '1a2b3c4d-0000-4000-8000-000000000003',
      score: 90,
      title: 'Der seltsame Wecker',
      'artist-credit': [{ name: 'Die drei ???' }],
      'release-group': { id: 'b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12' },
      date: '2001',
      media: [{ format: 'CD', 'track-count': 9 }],
    },
    {
      id: '1a2b3c4d-0000-4000-8000-000000000004',
      score: 97,
      title: 'Der seltsame Wecker',
      'artist-credit': [{ name: 'Die drei ???' }],
      'release-group': { id: 'b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12' },
      date: '1997',
      media: [{ format: 'Cassette' }],
    },
    {
      // A fourth cassette of the same album: three are plenty.
      id: '1a2b3c4d-0000-4000-8000-000000000005',
      score: 96,
      title: 'Der seltsame Wecker',
      'artist-credit': [{ name: 'Die drei ???' }],
      'release-group': { id: 'b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12' },
      date: '2003',
      media: [{ format: 'Cassette' }],
    },
    {
      // Media not listed: trusted to the query's format filter.
      id: '1a2b3c4d-0000-4000-8000-000000000006',
      score: 70,
      title: 'Der Super-Papagei',
      'artist-credit': [{ name: 'Die drei ???' }],
      'release-group': { id: 'aa11bb22-cc33-4d44-8e55-ff6677889900' },
      date: '1979',
    },
  ],
};

describe('cassette covers', () => {
  it('asks MusicBrainz for cassette editions only, and for more of them', () => {
    expect(buildMusicBrainzQuery({ artist: 'TKKG', album: 'Folge 125' }, 'cassette')).toBe('(artist:"TKKG" AND release:(folge 125)) AND format:cassette');
    expect(buildMusicBrainzQuery({ query: 'Bibi Blocksberg' }, 'cassette')).toBe('(release:"bibi blocksberg"^3 OR release:(bibi blocksberg) OR artist:(bibi blocksberg)) AND format:cassette');
    expect(buildMusicBrainzUrl({ query: 'Benjamin' }, 'cassette')).toBe(
      'https://musicbrainz.org/ws/2/release/?query=(release%3A(benjamin)%20OR%20artist%3A(benjamin))%20AND%20format%3Acassette&fmt=json&limit=50',
    );
    // Frank 2026-10-13: "Der" alone brought "Der Tod" among the Hotzenplotz cassettes.
    expect(buildMusicBrainzQuery({ query: 'Der Räuber Hotzenplotz' }, 'cassette')).toBe(
      '(release:"der räuber hotzenplotz"^3 OR release:(räuber hotzenplotz) OR artist:(räuber hotzenplotz)) AND format:cassette',
    );
    // CDs as before.
    expect(buildMusicBrainzQuery({ query: 'Benjamin' })).toBe('release:(benjamin) OR artist:(benjamin)');
  });

  it('takes the front cover of each cassette edition, not the album picture', () => {
    const list = parseMusicBrainzResults(MUSICBRAINZ_DDF_MC, 'cassette');
    expect(list.map((c) => c.edition)).toEqual([
      '1a2b3c4d-0000-4000-8000-000000000001',
      '1a2b3c4d-0000-4000-8000-000000000002',
      '1a2b3c4d-0000-4000-8000-000000000004',
      '1a2b3c4d-0000-4000-8000-000000000006',
    ]);
    expect(list[0]).toMatchObject({
      id: 'musicbrainz:1a2b3c4d-0000-4000-8000-000000000001',
      source: 'musicbrainz',
      year: 1980,
      thumbUrl: 'https://coverartarchive.org/release/1a2b3c4d-0000-4000-8000-000000000001/front-250',
      mediumUrl: 'https://coverartarchive.org/release/1a2b3c4d-0000-4000-8000-000000000001/front-500',
      fullUrl: 'https://coverartarchive.org/release/1a2b3c4d-0000-4000-8000-000000000001/front-1200',
    });
    // The same answer read for CDs: one hit per album, picture of the album.
    const cd = parseMusicBrainzResults(MUSICBRAINZ_DDF_MC);
    expect(cd).toHaveLength(2);
    expect(cd[0].thumbUrl).toBe('https://coverartarchive.org/release-group/b9bc1f52-5f3e-3a52-8b1d-6c8a2b1f0e12/front-250');
    expect(cd[0].edition).toBeUndefined();
  });

  it('puts the cassette editions first and keeps them apart, the CD covers after them', async () => {
    const fetchFn = mockFetch({ musicbrainz: async () => jsonResponse(MUSICBRAINZ_DDF_MC) });
    const result = await searchCovers({ query: 'Die drei ??? Der seltsame Wecker' }, { fetchFn, limiters: quick(), kind: 'cassette' });
    expect(result.warnings).toEqual([]);
    expect(result.notes).toBeUndefined();
    const mb = fetchFn.mock.calls.map(([url]) => url).filter((u) => u.includes('musicbrainz'));
    expect(mb).toHaveLength(1);
    expect(mb[0]).toContain('format%3Acassette');
    const tapes = result.candidates.filter((c) => c.source === 'musicbrainz');
    expect(tapes.filter((c) => c.title === 'Der seltsame Wecker').map((c) => c.year)).toEqual([1980, 1993, 1997]);
    // The cassettes first, then the CD covers as a fallback.
    const firstCd = result.candidates.findIndex((c) => c.source !== 'musicbrainz');
    expect(firstCd).toBe(tapes.length);
    // Tiles already on the screen are not merged either.
    expect(keepShownOrder(result.candidates.slice(0, 1), result.candidates)).toHaveLength(result.candidates.length);
  });

  it('learns the title of a numbered episode before it looks for cassettes', async () => {
    const fetchFn = mockFetch({ musicbrainz: async () => jsonResponse({ releases: [] }) });
    const result = await searchCovers(DDF_12, { fetchFn, limiters: quick(), kind: 'cassette' });
    const mb = decodeURIComponent(fetchFn.mock.calls.map(([url]) => url).find((u) => u.includes('musicbrainz'))!);
    expect(mb).toContain('artist:"Die drei ???" AND release:(der seltsame wecker)');
    // No cassette there: the CD covers, with a word why.
    expect(result.notes).toEqual([NO_CASSETTE_PHOTO]);
    expect(result.candidates[0].id).toBe('itunes:1440729154');
  });

  it('shows the CD covers with a note when MusicBrainz cannot be reached', async () => {
    const r = await searchCovers(DDF_12, {
      fetchFn: mockFetch({ musicbrainz: async () => new Response('', { status: 503 }) }),
      limiters: quick(),
      retries: 0,
      kind: 'cassette',
    });
    expect(r.warnings).toEqual([]);
    expect(r.notes).toEqual([NO_CASSETTE_SEARCH]);
    expect(r.candidates[0].id).toBe('itunes:1440729154');

    const only = await searchCovers(DDF_12, {
      fetchFn: mockFetch({ musicbrainz: async () => new Response('', { status: 503 }) }),
      limiters: quick(),
      retries: 0,
      cache: false,
      sources: ['musicbrainz'],
      kind: 'cassette',
    });
    expect(only.candidates).toEqual([]);
    expect(only.warnings).toEqual(['MusicBrainz ist gerade ausgelastet. Warte ein paar Minuten und suche noch einmal.']);
  });
});
