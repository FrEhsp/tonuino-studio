/**
 * The small bridge between the page and the Kotlin side of the Android app
 * for the SD card (Storage Access Framework, ./androidSaf.ts), the box over
 * USB (./androidUsb.ts), printing and saving (src-tauri/android/TonuinoFiles.kt,
 * TonuinoUsb.kt). The NFC bridge (./nfcAndroid.ts) keeps its own.
 *
 * Kotlin adds plain objects to the page (window.TonuinoFiles,
 * window.TonuinoUsb). Their methods return at once: either a small answer
 * (a string, a number), or nothing, and the answer comes later through
 *
 *   window.__tonuinoAndroid.done(id, result)   result = {ok: true, …} or {ok: false, code, message}
 *   window.__tonuinoAndroid.event(name, data)  "usb-data", "usb-gone", "usb-devices", "storage"
 *
 * A big answer (file bytes, a long folder list) does not travel through
 * done(): the result says `payload: true`, and the page fetches it at once
 * with the bridge's take(id), so it never has to be parsed as script.
 */

/** What the Kotlin side answers through done(). */
export type BridgeResult = ({ ok: true; payload?: boolean } & Record<string, unknown>) | { ok: false; code: string; message?: string };

/** The callbacks Kotlin calls in the page: window.__tonuinoAndroid. */
export interface AndroidCallbacks {
  done(id: string, result: BridgeResult): void;
  event(name: string, data: unknown): void;
}

declare global {
  interface Window {
    __tonuinoAndroid?: AndroidCallbacks;
  }
}

/** An error the Kotlin side reported, or a call that got no answer. */
export class AndroidBridgeError extends Error {
  readonly code: string;
  /** What Kotlin said, for logs and support. */
  readonly detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'AndroidBridgeError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

/** A call that may wait for the user (a chooser, a permission question) has no time limit. */
export const NO_TIMEOUT = 0;

interface Pending {
  resolve(result: Record<string, unknown>): void;
  reject(error: AndroidBridgeError): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Fetches the payload of this call (the bridge's take). */
  take?: (id: string) => string;
}

/**
 * Hands out ids, waits for done(id) and passes events on. One instance per
 * page; the file and the USB part share it, because Kotlin calls one
 * window.__tonuinoAndroid.
 */
export class AndroidCalls {
  private counter = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  /** `host` is the window Kotlin calls into (tests pass their own). */
  constructor(host: { __tonuinoAndroid?: AndroidCallbacks } = window) {
    host.__tonuinoAndroid = {
      done: (id, result) => this.onDone(id, result),
      event: (name, data) => this.onEvent(name, data),
    };
  }

  /**
   * Sends one call and resolves with its result (without `ok`). With `take`,
   * a result that says `payload: true` gets the payload as `payload` (a string).
   * Rejects with the code Kotlin sent, or 'timeout' after `timeoutMs`.
   */
  call<T extends Record<string, unknown> = Record<string, unknown>>(send: (id: string) => void, timeoutMs: number, take?: (id: string) => string): Promise<T> {
    this.counter += 1;
    const id = `a${this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new AndroidBridgeError('timeout', 'Das Handy hat nicht geantwortet. Versuche es noch einmal.', `no answer within ${timeoutMs} ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve: resolve as (r: Record<string, unknown>) => void, reject, timer, take });
      try {
        send(id);
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(new AndroidBridgeError('other', e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /** Listens to one kind of event; returns the way to stop. */
  on(name: string, cb: (data: unknown) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  private onDone(id: string, result: BridgeResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (!result || typeof result !== 'object') {
      p.reject(new AndroidBridgeError('other', 'Das Handy hat eine unverständliche Antwort geschickt.', String(result)));
      return;
    }
    if (!result.ok) {
      const code = typeof result.code === 'string' && result.code ? result.code : 'other';
      p.reject(new AndroidBridgeError(code, typeof result.message === 'string' ? result.message : code, typeof result.message === 'string' ? result.message : undefined));
      return;
    }
    const { ok: _ok, payload, ...rest } = result;
    if (payload && p.take) {
      // Kotlin keeps the payload only until it is taken: take it now, not when the caller gets to it.
      let data: string;
      try {
        data = p.take(id);
      } catch (e) {
        p.reject(new AndroidBridgeError('other', e instanceof Error ? e.message : String(e)));
        return;
      }
      p.resolve({ ...rest, payload: data });
      return;
    }
    p.resolve(rest);
  }

  private onEvent(name: string, data: unknown): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(data);
      } catch {
        // One listener failing must not keep the others from hearing it.
      }
    }
  }
}

/* ------------------------------------------------------------------ base64 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CODES = Uint8Array.from(B64, (c) => c.charCodeAt(0));
const B64_INDEX = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();
const PAD = 61; // '='
const ascii = typeof TextDecoder === 'undefined' ? undefined : new TextDecoder('latin1');

/**
 * Bytes as base64, the way they cross the bridge (Kotlin: android.util.Base64
 * with NO_WRAP). Written out instead of btoa, which wants a string of every
 * byte first: half a megabyte of audio per call is common here.
 */
export function toBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64_CODES[n >> 18];
    out[o++] = B64_CODES[(n >> 12) & 63];
    out[o++] = B64_CODES[(n >> 6) & 63];
    out[o++] = B64_CODES[n & 63];
  }
  if (i < bytes.length) {
    const two = i + 1 < bytes.length;
    const n = (bytes[i] << 16) | (two ? bytes[i + 1] << 8 : 0);
    out[o++] = B64_CODES[n >> 18];
    out[o++] = B64_CODES[(n >> 12) & 63];
    out[o++] = two ? B64_CODES[(n >> 6) & 63] : PAD;
    out[o++] = PAD;
  }
  if (ascii) return ascii.decode(out);
  let s = '';
  for (let k = 0; k < out.length; k += 8192) s += String.fromCharCode(...out.subarray(k, k + 8192));
  return s;
}

/** Base64 back to bytes; skips line breaks and spaces, rejects anything else. */
export function fromBase64(text: string): Uint8Array {
  const codes = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) continue;
    if (c > 255 || (c !== PAD && B64_INDEX[c] < 0)) throw new Error(`not base64 at ${i}`);
    codes[n++] = c;
  }
  if (n % 4 !== 0) throw new Error(`base64 of length ${n}`);
  const pad = n && codes[n - 1] === PAD ? (codes[n - 2] === PAD ? 2 : 1) : 0;
  const out = new Uint8Array((n / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const a = B64_INDEX[codes[i]];
    const b = B64_INDEX[codes[i + 1]];
    const c = codes[i + 2] === PAD ? 0 : B64_INDEX[codes[i + 2]];
    const d = codes[i + 3] === PAD ? 0 : B64_INDEX[codes[i + 3]];
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error(`not base64 at ${i}`);
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = v >> 16;
    if (o < out.length) out[o++] = (v >> 8) & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}
