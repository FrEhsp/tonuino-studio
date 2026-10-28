/**
 * Polite requests to the music services (TODO #130): one queue per service
 * for the whole app (MusicBrainz allows one request a second per program,
 * Apple about twenty a minute), asking again by itself when a service is
 * busy (503, 429: after Retry-After, else after 2, 4 and 8 seconds), a
 * memory of answers so the same search does not go out twice, and a memory
 * of services that do not answer at all, e.g. because a web filter blocks
 * them (#110): a search then goes on with the others without a word.
 *
 * The User-Agent that MusicBrainz asks for ("TonUINO-Studio/0.6.0 ( … )")
 * is set where the platform allows it: the desktop app sends these requests
 * through its backend (src-tauri/src/cover_net.rs). A browser does not let
 * a page set it.
 *
 * No DOM here: tested in Node with fake timers.
 */

import { isAbortError, type FetchLike } from '../stickers/image';

export type Service = 'itunes' | 'deezer' | 'musicbrainz' | 'coverartarchive';

/**
 * The addresses each service needs, for a web filter's allow list (Frank's
 * PC: Plucky). The pictures come from other hosts than the searches.
 */
export const SERVICE_HOSTS: Readonly<Record<Service, readonly string[]>> = {
  itunes: ['itunes.apple.com', 'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com', 'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com'],
  deezer: ['api.deezer.com', 'cdn-images.dzcdn.net', 'e-cdns-images.dzcdn.net'],
  musicbrainz: ['musicbrainz.org'],
  coverartarchive: ['coverartarchive.org', 'archive.org', '*.archive.org'],
};

export const SERVICE_NAME: Readonly<Record<Service, string>> = { itunes: 'iTunes', deezer: 'Deezer', musicbrainz: 'MusicBrainz', coverartarchive: 'Cover Art Archive' };

/** The service a URL belongs to, or undefined. */
export function serviceOf(url: string): Service | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [service, hosts] of Object.entries(SERVICE_HOSTS) as [Service, readonly string[]][]) {
    if (hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h))) return service;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Waiting

export function abortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Die Suche wurde abgebrochen.', 'AbortError')
    : Object.assign(new Error('Die Suche wurde abgebrochen.'), { name: 'AbortError' });
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A signal that aborts when either does (AbortSignal.any is missing in older WebViews). */
export function eitherSignal(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a || !b) return a ?? b;
  if (a.aborted || b.aborted) return AbortSignal.abort();
  const both = new AbortController();
  const stop = () => {
    both.abort();
    a.removeEventListener('abort', stop);
    b.removeEventListener('abort', stop);
  };
  a.addEventListener('abort', stop, { once: true });
  b.addEventListener('abort', stop, { once: true });
  return both.signal;
}

/** Anything that hands out turns: RateLimiter, ServiceGate, or one that never waits (tests). */
export interface Limiter {
  wait(signal?: AbortSignal): Promise<void>;
}

/**
 * Spaces calls at least `intervalMs` apart. Slots are reserved
 * synchronously, so concurrent callers queue up. A caller that gives up
 * while waiting returns its slot when nobody queued behind it, so an
 * abandoned search does not delay the next one.
 */
export class RateLimiter implements Limiter {
  private nextSlot = 0;

  constructor(
    readonly intervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepMs,
  ) {}

  async wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    const t = this.now();
    const start = Math.max(t, this.nextSlot);
    const end = start + this.intervalMs;
    this.nextSlot = end;
    if (start <= t) return;
    try {
      await this.sleep(start - t, signal);
    } catch (err) {
      if (this.nextSlot === end) this.nextSlot = start;
      throw err;
    }
  }
}

interface Waiter {
  resolve: () => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * A queue of turns for one service: at most `burst` requests at once, then
 * one each `intervalMs`, first come first served. Unlike RateLimiter, a
 * caller that gives up leaves the queue at once and the ones behind move
 * up: a folder whose cover was found elsewhere frees its turn. `holdOff`
 * pauses the whole queue, after a service said it is busy.
 */
export class ServiceGate implements Limiter {
  private tokens: number;
  private last: number;
  private pausedUntil = 0;
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly intervalMs: number,
    readonly burst = 1,
  ) {
    this.tokens = burst;
    this.last = Date.now();
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.queue.push(w);
      this.pump();
    });
  }

  /** Nobody gets a turn for `ms` (a service answered 503 or 429). */
  holdOff(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    this.tokens = Math.min(this.tokens, 0);
    this.pump();
  }

  /** Forgets turns given and pauses (tests). */
  reset(): void {
    this.tokens = this.burst;
    this.last = Date.now();
    this.pausedUntil = 0;
    this.pump();
  }

  /** Waiting callers, for tests and progress. */
  get waiting(): number {
    return this.queue.length;
  }

  private refill(now: number) {
    if (this.intervalMs <= 0) {
      this.tokens = this.burst;
    } else {
      // A clock set back (tests, the computer's time changed) gives nothing.
      this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.last) / this.intervalMs);
    }
    this.last = now;
  }

  private pump() {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (;;) {
      if (!this.queue.length) return;
      const now = Date.now();
      this.refill(now);
      // A pause from before a clock change never lasts longer than a minute.
      if (this.pausedUntil - now > 60_000) this.pausedUntil = now + 60_000;
      const wait = Math.max(this.pausedUntil - now, this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * this.intervalMs));
      if (wait > 0) {
        this.timer = setTimeout(() => this.pump(), wait);
        return;
      }
      this.tokens -= 1;
      const w = this.queue.shift()!;
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      w.resolve();
    }
  }
}

/**
 * One queue per service for the whole app. MusicBrainz: one request every
 * 1.1 s (their rule is one a second). Apple: about twenty a minute, a few
 * at once. Deezer allows 50 in 5 s; ten a second is plenty. The Cover Art
 * Archive has no such rule; a few at once keep it calm.
 */
export const gates: Readonly<Record<Service, ServiceGate>> = {
  musicbrainz: new ServiceGate(1100),
  itunes: new ServiceGate(3000, 4),
  deezer: new ServiceGate(100, 5),
  coverartarchive: new ServiceGate(200, 4),
};

// ---------------------------------------------------------------------------
// Services that do not answer

/** After this many failed connections in a row a service counts as unreachable … */
const DOWN_AFTER = 2;
/** … for this long; then it is asked again. */
const DOWN_FOR_MS = 10 * 60_000;

interface Health {
  fails: number;
  downUntil: number;
  /** Did not answer at least once in this session. */
  everFailed: boolean;
  /** Answered at least once in this session. */
  everAnswered: boolean;
}

const health = new Map<Service, Health>();

function healthOf(s: Service): Health {
  let h = health.get(s);
  if (!h) {
    h = { fails: 0, downUntil: 0, everFailed: false, everAnswered: false };
    health.set(s, h);
  }
  return h;
}

/** The service answered (any HTTP answer counts: it is reachable). */
export function noteAnswered(s: Service): void {
  const h = healthOf(s);
  h.fails = 0;
  h.downUntil = 0;
  h.everAnswered = true;
}

/** No connection, no answer in time, or a page a web filter put in place of the answer. */
export function noteUnreachable(s: Service): void {
  const h = healthOf(s);
  h.fails++;
  h.everFailed = true;
  if (h.fails >= DOWN_AFTER) h.downUntil = Date.now() + DOWN_FOR_MS;
}

/** True while the service is left out because it did not answer just now. */
export function isDown(s: Service): boolean {
  return healthOf(s).downUntil > Date.now();
}

/**
 * Services that did not answer in this session, with the addresses to
 * allow in a web filter, for the help or a quiet note. Empty when all
 * answered.
 */
export function unreachableServices(): { service: Service; name: string; hosts: readonly string[]; down: boolean }[] {
  return [...health.entries()]
    .filter(([, h]) => h.everFailed && (h.fails > 0 || !h.everAnswered))
    .map(([service, h]) => ({ service, name: SERVICE_NAME[service], hosts: SERVICE_HOSTS[service], down: h.downUntil > Date.now() }));
}

/**
 * For people behind a web filter (Frank's PC: Plucky): which services did
 * not answer and which addresses to allow there. Null when all answered.
 */
export function webFilterHint(services: readonly Service[] = unreachableServices().map((u) => u.service)): string | null {
  const list = [...new Set(services)];
  if (!list.length) return null;
  const names = list.map((s) => SERVICE_NAME[s]);
  const who = names.length === 1 ? `${names[0]} hat` : `${names.slice(0, -1).join(', ')} und ${names.at(-1)} haben`;
  const hosts = list.flatMap((s) => SERVICE_HOSTS[s]);
  return `${who} nicht geantwortet. Ich suche ohne ${list.length === 1 ? 'diesen Dienst' : 'diese Dienste'} weiter. Nutzt du einen Webfilter? Dann gib dort diese Adressen frei: ${hosts.join(', ')}.`;
}

/** Forgets what is known about the services (tests, or the user asks again on purpose). */
export function resetServiceHealth(): void {
  health.clear();
}

// ---------------------------------------------------------------------------
// Answers kept

/** Searches answered within this time are not asked again. */
export const ANSWER_TTL_MS = 12 * 3600_000;
const MAX_ANSWERS = 400;

const answers = new Map<string, { at: number; json: unknown }>();

function recallAnswer(url: string): unknown {
  const a = answers.get(url);
  if (!a) return undefined;
  if (Date.now() - a.at > ANSWER_TTL_MS) {
    answers.delete(url);
    return undefined;
  }
  // Most recently used last.
  answers.delete(url);
  answers.set(url, a);
  return a.json;
}

function keepAnswer(url: string, json: unknown) {
  answers.set(url, { at: Date.now(), json });
  while (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value!);
}

export function clearAnswers(): void {
  answers.clear();
}

// ---------------------------------------------------------------------------
// Requests

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

export class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

export class FormatError extends Error {
  constructor() {
    super('unexpected response');
    this.name = 'FormatError';
  }
}

/** The service was left out: it did not answer the last times (see isDown). */
export class ServiceDownError extends Error {
  constructor(readonly service: Service) {
    super(`${SERVICE_NAME[service]} is not reachable`);
    this.name = 'ServiceDownError';
  }
}

/**
 * Runs `request` with a signal that follows the caller's `signal` and also
 * aborts after `timeoutMs`; running out of time rejects with a TimeoutError.
 */
export async function withTimeout<T>(signal: AbortSignal | undefined, timeoutMs: number, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // An abort before the start would never reach the request's own signal.
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await request(controller.signal);
  } catch (err) {
    if (timedOut) throw new TimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Waits after a busy answer: Retry-After in seconds or as a date (at most 30 s), else 2, 4, 8 s. */
export function retryDelay(res: Pick<Response, 'headers'>, attempt: number): number {
  const fallback = 2000 * 2 ** attempt;
  const ra = res.headers.get('retry-after')?.trim();
  if (!ra) return fallback;
  const seconds = /^\d+(?:\.\d+)?$/.test(ra) ? Number(ra) * 1000 : Date.parse(ra) - Date.now();
  return Number.isFinite(seconds) ? Math.min(30_000, Math.max(500, seconds)) : fallback;
}

export interface PoliteOptions {
  fetchFn: FetchLike;
  signal?: AbortSignal;
  /** Per request, default 12 s. */
  timeoutMs?: number;
  /** The service's queue unless given (tests: one that never waits). */
  limiter?: Limiter;
  /** How often a busy answer is asked again, default 3. */
  retries?: number;
  /** Keep and reuse the answer (default for JSON). */
  cache?: boolean;
  /**
   * Gives up the turn while still waiting for it (rejects with an
   * AbortError), but lets a request that is already out finish: its answer
   * is still worth having.
   */
  skip?: AbortSignal;
}

/**
 * GET of a JSON answer from one of the services, politely: in the
 * service's queue, again after a busy answer, and from memory when the same
 * URL was answered a little earlier. A service that did not answer the
 * last times is left out at once (ServiceDownError).
 */
export async function serviceJson(service: Service, url: string, opts: PoliteOptions): Promise<unknown> {
  const useCache = opts.cache !== false;
  if (useCache) {
    const kept = recallAnswer(url);
    if (kept !== undefined) return kept;
  }
  const json = await politeRequest(service, url, opts, { Accept: 'application/json' }, async (res) => {
    try {
      return (await res.json()) as unknown;
    } catch (err) {
      if (isAbortError(err)) throw err;
      // A web filter's page instead of the answer: as good as no answer.
      throw new FormatError();
    }
  });
  if (useCache) keepAnswer(url, json);
  return json;
}

/** GET through the service's queue, again after busy answers. Rejects with HttpError for other non-2xx answers. */
export function politeFetch(service: Service, url: string, opts: PoliteOptions, headers?: Record<string, string>): Promise<Response> {
  return politeRequest(service, url, opts, headers, async (res) => res);
}

/**
 * The request with its answer read by `read`, both within the time limit
 * (an answer whose body stops halfway must not hang). The service counts as
 * answering once `read` succeeds, or on an HTTP error.
 */
async function politeRequest<T>(service: Service, url: string, opts: PoliteOptions, headers: Record<string, string> | undefined, read: (res: Response) => Promise<T>): Promise<T> {
  if (opts.signal?.aborted) throw abortError();
  if (isDown(service)) throw new ServiceDownError(service);
  const limiter = opts.limiter ?? gates[service];
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  for (let attempt = 0; ; attempt++) {
    await limiter.wait(eitherSignal(opts.signal, attempt === 0 ? opts.skip : undefined));
    if (opts.signal?.aborted) throw abortError();
    let outcome: { res: Response; value?: undefined } | { res?: undefined; value: T };
    try {
      outcome = await withTimeout(opts.signal, timeoutMs, async (timed) => {
        const res = await opts.fetchFn(url, { signal: timed, ...(headers ? { headers } : {}) });
        if (!res.ok) return { res };
        return { value: await read(res) };
      });
    } catch (err) {
      if (opts.signal?.aborted) throw abortError();
      if (isAbortError(err)) throw err;
      noteUnreachable(service);
      throw err;
    }
    noteAnswered(service);
    if (!outcome.res) return outcome.value as T;
    const res = outcome.res;
    if ((res.status === 503 || res.status === 429) && attempt < retries) {
      const wait = retryDelay(res, attempt);
      // The whole service waits, not only this request: the others would be refused just the same.
      if (limiter instanceof ServiceGate) limiter.holdOff(wait);
      else await sleepMs(wait, opts.signal);
      continue;
    }
    throw new HttpError(res.status);
  }
}

/** Fresh queues, no kept answers, every service reachable again (tests). */
export function resetNet(): void {
  clearAnswers();
  resetServiceHealth();
  for (const g of Object.values(gates)) g.reset();
}
