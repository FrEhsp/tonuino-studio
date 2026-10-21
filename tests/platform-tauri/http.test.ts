import { describe, expect, it } from 'vitest';
import { createFetch, plainHttp, timeoutFor, usesPlainHttp } from '../../src/platform/tauri/http';
import { fakeBridge, frame } from './fake-ipc';

const enc = new TextEncoder();

describe('desktop fetch', () => {
  it('sends http:// requests through http_plain and builds a Response', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('http_plain', () =>
      frame(
        { status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json'], ['X-Box', 'TonUINO']] },
        enc.encode('{"volume":15}'),
      ),
    );
    const res = await plainHttp(bridge, 'http://192.168.1.50/api/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"cmd":"play"}',
    });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.url).toBe('http://192.168.1.50/api/status');
    expect(res.headers.get('x-box')).toBe('TonUINO');
    expect(await res.json()).toEqual({ volume: 15 });

    const call = ipc.calls[0];
    expect(new TextDecoder().decode(call.args as Uint8Array)).toBe('{"cmd":"play"}');
    expect(call.headers!['x-method']).toBe('POST');
    expect(decodeURIComponent(call.headers!['x-url'])).toBe('http://192.168.1.50/api/status');
    expect(JSON.parse(decodeURIComponent(call.headers!['x-headers']))).toEqual({ 'content-type': 'application/json' });
    expect(Number(call.headers!['x-timeout'])).toBe(timeoutFor(14));
  });

  it('handles bodiless statuses and backend errors', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('http_plain', () => frame({ status: 204, statusText: 'No Content', headers: [] }, new Uint8Array(0)));
    const res = await plainHttp(bridge, 'http://10.0.0.7/x');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    ipc.on('http_plain', () => {
      throw { code: 'not-allowed', detail: 'example.com is not in the local network (93.184.215.14)' };
    });
    const err = await plainHttp(bridge, 'http://example.com/').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'not-allowed' });
    expect((err as Error).message).toMatch(/Heimnetz/);
  });

  it('routes only plain http of other origins to the backend', async () => {
    const page = 'tauri://localhost';
    expect(usesPlainHttp(new URL('http://192.168.4.1/'), page)).toBe(true);
    expect(usesPlainHttp(new URL('https://github.com/'), page)).toBe(false);
    expect(usesPlainHttp(new URL('http://tauri.localhost/assets/x.json'), 'http://tauri.localhost')).toBe(false);

    const { ipc, bridge } = fakeBridge();
    ipc.on('http_plain', () => frame({ status: 200, statusText: 'OK', headers: [] }, enc.encode('box')));
    const native: string[] = [];
    const doFetch = createFetch(bridge, async (input) => {
      native.push(input);
      return new Response('web');
    });
    expect(await (await doFetch('https://api.github.com/repos/x')).text()).toBe('web');
    expect(await (await doFetch('http://192.168.4.1/status')).text()).toBe('box');
    expect(native).toEqual(['https://api.github.com/repos/x']);
  });

  it('rejects with the abort reason when the signal fires', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('http_plain', () => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = plainHttp(bridge, 'http://192.168.1.2/slow', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('gives big uploads more time', () => {
    expect(timeoutFor(0)).toBe(10_000);
    expect(timeoutFor(5_000_000)).toBe(110_000);
    expect(timeoutFor(1e12)).toBe(3_600_000);
  });
});
