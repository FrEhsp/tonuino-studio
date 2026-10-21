/**
 * NfcAccess for the Android app: the phone's own NFC through the small
 * Kotlin bridge MainActivity adds to the WebView (src-tauri/android/TonuinoNfc.kt).
 * The card logic sits there and is the one of the desktop's PC/SC reader
 * (src-tauri/src/nfc.rs): 16 bytes in MIFARE Classic block 4 or in
 * Ultralight/NTAG pages 8–11, every write read back.
 *
 *   window.TonuinoNfc        state(), openSettings(), start(), stop(),
 *                            read(id), write(id, hex, uid), check(id)
 *   window.__tonuinoNfc      tag(event) when a card comes to the phone,
 *                            done(id, result) when read/write/check ends,
 *                            state(state) when the app comes back to the front
 *
 * A phone has no "card lies on the reader": Android reports a card once when
 * it comes close. waitForCard therefore asks the bridge whether the last card
 * still answers (check) and otherwise waits for the next one.
 */
import type { NfcAccess, NfcCardInfo, NfcCardType, NfcReadResult, PhoneNfcState } from '../types';
import { hintInfo, messageFor, platformError, TauriPlatformError } from './errors';

/** What MainActivity adds to the page as window.TonuinoNfc. */
export interface NfcBridge {
  state(): string;
  openSettings(): void;
  start(): void;
  stop(): void;
  read(id: string): void;
  /** `uid`: the card meant, "" for whichever came last. Another card there: code 'wrong-card'. */
  write(id: string, hex: string, uid: string): void;
  check(id: string): void;
}

/** A card came to the phone. */
export interface NfcTagEvent {
  /** Hex bytes separated by colons, like the desktop. */
  uid: string;
  type: string;
  sak?: string;
  atqa?: string;
  /** MIFARE Classic only: whether this phone can talk to it (it needs a chip from NXP). */
  classic?: boolean;
}

export type NfcBridgeResult = { ok: true; uid: string; type: string; data?: string } | { ok: false; code: string; message?: string; hints?: string[] };

/** What the bridge calls in the page: window.__tonuinoNfc. */
export interface NfcCallbacks {
  tag(event: NfcTagEvent): void;
  done(id: string, result: NfcBridgeResult): void;
  state(state: string): void;
}

declare global {
  interface Window {
    TonuinoNfc?: NfcBridge;
    __tonuinoNfc?: NfcCallbacks;
  }
}

/** The one "reader" of the phone, as the cards page shows it. */
export const PHONE_READER = 'Handy';

/** Longest a read, write or check may take before the page gives up on the bridge. */
export const OP_TIMEOUT_MS = 15_000;

const CARD_TYPES: readonly NfcCardType[] = ['mifare-classic-1k', 'mifare-classic-4k', 'mifare-classic-mini', 'mifare-ultralight', 'ntag213', 'ntag215', 'ntag216', 'unknown'];

/**
 * The phone's own words where the reader's ("lass sie liegen") do not fit.
 * Every other code keeps the text of errors.ts ('nfc:…').
 */
const PHONE_MESSAGES: Record<string, string> = {
  'no-nfc': 'Dieses Handy hat kein NFC. Damit kann es keine Karten beschreiben.',
  'nfc-off': 'NFC ist ausgeschaltet. Schalte es ein, dann geht es weiter.',
  // Thick cases, metal plates for magnet holders and bank cards in a wallet case keep the card away or answer instead of it.
  'no-card':
    'Keine Karte am Handy. Halte die Karte an die Rückseite deines Handys und schiebe sie langsam hin und her. Steckt das Handy in einer dicken Hülle, mit Metallplatte oder mit Bankkarten darin, nimm es heraus.',
  'tag-lost': 'Die Karte war zu kurz am Handy. Halte sie ruhig an die Rückseite und versuche es noch einmal.',
  'classic-unsupported':
    'Dieses Handy kann MIFARE-Classic-Karten nicht beschreiben, dafür fehlt ihm ein bestimmter NFC-Chip. Karten und Sticker mit NTAG213 oder NTAG215 gehen mit jedem Handy.',
  'read-failed': 'Die Karte konnte nicht gelesen werden. Halte sie ruhig an die Rückseite und versuche es noch einmal.',
  'write-failed': 'Die Karte konnte nicht beschrieben werden. Halte sie ruhig an die Rückseite und versuche es noch einmal.',
  'write-refused': 'Die Karte hat das Schreiben abgelehnt. Ist sie schreibgeschützt, nimm eine andere Karte. Sonst versuche es noch einmal.',
  'verify-failed': 'Beim Prüfen stand etwas anderes auf der Karte. Halte sie ruhig an die Rückseite und schreibe sie noch einmal.',
  'wrong-card': 'Am Handy ist jetzt eine andere Karte. Halte die Karte, die du beschreiben willst, an die Rückseite und versuche es noch einmal.',
  timeout: 'Das Handy hat nicht geantwortet. Versuche es noch einmal.',
};

export function phoneNfcError(code: string, detail?: string, hintIds: string[] = []): TauriPlatformError {
  return new TauriPlatformError(code, PHONE_MESSAGES[code] ?? messageFor(code, 'nfc'), detail, hintIds.map((id) => hintInfo({ id })));
}

function cardType(type: string): NfcCardType {
  return (CARD_TYPES as readonly string[]).includes(type) ? (type as NfcCardType) : 'unknown';
}

function toHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A bridge that is not there (an APK built without the Kotlin files): a phone without NFC. */
const NO_BRIDGE: NfcBridge = {
  state: () => 'none',
  openSettings: () => undefined,
  start: () => undefined,
  stop: () => undefined,
  read: () => undefined,
  write: () => undefined,
  check: () => undefined,
};

interface Pending {
  resolve(result: NfcBridgeResult & { ok: true }): void;
  reject(error: TauriPlatformError): void;
  timer: ReturnType<typeof setTimeout>;
}

export class AndroidNfc implements NfcAccess {
  readonly supported = true;
  readonly phone = true;
  private readonly bridge: NfcBridge;
  /** The last card that came to the phone; null once it is known to be gone. */
  private current: NfcCardInfo | null = null;
  /** Counts the cards that came, so a wait notices one that came meanwhile. */
  private seq = 0;
  private readonly waiters = new Set<(card: NfcCardInfo) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly stateListeners = new Set<(state: PhoneNfcState) => void>();
  private readonly tapListeners = new Set<(card: NfcCardInfo) => void>();
  /** waitForCard calls running; a card that comes then is not a tap. */
  private waiting = 0;
  private started = false;
  private counter = 0;

  /** `host` is the window the bridge calls back into (tests pass their own). */
  constructor(bridge: NfcBridge | undefined, host: { __tonuinoNfc?: NfcCallbacks } = window) {
    this.bridge = bridge ?? NO_BRIDGE;
    host.__tonuinoNfc = {
      tag: (e) => this.onTag(e),
      done: (id, r) => this.onDone(id, r),
      state: (s) => this.onState(s),
    };
  }

  /** Whether the phone has NFC and whether it is switched on. */
  state(): PhoneNfcState {
    let s: string;
    try {
      s = this.bridge.state();
    } catch {
      return 'none';
    }
    return s === 'on' || s === 'off' ? s : 'none';
  }

  openSettings(): void {
    this.bridge.openSettings();
  }

  onStateChange(cb: (state: PhoneNfcState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /**
   * Cards no wait was there for. Reader mode goes on now and stays on: the
   * bridge sets it only while the app is in the front, and once NFC is
   * switched on in the settings.
   */
  onTap(cb: (card: NfcCardInfo) => void): () => void {
    this.tapListeners.add(cb);
    this.start();
    return () => this.tapListeners.delete(cb);
  }

  /** ['Handy'] while NFC is on; [] without NFC; rejects with 'nfc-off' while it is switched off. */
  async listReaders(): Promise<string[]> {
    const s = this.state();
    if (s === 'none') return [];
    if (s === 'off') throw phoneNfcError('nfc-off', 'NFC is switched off');
    this.start();
    return [PHONE_READER];
  }

  async waitForCard(_reader: string, timeoutMs: number): Promise<NfcCardInfo | null> {
    this.ensureOn();
    this.start();
    // From here on a card that comes is this wait's, also while the last one is asked first.
    this.waiting += 1;
    try {
      const seen = this.seq;
      if (this.current) {
        const still = await this.present();
        if (still) return still;
        // A new card may have come while the old one was asked.
        if (this.seq !== seen && this.current) return this.current;
      }
      return await this.nextCard(timeoutMs);
    } finally {
      this.waiting -= 1;
    }
  }

  async read(_reader: string): Promise<NfcReadResult> {
    this.ensureOn();
    const r = await this.op((id) => this.bridge.read(id));
    if (!r.data || !/^[0-9A-Fa-f]{32}$/.test(r.data)) throw phoneNfcError('read-failed', `bridge sent ${r.data?.length ?? 0} hex digits`);
    return { ...this.info(r), data: fromHex(r.data) };
  }

  async write(_reader: string, data: Uint8Array, uid?: string): Promise<void> {
    if (data.length !== 16) throw platformError('invalid-argument', 'nfc', `expected 16 bytes, got ${data.length}`);
    this.ensureOn();
    // Android writes to the card that came last; one that came after the caller looked is refused there.
    const meant = uid ?? this.current?.uid ?? '';
    try {
      await this.op((id) => this.bridge.write(id, toHex(data), meant));
    } catch (e) {
      // Android reports a page the card refuses (locked) like a card taken away; one that still answers refused it (Testlabor #69).
      if (e instanceof TauriPlatformError && e.code === 'tag-lost' && (await this.present())) throw phoneNfcError('write-refused', e.detail);
      throw e;
    }
  }

  /** Reader mode on; it stays on while the app is in the front (the bridge pauses it in the background). */
  private start(): void {
    if (this.started) return;
    this.started = true;
    this.bridge.start();
  }

  private ensureOn(): void {
    const s = this.state();
    if (s === 'none') throw phoneNfcError('no-nfc', 'this phone has no NFC');
    if (s === 'off') throw phoneNfcError('nfc-off', 'NFC is switched off');
  }

  /** The last card, if it still answers; null when it is gone. */
  private async present(): Promise<NfcCardInfo | null> {
    const seen = this.seq;
    try {
      await this.op((id) => this.bridge.check(id));
      return this.seq === seen ? this.current : null;
    } catch {
      // Gone (or no answer): forget it, unless a new card came meanwhile.
      if (this.seq === seen) this.current = null;
      return null;
    }
  }

  private nextCard(timeoutMs: number): Promise<NfcCardInfo | null> {
    return new Promise((resolve) => {
      const done = (card: NfcCardInfo | null) => {
        clearTimeout(timer);
        this.waiters.delete(take);
        resolve(card);
      };
      const take = (card: NfcCardInfo) => done(card);
      const timer = setTimeout(() => done(null), Math.max(0, timeoutMs));
      this.waiters.add(take);
    });
  }

  private op(send: (id: string) => void): Promise<NfcBridgeResult & { ok: true }> {
    this.counter += 1;
    const id = `nfc${this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(phoneNfcError('timeout', 'no answer from the NFC bridge'));
      }, OP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        send(id);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(phoneNfcError('other', e instanceof Error ? e.message : String(e)));
      }
    });
  }

  private info(r: { uid: string; type: string }): NfcCardInfo {
    return { uid: r.uid, type: cardType(r.type), ...(this.current?.uid === r.uid && this.current.details ? { details: this.current.details } : {}) };
  }

  private onTag(e: NfcTagEvent): void {
    if (!e || typeof e.uid !== 'string') return;
    const details = [e.sak ? `SAK ${e.sak}` : '', e.atqa ? `ATQA ${e.atqa}` : ''].filter(Boolean).join(' · ');
    const card: NfcCardInfo = { uid: e.uid, type: cardType(e.type), ...(details ? { details } : {}) };
    this.current = card;
    this.seq += 1;
    const waited = this.waiting > 0;
    for (const take of [...this.waiters]) take(card);
    if (waited) return;
    for (const cb of [...this.tapListeners]) {
      try {
        cb(card);
      } catch {
        // One listener's trouble does not keep the card from the others.
      }
    }
  }

  private onDone(id: string, r: NfcBridgeResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (r && r.ok) p.resolve(r);
    else p.reject(phoneNfcError(r?.code || 'other', r?.message, Array.isArray(r?.hints) ? r.hints : []));
  }

  private onState(s: string): void {
    const state: PhoneNfcState = s === 'on' || s === 'off' ? s : 'none';
    for (const cb of [...this.stateListeners]) cb(state);
  }
}
