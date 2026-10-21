/**
 * How picked items from "Entdecken" become files for the normal add flow:
 * the order, the album and title hints that decide how the files are grouped
 * into folders, the path they show up under, and how files a family saved
 * from a publisher's page are recognised again.
 */
import { LONG_TRACK_SEC, SPLIT_TOLERANCE } from '../library/grouping';
import type { TrackInfo } from '../library/tags';
import { MAX_TRACKS } from '../tonuino/sd';
import { filesInOrder, storyPart, type StoryPart } from './filter';
import { normalizeSearch } from './text';
import type { IndexEntry, IndexItem, MediaFile } from './types';

/** One card for all picked items, or one card per item. */
export type CardMode = 'all' | 'each';

/** Below this average length the picked items share one card by default. */
export const ONE_CARD_BELOW_SEC = 15 * 60;
/** From here the app asks before loading. */
export const BIG_DOWNLOAD_BYTES = 1024 ** 3;
/** More than this is refused: memory, and the SD card. */
export const MAX_DOWNLOAD_BYTES = 3 * 1024 ** 3;
/** Rough bytes per second when the list knows only the length (128 kbit/s). */
const BYTES_PER_SEC = 16_000;

/** The length of an item, or a guess from its size. */
function roughSeconds(item: IndexItem): number | undefined {
  return item.durationSec || (item.size ? item.size / BYTES_PER_SEC : undefined);
}

/** Short pieces (stories, songs) share a card; long episodes get one each. Unknown lengths: one each. */
export function defaultCardMode(items: readonly IndexItem[]): CardMode {
  const known = items.map(roughSeconds);
  if (!known.length || known.some((d) => !d)) return 'each';
  return (known as number[]).reduce((a, b) => a + b, 0) / known.length < ONE_CARD_BELOW_SEC ? 'all' : 'each';
}

/** Albums always become one card of their own, whatever is picked. */
export function isWholeWork(entry: Pick<IndexEntry, 'type'>): boolean {
  return entry.type === 'archive-album';
}

/** A file and the item it belongs to. */
export interface PickedFile {
  item: IndexItem;
  file: MediaFile;
}

export interface PlannedFile extends PickedFile {
  /** Where the file shows up in the import, e.g. "Entdecken/Radio Klops/Folge 7/x.mp3" (a book named like its source: "Entdecken/Heidi/x.mp3"). */
  relativePath: string;
  /** Facts that win over the file's own tags: titles, album, order. */
  hint: Partial<TrackInfo>;
}

/** Characters that do not belong into a path segment. */
export function safeName(s: string): string {
  const t = s.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (t.length > 80 ? t.slice(0, 80).trim() : t) || '_';
}

function published(item: IndexItem): number {
  const t = item.published ? Date.parse(item.published.length === 4 ? `${item.published}-01-01` : item.published) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** Podcasts play from the oldest picked episode to the newest; everything else in the list's order. */
export function playingOrder(entry: Pick<IndexEntry, 'type'>, items: readonly IndexItem[]): IndexItem[] {
  if (entry.type !== 'podcast') return [...items];
  const indexed = items.map((item, i) => ({ item, i, t: published(item) }));
  return indexed
    .sort((a, b) => {
      if (Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t) return a.t - b.t;
      return b.i - a.i; // the list is newest first
    })
    .map((x) => x.item);
}

/** The files of the picked items, in playing order. */
export function picksOf(entry: Pick<IndexEntry, 'type'>, items: readonly IndexItem[]): PickedFile[] {
  return playingOrder(entry, items).flatMap((item) => [...item.files].sort((a, b) => (a.track ?? 0) - (b.track ?? 0)).map((file) => ({ item, file })));
}

export { storyPart, type StoryPart } from './filter';

/** Picked items that are parts of one story (at least two of them), by item key: the story's folder. */
function storiesOf(items: readonly IndexItem[]): Map<string, StoryPart> {
  const byStory = new Map<string, { s: StoryPart; key: string }[]>();
  for (const it of items) {
    const s = storyPart(it.title);
    if (!s) continue;
    const id = `${normalizeSearch(s.story)}|${s.of}`;
    byStory.set(id, [...(byStory.get(id) ?? []), { s, key: it.key }]);
  }
  const out = new Map<string, StoryPart>();
  for (const members of byStory.values()) {
    if (members.length < 2 || new Set(members.map((m) => m.s.part)).size !== members.length) continue;
    for (const m of members) out.set(m.key, m.s);
  }
  return out;
}

/** Names of the stories whose parts share a card when each gets its own ("Die Schatzinsel"). */
export function sharedStories(items: readonly IndexItem[]): string[] {
  return [...new Set([...storiesOf(items).values()].map((s) => s.story))];
}

/** Default length of the pieces a long file is cut into (settings: "Teilen", 5 minutes). */
export const SPLIT_MINUTES = 5;

/**
 * About how many titles a file becomes on the card: a long file of a source
 * that allows changes is cut into pieces (like the add flow does,
 * grouping.ts estimateTrackCount), everything else stays one title.
 */
export function titlesOnCard(file: Pick<MediaFile, 'durationSec'>, unchanged: boolean, splitMinutes = SPLIT_MINUTES): number {
  const sec = file.durationSec ?? 0;
  if (unchanged || sec <= LONG_TRACK_SEC || sec <= splitMinutes * 60 * (1 + SPLIT_TOLERANCE)) return 1;
  return Math.max(2, Math.round(sec / (splitMinutes * 60)));
}

/**
 * The card each picked item goes on when all share one card: in playing
 * order, whole items only, at most MAX_TRACKS titles per card (cut pieces
 * counted). One number per item key, from 1; more than one card only when
 * they do not fit on one.
 */
export function cardParts(entry: Pick<IndexEntry, 'editPolicy'>, picks: readonly PickedFile[], splitMinutes = SPLIT_MINUTES): Map<string, number> {
  const unchanged = entry.editPolicy === 'unchanged';
  const need = new Map<string, number>();
  for (const { item, file } of picks) need.set(item.key, (need.get(item.key) ?? 0) + titlesOnCard(file, unchanged, splitMinutes));
  const out = new Map<string, number>();
  let card = 1;
  let used = 0;
  for (const [key, n] of need) {
    if (used > 0 && used + n > MAX_TRACKS) {
      card++;
      used = 0;
    }
    out.set(key, card);
    used += n;
  }
  return out;
}

/**
 * Hints and paths for picked files. Albums keep their own songs; podcasts and stories either share one card with
 * the source as album, or get a card each with the item as album.
 *
 * One card each: the parts of one story ("Die Schatzinsel (1/3)" to
 * "(3/3)") share a card, in the order of their parts. One card for all:
 * more than MAX_TRACKS titles go on several cards ("Teil 1", "Teil 2"),
 * whole episodes each (cardParts). The files keep the order of `picks`.
 */
export function planFiles(entry: IndexEntry, picks: readonly PickedFile[], mode: CardMode, opts: { splitMinutes?: number } = {}): PlannedFile[] {
  const work = isWholeWork(entry);
  const stories = !work && mode === 'each' ? storiesOf([...new Set(picks.map((p) => p.item))]) : new Map<string, StoryPart>();
  const parts = !work && mode === 'all' ? cardParts(entry, picks, opts.splitMinutes) : new Map<string, number>();
  const cards = new Set(parts.values()).size;
  // Track numbers: per story in the order of its parts; per card in playing order.
  const storyTrack = new Map<PickedFile, { no: number; of: number }>();
  const byStory = new Map<string, PickedFile[]>();
  for (const p of picks) {
    const s = stories.get(p.item.key);
    if (s) byStory.set(s.story, [...(byStory.get(s.story) ?? []), p]);
  }
  for (const members of byStory.values()) {
    const sorted = [...members].sort((a, b) => stories.get(a.item.key)!.part - stories.get(b.item.key)!.part || (a.file.track ?? 0) - (b.file.track ?? 0));
    sorted.forEach((p, i) => storyTrack.set(p, { no: i + 1, of: sorted.length }));
  }
  const onCard = new Map<number, number>();
  for (const p of picks) {
    const c = parts.get(p.item.key) ?? 1;
    onCard.set(c, (onCard.get(c) ?? 0) + 1);
  }
  const seen = new Map<number, number>();
  return picks.map((pick) => {
    const { item, file } = pick;
    const filesOfItem = item.files.length || 1;
    const k = Math.max(0, item.files.indexOf(file));
    const partTitle = file.title ?? (filesOfItem > 1 ? `${item.title} – Teil ${k + 1}` : item.title);
    let hint: Partial<TrackInfo>;
    if (entry.type === 'archive-album') {
      hint = { album: item.title, albumArtist: entry.publisher, title: file.title ?? partTitle, trackNo: file.track ?? k + 1, trackOf: filesOfItem, discNo: 1 };
    } else if (mode === 'each') {
      const story = stories.get(item.key);
      const t = storyTrack.get(pick);
      hint = story && t
        ? { album: story.story, albumArtist: entry.title, title: partTitle, trackNo: t.no, trackOf: t.of, discNo: 1 }
        : { album: item.title, albumArtist: entry.title, title: partTitle, trackNo: file.track ?? k + 1, trackOf: filesOfItem, discNo: 1 };
    } else {
      const card = parts.get(item.key) ?? 1;
      const no = (seen.get(card) ?? 0) + 1;
      seen.set(card, no);
      hint = { album: cards > 1 ? `${entry.title} (Teil ${card})` : entry.title, albumArtist: entry.publisher, title: partTitle, trackNo: no, trackOf: onCard.get(card) ?? no, discNo: 1 };
    }
    if (file.durationSec) hint.durationSec = file.durationSec;
    // An album named like its source gets its folder once, not twice.
    const story = stories.get(item.key);
    const inner = story ? safeName(story.story) : cards > 1 ? `Teil ${parts.get(item.key) ?? 1}/${safeName(item.title)}` : safeName(item.title);
    const folder = safeName(entry.title) === safeName(item.title) ? safeName(entry.title) : `${safeName(entry.title)}/${inner}`;
    return { item, file, hint, relativePath: `Entdecken/${folder}/${file.name}` };
  });
}

/** Bytes to load: sizes from the list, else estimated from the length. */
export function plannedBytes(picks: readonly PickedFile[]): number {
  return picks.reduce((sum, { file }) => sum + (file.size ?? (file.durationSec ? file.durationSec * BYTES_PER_SEC : 0)), 0);
}

export function plannedSeconds(items: readonly IndexItem[]): number | undefined {
  const d = items.map((i) => i.durationSec);
  return d.every((x): x is number => x !== undefined) ? d.reduce((a, b) => a + b, 0) : undefined;
}

/** "folge (1).mp3" → "folge.mp3": browsers add a number when the same file is saved twice. */
function comparableName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s*\(\d+\)(?=\.[^.]+$)/, '')
    .replace(/\s*\(\d+\)$/, '');
}

/**
 * Finds the item a file belongs to that the family saved from the publisher's
 * page: by its name (as in the feed or on the page), else by its exact size.
 */
export function matchDropped(entry: IndexEntry, dropped: { name: string; size: number }): PickedFile | undefined {
  const name = comparableName(dropped.name);
  for (const item of entry.items) {
    for (const file of item.files) if (comparableName(file.name) === name) return { item, file };
    if (item.fileName && comparableName(item.fileName) === name) return savedAs(item, dropped);
  }
  if (dropped.size > 0) {
    for (const item of entry.items) {
      for (const file of item.files) if (file.size === dropped.size) return { item, file };
      if (!item.files.length && item.size === dropped.size) return savedAs(item, dropped);
    }
  }
  return undefined;
}

/** A saved file that belongs to an item without files of its own (a link, an episode saved on the publisher's page). */
export function savedAs(item: IndexItem, dropped: { name: string; size: number }): PickedFile {
  return { item, file: { url: '', name: dropped.name, size: dropped.size } };
}

/** What the app reads from a saved file the list does not know by name or size. */
export interface SavedFacts {
  name: string;
  /** The title in the file's own tags (ID3). */
  title?: string;
  durationSec?: number;
}

/** Lengths in the list may differ this much from the file's. */
export const LENGTH_TOLERANCE_SEC = 3;

/** Words that say nothing about which episode a file is. */
const PLAIN_WORDS = new Set(['der', 'die', 'das', 'und', 'ein', 'eine', 'von', 'mit', 'mp3', 'm4a', 'aac', 'folge', 'teil', 'hoerspiel', 'kinderhoerspiel', 'download']);

function wordsOf(s: string): Set<string> {
  return new Set(
    normalizeSearch(s)
      .split(' ')
      .filter((w) => (w.length > 2 || /^\d+$/.test(w)) && !PLAIN_WORDS.has(w)),
  );
}

/** Something a saved file may be: an item, or for a book or album one of its files (see savedChoices). */
interface Candidate {
  title: string;
  originalTitle?: string;
  durationSec?: number;
}

/**
 * How close a candidate's length is to the file's: 1 for the same length,
 * down to just above 0 at the edge, 0 outside. ARD lists lengths in whole
 * minutes (rounded), so there a minute counts as close as well.
 */
function lengthFit(c: Candidate, sec: number | undefined): number {
  const listed = c.durationSec;
  if (!sec || !listed) return 0;
  const tolerance = listed % 60 === 0 ? 60 + LENGTH_TOLERANCE_SEC : LENGTH_TOLERANCE_SEC;
  const gap = Math.abs(listed - sec);
  return gap > tolerance ? 0 : 1 - gap / (tolerance + 1);
}

/**
 * How much the words of a candidate's title and of the file's name or title
 * tag overlap: shared words of all words. Numbers alone ("Kapitel 1") say nothing.
 */
function wordFit(c: Candidate, words: Set<string>): number {
  const own = new Set([...wordsOf(c.title), ...wordsOf(c.originalTitle ?? '')]);
  const shared = [...own].filter((w) => words.has(w));
  if (!shared.some((w) => !/^\d+$/.test(w))) return 0;
  return shared.length / (own.size + words.size - shared.length);
}

/** The clear best of the candidates for a saved file, by length and words; undefined when none stands out. */
function bestGuess<T extends Candidate>(candidates: readonly T[], facts: SavedFacts): T | undefined {
  const words = new Set([...wordsOf(facts.name.replace(/\.[^.]+$/, '')), ...wordsOf(facts.title ?? '')]);
  let best: T | undefined;
  let bestScore = 0;
  let second = 0;
  for (const c of candidates) {
    const score = lengthFit(c, facts.durationSec) + wordFit(c, words);
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = c;
    } else if (score > second) second = score;
  }
  return best && bestScore - second > 0.01 ? best : undefined;
}

/**
 * The item a saved file most likely is, for "Welche Folge ist das?": by its
 * length (from its own data) and by the words of its name and title tag. Only
 * a clear best is returned; the family confirms it in any case.
 */
export function guessSaved(entry: Pick<IndexEntry, 'items'>, facts: SavedFacts): IndexItem | undefined {
  return bestGuess(entry.items, facts);
}

/** One answer to "Welche Folge ist das?" / "Welches Lied ist das?". */
export interface SavedChoice extends Candidate {
  /** The value of the choice: the item's key, for a chapter or song `${key}#${index}`. */
  value: string;
  item: IndexItem;
  /** The chapter or song of a book or album. */
  file?: MediaFile;
}

/**
 * What a saved file can be: the items, or for a book or an album each of
 * its chapters or songs. A chapter chosen fills the gap of a failed
 * download, since it is the same file as the one missing.
 */
export function savedChoices(entry: Pick<IndexEntry, 'type' | 'items'>): SavedChoice[] {
  if (!isWholeWork(entry)) return entry.items.map((item) => ({ value: item.key, item, title: item.title, originalTitle: item.originalTitle, durationSec: item.durationSec }));
  return entry.items.flatMap((item) =>
    filesInOrder(item).map((file, i) => ({ value: `${item.key}#${i}`, item, file, title: file.title ?? `Teil ${i + 1}`, durationSec: file.durationSec })),
  );
}

/** The choice a saved file most likely is (its value), see guessSaved. */
export function guessSavedChoice(entry: Pick<IndexEntry, 'type' | 'items'>, facts: SavedFacts): string | undefined {
  return bestGuess(savedChoices(entry), facts)?.value;
}

/** The file and item for a chosen answer: the chapter itself, or the item with the saved file. */
export function pickOfChoice(choice: SavedChoice, dropped: { name: string; size: number }): PickedFile {
  return choice.file ? { item: choice.item, file: choice.file } : savedAs(choice.item, dropped);
}
