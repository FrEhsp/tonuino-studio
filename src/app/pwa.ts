/**
 * The web app's service worker (src/pwa/sw.template.js, built by
 * scripts/pwa.ts): registered once the first page is on the screen and the
 * browser is idle, so the start is not slower. It makes the web app
 * installable and opens it offline. When the server has a new version, an
 * open tab says "Neue Version da · neu laden" (UpdateNotice.tsx).
 *
 * The page knows its own version (meta tonuino-build in index.html); the
 * service worker tells its own on request. A new one that waits, or one
 * that took over, with another version than the page: there is a newer
 * version than the one on the screen.
 */
import { signal } from '@preact/signals';

/** A newer version than the page on the screen is ready: one reload brings it. */
export const newVersionWaiting = signal(false);

/** How often an open tab asks the server for a new version. */
export const CHECK_EVERY_MS = 60 * 60 * 1000;

let registration: ServiceWorkerRegistration | undefined;

/** Chrome's and Edge's offer to install the web app (beforeinstallprompt), kept for the button in the settings. */
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
export const installOffer = signal<InstallPrompt | null>(null);

/** The web app runs as an installed app (its own window). */
export function runsInstalled(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

/** "Als App installieren": the browser asks; afterwards the offer is gone either way. */
export async function install(): Promise<boolean> {
  const offer = installOffer.peek();
  if (!offer) return false;
  installOffer.value = null;
  await offer.prompt();
  return (await offer.userChoice).outcome === 'accepted';
}

/** The version of the page on the screen, '' in a build without a service worker. */
export function pageVersion(doc: Pick<Document, 'querySelector'> = document): string {
  return doc.querySelector('meta[name="tonuino-build"]')?.getAttribute('content') ?? '';
}

/** Whether to say "neu laden": a worker of another version waits or took over. */
export function isNewer(page: string, worker: string | undefined): boolean {
  return !!page && !!worker && worker !== page;
}

/** Asks a service worker for its version; undefined when it does not answer in time. */
function versionOf(worker: ServiceWorker): Promise<string | undefined> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const t = setTimeout(() => resolve(undefined), 3000);
    channel.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(typeof e.data === 'string' ? e.data : undefined);
    };
    worker.postMessage({ type: 'version' }, [channel.port2]);
  });
}

async function look(reg: ServiceWorkerRegistration): Promise<void> {
  const worker = reg.waiting ?? navigator.serviceWorker.controller ?? reg.active;
  if (!worker) return;
  newVersionWaiting.value = isNewer(pageVersion(), await versionOf(worker));
}

/**
 * Registers the service worker of the web app. Only in a built web app on
 * https (or localhost) with one; never in the desktop app, the dev server or
 * the tests.
 */
export function startServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext || !pageVersion()) return;
  // The browser may offer to install right after the start; the settings show it as a button (WebAbilities.tsx).
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installOffer.value = e as InstallPrompt;
  });
  window.addEventListener('appinstalled', () => (installOffer.value = null));
  const go = async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      registration = reg;
      const watch = (w: ServiceWorker | null) => w?.addEventListener('statechange', () => w.state === 'installed' && void look(reg));
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      navigator.serviceWorker.addEventListener('controllerchange', () => void look(reg));
      void look(reg);
      // A tab that stays open asks now and then, and when it comes to the front again.
      setInterval(() => void reg.update().catch(() => undefined), CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void reg.update().catch(() => undefined));
    } catch {
      // No service worker (blocked, private window): the app works as before, only not offline.
    }
  };
  // After the first page and the busy start: when the browser has nothing else to do.
  const idle = () => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => void go(), { timeout: 10_000 }) : setTimeout(() => void go(), 3000));
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
}

/** "neu laden": the waiting version takes over, then the page loads again with it. */
export async function reloadToNewest(): Promise<void> {
  const waiting = registration?.waiting;
  if (!waiting) {
    location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  waiting.postMessage({ type: 'skip-waiting' });
  // Should the switch not come (an old browser), the page from the server is the newest anyway.
  setTimeout(() => location.reload(), 3000);
}
