import type { TngRelease } from './boxguide';
import type { FirmwareProfile } from './card';
import type { SdScan, SdTrack, SystemDirName } from './sd';

/**
 * Announcements the firmware expects in mp3/ and advert/. Derived from the
 * sd-card folder of TonUINO-TNG V3.3.3 (17.09.2026). Older system sounds miss
 * some numbers (for example 0340, asked by "Hörbuch einzeln" since 3.2.1).
 */
export const TNG_SYSTEM_SOUNDS = {
  version: '3.3.3',
  mp3: ranges([1, 255], [262, 262], [300, 302], [310, 338], [340, 340], [400, 402], [500, 510], [520, 524], [530, 532], [800, 802], [900, 914], [919, 926], [930, 938], [940, 944], [960, 981], [985, 989], [991, 994], [999, 999]),
  advert: ranges([1, 255], [260, 262], [300, 309], [320, 326]),
};

/**
 * New in TNG 3.3.3 of 17.09.2026 (TNG_SEPTEMBER_2026): in the sd-card folder
 * of commit d527ca5, not in the one of the release tag V3.3.3_2026.02.25.
 * mp3/0302: Hörbuch cards ask for a last folder (issue 319); mp3/0981: the
 * Endlos card (issue 328); advert/0325 and 0326: Endlos off and on. A box
 * with an older firmware never plays them, so they count as missing only
 * when the box is known to run that release or a newer one.
 */
export const TNG_SEPTEMBER_SOUNDS = {
  mp3: [302, 981],
  advert: [325, 326],
};

/**
 * The announcements of TonUINO 2.1: the folder sd-card of the original
 * TonUINO repository, whose default branch DEV is the 2.1 firmware. GitHub
 * packs the whole repository into one ZIP; readSoundPackage finds mp3/ and
 * advert/ in it at any depth.
 */
export const CLASSIC21_SOUNDS_URL = 'https://github.com/xfjx/TonUINO/archive/refs/heads/DEV.zip';

/** Announcements every firmware generation needs (numbers spoken before tracks, "new card", admin menu). */
const CORE = {
  mp3: ranges([1, 255], [300, 300], [310, 310], [400, 401], [800, 802], [900, 900]),
  advert: ranges([1, 255]),
};

/**
 * What TonUINO TNG needs on top: mp3/0262.mp3, the short tone it plays
 * whenever a card starts (StartPlay in src/state_machine.cpp). Without it
 * the first card still plays, after that the box reports error 6 and stops
 * responding (forum 12980#1, #4: an announcement package from a fixed
 * download page that ended at 0255).
 */
const TNG_CORE = {
  mp3: [...CORE.mp3, 262].sort((a, b) => a - b),
  advert: CORE.advert,
};

/** The start tone of TonUINO TNG, see TNG_CORE. */
export const TNG_START_TONE = 262;

function ranges(...rs: [number, number][]): number[] {
  const out: number[] = [];
  for (const [a, b] of rs) for (let n = a; n <= b; n++) out.push(n);
  return out;
}

/**
 * Announcements last a few seconds. A file far bigger than that holds
 * something else, for example a whole audio play saved as mp3/0001.mp3: the
 * box then plays it where it should say a short sentence, for example while
 * a card is set up. The limit is about one minute of MP3 at 128 kbit/s; WAV,
 * which takes ten times the space, gets ten times as much.
 */
export const MAX_SOUND_BYTES = { mp3: 1024 * 1024, wav: 10 * 1024 * 1024 } as const;

export function isOversizedSound(t: Pick<SdTrack, 'size' | 'ext'>): boolean {
  return t.size > MAX_SOUND_BYTES[t.ext];
}

export interface SystemSoundsStatus {
  present: Record<SystemDirName, boolean>;
  /** Missing numbers per folder, compared with the expected set for the profile. */
  missing: Record<SystemDirName, number[]>;
  /** Numbers that occur more than once (e.g. 0300.mp3 and 0300_new_tag.mp3). */
  duplicates: Record<SystemDirName, number[]>;
  /** Numbered files far too big for an announcement (see MAX_SOUND_BYTES). */
  oversized: Record<SystemDirName, SdTrack[]>;
  /** Of `missing`, the ones every box of this firmware needs (see CORE, TNG_CORE). */
  coreMissing: Record<SystemDirName, number[]>;
  /**
   * Announcements with 0 bytes, e.g. from a copy that stopped: the box stays
   * silent there. They are not missing, so they do not change `state`.
   */
  empty: Record<SystemDirName, string[]>;
  /**
   * Of TNG_SEPTEMBER_SOUNDS, the ones not on the card while the box is not
   * known to need them (TNG release older or unknown). Not in `missing`.
   */
  september: Record<SystemDirName, number[]>;
  /** Only about missing files: 'incomplete' when files from `coreMissing` are gone, 'outdated' when only newer ones are. */
  state: 'missing' | 'incomplete' | 'outdated' | 'ok';
}

/**
 * `release` says whether the TNG box runs the release of 17.09.2026 or a
 * newer one: only then the files of TNG_SEPTEMBER_SOUNDS count as missing.
 */
export function checkSystemSounds(scan: SdScan, profile: FirmwareProfile, release: TngRelease = 'unknown'): SystemSoundsStatus {
  const september = profile === 'tng' && release !== 'newer' ? TNG_SEPTEMBER_SOUNDS : { mp3: [], advert: [] };
  const expected = profile === 'tng' ? { mp3: TNG_SYSTEM_SOUNDS.mp3.filter((n) => !september.mp3.includes(n)), advert: TNG_SYSTEM_SOUNDS.advert.filter((n) => !september.advert.includes(n)) } : CORE;
  const result: SystemSoundsStatus = {
    present: { mp3: !!scan.system.mp3, advert: !!scan.system.advert },
    missing: { mp3: [], advert: [] },
    duplicates: { mp3: [], advert: [] },
    oversized: { mp3: [], advert: [] },
    coreMissing: { mp3: [], advert: [] },
    empty: { mp3: [], advert: [] },
    september: { mp3: [], advert: [] },
    state: 'ok',
  };
  for (const name of ['mp3', 'advert'] as const) {
    const dir = scan.system[name];
    if (!dir) {
      result.missing[name] = expected[name];
      continue;
    }
    const counts = new Map<number, number>();
    for (const f of dir.files) counts.set(f.number, (counts.get(f.number) ?? 0) + 1);
    result.september[name] = september[name].filter((n) => !counts.has(n));
    result.missing[name] = expected[name].filter((n) => !counts.has(n));
    result.duplicates[name] = [...counts].filter(([, c]) => c > 1).map(([n]) => n);
    result.oversized[name] = [...dir.files, ...dir.wrongDigits].filter(isOversizedSound);
    result.empty[name] = [...dir.empty];
  }
  const core = profile === 'tng' ? TNG_CORE : CORE;
  for (const name of ['mp3', 'advert'] as const) result.coreMissing[name] = result.missing[name].filter((x) => core[name].includes(x));
  if (!result.present.mp3 || !result.present.advert) result.state = 'missing';
  else {
    if (result.coreMissing.mp3.length || result.coreMissing.advert.length) result.state = 'incomplete';
    else if (result.missing.mp3.length || result.missing.advert.length) result.state = 'outdated';
  }
  return result;
}
