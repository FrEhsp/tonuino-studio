/**
 * What the Bedienkarte knows about the box, and from where: the start of the
 * box in the Box-Logbuch (firmware, keys, settings), the Baukasten build the
 * app read off the box or put on it (knob, light, headphones), and the
 * special cards on the list. What nobody told the app is the factory setting,
 * and the user can change it.
 */
import type { BoxInfo } from '../../core/firmware/bootlog';
import type { CardData, FirmwareProfile } from '../../core/tonuino/card';
import type { ManualBox } from '../../core/tonuino/manual';
import type { KnownBuild } from '../workshop/boxbuild';

export type ManualFact = 'profile' | 'buttons' | 'shortPressVolume' | 'standby' | 'pauseWhenCardRemoved' | 'lock' | 'headphones' | 'extras';

export interface ManualChoice {
  profile?: FirmwareProfile;
  buttons?: 3 | 5;
  shortPressVolume?: boolean;
}

export interface ManualFacts {
  box: ManualBox;
  /** What came from the box itself ("automatisch erkannt"). */
  detected: Set<ManualFact>;
}

export function manualFacts(opts: { info?: BoxInfo; profile: FirmwareProfile; build?: KnownBuild | null; specials?: CardData[]; choice?: ManualChoice }): ManualFacts {
  const { info, build, choice = {} } = opts;
  const detected = new Set<ManualFact>();
  const s = info?.settings;

  let profile = opts.profile;
  if (info?.firmware) {
    profile = info.firmware;
    detected.add('profile');
  }
  if (choice.profile && choice.profile !== profile) {
    profile = choice.profile;
    detected.delete('profile');
  }

  let buttons: 3 | 5 = 3;
  const seen = info?.buttons ?? build?.buttons;
  if (seen) {
    buttons = seen === '5' ? 5 : 3;
    detected.add('buttons');
  }
  if (choice.buttons && choice.buttons !== buttons) {
    buttons = choice.buttons;
    detected.delete('buttons');
  }

  let shortPressVolume = true;
  if (s?.invertVolumeButtons !== undefined) {
    shortPressVolume = s.invertVolumeButtons;
    detected.add('shortPressVolume');
  }
  if (choice.shortPressVolume !== undefined && choice.shortPressVolume !== shortPressVolume) {
    shortPressVolume = choice.shortPressVolume;
    detected.delete('shortPressVolume');
  }

  const box: ManualBox = { profile, buttons, shortPressVolume, specials: opts.specials };
  if (s?.standbyTimerMinutes !== undefined) {
    box.standby = s.standbyTimerMinutes;
    detected.add('standby');
  }
  if (s?.pauseWhenCardRemoved !== undefined) {
    box.pauseWhenCardRemoved = s.pauseWhenCardRemoved;
    detected.add('pauseWhenCardRemoved');
  }
  const lock = s?.adminLock?.kind;
  if (lock === 'card' || lock === 'pin' || lock === 'calc') {
    box.lock = lock;
    detected.add('lock');
  } else if (lock === 'none') detected.add('lock');
  if (info?.headphones !== undefined || build?.headphones) {
    box.headphones = true;
    detected.add('headphones');
  }
  // A build for another number of keys is another box.
  if (build && (build.buttons === '5') === (buttons === 5)) {
    if (build.knob) box.knob = build.knob;
    if (build.light) box.light = build.light;
    if (build.preset) box.preset = build.preset;
    if (build.knob || build.light || build.preset) detected.add('extras');
  }
  return { box, detected };
}

/** The line under the title: firmware and keys. */
export function manualAbout(box: ManualBox): string {
  return `${box.profile === 'tng' ? 'TonUINO TNG' : 'TonUINO 2.1'} · ${box.buttons} Tasten`;
}

/** The title of the card: "So geht die Box", or with the box's name. */
export function manualTitle(name: string | undefined): string {
  const n = name?.trim();
  if (!n || n === 'Meine TonUINO-Box') return 'So geht die Box';
  return `So geht ${n}`;
}
