/**
 * Is a title of "Entdecken" still online? The app asks when someone opens
 * "Entdecken" (never in the background at start) and hides titles whose
 * source answers that it no longer has them. The daily build leaves such
 * titles out as well (isGone in build.ts); this check covers the days a
 * family's copy of the list is older.
 *
 * - archive.org (albums): one small metadata request per item; an
 *   empty answer means archive.org no longer has it.
 * - Other files the app loads itself: a HEAD request on the first file of
 *   the title; 404 or 410 means gone.
 * - Titles saved on the publisher's page are not asked about: their servers
 *   do not let the app read the answer. Those with a known end (`until`,
 *   ARD Sounds) are hidden from that day on without any request
 *   (expiredItems); the daily build looks after the others.
 *
 * Only a clear "gone" hides a title. Network errors, timeouts, refused
 * answers and server errors change nothing. Results are kept for a while
 * (REACH_OK_MS, REACH_GONE_MS), so opening "Entdecken" again does not ask
 * again, and a title that comes back shows again on the next day.
 */
import type { IndexEntry, IndexItem, SourceIndex } from './types';
import type { SmallStore } from './load';

export type ReachVerdict = 'ok' | 'gone' | 'unknown';

export interface ReachTarget {
  /** "archive:<identifier>" or "file:<item key>". */
  id: string;
  url: string;
  how: 'archive' | 'head';
  /** The item keys this answer is about. */
  items: string[];
}

interface CachedResult {
  v: 'ok' | 'gone';
  at: number;
}

export interface ReachCache {
  format: 1;
  results: Record<string, CachedResult>;
}

/** A title found online is asked about again after a week. */
export const REACH_OK_MS = 7 * 24 * 60 * 60 * 1000;
/** A title found gone is asked about again after a day: it shows again when it is back. */
export const REACH_GONE_MS = 24 * 60 * 60 * 1000;
/** At most this many requests each time "Entdecken" opens; the rest follow the next time. */
export const REACH_MAX_REQUESTS = 30;
/** Requests at the same time. */
export const REACH_PARALLEL = 3;
/** One request may take this long; a slow answer counts as "do not know". */
export const REACH_TIMEOUT_MS = 8000;

export const REACH_KEY = 'tonuino-studio:sources-reach';

const ARCHIVE_HOST = /^(?:[a-z0-9-]+\.)*archive\.org$/i;

/** The archive.org identifier of a download address, e.g. https://archive.org/download/<id>/file.mp3. */
export function archiveIdOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!ARCHIVE_HOST.test(u.hostname)) return undefined;
    const m = /^\/download\/([^/]+)\//.exec(u.pathname);
    return m ? decodeURIComponent(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function archiveCheckUrl(id: string): string {
  return `https://archive.org/metadata/${encodeURIComponent(id)}/metadata/identifier`;
}

function direct(entry: IndexEntry, item: IndexItem): boolean {
  return entry.type !== 'link' && (item.delivery ?? entry.delivery) === 'direct';
}

/** What to ask for a list: archive.org items once each, other directly loaded titles by their first file. */
export function reachTargets(index: SourceIndex): ReachTarget[] {
  const out = new Map<string, ReachTarget>();
  for (const entry of index.entries) {
    for (const item of entry.items) {
      const first = item.files[0];
      if (!first || !direct(entry, item)) continue;
      const archiveId = archiveIdOf(first.url);
      const target: ReachTarget = archiveId
        ? { id: `archive:${archiveId}`, url: archiveCheckUrl(archiveId), how: 'archive', items: [] }
        : { id: `file:${item.key}`, url: first.url, how: 'head', items: [] };
      const known = out.get(target.id) ?? target;
      known.items.push(item.key);
      out.set(target.id, known);
    }
  }
  return [...out.values()];
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One question; never throws. */
export async function probe(target: ReachTarget, fetch: Fetch, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ReachVerdict> {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  opts.signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, opts.timeoutMs ?? REACH_TIMEOUT_MS);
  try {
    const init: RequestInit = { method: target.how === 'head' ? 'HEAD' : 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctrl.signal };
    const res = await fetch(target.url, init);
    if (target.how === 'head') {
      if (res.status === 404 || res.status === 410) return 'gone';
      return res.ok ? 'ok' : 'unknown';
    }
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
    const result = (body as { result?: unknown }).result;
    if (typeof result === 'string' && result !== '') return 'ok';
    // archive.org answers {"error":"Couldn't locate item '…'"} (on the whole item: {}) for an identifier it does not have (any more).
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string' && /couldn.t locate item/i.test(error)) return 'gone';
    return Object.keys(body).length === 0 ? 'gone' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
}

export function readReachCache(storage: SmallStore | null): ReachCache {
  try {
    const raw = storage?.getItem(REACH_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<ReachCache>) : undefined;
    if (v?.format !== 1 || !v.results || typeof v.results !== 'object') return { format: 1, results: {} };
    const results: Record<string, CachedResult> = {};
    for (const [k, r] of Object.entries(v.results)) {
      if (r && (r.v === 'ok' || r.v === 'gone') && typeof r.at === 'number' && Number.isFinite(r.at)) results[k] = { v: r.v, at: r.at };
    }
    return { format: 1, results };
  } catch {
    return { format: 1, results: {} };
  }
}

export function writeReachCache(storage: SmallStore | null, cache: ReachCache, now: number): void {
  // Old answers are of no use any more; the stored text stays small.
  const results = Object.fromEntries(Object.entries(cache.results).filter(([, r]) => now - r.at < REACH_OK_MS && r.at <= now));
  try {
    storage?.setItem(REACH_KEY, JSON.stringify({ format: 1, results }));
  } catch {
    /* full or not allowed: the next opening asks again */
  }
}

function fresh(r: CachedResult | undefined, now: number): boolean {
  if (!r || r.at > now) return false;
  return now - r.at < (r.v === 'gone' ? REACH_GONE_MS : REACH_OK_MS);
}

/** Whether a title's time at the publisher is over (IndexItem.until): from the start of that day (UTC). */
export function expired(item: Pick<IndexItem, 'until'>, now: number): boolean {
  if (!item.until) return false;
  const end = Date.parse(item.until);
  return Number.isFinite(end) && now >= end;
}

/** Item keys whose time at the publisher is over; known from the list alone, offline too. */
export function expiredItems(index: SourceIndex | undefined, now: number): Set<string> {
  const out = new Set<string>();
  for (const e of index?.entries ?? []) for (const it of e.items) if (expired(it, now)) out.add(it.key);
  return out;
}

/** Item keys a fresh answer found gone. */
export function goneItems(index: SourceIndex | undefined, cache: ReachCache, now: number): Set<string> {
  const out = new Set<string>();
  if (!index) return out;
  for (const t of reachTargets(index)) {
    const r = cache.results[t.id];
    if (r?.v === 'gone' && fresh(r, now)) for (const k of t.items) out.add(k);
  }
  return out;
}

/** The list without the gone titles, and without sources that have none left. The same object when nothing is gone. */
export function withoutGone(index: SourceIndex, gone: ReadonlySet<string>): SourceIndex {
  if (!gone.size) return index;
  let changed = false;
  const entries: IndexEntry[] = [];
  for (const e of index.entries) {
    const items = e.items.filter((it) => !gone.has(it.key));
    if (items.length === e.items.length) entries.push(e);
    else {
      changed = true;
      if (items.length) entries.push({ ...e, items });
    }
  }
  return changed ? { ...index, entries } : index;
}

/**
 * Asks about the titles without a fresh answer, a few at a time, and stores
 * the answers. Returns the updated cache. "Do not know" is not stored: it
 * neither hides a title nor saves the next question.
 */
export async function checkReach(
  index: SourceIndex,
  deps: { fetch: Fetch; storage: SmallStore | null; now: () => number; signal?: AbortSignal; max?: number; parallel?: number; timeoutMs?: number },
): Promise<ReachCache> {
  const cache = readReachCache(deps.storage);
  const due = reachTargets(index)
    .filter((t) => !fresh(cache.results[t.id], deps.now()))
    .slice(0, deps.max ?? REACH_MAX_REQUESTS);
  let next = 0;
  const worker = async () => {
    while (next < due.length && !deps.signal?.aborted) {
      const t = due[next++];
      const v = await probe(t, deps.fetch, { signal: deps.signal, timeoutMs: deps.timeoutMs });
      if (deps.signal?.aborted) return;
      if (v !== 'unknown') cache.results[t.id] = { v, at: deps.now() };
    }
  };
  await Promise.all(Array.from({ length: Math.min(deps.parallel ?? REACH_PARALLEL, due.length) }, worker));
  if (due.length) writeReachCache(deps.storage, cache, deps.now());
  return cache;
}
