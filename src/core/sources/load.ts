/**
 * Loads the list for "Entdecken": from the app's own web server first, then
 * the copy this computer kept from last time, then the list that came with
 * the app. No other server is contacted for the list. A server that does not
 * answer is given up after INDEX_TIMEOUT_MS, like one that is not there.
 */
import { withoutBlocked } from './filter';
import type { SourceIndex } from './types';
import { parseIndex } from './validate';

/** The last list loaded from the network. */
export const INDEX_KEY = 'tonuino-studio:sources-index';
/** The newest kill switch, kept on its own so it also hides entries in older copies. */
export const BLOCKED_KEY = 'tonuino-studio:sources-blocked';
/** Bigger lists are not kept: localStorage holds about 5 MB per site, shared with the settings. */
export const MAX_CACHED_CHARS = 1_500_000;
/** The list's path next to the web app. */
export const INDEX_PATH = 'quellen/index-v1.json';
/** A list request without an answer for this long counts as failed (a captive portal, a stalled proxy, weak Wi-Fi). */
export const INDEX_TIMEOUT_MS = 8000;

/** The part of localStorage the loader needs. */
export interface SmallStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type IndexOrigin = 'network' | 'cache' | 'snapshot';

export type LoadResult =
  | {
      status: 'ready';
      index: SourceIndex;
      from: IndexOrigin;
      /** Past the list's own "stale after" date. */
      stale: boolean;
      /** The network failed and the browser says it is offline. */
      offline: boolean;
    }
  | {
      status: 'error';
      reason: 'unavailable' | 'needs-update';
      offline: boolean;
      /** The server answered, but without a usable list (not published yet, an error page, a damaged file): the connection works. */
      answered?: boolean;
    };

type ReadyResult = Extract<LoadResult, { status: 'ready' }>;

export interface LoadOptions {
  /** Address of the published list. None: only the kept copy and the list that came with the app. */
  url?: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** localStorage, when the browser allows it. */
  storage?: SmallStore | null;
  /** The list that came with the app; imported only when needed. */
  snapshot: () => Promise<unknown>;
  now: number;
  /** navigator.onLine */
  isOnline?: () => boolean;
  signal?: AbortSignal;
  /** Gives up on the network after this long (INDEX_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Where the list comes from. The web app loads it from its own server; the
 * desktop app from the web app's address (VITE_WEB_ORIGIN). An explicit
 * address (VITE_SOURCES_INDEX_URL) wins, e.g. for a preview list.
 */
export function indexUrl(o: { kind: 'web' | 'desktop'; pageUrl: string; base?: string; webOrigin?: string; override?: string }): string | undefined {
  const resolve = (u: string) => {
    try {
      const url = new URL(u, o.pageUrl);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
    } catch {
      return undefined;
    }
  };
  const override = o.override?.trim();
  if (override) return resolve(override);
  if (o.kind === 'web') return resolve((o.base || '/') + INDEX_PATH);
  const origin = o.webOrigin?.trim();
  if (!origin) return undefined;
  const url = resolve(origin.replace(/\/+$/, '') + '/' + INDEX_PATH);
  return url?.startsWith('https:') ? url : undefined;
}

function read(storage: SmallStore | null | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: SmallStore | null | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Full or blocked: the list still works for this visit.
  }
}

/** The kill switch from the newest list this computer saw. */
export function storedBlocked(storage: SmallStore | null | undefined): string[] {
  const raw = read(storage, BLOCKED_KEY);
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  } catch {
    return [];
  }
}

function isStale(index: SourceIndex, now: number): boolean {
  const t = Date.parse(index.staleAfter);
  return Number.isFinite(t) && now > t;
}

function isAbort(e: unknown, signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted || (e instanceof Error && e.name === 'AbortError');
}

class TimeoutError extends Error {
  constructor() {
    super('Die Liste kam nicht rechtzeitig');
    this.name = 'TimeoutError';
  }
}

/** The server answered with an error status, e.g. 404 before the first list is published. */
class StatusError extends Error {
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = 'StatusError';
  }
}

/**
 * The list's text from the network, or an error after `timeoutMs` without
 * the whole answer. The request is cancelled then; a fetch that ignores the
 * cancel does not keep the page waiting either.
 */
async function fetchText(url: string, o: LoadOptions): Promise<string> {
  const ctrl = new AbortController();
  let timedOut = false;
  const stop = () => ctrl.abort();
  if (o.signal?.aborted) ctrl.abort();
  else o.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, o.timeoutMs ?? INDEX_TIMEOUT_MS);
  const gaveUp = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(timedOut ? new TimeoutError() : new DOMException('Abgebrochen', 'AbortError'));
    if (ctrl.signal.aborted) fail();
    else ctrl.signal.addEventListener('abort', fail, { once: true });
  });
  gaveUp.catch(() => undefined);
  try {
    const res = await Promise.race([o.fetch(url, { credentials: 'omit', cache: 'no-cache', signal: ctrl.signal }), gaveUp]);
    if (!res.ok) throw new StatusError(res.status);
    return await Promise.race([res.text(), gaveUp]);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', stop);
  }
}

/** A kept copy or the list in the app, when it is readable and not empty. */
function usable(raw: unknown): SourceIndex | undefined {
  const parsed = parseIndex(raw);
  if (!parsed || parsed === 'needs-update' || !parsed.index.entries.length) return undefined;
  return parsed.index;
}

export async function loadIndex(o: LoadOptions): Promise<LoadResult> {
  let networkFailed = false;
  let answered = false;
  if (o.url) {
    try {
      const body = await fetchText(o.url, o);
      answered = true;
      const parsed = parseIndex(JSON.parse(body));
      if (parsed === 'needs-update') return { status: 'error', reason: 'needs-update', offline: false };
      if (!parsed) throw new Error('Liste nicht lesbar');
      const index = parsed.index;
      write(o.storage, BLOCKED_KEY, JSON.stringify(index.blocked));
      const text = JSON.stringify(index);
      if (text.length < MAX_CACHED_CHARS) write(o.storage, INDEX_KEY, text);
      return { status: 'ready', index: withoutBlocked(index), from: 'network', stale: isStale(index, o.now), offline: false };
    } catch (e) {
      // Only the caller's cancel stops here; a timeout is a failed network like any other.
      if (o.signal?.aborted) throw e;
      networkFailed = true;
      if (e instanceof StatusError) answered = true;
    }
  }
  const offline = networkFailed && o.isOnline?.() === false;
  const kept = await keptList(o, offline);
  return kept ?? { status: 'error', reason: 'unavailable', offline, answered };
}

/**
 * The newer of the kept copy and the list that came with the app, with the
 * newest kill switch applied. A copy kept by an older version does not hide
 * the newer list a later version brought along.
 */
async function keptList(o: Pick<LoadOptions, 'storage' | 'snapshot' | 'now' | 'signal'>, offline: boolean): Promise<ReadyResult | undefined> {
  const blocked = storedBlocked(o.storage);
  const ready = (index: SourceIndex, from: IndexOrigin): ReadyResult => ({ status: 'ready', index: withoutBlocked(index, blocked), from, stale: isStale(index, o.now), offline });

  let cache: SourceIndex | undefined;
  const cached = read(o.storage, INDEX_KEY);
  if (cached) {
    try {
      cache = usable(JSON.parse(cached));
    } catch {
      // Damaged copy: the list in the app.
    }
  }
  let snapshot: SourceIndex | undefined;
  try {
    snapshot = usable(await o.snapshot());
  } catch (e) {
    if (isAbort(e, o.signal)) throw e;
  }
  if (cache && (!snapshot || !(madeAt(snapshot) > madeAt(cache)))) return ready(cache, 'cache');
  return snapshot ? ready(snapshot, 'snapshot') : undefined;
}

/** When a list was made; an unreadable date counts as very old. */
function madeAt(index: SourceIndex): number {
  const t = Date.parse(index.generatedAt);
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * The kept copy or the list in the app, without asking the network: shown
 * while the current list is still on its way, so a slow server does not
 * leave the page empty. Nothing when neither has entries.
 */
export function loadKept(o: Pick<LoadOptions, 'storage' | 'snapshot' | 'now' | 'signal'>): Promise<ReadyResult | undefined> {
  return keptList(o, false);
}
