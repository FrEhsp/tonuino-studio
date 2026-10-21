/**
 * What the "Entdecken" page shows: the choices for kind and age, and the
 * search over the downloaded index. Runs locally; nothing is sent anywhere.
 */
import { normalizeSearch } from './text';
import type { AgeInfo, AgeRange, Category, EditorPick, IndexEntry, IndexItem, MediaFile, SourceIndex } from './types';

export type CategoryChoice = Category | 'alle';

export const CATEGORY_CHOICES: readonly { id: CategoryChoice; label: string }[] = [
  { id: 'alle', label: 'Alles' },
  { id: 'hoerspiel', label: 'Hörspiele' },
  { id: 'hoerbuch', label: 'Hörbücher' },
  { id: 'wissen', label: 'Wissen' },
  { id: 'lied', label: 'Lieder' },
];

/** Plural labels for the badges on a source card. */
export const CATEGORY_LABEL: Record<Category, string> = { hoerspiel: 'Hörspiele', hoerbuch: 'Hörbücher', lied: 'Lieder', wissen: 'Wissen' };

export type AgeBandId = 'alle' | 'bis5' | '6bis11' | 'ab12';

export const AGE_BANDS: readonly { id: AgeBandId; label: string; min: number; max: number }[] = [
  { id: 'alle', label: 'Jedes Alter', min: 0, max: 99 },
  { id: 'bis5', label: 'Bis 5', min: 0, max: 5 },
  { id: '6bis11', label: '6 bis 11', min: 6, max: 11 },
  { id: 'ab12', label: 'Ab 12', min: 12, max: 17 },
];

/** Upper end for ranges without one: nothing in the index is meant for adults. */
const OPEN_MAX = 17;

/** An entry or episode fits a band when their age ranges overlap. Open-ended ranges run to 17. */
export function fitsBand(ages: AgeRange, band: AgeBandId): boolean {
  const b = AGE_BANDS.find((x) => x.id === band) ?? AGE_BANDS[0];
  return ages.min <= b.max && (ages.max ?? OPEN_MAX) >= b.min;
}

/** Short badge: "ab 7 Jahren", "4 bis 8 Jahre", "bis 5 Jahre"; the same words as the sentence on the source page. */
export function agesLabel(ages: AgeRange): string {
  if (ages.max === undefined) return ages.min <= 0 ? 'jedes Alter' : `ab ${ages.min} ${ages.min === 1 ? 'Jahr' : 'Jahren'}`;
  if (ages.min === ages.max) return `${ages.min} Jahre`;
  if (ages.min <= 0) return `bis ${ages.max} Jahre`;
  return `${ages.min} bis ${ages.max} Jahre`;
}

/**
 * The age line on a source page. Ages are recommendations; the sentence
 * says whose: the publisher's own words, or the estimate of whoever keeps the list.
 */
export function agesSentence(ages: AgeInfo): string {
  const base = ages.max === undefined ? `Empfohlen ab ${ages.min} Jahren` : ages.min <= 0 ? `Empfohlen bis ${ages.max} Jahre` : `Empfohlen für ${ages.min} bis ${ages.max} Jahre`;
  if (ages.source === 'editor') return `${base} (geschätzt, der Anbieter nennt kein Alter).`;
  return ages.text ? `${base}. Der Anbieter schreibt: „${ages.text.trim()}“` : `${base} (Angabe des Anbieters).`;
}

export interface Query {
  text?: string;
  category?: CategoryChoice;
  band?: AgeBandId;
}

export interface Hit {
  entry: IndexEntry;
  /** The items that pass the choices and the search, in index order (episode order stays). */
  items: IndexItem[];
  /** The search words matched the source itself (title, publisher, description), not only some of its items. */
  entryMatch: boolean;
  /** The items were found by their own texts (title, names, chapters): the card lists them. False: the whole source. */
  itemsMatched: boolean;
  /** Chapters or songs whose title the search words found, for the card ("Kapitel: Rapunzel"). */
  chapters: ChapterHit[];
  /** Higher is better. */
  score: number;
  /** The editors' pick: the source's own, else the best of its shown titles. */
  pick?: EditorPick;
  /** 0: described source with described titles of known length; 1: the rest. */
  tier: 0 | 1;
}

/** A chapter (or song) of an item that the search found by its title. */
export interface ChapterHit {
  item: IndexItem;
  /** The row's key on the source page: the item's key, "#" and its place in filesInOrder. */
  key: string;
  title: string;
}

/** Share of titles that need a description and a known length for the better tier. */
export const WELL_DESCRIBED_SHARE = 0.8;

/** The playing time of an item: its own, else the sum of its files when all are known. */
export function itemSeconds(item: IndexItem): number | undefined {
  if (item.durationSec) return item.durationSec;
  if (!item.files.length || !item.files.every((f) => f.durationSec)) return undefined;
  return item.files.reduce((n, f) => n + (f.durationSec ?? 0), 0);
}

/**
 * 0 for a source with our own description whose titles mostly have a text
 * from the publisher and a known length; 1 for the rest. The index has no
 * pictures of its own (the app draws covers), so a cover cannot count.
 */
export function qualityTier(entry: Pick<IndexEntry, 'blurb'>, items: readonly IndexItem[]): 0 | 1 {
  if (!entry.blurb || !items.length) return 1;
  const good = items.filter((it) => !it.sparse && itemSeconds(it) !== undefined).length;
  return good / items.length >= WELL_DESCRIBED_SHARE ? 0 : 1;
}

function bestPick(entry: IndexEntry, items: readonly IndexItem[]): EditorPick | undefined {
  let best = entry.featured;
  for (const it of items) if (it.featured && (!best || it.featured.rank < best.rank)) best = it.featured;
  return best;
}

function matchesAll(haystack: string, words: readonly string[]): boolean {
  return words.every((w) => haystack.includes(w));
}

/** Every word starts a word of the text: "Muck" in "Der kleine Muck", not only inside "Pumuckl". */
function startsWords(haystack: string, words: readonly string[]): boolean {
  const t = ` ${haystack}`;
  return words.every((w) => t.includes(` ${w}`));
}

/**
 * Text to search in, folded twice: umlauts as "ae" and as plain "a". So
 * "Maerchen" and "Marchen" find "Märchen", and "Sandmann" finds "Sandmännchen".
 */
export function searchable(s: string): string {
  const a = normalizeSearch(s);
  const b = normalizeSearch(s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  return a === b ? a : `${a} ${b}`;
}

/** The search words of a query: normalised, no duplicates. */
export function searchWords(text: string | undefined): string[] {
  return [...new Set(normalizeSearch(text ?? '').split(' ').filter(Boolean))];
}

/**
 * A long search word also finds its other forms: without the ending -en, -e
 * or -n, "Weihnachten" finds "Weihnacht…" and "Piraten" finds "Pirat".
 * Short words stay as they are, they would find too much.
 */
export function searchStem(word: string): string {
  if (word.length < 6 || /\d/.test(word)) return word;
  return word.replace(/(en|e|n)$/, '');
}

/** The files of an item in playing order, as the source page lists them. */
export function filesInOrder(item: Pick<IndexItem, 'files'>): MediaFile[] {
  return [...item.files].sort((a, b) => (a.track ?? 0) - (b.track ?? 0));
}

/**
 * Filters and searches the index. All words must match (in the source's
 * texts, the item's title, names and chapters, or both together). Blocked
 * entries and items never show. A source that matches as a whole lists the
 * items that match on their own, else all of them. Sources that match as a
 * whole come first, then by title.
 */
export function search(index: SourceIndex, q: Query): Hit[] {
  const words = searchWords(q.text).map(searchStem);
  const blocked = new Set(index.blocked);
  const hits: Hit[] = [];
  for (const entry of index.entries) {
    if (blocked.has(entry.id)) continue;
    const entryText = searchable([entry.title, entry.publisher, entry.blurb ?? '', entry.about ?? '', entry.featured?.why ?? ''].join(' '));
    const entryMatch = words.length > 0 && matchesAll(entryText, words);
    const fitting = entry.items.filter((it) => {
      if (blocked.has(it.key)) return false;
      if (q.category && q.category !== 'alle' && it.category !== q.category) return false;
      if (q.band && q.band !== 'alle' && !fitsBand(it.ages ?? entry.ages, q.band)) return false;
      return true;
    });
    if (!words.length) {
      if (fitting.length) hits.push({ entry, items: fitting, entryMatch, itemsMatched: false, chapters: [], score: 0, pick: bestPick(entry, fitting), tier: qualityTier(entry, fitting) });
      continue;
    }
    const textOf = (it: IndexItem) =>
      searchable([it.title, it.tradition ?? '', it.about ?? '', it.featured?.why ?? '', ...(it.creators ?? []).map((p) => p.name), ...it.files.map((f) => f.title ?? '')].join(' '));
    const own = fitting.filter((it) => matchesAll(textOf(it), words));
    const together = fitting.filter((it) => matchesAll(`${entryText} ${textOf(it)}`, words));
    // A source found as a whole lists only its items found on their own ("Schatzinsel" in the classics), else all.
    const itemsMatched = !entryMatch || own.length > 0;
    const items = entryMatch ? (own.length ? own : fitting) : together;
    if (!items.length) continue;
    const chapters: ChapterHit[] = [];
    if (itemsMatched) {
      for (const it of items) {
        filesInOrder(it).forEach((f, i) => {
          if (!f.title || f.title === it.title) return;
          const title = searchable(f.title);
          if (words.some((w) => title.includes(w)) && matchesAll(`${entryText} ${searchable(it.title)} ${title}`, words)) chapters.push({ item: it, key: `${it.key}#${i}`, title: f.title });
        });
      }
    }
    const shown = [entryText, ...items.map(textOf)].join(' ');
    const score = (entryMatch ? 2 : 0) + 1 + (startsWords(shown, words) ? 1 : 0);
    hits.push({ entry, items, entryMatch, itemsMatched, chapters, score, pick: bestPick(entry, items), tier: qualityTier(entry, items) });
  }
  return rankHits(hits);
}

/**
 * The order of the list and of search results: editors' picks first (by
 * rank), then sources that match as a whole, then well described sources,
 * then by German title. The titles inside a source keep their order.
 */
export function rankHits(hits: Hit[]): Hit[] {
  const collator = new Intl.Collator('de');
  const rank = (h: Hit) => h.pick?.rank ?? Infinity;
  return hits.sort((a, b) => rank(a) - rank(b) || b.score - a.score || a.tier - b.tier || collator.compare(a.entry.title, b.entry.title));
}

/** A title that is one part of a story told in several episodes: "Komet im Mumintal (2/4): Auf in die Berge". */
export interface StoryPart {
  /** "Komet im Mumintal" */
  story: string;
  part: number;
  of: number;
}

/**
 * The story and part a title names with "(n/m)" right after the story's
 * name. "Mucks Wüstenfuchs: Am Strand (5/10)" is a part too, but of a story
 * named "Mucks Wüstenfuchs: Am Strand": episodes with names of their own
 * never share a story, only parts that the publisher numbers under one name.
 */
export function storyPart(title: string): StoryPart | undefined {
  const m = /^(.+?)\s*\((\d{1,2})\s*\/\s*(\d{1,2})\)(?:\s*[:–-].*)?$/u.exec(title.trim());
  if (!m) return undefined;
  const part = Number(m[2]);
  const of = Number(m[3]);
  if (part < 1 || of < 2 || part > of) return undefined;
  return { story: m[1].trim(), part, of };
}

/** A story as the list shows it: one title, or the parts of one story ("Die Schatzinsel (1/3)" to "(3/3)") together. */
export interface Story {
  /** The story's name when it has several parts, else the title. */
  title: string;
  /** Its titles: one, or the parts in order. */
  items: IndexItem[];
}

/**
 * The titles of a source as stories, in the source's order: parts of one
 * story (the same name and count, each number once, at least two of them)
 * join the place of the first part. Everything else stays a story of its own.
 */
export function storyGroups(items: readonly IndexItem[]): Story[] {
  const id = (s: StoryPart) => `${normalizeSearch(s.story)}|${s.of}`;
  const byStory = new Map<string, number[]>();
  for (const it of items) {
    const s = storyPart(it.title);
    if (s) byStory.set(id(s), [...(byStory.get(id(s)) ?? []), s.part]);
  }
  const shared = new Set([...byStory].filter(([, parts]) => parts.length >= 2 && new Set(parts).size === parts.length).map(([k]) => k));
  const out: Story[] = [];
  const open = new Map<string, Story>();
  for (const it of items) {
    const s = storyPart(it.title);
    const k = s ? id(s) : '';
    if (!s || !shared.has(k)) {
      out.push({ title: it.title, items: [it] });
      continue;
    }
    const story = open.get(k);
    if (story) story.items.push(it);
    else {
      const fresh = { title: s.story, items: [it] };
      open.set(k, fresh);
      out.push(fresh);
    }
  }
  for (const story of open.values()) story.items.sort((a, b) => (storyPart(a.title)?.part ?? 0) - (storyPart(b.title)?.part ?? 0));
  return out;
}

/** One recommendation: a whole source, one title of it, or one story of a source that is recommended as a whole. */
export interface Recommendation {
  entry: IndexEntry;
  /** Set when the card stands for one title or story, not the whole source: the title, or the story's first part. */
  item?: IndexItem;
  pick: EditorPick;
  /** The titles of the card that pass the choices: for its count and length. */
  items: IndexItem[];
  /** The story's name when the card holds several parts of it. */
  story?: string;
  /** The card is one story of a source recommended as a whole (its own words then, not the source's reason). */
  fromSource?: true;
}

/** Stories of one recommended source that show among the picks; the others stay in the list below. */
export const PICK_STORIES = 3;

/**
 * The editors' picks that pass the choices for kind and age. A source that
 * shows its titles one by one (`single`) is no bundle here either: its first
 * stories become picks of their own, each with its own picture. The order
 * takes the first story of every pick by rank, then the second ones, so the
 * first cards show different sources. Blocked sources and titles never
 * show; a source whose titles all fall outside the choices does not either.
 */
export function recommendations(index: SourceIndex, q: Pick<Query, 'category' | 'band'> = {}): Recommendation[] {
  const blocked = new Set(index.blocked);
  const fits = (entry: IndexEntry, it: IndexItem) =>
    !blocked.has(it.key) && (!q.category || q.category === 'alle' || it.category === q.category) && (!q.band || q.band === 'alle' || fitsBand(it.ages ?? entry.ages, q.band));
  const out: { r: Recommendation; round: number }[] = [];
  for (const entry of index.entries) {
    if (blocked.has(entry.id)) continue;
    const items = entry.items.filter((it) => fits(entry, it));
    if (!items.length) continue;
    const pick = entry.featured;
    if (pick && entry.single) {
      storyGroups(items)
        .slice(0, PICK_STORIES)
        .forEach((s, round) => out.push({ round, r: { entry, item: s.items[0], pick, items: s.items, fromSource: true, ...(s.items.length > 1 ? { story: s.title } : {}) } }));
    } else if (pick) out.push({ round: 0, r: { entry, pick, items } });
    else for (const it of items) if (it.featured) out.push({ round: 0, r: { entry, item: it, pick: it.featured, items: [it] } });
  }
  return out.sort((a, b) => a.round - b.round || a.r.pick.rank - b.r.pick.rank).map((x) => x.r);
}

/** Entry ids and item keys of the index that must not show (kill switch), plus any blocked later. */
export function withoutBlocked(index: SourceIndex, extra: readonly string[] = []): SourceIndex {
  const blocked = new Set([...index.blocked, ...extra]);
  if (!blocked.size) return index;
  return {
    ...index,
    blocked: [...blocked],
    entries: index.entries.filter((e) => !blocked.has(e.id)).map((e) => ({ ...e, items: e.items.filter((it) => !blocked.has(it.key)) })).filter((e) => e.items.length > 0),
  };
}
