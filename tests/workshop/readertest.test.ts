import { describe, expect, it } from 'vitest';
import {
  ReaderLineParser,
  ReaderTest,
  cardStats,
  cardVerdict,
  failureText,
  overallVerdict,
  rateText,
  readerText,
  resultOf,
  resultText,
  type CardResult,
  type TestResult,
} from '../../src/features/workshop/readertest';
import { searchHelp } from '../../src/features/help/search';
import { findSection, helpLinks } from '../../src/features/help/topics';
import { AIOPLUS_BROKEN_LOG, CLASSIC_LOG } from './fakes';

/* ------------------------------------------------------------------ fixtures */

/** Start of a Classic box with TNG 3.3.3 (from fakes.ts), without the card lines at its end. */
const TNG_START = CLASSIC_LOG.split('\r\n').filter((l) => l && !/^(Card Ins|play |Volume)/.test(l));

/** Start of a Classic box with TNG 3.2.0: NTAG215 is not supported yet. */
const TNG320_START = TNG_START.map((l) => (l.startsWith('V3.3.3') ? 'V3.2.0 01.08.24' : l));

/** Start of an AiO (not AiO+): TNG logs no card events and no reader version there. */
const AIO_START = ['TonUINO Version 3.x - refactored by Boerge1', 'V3.3.3 17.09.26', 'A 3', 'Ver:2', 'Vol:25 5 15', 'EQ:1', 'ST:0', 'IB:1', 'AL:0', 'AP:1111', 'PCR:0', 'enter Idle'];

/** Start of TonUINO 2.1 as Tonuino.ino and the MFRC522 library print it. */
const CLASSIC21_START = [
  ' _____         _____ _____ _____ _____',
  '|_   _|___ ___|  |  |     |   | |     |',
  'TonUINO Version 2.1',
  'created by Thorsten Voß and licensed under GNU/GPL.',
  'Information and contribution at https://tonuino.de.',
  'Version: 2',
  'Maximal Volume: 25',
  'Minimal Volume: 5',
  'Initial Volume: 15',
  'EQ: 1',
  'Firmware Version: 0x92 = v2.0',
];

const FOLDER_5 = '13 37 b3 47 02 05 02 00 00';

/** Drives a ReaderTest with a clock: lines arrive at `now`, waiting ticks every 100 ms. */
class Run {
  now = 1_000_000;
  constructor(readonly t: ReaderTest = new ReaderTest()) {}

  lines(lines: string[]): this {
    for (const l of lines) this.t.observe(l, this.now);
    return this;
  }
  wait(ms: number): this {
    for (let left = ms; left > 0; left -= 100) {
      this.now += Math.min(100, left);
      this.t.tick(this.now);
    }
    return this;
  }
  connect(start: string[] = TNG_START): this {
    this.t.connected(this.now);
    this.wait(300).lines(start).wait(200);
    return this;
  }
  card(name = ''): this {
    if (this.t.phase.kind === 'reader-done') this.t.startCards();
    this.t.startCard(name, this.now);
    return this;
  }
  // ---- TNG rounds
  good(data = FOLDER_5, type?: string): this {
    this.wait(400).lines(['Card Ins', ...(type ? [type] : []), `CardData: ${data}`]);
    return this.wait(300).lines(['Card Rem']).wait(700);
  }
  unreadable(error = 'Auth failed: 3', type?: string): this {
    this.wait(400).lines(['Card Ins', ...(type ? [type] : []), error]);
    return this.wait(300).lines(['Card Rem']).wait(700);
  }
  missed(): this {
    return this.wait(6100);
  }
  // ---- TonUINO 2.1 rounds (no "Card Rem")
  good21(type = 'MIFARE 1KB', data = ' 13 37 B3 47 02 05 02 00 00 00 00 00 00 00 00 00'): this {
    this.wait(400).lines(['Card UID: 9A 3F 21 C4', `PICC type: ${type}`, 'Authenticating Classic using key A...', 'Reading data from block 4 ...', 'Data on Card :', data]);
    return this.wait(2600);
  }
  unreadable21(type = 'MIFARE Ultralight or Ultralight C'): this {
    this.wait(400).lines(['Card UID: 04 A2 19 3B 22 51 80', `PICC type: ${type}`, 'Authenticating MIFARE UL...', 'PCD_Authenticate() failed: Timeout in communication.']);
    return this.wait(2600);
  }
  next(): this {
    this.t.nextCard();
    return this;
  }
  get result(): TestResult {
    return resultOf(this.t);
  }
}

function card(outcomes: string, extra: Partial<CardResult> = {}): CardResult {
  const map = {
    r: 'read',
    u: 'unreadable',
    m: 'missed',
    b: 'bad-version',
    f: 'foreign',
  } as const;
  return {
    name: '',
    skipped: 0,
    types: [],
    rounds: [...outcomes].map((c) => ({ outcome: map[c as keyof typeof map] })),
    ...extra,
  };
}

function result(cards: CardResult[], over: Partial<TestResult> = {}): TestResult {
  return {
    reader: { state: 'ok', version: 146, chip: 'MFRC522 v2.0' },
    box: { firmware: 'tng', version: '3.3.3', board: 'classic' },
    cards,
    reboots: 0,
    sawCard: true,
    readerChecked: true,
    ...over,
  };
}

/* ------------------------------------------------------------------ lines */

describe('ReaderLineParser', () => {
  it('reads the card lines of TNG through the Box-Logbuch parser', () => {
    const p = new ReaderLineParser();
    expect(p.read('Card Ins')).toEqual({ kind: 'detected', dialect: 'tng' });
    expect(p.read('[12:00:01.123] Card Rem')).toEqual({ kind: 'removed' });
    expect(p.read('CardData: 13 37 b3 47 02 05 02 00 00')).toEqual({
      kind: 'data',
      bytes: [0x13, 0x37, 0xb3, 0x47, 2, 5, 2, 0, 0],
    });
    expect(p.read('Auth  failed: 3')).toEqual({
      kind: 'error',
      op: 'auth',
      line: 'Auth failed: 3',
    });
    expect(p.read('MIFARE_Read  failed: 1')).toMatchObject({
      kind: 'error',
      op: 'read',
    });
    expect(p.read('bad ver 5')).toEqual({ kind: 'bad-version', version: 5 });
    expect(p.read('NTAG215')).toEqual({
      kind: 'type',
      label: 'NTAG215',
      family: 'ultralight',
    });
    expect(p.read('NTAG?-0')).toEqual({
      kind: 'type',
      label: 'NTAG (unbekannter Typ)',
      family: 'ultralight',
    });
    // The failed probe of an NTAG card says the family; it is no final error.
    expect(p.read('MIFARE_Read 3 failed: 3')).toEqual({
      kind: 'type',
      label: '',
      family: 'ultralight',
    });
    expect(p.read('MFRC522:146')).toEqual({ kind: 'reader', version: 146 });
    expect(p.read('com to mfrc broken')).toEqual({ kind: 'reader-broken' });
    expect(p.read('MIFARE_Write  failed: 3')).toBeNull();
  });

  it('reads the card lines of TonUINO 2.1', () => {
    const p = new ReaderLineParser();
    expect(p.read('Card UID: 9A 3F 21 C4')).toEqual({
      kind: 'detected',
      dialect: 'classic21',
    });
    expect(p.read('PICC type: MIFARE 1KB')).toEqual({
      kind: 'type',
      label: 'MIFARE Classic 1K',
      family: 'classic',
    });
    expect(p.read('PICC type: MIFARE Ultralight or Ultralight C')).toEqual({
      kind: 'type',
      label: 'MIFARE Ultralight oder NTAG',
      family: 'ultralight',
    });
    expect(p.read('PICC type: PICC compliant with ISO/IEC 14443-4')).toMatchObject({ family: 'other' });
    expect(p.read('PCD_Authenticate() failed: Timeout in communication.')).toMatchObject({ kind: 'error', op: 'auth' });
    expect(p.read('MIFARE_Read_2() failed: The CRC_A does not match.')).toMatchObject({ kind: 'error', op: 'read' });
    expect(p.read('Data on Card :')).toBeNull();
    expect(p.read(' 13 37 B3 47 02 05 02 00 00 00 00 00 00 00 00 00')).toMatchObject({
      kind: 'data',
      bytes: [0x13, 0x37, 0xb3, 0x47, 2, 5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    expect(p.read('Firmware Version: 0x92 = v2.0')).toEqual({
      kind: 'reader',
      version: 0x92,
    });
    expect(p.read('Firmware Version: 0x0 = (unknown)')).toEqual({
      kind: 'reader',
      version: 0,
    });
    expect(p.read('WARNING: Communication failure, is the MFRC522 properly connected?')).toEqual({ kind: 'reader-broken' });
    expect(p.read('TonUINO Version 2.1')).toEqual({
      kind: 'boot',
      firmware: 'classic21',
    });
  });

  it('tolerates lines it does not know', () => {
    const p = new ReaderLineParser();
    for (const l of ['', 'enter Idle', '== playFolder()', 'Authenticating Classic using key A...', 'Reading data from block 4 ...', '\u0000ÿþ garbage', 'Data on Card :', 'not hex at all']) {
      expect(p.read(l), l).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ reader check */

describe('reader check', () => {
  it('a TNG box that reports its reader at the start', () => {
    const r = new Run().connect();
    expect(r.t.phase.kind).toBe('reader-done');
    expect(r.t.reader).toEqual({
      state: 'ok',
      version: 146,
      chip: 'MFRC522 v2.0',
    });
    expect(r.t.box).toEqual({
      firmware: 'tng',
      version: '3.3.3',
      board: 'classic',
    });
  });

  it('"Noch einmal prüfen" after a dead reader checks it again at the next start', () => {
    const broken = TNG_START.map((l) => (l === 'MFRC522:146' ? 'MFRC522:0' : l)).concat('com to mfrc broken');
    const r = new Run().connect(broken);
    expect(r.t.reader.state).toBe('broken');
    r.t.restartRequested(r.now);
    expect(r.t.phase.kind).toBe('reader-check');
    // Until the box starts, the last result stays.
    expect(r.t.reader.state).toBe('broken');
    r.wait(400).lines(TNG_START);
    expect(r.t.phase.kind).toBe('reader-done');
    expect(r.t.reader.state).toBe('ok');
    expect(r.t.reboots).toBe(0);
  });

  it('a reader that does not answer', () => {
    const r = new Run().connect(AIOPLUS_BROKEN_LOG.split('\n').filter(Boolean));
    expect(r.t.phase.kind).toBe('reader-done');
    expect(r.t.reader.state).toBe('broken');
    const a = overallVerdict(r.result);
    expect(a.kind).toBe('reader-dead');
    expect(a.tone).toBe('error');
    // The AiO+ has its reader on a plug, not on loose cables.
    expect(a.steps.join(' ')).toContain('Stecker richtig herum');
  });

  it('a Classic box with a dead reader is told about cables, 3.3 V and a new reader', () => {
    const r = new Run().connect(TNG_START.map((l) => (l === 'MFRC522:146' ? 'MFRC522:0' : l)).concat('com to mfrc broken'));
    const a = overallVerdict(r.result);
    expect(a.kind).toBe('reader-dead');
    expect(a.steps.join(' ')).toMatch(/3,3 V/);
    expect(a.steps[a.steps.length - 1]).toMatch(/tausche den Kartenleser aus/);
  });

  it('a counterfeit or unknown reader chip answers, with a note', () => {
    const fake = new Run().connect(TNG_START.map((l) => (l === 'MFRC522:146' ? 'MFRC522:18' : l)));
    expect(fake.t.reader.state).toBe('warn');
    const odd = new Run().connect(TNG_START.map((l) => (l === 'MFRC522:146' ? 'MFRC522:24' : l)));
    expect(odd.t.reader.state).toBe('warn');
    // A clone that works well is no reason to worry.
    const clone = new Run().connect(TNG_START.map((l) => (l === 'MFRC522:146' ? 'MFRC522:178' : l)));
    expect(clone.t.reader.state).toBe('ok');
    odd.card().good().good().good().good().good();
    const a = overallVerdict(odd.result);
    expect(a.kind).toBe('all-good');
    // On screen in plain words, without the register value.
    expect(a.notes.join(' ')).toContain('kenne ich nicht');
    expect(a.notes.join(' ')).not.toContain('24');
    fake.card().good().good().good().good().good();
    const note = overallVerdict(fake.result).notes.join(' ');
    // The firmware only labels the value; it does not say such readers read badly.
    expect(note).toContain('als Nachbau');
    expect(note).not.toMatch(/Fälschung|oft schlecht/);
    expect(readerText(fake.result)).toBe('antwortet, Nachbau-Chip');
    expect(readerText(fake.result, true)).toBe('antwortet, Nachbau-Chip (Kennung 18)');
  });

  it('TonUINO 2.1 reports its reader after the MP3 player is up', () => {
    const r = new Run();
    r.t.connected(r.now);
    r.wait(300).lines(CLASSIC21_START.slice(0, -1)).wait(2100);
    expect(r.t.phase.kind).toBe('reader-check');
    r.lines(CLASSIC21_START.slice(-1));
    expect(r.t.phase.kind).toBe('reader-done');
    expect(r.t.reader.state).toBe('ok');
    expect(r.t.box.firmware).toBe('classic21');
  });

  it('asks for a restart when the start was missed, and checks again after it', () => {
    const r = new Run();
    r.t.connected(r.now);
    r.wait(5900);
    expect(r.t.phase.kind).toBe('reader-check');
    r.wait(200);
    expect(r.t.phase.kind).toBe('reader-missed');
    r.t.restartRequested(r.now);
    expect(r.t.phase.kind).toBe('reader-check');
    r.wait(400).lines(TNG_START);
    expect(r.t.phase.kind).toBe('reader-done');
    expect(r.t.reader.state).toBe('ok');
    // The requested start is no surprise.
    expect(r.t.reboots).toBe(0);
  });

  it('can go on without the check', () => {
    const r = new Run();
    r.t.connected(r.now);
    r.wait(6100);
    r.t.skipReaderCheck();
    expect(r.t.phase).toEqual({ kind: 'card-ready', card: 0 });
    expect(r.t.reader.state).toBe('unknown');
    expect(readerText(r.result)).toBe('nicht geprüft');
  });

  it('a start without a reader line ends the check after a while', () => {
    const r = new Run().connect(TNG_START.filter((l) => !l.startsWith('MFRC522')));
    expect(r.t.phase.kind).toBe('reader-check');
    r.wait(5000);
    expect(r.t.phase.kind).toBe('reader-done');
    expect(r.t.reader.state).toBe('unknown');
    // The check ran: the box started, the reader line did not come.
    expect(readerText(r.result)).toBe('keine Meldung beim Start');
  });

  it('on the AiO the card rounds cannot work: it logs no card events', () => {
    const r = new Run().connect(AIO_START);
    r.wait(2500);
    expect(r.t.phase.kind).toBe('reader-done');
    expect(r.t.cardsUntestable).toBe(true);
    r.t.finish();
    const a = overallVerdict(r.result);
    expect(a.kind).toBe('aio');
    expect(a.text).toContain('AiO');
    // But "com to mfrc broken" is logged on the AiO, too.
    const dead = new Run().connect([...AIO_START, 'com to mfrc broken']);
    expect(overallVerdict(dead.result).kind).toBe('reader-dead');
  });

  it('takes what the Box-Logbuch already knows', () => {
    const t = new ReaderTest();
    t.connected(0);
    t.seed({
      firmware: 'tng',
      version: '3.3.3',
      board: 'classic',
      rfid: { ok: true, version: 146 },
    });
    expect(t.phase.kind).toBe('reader-done');
    expect(t.reader.state).toBe('ok');
  });
});

/* ------------------------------------------------------------------ rounds */

describe('card rounds (TNG)', () => {
  it('counts five good rounds and waits for the card to leave between them', () => {
    const r = new Run().connect().card('Biene Maja');
    expect(r.t.phase.kind).toBe('lay');
    r.wait(400).lines(['Card Ins', 'CardData: ' + FOLDER_5]);
    expect(r.t.phase.kind).toBe('remove');
    // Still lying on the box: the next round waits.
    r.wait(3000);
    expect(r.t.phase.kind).toBe('remove');
    r.lines(['Card Rem']).wait(700);
    expect(r.t.phase.kind).toBe('lay');
    r.good().good().good().good();
    expect(r.t.phase).toEqual({ kind: 'card-done', card: 0 });
    const c = r.t.cards[0];
    expect(c.name).toBe('Biene Maja');
    expect(rateText(c)).toBe('5 von 5');
    expect(c.family).toBe('classic');
    expect(c.data).toEqual([0x13, 0x37, 0xb3, 0x47, 2, 5, 2, 0, 0]);
    expect(cardVerdict(c).kind).toBe('good');
  });

  it('tells read, unreadable and not noticed apart', () => {
    const r = new Run().connect().card().good().unreadable().missed().unreadable('MIFARE_Read  failed: 3').missed();
    const c = r.t.cards[0];
    expect(cardStats(c)).toMatchObject({
      total: 5,
      ok: 1,
      unreadable: 2,
      missed: 2,
    });
    expect(rateText(c)).toBe('1 von 5');
    expect(failureText(c)).toBe('2 × bemerkt, aber nicht lesbar, 2 × nicht bemerkt');
    expect(c.rounds[1].error).toBe('Auth failed: 3');
    expect(cardVerdict(c).kind).toBe('flaky');
  });

  it('a card that is never noticed comes from the time the rounds wait', () => {
    const r = new Run().connect().card().missed().missed().missed().missed();
    expect(r.t.phase.kind).toBe('lay');
    r.missed();
    expect(r.t.phase.kind).toBe('card-done');
    const v = cardVerdict(r.t.cards[0]);
    expect(v.kind).toBe('never-seen');
    expect(v.text).toContain('125 kHz');
    expect(v.text).toContain('geknickt');
    expect(v.text).not.toContain('Loch in der Antenne');
  });

  it('notes the NTAG type the firmware prints', () => {
    const r = new Run().connect().card().good(FOLDER_5, 'NTAG213').good(FOLDER_5, 'NTAG213').good().good().good();
    expect(r.t.cards[0].types).toEqual(['NTAG213']);
    expect(r.t.cards[0].family).toBe('ultralight');
  });

  it('a card written for another firmware is read, but says so', () => {
    const r = new Run().connect().card();
    for (let i = 0; i < 5; i++) {
      r.wait(400).lines(['Card Ins', 'CardData: 13 37 b3 47 05 05 02 00 00', 'bad ver 5']).wait(300).lines(['Card Rem']).wait(700);
    }
    const c = r.t.cards[0];
    expect(cardStats(c)).toMatchObject({ ok: 5, badVersion: 5 });
    expect(cardVerdict(c).kind).toBe('wrong-version');
    expect(overallVerdict(r.result).kind).toBe('cards-content');
  });

  it('stops at a blank card: the box opens its menu for new cards', () => {
    const r = new Run().connect().card().good('00 00 00 00 00 00 00 00 00');
    expect(r.t.phase.kind).toBe('card-done');
    expect(r.t.cards[0].stop).toBe('blank');
    expect(cardVerdict(r.t.cards[0]).kind).toBe('blank');
    // A blank card says nothing about the reader yet.
    expect(overallVerdict(r.result).kind).toBe('no-cards');
  });

  it('stops at the admin card', () => {
    const r = new Run().connect().card().good('13 37 b3 47 02 00 ff 00 00');
    expect(r.t.cards[0].stop).toBe('admin');
    expect(cardVerdict(r.t.cards[0]).title).toBe('Admin-Karte');
  });

  it('a card noticed but not read (box busy in a menu) is not counted, and three of them stop the card', () => {
    const r = new Run().connect().card().good();
    r.wait(400).lines(['Card Ins']).wait(300).lines(['Card Rem']).wait(700);
    expect(r.t.cards[0].skipped).toBe(1);
    expect(r.t.cards[0].rounds).toHaveLength(1);
    expect(r.t.last?.outcome).toBe('skipped');
    expect(r.t.phase.kind).toBe('lay');
    // Lying still without a read: the round ends after the read wait.
    r.wait(400).lines(['Card Ins']).wait(1600);
    expect(r.t.phase.kind).toBe('remove');
    r.lines(['Card Rem']).wait(700);
    r.wait(400).lines(['Card Ins']).wait(300).lines(['Card Rem']);
    expect(r.t.cards[0].stop).toBe('busy');
    expect(r.t.phase.kind).toBe('card-done');
  });

  it('a card that already lies on the box has to go before a round counts', () => {
    const r = new Run().connect();
    r.lines(['Card Ins', 'CardData: ' + FOLDER_5]);
    r.card();
    expect(r.t.phase.kind).toBe('clear');
    r.wait(8000);
    expect(r.t.phase.kind).toBe('clear');
    r.lines(['Card Rem']).wait(700);
    expect(r.t.phase.kind).toBe('lay');
  });

  it('a card laid on again before the next round waits for it to go', () => {
    const r = new Run().connect().card();
    r.wait(400)
      .lines(['Card Ins', 'CardData: ' + FOLDER_5, 'Card Rem'])
      .wait(200)
      .lines(['Card Ins'])
      .wait(1000);
    expect(r.t.phase.kind).toBe('remove');
    r.lines(['Card Rem']).wait(700);
    expect(r.t.phase.kind).toBe('lay');
    expect(r.t.cards[0].rounds).toHaveLength(1);
  });

  it('counts starts of the box during the test that the app did not ask for', () => {
    const r = new Run().connect().card().good().good();
    r.wait(400).lines(['Card Ins']).lines(TNG_START);
    expect(r.t.reboots).toBe(1);
    // The round of the restart is not counted; the test goes on.
    expect(r.t.cards[0].rounds).toHaveLength(2);
    r.wait(800);
    expect(r.t.phase.kind).toBe('lay');
    r.good().good().good();
    expect(overallVerdict(r.result).notes.join(' ')).toContain('neu gestartet');
  });

  it('a lost connection drops the card in progress; it starts over once the box is back', () => {
    const r = new Run().connect().card('Feuerwehr').good().good();
    r.t.disconnected();
    expect(r.t.phase).toEqual({ kind: 'card-ready', card: 0 });
    expect(r.t.cards).toHaveLength(0);
    expect(r.t.interrupted).toBe(true);
    r.connect();
    // The reader was checked already; the start after reconnecting is expected.
    expect(r.t.phase).toEqual({ kind: 'card-ready', card: 0 });
    expect(r.t.reboots).toBe(0);
  });

  it('cancel drops the card, repeat keeps its name, and there are at most 8 cards', () => {
    const r = new Run(new ReaderTest({ maxCards: 2 })).connect().card('Eins').good();
    r.t.cancelCard();
    expect(r.t.cards).toHaveLength(0);
    r.card('Eins').good().good().good().good().good();
    r.t.repeatCard(r.now);
    expect(r.t.phase.kind).toBe('lay');
    expect(r.t.cards[0]).toMatchObject({ name: 'Eins', rounds: [] });
    r.good().good().good().good().good().next().card('Zwei').good().good().good().good().good();
    r.t.nextCard();
    expect(r.t.phase.kind).toBe('card-done');
    r.t.finish();
    expect(r.t.phase.kind).toBe('results');
    expect(new ReaderTest().maxCards).toBe(8);
  });
  it('NTAG cards that fail on a TNG before 3.2.1, next to working MIFARE Classic cards', () => {
    const r = new Run().connect(TNG320_START);
    expect(r.t.box.version).toBe('3.2.0');
    r.card('Karte').good().good().good().good().good().next();
    const probe = 'MIFARE_Read 3 failed: 3';
    r.card('Sticker');
    for (let i = 0; i < 5; i++) r.unreadable('Auth  failed: 3', probe);
    expect(r.t.cards[1].family).toBe('ultralight');
    // One card of each type cannot tell the type from that one card; the card's own verdict names NTAG215.
    const one = overallVerdict(r.result);
    expect(one.kind).toBe('one-card');
    expect(one.text).toContain('Das liest TonUINO TNG 3.2.0 nicht');
    expect(one.text).not.toContain('Der Kartenleser funktioniert');
    r.next().card('Karte 2').good().good().good().good().good();
    const a = overallVerdict(r.result);
    expect(a.kind).toBe('type-fails');
    expect(a.text).toContain('Das liest TonUINO TNG 3.2.0 nicht');
  });

  it('"bad ver 1" of an older TNG after the card data: the card is read but not played', () => {
    const r = new Run().connect(TNG_START.map((l) => (l.startsWith('V3.3.3') ? 'V3.1.4 01.06.23' : l))).card();
    for (let i = 0; i < 5; i++) {
      r.wait(400).lines(['Card Ins', 'CardData: 13 37 b3 47 01 05 02 00 00', 'bad ver 1']);
      expect(r.t.last?.outcome).toBe('bad-version');
      r.wait(300).lines(['Card Rem']).wait(700);
    }
    const c = r.t.cards[0];
    expect(cardStats(c)).toMatchObject({ ok: 5, read: 0, badVersion: 5 });
    const v = cardVerdict(c, r.t.box);
    expect(v.kind).toBe('wrong-version');
    expect(v.text).toContain('neuere Firmware');
    expect(overallVerdict(r.result).kind).toBe('cards-content');
    // A "bad ver" without a round that just ended on card data changes nothing.
    expect(r.t.observe('bad ver 1', r.now)).toBe(false);
  });

  it('the box switching itself off stops the card; it is not blamed on the reader', () => {
    const r = new Run().connect().card('Eins').good().good().good().good().good().next();
    r.card('Zwei').good().good();
    r.lines(['timer started']).lines(['power off!']);
    expect(r.t.poweredOff).toBe(true);
    // The card in progress starts over once the box is on again.
    expect(r.t.phase).toEqual({ kind: 'card-ready', card: 1 });
    expect(r.t.cards).toHaveLength(1);
    expect(r.t.interrupted).toBe(false);
    r.wait(60_000).lines(TNG_START);
    expect(r.t.poweredOff).toBe(false);
    // Switched on again by someone: not a start of its own.
    expect(r.t.reboots).toBe(0);
    expect(new ReaderLineParser().read('=== power off!')).toEqual({ kind: 'power-off' });
  });
});

describe('card rounds (TonUINO 2.1)', () => {
  it('waits a fixed time between rounds, as 2.1 does not report a removed card', () => {
    const r = new Run();
    r.t.connected(r.now);
    r.wait(300).lines(CLASSIC21_START).wait(100);
    r.card();
    r.wait(400).lines(['Card UID: 9A 3F 21 C4', 'PICC type: MIFARE 1KB', 'Data on Card :', ' 13 37 B3 47 02 05 02 00 00 00 00 00 00 00 00 00']);
    expect(r.t.phase.kind).toBe('remove');
    expect(r.t.remaining(r.now)).toBe(1);
    r.wait(2500);
    expect(r.t.phase.kind).toBe('lay');
    r.good21().good21().good21().good21();
    const c = r.t.cards[0];
    expect(rateText(c)).toBe('5 von 5');
    expect(c.types).toEqual(['MIFARE Classic 1K']);
  });

  it('NTAG cards that 2.1 cannot read, next to working MIFARE Classic cards', () => {
    const r = new Run();
    r.t.connected(r.now);
    r.wait(300).lines(CLASSIC21_START).wait(100);
    r.card('Classic').good21().good21().good21().good21().good21().next();
    r.card('Classic 2').good21().good21().good21().good21().good21().next();
    r.card('Sticker').unreadable21().unreadable21().unreadable21().unreadable21().unreadable21();
    const sticker = r.t.cards[2];
    expect(sticker.family).toBe('ultralight');
    expect(sticker.rounds[0].error).toBe('PCD_Authenticate() failed: Timeout in communication.');
    expect(cardVerdict(sticker, r.t.box).text).toContain('NTAG215');
    const a = overallVerdict(r.result);
    expect(a.kind).toBe('type-fails');
    expect(a.text).toContain('Karten vom Typ MIFARE Classic schon');
    expect(a.text).toContain('Das liest TonUINO 2.1 nicht');
    expect(a.links.map((l) => l.href)).toContain('#/hilfe/kartentypen');
  });

  it('a card laid on again before the timed wait is over counts as the next round', () => {
    const r = new Run();
    r.t.connected(r.now);
    r.wait(300).lines(CLASSIC21_START).wait(100);
    r.card();
    const read = ['Card UID: 9A 3F 21 C4', 'PICC type: MIFARE 1KB', 'Data on Card :', ' 13 37 B3 47 02 05 02 00 00 00 00 00 00 00 00 00'];
    r.wait(400).lines(read);
    expect(r.t.phase.kind).toBe('remove');
    // Taken off and laid on again 1.2 s later: 2.1 reads it again and then sends it to sleep.
    r.wait(1200).lines(read.slice(0, 1));
    expect(r.t.phase.kind).toBe('reading');
    r.lines(read.slice(1)).wait(2600);
    expect(r.t.cards[0].rounds.map((x) => x.outcome)).toEqual(['read', 'read']);
    expect(r.t.phase.kind).toBe('lay');
  });

  it('a blank card or a card of another system opens the menu of 2.1 and stops the card', () => {
    const r = new Run();
    r.t.connected(r.now);
    r.wait(300).lines(CLASSIC21_START).wait(100);
    r.card().good21('MIFARE 1KB', ' 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00');
    expect(r.t.cards[0].stop).toBe('blank');
  });
});

/* ------------------------------------------------------------------ verdicts */

describe('verdicts', () => {
  it('a single slip in five rounds is fine', () => {
    expect(cardVerdict(card('rrrrm')).kind).toBe('mostly');
    expect(cardVerdict(card('rrrur')).kind).toBe('mostly');
    expect(cardVerdict(card('rrm')).kind).toBe('flaky');
    expect(cardVerdict(card('rruum')).kind).toBe('flaky');
    expect(cardVerdict(card('uuuuu')).kind).toBe('never-read');
    expect(cardVerdict(card('mmmmm')).kind).toBe('never-seen');
    expect(cardVerdict(card('fffff')).kind).toBe('foreign');
    expect(cardVerdict(card('')).kind).toBe('untested');
  });

  it('a card type the box cannot read is named', () => {
    const v = cardVerdict(card('uuuuu', { family: 'other', types: ['MIFARE DESFire'] }));
    expect(v.text).toContain('Diesen Kartentyp (MIFARE DESFire) kann die Box nicht lesen.');
  });

  it('the NTAG215 hint depends on the firmware version', () => {
    const ntag = card('uuuuu', { family: 'ultralight', types: ['NTAG215'] });
    expect(cardVerdict(ntag, { firmware: 'tng', version: '3.2.0' }).text).toContain('Das liest TonUINO TNG 3.2.0 nicht');
    expect(cardVerdict(ntag, { firmware: 'tng', version: '3.3.3' }).text).not.toContain('NTAG215');
    // TNG names the type: an NTAG213 that fails is not the NTAG215 problem.
    expect(
      cardVerdict(card('uuuuu', { family: 'ultralight', types: ['NTAG213'] }), {
        firmware: 'tng',
        version: '3.2.0',
      }).text,
    ).not.toContain('NTAG215');
    expect(cardVerdict(ntag, {}).text).toContain('TNG vor Version 3.2.1');
  });

  it('all cards fine', () => {
    const a = overallVerdict(result([card('rrrrr'), card('rrrrr'), card('rrrrr')]));
    expect(a).toMatchObject({ kind: 'all-good', tone: 'ok' });
    expect(a.text).toBe('Die Box hat alle 3 Karten zuverlässig gelesen.');
    // One slip on one card: fine, but not "zuverlässig".
    const slip = overallVerdict(result([card('rrrrr'), card('rrrrm'), card('rrrrr')]));
    expect(slip).toMatchObject({ kind: 'all-good', tone: 'ok' });
    expect(slip.text).toContain('alle 3 Karten');
    expect(slip.text).not.toContain('zuverlässig');
  });

  it('a slip on every card is a reader that loses cards now and then', () => {
    const a = overallVerdict(result([card('rrrrm'), card('rmrrr'), card('rrmrr'), card('rrrur')]));
    expect(a).toMatchObject({ kind: 'reader-weak', tone: 'warn' });
    expect(a.text).not.toContain('zuverlässig');
    expect(a.text).toContain('4 von 4 Karten');
    expect(a.steps.join(' ')).toContain('RC522');
    // Two slips among many cards stay below that.
    const many = overallVerdict(result([card('rrrrm'), card('rmrrr'), ...Array.from({ length: 4 }, () => card('rrrrr'))]));
    expect(many.kind).toBe('all-good');
    expect(many.text).not.toContain('zuverlässig');
  });

  it('one card fails while the others work: that card is the problem', () => {
    const a = overallVerdict(result([card('rrrrr', { name: 'Biene' }), card('mmmmm', { name: 'Löwe' }), card('rrrrr')]));
    expect(a.kind).toBe('one-card');
    expect(a.title).toBe('Nur Karte 2 „Löwe“ macht Probleme');
    expect(a.text).toContain('Der Kartenleser funktioniert');
    expect(a.text).toContain('Nimm eine andere Karte');
    // With only one good card it is likely, not certain.
    const two = overallVerdict(result([card('rrrrr'), card('rmrmm')]));
    expect(two.kind).toBe('one-card');
    expect(two.text).toContain('Die andere Karte');
    expect(two.text).not.toContain('Der Kartenleser funktioniert');
    expect(two.text).toContain('auch der Kartenleser');
    expect(two.steps.length).toBeGreaterThan(0);
  });

  it('several cards work only sometimes: the reader is the suspect', () => {
    const a = overallVerdict(result([card('rrrrr'), card('rmrmr'), card('rurmm')]));
    expect(a.kind).toBe('reader-weak');
    const steps = a.steps.join(' ');
    for (const word of ['mittig', 'Metall', 'Lötstellen', '3,3 V', 'Netzteil', 'RC522']) expect(steps).toContain(word);
  });

  it('no card works at all', () => {
    expect(overallVerdict(result([card('rmrum'), card('uuuuu')])).kind).toBe('reader-weak');
    const nothing = overallVerdict(result([card('mmmmm'), card('mmmmm')]));
    expect(nothing.kind).toBe('sees-nothing');
    expect(nothing.text).toContain('125 kHz');
    // Without a start log and without a single card event the firmware may simply not report cards.
    expect(
      overallVerdict(
        result([card('mmmmm'), card('mmmmm')], {
          reader: { state: 'unknown' },
          sawCard: false,
        }),
      ).kind,
    ).toBe('no-signal');
  });

  it('one failing card alone cannot tell card from reader', () => {
    const a = overallVerdict(result([card('mmmmm')]));
    expect(a.kind).toBe('one-card-only');
    expect(a.text).toContain('zweite Karte');
  });

  it('only one card type fails', () => {
    const a = overallVerdict(
      result([card('rrrrr', { family: 'classic' }), card('uuuuu', { family: 'ultralight', types: ['NTAG215'] }), card('rrrrr', { family: 'classic' })], {
        box: { firmware: 'tng', version: '3.1.4', board: 'classic' },
      }),
    );
    expect(a.kind).toBe('type-fails');
    expect(a.text).toContain('NTAG215');
    expect(a.text).toContain('Ultralight C');
  });

  it('a type is not blamed for a card the box read now and then, or from one card of each type', () => {
    // A Classic card read 2 of 5 times: the box can read that type.
    const flaky = overallVerdict(result([card('rrrrr', { family: 'ultralight', types: ['NTAG213'] }), card('rmrmm', { family: 'classic' })]));
    expect(flaky.kind).not.toBe('type-fails');
    expect(flaky.text).not.toContain('Handy-App');
    // An Ultralight card read 3 of 5 times on TNG 3.2.0 is no NTAG215 problem.
    const ul = overallVerdict(
      result([card('rrrrr', { family: 'classic' }), card('rrmrm', { family: 'ultralight' })], {
        box: { firmware: 'tng', version: '3.2.0', board: 'classic' },
      }),
    );
    expect(ul.kind).not.toBe('type-fails');
    expect(ul.text).not.toContain('NTAG215');
    // Two never-read cards of one type next to one good card are enough.
    const two = overallVerdict(result([card('rrrrr', { family: 'classic' }), card('uuuuu', { family: 'other' }), card('uuuuu', { family: 'other' })]));
    expect(two.kind).toBe('type-fails');
  });

  it('several cards of one type that the box cannot read at all', () => {
    const a = overallVerdict(
      result([card('uuuuu', { family: 'other', types: ['MIFARE DESFire'] }), card('uuuuu', { family: 'other', types: ['MIFARE DESFire'] })], { box: { firmware: 'classic21' } }),
    );
    expect(a.kind).toBe('type-fails');
    expect(a.text).toContain('MIFARE DESFire');
  });

  it('many cards fail completely: it can be the cards or the reader', () => {
    for (const cards of [
      [card('rrrrr'), card('mmmmm'), card('uuuuu')],
      [card('rrrrr'), card('mmmmm'), card('mmmmm'), card('mmmmm')],
      [card('rrrrr'), card('rrrrr'), card('uuuuu'), card('mmmmm')],
    ]) {
      const a = overallVerdict(result(cards));
      expect(a.kind).toBe('cards-or-reader');
      expect(a.text).not.toContain('Der Kartenleser funktioniert');
      expect(a.text).toContain('früher in dieser Box geklappt');
      expect(a.steps.join(' ')).toContain('tausche den Kartenleser aus');
      expect(a.links.map((l) => l.href)).toContain('#/hilfe/kartenleser-testen');
    }
    expect(overallVerdict(result([card('rrrrr'), card('mmmmm'), card('mmmmm')])).text).toMatch(/^Nur eine Karte liest/);
    expect(overallVerdict(result([card('rrrrr'), card('rrmmm'), card('uuuuu')])).text).toMatch(/^Nur eine Karte liest die Box gut, zwei nicht oder nur manchmal\./);
  });

  it('a few cards fail completely while most work: probably those cards', () => {
    const a = overallVerdict(result([card('rrrrr'), card('rrrrr'), card('rrrrr'), card('mmmmm'), card('uuuuu')]));
    expect(a.kind).toBe('some-cards');
    expect(a.text).toMatch(/^Drei Karten liest die Box gut, zwei nicht\./);
    expect(a.text).not.toContain('Der Kartenleser funktioniert');
    expect(a.text).toContain('früher in dieser Box geklappt');
    expect(a.steps).toEqual([]);
    // One of them works now and then: the reader is a suspect, too.
    const flaky = overallVerdict(result([card('rrrrr'), card('rrrrr'), card('rrrrr'), card('mmmmm'), card('rmrmm')]));
    expect(flaky.kind).toBe('some-cards');
    expect(flaky.text).toMatch(/^Drei Karten liest die Box gut, zwei nicht oder nur manchmal\./);
    expect(flaky.text).toContain('auch der Kartenleser');
    expect(flaky.steps.length).toBeGreaterThan(0);
  });

  it('a start of the box during the test is not blamed on the power for sure', () => {
    const a = overallVerdict(result([card('rrrrr'), card('rrrrr')], { reboots: 1 }));
    expect(a.notes.join(' ')).toContain('Hast du sie nicht selbst neu gestartet, ist vielleicht kurz der Strom weggebrochen');
  });

  it('every advice says what to do next', () => {
    const cases: TestResult[] = [
      result([card('rrrrr'), card('rrrrr')]),
      result([card('rrrrr'), card('mmmmm')]),
      result([card('rrrrr'), card('mmmmm'), card('uuuuu')]),
      result([card('rrrrr'), card('rrrrr'), card('rrrrr'), card('mmmmm'), card('uuuuu')]),
      result([card('rrrrm'), card('rrrrm')]),
      result([card('rmrmr'), card('rurmr')]),
      result([card('mmmmm'), card('mmmmm')]),
      result([card('mmmmm')]),
      result([], { reader: { state: 'broken' } }),
      result([], {
        box: { board: 'aio' },
        reader: { state: 'unknown' },
        sawCard: false,
      }),
    ];
    for (const c of cases) {
      const a = overallVerdict(c);
      expect(a.title.length, a.kind).toBeGreaterThan(5);
      expect(a.text.length, a.kind).toBeGreaterThan(30);
      expect(a.kind === 'all-good' || a.steps.length > 0 || a.links.length > 0 || /Teste|Beschreib|Nimm/.test(a.text), a.kind).toBe(true);
    }
  });
});

describe('result text for the forum', () => {
  it('a whole TNG run: reader check, three cards with different outcomes, results', () => {
    const r = new Run().connect();
    r.card('Biene Maja').good().good().good().good().good().next();
    r.card('Löwe').good().missed().unreadable().missed().good().next();
    r.card().missed().missed().missed().missed().missed();
    r.t.finish();
    expect(r.t.phase.kind).toBe('results');
    const text = resultText(r.result, r.t.rounds, new Date(2026, 9, 6).getTime());
    expect(text).toContain('Kartenleser-Test aus TonUINO Studio, 06.10.2026');
    expect(text).toContain('Box: TonUINO TNG 3.3.3, Platine Classic');
    expect(text).toContain('Kartenleser: antwortet (MFRC522 v2.0, Kennung 146)');
    expect(text).toContain('Jede Karte 5-mal aufgelegt und wieder weggenommen.');
    expect(text).toContain('Karte 1 „Biene Maja“: 5 von 5 gelesen. Klappt.');
    expect(text).toContain('Karte 2 „Löwe“: 2 von 5 gelesen, 1 × bemerkt, aber nicht lesbar, 2 × nicht bemerkt, Meldung: Auth failed: 3. Klappt nur manchmal.');
    expect(text).toContain('Karte 3: 0 von 5 gelesen, 5 × nicht bemerkt. Wird gar nicht bemerkt.');
    expect(text).toContain('Ergebnis: Viele Karten klappen nicht.');
    // On screen the reader line is in plain words.
    expect(readerText(r.result)).toBe('antwortet');
  });
});

describe('help', () => {
  const ids = (query: string) => searchHelp(query).hits.map((h) => h.id);

  it('the section on the reader test is found with the words people use', () => {
    for (const q of ['Karten werden nicht gelesen', 'Kartenleser defekt', 'RC522', 'NFC Leser', 'manche Karten gehen nicht', 'Kartenleser testen', 'com to mfrc broken', 'Karten funktionieren nicht', 'Box erkennt Karte nicht', 'Karte wird nicht immer erkannt', 'Lesegerät']) {
      expect(ids(q)[0], q).toBe('kartenleser-testen');
    }
    // The page about a card that is not recognised leads to the test, too.
    expect(ids('Karte wird nicht erkannt').slice(0, 3)).toEqual(expect.arrayContaining(['karte-geht-nicht', 'kartenleser-testen']));
  });

  it('the pages about cards lead to the test', () => {
    const links = helpLinks();
    for (const id of ['karte-geht-nicht', 'kartentypen', 'anlernen-klappt-nicht', 'kartenleser-testen']) {
      expect(
        links.some((l) => l.section === id && l.href === '#/werkstatt/kartenleser'),
        id,
      ).toBe(true);
    }
    expect(findSection('kartenleser-testen')?.topic.id).toBe('werkstatt');
  });

  it('the advice links to pages that exist', () => {
    const r = new Run().connect().card().missed().missed().missed().missed().missed().next().card().missed().missed().missed().missed().missed();
    for (const l of overallVerdict(r.result).links) {
      const id = l.href.replace('#/hilfe/', '');
      if (l.href.startsWith('#/hilfe/')) expect(findSection(id), l.href).toBeDefined();
    }
  });
});

describe('end check: AiO advice', () => {
  it('a dead reader in an AiO box names no support of a maker that no longer sells it', () => {
    for (const board of ['aio', 'aioplus'] as const) {
      const a = overallVerdict(result([], { reader: { state: 'broken' }, box: { firmware: 'tng', board } }));
      expect(a.kind).toBe('reader-dead');
      const all = [a.text, ...a.steps].join(' ');
      expect(all).not.toContain('Leiterkartenpiraten');
      expect(all).toContain('Kartenleser');
    }
  });
});
