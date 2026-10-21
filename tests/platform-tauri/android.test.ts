import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTauriAndroid } from '../../src/platform/tauri/detect';
import { createAndroidPlatform } from '../../src/platform/tauri/android';
import { AndroidNfc, OP_TIMEOUT_MS, PHONE_READER, type NfcBridge, type NfcBridgeResult, type NfcCallbacks } from '../../src/platform/tauri/nfcAndroid';
import { newRunMemory, readCardNow, writeCards, type ReaderPort } from '../../src/features/cards/readerRun';
import { decodeCard, type CardData } from '../../src/core/tonuino/card';
import type { AudioBackend, NfcCardInfo } from '../../src/platform/types';
import { FakeIpc } from './fake-ipc';

interface FakeCard {
  uid: string;
  type: string;
  memory: Uint8Array;
}

/**
 * window.TonuinoNfc as MainActivity adds it (src-tauri/android/TonuinoNfc.kt):
 * answers read, write and check a moment later through window.__tonuinoNfc,
 * for the card that came last, as long as it is still at the phone.
 */
class FakeBridge implements NfcBridge {
  nfc: 'none' | 'off' | 'on' = 'on';
  started = 0;
  settingsOpened = 0;
  /** The card at the phone right now. */
  card: FakeCard | null = null;
  /** The card the last tag event named. */
  last: FakeCard | null = null;
  /** The next read or write fails with this. */
  fail: { code: string; hints?: string[] } | null = null;
  /** Never answers (a hanging bridge). */
  silent = false;
  readonly writes: string[] = [];
  /** The card each write named. */
  readonly meant: string[] = [];

  constructor(readonly host: { __tonuinoNfc?: NfcCallbacks }) {}

  state() {
    return this.nfc;
  }
  openSettings() {
    this.settingsOpened++;
  }
  start() {
    this.started++;
  }
  stop() {}

  /** A card comes to the phone. */
  bring(card: FakeCard) {
    this.card = card;
    this.last = card;
    this.host.__tonuinoNfc!.tag({ uid: card.uid, type: card.type, sak: card.type.startsWith('mifare-classic') ? '08' : '00', atqa: '4400' });
  }

  /** The card leaves the phone. */
  takeAway() {
    this.card = null;
  }

  private answer(id: string, result: NfcBridgeResult) {
    if (this.silent) return;
    setTimeout(() => this.host.__tonuinoNfc!.done(id, result), 1);
  }

  private here(id: string): FakeCard | null {
    if (!this.last) {
      this.answer(id, { ok: false, code: 'no-card', message: 'no card came to the phone yet' });
      return null;
    }
    if (this.card !== this.last) {
      this.answer(id, { ok: false, code: 'tag-lost', message: 'Tag was lost.' });
      return null;
    }
    if (this.fail) {
      const { code, hints } = this.fail;
      this.fail = null;
      this.answer(id, { ok: false, code, message: `failed: ${code}`, ...(hints ? { hints } : {}) });
      return null;
    }
    return this.card;
  }

  read(id: string) {
    const c = this.here(id);
    if (c) this.answer(id, { ok: true, uid: c.uid, type: c.type, data: hex(c.memory) });
  }

  write(id: string, data: string, uid: string) {
    const c = this.here(id);
    if (!c) return;
    this.meant.push(uid);
    if (uid && uid !== c.uid) return this.answer(id, { ok: false, code: 'wrong-card', message: `expected ${uid}` });
    this.writes.push(data);
    c.memory = Uint8Array.from(data.match(/../g)!.map((b) => parseInt(b, 16)));
    this.answer(id, { ok: true, uid: c.uid, type: c.type });
  }

  check(id: string) {
    const c = this.here(id);
    if (c) this.answer(id, { ok: true, uid: c.uid, type: c.type });
  }
}

function hex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

function setup() {
  const host: { __tonuinoNfc?: NfcCallbacks } = {};
  const bridge = new FakeBridge(host);
  const nfc = new AndroidNfc(bridge, host);
  return { host, bridge, nfc };
}

const card = (uid: string, type = 'ntag215'): FakeCard => ({ uid, type, memory: new Uint8Array(16) });
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Android NFC (window.TonuinoNfc)', () => {
  afterEach(() => vi.useRealTimers());

  it('offers the phone as the reader while NFC is on and starts reader mode once', async () => {
    const { bridge, nfc } = setup();
    expect(nfc.phone).toBe(true);
    expect(await nfc.listReaders()).toEqual([PHONE_READER]);
    expect(await nfc.listReaders()).toEqual([PHONE_READER]);
    expect(bridge.started).toBe(1);

    bridge.nfc = 'off';
    await expect(nfc.listReaders()).rejects.toMatchObject({ code: 'nfc-off', message: expect.stringMatching(/NFC ist ausgeschaltet/) });
    await expect(nfc.waitForCard(PHONE_READER, 10)).rejects.toMatchObject({ code: 'nfc-off' });
    nfc.openSettings();
    expect(bridge.settingsOpened).toBe(1);

    bridge.nfc = 'none';
    expect(await nfc.listReaders()).toEqual([]);
    await expect(nfc.read(PHONE_READER)).rejects.toMatchObject({ code: 'no-nfc', message: expect.stringMatching(/kein NFC/) });
  });

  it('is a phone without NFC when the APK has no bridge', async () => {
    const nfc = new AndroidNfc(undefined, {});
    expect(nfc.state()).toBe('none');
    expect(await nfc.listReaders()).toEqual([]);
  });

  it('waits for the next card, reads it, writes it and reads the new bytes back', async () => {
    const { bridge, nfc } = setup();
    await nfc.listReaders();
    const a = card('04:A2:3B:12:7F:61:80');
    later(5, () => bridge.bring(a));
    const seen = await nfc.waitForCard(PHONE_READER, 1000);
    expect(seen).toEqual({ uid: a.uid, type: 'ntag215', details: 'SAK 00 · ATQA 4400' });

    const before = await nfc.read(PHONE_READER);
    expect(before.data).toEqual(new Uint8Array(16));
    expect(before.uid).toBe(a.uid);

    const data = Uint8Array.from([0x13, 0x37, 0xb3, 0x47, 0x02, 0x05, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0xff]);
    await nfc.write(PHONE_READER, data);
    expect(bridge.writes).toEqual(['1337B34702050100000000000000' + '00FF']);
    // Without a card named, the one the page saw last is meant.
    expect(bridge.meant).toEqual([a.uid]);
    expect((await nfc.read(PHONE_READER)).data).toEqual(data);
    // The card the caller read is gone, another one at the phone: refused, in German.
    await expect(nfc.write(PHONE_READER, data, '04:00:00:00:00:00:01')).rejects.toMatchObject({ code: 'wrong-card', message: expect.stringMatching(/andere Karte/) });
    expect(bridge.writes).toHaveLength(1);

    await expect(nfc.write(PHONE_READER, new Uint8Array(15))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('says null when no card comes in time, and the card again while it stays at the phone', async () => {
    const { bridge, nfc } = setup();
    expect(await nfc.waitForCard(PHONE_READER, 20)).toBeNull();
    const a = card('04:01');
    bridge.bring(a);
    // Android reports a card once; it still counts as there while it answers.
    expect((await nfc.waitForCard(PHONE_READER, 20))?.uid).toBe('04:01');
    expect((await nfc.waitForCard(PHONE_READER, 20))?.uid).toBe('04:01');
    bridge.takeAway();
    expect(await nfc.waitForCard(PHONE_READER, 20)).toBeNull();
    // The next card comes.
    const b = card('04:02', 'mifare-classic-1k');
    later(5, () => bridge.bring(b));
    expect(await nfc.waitForCard(PHONE_READER, 1000)).toMatchObject({ uid: '04:02', type: 'mifare-classic-1k' });
  });

  it('turns the codes of the bridge into German messages and hints', async () => {
    const { bridge, nfc } = setup();
    bridge.bring(card('04:03', 'mifare-classic-1k'));

    bridge.fail = { code: 'classic-unsupported' };
    const classic = await nfc.write(PHONE_READER, new Uint8Array(16)).catch((e: unknown) => e);
    expect(classic).toMatchObject({ code: 'classic-unsupported', message: expect.stringMatching(/MIFARE-Classic.*NTAG213 oder NTAG215/s) });

    bridge.fail = { code: 'auth-failed', hints: ['card-ndef-formatted'] };
    const auth = (await nfc.read(PHONE_READER).catch((e: unknown) => e)) as { code: string; hints: { id: string; text: string }[] };
    expect(auth.code).toBe('auth-failed');
    expect(auth.hints).toEqual([expect.objectContaining({ id: 'card-ndef-formatted', text: expect.stringMatching(/Handy-App/) })]);

    bridge.fail = { code: 'verify-failed' };
    await expect(nfc.write(PHONE_READER, new Uint8Array(16))).rejects.toMatchObject({ code: 'verify-failed', message: expect.stringMatching(/Rückseite/) });

    bridge.takeAway();
    await expect(nfc.read(PHONE_READER)).rejects.toMatchObject({ code: 'tag-lost', message: expect.stringMatching(/zu kurz am Handy/) });
  });

  it('gives up on a bridge that never answers', async () => {
    vi.useFakeTimers();
    const { bridge, nfc } = setup();
    bridge.bring(card('04:04'));
    bridge.silent = true;
    const read = nfc.read(PHONE_READER).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(OP_TIMEOUT_MS + 1);
    expect(await read).toMatchObject({ code: 'timeout' });
  });

  it('tells when NFC was switched on in the settings meanwhile', () => {
    const { host, nfc } = setup();
    const states: string[] = [];
    const stop = nfc.onStateChange((s) => states.push(s));
    host.__tonuinoNfc!.state('on');
    host.__tonuinoNfc!.state('weird');
    stop();
    host.__tonuinoNfc!.state('off');
    expect(states).toEqual(['on', 'none']);
  });

  it('hands a card nobody waits for to the tap listeners and starts reader mode for them', async () => {
    const { bridge, nfc } = setup();
    const taps: string[] = [];
    const stop = nfc.onTap((c) => taps.push(c.uid));
    expect(bridge.started).toBe(1);
    bridge.bring(card('04:01'));
    expect(taps).toEqual(['04:01']);

    // A card a wait is there for belongs to that wait alone.
    bridge.takeAway();
    const waiting = nfc.waitForCard(PHONE_READER, 1000);
    later(5, () => bridge.bring(card('04:02')));
    expect((await waiting)?.uid).toBe('04:02');
    // Also while the wait still asks whether the last card is there.
    const again = nfc.waitForCard(PHONE_READER, 1000);
    bridge.bring(card('04:04'));
    expect((await again)?.uid).toBe('04:04');
    expect(taps).toEqual(['04:01']);

    stop();
    bridge.bring(card('04:03'));
    expect(taps).toEqual(['04:01']);
    // Reader mode was asked for once, also when the cards page looks for the reader later.
    await nfc.listReaders();
    expect(bridge.started).toBe(1);
  });

  it('"Karte prüfen" on the phone waits for a card first', async () => {
    const { bridge, nfc } = setup();
    expect(await readCardNow(nfc, PHONE_READER, 20)).toBeNull();
    const a = card('04:05');
    a.memory[0] = 0x13;
    later(5, () => bridge.bring(a));
    expect((await readCardNow(nfc, PHONE_READER, 1000))?.data[0]).toBe(0x13);
  });

  it('writes a run of cards one after the other, like the cards page', async () => {
    const { bridge, nfc } = setup();
    await nfc.listReaders();
    // The port of ReaderPanel.tsx, with shorter pauses.
    const port: ReaderPort = {
      waitForCard: async (signal) => {
        while (!signal.aborted) {
          const c = await nfc.waitForCard(PHONE_READER, 100);
          if (c) return c;
        }
        return null;
      },
      waitForRemoval: async (uid, signal) => {
        while (!signal.aborted) {
          const c: NfcCardInfo | null = await nfc.waitForCard(PHONE_READER, 20);
          if (!c || c.uid !== uid) return true;
          await sleep(10);
        }
        return false;
      },
      read: () => nfc.read(PHONE_READER),
      write: (data, uid) => nfc.write(PHONE_READER, data, uid),
    };
    const items: { key: string; data: CardData }[] = [
      { key: 'f1', data: { version: 2, folder: 1, mode: 2, special: 0, special2: 0 } as CardData },
      { key: 'f2', data: { version: 2, folder: 2, mode: 2, special: 0, special2: 0 } as CardData },
    ];
    const a = card('04:A1');
    const b = card('04:B2', 'ntag213');
    const steps: string[] = [];
    const run = writeCards(
      items,
      0,
      port,
      newRunMemory(),
      {
        waiting: (i) => {
          steps.push(`waiting ${i}`);
          // The family holds the next card to the phone.
          later(5, () => bridge.bring(i === 0 ? a : b));
        },
        clash: () => steps.push('clash'),
        occupied: () => steps.push('occupied'),
        writing: () => steps.push('writing'),
        written: (key) => steps.push(`written ${key}`),
        remove: () => {
          steps.push('remove');
          later(20, () => bridge.takeAway());
        },
      },
      new AbortController().signal,
    );
    expect(await run).toEqual({ kind: 'done' });
    expect(steps).toEqual(['waiting 0', 'writing', 'written f1', 'remove', 'waiting 1', 'writing', 'written f2', 'remove']);
    expect(decodeCard(a.memory)).toMatchObject({ kind: 'tonuino', data: { folder: 1 } });
    expect(decodeCard(b.memory)).toMatchObject({ kind: 'tonuino', data: { folder: 2 } });
  });
});

describe('the Android platform', () => {
  const audio = {} as AudioBackend;

  it('is found only in Tauri on Android', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36';
    const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(isTauriAndroid(android)).toBe(false);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    try {
      expect(isTauriAndroid(android)).toBe(true);
      expect(isTauriAndroid(linux)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('without the file and USB bridges: cards with the phone, no SD card, no USB and no desktop extras', async () => {
    const ipc = new FakeIpc().on('open_external', () => null);
    const host: { __tonuinoNfc?: NfcCallbacks } = {};
    const bridge = new FakeBridge(host);
    const p = createAndroidPlatform({ audio, ipc, nfcBridge: bridge, host });
    expect(p).toMatchObject({ kind: 'desktop', os: 'other', mobile: true, handheld: true });
    expect(p.capabilities).toEqual({ sd: false, sdPackage: false, sdAutoDetect: false, eject: false, fsDetails: false, serial: false, nfcReader: true, wifiBox: true, builtInMic: false });
    expect(p.audio).toBe(audio);
    expect(p.nfc.phone).toBe(true);
    expect(await p.nfc.listReaders()).toEqual([PHONE_READER]);
    expect(host.__tonuinoNfc).toBeDefined();
    expect(p.serial.supported).toBe(false);
    for (const key of ['speech', 'sourcesList', 'downloads', 'cardSnapshot', 'onFileDrop', 'holdWindowOpen', 'folderInfo', 'printPdf', 'openAppSettings'] as const) {
      expect(p[key], key).toBeUndefined();
    }
    let seen: unknown[] | undefined;
    p.volumes.subscribe((list) => (seen = list));
    expect(seen).toEqual([]);
    expect(await p.pickBackupFolder()).toBeNull();
    await expect(p.files.save('x.pdf', new Blob(['x']))).rejects.toThrow(/Handy-App/);
    await expect(p.serial.open({ id: 'x', label: 'x' }, 115200)).rejects.toThrow(/Am Computer/);
    await p.openExternal('https://example.org/');
    expect(ipc.calls).toEqual([{ cmd: 'open_external', args: { url: 'https://example.org/' } }]);
  });
});
