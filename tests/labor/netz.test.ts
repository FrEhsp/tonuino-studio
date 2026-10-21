/**
 * Testlabor, schlechtes Internet (TODO #69): every online lookup of the app
 * (cover search at iTunes and MusicBrainz, the cover download, track names
 * from MusicBrainz, ARASAAC pictograms, the list and the files of
 * "Entdecken") against netz/stoersender.ts: offline, no answer, an answer
 * that stops halfway, a slow one, busy (429/503), an error page and a
 * login page instead of data. The rule: every lookup ends on its own
 * within its time limit, with a German message that says what happened,
 * and nothing else breaks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchCovers, downloadCoverImage, RateLimiter } from '../../src/core/stickers/coversearch';
import { BUSY_MESSAGE, lookupFailureMessage, runBulkSearch, UNREACHABLE_MESSAGE, UnreachableError } from '../../src/core/stickers/bulkcover';
import { lookupAlbumTracks } from '../../src/core/library/tracklookup';
import { downloadPictogram, searchPictograms } from '../../src/core/stickers/arasaac';
import { loadIndex } from '../../src/core/sources/load';
import { probe } from '../../src/core/sources/reach';
import { downloadFiles } from '../../src/core/sources/download';
import { monoMp3 } from '../audio/fixtures';
import { tinyJpeg, tinyPng } from '../stickers/fixtures';
import { loadSample, NOW } from '../sources/sample';
import { laborOn } from './labor';
import { Stoersender, type Answer } from './netz/stoersender';

const art = 'https://is1-ssl.mzstatic.com/image/thumb/Music/x/source/100x100bb.jpg';
const sample = loadSample();
const mp3 = monoMp3();

function canned(url: URL): Answer {
  const json = (v: unknown): Answer => ({ type: 'application/json', body: JSON.stringify(v) });
  if (url.hostname === 'itunes.apple.com') {
    return json({
      resultCount: 1,
      results: [{ wrapperType: 'collection', collectionType: 'Album', collectionId: 1440729154, artistName: 'Die drei ???', collectionName: 'Folge 12: Der seltsame Wecker', artworkUrl100: art, trackCount: 9 }],
    });
  }
  if (url.hostname === 'musicbrainz.org') return json({ created: '2026-10-20T12:00:00.000Z', count: 0, offset: 0, releases: [] });
  if (url.hostname === 'api.arasaac.org') return json([{ _id: 2382, keywords: [{ keyword: 'Katze', type: 2 }], schematic: false, sex: false, violence: false }]);
  if (url.hostname === 'static.arasaac.org') return { type: 'image/png', body: tinyPng() };
  if (url.hostname.endsWith('mzstatic.com') || url.hostname === 'coverartarchive.org') return { type: 'image/jpeg', body: tinyJpeg() };
  if (url.pathname.endsWith('index-v1.json')) return json(sample);
  if (url.hostname === 'archive.org' && url.pathname.startsWith('/metadata/')) return json({ result: 'x' });
  if (url.pathname.endsWith('.mp3')) return { type: 'audio/mpeg', body: mp3 };
  return { status: 404, type: 'text/plain', body: 'not found' };
}

const net = new Stoersender(canned);

/** Settles within `ms`, or the lookup hangs. */
async function within<T>(ms: number, p: Promise<T>): Promise<{ value?: T; error?: Error & { offline?: boolean; code?: string }; ms: number }> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`hängt länger als ${ms} ms`)), ms)));
  try {
    const value = await Promise.race([p, hang]);
    return { value, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('hängt')) throw e;
    return { error: e as Error, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

const quick = new RateLimiter(0);
const T = 1500;

describe.skipIf(!laborOn)('Testlabor: schlechtes Internet', () => {
  beforeAll(() => net.start());
  afterAll(() => net.stop());
  beforeEach(() => net.clear());

  describe('Cover-Suche (iTunes und MusicBrainz)', () => {
    const search = (timeoutMs = T) => searchCovers({ query: 'Die drei ??? Der seltsame Wecker' }, { fetchFn: net.fetch, timeoutMs, rateLimiter: quick });

    it('offline: sofort eine Meldung zur Internetverbindung, keine Treffer', async () => {
      net.set('offline');
      const r = await within(T, search());
      expect(r.value?.candidates).toEqual([]);
      expect(r.value?.warnings).toHaveLength(2);
      for (const w of r.value!.warnings) expect(w).toMatch(/Internetverbindung/);
    });

    it.each(['hang', 'stall', 'slow'] as const)('%s: endet nach der Wartezeit mit „antwortet gerade nicht“', async (weather) => {
      net.set(weather);
      const r = await within(T + 1500, search());
      expect(r.value?.warnings).toHaveLength(2);
      for (const w of r.value!.warnings) expect(w).toMatch(/antwortet gerade nicht/);
    });

    it('MusicBrainz ausgelastet (429): Treffer von iTunes kommen trotzdem, mit Hinweis', async () => {
      net.set('429', /musicbrainz/);
      const r = await within(T, search());
      expect(r.value?.candidates.length).toBeGreaterThan(0);
      expect(r.value?.warnings).toEqual([expect.stringMatching(/MusicBrainz ist gerade ausgelastet.*nur Treffer von iTunes/)]);
    });

    it('WLAN-Anmeldeseite statt Daten: „unerwartete Antwort“', async () => {
      net.set('garbage');
      const r = await within(T, search());
      for (const w of r.value!.warnings) expect(w).toMatch(/unerwartete Antwort/);
    });

    it('Cover laden: hängt, bricht ab oder ist kein Bild – klare Meldung in der Zeit', async () => {
      const c = { fullUrl: art.replace('100x100bb', '1200x1200bb'), thumbUrl: art };
      for (const [weather, text] of [
        ['stall', /antwortet gerade nicht/],
        ['hang', /antwortet gerade nicht/],
        ['garbage', /gibt das Bild nicht heraus/],
        ['offline', /gibt das Bild nicht heraus/],
      ] as const) {
        net.clear();
        net.set(weather);
        const r = await within(2 * T + 1500, downloadCoverImage(c, { fetchFn: net.fetch, timeoutMs: T }));
        expect(r.error?.message, weather).toMatch(text);
      }
    });

    it('alle Cover suchen offline: gibt nach zwei Ordnern auf, eine Meldung statt dreißig', async () => {
      net.set('offline');
      const targets = Array.from({ length: 30 }, (_, i) => ({ folder: i + 1, query: `Hörspiel ${i + 1}` })) as never[];
      const r = await within(3 * T, runBulkSearch(targets, { search: (q, signal) => searchCovers(q, { fetchFn: net.fetch, signal, timeoutMs: T, rateLimiter: quick }), spacing: quick }));
      expect(r.error).toBeInstanceOf(UnreachableError);
      expect(net.seen.length).toBeLessThanOrEqual(6);
    });

    it('alle Cover suchen, beide Dienste ausgelastet (429): die Meldung schickt nicht zur Internetverbindung', async () => {
      net.set('429');
      const targets = Array.from({ length: 5 }, (_, i) => ({ folder: i + 1, query: `Hörspiel ${i + 1}` })) as never[];
      const r = await within(3 * T, runBulkSearch(targets, { search: (q, signal) => searchCovers(q, { fetchFn: net.fetch, signal, timeoutMs: T, rateLimiter: quick }), spacing: quick }));
      expect(r.error?.message).toMatch(/ausgelastet/);
    });
  });

  describe('Titelnamen von iTunes und MusicBrainz', () => {
    const lookup = () => lookupAlbumTracks({ album: 'Der seltsame Wecker', artist: 'Die drei ???', durations: [60, 61, 62] }, { fetchFn: net.fetch, timeoutMs: T, rateLimiter: quick });

    it.each(['offline', 'hang', 'stall', '503'] as const)('%s: endet in der Zeit mit einem Fehler, den die Seite zeigt', async (weather) => {
      net.set(weather);
      const r = await within(2 * T + 1500, lookup());
      expect(r.error).toBeTruthy();
    });

    it('beide ausgelastet (429): die Seite sagt „ausgelastet“, nicht „Internetverbindung prüfen“', async () => {
      net.set('429');
      const r = await within(2 * T, lookup());
      expect(lookupFailureMessage(r.error)).toBe(BUSY_MESSAGE);
      net.set('offline');
      expect(lookupFailureMessage((await within(2 * T, lookup())).error)).toBe(UNREACHABLE_MESSAGE);
    });

    it('MusicBrainz ausgelastet, iTunes antwortet: „nichts gefunden“ statt Fehler', async () => {
      net.set('429', /musicbrainz/);
      const r = await within(2 * T, lookup());
      expect(r.error).toBeUndefined();
      expect(r.value).toBeNull();
    });
  });

  describe('ARASAAC-Piktogramme', () => {
    it('offline: „Bist du online?“', async () => {
      net.set('offline');
      const r = await within(T, searchPictograms('Katze', { fetchFn: net.fetch, timeoutMs: T }));
      expect(r.error?.message).toMatch(/Bist du online/);
      expect(r.error?.offline).toBe(true);
    });

    it.each(['hang', 'stall', 'slow'] as const)('Suche %s: endet nach der Wartezeit', async (weather) => {
      net.set(weather);
      const r = await within(T + 2000, searchPictograms('Katze', { fetchFn: net.fetch, timeoutMs: T }));
      expect(r.error?.message).toMatch(/zu lange|nicht zu erreichen/);
    });

    it.each(['429', '500'] as const)('Suche %s: sagt den Fehler', async (weather) => {
      net.set(weather);
      const r = await within(T, searchPictograms('Katze', { fetchFn: net.fetch, timeoutMs: T }));
      expect(r.error?.message).toMatch(new RegExp(`Fehler ${weather}`));
    });

    it('Anmeldeseite statt Daten: „nicht lesen“', async () => {
      net.set('garbage');
      const r = await within(T, searchPictograms('Katze', { fetchFn: net.fetch, timeoutMs: T }));
      expect(r.error?.message).toMatch(/nicht lesen/);
    });

    it.each(['hang', 'stall', 'garbage', 'offline'] as const)('Bild laden %s: endet in der Zeit mit Meldung', async (weather) => {
      net.set(weather);
      const r = await within(3 * T + 2000, downloadPictogram(2382, { fetchFn: net.fetch, timeoutMs: T }));
      expect(r.error?.message).toMatch(/Piktogramm|ARASAAC/);
    });
  });

  describe('Entdecken: die Liste', () => {
    const load = () =>
      loadIndex({ url: 'https://studio.example.de/quellen/index-v1.json', fetch: net.fetch, storage: null, snapshot: async () => sample, now: NOW.getTime(), isOnline: net.isOnline, timeoutMs: T });

    it('gute Verbindung: die Liste aus dem Netz', async () => {
      const r = await within(T, load());
      expect(r.value).toMatchObject({ status: 'ready', from: 'network' });
    });

    it.each(['offline', 'hang', 'stall', 'slow', '429', '500', 'garbage'] as const)('%s: die mitgelieferte Liste, in der Zeit', async (weather) => {
      net.set(weather);
      const r = await within(T + 1500, load());
      expect(r.value).toMatchObject({ status: 'ready', from: 'snapshot', offline: weather === 'offline' });
    });
  });

  describe('Entdecken: Erreichbarkeit und Laden der Dateien', () => {
    const file = { url: 'https://media.example.de/folge1.mp3', name: 'Folge 1.mp3' };

    it.each(['hang', 'stall', '429', 'offline'] as const)('Erreichbarkeit %s: „weiß nicht“, kein Hängen', async (weather) => {
      net.set(weather);
      const r = await within(T + 1000, probe({ id: 'file:x', url: file.url, how: 'head', items: ['x'] }, net.fetch, { timeoutMs: T }));
      expect(r.value).toBe('unknown');
    });

    it('offline: „offline“, nichts halb geladen', async () => {
      net.set('offline');
      const r = await within(T, downloadFiles([file], { fetch: net.fetch, isOnline: net.isOnline, idleMs: T, wait: async () => undefined }));
      expect(r.value?.failed.map((f) => f.error.code)).toEqual(['offline']);
      expect(r.value?.ok).toEqual([]);
    });

    it.each(['hang', 'stall'] as const)('%s: nach einmal Wiederholen „bricht ab“, in der Zeit', async (weather) => {
      net.set(weather);
      const r = await within(3 * T + 2000, downloadFiles([file], { fetch: net.fetch, isOnline: net.isOnline, idleMs: T, wait: async () => undefined }));
      expect(r.value?.failed.map((f) => f.error.code)).toEqual([weather === 'hang' ? 'network' : 'incomplete']);
    });

    it('429 mit Retry-After: wartet so lange wie verlangt und lädt dann', async () => {
      let calls = 0;
      const waits: number[] = [];
      net.set('ok');
      const fetchOnce429 = async (url: string, init: RequestInit) => {
        net.clear();
        net.set(calls++ === 0 ? '429' : 'ok');
        return net.fetch(url, init);
      };
      const r = await within(T, downloadFiles([file], { fetch: fetchOnce429, isOnline: net.isOnline, idleMs: T, wait: async (ms) => void waits.push(ms) }));
      expect(waits).toEqual([2000]);
      expect(r.value?.ok).toHaveLength(1);
    });

    it('Anmeldeseite statt Ton: „kein Ton“', async () => {
      net.set('garbage');
      const r = await within(T, downloadFiles([file], { fetch: net.fetch, isOnline: net.isOnline, idleMs: T, wait: async () => undefined }));
      expect(r.value?.failed.map((f) => f.error.code)).toEqual(['not-audio']);
    });
  });
});
