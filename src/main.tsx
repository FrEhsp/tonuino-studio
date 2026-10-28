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
// 0.6 „Schlank neu“: the bars and the three screens in front, last of all.
import './ui/styles/schlank.css';
import { boot, card, remembered } from './app/state';
import { route, startAt } from './app/router';
import { startPage } from './app/Kopf';
import { installKarteAhead } from './features/cards/KarteScreen';
import { isTauri, isTauriAndroid } from './platform/tauri/detect';
import { firstScreenFonts } from './ui/fontsReady';
import { quietMoment } from './ui/quiet';
import { installSmallCovers } from './ui/smallCovers';
import { startServiceWorker } from './app/pwa';
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
  // The start page: „Musik auf die SD-Karte“; the Android app opens at „Karte beschreiben“, its main thing (Frank),
  // also with a card reader plugged in: „Musik“ then shows a dot (Kopf.tsx).
  startAt(startPage(!!p.mobile));
  await preloadPage(route.value.page);
  // The Android app answers a card held to the phone on every page (nfcTap.ts).
  if (__DESKTOP_BUILD__ && p.nfc.phone) void import('./features/cards/phoneTaps').then((m) => m.startPhoneTaps(p.nfc));
  render(<App />, document.getElementById('app')!);
  // Missing covers by themselves, in the background (src/features/covers/autoCovers.ts); not for the made-up box of a measurement.
  // Its code comes in the first quiet moment after the start, not with it (Prüfrunde 2, webkit W3); a search starts later anyway.
  if (!m) void quietMoment(1500).then(() => import('./features/covers/autoCovers').then((a) => a.installAutoCovers()));
  // Which known work each folder is, worked out in idle moments, so „Sticker drucken“ opens at once (stickers/warmup.ts).
  // „Sticker“, the third of the three screens in the bar (Musik and Karte come with the start): its code soon after
  // the first frame, not only in the first quiet moment, which may come long after the card was read (Tempo #121).
  const stickerCode = () => void preloadPage('sticker');
  if (typeof requestIdleCallback === 'function') requestIdleCallback(stickerCode, { timeout: 500 });
  else setTimeout(stickerCode, 200);
  // „Karte beschreiben“: the sticker on its card, drawn ahead once the card is read (KarteScreen.tsx).
  installKarteAhead();
  // Small copies of the covers for the tiny pictures in lists, made in quiet moments (src/ui/smallCovers.ts).
  installSmallCovers(() => [...(card.value?.coverUrls.values() ?? []), ...(remembered.value?.coverUrls.values() ?? [])]);
  // Its folders are gone over in idle moments only (warmup.ts), so it can watch the card from the start.
  void import('./features/stickers/warmup').then((w) => w.installWarmup());
  // The logo of index.html goes with the first frame of the app.
  document.getElementById('boot')?.remove();
  // The built web app: installable, offline, "Neue Version da" (src/app/pwa.ts); registered once the browser is idle.
  if (!__DESKTOP_BUILD__ && import.meta.env.PROD) startServiceWorker();
  // "?messen=zeigen" only shows the made-up box (for screenshots).
  if (m && measure !== 'zeigen') void m.measureAndReport(measure!);
});
