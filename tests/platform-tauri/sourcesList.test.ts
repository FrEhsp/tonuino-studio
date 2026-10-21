import { describe, expect, it } from 'vitest';
import { createTauriPlatform } from '../../src/platform/tauri';
import { TauriSourcesList } from '../../src/platform/tauri/sourcesList';
import { Net } from '../../src/core/sources/net';
import { fakeBridge, FakeIpc, frame } from './fake-ipc';

const enc = new TextEncoder();

describe('the list of "Entdecken" built on this computer (desktop bridge)', () => {
  it('fetches through sources_fetch and passes only the headers the backend takes', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('sources_fetch', () => frame({ status: 200, statusText: 'OK', headers: [['ETag', '"v1"'], ['Content-Type', 'application/json']] }, enc.encode('{"books":[]}')));
    const list = new TauriSourcesList(bridge);
    const res = await list.fetch('https://www.ardsounds.de/sendung/x/urn:ard:show:1/', {
      headers: { 'User-Agent': 'egal', 'If-None-Match': '"v0"', Cookie: 'a=b' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"v1"');
    expect(await res.json()).toEqual({ books: [] });
    expect(ipc.calls[0].args).toEqual({ url: 'https://www.ardsounds.de/sendung/x/urn:ard:show:1/', headers: { 'if-none-match': '"v0"' }, body: true });
  });

  it('passes a byte range, for the files the app loads itself in pieces', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('sources_fetch', () => frame({ status: 206, statusText: 'Partial Content', headers: [['Content-Range', 'bytes 0-3/10']] }, enc.encode('ID3x')));
    const res = await new TauriSourcesList(bridge).fetch('https://www.ohrka.de/fileadmin/audio/a.mp3', { headers: { range: 'bytes=0-3' } });
    expect(res.status).toBe(206);
    expect(ipc.calls[0].args).toEqual({ url: 'https://www.ohrka.de/fileadmin/audio/a.mp3', headers: { range: 'bytes=0-3' }, body: true });
  });

  it('asks only for status and headers in the file check (a request with an Origin)', async () => {
    const { ipc, bridge } = fakeBridge();
    const net = new Net({ fetch: new TauriSourcesList(bridge).fetch as typeof fetch, userAgent: 'x', sleep: async () => undefined });
    ipc.on('sources_fetch', (args) => {
      const url = (args as { url: string }).url;
      return url.startsWith('https://archive.org/')
        ? frame({ status: 302, statusText: 'Found', headers: [['Location', 'https://dn1.ca.archive.org/0/items/x/a.mp3'], ['Access-Control-Allow-Origin', '*']] }, new Uint8Array(0))
        : frame({ status: 200, statusText: 'OK', headers: [['Access-Control-Allow-Origin', '*'], ['Content-Length', '13089937']] }, new Uint8Array(0));
    });
    const hops = await net.chain('https://archive.org/download/x/a.mp3', 'tauri://localhost');
    expect(hops.map((h) => h.status)).toEqual([302, 200]);
    expect(ipc.calls.map((c) => c.args)).toEqual([
      { url: 'https://archive.org/download/x/a.mp3', headers: { origin: 'tauri://localhost' }, body: false },
      { url: 'https://dn1.ca.archive.org/0/items/x/a.mp3', headers: { origin: 'null' }, body: false },
    ]);
  });

  it('turns a refused host into an error, as Net expects from a failed request', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('sources_fetch', () => {
      throw { code: 'not-allowed', detail: 'example.org is not a source of the list' };
    });
    await expect(new TauriSourcesList(bridge).fetch('https://example.org/feed.xml')).rejects.toMatchObject({ code: 'not-allowed' });
  });

  it('keeps the list in the app’s data folder', async () => {
    const { ipc, bridge } = fakeBridge();
    let kept: string | null = null;
    ipc.on('sources_cache_read', () => kept);
    ipc.on('sources_cache_write', (args) => void (kept = (args as { text: string }).text));
    const list = new TauriSourcesList(bridge);
    expect(await list.readCache()).toBeNull();
    await list.writeCache('{"format":1}');
    expect(await list.readCache()).toBe('{"format":1}');
  });

  it('is part of the desktop platform (the tests build it)', () => {
    const p = createTauriPlatform({ ipc: new FakeIpc(), os: 'linux' });
    expect(p.sourcesList).toBeInstanceOf(TauriSourcesList);
  });
});
