/**
 * Kopfhörer-Grenzen: TNG keeps its own three volumes for the headphones
 * (hpMax/hpMin/hpInit, 25/5/15 from the factory) and uses them while a
 * headphone is plugged in, on boxes with headphone detection. They are set
 * in the same admin menu as the speaker's, with the headphone plugged in.
 * A lower limit protects children's ears.
 */
import type { BoxInfo } from '../../core/firmware/bootlog';
import type { BoardId } from '../../core/firmware/variants';
import type { KeyCount } from '../../core/tonuino/adminkeys';
import type { AdminAccess, BoxStep } from '../../core/tonuino/boxguide';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { FACTORY_SETTINGS, settingsGuide, type SettingsGuideResult, type Volumes } from '../../core/tonuino/settingsguide';
import type { KnownBuild } from './boxbuild';

export type HeadphonePreset = 'leise' | 'werk' | 'eigene';

export const HEADPHONE_PRESETS: { id: Exclude<HeadphonePreset, 'eigene'>; label: string; text: string; volume: Volumes }[] = [
  { id: 'leise', label: 'Leiser für Kopfhörer', text: 'Höchstens 15, mindestens 1, beim Einschalten 5.', volume: { max: 15, min: 1, init: 5 } },
  { id: 'werk', label: 'Wie ab Werk', text: 'Höchstens 25, mindestens 5, beim Einschalten 15.', volume: { ...FACTORY_SETTINGS.volume } },
];

/**
 * The box notices a headphone: the log printed "hpJackDetect" (info.headphones
 * is set either way), the app knows its Baukasten build has it, or it is an
 * AiO+, which has the jack on the board.
 */
export function hasHeadphoneDetection(opts: { info?: BoxInfo; build?: KnownBuild | null; board?: BoardId }): boolean {
  if (opts.info?.headphones !== undefined) return true;
  if (opts.build?.headphones) return true;
  return opts.board === 'aioplus';
}

const PLUG_IN: BoxStep = {
  kind: 'admin',
  text: 'Stecke einen Kopfhörer ein und lasse ihn drin, bis du fertig bist. Nur dann gelten die Werte für den Kopfhörer.',
};

/** The steps at the box for these headphone volumes: plug in first, then the volume menus. */
export function headphoneGuide(profile: FirmwareProfile, volume: Volumes, now: Volumes | undefined, opts: { access?: AdminAccess; open?: AdminAccess; buttons?: KeyCount } = {}): SettingsGuideResult {
  const r = settingsGuide(profile, { volume }, now ? { volume: now } : {}, opts);
  if (!r.ok) return r;
  const unchanged = r.guide.unchanged.map((u) => (u === 'Lautstärke' ? 'Lautstärke für Kopfhörer' : u));
  // The general hint about headphones is for the speaker's volume.
  const notes = r.guide.notes.filter((n) => !n.includes('Kopfhörer'));
  if (!r.guide.steps.length) return { ok: true, guide: { ...r.guide, notes, unchanged } };
  notes.push('Danach kannst du den Kopfhörer abziehen. Der Lautsprecher behält seine eigenen Grenzen.');
  return { ok: true, guide: { ...r.guide, steps: [PLUG_IN, ...r.guide.steps], notes, unchanged } };
}
