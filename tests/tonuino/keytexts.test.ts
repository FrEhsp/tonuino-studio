/**
 * Every text about the keys of the box, for each box the app can know of:
 * TonUINO TNG or 2.1, three keys, five keys or not known. A box with five
 * keys must never read "drei Tasten" or "alle drei" (Frank, 17.10.2026: TNG
 * with five keys, the Bedienkarte said "Alle drei lang"), and the keys that
 * open the admin menu or erase the settings must be the ones the firmware
 * checks: tests/fixtures/tng/buttons.cpp and commands.cpp, read here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BootLogParser, type BootLogEvent } from '../../src/core/firmware/bootlog';
import { allLongLabel } from '../../src/core/firmware/logexplain';
import { ADMIN_KEYS, RESET_KEYS, adminKeyCombos, adminKeys, adminOpenText, listKeys, type KeyCount, type KeyName } from '../../src/core/tonuino/adminkeys';
import { batchGuide, boxGuide, type AdminAccess, type GuideResult } from '../../src/core/tonuino/boxguide';
import type { FirmwareProfile } from '../../src/core/tonuino/card';
import { manualSections } from '../../src/core/tonuino/manual';
import { adminCard, modifierCard } from '../../src/core/tonuino/modes';
import { settingsGuide } from '../../src/core/tonuino/settingsguide';
import { GLOSSARY } from '../../src/features/help/glossary';
import { HELP_TOPICS, blockTexts } from '../../src/features/help/topics';
import { ADMIN_ACCESS, SETTING_TEXTS } from '../../src/features/settings/options';
import { BUTTONS_PART_HINT, lockDoneNote, noLockText } from '../../src/features/workshop/BoxSettingsTool';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/tng/${name}`, import.meta.url), 'utf8');
const BUTTONS_CPP = fixture('buttons.cpp');
const COMMANDS_CPP = fixture('commands.cpp');

/** What a box with five keys must never say. */
const COUNTED = /\bdrei Tasten\b|\balle drei\b|\ballen drei\b/i;

/* ------------------------------------------------------------------ the firmware */

/** commands.cpp with FIVEBUTTONS: what each raw key does while playing names the key. */
function keyNames(): Record<string, KeyName> {
  const five = COMMANDS_CPP.slice(COMMANDS_CPP.indexOf('#ifdef FIVEBUTTONS'), COMMANDS_CPP.indexOf('#else // Three Button'));
  const byCommand: Record<string, KeyName> = { next: 'Vor', previous: 'Zurück', volume_up: 'Lauter', volume_down: 'Leiser' };
  const names: Record<string, KeyName> = { Pause: 'Play/Pause' };
  for (const m of five.matchAll(/\/\*\s*\d+\s+(up|down|four|five),\s*\*\/\s*,\{([^}]*)\}/g)) {
    // Columns: adm, idle/pause, play, play_invert.
    const play = m[2].split(',')[2].trim().replace('command::', '');
    names[m[1][0].toUpperCase() + m[1].slice(1)] = byCommand[play];
  }
  return names;
}

/** buttons.cpp getCommandRaw(): every key combination that gives allLong, and whether it needs FIVEBUTTONS. */
function firmwareAdminCombos(): { keys: KeyName[]; fiveOnly: boolean }[] {
  const names = keyNames();
  const out: { keys: KeyName[]; fiveOnly: boolean }[] = [];
  let at = BUTTONS_CPP.indexOf('ret = commandRaw::allLong;');
  while (at >= 0) {
    const start = BUTTONS_CPP.lastIndexOf('if (', at);
    const cond = BUTTONS_CPP.slice(start, at);
    const keys = [...cond.matchAll(/button(\w+)\s*\.isPressed\(\)/g)].map((m) => names[m[1]]);
    const before = BUTTONS_CPP.slice(0, start);
    out.push({ keys, fiveOnly: before.lastIndexOf('#ifdef FIVEBUTTONS') > before.lastIndexOf('#endif') });
    at = BUTTONS_CPP.indexOf('ret = commandRaw::allLong;', at + 1);
  }
  return out;
}

/** buttons.cpp isReset(), called at power-on by Tonuino::setup(): the keys that erase the settings. */
function firmwareResetKeys(): { keys: KeyName[]; fiveOnly: boolean } {
  const body = /bool Buttons::isReset\(\) \{([\s\S]*?)\n\}/.exec(BUTTONS_CPP)![1];
  return { keys: [...body.matchAll(/button(\w+)Pin/g)].map((m) => keyNames()[m[1]]), fiveOnly: body.includes('FIVEBUTTONS') };
}

const sorted = (combos: readonly (readonly string[])[]) => combos.map((c) => [...c].sort().join('+')).sort();

describe('the keys of the admin menu, as TNG checks them', () => {
  it('reads the fixture: Vor is buttonUp, Lauter buttonFour', () => {
    expect(keyNames()).toEqual({ Pause: 'Play/Pause', Up: 'Vor', Down: 'Zurück', Four: 'Lauter', Five: 'Leiser' });
  });

  it('names the combinations of allLong for three keys and for five', () => {
    const fw = firmwareAdminCombos();
    expect(fw.length).toBe(2);
    const three = fw.filter((c) => !c.fiveOnly).map((c) => c.keys);
    expect(sorted(adminKeyCombos('tng', 3))).toEqual(sorted(three));
    expect(sorted(adminKeyCombos('tng', 5))).toEqual(sorted(fw.map((c) => c.keys)));
    // Not knowing the keys, the app names the combination every box has.
    expect(sorted(adminKeyCombos('tng'))).toEqual(sorted(three));
    // TonUINO 2.1 (Tonuino.ino, loop()): Pause, Up and Down only, with five keys as well.
    expect(adminKeyCombos('classic21', 5)).toEqual([['Play/Pause', 'Vor', 'Zurück']]);
  });

  it('erases the settings at power-on with Play/Pause, Vor and Zurück, also with five keys', () => {
    const fw = firmwareResetKeys();
    expect(fw.fiveOnly).toBe(false);
    expect(RESET_KEYS).toBe(listKeys(fw.keys));
  });
});

/* ------------------------------------------------------------------ the texts */

const PROFILES: FirmwareProfile[] = ['tng', 'classic21'];
const KEYS: (KeyCount | undefined)[] = [3, 5, undefined];

function steps(r: GuideResult): string[] {
  if (!r.ok) throw new Error(r.reason);
  return [...r.guide.steps.map((s) => s.text), ...r.guide.notes];
}

/** The admin step of the guides: the text that opens the menu by keys. */
function adminStep(profile: FirmwareProfile, buttons: KeyCount | undefined): string {
  const r = boxGuide({ folder: 3, mode: 2, special: 0, special2: 0 }, profile, { start: 'reuse', access: 'buttons', buttons });
  if (!r.ok) throw new Error(r.reason);
  return r.guide.steps.find((s) => s.kind === 'admin')!.text;
}

/** Everything the app says about the keys for this box. */
function boxTexts(profile: FirmwareProfile, buttons: KeyCount | undefined): string[] {
  const out: string[] = [];
  const card = { folder: 3, mode: 2, special: 0, special2: 0 };
  for (const access of ['buttons', 'pin', 'card', 'calc'] as AdminAccess[]) {
    out.push(...steps(boxGuide(card, profile, { start: 'reuse', access, buttons })));
    out.push(...steps(boxGuide(modifierCard(1, 5), profile, { start: 'blank', access, buttons })));
    out.push(...steps(batchGuide(3, 1, 4, profile, { access, buttons })));
    out.push(lockDoneNote(access, profile, buttons));
  }
  out.push(...steps(boxGuide(card, profile, { start: 'blank', buttons })));
  out.push(...steps(boxGuide(adminCard(), profile, { start: 'blank', buttons })));
  out.push(...steps(settingsGuide(profile, { reset: true, standby: 30, lock: 'pin', pin: ['pause', 'up', 'down', 'up'] }, {}, { buttons })));
  out.push(...steps(settingsGuide(profile, { shortPressVolume: false, eq: 2 }, { lock: 'pin' }, { buttons })));
  out.push(noLockText(profile, buttons), adminKeys(profile, buttons), adminOpenText(profile, buttons));
  if (buttons === undefined) out.push(BUTTONS_PART_HINT);
  else {
    for (const shortPressVolume of [true, false]) {
      for (const lock of [undefined, 'card', 'pin'] as const) {
        for (const s of manualSections({ profile, buttons, shortPressVolume, lock, standby: 15 })) out.push(s.title, ...s.rows.flatMap((r) => [r.what, r.does]));
      }
    }
  }
  return out;
}

/** The Box-Logbuch explaining a TNG start and a press of the admin keys. */
function logTexts(buttons: '3' | '5' | '3x3' | undefined): string[] {
  const events: BootLogEvent[] = [];
  const parser = new BootLogParser({ onEvent: (e) => events.push(e) });
  const lines = ['TonUINO Version 3.3.3', 'V3.3.3 17.09.26', ...(buttons ? [`A+ ${buttons}`] : []), 'IB: 1', 'IB: 0', 'AL: 0', 'btn/cmd: allLong/admin', 'btn/cmd: updownLong/to_first'];
  parser.push(lines.join('\n') + '\n');
  parser.flush();
  return events.flatMap((e) => (e.type === 'line' && e.explanation ? [e.explanation.title, e.explanation.explanation, e.explanation.fix ?? ''] : []));
}

/** Texts that are the same for every box: help, glossary, settings. */
function staticTexts(): string[] {
  return [
    ...HELP_TOPICS.flatMap((t) => [t.title, t.summary, ...t.sections.flatMap((s) => [s.title, s.summary ?? '', ...s.blocks.flatMap(blockTexts)])]),
    ...GLOSSARY.map((g) => g.text),
    ...Object.values(SETTING_TEXTS).flatMap((t) => [t.label, t.hint, ...t.more]),
    ...ADMIN_ACCESS.flatMap((a) => [a.label, a.short ?? '']),
  ];
}

describe('texts about the keys', () => {
  for (const profile of PROFILES) {
    for (const buttons of KEYS) {
      it(`${profile}, ${buttons ?? 'unbekannt'} Tasten: names the keys of the admin menu the firmware checks`, () => {
        const text = adminStep(profile, buttons);
        for (const combo of adminKeyCombos(profile, buttons)) expect(text).toContain(listKeys(combo));
        if (!(profile === 'tng' && buttons === 5)) expect(text).not.toMatch(/Lauter|Leiser/);
        expect(text).toContain(ADMIN_KEYS);
      });
    }
    it(`${profile}, 5 Tasten: never counts three keys`, () => {
      const bad = boxTexts(profile, 5).filter((t) => COUNTED.test(t));
      expect(bad).toEqual([]);
    });
  }

  it('TNG with five keys: the guide, the lock choice and the note after "Erledigt" give both ways in', () => {
    const both = ['Play/Pause, Vor und Zurück', 'Play/Pause, Lauter und Leiser'];
    for (const text of [adminStep('tng', 5), noLockText('tng', 5), lockDoneNote('buttons', 'tng', 5)]) for (const k of both) expect(text).toContain(k);
    // The PIN takes Play/Pause, Vor and Zurück only (commands.cpp getButtonCode).
    const pin = boxGuide({ folder: 3, mode: 2, special: 0, special2: 0 }, 'tng', { start: 'reuse', access: 'pin', buttons: 5 });
    expect(pin.ok && pin.guide.steps.map((s) => s.text).join(' ')).toContain('Lauter und Leiser zählen nicht');
  });

  it('the Box-Logbuch names the admin keys from the keys of the box', () => {
    const five = logTexts('5');
    expect(five.filter((t) => COUNTED.test(t))).toEqual([]);
    expect(five).toContain(`Taste: ${allLongLabel('5')}`);
    expect(allLongLabel('5')).toContain('Play/Pause + Lauter + Leiser');
    // commands.cpp before TNG of 26.10.2026: no play_invert with FIVEBUTTONS, the setting IB does nothing.
    expect(five.join(' ')).toMatch(/Gilt bei dieser Firmware nur für 3 Tasten/);
    const three = logTexts('3');
    expect(three).toContain('Taste: Play/Pause + Vor + Zurück lang');
    expect(three.join(' ')).not.toMatch(/Lauter \+ Leiser/);
    expect(logTexts('3x3')).toContain('Taste: Play/Pause + Vor + Zurück lang');
    expect(logTexts(undefined).filter((t) => COUNTED.test(t))).toEqual([]);
  });

  it('help, glossary and settings speak for every box: keys named, not counted', () => {
    const texts = staticTexts();
    expect(texts.filter((t) => COUNTED.test(t))).toEqual([]);
    // The erase at power-on: the keys of isReset().
    expect(texts.join('\n')).toContain(`beim Einschalten ${RESET_KEYS} gedrückt`);
  });

  it('no source file counts the keys of the admin menu', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
      });
    const hits = files(root).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (/\bdrei Tasten\b|\balle drei (lang|zugleich|zusammen|gleichzeitig)\b|\ballen drei Tasten\b/i.test(line) ? [`${f.slice(root.length)}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
