/**
 * Which way a request of the cover search takes (TODO #110, #134):
 *
 * 1. In the desktop app through the backend (src-tauri/src/cover_net.rs):
 *    with the app's own User-Agent, as MusicBrainz asks, and without the
 *    WebView's CORS limits (Deezer sends no CORS header). Redirects come
 *    back as answers and are followed here, each address checked again.
 * 2. Else, or when that fails, the WebView's (or browser's) fetch.
 * 3. When that fails for a search of iTunes or Deezer, JSONP: both answer
 *    to a <script> tag, which needs no CORS header. Deezer's API never sends
 *    one, so without the backend its searches go this way at once: the
 *    WebView's fetch could only fail, and the browser would log an error
 *    for it on every search.
 *
 * Pure: the three ways are passed in, so tests need no network.
 */
import { isAbortError, type FetchLike } from '../stickers/image';
import { serviceOf } from './net';

export interface FetchWays {
  /** The backend's fetch for the services' hosts (desktop app), or none. */
  native?: FetchLike;
  /** The WebView's or browser's fetch. */
  web: FetchLike;
  /** Loads a JSONP URL (the callback parameter is added) and gives its data, or none (no DOM). */
  jsonp?: (url: string, signal?: AbortSignal) => Promise<unknown>;
}

/** Redirects followed through the backend. */
const MAX_REDIRECTS = 5;

/** The JSONP form of a search URL of iTunes or Deezer, or null for any other URL. */
export function jsonpUrl(url: string): string | null {
  if (url.startsWith('https://itunes.apple.com/search?') || url.startsWith('https://itunes.apple.com/lookup?')) return url;
  if (url.startsWith('https://api.deezer.com/')) return `${url}${url.includes('?') ? '&' : '?'}output=jsonp`;
  return null;
}

/** Answers without a CORS header, always: the WebView's fetch cannot read them. */
function neverCors(url: string): boolean {
  return url.startsWith('https://api.deezer.com/');
}

export function routedFetch(ways: FetchWays): FetchLike {
  // Services the backend could not reach while the WebView could (a web filter's proxy or its own
  // certificate, which only the system knows): they go the WebView's way for the rest of the session.
  const webOnly = new Set<string>();
  return async (url, init) => {
    const signal = init?.signal ?? undefined;
    const service = serviceOf(url);
    let nativeFailed = false;
    if (ways.native && service && !webOnly.has(service)) {
      try {
        return await followRedirects(ways.native, url, init);
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        // An old desktop build without the command, no connection of its own: the WebView tries.
        nativeFailed = true;
      }
    }
    const asJsonp = jsonpUrl(url);
    if (asJsonp && ways.jsonp && neverCors(url)) return jsonpResponse(ways.jsonp, asJsonp, signal);
    try {
      const res = await ways.web(url, init);
      if (nativeFailed && service) webOnly.add(service);
      return res;
    } catch (e) {
      if (isAbortError(e) || signal?.aborted || !asJsonp || !ways.jsonp) throw e;
      return jsonpResponse(ways.jsonp, asJsonp, signal);
    }
  };
}

async function jsonpResponse(jsonp: NonNullable<FetchWays['jsonp']>, url: string, signal: AbortSignal | undefined): Promise<Response> {
  const json = await jsonp(url, signal);
  return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function followRedirects(native: FetchLike, url: string, init: RequestInit | undefined): Promise<Response> {
  let at = url;
  for (let hop = 0; ; hop++) {
    const res = await native(at, init);
    const location = res.headers.get('location');
    if (res.status < 300 || res.status > 399 || !location) return res;
    if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects: ${url}`);
    const next = new URL(location, at).href;
    // Only to another of the services (the backend checks too).
    if (!serviceOf(next)) throw new Error(`redirect away from the services: ${next}`);
    at = next;
  }
}
