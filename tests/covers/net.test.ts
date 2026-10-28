import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAnswers,
  eitherSignal,
  FormatError,
  gates,
  HttpError,
  isDown,
  noteUnreachable,
  politeFetch,
  resetNet,
  retryDelay,
  serviceJson,
  ServiceDownError,
  ServiceGate,
  serviceOf,
  SERVICE_HOSTS,
  unreachableServices,
  type Limiter,
} from '../../src/core/covers/net';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const instant: Limiter = { wait: async () => undefined };

beforeEach(() => resetNet());
afterEach(() => vi.useRealTimers());

describe('services', () => {
  it('knows which service an address belongs to', () => {
    expect(serviceOf('https://itunes.apple.com/search?term=x')).toBe('itunes');
    expect(serviceOf('https://is3-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg')).toBe('itunes');
    expect(serviceOf('https://api.deezer.com/search/album?q=x')).toBe('deezer');
    expect(serviceOf('https://e-cdns-images.dzcdn.net/images/cover/x/1000x1000.jpg')).toBe('deezer');
    expect(serviceOf('https://cdn-images.dzcdn.net/images/cover/x/1000x1000.jpg')).toBe('deezer');
    expect(serviceOf('https://musicbrainz.org/ws/2/release/?query=x')).toBe('musicbrainz');
    expect(serviceOf('https://coverartarchive.org/release-group/x/front-500')).toBe('coverartarchive');
    expect(serviceOf('https://ia800300.us.archive.org/x.jpg')).toBe('coverartarchive');
    expect(serviceOf('https://example.org/')).toBeUndefined();
    expect(serviceOf('kein link')).toBeUndefined();
  });

  it('names the same hosts as the backend lets through (src-tauri/src/cover_net.rs)', () => {
    const rust = readFileSync(new URL('../../src-tauri/src/cover_net.rs', import.meta.url), 'utf8');
    const block = rust.slice(rust.indexOf('pub const COVER_HOSTS'), rust.indexOf('];', rust.indexOf('pub const COVER_HOSTS')));
    const allowed = [...block.matchAll(/\("([^"]+)", (true|false)\)/g)].map((m) => ({ host: m[1], below: m[2] === 'true' }));
    expect(allowed.length).toBeGreaterThan(5);
    const passes = (host: string) => allowed.some((a) => (a.below ? host.endsWith(`.${a.host}`) : host === a.host));
    for (const hosts of Object.values(SERVICE_HOSTS)) {
      for (const h of hosts) expect(passes(h.startsWith('*.') ? `x${h.slice(1)}` : h), h).toBe(true);
    }
  });
});

describe('ServiceGate', () => {
  it('gives the first turns at once and then one per interval, in order', async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = new ServiceGate(1000, 2);
    const times: number[] = [];
    const all = [0, 1, 2, 3].map((i) => gate.wait().then(() => times.push(Date.now()) && i));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await Promise.all(all)).toEqual([0, 1, 2, 3]);
    expect(times).toEqual([0, 0, 1000, 2000]);
  });

  it('lets a caller leave the queue, and the next one moves up', async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = new ServiceGate(1000);
    await gate.wait();
    const leave = new AbortController();
    const first = gate.wait(leave.signal);
    const second = gate.wait();
    expect(gate.waiting).toBe(2);
    leave.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(gate.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await second;
    expect(gate.waiting).toBe(0);
  });

  it('pauses the whole queue after a busy answer', async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = new ServiceGate(100, 4);
    gate.holdOff(3000);
    let done = false;
    void gate.wait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });

  it('keeps MusicBrainz to about one request a second', () => {
    expect(gates.musicbrainz.intervalMs).toBeGreaterThanOrEqual(1000);
    expect(gates.musicbrainz.burst).toBe(1);
  });
});

describe('polite requests', () => {
  it('asks again after 503 and 429, waiting as the service says', async () => {
    vi.useFakeTimers({ now: 0 });
    const answers = [json({}, 503, { 'Retry-After': '2' }), json({}, 429), json({ ok: 1 })];
    const fetchFn = vi.fn(async () => answers.shift()!);
    const gate = new ServiceGate(0, 1);
    const p = serviceJson('musicbrainz', 'https://musicbrainz.org/ws/2/x', { fetchFn, limiter: gate });
    await vi.advanceTimersByTimeAsync(1900);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // No Retry-After the second time: 4 s.
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toEqual({ ok: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('gives up after the retries and says why', async () => {
    const fetchFn = vi.fn(async () => json({}, 503));
    await expect(politeFetch('itunes', 'https://itunes.apple.com/x', { fetchFn, limiter: instant, retries: 0 })).rejects.toBeInstanceOf(HttpError);
    await expect(politeFetch('itunes', 'https://itunes.apple.com/x', { fetchFn: async () => json({}, 404), limiter: instant })).rejects.toMatchObject({ status: 404 });
  });

  it('waits at most 30 s, whatever the service asks', () => {
    const h = (v?: string) => ({ headers: new Headers(v ? { 'Retry-After': v } : {}) });
    expect(retryDelay(h('5'), 0)).toBe(5000);
    expect(retryDelay(h('3600'), 0)).toBe(30_000);
    expect(retryDelay(h(), 0)).toBe(2000);
    expect(retryDelay(h(), 2)).toBe(8000);
    expect(retryDelay(h('quatsch'), 1)).toBe(4000);
  });

  it('keeps answers and asks again only when told', async () => {
    const fetchFn = vi.fn(async () => json({ n: 1 }));
    const url = 'https://api.deezer.com/search/album?q=x';
    await serviceJson('deezer', url, { fetchFn, limiter: instant });
    expect(await serviceJson('deezer', url, { fetchFn, limiter: instant })).toEqual({ n: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await serviceJson('deezer', url, { fetchFn, limiter: instant, cache: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    clearAnswers();
    await serviceJson('deezer', url, { fetchFn, limiter: instant });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('counts a web filter page as no answer', async () => {
    const fetchFn = async () => new Response('<html>Diese Seite ist gesperrt</html>', { status: 200 });
    await expect(serviceJson('deezer', 'https://api.deezer.com/a', { fetchFn, limiter: instant })).rejects.toBeInstanceOf(FormatError);
    await expect(serviceJson('deezer', 'https://api.deezer.com/b', { fetchFn, limiter: instant })).rejects.toBeInstanceOf(FormatError);
    expect(isDown('deezer')).toBe(true);
  });

  it('leaves a service out for a while after it did not answer twice, and names its addresses', async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchFn = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    for (const _ of [1, 2]) await expect(politeFetch('deezer', 'https://api.deezer.com/x', { fetchFn, limiter: instant })).rejects.toBeInstanceOf(TypeError);
    await expect(politeFetch('deezer', 'https://api.deezer.com/x', { fetchFn, limiter: instant })).rejects.toBeInstanceOf(ServiceDownError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const list = unreachableServices();
    expect(list).toEqual([{ service: 'deezer', name: 'Deezer', hosts: expect.arrayContaining(['api.deezer.com', 'e-cdns-images.dzcdn.net']), down: true }]);
    // Ten minutes later it is asked again.
    vi.setSystemTime(11 * 60_000);
    expect(isDown('deezer')).toBe(false);
  });

  it('gives up a turn not yet come, but lets a request that is out finish', async () => {
    const skip = new AbortController();
    const never: Limiter = { wait: (signal) => new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))) };
    const waiting = politeFetch('deezer', 'https://api.deezer.com/x', { fetchFn: async () => json({}), limiter: never, skip: skip.signal });
    skip.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

    const out = new AbortController();
    let answer: (r: Response) => void = () => undefined;
    const sent = politeFetch('deezer', 'https://api.deezer.com/y', { fetchFn: () => new Promise((r) => (answer = r)), limiter: instant, skip: out.signal });
    await vi.waitFor(() => expect(answer).not.toBe(undefined));
    await new Promise((r) => setTimeout(r, 0));
    out.abort();
    answer(json({ ok: true }));
    expect((await sent).ok).toBe(true);
  });

  it('stops at once when the caller aborted before', async () => {
    const fetchFn = vi.fn(async () => json({}));
    await expect(politeFetch('itunes', 'https://itunes.apple.com/x', { fetchFn, limiter: instant, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).not.toHaveBeenCalled();
    noteUnreachable('itunes');
    expect(isDown('itunes')).toBe(false);
  });

  it('combines two signals', () => {
    const a = new AbortController();
    const b = new AbortController();
    const both = eitherSignal(a.signal, b.signal)!;
    expect(both.aborted).toBe(false);
    b.abort();
    expect(both.aborted).toBe(true);
    expect(eitherSignal(undefined, a.signal)).toBe(a.signal);
  });
});
