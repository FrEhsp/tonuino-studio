/**
 * The app at the USB cable of the real TNG firmware (TODO #66): „Box
 * erkennen“, the settings check after an update, „Kann die Box Karten
 * schreiben?“ and „Über USB an die Box“ with the card written into the
 * simulated card's memory and read back. Runs with `npm run test:boxsim`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { lineBytes, PROBE_LINE, WriteCardProbe } from '../../src/core/firmware/writecard';
import { encodeCard, type CardData } from '../../src/core/tonuino/card';
import { UsbCardWriter, type BoxLink, type UsbCard, type UsbStep } from '../../src/features/cards/usbwrite';
import { judgeSettings, readStartSettings } from '../../src/features/workshop/aftercheck';
import { probeBox } from '../../src/features/workshop/detect';
import { CH340_PORT } from '../workshop/fakes';
import { BoxSim, canSimulate } from './boxsim';
import { listen } from './guide';

let sim: BoxSim | undefined;
afterEach(async () => {
  await sim?.stop();
  sim = undefined;
});

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
/** Simulated milliseconds: the time of the last event. */
const simMs = (s: BoxSim) => Math.round((s.events.at(-1)?.t ?? 0) * 1000);

/** The box's log as logsession.ts hands it to the card writer, in simulated time. */
function link(s: BoxSim): BoxLink {
  return {
    send: async (line) => {
      await s.do(`tx ${hex(lineBytes(line))}`);
    },
    onLine: (listener) => s.onEvent((e) => e.tag === 'box' && listener(e.text, Math.round(e.t * 1000))),
  };
}

describe.skipIf(!canSimulate)('Box erkennen and the settings after an update (real time)', () => {
  it.each([
    ['classic-3', 'classic', '3'],
    ['classic-5', 'classic', '5'],
    ['aio-5', 'aio', '5'],
  ])('%s', async (build, board, buttons) => {
    sim = BoxSim.start({ build, realtime: 1 });
    const probe = await probeBox(sim.serial, CH340_PORT);
    expect(probe.heard).toBe(true);
    expect(probe.info).toMatchObject({ firmware: 'tng', board, buttons });

    const read = await readStartSettings(sim.serial, CH340_PORT);
    expect(read.invalid).toEqual([]);
    const verdict = judgeSettings(read, board as 'classic' | 'aio');
    expect(verdict.silent).toBe(false);
    expect(verdict.facts.find((f) => f.label === 'Lautstärke')?.value).toBe('5 bis 25, beim Einschalten 15');
    // A fresh box has the factory settings; the AiO also gets the battery warning.
    expect(verdict.findings.map((f) => f.tone)).toEqual(board === 'aio' ? ['warning', 'info'] : ['info']);
  });

  it('a box at the wrong speed is heard but not named', async () => {
    sim = BoxSim.start({ build: 'classic-3', realtime: 1 });
    const probe = await probeBox(sim.serial, CH340_PORT, { monitor: { baudRate: 9600 } });
    expect(probe.heard).toBe(true);
    expect(probe.info.board).toBeUndefined();
  });
});

/** Runs the simulation until WriteCardProbe has its answer, as logsession.ts drives it. */
async function probeWriting(s: BoxSim): Promise<WriteCardProbe> {
  await s.do('reset');
  const probe = new WriteCardProbe(simMs(s));
  const stop = s.onEvent((e) => e.tag === 'box' && probe.observe(e.text, Math.round(e.t * 1000)));
  try {
    for (let i = 0; i < 200 && probe.result === 'checking'; i++) {
      await s.do('wait 0.1');
      const now = simMs(s);
      if (probe.due(now)) {
        await s.do(`tx ${hex(lineBytes(PROBE_LINE))}`);
        probe.sent(now);
      }
      probe.tick(simMs(s));
    }
  } finally {
    stop();
  }
  return probe;
}

describe.skipIf(!canSimulate)('Kann die Box Karten schreiben?', () => {
  it('the writeCard build says yes, the normal build no', async () => {
    sim = BoxSim.start({ build: 'classic-3-writeCard' });
    await sim.until('enter Idle', 60);
    expect((await probeWriting(sim)).result).toBe('yes');
    await sim.stop();

    sim = BoxSim.start({ build: 'classic-3' });
    await sim.until('enter Idle', 60);
    const no = await probeWriting(sim);
    expect(no.result).toBe('no');
    expect(no.certain).toBe(true);
  });
});

/** Steps the writer goes through, and the simulation until `until` holds. */
async function drive(s: BoxSim, writer: UsbCardWriter, until: (step: UsbStep) => boolean, seconds = 20): Promise<UsbStep> {
  for (let t = 0; t < seconds && !until(writer.step); t += 0.1) {
    await s.do('wait 0.1');
    writer.tick(simMs(s));
  }
  return writer.step;
}

async function writeOne(s: BoxSim, writer: UsbCardWriter, index: number, card: string): Promise<UsbStep> {
  const { mode, folder } = writer.cards[index].data;
  const admin = mode === 255 && folder === 0;
  await writer.start(index);
  const started = await drive(s, writer, (st) => st.kind !== 'starting');
  expect(started.kind, `${JSON.stringify(started)}\n${s.dump(30)}`).toBe('place');
  const laid = s.events.length;
  await s.do(`card ${card}`);
  expect((await drive(s, writer, (st) => st.kind !== 'place')).kind, s.dump(30)).toBe('remove');
  // UsbPanel: „Lasse die Karte liegen, bis sie „OK. Ich habe die Karte konfiguriert.“ sagt, dann nimm sie ab.“
  expect(await listen(s, laid, '„OK. Ich habe die Karte konfiguriert.“'), s.dump(30)).toBe(true);
  await s.do('card off');
  const done = await drive(s, writer, (st) => st.kind !== 'remove');
  expect(done.kind, s.dump(30)).toBe('check');
  // Laid on again: the box reads it back.
  await s.do(`card ${card}`);
  const checked = await drive(s, writer, (st) => st.kind === 'check' && !!st.result);
  if (admin) {
    // UsbPanel: „Die Box öffnet jetzt das Admin-Menü. Nimm die Karte ab und halt Play/Pause lang gedrückt, bis die Box „OK, ich habe den Vorgang abgebrochen.“ sagt.“
    const from = s.events.length;
    await s.script('wait 2\ncard off\npress pause long');
    expect(await listen(s, from, '„OK, ich habe den Vorgang abgebrochen.“'), s.dump(30)).toBe(true);
  } else {
    // UsbPanel: „Die Box spielt die Karte jetzt ab. Halte die Musik mit Play/Pause an und nimm die Karte ab, bevor die nächste kommt.“
    await s.script('wait 2\npress pause\nwait 1\ncard off\nwait 2');
  }
  return checked;
}

describe.skipIf(!canSimulate)('Über USB an die Box', () => {
  const cards: UsbCard[] = [
    { key: 'a', title: 'Hörspiel 3', data: { folder: 3, mode: 1, special: 0, special2: 0 } },
    { key: 'b', title: 'Einzel 2/7', data: { folder: 2, mode: 4, special: 7, special2: 0 } },
    { key: 'c', title: 'Von-bis 5', data: { folder: 5, mode: 8, special: 2, special2: 6 } },
    { key: 'd', title: 'Admin-Karte', data: { folder: 0, mode: 255, special: 0, special2: 0 } },
    { key: 'e', title: 'Album 4', data: { folder: 4, mode: 2, special: 0, special2: 0 } },
  ];
  const media = ['classic uid=a1000001', 'ntag215 uid=04a10000000002', 'ultralight uid=04a10000000003', 'classic uid=a1000004', 'classic uid=a1000005'];

  it('writes Classic, NTAG and Ultralight cards, the box reads every one back', async () => {
    sim = BoxSim.start({ build: 'classic-3-writeCard' });
    await sim.until('enter Idle', 60);
    await sim.do('wait 2');
    const writer = new UsbCardWriter(cards, link(sim), { now: () => simMs(sim!) });
    for (const [i, card] of media.entries()) {
      const step = await writeOne(sim, writer, i, card);
      expect(step, sim.dump(40)).toMatchObject({ kind: 'check', how: 'log', result: { kind: 'match' } });
    }
    expect([...writer.outcomes.values()]).toEqual(['checked', 'checked', 'checked', 'checked', 'checked']);
    const known = await sim.cards();
    for (const [i, card] of media.entries()) {
      const uid = card.split('uid=')[1];
      expect(known.get(uid)?.data, uid).toEqual([...encodeCard(cards[i].data)]);
    }
    writer.dispose();
  });

  it('Abbrechen while the box waits for the card', async () => {
    sim = BoxSim.start({ build: 'classic-3-writeCard' });
    await sim.until('enter Idle', 60);
    await sim.do('wait 2');
    const writer = new UsbCardWriter(cards, link(sim), { now: () => simMs(sim!) });
    await writer.start(0);
    expect((await drive(sim, writer, (st) => st.kind !== 'starting')).kind).toBe('place');
    await writer.cancel();
    expect((await drive(sim, writer, (st) => st.kind !== 'place')).kind, sim.dump(30)).toBe('idle');
    // Afterwards the box takes the next command.
    const step = await writeOne(sim, writer, 1, 'classic uid=a1000005');
    expect(step).toMatchObject({ kind: 'check', result: { kind: 'match' } });
  });

  it('while music plays the box does not answer: no-answer', async () => {
    sim = BoxSim.start({ build: 'classic-3-writeCard' });
    await sim.until('enter Idle', 60);
    await sim.script('card classic uid=b0000001 tonuino=1,2\nuntil enter Play 10\ncard off\nwait 1');
    const writer = new UsbCardWriter(cards, link(sim), { now: () => simMs(sim!) });
    await writer.start(0);
    expect(await drive(sim, writer, (st) => st.kind !== 'starting')).toMatchObject({ kind: 'problem', problem: 'no-answer' });
  });

  it('a card the box cannot write (wrong key) ends as failed', async () => {
    sim = BoxSim.start({ build: 'classic-3-writeCard' });
    await sim.until('enter Idle', 60);
    await sim.do('wait 2');
    const card: CardData = { folder: 3, mode: 2, special: 0, special2: 0 };
    const writer = new UsbCardWriter([{ key: 'x', title: 'x', data: card }], link(sim), { now: () => simMs(sim!) });
    await writer.start(0);
    await drive(sim, writer, (st) => st.kind !== 'starting');
    const laid = sim.events.length;
    await sim.do('card classic uid=b0000002 key=a0a1a2a3a4a5');
    await drive(sim, writer, (st) => st.kind !== 'place');
    expect(await listen(sim, laid, '„Oh weh! Das hat leider nicht geklappt!“')).toBe(true);
    await sim.do('card off');
    const end = await drive(sim, writer, (st) => st.kind !== 'remove');
    expect(end, sim.dump(30)).toMatchObject({ kind: 'problem', problem: 'failed' });
    expect(writer.outcomes.get('x')).toBe('failed');
  });
});
