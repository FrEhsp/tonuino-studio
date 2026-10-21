/**
 * A whole album in one file (src/core/library/albumcut.ts, TODO 0.4 #52):
 * which shop album fits the file's length, cue sheets, and where the cuts
 * go once the pauses between the songs are known.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findPauses, snapCutsToPauses } from '../../src/core/audio/silence';
import {
  albumCutsOf,
  cueTracksFor,
  cutsForStarts,
  decodeCueText,
  nudgeCut,
  parseCue,
  SEARCH_SEC,
  startsFromLengths,
  wholeAlbumCandidate,
  wholeAlbumQueries,
  wholeAlbumQuery,
} from '../../src/core/library/albumcut';
import { estimateTrackCount, isSplit, type DraftTrack } from '../../src/core/library/grouping';
import { RateLimiter } from '../../src/core/stickers/coversearch';
import { lookupWholeAlbum, parseItunesTracks, parseMusicBrainzTracks, wholeAlbumFits } from '../../src/core/library/tracklookup';
import { memSource } from '../../src/platform/memory';

const fixture = (name: string) => new URL(`../fixtures/library/${name}`, import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(fixture(name), 'utf8')) as unknown;

/** The iTunes answers for "Lieder vom Apfelbaum" (12 songs, 31:12). */
const ITUNES_SEARCH = json('itunes-search-apfelbaum.json');
const ITUNES_LOOKUP = json('itunes-lookup-apfelbaum.json');
const MB_RELEASE = json('musicbrainz-release-apfelbaum.json');
const ALBUM = parseItunesTracks(ITUNES_LOOKUP)!;
const LENGTHS = ALBUM.tracks.map((t) => t.durationSec!);
const SUM = LENGTHS.reduce((a, b) => a + b, 0);

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

describe('a shop album that is the whole file', () => {
  it('fits when its songs add up to the file, within about a percent', () => {
    expect(SUM).toBeCloseTo(1872.2, 1);
    expect(wholeAlbumFits(SUM, ALBUM.tracks)).toBe(true);
    // A rip with two seconds of silence at each end, or cut a little short.
    expect(wholeAlbumFits(SUM + 4, ALBUM.tracks)).toBe(true);
    expect(wholeAlbumFits(SUM - 15, ALBUM.tracks)).toBe(true);
    // Half a minute off: another edition, or not this album.
    expect(wholeAlbumFits(SUM + 30, ALBUM.tracks)).toBe(false);
    // Short files have at least four seconds of room, long ones at most twenty.
    expect(wholeAlbumFits(604, [{ title: 'a', durationSec: 300 }, { title: 'b', durationSec: 300 }])).toBe(true);
    expect(wholeAlbumFits(4000 + 25, [{ title: 'a', durationSec: 2000 }, { title: 'b', durationSec: 2000 }])).toBe(false);
    // Every length must be known, and one song is no album.
    expect(wholeAlbumFits(SUM, [...ALBUM.tracks.slice(0, -1), { title: 'x' }])).toBe(false);
    expect(wholeAlbumFits(154.2, ALBUM.tracks.slice(0, 1))).toBe(false);
  });

  it('is searched by name with the artist from a file name like "Artist - Album"', () => {
    expect(wholeAlbumQuery('Die Apfelbaum-Band - Lieder vom Apfelbaum')).toEqual({ album: 'Lieder vom Apfelbaum', artist: 'Die Apfelbaum-Band' });
    expect(wholeAlbumQuery('Die Apfelbaum-Band – Lieder vom Apfelbaum')).toEqual({ album: 'Lieder vom Apfelbaum', artist: 'Die Apfelbaum-Band' });
    // An artist from the tags wins: the name stays whole.
    expect(wholeAlbumQuery('Bibi Blocksberg - Folge 3', 'Bibi Blocksberg')).toEqual({ album: 'Bibi Blocksberg - Folge 3', artist: 'Bibi Blocksberg' });
    expect(wholeAlbumQuery('Lieder vom Apfelbaum')).toEqual({ album: 'Lieder vom Apfelbaum' });
  });

  it('is searched by the folder\'s name and then by the file\'s, once each', () => {
    expect(wholeAlbumQueries('Apfelbaum', 'Die Apfelbaum-Band - Lieder vom Apfelbaum')).toEqual([{ album: 'Apfelbaum' }, { album: 'Lieder vom Apfelbaum', artist: 'Die Apfelbaum-Band' }]);
    expect(wholeAlbumQueries('Lieder vom Apfelbaum', 'lieder vom apfelbaum', 'Die Apfelbaum-Band')).toEqual([{ album: 'Lieder vom Apfelbaum', artist: 'Die Apfelbaum-Band' }]);
  });

  it('comes from iTunes whatever its number of songs, when the lengths add up', async () => {
    const { fetchFn, seen } = fakeFetch([
      [/itunes\.apple\.com\/search/, ITUNES_SEARCH],
      // Albums of that name in one request. Were the live album asked for too: 15 songs, longer, its lengths do not add up.
      [
        /itunes\.apple\.com\/lookup/,
        {
          results: [
            { wrapperType: 'collection', collectionId: 1500000001, collectionName: 'Lieder vom Apfelbaum (Live)' },
            ...Array.from({ length: 15 }, (_, i) => ({ wrapperType: 'track', collectionId: 1500000001, trackName: `Live ${i + 1}`, trackNumber: i + 1, trackTimeMillis: 180_000 })),
            ...(ITUNES_LOOKUP as { results: unknown[] }).results,
          ],
        },
      ],
    ]);
    const found = await lookupWholeAlbum({ album: 'Lieder vom Apfelbaum', artist: 'Die Apfelbaum-Band', totalSec: SUM + 1.3 }, { fetchFn, rateLimiter: noWait });
    expect(found?.source).toBe('iTunes');
    expect(found?.tracks).toHaveLength(12);
    expect(found?.tracks[4].title).toBe('Kleiner Käfer, wohin?');
    expect(seen.filter((u) => u.includes('lookup'))).toHaveLength(1);
    expect(seen.some((u) => u.includes('musicbrainz'))).toBe(false);
  });

  it('comes from MusicBrainz when iTunes cannot be reached, asked without a number of tracks', async () => {
    const { fetchFn, seen } = fakeFetch([
      [
        /itunes/,
        () => {
          throw new TypeError('Failed to fetch');
        },
      ],
      [/musicbrainz\.org\/ws\/2\/release\/\?query/, { releases: [{ id: '5f1c2e9a-8b7d-4c3e-9a21-0d4b6e7f8a90', title: 'Lieder vom Apfelbaum', 'track-count': 12 }] }],
      [/musicbrainz\.org\/ws\/2\/release\/5f1c/, MB_RELEASE],
    ]);
    const found = await lookupWholeAlbum({ album: 'Lieder vom Apfelbaum', totalSec: SUM }, { fetchFn, rateLimiter: noWait });
    expect(found?.source).toBe('MusicBrainz');
    expect(found?.artist).toBe('Die Apfelbaum-Band');
    const query = decodeURIComponent(seen.find((u) => u.includes('query='))!);
    expect(query).toContain('release:"Lieder vom Apfelbaum"');
    expect(query).not.toContain('tracks:');
  });

  it('is nothing when no album of that name is as long as the file', async () => {
    const { fetchFn } = fakeFetch([
      [/itunes\.apple\.com\/search/, ITUNES_SEARCH],
      [/lookup\?id=1622334455/, ITUNES_LOOKUP],
      [/musicbrainz\.org\/ws\/2\/release\/\?query/, { releases: [] }],
    ]);
    expect(await lookupWholeAlbum({ album: 'Lieder vom Apfelbaum', totalSec: SUM + 600 }, { fetchFn, rateLimiter: noWait })).toBeNull();
    expect(await lookupWholeAlbum({ album: '', totalSec: SUM }, { fetchFn, rateLimiter: noWait })).toBeNull();
  });

  it('gives the starts of its songs, stretched evenly to the file', () => {
    const starts = startsFromLengths(ALBUM.tracks, SUM);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeCloseTo(154.213, 3);
    expect(starts[11]).toBeCloseTo(SUM - 212.627, 3);
    // Ten seconds longer: every start a little later, the last one most.
    const longer = startsFromLengths(ALBUM.tracks, SUM + 10);
    expect(longer[1] - starts[1]).toBeCloseTo((10 * 154.213) / SUM, 3);
    expect(longer[11] - starts[11]).toBeGreaterThan(8.8);
    // MusicBrainz' lengths differ by a few milliseconds: the starts hardly move.
    const mb = startsFromLengths(parseMusicBrainzTracks(MB_RELEASE)!.tracks, SUM);
    mb.forEach((s, i) => expect(Math.abs(s - starts[i])).toBeLessThan(0.05));
  });
});

describe('cue sheets', () => {
  const text = decodeCueText(readFileSync(fixture('apfelbaum.cue')));

  it('reads an EAC cue sheet with byte order mark, pregaps and CRLF', () => {
    const sheet = parseCue(text)!;
    expect(sheet.title).toBe('Lieder vom Apfelbaum');
    expect(sheet.performer).toBe('Die Apfelbaum-Band');
    expect(sheet.files).toHaveLength(1);
    const [file] = sheet.files;
    expect(file.name).toBe('Die Apfelbaum-Band - Lieder vom Apfelbaum.wav');
    expect(file.tracks).toHaveLength(12);
    expect(file.tracks[4]).toMatchObject({ number: 5, title: 'Kleiner Käfer, wohin?', performer: 'Die Apfelbaum-Band' });
    // INDEX 01 counts, not the pregap (INDEX 00); frames are 1/75 s.
    expect(file.tracks[0].startSec).toBe(0);
    expect(file.tracks[1].startSec).toBeCloseTo(154.213, 1);
    expect(file.tracks[11].startSec).toBeCloseTo(SUM - 212.627, 1);
  });

  it('reads cue sheets in the old Windows code page and without quotes', () => {
    const latin1 = 'TITLE "Kinderlieder für draußen"\nFILE album.flac WAVE\n  TRACK 01 AUDIO\n    TITLE "Frühling"\n    INDEX 01 00:00:00\n  TRACK 2 AUDIO\n    TITLE Sommer\n    INDEX 01 02:10:37\n';
    const bytes = Uint8Array.from(latin1, (c) => c.charCodeAt(0));
    const sheet = parseCue(decodeCueText(bytes))!;
    expect(sheet.title).toBe('Kinderlieder für draußen');
    expect(sheet.files[0].name).toBe('album.flac');
    expect(sheet.files[0].tracks.map((t) => [t.title, t.startSec])).toEqual([
      ['Frühling', 0],
      ['Sommer', 130 + 37 / 75],
    ]);
  });

  it('describes a file by its name, also after the WAV became a FLAC', () => {
    const sheet = parseCue(text)!;
    expect(cueTracksFor(sheet, 'Die Apfelbaum-Band - Lieder vom Apfelbaum.flac')).toHaveLength(12);
    expect(cueTracksFor(sheet, 'Musik/Die Apfelbaum-Band - Lieder vom Apfelbaum.mp3')).toHaveLength(12);
    // Another name: only when the sheet and the file are alone in their folder.
    expect(cueTracksFor(sheet, 'CD1.flac')).toBeNull();
    expect(cueTracksFor(sheet, 'CD1.flac', { alone: true })).toHaveLength(12);
    // A sheet for a longer file does not describe this one.
    expect(cueTracksFor(sheet, 'CD1.flac', { alone: true, durationSec: 1500 })).toBeNull();
  });

  it('is no whole album when it has one track per file, or nothing usable', () => {
    const perFile = 'FILE "01.flac" WAVE\n TRACK 01 AUDIO\n  INDEX 01 00:00:00\nFILE "02.flac" WAVE\n TRACK 02 AUDIO\n  INDEX 01 00:00:00\n';
    const sheet = parseCue(perFile)!;
    expect(cueTracksFor(sheet, '01.flac')).toBeNull();
    expect(parseCue('REM nothing here\n')).toBeNull();
    expect(parseCue('')).toBeNull();
  });
});

/* ------------------------------------------------------------ the cuts */

const WS = 0.01;

/** Deterministic pseudo random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Song {
  sec: number;
  /** Silence after the song (seconds); 0 when it runs into the next. */
  gap: number;
  /** A quiet bridge inside the song: start (seconds into the song), length. */
  quiet?: [number, number];
  /** False for a song that runs into the next one without fading out. */
  fade?: boolean;
}

/**
 * Power envelope (10 ms windows) of a song album: music at about -14 LUFS
 * with beats and swells, a fade over the last two seconds of each song,
 * digital silence in the gaps, and a lead-in of silence before the first.
 */
function albumEnvelope(songs: Song[], leadSec: number, seed = 3): { power: Float32Array; boundaries: number[]; durationSec: number } {
  const rand = rng(seed);
  const parts: number[] = [];
  const push = (sec: number, db: (i: number) => number) => {
    const n = Math.round(sec / WS);
    for (let i = 0; i < n; i++) parts.push(10 ** ((db(i) + 0.691) / 10));
  };
  push(leadSec, () => -95 + rand() * 3);
  for (const s of songs) {
    push(s.sec, (i) => {
      const t = i * WS;
      if (s.quiet && t >= s.quiet[0] && t < s.quiet[0] + s.quiet[1]) return -42 + rand() * 4;
      const fade = s.fade === false ? 0 : Math.max(0, (t - (s.sec - 2)) / 2);
      return -14 + 4 * Math.sin((2 * Math.PI * i) / 50) + (rand() - 0.5) * 5 - 30 * fade * fade;
    });
    if (s.gap) push(s.gap, () => -95 + rand() * 3);
  }
  // The cut between two songs goes into the gap after the first: the boundary is the middle of it.
  let at = leadSec;
  const middles: number[] = [];
  for (const s of songs.slice(0, -1)) {
    at += s.sec;
    middles.push(at + s.gap / 2);
    at += s.gap;
  }
  return { power: Float32Array.from(parts), boundaries: middles, durationSec: parts.length * WS };
}

describe('cuts in the pauses between songs', () => {
  // The shop's lengths include the gap after each song, as CD track lengths do.
  const songs: Song[] = LENGTHS.map((len) => ({ sec: len - 1.6, gap: 1.6 }));
  songs[11].gap = 0;
  // Song 5 has a quiet bridge four seconds before its end; songs 8 and 9 run into each other.
  songs[4].quiet = [songs[4].sec - 6, 1.2];
  songs[7] = { sec: LENGTHS[7], gap: 0, fade: false };

  it('finds every gap, a rip with silence in front moving all of them the same', () => {
    const lead = 1.8;
    const { power, boundaries, durationSec } = albumEnvelope(songs, lead);
    const starts = startsFromLengths(ALBUM.tracks, durationSec);
    const cuts = cutsForStarts(starts, { power, windowSec: WS, durationSec }, SEARCH_SEC.shop);
    expect(cuts).toHaveLength(11);
    for (const [i, c] of cuts.entries()) {
      if (i === 7) continue; // no gap there, see below
      expect(c.kind).toBe('pause');
      expect(Math.abs(c.timeSec - boundaries[i])).toBeLessThan(0.6);
    }
    // Every cut later than the one before, and none moved by more than the search allows.
    for (let i = 1; i < cuts.length; i++) expect(cuts[i].timeSec).toBeGreaterThan(cuts[i - 1].timeSec);
    for (const c of cuts) expect(Math.abs(c.timeSec - c.expectedSec)).toBeLessThan(SEARCH_SEC.shop + lead);
  });

  it('cuts songs that run into each other at the quietest moment close by', () => {
    const { power, durationSec } = albumEnvelope(songs, 0);
    const starts = startsFromLengths(ALBUM.tracks, durationSec);
    const cut = cutsForStarts(starts, { power, windowSec: WS, durationSec }, SEARCH_SEC.shop)[7];
    expect(cut.kind).toBe('quietest');
    // No pause anywhere near: the quietest moment within half the search on each side.
    expect(Math.abs(cut.timeSec - cut.expectedSec)).toBeLessThan(SEARCH_SEC.shop / 2 + 0.01);
  });

  it('prefers the gap over a quiet bridge in a song that lies closer', () => {
    const { power, boundaries, durationSec } = albumEnvelope(songs, 0);
    const pauses = findPauses(power, WS, { minPauseSec: 0.3 });
    // The bridge in song 5 is a pause too, but shallow and far from silence.
    expect(pauses.some((p) => Math.abs(p.startSec - (boundaries[3] + 0.8 + songs[4].sec - 6)) < 0.5)).toBe(true);
    // The list puts the cut 3.5 s early, right at the bridge.
    const early = boundaries[4] - 3.5;
    const [cut] = snapCutsToPauses([early], pauses, { durationSec, searchSec: 6 });
    expect(cut.kind).toBe('pause');
    expect(Math.abs(cut.timeSec - boundaries[4])).toBeLessThan(0.6);
  });

  it('keeps the cue sheet\'s places when nothing is measured, and keeps cuts apart and inside the file', () => {
    const cuts = snapCutsToPauses([100, 101, 299], [], { durationSec: 300, minGapSec: 5 });
    expect(cuts.map((c) => [c.timeSec, c.kind])).toEqual([
      [100, 'exact'],
      [105, 'exact'],
      [295, 'exact'],
    ]);
  });
});

describe('looking at the cuts before they are made', () => {
  it('moves a cut by half a second, never past its neighbours or the ends', () => {
    expect(nudgeCut([10, 20, 30], 1, 0.5, 40)).toEqual([10, 20.5, 30]);
    expect(nudgeCut([10, 20, 30], 1, -15, 40)).toEqual([10, 11, 30]);
    expect(nudgeCut([10, 20, 30], 2, 50, 40)).toEqual([10, 20, 39]);
    expect(nudgeCut([10, 20, 30], 0, -50, 40)).toEqual([1, 20, 30]);
  });

  it('keeps titles and starts, with a name for an empty title', () => {
    expect(albumCutsOf('iTunes', ['Eins', ' ', 'Drei'], [120.5, 250])).toEqual({
      from: 'iTunes',
      tracks: [
        { title: 'Eins', startSec: 0 },
        { title: 'Titel 2', startSec: 120.5 },
        { title: 'Drei', startSec: 250 },
      ],
    });
  });
});

describe('an album cut at its tracks in the review', () => {
  const file = (sec: number): DraftTrack => ({ source: memSource('Lieder vom Apfelbaum.flac', new Uint8Array(4)), info: { durationSec: sec }, title: 'Lieder vom Apfelbaum' });

  it('is offered for one file of eight minutes or more', () => {
    expect(wholeAlbumCandidate([file(SUM)])).toBe(true);
    expect(wholeAlbumCandidate([file(7 * 60)])).toBe(false);
    expect(wholeAlbumCandidate([file(SUM), file(SUM)])).toBe(false);
  });

  it('becomes as many titles as the album has, also when the file is short', () => {
    const t = { ...file(12 * 60), albumCuts: albumCutsOf('iTunes', ['A', 'B', 'C'], [200, 400]) };
    const album = { tracks: [t], split: 'tracks' as const, splitMinutes: 5 };
    expect(isSplit(album, t)).toBe(true);
    expect(estimateTrackCount(album)).toBe(3);
    // "Nicht teilen" chosen, or the pauses: the cuts are kept but not used.
    expect(isSplit({ ...album, split: 'none' }, t)).toBe(false);
    expect(estimateTrackCount({ ...album, split: 'pauses' })).toBe(1);
    // A long file without a track list in the same album is cut at pauses.
    const long = file(45 * 60);
    expect(estimateTrackCount({ ...album, tracks: [t, long] })).toBe(3 + 9);
  });
});
