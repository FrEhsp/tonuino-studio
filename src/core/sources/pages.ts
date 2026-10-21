/**
 * Readers for the official pages of series that have no feed: the show
 * pages of ARD Sounds (www.ardsounds.de/sendung/…) and the topic pages of
 * OHRKA (www.ohrka.de/hoeren/…). A show page names its episodes, a title
 * page tells what the title is.
 *
 * Only what a page states for machines and people alike is read: the meta
 * tags every page has for link previews (og:title, og:description,
 * og:image, the robots line with unavailable_after), schema.org data when
 * there is some, and short standalone labels ("Ab 7 Jahre", "53 Min.").
 * A label that shows up with two different values says nothing (other
 * episodes on the same page); then the fact stays unknown. Unknown facts
 * never get guessed: rules.ts leaves a new title out that lacks one.
 */
import { decodeEntities } from './rss';
import { parseAges, parseDuration, plainText } from './text';
import type { AgeRange, Person } from './types';

/** The readers the catalogue can name for a link entry (`series.reader`). */
export type SeriesReader = 'ardsounds' | 'ohrka';

export const SERIES_READERS: readonly SeriesReader[] = ['ardsounds', 'ohrka'];

/** The host each reader reads; a series page or title on another host is not read. */
export const READER_HOST: Record<SeriesReader, string> = { ardsounds: 'www.ardsounds.de', ohrka: 'www.ohrka.de' };

/** What a title page says about the title. */
export interface PageFacts {
  /** The page's own address (canonical), normalised. */
  url: string;
  /** 'episode' for a real episode; 'extra' for trailers and announcements ARD files apart (urn:ard:extra). */
  kind: 'episode' | 'extra' | 'title';
  title?: string;
  /** The page's own description (meta description), plain text. */
  description?: string;
  /** The page's picture (og:image), https. */
  image?: string;
  /** Last day the publisher offers it (YYYY-MM-DD), from robots unavailable_after. */
  until?: string;
  ages?: AgeRange;
  /** The page states the age itself ("Ab 7 Jahre"), not only the show. */
  agesStated?: boolean;
  durationSec?: number;
  /** The audio file the page offers for download, when it links one. */
  fileUrl?: string;
  /** The publisher's player for the title (ARD Sounds: twitter:player), https. Whether the app may load it decides providers.ts. */
  embed?: string;
  /** The page's language when it says (html lang, og:locale): "de". */
  language?: string;
  creators?: Person[];
}

/* ------------------------------------------------------------ meta tags */

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  const v = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  return v === undefined ? undefined : decodeEntities(v).trim();
}

/** The page's meta tags by name or property (lower case), first one wins. */
export function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'property') ?? attr(m[0], 'name') ?? attr(m[0], 'itemprop'))?.toLowerCase();
    const content = attr(m[0], 'content');
    if (key && content !== undefined && !out.has(key)) out.set(key, content);
  }
  return out;
}

function linkHref(html: string, rel: string): string | undefined {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) if (attr(m[0], 'rel')?.toLowerCase() === rel) return attr(m[0], 'href');
  return undefined;
}

function https(raw: string | undefined, base?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** "unavailable_after: 2031-04-30", also with a time or as an RFC 850 date, as YYYY-MM-DD. */
export function unavailableAfter(robots: string | undefined): string | undefined {
  const m = robots ? /unavailable_after\s*:\s*(.*)$/i.exec(robots) : null;
  if (!m) return undefined;
  const iso = /^\s*(\d{4}-\d{2}-\d{2})/.exec(m[1]);
  if (iso) return iso[1];
  // "Friday, 25-Jun-10 15:00:00 PST", up to the next directive.
  const raw = m[1].split(/,\s*(?=(?:no|index|follow|max-|all\b|none\b))/i)[0].trim();
  const t = Date.parse(raw.replace(/-/g, ' '));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}

/** The language a page names (html lang, og:locale, content-language), as "de". */
function pageLanguage(html: string, meta: Map<string, string>): string | undefined {
  const lang = /<html\b[^>]*\slang\s*=\s*["']?([a-z]{2})/i.exec(html)?.[1] ?? meta.get('og:locale')?.slice(0, 2) ?? meta.get('content-language')?.slice(0, 2);
  return lang?.toLowerCase();
}

/** schema.org objects of the page (application/ld+json), flattened (@graph, arrays). */
export function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const add = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      out.push(o);
      if (o['@graph']) add(o['@graph']);
    }
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      add(JSON.parse(m[1]));
    } catch {
      // A broken block says nothing.
    }
  }
  return out;
}

function ldString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v)) return ldString(v[0]);
  if (v && typeof v === 'object') return ldString((v as Record<string, unknown>).url ?? (v as Record<string, unknown>).name);
  return undefined;
}

const EPISODE_TYPES = /^(?:PodcastEpisode|RadioEpisode|Episode|AudioObject|Audiobook|Book|CreativeWork)$/;

/** ISO 8601 durations "PT53M", "PT1H2M3S". */
export function isoDuration(v: unknown): number | undefined {
  const m = typeof v === 'string' ? /^P(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)$/i.exec(v.trim()) : null;
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  const s = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return s > 0 ? Math.round(s) : undefined;
}

/**
 * The text of elements that hold nothing but a short label, e.g. ">Ab 7 Jahre<".
 * Returns the distinct values a pattern finds; one value is a fact, more are noise.
 */
function labels(html: string, re: RegExp): string[][] {
  const found = new Map<string, string[]>();
  const body = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  for (const m of body.matchAll(/>([^<>]{1,40})</g)) {
    const text = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
    const hit = re.exec(text);
    if (hit) found.set(hit.slice(1).join('|'), hit.slice(1));
  }
  return [...found.values()];
}

function single<T>(values: T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

/** Facts shared by both readers: meta tags, schema.org, language. */
function baseFacts(html: string, pageUrl: string): Omit<PageFacts, 'kind' | 'url'> & { canonical?: string } {
  const meta = metaTags(html);
  const ld = jsonLd(html).find((o) => EPISODE_TYPES.test(String(o['@type'] ?? '')));
  const canonical = https(linkHref(html, 'canonical') ?? meta.get('og:url'), pageUrl);
  const description = plainText(meta.get('og:description') ?? meta.get('description') ?? ldString(ld?.description)) || undefined;
  return {
    canonical,
    title: plainText(meta.get('og:title') ?? ldString(ld?.name)) || undefined,
    description,
    image: https(meta.get('og:image') ?? ldString(ld?.image), pageUrl),
    until: unavailableAfter(meta.get('robots')) ?? unavailableAfter(meta.get('googlebot')),
    durationSec: isoDuration(ld?.duration) ?? isoDuration(ld?.timeRequired),
    language: pageLanguage(html, meta),
  };
}

/* ------------------------------------------------------------ ARD Sounds */

const ARD_HOST = READER_HOST.ardsounds;
const ARD_EPISODE = /\/episode\/(?:[a-z0-9-]+\/)*urn:ard:(episode|extra):([0-9a-f]{8,32})\/?/gi;

/** The address of an ARD Sounds episode as the catalogue writes it: https://www.ardsounds.de/episode/urn:ard:episode:<id>/ */
export function ardEpisodeUrl(raw: string): string | undefined {
  ARD_EPISODE.lastIndex = 0;
  const m = ARD_EPISODE.exec(raw);
  return m ? `https://${ARD_HOST}/episode/urn:ard:${m[1].toLowerCase()}:${m[2].toLowerCase()}/` : undefined;
}

/** The episodes a show page links, in page order, each once. Extras (trailers, announcements) are left out. */
export function ardShowEpisodes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(ARD_EPISODE)) {
    if (m[1].toLowerCase() !== 'episode') continue;
    const url = `https://${ARD_HOST}/episode/urn:ard:episode:${m[2].toLowerCase()}/`;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** "Die Schatzinsel (1/3) | ARD Sounds" → "Die Schatzinsel (1/3)". */
function withoutSiteName(title: string | undefined): string | undefined {
  return title?.replace(/\s*[|·–-]\s*ARD\s*(?:Sounds|Audiothek)\s*$/i, '').trim() || undefined;
}

/** What an ARD Sounds episode page says about the episode. */
export function ardEpisodePage(html: string, pageUrl: string): PageFacts {
  const base = baseFacts(html, pageUrl);
  const url = ardEpisodeUrl(base.canonical ?? '') ?? ardEpisodeUrl(pageUrl) ?? pageUrl;
  const kind = /urn:ard:extra:/i.test(url) ? 'extra' : 'episode';
  // "Ab 7 Jahre" as a label of its own; the description may say it too ("Für Kinder ab 8 Jahren").
  const ageLabel = single(labels(html, /^ab\s+(\d{1,2})\s+jahren?\.?$/i));
  const labelAges = ageLabel ? parseAges(`ab ${ageLabel[0]} Jahren`) : undefined;
  const textAges = parseAges([base.title, base.description].filter(Boolean).join(' \n '));
  const ages = labelAges && textAges ? (textAges.min > labelAges.min ? textAges : labelAges) : (labelAges ?? textAges);
  const minutes = single(labels(html, /^(?:(\d{1,2})\s*Std\.?\s*)?(\d{1,3})\s*Min\.?$/i));
  const fromLabel = minutes ? (Number(minutes[0] ?? 0) * 60 + Number(minutes[1])) * 60 : undefined;
  const mp3 = /href\s*=\s*["'](https:\/\/[^"']+\.mp3)(?:\?[^"']*)?["']/i.exec(html)?.[1];
  // ARD Sounds names its own player for the episode the way social sites look for it.
  const player = https(metaTags(html).get('twitter:player'), pageUrl);
  return {
    ...strip(base),
    url,
    kind,
    ...(player ? { embed: player } : {}),
    title: withoutSiteName(base.title),
    ages,
    agesStated: !!ages,
    durationSec: base.durationSec ?? (fromLabel && fromLabel > 0 ? fromLabel : undefined),
    fileUrl: mp3,
  };
}

/* ------------------------------------------------------------ OHRKA */

const OHRKA_HOST = READER_HOST.ohrka;

/** A title page of OHRKA: /hoeren/<topic>/<title>, normalised without a trailing slash. */
export function ohrkaTitleUrl(raw: string, base = `https://${OHRKA_HOST}/`): string | undefined {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (u.hostname !== OHRKA_HOST) return undefined;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'hoeren' || !parts.every((p) => /^[a-z0-9-]+$/i.test(p))) return undefined;
  return `https://${OHRKA_HOST}/${parts.join('/')}`;
}

/** The titles a topic page of OHRKA links (only titles of this topic), in page order, each once. */
export function ohrkaTopicTitles(html: string, topicUrl: string): string[] {
  const topic = new URL(topicUrl).pathname.split('/').filter(Boolean)[1];
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], 'href');
    const url = href ? ohrkaTitleUrl(href, topicUrl) : undefined;
    if (!url || url.split('/')[4] !== topic || out.includes(url)) continue;
    out.push(url);
  }
  return out;
}

/** "Katharina Thalbach liest Alice im Wunderland …", "gelesen von Anke Engelke": the reader, by name. */
export function readerOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const name = /^\s*((?:[A-ZÄÖÜ][\p{L}.'-]+\s+){1,3}[A-ZÄÖÜ][\p{L}'-]+)\s+(?:liest|lesen|erzählt)\b/u.exec(text)?.[1] ?? /gelesen\s+von\s+((?:[A-ZÄÖÜ][\p{L}.'-]+\s+){1,3}?[A-ZÄÖÜ][\p{L}'-]+)/u.exec(text)?.[1];
  return name?.trim();
}

/** What an OHRKA title page says: title, its description, the reader, the length, the file and the picture. */
export function ohrkaTitlePage(html: string, pageUrl: string): PageFacts {
  const base = baseFacts(html, pageUrl);
  const url = ohrkaTitleUrl(base.canonical ?? '') ?? ohrkaTitleUrl(pageUrl) ?? pageUrl;
  const docTitle = plainText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
  const title = (base.title ?? docTitle).replace(/^OHRKA(?:\s+e\.\s?V\.)?\s*[:|–-]\s*/i, '').trim() || undefined;
  const clock = single(labels(html, /^(\d{1,2}:\d{2}:\d{2})$/));
  const file = /href\s*=\s*["']((?:https:\/\/www\.ohrka\.de)?\/?fileadmin\/[^"']+\.mp3)["']/i.exec(html)?.[1];
  const picture = /(?:src|href)\s*=\s*["']((?:https:\/\/www\.ohrka\.de)?\/?fileadmin\/bilder\/[^"']+\.(?:png|jpe?g))["']/i.exec(html)?.[1];
  const reader = readerOf(base.description) ?? readerOf(title);
  return {
    ...strip(base),
    url,
    kind: 'title',
    title,
    image: base.image && !/logo/i.test(base.image) ? base.image : https(picture, pageUrl),
    durationSec: base.durationSec ?? parseDuration(clock?.[0]),
    fileUrl: https(file, pageUrl),
    ages: parseAges(base.description),
    agesStated: !!parseAges(base.description),
    ...(reader ? { creators: [{ name: reader, role: 'reader' as const }] } : {}),
  };
}

function strip<T extends { canonical?: string }>(o: T): Omit<T, 'canonical'> {
  const { canonical: _c, ...rest } = o;
  return rest;
}

/* ------------------------------------------------------------ both */

/** The title pages a series page links, by reader. */
export function seriesLinks(reader: SeriesReader, html: string, pageUrl: string): string[] {
  return reader === 'ardsounds' ? ardShowEpisodes(html) : ohrkaTopicTitles(html, pageUrl);
}

/** What a title page says, by reader. */
export function titleFacts(reader: SeriesReader, html: string, pageUrl: string): PageFacts {
  return reader === 'ardsounds' ? ardEpisodePage(html, pageUrl) : ohrkaTitlePage(html, pageUrl);
}

/** The address of a title as the reader writes it, to compare catalogue titles and links. */
export function titleUrl(reader: SeriesReader, raw: string): string | undefined {
  return reader === 'ardsounds' ? ardEpisodeUrl(raw) : ohrkaTitleUrl(raw);
}
