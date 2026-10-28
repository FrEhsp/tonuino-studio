/**
 * The web app's service worker (src/pwa/sw.template.js, filled in by
 * scripts/pwa.ts), run in a sandbox with a made-up cache and network: the
 * page comes from the server first and from the cache only offline, files
 * below assets/ from the browser online (the worker keeps a copy) and from
 * the cache offline, everything else passes by, and an old version's files
 * go when a new one takes over.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildVersion, headTags, serviceWorkerSource, shellFiles } from '../../scripts/pwa';
import { isNewer, pageVersion } from '../../src/app/pwa';

const TEMPLATE = readFileSync(new URL('../../src/pwa/sw.template.js', import.meta.url), 'utf8');
const SCOPE = 'https://studio.example.de/app/';

type Req = { url: string; method: string; mode?: string };
const key = (r: Req | string) => (typeof r === 'string' ? r : r.url);

class FakeCache {
  readonly map = new Map<string, Response>();
  constructor(private readonly net: (r: Req | string) => Promise<Response>) {}
  async add(r: Req) {
    const res = await this.net(r);
    if (!res.ok) throw new TypeError('bad response');
    this.map.set(key(r), res);
  }
  async put(r: Req | string, res: Response) {
    this.map.set(key(r), res);
  }
  async match(r: Req | string) {
    return this.map.get(key(r))?.clone();
  }
  async keys() {
    return [...this.map.keys()].map((url) => ({ url, method: 'GET' }));
  }
  async delete(r: Req | string) {
    return this.map.delete(key(r));
  }
}

/** A service worker of one version in a sandbox; `online` switches the made-up network. */
function worker(version: string, assets: string[], shell: string[], stores = new Map<string, FakeCache>()) {
  const listeners = new Map<string, (e: unknown) => void>();
  const net = { online: true, asked: [] as string[] };
  const fetch = async (r: Req | string) => {
    net.asked.push(key(r));
    if (!net.online) throw new TypeError('offline');
    return new Response(`net:${key(r)}`, { status: 200 });
  };
  const open = (name: string) => {
    let c = stores.get(name);
    if (!c) stores.set(name, (c = new FakeCache(fetch)));
    return c;
  };
  const caches = {
    open: async (name: string) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (r: Req | string, o: { cacheName: string }) => stores.get(o.cacheName)?.match(r),
  };
  let skipped = false;
  let claimed = false;
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    registration: { scope: SCOPE, navigationPreload: { enable: async () => undefined } },
    location: { origin: new URL(SCOPE).origin },
    clients: { claim: async () => void (claimed = true) },
    skipWaiting: () => void (skipped = true),
  };
  // The copy of a file is kept a moment after it was loaded (KEEP_AFTER_MS): here at once.
  const setTimeout = (fn: () => void) => void Promise.resolve().then(fn);
  runInNewContext(serviceWorkerSource(TEMPLATE, version, shell, assets), { self, caches, fetch, URL, Request, Response, Promise, Set, setTimeout });
  const lifecycle = async (type: 'install' | 'activate') => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  /** A request through the worker; undefined when it lets the request pass by (after what it does meanwhile). */
  const request = async (path: string, init: { mode?: string; method?: string } = {}) => {
    let answer: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    listeners.get('fetch')!({
      request: { url: new URL(path, SCOPE).href, method: init.method ?? 'GET', mode: init.mode ?? 'cors' },
      respondWith: (p: Promise<Response>) => (answer = p),
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      preloadResponse: Promise.resolve(undefined),
    });
    const res = answer ? await answer : undefined;
    await Promise.all(waits);
    return res?.text();
  };
  const message = (data: unknown) => {
    let got: unknown;
    listeners.get('message')!({ data, ports: [{ postMessage: (v: unknown) => (got = v) }] });
    return got;
  };
  return { net, stores, lifecycle, request, message, skipped: () => skipped, claimed: () => claimed };
}

describe('the service worker of the web app', () => {
  const shell = ['index.html', 'favicon.svg', 'assets/index-a.js'];
  const assets = ['assets/index-a.js', 'assets/Sticker-b.js'];

  it('keeps the first page at install and opens it without internet', async () => {
    const w = worker('v1', assets, shell);
    await w.lifecycle('install');
    await w.lifecycle('activate');
    expect(w.claimed()).toBe(true);
    w.net.asked.length = 0;
    // Online the page comes from the server, as without a service worker: a reload brings the newest version.
    expect(await w.request('./', { mode: 'navigate' })).toBe(`net:${SCOPE}`);
    expect(await w.request('index.html?als=handy', { mode: 'navigate' })).toBe(`net:${SCOPE}index.html?als=handy`);
    // Online the page's files come from the browser, as without a service worker (WebKit drew the first frame later through it).
    expect(await w.request('assets/index-a.js')).toBeUndefined();
    w.net.online = false;
    expect(await w.request('./', { mode: 'navigate' })).toBe(`net:${SCOPE}index.html`);
    // Without a connection the first page's own files come from the cache.
    w.net.asked.length = 0;
    expect(await w.request('assets/index-a.js')).toBe(`net:${SCOPE}assets/index-a.js`);
    expect(w.net.asked).toEqual([]);
    // Online again: the page from the server, its files from the browser.
    w.net.online = true;
    expect(await w.request('./', { mode: 'navigate' })).toBe(`net:${SCOPE}`);
    expect(await w.request('assets/index-a.js')).toBeUndefined();
  });

  it('keeps the other files below assets/ once loaded, and lets everything else pass by', async () => {
    const w = worker('v1', assets, shell);
    await w.lifecycle('install');
    await w.lifecycle('activate');
    w.net.asked.length = 0;
    // Loaded by the browser; the worker keeps a copy (fetched once, from the browser's cache by then), only once.
    expect(await w.request('assets/Sticker-b.js')).toBeUndefined();
    expect(await w.request('assets/Sticker-b.js')).toBeUndefined();
    expect(w.net.asked).toEqual([`${SCOPE}assets/Sticker-b.js`]);
    // Without a connection it comes from that copy.
    w.net.online = false;
    expect(await w.request('./', { mode: 'navigate' })).toBe(`net:${SCOPE}index.html`);
    expect(await w.request('assets/Sticker-b.js')).toBe(`net:${SCOPE}assets/Sticker-b.js`);
    w.net.online = true;
    expect(await w.request('./', { mode: 'navigate' })).toBe(`net:${SCOPE}`);
    // The list of "Entdecken", other servers, other pages, writes: not the worker's business.
    expect(await w.request('quellen/index-v1.json')).toBeUndefined();
    expect(await w.request('https://cover.example.org/a.jpg')).toBeUndefined();
    expect(await w.request('hilfe/ablage.webp', { mode: 'navigate' })).toBeUndefined();
    expect(await w.request('assets/index-a.js', { method: 'POST' })).toBeUndefined();
    expect(await w.request('/anderes/assets/x.js')).toBeUndefined();
  });

  it('tells its version, waits for "neu laden", and clears the old version when it takes over', async () => {
    const stores = new Map<string, FakeCache>();
    const old = worker('v1', assets, shell, stores);
    await old.lifecycle('install');
    await old.lifecycle('activate');
    await old.request('assets/Sticker-b.js');
    expect(old.message({ type: 'version' })).toBe('v1');

    const next = worker('v2', ['assets/index-c.js'], ['index.html', 'assets/index-c.js'], stores);
    await next.lifecycle('install');
    expect(next.skipped()).toBe(false);
    next.message({ type: 'skip-waiting' });
    expect(next.skipped()).toBe(true);
    await next.lifecycle('activate');
    expect([...stores.keys()].sort()).toEqual(['tonuino-studio-assets', 'tonuino-studio-v2']);
    expect(await stores.get('tonuino-studio-assets')!.keys()).toEqual([]);
  });
});

describe('the build of the service worker', () => {
  it('finds the files the page loads itself', () => {
    const html =
      '<script type="module" crossorigin src="./assets/index-a.js"></script><link rel="modulepreload" href="./assets/rt-b.js"><link rel="stylesheet" href="./assets/index-c.css"><link rel="preload" as="font" href="./assets/f-d.woff2"><link rel="icon" href="favicon.svg">';
    expect(shellFiles(html)).toEqual(['assets/f-d.woff2', 'assets/index-a.js', 'assets/index-c.css', 'assets/rt-b.js']);
  });

  it('gets a new version when any file changes, and keeps it when nothing does', () => {
    const v = buildVersion(['assets/b.js', 'assets/a.js'], '<html>');
    expect(buildVersion(['assets/a.js', 'assets/b.js'], '<html>')).toBe(v);
    expect(buildVersion(['assets/a.js', 'assets/b2.js'], '<html>')).not.toBe(v);
    expect(buildVersion(['assets/a.js', 'assets/b.js'], '<html lang="de">')).not.toBe(v);
    expect(serviceWorkerSource(TEMPLATE, v, [], [])).toContain(`const VERSION = "${v}";`);
    expect(headTags(v)).toContain(`<meta name="tonuino-build" content="${v}" />`);
    expect(headTags(v)).toContain('rel="manifest"');
  });

  it('says "neu laden" only when another version waits', () => {
    const doc = { querySelector: () => ({ getAttribute: () => 'v1' }) } as unknown as Document;
    expect(pageVersion(doc)).toBe('v1');
    expect(isNewer('v1', 'v2')).toBe(true);
    expect(isNewer('v1', 'v1')).toBe(false);
    expect(isNewer('v1', undefined)).toBe(false);
    // The dev server and the tests have no version: never a notice.
    expect(isNewer('', 'v2')).toBe(false);
  });
});
