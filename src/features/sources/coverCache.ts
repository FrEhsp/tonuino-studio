/**
 * Covers of "Entdecken", kept on this computer. Some sources answer slowly
 * (archive.org takes 2 to 4 seconds per picture, measured on a home line),
 * so each cover is fetched once, stored in IndexedDB and shown from there
 * from then on, also offline. Opening "Entdecken" fetches the covers of all
 * sources in the background, a few at a time, so they are there when you
 * open one. Covers that left the list are removed again.
 *
 * Only hosts that allow it (CORS) can be stored; for the others the picture
 * loads as before, straight from the source, without a referrer.
 */
import { signal } from '@preact/signals';
import { kv } from '../../platform/web/idb';

const PREFIX = 'cover|';
/** A picture larger than this is shown but not stored. */
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 20_000;
const WARM_PARALLEL = 4;

/** url -> what to put into <img src>: an object URL, the url itself, or '' (nothing, offline). */
const ready = new Map<string, string>();
const pending = new Map<string, Promise<void>>();
/** Hosts that refused the stored copy this session (no CORS): load those straight away. */
const direct = new Set<string>();

/** Changes when a cover becomes ready; components read it to re-render. */
export const coverRev = signal(0);

/**
 * What to show for `url` right now: the stored picture, the url itself,
 * '' for nothing, or undefined while it is still being looked up.
 */
export function coverSrc(url: string): string | undefined {
  const hit = ready.get(url);
  if (hit !== undefined) return hit;
  void ensureCover(url);
  return undefined;
}

/** The url failed to load as a picture: show nothing for it this session. */
export function coverFailed(url: string, src: string): void {
  if (ready.get(url) !== src) return;
  ready.set(url, '');
  if (src.startsWith('blob:')) {
    URL.revokeObjectURL(src);
    void kv.delete(PREFIX + url).catch(() => undefined);
  }
  coverRev.value++;
}

export function ensureCover(url: string): Promise<void> {
  if (ready.has(url)) return Promise.resolve();
  let p = pending.get(url);
  if (!p) {
    p = load(url)
      .then((src) => {
        ready.set(url, src);
        coverRev.value++;
      })
      .finally(() => pending.delete(url));
    pending.set(url, p);
  }
  return p;
}

async function load(url: string): Promise<string> {
  const stored = await storedCover(url);
  if (stored) return URL.createObjectURL(stored);
  const got = await fetchCover(url, TIMEOUT_MS);
  return got instanceof Blob ? URL.createObjectURL(got) : got;
}

async function storedCover(url: string): Promise<Blob | undefined> {
  const stored = await kv.get<Blob>(PREFIX + url).catch(() => undefined);
  return stored instanceof Blob && stored.size > 0 ? stored : undefined;
}

/** Fetches and stores a cover. Else what to show instead: the url itself (the <img> tries), or '' (nothing, offline). */
async function fetchCover(url: string, timeoutMs: number): Promise<Blob | string> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return '';
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return '';
  }
  if (direct.has(host) || typeof fetch !== 'function') return url;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return url;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return url;
    const blob = await res.blob();
    if (blob.size === 0) return url;
    if (blob.size <= MAX_BYTES) await kv.set(PREFIX + url, blob).catch(() => undefined);
    return blob;
  } catch (e) {
    // A TypeError is the browser refusing the copy (CORS) or the network: the <img> tries itself.
    if (e instanceof TypeError) direct.add(host);
    return url;
  }
}

/** A cover going along with loaded files may hold them up only this long. */
const HAND_OFF_TIMEOUT_MS = 5000;

/**
 * The picture itself, for the cover that goes along with files from
 * "Entdecken" into the add flow: the stored copy, else fetched once.
 * Undefined when its host allows no copy (CORS), offline or on errors.
 */
export async function coverBlob(url: string): Promise<Blob | undefined> {
  const stored = await storedCover(url);
  if (stored) return stored;
  const got = await fetchCover(url, HAND_OFF_TIMEOUT_MS);
  return got instanceof Blob ? got : undefined;
}

/** Fetches the given covers in the background, a few at a time. */
export async function warmCovers(urls: string[]): Promise<void> {
  const queue = [...new Set(urls)].filter((u) => !ready.has(u));
  const worker = async () => {
    for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      await ensureCover(u).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: WARM_PARALLEL }, worker));
}

/** Removes stored covers that are no longer in the list. */
export async function pruneCovers(keep: Iterable<string>): Promise<void> {
  const wanted = new Set(keep);
  const keys = await kv.keys(PREFIX);
  await Promise.all(keys.filter((k) => !wanted.has(k.slice(PREFIX.length))).map((k) => kv.delete(k).catch(() => undefined)));
}

if (typeof window !== 'undefined') {
  // Covers missed while offline get another try.
  window.addEventListener('online', () => {
    for (const [url, src] of ready) if (src === '') ready.delete(url);
    coverRev.value++;
  });
}
