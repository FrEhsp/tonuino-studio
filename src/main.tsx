import { render } from 'preact';
import './ui/style-units';
import './ui/styles/index.css';
import { App, preloadPage } from './app/App';
// The style comes after every shared style sheet (the pages bring their own), so its rules
// win where they say something else. It applies under data-stil='holz' on <html> (see src/ui/stil.ts).
import './ui/styles/stil-holz.css';
// Phones and tablets (0.4): after the style, so its rules win where they say something else.
import './ui/styles/handy.css';
// Meine Box with a card as a workbench (0.4.1): after both, its rules only hang on .box-bench.
import './ui/styles/box.css';
import { boot } from './app/state';
import { route, startAt } from './app/router';
import { isTauri, isTauriAndroid } from './platform/tauri/detect';
import { firstScreenFonts } from './ui/fontsReady';
import type { Platform } from './platform/types';

async function createPlatform(): Promise<Platform> {
  // The Android app: cards with the phone's NFC, audio decoded in the WebView like in the web app.
  if (__DESKTOP_BUILD__ && isTauriAndroid()) {
    const [{ createAndroidPlatform }, { createBrowserAudioBackend }] = await Promise.all([import('./platform/tauri/android'), import('./core/audio/browserBackend')]);
    return createAndroidPlatform({ audio: createBrowserAudioBackend() });
  }
  // The desktop app builds its own front end: the web build has no desktop platform at all.
  if (__DESKTOP_BUILD__ && isTauri()) {
    const { createTauriPlatform } = await import('./platform/tauri');
    return createTauriPlatform();
  }
  const [{ createWebPlatform }, { createBrowserAudioBackend }] = await Promise.all([import('./platform/web'), import('./core/audio/browserBackend')]);
  const web = createWebPlatform(createBrowserAudioBackend());
  // Dev and bench builds only: "?als=handy" shows the web app as the Android app (src/app/asPhone.ts),
  // "?als=leser": with a USB card reader as in the desktop app.
  const als = import.meta.env.DEV || import.meta.env.VITE_BENCH_HANDY === '1' ? new URLSearchParams(location.search).get('als') : null;
  if (als === 'handy') return (await import('./app/asPhone')).asPhoneApp(web);
  if (als === 'leser') return (await import('./app/asPhone')).asReaderApp(web);
  return web;
}

/**
 * Where the measuring mode writes its result (desktop, TONUINO_MESSEN=1), "" in the web app
 * with "?messen" in its address, null normally: see src/app/measure.ts.
 * The desktop path is never "zeigen" (it is a file path).
 */
async function measureTarget(): Promise<string | null> {
  if (__DESKTOP_BUILD__ && isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string | null>('measure_mode').catch(() => null);
  }
  const asked = new URLSearchParams(location.search).get('messen');
  return asked === null ? null : asked === 'zeigen' ? 'zeigen' : '';
}

// The first frame comes with its own fonts, so no text changes its width after it showed (fontsReady.ts),
// and with the code of its page when that is not "Meine Box" (a link to another page).
Promise.all([createPlatform(), measureTarget(), firstScreenFonts(), preloadPage(route.value.page)]).then(async ([p, measure]) => {
  const m = measure === null ? null : await import('./app/measure');
  if (m) p = await m.measurePlatform(p);
  boot(p);
  // Phones and tablets: the narrow menu of a tablet held sideways hangs on this (layout.css), set before the first frame.
  if (p.handheld) document.documentElement.setAttribute('data-handheld', '');
  // The Android app opens at the cards, its main thing (Frank), also with a card reader plugged in: Meine Box then shows a dot (Sidebar.tsx).
  if (p.mobile) {
    startAt({ page: 'cards' });
    await preloadPage(route.value.page);
  }
  // The Android app answers a card held to the phone on every page (nfcTap.ts).
  if (__DESKTOP_BUILD__ && p.nfc.phone) void import('./features/cards/phoneTaps').then((m) => m.startPhoneTaps(p.nfc));
  render(<App />, document.getElementById('app')!);
  // The logo of index.html goes with the first frame of the app.
  document.getElementById('boot')?.remove();
  // "?messen=zeigen" only shows the made-up box (for screenshots).
  if (m && measure !== 'zeigen') void m.measureAndReport(measure!);
});
