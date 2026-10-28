import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNet, type Limiter } from '../../src/core/covers/net';
import { searchOptionsFor } from '../../src/core/covers/autofind';
import {
  buildFolderQuery,
  chosenCandidate,
  CONFIDENT_SCORE,
  coverlessFolders,
  dropCandidate,
  inPool,
  isConfident,
  isSearchable,
  BUSY_MESSAGE,
  namesOneAlbum,
  isUnreachable,
  lookupFailureMessage,
  MAX_CHOICES,
  needsLook,
  newRows,
  pickCandidate,
  pickNone,
  pickOwn,
  reviewSummary,
  rowsToSave,
  runBulkSearch,
  searchProgress,
  setChecked,
  UNREACHABLE_MESSAGE,
  UnreachableError,
  withResult,
  type BulkRow,
  type BulkTarget,
} from '../../src/core/stickers/bulkcover';
import { RateLimiter, rankCandidates, searchCovers, type CoverCandidate, type CoverSearchResult } from '../../src/core/stickers/coversearch';
import { newCatalog, parseCatalog, serializeCatalog, type Catalog, type CatalogFolder } from '../../src/core/tonuino/catalog';
import { loadCovers, packCovers } from '../../src/core/tonuino/covers';
import type { SdFolder } from '../../src/core/tonuino/sd';
import { boot, card, closeCard, coverUrlFor, openVolume, setCovers } from '../../src/app/state';
import { writeGuard } from '../../src/app/writeguard';
import { searchHelp } from '../../src/features/help/search';
import { blockTexts, findSection, plainText, resolveHelp } from '../../src/features/help/topics';
import { memDir } from '../../src/platform/memory';
import type { Dir, Platform, Volume } from '../../src/platform/types';

// ---------------------------------------------------------------------------
// Helpers

const entry = (title: string, more: Partial<CatalogFolder> = {}): CatalogFolder => ({ title, tracks: [], addedAt: 1, updatedAt: 1, ...more });

const sdFolder = (n: number): SdFolder =>
  ({ number: n, name: String(n).padStart(2, '0'), tracks: [], wrongDigits: [], unnumbered: [], others: [], junk: [], subfolders: [], empty: [] }) as unknown as SdFolder;

const candidate = (title: string, artist: string, source: CoverCandidate['source'] = 'itunes', id = `${source}:${title}`): CoverCandidate => ({
  id,
  source,
  title,
  artist,
  thumbUrl: `https://example.org/${encodeURIComponent(id)}-250.jpg`,
  fullUrl: `https://example.org/${encodeURIComponent(id)}-1200.jpg`,
  score: 0,
});

/** The best hit for a folder name, ranked as the search ranks it. */
function best(query: string, ...candidates: CoverCandidate[]): CoverCandidate {
  return rankCandidates({ query }, candidates)[0];
}

const target = (folder: number, query: string, title = query, specific = !!query): BulkTarget => ({ folder, title, query, specific });
/** A folder name that points at one album, as the confidence check sees it. */
const named = (query: string) => ({ query, specific: true });
const result = (...candidates: CoverCandidate[]): CoverSearchResult => ({ candidates, warnings: [] });
const nobody: CoverSearchResult = { candidates: [], warnings: ['iTunes antwortet nicht.', 'MusicBrainz antwortet nicht.'] };
const noWait = () => new RateLimiter(0);
/** Every service's turn at once. */
const instant = (): Limiter => ({ wait: async (signal) => void signal?.throwIfAborted() });
const quick = () => ({ itunes: instant(), deezer: instant(), musicbrainz: instant() });

beforeEach(() => resetNet());

// ---------------------------------------------------------------------------

describe('which folders', () => {
  const scan = { folders: [1, 2, 3, 4, 5, 6].map(sdFolder) };
  const catalog = {
    folders: {
      '01': entry('Folge 125: Feuermond', { series: 'Die drei ???' }),
      '02': entry('Hexen gibt es doch', { artist: 'Bibi Blocksberg', cover: '02.jpg' }),
      // The catalog names a picture the zip does not have (zip lost): counts as no cover.
      '03': entry('Die Weihnachtsbäckerei', { artist: 'Rolf Zuckowski', cover: '03.jpg' }),
      // 04: copied with another program, unknown to the app.
      '05': entry('Ordner 05'),
      '06': entry('Benjamin Blümchen als Wetterelefant'),
      // Not on the card any more.
      '07': entry('Pumuckl'),
    },
  };
  const covers = new Set(['02.jpg']);

  it('lists known folders without a cover, in folder order, and never one that has a cover', () => {
    const list = coverlessFolders(scan, catalog, covers);
    expect(list.map((t) => t.folder)).toEqual([1, 3, 5, 6]);
    expect(list[0]).toEqual({
      folder: 1,
      title: 'Folge 125: Feuermond',
      detail: 'Die drei ???',
      query: 'Die drei ??? Folge 125: Feuermond',
      specific: true,
      // The services get the series as artist and the title apart.
      search: { artist: 'Die drei ???', album: 'Folge 125: Feuermond' },
    });
    expect(list[1]).toMatchObject({ folder: 3, detail: 'Rolf Zuckowski', query: 'Rolf Zuckowski Die Weihnachtsbäckerei' });
    // Without a real name there is nothing to search for.
    expect(list[2]).toEqual({ folder: 5, title: 'Ordner 05', detail: undefined, query: '', specific: false });
  });

  it('can be limited to some folders, e.g. those picked for printing', () => {
    expect(coverlessFolders(scan, catalog, covers, [2, 6]).map((t) => t.folder)).toEqual([6]);
    expect(coverlessFolders(scan, null, covers)).toEqual([]);
  });
});

describe('search text', () => {
  it('puts the series or the artist before the title, like the folder page', () => {
    expect(buildFolderQuery(entry('Folge 125: Feuermond', { series: 'Die drei ???', episode: 125 }))).toBe('Die drei ??? Folge 125: Feuermond');
    expect(buildFolderQuery(entry('Feuermond', { series: 'Die drei ???', episode: 125 }))).toBe('Die drei ??? Feuermond Folge 125');
    expect(buildFolderQuery(entry('Die drei ??? 125 Feuermond', { series: 'Die drei ???', episode: 125 }))).toBe('Die drei ??? 125 Feuermond');
    expect(buildFolderQuery(entry('Hexen gibt es doch', { artist: 'Bibi Blocksberg' }))).toBe('Bibi Blocksberg Hexen gibt es doch');
    // The series wins over a narrator in the artist tag.
    expect(buildFolderQuery(entry('Der seltsame Wecker', { series: 'Die drei ???', artist: 'Oliver Rohrbeck' }))).toBe('Die drei ??? Der seltsame Wecker');
  });

  it('does not repeat what the title says already', () => {
    expect(buildFolderQuery(entry('Bibi Blocksberg – Hexen gibt es doch', { artist: 'Bibi Blocksberg' }))).toBe('Bibi Blocksberg – Hexen gibt es doch');
    expect(buildFolderQuery(entry('Die 3 ??? und der Super-Papagei', { series: 'Die drei ???' }))).toBe('Die 3 ??? und der Super-Papagei');
  });

  it('leaves out artist tags that name no one', () => {
    expect(buildFolderQuery(entry('Kinderlieder zum Mitsingen', { artist: 'Various Artists' }))).toBe('Kinderlieder zum Mitsingen');
    expect(buildFolderQuery(entry('Kinderlieder zum Mitsingen', { artist: 'Verschiedene Interpreten' }))).toBe('Kinderlieder zum Mitsingen');
  });

  it('does not search for names that say nothing', () => {
    expect(buildFolderQuery(entry('Ordner 05'))).toBe('');
    expect(buildFolderQuery(entry('Folge 1'))).toBe('');
    expect(buildFolderQuery(entry('CD 2 - Teil 3'))).toBe('');
    expect(buildFolderQuery(entry('  '))).toBe('');
    // With a series it is a real name again.
    expect(buildFolderQuery(entry('Folge 1', { artist: 'Benjamin Blümchen' }))).toBe('Benjamin Blümchen Folge 1');
    expect(buildFolderQuery(entry('Ordner 05', { series: 'TKKG', episode: 7 }))).toBe('TKKG Folge 7');
    expect(isSearchable('Hörspiel Folge 3')).toBe(false);
    expect(isSearchable('Pumuckl')).toBe(true);
  });
});

describe('good enough to take without a look', () => {
  it('takes the right episode of the right series', () => {
    const q = 'Die drei ??? Folge 125 Feuermond';
    const hit = best(q, candidate('Folge 125: Feuermond (Teil 1 - Das Rätsel der Meister)', 'Die drei ???'), candidate('Folge 12: Der seltsame Wecker', 'Die drei ???'));
    expect(hit.title).toMatch(/^Folge 125/);
    expect(hit.score).toBeGreaterThan(0.85);
    expect(isConfident(named(q), hit)).toBe(true);
  });

  it('takes the right album of an artist', () => {
    const q = 'Rolf Zuckowski Die Weihnachtsbäckerei';
    const hit = best(q, candidate('Die Weihnachtsbäckerei', 'Rolf Zuckowski'), candidate('Rolfs Vogelhochzeit', 'Rolf Zuckowski'));
    expect(hit.title).toBe('Die Weihnachtsbäckerei');
    expect(isConfident(named(q), hit)).toBe(true);
    const bibi = 'Bibi Blocksberg Hexen gibt es doch';
    expect(isConfident(named(bibi), best(bibi, candidate('Folge 3: Hexen gibt es doch', 'Bibi Blocksberg')))).toBe(true);
  });

  it('asks for a look when only the series matches and the episode does not', () => {
    const q = 'Benjamin Blümchen Folge 3';
    const hit = best(q, candidate('Folge 4: ...als Koch', 'Benjamin Blümchen'), candidate('Folge 2: ...als Lokomotivführer', 'Benjamin Blümchen'));
    expect(hit.score).toBeLessThan(CONFIDENT_SCORE);
    expect(isConfident(named(q), hit)).toBe(false);
    // A hit without any number, for a name with one, is not good enough either.
    const ddf = 'Die drei ??? Folge 12';
    expect(isConfident(named(ddf), best(ddf, candidate('Der seltsame Wecker', 'Die drei ???', 'musicbrainz')))).toBe(false);
    // Even a high score needs the episode number.
    expect(isConfident(named(ddf), { title: 'Folge 13: Der lachende Schatten', score: 0.9 })).toBe(false);
  });

  it('asks for a look when a hit shares just a word with the name', () => {
    const songs = 'Mamas Lieblingslieder';
    expect(isConfident(named(songs), best(songs, candidate('Lieblingslieder für Kinder', 'Various Artists')))).toBe(false);
    const pumuckl = 'Pumuckl und der Schmutzfink';
    expect(isConfident(named(pumuckl), best(pumuckl, candidate('Folge 12: Pumuckl und die Schatzsuche', 'Pumuckl')))).toBe(false);
    const sam = 'Feuerwehrmann Sam Rettung am Pontypandy';
    expect(isConfident(named(sam), best(sam, candidate('Die besten Abenteuer (Box)', 'Feuerwehrmann Sam')))).toBe(false);
    expect(isConfident(named('x'), undefined)).toBe(false);
  });

  it('does not tick a hit when the name is only an artist, a series or common words', () => {
    // A folder the app named "Ordner 05" because its MP3s have an artist tag but no album tag.
    const artistOnly = coverlessFolders({ folders: [sdFolder(5)] }, { folders: { '05': entry('Ordner 05', { artist: 'Rolf Zuckowski' }) } }, new Set())[0];
    expect(artistOnly).toMatchObject({ query: 'Rolf Zuckowski', specific: false });
    const freunde = best(artistOnly.query, candidate('Rolf Zuckowski und seine Freunde', 'Rolf Zuckowski'));
    expect(freunde.score).toBeGreaterThanOrEqual(CONFIDENT_SCORE);
    const row = withResult(newRows([artistOnly])[0], result(freunde));
    expect(row).toMatchObject({ status: 'found', confident: false, checked: false, choice: { kind: 'candidate', id: freunde.id } });
    expect(needsLook(row)).toBe(true);

    const ddf = entry('Ordner 05', { artist: 'Die drei ???' });
    expect(namesOneAlbum(ddf)).toBe(false);
    const ddfQuery = buildFolderQuery(ddf);
    const special = best(ddfQuery, candidate('Die drei ??? - Das Hörspiel-Special', 'Die drei ???'));
    expect(isConfident({ query: ddfQuery, specific: namesOneAlbum(ddf) }, special)).toBe(false);

    for (const title of ['Kinderlieder', 'Weihnachtslieder', 'Gute Nacht Geschichten', 'Kinderlieder zum Mitsingen', 'Die schönsten Einschlaflieder']) {
      const e = entry(title, { artist: 'Various Artists' });
      expect(buildFolderQuery(e), title).not.toBe('');
      expect(namesOneAlbum(e), title).toBe(false);
      const q = buildFolderQuery(e);
      const hit = best(q, candidate(title, 'Simone Sommerland'));
      expect(isConfident({ query: q, specific: false }, hit), title).toBe(false);
    }
    // Only the series name as title: any album of the series would fit.
    expect(namesOneAlbum(entry('Bibi Blocksberg', { artist: 'Bibi Blocksberg' }))).toBe(false);
    expect(namesOneAlbum(entry('Pumuckl'))).toBe(false);
  });

  it('ticks a hit when the name points at one album', () => {
    expect(namesOneAlbum(entry('Die Weihnachtsbäckerei', { artist: 'Rolf Zuckowski' }))).toBe(true);
    expect(namesOneAlbum(entry('Folge 125: Feuermond', { series: 'Die drei ???' }))).toBe(true);
    expect(namesOneAlbum(entry('Hexen gibt es doch', { artist: 'Bibi Blocksberg' }))).toBe(true);
    expect(namesOneAlbum(entry('Benjamin Blümchen als Wetterelefant'))).toBe(true);
    // A series with an episode number names one episode.
    expect(namesOneAlbum(entry('Ordner 05', { series: 'TKKG', episode: 7 }))).toBe(true);
    expect(namesOneAlbum(entry('Folge 1', { artist: 'Benjamin Blümchen' }))).toBe(true);
    expect(namesOneAlbum(entry('TKKG Folge 7'))).toBe(true);
    expect(namesOneAlbum(entry('Kinderlieder 2'))).toBe(false);
    const q = 'Rolf Zuckowski Die Weihnachtsbäckerei';
    const targets = coverlessFolders({ folders: [sdFolder(3)] }, { folders: { '03': entry('Die Weihnachtsbäckerei', { artist: 'Rolf Zuckowski' }) } }, new Set());
    expect(targets[0]).toMatchObject({ query: q, specific: true });
    const row = withResult(newRows(targets)[0], result(best(q, candidate('Die Weihnachtsbäckerei', 'Rolf Zuckowski'))));
    expect(row).toMatchObject({ confident: true, checked: true });
  });

  it('tells "nobody answered" from "nothing found"', () => {
    expect(isUnreachable(nobody)).toBe(true);
    expect(isUnreachable({ candidates: [], warnings: [] })).toBe(false);
    expect(isUnreachable({ candidates: [], warnings: ['iTunes antwortet nicht. Es werden nur Treffer von MusicBrainz gezeigt.'] })).toBe(false);
  });
});

describe('rows', () => {
  const q = 'Die drei ??? Folge 125 Feuermond';
  const good = rankCandidates({ query: q }, [
    candidate('Folge 125: Feuermond', 'Die drei ???'),
    candidate('Folge 126: Feuermond Teil 2', 'Die drei ???'),
    candidate('Feuermond', 'Die drei ???', 'musicbrainz'),
    candidate('Folge 1: Der Super-Papagei', 'Die drei ???'),
    candidate('Folge 2: Der Phantomsee', 'Die drei ???'),
    candidate('Folge 3: Der Karpatenhund', 'Die drei ???'),
  ]);
  const fresh = () => newRows([target(1, q), target(2, ''), target(3, 'Benjamin Blümchen Folge 3')]);

  it('start waiting, or without a search when the name says too little', () => {
    const rows = fresh();
    expect(rows.map((r) => r.status)).toEqual(['waiting', 'noName', 'waiting']);
    expect(rows.every((r) => !r.checked && r.choice.kind === 'none')).toBe(true);
    expect(searchProgress(rows)).toEqual({ done: 0, total: 2 });
  });

  it('propose the best hit, ticked when confident, with up to four others', () => {
    const row = withResult(fresh()[0], result(...good));
    expect(row.status).toBe('found');
    expect(row.candidates).toHaveLength(MAX_CHOICES);
    expect(chosenCandidate(row)?.title).toBe('Folge 125: Feuermond');
    expect(row).toMatchObject({ confident: true, checked: true, touched: false });
    expect(needsLook(row)).toBe(false);
  });

  it('start unticked with a weak best hit ("Unsicher – bitte prüfen")', () => {
    const weak = rankCandidates({ query: 'Benjamin Blümchen Folge 3' }, [candidate('Folge 4: ...als Koch', 'Benjamin Blümchen')]);
    const row = withResult(fresh()[2], result(...weak));
    expect(row).toMatchObject({ status: 'found', confident: false, checked: false, choice: { kind: 'candidate', id: weak[0].id } });
    expect(needsLook(row)).toBe(true);
    // Picking it on purpose ticks it.
    const picked = pickCandidate(row, weak[0].id);
    expect(picked).toMatchObject({ checked: true, touched: true });
    expect(needsLook(picked)).toBe(false);
  });

  it('know "nothing found" and "no service answered"', () => {
    expect(withResult(fresh()[0], result())).toMatchObject({ status: 'nothing', checked: false, choice: { kind: 'none' } });
    expect(withResult(fresh()[0], nobody)).toMatchObject({ status: 'failed', checked: false });
    const rows = [withResult(fresh()[0], nobody), fresh()[1], withResult(fresh()[2], result())];
    expect(searchProgress(rows)).toEqual({ done: 2, total: 2 });
  });

  it('count "no hits because a service did not answer" as failed, not as "nothing found"', () => {
    const itunesDown: CoverSearchResult = { candidates: [], warnings: ['iTunes antwortet gerade nicht. Versuche es später noch einmal. Es werden nur Treffer von MusicBrainz gezeigt.'] };
    const row = withResult(fresh()[0], itunesDown);
    expect(row).toMatchObject({ status: 'failed', checked: false, choice: { kind: 'none' } });
    // With hits, a service that did not answer does not matter for the row.
    expect(withResult(fresh()[0], { candidates: good, warnings: itunesDown.warnings }).status).toBe('found');
    // An own picture chosen meanwhile stays.
    expect(withResult(pickOwn(fresh()[0]), itunesDown)).toMatchObject({ status: 'failed', checked: true, choice: { kind: 'own' } });
  });

  it('keep an own picture chosen while the search still ran', () => {
    const own = pickOwn(fresh()[0]);
    const row = withResult(own, result(...good));
    expect(row.choice).toEqual({ kind: 'own' });
    expect(row.checked).toBe(true);
    expect(row.candidates).toHaveLength(MAX_CHOICES);
  });

  it('can be set to "Kein passendes" and ticked only with something to take', () => {
    const row = pickNone(withResult(fresh()[0], result(...good)));
    expect(row).toMatchObject({ checked: false, choice: { kind: 'none' }, touched: true });
    expect(setChecked(row, true).checked).toBe(false);
    const on = withResult(fresh()[0], result(...good));
    expect(setChecked(on, false)).toMatchObject({ checked: false, choice: { kind: 'candidate' } });
    expect(setChecked(setChecked(on, false), true).checked).toBe(true);
    expect(pickCandidate(on, 'no-such-hit')).toBe(on);
  });

  it('drop a hit whose picture does not load and propose the next one', () => {
    const row = withResult(fresh()[0], result(...good));
    const first = row.candidates[0].id;
    const next = dropCandidate(row, first);
    expect(next.candidates.map((c) => c.id)).not.toContain(first);
    // The next best is a different episode: no longer confident, so no longer ticked.
    expect(next.choice).toEqual({ kind: 'candidate', id: next.candidates[0].id });
    expect(next).toMatchObject({ confident: false, checked: false });
    // A row the user decided on is not ticked again by itself.
    const touched = pickCandidate(row, row.candidates[1].id);
    const gone = dropCandidate(touched, row.candidates[1].id);
    expect(gone).toMatchObject({ choice: { kind: 'none' }, checked: false });
    // The last hit gone: nothing to choose any more.
    let only = withResult(fresh()[0], result(good[0]));
    only = dropCandidate(only, good[0].id);
    expect(only).toMatchObject({ status: 'nothing', candidates: [], checked: false, choice: { kind: 'none' } });
  });

  it('save only ticked rows with something to take, and not twice', () => {
    const rows: BulkRow[] = [
      withResult(fresh()[0], result(...good)),
      pickOwn(fresh()[1]),
      withResult(fresh()[2], result(candidate('Folge 4: ...als Koch', 'Benjamin Blümchen'))),
    ];
    expect(rowsToSave(rows).map((r) => r.target.folder)).toEqual([1, 2]);
    rows[0] = { ...rows[0], saved: true };
    expect(rowsToSave(rows).map((r) => r.target.folder)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// Searching with a stubbed network

const art = (id: string) => `https://is1-ssl.mzstatic.com/image/thumb/Music/${id}/source/100x100bb.jpg`;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A small iTunes, Deezer and MusicBrainz that know six audio plays. */
const SHELF = [
  { id: 1, artist: 'Die drei ???', title: 'Folge 125: Feuermond' },
  { id: 2, artist: 'Bibi Blocksberg', title: 'Folge 3: Hexen gibt es doch' },
  { id: 3, artist: 'Rolf Zuckowski', title: 'Die Weihnachtsbäckerei' },
  { id: 4, artist: 'Benjamin Blümchen', title: 'Folge 4: ...als Koch' },
  { id: 5, artist: 'TKKG', title: 'Folge 7: Das Paket mit dem Totenkopf' },
  { id: 6, artist: 'Pumuckl', title: 'Pumuckl und die Schatzsuche' },
];

function fakeFetch(opts: { down?: boolean; onRequest?: (url: string) => void } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    opts.onRequest?.(url);
    await new Promise((r) => setTimeout(r, 2));
    if (init?.signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    if (opts.down) throw new TypeError('Failed to fetch');
    const term = decodeURIComponent(url.split(/[?&](?:term|query|q)=/)[1]?.split('&')[0] ?? '')
      .replace(/\+/g, ' ')
      .toLowerCase();
    const hits = SHELF.filter((s) => term.includes(s.artist.toLowerCase().split(' ')[0]) || s.title.toLowerCase().split(/\W+/).some((w) => w.length > 4 && term.includes(w)));
    if (url.startsWith('https://itunes.apple.com/search?')) {
      return jsonResponse({ resultCount: hits.length, results: hits.map((s) => ({ wrapperType: 'collection', collectionId: s.id, artistName: s.artist, collectionName: s.title, artworkUrl100: art(String(s.id)) })) });
    }
    if (url.startsWith('https://api.deezer.com/search/album?')) {
      return jsonResponse({ data: hits.map((s) => ({ id: s.id, title: s.title, artist: { name: s.artist }, cover_medium: `https://e-cdns-images.dzcdn.net/images/cover/${s.id}/250x250.jpg` })), total: hits.length });
    }
    if (url.startsWith('https://musicbrainz.org/ws/2/release/?')) {
      return jsonResponse({ releases: hits.map((s) => ({ id: `rel-${s.id}`, score: 90, title: s.title, 'artist-credit': [{ name: s.artist }], 'release-group': { id: `rg-${s.id}` } })) });
    }
    throw new Error(`unexpected request ${url}`);
  });
}

const SIX: BulkTarget[] = [
  target(1, 'Die drei ??? Folge 125 Feuermond'),
  target(2, 'Bibi Blocksberg Hexen gibt es doch'),
  target(3, 'Rolf Zuckowski Die Weihnachtsbäckerei'),
  target(4, 'Benjamin Blümchen Folge 3'),
  target(5, 'TKKG Folge 7'),
  target(6, ''),
];

describe('searching many folders', () => {
  it('searches every folder with a name, four at a time, and proposes a cover per folder', async () => {
    let running = 0;
    let most = 0;
    const fetchFn = fakeFetch();
    let rows = newRows(SIX);
    const spacing = new RateLimiter(0);
    const wait = vi.spyOn(spacing, 'wait');
    await runBulkSearch(SIX, {
      spacing,
      search: async (query, signal, target) => {
        running++;
        most = Math.max(most, running);
        try {
          return await searchCovers(query, { fetchFn, ...searchOptionsFor(target, signal), limiters: quick() });
        } finally {
          running--;
        }
      },
      onResult: (folder, r) => {
        rows = rows.map((row) => (row.target.folder === folder ? withResult(row, r) : row));
      },
    });
    expect(most).toBe(4);
    expect(wait).toHaveBeenCalledTimes(5);
    // iTunes and Deezer for each folder with a name; MusicBrainz only for the one they found nothing sure for.
    const urls = fetchFn.mock.calls.map(([url]) => url);
    expect(urls.filter((u) => u.includes('itunes'))).toHaveLength(5);
    expect(urls.filter((u) => u.includes('deezer'))).toHaveLength(5);
    expect(urls.filter((u) => u.includes('musicbrainz'))).toHaveLength(1);
    expect(urls.find((u) => u.includes('musicbrainz'))).toMatch(/benjamin/i);
    expect(rows.map((r) => r.status)).toEqual(['found', 'found', 'found', 'found', 'found', 'noName']);
    expect(rows.map((r) => chosenCandidate(r)?.title)).toEqual([
      'Folge 125: Feuermond',
      'Folge 3: Hexen gibt es doch',
      'Die Weihnachtsbäckerei',
      'Folge 4: ...als Koch',
      'Folge 7: Das Paket mit dem Totenkopf',
      undefined,
    ]);
    // Benjamin Blümchen 3 has only episode 4 on offer: unticked, to be checked.
    expect(rows.map((r) => r.checked)).toEqual([true, true, true, false, true, false]);
    expect(rows[3].confident).toBe(false);
    expect(searchProgress(rows)).toEqual({ done: 5, total: 5 });
  });

  it('keeps to the spacing between searches', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const spacing = new RateLimiter(
      3000,
      () => clock,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    );
    const starts: number[] = [];
    await runBulkSearch(SIX, { spacing, concurrency: 1, onStart: () => starts.push(clock), search: async () => result() });
    expect(starts).toEqual([0, 3000, 6000, 9000, 12000]);
  });

  it('stops with one message when neither service answers', async () => {
    const fetchFn = fakeFetch({ down: true });
    const results: number[] = [];
    const run = runBulkSearch(SIX, {
      spacing: noWait(),
      search: (query, signal) => searchCovers(query, { fetchFn, signal, limiters: quick() }),
      onResult: (folder) => results.push(folder),
    });
    await expect(run).rejects.toBeInstanceOf(UnreachableError);
    await expect(run).rejects.toThrow(UNREACHABLE_MESSAGE);
    // It gave up after the first folders instead of trying all of them.
    expect(results.length).toBeLessThanOrEqual(2);
    // Four folders at a time, one request per service each, and the fifth folder at most: then it stops.
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(15);
  });

  it('goes on when only some folders fail', async () => {
    let n = 0;
    const results: [number, boolean][] = [];
    await runBulkSearch(SIX, {
      spacing: noWait(),
      concurrency: 1,
      search: async () => (n++ === 1 ? nobody : result(candidate('Treffer', 'Jemand'))),
      onResult: (folder, r) => results.push([folder, isUnreachable(r)]),
    });
    expect(results).toEqual([
      [1, false],
      [2, true],
      [3, false],
      [4, false],
      [5, false],
    ]);
  });

  it('marks folders as failed, not as "nothing found", when iTunes does not answer and the others have nothing', async () => {
    const three = SIX.slice(0, 3);
    let rows = newRows(three);
    // iTunes does not answer, Deezer and MusicBrainz answer with an empty list.
    const fetchFn = vi.fn(async (url: string) => {
      if (url.startsWith('https://itunes.apple.com/')) throw new TypeError('Failed to fetch');
      return jsonResponse(url.includes('deezer') ? { data: [], total: 0 } : { releases: [] });
    });
    await runBulkSearch(three, {
      spacing: noWait(),
      search: (query, signal) => searchCovers(query, { fetchFn, signal, limiters: quick() }),
      onResult: (folder, r) => {
        rows = rows.map((row) => (row.target.folder === folder ? withResult(row, r) : row));
      },
    });
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    expect(reviewSummary(rows)).toBe('Bei 3 Ordnern hat die Suche nicht geklappt, weil ein Dienst nicht geantwortet hat. Versuche es noch einmal oder nimm ein eigenes Bild.');
    expect(reviewSummary(rows)).not.toMatch(/genauere Namen/);
  });

  it('counts an unexpected error as a failed folder, not as the end of the run', async () => {
    let n = 0;
    const results: number[] = [];
    await runBulkSearch(SIX.slice(0, 3), {
      spacing: noWait(),
      concurrency: 1,
      search: async () => {
        if (n++ === 1) throw new Error('kaputt');
        return result(candidate('Treffer', 'Jemand'));
      },
      onResult: (folder) => results.push(folder),
    });
    expect(results).toEqual([1, 2, 3]);
  });

  it('stops at once when cancelled and reports nothing after that', async () => {
    const ctrl = new AbortController();
    const fetchFn = fakeFetch();
    const results: number[] = [];
    const run = runBulkSearch(SIX, {
      spacing: noWait(),
      signal: ctrl.signal,
      search: (query, signal) => searchCovers(query, { fetchFn, signal, rateLimiter: noWait() }),
      onStart: () => ctrl.abort(),
      onResult: (folder) => results.push(folder),
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(results).toEqual([]);
    const already = new AbortController();
    already.abort();
    await expect(runBulkSearch(SIX, { signal: already.signal, search: async () => result() })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('runs a pool in order of the items', async () => {
    const out = await inPool([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });
});

// ---------------------------------------------------------------------------
// Saving: one write of the cover zip, one catalog update

const JPEG = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n]);

interface SixCard {
  volume: Volume;
  writes: string[];
  refuse: Set<string>;
  read: (name: string) => Promise<Uint8Array>;
}

/** A card with six folders; folder 02 has a cover already. */
async function sixCard(): Promise<SixCard> {
  const c: Catalog = newCatalog('Lenas Box');
  for (const s of SHELF) c.folders[String(s.id).padStart(2, '0')] = entry(s.title, { artist: s.artist, tracks: [{ file: '001.mp3' }] });
  c.folders['02'].cover = '02.jpg';
  c.folders['02'].coverSource = 'Datei';
  // A colour and section chosen for the generated placeholder of folder 01.
  c.folders['01'].color = '#336699';
  c.folders['01'].sticker = { title: 'Feuermond', zoom: 2, focusX: 0.2, orientation: 'portrait' };
  // And for the cover of folder 02.
  c.folders['02'].color = '#aa3300';
  c.folders['02'].sticker = { title: 'Zwei', zoom: 1.5, focusY: 0.3 };
  const tree: Record<string, Record<string, number> | string | Uint8Array> = {
    'tonuino-studio.json': serializeCatalog(c),
    'tonuino-studio-covers.zip': await packCovers(new Map([['02.jpg', JPEG(2)]])),
  };
  for (const s of SHELF) tree[String(s.id).padStart(2, '0')] = { '001.mp3': 1000 };
  const mem = memDir(tree);
  const writes: string[] = [];
  const refuse = new Set<string>();
  const root = new Proxy(mem, {
    get(t, prop) {
      if (prop === 'write') {
        return async (name: string, data: Uint8Array | Blob) => {
          writes.push(name);
          if (refuse.delete(name)) throw new Error('Die Datei ist gesperrt oder schreibgeschützt.');
          return t.write(name, data);
        };
      }
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Dir;
  return { volume: { id: 'six', label: 'SD', root, info: { removable: true }, canEject: true }, writes, refuse, read: (name) => mem.read(name) };
}

describe('saving the chosen covers', () => {
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

  it('writes the cover zip once and the catalog once, and leaves folders with a cover alone', async () => {
    const t = await sixCard();
    await openVolume(t.volume);
    const kinds: string[][] = [];
    const stop = writeGuard.running.subscribe((r) => kinds.push([...r]));
    const written = await setCovers(
      [
        { folder: 1, data: JPEG(1), mimeType: 'image/jpeg', source: 'iTunes' },
        { folder: 2, data: JPEG(99), mimeType: 'image/jpeg', source: 'iTunes' },
        { folder: 3, data: JPEG(3), mimeType: 'image/jpeg', source: 'MusicBrainz' },
        { folder: 5, data: JPEG(5), mimeType: 'image/jpeg', source: 'Datei' },
      ],
      { onlyMissing: true },
    );
    stop();
    expect(written).toEqual([1, 3, 5]);
    expect(t.writes).toEqual(['tonuino-studio-covers.zip', 'tonuino-studio.json']);
    // The card was held open while it was written.
    expect(kinds).toContainEqual(['covers']);

    const zip = await loadCovers(t.volume.root);
    expect([...zip.keys()].sort()).toEqual(['01.jpg', '02.jpg', '03.jpg', '05.jpg']);
    expect(zip.get('02.jpg')).toEqual(JPEG(2));
    const onCard = parseCatalog(new TextDecoder().decode(await t.read('tonuino-studio.json')))!;
    expect(onCard.folders['01']).toMatchObject({ cover: '01.jpg', coverSource: 'iTunes' });
    expect(onCard.folders['02']).toMatchObject({ cover: '02.jpg', coverSource: 'Datei' });
    expect(onCard.folders['03']).toMatchObject({ cover: '03.jpg', coverSource: 'MusicBrainz' });
    expect(onCard.folders['05']).toMatchObject({ cover: '05.jpg', coverSource: 'Datei' });
    expect(onCard.folders['04'].cover).toBeUndefined();
    // Colour, section and orientation were chosen for the placeholder; the shorter title stays.
    expect(onCard.folders['01'].color).toBeUndefined();
    expect(onCard.folders['01'].sticker).toEqual({ title: 'Feuermond' });
    // Folder 02 kept its cover, so it keeps what was set for it.
    expect(onCard.folders['02'].color).toBe('#aa3300');
    expect(onCard.folders['02'].sticker).toEqual({ title: 'Zwei', zoom: 1.5, focusY: 0.3 });
    // Shelf and sticker sheet read their pictures from here.
    for (const n of [1, 2, 3, 5]) expect(coverUrlFor(n)).toBeTruthy();
    expect(coverUrlFor(4)).toBeUndefined();
  });

  it('forgets colour and section when a cover is removed, and keeps the text', async () => {
    const t = await sixCard();
    await openVolume(t.volume);
    expect(await setCovers([{ folder: 2, data: null }])).toEqual([2]);
    const onCard = parseCatalog(new TextDecoder().decode(await t.read('tonuino-studio.json')))!;
    expect(onCard.folders['02'].cover).toBeUndefined();
    expect(onCard.folders['02'].coverSource).toBeUndefined();
    expect(onCard.folders['02'].color).toBeUndefined();
    expect(onCard.folders['02'].sticker).toEqual({ title: 'Zwei' });
    expect(coverUrlFor(2)).toBeUndefined();
  });

  it('leaves colour and section alone when a folder without a cover gets none', async () => {
    const t = await sixCard();
    await openVolume(t.volume);
    await setCovers([{ folder: 1, data: null }]);
    const onCard = parseCatalog(new TextDecoder().decode(await t.read('tonuino-studio.json')))!;
    expect(onCard.folders['01'].color).toBe('#336699');
    expect(onCard.folders['01'].sticker).toEqual({ title: 'Feuermond', zoom: 2, focusX: 0.2, orientation: 'portrait' });
  });

  it('writes nothing when every folder has a cover by now', async () => {
    const t = await sixCard();
    await openVolume(t.volume);
    expect(await setCovers([{ folder: 2, data: JPEG(9), source: 'iTunes' }], { onlyMissing: true })).toEqual([]);
    expect(await setCovers([{ folder: 9, data: JPEG(9), source: 'iTunes' }], { onlyMissing: true })).toEqual([]);
    expect(t.writes).toEqual([]);
  });

  it('keeps the old covers when the card refuses the write', async () => {
    const t = await sixCard();
    await openVolume(t.volume);
    t.refuse.add('tonuino-studio-covers.zip');
    await expect(setCovers([{ folder: 1, data: JPEG(1), source: 'iTunes' }], { onlyMissing: true })).rejects.toThrow(/schreibgeschützt/);
    expect([...(await loadCovers(t.volume.root)).keys()]).toEqual(['02.jpg']);
    expect(card.value?.catalog?.folders['01'].cover).toBeUndefined();
    expect(coverUrlFor(1)).toBeUndefined();
    expect(t.writes).toEqual(['tonuino-studio-covers.zip']);
    expect(writeGuard.running.value).toEqual([]);
  });
});

describe('the line above the proposals', () => {
  const found = (folder: number, confident: boolean): BulkRow => {
    const hit = { ...candidate('Treffer', 'Jemand'), score: confident ? 1 : 0.3 };
    return withResult(newRows([target(folder, 'Jemand Treffer')])[0], result(hit));
  };

  it('counts proposals and the unsure ones', () => {
    expect(reviewSummary([found(1, true), found(2, true)])).toBe('Für alle 2 Ordner gibt es einen Vorschlag. Ein anderes Bild nimmst du, indem du es anklickst.');
    expect(reviewSummary([found(1, true), found(2, false), ...newRows([target(3, '')])])).toBe(
      'Für 2 von 3 Ordnern gibt es einen Vorschlag. Einer ist unsicher: Sieh ihn dir an und hake ihn an, wenn er passt. Ein anderes Bild nimmst du, indem du es anklickst.',
    );
    expect(reviewSummary([found(1, false), found(2, false)])).toMatch(/2 sind unsicher: Sieh sie dir an/);
    expect(reviewSummary([withResult(newRows([target(1, 'x y')])[0], result())])).toMatch(/^Für keinen Ordner gab es einen Treffer\./);
    expect(reviewSummary(newRows([target(1, '')]))).toMatch(/weil genaue Namen fehlen/);
    const failed = withResult(newRows([target(3, 'Jemand Anderes')])[0], { candidates: [], warnings: ['iTunes antwortet gerade nicht.'] });
    expect(reviewSummary([found(1, true), failed])).toBe(
      'Für 1 von 2 Ordnern gibt es einen Vorschlag. Bei einem Ordner hat die Suche nicht geklappt, weil ein Dienst nicht geantwortet hat. Ein anderes Bild nimmst du, indem du es anklickst.',
    );
  });
});

// ---------------------------------------------------------------------------
// Help

describe('help on finding covers', () => {
  it('is found by the words parents use', () => {
    for (const q of [
      'Cover automatisch',
      'Original-Cover',
      'Originalcover',
      'Hörspiel-Cover',
      'Hörspielcover',
      'fehlende Cover',
      'alle Cover finden',
      'cover herunterladen',
      'cover laden',
      'Coverbild',
      'Titelbild',
      'Plattencover',
    ]) {
      expect(searchHelp(q).hits[0]?.id, q).toBe('cover-finden');
    }
    // The general section on covers may come first; this one is right behind it.
    expect(searchHelp('Albumcover').hits.slice(0, 2).map((h) => h.id)).toContain('cover-finden');
  });

  it('says where the pictures come from and that the search only starts on request', () => {
    const text = (id: string) => findSection(id)!.section.blocks.flatMap(blockTexts).map(plainText).join(' ');
    expect(text('cover-finden')).toMatch(/iTunes \(Apple\)/);
    expect(text('cover-finden')).toMatch(/MusicBrainz mit dem Cover Art Archive/);
    expect(text('cover-finden')).toMatch(/Eigenes Bild/);
    expect(text('cover-finden')).toMatch(/nur für deine eigenen/);
    expect(text('datenschutz')).toMatch(/Erst wenn du unter „Cover suchen“ auf „Suche starten“ klickst, schickt die App die Namen/);
    expect(resolveHelp('cover-automatisch')).toMatchObject({ kind: 'topic', section: { id: 'cover' }, part: { id: 'cover-finden' } });
  });
});

describe('the message of a failed name search', () => {
  it('says "ausgelastet" for 429 and 503, else that the services are not reachable', () => {
    expect(lookupFailureMessage(new Error('HTTP 429'))).toBe(BUSY_MESSAGE);
    expect(lookupFailureMessage(new Error('HTTP 503'))).toBe(BUSY_MESSAGE);
    expect(lookupFailureMessage(new Error('HTTP 500'))).toBe(UNREACHABLE_MESSAGE);
    expect(lookupFailureMessage(new TypeError('Failed to fetch'))).toBe(UNREACHABLE_MESSAGE);
  });
});
