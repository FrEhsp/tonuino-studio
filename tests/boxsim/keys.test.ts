/**
 * Keys, knob and headphones against the real TNG firmware (TODO #66): the
 * admin keys of adminkeys.ts really open the menu, the reset keys at power
 * on really erase the settings, „Tasten und Teile testen“ ticks every row
 * when its instructions are followed, the Extras view names the cause of a
 * volume change, and the volume stops at the limits. Runs with
 * `npm run test:boxsim`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeBootLog } from '../../src/core/firmware/bootlog';
import { ExtrasLogWatcher, type ExtrasEvent } from '../../src/core/firmware/extraslog';
import { adminKeyCombos, RESET_KEYS, type KeyName } from '../../src/core/tonuino/adminkeys';
import { BoxTest } from '../../src/features/workshop/boxtest';
import { allArrived, instruction, PartsTest, type ButtonKey } from '../../src/features/workshop/partstest';
import { BoxSim, canSimulate } from './boxsim';
import { spoken } from './guide';

let sim: BoxSim | undefined;
afterEach(async () => {
  await sim?.stop();
  sim = undefined;
});

async function boot(build: string, args: string[] = []): Promise<BoxSim> {
  sim = BoxSim.start({ build, args });
  await sim.until('enter Idle', 60);
  await sim.do('wait 1');
  return sim;
}

/** The box's key names as the simulator calls the pins (TNG buttons.cpp). */
function simKeys(keys: readonly KeyName[] | string, buttons: 3 | 5): string {
  const names = typeof keys === 'string' ? keys.split(/, | und /) : keys;
  const map: Record<string, string> = { 'Play/Pause': 'pause', Vor: 'up', Zurück: 'down', Lauter: buttons === 5 ? 'four' : 'up', Leiser: buttons === 5 ? 'five' : 'down' };
  return names.map((n) => map[n]).join('+');
}

describe.skipIf(!canSimulate)('Admin-Menü and reset keys (adminkeys.ts)', () => {
  it.each([
    ['classic-3', 3],
    ['classic-5', 5],
  ] as const)('%s: every combination of adminKeyCombos opens the menu', async (build, buttons) => {
    const s = await boot(build);
    const combos = adminKeyCombos('tng', buttons);
    expect(combos.length).toBe(buttons === 5 ? 2 : 1);
    for (const combo of combos) {
      const from = s.events.length;
      // TNG answers while the keys are still held (adminOpenText).
      await s.do(`hold ${simKeys(combo, buttons)}`);
      expect(await s.waitFor('Willkommen im Admin Menü', 3), `${combo.join('+')}\n${s.dump(30)}`).toBe(true);
      await s.do('release all');
      expect(s.boxLines(from)).toContain('enter AdmEntry');
      await s.script('wait 1\npress pause long\nuntil enter Idle 15\nwait 1');
    }
  });

  it('RESET_KEYS held at power on erase the settings', async () => {
    const s = await boot('classic-5');
    // Change something first: the volume limit in the admin menu.
    await s.script(`
      press pause+up+down long
      wait 1
      press up
      wait 0.5
      press up
      wait 0.5
      press pause
      wait 1
      press down
      wait 0.5
      press pause
      wait 2
      press pause long
      wait 2
      power cycle
      until enter Idle 60`);
    let from = s.events.length;
    const changed = analyzeBootLog(s.boxText(Math.max(0, from - 40))).info.settings.speakerVolume;
    expect(changed?.max).toBe(24);

    from = s.events.length;
    await s.script(`
      power off
      hold ${simKeys(RESET_KEYS, 5)}
      power on
      until enter Idle 60
      release all
      wait 1`);
    const after = analyzeBootLog(s.boxText(from));
    expect(s.boxLines(from).join('\n')).toMatch(/clEEPROM|reset/i);
    expect(after.info.settings.speakerVolume).toEqual({ max: 25, min: 5, init: 15 });
  });
});

/** Follows the guide of „Tasten und Teile testen“ row by row, as instruction() says. */
async function partsTest(s: BoxSim): Promise<{ test: PartsTest; done: string[] }> {
  const test = new PartsTest();
  test.seed(analyzeBootLog(s.boxText()).info);
  const stop = s.onEvent((e) => e.tag === 'box' && test.observe(e.text, Math.round(e.t * 1000)));
  const done: string[] = [];
  try {
    for (let n = 0; n < 20; n++) {
      const row = test.current();
      if (!row) break;
      const say = instruction(test, row).say;
      done.push(say);
      if (row.kind === 'card' || row.kind === 'sound') {
        await s.do('card classic uid=a7a7a7a7 tonuino=1,2');
        await s.until('enter Play', 10);
      } else if (row.kind === 'volume') {
        const sub = instruction(test, row).sub;
        await s.do(sub.includes('Lauter') ? 'press four' : sub.startsWith('Halte') ? 'press up long' : 'press up');
      } else {
        const [key, press] = row.id.split(':') as [ButtonKey, 'short' | 'long'];
        await s.do(`press ${key} ${press}`);
      }
      await s.do('wait 1');
      if (test.current()?.id === row.id) break;
    }
  } finally {
    stop();
  }
  return { test, done };
}

describe.skipIf(!canSimulate)('Tasten und Teile testen (partstest.ts)', () => {
  it.each(['classic-3', 'classic-5'])('%s: every row arrives when its instruction is followed', async (build) => {
    const s = await boot(build);
    const { test, done } = await partsTest(s);
    const open = test.rows().filter((r) => r.at === undefined).map((r) => r.label);
    expect(open, `${done.join('\n')}\n${s.dump(40)}`).toEqual([]);
    expect(allArrived(test)).toBe(true);
    expect(test.others).toEqual([]);
  });
});

describe.skipIf(!canSimulate)('Box testen (boxtest.ts), guided from the start to the result', () => {
  it('classic-3-encoder: keys, card, sound and the knob', async () => {
    const s = await boot('classic-3-encoder');
    const t = new BoxTest({ platine: 'classic', tasten: 3, kopfhoerer: false, ring: false, knopf: true, knopfArt: 'encoder', akku: false });
    const stop = s.onEvent((e) => e.tag === 'box' && t.zeile(e.text, Math.round(e.t * 1000)));
    try {
      // Connecting restarts the box.
      t.verbindet(Math.round((s.events.at(-1)?.t ?? 0) * 1000));
      await s.script('reset\nuntil enter Idle 60\nwait 1');
      expect(t.gestartet).toBe(true);
      expect(t.befunde.size, JSON.stringify(t.befunde.list())).toBe(0);
      t.weiter();
      expect(t.schritt).toBe('tasten');
      // „Drück kurz auf …“, one key after the other.
      for (let want = t.wantTaste(), n = 0; want && n < 5; want = t.wantTaste(), n++) await s.script(`press ${want.key}\nwait 1`);
      expect(t.tasten().map((k) => k.status)).toEqual(['ok', 'ok', 'ok']);
      expect(t.schritt).toBe('karte');
      // The knob does nothing while the box is idle: it is no knob turn yet.
      await s.script('turn right\nwait 1');
      expect(t.teilStatus('knopf')).toBe('offen');
      await s.script('card classic uid=a7a7a7a7 tonuino=1,2\nuntil enter Play 10\nwait 1');
      expect(t.teilStatus('leser')).toBe('ok');
      expect(t.schritt).toBe('ton');
      expect(t.teilStatus('mp3')).toBe('ok');
      t.antwort('lautsprecher', true, 0);
      t.weiter();
      expect(t.schritt).toBe('extras');
      expect(t.extraJetzt()).toBe('knopf');
      await s.script('turn right\nwait 1\nturn left\nwait 1');
      expect(t.teilStatus('knopf')).toBe('ok');
      expect(t.befunde.size, JSON.stringify(t.befunde.list())).toBe(0);
    } finally {
      stop();
    }
  });
});

describe.skipIf(!canSimulate)('Extras: knob and headphones (extraslog.ts)', () => {
  it('encoder: a turn is a knob change, a held key a button change', async () => {
    const s = await boot('classic-3-encoder');
    const watcher = new ExtrasLogWatcher({ knob: 'encoder' });
    const events: ExtrasEvent[] = [];
    for (const e of s.events) if (e.tag === 'box') watcher.push(e.text, Math.round(e.t * 1000));
    const stop = s.onEvent((e) => {
      if (e.tag !== 'box') return;
      const ev = watcher.push(e.text, Math.round(e.t * 1000));
      if (ev) events.push(ev);
    });
    await s.script('card classic uid=a7a7a7a7 tonuino=1,2\nuntil enter Play 10\nwait 1\nturn right\nwait 1\nturn right\nwait 1\nturn left\nwait 1');
    const knob = events.filter((e) => e.kind === 'volume');
    expect(knob.map((e) => (e.kind === 'volume' ? [e.volume, e.cause] : [])), s.dump(40)).toEqual([
      [16, 'knob'],
      [17, 'knob'],
      [16, 'knob'],
    ]);
    // With 3 keys and the factory setting (short press = volume) a short press on Vor logs the
    // same line as a turn ("btn/cmd: up/volume_up"): the log cannot tell them apart.
    events.length = 0;
    await s.script('press up\nwait 1');
    stop();
    expect(events.map((e) => (e.kind === 'volume' ? e.cause : e.kind))).toEqual(['knob']);
  });

  it('headphones: plug in and out, each with its own volume', async () => {
    const s = await boot('classic-3-headphones');
    const watcher = new ExtrasLogWatcher();
    const events: ExtrasEvent[] = [];
    const stop = s.onEvent((e) => {
      if (e.tag !== 'box') return;
      const ev = watcher.push(e.text, Math.round(e.t * 1000));
      if (ev) events.push(ev);
    });
    await s.script('hp in\nwait 1\nhp out\nwait 1');
    stop();
    expect(events.filter((e) => e.kind === 'headphones')).toEqual([
      { kind: 'headphones', plugged: true },
      { kind: 'headphones', plugged: false },
    ]);
    expect(events.filter((e) => e.kind === 'volume').every((e) => e.kind === 'volume' && e.cause === 'headphones')).toBe(true);
    expect(watcher.seen.has('headphones')).toBe(true);
  });
});

describe.skipIf(!canSimulate)('volume limits', () => {
  it('3 keys: short presses stop at the loudest and the quietest level', async () => {
    const s = await boot('classic-3');
    await s.script('card classic uid=a7a7a7a7 tonuino=1,2\nuntil enter Play 10');
    for (let i = 0; i < 14; i++) await s.script('press up\nwait 0.3');
    const vols = s.boxLines().filter((l) => l.startsWith('Volume: ')).map((l) => Number(l.slice(8)));
    expect(Math.max(...vols)).toBe(25);
    for (let i = 0; i < 25; i++) await s.script('press down\nwait 0.3');
    const all = s.boxLines().filter((l) => l.startsWith('Volume: ')).map((l) => Number(l.slice(8)));
    expect(Math.min(...all)).toBe(5);
    // The box says nothing about the limit; it only stays there.
    expect(spoken(s.events).filter((t) => /laut|leise/i.test(t))).toEqual([]);
  });
});
