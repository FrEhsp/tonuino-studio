/**
 * The list of "Entdecken" built on the user's computer by the desktop app
 * (`__DESKTOP_BUILD__ && __LOCAL_SOURCES__`): no server of ours is needed.
 * It runs the daily job's own code (collectAndBuild, publishGates) over the
 * catalogue that comes with the app, through a Net whose requests go to the
 * backend (sources_fetch: https, a fixed list of hosts). New episodes come
 * from the feeds and the official series pages (pages.ts, rules.ts); what a
 * source says is gone stays out for good (BuilderState.gone). The web app
 * cannot ask those servers (CORS) and never contains this file.
 *
 * - Only entries with status "active" and only what released.json released;
 *   every title passes the same quality, age and host checks as in the daily job.
 * - At most one build a day: a list younger than LOCAL_REFRESH_MS is the
 *   current one. A failed build keeps the last list (shown as an older copy).
 * - The first build stands on the list that came with the app (`snapshot`):
 *   a source that does not answer that day keeps its titles from there.
 * - The terms check of validateCatalog is left out here: the stored hashes
 *   say a person read the terms, which the daily job and "sources:check"
 *   keep track of; the app cannot read them for anyone.
 */
import { publishGates, type BuildReport } from './build';
import { collectAndBuild, emptyState, readState, type BuilderState } from './collect';
import { DESKTOP_ORIGINS } from './cors';
import type { LoadResult } from './load';
import { Net } from './net';
import type { SourceIndex } from './types';
import { parseIndex, validateCatalog, validateReleased, validateIndex } from './validate';

/** A built list is the current one for a day. */
export const LOCAL_REFRESH_MS = 24 * 60 * 60 * 1000;
/** The backend sets its own User-Agent (sources_net.rs); this one names the same caller for the record. */
export const LOCAL_USER_AGENT = 'TonUINO-Studio-Quellen/1.0 (Desktop-App)';

/** What the app keeps in its data folder between starts. */
export interface LocalCache {
  format: 1;
  /** When the list was built (ISO). */
  builtAt: string;
  index: SourceIndex;
  /** Results of the file checks, to notice hosts that change their answer. */
  state: BuilderState;
}

export interface LocalStore {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export interface LocalListOptions {
  /** sources/catalog.json and sources/released.json as they came with the app. */
  catalog: unknown;
  released: unknown;
  /** The backend's fetch (no CORS, only the allowed hosts); redirects come back as answers. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  store: LocalStore;
  now: () => number;
  /** navigator.onLine */
  isOnline?: () => boolean;
  /** Pauses between requests to the same host (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  /** The list that came with the app: what the first build stands on. */
  snapshot?: () => Promise<unknown>;
  log?: (m: string) => void;
}

/** A kept list with entries, or nothing. */
export function readLocalCache(text: string | null | undefined): LocalCache | undefined {
  if (!text) return undefined;
  try {
    const raw = JSON.parse(text) as Partial<LocalCache> | null;
    if (!raw || raw.format !== 1 || typeof raw.builtAt !== 'string' || !Number.isFinite(Date.parse(raw.builtAt))) return undefined;
    const parsed = parseIndex(raw.index);
    if (!parsed || parsed === 'needs-update' || !parsed.index.entries.length) return undefined;
    return { format: 1, builtAt: raw.builtAt, index: parsed.index, state: readState(raw.state) };
  } catch {
    return undefined;
  }
}

export interface LocalBuild {
  index: SourceIndex;
  /** Holds, rejections and failures, as in the daily job's report. */
  report: BuildReport;
  /** Why the list may not replace the last one (publishGates); empty when it may. */
  gateErrors: string[];
  /** At least one source answered: the connection works. */
  answered: boolean;
  state: BuilderState;
}

/** One run of the daily job's code on this computer. Throws only for a damaged catalogue. */
export async function buildLocalList(o: LocalListOptions, previous?: LocalCache): Promise<LocalBuild> {
  const now = new Date(o.now());
  const checked = validateCatalog(o.catalog, now);
  if (!checked.catalog) throw new Error(`Katalog fehlerhaft: ${checked.errors.join('; ')}`);
  const catalog = checked.catalog;
  const released = validateReleased(o.released, catalog);
  if (released.errors.length) throw new Error(`Freigaben fehlerhaft: ${released.errors.join('; ')}`);
  let answered = false;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await o.fetch(String(input), init ?? {});
    answered = true;
    return res;
  }) as typeof fetch;
  const net = new Net({ fetch: fetchFn, userAgent: LOCAL_USER_AGENT, sleep: o.sleep, now: o.now, log: o.log });
  // A copy: the kept state changes only together with a list that passed the gates.
  const state = previous ? (JSON.parse(JSON.stringify(previous.state)) as BuilderState) : emptyState();
  const { index, report } = await collectAndBuild(catalog, {
    net,
    include: ['active'],
    state,
    released: released.released,
    previous: previous?.index,
    now,
    // Only this app loads the files of this list: the desktop WebView's origins.
    origins: DESKTOP_ORIGINS,
    log: o.log,
  });
  const serialized = JSON.stringify(index);
  const gateErrors = publishGates(index, { catalog, previous: previous?.index, serialized, parsed: validateIndex(JSON.parse(serialized)) });
  o.log?.(`${report.counts.entries} Quellen, ${report.counts.items} Titel, ${report.holds.length} warten auf Prüfung, ${report.failures.length} nicht erreichbar, ${net.requests} Anfragen.`);
  return { index, report, gateErrors, answered, state };
}

function isStale(index: SourceIndex, now: number): boolean {
  const t = Date.parse(index.staleAfter);
  return Number.isFinite(t) && now > t;
}

/** The kept list as it is, without building (the start page, the moment before a build ends); else the one that came with the app. */
export async function loadLocalKept(o: Pick<LocalListOptions, 'store' | 'now' | 'snapshot'>): Promise<Extract<LoadResult, { status: 'ready' }> | undefined> {
  const kept = readLocalCache(await o.store.read().catch(() => null)) ?? (await fromSnapshot(o));
  if (!kept) return undefined;
  const fresh = o.now() - Date.parse(kept.builtAt) < LOCAL_REFRESH_MS;
  return { status: 'ready', index: kept.index, from: fresh ? 'network' : 'cache', stale: isStale(kept.index, o.now()), offline: false };
}

let running: Promise<LoadResult> | undefined;

/**
 * The list for "Entdecken": the one built today, else a new build, else the
 * last one (as an older copy). One build at a time; a second caller waits
 * for the first. A build, once started, runs to its end (every request has
 * its time limit): a caller that no longer waits just ignores the result.
 * 'network' means the current list, as for the published one.
 */
export function loadLocalList(o: LocalListOptions): Promise<LoadResult> {
  running ??= loadOnce(o).finally(() => {
    running = undefined;
  });
  return running;
}

/** The list that came with the app as a starting point, or nothing. */
async function fromSnapshot(o: Pick<LocalListOptions, 'snapshot'>): Promise<LocalCache | undefined> {
  try {
    const parsed = parseIndex(await o.snapshot?.());
    if (!parsed || parsed === 'needs-update' || !parsed.index.entries.length) return undefined;
    return { format: 1, builtAt: parsed.index.generatedAt, index: parsed.index, state: emptyState() };
  } catch {
    return undefined;
  }
}

async function loadOnce(o: LocalListOptions): Promise<LoadResult> {
  const kept = readLocalCache(await o.store.read().catch(() => null));
  const now = o.now();
  if (kept && now - Date.parse(kept.builtAt) < LOCAL_REFRESH_MS) {
    return { status: 'ready', index: kept.index, from: 'network', stale: isStale(kept.index, now), offline: false };
  }
  // A build that ran and reached no source at all: the computer is offline.
  let answered = false;
  let reachedNone = false;
  try {
    const built = await buildLocalList(o, kept ?? (await fromSnapshot(o)));
    answered = built.answered;
    reachedNone = !built.answered;
    // Nothing answered: every source would stand in with yesterday's titles, which is no new list.
    if (built.answered && !built.gateErrors.length) {
      const cache: LocalCache = { format: 1, builtAt: new Date(now).toISOString(), index: built.index, state: built.state };
      await o.store.write(JSON.stringify(cache)).catch((e: unknown) => o.log?.(`Liste nicht gespeichert: ${e instanceof Error ? e.message : String(e)}`));
      return { status: 'ready', index: built.index, from: 'network', stale: isStale(built.index, now), offline: false };
    }
    o.log?.(built.answered ? `Liste nicht übernommen: ${built.gateErrors.join(' ')}` : 'Keine Quelle hat geantwortet.');
  } catch (e) {
    o.log?.(`Liste nicht gebaut: ${e instanceof Error ? e.message : String(e)}`);
  }
  const offline = reachedNone || o.isOnline?.() === false;
  // No list of its own yet: the one that came with the app, as an older copy.
  const shown = kept ?? (await fromSnapshot(o));
  if (shown) return { status: 'ready', index: shown.index, from: 'cache', stale: isStale(shown.index, now), offline };
  return { status: 'error', reason: 'unavailable', offline, answered };
}
