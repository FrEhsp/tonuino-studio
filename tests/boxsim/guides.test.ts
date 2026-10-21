/**
 * „Box einstellen“, Kopfhörer-Grenzen and „Karte an der Box anlernen“ against
 * the real TNG firmware (TODO #66): every step of the app's guide is pressed
 * at the simulated box, the box has to say what the step promises, and in
 * the end the box's own start log (settings) or the card's memory has to
 * show the wish. Runs with `npm run test:boxsim`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeBootLog } from '../../src/core/firmware/bootlog';
import { CARD_COOKIE, type CardData } from '../../src/core/tonuino/card';
import { batchGuide, boxGuide, type BoxStep } from '../../src/core/tonuino/boxguide';
import { FACTORY_SETTINGS, settingsGuide, type BoxSettingValues, type SettingsWish } from '../../src/core/tonuino/settingsguide';
import { valuesFromInfo } from '../../src/features/workshop/BoxSettingsTool';
import { headphoneGuide } from '../../src/features/workshop/headphones';
import { BoxSim, canSimulate } from './boxsim';
import { follow, listen, unheard } from './guide';

let sim: BoxSim | undefined;
afterEach(async () => {
  await sim?.stop();
  sim = undefined;
});

async function boot(build: string, sd?: string, args?: string[]): Promise<BoxSim> {
  sim = BoxSim.start({ build, sd, args });
  await sim.until('enter Idle', 60);
  await sim.do('wait 1');
  return sim;
}

/** Switches the box off and on and reads the settings it prints, as the Box-Logbuch does. */
async function settingsAfterRestart(s: BoxSim): Promise<BoxSettingValues & { raw: ReturnType<typeof analyzeBootLog>['info'] }> {
  const from = s.events.length;
  await s.script('power cycle\nuntil enter Idle 60');
  const { info } = analyzeBootLog(s.boxText(from));
  return { ...valuesFromInfo(info), raw: info };
}

async function run(s: BoxSim, steps: readonly BoxStep[], card?: string, all?: string) {
  const runs = await follow(s, steps, { card, all });
  expect(unheard(runs), s.dump(60)).toEqual([]);
  return runs;
}

const factory: BoxSettingValues = { ...FACTORY_SETTINGS, volume: { ...FACTORY_SETTINGS.volume } };

describe.skipIf(!canSimulate)('Box einstellen', () => {
  it.each([
    ['known from the Steckbrief', factory],
    ['unknown', {}],
  ])('volume, now %s', async (_, now) => {
    const s = await boot('classic-3');
    const r = settingsGuide('tng', { volume: { max: 20, min: 3, init: 8 } }, now, { buttons: 3 });
    if (!r.ok) throw new Error(r.reason);
    await run(s, r.guide.steps);
    const after = await settingsAfterRestart(s);
    expect(after.volume).toEqual({ max: 20, min: 3, init: 8 });
    expect(after.raw.volume).toBe(8);
  });

  it('timer, sound, keys and card removal in one go', async () => {
    const s = await boot('classic-3');
    const wish: SettingsWish = { standby: 15, eq: 4, shortPressVolume: false, pauseWhenCardRemoved: true };
    const r = settingsGuide('tng', wish, factory, { buttons: 3 });
    if (!r.ok) throw new Error(r.reason);
    await run(s, r.guide.steps);
    const after = await settingsAfterRestart(s);
    expect(after).toMatchObject(wish);
    // Unchanged stays unchanged.
    expect(after.volume).toEqual(factory.volume);
    expect(after.lock).toBe('buttons');
  });

  it('five keys: the same guide, opened with Play/Pause, Lauter und Leiser too', async () => {
    const s = await boot('classic-5');
    const r = settingsGuide('tng', { standby: 30, volume: { max: 22, min: 5, init: 12 } }, factory, { buttons: 5 });
    if (!r.ok) throw new Error(r.reason);
    await run(s, r.guide.steps, undefined, 'pause+four+five');
    const after = await settingsAfterRestart(s);
    expect(after).toMatchObject({ standby: 30, volume: { max: 22, min: 5, init: 12 } });
  });

  it('PIN lock, then the next guide opens the menu with that PIN, then reset', async () => {
    const s = await boot('classic-3');
    const pin = ['up', 'down', 'pause', 'up'] as const;
    const r = settingsGuide('tng', { lock: 'pin', pin: [...pin] }, factory, { buttons: 3 });
    if (!r.ok) throw new Error(r.reason);
    await run(s, r.guide.steps);
    let after = await settingsAfterRestart(s);
    expect(after.lock).toBe('pin');
    expect(after.pin).toEqual(pin);

    // The Steckbrief now knows the PIN; the next guide types it in.
    const r2 = settingsGuide('tng', { eq: 6 }, after, { buttons: 3 });
    if (!r2.ok) throw new Error(r2.reason);
    expect(r2.guide.steps.some((st) => /PIN/.test(st.text))).toBe(true);
    // The guide says which keys; the person types the PIN known from the Steckbrief.
    const steps = r2.guide.steps.map((st) => (/Gib deine PIN ein/.test(st.text) ? { ...st, presses: pin.map((key) => ({ key, times: 1 })) } : st));
    await run(s, steps);
    after = await settingsAfterRestart(s);
    expect(after.eq).toBe(6);

    const r3 = settingsGuide('tng', { reset: true }, after, { buttons: 3 });
    if (!r3.ok) throw new Error(r3.reason);
    const steps3 = r3.guide.steps.map((st) => (/Gib deine PIN ein/.test(st.text) ? { ...st, presses: pin.map((key) => ({ key, times: 1 })) } : st));
    await run(s, steps3);
    after = await settingsAfterRestart(s);
    expect(after).toMatchObject(factory);
  });

  it('shortcut: Vor long while idle plays the chosen folder', async () => {
    const s = await boot('classic-3');
    const r = settingsGuide('tng', { shortcut: { slot: 2, folder: 3, mode: 2 } }, factory, { buttons: 3 });
    if (!r.ok) throw new Error(r.reason);
    await run(s, r.guide.steps);
    await s.script('power cycle\nuntil enter Idle 60\nwait 1\npress up long');
    expect(await s.waitFor('play 3-1', 5)).toBe(true);
  });
});

describe.skipIf(!canSimulate)('Kopfhörer-Grenzen', () => {
  it('sets the headphone levels with the headphones plugged in, the speaker keeps its own', async () => {
    const s = await boot('classic-3-headphones');
    await s.do('hp in');
    await s.do('wait 1');
    const r = headphoneGuide('tng', { max: 12, min: 2, init: 6 }, FACTORY_SETTINGS.volume, { buttons: 3 });
    if (!r.ok) throw new Error(r.reason);
    await run(s, r.guide.steps);
    const after = await settingsAfterRestart(s);
    expect(after.raw.settings.headphoneVolume).toEqual({ max: 12, min: 2, init: 6 });
    expect(after.raw.settings.speakerVolume).toEqual(FACTORY_SETTINGS.volume);
  });
});

function cardBytes(c: CardData): number[] {
  return [...CARD_COOKIE, 2, c.folder, c.mode, c.special, c.special2];
}

describe.skipIf(!canSimulate)('Karte an der Box anlernen', () => {
  const cards: [string, CardData][] = [
    ['Hörspiel', { folder: 3, mode: 1, special: 0, special2: 0 }],
    ['Album', { folder: 2, mode: 2, special: 0, special2: 0 }],
    ['Party', { folder: 4, mode: 3, special: 0, special2: 0 }],
    ['Einzel', { folder: 1, mode: 4, special: 7, special2: 0 }],
    ['Hörbuch', { folder: 5, mode: 5, special: 0, special2: 0 }],
    ['Hörspiel von-bis', { folder: 12, mode: 7, special: 2, special2: 9 }],
  ];
  // A new card lies on the box from the start. TNG writes it without selecting it again
  // (chip_card.cpp writeCard), and its polling leaves a card that lies still unselected every
  // second round (ISO 14443-3, the simulator's default): then "Auth failed: 3" and „Oh weh!“ by
  // chance. Whether real cards do that, only a real box shows (docs/BOX-SIMULATOR.md); here the
  // card answers every poll, so the guide itself is what is tested.
  it.each(cards)('%s on a new card', async (_, card) => {
    const s = await boot('classic-3', '1:10,2:10,3:10,4:10,5:10,12:15', ['--reqa-answers']);
    const r = boxGuide(card, 'tng', { start: 'blank', release: 'newer', buttons: 3, trackCount: (f) => (f === 12 ? 15 : 10) });
    if (!r.ok) throw new Error(r.reason);
    await run(s, r.guide.steps, 'classic uid=c0ffee01');
    const known = await s.cards();
    expect(known.get('c0ffee01')?.data.slice(0, 9)).toEqual(cardBytes(card));
  });

  // The card is laid on when the box asks for it, so the box has just selected it: this works
  // also with the strict card of the default.
  it('Album on a used card, through the admin menu, on an Ultralight', async () => {
    const s = await boot('classic-3');
    const card: CardData = { folder: 4, mode: 2, special: 0, special2: 0 };
    const r = boxGuide(card, 'tng', { start: 'reuse', release: 'newer', buttons: 3, trackCount: () => 10 });
    if (!r.ok) throw new Error(r.reason);
    await run(s, r.guide.steps, 'ultralight uid=04a1b2c3d4e5f6 tonuino=1,1');
    const known = await s.cards();
    expect(known.get('04a1b2c3d4e5f6')?.data.slice(0, 9)).toEqual(cardBytes(card));
  });

  it('Einzel cards for tracks 1 to 3 in a row (batchGuide)', async () => {
    const s = await boot('classic-3');
    const r = batchGuide(2, 1, 3, 'tng', { buttons: 3, trackCount: () => 10 });
    if (!r.ok) throw new Error(r.reason);
    const steps = r.guide.steps;
    const cardAt = steps.findIndex((st) => st.kind === 'card');
    // Up to the card step, which here only listens; then one card after the other, each laid on
    // when the box asks for it, as the step says.
    let mark = s.events.length;
    await run(s, [...steps.slice(0, cardAt), { ...steps[cardAt], kind: 'done' }]);
    expect(steps[cardAt].text).toContain('„Bitte lege nun die Karte auf!“ Lege erst dann');
    for (const uid of ['ba7c0001', 'ba7c0002', 'ba7c0003']) {
      expect(await listen(s, mark, '„Bitte lege nun die Karte auf!“'), s.dump(30)).toBe(true);
      mark = s.events.length;
      await s.do(`card classic uid=${uid}`);
      expect(await listen(s, mark, '„OK. Ich habe die Karte konfiguriert.“'), s.dump(30)).toBe(true);
      mark = s.events.length;
      await s.script('card off\nwait 1');
    }
    await run(s, steps.slice(cardAt + 1));
    const known = await s.cards();
    expect([1, 2, 3].map((t) => known.get(`ba7c000${t}`)?.data.slice(0, 9))).toEqual([1, 2, 3].map((t) => cardBytes({ folder: 2, mode: 4, special: t, special2: 0 })));
  });
});
