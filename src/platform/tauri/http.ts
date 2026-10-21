/**
 * Platform.fetch for the desktop app. HTTPS (and the app's own origin) goes
 * through the WebView's fetch; plain http:// requests to other hosts, i.e.
 * an ESP32 box in the home network, go through the backend's `http_plain`,
 * which has no mixed-content or CORS limits but only talks to private
 * addresses.
 */
import { parseFrame } from './binary';
import { encodeHeader, type Bridge } from './bridge';
import { abortReason, platformError } from './errors';

interface HttpHeadDto {
  status: number;
  statusText: string;
  headers: [string, string][];
}

/** Base timeout of one request; uploads get more time per byte. */
export const HTTP_TIMEOUT_MS = 10_000;
/** Slowest upload speed we still wait for (bytes per second). */
const MIN_UPLOAD_BYTES_PER_SEC = 50_000;
/** Upper bound the backend accepts. */
const MAX_TIMEOUT_MS = 3_600_000;

/** Statuses whose responses never have a body (the Response constructor rejects one). */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export function timeoutFor(bodyBytes: number): number {
  return Math.min(MAX_TIMEOUT_MS, HTTP_TIMEOUT_MS + Math.ceil((bodyBytes / MIN_UPLOAD_BYTES_PER_SEC) * 1000));
}

/** True when the request goes through `http_plain` instead of the WebView. */
export function usesPlainHttp(url: URL, pageOrigin: string | undefined): boolean {
  return url.protocol === 'http:' && url.origin !== pageOrigin;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export function toResponse(head: HttpHeadDto, payload: Uint8Array, url: string): Response {
  if (head.status < 200 || head.status > 599) {
    throw platformError('bad-response', 'http', `unexpected status ${head.status}`);
  }
  const headers = new Headers();
  for (const [name, value] of head.headers) {
    try {
      headers.append(name, value);
    } catch {
      // A header the Fetch API does not accept: leave it out.
    }
  }
  const body = NULL_BODY_STATUS.has(head.status) ? null : new Uint8Array(payload);
  let response: Response;
  try {
    response = new Response(body, { status: head.status, statusText: head.statusText, headers });
  } catch {
    // Odd reason phrase from a small web server.
    response = new Response(body, { status: head.status, headers });
  }
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

/** One request through the backend's minimal HTTP/1.1 client. */
export async function plainHttp(bridge: Bridge, url: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw abortReason(signal);
  let request: Request;
  try {
    // Lets the platform normalize method, headers and body exactly like fetch.
    request = new Request(url, init);
  } catch (e) {
    throw platformError('invalid-argument', 'http', e instanceof Error ? e.message : String(e));
  }
  const body = new Uint8Array(await request.arrayBuffer());
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const reply = bridge.call<unknown>('http', 'http_plain', body, {
    headers: {
      'x-method': encodeHeader(request.method),
      'x-url': encodeHeader(url),
      'x-timeout': String(timeoutFor(body.byteLength)),
      'x-headers': encodeHeader(JSON.stringify(headers)),
    },
  });
  const raw = await withAbort(reply, signal);
  let frame: { header: HttpHeadDto; payload: Uint8Array };
  try {
    frame = parseFrame<HttpHeadDto>(raw);
  } catch (e) {
    throw platformError('bad-response', 'http', e instanceof Error ? e.message : String(e));
  }
  return toResponse(frame.header, frame.payload, url);
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createFetch(bridge: Bridge, nativeFetch: FetchFn = (input, init) => fetch(input, init)): FetchFn {
  return (input, init) => {
    const page = typeof location === 'undefined' ? undefined : location;
    let url: URL;
    try {
      url = new URL(input, page?.href);
    } catch {
      return nativeFetch(input, init);
    }
    return usesPlainHttp(url, page?.origin) ? plainHttp(bridge, url.href, init) : nativeFetch(input, init);
  };
}
