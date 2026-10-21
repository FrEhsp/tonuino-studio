/**
 * "Worum geht es?": one or two sentences about a title or a source, taken
 * from what the source itself publishes (the feed's description, the meta
 * description of a title page). Nothing is written
 * here: the text is shortened at a sentence end, never reworded. Texts that
 * are no description (credits, links, a bare list of names) or not German
 * are left out; then the app shows nothing rather than something made up.
 */
import { foldText, plainText } from './text';

/** Longest description the list carries; longer texts end after their first sentences. */
export const ABOUT_MAX = 240;
/** A sentence needs at least this many words to count as a description. */
const MIN_WORDS = 6;

const GERMAN = new Set(['der', 'die', 'das', 'und', 'ist', 'ein', 'eine', 'einen', 'nicht', 'mit', 'sich', 'auf', 'den', 'dem', 'des', 'von', 'zu', 'sie', 'er', 'es', 'im', 'wird', 'wie', 'was', 'auch', 'aus', 'fuer', 'ihr', 'ihre', 'sein', 'seine', 'doch', 'nach', 'bei', 'wenn', 'aber', 'oder', 'hat', 'haben', 'kann', 'will', 'muss']);
const ENGLISH = new Set(['the', 'and', 'is', 'of', 'to', 'in', 'a', 'an', 'his', 'her', 'with', 'this', 'that', 'for', 'was', 'are', 'by', 'from', 'it', 'he', 'she', 'they', 'who', 'which', 'on', 'be', 'has', 'have']);

/** Whether a text reads as German: more German than English function words, and some of them. */
export function looksGerman(text: string): boolean {
  const words = foldText(text).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  let de = 0;
  let en = 0;
  for (const w of words) {
    if (GERMAN.has(w)) de++;
    else if (ENGLISH.has(w)) en++;
  }
  return de >= 2 && de > en * 1.5;
}

/** Sentences of a plain text: split after . ! ? or … before a capital letter, a quote or a digit. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…]["“”»«']?)\s+(?=["„“»«']?[A-ZÄÖÜ0-9])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A sentence that describes something, not credits ("Anna Böhm www.kakadu.de, Kakadu") or a link. */
function describes(s: string): boolean {
  if (/https?:\/\/|www\.|@[a-z0-9-]+\.[a-z]/i.test(s)) return false;
  if (!/[.!?…]["“”»«']?$/u.test(s)) return false;
  return s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= MIN_WORDS;
}

/**
 * The first one or two describing sentences of a source's text, at most
 * `max` characters, or undefined. A first sentence longer than `max` is cut
 * at a word and ends with "…". `title`: a text that only repeats the title
 * is no description.
 */
export function shortAbout(raw: string | undefined, opts: { max?: number; title?: string } = {}): string | undefined {
  const max = opts.max ?? ABOUT_MAX;
  const text = plainText(raw);
  if (!text) return undefined;
  if (opts.title && foldText(text) === foldText(opts.title)) return undefined;
  const usable = sentences(text).filter(describes);
  if (!usable.length || !looksGerman(usable.join(' '))) return undefined;
  const first = usable[0];
  if (first.length > max) {
    const cut = first.slice(0, max - 1);
    const end = cut.lastIndexOf(' ');
    return `${(end > max / 2 ? cut.slice(0, end) : cut).replace(/[\s,;:–-]+$/u, '')}…`;
  }
  const second = usable[1];
  return second && first.length + 1 + second.length <= max ? `${first} ${second}` : first;
}
