/**
 * The quality filter of the daily build: no junk reaches the list, even from
 * a good source. Trailers, teasers and announcements, snippets, files with
 * a very low bit rate. A person can still release a title by its key in
 * sources/released.json; that always wins.
 *
 * - reject: left out and listed under "Abgelehnt" in the report.
 * - hold: waits for a person like the other hold rules.
 * - sparse: listed; a source with many such titles ranks lower (qualityTier
 *   in filter.ts). The order of titles inside a source stays.
 */
import { foldText } from './text';
import type { Category } from './types';

/** Shortest length per kind, in seconds: shorter Hörspiele and Hörbücher are snippets, shorter songs are jingles. */
export const MIN_SECONDS: Readonly<Record<Category, number>> = { hoerspiel: 180, hoerbuch: 180, lied: 45, wissen: 180 };

/** Lowest estimated bit rate in kbit/s; below it speech sounds dull on the box's small speaker. */
export const MIN_KBPS = 48;

/**
 * Below this many bytes a feed's file size is a placeholder ("length=1"),
 * not the size of the file: no bit rate is estimated from it.
 */
export const MIN_PLAUSIBLE_BYTES = 100_000;

/** Only the start of a description is read for promo words: a trailer says so first, normal show notes mention a "Vorschau" later. */
export const PROMO_TEXT_CHARS = 160;

/** Words that mark a trailer, teaser, preview or announcement; matched inside words ("Staffeltrailer", "Wochenvorschau"). */
export const PROMO_WORDS: readonly string[] = ['trailer', 'teaser', 'vorschau', 'ankuendigung', 'hoerprobe', 'programmhinweis'];
/** Phrases with the same meaning (folded text). */
export const PROMO_PHRASES: readonly string[] = ['in eigener sache'];

export type QualityCode = 'promo' | 'promoText' | 'short' | 'lowBitrate' | 'sparse';

/** Counts per reason, for the run report. */
export type QualityCounts = Record<QualityCode, number>;

export function emptyQualityCounts(): QualityCounts {
  return { promo: 0, promoText: 0, short: 0, lowBitrate: 0, sparse: 0 };
}

/** The promo word or phrase in a text, folded; undefined when there is none. */
export function promoWord(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const folded = foldText(text);
  const words = folded.split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    const hit = PROMO_WORDS.find((p) => w.includes(p));
    if (hit) return hit;
  }
  const wordText = ` ${words.join(' ')} `;
  return PROMO_PHRASES.find((p) => wordText.includes(` ${p} `));
}

/** The shortest length for a kind; a source may set a lower one (bedtime stories may be short), never a higher one. */
export function minSecondsFor(category: Category, sourceMin?: number): number {
  const standard = MIN_SECONDS[category];
  return sourceMin !== undefined && sourceMin < standard ? sourceMin : standard;
}

/** Estimated bit rate in kbit/s from size and length; undefined when either is unknown or the size is a placeholder. */
export function estimatedKbps(size: number | undefined, durationSec: number | undefined): number | undefined {
  if (!size || !durationSec || size < MIN_PLAUSIBLE_BYTES || durationSec <= 0) return undefined;
  return (size * 8) / durationSec / 1000;
}

export interface QualityInput {
  /** The title as published. */
  title: string;
  /** What the publisher wrote about it (plain text), without the title. */
  about?: string;
  /** itunes:episodeType: "full", "trailer" or "bonus". */
  episodeType?: string;
  category: Category;
  durationSec?: number;
  size?: number;
  /** The source's own minSeconds. */
  minSeconds?: number;
}

export interface QualityFinding {
  code: QualityCode;
  /** For the report, in the editors' words. */
  reason: string;
}

export interface QualityVerdict {
  /** Left out (unless a person released it). */
  reject?: QualityFinding;
  /** Wait for a person. */
  holds: QualityFinding[];
  /** Nothing written about it besides the title. */
  sparse: boolean;
}

/**
 * A length for the report: "45 Sekunden", "1 Minute", "3 Minuten", "2:59 Minuten",
 * "12,5 Minuten". Below ten minutes in whole seconds, so a title just under
 * the limit never reads like the limit itself.
 */
export function lengthText(sec: number): string {
  const s = Math.floor(sec);
  if (s < 60) return `${s} Sekunden`;
  if (s < 600) return s % 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} Minuten` : s === 60 ? '1 Minute' : `${s / 60} Minuten`;
  return `${Math.round((sec / 60) * 10) / 10} Minuten`.replace('.', ',');
}

/** The quality verdict for one item. */
export function checkQuality(q: QualityInput): QualityVerdict {
  const holds: QualityFinding[] = [];
  const about = (q.about ?? '').trim();
  const sparse = !about || foldText(about) === foldText(q.title);
  let reject: QualityFinding | undefined;
  const titleWord = promoWord(q.title);
  if (q.episodeType && /^trailer$/i.test(q.episodeType.trim())) reject = { code: 'promo', reason: 'Der Anbieter markiert die Folge als Trailer' };
  else if (titleWord) reject = { code: 'promo', reason: `Trailer, Vorschau oder Ankündigung („${titleWord}“ im Titel)` };
  const min = minSecondsFor(q.category, q.minSeconds);
  if (!reject && q.durationSec !== undefined && q.durationSec < min) {
    reject = { code: 'short', reason: `Zu kurz: ${lengthText(q.durationSec)} (mindestens ${lengthText(min)})` };
  }
  if (!sparse) {
    const word = promoWord(about.slice(0, PROMO_TEXT_CHARS));
    if (word) holds.push({ code: 'promoText', reason: `Vielleicht Trailer oder Ankündigung („${word}“ in der Beschreibung)` });
  }
  const kbps = estimatedKbps(q.size, q.durationSec);
  if (kbps !== undefined && kbps < MIN_KBPS) holds.push({ code: 'lowBitrate', reason: `Geringe Tonqualität: etwa ${Math.round(kbps)} kbit/s (Datei anhören)` });
  return { reject, holds, sparse };
}
