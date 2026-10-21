/**
 * ARASAAC pictograms for Bildkarten (core/stickers/arasaac.ts, features/stickers/pictograms.ts).
 * The container cannot reach api.arasaac.org, so the answers are built after
 * the API's documented form (GET /v1/pictograms/{locale}/search/{text}: a list
 * of pictograms with _id, keywords, sex, violence …; 404 when nothing matches).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadPictogram, imageUrls, parseSearch, PICTOGRAM_CREDIT, PictogramError, searchPictograms, searchUrl, thumbUrl } from '../../src/core/stickers/arasaac';
import { parseCatalog, serializeCatalog, newCatalog } from '../../src/core/tonuino/catalog';
import { tinyPng } from './fixtures';

const store = new Map<string, unknown>();
vi.mock('../../src/platform/web/idb', () => ({
  kv: {
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    keys: async (p: string) => [...store.keys()].filter((k) => k.startsWith(p)),
  },
}));

/** One pictogram as the API describes it (fields trimmed to those that matter). */
const picto = (id: number, keyword: string, more: Record<string, unknown> = {}) => ({
  _id: id,
  keywords: [{ keyword, type: 2, hasLocution: true, plural: `${keyword}n` }],
  schematic: false,
  sex: false,
  violence: false,
  aac: false,
  aacColor: true,
  skin: true,
  hair: true,
  categories: ['animal'],
  tags: ['animal'],
  synsets: [],
  downloads: 0,
  created: '2008-01-01T00:00:00.000Z',
  lastUpdated: '2020-01-01T00:00:00.000Z',
  ...more,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function pngBytes(): Promise<Uint8Array<ArrayBuffer>> {
  return tinyPng();
}

describe('searching ARASAAC', () => {
  it('asks the German search of the official API, the word encoded, without cookies or referrer', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return json([picto(2382, 'Katze'), picto(7114, 'Kätzchen')]);
    });
    const hits = await searchPictograms('  Katze schläft ', { fetchFn });
    expect(calls[0].url).toBe('https://api.arasaac.org/v1/pictograms/de/search/Katze%20schl%C3%A4ft');
    expect(calls[0].init?.credentials).toBe('omit');
    expect(calls[0].init?.referrerPolicy).toBe('no-referrer');
    expect(hits).toEqual([
      { id: 2382, label: 'Katze', thumbUrl: 'https://static.arasaac.org/pictograms/2382/2382_300.png' },
      { id: 7114, label: 'Kätzchen', thumbUrl: thumbUrl(7114) },
    ]);
  });

  it('goes nowhere for an empty word', async () => {
    const fetchFn = vi.fn();
    expect(await searchPictograms('   ', { fetchFn })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('takes "nothing found" (404) as no hits, a broken server or network as a German message', async () => {
    expect(await searchPictograms('xyzzy', { fetchFn: async () => json({ error: 'not found' }, 404) })).toEqual([]);
    await expect(searchPictograms('Katze', { fetchFn: async () => json({}, 500) })).rejects.toThrow(/ARASAAC antwortet gerade nicht \(Fehler 500\)/);
    const offline = searchPictograms('Katze', {
      fetchFn: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(offline).rejects.toBeInstanceOf(PictogramError);
    await expect(offline).rejects.toThrow(/nicht zu erreichen/);
    await expect(searchPictograms('Katze', { fetchFn: async () => new Response('<html>', { status: 200 }) })).rejects.toThrow(/nicht lesen/);
  });

  it('leaves out what ARASAAC marks as violence or sex, doubles and broken entries, and stops at the limit', () => {
    const raw = [picto(1, 'Hund'), picto(2, 'Waffe', { violence: true }), picto(3, 'nackt', { sex: true }), picto(1, 'Hund'), { _id: 'x' }, null, { _id: 4 }, picto(5, 'Katze')];
    expect(parseSearch(raw).map((h) => [h.id, h.label])).toEqual([
      [1, 'Hund'],
      [4, ''],
      [5, 'Katze'],
    ]);
    expect(parseSearch(raw, 1)).toHaveLength(1);
    expect(parseSearch({ not: 'a list' })).toEqual([]);
  });

  it('builds the URLs the API documents', () => {
    expect(searchUrl('Hund')).toBe('https://api.arasaac.org/v1/pictograms/de/search/Hund');
    expect(imageUrls(2382)[0]).toMatch(/^https:\/\/api\.arasaac\.org\/v1\/pictograms\/2382\?.*resolution=500/);
    expect(imageUrls(2382)[0]).toMatch(/color=true/);
    expect(imageUrls(2382)[1]).toBe('https://static.arasaac.org/pictograms/2382/2382_500.png');
  });

  it('gives up on an answer that stops halfway, within the time limit (Testlabor)', async () => {
    // Headers and a first part, then nothing: the body never ends until the request is aborted.
    const stalled = async (_url: string, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('[{"_id":'));
            init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    await expect(searchPictograms('Katze', { fetchFn: stalled, timeoutMs: 50 })).rejects.toThrow(/zu lange/);
    await expect(downloadPictogram(2382, { fetchFn: stalled, timeoutMs: 50 })).rejects.toThrow(/zu lange/);
  });
});

describe('loading the chosen pictogram', () => {
  it('takes the PNG of the API, else the one of the static server', async () => {
    const png = await pngBytes();
    const asked: string[] = [];
    const blob = await downloadPictogram(2382, {
      fetchFn: async (url) => {
        asked.push(url);
        return url.includes('api.arasaac.org') ? new Response('busy', { status: 503 }) : new Response(png as BodyInit, { status: 200 });
      },
    });
    expect(asked).toHaveLength(2);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(png.length);
  });

  it('refuses an answer that is no picture', async () => {
    await expect(downloadPictogram(1, { fetchFn: async () => new Response('<html>nope</html>', { status: 200 }) })).rejects.toThrow(/kein Bild/);
  });
});

describe('kept on this device', () => {
  beforeEach(() => store.clear());

  it('stores the chosen picture once and never loads it again, for printing neither', async () => {
    const { keepPictogram, hasPictogram, pictogramImage, pictogramRev } = await import('../../src/features/stickers/pictograms');
    const png = await pngBytes();
    const fetchFn = vi.fn(async () => new Response(png as BodyInit, { status: 200 }));
    expect(await hasPictogram(2382)).toBe(false);
    const rev = pictogramRev.value;
    await keepPictogram(2382, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.get('arasaac|2382')).toBeInstanceOf(Blob);
    expect(pictogramRev.value).toBe(rev + 1);
    await keepPictogram(2382, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await hasPictogram(2382)).toBe(true);
    // Not stored here: nothing to draw, and no request (pictogramImage has no fetch at all).
    expect(await pictogramImage(999)).toBeNull();
  });
});

describe('the choice on the SD card', () => {
  it('keeps the number of a pictogram in the sticker of a folder and of a further card, and drops nonsense', () => {
    const c = newCatalog();
    c.folders['07'] = { title: 'Tiere', tracks: [], sticker: { pictogram: 2382 }, addedAt: 1, updatedAt: 1 };
    c.extraCards = [{ id: 'e', label: 'Teil 2', folder: 7, mode: 8, special: 1, special2: 2, sticker: { pictogram: 7114, title: 'Katzen' } }];
    const back = parseCatalog(serializeCatalog(c))!;
    expect(back.folders['07'].sticker?.pictogram).toBe(2382);
    expect(back.extraCards[0].sticker).toEqual({ pictogram: 7114, title: 'Katzen' });
    for (const bad of [-1, 0, 1.5, '2382', 1e9]) {
      const raw = JSON.parse(serializeCatalog(c));
      raw.folders['07'].sticker = { pictogram: bad };
      expect(parseCatalog(JSON.stringify(raw))!.folders['07'].sticker, String(bad)).toBeUndefined();
    }
  });
});

describe('the licence', () => {
  it('names author, source and licence on the card', () => {
    expect(PICTOGRAM_CREDIT).toBe('Piktogramm: Sergio Palao, ARASAAC (arasaac.org), CC BY-NC-SA');
  });
});
