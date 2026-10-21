/**
 * „Über USB an die Box“ end to end: LogSession (port, lines, the WRITECARD
 * question after connecting) and UsbCardWriter against a pretend TNG box
 * (tests/firmware/tngbox.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LogSession, PROBE_NOTE, keepsLogConnection } from '../../src/features/workshop/logsession';
import { UsbCardWriter, problemText, type UsbCard } from '../../src/features/cards/usbwrite';
import { boxWritesCards, rememberBoxWritesCards } from '../../src/features/workshop/writeability';
import { adminCard, modifierCard } from '../../src/core/tonuino/modes';
import { TngBox } from '../firmware/tngbox';
import { CH340_PORT, until } from '../workshop/fakes';

const fast = { throttleMs: 0, monitor: { readSliceMs: 10 }, probe: { settleMs: 40, quietMs: 20, maxWaitMs: 400, answerMs: 120 }, probeTickMs: 5 };

const sessions: LogSession[] = [];
async function connect(box: TngBox): Promise<LogSession> {
  const s = new LogSession(fast);
  sessions.push(s);
  await s.connect(box, CH340_PORT);
  return s;
}

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.disconnect();
  rememberBoxWritesCards(false);
});

function writerFor(s: LogSession, cards: UsbCard[]): UsbCardWriter {
  const w = new UsbCardWriter(cards, { send: (l) => s.send(l), onLine: (f) => s.onLine(f) }, { startMs: 300 });
  const timer = setInterval(() => w.tick(), 10);
  w.onChange(() => (w.step.kind === 'done' ? clearInterval(timer) : undefined));
  return w;
}

const folder5: UsbCard = { key: 'f5', title: 'Ordner 5', data: { folder: 5, mode: 1, special: 0, special2: 0 } };
const admin: UsbCard = { key: 'admin', title: 'Admin-Karte', data: adminCard() };

describe('asking the box after connecting', () => {
  it('a box with WRITECARD answers ERR: it can write, and the app remembers', async () => {
    const box = new TngBox();
    const s = await connect(box);
    await until(() => s.writeAbility.value === 'yes');
    expect(box.received).toEqual(['WRITECARD CANCEL']);
    expect(s.book.entries.some((e) => e.text === PROBE_NOTE)).toBe(true);
    expect(boxWritesCards.value).toBe(true);
  });

  it('the official TNG stays silent: it cannot', async () => {
    rememberBoxWritesCards(true);
    const box = new TngBox({ writeCard: false });
    const s = await connect(box);
    await until(() => s.writeAbility.value === 'no');
    expect(boxWritesCards.value).toBe(false);
  });

  it('a playing box cannot tell; asked again after a pause it says yes', async () => {
    const box = new TngBox({ bootOnOpen: false });
    box.state = 'Play';
    const s = await connect(box);
    box.say('enter Play');
    await until(() => s.writeAbility.value === 'busy');
    box.pause();
    s.checkWriteAbility();
    await until(() => s.writeAbility.value === 'yes');
  });

  it('keeps the connection for „Karten beschreiben“', () => {
    expect(keepsLogConnection({ page: 'cards' })).toBe(true);
  });
});

describe('writing cards through the box', () => {
  it('writes, waits for the card to come off, and reads it back from the log', async () => {
    const box = new TngBox();
    const s = await connect(box);
    await until(() => s.writeAbility.value === 'yes');
    const w = writerFor(s, [admin, folder5]);
    await w.start(w.firstOpen());
    await until(() => box.received.at(-1) === 'WRITECARD 255,0');
    await until(() => w.step.kind === 'place');
    box.layCard();
    await until(() => w.step.kind === 'remove');
    expect(box.card).toEqual([0x13, 0x37, 0xb3, 0x47, 2, 0, 0xff, 0, 0]);
    box.removeCard();
    await until(() => w.step.kind === 'check');
    expect(w.step).toMatchObject({ kind: 'check', how: 'log' });
    // Laid on again: the box reads it (and plays it).
    box.layCard();
    await until(() => w.step.kind === 'check' && !!w.step.result);
    expect(w.step).toMatchObject({ result: { kind: 'match' } });
    expect(w.outcomes.get('admin')).toBe('checked');

    // The box plays the card now: the next one gets no answer until the music stops.
    box.removeCard();
    await w.next();
    await until(() => box.received.at(-1) === 'WRITECARD 1,5');
    await until(() => w.step.kind === 'problem');
    expect(w.step).toMatchObject({ problem: 'no-answer' });
    expect(problemText('no-answer').text).toMatch(/Musik mit Play\/Pause an, nimm die Karte runter/);
    box.pause();
    await w.start(1);
    await until(() => w.step.kind === 'place');
    box.layCard();
    box.removeCard();
    await until(() => w.step.kind === 'check');
    await w.next();
    expect(w.step.kind).toBe('done');
    expect(w.outcomes.get('f5')).toBe('written');
  });

  it('a card on the reader when the command comes: no answer either', async () => {
    const box = new TngBox();
    const s = await connect(box);
    await until(() => s.writeAbility.value === 'yes');
    box.cardOn = true;
    const w = writerFor(s, [folder5]);
    await w.start(0);
    await until(() => w.step.kind === 'problem');
    expect(w.step).toMatchObject({ problem: 'no-answer' });
  });

  it('counts OK after "MIFARE_Write failed" as failure', async () => {
    const box = new TngBox();
    const s = await connect(box);
    await until(() => s.writeAbility.value === 'yes');
    const w = writerFor(s, [folder5]);
    box.failNext = 'write';
    await w.start(0);
    await until(() => w.step.kind === 'place');
    box.layCard();
    await until(() => w.step.kind === 'remove');
    box.removeCard();
    await until(() => w.step.kind === 'problem');
    expect(w.step).toMatchObject({ problem: 'failed', detail: 'MIFARE_Write  failed: 3' });
    expect(w.outcomes.get('f5')).toBe('failed');
  });

  it('the AiO logs no card lines: done after OK, the user listens', async () => {
    const box = new TngBox({ quietCardLog: true });
    const s = await connect(box);
    await until(() => s.writeAbility.value === 'yes');
    const w = writerFor(s, [folder5]);
    await w.start(0);
    await until(() => w.step.kind === 'place');
    box.layCard();
    box.removeCard();
    await until(() => w.step.kind === 'check');
    expect(w.step).toMatchObject({ how: 'listen' });
    w.confirmCheck(true);
    expect(w.outcomes.get('f5')).toBe('checked');
  });

  it('Abbrechen sends CANCEL; the box stops waiting', async () => {
    const box = new TngBox();
    const s = await connect(box);
    await until(() => s.writeAbility.value === 'yes');
    const w = writerFor(s, [folder5]);
    await w.start(0);
    await until(() => w.step.kind === 'place');
    await w.cancel();
    await until(() => w.step.kind === 'idle');
    await until(() => box.received.at(-1) === 'WRITECARD CANCEL');
    expect(box.state).toBe('Idle');
  });

  it('never sends what the box cannot write exactly', async () => {
    const box = new TngBox();
    const s = await connect(box);
    await until(() => s.writeAbility.value === 'yes');
    const sleep: UsbCard = { key: 'sleep', title: 'Schlummerkarte', data: modifierCard(1, 15) };
    expect(UsbCardWriter.problemOf(sleep.data)).toMatch(/Schlummerkarte/);
    const w = writerFor(s, [sleep, folder5]);
    expect(w.firstOpen()).toBe(1);
    await w.start(0);
    expect(w.step).toMatchObject({ kind: 'problem', problem: 'not-possible' });
    expect(box.received).toEqual(['WRITECARD CANCEL']);
  });
});
