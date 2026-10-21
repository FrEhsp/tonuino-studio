/**
 * Small text helpers for the source index: durations, publisher age
 * statements, title prefixes, search normalisation and the keyword scan
 * that holds new podcast episodes for a person to look at.
 */
import { decodeEntities } from './rss';
import type { AgeRange } from './types';

/**
 * Playing time from feed and archive data: "52:59", "1:02:03", "2653",
 * "530.74" (seconds). Undefined for empty, zero or unreadable values.
 */
export function parseDuration(raw: string | number | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  let sec: number;
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return undefined;
    sec = parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  } else if (/^\d+(\.\d+)?$/.test(s)) {
    sec = Number(s);
  } else {
    return undefined;
  }
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec) : undefined;
}

/**
 * Lower case, umlauts as ae/oe/ue, ß as ss, no accents, single spaces.
 * Punctuation stays, so "16+" and "CN:" can still be read.
 */
export function foldText(s: string): string {
  // NFC first: a feed written on a Mac may spell "ü" as "u" plus a combining mark.
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Show notes as plain text: tags removed, entities decoded (also twice
 * encoded ones such as "&amp;auml;"), single spaces.
 */
export function plainText(s: string | undefined): string {
  if (!s) return '';
  let t = s;
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = decodeEntities(
      t
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/?[a-z][^<>]*>/gi, ' '),
    );
    if (t === before) break;
  }
  return t.replace(/\s+/g, ' ').trim();
}

const MONTHS = 'januar|februar|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|jan|feb|mrz|apr|jun|jul|aug|sep|sept|okt|nov|dez';
/** "ab 10 Uhr", "ab 5 Minuten", "ab 20 Euro", "ab 16. Oktober", "ab 12:30": not ages. */
const NOT_AGE_AFTER = new RegExp(
  `^(?:\\s*[.,:]\\s*\\d|\\.\\s*(?:${MONTHS})\\b|\\s*(?:uhr|minuten|min\\b|sekunden|stunden|std\\b|prozent|%|euro|eur\\b|€|cent|seiten|folgen|teile|teilen|personen|spieler|teilnehmer|grad|°|km\\b|kilometer|meter|kg\\b|stueck|punkte|punkten|mal\\b))`,
);

type AgeRule = { re: RegExp; ages: (m: RegExpExecArray) => AgeRange | undefined };

function age(n: string | undefined, cap = 18): number | undefined {
  const v = n === undefined ? NaN : Number(n);
  if (!Number.isInteger(v) || v < 0 || v > cap) return undefined;
  return Math.min(v, 18);
}

function range(minText: string, maxText: string | undefined): AgeRange | undefined {
  const min = age(minText);
  if (min === undefined) return undefined;
  const max = maxText === undefined ? undefined : age(maxText);
  return max !== undefined && max >= min ? { min, max } : { min };
}

/**
 * Age statements, read from folded text (see foldText). Every statement
 * counts; the highest one wins (parseAges).
 */
const AGE_RULES: AgeRule[] = [
  { re: /zwischen\s+(\d{1,2})\s+und\s+(\d{1,2})\s+jahr/g, ages: (m) => range(m[1], m[2]) },
  { re: /(?:ab|von)\s+(\d{1,2})\s+bis\s+(\d{1,2})\s*-?\s*(?:jahr|jaehrig)/g, ages: (m) => range(m[1], m[2]) },
  { re: /\b(\d{1,2})\s*-?\s*(?:-|–|bis)\s*(\d{1,2})\s*-?\s*(?:jahr|jaehrig)/g, ages: (m) => range(m[1], m[2]) },
  { re: /altersempfehlung\s*:?\s*(?:ab\s+)?(\d{1,2})(?:\s*(?:-|–|bis)\s*(\d{1,2}))?/g, ages: (m) => range(m[1], m[2]) },
  { re: /\bab\s+(\d{1,2})\s*(?:jahr|j\.|\+)/g, ages: (m) => range(m[1], undefined) },
  {
    re: /\bab\s+(\d{1,2})\b/g,
    ages: (m) => (NOT_AGE_AFTER.test(m.input.slice(m.index + m[0].length)) ? undefined : range(m[1], undefined)),
  },
  // "(16+)", "12+": not "1+1" or "Teil 2 + 3".
  { re: /(?<![\d.,:/+-])(\d{1,2})\s*\+(?!\s*\d)/g, ages: (m) => range(m[1], undefined) },
  // "Ü18", "ü 16" (folded to "ue18").
  { re: /(?:^|[^a-z0-9])ue\s?-?(\d{2})\b/g, ages: (m) => (age(m[1], 21) === undefined ? undefined : { min: age(m[1], 21)! }) },
  { re: /\b(?:fsk|usk|pegi)\s*:?\s*(?:ab\s*)?(\d{1,2})\b/g, ages: (m) => range(m[1], undefined) },
  { re: /\bnicht\s+fuer\s+kinder\s+unter\s+(\d{1,2})/g, ages: (m) => range(m[1], undefined) },
  { re: /\bunter\s+(\d{1,2})\s+(?:jahren\s+)?nicht\s+geeignet/g, ages: (m) => range(m[1], undefined) },
  // Plainly for adults. A bare "für Erwachsene" ("für Kinder und Erwachsene") is not an age; see holdReasons.
  { re: /\bnur\s+fuer\s+erwachsene/g, ages: () => ({ min: 18 }) },
  { re: /\berwachsenen(?:hoerspiel|hoerbuch|krimi|programm|unterhaltung|literatur|roman|thriller)/g, ages: () => ({ min: 18 }) },
  {
    re: /\b(?:hoerspiel|hoerbuch|krimi|thriller|lesung|sendung|podcast|programm|geschichte|geschichten|serie|folge)\s+(?:nur\s+)?fuer\s+erwachsene/g,
    ages: () => ({ min: 18 }),
  },
];

/**
 * Age statement in a publisher's words: "(Ab 8 Jahren)", "ab 5 Jahren",
 * "zwischen 4 und 8 Jahren", "4-8 Jahre", "(16+)", "Ü18", "FSK 16",
 * "Altersempfehlung: 14 Jahre", "Hörspiel für Erwachsene" (18).
 * Not "ab 10 Uhr", "ab 5 Minuten", "ab 20 Euro" or "ab 16. Oktober".
 * All statements count and the highest wins: "Für Kinder ab 6 Jahren. Die
 * Langfassung erst ab 16." is 16.
 */
export function parseAges(text: string | undefined): AgeRange | undefined {
  if (!text) return undefined;
  const t = foldText(text);
  let best: AgeRange | undefined;
  for (const rule of AGE_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(t))) {
      const a = rule.ages(m);
      if (!a) continue;
      if (!best || a.min > best.min || (a.min === best.min && best.max === undefined && a.max !== undefined)) best = a;
    }
  }
  return best;
}

/** Removes the first matching prefix ("Kinderhörspiel - "). */
export function stripPrefix(title: string, prefixes: readonly string[] | undefined): string {
  const t = title.trim();
  for (const p of prefixes ?? []) {
    if (t.toLowerCase().startsWith(p.toLowerCase()) && t.length > p.length) return t.slice(p.length).trim();
  }
  return t;
}

/**
 * The title without the episode counter at its end ("Verzockt (5/26)"), for
 * series that count their episodes that way (CatalogEntry.dropCounter).
 * Nothing is removed when only the counter would remain.
 */
export function dropCounter(title: string): string {
  const t = title.trim();
  return t.replace(/\s*\(\s*\d{1,3}\s*\/\s*\d{1,3}\s*\)$/u, '') || t;
}

/**
 * Display title of an episode: the series pattern (a regular expression
 * anchored at the start) removed first, else the first matching prefix.
 * Nothing is removed when only the prefix would remain. `counter`: the
 * episode counter at the end goes too (dropCounter).
 */
export function cleanTitle(title: string, opts: { pattern?: string; prefixes?: readonly string[]; counter?: boolean }): string {
  const t = opts.counter ? dropCounter(title) : title.trim();
  if (opts.pattern) {
    const rest = t.replace(new RegExp(opts.pattern, 'i'), '').trim();
    if (rest && rest !== t) return rest;
  }
  return stripPrefix(t, opts.prefixes);
}

/** First word of each prefix ("Kinderhörspiel" from "Kinderhörspiel - "), lower case. */
export function prefixWords(prefixes: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const p of prefixes ?? []) {
    const w = /^[\p{L}\p{N}]+/u.exec(p.trim())?.[0]?.toLowerCase();
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

/** Lower case, no accents, ß as ss, single spaces: "Märchen" and "maerchen" both find "Märchen". */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------ warning words */

/**
 * One kind of warning. Words are matched on folded text (see foldText), as
 * whole words or inside compound words: "Doppelmord", "Weltkrieg",
 * "Wasserleiche". `harmless` words never count ("Waffel", "Drogerie").
 */
interface WatchRule {
  label: string;
  /** Matched anywhere inside a word. */
  inside?: string[];
  /** The whole word. */
  words?: string[];
  /** The start of a word. */
  starts?: string[];
  /** The end of a word. */
  ends?: string[];
  /** Regular expressions tested against each word. */
  wordRes?: RegExp[];
  /** Phrases on the folded text (words and spaces). */
  phrases?: string[];
  /** Regular expressions on the folded text. */
  textRes?: RegExp[];
  harmless?: RegExp[];
}

const WATCH: WatchRule[] = [
  {
    label: 'Grusel',
    inside: ['horror', 'grusel', 'gaensehaut', 'zombie', 'vampir', 'daemon', 'werwolf', 'exorzis', 'schauergeschicht', 'schauermaerchen'],
  },
  {
    label: 'Gewalt oder Tod',
    inside: [
      'mord', 'moerd', 'toet', 'folter', 'suizid', 'massaker', 'gemetzel', 'hinricht', 'blutbad', 'blutig', 'blutruenst', 'blutvergiess',
      'blutrache', 'erschoss', 'erschiess', 'erstoch', 'erstech', 'erstich', 'erwuerg', 'amok', 'terror', 'attentat', 'geisel',
      'missbrauch', 'misshandl', 'entfuehr', 'kidnapp', 'vergewaltig', 'pistole', 'gewehr', 'leichen',
    ],
    words: ['tod', 'tot', 'tote', 'toten', 'toter', 'totes', 'leiche', 'sterben', 'stirbt', 'starb', 'gestorben'],
    starts: ['todes', 'totschlag', 'totgeschlagen', 'totgeschossen', 'totgestochen', 'totgefahren', 'totgebissen'],
    ends: ['tod', 'leiche'],
    wordRes: [/waffe(?!l)/, /krieg/, /gewalt/],
    harmless: [
      // Intensifiers: "Mordsspaß", "Mordshunger".
      /^mords(?:spass|gaudi|hunger|ding|dinger|kerl|glueck|laerm|stimmung|appetit|schreck|durst|aerger|spektakel|radau|krach|wut|tempo|stress|arbeit|freude)/,
      /(?:wasser|spritz|heissklebe)pistolen?$/,
      // "kriegen" (to get): "hinkriegen", "Wir kriegen das hin".
      /krieg(?:en|t|st|te|ten|tet)$/,
      /^gewaltig(?:e[mnrs]?|ste[mnrs]?)?$/,
      /[bg]leiche/,
      /schleich/,
      /^totem/,
    ],
  },
  {
    label: 'Sexualität',
    inside: ['sex', 'erotik', 'erotisch', 'porno', 'nackt', 'vergewaltig', 'prostitu', 'bordell'],
    harmless: [/^(?:es|sus|middle)sex/, /^sextett/, /nacktschnecke/, /nacktmull/],
  },
  {
    label: 'Drogen oder Alkohol',
    inside: ['droge', 'rauschgift', 'rauschmittel', 'drogenrausch', 'kokain', 'heroin', 'cannabis', 'marihuana', 'haschisch', 'kiff', 'alkohol', 'betrunken', 'besoffen', 'zigarett'],
    harmless: [/drogerie/, /drogist/, /^alkoholfrei/],
  },
  {
    label: 'Werbung',
    inside: ['werbung', 'werbe', 'anzeige', 'sponsor', 'gesponsert', 'rabatt', 'gutschein', 'promocode', 'affiliate', 'reklame', 'produktplatzierung', 'partnerlink'],
    phrases: ['praesentiert von', 'unterstuetzt von', 'in kooperation mit', 'mit freundlicher unterstuetzung', 'bezahlte partnerschaft', 'paid partnership'],
    words: ['promo'],
    harmless: [/bewerb/, /gewerbe/, /^werbefrei/, /^anzeigetafel/],
  },
  {
    label: 'Warnhinweis',
    inside: ['triggerwarnung', 'contentwarnung', 'inhaltswarnung', 'verstoerend'],
    phrases: [
      'content note', 'content warning', 'trigger warning', 'nicht fuer kinder', 'nicht geeignet fuer kinder', 'fuer kinder nicht geeignet', 'nicht kindgerecht',
    ],
    textRes: [/(?:^|[\s(])(?:cn|cw|tw)\s*:/],
  },
];

/** "für Erwachsene" that is not "für Kinder und Erwachsene" or "auch für Erwachsene". */
const FOR_ADULTS = /fuer erwachsene/;
const FAMILY_AND_ADULTS = /(?:kinder|kleine|familie|familien|jung|gross)\w*\s+(?:und|wie|&|oder|sowie)\s+(?:auch\s+)?(?:fuer\s+)?erwachsene|auch\s+fuer\s+erwachsene/;

function hasPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `) || ` ${text} `.includes(` ${phrase}`);
}

function matches(rule: WatchRule, words: string[], text: string, wordText: string): boolean {
  for (const w of words) {
    if (rule.harmless?.some((re) => re.test(w))) continue;
    if (rule.words?.includes(w)) return true;
    if (rule.inside?.some((x) => w.includes(x))) return true;
    if (rule.starts?.some((x) => w.startsWith(x))) return true;
    if (rule.ends?.some((x) => w.endsWith(x) && w.length > x.length)) return true;
    if (rule.wordRes?.some((re) => re.test(w))) return true;
  }
  if (rule.phrases?.some((p) => hasPhrase(wordText, p))) return true;
  return !!rule.textRes?.some((re) => re.test(text));
}

/**
 * Why a new episode should wait for a person, from its title and show notes
 * (plain text, see plainText). Not a filter: a prompt to listen first.
 * Empty: nothing found. Ages are read by parseAges.
 */
export function holdReasons(text: string): string[] {
  const folded = foldText(text);
  const words = folded.split(/[^a-z0-9]+/).filter(Boolean);
  const wordText = words.join(' ');
  const out: string[] = [];
  for (const rule of WATCH) if (!out.includes(rule.label) && matches(rule, words, folded, wordText)) out.push(rule.label);
  if (FOR_ADULTS.test(wordText) && !FAMILY_AND_ADULTS.test(wordText)) {
    if (!out.includes('Warnhinweis')) out.push('Warnhinweis');
  }
  return out;
}

/** Text with each phrase removed (case and umlauts ignored): for a show's standing notes that would hold every episode. */
export function withoutPhrases(text: string, phrases: readonly string[] | undefined): string {
  let t = foldText(text);
  for (const p of phrases ?? []) {
    const f = foldText(p);
    if (f) t = t.split(f).join(' ');
  }
  return t;
}

/** Last path segment of a URL, decoded: the file name for the import. */
export function fileNameOf(url: string): string {
  const path = new URL(url).pathname;
  const last = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last) || 'audio.mp3';
  } catch {
    return last || 'audio.mp3';
  }
}
