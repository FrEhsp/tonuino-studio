import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.mock('../../src/platform/web/idb', () => ({
  kv: {
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    keys: async (p = '') => [...store.keys()].filter((k) => k.startsWith(p)),
  },
}));

let created = 0;
beforeEach(() => {
  vi.resetModules();
  store.clear();
  created = 0;
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => `blob:${++created}`, revokeObjectURL: () => undefined }));
});

const image = (bytes = 10) => new Response(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), { headers: { 'content-type': 'image/jpeg' } });

describe('cover cache', () => {
  it('fetches a cover once, stores it and shows it from the store afterwards', async () => {
    const fetch = vi.fn(async () => image());
    vi.stubGlobal('fetch', fetch);
    const c = await import('../../src/features/sources/coverCache');
    expect(c.coverSrc('https://archive.org/a.jpg')).toBeUndefined();
    await c.ensureCover('https://archive.org/a.jpg');
    expect(c.coverSrc('https://archive.org/a.jpg')).toBe('blob:1');
    expect(store.has('cover|https://archive.org/a.jpg')).toBe(true);

    vi.resetModules();
    const again = await import('../../src/features/sources/coverCache');
    await again.ensureCover('https://archive.org/a.jpg');
    expect(again.coverSrc('https://archive.org/a.jpg')).toMatch(/^blob:/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to the address itself when the host refuses a copy, and remembers the host', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetch);
    const c = await import('../../src/features/sources/coverCache');
    await c.ensureCover('https://example.org/1.png');
    await c.ensureCover('https://example.org/2.png');
    expect(c.coverSrc('https://example.org/1.png')).toBe('https://example.org/1.png');
    expect(c.coverSrc('https://example.org/2.png')).toBe('https://example.org/2.png');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it('hands the picture itself to the add flow: the stored copy, else fetched once', async () => {
    const fetch = vi.fn(async () => image(12));
    vi.stubGlobal('fetch', fetch);
    const c = await import('../../src/features/sources/coverCache');
    const got = await c.coverBlob('https://archive.org/b.jpg');
    expect(got?.size).toBe(12);
    expect(got?.type).toBe('image/jpeg');
    expect(store.has('cover|https://archive.org/b.jpg')).toBe(true);
    expect((await c.coverBlob('https://archive.org/b.jpg'))?.size).toBe(12);
    expect(fetch).toHaveBeenCalledTimes(1);
    // A host that allows no copy: no picture, never a drawn one.
    fetch.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await c.coverBlob('https://example.org/c.png')).toBeUndefined();
  });

  it('removes stored covers that left the list', async () => {
    store.set('cover|https://a/x.jpg', new Blob(['x']));
    store.set('cover|https://a/y.jpg', new Blob(['y']));
    store.set('other', 1);
    const c = await import('../../src/features/sources/coverCache');
    await c.pruneCovers(['https://a/x.jpg']);
    expect([...store.keys()].sort()).toEqual(['cover|https://a/x.jpg', 'other']);
  });

  it('a broken stored picture is dropped and not shown again', async () => {
    store.set('cover|https://a/x.jpg', new Blob(['x']));
    const c = await import('../../src/features/sources/coverCache');
    await c.ensureCover('https://a/x.jpg');
    const src = c.coverSrc('https://a/x.jpg')!;
    c.coverFailed('https://a/x.jpg', src);
    expect(c.coverSrc('https://a/x.jpg')).toBe('');
    await Promise.resolve();
    expect(store.has('cover|https://a/x.jpg')).toBe(false);
  });
});
