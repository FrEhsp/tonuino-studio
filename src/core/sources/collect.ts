/**
 * Fetches what the builder needs for the admitted catalogue entries, one
 * request at a time, through Net: feeds, archive.org item metadata, the
 * official pages of series without a feed, the Global Storybooks tree and
 * the first 16 KB of changed story files. Then checks, per media host, whether the app may fetch its files.
 * Every failure is kept per entry; the builder falls back to yesterday's items.
 *
 * collectAndBuild is the whole run up to the publishing gates. The daily job
 * (scripts/sources/build-index.ts) and the desktop app, which builds the
 * list on the user's computer (local.ts), both use it.
 */
import { allowedHosts, buildIndex, type ArchiveMetadata, type BuildInputs, type BuildReport, type GsbStoryData, type SeriesData, linkKey } from './build';
import { seriesLinks, titleFacts, titleUrl, type PageFacts } from './pages';
import { MAX_NEW_PER_RUN } from './rules';
import { chainHostProblem, chainReachedFile, deliveryFromChain, stableVerdict, type HostVerdict } from './cors';
import { GSB_HEAD_BYTES, gsbStoryPath, parseGsbHead, type GsbHead } from './gsb';
import type { CatalogEntry, EntryStatus, ReleasedItem, SourceCatalog, SourceIndex } from './types';
import type { Net } from './net';

/** What the builder remembers between runs (.sources-cache/state.json). */
export interface BuilderState {
  format: 1;
  /** Story path -> what its first bytes said, valid while the blob id stays the same. */
  gsb: Record<string, { blob: string; size?: number } & GsbHead>;
  /** Media host -> last measured result, to notice hosts that change their answer. */
  hosts: Record<string, 'direct' | 'browser'>;
  /** Title page -> what it said and when (pages.ts); read again after PAGE_REFRESH_DAYS. */
  pages?: Record<string, { at: string; facts: PageFacts }>;
  /** Entry ids and item keys a source said it no longer has (HTTP 404/410): never listed again. */
  gone?: string[];
}

export function emptyState(): BuilderState {
  return { format: 1, gsb: {}, hosts: {}, pages: {}, gone: [] };
}

export function readState(raw: unknown): BuilderState {
  const s = raw as Partial<BuilderState> | null;
  if (!s || s.format !== 1) return emptyState();
  const obj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  return {
    format: 1,
    gsb: obj(s.gsb) ? s.gsb! : {},
    hosts: obj(s.hosts) ? s.hosts! : {},
    pages: obj(s.pages) ? s.pages! : {},
    gone: Array.isArray(s.gone) ? s.gone.filter((g): g is string => typeof g === 'string') : [],
  };
}

/** A title page's facts count this long; then it is read again (end date, picture, still there). */
export const PAGE_REFRESH_DAYS = 7;
/** Known titles read again per series and run, the oldest first; the rest wait for the next days. */
export const MAX_REFRESH_PER_RUN = 15;

export const ARCHIVE_METADATA = (id: string) => `https://archive.org/metadata/${encodeURIComponent(id)}`;
export const GITLAB_TREE = (project: number, path: string, ref: string, page: number) =>
  `https://gitlab.com/api/v4/projects/${project}/repository/tree?path=${encodeURIComponent(path)}&recursive=true&per_page=100&ref=${encodeURIComponent(ref)}&page=${page}`;
export const GITLAB_RAW = (project: number, path: string, ref: string) => `https://gitlab.com/api/v4/projects/${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;

type Collected = Pick<BuildInputs, 'feeds' | 'archive' | 'gsb'> & { series: Record<string, SeriesData | Error> };

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** Only what the builder reads from archive.org; uploader and other personal fields never leave this function. */
function trimArchive(raw: unknown): ArchiveMetadata {
  const r = raw as { metadata?: Record<string, unknown>; files?: Record<string, unknown>[] } | null;
  if (!r || typeof r !== 'object' || !r.metadata) throw new Error('archive.org kennt diese Kennung nicht');
  const s = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? (v[0] as string) : undefined);
  const m = r.metadata;
  return {
    metadata: { identifier: s(m.identifier), title: s(m.title), creator: s(m.creator), licenseurl: s(m.licenseurl), date: s(m.date) },
    files: (r.files ?? []).map((f) => ({
      name: String(f.name ?? ''),
      source: s(f.source),
      format: s(f.format),
      size: s(f.size),
      length: s(f.length),
      title: s(f.title),
      track: s(f.track),
      creator: s(f.creator),
      sha1: s(f.sha1),
    })),
  };
}

async function archive(net: Net, id: string, out: Collected): Promise<void> {
  if (out.archive[id] !== undefined) return;
  try {
    out.archive[id] = trimArchive(await net.json<unknown>(ARCHIVE_METADATA(id)));
  } catch (e) {
    out.archive[id] = asError(e);
  }
}

interface TreeEntry {
  id: string;
  path: string;
  type: string;
}

async function gsbStories(net: Net, entry: Extract<CatalogEntry, { type: 'gitlab-gsb' }>, state: BuilderState, log: (m: string) => void): Promise<GsbStoryData[]> {
  const tree: TreeEntry[] = [];
  for (let page = 1; page <= 50; ) {
    const { body, headers } = await net.page(GITLAB_TREE(entry.project, entry.path, entry.ref, page), { conditional: false });
    const list = JSON.parse(body) as TreeEntry[];
    if (!Array.isArray(list)) throw new Error('Unerwartete Antwort der GitLab-API');
    tree.push(...list);
    const next = Number(headers.get('x-next-page'));
    if (!next || next <= page) break;
    page = next;
  }
  const wanted = new Set(entry.stories.map((s) => s.id));
  const out: GsbStoryData[] = [];
  for (const t of tree) {
    if (t.type !== 'blob') continue;
    const story = gsbStoryPath(t.path, entry.path);
    if (!story || !wanted.has(story.id)) continue;
    let known = state.gsb[t.path];
    if (!known || known.blob !== t.id) {
      const head = await net.head(GITLAB_RAW(entry.project, t.path, entry.ref), GSB_HEAD_BYTES);
      known = { blob: t.id, size: head.total, ...parseGsbHead(head.data) };
      state.gsb[t.path] = known;
      log(`Global Storybooks: ${t.path} gelesen (${head.status})`);
    }
    out.push({ id: story.id, path: t.path, name: story.name, size: known.size, title: known.title, reader: known.reader, year: known.year, durationSec: known.durationSec, comment: known.comment });
  }
  return out;
}

/**
 * Reads the series pages of a link entry (pages.ts): which titles they link,
 * and the title pages of new titles and of known ones whose facts are older
 * than PAGE_REFRESH_DAYS. Facts are kept in `state.pages`; a page that does
 * not load this time keeps its last facts, one that answers 404 or 410 is
 * passed on as gone. Throws when no series page loads.
 */
async function seriesData(net: Net, entry: Extract<CatalogEntry, { type: 'link' }>, state: BuilderState, now: Date, log: (m: string) => void): Promise<SeriesData> {
  const series = entry.series!;
  const links: string[] = [];
  const from: Record<string, string> = {};
  let read = 0;
  let lastError: unknown;
  for (const url of series.urls) {
    try {
      const html = await net.text(url, { conditional: false });
      read++;
      for (const l of seriesLinks(series.reader, html, url)) {
        if (links.includes(l)) continue;
        links.push(l);
        from[l] = url;
      }
    } catch (e) {
      lastError = e;
      log(`${entry.id}: ${url} nicht gelesen: ${asError(e).message}`);
    }
  }
  if (!read) throw asError(lastError);
  const cache = (state.pages ??= {});
  const gone = new Set(state.gone ?? []);
  const pages: Record<string, PageFacts | Error> = {};
  const fresh = (url: string) => {
    const c = cache[url];
    return !!c && now.getTime() - Date.parse(c.at) < PAGE_REFRESH_DAYS * 86_400_000;
  };
  const known = entry.items.map((it) => titleUrl(series.reader, it.pageUrl)).filter((u): u is string => !!u);
  const newOnes = series.noNew ? [] : links.filter((u) => !known.includes(u) && !gone.has(linkKey(entry.id, u)));
  // Known titles: the ones read longest ago first.
  const stale = known.filter((u) => !fresh(u)).sort((a, b) => (cache[a] ? Date.parse(cache[a].at) : 0) - (cache[b] ? Date.parse(cache[b].at) : 0));
  const toRead = [...newOnes.filter((u) => !fresh(u)).slice(0, MAX_NEW_PER_RUN), ...stale.slice(0, MAX_REFRESH_PER_RUN)];
  for (const url of toRead) {
    try {
      const facts = titleFacts(series.reader, await net.text(url, { conditional: false }), url);
      cache[url] = { at: now.toISOString(), facts };
    } catch (e) {
      // Gone is passed on; anything else keeps what the page said last time.
      if ((e as { status?: unknown }).status === 404 || (e as { status?: unknown }).status === 410) {
        pages[url] = asError(e);
        delete cache[url];
      } else log(`${entry.id}: ${url} nicht gelesen: ${asError(e).message}`);
    }
  }
  for (const url of [...known, ...newOnes]) if (!(url in pages) && cache[url]) pages[url] = cache[url].facts;
  return { links, pages, from };
}

/** Fetches the sources of every included entry. Never throws: failures are stored per entry. */
export async function collectInputs(
  catalog: SourceCatalog,
  opts: { net: Net; include: readonly EntryStatus[]; state: BuilderState; log?: (m: string) => void; now?: Date },
): Promise<Collected> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const out: Collected = { feeds: {}, archive: {}, gsb: {}, series: {} };
  const blocked = new Set(catalog.blocked);
  for (const entry of catalog.entries) {
    if (!opts.include.includes(entry.status) || blocked.has(entry.id)) continue;
    switch (entry.type) {
      case 'podcast':
        try {
          out.feeds[entry.id] = await opts.net.text(entry.feedUrl);
        } catch (e) {
          out.feeds[entry.id] = asError(e);
        }
        break;
      case 'archive-album':
        await archive(opts.net, entry.archiveId, out);
        break;
      case 'gitlab-gsb':
        try {
          out.gsb[entry.id] = await gsbStories(opts.net, entry, opts.state, log);
        } catch (e) {
          out.gsb[entry.id] = asError(e);
        }
        break;
      case 'link':
        if (entry.series) {
          try {
            out.series[entry.id] = await seriesData(opts.net, entry, opts.state, now, log);
          } catch (e) {
            out.series[entry.id] = asError(e);
          }
        }
        break;
      case 'commons':
        break;
    }
  }
  // Facts of pages no series linked for two months are of no use any more.
  for (const [url, c] of Object.entries(opts.state.pages ?? {})) if (now.getTime() - Date.parse(c.at) > 60 * 86_400_000) delete opts.state.pages![url];
  return out;
}

export interface HostCheck {
  host: string;
  url: string;
  verdict: HostVerdict;
  failures: string[];
}

/**
 * One real file per media host (the newest one the index lists), fetched as
 * the app would from every app origin. 'direct' only when all pass; a changed
 * answer since the last run is 'unstable'; no web origin configured or no file
 * reached: 'unverified'. A redirect through a measurement service or to a
 * host outside `allowed` (the entry's own hosts) is 'blocked'.
 */
export async function checkHosts(
  index: SourceIndex,
  opts: { net: Net; origins: readonly string[]; state: BuilderState; allowed?: (host: string) => readonly string[]; log?: (m: string) => void },
): Promise<HostCheck[]> {
  const newest = new Map<string, string>();
  for (const e of index.entries) {
    if (e.type === 'link') continue;
    for (const it of e.items) {
      const f = it.files[0];
      if (!f) continue;
      const host = new URL(f.url).hostname;
      if (!newest.has(host)) newest.set(host, f.url);
    }
  }
  const results: HostCheck[] = [];
  for (const [host, url] of newest) {
    if (!opts.origins.length) {
      results.push({ host, url, verdict: 'unverified', failures: ['Keine Web-Adresse der App eingestellt (SOURCES_WEB_ORIGIN)'] });
      continue;
    }
    const failures: string[] = [];
    let reached = true;
    let blocked: string | undefined;
    for (const origin of opts.origins) {
      try {
        const hops = await opts.net.chain(url, origin);
        blocked = chainHostProblem(hops, opts.allowed?.(host) ?? [host]);
        if (blocked) break;
        if (!chainReachedFile(hops)) {
          reached = false;
          failures.push(`${origin}: Datei nicht erreicht (HTTP ${hops[hops.length - 1]?.status ?? '?'})`);
          break;
        }
        failures.push(...deliveryFromChain(hops, [origin]).failures);
      } catch (e) {
        reached = false;
        failures.push(`${origin}: ${asError(e).message}`);
        break;
      }
    }
    if (blocked) {
      opts.log?.(`CORS ${host}: blocked – ${blocked}`);
      results.push({ host, url, verdict: 'blocked', failures: [blocked] });
      continue;
    }
    if (!reached) {
      results.push({ host, url, verdict: 'unverified', failures });
      continue;
    }
    const measured = failures.length ? 'browser' : 'direct';
    const verdict = stableVerdict(opts.state.hosts[host], measured);
    opts.state.hosts[host] = measured;
    opts.log?.(`CORS ${host}: ${verdict}${failures.length ? ' – ' + failures[0] : ''}`);
    results.push({ host, url, verdict, failures });
  }
  return results;
}

/**
 * Fetches, builds, checks one real file per media host of the entries
 * offered for direct download, and builds again with those results. A
 * redirect of a media file may only stay on the hosts the entries using
 * that media host allow. Never throws for a source that fails; the
 * publishing gates (publishGates) are the caller's next step.
 */
export async function collectAndBuild(
  catalog: SourceCatalog,
  opts: {
    net: Net;
    include: readonly EntryStatus[];
    state: BuilderState;
    released: readonly ReleasedItem[];
    previous?: SourceIndex;
    now: Date;
    /** App origins the file check sends; none: every media host stays 'unverified'. */
    origins: readonly string[];
    log?: (m: string) => void;
  },
): Promise<{ index: SourceIndex; report: BuildReport; hostChecks: HostCheck[] }> {
  const { net, include, state, log } = opts;
  const collected = await collectInputs(catalog, { net, include, state, log, now: opts.now });
  const gone = new Set(state.gone ?? []);
  const base = { now: opts.now, ...collected, previous: opts.previous, released: opts.released, include, gone };
  const first = buildIndex(catalog, { ...base, hosts: {} });
  const direct = new Set(catalog.entries.filter((e) => e.delivery === 'direct' && e.type !== 'link').map((e) => e.id));
  const allowedByHost = new Map<string, Set<string>>();
  for (const e of first.index.entries) {
    const source = catalog.entries.find((c) => c.id === e.id);
    if (!source) continue;
    for (const it of e.items)
      for (const f of it.files) {
        const host = new URL(f.url).hostname;
        const set = allowedByHost.get(host) ?? new Set<string>();
        for (const h of allowedHosts(source)) set.add(h);
        allowedByHost.set(host, set);
      }
  }
  const hostChecks = await checkHosts(
    { ...first.index, entries: first.index.entries.filter((e) => direct.has(e.id)) },
    { net, origins: opts.origins, state, allowed: (host) => [...(allowedByHost.get(host) ?? [host])], log },
  );
  const hosts = Object.fromEntries(hostChecks.map((h) => [h.host, h.verdict]));
  const { index, report } = buildIndex(catalog, { ...base, hosts });
  // What a source said is gone stays out from now on.
  state.gone = [...new Set([...(state.gone ?? []), ...report.gone])];
  return { index, report, hostChecks };
}
