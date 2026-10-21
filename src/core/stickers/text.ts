/**
 * Fitting text into a box: word wrap, shrink to fit, balanced lines, and as
 * a last resort hyphenated breaks and an ellipsis. Pure functions; the width
 * of a string comes from a `measure` callback (canvas measureText in the app,
 * a fixed advance per character in tests).
 */

/** Width of `text` at font size `size`, in the same unit as the sizes (mm in the sticker renderer). */
export type Measure = (text: string, size: number) => number;

export interface FitOptions {
  maxWidth: number;
  maxHeight: number;
  maxLines: number;
  /** Largest and smallest font size to try. */
  maxSize: number;
  minSize: number;
  /** Line distance as a factor of the font size. Default 1.15. */
  lineHeight?: number;
  /** Size step while shrinking. Default 2 % of maxSize. */
  step?: number;
  /** Even out line lengths (no single word on the last line). Default true. */
  balance?: boolean;
  /** How much larger hyphenated text must come out to be chosen over whole words. Default 1.18 (1.35 for a single word). */
  hyphenGain?: number;
}

export interface FittedText {
  size: number;
  lines: string[];
  /** Text was cut and ends with "…". */
  truncated: boolean;
  /** Width of the widest line and height of the block (lines × size × lineHeight). */
  width: number;
  height: number;
  lineHeight: number;
}

interface Token {
  text: string;
  /** A space follows this token (false inside "Kinder-|Lieder"). */
  space: boolean;
}

const ELLIPSIS = '…';

/**
 * Splits into words, and after hyphens and slashes inside words, so lines may break there. A lone dash or
 * middle dot sticks to the word before it; a no-break space (U+00A0) never breaks: "16 Titel" stays whole.
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const words = text.trim().split(/[^\S\u00a0]+/).filter(Boolean);
  words.forEach((word, wi) => {
    // A dash between words stays at the end of the line before: "Bibi Blocksberg –|Hexen gibt es doch", never a line starting with "–".
    const prev = out[out.length - 1];
    if (/^[-–—·]$/u.test(word) && prev?.space) {
      prev.text += ` ${word}`;
      prev.space = wi < words.length - 1;
      return;
    }
    const parts = word.split(/(?<=[-–/])(?=\S)/u);
    parts.forEach((p, pi) => out.push({ text: p, space: pi === parts.length - 1 && wi < words.length - 1 }));
  });
  return out;
}

function joinTokens(tokens: Token[]): string {
  let s = '';
  tokens.forEach((t, i) => {
    s += t.text;
    if (t.space && i < tokens.length - 1) s += ' ';
  });
  return s;
}

/**
 * How words that are wider than a line are handled: refused ("none"), split
 * at syllables ("syllables", German-style rules, see hyphenPoints) or split
 * anywhere ("chars", the last resort).
 */
export type BreakMode = 'none' | 'syllables' | 'chars';

/**
 * Greedy word wrap. Returns null when a token is wider than maxWidth and the
 * mode cannot split it.
 */
export function wrap(tokens: Token[], size: number, maxWidth: number, measure: Measure, mode: BreakMode | boolean = 'none'): string[] | null {
  const m: BreakMode = mode === true ? 'chars' : mode === false ? 'none' : mode;
  const lines: string[] = [];
  let current: Token[] = [];
  const width = (ts: Token[]) => measure(joinTokens(ts), size);
  const split = (tok: Token): boolean => {
    const pieces = m === 'syllables' ? breakAtSyllables(tok.text, size, maxWidth, measure) : m === 'chars' ? breakWord(tok.text, size, maxWidth, measure) : null;
    if (!pieces) return false;
    lines.push(...pieces.slice(0, -1));
    current = [{ text: pieces[pieces.length - 1], space: tok.space }];
    return true;
  };
  for (const tok of tokens) {
    const candidate = [...current, tok];
    if (current.length && width(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length) lines.push(joinTokens(current));
    current = [];
    if (measure(tok.text, size) > maxWidth) {
      if (!split(tok)) return null;
    } else {
      current = [tok];
    }
  }
  if (current.length) lines.push(joinTokens(current));
  return lines;
}

const VOWEL = /[aeiouyäöüàáâèéêìíîòóôùúû]/i;
const UNITS = ['sch', 'ch', 'ck', 'ph', 'th', 'qu'];
/** Two consonants that begin a syllable together ("Hot-zen-plotz", "Elek-tro"). */
const ONSETS = ['bl', 'fl', 'gl', 'kl', 'pl', 'br', 'dr', 'fr', 'gr', 'kr', 'pr', 'tr'];
/** Letters that begin a syllable together with "sch" before them ("schw", "schl", "schm", "schn", "schr"). */
const SCH_ONSETS = ['w', 'l', 'm', 'n', 'r'];

/**
 * Positions inside a word where it may be hyphenated, by simple German
 * syllable rules: between vowel groups one consonant (or a sound written
 * with several letters: sch, ch, ck, ph, th) starts the next syllable;
 * "sch", "st"/"sp" and a consonant with l or r ("pl", "tr") after another
 * consonant stay together. No dictionary,
 * so compound words are not always split at the seam, but every split is
 * pronounceable: "Weih-nachts-ge-schich-ten", "Pi-ra-ten-schatz".
 * Never leaves fewer than two letters at either end.
 */
export function hyphenPoints(word: string): number[] {
  const chars = [...word];
  const isLetter = (c: string) => /\p{L}/u.test(c);
  if (chars.length < 4 || !chars.every(isLetter)) return [];
  const isVowel = (i: number) => VOWEL.test(chars[i]);
  const points: number[] = [];
  let i = 0;
  // Skip the leading consonants and the first vowel group.
  while (i < chars.length && !isVowel(i)) i++;
  while (i < chars.length && isVowel(i)) i++;
  while (i < chars.length) {
    const start = i;
    while (i < chars.length && !isVowel(i)) i++;
    if (i >= chars.length) break; // trailing consonants: no syllable follows
    // Consonant cluster chars[start..i) between two vowel groups, in units.
    const units: { at: number; text: string }[] = [];
    let j = start;
    while (j < i) {
      const rest = chars.slice(j, i).join('').toLowerCase();
      const unit = UNITS.find((u) => rest.startsWith(u)) ?? rest[0];
      units.push({ at: j, text: unit });
      j += unit.length;
    }
    let cut = units[units.length - 1].at;
    const schIndex = units.findIndex((u, n) => n > 0 && u.text === 'sch');
    // "sch" before a consonant that cannot follow it at a syllable's start ends its syllable:
    // "Kirsch-baum", "Hirsch-kä-fer", not "Kir-schbaum"; "ver-schwun-de-ne" and "Stern-schnup-pe" stay.
    const after = units[schIndex + 1]?.text;
    if (schIndex > 0) cut = after && !SCH_ONSETS.includes(after) ? units[schIndex + 1].at : units[schIndex].at;
    else if (units.length >= 3) {
      const [a, b] = units.slice(-2).map((u) => u.text);
      const before = units[units.length - 3].text;
      if (a === 's' && (b === 't' || b === 'p')) cut = units[units.length - 2].at;
      // A consonant with l or r starts a syllable together: "Hot-zen-plotz", "Ost-fries-land", not "Hot-zenp-lotz".
      // After n, "gl" and "gr" stay apart: "Eng-län-der", "hung-rig".
      else if (ONSETS.includes(a + b) && !(a === 'g' && before === 'n')) cut = units[units.length - 2].at;
    }
    if (cut >= 2 && chars.length - cut >= 2) points.push(cut);
    while (i < chars.length && isVowel(i)) i++;
  }
  return points;
}

/**
 * Text for a narrow place laid out by the browser (the name on a card in the
 * shelf): long words get soft hyphens at their syllables, so a line breaks
 * as "Lumpen-konzert" instead of the word being cut off. The browser shows a
 * hyphen only where it breaks; without dictionaries of its own (WebKitGTK,
 * Android) it would not hyphenate German at all. Only long words: a shorter
 * one moves to the next line whole, which reads better than a break. At
 * least three letters stay on each side.
 */
export function softHyphens(text: string, minLength = 12): string {
  return text.replace(/\p{L}+/gu, (word) => {
    if ([...word].length < minLength) return word;
    const chars = [...word];
    const points = hyphenPoints(word).filter((p) => p >= 3 && chars.length - p >= 3);
    let out = '';
    let last = 0;
    for (const p of points) {
      out += chars.slice(last, p).join('') + '\u00ad';
      last = p;
    }
    return out + chars.slice(last).join('');
  });
}

/** Letters a hyphenated word should keep on its next line: "Urlaubs-lieder", not "Urlaubslie-der". */
const MIN_REST = 4;

/**
 * Splits a long word at syllables so every piece but the last fits with its
 * "-"; null if a syllable alone is too wide. Leaves at least MIN_REST letters
 * for the next line where it can, and when the rest fits on one line, takes
 * the break that makes both lines most even.
 */
function breakAtSyllables(word: string, size: number, maxWidth: number, measure: Measure): string[] | null {
  const chars = [...word];
  const points = hyphenPoints(word);
  const pieces: string[] = [];
  let start = 0;
  while (measure(chars.slice(start).join(''), size) > maxWidth) {
    const fitting = points.filter((p) => p > start && measure(chars.slice(start, p).join('') + '-', size) <= maxWidth);
    if (!fitting.length) return null;
    const roomy = fitting.filter((p) => chars.length - p >= MIN_REST);
    const choice = roomy.length ? roomy : fitting;
    const width = (from: number, to?: number) => measure(chars.slice(from, to).join(''), size);
    const last = choice.filter((p) => width(p) <= maxWidth);
    const end = last.length
      ? last.reduce((best, p) => (Math.abs(width(start, p) - width(p)) < Math.abs(width(start, best) - width(best)) ? p : best))
      : choice[choice.length - 1];
    pieces.push(chars.slice(start, end).join('') + '-');
    start = end;
  }
  pieces.push(chars.slice(start).join(''));
  return pieces;
}

/** Splits a word that is too long for one line into pieces ending with "-". */
function breakWord(word: string, size: number, maxWidth: number, measure: Measure): string[] {
  const chars = [...word];
  const pieces: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    if (measure(chars.slice(start).join(''), size) > maxWidth) {
      end = start + 1;
      while (end < chars.length && measure(chars.slice(start, end + 1).join('') + '-', size) <= maxWidth) end++;
      // Keep at least two letters on the next line ("Geschich-ten", not "Geschicht-e").
      if (chars.length - end === 1 && end - start > 2) end--;
    }
    const piece = chars.slice(start, end).join('');
    pieces.push(end < chars.length ? piece + '-' : piece);
    start = end;
  }
  return pieces;
}

/**
 * Largest size between maxSize and minSize at which the text fits into
 * maxLines lines of maxWidth and into maxHeight. Long words are hyphenated at
 * syllables when that allows a clearly larger size than shrinking alone; if
 * even minSize does not fit, words are split anywhere and the last line gets
 * an ellipsis.
 */
export function fitText(text: string, measure: Measure, o: FitOptions): FittedText {
  const lh = o.lineHeight ?? 1.15;
  const tokens = tokenize(text);
  const minSize = Math.min(o.minSize, o.maxSize);
  const empty: FittedText = { size: o.maxSize, lines: [], truncated: false, width: 0, height: 0, lineHeight: lh };
  if (!tokens.length || o.maxWidth <= 0 || o.maxLines < 1) return empty;
  const step = o.step ?? Math.max(o.maxSize * 0.02, 1e-3);
  const linesFor = (size: number) => Math.min(o.maxLines, Math.floor(o.maxHeight / (size * lh) + 1e-9));

  const search = (mode: BreakMode): { size: number; lines: string[] } | null => {
    for (let size = o.maxSize; size >= minSize - 1e-9; size -= step) {
      const max = linesFor(size);
      if (max < 1) continue;
      const lines = wrap(tokens, size, o.maxWidth, measure, mode);
      if (lines && lines.length <= max) return { size, lines };
    }
    return null;
  };

  const plain = search('none');
  // Hyphenation only when it buys a clearly larger size (or is the only way to fit).
  const hyphenated = !plain || plain.size < o.maxSize * 0.999 ? search('syllables') : null;
  // A title of one word is easier to read whole, so it is split only for a much larger size.
  const gain = Math.max(o.hyphenGain ?? 1.18, tokens.length === 1 ? 1.35 : 1.18);
  if (hyphenated && (!plain || hyphenated.size > plain.size * gain)) {
    return finish(hyphenated.lines, hyphenated.size, lh, measure, false);
  }
  if (plain) {
    const balanced = o.balance === false ? plain.lines : (balance(tokens, plain.size, o.maxWidth, plain.lines.length, measure) ?? plain.lines);
    return finish(balanced, plain.size, lh, measure, false);
  }

  // Last resort at the smallest size: split anywhere, then cut.
  const size = minSize;
  const max = Math.max(1, linesFor(size));
  const lines = wrap(tokens, size, o.maxWidth, measure, 'syllables') ?? wrap(tokens, size, o.maxWidth, measure, 'chars') ?? [joinTokens(tokens)];
  if (lines.length <= max) return finish(lines, size, lh, measure, false);
  const kept = lines.slice(0, max);
  kept[max - 1] = ellipsize(kept[max - 1], size, o.maxWidth, measure);
  return finish(kept, size, lh, measure, true);
}

/** Narrowest width that still gives the same number of lines, so lines come out evenly long. */
function balance(tokens: Token[], size: number, maxWidth: number, count: number, measure: Measure): string[] | null {
  if (count < 2) return null;
  let lo = maxWidth * 0.4;
  let hi = maxWidth;
  let best: string[] | null = null;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const lines = wrap(tokens, size, mid, measure);
    if (lines && lines.length <= count) {
      best = lines;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return best;
}

/** Cuts a line so that it fits with a trailing "…", preferably at a word boundary. */
export function ellipsize(line: string, size: number, maxWidth: number, measure: Measure): string {
  const base = line.replace(/-$/, '');
  if (measure(base + ELLIPSIS, size) <= maxWidth) return base + ELLIPSIS;
  const chars = [...base];
  let n = chars.length;
  while (n > 0 && measure(chars.slice(0, n).join('').trimEnd() + ELLIPSIS, size) > maxWidth) n--;
  let cut = chars.slice(0, n).join('');
  const space = cut.lastIndexOf(' ');
  if (space > cut.length * 0.6) cut = cut.slice(0, space);
  return cut.trimEnd().replace(/[-–,;:]$/, '') + ELLIPSIS;
}

function finish(lines: string[], size: number, lh: number, measure: Measure, truncated: boolean): FittedText {
  const width = Math.max(0, ...lines.map((l) => measure(l, size)));
  return { size, lines, truncated, width, height: lines.length * size * lh, lineHeight: lh };
}

/** Largest size (≤ maxSize) at which a single line fits into maxWidth; at least minSize. */
export function fitLine(text: string, measure: Measure, maxWidth: number, maxSize: number, minSize = 0): number {
  if (!text) return maxSize;
  const w = measure(text, maxSize);
  if (w <= maxWidth || w <= 0) return maxSize;
  return Math.max(minSize, (maxSize * maxWidth) / w);
}
