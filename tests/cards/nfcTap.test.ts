import { afterEach, describe, expect, it } from 'vitest';
import { handleTap, holdTaps, startNfcTaps, tapPlan, tappedCard, type TapDeps } from '../../src/features/cards/nfcTap';
import type { NfcAccess, NfcCardInfo, NfcReadResult } from '../../src/platform/types';
import type { Route } from '../../src/app/router';

/** The phone's NFC as nfcTap.ts sees it: cards come through onTap and are read on asking. */
class FakePhone implements NfcAccess {
  readonly supported = true;
  readonly phone = true;
  memory = new Map<string, Uint8Array>();
  failRead: Error | null = null;
  /** A read waits for this before it answers (a slow card). */
  gate: Promise<void> | null = null;
  private listener: ((c: NfcCardInfo) => void) | null = null;
  private last: NfcCardInfo | null = null;
  async listReaders() {
    return ['Handy'];
  }
  async waitForCard() {
    return this.last;
  }
  async read(): Promise<NfcReadResult> {
    const card = this.last!;
    if (this.gate) await this.gate;
    if (this.failRead) throw this.failRead;
    return { ...card, data: this.memory.get(card.uid) ?? new Uint8Array(16) };
  }
  async write() {}
  onTap(cb: (c: NfcCardInfo) => void) {
    this.listener = cb;
    return () => {
      this.listener = null;
    };
  }
  tap(uid: string, data?: Uint8Array) {
    if (data) this.memory.set(uid, data);
    this.last = { uid, type: 'ntag215' };
    this.listener?.(this.last);
  }
}

function deps(page: Route['page'], dialogOpen = false) {
  const log: string[] = [];
  const d: TapDeps = {
    page: () => page,
    dialogOpen: () => dialogOpen,
    open: () => log.push('open'),
    note: (text) => log.push(`note ${text}`),
    describe: (data) => `Ordner ${data[5]}`,
    reader: 'Handy',
  };
  return { d, log };
}

const tonuino = (folder: number) => Uint8Array.from([0x13, 0x37, 0xb3, 0x47, 2, folder, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  tappedCard.value = null;
});

describe('a card held to the phone', () => {
  it('shows on the cards page, opens it from other pages and only notes it where the screen must stay', () => {
    expect(tapPlan({ held: false, page: 'cards', dialogOpen: false })).toBe('show');
    expect(tapPlan({ held: false, page: 'cards', dialogOpen: true })).toBe('show');
    expect(tapPlan({ held: false, page: 'box', dialogOpen: false })).toBe('open');
    expect(tapPlan({ held: false, page: 'sources', dialogOpen: false })).toBe('open');
    expect(tapPlan({ held: false, page: 'box', dialogOpen: true })).toBe('note');
    expect(tapPlan({ held: false, page: 'workshop', dialogOpen: false })).toBe('note');
    expect(tapPlan({ held: true, page: 'cards', dialogOpen: false })).toBe('ignore');
  });

  it('is read and shown on the cards page', async () => {
    const nfc = new FakePhone();
    const { d, log } = deps('cards');
    nfc.tap('04:AA', tonuino(7));
    const done = handleTap(nfc, { uid: '04:AA', type: 'ntag215' }, d);
    expect(tappedCard.value).toMatchObject({ uid: '04:AA', busy: true });
    await done;
    expect(tappedCard.value).toMatchObject({ uid: '04:AA', busy: false });
    expect(tappedCard.value?.data?.[5]).toBe(7);
    expect(log).toEqual([]);
  });

  it('opens the cards page from elsewhere and tells a card it could not read', async () => {
    const nfc = new FakePhone();
    nfc.failRead = new Error('Die Karte war zu kurz am Handy.');
    const { d, log } = deps('box');
    nfc.tap('04:BB');
    await handleTap(nfc, { uid: '04:BB', type: 'ntag215' }, d);
    expect(log).toEqual(['open']);
    expect(tappedCard.value).toMatchObject({ uid: '04:BB', busy: false, error: 'Die Karte war zu kurz am Handy.' });
    expect(tappedCard.value?.data).toBeUndefined();
  });

  it('leaves an open dialog alone and only notes what is on the card', async () => {
    const nfc = new FakePhone();
    const { d, log } = deps('add', true);
    nfc.tap('04:CC', tonuino(3));
    await handleTap(nfc, { uid: '04:CC', type: 'ntag215' }, d);
    expect(log).toEqual(['note Ordner 3']);
    expect(tappedCard.value?.uid).toBe('04:CC');

    // A card that cannot be read is not worth a note there.
    nfc.failRead = new Error('weg');
    await handleTap(nfc, { uid: '04:CD', type: 'ntag215' }, d);
    expect(log).toEqual(['note Ordner 3']);
  });

  it('is left to a write run or "Karte löschen" while they hold the taps', async () => {
    const nfc = new FakePhone();
    const { d, log } = deps('box');
    const release = holdTaps();
    const second = holdTaps();
    nfc.tap('04:DD', tonuino(1));
    await handleTap(nfc, { uid: '04:DD', type: 'ntag215' }, d);
    release();
    release();
    await handleTap(nfc, { uid: '04:DD', type: 'ntag215' }, d);
    expect(tappedCard.value).toBeNull();
    expect(log).toEqual([]);
    second();
    await handleTap(nfc, { uid: '04:DD', type: 'ntag215' }, d);
    expect(log).toEqual(['open']);
  });

  it('shows the newest card when two come quickly', async () => {
    const nfc = new FakePhone();
    const { d } = deps('cards');
    let open!: () => void;
    nfc.gate = new Promise((r) => (open = r));
    nfc.tap('04:01', tonuino(1));
    const first = handleTap(nfc, { uid: '04:01', type: 'ntag215' }, d);
    nfc.gate = null;
    nfc.tap('04:02', tonuino(2));
    await handleTap(nfc, { uid: '04:02', type: 'ntag215' }, d);
    open();
    await first;
    expect(tappedCard.value?.data?.[5]).toBe(2);
  });

  it('is answered on every page once started, and no more after stop', async () => {
    const nfc = new FakePhone();
    const { d } = deps('cards');
    const stop = startNfcTaps(nfc, 'Handy', d.describe, d.note, d);
    nfc.tap('04:EE', tonuino(9));
    await flush();
    expect(tappedCard.value?.data?.[5]).toBe(9);
    stop();
    tappedCard.value = null;
    nfc.tap('04:EF', tonuino(4));
    await flush();
    expect(tappedCard.value).toBeNull();
    // Not a phone: nothing to start.
    const desktop: NfcAccess = { supported: true, listReaders: async () => [], waitForCard: async () => null, read: nfc.read.bind(nfc), write: async () => {}, onTap: nfc.onTap.bind(nfc) };
    startNfcTaps(desktop, 'Handy', d.describe, d.note, d)();
    nfc.tap('04:F0', tonuino(5));
    await flush();
    expect(tappedCard.value).toBeNull();
  });
});
