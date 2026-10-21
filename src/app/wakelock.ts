/**
 * Keeps the screen on while a long write runs, so the computer or the phone
 * does not go to sleep half-way through it. A laptop that sleeps cuts the
 * copy to the card short; a phone whose screen goes off pauses the app, and
 * a strict battery saver may end it (TODO #60). Uses the Screen Wake Lock API
 * where the browser or WebView has it (Chrome, Edge, WebView2, newer WebKit);
 * elsewhere nothing changes. The system lets go of the lock whenever the page
 * is hidden, so it is asked for again when the page comes back.
 */
import { effect, type ReadonlySignal } from '@preact/signals';
import type { WriteKind } from './writeguard';

/** Kinds that only wait for something (no write runs): no reason to keep the screen on. */
const WAITING: readonly WriteKind[] = ['selection', 'downloads'];

export interface WakeLockHost {
  /** Asks for the screen lock; rejects or resolves null where it is not possible. */
  request(): Promise<{ release(): Promise<void> } | null>;
  visible(): boolean;
  /** Calls `cb` whenever the page is shown or hidden; returns the function that stops it. */
  onVisibility(cb: () => void): () => void;
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

/** The page's own wake lock, or null where there is none. */
export function pageWakeLock(): WakeLockHost | null {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return null;
  const api = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
  if (!api || typeof api.request !== 'function') return null;
  return {
    request: () => api.request('screen'),
    visible: () => document.visibilityState === 'visible',
    onVisibility(cb) {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
  };
}

/** Whether these writes need the screen kept on. */
export function needsAwake(running: readonly WriteKind[]): boolean {
  return running.some((k) => !WAITING.includes(k));
}

/** Holds the screen lock while `running` has a write; returns the function that stops it. */
export function keepAwakeWhileWriting(running: ReadonlySignal<readonly WriteKind[]>, host: WakeLockHost | null = pageWakeLock()): () => void {
  if (!host) return () => undefined;
  let lock: { release(): Promise<void> } | null = null;
  let asking = false;
  let wanted = false;
  let stopped = false;

  const letGo = () => {
    const held = lock;
    lock = null;
    void held?.release().catch(() => undefined);
  };
  const sync = () => {
    if (stopped) return;
    if (!wanted) return letGo();
    if (lock || asking || !host.visible()) return;
    asking = true;
    host
      .request()
      .then((l) => {
        lock = l;
        // The write may have ended while the system answered.
        if (!wanted || stopped) letGo();
      })
      .catch(() => {
        // Refused (power saving, no permission): the write goes on without it.
      })
      .finally(() => {
        asking = false;
      });
  };
  const onVisibility = () => {
    // A hidden page lost its lock; the sentinel is spent.
    if (!host.visible()) lock = null;
    sync();
  };
  const stopVisibility = host.onVisibility(onVisibility);
  const stopEffect = effect(() => {
    wanted = needsAwake(running.value);
    sync();
  });
  return () => {
    stopped = true;
    stopEffect();
    stopVisibility();
    letGo();
  };
}
