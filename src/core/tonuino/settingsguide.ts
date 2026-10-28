import { factoryInvert, type InvertKind } from '../firmware/tngstands';
import type { KeyCount } from './adminkeys';
import type { FirmwareProfile } from './card';
import { adminEntry, describePresses, menuPresses, menuStep, type AdminAccess, type BoxGuide, type BoxStep, type KeyPress } from './boxguide';

/**
 * Step-by-step instructions for the settings in the admin menu of a box:
 * volume limits, Ausschalt-Timer, buttons, "Pause, wenn die Karte weg ist",
 * the lock of the admin menu, Klang (EQ), a Kurzwahl and the reset. The menus
 * follow TonUINO-TNG 3.3 (src/state_machine.cpp, src/settings.cpp) and
 * TonUINO 2.1 (Tonuino.ino, adminMenu() and resetSettings()):
 *
 * - Admin entries: 2 lauteste Stufe, 3 leiseste Stufe, 4 Lautstärke beim
 *   Start, 5 EQ, 7 Kurzwahl (Shortcut), 8 Timer, 10 Tasten umdrehen, 11 alle
 *   Einstellungen löschen, 12 Admin-Menü absichern, 13 Pause ohne Karte (TNG
 *   only). TNG has 14 entries, 2.1 has 12.
 * - TNG saves, says "Ok, ich habe die Einstellungen gespeichert" and stays in
 *   the admin menu at the same entry (Admin_End = Admin_Entry, "Und weiter im
 *   Admin Menü"). 2.1 saves without a word and leaves the menu, so the menu
 *   opens again for every setting.
 * - The volume menus start at the value the box has and say the real volume
 *   (Admin_SimpleSetting::entry; adminMenu() in 2.1): the loudest level counts
 *   from the current minimum (30 - min options), the quietest from 1 to
 *   max - 1, the start volume from min to max. A start volume below a new
 *   minimum puts that menu outside its range; one press on Vor brings it to
 *   the top. The EQ menu starts at the current sound as well.
 * - Timer, buttons, Pause and lock start at 0: one press on Vor is option 1.
 * - Volume and EQ steps are exact only when the current values are known
 *   (the Steckbrief of the Box-Logbuch, or right after a reset). Otherwise a
 *   step says which number to wait for.
 */

export interface Volumes {
  /** Lauteste Stufe. */
  max: number;
  /** Leiseste Stufe. */
  min: number;
  /** Lautstärke beim Einschalten. */
  init: number;
}

/** A key of the PIN: Pause, Vor or Zurück, each pressed short. */
export type PinKey = 'pause' | 'up' | 'down';

/**
 * Settings of the admin menu. As the current state of a box a missing field
 * is unknown; as a wish it stays as it is.
 */
export interface BoxSettingValues {
  volume?: Volumes;
  /** Minutes without music until the box switches off; 0: never. */
  standby?: number;
  /**
   * invertVolumeButtons. Boxes with 3 buttons: true when a short press changes
   * the volume, as from the factory. Boxes with 5 buttons and TNG from
   * 26.10.2026: true when Vor/Zurück change the volume while music plays
   * (from the factory false; tngstands.ts invertKind).
   */
  shortPressVolume?: boolean;
  /** TNG only: stop when the card is taken off the box. */
  pauseWhenCardRemoved?: boolean;
  /** How the admin menu opens; 'buttons' means it is not locked. */
  lock?: AdminAccess;
  /** The four keys of the PIN, for the lock 'pin'. */
  pin?: PinKey[];
  /** Klang: 1 Normal, 2 Pop, 3 Rock, 4 Jazz, 5 Classic, 6 Bass. */
  eq?: number;
}

/** A folder that starts with a long press while nothing plays, or when the box starts. */
export interface Shortcut {
  /** 1 to 4, see shortcutSlots(). */
  slot: number;
  folder: number;
  /** 1 Hörspiel, 2 Album, 3 Party: the modes that need nothing but the folder. */
  mode: number;
}

export interface SettingsWish extends BoxSettingValues {
  /** Erase all settings first ("Alle Einstellungen löschen"). */
  reset?: boolean;
  shortcut?: Shortcut;
}

export interface SettingsGuide extends BoxGuide {
  /** Settings the box already has as wished: they get no steps. */
  unchanged: string[];
}

export type SettingsGuideResult = { ok: true; guide: SettingsGuide } | { ok: false; reason: string };

/** A new box and a box after a reset (TNG Settings::resetSettings, 2.1 resetSettings()). */
export const FACTORY_SETTINGS: Readonly<Required<Omit<BoxSettingValues, 'pin'>>> = {
  volume: { max: 25, min: 5, init: 15 },
  standby: 0,
  shortPressVolume: true,
  pauseWhenCardRemoved: false,
  lock: 'buttons',
  eq: 1,
};

/** The MP3 player knows 30 volume levels. */
export const MAX_VOLUME = 30;

/** The timer menu in its order: option 1 is 5 minutes, option 5 switches the timer off. */
export const STANDBY_OPTIONS = [5, 15, 30, 60, 0] as const;

/** The sounds of the EQ menu, as the box says them. */
export const EQ_NAMES = ['Normal', 'Pop', 'Rock', 'Jazz', 'Classic', 'Bass'] as const;

/** The locks in the order of the menu "Das Adminmenü absichern" (TNG offers the first three). */
const LOCK_ORDER: readonly AdminAccess[] = ['buttons', 'card', 'pin', 'calc'];

const LOCK_SAYS: Record<AdminAccess, string> = {
  buttons: 'Kein Schutz …',
  card: 'Nur Adminkarte …',
  pin: 'Codeeingabe …',
  calc: 'Rechenaufgabe …',
};

const STANDBY_SAYS = ['5 Minuten.', '15 Minuten.', '30 Minuten.', '60 Minuten.', 'Nicht automatisch abschalten'];

/** The modes a Kurzwahl can play here; both firmwares ask nothing more for them. */
export const SHORTCUT_MODES = [
  { mode: 1, name: 'Hörspiel', text: 'ein zufälliger Titel', says: 'Hörspielmodus …' },
  { mode: 2, name: 'Album', text: 'alle Titel der Reihe nach', says: 'Albummodus …' },
  { mode: 3, name: 'Party', text: 'alle Titel durcheinander', says: 'Party Modus …' },
] as const;

const ENTRIES: Record<FirmwareProfile, number> = { tng: 14, classic21: 12 };
const MODES: Record<FirmwareProfile, number> = { tng: 16, classic21: 9 };

const ENTRY = { max: 2, min: 3, init: 4, eq: 5, shortcut: 7, standby: 8, buttons: 10, reset: 11, lock: 12, cardRemoved: 13 } as const;

const ENTRY_SAYS: Record<number, string> = {
  2: 'Maximale Lautstärke festlegen.',
  3: 'Minimale Lautstärke festlegen.',
  4: 'Lautstärke beim Start festlegen.',
  5: 'EQ konfigurieren.',
  8: 'Den Timer konfigurieren.',
  10: 'Funktion der Lautstärketasten umdrehen.',
  11: 'Alle Einstellungen löschen.',
  12: 'Das Adminmenü absichern.',
  13: 'Pause, wenn Karte entfernt wird …',
};

function entrySays(profile: FirmwareProfile, entry: number): string {
  if (entry === ENTRY.shortcut) return profile === 'tng' ? 'Shortcuts konfigurieren …' : 'Tasten mit einem Shortcut konfigurieren …';
  return ENTRY_SAYS[entry];
}

/** What starts a Kurzwahl, in the order of the box's menu (0941 to 0944). */
export function shortcutSlots(profile: FirmwareProfile): { slot: number; label: string; says: string }[] {
  return [
    profile === 'tng'
      ? { slot: 1, label: 'Vor und Zurück zusammen lang drücken', says: 'Vor- und Zurücktaste' }
      : { slot: 1, label: 'Play/Pause lang drücken', says: 'Pausetaste' },
    { slot: 2, label: 'Vor lang drücken', says: 'Vor- bzw. Lautertaste' },
    { slot: 3, label: 'Zurück lang drücken', says: 'Zurück- bzw. Leisertaste' },
    { slot: 4, label: 'Beim Einschalten', says: 'Shortcut beim Start festlegen' },
  ];
}

/** Option of the timer menu for these minutes, or undefined. */
export function standbyOption(minutes: number): number | undefined {
  const i = (STANDBY_OPTIONS as readonly number[]).indexOf(minutes);
  return i < 0 ? undefined : i + 1;
}

/* ------------------------------------------------------------------ checks */

/** Why these volume levels do not work, in plain German; undefined when they do. */
export function volumeProblem(v: Volumes): string | undefined {
  if (![v.max, v.min, v.init].every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_VOLUME)) {
    return `Trage bei der Lautstärke ganze Zahlen von 1 bis ${MAX_VOLUME} ein.`;
  }
  if (v.min >= v.max) return 'Die leiseste Stufe muss unter der lautesten liegen.';
  if (v.init < v.min || v.init > v.max) return 'Die Lautstärke beim Einschalten muss zwischen der leisesten und der lautesten Stufe liegen.';
  return undefined;
}

/** Why the box cannot be set like this, in plain German; undefined when it can. */
export function settingsProblem(profile: FirmwareProfile, wish: SettingsWish): string | undefined {
  if (wish.volume) {
    const problem = volumeProblem(wish.volume);
    if (problem) return problem;
  }
  if (wish.standby !== undefined && standbyOption(wish.standby) === undefined) return 'Der Ausschalt-Timer kennt nur 5, 15, 30 oder 60 Minuten oder nie.';
  if (wish.eq !== undefined && !(Number.isInteger(wish.eq) && wish.eq >= 1 && wish.eq <= EQ_NAMES.length)) return 'Diesen Klang kennt die Box nicht.';
  if (wish.pauseWhenCardRemoved !== undefined && profile !== 'tng') {
    return 'TonUINO 2.1 kennt „Box hält an, wenn die Karte weg ist“ nicht. Das gibt es nur bei TonUINO TNG.';
  }
  if (wish.lock === 'calc' && profile === 'tng') return 'Eine Rechenaufgabe als Sperre gibt es nur bei TonUINO 2.1. Nimm bei TNG die Admin-Karte oder eine PIN.';
  if (wish.lock === 'pin' && (wish.pin?.length !== 4 || !wish.pin.every((k) => k === 'pause' || k === 'up' || k === 'down'))) {
    return 'Wähle alle vier Tasten der PIN.';
  }
  if (wish.shortcut) {
    const { slot, folder, mode } = wish.shortcut;
    if (!Number.isInteger(slot) || slot < 1 || slot > 4) return 'Diese Taste für die Kurzwahl kennt die Box nicht.';
    if (!Number.isInteger(folder) || folder < 1 || folder > 99) return 'Wähle für die Kurzwahl einen Ordner von 1 bis 99.';
    if (!SHORTCUT_MODES.some((m) => m.mode === mode)) return 'Die Kurzwahl kann hier nur Hörspiel, Album oder Party.';
  }
  return undefined;
}

/* ------------------------------------------------------------------ steps */

const KEY_WORDS: Record<PinKey, string> = { pause: 'Play/Pause', up: 'Vor', down: 'Zurück' };

/** A step that waits for a number because the start of the menu is unknown. */
function untilStep(what: string, says: string, firstUp = false): BoxStep {
  const hear = `„${says}“`;
  const how = firstUp ? 'Drücke zuerst einmal kurz Vor, dann Vor oder Zurück' : 'Drücke Vor oder Zurück';
  return { kind: 'menu', text: `${what}: ${how}, bis die Box ${hear} sagt. Dann kurz die Play/Pause-Taste.`, hear };
}

/** Like menuStep, for presses worked out here. */
function pressStep(what: string, presses: KeyPress[], says: string): BoxStep {
  const hear = `„${says}“`;
  return { kind: 'menu', text: `${what}: Drücke ${describePresses(presses)}, bis die Box ${hear} sagt. Dann kurz die Play/Pause-Taste.`, presses: [...presses, { key: 'pause', times: 1 }], hear };
}

function folderStep(folder: number): BoxStep {
  const step = menuStep('Wähle den Ordner', 0, folder, 99, String(folder));
  return { ...step, text: step.text.replace('. Dann kurz', ' und kurz in den Ordner hineinspielt. Dann kurz') };
}

/** The keys of a PIN as presses: the same key twice in a row is one picture with "2×". */
function pinPresses(pin: PinKey[]): KeyPress[] {
  const out: KeyPress[] = [];
  for (const key of pin) {
    const last = out[out.length - 1];
    if (last?.key === key) last.times++;
    else out.push({ key, times: 1 });
  }
  return out;
}

const SAVED_SILENTLY = 'Die Box hat gespeichert und das Admin-Menü verlassen, ohne etwas zu sagen.';

/** Walks through the admin menu and remembers where the box is. */
class Plan {
  readonly steps: BoxStep[] = [];
  private inMenu = false;
  private at = 0;
  /** What 2.1 did when it left the menu after the last setting. */
  private left = SAVED_SILENTLY;
  private opened = false;

  constructor(
    private readonly profile: FirmwareProfile,
    public access: AdminAccess,
    private readonly buttons?: KeyCount,
  ) {}

  /** Opens the admin menu when needed and selects an entry. */
  choose(entry: number, what = 'Wähle im Admin-Menü'): BoxStep {
    const says = entrySays(this.profile, entry);
    const size = ENTRIES[this.profile];
    let step: BoxStep;
    if (this.inMenu) {
      step = menuStep(`Die Box sagt „Und weiter im Admin Menü …“. ${what === 'Wähle im Admin-Menü' ? 'Wähle als Nächstes' : what}`, this.at, entry, size, says);
    } else {
      const open = adminEntry(this.profile, this.access, this.buttons);
      // 2.1 left the menu after the last setting: say so before it opens again.
      if (this.opened) open[0] = { ...open[0], text: `${this.left} ${open[0].text}` };
      this.steps.push(...open);
      step = menuStep(what, 0, entry, size, says);
      this.inMenu = true;
      this.opened = true;
    }
    this.steps.push(step);
    this.at = entry;
    return step;
  }

  add(step: BoxStep) {
    this.steps.push(step);
  }

  /** The box saved the setting: TNG stays at this entry, 2.1 leaves the menu. */
  saved(left = SAVED_SILENTLY) {
    if (this.profile === 'tng') return;
    this.inMenu = false;
    this.left = left;
  }

  finish() {
    if (!this.steps.length) return;
    if (this.profile === 'tng') {
      // Holding Pause in Admin_Entry is adm_end: "OK, ich habe den Vorgang abgebrochen." and back to Idle.
      this.steps.push({
        kind: 'done',
        text: 'Die Box sagt „Und weiter im Admin Menü …“. Verlass das Admin-Menü jetzt: Halte die Play/Pause-Taste lang, bis die Box „OK, ich habe den Vorgang abgebrochen.“ sagt. Deine Einstellungen bleiben trotzdem gespeichert.',
        presses: [{ key: 'pause', long: true, times: 1 }],
        hear: '„OK, ich habe den Vorgang abgebrochen.“',
      });
    } else {
      this.steps.push({ kind: 'done', text: `Fertig. ${this.left}` });
    }
  }
}

function samePin(a: PinKey[] | undefined, b: PinKey[] | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Instructions that bring a box from `now` (what is known about it) to
 * `wish`. `access` is how the admin menu opens when `now.lock` is unknown;
 * `open` overrides both, for a box whose lock cannot be opened its own way
 * (a PIN that cannot be typed: only the admin card gets in). `buttons` is
 * the number of keys when known.
 */
export function settingsGuide(
  profile: FirmwareProfile,
  wish: SettingsWish,
  now: BoxSettingValues = {},
  opts: { access?: AdminAccess; open?: AdminAccess; buttons?: KeyCount; invert?: InvertKind } = {},
): SettingsGuideResult {
  const problem = settingsProblem(profile, wish);
  if (problem) return { ok: false, reason: problem };

  const tng = profile === 'tng';
  const plan = new Plan(profile, opts.open ?? now.lock ?? opts.access ?? 'buttons', opts.buttons);
  const notes: string[] = [];
  const unchanged: string[] = [];
  let cur: BoxSettingValues = { ...now };

  if (wish.reset) {
    const step = plan.choose(ENTRY.reset, 'Lösche alle Einstellungen');
    step.text += ' Die Box löscht sofort und sagt „Reset wurde durchgeführt!“.';
    plan.saved('Die Box sagt „Reset wurde durchgeführt!“ und verlässt das Admin-Menü.');
    cur = { ...FACTORY_SETTINGS, volume: { ...FACTORY_SETTINGS.volume }, shortPressVolume: factoryInvert(opts.invert) };
    plan.access = 'buttons';
    notes.push('Das Löschen setzt alles auf den Stand ab Werk: auch die Sperre des Admin-Menüs und die Kurzwahlen. Hörbücher fangen wieder vorn an. Karten und SD-Karte bleiben, wie sie sind.');
  }

  if (wish.volume) volumeSteps(plan, wish.volume, cur.volume, notes, unchanged);
  if (wish.volume && tng) {
    notes.push('Boxen mit Kopfhörer-Erkennung (zum Beispiel die AiO+) merken sich die Lautstärke für den Kopfhörer extra. Steckt beim Einstellen ein Kopfhörer, gelten die Werte nur für ihn. Für den Lautsprecher zieh ihn vorher ab.');
  }

  if (wish.eq !== undefined) {
    const says = EQ_NAMES[wish.eq - 1];
    if (cur.eq === wish.eq) unchanged.push('Klang');
    else {
      plan.choose(ENTRY.eq);
      plan.add(cur.eq !== undefined ? menuStep('Klang', cur.eq, wish.eq, EQ_NAMES.length, says) : untilStep('Klang', says));
      plan.saved();
    }
  }

  if (wish.shortcut) {
    const { slot, folder, mode } = wish.shortcut;
    const modeSays = SHORTCUT_MODES.find((m) => m.mode === mode)!.says;
    plan.choose(ENTRY.shortcut);
    plan.add(menuStep('Wähle die Taste für die Kurzwahl', 0, slot, 4, shortcutSlots(profile)[slot - 1].says));
    // TNG asks for the mode first and then for the folder (SM_setupCard), 2.1 the other way round (setupFolder()).
    const modeStep = menuStep('Wähle, wie der Ordner spielt', 0, mode, MODES[profile], modeSays);
    const setup = tng ? [modeStep, folderStep(folder)] : [folderStep(folder), modeStep];
    for (const step of setup) plan.add(step);
    plan.saved('Die Box sagt „OK. Ich habe die Karte konfiguriert.“ und verlässt das Admin-Menü.');
    notes.push('Die Kurzwahl startet nur, wenn gerade nichts läuft.');
  }

  if (wish.standby !== undefined) {
    const option = standbyOption(wish.standby)!;
    if (cur.standby === wish.standby) unchanged.push('Ausschalt-Timer');
    else {
      plan.choose(ENTRY.standby);
      plan.add(menuStep('Ausschalt-Timer', 0, option, STANDBY_OPTIONS.length, STANDBY_SAYS[option - 1]));
      plan.saved();
    }
  }

  if (wish.shortPressVolume !== undefined) {
    if (cur.shortPressVolume === wish.shortPressVolume) unchanged.push('Tasten');
    else {
      plan.choose(ENTRY.buttons);
      // 5 buttons on TNG from 26.10.2026: the same menu swaps Vor/Zurück with Lauter/Leiser (tngstands.ts invertKind).
      const what =
        opts.invert === 'five'
          ? wish.shortPressVolume
            ? 'Die Box fragt, ob sie die Funktion der Tasten umdrehen soll. Damit Vor und Zurück beim Abspielen die Lautstärke ändern, wähle „Ja“'
            : 'Die Box fragt, ob sie die Funktion der Tasten umdrehen soll. Damit alle Tasten tun, was draufsteht, wähle „Nein“'
          : wish.shortPressVolume
            ? 'Die Box fragt, ob sie die Funktion der Tasten umdrehen soll. Damit kurz drücken die Lautstärke ändert, wähle „Ja“'
            : 'Die Box fragt, ob sie die Funktion der Tasten umdrehen soll. Damit kurz drücken den Titel wechselt, wähle „Nein“';
      plan.add(menuStep(what, 0, wish.shortPressVolume ? 2 : 1, 2, wish.shortPressVolume ? 'Ja.' : 'Nein.'));
      plan.saved();
    }
  }

  if (wish.pauseWhenCardRemoved !== undefined) {
    if (cur.pauseWhenCardRemoved === wish.pauseWhenCardRemoved) unchanged.push('Karte wegnehmen');
    else {
      plan.choose(ENTRY.cardRemoved);
      const yes = wish.pauseWhenCardRemoved;
      plan.add(menuStep(`Die Box fragt, ob sie anhalten soll, wenn die Karte weg ist. Wähle „${yes ? 'Ja' : 'Nein'}“`, 0, yes ? 2 : 1, 2, yes ? 'Ja.' : 'Nein.'));
      plan.saved();
    }
  }

  // The lock comes last: 2.1 opens the menu again for every setting, still with the old lock.
  if (wish.lock !== undefined) {
    const same = cur.lock === wish.lock && (wish.lock !== 'pin' || samePin(cur.pin, wish.pin));
    if (same) unchanged.push('Admin-Menü');
    else {
      plan.choose(ENTRY.lock);
      plan.add(menuStep('Wähle, wie das Admin-Menü geschützt ist', 0, LOCK_ORDER.indexOf(wish.lock) + 1, tng ? 3 : 4, LOCK_SAYS[wish.lock]));
      if (wish.lock === 'pin') {
        const pin = wish.pin!;
        plan.add({
          kind: 'menu',
          text: `Die Box sagt „Bitte gebe die Pin ein.“ Drücke jetzt die vier Tasten der neuen PIN nacheinander, jeweils kurz: ${pin.map((k) => KEY_WORDS[k]).join(', ')}.`,
          presses: pinPresses(pin),
          hear: tng ? '„Ok, ich habe die Einstellungen gespeichert“' : undefined,
        });
        notes.push('Merke dir die PIN gut. Hast du sie vergessen, öffnet eine Admin-Karte das Menü trotzdem.');
      }
      plan.saved();
      plan.access = wish.lock;
    }
  }

  plan.finish();
  return { ok: true, guide: { steps: plan.steps, notes, unchanged } };
}

/**
 * The volume steps. The loudest level must stay above the quietest one, so
 * the quietest goes first when the new loudest level is not above the old
 * quietest. The start volume comes last, inside the new limits.
 */
function volumeSteps(plan: Plan, want: Volumes, known: Volumes | undefined, notes: string[], unchanged: string[]) {
  if (known && known.max === want.max && known.min === want.min && known.init === want.init) {
    unchanged.push('Lautstärke');
    return;
  }
  // Unknown values: the order goes by the factory values, the steps wait for the right number.
  const base = known ?? FACTORY_SETTINGS.volume;
  const setMax = !known || known.max !== want.max;
  const setMin = !known || known.min !== want.min;
  const setInit = !known || known.init !== want.init;
  let max = base.max;
  let min = base.min;

  const loudest = () => {
    plan.choose(ENTRY.max);
    plan.add(known ? menuStep('Lauteste Stufe', max - min, want.max - min, MAX_VOLUME - min, String(want.max)) : untilStep('Lauteste Stufe', String(want.max)));
    plan.saved();
    max = want.max;
  };
  const quietest = () => {
    plan.choose(ENTRY.min);
    plan.add(known ? menuStep('Leiseste Stufe', min, want.min, max - 1, String(want.min)) : untilStep('Leiseste Stufe', String(want.min)));
    plan.saved();
    min = want.min;
  };
  if (setMax && setMin && want.max <= base.min) {
    quietest();
    loudest();
  } else {
    if (setMax) loudest();
    if (setMin) quietest();
  }

  if (setInit) {
    plan.choose(ENTRY.init);
    const what = 'Lautstärke beim Einschalten';
    const says = String(want.init);
    const options = want.max - want.min + 1;
    const to = want.init - want.min + 1;
    if (!known) {
      // A start volume below the new minimum puts the menu outside its range; Vor first brings it back.
      plan.add(untilStep(what, says, want.min > 1));
    } else {
      const from = known.init - want.min + 1;
      // Below 0 the menu's counter wrapped around; one press on Vor lands on the loudest level.
      plan.add(from < 0 ? pressStep(what, [{ key: 'up', times: 1 }, ...menuPresses(options, to, options)], says) : menuStep(what, from, to, options, says));
    }
    plan.saved();
  }

  if (!known) {
    notes.push(
      'Ich weiß nicht, wie die Lautstärke an der Box gerade eingestellt ist. Darum drückst du, bis die Box die richtige Zahl sagt. Geht es bei der lautesten Stufe nicht weit genug hinunter, liegt die leiseste Stufe noch zu hoch: Stelle dann erst die leiseste Stufe ein und danach noch einmal die lauteste.',
    );
  }
}
