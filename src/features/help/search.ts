/**
 * Search in the help. People type umlauts in every way ("Lautstärke",
 * "lautstaerke", "Lautstarke") and often only part of a word ("lautst",
 * "stärke"), so text and query are folded the same way and compared as
 * substrings. Every word of the query has to appear in a section; when no
 * section has all of them, the sections with the most of them are shown.
 *
 * A word that stands as a word counts more than the start of a longer one:
 * "kein Ton" is about sound, not about "TonUINO". In a query of several
 * words, a short word only counts where it stands as a word: "ohne Ton"
 * does not find "TonUINO … ohne Gewähr". The query as typed in a title or
 * keyword ("Box bleibt stumm", "kein Ton") counts most of all.
 */
import { MODES, modifiersFor } from '../../core/tonuino/modes';
import { BUILTIN_TEMPLATES } from '../../core/stickers/templates';
import { APP_VERSION } from '../../app/version';
import { CRATE_NOTICES, FONT_NOTICES, PACKAGE_NOTICES, licenseLabel } from './notices';
import { GLOSSARY } from './glossary';
import { HELP_TOPICS, blockTexts, plainText, sectionParts, type HelpBlock, type HelpPart, type HelpSection, type HelpTopic } from './topics';

/* ------------------------------------------------------------------ folding */

interface Folded {
  text: string;
  /** Index in the original text for every character of `text`. */
  map: number[];
}

type UmlautStyle = 'ae' | 'a';

const UMLAUT_AE: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue' };
/** Left out, so "SD-Karte", "SD Karte" and "sdkarte" all meet. */
const SKIPPED = /[-­‐‑–—'’]/;

/** Lower case without accents; ä becomes "ae" or "a", ß becomes "ss". */
function fold(text: string, umlauts: UmlautStyle): Folded {
  let out = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (SKIPPED.test(ch)) continue;
    const lower = ch.toLowerCase();
    let f: string;
    if (lower === 'ß') f = 'ss';
    else if (lower === '×') f = 'x';
    else if (umlauts === 'ae' && UMLAUT_AE[lower]) f = UMLAUT_AE[lower];
    else f = lower.normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const c of f) {
      out += c;
      map.push(i);
    }
  }
  return { text: out, map };
}

/** The same text in both umlaut styles. */
interface Searchable {
  raw: string;
  ae: Folded;
  a: Folded;
}

function searchable(raw: string): Searchable {
  return { raw, ae: fold(raw, 'ae'), a: fold(raw, 'a') };
}

interface Term {
  raw: string;
  ae: string;
  a: string;
  /** Counts only where it stands as a word, not as part of a longer one (see parseQuery). */
  wordOnly?: boolean;
}

/** Query words this short are whole words when the query has more than one word. */
const SHORT_WORD = 3;

/**
 * Words that say little in a question like "Wie mache ich die Karte neu?",
 * "Gibt es eine Pause-Karte?" or "Unsere Box macht plötzlich keinen Ton mehr".
 */
const STOP_WORDS = new Set(
  'wie was wo wer warum wieso wann welche welcher welches welchen ich du die der das den dem des ein eine einen einer eines und oder mit mein meine meinen meiner unser unsere unseren unserer unserem dein deine deinen deiner kann koennen muss soll ist sind gibt geht gehen nicht kein keine keinen keinem keiner keines auf in im an am zu zum zur von vom fuer bei beim mich mir sich es sie er wir man wenn dann so noch auch nur aber da hat habe haben wird werden bitte denn mache machen mehr immer schon jetzt mal ploetzlich leider trotzdem'.split(
    ' ',
  ),
);

/**
 * Left out like the other small words, but they say that something does not
 * work: "Karte geht nicht" asks for "Eine Karte wird nicht erkannt" rather
 * than for "Die SD-Karte auswählen".
 */
const NEGATIONS = new Set(['nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'keines']);

interface Query {
  /** The words searched for. */
  terms: Term[];
  /** Words of NEGATIONS left out of `terms`. They only decide between equally good pages. */
  negations: Term[];
  /** The query as typed, small words included, when it has more than one word: "kein Ton". */
  typed: Term | null;
  /** The words searched for in a row, when that is something else than `typed`: "Firmware aufspielen" for "Wie mache ich Firmware aufspielen?". */
  joined: Term | null;
}

function termOf(raw: string): Term {
  return { raw, ae: fold(raw, 'ae').text, a: fold(raw, 'a').text };
}

/** Several words as one term, for phrases. */
function phraseOf(words: Term[]): Term | null {
  return words.length > 1 ? termOf(words.map((w) => w.raw).join(' ')) : null;
}

function parseQuery(query: string): Query {
  const seen = new Set<string>();
  const all: Term[] = [];
  const words: Term[] = [];
  for (const word of query.split(/\s+/)) {
    const raw = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const term = termOf(raw);
    if (!term.ae) continue;
    all.push(term);
    if (seen.has(term.ae)) continue;
    seen.add(term.ae);
    words.push(term);
  }
  const typed = phraseOf(all);
  const meaningful = words.filter((t) => !STOP_WORDS.has(t.ae));
  const terms = meaningful.length ? meaningful : words;
  // Next to another word, a short word is meant as a word: "Ton" in "ohne Ton" is the sound, not the
  // start of "TonUINO", and "aus" in "Ton aus" is not the middle of "Bausteine". Typed alone, it may
  // still be the start of a longer word ("Ton" finds "TonUINO" too, behind the pages about sound).
  if (terms.length > 1) for (const t of terms) if (termLength(t) <= SHORT_WORD) t.wordOnly = true;
  if (!meaningful.length) return { terms, negations: [], typed, joined: null };
  const joined = phraseOf(meaningful);
  return {
    terms,
    negations: words.filter((t) => NEGATIONS.has(t.ae)),
    typed,
    joined: joined && joined.ae !== typed?.ae ? joined : null,
  };
}

/** The words of a query, without punctuation around them; question words only count when nothing else is left. */
export function queryTerms(query: string): Term[] {
  return parseQuery(query).terms;
}

interface Range {
  start: number;
  end: number;
}

/** Every place of the term in the text, in original positions, in both umlaut styles. */
function placesOf(s: Searchable, t: Term): Range[] {
  const places: Range[] = [];
  for (const [folded, needle] of [
    [s.ae, t.ae],
    [s.a, t.a],
  ] as const) {
    if (!needle) continue;
    for (let at = folded.text.indexOf(needle); at >= 0; at = folded.text.indexOf(needle, at + 1)) {
      places.push({ start: folded.map[at], end: folded.map[at + needle.length - 1] + 1 });
    }
  }
  return places;
}

/** Every place of every term that counts, merged and sorted. */
function allRanges(s: Searchable, terms: Term[]): Range[] {
  const ranges: Range[] = [];
  for (const t of terms) {
    const length = termLength(t);
    for (const r of placesOf(s, t)) {
      if (!t.wordOnly || fitAt(s.raw, r.start, r.end, length, false) === WORD) ranges.push(r);
    }
  }
  ranges.sort((x, y) => x.start - y.start || y.end - x.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function startsWord(text: string, at: number): boolean {
  return at === 0 || !WORD_CHAR.test(text[at - 1]);
}

/** How a query word stands in a text: inside a longer word, at its start, or as the word itself. */
type Fit = 0 | 1 | 2;
const INSIDE: Fit = 0;
const PREFIX: Fit = 1;
const WORD: Fit = 2;
/** What the fit adds to the weight of a field. */
const FIT_FACTOR: Readonly<Record<Fit, number>> = { 0: 1, 1: 1.5, 2: 2 };

/** Endings German adds to a word: "Karte" is the word in "Karten", "Box" in "Boxen", "Lied" in "Lieder". */
const ENDINGS = new Set(['e', 'n', 'en', 's', 'es', 'er', 'ern', 'em']);

/**
 * The fit of a match from `start` to `end` in the original text. Endings
 * count for query words of three letters or more. With `head`, the last part
 * of a compound counts as the word, like "Ansagen" in "Systemansagen".
 */
function fitAt(raw: string, start: number, end: number, length: number, head: boolean): Fit {
  let wordEnd = end;
  while (wordEnd < raw.length && WORD_CHAR.test(raw[wordEnd])) wordEnd++;
  const rest = raw.slice(end, wordEnd).toLowerCase();
  const endsWord = rest === '' || (length >= 3 && ENDINGS.has(rest));
  if (startsWord(raw, start)) return endsWord ? WORD : PREFIX;
  return endsWord && head ? WORD : INSIDE;
}

/** The best fit of the term anywhere in the text, or -1 when it is not there (or, for a word-only term, not as a word). */
function bestFit(s: Searchable, t: Term, length = termLength(t)): Fit | -1 {
  // Short words are too often the end of something else ("Ton" in "Karton"), and phrases have no compounds.
  const head = length >= 4 && !/\s/.test(t.raw);
  let best: Fit | -1 = -1;
  for (const r of placesOf(s, t)) {
    const fit = fitAt(s.raw, r.start, r.end, length, head);
    if (t.wordOnly && fit !== WORD) continue;
    if (fit > best) best = fit;
    if (best === WORD) break;
  }
  return best;
}

/** Whether the term stands in the text as a whole word: "nicht" in "Box wird nicht erkannt?", but not in "nichts". */
function hasWord(s: Searchable, t: Term): boolean {
  return placesOf(s, t).some((r) => startsWord(s.raw, r.start) && (r.end >= s.raw.length || !WORD_CHAR.test(s.raw[r.end])));
}

/* ------------------------------------------------------------------ marked text */

export interface MarkedPart {
  text: string;
  mark: boolean;
}

/** Splits a text into parts, marking every place a query word appears. */
export function markText(text: string, query: string | Term[]): MarkedPart[] {
  const terms = typeof query === 'string' ? queryTerms(query) : query;
  return markRanges(text, allRanges(searchable(text), terms));
}

function markRanges(text: string, ranges: Range[], from = 0, to = text.length): MarkedPart[] {
  const parts: MarkedPart[] = [];
  let at = from;
  for (const r of ranges) {
    if (r.end <= from || r.start >= to) continue;
    const start = Math.max(r.start, from);
    const end = Math.min(r.end, to);
    if (start > at) parts.push({ text: text.slice(at, start), mark: false });
    parts.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < to) parts.push({ text: text.slice(at, to), mark: false });
  return parts;
}

/* ------------------------------------------------------------------ index */

interface Field {
  s: Searchable;
  weight: number;
}

interface Doc {
  topic: HelpTopic;
  section?: HelpSection;
  /** A part of the page folded away under "Mehr" that has an id of its own (cover-finden, handy …). */
  part?: HelpPart;
  /** Order in the help, for equal scores. */
  order: number;
  title: Field;
  /** Title, keywords, summary and texts of the topic or section itself. */
  own: Field[];
  /** Texts shown as snippet, best first. */
  body: Searchable[];
  /**
   * For pages: the topic title and keywords, so "karten handy" finds the phone part first; for parts
   * also the title of their page. Never enough on its own.
   */
  context: Field[];
}

const TITLE = 10;
const KEYWORD = 6;
const SUMMARY = 3;
const BODY = 1;
const CONTEXT = 3;

/** The texts of generated blocks, as the help page shows them. */
export function generatedTexts(b: HelpBlock): string[] {
  switch (b.kind) {
    case 'modes':
      return MODES.map((m) => `${m.name}: ${m.tagline} ${m.goodFor}`);
    case 'modifiers': {
      const tng = modifiersFor('tng');
      const classicOnly = modifiersFor('classic21').filter((m) => !tng.some((t) => t.name === m.name));
      return [...tng, ...classicOnly].map((m) => `${m.name}: ${m.tagline}`);
    }
    case 'papers':
      return BUILTIN_TEMPLATES.map((t) => `${t.name}: ${t.description}`);
    case 'notices':
      return [
        ...PACKAGE_NOTICES.map((p) => `${p.name} ${p.version} ${licenseLabel(p.license)} ${p.copyright} ${p.use}`),
        ...FONT_NOTICES.map((f) => `${f.family} ${f.use} ${f.copyright} SIL Open Font License`),
        ...CRATE_NOTICES.map((c) => `${c.name} ${c.version} ${licenseLabel(c.license)} ${c.copyright} ${c.use}`),
      ];
    case 'version':
      return [`Version ${APP_VERSION}`];
    case 'glossary':
      return GLOSSARY.map((e) => `${e.term} ${(e.aka ?? []).join(' ')}: ${plainText(e.text)}`);
    default:
      return [];
  }
}

function blocksTexts(blocks: HelpBlock[]): string[] {
  return blocks.flatMap((b) => [...blockTexts(b).map(plainText), ...generatedTexts(b)]);
}

let docs: Doc[] | null = null;

function buildDocs(): Doc[] {
  const out: Doc[] = [];
  let order = 0;
  for (const topic of HELP_TOPICS) {
    const title = { s: searchable(topic.title), weight: TITLE };
    const keywords = (topic.keywords ?? []).map((k) => ({ s: searchable(k), weight: KEYWORD }));
    const summary = searchable(topic.summary);
    out.push({ topic, order: order++, title, own: [title, ...keywords, { s: summary, weight: SUMMARY }], body: [summary], context: [] });
    const topicContext = [{ s: title.s, weight: CONTEXT }, ...keywords.map((k) => ({ ...k, weight: CONTEXT }))];
    for (const section of topic.sections) {
      const sTitle = { s: searchable(section.title), weight: TITLE };
      const { main, parts } = sectionParts(section);
      // A part with an id is a place of its own; the others belong to the page, their title like a heading.
      const texts = [...blocksTexts(main), ...parts.filter((p) => !p.id).flatMap((p) => [p.title, ...blocksTexts(p.blocks)])];
      const summary = section.summary ? [searchable(section.summary)] : [];
      const body = [...summary, ...texts.map(searchable)];
      out.push({
        topic,
        section,
        order: order++,
        title: sTitle,
        own: [
          sTitle,
          ...(section.keywords ?? []).map((k) => ({ s: searchable(k), weight: KEYWORD })),
          ...summary.map((s) => ({ s, weight: SUMMARY })),
          ...texts.map((t) => ({ s: searchable(t), weight: BODY })),
        ],
        body,
        context: topicContext,
      });
      for (const part of parts) {
        if (!part.id) continue;
        const pTitle = { s: searchable(part.title), weight: TITLE };
        const pBody = blocksTexts(part.blocks).map(searchable);
        out.push({
          topic,
          section,
          part,
          order: order++,
          title: pTitle,
          own: [pTitle, ...(part.keywords ?? []).map((k) => ({ s: searchable(k), weight: KEYWORD })), ...pBody.map((s) => ({ s, weight: BODY }))],
          body: pBody,
          context: [{ s: sTitle.s, weight: CONTEXT }, ...topicContext],
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ search */

export interface HelpHit {
  topic: HelpTopic;
  section?: HelpSection;
  part?: HelpPart;
  /** The id to open as #/hilfe/<id>. */
  id: string;
  title: MarkedPart[];
  /** A short piece of text around the first match, or the topic summary. */
  snippet: MarkedPart[];
  score: number;
}

export interface HelpResults {
  hits: HelpHit[];
  /** How many pages match, also those left out by the limit. */
  total: number;
  /** True when no section has every word and the hits match only some. */
  partial: boolean;
  /** The words searched for, after leaving out question words. */
  terms: string[];
}

/** Shortest query that searches; a single letter would match everything. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Length of a word as it is searched: its shortest form. "Ü" is searched as
 * "ue" and as "u", and "u" alone matches nearly every page; "ß" becomes "ss"
 * but is still a single letter typed.
 */
function termLength(t: Term): number {
  return Math.min([...t.raw].length, t.ae.length, t.a.length);
}

interface Scored {
  doc: Doc;
  score: number;
  matched: number;
  /** 2: the query as typed stands in the title or a keyword ("kein Ton"), 1: its search words do, in a row. */
  phrase: number;
  /** How many search words stand as words, not only as part of a longer word. */
  whole: number;
  /** Negations of the query in the title or keywords: 2 each right before a search word, 1 elsewhere there. */
  hint: number;
  /** Whether a search word stands in the title or a keyword of the page itself. */
  named: boolean;
}

function scoreDoc(doc: Doc, q: Query): Scored {
  let score = 0;
  let matched = 0;
  let whole = 0;
  let own = false;
  let named = false;
  for (const t of q.terms) {
    const length = termLength(t);
    let best = 0;
    let isWord = false;
    for (const [fields, isOwn] of [
      [doc.own, true],
      [doc.context, false],
    ] as const) {
      for (const f of fields) {
        const fit = bestFit(f.s, t, length);
        if (fit === -1) continue;
        if (isOwn) {
          own = true;
          if (f.weight >= KEYWORD) named = true;
        }
        best = Math.max(best, f.weight * FIT_FACTOR[fit]);
        if (fit === WORD) isWord = true;
      }
    }
    if (best > 0) {
      matched++;
      score += best;
      if (isWord) whole++;
    }
  }
  if (!own) return { doc, score: 0, matched: 0, phrase: 0, whole: 0, hint: 0, named: false };
  // Title and keywords, not the texts: nearly every text says "nicht" somewhere.
  const titled = doc.own.filter((f) => f.weight >= KEYWORD);
  const phraseIn = (p: Term | null) => !!p && titled.some((f) => bestFit(f.s, p) === WORD);
  const phrase = phraseIn(q.typed) ? 2 : phraseIn(q.joined) ? 1 : 0;
  // A negation right before a search word says more than one anywhere: "geht nicht aus" is "Die Box geht
  // nicht von selbst aus" (keyword "schaltet sich nicht aus"), not "… oder reagiert nicht mehr".
  const negated = (n: Term) => q.terms.some((t) => titled.some((f) => bestFit(f.s, termOf(`${n.raw} ${t.raw}`)) === WORD));
  const hint = q.negations.reduce((sum, n) => sum + (negated(n) ? 2 : titled.some((f) => hasWord(f.s, n)) ? 1 : 0), 0);
  return { doc, score, matched, phrase, whole, hint, named };
}

const SNIPPET_BEFORE = 50;
const SNIPPET_AFTER = 130;

/**
 * The text with the most query words standing as words, then with the most
 * query words at all, else the first one. When the page matched by a word in
 * its title or keywords and its texts have the query only inside longer words,
 * the first text says more: "kein Ton" should not show "TonUINO".
 */
function snippetOf(doc: Doc, terms: Term[], wordMatched: boolean): MarkedPart[] {
  let best: { s: Searchable; ranges: Range[]; whole: number; words: number } | null = null;
  for (const s of doc.body) {
    const fits = terms.map((t) => bestFit(s, t));
    const words = fits.filter((f) => f >= 0).length;
    const whole = fits.filter((f) => f === WORD).length;
    if (words && (!best || whole > best.whole || (whole === best.whole && words > best.words))) best = { s, ranges: allRanges(s, terms), whole, words };
  }
  if (best && !best.whole && wordMatched) best = null;
  const s = best?.s ?? doc.body[0];
  if (!s) return [];
  const text = s.raw;
  const ranges = best?.ranges ?? [];
  const first = ranges[0]?.start ?? 0;
  let from = Math.max(0, first - SNIPPET_BEFORE);
  let to = Math.min(text.length, first + SNIPPET_AFTER);
  // Whole words only.
  if (from > 0) {
    const space = text.indexOf(' ', from);
    from = space >= 0 && space < first ? space + 1 : from;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(' ', to);
    to = space > first ? space : to;
  }
  const parts = markRanges(text, ranges, from, to);
  if (from > 0) parts.unshift({ text: '… ', mark: false });
  if (to < text.length) parts.push({ text: ' …', mark: false });
  return parts;
}

export interface SearchOptions {
  /**
   * The app brings changes to the card in a Paket (Firefox, Safari). Without
   * it, the pages only about the Paket come after all others: in Chrome, Edge
   * and the desktop app "formatieren" should find "Die SD-Karte wird nicht
   * erkannt", not the whole-card Paket that is not there.
   */
  packageMode?: boolean;
}

/** The pages for a query, best first, and whether they match only some of its words. */
function rank(query: string, opts: SearchOptions = {}): { q: Query; found: Scored[]; partial: boolean } | null {
  const q = parseQuery(query);
  const length = q.terms.reduce((n, t) => n + termLength(t), 0);
  if (!q.terms.length || length < MIN_QUERY_LENGTH) return null;
  docs ??= buildDocs();
  const scored = docs.map((doc) => scoreDoc(doc, q)).filter((r) => r.matched > 0);
  let found = scored.filter((r) => r.matched === q.terms.length);
  const partial = found.length === 0 && q.terms.length > 1;
  if (partial) {
    // At least half of the words, so one common word does not list everything.
    found = scored.filter((r) => r.matched >= Math.ceil(q.terms.length / 2));
  }
  // Pages only about the Paket come last where there is no Paket (see SearchOptions). Then the pages
  // with the query in their title or keywords, then those where more words stand as
  // words: "kein Ton" lists "Die Box bleibt stumm" before "Über TonUINO Studio". On equal scores a
  // "nicht" in the query puts the pages about problems first: "Karte geht nicht" lists "Eine Karte
  // wird nicht erkannt" first. Then the topic comes before its sections: "Karte" lists "Karten
  // beschreiben" first.
  const elsewhere = (r: Scored) => Number(!opts.packageMode && !!r.doc.section?.packageOnly);
  found.sort(
    (x, y) =>
      elsewhere(x) - elsewhere(y) ||
      y.matched - x.matched ||
      y.phrase - x.phrase ||
      y.whole - x.whole ||
      y.score - x.score ||
      y.hint - x.hint ||
      Number(!!x.doc.section) - Number(!!y.doc.section) ||
      x.doc.order - y.doc.order,
  );
  return { q, found, partial };
}

/** Topics and sections for the query, best first. */
export function searchHelp(query: string, limit = 30, opts: SearchOptions = {}): HelpResults {
  const ranked = rank(query, opts);
  if (!ranked) return { hits: [], total: 0, partial: false, terms: [] };
  const { q, found, partial } = ranked;
  const terms = q.terms;
  const hits = found.slice(0, limit).map(({ doc, score, whole }) => ({
    topic: doc.topic,
    section: doc.section,
    ...(doc.part ? { part: doc.part } : {}),
    id: doc.part?.id ?? doc.section?.id ?? doc.topic.id,
    title: markRanges(doc.title.s.raw, allRanges(doc.title.s, terms)),
    snippet: snippetOf(doc, terms, whole > 0),
    score,
  }));
  return { hits, total: found.length, partial, terms: terms.map((t) => t.raw) };
}

/** The line under the search field, read out by screen readers; empty while nothing is searched. */
export function resultStatus(r: HelpResults): string {
  if (!r.terms.length) return '';
  if (!r.total) return 'Nichts gefunden.';
  const more = r.hits.length < r.total ? ` Hier stehen die ${r.hits.length} besten.` : '';
  if (r.partial) return `Keine Seite enthält alle Wörter. ${r.total === 1 ? 'Ein Treffer passt' : `${r.total} Treffer passen`} zum Teil.${more}`;
  return more ? `${r.total} Treffer.${more}` : `${r.total} Treffer`;
}

/**
 * What to search for when a help link leads nowhere, like an old or mistyped
 * id: its words, but only when a page has them in its title or keywords. A
 * word somewhere in a text is too little to guess from, and an id of only
 * small words ("gibt-es-nicht") says nothing about a page.
 */
export function searchForMissing(id: string): string | undefined {
  const words = id.replace(/[-_]+/g, ' ').trim();
  if (!queryTerms(words).some((t) => !STOP_WORDS.has(t.ae))) return undefined;
  // Every page counts here: the words are searched again with the options of the page.
  return rank(words, { packageMode: true })?.found[0]?.named ? words : undefined;
}
