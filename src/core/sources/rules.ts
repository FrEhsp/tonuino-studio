/**
 * Fixed rules for titles that are new at a source the list already has
 * (a new episode on the show page of "Hörspielklassiker für Kinder", a new
 * book on a topic page of OHRKA). No person listens to them first, so only
 * what can be decided from the source's own data counts, and anything
 * unclear leaves the title out:
 *
 * 1. Trusted source: only series a person admitted (an active catalogue
 *    entry with `series`). Broadcasters and OHRKA produce with professional
 *    speakers; that is the "not badly read" rule. Brand-new sources never
 *    come in by themselves.
 * 2. A real episode: no trailer, announcement or extra (urn:ard:extra, the
 *    words of quality.ts), with a title.
 * 3. German: the page does not name another language.
 * 4. For children: the page states an age itself, or the page that lists it
 *    states one for all its titles (`series.pageAges`), or the catalogue
 *    sets the series' age for every title once (`series.agesFromSeries`, as
 *    every new episode of a feed gets its show's age); under 16 always,
 *    within the series' range, and from 12 on only in a series for that age.
 * 5. Long enough (quality.ts), and its length is known.
 * 6. Still there for a while: at least AVAILABLE_DAYS before `until`.
 * 7. No warning words in title and description (holdReasons: horror,
 *    violence or death, sexuality, drugs, advertising, warnings).
 *
 * A title a person released in sources/released.json passes rules 2 to 7.
 */
import { checkQuality } from './quality';
import { holdReasons } from './text';
import type { PageFacts } from './pages';
import type { AgeInfo, AgeRange, Category } from './types';

/** Titles that leave within this many days are not worth putting on a card. */
export const AVAILABLE_DAYS = 30;
/** New titles read per series and run; the rest come in the next days. */
export const MAX_NEW_PER_RUN = 20;
/** Ages from here on need a series for that age. */
const TEEN_AGE = 12;
/** Never listed (build.ts REJECT_MIN_AGE). */
const ADULT_AGE = 16;

export interface SeriesRules {
  ages: AgeInfo;
  category: Category;
  minSeconds?: number;
  /** The series' age holds for each of its titles that names none (OHRKA topic pages, knowledge shows). */
  agesFromSeries?: boolean;
}

export type Admission = { ok: true; ages?: AgeRange } | { ok: false; reasons: string[] };

const DAY_MS = 86_400_000;

/** Whether a new title from a trusted series may join the list without a person, and with which ages. */
export function admitNewTitle(facts: PageFacts, series: SeriesRules, category: Category, now: Date): Admission {
  const reasons: string[] = [];
  if (facts.kind === 'extra') reasons.push('Kein Hörspiel, sondern ein Extra (Trailer oder Ankündigung)');
  if (!facts.title) reasons.push('Die Seite nennt keinen Titel');
  if (facts.language && facts.language !== 'de') reasons.push(`Sprache der Seite: ${facts.language}`);
  // Ages: the title's own statement, else the series' when the publisher states it for every title.
  const own = facts.agesStated ? facts.ages : undefined;
  const ages: AgeRange | undefined = own ?? (series.agesFromSeries ? { min: series.ages.min, max: series.ages.max } : undefined);
  if (!ages) reasons.push('Die Seite nennt kein Alter');
  else {
    if (ages.min >= ADULT_AGE) reasons.push(`Altersangabe ab ${ages.min}`);
    else if (series.ages.max !== undefined && ages.min > series.ages.max) reasons.push(`Altersangabe (ab ${ages.min}) passt nicht zur Reihe`);
    else if (ages.min >= TEEN_AGE && ages.min > series.ages.min) reasons.push(`Altersangabe ab ${ages.min}: über der Reihe`);
  }
  if (!facts.durationSec) reasons.push('Die Seite nennt keine Länge');
  const quality = checkQuality({ title: facts.title ?? '', about: facts.description, category, durationSec: facts.durationSec, minSeconds: series.minSeconds });
  if (quality.reject) reasons.push(quality.reject.reason);
  reasons.push(...quality.holds.map((h) => h.reason));
  if (facts.until) {
    const left = (Date.parse(`${facts.until}T23:59:59Z`) - now.getTime()) / DAY_MS;
    if (!(left >= AVAILABLE_DAYS)) reasons.push(`Beim Anbieter nur noch bis ${facts.until}`);
  }
  reasons.push(...holdReasons([facts.title, facts.description].filter(Boolean).join(' \n ')));
  return reasons.length ? { ok: false, reasons } : { ok: true, ages };
}

/** The same check for a title a person released: only what the source must say anyway (a real, available episode). */
export function admitReleased(facts: PageFacts, now: Date): Admission {
  const reasons: string[] = [];
  if (!facts.title) reasons.push('Die Seite nennt keinen Titel');
  if (facts.until && Date.parse(`${facts.until}T23:59:59Z`) < now.getTime()) reasons.push(`Beim Anbieter nur bis ${facts.until}`);
  return reasons.length ? { ok: false, reasons } : { ok: true, ages: facts.agesStated ? facts.ages : undefined };
}
