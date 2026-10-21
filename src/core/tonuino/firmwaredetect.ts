/**
 * Which firmware runs on the box, without asking: TonUINO TNG or TonUINO 2.1.
 * The card format is the same, so this only matters for some modes and
 * special cards (items.ts otherMeaning/supportProblem) and the announcements.
 *
 * - For sure: the start of the box over USB ("TonUINO Version 3…" is TNG,
 *   "TonUINO Version 2.1" is 2.1), from the Box-Logbuch, "Box erkennen" or a
 *   firmware just put on the box. Kept in the card's catalog.
 * - A good guess: the announcements on the SD card. Only TNG has the start
 *   tone mp3/0262 and the files 0500–0532 (games), 0985–0989 (admin lock) and
 *   advert/0306–0309, 0320–0326; only 2.1 has the admin-lock sentences at
 *   mp3/0982–0984 (TNG moved them to 0987–0989). Sets: sd-card of TNG V3.3.3
 *   and of xfjx/TonUINO DEV (2.1). Both kinds on one card mean a TNG set was
 *   copied over a 2.1 set: TNG wins. Worked out each time, not stored.
 * - A choice someone made by hand always wins.
 */
import type { TngRelease } from './boxguide';
import type { FirmwareProfile } from './card';
import type { SdScan } from './sd';

/** How the profile of a card came about. */
export type ProfileSource = 'manual' | 'box' | 'sounds' | 'default';

const TNG_MP3 = new Set<number>([262, ...range(500, 510), ...range(520, 524), ...range(530, 532), ...range(985, 989)]);
const TNG_ADVERT = new Set<number>([262, ...range(306, 309), ...range(320, 326)]);
const CLASSIC21_MP3 = new Set<number>([982, 983, 984]);

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let n = a; n <= b; n++) out.push(n);
  return out;
}

export interface SoundsEvidence {
  profile: FirmwareProfile;
  /** File names that decided it, e.g. ["mp3/0262.mp3"]; at most a few. */
  files: string[];
}

/** The firmware the announcements on the card were made for, or undefined when they do not tell. */
export function profileFromSounds(scan: Pick<SdScan, 'system'>): SoundsEvidence | undefined {
  const tng: string[] = [];
  const old: string[] = [];
  for (const name of ['mp3', 'advert'] as const) {
    const dir = scan.system[name];
    if (!dir) continue;
    for (const f of dir.files) {
      // An empty file (a copy that stopped) proves nothing.
      if (f.size === 0) continue;
      if (name === 'mp3' ? TNG_MP3.has(f.number) : TNG_ADVERT.has(f.number)) tng.push(`${name}/${f.name}`);
      else if (name === 'mp3' && CLASSIC21_MP3.has(f.number)) old.push(`${name}/${f.name}`);
    }
  }
  if (tng.length) return { profile: 'tng', files: tng.slice(0, 3) };
  if (old.length) return { profile: 'classic21', files: old.slice(0, 3) };
  return undefined;
}

/** The firmware family the start of a box named. */
export function profileFromBox(info: { firmware?: 'tng' | 'classic21' } | undefined): FirmwareProfile | undefined {
  return info?.firmware;
}

/**
 * Which TNG release a box runs (TngRelease, boxguide.ts), from the version it
 * logs at its start: the release of 17.09.2026 says "V3.3.3 17.09.26", the
 * release tag of 25.02.2026 "V3.3.3 25.02.26". A 3.3.3 built from main in
 * between (e.g. "V3.3.3 11.06.26") may have parts of it or not: undefined,
 * as without a date.
 */
export function tngReleaseOf(fw: { version?: string; date?: string } | undefined): Exclude<TngRelease, 'unknown'> | undefined {
  const v = fw?.version?.split('.').map(Number);
  if (!v || v.length < 2 || v.some((n) => !Number.isInteger(n))) return undefined;
  const order = [3, 3, 3].reduce((acc, n, i) => acc || Math.sign((v[i] ?? 0) - n), 0);
  if (order) return order < 0 ? 'older' : 'newer';
  if (!fw?.date) return undefined;
  if (fw.date >= TNG_SEPTEMBER_DATE) return 'newer';
  return fw.date <= TNG_FEBRUARY_DATE ? 'older' : undefined;
}

/** The release tag of TNG 3.3.3 ("V3.3.3 25.02.26"). */
export const TNG_FEBRUARY_DATE = '2026-02-25';
/** The release of 17.09.2026 (TNG_SEPTEMBER_2026). */
export const TNG_SEPTEMBER_DATE = '2026-09-17';
/**
 * A test build of TNG PR 352 (issue 349, still open in October 2026): the
 * MP3 player starts faster. In tests a box could hang after an announcement
 * (waitForTrackToFinish without a time limit), so the app warns about it.
 */
export const TNG_OCTOBER_PREVIEW_DATE = '2026-10-16';

/** Which build of TNG 3.3.3 a box runs, from the date in its version line ("V3.3.3 16.10.26"). */
export interface TngStand {
  /** E.g. "Release vom 17.09.2026". */
  label: string;
  /** What to know about it, in a sentence or two. */
  note?: string;
  /** Not released: a test build. */
  preview?: boolean;
}

function germanDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * The build of 3.3.3 a box runs: three are known (25.02., 17.09. and the
 * test build of 16.10.2026); other dates are builds in between or after.
 * Undefined for other versions or without a date.
 */
export function tngStandOf(fw: { version?: string; date?: string } | undefined): TngStand | undefined {
  const date = fw?.date;
  if (fw?.version !== '3.3.3' || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  if (date === TNG_FEBRUARY_DATE) {
    return { label: 'Release vom 25.02.2026', note: 'Es gibt ein neueres Release vom 17.09.2026. Erst damit fragt die Box bei Hörbuch-Karten nach dem letzten Ordner und kennt die Endlos-Karte.' };
  }
  if (date === TNG_SEPTEMBER_DATE) return { label: 'Release vom 17.09.2026' };
  if (date === TNG_OCTOBER_PREVIEW_DATE) {
    return {
      label: 'Testversion vom 16.10.2026',
      preview: true,
      note: 'Noch nicht offiziell (TNG PR 352): Der MP3-Player startet damit schneller. In Tests blieb die Box manchmal nach einer Ansage hängen. Passiert dir das, spiele das Release vom 17.09.2026 auf.',
    };
  }
  if (date < TNG_FEBRUARY_DATE) return { label: `Stand vom ${germanDate(date)}`, note: 'Älter als das Release vom 25.02.2026.' };
  if (date < TNG_SEPTEMBER_DATE) return { label: `Zwischenstand vom ${germanDate(date)}`, note: 'Gebaut zwischen den Releases vom 25.02. und 17.09.2026.' };
  return { label: `Stand vom ${germanDate(date)}`, note: 'Neuer als das Release vom 17.09.2026.' };
}

export interface ProfileDecision {
  profile: FirmwareProfile;
  source: ProfileSource;
  /** For 'sounds': the files that decided it. */
  files?: string[];
}

/**
 * The profile a card works with. `stored` is what its catalog says and how it
 * got there; catalogs from before 0.3 have no source: there 2.1 was always
 * chosen by hand (the default was TNG), TNG may be the default.
 */
export function decideProfile(
  stored: { profile: FirmwareProfile; from?: ProfileSource } | undefined,
  scan: Pick<SdScan, 'system'> | undefined,
  fallback: FirmwareProfile,
): ProfileDecision {
  const from = stored ? (stored.from ?? (stored.profile === 'classic21' ? 'manual' : 'default')) : 'default';
  if (stored && (from === 'manual' || from === 'box')) return { profile: stored.profile, source: from };
  const sounds = scan ? profileFromSounds(scan) : undefined;
  if (sounds) return { profile: sounds.profile, source: 'sounds', files: sounds.files };
  return { profile: stored?.profile ?? fallback, source: 'default' };
}

/**
 * What to store when a box reported its firmware: undefined when nothing
 * changes or a choice by hand must stay. A box that disagrees with a hand
 * choice is shown as a hint instead (see boxDisagrees).
 */
export function afterBoxReport(stored: { profile: FirmwareProfile; from?: ProfileSource }, box: FirmwareProfile): { profile: FirmwareProfile; from: 'box' } | undefined {
  const from = stored.from ?? (stored.profile === 'classic21' ? 'manual' : 'default');
  if (from === 'manual') return undefined;
  if (from === 'box' && stored.profile === box) return undefined;
  return { profile: box, from: 'box' };
}

/** A hand choice that the box itself contradicts. */
export function boxDisagrees(decision: ProfileDecision, box: FirmwareProfile | undefined): boolean {
  return decision.source === 'manual' && !!box && box !== decision.profile;
}

export const PROFILE_NAMES: Record<FirmwareProfile, string> = { tng: 'TonUINO TNG', classic21: 'TonUINO 2.1' };

/** "aus dem Start der Box (USB)", "aus den Ansagen auf der SD-Karte" */
export function sourceText(source: ProfileSource): string | undefined {
  if (source === 'box') return 'aus dem Start der Box über USB';
  if (source === 'sounds') return 'aus den Ansagen auf der SD-Karte';
  return undefined;
}
