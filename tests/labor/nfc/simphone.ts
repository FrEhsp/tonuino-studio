/**
 * A phone with NFC for the test bench (TODO #69): window.TonuinoNfc as
 * src-tauri/android/TonuinoNfc.kt implements it, with cards that answer
 * like real ones. The app's AndroidNfc (src/platform/tauri/nfcAndroid.ts)
 * talks to it unchanged.
 *
 * What the Kotlin side does and this copies:
 * - one worker thread: card events and operations run one after the other,
 *   in the order they came;
 * - every operation works on the card that came last (lastTag); a write
 *   names the card the page means and is refused ("wrong-card") when
 *   another one came since;
 * - a card that left the phone, or a stale Tag of a card that came again,
 *   fails with IOException / SecurityException: "tag-lost";
 * - MIFARE Classic: block 4 with key A FF…FF, verified by reading back; a
 *   phone without NXP chip cannot talk to it ("classic-unsupported");
 * - Ultralight/NTAG: pages 8–11, one page per WRITE, so a card taken away
 *   in between keeps some new and some old pages.
 */
import type { NfcBridge, NfcBridgeResult, NfcCallbacks } from '../../../src/platform/tauri/nfcAndroid';

export type SimCardType = 'mifare-classic-1k' | 'mifare-classic-4k' | 'mifare-ultralight' | 'ntag213' | 'ntag215' | 'ntag216' | 'desfire';

export interface SimTag {
  uid: string;
  type: SimCardType;
  /** The 16 bytes TonUINO uses (Classic block 4, or pages 8–11). */
  data: Uint8Array;
  /** Key A of sector 1: 'default' FF…FF, 'ndef' D3 F7… (a phone app "formatted" it), 'other'. */
  key?: 'default' | 'ndef' | 'other';
  /** Pages or block locked: writes are refused (NAK). */
  locked?: boolean;
}

export function tag(uid: string, type: SimCardType, data: Uint8Array = new Uint8Array(16), extra: Partial<SimTag> = {}): SimTag {
  return { uid, type, data: data.slice(), ...extra };
}

class CardError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
  }
}
/** android.nfc.TagLostException and friends. */
class IoError extends Error {}

const SAK: Record<SimCardType, number> = {
  'mifare-classic-1k': 0x08,
  'mifare-classic-4k': 0x18,
  'mifare-ultralight': 0x00,
  ntag213: 0x00,
  ntag215: 0x00,
  ntag216: 0x00,
  desfire: 0x20,
};

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export interface PhoneHooks {
  /** Before page `page` (8–11) of an Ultralight/NTAG is written. */
  beforePage?(t: SimTag, page: number): void;
  /** Before a read of the card's 16 bytes. */
  beforeRead?(t: SimTag): void;
  /** After the card's 16 bytes were read, before the answer goes to the page. */
  afterRead?(t: SimTag): void;
  /** Before a write starts. */
  beforeWrite?(t: SimTag): void;
}

export class SimPhone implements NfcBridge {
  /** 'none': no NFC in this phone; 'off': switched off in the settings. */
  nfc: 'none' | 'off' | 'on' = 'on';
  /** MIFARE Classic needs a chip from NXP in the phone. */
  nxpChip = true;
  /** How long one exchange with a card takes, in ms. */
  exchangeMs = 4;
  hooks: PhoneHooks = {};
  /** What the page asked for, in order. */
  readonly calls: string[] = [];
  /** Card writes that reached a card: uid and the 16 bytes. */
  readonly writes: { uid: string; data: string }[] = [];

  private reading = false;
  /** The card held to the phone right now, and which discovery of it Android knows. */
  private field: { tag: SimTag; discovery: number } | null = null;
  private lastTag: { tag: SimTag; discovery: number } | null = null;
  private discoveries = 0;
  private worker: Promise<void> = Promise.resolve();

  constructor(private readonly host: { __tonuinoNfc?: NfcCallbacks }) {}

  /* ------------------------------------------------- the person with the card */

  /** Holds a card to the phone. With reader mode on, Android reports it. */
  hold(t: SimTag): void {
    const d = { tag: t, discovery: ++this.discoveries };
    this.field = d;
    if (this.reading && this.nfc === 'on') {
      this.onWorker(async () => {
        this.lastTag = d;
        const event: Record<string, unknown> = { uid: t.uid.match(/../g)!.join(':'), type: this.detect(t), sak: SAK[t.type].toString(16).padStart(2, '0').toUpperCase(), atqa: '4400' };
        if (t.type.startsWith('mifare-classic')) event.classic = this.nxpChip;
        this.push(() => this.host.__tonuinoNfc?.tag(event as never));
      });
    }
  }

  /** Takes the card away from the phone. */
  takeAway(): void {
    this.field = null;
  }

  /** Waits until everything queued on the worker ran and its answers reached the page. */
  async idle(): Promise<void> {
    await this.worker;
    await new Promise((r) => setTimeout(r, 5));
  }

  /* --------------------------------------------------------- window.TonuinoNfc */

  state(): string {
    return this.nfc;
  }
  openSettings(): void {
    this.calls.push('openSettings');
  }
  start(): void {
    this.calls.push('start');
    const was = this.reading;
    this.reading = true;
    // Reader mode finds a card that already lies at the phone.
    if (!was && this.field) this.hold(this.field.tag);
  }
  stop(): void {
    this.calls.push('stop');
    this.reading = false;
  }
  read(id: string): void {
    this.calls.push('read');
    this.onWorker(() => this.answer(id, () => this.readCard()));
  }
  write(id: string, hexData: string, uid: string): void {
    this.calls.push('write');
    this.onWorker(() =>
      this.answer(id, () => {
        if (!/^[0-9A-Fa-f]{32}$/.test(hexData)) throw new CardError('invalid-argument', 'exactly 16 bytes (32 hex digits) expected');
        const data = new Uint8Array(16);
        for (let i = 0; i < 16; i++) data[i] = parseInt(hexData.slice(i * 2, i * 2 + 2), 16);
        return this.writeCard(data, uid);
      }),
    );
  }
  check(id: string): void {
    this.calls.push('check');
    this.onWorker(() =>
      this.answer(id, async () => {
        const t = this.current();
        await this.exchange(t);
        return this.cardJson(t.tag);
      }),
    );
  }

  /* ------------------------------------------------------------------ inside */

  private onWorker(job: () => Promise<void>): void {
    this.worker = this.worker.then(job, job);
  }

  /** evaluateJavascript: the page hears it a moment later. */
  private push(fn: () => void): void {
    setTimeout(fn, 1);
  }

  private detect(t: SimTag): string {
    return t.type === 'desfire' ? 'unknown' : t.type;
  }

  private cardJson(t: SimTag): Record<string, unknown> {
    return { uid: t.uid.match(/../g)!.join(':'), type: this.detect(t) };
  }

  private current(): { tag: SimTag; discovery: number } {
    if (!this.lastTag) throw new CardError('no-card', 'no card came to the phone yet');
    return this.lastTag;
  }

  /** One exchange with the card: it must still be the one Android knows, at the phone. */
  private async exchange(d: { tag: SimTag; discovery: number }): Promise<void> {
    await new Promise((r) => setTimeout(r, this.exchangeMs));
    if (!this.field || this.field.tag !== d.tag) throw new IoError('Tag was lost.');
    if (this.field.discovery !== d.discovery) throw new IoError('Tag is out of date');
  }

  private async readCard(): Promise<Record<string, unknown>> {
    const d = this.current();
    const t = d.tag;
    const type = this.detect(t);
    if (type.startsWith('mifare-classic')) await this.classicLogin(d);
    else if (type === 'unknown') throw new CardError('unsupported-card', `card type ${type}`);
    this.hooks.beforeRead?.(t);
    await this.exchange(d);
    this.hooks.afterRead?.(t);
    return { ...this.cardJson(t), data: hex(t.data) };
  }

  private async writeCard(data: Uint8Array, expected: string): Promise<Record<string, unknown>> {
    const d = this.current();
    const t = d.tag;
    const there = this.cardJson(t).uid as string;
    if (expected && there.toLowerCase() !== expected.toLowerCase()) throw new CardError('wrong-card', `expected ${expected}, the phone has ${there}`);
    const type = this.detect(t);
    if (type === 'unknown') throw new CardError('unsupported-card', `card type ${type}`);
    this.hooks.beforeWrite?.(t);
    if (type.startsWith('mifare-classic')) {
      await this.classicLogin(d);
      await this.exchange(d);
      if (t.locked) throw new IoError('Transceive failed');
      t.data = data.slice();
      this.writes.push({ uid: t.uid, data: hex(data) });
    } else {
      for (let i = 0; i < 4; i++) {
        this.hooks.beforePage?.(t, 8 + i);
        await this.exchange(d);
        if (t.locked) throw new IoError('Transceive failed');
        t.data.set(data.subarray(i * 4, i * 4 + 4), i * 4);
      }
      this.writes.push({ uid: t.uid, data: hex(data) });
    }
    // Read back and compare, like nfc.rs.
    try {
      await this.exchange(d);
    } catch (e) {
      throw new CardError('verify-failed', `read back: ${(e as Error).message}`);
    }
    if (hex(t.data) !== hex(data)) throw new CardError('verify-failed', 'wrote something else than read back');
    return this.cardJson(t);
  }

  private async classicLogin(d: { tag: SimTag; discovery: number }): Promise<void> {
    if (!this.nxpChip) throw new CardError('classic-unsupported', 'this phone cannot talk MIFARE Classic');
    await this.exchange(d);
    const key = d.tag.key ?? 'default';
    if (key !== 'default') throw new CardError('auth-failed', 'key A FF FF FF FF FF FF rejected for sector 1', [key === 'ndef' ? 'card-ndef-formatted' : 'card-keys-changed']);
  }

  private async answer(id: string, op: () => Promise<Record<string, unknown>>): Promise<void> {
    let result: NfcBridgeResult;
    try {
      result = { ok: true, ...(await op()) } as NfcBridgeResult;
    } catch (e) {
      if (e instanceof CardError) result = { ok: false, code: e.code, message: e.message, ...(e.hints.length ? { hints: e.hints } : {}) };
      else if (e instanceof IoError) result = { ok: false, code: 'tag-lost', message: e.message };
      else result = { ok: false, code: 'other', message: String(e) };
    }
    this.push(() => this.host.__tonuinoNfc?.done(id, result));
  }
}
