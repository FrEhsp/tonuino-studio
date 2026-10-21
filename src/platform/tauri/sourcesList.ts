/**
 * The list of "Entdecken" built on this computer by the desktop app
 * (src-tauri/src/sources_net.rs, cargo feature "quellen", on by default).
 *
 *   sources_fetch        GET over https to the hosts of the list's sources only;
 *                        redirects come back as answers, Net follows them; also
 *                        the files of a source the app loads itself, one byte
 *                        range at a time (rangedFetch)
 *   sources_cache_read   the list kept in the app's data folder
 *   sources_cache_write
 */
import type { SourcesListAccess } from '../types';
import { parseFrame } from './binary';
import type { Bridge } from './bridge';
import { abortReason, platformError } from './errors';
import { toResponse } from './http';

interface HttpHeadDto {
  status: number;
  statusText: string;
  headers: [string, string][];
}

/** Request headers the backend lets through (it sets the User-Agent itself). */
const PASSED = ['if-none-match', 'if-modified-since', 'origin', 'range'];

export class TauriSourcesList implements SourcesListAccess {
  constructor(private readonly bridge: Bridge) {}

  /**
   * A fetch for the list builder (Net). A request with an Origin header is
   * the file check of a media host: only its status and headers count, the
   * file itself is not loaded.
   */
  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortReason(signal);
    const given = new Headers(init.headers);
    const headers: Record<string, string> = {};
    for (const name of PASSED) {
      const v = given.get(name);
      if (v !== null) headers[name] = v;
    }
    const raw = await this.bridge.call<unknown>('app', 'sources_fetch', { url, headers, body: !('origin' in headers) });
    let frame: { header: HttpHeadDto; payload: Uint8Array };
    try {
      frame = parseFrame<HttpHeadDto>(raw);
    } catch (e) {
      throw platformError('bad-response', 'app', e instanceof Error ? e.message : String(e));
    }
    return toResponse(frame.header, frame.payload, url);
  };

  readCache(): Promise<string | null> {
    return this.bridge.call<string | null>('app', 'sources_cache_read');
  }

  async writeCache(text: string): Promise<void> {
    await this.bridge.call('app', 'sources_cache_write', { text });
  }
}
