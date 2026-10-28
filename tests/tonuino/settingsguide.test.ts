import { describe, expect, it } from 'vitest';
import type { AdminAccess, BoxKey, BoxStep } from '../../src/core/tonuino/boxguide';
import type { FirmwareProfile } from '../../src/core/tonuino/card';
import {
  EQ_NAMES,
  FACTORY_SETTINGS,
  STANDBY_OPTIONS,
  settingsGuide,
  settingsProblem,
  shortcutSlots,
  standbyOption,
  volumeProblem,
  type BoxSettingValues,
  type PinKey,
  type SettingsGuide,
  type SettingsGuideResult,
  type SettingsWish,
  type Volumes,
} from '../../src/core/tonuino/settingsguide';

function guide(r: SettingsGuideResult): SettingsGuide {
  if (!r.ok) throw new Error(r.reason);
  return r.guide;
}

/** The menu presses of a step, without the confirming Pause. */
const moves = (step: BoxStep) => (step.presses ?? []).filter((p) => p.key !== 'pause');

interface BoxState {
  volume: Volumes;
  eq: number;
  standby: number;
  shortPressVolume: boolean;
  pauseWhenCardRemoved: boolean;
  lock: AdminAccess;
  pin: PinKey[];
  shortcuts: Record<number, { folder: number; mode: number }>;
}

function factory(): BoxState {
  return {
    volume: { max: 25, min: 5, init: 15 },
    eq: 1,
    standby: 0,
    shortPressVolume: true,
    pauseWhenCardRemoved: false,
    lock: 'buttons',
    pin: ['pause', 'pause', 'pause', 'pause'],
    shortcuts: {},
  };
}

/** What the Steckbrief would know about this box. */
function known(s: BoxState): BoxSettingValues {
  return { volume: { ...s.volume }, eq: s.eq, standby: s.standby, shortPressVolume: s.shortPressVolume, pauseWhenCardRemoved: s.pauseWhenCardRemoved, lock: s.lock, pin: [...s.pin] };
}

interface Menu {
  v: number;
  n: number;
  say: (v: number) => string;
  select: (v: number) => void;
}

const LOCKS: AdminAccess[] = ['buttons', 'card', 'pin', 'calc'];
const STANDBY_MENU = [5, 15, 30, 60, 0];

/**
 * The admin menu of a box, as TonUINO-TNG 3.3 (src/state_machine.cpp) and
 * TonUINO 2.1 (Tonuino.ino) run it:
 *
 * - Holding all three buttons opens the menu at 0, unless it is locked: a
 *   PIN or (2.1) a sum comes first; with the card lock only the admin card
 *   opens it. The admin card always opens it.
 * - Vor and Zurück move by 1, held by 10, within 1 … options; the counter is
 *   an unsigned byte. Pause selects (not at 0), a long Pause aborts.
 * - TNG saves and goes back to the entry it came from; 2.1 saves and leaves.
 */
class SettingsBox {
  state: 'idle' | 'pin' | 'calc' | 'entry' | 'menu' | 'newPin' = 'idle';
  at = 0;
  menu?: Menu;
  newPin: PinKey[] = [];
  /** Admin entries chosen, in order. */
  chosen: number[] = [];
  /** How often the menu was opened. */
  opened = 0;
  problems: string[] = [];

  constructor(
    readonly profile: FirmwareProfile,
    readonly s: BoxState,
  ) {}

  get tng() {
    return this.profile === 'tng';
  }

  follow(steps: BoxStep[]) {
    for (const step of steps) this.step(step);
  }

  private step(step: BoxStep) {
    const presses = step.presses ?? [];
    if (step.kind === 'admin') {
      if (presses.some((p) => p.key === 'all')) return this.holdAll();
      if (step.text.includes('Admin-Karte')) return this.adminCard();
      if (step.text.includes('PIN')) return this.unlock('pin');
      if (step.text.includes('Rechenaufgabe')) return this.unlock('calc');
      return void this.problems.push(`admin step not understood: ${step.text}`);
    }
    if (step.kind === 'menu' && !presses.length) return this.untilHeard(step);
    for (const p of presses) for (let i = 0; i < p.times; i++) this.press(p.key, !!p.long);
  }

  /** A family following "Drück Vor oder Zurück, bis die Box „20“ sagt". */
  private untilHeard(step: BoxStep) {
    const target = step.hear?.replace(/[„“]/g, '') ?? '';
    if (step.text.includes('zuerst einmal kurz Vor')) this.press('up', false);
    const rank = (said: string) => (EQ_NAMES as readonly string[]).includes(said) ? (EQ_NAMES as readonly string[]).indexOf(said) : Number(said);
    for (let i = 0; i < 60 && this.state === 'menu'; i++) {
      const said = this.menu!.say(this.menu!.v);
      if (said === target) return this.press('pause', false);
      this.press(rank(said) < rank(target) ? 'up' : 'down', false);
    }
    this.problems.push(`never heard ${target}`);
  }

  private holdAll() {
    if (this.state !== 'idle') return void this.problems.push(`held all three while ${this.state}`);
    this.opened++;
    const lock = this.tng && this.s.lock === 'calc' ? 'buttons' : this.s.lock;
    if (lock === 'buttons') this.enter();
    else if (lock === 'card') this.problems.push('the menu only opens with the admin card');
    else this.state = lock;
  }

  private adminCard() {
    if (this.state !== 'idle') return void this.problems.push(`admin card while ${this.state}`);
    this.opened++;
    this.enter();
  }

  private unlock(how: 'pin' | 'calc') {
    if (this.state !== how) return void this.problems.push(`${how} while ${this.state}`);
    this.enter();
  }

  private enter() {
    this.state = 'entry';
    this.at = 0;
  }

  private press(key: BoxKey, long: boolean) {
    const move = (v: number, n: number) => (key === 'up' ? Math.min(v + (long ? 10 : 1), n) : Math.max(v - (long ? 10 : 1), 1));
    switch (this.state) {
      case 'entry':
        if (key === 'pause') return long ? void (this.state = 'idle') : this.selectEntry();
        this.at = move(this.at, this.tng ? 14 : 12);
        return;
      case 'menu': {
        const m = this.menu!;
        if (key === 'pause') {
          if (long) {
            this.problems.push('aborted a menu');
            this.state = 'idle';
          } else if (m.v !== 0) m.select(m.v);
          return;
        }
        m.v = move(m.v, m.n);
        return;
      }
      case 'newPin':
        if (long || key === 'all') return void this.problems.push('PIN entry needs short presses');
        this.newPin.push(key);
        if (this.newPin.length === 4) {
          this.s.lock = 'pin';
          this.s.pin = this.newPin;
          this.saved();
        }
        return;
      default:
        this.problems.push(`pressed ${key}${long ? ' long' : ''} while ${this.state}`);
    }
  }

  private open(m: Omit<Menu, 'say'> & { say?: Menu['say'] }) {
    this.menu = { say: String, ...m };
    this.state = 'menu';
  }

  private saved() {
    this.menu = undefined;
    // TNG: Admin_End = Admin_Entry at the entry used last. 2.1 returns from adminMenu().
    this.state = this.tng ? 'entry' : 'idle';
  }

  private selectEntry() {
    if (this.at === 0) return;
    this.chosen.push(this.at);
    const s = this.s;
    const v = s.volume;
    /** Stores what the menu chose, then saves like the firmware. */
    const set = (store: (x: number) => void) => (x: number) => {
      store(x);
      this.saved();
    };
    switch (this.at) {
      case 2:
        return this.open({ v: v.max - v.min, n: 30 - v.min, say: (x) => String(x + v.min), select: set((x) => (v.max = x + v.min)) });
      case 3:
        return this.open({ v: v.min, n: v.max - 1, select: set((x) => (v.min = x)) });
      case 4:
        // uint8_t: a start volume below the minimum wraps around.
        return this.open({ v: (v.init - v.min + 1 + 256) % 256, n: v.max - v.min + 1, say: (x) => String(x + v.min - 1), select: set((x) => (v.init = x + v.min - 1)) });
      case 5:
        return this.open({ v: s.eq, n: 6, say: (x) => EQ_NAMES[x - 1] ?? `?${x}`, select: set((x) => (s.eq = x)) });
      case 7:
        return this.open({
          v: 0,
          n: 4,
          select: (slot) => {
            const folder = (then: (f: number) => void) => this.open({ v: 0, n: 99, select: then });
            const mode = (then: (m: number) => void) => this.open({ v: 0, n: this.tng ? 16 : 9, select: then });
            const save = (f: number, m: number) => {
              s.shortcuts[slot] = { folder: f, mode: m };
              this.saved();
            };
            if (this.tng) mode((m) => folder((f) => save(f, m)));
            else folder((f) => mode((m) => save(f, m)));
          },
        });
      case 8:
        return this.open({ v: 0, n: 5, select: set((x) => (s.standby = STANDBY_MENU[x - 1])) });
      case 10:
        return this.open({ v: 0, n: 2, select: set((x) => (s.shortPressVolume = x === 2)) });
      case 11:
        Object.assign(s, { ...factory(), shortcuts: {} });
        return this.saved();
      case 12:
        return this.open({
          v: 0,
          n: this.tng ? 3 : 4,
          select: (x) => {
            if (LOCKS[x - 1] === 'pin') {
              this.newPin = [];
              this.menu = undefined;
              this.state = 'newPin';
              return;
            }
            s.lock = LOCKS[x - 1];
            this.saved();
          },
        });
      case 13:
        if (!this.tng) break;
        return this.open({ v: 0, n: 2, select: set((x) => (s.pauseWhenCardRemoved = x === 2)) });
    }
    this.problems.push(`entry ${this.at} is no setting`);
    this.state = 'idle';
  }
}

function follow(profile: FirmwareProfile, start: BoxState, g: SettingsGuide): SettingsBox {
  const box = new SettingsBox(profile, structuredClone(start));
  box.follow(g.steps);
  return box;
}

/** Tries every way to the wished levels: a second alone, more while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('TNG', () => {
  it('goes from the factory values to the children’s room through entries 2, 3, 4 and 8', () => {
    const g = guide(settingsGuide('tng', { volume: { max: 20, min: 1, init: 8 }, standby: 30 }, known(factory())));
    expect(g.steps.map((s) => s.kind)).toEqual(['admin', 'menu', 'menu', 'menu', 'menu', 'menu', 'menu', 'menu', 'menu', 'done']);
    // The admin menu: Vor 2 to the loudest level, then 1, 1 and 4 further.
    expect(moves(g.steps[1])).toEqual([{ key: 'up', times: 2 }]);
    expect(g.steps[1].hear).toBe('„Maximale Lautstärke festlegen.“');
    expect(moves(g.steps[3])).toEqual([{ key: 'up', times: 1 }]);
    expect(moves(g.steps[5])).toEqual([{ key: 'up', times: 1 }]);
    expect(moves(g.steps[7])).toEqual([{ key: 'up', times: 4 }]);
    expect(g.steps[7].hear).toBe('„Den Timer konfigurieren.“');
    // The settings: from 25 down to 20, from 5 down to 1, from 15 down to 8, timer option 3.
    expect(moves(g.steps[2])).toEqual([{ key: 'down', times: 5 }]);
    expect(g.steps[2].text).toBe('Lauteste Stufe: Drücke die Zurück-Taste fünfmal kurz, bis die Box „20“ sagt. Dann kurz die Play/Pause-Taste.');
    expect(moves(g.steps[4])).toEqual([{ key: 'down', times: 4 }]);
    expect(moves(g.steps[6])).toEqual([{ key: 'down', times: 7 }]);
    expect(moves(g.steps[8])).toEqual([{ key: 'up', times: 3 }]);
    expect(g.steps[8].hear).toBe('„30 Minuten.“');
    // TNG stays in the admin menu; the last step leaves it.
    expect(g.steps[3].text).toContain('Und weiter im Admin Menü');
    expect(g.steps.at(-1)!.presses).toEqual([{ key: 'pause', long: true, times: 1 }]);

    const box = follow('tng', factory(), g);
    expect(box.problems).toEqual([]);
    expect(box.chosen).toEqual([2, 3, 4, 8]);
    expect(box.opened).toBe(1);
    expect(box.state).toBe('idle');
    expect(box.s.volume).toEqual({ max: 20, min: 1, init: 8 });
    expect(box.s.standby).toBe(30);
  });

  it('„nie“ is the fifth option of the timer', () => {
    expect(STANDBY_OPTIONS).toEqual([5, 15, 30, 60, 0]);
    expect(standbyOption(0)).toBe(5);
    expect(standbyOption(5)).toBe(1);
    expect(standbyOption(10)).toBeUndefined();
    const now = { ...factory(), standby: 15 };
    const g = guide(settingsGuide('tng', { standby: 0 }, known(now)));
    const timer = g.steps.find((s) => s.hear === '„Nicht automatisch abschalten“')!;
    expect(moves(timer)).toEqual([{ key: 'up', times: 5 }]);
    expect(follow('tng', now, g).s.standby).toBe(0);
  });

  it('sets the quietest level first when the new loudest one is not above the old quietest', () => {
    const now = { ...factory(), volume: { max: 25, min: 15, init: 20 } };
    const g = guide(settingsGuide('tng', { volume: { max: 10, min: 5, init: 8 } }, known(now)));
    const box = follow('tng', now, g);
    expect(box.problems).toEqual([]);
    expect(box.chosen).toEqual([3, 2, 4]);
    expect(box.s.volume).toEqual({ max: 10, min: 5, init: 8 });
    // At the old quietest level itself it swaps as well.
    const atMin = guide(settingsGuide('tng', { volume: { max: 15, min: 5, init: 10 } }, known(now)));
    expect(follow('tng', now, atMin).chosen).toEqual([3, 2, 4]);
    // Above it the loudest level goes first.
    const above = guide(settingsGuide('tng', { volume: { max: 16, min: 5, init: 10 } }, known(now)));
    expect(follow('tng', now, above).chosen).toEqual([2, 3, 4]);
  });

  it('brings a start volume below the new minimum back with one press on Vor', () => {
    const now = { ...factory(), volume: { max: 20, min: 1, init: 3 } };
    const g = guide(settingsGuide('tng', { volume: { max: 25, min: 5, init: 15 } }, known(now)));
    const start = g.steps.find((s) => s.hear === '„15“')!;
    expect(moves(start)[0]).toEqual({ key: 'up', times: 1 });
    const box = follow('tng', now, g);
    expect(box.problems).toEqual([]);
    expect(box.s.volume).toEqual({ max: 25, min: 5, init: 15 });
  });

  it('leaves out what the box already has, and says so', () => {
    const g = guide(settingsGuide('tng', { volume: { max: 25, min: 5, init: 15 }, standby: 0, shortPressVolume: true, pauseWhenCardRemoved: false, lock: 'buttons', eq: 1 }, known(factory())));
    expect(g.steps).toEqual([]);
    expect(g.unchanged).toEqual(['Lautstärke', 'Klang', 'Ausschalt-Timer', 'Tasten', 'Karte wegnehmen', 'Admin-Menü']);
    const one = guide(settingsGuide('tng', { volume: { max: 25, min: 5, init: 10 }, standby: 0 }, known(factory())));
    const box = follow('tng', factory(), one);
    expect(box.chosen).toEqual([4]);
    expect(one.unchanged).toEqual(['Ausschalt-Timer']);
  });

  it('opens the menu as the box is locked: with the PIN or with the admin card', () => {
    const locked = { ...factory(), lock: 'pin' as const, pin: ['up', 'down', 'up', 'pause'] as PinKey[] };
    const g = guide(settingsGuide('tng', { standby: 15 }, known(locked)));
    expect(g.steps.slice(0, 2).map((s) => s.kind)).toEqual(['admin', 'admin']);
    expect(follow('tng', locked, g).s.standby).toBe(15);

    const card = { ...factory(), lock: 'card' as const };
    const withCard = guide(settingsGuide('tng', { standby: 15 }, known(card)));
    expect(withCard.steps[0].text).toContain('Admin-Karte');
    const box = follow('tng', card, withCard);
    expect(box.problems).toEqual([]);
    expect(box.s.standby).toBe(15);
  });

  it('without a Steckbrief the menu opens as set in the app', () => {
    const card = { ...factory(), lock: 'card' as const };
    const g = guide(settingsGuide('tng', { standby: 60 }, {}, { access: 'card' }));
    expect(follow('tng', card, g).s.standby).toBe(60);
  });

  it('locks the menu with a new PIN', () => {
    const pin: PinKey[] = ['up', 'up', 'pause', 'down'];
    const g = guide(settingsGuide('tng', { lock: 'pin', pin }, known(factory())));
    const entry = g.steps.find((s) => s.text.includes('Bitte gebe die Pin ein'))!;
    expect(entry.presses).toEqual([
      { key: 'up', times: 2 },
      { key: 'pause', times: 1 },
      { key: 'down', times: 1 },
    ]);
    expect(entry.text).toContain('Vor, Vor, Play/Pause, Zurück');
    expect(g.notes.join(' ')).toContain('Admin-Karte');
    const box = follow('tng', factory(), g);
    expect(box.problems).toEqual([]);
    expect(box.s.lock).toBe('pin');
    expect(box.s.pin).toEqual(pin);
    // The same PIN again is nothing to do; another one is.
    const locked = { ...factory(), lock: 'pin' as const, pin };
    expect(guide(settingsGuide('tng', { lock: 'pin', pin }, known(locked))).steps).toEqual([]);
    expect(guide(settingsGuide('tng', { lock: 'pin', pin: ['down', 'down', 'down', 'down'] }, known(locked))).steps.length).toBeGreaterThan(0);
  });

  it('sets the buttons, the sound and “Pause, wenn die Karte weg ist”', () => {
    const wish: SettingsWish = { shortPressVolume: false, eq: 6, pauseWhenCardRemoved: true };
    const g = guide(settingsGuide('tng', wish, known(factory())));
    expect(g.steps.find((s) => s.hear === '„Nein.“')!.text).toContain('kurz drücken den Titel wechselt');
    expect(g.steps.some((s) => s.hear === '„Bass“')).toBe(true);
    const box = follow('tng', factory(), g);
    expect(box.problems).toEqual([]);
    expect(box.chosen).toEqual([5, 10, 13]);
    expect(box.s).toMatchObject({ shortPressVolume: false, eq: 6, pauseWhenCardRemoved: true });
    const back = guide(settingsGuide('tng', { shortPressVolume: true }, known(box.s)));
    expect(back.steps.find((s) => s.hear === '„Ja.“')!.text).toContain('kurz drücken die Lautstärke ändert');
  });

  it('says what „Tasten umdrehen“ does on a box with 5 buttons and TNG from 26.10.2026', () => {
    const on = guide(settingsGuide('tng', { shortPressVolume: true }, { ...known(factory()), shortPressVolume: false }, { buttons: 5, invert: 'five' }));
    expect(on.steps.find((s) => s.hear === '„Ja.“')!.text).toContain('Vor und Zurück beim Abspielen die Lautstärke ändern');
    const off = guide(settingsGuide('tng', { shortPressVolume: false }, known(factory()), { buttons: 5, invert: 'five' }));
    expect(off.steps.find((s) => s.hear === '„Nein.“')!.text).toContain('alle Tasten tun, was draufsteht');
    // From the factory the 5 keys do what is printed on them: after a reset nothing is left to do.
    const reset = guide(settingsGuide('tng', { reset: true, shortPressVolume: false }, known(factory()), { buttons: 5, invert: 'five' }));
    expect(reset.steps.some((s) => s.hear === '„Nein.“')).toBe(false);
    const reset3 = guide(settingsGuide('tng', { reset: true, shortPressVolume: false }, known(factory()), { buttons: 3, invert: 'three' }));
    expect(reset3.steps.some((s) => s.hear === '„Nein.“')).toBe(true);
  });

  it('sets a Kurzwahl: mode first, then the folder', () => {
    const g = guide(settingsGuide('tng', { shortcut: { slot: 2, folder: 7, mode: 2 } }, known(factory())));
    const hears = g.steps.map((s) => s.hear);
    expect(hears.indexOf('„Albummodus …“')).toBeLessThan(hears.indexOf('„7“'));
    expect(g.steps.find((s) => s.hear === '„7“')!.text).toContain('hineinspielt');
    expect(g.notes).toContain('Die Kurzwahl startet nur, wenn gerade nichts läuft.');
    const box = follow('tng', factory(), g);
    expect(box.problems).toEqual([]);
    expect(box.s.shortcuts).toEqual({ 2: { folder: 7, mode: 2 } });
  });

  it('erases everything first and then knows every value', () => {
    const odd: BoxState = { ...factory(), volume: { max: 12, min: 3, init: 4 }, standby: 60, lock: 'pin', pin: ['down', 'down', 'up', 'up'] };
    const g = guide(settingsGuide('tng', { reset: true, volume: { max: 20, min: 1, init: 8 }, standby: 30 }, {}, { access: 'pin' }));
    // After the reset the steps are exact, although nothing was known before.
    expect(g.steps.every((s) => s.kind !== 'menu' || s.presses?.length)).toBe(true);
    expect(g.steps.find((s) => s.text.includes('Reset wurde durchgeführt'))).toBeDefined();
    expect(g.notes.join(' ')).toContain('Hörbücher fangen wieder vorn an');
    const box = follow('tng', odd, g);
    expect(box.problems).toEqual([]);
    expect(box.chosen).toEqual([11, 2, 3, 4, 8]);
    expect(box.s).toMatchObject({ volume: { max: 20, min: 1, init: 8 }, standby: 30, lock: 'buttons' });
  });

  it('notes that a plugged-in headphone keeps its own volume', () => {
    expect(guide(settingsGuide('tng', { volume: { max: 20, min: 1, init: 8 } })).notes.join(' ')).toContain('Kopfhörer');
    expect(guide(settingsGuide('classic21', { volume: { max: 20, min: 1, init: 8 } })).notes.join(' ')).not.toContain('Kopfhörer');
  });
});

describe('TonUINO 2.1', () => {
  it('opens the menu again for every setting', () => {
    const g = guide(settingsGuide('classic21', { volume: { max: 20, min: 1, init: 8 }, standby: 30 }, known(factory())));
    expect(g.steps.filter((s) => s.kind === 'admin')).toHaveLength(4);
    // Every setting starts from the top of the admin menu.
    const entries = g.steps.filter((s) => s.text.startsWith('Wähle im Admin-Menü')).map(moves);
    expect(entries).toEqual([[{ key: 'up', times: 2 }], [{ key: 'up', times: 3 }], [{ key: 'up', times: 4 }], [{ key: 'up', long: true, times: 1 }, { key: 'down', times: 2 }]]);
    expect(g.steps[3].text).toContain('verlassen, ohne etwas zu sagen');
    expect(g.steps.at(-1)!.kind).toBe('done');
    expect(g.steps.some((s) => s.text.includes('Und weiter im Admin Menü'))).toBe(false);
    const box = follow('classic21', factory(), g);
    expect(box.problems).toEqual([]);
    expect(box.opened).toBe(4);
    expect(box.chosen).toEqual([2, 3, 4, 8]);
    expect(box.state).toBe('idle');
    expect(box.s.volume).toEqual({ max: 20, min: 1, init: 8 });
    expect(box.s.standby).toBe(30);
  });

  it('offers the sum as a lock, and sets the lock last', () => {
    const g = guide(settingsGuide('classic21', { lock: 'calc', standby: 5 }, known(factory())));
    const lock = g.steps.find((s) => s.hear === '„Rechenaufgabe …“')!;
    expect(moves(lock)).toEqual([{ key: 'up', times: 4 }]);
    const box = follow('classic21', factory(), g);
    expect(box.problems).toEqual([]);
    expect(box.chosen).toEqual([8, 12]);
    expect(box.s.lock).toBe('calc');
    // Next time the sum comes first.
    const next = guide(settingsGuide('classic21', { standby: 15 }, known(box.s)));
    expect(next.steps[1].text).toContain('Rechenaufgabe');
    expect(follow('classic21', box.s, next).s.standby).toBe(15);
  });

  it('a TNG box has no sum to solve', () => {
    expect(settingsProblem('tng', { lock: 'calc' })).toContain('nur bei TonUINO 2.1');
    expect(settingsGuide('tng', { lock: 'calc' }).ok).toBe(false);
  });

  it('refuses “Box hält an, wenn die Karte weg ist” with a German reason', () => {
    const r = settingsGuide('classic21', { pauseWhenCardRemoved: true });
    expect(r).toEqual({ ok: false, reason: 'TonUINO 2.1 kennt „Box hält an, wenn die Karte weg ist“ nicht. Das gibt es nur bei TonUINO TNG.' });
    expect(settingsGuide('classic21', { pauseWhenCardRemoved: false }).ok).toBe(false);
  });

  it('sets a Kurzwahl: the folder first, then the mode', () => {
    const g = guide(settingsGuide('classic21', { shortcut: { slot: 1, folder: 12, mode: 3 } }, known(factory())));
    const hears = g.steps.map((s) => s.hear);
    expect(hears).toContain('„Pausetaste“');
    expect(hears.indexOf('„12“')).toBeLessThan(hears.indexOf('„Party Modus …“'));
    const box = follow('classic21', factory(), g);
    expect(box.problems).toEqual([]);
    expect(box.s.shortcuts).toEqual({ 1: { folder: 12, mode: 3 } });
    expect(g.steps.at(-1)!.text).toContain('OK. Ich habe die Karte konfiguriert.');
  });

  it('after erasing, the menu opens with the buttons again', () => {
    const locked = { ...factory(), lock: 'card' as const };
    const g = guide(settingsGuide('classic21', { reset: true, standby: 30 }, known(locked)));
    expect(g.steps[0].text).toContain('Admin-Karte');
    const reopen = g.steps.filter((s) => s.kind === 'admin')[1];
    expect(reopen.text).toContain('Reset wurde durchgeführt');
    expect(reopen.presses).toEqual([{ key: 'all', long: true, times: 1 }]);
    const box = follow('classic21', locked, g);
    expect(box.problems).toEqual([]);
    expect(box.s).toMatchObject({ lock: 'buttons', standby: 30 });
  });

  it('locks with a PIN and leaves the menu without a word', () => {
    const pin: PinKey[] = ['down', 'pause', 'pause', 'up'];
    const g = guide(settingsGuide('classic21', { lock: 'pin', pin }, known(factory())));
    expect(g.steps.find((s) => s.text.includes('Bitte gebe die Pin ein'))!.hear).toBeUndefined();
    const box = follow('classic21', factory(), g);
    expect(box.problems).toEqual([]);
    expect(box.s).toMatchObject({ lock: 'pin', pin });
  });

  it('names its own Kurzwahl buttons', () => {
    expect(shortcutSlots('classic21')[0].label).toBe('Play/Pause lang drücken');
    expect(shortcutSlots('tng')[0].label).toBe('Vor und Zurück zusammen lang drücken');
  });
});

describe('volume levels', SLOW, () => {
  const levels: Volumes[] = [];
  for (const max of [2, 3, 8, 12, 20, 25, 30]) {
    for (const min of [1, 2, 5, 9, 15, 19, 29]) {
      if (min >= max) continue;
      for (const init of new Set([min, Math.round((min + max) / 2), max])) levels.push({ max, min, init });
    }
  }

  it('rejects a quietest level at or above the loudest one', () => {
    expect(volumeProblem({ max: 10, min: 10, init: 10 })).toBe('Die leiseste Stufe muss unter der lautesten liegen.');
    expect(volumeProblem({ max: 10, min: 12, init: 11 })).toBe('Die leiseste Stufe muss unter der lautesten liegen.');
    expect(settingsGuide('tng', { volume: { max: 5, min: 8, init: 6 } })).toEqual({ ok: false, reason: 'Die leiseste Stufe muss unter der lautesten liegen.' });
  });

  it('wants whole numbers from 1 to 30 and a start volume in between', () => {
    expect(volumeProblem({ max: 31, min: 5, init: 15 })).toContain('1 bis 30');
    expect(volumeProblem({ max: 25, min: 0, init: 15 })).toContain('1 bis 30');
    expect(volumeProblem({ max: 25, min: 5, init: Number.NaN })).toContain('1 bis 30');
    expect(volumeProblem({ max: 25, min: 5, init: 2.5 })).toContain('1 bis 30');
    expect(volumeProblem({ max: 25, min: 5, init: 26 })).toBe('Die Lautstärke beim Einschalten muss zwischen der leisesten und der lautesten Stufe liegen.');
    expect(volumeProblem({ max: 25, min: 5, init: 4 })).toBe('Die Lautstärke beim Einschalten muss zwischen der leisesten und der lautesten Stufe liegen.');
    expect(volumeProblem({ max: 30, min: 1, init: 1 })).toBeUndefined();
    expect(volumeProblem({ ...FACTORY_SETTINGS.volume })).toBeUndefined();
  });

  it('with known values every guide lands exactly on the wished levels', () => {
    for (const profile of ['tng', 'classic21'] as const) {
      for (const from of levels) {
        for (const to of levels) {
          const start = { ...factory(), volume: { ...from } };
          const g = guide(settingsGuide(profile, { volume: to }, known(start)));
          const box = follow(profile, start, g);
          const where = `${profile} ${JSON.stringify(from)} → ${JSON.stringify(to)}`;
          expect(box.problems, where).toEqual([]);
          expect(box.s.volume, where).toEqual(to);
          expect(box.state, where).toBe('idle');
        }
      }
    }
  });

  it('without known values the family waits for the right number', () => {
    const g = guide(settingsGuide('tng', { volume: { max: 20, min: 1, init: 8 } }));
    const loudest = g.steps.find((s) => s.hear === '„20“')!;
    expect(loudest.text).toBe('Lauteste Stufe: Drücke Vor oder Zurück, bis die Box „20“ sagt. Dann kurz die Play/Pause-Taste.');
    expect(loudest.presses).toBeUndefined();
    expect(g.notes.join(' ')).toContain('weiß nicht');

    // In the order of the factory values, which works unless the loudest level would have to pass the quietest one.
    for (const profile of ['tng', 'classic21'] as const) {
      for (const from of levels) {
        for (const to of levels) {
          const minFirst = to.max <= FACTORY_SETTINGS.volume.min;
          if (minFirst ? to.min >= from.max : to.max <= from.min) continue;
          const start = { ...factory(), volume: { ...from } };
          const box = follow(profile, start, guide(settingsGuide(profile, { volume: to })));
          const where = `${profile} ${JSON.stringify(from)} → ${JSON.stringify(to)}`;
          expect(box.problems, where).toEqual([]);
          expect(box.s.volume, where).toEqual(to);
        }
      }
    }
  });

  it('without known values Vor comes first when the start volume may lie below the new minimum', () => {
    const g = guide(settingsGuide('tng', { volume: { max: 25, min: 5, init: 15 } }));
    expect(g.steps.find((s) => s.hear === '„15“')!.text).toContain('Drücke zuerst einmal kurz Vor');
    const box = follow('tng', { ...factory(), volume: { max: 20, min: 1, init: 3 } }, g);
    expect(box.problems).toEqual([]);
    expect(box.s.volume).toEqual({ max: 25, min: 5, init: 15 });
    // With 1 as the quietest level nothing lies below it.
    const low = guide(settingsGuide('tng', { volume: { max: 20, min: 1, init: 8 } }));
    expect(low.steps.find((s) => s.hear === '„8“')!.text).not.toContain('zuerst');
  });

  it('the sound waits for its name when the box was not read', () => {
    const g = guide(settingsGuide('classic21', { eq: 5 }));
    expect(g.steps.find((s) => s.hear === '„Classic“')!.text).toContain('Drücke Vor oder Zurück');
    expect(follow('classic21', { ...factory(), eq: 2 }, g).s.eq).toBe(5);
  });
});

describe('checks', () => {
  it('refuses what the menus do not offer', () => {
    expect(settingsProblem('tng', { standby: 10 })).toContain('5, 15, 30 oder 60 Minuten');
    expect(settingsProblem('tng', { eq: 7 })).toBe('Diesen Klang kennt die Box nicht.');
    expect(settingsProblem('tng', { lock: 'pin' })).toBe('Wähle alle vier Tasten der PIN.');
    expect(settingsProblem('tng', { lock: 'pin', pin: ['up', 'up', 'up'] })).toBe('Wähle alle vier Tasten der PIN.');
    expect(settingsProblem('tng', { shortcut: { slot: 1, folder: 0, mode: 1 } })).toContain('Ordner');
    expect(settingsProblem('tng', { shortcut: { slot: 5, folder: 1, mode: 1 } })).toContain('Taste');
    expect(settingsProblem('tng', { shortcut: { slot: 1, folder: 1, mode: 5 } })).toContain('Hörspiel, Album oder Party');
    expect(settingsProblem('classic21', { volume: { max: 20, min: 1, init: 8 }, standby: 30, lock: 'calc', eq: 2 })).toBeUndefined();
  });

  it('nothing chosen is nothing to do', () => {
    expect(guide(settingsGuide('tng', {}))).toEqual({ steps: [], notes: [], unchanged: [] });
  });

  it('every step says what the box answers or what to press', () => {
    const wish: SettingsWish = { reset: true, volume: { max: 20, min: 1, init: 8 }, eq: 2, shortcut: { slot: 4, folder: 3, mode: 1 }, standby: 15, shortPressVolume: false, lock: 'pin', pin: ['up', 'down', 'up', 'down'] };
    for (const profile of ['tng', 'classic21'] as const) {
      const g = guide(settingsGuide(profile, wish));
      for (const s of g.steps) {
        expect(s.text.length, s.text).toBeGreaterThan(20);
        expect(s.text, s.text).not.toMatch(/undefined|NaN/);
        if (s.kind === 'menu') expect(s.hear ?? s.presses, s.text).toBeDefined();
      }
      const box = follow(profile, factory(), g);
      expect(box.problems, profile).toEqual([]);
      expect(box.s, profile).toMatchObject({ volume: { max: 20, min: 1, init: 8 }, eq: 2, standby: 15, shortPressVolume: false, lock: 'pin', shortcuts: { 4: { folder: 3, mode: 1 } } });
    }
  });
});
