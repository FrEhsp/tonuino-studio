/**
 * Builds the published index from the curated catalogue and what the
 * builder fetched (feeds, archive.org metadata, GitLab tags, the pages
 * of series without a feed, CORS checks). Pure: all network work happens before, in the
 * script (scripts/sources/build-index.ts), and tests feed saved answers.
 *
 * Nothing reaches the index unless a person admitted the source; new
 * episodes with warning words, story notes or (for some sources) every new
 * episode wait until a person released them in sources/released.json.
 */
import { shortAbout } from './about';
import { titleUrl, type PageFacts } from './pages';
import { admitNewTitle, admitReleased, MAX_NEW_PER_RUN } from './rules';
import { ccFromUrl } from './licence';
import { embedAllowed, fileAllowed, providerOf, saveWay } from './providers';
import { isMeasurementHost, type HostVerdict } from './cors';
import { coverUrl, entryHosts } from './cover';
import { traditionOf, type GsbCredit } from './gsb';
import { checkQuality, emptyQualityCounts, type QualityCounts, type QualityVerdict } from './quality';
import { expired } from './reach';
import { parseRss } from './rss';
import { isDay } from './validate';
import { cleanTitle, dropCounter, fileNameOf, holdReasons, parseAges, parseDuration, plainText, prefixWords, withoutPhrases } from './text';
import type {
  AgeRange,
  CatalogEntry,
  Category,
  EntryStatus,
  EntryType,
  IndexEntry,
  IndexItem,
  MediaFile,
  Person,
  ReleasedItem,
  Rights,
  SourceCatalog,
  SourceIndex,
} from './types';

export interface ArchiveFile {
  name: string;
  /** "original" or "derivative". */
  source?: string;
  format?: string;
  size?: string;
  /** Seconds ("530.74") or "mm:ss". */
  length?: string;
  title?: string;
  /** "1" or "1/14". */
  track?: string;
  creator?: string;
  /** Checksum archive.org lists for the file. */
  sha1?: string;
}

export interface ArchiveMetadata {
  metadata?: { identifier?: string; title?: string; creator?: string; licenseurl?: string; date?: string };
  files?: ArchiveFile[];
}

/** One story file of the Global Storybooks repository, as the builder read it. */
export interface GsbStoryData {
  id: string;
  path: string;
  name: string;
  size?: number;
  title?: string;
  reader?: string;
  year?: string;
  durationSec?: number;
  comment?: GsbCredit;
}

export interface BuildInputs {
  now: Date;
  /** Entry id -> feed XML, or the error the fetch ended with. */
  feeds: Record<string, string | Error>;
  /** Archive identifier -> item metadata. */
  archive: Record<string, ArchiveMetadata | Error>;
  /** Entry id -> stories read from the repository. */
  gsb: Record<string, GsbStoryData[] | Error>;
  /** Media host -> result of the CORS check for all app origins. */
  hosts: Record<string, HostVerdict>;
  /** Last published index: its items stand in when a source cannot be read, and tell which items are new. */
  previous?: SourceIndex;
  /** Items a person released after a hold (sources/released.json). */
  released: readonly ReleasedItem[];
  /** ['active'] in production; ['active', 'review'] for a local preview. */
  include: readonly EntryStatus[];
  /** Entry id -> what the series pages of a link entry said (collect.ts), or why they did not load. */
  series?: Record<string, SeriesData | Error>;
  /** Entry ids and item keys a source once said it no longer has: never listed again. */
  gone?: ReadonlySet<string>;
}

/** What the official pages of a series said (pages.ts). */
export interface SeriesData {
  /** The title pages the series pages link, in page order, as the reader writes them. */
  links: string[];
  /** Facts per title page; an Error when it did not load (a NetError keeps the HTTP status). */
  pages: Record<string, PageFacts | Error>;
  /** Title page -> the series page that linked it first. */
  from?: Record<string, string>;
}

export interface BuildReport {
  generatedAt: string;
  holds: { entry: string; key: string; title: string; reasons: string[] }[];
  rejected: { entry: string; key: string; reason: string }[];
  /** gone: the source answered that it no longer has it (HTTP 404/410, unknown identifier); its titles leave the list at once. */
  failures: { entry: string; error: string; keptPrevious: boolean; gone?: boolean }[];
  downgraded: { entry: string; host: string; verdict: HostVerdict }[];
  skipped: { entry: string; status: EntryStatus }[];
  /** Entries whose review date passed; after 60 days they leave the index until reviewed. */
  overdue: { entry: string; next: string; days: number; dropped: boolean }[];
  /** Verdict per media host the index uses. */
  hosts: Record<string, HostVerdict>;
  /** Things an editor should look at that do not stop an item: titles to override, links not taken over. */
  notes: { entry: string; key?: string; note: string }[];
  counts: { entries: number; items: number };
  /** How many titles the quality filter left out or held, and how many have no description, per reason (quality.ts). */
  quality: QualityCounts;
  /** Entry ids and item keys whose source said they are gone for good (HTTP 404/410): kept out from now on. */
  gone: string[];
  /** New titles a series brought in by the fixed rules (rules.ts), without a person. */
  added: { entry: string; key: string; title: string }[];
}

/** After this many days without a new build the app says the list is old. */
export const STALE_DAYS = 14;
/** Overdue reviews: a warning first, then the entry leaves the index. */
export const OVERDUE_DROP_DAYS = 60;
/** Newest episodes per podcast. */
export const DEFAULT_MAX_ITEMS = 100;
/** Items from this age on are never listed, whatever a person released. */
export const REJECT_MIN_AGE = 16;

const DAY_MS = 86_400_000;

class EntryFailure extends Error {
  /** The source no longer has it: the titles of yesterday are not kept. */
  readonly gone: boolean;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.gone = isGone(cause);
  }
}

/**
 * Whether a failed request means "not there any more" rather than "not
 * reachable right now": HTTP 404 or 410 (NetError keeps the status), or an
 * answer of archive.org that does not know the identifier.
 * Timeouts, 5xx, 429 and network errors are never gone.
 */
export function isGone(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const status = (e as { status?: unknown }).status;
  if (status === 404 || status === 410) return true;
  return /kennt diese Kennung nicht/.test(e.message);
}

/** What a source gave: its titles and, when it publishes one, its picture and where the picture is from. */
interface Sourced {
  items: IndexItem[];
  cover?: string;
  coverFrom?: string;
  /** The source's own words about itself (about.ts). */
  about?: string;
}

interface Context {
  inputs: BuildInputs;
  report: BuildReport;
  released: Map<string, ReleasedItem>;
  /** Item keys of the last published index. */
  known: Set<string>;
}

function iso(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const t = Date.parse(date);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function httpsUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Hosts an entry's links may point to: its own page and the hosts the catalogue lists in linkHosts. */
export function linkHostsOf(entry: Pick<CatalogEntry, 'pageUrl' | 'linkHosts'>): string[] {
  const own = hostOf(entry.pageUrl);
  return [...(own ? [own] : []), ...(entry.linkHosts ?? [])];
}

/** "itunes:explicit" set by the publisher: "true", "yes" or "explicit". */
export function isExplicit(v: string | undefined): boolean {
  return !!v && /^(?:true|yes|explicit)$/i.test(v.trim());
}

function sameAges(a: AgeRange, b: AgeRange): boolean {
  return a.min === b.min && a.max === b.max;
}

/**
 * The episode's own age statement, narrowed by the entry: "(Ab 8 Jahren)" in
 * a show for 8 to 12 stays 8 to 12 and is not stored. Kept only when it differs.
 */
export function itemAges(entryAges: AgeRange, found: AgeRange | undefined): AgeRange | undefined {
  if (!found) return undefined;
  const merged: AgeRange = { min: Math.max(found.min, entryAges.min), max: found.max ?? entryAges.max };
  if (merged.max !== undefined && merged.max < merged.min) merged.max = undefined;
  return sameAges(merged, entryAges) ? undefined : merged;
}

/** Ages a person set when releasing an item; stored only when they differ from the entry. */
function releasedAges(entryAges: AgeRange, ages: AgeRange): AgeRange | undefined {
  const a: AgeRange = ages.max === undefined ? { min: ages.min } : { min: ages.min, max: ages.max };
  return sameAges(a, entryAges) ? undefined : a;
}

export function categoryFor(entry: Pick<CatalogEntry, 'category' | 'categoryRules'>, title: string): Category | 'skip' {
  for (const r of entry.categoryRules ?? []) if (new RegExp(r.pattern, 'i').test(title)) return r.category;
  return entry.category;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------------------------------------ podcasts */

function podcastItems(entry: Extract<CatalogEntry, { type: 'podcast' }>, xml: string, ctx: Context): Sourced {
  const { report } = ctx;
  const feed = parseRss(xml);
  const showCover = httpsUrl(feed.image);
  const time = (d: string | undefined) => {
    const t = d ? Date.parse(d) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  };
  const newestFirst = feed.items.map((it, i) => ({ it, i })).sort((a, b) => time(b.it.pubDate) - time(a.it.pubDate) || a.i - b.i);
  const linkHosts = linkHostsOf(entry);
  const linkOk = (raw: string | undefined) => {
    const u = httpsUrl(raw);
    return u && linkHosts.includes(new URL(u).hostname) ? u : undefined;
  };
  // Episodes without a page of their own link to the show page from the feed, not to the catalogue's article.
  const showPage = linkOk(feed.link);
  const channelExplicit = isExplicit(feed.explicit);
  const words = prefixWords(entry.titlePrefixes);
  const out: IndexItem[] = [];
  for (const { it } of newestFirst.slice(0, entry.maxItems ?? DEFAULT_MAX_ITEMS)) {
    const key = `${entry.id}/${it.guid?.trim() || it.enclosure?.url || (it.title ?? '').trim()}`;
    const reject = (reason: string) => report.rejected.push({ entry: entry.id, key, reason });
    const enc = it.enclosure;
    if (!enc) {
      reject('Keine Audiodatei in der Folge');
      continue;
    }
    let url: URL;
    try {
      url = new URL(enc.url);
    } catch {
      reject('Adresse der Datei ist ungültig');
      continue;
    }
    if (url.protocol !== 'https:') {
      reject('Datei nicht über HTTPS');
      continue;
    }
    if (isMeasurementHost(url.hostname) || !entry.mediaHosts.includes(url.hostname)) {
      reject(`Host nicht erlaubt: ${url.hostname}`);
      continue;
    }
    if (enc.type && !/^audio\//i.test(enc.type)) {
      reject(`Kein Audio (${enc.type})`);
      continue;
    }
    // Explicit is never listed, whatever a person released.
    if (channelExplicit || isExplicit(it.explicit)) {
      reject(channelExplicit ? 'Der Anbieter markiert den ganzen Feed als „explicit“' : 'Der Anbieter markiert die Folge als „explicit“');
      continue;
    }
    const original = plainText(it.title) || 'Ohne Titel';
    const category = categoryFor(entry, original);
    if (category === 'skip') continue;
    const override = entry.titleOverrides?.[key];
    const title = override ?? cleanTitle(original, { pattern: entry.titlePattern, prefixes: entry.titlePrefixes, counter: entry.dropCounter });
    const leftover = override ? undefined : words.find((w) => title.toLowerCase().startsWith(w));
    if (leftover) report.notes.push({ entry: entry.id, key, note: `Titel beginnt noch mit „${title.slice(0, leftover.length)}“: ${title} (titleOverrides setzen)` });
    // Everything the publisher wrote about the episode, as plain text: title, description, summary, subtitle, show notes.
    const text = withoutPhrases([it.title, it.description, it.summary, it.subtitle, it.content].map(plainText).filter(Boolean).join(' \n '), entry.ignorePhrases);
    const release = ctx.released.get(key);
    const found = parseAges(text);
    const ages = release?.ages ? releasedAges(entry.ages, release.ages) : itemAges(entry.ages, found);
    if (ages && ages.min >= REJECT_MIN_AGE) {
      reject(`Altersangabe ab ${ages.min}`);
      continue;
    }
    const durationSec = parseDuration(it.duration);
    const size = enc.length && enc.length > 0 ? enc.length : undefined;
    // What the publisher wrote besides the title: the start shows a trailer, nothing at all sorts the episode down.
    const about = [it.description, it.summary, it.subtitle, it.content].map(plainText).find((t) => t && t !== plainText(it.title));
    const quality = checkQuality({ title: original, about, episodeType: it.episodeType, category, durationSec, size, minSeconds: entry.minSeconds });
    if (!release && quality.reject) {
      ctx.report.quality[quality.reject.code]++;
      reject(quality.reject.reason);
      continue;
    }
    if (!release) {
      const reasons = holdReasons(text);
      reasons.push(...quality.holds.map((h) => h.reason));
      if (found && entry.ages.max !== undefined && found.min > entry.ages.max) reasons.push(`Altersangabe der Folge (ab ${found.min}) passt nicht zur Reihe`);
      else if (found && found.min >= 12 && found.min > entry.ages.min) reasons.push(`Altersangabe der Folge: ab ${found.min}`);
      if (entry.holdNew && !ctx.known.has(key)) reasons.push('Neue Folge: wird vor der Aufnahme angehört');
      if (reasons.length) {
        for (const h of quality.holds) ctx.report.quality[h.code]++;
        report.holds.push({ entry: entry.id, key, title: original, reasons });
        continue;
      }
    }
    const link = linkOk(it.link);
    if (it.link && !link) report.notes.push({ entry: entry.id, key, note: `Link der Folge nicht übernommen (Host nicht in linkHosts): ${it.link}` });
    // The URL stays exactly as published (query strings such as ?refId=… included).
    const file: MediaFile = { url: enc.url.trim(), name: fileNameOf(enc.url), size, durationSec, title };
    const cover = httpsUrl(it.image);
    const aboutText = [it.description, it.summary, it.subtitle, it.content].map((t) => shortAbout(t, { title: original })).find(Boolean);
    out.push({
      key,
      title,
      originalTitle: title !== original ? original : undefined,
      category,
      ages,
      published: iso(it.pubDate),
      durationSec,
      size,
      pageUrl: link ?? showPage,
      files: [file],
      ...(quality.sparse ? { sparse: true as const } : {}),
      ...(cover && cover !== showCover ? { cover } : {}),
      ...(aboutText ? { about: aboutText } : {}),
    });
  }
  return { items: out, cover: showCover, coverFrom: `Bild aus dem Podcast von ${entry.publisher}`, about: shortAbout(feed.description, { title: feed.title }) };
}

/* ------------------------------------------------------------ archive.org */

function trackNo(v: string | undefined): number | undefined {
  const m = v ? /^(\d+)/.exec(v.trim()) : null;
  return m ? Number(m[1]) : undefined;
}

export function archiveDownloadUrl(id: string, name: string): string {
  return `https://archive.org/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;
}

function archiveFiles(id: string, files: readonly ArchiveFile[]): MediaFile[] {
  return files
    .map((f) => ({
      url: archiveDownloadUrl(id, f.name),
      name: f.name.split('/').pop() ?? f.name,
      size: f.size && /^\d+$/.test(f.size) ? Number(f.size) : undefined,
      durationSec: parseDuration(f.length),
      title: f.title?.replace(/^\d+\s*-\s*/, '').trim() || undefined,
      track: trackNo(f.track),
    }))
    .sort((a, b) => (a.track ?? 9999) - (b.track ?? 9999) || a.name.localeCompare(b.name));
}

function sum(values: (number | undefined)[]): number | undefined {
  return values.length && values.every((v) => v !== undefined) ? (values as number[]).reduce((a, b) => a + b, 0) : undefined;
}

function archiveData(id: string, ctx: Context): ArchiveMetadata {
  const meta = ctx.inputs.archive[id];
  if (meta === undefined) throw new EntryFailure('archive.org-Daten fehlen');
  if (meta instanceof Error) throw new EntryFailure(`archive.org-Daten nicht geladen: ${meta.message}`, meta);
  return meta;
}

/** The MP3s of an album item: the uploaded originals, else one derivative format. */
function albumMp3s(files: readonly ArchiveFile[]): ArchiveFile[] {
  const mp3 = files.filter((f) => /mp3/i.test(f.format ?? '') && /\.mp3$/i.test(f.name));
  const originals = mp3.filter((f) => f.source === 'original');
  if (originals.length) return originals;
  for (const format of ['VBR MP3', '128Kbps MP3', '64Kbps MP3']) {
    const group = mp3.filter((f) => f.format === format);
    if (group.length) return group;
  }
  return mp3;
}

/** Differences between the files a person checked and what archive.org lists now. */
export function albumChanges(reviewed: readonly { name: string; sha1: string }[], now: readonly ArchiveFile[]): string[] {
  const out: string[] = [];
  const current = new Map(now.map((f) => [f.name, f.sha1?.toLowerCase()]));
  for (const r of reviewed) {
    if (!current.has(r.name)) out.push(`fehlt: ${r.name}`);
    else if (current.get(r.name) !== r.sha1.toLowerCase()) out.push(`anderer Inhalt: ${r.name}`);
  }
  const known = new Set(reviewed.map((r) => r.name));
  for (const f of now) if (!known.has(f.name)) out.push(`neu: ${f.name}`);
  return out;
}

/**
 * A picture the uploader put into an album item (JPEG or PNG among the
 * original files), "cover", "folder" or "front" in the name first. None: no
 * cover; the pictures archive.org makes itself are not used.
 */
export function albumCover(id: string, files: readonly ArchiveFile[]): string | undefined {
  // Small copies ("…_thumb.jpg") only when there is nothing else.
  const all = files.filter((f) => f.source === 'original' && /^(?:JPEG|PNG)$/i.test(f.format ?? '') && /\.(?:jpe?g|png)$/i.test(f.name));
  const full = all.filter((f) => !/_thumb\.[a-z]+$/i.test(f.name));
  const images = full.length ? full : all;
  const best = images.find((f) => /cover|folder|front/i.test(f.name.split('/').pop() ?? '')) ?? images[0];
  return best ? archiveDownloadUrl(id, best.name) : undefined;
}

function archiveAlbumItems(entry: Extract<CatalogEntry, { type: 'archive-album' }>, ctx: Context): Sourced {
  const meta = archiveData(entry.archiveId, ctx);
  const cc = ccFromUrl(meta.metadata?.licenseurl);
  if (!cc) throw new EntryFailure('Keine Lizenzangabe');
  const want = entry.rights;
  if (want.kind !== 'cc' || want.id !== cc.id || want.version !== cc.version || (want.port ?? '') !== (cc.port ?? '')) {
    throw new EntryFailure(`Lizenz geändert: ${meta.metadata?.licenseurl}`);
  }
  const mp3s = albumMp3s(meta.files ?? []);
  const files = archiveFiles(entry.archiveId, mp3s);
  if (!files.length) throw new EntryFailure('Keine MP3-Dateien');
  const key = `${entry.id}/${entry.archiveId}`;
  // What a person listened to is what goes out: a new, missing or replaced file holds the album until the catalogue is updated.
  if (entry.files) {
    const changed = albumChanges(entry.files, mp3s);
    if (changed.length) {
      ctx.report.holds.push({ entry: entry.id, key, title: entry.title, reasons: [`Dateien seit der Prüfung geändert: ${changed.join('; ')}. Anhören, dann files im Katalog anpassen`] });
      return { items: [] };
    }
  }
  const creator = meta.metadata?.creator?.trim();
  const creators: Person[] = creator ? [{ name: creator, role: 'performer' }] : [];
  const items: IndexItem[] = [
    {
      key,
      title: entry.title,
      category: entry.category,
      published: meta.metadata?.date && /^\d{4}/.test(meta.metadata.date) ? meta.metadata.date.slice(0, 4) : undefined,
      durationSec: sum(files.map((f) => f.durationSec)),
      size: sum(files.map((f) => f.size)),
      pageUrl: entry.pageUrl,
      creators,
      rights: { kind: 'cc', id: cc.id, version: cc.version, port: cc.port, url: cc.url },
      files,
    },
  ];
  const cover = albumCover(entry.archiveId, meta.files ?? []);
  return { items, cover, coverFrom: cover ? `Bild aus dem Album bei archive.org${creator ? ` (${creator})` : ''}` : undefined };
}

/* ------------------------------------------------------------ Global Storybooks */

function splitNames(s: string | undefined): string[] {
  return (s ?? '')
    .split(/\s*,\s*|\s+(?:and|und|&)\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function gsbFileUrl(project: number, path: string, ref: string): string {
  return `https://gitlab.com/api/v4/projects/${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;
}

function gsbItems(entry: Extract<CatalogEntry, { type: 'gitlab-gsb' }>, ctx: Context): IndexItem[] {
  const { report } = ctx;
  const data = ctx.inputs.gsb[entry.id];
  if (data instanceof Error) throw new EntryFailure(`Repository nicht gelesen: ${data.message}`);
  if (!data?.length) throw new EntryFailure('Keine Daten aus dem Repository');
  const out: IndexItem[] = [];
  for (const story of entry.stories) {
    const key = `${entry.id}/${story.id}`;
    const d = data.find((x) => x.id === story.id);
    if (!d) {
      report.rejected.push({ entry: entry.id, key, reason: 'Datei nicht im Repository' });
      continue;
    }
    const title = d.title?.trim() || `Geschichte ${story.id}`;
    const cc = ccFromUrl(story.licence);
    const family = (d.comment?.license ?? '').replace(/^CC[-\s]/i, '').trim().toLowerCase();
    if (!cc || family !== cc.id) {
      // Not releasable: the catalogue has to be corrected first.
      report.holds.push({ entry: entry.id, key, title, reasons: [`Lizenzangaben widersprechen sich (Datei: ${d.comment?.license ?? 'keine'}, Katalog: ${story.licence}); Katalog prüfen`] });
      continue;
    }
    const release = ctx.released.get(key);
    if (story.review && !release) {
      report.holds.push({ entry: entry.id, key, title, reasons: [story.review] });
      continue;
    }
    const ages = release?.ages ? releasedAges(entry.ages, release.ages) : undefined;
    if (ages && ages.min >= REJECT_MIN_AGE) {
      report.rejected.push({ entry: entry.id, key, reason: `Altersangabe ab ${ages.min}` });
      continue;
    }
    // "Ghanaian folktale" is where the tale comes from, not a person.
    const tradition = traditionOf(d.comment?.textBy);
    const creators: Person[] = [
      ...(tradition ? [] : splitNames(d.comment?.textBy).map((name): Person => ({ name, role: 'author' }))),
      ...splitNames(d.comment?.translatedBy).map((name): Person => ({ name, role: 'translator' })),
      ...(d.reader?.trim() ? [{ name: d.reader.trim(), role: 'reader' } as Person] : []),
    ];
    const rights: Rights = { kind: 'cc', id: cc.id, version: cc.version, port: cc.port, url: cc.url };
    out.push({
      key,
      title,
      category: entry.category,
      ages,
      published: d.year && /^\d{4}$/.test(d.year) ? d.year : undefined,
      durationSec: d.durationSec,
      size: d.size,
      pageUrl: entry.pageUrl,
      creators,
      tradition,
      rights,
      files: [{ url: gsbFileUrl(entry.project, d.path, entry.ref), name: d.name, size: d.size, durationSec: d.durationSec, title }],
    });
  }
  return out;
}

/* ------------------------------------------------------------ link entries */

/** The key of a link item: entry id + the path of its page ("ard-hoerspielklassiker/episode/urn:ard:episode:02e2…/"). */
export function linkKey(entryId: string, pageUrl: string): string {
  return `${entryId}/${pageUrl.replace(/^https?:\/\/[^/]+\//, '')}`;
}

/**
 * Link entries: the titles a person chose in the catalogue, refreshed from
 * their pages when the series is read (description, picture, end date), and
 * new titles of the series admitted by the fixed rules (rules.ts). A title
 * whose page answers 404 or 410 is gone for good.
 */
/**
 * What a link title offers besides its page, as far as its provider's terms
 * allow (providers.ts): the file to save where saving is allowed, else none,
 * and the provider's own player to listen in the app.
 */
function playable(entry: Extract<CatalogEntry, { type: 'link' }>, fileUrl: string | undefined, embed: string | undefined, name: string | undefined, size?: number): Pick<IndexItem, 'files' | 'embed'> {
  const files = fileAllowed(entry, fileUrl) ? [{ url: fileUrl, name: name ?? fileNameOf(fileUrl), ...(size ? { size } : {}) }] : [];
  return { files, ...(embedAllowed(entry.rights, embed) ? { embed } : {}) };
}

function linkItems(entry: Extract<CatalogEntry, { type: 'link' }>, ctx: Context): IndexItem[] {
  const out: IndexItem[] = [];
  const reader = entry.series?.reader;
  const raw = ctx.inputs.series?.[entry.id];
  if (raw instanceof Error) ctx.report.notes.push({ entry: entry.id, note: `Seiten der Reihe nicht gelesen: ${raw.message}` });
  const data = raw instanceof Error ? undefined : raw;
  const known = new Set<string>();
  // What yesterday's list said about a title stays when its page is not read today (offline, page down).
  const before = new Map(ctx.inputs.previous?.entries.find((x) => x.id === entry.id)?.items.map((x) => [x.key, x]) ?? []);
  for (const it of entry.items) {
    const key = linkKey(entry.id, it.pageUrl);
    const own = reader ? titleUrl(reader, it.pageUrl) : undefined;
    if (own) known.add(own);
    const facts = own ? data?.pages[own] : undefined;
    if (facts instanceof Error && isGone(facts)) {
      ctx.report.gone.push(key);
      ctx.report.rejected.push({ entry: entry.id, key, reason: 'beim Anbieter nicht mehr da' });
      continue;
    }
    const fresh = facts instanceof Error ? undefined : facts;
    const ages = it.ages ? releasedAges(entry.ages, it.ages) : undefined;
    if (ages && ages.min >= REJECT_MIN_AGE) {
      ctx.report.rejected.push({ entry: entry.id, key, reason: `Altersangabe ab ${ages.min}` });
      continue;
    }
    // The page's own picture and end date are the current ones; what the catalogue says stands in.
    const cover = httpsUrl(fresh?.image) ?? it.cover;
    const until = fresh?.until ?? it.until;
    // The page's own words when it was read; the catalogue's sentence stands in until then, else yesterday's.
    const about = shortAbout(fresh?.description, { title: it.title }) ?? it.about ?? before.get(key)?.about;
    const creators = it.creators ?? fresh?.creators;
    const fileName = it.fileName ?? (fresh?.fileUrl ? fileNameOf(fresh.fileUrl) : undefined);
    out.push({
      key,
      title: entry.dropCounter ? dropCounter(it.title) : it.title,
      category: it.category ?? entry.category,
      ages,
      durationSec: it.durationSec ?? fresh?.durationSec,
      size: it.size,
      pageUrl: it.pageUrl,
      ...playable(entry, fresh?.fileUrl ?? it.fileUrl, fresh?.embed ?? it.embed, fileName, it.size),
      fileName,
      delivery: 'browser',
      ...(creators?.length ? { creators } : {}),
      ...(cover ? { cover } : {}),
      ...(until ? { until } : {}),
      ...(about ? { about } : {}),
    });
  }
  if (!data || !entry.series || entry.series.noNew) return out;
  // New titles of the series, in page order, at most MAX_NEW_PER_RUN in a run.
  let added = 0;
  for (const url of data.links) {
    if (known.has(url)) continue;
    known.add(url);
    const key = linkKey(entry.id, url);
    if (ctx.inputs.gone?.has(key)) continue;
    const facts = data.pages[url];
    if (facts === undefined) continue; // not read in this run
    if (facts instanceof Error) {
      if (isGone(facts)) ctx.report.gone.push(key);
      continue;
    }
    if (added >= MAX_NEW_PER_RUN) break;
    const original = facts.title ?? '';
    const title = entry.titleOverrides?.[key] ?? cleanTitle(original, { pattern: entry.titlePattern, prefixes: entry.titlePrefixes, counter: entry.dropCounter });
    const category = categoryFor(entry, original);
    if (category === 'skip') continue;
    const release = ctx.released.get(key);
    // The age the page that linked the title states for all its titles, else the series'.
    const pageAges = entry.series.pageAges?.[data.from?.[url] ?? ''];
    const rules = pageAges
      ? { ages: { ...pageAges, source: 'publisher' as const }, category: entry.category, minSeconds: entry.minSeconds, agesFromSeries: true }
      : { ages: entry.ages, category: entry.category, minSeconds: entry.minSeconds, agesFromSeries: entry.series.agesFromSeries };
    const verdict = release ? admitReleased(facts, ctx.inputs.now) : admitNewTitle(facts, rules, category, ctx.inputs.now);
    if (!verdict.ok) {
      ctx.report.holds.push({ entry: entry.id, key, title: original || url, reasons: verdict.reasons });
      continue;
    }
    // Link titles carry their ages as found, so the list knows them per title.
    const ages = release?.ages ? releasedAges(entry.ages, release.ages) : verdict.ages ? itemAges(entry.ages, verdict.ages) : undefined;
    if (ages && ages.min >= REJECT_MIN_AGE) {
      ctx.report.rejected.push({ entry: entry.id, key, reason: `Altersangabe ab ${ages.min}` });
      continue;
    }
    const about = shortAbout(facts.description, { title: original });
    const cover = httpsUrl(facts.image);
    out.push({
      key,
      title,
      ...(title !== original ? { originalTitle: original } : {}),
      category,
      ages,
      durationSec: facts.durationSec,
      pageUrl: url,
      ...playable(entry, facts.fileUrl, facts.embed, facts.fileUrl ? fileNameOf(facts.fileUrl) : undefined),
      ...(facts.fileUrl ? { fileName: fileNameOf(facts.fileUrl) } : {}),
      delivery: 'browser',
      ...(facts.creators?.length ? { creators: facts.creators } : {}),
      ...(cover ? { cover } : {}),
      ...(facts.until ? { until: facts.until } : {}),
      ...(about ? { about } : {}),
    });
    ctx.report.added.push({ entry: entry.id, key, title });
    added++;
  }
  return out;
}

/**
 * The quality filter for sources without episode texts (books, albums,
 * stories, links): title words, length and bit rate. Podcasts run it inside
 * podcastItems, where the show notes are known. A released title always passes.
 */
function qualityFiltered(entry: CatalogEntry, items: IndexItem[], ctx: Context): IndexItem[] {
  if (entry.type === 'podcast') return items;
  return items.filter((it) => {
    if (ctx.released.has(it.key)) return true;
    // Albums carry the entry's own title, chosen by a person.
    const title = entry.type === 'archive-album' ? '' : (it.originalTitle ?? it.title);
    const size = it.size ?? (it.files.length && it.files.every((f) => f.size) ? it.files.reduce((n, f) => n + (f.size ?? 0), 0) : undefined);
    const q: QualityVerdict = checkQuality({ title, category: it.category, durationSec: it.durationSec, size, minSeconds: entry.minSeconds });
    if (q.reject) {
      ctx.report.quality[q.reject.code]++;
      ctx.report.rejected.push({ entry: entry.id, key: it.key, reason: q.reject.reason });
      return false;
    }
    if (q.holds.length) {
      for (const h of q.holds) ctx.report.quality[h.code]++;
      ctx.report.holds.push({ entry: entry.id, key: it.key, title: it.originalTitle ?? it.title, reasons: q.holds.map((h) => h.reason) });
      return false;
    }
    return true;
  });
}

/** Titles and picture of a source. Global Storybooks and link entries publish no picture. */
function itemsFor(entry: CatalogEntry, ctx: Context): Sourced {
  switch (entry.type) {
    case 'podcast': {
      const xml = ctx.inputs.feeds[entry.id];
      if (xml === undefined) throw new EntryFailure('Feed nicht geladen');
      if (xml instanceof Error) throw new EntryFailure(`Feed nicht erreichbar: ${xml.message}`, xml);
      try {
        return podcastItems(entry, xml, ctx);
      } catch (e) {
        throw new EntryFailure(`Feed nicht lesbar: ${errorText(e)}`);
      }
    }
    case 'archive-album':
      return archiveAlbumItems(entry, ctx);
    case 'gitlab-gsb':
      return { items: gsbItems(entry, ctx) };
    case 'link':
      return { items: linkItems(entry, ctx) };
    case 'commons':
      throw new EntryFailure('Commons-Abfrage ist noch nicht gebaut');
  }
}

function deliveryFor(entry: CatalogEntry, items: IndexItem[], ctx: Context): IndexEntry['delivery'] {
  if (entry.delivery === 'browser' || entry.type === 'link') return 'browser';
  const hosts = new Set<string>();
  for (const it of items) for (const f of it.files) hosts.add(new URL(f.url).hostname);
  let result: IndexEntry['delivery'] = 'direct';
  for (const host of hosts) {
    const verdict = ctx.inputs.hosts[host] ?? 'unverified';
    ctx.report.hosts[host] = verdict;
    if (verdict !== 'direct') {
      ctx.report.downgraded.push({ entry: entry.id, host, verdict });
      result = 'browser';
    }
  }
  return result;
}

/** The item with the pick a person set in sources/released.json, and without an older one. */
function withPick(item: IndexItem, pick: IndexItem['featured']): IndexItem {
  if (!pick && !item.featured) return item;
  const { featured: _old, ...rest } = item;
  return pick ? { ...rest, featured: { rank: pick.rank, why: pick.why.trim() } } : rest;
}

/**
 * The entry with the cover a person set in the catalogue, else the one the
 * source publishes, and the covers of its titles. A cover the app would not
 * show (http, measurement service, a host the entry does not use and that is
 * not a known cover host, see cover.ts) is left out and noted; a title's
 * cover equal to the entry's is not repeated.
 */
function withCovers(entry: IndexEntry, cover: string | undefined, coverFrom: string | undefined, report: BuildReport): IndexEntry {
  const hosts = entryHosts(entry);
  const checked = (raw: string | undefined, key?: string): string | undefined => {
    if (!raw) return undefined;
    const ok = coverUrl(raw, hosts);
    if (!ok) report.notes.push({ entry: entry.id, key, note: `Cover nicht übernommen (nur https, Host der Quelle oder bekannter Bilder-Host, siehe cover.ts): ${raw}` });
    return ok;
  };
  const entryCover = checked(cover);
  const items = entry.items.map((it) => {
    if (!it.cover) return it;
    const { cover: own, ...rest } = it;
    const ok = own === entryCover ? undefined : checked(own, it.key);
    return ok ? { ...rest, cover: ok } : rest;
  });
  const from = coverFrom?.trim();
  return { ...entry, items, ...(entryCover ? { cover: entryCover, ...(from ? { coverFrom: from } : {}) } : {}) };
}

/** Days the review of an entry is overdue (0 when not due). */
export function overdueDays(entry: Pick<CatalogEntry, 'review'>, now: Date): number {
  const next = entry.review?.next ? Date.parse(entry.review.next) : NaN;
  if (!Number.isFinite(next) || now.getTime() <= next) return 0;
  return Math.floor((now.getTime() - next) / DAY_MS);
}

export function buildIndex(catalog: SourceCatalog, inputs: BuildInputs): { index: SourceIndex; report: BuildReport } {
  const now = inputs.now.toISOString();
  const report: BuildReport = {
    generatedAt: now,
    holds: [],
    rejected: [],
    failures: [],
    downgraded: [],
    skipped: [],
    overdue: [],
    hosts: {},
    notes: [],
    counts: { entries: 0, items: 0 },
    quality: emptyQualityCounts(),
    gone: [],
    added: [],
  };
  const ctx: Context = {
    inputs,
    report,
    released: new Map(inputs.released.map((r) => [r.key, r])),
    known: new Set(inputs.previous?.entries.flatMap((e) => e.items.map((i) => i.key)) ?? []),
  };
  const blocked = new Set(catalog.blocked);
  const entries: IndexEntry[] = [];
  for (const entry of catalog.entries) {
    if (!inputs.include.includes(entry.status)) {
      report.skipped.push({ entry: entry.id, status: entry.status });
      continue;
    }
    if (blocked.has(entry.id) || inputs.gone?.has(entry.id)) continue;
    const late = overdueDays(entry, inputs.now);
    if (late > 0 && entry.review) {
      const dropped = late > OVERDUE_DROP_DAYS;
      report.overdue.push({ entry: entry.id, next: entry.review.next, days: late, dropped });
      if (dropped) continue;
    }
    let items: IndexItem[];
    let sourceCover: string | undefined;
    let sourceCoverFrom: string | undefined;
    let sourceAbout: string | undefined;
    let checkedAt = now;
    try {
      const sourced = itemsFor(entry, ctx);
      items = qualityFiltered(entry, sourced.items, ctx);
      sourceCover = sourced.cover;
      sourceCoverFrom = sourced.coverFrom;
      sourceAbout = sourced.about;
    } catch (e) {
      // A source that is not reachable today keeps yesterday's titles; one that says it no longer has them leaves the list.
      const gone = e instanceof EntryFailure && e.gone;
      const prev = gone ? undefined : inputs.previous?.entries.find((x) => x.id === entry.id);
      report.failures.push({ entry: entry.id, error: errorText(e), keptPrevious: !!prev, ...(gone ? { gone: true } : {}) });
      if (gone) report.gone.push(entry.id);
      if (!prev) continue;
      items = prev.items;
      sourceCover = prev.cover;
      sourceCoverFrom = prev.coverFrom;
      sourceAbout = prev.about;
      checkedAt = prev.checkedAt;
    }
    items = items.filter((it) => !blocked.has(it.key) && !inputs.gone?.has(it.key)).map((it) => withPick(it, ctx.released.get(it.key)?.featured));
    // Titles whose time at the publisher is over (until) leave the list, also when kept from yesterday.
    items = items.filter((it) => {
      if (!expired(it, inputs.now.getTime())) return true;
      report.rejected.push({ entry: entry.id, key: it.key, reason: `beim Anbieter nur bis ${it.until}` });
      return false;
    });
    // Files whose host redirects through a measurement service or a host the entry does not allow are not listed.
    items = items.filter((it) => {
      const host = it.files.map((f) => hostOf(f.url)).find((h) => h !== undefined && inputs.hosts[h] === 'blocked');
      if (host) report.rejected.push({ entry: entry.id, key: it.key, reason: `${host} leitet über einen nicht erlaubten Host weiter` });
      return !host;
    });
    if (!items.length) continue;
    const categories = (['hoerspiel', 'hoerbuch', 'wissen', 'lied'] as const).filter((c) => items.some((i) => i.category === c));
    const delivery = deliveryFor(entry, items, ctx);
    // Saved on the publisher's page: the app opens the file itself, else the item's own page. Neither: families land on a general page.
    const lost = items.filter((it) => !((it.delivery ?? delivery) === 'direct' && it.files.length) && !it.files.some((f) => f.url) && (!it.pageUrl || it.pageUrl === entry.pageUrl));
    if (lost.length) {
      report.notes.push({
        entry: entry.id,
        note: `${lost.length} von ${items.length} Titeln ${lost.length === 1 ? 'hat' : 'haben'} weder eine Datei noch eine eigene Seite: „Auf der Webseite öffnen“ führt nur zur Seite der Quelle (${lost
          .slice(0, 3)
          .map((it) => it.title)
          .join(', ')}${lost.length > 3 ? ', …' : ''}).`,
      });
    }
    // Saved on the publisher's page and kept unchanged: the app knows the file by name, size or length ("Welche Folge ist das?").
    const unknowable = entry.editPolicy === 'unchanged' ? items.filter((it) => (it.delivery ?? delivery) === 'browser' && !it.files.length && !it.fileName && !it.size && !it.durationSec) : [];
    if (unknowable.length) {
      report.notes.push({
        entry: entry.id,
        note: `${unknowable.length} von ${items.length} Titeln ohne Dateiname, Größe und Länge: Die App kann eine gespeicherte Datei nicht vorschlagen, die Familie muss die Folge selbst auswählen (${unknowable
          .slice(0, 3)
          .map((it) => it.title)
          .join(', ')}${unknowable.length > 3 ? ', …' : ''}).`,
      });
    }
    const built: IndexEntry = {
      id: entry.id,
      type: entry.type,
      title: entry.title,
      publisher: entry.publisher,
      blurb: entry.blurb,
      categories,
      ages: entry.ages,
      language: entry.language,
      rights: entry.rights,
      delivery,
      editPolicy: entry.editPolicy,
      pageUrl: entry.pageUrl,
      note: entry.note,
      items,
      checkedAt,
      reviewedAt: entry.review?.at,
      featured: entry.featured ? { rank: entry.featured.rank, why: entry.featured.why.trim() } : undefined,
      ...(sourceAbout ? { about: sourceAbout } : {}),
      ...(entry.single ? { single: true as const } : {}),
    };
    const ownCover = entry.cover?.trim();
    entries.push(withCovers(built, ownCover || sourceCover, ownCover ? entry.coverFrom : sourceCoverFrom, report));
  }
  report.counts = { entries: entries.length, items: entries.reduce((n, e) => n + e.items.length, 0) };
  report.quality.sparse = entries.reduce((n, e) => n + e.items.filter((it) => it.sparse).length, 0);
  // A recommended title that did not make it into the list (held, rejected, gone from the feed) is worth a look.
  const listed = new Set(entries.flatMap((e) => e.items.map((it) => it.key)));
  for (const r of inputs.released) {
    if (r.featured && !listed.has(r.key)) report.notes.push({ entry: r.key.slice(0, r.key.indexOf('/')), key: r.key, note: 'Empfohlener Titel steht nicht in der Liste (gehalten, abgelehnt oder nicht mehr beim Anbieter)' });
  }
  const staleAfter = new Date(inputs.now.getTime() + STALE_DAYS * DAY_MS).toISOString();
  return { index: { format: 1, generatedAt: now, staleAfter, entries, blocked: [...blocked] }, report };
}

/* ------------------------------------------------------------ publishing gates */

/** Largest index the app is asked to load. */
export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
/** Largest drop in items from one build to the next without allowShrink. */
export const MAX_SHRINK = 0.2;

const ENTRY_KEYS = new Set(['id', 'type', 'title', 'publisher', 'blurb', 'categories', 'ages', 'language', 'rights', 'delivery', 'editPolicy', 'pageUrl', 'note', 'items', 'checkedAt', 'reviewedAt', 'featured', 'cover', 'coverFrom', 'about', 'single']);
const ITEM_KEYS = new Set(['key', 'title', 'originalTitle', 'category', 'ages', 'published', 'durationSec', 'size', 'pageUrl', 'creators', 'tradition', 'rights', 'files', 'fileName', 'delivery', 'featured', 'sparse', 'cover', 'until', 'about', 'embed']);
const FIXED_HOSTS: Partial<Record<EntryType, string[]>> = {
  'archive-album': ['archive.org'],
  'gitlab-gsb': ['gitlab.com'],
  commons: ['upload.wikimedia.org'],
  link: [],
};

/** Hosts the files of an entry may come from. A link entry's: its provider's, where saving is allowed (providers.ts). */
export function allowedHosts(entry: CatalogEntry): string[] {
  if (entry.type === 'link') return saveWay(entry) === 'app' ? [...(providerOf(entry.rights)?.fileHosts ?? [])] : [];
  return entry.type === 'podcast' ? entry.mediaHosts : (FIXED_HOSTS[entry.type] ?? []);
}

function itemCount(index: SourceIndex): number {
  return index.entries.reduce((n, e) => n + e.items.length, 0);
}

/**
 * The checks a new index must pass before it replaces the published one.
 * Any error: do not publish, keep the last good file, fail the job.
 * `serialized` is exactly what would be uploaded; `parsed` is what the
 * app's own reader (validateIndex) makes of it.
 */
export function publishGates(
  index: SourceIndex,
  opts: { catalog: SourceCatalog; previous?: SourceIndex; serialized: string; parsed: SourceIndex | 'needs-update' | null },
): string[] {
  const errors: string[] = [];
  const { catalog, previous, serialized, parsed } = opts;
  if (parsed === null || parsed === 'needs-update') errors.push('Die App könnte die Liste nicht lesen.');
  else if (parsed.entries.length !== index.entries.length || itemCount(parsed) !== itemCount(index)) errors.push('Die App würde Einträge der Liste verwerfen.');
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes >= MAX_INDEX_BYTES) errors.push(`Liste zu groß (${bytes} Bytes).`);
  if (!index.entries.length) errors.push('Liste ohne Einträge.');
  const count = itemCount(index);
  if (previous && !catalog.allowShrink) {
    const before = itemCount(previous);
    if (before > 0 && count < before * (1 - MAX_SHRINK)) errors.push(`Zu viele Titel verschwunden (${before} → ${count}). Wenn das gewollt ist: "allowShrink": true im Katalog.`);
  }
  const byId = new Map(catalog.entries.map((e) => [e.id, e]));
  for (const e of index.entries) {
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) errors.push(`${e.id}: Feld „${k}“ gehört nicht in die Liste.`);
    if (e.ages.min >= REJECT_MIN_AGE) errors.push(`${e.id}: Altersangabe ab ${e.ages.min}.`);
    const source = byId.get(e.id);
    if (!source) {
      errors.push(`${e.id}: nicht im Katalog.`);
      continue;
    }
    const hosts = allowedHosts(source);
    const linkHosts = linkHostsOf(source);
    const linkOk = (url: string) => {
      const h = hostOf(url);
      return h !== undefined && linkHosts.includes(h);
    };
    if (!linkOk(e.pageUrl)) errors.push(`${e.id}: Seite ${e.pageUrl} passt nicht zum Katalog.`);
    const usedHosts = entryHosts(e);
    for (const c of [e.cover, ...e.items.map((it) => it.cover)]) {
      if (c !== undefined && !coverUrl(c, usedHosts)) errors.push(`${e.id}: Cover ${c} würde die App nicht zeigen.`);
    }
    for (const it of e.items) {
      for (const k of Object.keys(it)) if (!ITEM_KEYS.has(k)) errors.push(`${it.key}: Feld „${k}“ gehört nicht in die Liste.`);
      if (it.pageUrl && !linkOk(it.pageUrl)) errors.push(`${it.key}: Link auf ${hostOf(it.pageUrl) ?? it.pageUrl} ist für diesen Eintrag nicht erlaubt.`);
      if (it.ages && it.ages.min >= REJECT_MIN_AGE) errors.push(`${it.key}: Altersangabe ab ${it.ages.min}.`);
      if (it.until !== undefined && !isDay(it.until)) errors.push(`${it.key}: until ist kein Tag (JJJJ-MM-TT).`);
      if (it.embed !== undefined && !embedAllowed(source.rights, it.embed)) errors.push(`${it.key}: Player ${it.embed} ist für diesen Anbieter nicht erlaubt.`);
      for (const f of it.files) {
        let u: URL;
        try {
          u = new URL(f.url);
        } catch {
          errors.push(`${it.key}: ungültige Adresse ${f.url}`);
          continue;
        }
        if (u.protocol !== 'https:') errors.push(`${it.key}: Datei nicht über HTTPS.`);
        if (isMeasurementHost(u.hostname)) errors.push(`${it.key}: Messdienst ${u.hostname}.`);
        else if (!hosts.includes(u.hostname)) errors.push(`${it.key}: Host ${u.hostname} ist für diesen Eintrag nicht erlaubt.`);
      }
    }
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(serialized)) errors.push('Die Liste enthält eine E-Mail-Adresse.');
  if (/"(internal|openChecks|review|holdNew|feedUrl|mediaHosts|status)"\s*:/.test(serialized)) errors.push('Die Liste enthält Felder aus dem Katalog, die nur für die Redaktion sind.');
  return errors;
}
