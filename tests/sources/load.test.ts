import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOCKED_KEY, INDEX_KEY, INDEX_TIMEOUT_MS, indexUrl, loadIndex, loadKept, MAX_CACHED_CHARS, storedBlocked, type LoadOptions, type SmallStore } from '../../src/core/sources/load';
import type { SourceIndex } from '../../src/core/sources/types';
import { loadSample, NOW } from './sample';

const URL_ = 'https://studio.example.de/quellen/index-v1.json';
const EMPTY_SNAPSHOT = { format: 1, generatedAt: '2026-10-05T04:00:00.000Z', staleAfter: '2026-10-19T04:00:00.000Z', entries: [], blocked: [] };

class MemoryStore implements SmallStore {
  readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

class BrokenStore implements SmallStore {
  getItem(): string | null {
    throw new DOMException('blocked', 'SecurityError');
  }
  setItem() {
    throw new DOMException('full', 'QuotaExceededError');
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function options(over: Partial<LoadOptions> = {}): LoadOptions & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const base: LoadOptions = {
    url: URL_,
    fetch: async () => json(loadSample()),
    storage: new MemoryStore(),
    snapshot: async () => EMPTY_SNAPSHOT,
    now: NOW.getTime(),
    isOnline: () => true,
  };
  const o = { ...base, ...over };
  const fetch = o.fetch;
  return {
    ...o,
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return fetch(url, init);
    },
  };
}

const withBlocked = (index: SourceIndex, blocked: string[]): SourceIndex => ({ ...index, blocked });
const ids = (index: SourceIndex) => index.entries.map((e) => e.id);

describe('indexUrl', () => {
  const page = 'https://studio.example.de/app/#/entdecken';
  it('takes the list next to the web app', () => {
    expect(indexUrl({ kind: 'web', pageUrl: page, base: '/' })).toBe('https://studio.example.de/quellen/index-v1.json');
    expect(indexUrl({ kind: 'web', pageUrl: page, base: '/app/' })).toBe('https://studio.example.de/app/quellen/index-v1.json');
  });

  it('loads from the web address in the desktop app, only over https', () => {
    expect(indexUrl({ kind: 'desktop', pageUrl: 'tauri://localhost/', webOrigin: 'https://studio.example.de/' })).toBe(URL_);
    expect(indexUrl({ kind: 'desktop', pageUrl: 'tauri://localhost/', webOrigin: 'http://studio.example.de' })).toBeUndefined();
    expect(indexUrl({ kind: 'desktop', pageUrl: 'tauri://localhost/' })).toBeUndefined();
  });

  it('lets an explicit address win, also a relative one', () => {
    expect(indexUrl({ kind: 'web', pageUrl: page, base: '/', override: '/quellen/index-preview.json' })).toBe('https://studio.example.de/quellen/index-preview.json');
    expect(indexUrl({ kind: 'desktop', pageUrl: 'tauri://localhost/', override: 'https://preview.example.de/x.json' })).toBe('https://preview.example.de/x.json');
    expect(indexUrl({ kind: 'web', pageUrl: page, override: 'javascript:alert(1)' })).toBeUndefined();
  });
});

describe('loadIndex', () => {
  it('loads from the network without cookies and past the HTTP cache, and keeps a copy', async () => {
    const o = options();
    const r = await loadIndex(o);
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.from).toBe('network');
    expect(r.stale).toBe(false);
    expect(r.offline).toBe(false);
    expect(r.index.entries).toHaveLength(6);
    expect(o.calls).toHaveLength(1);
    expect(o.calls[0].url).toBe(URL_);
    expect(o.calls[0].init).toMatchObject({ credentials: 'omit', cache: 'no-cache' });
    expect(o.calls[0].init.headers).toBeUndefined();
    const store = o.storage as MemoryStore;
    expect(JSON.parse(store.data.get(INDEX_KEY)!).entries).toHaveLength(6);
    expect(store.data.get(BLOCKED_KEY)).toBe(JSON.stringify(loadSample().blocked));
  });

  it('hides blocked entries and items at once', async () => {
    const klopsItem = loadSample().entries.find((e) => e.id === 'radio-klops')!.items[0].key;
    const sample = withBlocked(loadSample(), ['ohrka', klopsItem]);
    const r = await loadIndex(options({ fetch: async () => json(sample) }));
    if (r.status !== 'ready') throw new Error(r.status);
    expect(ids(r.index)).not.toContain('ohrka');
    const klops = r.index.entries.find((e) => e.id === 'radio-klops')!;
    expect(klops.items).toHaveLength(6);
  });

  it('falls back to the kept copy and applies the newest kill switch to it', async () => {
    const storage = new MemoryStore();
    storage.setItem(INDEX_KEY, JSON.stringify(loadSample()));
    storage.setItem(BLOCKED_KEY, JSON.stringify(['srf-kids-hoerspiele']));
    const r = await loadIndex(options({ storage, fetch: async () => json('Server Error', 500) }));
    if (r.status !== 'ready') throw new Error(r.status);
    expect(r.from).toBe('cache');
    expect(r.offline).toBe(false);
    expect(ids(r.index)).not.toContain('srf-kids-hoerspiele');
    expect(r.index.entries).toHaveLength(5);
  });

  it('says offline only when the network failed and the browser is offline', async () => {
    const storage = new MemoryStore();
    storage.setItem(INDEX_KEY, JSON.stringify(loadSample()));
    const failing = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    };
    const offline = await loadIndex(options({ storage, fetch: failing, isOnline: () => false }));
    expect(offline).toMatchObject({ status: 'ready', from: 'cache', offline: true });
    const online = await loadIndex(options({ storage, fetch: failing, isOnline: () => true }));
    expect(online).toMatchObject({ status: 'ready', from: 'cache', offline: false });
  });

  it('takes the list that came with the app when there is no copy, and marks it as old', async () => {
    const snapshot = { ...loadSample(), staleAfter: '2026-09-01T00:00:00.000Z' };
    const r = await loadIndex(options({ fetch: async () => json('<!doctype html><html></html>'), snapshot: async () => snapshot }));
    expect(r).toMatchObject({ status: 'ready', from: 'snapshot', stale: true });
  });

  it('marks a list from the network as old after its date', async () => {
    const r = await loadIndex(options({ now: Date.parse('2026-10-20T00:00:00Z') }));
    expect(r).toMatchObject({ status: 'ready', from: 'network', stale: true });
  });

  it('shows an empty list from the network, but never an empty copy instead of an error', async () => {
    const r = await loadIndex(options({ fetch: async () => json(EMPTY_SNAPSHOT) }));
    expect(r).toMatchObject({ status: 'ready', from: 'network' });
    if (r.status === 'ready') expect(r.index.entries).toEqual([]);
    const storage = new MemoryStore();
    storage.setItem(INDEX_KEY, JSON.stringify(EMPTY_SNAPSHOT));
    const failed = await loadIndex(options({ storage, fetch: async () => json('nope', 404), isOnline: () => false }));
    expect(failed).toEqual({ status: 'error', reason: 'unavailable', offline: true, answered: true });
  });

  it('asks for an update when the list is newer than the app', async () => {
    const r = await loadIndex(options({ fetch: async () => json({ ...loadSample(), format: 2 }) }));
    expect(r).toEqual({ status: 'error', reason: 'needs-update', offline: false });
  });

  it('does not keep lists that are too big for localStorage', async () => {
    const big = loadSample();
    big.entries[0] = { ...big.entries[0], blurb: 'x'.repeat(MAX_CACHED_CHARS) };
    const storage = new MemoryStore();
    const r = await loadIndex(options({ storage, fetch: async () => json(big) }));
    expect(r.status).toBe('ready');
    expect(storage.data.has(INDEX_KEY)).toBe(false);
    expect(storage.data.get(BLOCKED_KEY)).toBe(JSON.stringify(loadSample().blocked));
  });

  it('works when storage is blocked or full', async () => {
    const r = await loadIndex(options({ storage: new BrokenStore() }));
    expect(r).toMatchObject({ status: 'ready', from: 'network' });
    const none = await loadIndex(options({ storage: new BrokenStore(), fetch: async () => json('x', 503), snapshot: async () => loadSample() }));
    expect(none).toMatchObject({ status: 'ready', from: 'snapshot' });
    expect(storedBlocked(new BrokenStore())).toEqual([]);
  });

  it('skips a damaged copy', async () => {
    const storage = new MemoryStore();
    storage.setItem(INDEX_KEY, '{"format":1,');
    storage.setItem(BLOCKED_KEY, '{"no":"array"}');
    const r = await loadIndex(options({ storage, fetch: async () => json('x', 500), snapshot: async () => loadSample() }));
    expect(r).toMatchObject({ status: 'ready', from: 'snapshot' });
  });

  it('does not touch the network without an address', async () => {
    const o = options({ url: undefined, snapshot: async () => loadSample() });
    const r = await loadIndex(o);
    expect(o.calls).toHaveLength(0);
    expect(r).toMatchObject({ status: 'ready', from: 'snapshot', offline: false });
  });

  it('reports an unusable list as unavailable', async () => {
    const r = await loadIndex(options({ fetch: async () => json({ format: 1 }) }));
    expect(r).toEqual({ status: 'error', reason: 'unavailable', offline: false, answered: true });
  });

  it('tells a server that answered without a list from a network that failed', async () => {
    // Before the first list is published: the address is not there.
    const missing = await loadIndex(options({ fetch: async () => json('Not Found', 404) }));
    expect(missing).toEqual({ status: 'error', reason: 'unavailable', offline: false, answered: true });
    // A host that answers every address with the app's start page.
    const page = await loadIndex(options({ fetch: async () => new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } }) }));
    expect(page).toMatchObject({ status: 'error', reason: 'unavailable', answered: true });
    const failed = await loadIndex(options({ fetch: async () => Promise.reject(new TypeError('Failed to fetch')) }));
    expect(failed).toEqual({ status: 'error', reason: 'unavailable', offline: false, answered: false });
  });

  it('stops when the page is left', async () => {
    const ctrl = new AbortController();
    const o = options({
      signal: ctrl.signal,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Abgebrochen', 'AbortError')));
        }),
    });
    const p = loadIndex(o);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('a list request that does not answer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const keptStore = () => {
    const storage = new MemoryStore();
    storage.setItem(INDEX_KEY, JSON.stringify(loadSample()));
    storage.setItem(BLOCKED_KEY, JSON.stringify(['ohrka']));
    return storage;
  };
  /** A server that takes the request and never answers, and ignores the cancel. */
  const hanging = (seen: AbortSignal[]) => (_url: string, init: RequestInit) => {
    if (init.signal) seen.push(init.signal);
    return new Promise<Response>(() => undefined);
  };

  it('gives up after a while and shows the kept copy, as after any network failure', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const p = loadIndex(options({ storage: keptStore(), fetch: hanging(signals) }));
    await vi.advanceTimersByTimeAsync(INDEX_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r).toMatchObject({ status: 'ready', from: 'cache', offline: false });
    if (r.status === 'ready') expect(ids(r.index)).not.toContain('ohrka');
    // The request itself is cancelled, too.
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
  });

  it('also gives up on an answer whose body stops coming', async () => {
    const stalled = new Response(new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('{"format":1,')) }), { status: 200 });
    const r = await loadIndex(options({ storage: keptStore(), fetch: async () => stalled, timeoutMs: 20 }));
    expect(r).toMatchObject({ status: 'ready', from: 'cache' });
  });

  it('takes the list that came with the app, or says unavailable, when there is no copy', async () => {
    const withSnapshot = await loadIndex(options({ fetch: hanging([]), timeoutMs: 20, snapshot: async () => loadSample() }));
    expect(withSnapshot).toMatchObject({ status: 'ready', from: 'snapshot' });
    const nothing = await loadIndex(options({ fetch: hanging([]), timeoutMs: 20 }));
    expect(nothing).toEqual({ status: 'error', reason: 'unavailable', offline: false, answered: false });
  });

  it('still stops at once when the caller cancels', async () => {
    const ctrl = new AbortController();
    const p = loadIndex(options({ storage: keptStore(), fetch: hanging([]), signal: ctrl.signal }));
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('loadKept', () => {
  it('reads the kept copy without the network and applies the newest kill switch', async () => {
    const storage = new MemoryStore();
    storage.setItem(INDEX_KEY, JSON.stringify(loadSample()));
    storage.setItem(BLOCKED_KEY, JSON.stringify(['srf-kids-hoerspiele']));
    const r = await loadKept({ storage, snapshot: async () => EMPTY_SNAPSHOT, now: NOW.getTime() });
    expect(r).toMatchObject({ status: 'ready', from: 'cache', offline: false });
    expect(r && ids(r.index)).not.toContain('srf-kids-hoerspiele');
  });

  it('falls back to the list in the app and gives nothing for an empty one', async () => {
    expect(await loadKept({ storage: new MemoryStore(), snapshot: async () => loadSample(), now: NOW.getTime() })).toMatchObject({ from: 'snapshot' });
    expect(await loadKept({ storage: new MemoryStore(), snapshot: async () => EMPTY_SNAPSHOT, now: NOW.getTime() })).toBeUndefined();
  });

  it('takes the list in the app when it is newer than the kept copy', async () => {
    const sample = loadSample();
    const older: SourceIndex = { ...sample, generatedAt: '2026-09-01T04:00:00.000Z', entries: sample.entries.slice(0, 1) };
    const storage = new MemoryStore();
    storage.setItem(INDEX_KEY, JSON.stringify(older));
    const newer = await loadKept({ storage, snapshot: async () => sample, now: NOW.getTime() });
    expect(newer).toMatchObject({ from: 'snapshot' });
    expect(newer && ids(newer.index)).toEqual(ids(sample));
    // A copy as new as the list in the app, or newer, stays the one shown.
    expect(await loadKept({ storage, snapshot: async () => ({ ...sample, generatedAt: older.generatedAt }), now: NOW.getTime() })).toMatchObject({ from: 'cache' });
    // Also after a failed network load.
    expect(await loadIndex(options({ storage, fetch: async () => json('x', 503), snapshot: async () => sample }))).toMatchObject({ status: 'ready', from: 'snapshot' });
  });
});
