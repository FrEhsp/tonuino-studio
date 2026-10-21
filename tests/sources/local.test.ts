/**
 * The list built on the user's computer (the desktop app): the
 * daily job's code over the catalogue that comes with the app, through the
 * backend's fetch. Here the backend is a fake that answers from the saved
 * fixtures and refuses every host the Rust allowlist does not name.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLocalList, loadLocalKept, loadLocalList, LOCAL_REFRESH_MS, readLocalCache, type LocalListOptions, type LocalStore } from '../../src/core/sources/local';
import type { SourceCatalog } from '../../src/core/sources/types';
import { NOW, fxText, realCatalog } from './sample';

/** ALLOWED_HOSTS of src-tauri/src/sources_net.rs: [host, hosts below it count too]. */
function rustAllowlist(): [string, boolean][] {
  const src = readFileSync(new URL('../../src-tauri/src/sources_net.rs', import.meta.url), 'utf8');
  const block = /pub const ALLOWED_HOSTS: &\[\(&str, bool\)\] = &\[([\s\S]*?)\n\];/.exec(src)?.[1] ?? '';
  return [...block.matchAll(/\("([a-z0-9.-]+)", (true|false)\)/g)].map((m) => [m[1], m[2] === 'true']);
}

const ALLOWED = rustAllowlist();
const allowed = (host: string) => ALLOWED.some(([h, below]) => host === h || (below && host.endsWith('.' + h)));

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const entryOf = (c: SourceCatalog, id: string) => c.entries.find((e) => e.id === id)!;
const feedOf = (c: SourceCatalog, id: string) => {
  const e = entryOf(c, id);
  return e.type === 'podcast' ? e.feedUrl : '';
};

/**
 * Copies of the Kakadu podcast under other ids, their feeds on the same host (the only feed
 * host the allowlist still names since the ARD shows are read from ARD Sounds): one for each
 * answer the tests need besides the clean one.
 */
const TEST_FEEDS: Record<string, string> = {
  'test-fremder-host': 'https://www.kakadu.de/test-fremder-host.xml',
  'test-gemischt': 'https://www.kakadu.de/test-gemischt.xml',
  'test-wartung': 'https://www.kakadu.de/test-wartung.xml',
};
const FEED_IDS = ['kakadu-kinderhoerspiel', ...Object.keys(TEST_FEEDS)];

/**
 * The catalogue without its link entries (OHRKA, the ARD links): they need no network and
 * would be in every list; these tests are about what the sources answer.
 */
function networkCatalog(): SourceCatalog {
  const c = clone(realCatalog());
  for (const e of c.entries) if (e.type === 'link' && e.status === 'active') Object.assign(e, { status: 'review', featured: undefined });
  const kakadu = entryOf(c, 'kakadu-kinderhoerspiel');
  for (const [id, feedUrl] of Object.entries(TEST_FEEDS)) {
    // The copy with the foreign host names another media host than the files in its feed.
    c.entries.push({ ...clone(kakadu), id, feedUrl, ...(id === 'test-fremder-host' ? { mediaHosts: ['media.example.de'] } : {}) } as SourceCatalog['entries'][number]);
  }
  return c;
}

const KAKADU = fxText('feeds/kakadu-kinderhoerspiel-118.xml');

type Answer = Response | Error;

/**
 * The backend as the list builder sees it: answers by URL, redirects are
 * not followed, hosts outside the Rust allowlist are refused like
 * sources_fetch refuses them ("not-allowed").
 */
function fakeBackend(answers: (url: string, headers: Headers) => Answer | undefined) {
  const urls: string[] = [];
  const refused: string[] = [];
  let clock = NOW.getTime();
  const fetch = async (url: string, init: RequestInit) => {
    const host = new URL(url).hostname;
    if (!allowed(host)) {
      refused.push(url);
      throw Object.assign(new Error(`${host} is not a source of the list`), { code: 'not-allowed' });
    }
    urls.push(url);
    const a = answers(url, new Headers(init.headers)) ?? new Response('nicht da', { status: 404 });
    if (a instanceof Error) throw a;
    return a;
  };
  return {
    urls,
    refused,
    fetch,
    now: () => clock,
    tick: (ms: number) => (clock += ms),
    sleep: async (ms: number) => void (clock += ms),
  };
}

function memoryStore(text: string | null = null): LocalStore & { text: string | null; writes: number } {
  const s = {
    text,
    writes: 0,
    read: async () => s.text,
    write: async (t: string) => {
      s.text = t;
      s.writes++;
    },
  };
  return s;
}

const xml = (t: string) => new Response(t, { status: 200, headers: { 'content-type': 'application/rss+xml' } });

/** The answers of a day on which most sources answer from the fixtures. */
function fixtureDay(catalog: SourceCatalog) {
  return (url: string): Answer | undefined => {
    // Kakadu: three clean episodes on the entry's own media host.
    if (url === feedOf(catalog, 'kakadu-kinderhoerspiel')) return xml(KAKADU);
    // Files on a host the entry does not name.
    if (url === feedOf(catalog, 'test-fremder-host')) return xml(KAKADU);
    // A trailer, an episode from 16 and one marked explicit.
    if (url === feedOf(catalog, 'test-gemischt')) {
      return xml(
        KAKADU.replace('<title>Kinderhörspiel - Das Mammut in der Grube</title>', '<title>Trailer: Das Mammut in der Grube</title>')
          .replace('Ein Wombat reist um die halbe Welt', 'Ab 16 Jahren. Ein Wombat reist um die halbe Welt')
          .replace('<itunes:duration>22:24</itunes:duration>', '<itunes:duration>22:24</itunes:duration><itunes:explicit>true</itunes:explicit>'),
      );
    }
    // The server is down today.
    if (url === feedOf(catalog, 'test-wartung')) return new Response('Wartung', { status: 500 });
    return undefined;
  };
}

function options(catalog: SourceCatalog, backend: ReturnType<typeof fakeBackend>, store = memoryStore(), extra: Partial<LocalListOptions> = {}): LocalListOptions {
  return {
    catalog,
    released: JSON.parse(readFileSync(new URL('../../sources/released.json', import.meta.url), 'utf8')) as unknown,
    fetch: backend.fetch,
    store,
    now: backend.now,
    sleep: backend.sleep,
    isOnline: () => true,
    ...extra,
  };
}

describe('the list built on this computer', () => {
  it('reads the Rust allowlist', () => {
    expect(ALLOWED.map(([h]) => h)).toEqual(['www.kakadu.de', 'www.ardsounds.de', 'www.ohrka.de']);
  });

  it('asks only the allowed hosts, for every released entry', async () => {
    const catalog = networkCatalog();
    const backend = fakeBackend(() => new Response('nicht da', { status: 404 }));
    const built = await buildLocalList(options(catalog, backend));
    expect(backend.refused).toEqual([]);
    for (const id of FEED_IDS) expect(backend.urls, id).toContain(feedOf(catalog, id));
    // Nothing for entries that are not active.
    expect(backend.urls.some((u) => u.includes('srf.ch') || u.includes('gitlab.com'))).toBe(false);
    expect(built.report.failures.map((f) => f.entry).sort()).toEqual([...FEED_IDS].sort());
    expect(built.index.entries).toEqual([]);
    expect(built.gateErrors).toContain('Liste ohne Einträge.');
    expect(built.answered).toBe(true);
  });

  it('builds the list with the daily job’s checks: hosts, trailers, ages, explicit', async () => {
    const catalog = networkCatalog();
    const backend = fakeBackend(fixtureDay(catalog));
    const built = await buildLocalList(options(catalog, backend));
    expect(backend.refused).toEqual([]);
    expect(built.gateErrors).toEqual([]);
    expect(built.index.entries.map((e) => e.id)).toEqual(['kakadu-kinderhoerspiel']);

    // A released podcast: its titles with the files of its feed, saved on the publisher's page.
    const kakadu = built.index.entries.find((e) => e.id === 'kakadu-kinderhoerspiel')!;
    expect(kakadu.items).toHaveLength(3);
    expect(kakadu.delivery).toBe('browser');
    expect(kakadu.editPolicy).toBe('unchanged');
    expect(kakadu.reviewedAt).toBe('2026-10-13');
    expect(kakadu.items.every((it) => it.files[0].url.startsWith('https://podcast-mp3.dradio.de/'))).toBe(true);

    // Files of a host the entry does not name are never listed.
    expect(built.report.rejected.filter((r) => r.entry === 'test-fremder-host').map((r) => r.reason)).toEqual(Array(3).fill('Host nicht erlaubt: podcast-mp3.dradio.de'));
    // Released does not mean unchecked: the trailer, the title from 16 and the explicit one stay out.
    expect(built.report.rejected.filter((r) => r.entry === 'test-gemischt').map((r) => r.reason)).toEqual([
      expect.stringMatching(/Trailer/),
      'Altersangabe ab 16',
      'Der Anbieter markiert die Folge als „explicit“',
    ]);
    expect(built.report.failures.map((f) => f.entry)).toContain('test-wartung');
  });

  it('keeps the list for a day, then builds it again; a failed build keeps the last one', async () => {
    const catalog = networkCatalog();
    let online = true;
    const day = fixtureDay(catalog);
    const backend = fakeBackend((url) => (online ? day(url) : new TypeError('Failed to fetch')));
    const store = memoryStore();
    const o = options(catalog, backend, store, { isOnline: () => online });

    expect(await loadLocalKept(o)).toBeUndefined();
    const first = await loadLocalList(o);
    expect(first).toMatchObject({ status: 'ready', from: 'network', stale: false, offline: false });
    expect(store.writes).toBe(1);
    const asked = backend.urls.length;
    expect(readLocalCache(store.text)?.index.entries).toHaveLength(1);

    // The same day: no request.
    backend.tick(LOCAL_REFRESH_MS - 60_000);
    expect(await loadLocalList(o)).toMatchObject({ status: 'ready', from: 'network' });
    expect(backend.urls.length).toBe(asked);
    expect(await loadLocalKept(o)).toMatchObject({ status: 'ready', from: 'network' });

    // A day later, offline: the last list as an older copy.
    backend.tick(120_000);
    online = false;
    const offline = await loadLocalList(o);
    expect(offline).toMatchObject({ status: 'ready', from: 'cache', offline: true });
    expect(offline.status === 'ready' && offline.index.entries.map((e) => e.id)).toEqual(['kakadu-kinderhoerspiel']);
    expect(store.writes).toBe(1);
    expect(await loadLocalKept(o)).toMatchObject({ status: 'ready', from: 'cache' });

    // Back online: a new build, kept again.
    online = true;
    expect(await loadLocalList(o)).toMatchObject({ status: 'ready', from: 'network' });
    expect(store.writes).toBe(2);
    expect(backend.urls.length).toBeGreaterThan(asked);
  });

  it('says offline when nothing answered and there is no list yet', async () => {
    const backend = fakeBackend(() => new TypeError('Failed to fetch'));
    const r = await loadLocalList(options(networkCatalog(), backend));
    expect(r).toEqual({ status: 'error', reason: 'unavailable', offline: true, answered: false });
  });

  it('says the sources did not answer when the connection works', async () => {
    const backend = fakeBackend(() => new Response('Wartung', { status: 503, headers: { 'retry-after': '1' } }));
    const r = await loadLocalList(options(networkCatalog(), backend));
    expect(r).toEqual({ status: 'error', reason: 'unavailable', offline: false, answered: true });
  });

  it('builds once when two callers ask at the same time', async () => {
    const catalog = networkCatalog();
    const backend = fakeBackend(fixtureDay(catalog));
    const store = memoryStore();
    const [a, b] = await Promise.all([loadLocalList(options(catalog, backend, store)), loadLocalList(options(catalog, backend, store))]);
    expect(a).toBe(b);
    expect(store.writes).toBe(1);
  });

  it('never keeps a list that fails the publishing gates, and ignores a damaged copy', async () => {
    expect(readLocalCache('{')).toBeUndefined();
    expect(readLocalCache(JSON.stringify({ format: 2, builtAt: NOW.toISOString(), index: {}, state: {} }))).toBeUndefined();
    const catalog = networkCatalog();
    const day = fixtureDay(catalog);
    let emptyFeed = false;
    const backend = fakeBackend((url) => (emptyFeed && url === feedOf(catalog, 'kakadu-kinderhoerspiel') ? xml('<rss version="2.0"><channel><title>NDR</title></channel></rss>') : day(url)));
    const store = memoryStore();
    const o = options(catalog, backend, store);
    await loadLocalList(o);
    const kept = store.text;
    // The next day the Kakadu feed is empty: 3 titles become none (publishGates).
    backend.tick(LOCAL_REFRESH_MS + 1);
    emptyFeed = true;
    const r = await loadLocalList(o);
    expect(r).toMatchObject({ status: 'ready', from: 'cache', offline: false });
    expect(r.status === 'ready' && r.index.entries.map((e) => e.id)).toEqual(['kakadu-kinderhoerspiel']);
    expect(store.text).toBe(kept);
  });

  it('says the sources did not answer when a damaged catalogue stops the build', async () => {
    const catalog = clone(realCatalog()) as unknown as { entries: Record<string, unknown>[] };
    catalog.entries[0].pageUrl = 'http://unsicher.example/';
    const backend = fakeBackend(() => undefined);
    await expect(buildLocalList(options(catalog as unknown as SourceCatalog, backend))).rejects.toThrow(/Katalog fehlerhaft/);
    expect(backend.urls).toEqual([]);
    expect(await loadLocalList(options(catalog as unknown as SourceCatalog, backend))).toEqual({ status: 'error', reason: 'unavailable', offline: false, answered: false });
  });
});
