import { describe, expect, it, vi } from 'vitest';
import { jsonpUrl, routedFetch } from '../../src/core/covers/route';

const ok = (body: unknown = { ok: true }) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const moved = (to: string) => new Response(null, { status: 307, headers: { Location: to } });
type Fn = (url: string, init?: RequestInit) => Promise<Response>;

describe('the way of a cover request', () => {
  it('goes through the backend for the services, the WebView for anything else', async () => {
    const native = vi.fn<Fn>(async () => ok({ from: 'native' }));
    const web = vi.fn<Fn>(async () => ok({ from: 'web' }));
    const f = routedFetch({ native, web });
    expect(await (await f('https://api.deezer.com/search/album?q=x')).json()).toEqual({ from: 'native' });
    expect(await (await f('https://example.org/bild.jpg')).json()).toEqual({ from: 'web' });
    expect(native).toHaveBeenCalledTimes(1);
  });

  it('follows redirects through the backend, only to the services', async () => {
    const native = vi.fn<Fn>(async (url) =>
      url.includes('coverartarchive.org') ? moved('https://ia800300.us.archive.org/1/items/x/front.jpg') : url.includes('archive.org') ? ok({ img: 1 }) : moved('https://example.org/'),
    );
    const web = vi.fn<Fn>(async () => ok({ from: 'web' }));
    const f = routedFetch({ native, web });
    expect(await (await f('https://coverartarchive.org/release-group/x/front-500')).json()).toEqual({ img: 1 });
    expect(native.mock.calls.map(([u]) => u)).toEqual(['https://coverartarchive.org/release-group/x/front-500', 'https://ia800300.us.archive.org/1/items/x/front.jpg']);
    // A redirect away from the services: the WebView decides instead.
    expect(await (await f('https://musicbrainz.org/ws/2/release/?query=x')).json()).toEqual({ from: 'web' });
  });

  it('takes the WebView when the backend fails, and keeps to it for that service', async () => {
    const native = vi.fn<Fn>(async () => Promise.reject(Object.assign(new Error('TLS: unknown issuer'), { code: 'other' })));
    const web = vi.fn<Fn>(async () => ok());
    const f = routedFetch({ native, web });
    await f('https://itunes.apple.com/search?term=x');
    await f('https://itunes.apple.com/search?term=y');
    expect(native).toHaveBeenCalledTimes(1);
    expect(web).toHaveBeenCalledTimes(2);
  });

  it('asks iTunes and Deezer by JSONP when the WebView may not read their answer', async () => {
    const web = vi.fn<Fn>(async () => Promise.reject(new TypeError('Failed to fetch')));
    const jsonp = vi.fn(async (url: string) => ({ url }));
    const f = routedFetch({ web, jsonp });
    expect(await (await f('https://api.deezer.com/search/album?q=x&limit=12')).json()).toEqual({ url: 'https://api.deezer.com/search/album?q=x&limit=12&output=jsonp' });
    expect(await (await f('https://itunes.apple.com/search?term=x')).json()).toEqual({ url: 'https://itunes.apple.com/search?term=x' });
    // Not for MusicBrainz (it sends CORS headers) or pictures.
    await expect(f('https://musicbrainz.org/ws/2/release/?query=x')).rejects.toThrow('Failed to fetch');
    await expect(f('https://e-cdns-images.dzcdn.net/images/cover/x/1000x1000.jpg')).rejects.toThrow('Failed to fetch');
    expect(jsonp).toHaveBeenCalledTimes(2);
  });

  it('asks Deezer by JSONP at once without the backend: its answers never have a CORS header', async () => {
    const web = vi.fn<Fn>(async () => ok({ from: 'web' }));
    const jsonp = vi.fn(async (url: string) => ({ url }));
    const f = routedFetch({ web, jsonp });
    expect(await (await f('https://api.deezer.com/search/album?q=x')).json()).toEqual({ url: 'https://api.deezer.com/search/album?q=x&output=jsonp' });
    // The fetch that could only fail (and be logged as an error) is not tried; iTunes sends CORS headers mostly.
    expect(web).not.toHaveBeenCalled();
    expect(await (await f('https://itunes.apple.com/search?term=x')).json()).toEqual({ from: 'web' });
    // The backend fails: the same.
    const g = routedFetch({ native: async () => Promise.reject(new Error('no connection')), web, jsonp });
    await g('https://api.deezer.com/search/album?q=y');
    expect(web).toHaveBeenCalledTimes(1);
    expect(jsonp).toHaveBeenCalledTimes(2);
  });

  it('stops at once when the caller aborts', async () => {
    const abort = () => Promise.reject(new DOMException('x', 'AbortError'));
    const web = vi.fn<Fn>(async () => ok());
    const f = routedFetch({ native: abort, web, jsonp: async () => ({}) });
    await expect(f('https://api.deezer.com/x', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(web).not.toHaveBeenCalled();
  });

  it('knows which URLs have a JSONP form', () => {
    expect(jsonpUrl('https://api.deezer.com/search/album?q=x')).toBe('https://api.deezer.com/search/album?q=x&output=jsonp');
    expect(jsonpUrl('https://itunes.apple.com/lookup?id=1')).toBe('https://itunes.apple.com/lookup?id=1');
    expect(jsonpUrl('https://musicbrainz.org/ws/2/release/?query=x')).toBeNull();
  });
});
