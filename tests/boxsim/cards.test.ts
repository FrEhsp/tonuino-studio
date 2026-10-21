/**
 * Cards at the real TNG firmware (TODO #66): „Kartenleser testen“ round by
 * round, and the quick card change of TNG issue 347 with the workaround the
 * help gives. Runs with `npm run test:boxsim`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeBootLog } from '../../src/core/firmware/bootlog';
import { cardVerdict, overallVerdict, ReaderTest, resultOf } from '../../src/features/workshop/readertest';
import { BoxSim, canSimulate } from './boxsim';

let sim: BoxSim | undefined;
afterEach(async () => {
  await sim?.stop();
  sim = undefined;
});

const ms = (s: BoxSim) => Math.round((s.events.at(-1)?.t ?? 0) * 1000);

/** Runs „Kartenleser testen“ with one card per entry, laying it on and off as the test asks. */
async function readerTest(s: BoxSim, cards: string[], rounds = 3): Promise<ReaderTest> {
  const t = new ReaderTest({ rounds });
  const stop = s.onEvent((e) => e.tag === 'box' && t.observe(e.text, Math.round(e.t * 1000)));
  try {
    t.connected(ms(s));
    await s.script('reset\nuntil enter Idle 60\nwait 1');
    t.tick(ms(s));
    expect(t.phase.kind).toBe('reader-done');
    t.startCards();
    for (const [i, card] of cards.entries()) {
      if (i > 0) t.nextCard();
      t.startCard('', ms(s));
      let on = false;
      for (let n = 0; n < 600; n++) {
        const p = t.phase.kind;
        if (p === 'card-done' || p === 'results') break;
        if (p === 'lay' && !on) {
          await s.do(`card ${card}`);
          on = true;
        } else if ((p === 'remove' || p === 'clear') && on) {
          await s.do('card off');
          on = false;
        }
        await s.do('wait 0.1');
        t.tick(ms(s));
      }
      if (on) await s.do('card off');
      await s.do('wait 1');
      t.tick(ms(s));
    }
    t.finish();
  } finally {
    stop();
  }
  return t;
}

describe.skipIf(!canSimulate)('Kartenleser testen (readertest.ts)', () => {
  it('good cards of every kind read in every round; a wrong key and an old card are named', async () => {
    sim = BoxSim.start({ build: 'classic-3' });
    await sim.until('enter Idle', 60);
    const t = await readerTest(sim, [
      'classic uid=c1000001 tonuino=1,2',
      'ntag215 uid=04c10000000002 tonuino=2,2',
      'ultralight uid=04c10000000003 tonuino=3,2',
      'classic uid=c1000004 key=a0a1a2a3a4a5 tonuino=1,2',
      'classic uid=c1000005 data=1337b347090102000000000000000000',
    ]);
    const r = resultOf(t);
    expect(r.reader.state).toBe('ok');
    const outcomes = t.cards.map((c) => c.rounds.map((x) => x.outcome));
    expect(outcomes, sim.dump(40)).toEqual([
      ['read', 'read', 'read'],
      ['read', 'read', 'read'],
      ['read', 'read', 'read'],
      ['unreadable', 'unreadable', 'unreadable'],
      ['bad-version', 'bad-version', 'bad-version'],
    ]);
    expect(t.cards[1].types).toContain('NTAG215');
    // A card the box cannot open names no type: TNG logs the type only at debug level.
    expect(t.cards.map((c) => c.family)).toEqual(['classic', 'ultralight', 'ultralight', undefined, 'classic']);
    expect(t.cards.map((c) => cardVerdict(c, t.box).kind)).toEqual(['good', 'good', 'good', 'never-read', 'wrong-version']);
    expect(t.reboots).toBe(0);
    // The reader works; one card is the problem.
    expect(overallVerdict(r).kind).toBe('one-card');
  });

  it('a flaky card fails some rounds, the reader is not blamed', async () => {
    sim = BoxSim.start({ build: 'classic-3' });
    await sim.until('enter Idle', 60);
    const t = await readerTest(sim, ['classic uid=c1000001 tonuino=1,2', 'classic uid=c1000006 flaky=0.5 tonuino=1,2'], 5);
    const [good, flaky] = t.cards;
    expect(good.rounds.every((x) => x.outcome === 'read')).toBe(true);
    expect(flaky.rounds.some((x) => x.outcome !== 'read'), sim.dump(40)).toBe(true);
    expect(resultOf(t).reader.state).toBe('ok');
  });
});

describe.skipIf(!canSimulate)('quick card change (TNG issue 347, help topic)', () => {
  it('a new card laid on while the last one starts plays the last one; off and on again helps', async () => {
    sim = BoxSim.start({ build: 'classic-3', sd: '1:10,2:10' });
    await sim.until('enter Idle', 60);
    await sim.script(`
      card classic uid=a0000001 tonuino=1,2
      until enter StartPlay 5
      card off
      wait 0.25
      card classic uid=a0000002 tonuino=2,2
      wait 4`);
    // The bug: card 2 lies on the box ("Card Ins", but no "CardData"), and folder 1 plays.
    let plays = sim.boxLines().filter((l) => /^play \d+-\d+$/.test(l));
    expect(plays.at(-1), sim.dump(60)).toMatch(/^play 1-/);
    // The help's workaround: take the new card off a moment and lay it on again.
    await sim.script('card off\nwait 1\ncard classic uid=a0000002 tonuino=2,2\nwait 4');
    plays = sim.boxLines().filter((l) => /^play \d+-\d+$/.test(l));
    expect(plays.at(-1)).toMatch(/^play 2-/);
    expect(analyzeBootLog(sim.boxText()).issues.filter((i) => i.explanation.level === 'error')).toEqual([]);
  });
});
