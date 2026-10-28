/**
 * Track names from iTunes and MusicBrainz for folders whose files carry none
 * (src/core/library/tracklookup.ts): only an album with as many tracks and
 * fitting lengths counts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetNet } from '../../src/core/covers/net';
import { RateLimiter } from '../../src/core/stickers/coversearch';
import { lookupAlbumTracks, parseItunesTracks, parseMusicBrainzTracks, sameAlbum, tracksFit } from '../../src/core/library/tracklookup';

// Each test its own answers: nothing kept from the one before, every service reachable.
beforeEach(() => resetNet());

const lengths = [66, 181, 125, 203];
const songs = ['Igel sucht den Mond', 'Der Mond im Wald', 'Hip-Hop-Hase', 'Gute Nacht, Igel'];

function itunesLookup(times = lengths) {
  return {
    resultCount: 5,
    results: [
      { wrapperType: 'collection', collectionId: 7, collectionName: 'Igel sucht den Mond (Musik-Hörspiel)', artistName: 'Igel', trackCount: 4 },
      // Out of order on purpose: the list sorts by disc and number.
      ...songs.map((s, i) => ({ wrapperType: 'track', kind: 'song', trackName: s, trackNumber: i + 1, discNumber: 1, trackTimeMillis: times[i] * 1000 })).reverse(),
    ],
  };
}

function fakeFetch(routes: [RegExp, unknown | (() => never)][]) {
  const seen: string[] = [];
  const fetchFn = async (url: string) => {
    seen.push(url);
    for (const [re, body] of routes) {
      if (re.test(url)) {
        if (typeof body === 'function') (body as () => never)();
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchFn, seen };
}

const noWait = new RateLimiter(0);

describe('track lists from shops', () => {
  it('fit when count and lengths agree', () => {
    const theirs = lengths.map((d, i) => ({ title: songs[i], durationSec: d + (i % 2 ? 1.5 : -1) }));
    expect(tracksFit(lengths, theirs)).toBe(true);
    expect(tracksFit([...lengths, 30], theirs)).toBe(false);
    // Another album with as many tracks: the lengths give it away.
    expect(tracksFit(lengths, [200, 70, 140, 90].map((d) => ({ title: 'x', durationSec: d })))).toBe(false);
    // Lengths unknown on one side: the count must do.
    expect(tracksFit([undefined, undefined, undefined, undefined], theirs)).toBe(true);
    expect(tracksFit([66, undefined, undefined, undefined], theirs)).toBe(false);
  });

  it('belong to the album when the names agree apart from noise and notes', () => {
    expect(sameAlbum('Somedownloader.Com - Igel Sucht Den Mond', 'Igel sucht den Mond (Musik-Hörspiel)')).toBe(true);
    expect(sameAlbum('Igel sucht den Mond', 'Igel sucht den Mond')).toBe(true);
    expect(sameAlbum('Igel', 'Igel sucht den Mond')).toBe(false);
    expect(sameAlbum('Sommerträume', 'Winterträume')).toBe(false);
  });

  it('are read from iTunes and MusicBrainz answers', () => {
    const it1 = parseItunesTracks(itunesLookup())!;
    expect(it1.source).toBe('iTunes');
    expect(it1.tracks.map((t) => t.title)).toEqual(songs);
    expect(it1.tracks[0].durationSec).toBe(66);
    const mb = parseMusicBrainzTracks({
      title: 'Igel sucht den Mond',
      'artist-credit': [{ name: 'Igel', joinphrase: ' & ' }, { name: 'Freunde' }],
      media: [
        { position: 2, tracks: [{ position: 1, title: songs[2], length: 125000 }, { position: 2, title: songs[3], length: null }] },
        { position: 1, tracks: [{ position: 2, title: songs[1], length: 181000 }, { position: 1, title: songs[0], length: 66000 }] },
      ],
    })!;
    expect(mb.tracks.map((t) => t.title)).toEqual(songs);
    expect(mb.tracks[3].durationSec).toBeUndefined();
    expect(mb.artist).toBe('Igel & Freunde');
  });

  it('come from iTunes when it has the album with as many tracks and fitting lengths', async () => {
    const { fetchFn, seen } = fakeFetch([
      [/itunes\.apple\.com\/search/, { results: [{ wrapperType: 'collection', collectionId: 3, collectionName: 'Igel sucht den Mond', trackCount: 12 }, { wrapperType: 'collection', collectionId: 7, collectionName: 'Igel sucht den Mond (Musik-Hörspiel)', trackCount: 4 }] }],
      [/itunes\.apple\.com\/lookup\?id=7/, itunesLookup()],
    ]);
    const found = await lookupAlbumTracks({ album: 'Somedownloader.Com - Igel Sucht Den Mond', durations: lengths }, { fetchFn, rateLimiter: noWait });
    expect(found?.source).toBe('iTunes');
    expect(found?.tracks.map((t) => t.title)).toEqual(songs);
    // The downloader's name never goes to the shop.
    expect(seen[0]).not.toMatch(/somedownloader/i);
    expect(seen.some((u) => /lookup\?id=3/.test(u))).toBe(false);
  });

  it('ask MusicBrainz when iTunes has nothing that fits', async () => {
    const { fetchFn, seen } = fakeFetch([
      [/itunes\.apple\.com\/search/, { results: [{ wrapperType: 'collection', collectionId: 7, collectionName: 'Igel sucht den Mond', trackCount: 4 }] }],
      [/itunes\.apple\.com\/lookup/, itunesLookup([200, 70, 140, 90])],
      [/musicbrainz\.org\/ws\/2\/release\/\?query/, { releases: [{ id: 'abc', title: 'Igel sucht den Mond', 'track-count': 4 }] }],
      [/musicbrainz\.org\/ws\/2\/release\/abc/, { title: 'Igel sucht den Mond', media: [{ position: 1, tracks: songs.map((s, i) => ({ position: i + 1, title: s, length: lengths[i] * 1000 })) }] }],
    ]);
    const found = await lookupAlbumTracks({ album: 'Igel Sucht Den Mond', artist: 'Igel', durations: lengths }, { fetchFn, rateLimiter: noWait });
    expect(found?.source).toBe('MusicBrainz');
    expect(decodeURIComponent(seen.find((u) => /musicbrainz.*query/.test(u))!)).toContain('tracks:4');
  });

  it('give nothing when no album fits, and an error only when no service answered', async () => {
    const none = fakeFetch([
      [/itunes/, { results: [] }],
      [/musicbrainz/, { releases: [] }],
    ]);
    expect(await lookupAlbumTracks({ album: 'Sommerträume', durations: lengths }, { fetchFn: none.fetchFn, rateLimiter: noWait })).toBeNull();
    const offline = { fetchFn: async () => Promise.reject(new TypeError('Failed to fetch')), rateLimiter: noWait };
    // The same search a little later comes from memory, even offline.
    expect(await lookupAlbumTracks({ album: 'Sommerträume', durations: lengths }, offline)).toBeNull();
    resetNet();
    await expect(lookupAlbumTracks({ album: 'Sommerträume', durations: lengths }, offline)).rejects.toThrow();
    expect(await lookupAlbumTracks({ album: '', durations: lengths }, offline)).toBeNull();
  });
});

describe('names from a match', () => {
  it('go only to tracks without a real title, by position', async () => {
    const { titlesFromMatch } = await import('../../src/core/library/tracklookup');
    const rows = [
      { file: '001.mp3', title: 'Titel 1', untitled: true },
      { file: '002.mp3', title: 'Selbst getippt' },
      { file: '003.mp3', title: 'Hip Hop Hase', titleAuto: true },
      { file: '004.mp3', title: 'Titel 4', untitled: true },
    ];
    const found = { tracks: songs.map((title) => ({ title })) };
    expect(titlesFromMatch(rows, found)).toEqual([
      { file: '001.mp3', title: songs[0] },
      { file: '003.mp3', title: songs[2] },
      { file: '004.mp3', title: songs[3] },
    ]);
    expect(titlesFromMatch(rows.slice(1), found)).toEqual([]);
  });
});
