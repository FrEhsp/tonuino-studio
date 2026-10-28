/**
 * "So soll sich meine Box verhalten" (0.6, design/06-umbau/loetplan,
 * entwurf-verhalten-*.png): how the box should behave, chosen in sentences
 * ("Nehme ich die Karte weg, dann …"). The app decides for each sentence
 * whether it goes into the firmware (a build of the Firmware-Baukasten) or
 * is set at the box in its admin menu (settingsguide.ts), and says so.
 *
 * One choice for the whole app: the step "Verhalten" of the firmware wizard
 * and the page "Box einstellen" show and change the same sentences, and the
 * app keeps them for the box (browser storage), so nothing has to be
 * remembered between the upload and the admin menu.
 *
 * Also here: what the app knows of the box (the Steckbrief of the
 * Box-Logbuch, with what was set since), moved from BoxSettingsTool.tsx.
 */
import { signal } from '@preact/signals';
import type { BoxInfo } from '../../core/firmware/bootlog';
import type { BoardId } from '../../core/firmware/variants';
import { isBaukastenBoard, PRESET_TEXTS, type ExtrasChoice } from '../../core/firmware/baukasten';
import { factoryInvert, invertKind, type InvertKind } from '../../core/firmware/tngstands';
import type { AdminAccess } from '../../core/tonuino/boxguide';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { EQ_NAMES, FACTORY_SETTINGS, SHORTCUT_MODES, type BoxSettingValues, type PinKey, type SettingsWish, type Volumes } from '../../core/tonuino/settingsguide';
import { knownBuild, type KnownBuild } from './boxbuild';
import { logSession } from './logsession';

/* ------------------------------------------------------------------ the sentences */

/** The settings of the admin menu, one sentence each, and the reset before them. */
export type Part = 'volume' | 'standby' | 'buttons' | 'cardRemoved' | 'lock' | 'shortcut' | 'eq' | 'reset';
export type Preset = 'kinderzimmer' | 'werk' | 'eigene';

export const PRESETS: { id: Exclude<Preset, 'eigene'>; title: string; volume: Volumes }[] = [
  { id: 'kinderzimmer', title: 'Fürs Kinderzimmer', volume: { max: 20, min: 1, init: 8 } },
  { id: 'werk', title: 'Wie ab Werk', volume: { ...FACTORY_SETTINGS.volume } },
];

/** What the sentences hold; numbers of "eigene" stay text until they are checked. `on`: the sentences that were answered. */
export interface Draft {
  on: Record<Part, boolean>;
  preset: Preset;
  volume: { max: string; min: string; init: string };
  standby: number;
  shortPressVolume: boolean;
  pauseWhenCardRemoved: boolean;
  lock: AdminAccess;
  pin: (PinKey | '')[];
  eq: number;
  shortcut: { slot: number; folder: string; mode: number };
  /** „Drücke ich Play ohne Karte, dann … spielt die letzte Karte“: the preset „Weitermachen“ of the firmware. Unset: not answered. */
  weiter?: boolean;
}

export const NOTHING_ON: Record<Part, boolean> = { volume: false, standby: false, buttons: false, cardRemoved: false, lock: false, shortcut: false, eq: false, reset: false };

function presetOf(v: Volumes): Preset {
  return PRESETS.find((p) => p.volume.max === v.max && p.volume.min === v.min && p.volume.init === v.init)?.id ?? 'eigene';
}

/** The sentences as the box is now, or as it comes from the factory. */
export function draftFrom(values: BoxSettingValues, invert?: InvertKind): Draft {
  const v = values.volume ?? FACTORY_SETTINGS.volume;
  return {
    on: { ...NOTHING_ON },
    preset: presetOf(v),
    volume: { max: String(v.max), min: String(v.min), init: String(v.init) },
    standby: values.standby ?? FACTORY_SETTINGS.standby,
    shortPressVolume: values.shortPressVolume ?? factoryInvert(invert),
    pauseWhenCardRemoved: values.pauseWhenCardRemoved ?? FACTORY_SETTINGS.pauseWhenCardRemoved,
    lock: values.lock ?? 'buttons',
    pin: values.pin ? [...values.pin] : ['', '', '', ''],
    eq: values.eq ?? FACTORY_SETTINGS.eq,
    shortcut: { slot: 2, folder: '1', mode: 2 },
  };
}

export function volumeOf(d: Draft): Volumes {
  if (d.preset !== 'eigene') return { ...PRESETS.find((p) => p.id === d.preset)!.volume };
  const num = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));
  return { max: num(d.volume.max), min: num(d.volume.min), init: num(d.volume.init) };
}

/** The settings the answered sentences ask for at the box; `visible` leaves out what this box has not. */
export function wishOf(d: Draft, visible: Record<Part, boolean>): SettingsWish {
  const isOn = (p: Part) => visible[p] && d.on[p];
  const wish: SettingsWish = {};
  if (isOn('reset')) wish.reset = true;
  if (isOn('volume')) wish.volume = volumeOf(d);
  if (isOn('standby')) wish.standby = d.standby;
  if (isOn('buttons')) wish.shortPressVolume = d.shortPressVolume;
  if (isOn('cardRemoved')) wish.pauseWhenCardRemoved = d.pauseWhenCardRemoved;
  if (isOn('lock')) {
    wish.lock = d.lock;
    if (d.lock === 'pin') wish.pin = d.pin.filter((k): k is PinKey => k !== '');
  }
  if (isOn('eq')) wish.eq = d.eq;
  if (isOn('shortcut')) wish.shortcut = { slot: d.shortcut.slot, folder: d.shortcut.folder.trim() === '' ? Number.NaN : Number(d.shortcut.folder), mode: d.shortcut.mode };
  return wish;
}

/** Which sentences a box has: "Karte wegnehmen" only TNG, "Tasten" with 5 keys only where the firmware swaps them. */
export function visibleParts(prof: FirmwareProfile, keys: 3 | 5 | undefined, invert: InvertKind | undefined): Record<Part, boolean> {
  return { volume: true, standby: true, buttons: keys !== 5 || invert === 'five', cardRemoved: prof === 'tng', lock: true, shortcut: true, eq: true, reset: true };
}

/* ------------------------------------------------------------------ where a sentence goes */

/** Where an answer ends up: in the firmware, at the box (admin menu), or nowhere on this box. */
export type Wo = 'firmware' | 'box' | 'nicht';

export interface Ort {
  wo: Wo;
  /** One short line beside the mark: how it is called there, or why it does not go. */
  text: string;
}

/** What the sentences are said for: the firmware wizard (a build is about to be made) or the page "Box einstellen". */
export interface Kontext {
  /** The board, when known: only Classic and AiO have the Firmware-Baukasten. */
  board?: BoardId;
  prof: FirmwareProfile;
  /** In the firmware wizard: the extras chosen; the sentence "Play ohne Karte" goes into this build. */
  bau?: { choice: ExtrasChoice; fits: (choice: ExtrasChoice) => boolean; ownFile: boolean };
}

export const WEITER_FOLGE = 'Auch nach dem Ausschalten. Dazu: Dieselbe Karte noch mal auflegen fängt nicht von vorn an.';

/**
 * The rule the page shows: "Weitermachen" is a switch of the firmware
 * (TNG's REPLAY_ON_PLAY_BUTTON and friends, a build of the Baukasten); the
 * others are entries of the admin menu (settingsguide.ts). "Karte wegnehmen"
 * has TNG only.
 */
export function ortVon(satz: Part | 'weiter', k: Kontext): Ort {
  if (satz === 'weiter') {
    if (k.board && !isBaukastenBoard(k.board)) return { wo: 'nicht', text: 'Geht nur mit der Firmware aus dem Baukasten, die gibt es für Classic und AiO.' };
    if (k.bau?.ownFile) return { wo: 'nicht', text: 'Du spielst eine eigene Datei auf. Was die kann, steht in ihr.' };
    if (k.bau && !k.bau.fits({ ...k.bau.choice, preset: 'weiter' })) return { wo: 'nicht', text: 'Passt zusammen mit deinen Extras nicht mehr in den Speicher.' };
    return { wo: 'firmware', text: `als „${PRESET_TEXTS.weiter.label}“` };
  }
  if (satz === 'cardRemoved') return k.prof === 'tng' ? { wo: 'box', text: 'im Admin-Menü, „Karte wegnehmen = Pause“' } : { wo: 'nicht', text: 'Das kann nur TonUINO TNG.' };
  return { wo: 'box', text: '' };
}

/* ------------------------------------------------------------------ what happens then */

const LOCK_KURZ: Record<AdminAccess, string> = { buttons: 'Admin-Menü offen', card: 'Admin-Menü nur mit Admin-Karte', pin: 'Admin-Menü mit PIN', calc: 'Admin-Menü mit Rechenaufgabe' };

/** The settings at the box, one short line each, in the order of the sentences ("Karte wegnehmen = Pause", "Lautstärke 20 / 1 / 8"). */
export function boxPunkte(wish: SettingsWish): string[] {
  const out: string[] = [];
  if (wish.reset) out.push('Vorher alles zurücksetzen');
  if (wish.pauseWhenCardRemoved !== undefined) out.push(wish.pauseWhenCardRemoved ? 'Karte wegnehmen = Pause' : 'Karte wegnehmen: spielt weiter');
  if (wish.volume) out.push(`Lautstärke ${wish.volume.max} / ${wish.volume.min} / ${wish.volume.init}`);
  if (wish.standby !== undefined) out.push(wish.standby === 0 ? 'Nicht von selbst ausschalten' : `Ausschalten nach ${wish.standby} Min.`);
  if (wish.shortPressVolume !== undefined) out.push(wish.shortPressVolume ? 'Kurz drücken: Lautstärke' : 'Kurz drücken: Titel');
  if (wish.lock !== undefined) out.push(LOCK_KURZ[wish.lock]);
  if (wish.shortcut) out.push(`Kurzwahl: Ordner ${Number.isFinite(wish.shortcut.folder) ? wish.shortcut.folder : '?'} als ${SHORTCUT_MODES.find((m) => m.mode === wish.shortcut!.mode)?.name ?? 'Hörspiel'}`);
  if (wish.eq !== undefined) out.push(`Klang: ${EQ_NAMES[wish.eq - 1] === 'Classic' ? 'Klassik' : (EQ_NAMES[wish.eq - 1] ?? 'Normal')}`);
  return out;
}

/** "Mit Drehregler, Leuchtring und Weitermachen": what goes into the firmware, as one phrase. */
export function firmwareSatz(teile: string[]): string {
  if (!teile.length) return 'Ohne Extras, so wie TonUINO TNG ab Werk ist.';
  const liste = teile.length === 1 ? teile[0] : `${teile.slice(0, -1).join(', ')} und ${teile[teile.length - 1]}`;
  return `Mit ${liste}.`;
}

/* ------------------------------------------------------------------ the choice, kept for the box */

const STORE_KEY = 'tonuino-studio:verhalten';

/** What is kept: the answered sentences, never the PIN. */
type Stored = Omit<Draft, 'pin'>;

/** A kept choice back as sentences; anything broken counts as nothing kept. */
export function fromStored(raw: string | null | undefined): Draft | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as Partial<Stored>;
    if (!o || typeof o !== 'object' || !o.on || !o.volume) return undefined;
    const base = draftFrom({});
    const on = { ...NOTHING_ON };
    for (const p of Object.keys(NOTHING_ON) as Part[]) on[p] = o.on[p] === true;
    const d: Draft = { ...base, ...o, on, pin: ['', '', '', ''] };
    if (typeof o.weiter !== 'boolean') delete d.weiter;
    // A lock with PIN without its PIN would lock the box with nothing: ask again.
    if (d.lock === 'pin') d.on.lock = false;
    return d;
  } catch {
    return undefined;
  }
}

/** What is kept of the sentences: everything but the PIN. */
export function toStored(d: Draft): string {
  const { pin: _, ...rest } = d;
  return JSON.stringify(rest);
}

function loadDraft(): Draft | undefined {
  try {
    return fromStored(globalThis.localStorage?.getItem(STORE_KEY));
  } catch {
    return undefined;
  }
}

function saveDraft(d: Draft | undefined) {
  try {
    if (!d) globalThis.localStorage?.removeItem(STORE_KEY);
    else globalThis.localStorage?.setItem(STORE_KEY, toStored(d));
  } catch {
    // Without storage the choice lasts for this session.
  }
}

/** The sentences, for the firmware wizard and "Box einstellen" alike. */
export const verhalten = signal<Draft | undefined>(loadDraft());
verhalten.subscribe(saveDraft);

/** What was set at the box with "Erledigt" in this session, on top of the Steckbrief it was based on. */
export const applied = signal<Applied | undefined>(undefined);
export const doneNote = signal<string | undefined>(undefined);

/* ------------------------------------------------------------------ what is known of the box */

/**
 * The Steckbrief a guide was based on: the log, the start of the box in it
 * and what that start reported. Any newer reading replaces it.
 */
export interface Basis {
  book: object | undefined;
  /** Connections and starts the log had seen (Logbook.readings). */
  readings: number;
  seen: string;
}

/** Values set with "Erledigt", and the Steckbrief they were set on top of. */
export interface Applied {
  values: BoxSettingValues;
  basis: Basis;
}

export function basisOf(book: object | undefined, readings: number, fromLog: BoxSettingValues): Basis {
  return { book, readings, seen: JSON.stringify(fromLog) };
}

/**
 * What the box has now: the Steckbrief, with what was set at the box on top,
 * but only while the Steckbrief is still the one the guide started from. A
 * new start of the box, a new connection or another box wins.
 */
export function currentValues(fromLog: BoxSettingValues, basis: Basis, done?: Applied): BoxSettingValues {
  const same = done && done.basis.book === basis.book && done.basis.readings === basis.readings && done.basis.seen === basis.seen;
  return same ? { ...fromLog, ...done.values } : fromLog;
}

const PIN_KEYS: Record<number, PinKey> = { 1: 'pause', 2: 'up', 3: 'down' };

/** The admin-menu settings the Steckbrief knows. */
export function valuesFromInfo(info: BoxInfo): BoxSettingValues {
  const s = info.settings;
  const values: BoxSettingValues = {};
  if (s.speakerVolume) values.volume = { ...s.speakerVolume };
  if (s.standbyTimerMinutes !== undefined) values.standby = s.standbyTimerMinutes;
  if (s.invertVolumeButtons !== undefined) values.shortPressVolume = s.invertVolumeButtons;
  if (s.pauseWhenCardRemoved !== undefined) values.pauseWhenCardRemoved = s.pauseWhenCardRemoved;
  if (s.eq !== undefined) values.eq = s.eq;
  const lock = s.adminLock?.kind;
  if (lock === 'none') values.lock = 'buttons';
  else if (lock === 'card' || lock === 'pin' || lock === 'calc') values.lock = lock;
  if (s.adminPin && s.adminPin.length === 4 && s.adminPin.every((k) => PIN_KEYS[k])) values.pin = s.adminPin.map((k) => PIN_KEYS[k]);
  return values;
}

/** The Steckbrief says the menu is locked with a PIN, but the stored PIN cannot be typed in. */
export function pinUnusable(info: BoxInfo): boolean {
  const s = info.settings;
  return s.adminLock?.kind === 'pin' && s.adminPin !== undefined && !valuesFromInfo(info).pin;
}

/** The lock a Steckbrief reports, when there is one: card, PIN or sum. */
export function lockOf(info: BoxInfo): AdminAccess | undefined {
  const lock = valuesFromInfo(info).lock;
  return lock === 'buttons' ? undefined : lock;
}

export interface BoxKnowledge {
  values: BoxSettingValues;
  basis: Basis;
  /** The Box-Logbuch saw the settings of this box. */
  fromLog: boolean;
  /** The Box-Logbuch shows a saved file with settings; they may be old, so they are not used. */
  fileName?: string;
  /** That file says the admin menu was locked: the steps may not open it the way the app thinks. */
  fileLock?: AdminAccess;
  /** Only the admin card opens the menu: the PIN lock has a PIN that cannot be typed. */
  cardOnly: boolean;
  firmware?: FirmwareProfile;
  board?: BoardId;
  buttons?: string;
  headphones?: boolean;
  /** What „Tasten umdrehen“ does on this box (tngstands.ts): with 5 buttons only on TNG from 26.10.2026. */
  invert?: InvertKind;
  /** The Baukasten build the app knows on this box. */
  build: KnownBuild | null;
}

/** What the app knows of the box now. Reads signals: a new Steckbrief shows up at once. */
export function knowledge(): BoxKnowledge {
  void logSession.revision.value;
  const book = logSession.book;
  const source = logSession.source;
  const info = source.kind === 'live' ? book.info : undefined;
  const fromLog = info ? valuesFromInfo(info) : {};
  const basis = basisOf(book, book.readings, fromLog);
  const fileHasSettings = source.kind === 'file' && Object.keys(valuesFromInfo(book.info)).length > 0;
  const build = knownBuild.value;
  return {
    values: currentValues(fromLog, basis, applied.value),
    basis,
    fromLog: Object.keys(fromLog).length > 0,
    fileName: fileHasSettings && source.kind === 'file' ? source.name : undefined,
    fileLock: fileHasSettings ? lockOf(book.info) : undefined,
    cardOnly: !!info && pinUnusable(info),
    firmware: info?.firmware,
    board: info?.board ?? build?.board,
    // The build the app knows tells the keys when the log does not (as on the Bedienkarte).
    buttons: info?.buttons ?? build?.buttons,
    headphones: info?.headphones,
    invert: invertKind({ buttons: (info?.buttons ?? build?.buttons) as '3' | '5' | '3x3' | undefined, version: info?.version, date: info?.versionDate }),
    build,
  };
}
