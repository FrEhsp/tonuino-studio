/**
 * Names of albums and episodes as downloads and shops write them (TODO 0.5
 * #81). A video's name carries leftovers ("| HÖRSPIEL DES MONATS OKTOBER
 * [Xq7Lm2Pz9Rt]", "(Hörspiel)", "#bibiundtina"), and shops name the same
 * episode in their own way: "Bibi & Tina - Das Kürbisfest (Folge 50)" is
 * "Folge 50: Das Kürbisfest" by "Bibi und Tina" at one shop and
 * "050/Das Kürbisfest" at another. Two names are the same release when the
 * series agrees, the episode number does not differ and the words of the
 * title agree, in any order. Pure functions.
 */
import { normalizeForMatch } from '../stickers/coversearch';
import { stripDownloaderNoise } from './tidy';

/* ------------------------------------------------------------ cleaning */

/**
 * What a whole piece of a name may consist of to be a leftover, in the
 * spelling of normalizeForMatch: words that say what it is, not which.
 */
const NOISE_PIECE = new RegExp(
  '^(?:' +
    [
      // "HÖRSPIEL DES MONATS OKTOBER 2024"
      'hoerspiel des monats(?: [a-z]+)?(?: \\d{4})?',
      // "(Hörspiel)", "Hörbuch komplett", "ganzes Hörspiel", "Hörspiel für Kinder zum Einschlafen"
      '(?:(?:das|ein|ganzes|ganze|komplettes|komplette|kostenloses|gratis|neues|neue|offizielles|offizielle) )*(?:hoerspiel|hoerbuch|hoerspiele|album|folge|episode|full episode|ganze folge)(?: (?:komplett|kostenlos|gratis|in voller laenge|fuer kinder|zum einschlafen|zum anhoeren|full episode|deutsch|german))*',
      'full album|full audiobook|audiobook|album komplett|komplett|in voller laenge|deutsch|german',
      '(?:official|offizielles?) (?:audio|video|music video|lyric video|hoerspiel)',
      'lyrics?|lyric video|musikvideo|music video|audio|hq|hd|4k|remastered|remaster',
    ].join('|') +
    ')$',
);

/** A video id at the end, as "[Xq7Lm2Pz9Rt]" or "-Xq7Lm2Pz9Rt": eleven letters, as download tools add them. */
const VIDEO_ID_BRACKETS = /\s*\[[A-Za-z0-9_-]{11}\]/g;
const VIDEO_ID_TAIL = /-([A-Za-z0-9_-]{11})$/;

/** A tail of eleven letters is a video id only with digits and capitals in it; "-Weihnachten" is a word. */
function looksLikeVideoId(s: string): boolean {
  return /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

function isNoise(piece: string): boolean {
  const n = normalizeForMatch(piece);
  return !n || NOISE_PIECE.test(n);
}

/**
 * A name without what downloads add to it: downloader sites, video ids,
 * hashtags and emoji, and pieces between "|" or " - " and in brackets that
 * only say what it is ("HÖRSPIEL DES MONATS OKTOBER", "(Hörspiel)",
 * "[Full Album]"). Pieces with a name or number in them stay ("(Folge 50)").
 * Keeps the name when nothing else would be left.
 */
export function cleanDownloadName(s: string): string {
  let t = stripDownloaderNoise(s).replace(/_/g, ' ');
  t = t.replace(VIDEO_ID_BRACKETS, '');
  const tail = VIDEO_ID_TAIL.exec(t.trim());
  if (tail && looksLikeVideoId(tail[1])) t = t.trim().slice(0, -tail[0].length);
  t = t
    .replace(/\p{Extended_Pictographic}|️/gu, ' ')
    .replace(/(^|\s)#[\p{L}_][\p{L}\p{N}_]*/gu, ' ')
    // Brackets that only say what it is.
    .replace(/[([【]([^()[\]【】]*)[)\]】]/g, (all, inner: string) => (isNoise(inner) ? ' ' : all));
  const pieces = t
    .split(/\s*[|｜¦•·]+\s*|\s+[-–—]+\s+|\s+[-–—]+$|^[-–—]+\s+/)
    .map((p) => p.trim())
    .filter((p) => p && !isNoise(p));
  // "Die drei ???" keeps its space.
  const out = pieces.join(' - ').replace(/\s+/g, ' ').replace(/\s+([,.:;)\]])/g, '$1').trim();
  return out || stripDownloaderNoise(s).trim();
}

/* ------------------------------------------------------------ parts */

export interface ReleaseName {
  /** The name without download leftovers. */
  clean: string;
  /** The series or artist: given, or the part in front of "Serie - Titel". */
  series?: string;
  /** True when the series is the part in front of " - ", only a guess. */
  seriesGuessed?: boolean;
  /** "Folge 50", "050/", "(Folge 50)", "Die drei ??? 125:" */
  episode?: number;
  /** The episode's own title, without series and number. */
  title: string;
}

const EPISODE_WORD = '(?:folge|episode|fall|nr\\.?|no\\.?|nummer|band|vol\\.?|volume|ausgabe|#)';
/** "Folge 50", "(Folge 050)", "Nr. 3", "Vol. 2", "#12": a number after a word that says so. */
const EPISODE_AFTER_WORD = new RegExp(`(^|[\\s([,:/-])${EPISODE_WORD}\\s*[:#.]?\\s*0*(\\d{1,4})(?=$|[\\s)\\],:./-])`, 'iu');
/** "050/Das Kürbisfest", "50: Das Kürbisfest", "200 - Die Rache", "1. Hexen gibt es doch" */
const EPISODE_IN_FRONT = /^0*(\d{1,3})\s*(?:[/:.)]|[-–—]\s)\s*(?=\S)/u;
/** "Die drei ??? 125: Feuermond", "TKKG 200/Die Rache": a number with a sign after it, behind the series. */
const EPISODE_AFTER_SERIES = /^(.+?)\s+0*(\d{1,3})\s*[/:]\s*(\S.*)$/u;
/** Lone numbers of a name (not years): "Die drei ??? 125 Feuermond". */
const NUMBER = /(?:^|[^\p{L}\p{N}])0*(\d{1,3})(?![\p{N}])/gu;

/** Splits a name into series, episode number and title, from any of the ways downloads and shops write them. */
export function parseReleaseName(name: string, artist?: string): ReleaseName {
  const clean = cleanDownloadName(name);
  let series = artist?.trim() ? cleanDownloadName(artist) : undefined;
  let guessed = false;
  let episode: number | undefined;
  let parts = clean.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  const markerOnly = (p: string) => {
    const m = new RegExp(`^(?:${EPISODE_WORD}\\s*[:#.]?\\s*)?0*(\\d{1,4})$`, 'iu').exec(p.trim());
    return m ? Number(m[1]) : undefined;
  };
  // "Folge 50 - …", "200 - …": the number in a piece of its own.
  for (let i = 0; i < parts.length && parts.length > 1; i++) {
    const n = markerOnly(parts[i]);
    if (n !== undefined) {
      episode ??= n;
      parts.splice(i, 1);
      i--;
    }
  }
  if (series && parts.length > 1 && ` ${normalizeForMatch(parts[0])} `.includes(` ${normalizeForMatch(series)} `)) {
    // "Meine Freundin Conni - Conni geht zum Zahnarzt" by "Conni": the series in full.
    series = parts[0];
    parts = parts.slice(1);
  } else if (!series && parts.length > 1) {
    series = parts[0];
    guessed = true;
    parts = parts.slice(1);
  }
  let title = parts.join(' - ');
  const word = EPISODE_AFTER_WORD.exec(title);
  if (word) {
    episode ??= Number(word[2]);
    const before = title.slice(0, word.index).trim();
    if (!series && word[1] !== '(' && before && word.index + word[0].length >= title.trimEnd().length) {
      // "Die drei ??? Folge 125": the number at the end, the series in front of it, no title.
      series = before;
      guessed = true;
      title = '';
    } else title = title.slice(0, word.index) + word[1] + title.slice(word.index + word[0].length);
  } else {
    const front = EPISODE_IN_FRONT.exec(title);
    if (front && front[0].length < title.length) {
      episode ??= Number(front[1]);
      title = title.slice(front[0].length);
    } else {
      const after = EPISODE_AFTER_SERIES.exec(title);
      if (after) {
        episode ??= Number(after[2]);
        if (!series) {
          series = after[1];
          guessed = true;
          title = after[3];
        } else title = `${after[1]} ${after[3]}`;
      }
    }
  }
  // A number in the series part: "Bibi Blocksberg Folge 3 - Die Zauberhexe".
  if (episode === undefined && series && guessed) {
    const inSeries = EPISODE_AFTER_WORD.exec(series);
    if (inSeries) {
      episode = Number(inSeries[2]);
      series = (series.slice(0, inSeries.index) + inSeries[1] + series.slice(inSeries.index + inSeries[0].length)).trim() || undefined;
    }
  }
  title = title
    .replace(/[([]\s*[)\]]/g, ' ')
    .replace(/^[\s,:;./|–—-]+|[\s,:;/|–—-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { clean, series: series?.trim() || undefined, seriesGuessed: guessed || undefined, episode, title };
}

/** What to type into a shop's search for a name: series and title, without number and leftovers. */
export function releaseSearchText(name: string, artist?: string): string {
  const p = parseReleaseName(name, artist);
  const title = p.title || (p.episode !== undefined ? `Folge ${p.episode}` : '');
  return [p.series, title]
    .filter(Boolean)
    .join(' ')
    .replace(/[&+|#[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------ comparing */

const STOP = new Set([
  'die', 'der', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'und', 'the', 'a', 'an', 'of', 'and', 'von', 'vom', 'im', 'in', 'mit',
  'zum', 'zur', 'am', 'cd', 'teil', 'folge', 'folgen', 'episode', 'fall', 'band', 'nr', 'nummer', 'no', 'vol', 'volume', 'ausgabe',
]);
/** Words of an edition or a kind, not of a name: "(Neu)", "(Musik-Hörspiel)", "ungekürzt". */
const EDITION = new Set([
  'neu', 'neuaufnahme', 'neuauflage', 'neuausgabe', 'remastered', 'remaster', 'original', 'originale', 'gekuerzt', 'ungekuerzt', 'lesung',
  'komplett', 'hoerspiel', 'hoerspiele', 'hoerbuch', 'musik', 'musikhoerspiel', 'audio', 'album', 'edition', 'version', 'fassung',
]);

function words(s: string | undefined): string[] {
  return [...new Set(normalizeForMatch(s ?? '').split(' '))].filter((w) => w && !STOP.has(w) && !EDITION.has(w) && !/^\d+$/.test(w));
}

/** 1 for the same word, 0.6 for a clear part of a word ("Schlossgespenst" in "Schlossgespensterkrieg"), else 0. */
function wordMatch(w: string, among: readonly string[]): number {
  if (among.includes(w)) return 1;
  if (w.length >= 5 && among.some((t) => t.length >= 5 && (t.includes(w) || w.includes(t)))) return 0.6;
  return 0;
}

function coverage(needles: readonly string[], haystack: readonly string[]): number {
  return needles.length ? needles.reduce((s, w) => s + wordMatch(w, haystack), 0) / needles.length : 0;
}

/** Lone numbers of a name, without years; "5 Freunde" is a name, not a number. */
function numbersIn(s: string): number[] {
  const out: number[] = [];
  for (const m of normalizeForMatch(s).matchAll(NUMBER)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The episode numbers of both names: the same, in conflict, or not to be told. */
function episodesOf(ours: ReleaseName, theirs: ReleaseName): 'same' | 'clash' | 'unknown' {
  const a = ours.episode;
  const b = theirs.episode;
  if (a !== undefined && b !== undefined) return a === b ? 'same' : 'clash';
  const na = numbersIn(ours.clean);
  const nb = numbersIn(theirs.clean);
  if (b !== undefined) return na.includes(b) ? 'same' : na.length ? 'clash' : 'unknown';
  if (a !== undefined) return nb.includes(a) ? 'same' : nb.length ? 'clash' : 'unknown';
  return na.length && nb.length && !na.some((n) => nb.includes(n)) ? 'clash' : 'unknown';
}

export interface ReleaseMatch {
  /** The same release, as far as the names tell. */
  same: boolean;
  /** Sure of it: the episode number agrees, or the title word for word. A file a little longer or shorter may still be it. */
  strong: boolean;
}

const NO_MATCH: ReleaseMatch = { same: false, strong: false };

/**
 * Whether two names are the same release, in any order and spelling of
 * series, number and title. `ours` is a file's or folder's name, `theirs` a
 * shop's album and artist.
 */
export function compareRelease(ours: { album: string; artist?: string }, theirs: { album: string; artist?: string }): ReleaseMatch {
  const po = parseReleaseName(ours.album, ours.artist);
  const pt = parseReleaseName(theirs.album, theirs.artist);
  if (!normalizeForMatch(po.clean) || !normalizeForMatch(pt.clean)) return NO_MATCH;
  const episodes = episodesOf(po, pt);
  if (episodes === 'clash') return NO_MATCH;
  const allO = words(`${po.clean} ${ours.artist ?? ''}`);
  const allT = words(`${pt.clean} ${theirs.artist ?? ''}`);
  const so = words(po.series);
  const st = words(pt.series);
  // "Die drei ???" is not "Die drei !!!", "Bibi Blocksberg" not "Bibi & Tina": one side's series in the other's name.
  if (so.length && st.length && !(coverage(so, allT) > 0.5 || coverage(st, allO) > 0.5)) return NO_MATCH;
  let best = NO_MATCH;
  const titleO = words(po.title);
  const titleT = words(pt.title);
  // With our series as guessed ("Serie - Titel"), and without (the name may be "Titel - Serie").
  for (const ourSeries of po.series ? [so, []] : [[]]) {
    const series = new Set([...ourSeries, ...st]);
    const o = [...new Set([...titleO, ...(ourSeries.length ? [] : so)])].filter((w) => !series.has(w));
    const t = [...new Set([...titleT, ...st])].filter((w) => !series.has(w) && !ourSeries.includes(w));
    const m = judge(o, t, episodes);
    if (m.strong) return m;
    if (m.same) best = m;
  }
  return best;
}

function judge(o: readonly string[], t: readonly string[], episodes: 'same' | 'unknown'): ReleaseMatch {
  if (!o.length || !t.length) {
    // "Die drei ??? Folge 125" for "Folge 125: Feuermond": only the number tells.
    return episodes === 'same' ? { same: true, strong: true } : NO_MATCH;
  }
  const a = coverage(o, t);
  const b = coverage(t, o);
  const low = Math.min(a, b);
  if (episodes === 'same') return Math.max(a, b) >= 0.5 ? { same: true, strong: true } : NO_MATCH;
  if (low >= 0.6) return { same: true, strong: low >= 0.85 };
  return NO_MATCH;
}
