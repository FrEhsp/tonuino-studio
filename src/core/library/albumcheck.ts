/**
 * A look at the album as a whole before it goes to the card (Frank,
 * 13.10.2026: „sinnvoll, wenn er die Listen prüft … eine leere Datei drin
 * oder irgendwas“). Empty, unreadable and damaged files are caught file by
 * file already, and the same sound under two names by sameaudio.ts; here are
 * the gaps in the numbering an incomplete download leaves, and titles too
 * short to be more than a broken file.
 */
import type { DraftTrack } from './grouping';

/** A title of a few seconds in an album of long ones is a broken file, not a jingle. */
export const SHORT_SEC = 2;
const LONG_SEC = 20;

/** "03 Name.mp3", "3. Kapitel.mp3", "003-Name.mp3": the number in front of the file name. */
function leadingNumber(name: string): number | undefined {
  const m = /^(\d{1,3})(?=[\s._-])/.exec(name);
  return m ? Number(m[1]) : undefined;
}

export interface Gap {
  /** The CD, when the album has more than one. */
  disc?: number;
  missing: number[];
}

/**
 * Numbers missing between 1 and the highest one (or the count the tags give,
 * "3/12"). Only when every title has a number and none twice: else the
 * numbering says nothing. And only when few are missing: someone who picked
 * three songs of an album meant to.
 */
export function numberGaps(tracks: readonly DraftTrack[]): Gap[] {
  if (tracks.length < 2) return [];
  const fromTags = tracks.every((t) => t.info?.trackNo);
  const fromNames = !fromTags && tracks.every((t) => leadingNumber(t.source.name) !== undefined);
  if (!fromTags && !fromNames) return [];
  const discs = new Map<number, { nos: number[]; of: Set<number | undefined> }>();
  for (const t of tracks) {
    const disc = fromTags ? (t.info?.discNo ?? 1) : 1;
    const d = discs.get(disc) ?? { nos: [], of: new Set() };
    d.nos.push(fromTags ? t.info!.trackNo! : leadingNumber(t.source.name)!);
    d.of.add(fromTags ? t.info?.trackOf : undefined);
    discs.set(disc, d);
  }
  const out: Gap[] = [];
  for (const [disc, d] of discs) {
    const have = new Set(d.nos);
    if (have.size !== d.nos.length) return [];
    const of = d.of.size === 1 ? [...d.of][0] : undefined;
    const top = Math.max(...d.nos, of && of <= 255 ? of : 0);
    const missing: number[] = [];
    for (let n = 1; n <= top; n++) if (!have.has(n)) missing.push(n);
    if (missing.length && missing.length * 3 <= top) out.push({ disc: discs.size > 1 ? disc : undefined, missing });
  }
  return out;
}

/** Titles shorter than SHORT_SEC, when the album has long ones besides. */
export function tooShort(tracks: readonly DraftTrack[]): DraftTrack[] {
  if (!tracks.some((t) => (t.info?.durationSec ?? 0) >= LONG_SEC)) return [];
  return tracks.filter((t) => t.info?.durationSec !== undefined && t.info.durationSec < SHORT_SEC);
}

/** "4", "4 und 7", "4, 7 und 9"; long lists end with how many more. */
export function listing(items: readonly string[], max = 5): string {
  if (items.length > max) return `${items.slice(0, max).join(', ')} und ${items.length - max} weitere`;
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}` : (items[0] ?? '');
}
