import { describe, expect, it } from 'vitest';
import {
  MODIFIER_REASON,
  NOT_EXACT_REASON,
  PROBE_LINE,
  WriteCardProbe,
  WriteCardRun,
  boxWrites,
  classifyLine,
  expectedBytes,
  lineBytes,
  readBack,
  writeCardCommand,
} from '../../src/core/firmware/writecard';
import { adminCard, modifierCard } from '../../src/core/tonuino/modes';
import type { CardData } from '../../src/core/tonuino/card';

const card = (folder: number, mode: number, special = 0, special2 = 0): CardData => ({ folder, mode, special, special2 });

describe('WRITECARD command (TNG issue_345 serial_input.cpp)', () => {
  it('sends exactly the parameters of the mode group', () => {
    expect(writeCardCommand(card(5, 1))).toEqual({ ok: true, line: 'WRITECARD 1,5' });
    expect(writeCardCommand(card(12, 2))).toEqual({ ok: true, line: 'WRITECARD 2,12' });
    expect(writeCardCommand(card(3, 4, 7))).toEqual({ ok: true, line: 'WRITECARD 4,3,7' });
    expect(writeCardCommand(card(9, 8, 2, 5))).toEqual({ ok: true, line: 'WRITECARD 8,9,2,5' });
    expect(writeCardCommand(card(9, 16, 1, 4))).toEqual({ ok: true, line: 'WRITECARD 16,9,1,4' });
    expect(writeCardCommand(card(4, 12, 4, 1))).toEqual({ ok: true, line: 'WRITECARD 12,4,4,1' });
    expect(writeCardCommand(card(6, 10, 2))).toEqual({ ok: true, line: 'WRITECARD 10,6,2' });
    // Endlos and Bluetooth: no parameters, the box writes 255 as folder.
    expect(writeCardCommand(card(0xff, 11))).toEqual({ ok: true, line: 'WRITECARD 11' });
    expect(writeCardCommand(card(0xff, 14))).toEqual({ ok: true, line: 'WRITECARD 14' });
  });

  it('writes the admin card as 255,0, never as the menu’s 6', () => {
    expect(writeCardCommand(adminCard())).toEqual({ ok: true, line: 'WRITECARD 255,0' });
    expect(writeCardCommand(card(5, 6)).ok).toBe(false);
  });

  it('checks the folder itself (the firmware does not)', () => {
    expect(writeCardCommand(card(0, 1))).toEqual({ ok: false, reason: MODIFIER_REASON });
    expect(writeCardCommand(card(100, 1))).toMatchObject({ ok: false, reason: expect.stringContaining('1 bis 99') });
    expect(writeCardCommand(card(99, 1)).ok).toBe(true);
    expect(writeCardCommand(card(1, 1)).ok).toBe(true);
  });

  it('refuses modifier cards and unknown modes', () => {
    expect(writeCardCommand(modifierCard(1, 15))).toEqual({ ok: false, reason: MODIFIER_REASON });
    expect(writeCardCommand(card(3, 17)).ok).toBe(false);
    expect(writeCardCommand(card(3, 0)).ok).toBe(false);
  });

  it('refuses what the box would answer with ERR, before sending', () => {
    expect(writeCardCommand(card(3, 4, 0)).ok).toBe(false);
    expect(writeCardCommand(card(3, 8, 5, 2)).ok).toBe(false);
    expect(writeCardCommand(card(3, 12, 3, 0)).ok).toBe(false);
    expect(writeCardCommand(card(3, 10, 30)).ok).toBe(false);
  });

  it('refuses cards the command cannot carry instead of writing them differently', () => {
    // Hörbuch over folders 3-5: the box reads only the folder for mode 5.
    expect(writeCardCommand(card(3, 5, 0, 2))).toEqual({ ok: false, reason: NOT_EXACT_REASON });
    expect(writeCardCommand(card(3, 5)).ok).toBe(true);
    // One track of a Hörbuch per placement over two folders: special2 gets lost.
    expect(writeCardCommand(card(3, 10, 1, 1))).toEqual({ ok: false, reason: NOT_EXACT_REASON });
    // The old card format (TonUINO 2.0): the box writes version 2.
    expect(writeCardCommand({ ...card(3, 1), version: 1 }).ok).toBe(false);
  });

  it('boxWrites follows the firmware, wrapping over 255', () => {
    expect(boxWrites(1, [300])).toEqual({ version: 2, folder: 44, mode: 1, special: 0, special2: 0 });
    expect(boxWrites(11, [])).toMatchObject({ folder: 0xff, mode: 11 });
    expect(boxWrites(255, [0])).toMatchObject({ folder: 0, mode: 255 });
    expect(boxWrites(0, [3])).toBeUndefined();
  });

  it('ends every line with \\n', () => {
    expect(new TextDecoder().decode(lineBytes(PROBE_LINE))).toBe('WRITECARD CANCEL\n');
  });
});

describe('lines of the box', () => {
  it('knows the answers, the start and the card lines', () => {
    expect(classifyLine('WRITECARD: OK')).toEqual({ kind: 'answer', ok: true });
    expect(classifyLine('WRITECARD: ERR')).toEqual({ kind: 'answer', ok: false });
    // Older states of the fork.
    expect(classifyLine('WRITECARD: ERROR')).toEqual({ kind: 'answer', ok: false });
    expect(classifyLine('enter WriteC')).toEqual({ kind: 'started' });
    expect(classifyLine('enter Idle')).toEqual({ kind: 'state', state: 'Idle' });
    expect(classifyLine('Writing: 13 37 B3 47 02 05 01 00 00 ')).toEqual({ kind: 'writing', bytes: [0x13, 0x37, 0xb3, 0x47, 2, 5, 1, 0, 0] });
    expect(classifyLine('Auth  failed: 3')).toMatchObject({ kind: 'write-failed' });
    expect(classifyLine('MIFARE_Write  failed: 3')).toMatchObject({ kind: 'write-failed' });
    expect(classifyLine('CardData: 13 37 B3 47 02 05 01 00 00 ')).toMatchObject({ kind: 'card-data' });
    expect(classifyLine('TonUINO Version 3.x - refactored by Boerge1')).toEqual({ kind: 'boot' });
    expect(classifyLine('btn/cmd: w_c_ser/w_c_ser')).toBeUndefined();
    expect(classifyLine('MIFARE_Read  failed: 3')).toBeUndefined();
  });
});

describe('asking the box after connecting (WRITECARD CANCEL)', () => {
  const opts = { settleMs: 2500, quietMs: 700, maxWaitMs: 9000, answerMs: 1500 };

  it('waits for the start to settle, then asks once; ERR means yes', () => {
    const p = new WriteCardProbe(0, opts);
    p.observe('TonUINO Version 3.x - refactored by Boerge1', 300);
    p.observe('enter Idle', 2200);
    expect(p.due(2400)).toBe(false);
    expect(p.due(2600)).toBe(false); // quiet only since 2200
    expect(p.due(2950)).toBe(true);
    p.sent(2950);
    expect(p.due(3000)).toBe(false);
    expect(p.observe('btn/cmd: w_c_c_ser/w_c_c_ser', 3000)).toBe(false);
    expect(p.observe('WRITECARD: ERR', 3001)).toBe(true);
    expect(p.result).toBe('yes');
  });

  it('no answer while idle means no, and that is certain', () => {
    const p = new WriteCardProbe(0, opts);
    p.observe('enter Idle', 1000);
    p.sent(3000);
    expect(p.tick(4000)).toBe(false);
    expect(p.tick(4500)).toBe(true);
    expect(p.result).toBe('no');
    expect(p.certain).toBe(true);
  });

  it('no answer while playing cannot tell', () => {
    const p = new WriteCardProbe(0, opts);
    p.observe('enter Play', 1000);
    p.sent(3000);
    p.tick(4600);
    expect(p.result).toBe('busy');
  });

  it('a box that keeps talking is asked after maxWaitMs; without any state the no is not certain', () => {
    const p = new WriteCardProbe(0, opts);
    for (let t = 0; t < 9000; t += 100) p.observe('Volume: 5', t);
    expect(p.due(8950)).toBe(false);
    expect(p.due(9000)).toBe(true);
    p.sent(9000);
    p.tick(10600);
    expect(p.result).toBe('no');
    expect(p.certain).toBe(false);
  });

  it('asks again when the box restarts before answering', () => {
    const p = new WriteCardProbe(0, opts);
    p.sent(3000);
    p.observe('TonUINO Version 3.x - refactored by Boerge1', 3100);
    expect(p.tick(5000)).toBe(false);
    expect(p.due(5000)).toBe(true);
  });
});

describe('one card written by the box', () => {
  const c = card(5, 1);
  const feed = (run: WriteCardRun, lines: string[]) => lines.forEach((l, i) => run.observe(l, 100 + i));

  it('OK after "Writing" is done, with the bytes the box wrote', () => {
    const run = new WriteCardRun(c, 0);
    feed(run, ['btn/cmd: w_c_ser/w_c_ser', 'enter WriteC']);
    expect(run.phase.kind).toBe('place-card');
    feed(run, ['play mp3 800', 'Writing: 13 37 B3 47 02 05 01 00 00 ']);
    expect(run.phase.kind).toBe('remove-card');
    feed(run, ['play mp3 400', 'WriteC -> finished', 'WRITECARD: OK']);
    expect(run.phase).toEqual({ kind: 'done', logged: expectedBytes(c) });
  });

  it('OK without "Writing" (AiO) is done too, without logged bytes', () => {
    const run = new WriteCardRun(c, 0);
    feed(run, ['enter WriteC', 'play mp3 800', 'play mp3 400', 'WRITECARD: OK']);
    expect(run.phase).toEqual({ kind: 'done' });
  });

  it('OK after an error line is a failure: the firmware says OK either way', () => {
    for (const err of ['MIFARE_Write  failed: 3', 'Auth  failed: 3']) {
      const run = new WriteCardRun(c, 0);
      feed(run, ['enter WriteC', err, 'play mp3 401', 'WRITECARD: OK']);
      expect(run.phase).toEqual({ kind: 'failed', detail: err });
    }
  });

  it('other bytes than wanted count as failure', () => {
    const run = new WriteCardRun(c, 0);
    feed(run, ['enter WriteC', 'Writing: 13 37 B3 47 02 06 01 00 00 ', 'WRITECARD: OK']);
    expect(run.phase.kind).toBe('failed');
  });

  it('ERR at once is a refusal, ERR after the start a cancel', () => {
    const refused = new WriteCardRun(c, 0);
    feed(refused, ['WRITECARD: ERR']);
    expect(refused.phase.kind).toBe('refused');
    const cancelled = new WriteCardRun(c, 0);
    feed(cancelled, ['enter WriteC']);
    cancelled.cancelSent();
    feed(cancelled, ['btn/cmd: pauseLong/adm_end', 'SM abort', 'WRITECARD: ERR']);
    expect(cancelled.phase.kind).toBe('cancelled');
    // A long press on Play/Pause at the box ends it the same way.
    const pressed = new WriteCardRun(c, 0);
    feed(pressed, ['enter WriteC', 'WRITECARD: ERR']);
    expect(pressed.phase.kind).toBe('cancelled');
  });

  it('no start within 3 s: the box plays or a card lies on it', () => {
    const run = new WriteCardRun(c, 0);
    expect(run.tick(2999)).toBe(false);
    expect(run.tick(3000)).toBe(true);
    expect(run.phase.kind).toBe('no-answer');
    // Once it waits for the card, there is no limit (the box has none either).
    const waiting = new WriteCardRun(c, 0);
    feed(waiting, ['enter WriteC']);
    expect(waiting.tick(60_000)).toBe(false);
  });

  it('a restart in between interrupts it', () => {
    const run = new WriteCardRun(c, 0);
    feed(run, ['enter WriteC', 'TonUINO Version 3.x - refactored by Boerge1']);
    expect(run.phase.kind).toBe('interrupted');
  });
});

describe('reading the card back', () => {
  it('compares the CardData line with the card', () => {
    expect(readBack('CardData: 13 37 B3 47 02 05 01 00 00 ', card(5, 1))).toEqual({ kind: 'match' });
    expect(readBack('CardData: 13 37 B3 47 02 05 02 00 00 ', card(5, 1))).toEqual({ kind: 'differs', read: '13 37 B3 47 02 05 02 00 00', want: '13 37 B3 47 02 05 01 00 00' });
    expect(readBack('CardData: 00 00 00 00 00 00 00 00 00 ', adminCard())).toMatchObject({ kind: 'differs' });
    expect(readBack('enter Play', card(5, 1))).toBeUndefined();
  });
});
