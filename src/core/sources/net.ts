/**
 * The index builder's only way onto the network: polite, bounded requests.
 * - one request at a time; archive.org, ARD Sounds and OHRKA at most one start per second
 * - a User-Agent with a contact address, a 20 s timeout and a 10 MB cap per answer
 * - https only, redirects followed by hand and only to https
 * - conditional requests (ETag, Last-Modified) against a cache, so unchanged feeds cost little
 * - 429/503: wait as long as the server asks (default 60 s), at most three tries
 * `fetch`, `sleep` and the cache are passed in, so tests run without network.
 */
import type { Hop } from './cors';

export const TIMEOUT_MS = 20_000;
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const MAX_TRIES = 3;
export const DEFAULT_RETRY_SEC = 60;
/** Hosts that get at least this much time between two request starts. */
export const SLOW_HOSTS: Record<string, number> = { 'archive.org': 1000, 'www.ardsounds.de': 1000, 'www.ohrka.de': 1000 };

export class NetError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'NetError';
    this.status = status;
  }
}

export interface CachedAnswer {
  etag?: string;
  lastModified?: string;
  body: string;
}

export interface NetCache {
  get(url: string): CachedAnswer | undefined;
  set(url: string, answer: CachedAnswer): void;
}

export interface NetOptions {
  fetch: typeof fetch;
  userAgent: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  cache?: NetCache;
  log?: (message: string) => void;
  timeoutMs?: number;
  maxBytes?: number;
}

function hostGap(host: string): number {
  for (const [h, ms] of Object.entries(SLOW_HOSTS)) if (host === h || host.endsWith('.' + h)) return ms;
  return 0;
}

function gapKey(host: string): string {
  for (const h of Object.keys(SLOW_HOSTS)) if (host === h || host.endsWith('.' + h)) return h;
  return host;
}

/** Retry-After in seconds: a number of seconds or an HTTP date. */
export function retryAfterSec(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowMs) / 1000)) : undefined;
}

function httpsOnly(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new NetError(`Ungültige Adresse: ${url}`);
  }
  if (u.protocol !== 'https:') throw new NetError(`Nur HTTPS: ${url}`);
  return u;
}

/** Reads a body up to `max` bytes; more is an error, not a cut. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    throw new NetError(`Antwort zu groß (${declared} Bytes)`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new NetError(`Antwort zu groß (mehr als ${max} Bytes)`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export class Net {
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cache?: NetCache;
  private readonly log?: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly lastStart = new Map<string, number>();
  /** Requests made, for the report. */
  requests = 0;

  constructor(opts: NetOptions) {
    this.fetchFn = opts.fetch;
    this.userAgent = opts.userAgent;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.cache = opts.cache;
    this.log = opts.log;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? MAX_BYTES;
  }

  private async pace(host: string): Promise<void> {
    const gap = hostGap(host);
    const key = gapKey(host);
    const last = this.lastStart.get(key);
    if (gap && last !== undefined) {
      const wait = last + gap - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastStart.set(key, this.now());
  }

  /** One request with redirects followed by hand (https only) and the busy rule. */
  private async request(url: string, headers: Record<string, string>): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let current = httpsOnly(url);
      let res: Response | undefined;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await this.pace(current.hostname);
        this.requests++;
        try {
          res = await this.fetchFn(current.toString(), {
            method: 'GET',
            headers: { 'User-Agent': this.userAgent, ...headers },
            redirect: 'manual',
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch (e) {
          throw new NetError(`${current.hostname}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (res.status < 300 || res.status >= 400 || res.status === 304) break;
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) throw new NetError(`Weiterleitung ohne Ziel: ${current}`, res.status);
        const next = new URL(location, current);
        if (next.protocol !== 'https:') throw new NetError(`Weiterleitung ohne HTTPS: ${next}`, res.status);
        current = next;
        res = undefined;
      }
      if (!res) throw new NetError(`Zu viele Weiterleitungen: ${url}`);
      if ((res.status === 429 || res.status === 503) && attempt < MAX_TRIES) {
        const wait = retryAfterSec(res.headers.get('retry-after'), this.now()) ?? DEFAULT_RETRY_SEC;
        await res.body?.cancel();
        this.log?.(`${new URL(url).hostname}: HTTP ${res.status}, warte ${wait} s (Versuch ${attempt} von ${MAX_TRIES})`);
        await this.sleep(wait * 1000);
        continue;
      }
      return res;
    }
  }

  /** A text answer (feed, JSON); 304 answers come from the cache. */
  async text(url: string, opts: { conditional?: boolean } = {}): Promise<string> {
    return (await this.page(url, opts)).body;
  }

  /** A text answer and its headers (for paging); `fromCache` when the server said 304. */
  async page(url: string, opts: { conditional?: boolean } = {}): Promise<{ body: string; headers: Headers; fromCache: boolean }> {
    const cached = opts.conditional === false ? undefined : this.cache?.get(url);
    const headers: Record<string, string> = {};
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
    const res = await this.request(url, headers);
    if (res.status === 304 && cached) {
      await res.body?.cancel();
      return { body: cached.body, headers: res.headers, fromCache: true };
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new NetError(`HTTP ${res.status}: ${url}`, res.status);
    }
    const body = new TextDecoder().decode(await readCapped(res, this.maxBytes));
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;
    if (this.cache && opts.conditional !== false && (etag || lastModified)) this.cache.set(url, { etag, lastModified, body });
    return { body, headers: res.headers, fromCache: false };
  }

  async json<T>(url: string): Promise<T> {
    const text = await this.text(url);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NetError(`Kein JSON: ${url}`);
    }
  }

  /** The first bytes of a file (Range request); servers that send the whole file are read up to the cap. */
  async head(url: string, bytes: number): Promise<{ status: number; data: Uint8Array; total?: number }> {
    const res = await this.request(url, { Range: `bytes=0-${bytes - 1}` });
    if (res.status !== 206 && res.status !== 200) {
      await res.body?.cancel();
      throw new NetError(`HTTP ${res.status}: ${url}`, res.status);
    }
    let total: number | undefined;
    const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
    if (range) total = Number(range[1]);
    else if (res.status === 200 && res.headers.get('content-length')) total = Number(res.headers.get('content-length'));
    const data = await readCapped(res, this.maxBytes);
    if (res.status === 200 && total === undefined) total = data.length;
    return { status: res.status, data: data.subarray(0, bytes), total };
  }

  /**
   * The redirect chain of a media file as the app's browser would see it:
   * GET with the given Origin (and "null" after a redirect to another origin,
   * as browsers do), no Range, bodies cancelled, at most five redirects.
   */
  async chain(url: string, origin: string): Promise<Hop[]> {
    const hops: Hop[] = [];
    let current = httpsOnly(url);
    let sent = origin;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      await this.pace(current.hostname);
      this.requests++;
      let res: Response;
      try {
        res = await this.fetchFn(current.toString(), {
          method: 'GET',
          headers: { 'User-Agent': this.userAgent, Origin: sent },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        throw new NetError(`${current.hostname}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await res.body?.cancel();
      const headers: Record<string, string> = {};
      for (const name of ['access-control-allow-origin', 'location', 'content-type', 'content-length']) {
        const v = res.headers.get(name);
        if (v !== null) headers[name] = v;
      }
      hops.push({ status: res.status, url: current.toString(), headers });
      if (res.status < 300 || res.status >= 400 || !headers.location) return hops;
      const next = new URL(headers.location, current);
      if (next.protocol !== 'https:') return hops;
      if (next.origin !== current.origin) sent = 'null';
      current = next;
    }
    return hops;
  }
}
