/**
 * The cover search through the desktop app's backend
 * (src-tauri/src/cover_net.rs, cargo feature "quellen", on by default):
 * GET over https to the hosts of iTunes, Deezer, MusicBrainz and the Cover
 * Art Archive only, with the app's own User-Agent. Redirects come back as
 * answers; src/core/covers/route.ts follows them.
 *
 *   cover_fetch   {url, json} -> TSB1 frame {status, statusText, headers} + body
 */
import type { CoverNetAccess } from '../types';
import { parseFrame } from './binary';
import type { Bridge } from './bridge';
import { abortReason, platformError } from './errors';
import { toResponse } from './http';

interface HttpHeadDto {
  status: number;
  statusText: string;
  headers: [string, string][];
}

export class TauriCoverNet implements CoverNetAccess {
  constructor(private readonly bridge: Bridge) {}

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortReason(signal);
    const json = new Headers(init.headers).get('accept')?.includes('json') ?? false;
    const call = this.bridge.call<unknown>('app', 'cover_fetch', { url, json });
    // The backend cannot be stopped halfway; the caller's time limit still counts.
    const raw = await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => reject(abortReason(signal!));
      signal?.addEventListener('abort', onAbort, { once: true });
      call.then(
        (v) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
    let frame: { header: HttpHeadDto; payload: Uint8Array };
    try {
      frame = parseFrame<HttpHeadDto>(raw);
    } catch (e) {
      throw platformError('bad-response', 'app', e instanceof Error ? e.message : String(e));
    }
    return toResponse(frame.header, frame.payload, url);
  };
}
