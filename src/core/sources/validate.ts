/**
 * Shape checks for the three data files of "Entdecken":
 * - validateCatalog: the curated catalogue (sources/catalog.json). CI fails on any error.
 * - validateReleased: the list of items a person released (sources/released.json).
 * - validateIndex / parseIndex: the published index as the app reads it. Malformed
 *   entries and items are dropped; a newer format asks for an app update.
 */
import { isMeasurementHost } from './cors';
import { COVER_HOSTS, coverUrl, entryHosts } from './cover';
import { ccFromUrl } from './licence';
import { READER_HOST, SERIES_READERS } from './pages';
import { embedAllowed, providerProblems } from './providers';
import {
  ENTRY_STATUSES,
  type AgeInfo,
  type AgeRange,
  type CatalogEntry,
  type Category,
  type CcId,
  type EditorPick,
  type EntryType,
  type IndexEntry,
  type IndexItem,
  type MediaFile,
  type Person,
  type PersonRole,
  type ReleasedItem,
  type Rights,
  type SourceCatalog,
  type SourceIndex,
} from './types';

type Obj = Record<string, unknown>;

const CATEGORIES: readonly Category[] = ['hoerspiel', 'hoerbuch', 'lied', 'wissen'];
const ENTRY_TYPES: readonly EntryType[] = ['podcast', 'archive-album', 'gitlab-gsb', 'commons', 'link'];
const ROLES: readonly PersonRole[] = ['author', 'translator', 'reader', 'performer', 'composer'];
const CC_IDS: readonly CcId[] = ['by', 'by-sa', 'by-nc', 'by-nc-sa', 'by-nd', 'by-nc-nd', 'cc0', 'pdm'];
const MAX_AGE = 18;

/** At most this many editors' picks at a time (entries and single titles together). */
export const MAX_PICKS = 12;
/** The longest "why" sentence of a pick, in characters. */
export const MAX_WHY_CHARS = 140;
/** Longest "why" the app accepts from a list: a little room for lists written by newer tools. */
const MAX_WHY_READ = 300;
/** Lowest minSeconds a source may set, and the highest. */
export const MIN_SECONDS_RANGE = { min: 0, max: 600 } as const;
/** Longest description of a title or source (about.ts writes at most 240). */
const ABOUT_LIMIT = 300;
/** Longest "where the cover comes from" line. */
export const COVER_FROM_MAX = 120;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function int(v: unknown, min = 0): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : undefined;
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** An https URL that parses, returned exactly as written. */
export function httpsUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    return new URL(v).protocol === 'https:' ? v : undefined;
  } catch {
    return undefined;
  }
}

function isDate(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

/** A calendar day as YYYY-MM-DD, the form of `until`. */
export function isDay(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
}

export function parseAgeRange(v: unknown): AgeRange | undefined {
  if (!isObj(v)) return undefined;
  const min = int(v.min);
  if (min === undefined || min > MAX_AGE) return undefined;
  if (v.max === undefined) return { min };
  const max = int(v.max);
  if (max === undefined || max < min || max > MAX_AGE) return undefined;
  return { min, max };
}

function parseAgeInfo(v: unknown): AgeInfo | undefined {
  const range = parseAgeRange(v);
  if (!range || !isObj(v)) return undefined;
  const source = oneOf(v.source, ['publisher', 'editor'] as const);
  if (!source) return undefined;
  const text = str(v.text);
  return { ...range, source, ...(text ? { text } : {}) };
}

export function parseRights(v: unknown): Rights | undefined {
  if (!isObj(v)) return undefined;
  switch (v.kind) {
    case 'podcast': {
      const holder = str(v.holder);
      if (!holder) return undefined;
      if (v.termsUrl !== undefined && !httpsUrl(v.termsUrl)) return undefined;
      const termsUrl = httpsUrl(v.termsUrl);
      return termsUrl ? { kind: 'podcast', holder, termsUrl } : { kind: 'podcast', holder };
    }
    case 'private-use': {
      const holder = str(v.holder);
      const termsUrl = httpsUrl(v.termsUrl);
      return holder && termsUrl ? { kind: 'private-use', holder, termsUrl } : undefined;
    }
    case 'public-domain': {
      const basis = oneOf(v.basis, ['commons'] as const);
      if (!basis) return undefined;
      const latestDeath = int(v.latestDeath);
      return latestDeath !== undefined ? { kind: 'public-domain', basis, latestDeath } : { kind: 'public-domain', basis };
    }
    case 'cc': {
      const id = oneOf(v.id, CC_IDS);
      const version = typeof v.version === 'string' && /^\d\.\d$/.test(v.version) ? v.version : undefined;
      const url = typeof v.url === 'string' ? v.url : undefined;
      const parsed = ccFromUrl(url);
      if (!id || !version || !url || !parsed || parsed.id !== id || parsed.version !== version) return undefined;
      const port = v.port === undefined ? undefined : typeof v.port === 'string' && /^[a-z]{2}$/i.test(v.port) ? v.port : null;
      if (port === null || (port ?? '') !== (parsed.port ?? '')) return undefined;
      return port ? { kind: 'cc', id, version, port, url } : { kind: 'cc', id, version, url };
    }
    default:
      return undefined;
  }
}

function parsePerson(v: unknown): Person | undefined {
  if (!isObj(v)) return undefined;
  const name = str(v.name);
  const role = oneOf(v.role, ROLES);
  if (!name || !role) return undefined;
  const p: Person = { name, role };
  const born = int(v.born);
  const died = int(v.died);
  if (born !== undefined) p.born = born;
  if (died !== undefined) p.died = died;
  return p;
}

/** A pick as the app reads it from a list: anything unusable is left out, never the title or source. */
function parsePick(v: unknown): EditorPick | undefined {
  if (!isObj(v)) return undefined;
  const rank = int(v.rank, 1);
  const why = str(v.why)?.trim();
  return rank !== undefined && why && why.length <= MAX_WHY_READ ? { rank, why } : undefined;
}

/** Words that end with a period inside a sentence: "3 Std. Abenteuer", "z. B. Rotkäppchen". */
export const ABBREVIATIONS: readonly string[] = ['std', 'min', 'sek', 'ca', 'bzw', 'nr', 'usw', 'bspw', 'evtl', 'inkl', 'vgl', 'dr', 'st', 'jh', 'mio', 'zb', 'ua', 'dh'];

/**
 * Whether a text has more than one sentence. A sentence ends with ".", "!"
 * or "?" followed by a capital letter; "Std." and other abbreviations, a
 * single letter ("z. B.") and the "???" or "!!!" of a series name do not end one.
 */
export function moreThanOneSentence(text: string): boolean {
  if (/[\r\n]/.test(text)) return true;
  const ends = /(\S*?)([.!?]+)\s+(?=\p{Lu})/gu;
  for (const m of text.matchAll(ends)) {
    const [, word, marks] = m;
    if (marks.length >= 3 && /^[!?]+$/.test(marks)) continue;
    if (marks === '.') {
      const w = word.toLowerCase().replace(/[^\p{L}]/gu, '');
      if (w.length <= 1 || ABBREVIATIONS.includes(w)) continue;
    }
    return true;
  }
  return false;
}

/** What is wrong with a pick as the editors wrote it; empty when nothing. */
export function pickProblems(v: unknown): string[] {
  if (!isObj(v)) return ['featured braucht rank und why'];
  const out: string[] = [];
  if (int(v.rank, 1) === undefined) out.push('featured.rank ist keine Zahl ab 1');
  const why = typeof v.why === 'string' ? v.why.trim() : '';
  if (!why) out.push('featured.why fehlt (ein kurzer Satz, warum es sich lohnt)');
  else {
    if (why.length > MAX_WHY_CHARS) out.push(`featured.why ist zu lang (${why.length} Zeichen, höchstens ${MAX_WHY_CHARS})`);
    if (moreThanOneSentence(why)) out.push('featured.why ist mehr als ein Satz');
  }
  return out;
}

function parseFile(v: unknown): MediaFile | undefined {
  if (!isObj(v)) return undefined;
  const url = httpsUrl(v.url);
  const name = str(v.name);
  if (!url || !name || /[\\/]/.test(name)) return undefined;
  const f: MediaFile = { url, name };
  const size = int(v.size);
  const durationSec = num(v.durationSec);
  const title = str(v.title);
  const track = int(v.track);
  if (size !== undefined) f.size = size;
  if (durationSec !== undefined && durationSec > 0) f.durationSec = durationSec;
  if (title) f.title = title;
  if (track !== undefined) f.track = track;
  return f;
}

function parseItem(v: unknown): IndexItem | undefined {
  if (!isObj(v)) return undefined;
  const key = str(v.key);
  const title = str(v.title);
  const category = oneOf(v.category, CATEGORIES);
  if (!key || !title || !category || !Array.isArray(v.files)) return undefined;
  const files: MediaFile[] = [];
  for (const f of v.files) {
    const file = parseFile(f);
    if (!file) return undefined; // a book with a missing chapter is not a book
    files.push(file);
  }
  const item: IndexItem = { key, title, category, files };
  const originalTitle = str(v.originalTitle);
  if (originalTitle) item.originalTitle = originalTitle;
  if (v.ages !== undefined) {
    const ages = parseAgeRange(v.ages);
    if (!ages) return undefined;
    item.ages = ages;
  }
  const published = str(v.published);
  if (published && (isDate(published) || /^\d{4}$/.test(published))) item.published = published;
  const durationSec = num(v.durationSec);
  if (durationSec !== undefined && durationSec > 0) item.durationSec = durationSec;
  const size = int(v.size);
  if (size !== undefined) item.size = size;
  const pageUrl = httpsUrl(v.pageUrl);
  if (pageUrl) item.pageUrl = pageUrl;
  if (Array.isArray(v.creators)) {
    const creators = v.creators.map(parsePerson).filter((p): p is Person => !!p);
    if (creators.length) item.creators = creators;
  }
  const tradition = str(v.tradition);
  if (tradition) item.tradition = tradition;
  if (v.rights !== undefined) {
    const rights = parseRights(v.rights);
    if (!rights) return undefined;
    item.rights = rights;
  }
  const fileName = str(v.fileName);
  if (fileName) item.fileName = fileName;
  const delivery = oneOf(v.delivery, ['direct', 'browser'] as const);
  if (delivery) item.delivery = delivery;
  const featured = parsePick(v.featured);
  if (featured) item.featured = featured;
  if (v.sparse === true) item.sparse = true;
  if (isDay(v.until)) item.until = v.until;
  const about = str(v.about);
  if (about && about.length <= ABOUT_LIMIT) item.about = about;
  return item;
}

function parseEntry(v: unknown, dropped: string[]): IndexEntry | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v.id);
  const type = oneOf(v.type, ENTRY_TYPES);
  const title = str(v.title);
  const publisher = str(v.publisher);
  const ages = parseAgeInfo(v.ages);
  const language = oneOf(v.language, ['de', 'gsw'] as const);
  const rights = parseRights(v.rights);
  const delivery = oneOf(v.delivery, ['direct', 'browser'] as const);
  const editPolicy = oneOf(v.editPolicy, ['normal', 'unchanged'] as const);
  const pageUrl = httpsUrl(v.pageUrl);
  const checkedAt = isDate(v.checkedAt) ? v.checkedAt : undefined;
  if (!id || !type || !title || !publisher || !ages || !language || !rights || !delivery || !editPolicy || !pageUrl || !checkedAt || !Array.isArray(v.items)) return undefined;
  const items: IndexItem[] = [];
  const itemCovers = new Map<IndexItem, unknown>();
  for (const raw of v.items) {
    const item = parseItem(raw);
    if (item) {
      items.push(item);
      if (isObj(raw) && raw.cover !== undefined) itemCovers.set(item, raw.cover);
      // A player only where the provider's row allows it (providers.ts); anything else is left out, never the title.
      if (isObj(raw) && typeof raw.embed === 'string' && embedAllowed(rights, raw.embed)) item.embed = raw.embed;
    } else dropped.push(isObj(raw) && typeof raw.key === 'string' ? raw.key : `${id}/?`);
  }
  if (!items.length) return undefined;
  const categories = CATEGORIES.filter((c) => items.some((i) => i.category === c));
  // Covers: https on a host the entry uses anyway or a known cover host (cover.ts). Anything else is left out, never the entry or title.
  const hosts = entryHosts({ pageUrl, items });
  for (const [item, raw] of itemCovers) {
    const cover = coverUrl(raw, hosts);
    if (cover) item.cover = cover;
  }
  const entry: IndexEntry = { id, type, title, publisher, categories, ages, language, rights, delivery, editPolicy, pageUrl, items, checkedAt };
  const blurb = str(v.blurb);
  const note = str(v.note);
  if (blurb) entry.blurb = blurb;
  if (note) entry.note = note;
  if (isDate(v.reviewedAt)) entry.reviewedAt = v.reviewedAt;
  const featured = parsePick(v.featured);
  if (featured) entry.featured = featured;
  const about = str(v.about);
  if (about && about.length <= ABOUT_LIMIT) entry.about = about;
  if (v.single === true) entry.single = true;
  const cover = coverUrl(v.cover, hosts);
  if (cover) {
    entry.cover = cover;
    const from = str(v.coverFrom);
    if (from && from.length <= COVER_FROM_MAX) entry.coverFrom = from;
  }
  return entry;
}

/** Reads a published index. Null: unusable. 'needs-update': written for a newer app. */
export function parseIndex(raw: unknown): { index: SourceIndex; dropped: string[] } | 'needs-update' | null {
  if (!isObj(raw)) return null;
  if (typeof raw.format === 'number' && raw.format > 1) return 'needs-update';
  if (raw.format !== 1) return null;
  if (!isDate(raw.generatedAt) || !isDate(raw.staleAfter) || !Array.isArray(raw.entries)) return null;
  const dropped: string[] = [];
  const entries: IndexEntry[] = [];
  const seen = new Set<string>();
  for (const e of raw.entries) {
    const entry = parseEntry(e, dropped);
    if (!entry || seen.has(entry.id)) {
      dropped.push(isObj(e) && typeof e.id === 'string' ? e.id : '?');
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  const blocked = Array.isArray(raw.blocked) ? raw.blocked.filter((b): b is string => typeof b === 'string' && b !== '') : [];
  return { index: { format: 1, generatedAt: raw.generatedAt, staleAfter: raw.staleAfter, entries, blocked }, dropped };
}

export function validateIndex(raw: unknown): SourceIndex | 'needs-update' | null {
  const r = parseIndex(raw);
  return r === null || r === 'needs-update' ? r : r.index;
}

/* ------------------------------------------------------------ catalogue */

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export interface CatalogCheck {
  /** Set when there are no errors. */
  catalog?: SourceCatalog;
  errors: string[];
  warnings: string[];
}

const SHA1 = /^[0-9a-f]{40}$/;

/** Terms URLs a person has read: the keys of sources/terms-hashes.json ("hashes"). */
function readTerms(raw: unknown): Set<string> {
  const hashes = isObj(raw) && isObj(raw.hashes) ? raw.hashes : {};
  return new Set(Object.entries(hashes).filter(([, v]) => isObj(v) && str(v.sha256)).map(([k]) => k));
}

function checkEntry(e: Obj, now: Date, terms: Set<string> | undefined, errors: string[], warnings: string[]): void {
  const id = String(e.id);
  const err = (m: string) => errors.push(`${id}: ${m}`);
  const type = oneOf(e.type, ENTRY_TYPES);
  if (!type) err(`unbekannter Typ „${String(e.type)}“`);
  const status = oneOf(e.status, ENTRY_STATUSES);
  if (!status) err(`unbekannter Status „${String(e.status)}“`);
  if (!str(e.title)) err('Titel fehlt');
  if (!str(e.publisher)) err('Anbieter fehlt');
  if (!httpsUrl(e.pageUrl)) err('pageUrl ist keine https-Adresse');
  if (!oneOf(e.category, CATEGORIES)) err(`unbekannte Kategorie „${String(e.category)}“`);
  if (e.categoryRules !== undefined) {
    if (!Array.isArray(e.categoryRules)) err('categoryRules ist keine Liste');
    else
      for (const r of e.categoryRules) {
        if (!isObj(r) || typeof r.pattern !== 'string' || !(r.category === 'skip' || oneOf(r.category, CATEGORIES))) {
          err('categoryRules: Regel unvollständig');
          continue;
        }
        try {
          new RegExp(r.pattern, 'i');
        } catch {
          err(`categoryRules: Muster „${r.pattern}“ ist ungültig`);
        }
      }
  }
  if (e.titlePrefixes !== undefined && !(Array.isArray(e.titlePrefixes) && e.titlePrefixes.every((p) => typeof p === 'string' && p !== ''))) err('titlePrefixes ist keine Liste von Texten');
  if (e.titlePattern !== undefined) {
    if (typeof e.titlePattern !== 'string' || !e.titlePattern.startsWith('^')) err('titlePattern ist kein Muster, das mit ^ beginnt');
    else
      try {
        new RegExp(e.titlePattern, 'i');
      } catch {
        err(`titlePattern „${e.titlePattern}“ ist ungültig`);
      }
  }
  if (e.dropCounter !== undefined && e.dropCounter !== true) err('dropCounter ist nicht true');
  if (e.titleOverrides !== undefined && !(isObj(e.titleOverrides) && Object.entries(e.titleOverrides).every(([k, v]) => k.startsWith(`${id}/`) && !!str(v)))) {
    err('titleOverrides braucht je Schlüssel dieses Eintrags einen Titel');
  }
  // Whole sentences only: a single word ("Mord") must not switch off the warning scan.
  if (e.ignorePhrases !== undefined && !(Array.isArray(e.ignorePhrases) && e.ignorePhrases.every((p) => typeof p === 'string' && p.trim().split(/\s+/).length >= 3))) {
    err('ignorePhrases ist keine Liste von Sätzen (mindestens drei Wörter)');
  }
  if (e.linkHosts !== undefined) {
    if (!Array.isArray(e.linkHosts)) err('linkHosts ist keine Liste');
    else
      for (const h of e.linkHosts) {
        if (typeof h !== 'string' || !HOSTNAME.test(h)) err(`linkHost „${String(h)}“ ist kein Hostname`);
        else if (isMeasurementHost(h)) err(`linkHost ${h} ist ein Messdienst`);
      }
  }
  if (e.permission !== undefined) {
    const p = e.permission;
    if (!isObj(p) || !str(p.needed)) err('permission braucht needed (was der Anbieter erlauben muss)');
    else if (p.granted !== undefined && !(isObj(p.granted) && str(p.granted.by) && isDate(p.granted.at) && str(p.granted.filed))) {
      err('permission.granted braucht by, at (Datum) und filed (wo die schriftliche Antwort liegt)');
    }
  }
  if (!parseAgeInfo(e.ages)) err('Altersangabe ungültig (0 ≤ min ≤ max ≤ 18, source publisher oder editor)');
  if (!oneOf(e.language, ['de', 'gsw'] as const)) err(`unbekannte Sprache „${String(e.language)}“`);
  const rights = parseRights(e.rights);
  if (!rights) {
    const cc = isObj(e.rights) && e.rights.kind === 'cc' ? ccFromUrl(typeof e.rights.url === 'string' ? e.rights.url : undefined) : undefined;
    err(isObj(e.rights) && e.rights.kind === 'cc' && !cc ? 'Lizenz-URL wird nicht verstanden' : 'Rechteangabe ungültig');
  }
  const delivery = oneOf(e.delivery, ['direct', 'browser'] as const);
  if (!delivery) err('delivery ist weder direct noch browser');
  const editPolicy = oneOf(e.editPolicy, ['normal', 'unchanged'] as const);
  if (!editPolicy) err('editPolicy ist weder normal noch unchanged');
  if (rights?.kind === 'cc' && rights.id.includes('nd') && editPolicy !== 'unchanged') err('Lizenz ohne Bearbeitungen (ND) verlangt editPolicy "unchanged"');
  if (e.holdNew !== undefined && typeof e.holdNew !== 'boolean') err('holdNew ist kein Wahrheitswert');
  if (e.minSeconds !== undefined && (int(e.minSeconds) === undefined || (e.minSeconds as number) > MIN_SECONDS_RANGE.max)) {
    err(`minSeconds ist keine ganze Zahl von ${MIN_SECONDS_RANGE.min} bis ${MIN_SECONDS_RANGE.max}`);
  }
  if (e.cover !== undefined) {
    // A cover set by hand: https on the entry's own page host, a link or media host, or a known cover host (cover.ts).
    const own = [httpsUrl(e.pageUrl) ? new URL(e.pageUrl as string).hostname : '', ...(Array.isArray(e.linkHosts) ? e.linkHosts : []), ...(Array.isArray(e.mediaHosts) ? e.mediaHosts : [])].filter(
      (h): h is string => typeof h === 'string' && h !== '',
    );
    if (!coverUrl(e.cover, own)) err(`cover ist keine https-Adresse auf dem Host der Quelle oder einem bekannten Bilder-Host (${COVER_HOSTS.join(', ')})`);
    const from = str(e.coverFrom);
    if (!from || from.length > COVER_FROM_MAX) err(`cover braucht coverFrom: woher das Bild kommt (höchstens ${COVER_FROM_MAX} Zeichen)`);
  } else if (e.coverFrom !== undefined) err('coverFrom nur zusammen mit cover');
  if (e.featured !== undefined) {
    for (const p of pickProblems(e.featured)) err(p);
    if (status !== 'active') err('Empfehlungen (featured) nur für aktive Einträge');
  }
  if (e.review !== undefined) {
    // `by` lives in the editors' notes (editorial.ts) and is missing in the published catalogue.
    if (!isObj(e.review) || (e.review.by !== undefined && !str(e.review.by)) || !isDate(e.review.at) || !isDate(e.review.next)) err('review braucht at und next (Datum)');
  }
  if (status === 'waiting-permission' && !isObj(e.permission)) err('waiting-permission braucht permission mit needed');
  if (status === 'active') {
    if (!isObj(e.review) || !isDate(e.review.next)) err('aktive Einträge brauchen review mit at und next');
    else if (Date.parse(e.review.next) <= now.getTime()) warnings.push(`${id}: Prüfung überfällig seit ${e.review.next}`);
    if (Array.isArray(e.openChecks) && e.openChecks.length) err(`aktiv, aber noch ${e.openChecks.length} offene Punkte (openChecks)`);
    if (rights?.kind === 'podcast' || rights?.kind === 'private-use') {
      if (!rights.termsUrl) err('aktive Einträge ohne freie Lizenz brauchen rights.termsUrl (die Nutzungsbedingungen)');
      else if (terms && !terms.has(rights.termsUrl)) err(`Nutzungsbedingungen nicht gelesen: kein Stand für ${rights.termsUrl} in sources/terms-hashes.json`);
    }
    // A podcast offered only as a link (delivery browser) is used like any podcast app uses an official feed:
    // the family saves the files on the publisher's page. The permission is needed for saving through the app.
    // Link entries are links to the publisher's own pages and nothing else, the same way.
    const linkOnly = (type === 'podcast' && delivery === 'browser') || type === 'link';
    if (isObj(e.permission) && !isObj(e.permission.granted) && !linkOnly) err(`Zustimmung fehlt (permission.granted): ${String(e.permission.needed)}`);
    // What the provider's terms allow for playing and saving (providers.ts).
    // A missing termsUrl is reported above already.
    const termsMissing = (rights?.kind === 'podcast' || rights?.kind === 'private-use') && !rights.termsUrl;
    if (rights && type && !termsMissing) {
      for (const p of providerProblems({ ...e, rights, type, delivery: delivery ?? 'browser', items: Array.isArray(e.items) ? e.items : [] } as unknown as CatalogEntry)) err(p);
    }
  }
  if (e.single !== undefined && typeof e.single !== 'boolean') err('single ist true oder false');
  switch (type) {
    case 'podcast': {
      if (!httpsUrl(e.feedUrl)) err('feedUrl ist keine https-Adresse');
      if (!Array.isArray(e.mediaHosts) || !e.mediaHosts.length) err('Podcasts brauchen mindestens einen mediaHost');
      else
        for (const h of e.mediaHosts) {
          if (typeof h !== 'string' || !HOSTNAME.test(h)) err(`mediaHost „${String(h)}“ ist kein Hostname`);
          else if (isMeasurementHost(h)) err(`mediaHost ${h} ist ein Messdienst`);
        }
      if (e.maxItems !== undefined && int(e.maxItems, 1) === undefined) err('maxItems ist keine positive Zahl');
      break;
    }
    case 'archive-album':
      if (typeof e.archiveId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(e.archiveId)) err('archiveId fehlt');
      if (rights && rights.kind !== 'cc') err('Alben von archive.org brauchen eine CC-Lizenz');
      if (e.files !== undefined && !(Array.isArray(e.files) && e.files.length && e.files.every((f) => isObj(f) && str(f.name) && typeof f.sha1 === 'string' && SHA1.test(f.sha1)))) {
        err('files braucht je Datei name und sha1 (40 Hex-Zeichen)');
      }
      if (status === 'active' && e.files === undefined) err('aktive Alben brauchen files: die angehörten Dateien mit sha1');
      break;
    case 'gitlab-gsb': {
      if (int(e.project, 1) === undefined) err('project fehlt');
      if (!str(e.ref)) err('ref fehlt');
      else if (status === 'active' && !SHA1.test(String(e.ref))) err('aktive Einträge brauchen als ref einen Commit (40 Hex-Zeichen), keinen Branch');
      if (!str(e.path)) err('path fehlt');
      if (!Array.isArray(e.stories) || !e.stories.length) err('stories fehlt');
      else {
        const ids = new Set<string>();
        for (const s of e.stories) {
          if (!isObj(s) || typeof s.id !== 'string' || !/^\d{4}$/.test(s.id)) {
            err('Geschichte ohne vierstellige id');
            continue;
          }
          if (ids.has(s.id)) err(`Geschichte ${s.id} doppelt`);
          ids.add(s.id);
          if (!ccFromUrl(typeof s.licence === 'string' ? s.licence : undefined)) err(`Geschichte ${s.id}: Lizenz-URL wird nicht verstanden`);
          if (s.review !== undefined && !str(s.review)) err(`Geschichte ${s.id}: review ist leer`);
        }
      }
      break;
    }
    case 'commons':
      if (!Array.isArray(e.files) || !e.files.every((f) => typeof f === 'string')) err('files ist keine Liste von Dateinamen');
      break;
    case 'link': {
      if (delivery && delivery !== 'browser') err('Link-Einträge haben delivery "browser"');
      const series = e.series;
      if (series !== undefined) {
        const reader = isObj(series) ? oneOf(series.reader, SERIES_READERS) : undefined;
        if (!isObj(series) || !reader) err(`series.reader ist einer von ${SERIES_READERS.join(', ')}`);
        else if (!Array.isArray(series.urls) || !series.urls.length) err('series.urls fehlt');
        else
          for (const u of series.urls) {
            const url = httpsUrl(u);
            if (!url || new URL(url).hostname !== READER_HOST[reader]) err(`series.urls: ${String(u)} ist keine https-Seite auf ${READER_HOST[reader]}`);
          }
      }
      if (isObj(series) && series.pageAges !== undefined) {
        if (!isObj(series.pageAges)) err('series.pageAges ist kein Objekt');
        else
          for (const [u, a] of Object.entries(series.pageAges)) {
            if (!Array.isArray(series.urls) || !series.urls.includes(u)) err(`series.pageAges: ${u} steht nicht in series.urls`);
            if (!isObj(a) || !parseAgeRange(a) || !str(a.text)) err(`series.pageAges: ${u} braucht min (und max) und den Wortlaut in text`);
          }
      }
      // A series that brings its titles itself may start without any.
      const fromSeries = isObj(series) && series.noNew !== true;
      if (!Array.isArray(e.items) || (!e.items.length && !fromSeries)) err('items fehlt');
      else
        for (const it of e.items) {
          if (!isObj(it) || !str(it.title) || !httpsUrl(it.pageUrl)) {
            err('Titel ohne title oder https-pageUrl');
            continue;
          }
          if (it.category !== undefined && !oneOf(it.category, CATEGORIES)) err(`${String(it.title)}: unbekannte Kategorie`);
          if (it.ages !== undefined && !parseAgeRange(it.ages)) err(`${String(it.title)}: Altersangabe ungültig`);
          if (status === 'active' && it.ages === undefined) err(`${String(it.title)}: aktive Link-Einträge brauchen eine Altersangabe je Titel`);
          if (it.until !== undefined && !isDay(it.until)) err(`${String(it.title)}: until ist kein Tag (JJJJ-MM-TT)`);
          if (it.embed !== undefined && !httpsUrl(it.embed)) err(`${String(it.title)}: embed ist keine https-Adresse`);
          if (it.fileUrl !== undefined && !httpsUrl(it.fileUrl)) err(`${String(it.title)}: fileUrl ist keine https-Adresse`);
          if (it.about !== undefined && (!str(it.about) || String(it.about).length > ABOUT_LIMIT)) err(`${String(it.title)}: about ist leer oder länger als ${ABOUT_LIMIT} Zeichen`);
          if (it.creators !== undefined && (!Array.isArray(it.creators) || !it.creators.every((c) => parsePerson(c)))) err(`${String(it.title)}: creators ungültig`);
          // The title's own picture: https on the host of the entry, of the title's page or a known cover host (cover.ts).
          if (it.cover !== undefined) {
            const own = [e.pageUrl, it.pageUrl].map((u) => (httpsUrl(u) ? new URL(u as string).hostname : '')).filter(Boolean);
            if (!coverUrl(it.cover, own)) err(`${String(it.title)}: cover ist keine https-Adresse auf dem Host der Quelle oder einem bekannten Bilder-Host`);
          }
        }
      break;
    }
    default:
      break;
  }
}

/**
 * Checks the curated catalogue. `now` decides which reviews are overdue (warnings).
 * `termsHashes` is sources/terms-hashes.json: an active entry's terms must have been read
 * (the build passes it; only "sources:check --update-hashes", which stores them, leaves it out).
 */
export function validateCatalog(raw: unknown, now: Date = new Date(), opts: { termsHashes?: unknown } = {}): CatalogCheck {
  const terms = opts.termsHashes === undefined ? undefined : readTerms(opts.termsHashes);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { errors: ['Katalog ist kein Objekt'], warnings };
  if (raw.format !== 1) errors.push(`unbekanntes Format ${String(raw.format)}`);
  if (!str(raw.updatedAt)) errors.push('updatedAt fehlt');
  if (!Array.isArray(raw.blocked) || !raw.blocked.every((b) => typeof b === 'string')) errors.push('blocked ist keine Liste von Texten');
  // notUsed comes from the editors' notes (editorial.ts) and may be missing.
  if (raw.notUsed !== undefined && (!Array.isArray(raw.notUsed) || !raw.notUsed.every((n) => isObj(n) && str(n.name) && str(n.reason)))) errors.push('notUsed braucht name und reason');
  if (raw.allowShrink !== undefined && typeof raw.allowShrink !== 'boolean') errors.push('allowShrink ist kein Wahrheitswert');
  if (!Array.isArray(raw.entries)) {
    errors.push('entries fehlt');
    return { errors, warnings };
  }
  const ids = new Set<string>();
  for (const e of raw.entries) {
    if (!isObj(e) || typeof e.id !== 'string' || !KEBAB.test(e.id)) {
      errors.push(`Eintrag ohne gültige id (Kleinbuchstaben, Ziffern, Bindestriche): ${isObj(e) ? String(e.id) : '?'}`);
      continue;
    }
    if (ids.has(e.id)) errors.push(`${e.id}: id doppelt`);
    ids.add(e.id);
    checkEntry(e, now, terms, errors, warnings);
  }
  errors.push(...rankProblems(raw.entries.filter(isObj).filter((e) => isObj(e.featured)).map((e) => ({ who: String(e.id), rank: (e.featured as Obj).rank }))));
  return errors.length ? { errors, warnings } : { catalog: raw as unknown as SourceCatalog, errors, warnings };
}

/** Ranks must differ, and there are at most MAX_PICKS picks. */
function rankProblems(picks: readonly { who: string; rank: unknown }[]): string[] {
  const out: string[] = [];
  const byRank = new Map<number, string>();
  for (const p of picks) {
    if (typeof p.rank !== 'number') continue;
    const other = byRank.get(p.rank);
    if (other) out.push(`${p.who}: Rang ${p.rank} der Empfehlung hat schon ${other}`);
    else byRank.set(p.rank, p.who);
  }
  if (picks.length > MAX_PICKS) out.push(`Zu viele Empfehlungen (${picks.length}, höchstens ${MAX_PICKS})`);
  return out;
}

/* ------------------------------------------------------------ released items */

export function validateReleased(raw: unknown, catalog?: SourceCatalog): { released: ReleasedItem[]; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw) || raw.format !== 1 || !Array.isArray(raw.released)) return { released: [], errors: ['released.json: Format 1 mit Liste "released" erwartet'] };
  const out: ReleasedItem[] = [];
  const keys = new Set<string>();
  const ids = catalog ? new Set(catalog.entries.map((e: CatalogEntry) => e.id)) : undefined;
  const picks: { who: string; rank: unknown }[] = (catalog?.entries ?? []).filter((e) => e.featured).map((e) => ({ who: e.id, rank: e.featured?.rank }));
  for (const r of raw.released) {
    if (!isObj(r) || !str(r.key) || !str(r.by) || !isDate(r.at)) {
      errors.push(`released.json: Eintrag braucht key, by und at (${isObj(r) ? String(r.key) : '?'})`);
      continue;
    }
    const key = r.key as string;
    if (!key.includes('/')) errors.push(`released.json: ${key} ist kein Titel-Schlüssel (Eintrag/Titel)`);
    if (ids && !ids.has(key.slice(0, key.indexOf('/')))) errors.push(`released.json: ${key} gehört zu keinem Eintrag im Katalog`);
    if (keys.has(key)) errors.push(`released.json: ${key} doppelt`);
    keys.add(key);
    const item: ReleasedItem = { key, by: r.by as string, at: r.at };
    if (str(r.note)) item.note = r.note as string;
    if (r.ages !== undefined) {
      const ages = parseAgeRange(r.ages);
      if (!ages) errors.push(`released.json: ${key}: Altersangabe ungültig`);
      else item.ages = ages;
    }
    if (r.featured !== undefined) {
      const problems = pickProblems(r.featured);
      for (const p of problems) errors.push(`released.json: ${key}: ${p}`);
      const entry = catalog?.entries.find((e) => e.id === key.slice(0, key.indexOf('/')));
      if (catalog && entry && entry.status !== 'active') errors.push(`released.json: ${key}: Empfehlungen (featured) nur für Titel aktiver Einträge`);
      if (entry?.featured) errors.push(`released.json: ${key}: ${entry.id} ist schon als Ganzes empfohlen`);
      if (!problems.length) {
        const f = r.featured as Obj;
        item.featured = { rank: f.rank as number, why: (f.why as string).trim() };
      }
      picks.push({ who: key, rank: isObj(r.featured) ? r.featured.rank : undefined });
    }
    out.push(item);
  }
  errors.push(...rankProblems(picks).map((p) => `released.json: ${p}`));
  return { released: out, errors };
}
