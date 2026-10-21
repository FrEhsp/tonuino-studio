import { describe, expect, it } from 'vitest';
import type { SmallStore } from '../../src/core/sources/load';
import { archiveIdOf, checkReach, expired, expiredItems, goneItems, probe, reachTargets, REACH_GONE_MS, REACH_KEY, REACH_OK_MS, readReachCache, withoutGone } from '../../src/core/sources/reach';
import type { IndexEntry, SourceIndex } from '../../src/core/sources/types';

class MemoryStore implements SmallStore {
  readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const base = {
  publisher: 'Test',
  categories: ['hoerbuch' as const],
  ages: { min: 6, source: 'editor' as const },
  language: 'de' as const,
  rights: { kind: 'public-domain' as const, basis: 'commons' as const },
  editPolicy: 'normal' as const,
  checkedAt: '2026-10-05T04:00:00.000Z',
};

const book: IndexEntry = {
  ...base,
  id: 'album-buch',
  type: 'archive-album',
  title: 'Ein Buch',
  delivery: 'direct',
  pageUrl: 'https://archive.org/details/buch_lieder',
  items: [
    {
      key: 'album-buch/buch_lieder',
      title: 'Ein Buch',
      category: 'hoerbuch',
      files: [
        { url: 'https://archive.org/download/buch_lieder/teil_01_64kb.mp3', name: 'teil_01_64kb.mp3' },
        { url: 'https://archive.org/download/buch_lieder/teil_02_64kb.mp3', name: 'teil_02_64kb.mp3' },
      ],
    },
  ],
};

const podcast: IndexEntry = {
  ...base,
  id: 'podcast',
  type: 'podcast',
  title: 'Ein Podcast',
  delivery: 'direct',
  pageUrl: 'https://pod.example.org/',
  items: ['a', 'b'].map((g) => ({ key: `podcast/${g}`, title: g, category: 'hoerspiel' as const, files: [{ url: `https://media.example.org/${g}.mp3`, name: `${g}.mp3` }] })),
};

const onPage: IndexEntry = { ...podcast, id: 'sender', delivery: 'browser', items: [{ ...podcast.items[0], key: 'sender/a' }] };

const LIST: SourceIndex = { format: 1, generatedAt: base.checkedAt, staleAfter: '2026-10-19T04:00:00.000Z', entries: [book, podcast, onPage], blocked: [] };

const NOW = Date.parse('2026-10-09T10:00:00Z');

describe('what the app asks', () => {
  it('asks archive.org once per item, other files by their first file, nothing for titles saved on the publisher’s page', () => {
    expect(reachTargets(LIST)).toEqual([
      { id: 'archive:buch_lieder', url: 'https://archive.org/metadata/buch_lieder/metadata/identifier', how: 'archive', items: ['album-buch/buch_lieder'] },
      { id: 'file:podcast/a', url: 'https://media.example.org/a.mp3', how: 'head', items: ['podcast/a'] },
      { id: 'file:podcast/b', url: 'https://media.example.org/b.mp3', how: 'head', items: ['podcast/b'] },
    ]);
    expect(archiveIdOf('https://ia800300.us.archive.org/download/x_y/z.mp3')).toBe('x_y');
    expect(archiveIdOf('https://evil.example/download/x/z.mp3')).toBeUndefined();
  });

  it('only a clear answer counts as gone', async () => {
    const [archive, file] = reachTargets(LIST);
    const answer = (r: Response | Error) => () => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r));
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    expect(await probe(archive, answer(json({ result: 'buch_lieder' })))).toBe('ok');
    expect(await probe(archive, answer(json({ error: "Couldn't locate item 'buch_lieder'" })))).toBe('gone');
    expect(await probe(archive, answer(json({})))).toBe('gone');
    expect(await probe(archive, answer(json({ error: 'Service unavailable' })))).toBe('unknown');
    expect(await probe(archive, answer(json({}, 503)))).toBe('unknown');
    expect(await probe(archive, answer(new Response('<html>', { status: 200 })))).toBe('unknown');
    expect(await probe(file, answer(new Response(null, { status: 404 })))).toBe('gone');
    expect(await probe(file, answer(new Response(null, { status: 410 })))).toBe('gone');
    expect(await probe(file, answer(new Response(null, { status: 200 })))).toBe('ok');
    expect(await probe(file, answer(new Response(null, { status: 500 })))).toBe('unknown');
    expect(await probe(file, answer(new Response(null, { status: 429 })))).toBe('unknown');
    expect(await probe(file, answer(new TypeError('Failed to fetch')))).toBe('unknown');
    // A server that does not answer in time: do not know.
    expect(await probe(file, (_u, init) => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abort')))), { timeoutMs: 20 })).toBe('unknown');
  });
});

describe('hiding and remembering', () => {
  it('hides gone titles and sources without titles, keeps the rest; asks again after a while', async () => {
    const store = new MemoryStore();
    let now = NOW;
    const asked: string[] = [];
    const fetch = (url: string) => {
      asked.push(url);
      if (url.includes('archive.org')) return Promise.resolve(new Response('{}'));
      if (url.endsWith('/a.mp3')) return Promise.reject(new TypeError('offline'));
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const cache = await checkReach(LIST, { fetch, storage: store, now: () => now });
    const gone = goneItems(LIST, cache, now);
    expect([...gone]).toEqual(['album-buch/buch_lieder']);
    const shown = withoutGone(LIST, gone);
    expect(shown.entries.map((e) => e.id)).toEqual(['podcast', 'sender']);
    expect(withoutGone(LIST, new Set())).toBe(LIST);
    // Stored: a second opening asks only what had no answer (the network error).
    expect(JSON.parse(store.getItem(REACH_KEY)!).results).toHaveProperty(['archive:buch_lieder']);
    asked.length = 0;
    await checkReach(LIST, { fetch, storage: store, now: () => now });
    expect(asked).toEqual(['https://media.example.org/a.mp3']);
    // A day later the gone title is asked about again: back online, it shows again.
    now += REACH_GONE_MS + 1;
    expect(goneItems(LIST, readReachCache(store), now).size).toBe(0);
    asked.length = 0;
    await checkReach(LIST, { fetch, storage: store, now: () => now });
    expect(asked).toEqual(['https://archive.org/metadata/buch_lieder/metadata/identifier', 'https://media.example.org/a.mp3']);
    // An answer "online" holds for a week.
    now += REACH_OK_MS;
    asked.length = 0;
    await checkReach(LIST, { fetch, storage: store, now: () => now, max: 1 });
    expect(asked).toHaveLength(1);
  });

  it('hides titles whose time at the publisher is over from that day on, without asking', () => {
    const dated: SourceIndex = {
      ...LIST,
      entries: [book, { ...onPage, items: [{ ...onPage.items[0], until: '2026-10-09' }, { ...onPage.items[0], key: 'sender/b', until: '2026-10-10' }] }],
    };
    expect(expired({ until: '2026-10-10' }, NOW)).toBe(false);
    expect(expired({ until: '2026-10-09' }, NOW)).toBe(true);
    expect(expired({}, NOW)).toBe(false);
    expect([...expiredItems(dated, NOW)]).toEqual(['sender/a']);
    // The next day the last title of the source is over as well: the source goes.
    const later = NOW + REACH_GONE_MS;
    expect(withoutGone(dated, expiredItems(dated, later)).entries.map((e) => e.id)).toEqual(['album-buch']);
    // Not something to ask about: the publisher's page does not let the app read the answer.
    expect(reachTargets(dated).map((t) => t.id)).toEqual(['archive:buch_lieder']);
  });

  it('reads a broken or foreign store as empty', () => {
    const store = new MemoryStore();
    store.setItem(REACH_KEY, 'kaputt');
    expect(readReachCache(store).results).toEqual({});
    store.setItem(REACH_KEY, JSON.stringify({ format: 1, results: { 'archive:x': { v: 'weg', at: 1 }, 'archive:y': { v: 'gone', at: 5 } } }));
    expect(readReachCache(store).results).toEqual({ 'archive:y': { v: 'gone', at: 5 } });
    expect(readReachCache(null).results).toEqual({});
  });
});
