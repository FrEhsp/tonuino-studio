import { describe, expect, it } from 'vitest';
import { buildIndex } from '../../src/core/sources/build';
import { appOrigins } from '../../src/core/sources/cors';
import type { CatalogEntry, SourceCatalog } from '../../src/core/sources/types';
import { checkHosts, collectInputs, emptyState, GITLAB_RAW, ARCHIVE_METADATA } from '../../src/core/sources/collect';
import { Net, NetError, retryAfterSec, type CachedAnswer, type NetCache } from '../../src/core/sources/net';
import { visibleText } from '../../scripts/sources/pages';
import { fxBytes, fxText, realCatalog } from './sample';

interface Call {
  url: string;
  headers: Record<string, string>;
}

type Handler = (url: string, headers: Record<string, string>) => Response | Promise<Response>;

function fakeNet(handler: Handler, opts: { cache?: NetCache; maxBytes?: number } = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, headers });
    return handler(url, headers);
  }) as typeof fetch;
  const net = new Net({
    fetch: fetchFn,
    userAgent: 'TonUINO-Studio-Quellen/1.0 (+https://studio.example.de/kontakt)',
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    cache: opts.cache,
    maxBytes: opts.maxBytes,
  });
  return { net, calls, sleeps, tick: (ms: number) => (clock += ms) };
}

function memoryCache(): NetCache & { map: Map<string, CachedAnswer> } {
  const map = new Map<string, CachedAnswer>();
  return { map, get: (u) => map.get(u), set: (u, a) => void map.set(u, a) };
}

const text = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(status === 304 ? null : body, { status, headers });

describe('Net', () => {
  it('sends the User-Agent and asks conditionally; 304 answers come from the cache', async () => {
    const cache = memoryCache();
    const { net, calls } = fakeNet((_, h) => (h['if-none-match'] === '"v1"' ? text('', 304) : text('<rss>eins</rss>', 200, { etag: '"v1"' })), { cache });
    expect(await net.text('https://feed.example/a.xml')).toBe('<rss>eins</rss>');
    expect(await net.text('https://feed.example/a.xml')).toBe('<rss>eins</rss>');
    expect(calls[0].headers['user-agent']).toBe('TonUINO-Studio-Quellen/1.0 (+https://studio.example.de/kontakt)');
    expect(calls[1].headers['if-none-match']).toBe('"v1"');
  });

  it('only talks https, also after redirects', async () => {
    const { net } = fakeNet((url) => (url.endsWith('/alt') ? new Response(null, { status: 301, headers: { location: 'http://feed.example/neu' } }) : text('x')));
    await expect(net.text('http://feed.example/a.xml')).rejects.toThrow('Nur HTTPS');
    await expect(net.text('https://feed.example/alt')).rejects.toThrow('Weiterleitung ohne HTTPS');
  });

  it('follows https redirects by hand', async () => {
    const { net, calls } = fakeNet((url) => (url === 'https://a.example/x' ? new Response(null, { status: 302, headers: { location: '/y' } }) : text('ziel')));
    expect(await net.text('https://a.example/x')).toBe('ziel');
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/x', 'https://a.example/y']);
  });

  it('waits as long as a busy server asks, three tries at most', async () => {
    let n = 0;
    const { net, sleeps } = fakeNet(() => (++n < 3 ? text('', 429, { 'retry-after': '2' }) : text('endlich')));
    expect(await net.text('https://busy.example/x')).toBe('endlich');
    expect(sleeps).toEqual([2000, 2000]);
    const always = fakeNet(() => text('', 503));
    await expect(always.net.text('https://busy.example/x')).rejects.toMatchObject({ status: 503 });
    expect(always.sleeps).toEqual([60_000, 60_000]);
  });

  it('keeps a second between two archive.org requests', async () => {
    const { net, sleeps, tick } = fakeNet(() => text('{}'));
    await net.text('https://archive.org/metadata/a');
    tick(300);
    await net.text('https://archive.org/metadata/b');
    await net.text('https://other.example/c');
    expect(sleeps).toEqual([700]);
  });

  it('refuses answers over the size cap', async () => {
    const { net } = fakeNet(() => text('x'.repeat(2000)), { maxBytes: 1000 });
    await expect(net.text('https://big.example/a')).rejects.toThrow(NetError);
  });

  it('reads the first bytes with Range and the total size from both kinds of answer', async () => {
    const mp3 = fxBytes('gitlab/gsb_de-0001_tall.mp3');
    const partial = fakeNet(() => new Response(mp3.slice(0, 16384), { status: 206, headers: { 'content-range': `bytes 0-16383/${mp3.length}` } }));
    const a = await partial.net.head('https://gitlab.com/x', 16384);
    expect(partial.calls[0].headers.range).toBe('bytes=0-16383');
    expect([a.status, a.data.length, a.total]).toEqual([206, 16384, 452051]);
    const whole = fakeNet(() => new Response(mp3, { status: 200, headers: { 'content-length': String(mp3.length) } }));
    const b = await whole.net.head('https://gitlab.com/x', 16384);
    expect([b.status, b.data.length, b.total]).toEqual([200, 16384, 452051]);
  });

  it('records a redirect chain with Origin "null" after leaving the first origin', async () => {
    const { net, calls } = fakeNet((url) =>
      url.startsWith('https://archive.org/')
        ? new Response(null, { status: 302, headers: { location: 'https://dn1.ca.archive.org/0/items/x/a.mp3', 'access-control-allow-origin': '*' } })
        : new Response('ID3', { status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/mpeg' } }),
    );
    const hops = await net.chain('https://archive.org/download/x/a.mp3', 'tauri://localhost');
    expect(hops.map((h) => h.status)).toEqual([302, 200]);
    expect(calls.map((c) => c.headers.origin)).toEqual(['tauri://localhost', 'null']);
    expect(calls.every((c) => c.headers.range === undefined)).toBe(true);
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterSec('120', 0)).toBe(120);
    expect(retryAfterSec('Mon, 05 Oct 2026 04:02:00 GMT', Date.parse('2026-10-05T04:00:00Z'))).toBe(120);
    expect(retryAfterSec(null, 0)).toBeUndefined();
  });
});

const GSB_REF = (realCatalog().entries.find((e) => e.id === 'global-storybooks-de') as Extract<CatalogEntry, { type: 'gitlab-gsb' }>).ref;

/** Answers from the fixtures, like the real services would give them. */
function fixtureServer(): Handler {
  const tree = [
    { id: 'b1', path: 'de/0001', type: 'tree' },
    { id: 'blob-0001', path: 'de/0001/de-0001_tall.mp3', type: 'blob' },
    { id: 'p1', path: 'de/0001/mp3/01.mp3', type: 'blob' },
  ];
  const tree2 = [{ id: 'blob-0002', path: 'de/0002/de-0002_animals.mp3', type: 'blob' }];
  return (url, headers) => {
    if (url === 'https://radioklops.podigee.io/feed/mp3') return text(fxText('feeds/radioklops.xml'));
    if (url === ARCHIVE_METADATA('jamendo-139374')) return text(fxText('archive/jamendo-139374.metadata.json'));
    if (url.startsWith('https://gitlab.com/api/v4/projects/6909116/repository/tree')) {
      const page = new URL(url).searchParams.get('page');
      return page === '1' ? text(JSON.stringify(tree), 200, { 'x-next-page': '2' }) : text(JSON.stringify(tree2), 200, { 'x-next-page': '' });
    }
    for (const [path, file] of [
      ['de/0001/de-0001_tall.mp3', 'gitlab/gsb_de-0001_tall.mp3'],
      ['de/0002/de-0002_animals.mp3', 'gitlab/gsb_de-0002_animals.mp3'],
    ]) {
      if (url === GITLAB_RAW(6909116, path, GSB_REF)) {
        const data = fxBytes(file);
        expect(headers.range).toBe('bytes=0-16383');
        // 0002 answers with the whole file, as observed.
        return path.includes('0002')
          ? new Response(data, { status: 200, headers: { 'content-length': String(data.length) } })
          : new Response(data.slice(0, 16384), { status: 206, headers: { 'content-range': `bytes 0-16383/${data.length}` } });
      }
    }
    return text('nicht gefunden', 404);
  };
}

function smallCatalog(): SourceCatalog {
  const c = realCatalog();
  const pick = (id: string) => c.entries.find((e) => e.id === id) as CatalogEntry;
  return { ...c, entries: [pick('radio-klops'), pick('jamendo-139374-eckhardt'), pick('global-storybooks-de'), pick('ohrka')] };
}

describe('collectInputs', () => {
  it('fetches feed, album metadata and story heads; drops the uploader; reuses unchanged stories', async () => {
    const state = emptyState();
    const first = fakeNet(fixtureServer());
    const got = await collectInputs(smallCatalog(), { net: first.net, include: ['active', 'review'], state });
    expect(typeof got.feeds['radio-klops']).toBe('string');
    expect(got.archive['jamendo-139374']).toMatchObject({ metadata: expect.any(Object) });
    expect(JSON.stringify(got.archive)).not.toContain('example.invalid');
    const stories = got.gsb['global-storybooks-de'];
    if (stories instanceof Error) throw stories;
    expect(stories.map((s) => [s.id, s.title, s.size, s.durationSec, s.year])).toEqual([
      ['0001', 'Ein sehr großer Mann', 452051, 49, '2017'],
      ['0002', 'Sieh Dir die Tiere an!', 251062, 28, '2017'],
    ]);
    expect(state.gsb['de/0001/de-0001_tall.mp3'].blob).toBe('blob-0001');

    const second = fakeNet(fixtureServer());
    await collectInputs(smallCatalog(), { net: second.net, include: ['active', 'review'], state });
    expect(second.calls.some((c) => c.url.includes('/raw?'))).toBe(false);

    const { index } = buildIndex(smallCatalog(), { now: new Date('2026-10-05T04:00:00Z'), ...got, hosts: {}, released: [], include: ['active', 'review'] });
    expect(index.entries.find((e) => e.id === 'global-storybooks-de')!.items.map((i) => i.key)).toEqual(['global-storybooks-de/0001', 'global-storybooks-de/0002']);
  });

  it('keeps the checksum archive.org lists for each file', async () => {
    const meta = JSON.parse(fxText('archive/jamendo-139374.metadata.json')) as { files: Record<string, unknown>[] };
    meta.files[0].sha1 = 'a'.repeat(40);
    const c = realCatalog();
    const album = c.entries.find((e) => e.id === 'jamendo-139374-eckhardt') as CatalogEntry;
    const { net } = fakeNet((url) => (url === ARCHIVE_METADATA('jamendo-139374') ? text(JSON.stringify(meta)) : text('', 404)));
    const got = await collectInputs({ ...c, entries: [album] }, { net, include: ['active', 'review'], state: emptyState() });
    const files = (got.archive['jamendo-139374'] as { files: { sha1?: string }[] }).files;
    expect(files[0].sha1).toBe('a'.repeat(40));
  });

  it('keeps a failure per entry instead of stopping', async () => {
    const { net } = fakeNet(() => text('kaputt', 500));
    const got = await collectInputs(smallCatalog(), { net, include: ['active', 'review'], state: emptyState() });
    expect(got.feeds['radio-klops']).toBeInstanceOf(Error);
    expect(got.archive['jamendo-139374']).toBeInstanceOf(Error);
    expect(got.gsb['global-storybooks-de']).toBeInstanceOf(Error);
  });
});

describe('checkHosts', () => {
  const index = buildIndex(
    { ...realCatalog(), entries: [] },
    { now: new Date(), feeds: {}, archive: {}, gsb: {}, hosts: {}, released: [], include: [] },
  ).index;
  const withFiles = {
    ...index,
    entries: [
      { id: 'a', type: 'podcast', items: [{ files: [{ url: 'https://good.example/new.mp3' }] }, { files: [{ url: 'https://good.example/old.mp3' }] }] },
      { id: 'b', type: 'podcast', items: [{ files: [{ url: 'https://nocors.example/a.mp3' }] }] },
      { id: 'c', type: 'podcast', items: [{ files: [{ url: 'https://gone.example/a.mp3' }] }] },
      { id: 'd', type: 'podcast', items: [{ files: [{ url: 'https://flaky.example/a.mp3' }] }] },
    ],
  } as unknown as typeof index;

  it('checks the newest file of each host from every app origin', async () => {
    const state = emptyState();
    state.hosts['flaky.example'] = 'browser';
    const { net, calls } = fakeNet((url) => {
      if (url.startsWith('https://good.example/') || url.startsWith('https://flaky.example/')) return new Response('x', { status: 200, headers: { 'access-control-allow-origin': '*' } });
      if (url.startsWith('https://nocors.example/')) return new Response('x', { status: 200 });
      return new Response('weg', { status: 404 });
    });
    const results = await checkHosts(withFiles, { net, origins: appOrigins('https://studio.example.de'), state });
    expect(Object.fromEntries(results.map((r) => [r.host, r.verdict]))).toEqual({
      'good.example': 'direct',
      'nocors.example': 'browser',
      'gone.example': 'unverified',
      'flaky.example': 'unstable',
    });
    expect(calls.filter((c) => c.url.startsWith('https://good.example/')).map((c) => c.url)).toEqual(Array(4).fill('https://good.example/new.mp3'));
    expect(state.hosts).toMatchObject({ 'good.example': 'direct', 'nocors.example': 'browser', 'flaky.example': 'direct' });
  });

  it('blocks a host whose files are passed on through a measurement service or to a host the entry does not allow', async () => {
    const { net } = fakeNet((url) => {
      if (url === 'https://good.example/new.mp3') return new Response(null, { status: 302, headers: { location: 'https://dts.podtrac.com/redirect.mp3/good.example/new.mp3', 'access-control-allow-origin': '*' } });
      if (url === 'https://nocors.example/a.mp3') return new Response(null, { status: 302, headers: { location: 'https://cdn.elsewhere.example/a.mp3', 'access-control-allow-origin': '*' } });
      if (url === 'https://flaky.example/a.mp3') return new Response(null, { status: 302, headers: { location: 'https://ia800300.flaky.example/a.mp3', 'access-control-allow-origin': '*' } });
      return new Response('x', { status: 200, headers: { 'access-control-allow-origin': '*' } });
    });
    const results = await checkHosts(withFiles, { net, origins: appOrigins('https://studio.example.de'), state: emptyState(), allowed: (host) => [host] });
    const byHost = Object.fromEntries(results.map((r) => [r.host, r]));
    expect(byHost['good.example']).toMatchObject({ verdict: 'blocked', failures: ['Weiterleitung über den Messdienst dts.podtrac.com'] });
    expect(byHost['nocors.example']).toMatchObject({ verdict: 'blocked', failures: ['Weiterleitung zu cdn.elsewhere.example, der für diesen Eintrag nicht erlaubt ist'] });
    // Below an allowed host is fine (archive.org hands out files from ia800300.us.archive.org).
    expect(byHost['flaky.example'].verdict).toBe('direct');
  });

  it('without a web address nothing counts as direct', async () => {
    const { net, calls } = fakeNet(() => new Response('x'));
    const results = await checkHosts(withFiles, { net, origins: [], state: emptyState() });
    expect(results.every((r) => r.verdict === 'unverified')).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('weekly terms check', () => {
  it('compares the visible text only', () => {
    expect(visibleText('<html><script>var t=1</script><p>Nutzung&nbsp;privat</p>\n<!-- 2026 --></html>')).toBe('Nutzung privat');
  });
});
