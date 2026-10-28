/*
 * The service worker of the TonUINO Studio web app (TODO #122, #123): makes
 * the web app installable, opens it without internet, and tells an open tab
 * that a new version is there ("Neue Version da · neu laden", src/app/pwa.ts).
 *
 * scripts/pwa.ts fills in the placeholders when the web app is built; the
 * desktop and Android apps have none of this. Plain JavaScript on purpose:
 * it is copied as it is, next to index.html.
 *
 * - The page itself (index.html) comes from the server first, as without a
 *   service worker, so a reload always brings the newest version. Only
 *   without a connection the copy of this version answers.
 * - Files below assets/ have their content in their names. Online the
 *   browser loads them as without a service worker (from its own cache):
 *   answered from the worker's cache, WebKit drew the first frame of the
 *   web app twice as late (Prüfrunde 2, webkit W3). The worker keeps a copy
 *   (the files of the first page already at install, the other pages once
 *   opened), and without a connection, once the page came from its copy,
 *   they come from there. Old ones go when a new version takes over.
 * - Everything else (the list of "Entdecken", help pictures, firmware,
 *   other servers) passes by untouched.
 * - A new version waits until the user says "neu laden" or every tab of the
 *   old one is closed. It never reloads a page by itself.
 */
/* eslint-disable no-restricted-globals */
const VERSION = '__VERSION__';
/** Kept at install: the page and what it loads first. Relative to the scope. */
const SHELL = __SHELL__;
/** Every file below assets/ of this version. */
const ASSETS = __ASSETS__;

const SHELL_CACHE = `tonuino-studio-${VERSION}`;
const ASSET_CACHE = 'tonuino-studio-assets';

/** A copy of a file the page just loaded is kept this long after, when the browser has it in its own cache. */
const KEEP_AFTER_MS = 1500;

/** The page came from the kept copy (no connection): its files come from the kept copies too. */
let offline = false;

const scope = () => new URL(self.registration.scope);
const inScope = (path) => new URL(path, scope()).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // The page asks the server again (no-cache); the rest was just loaded and comes from the browser's cache.
      Promise.all(SHELL.map((path) => cache.add(new Request(inScope(path), path === 'index.html' ? { cache: 'no-cache' } : {})))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // The page's request starts while the worker wakes up, so the start is not slower.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => undefined);
      for (const name of await caches.keys()) {
        if (name.startsWith('tonuino-studio-') && name !== SHELL_CACHE && name !== ASSET_CACHE) await caches.delete(name);
      }
      const known = new Set(ASSETS.map(inScope));
      const assets = await caches.open(ASSET_CACHE);
      for (const req of await assets.keys()) if (!known.has(req.url)) await assets.delete(req);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'skip-waiting') self.skipWaiting();
  else if (data.type === 'version' && event.ports && event.ports[0]) event.ports[0].postMessage(VERSION);
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const base = scope().pathname;
  if (!url.pathname.startsWith(base)) return;
  const path = url.pathname.slice(base.length);
  if (req.mode === 'navigate') {
    if (path === '' || path === 'index.html') event.respondWith(page(event));
    return;
  }
  if (!path.startsWith('assets/')) return;
  if (offline || (self.navigator && self.navigator.onLine === false)) event.respondWith(asset(req));
  else event.waitUntil(keep(req));
});

async function page(event) {
  try {
    const early = await event.preloadResponse;
    const res = early || (await fetch(event.request));
    offline = false;
    return res;
  } catch (err) {
    const kept = await caches.match(inScope('index.html'), { cacheName: SHELL_CACHE });
    if (kept) {
      offline = true;
      return kept;
    }
    throw err;
  }
}

const keptCopy = async (req) => (await caches.match(req, { cacheName: SHELL_CACHE })) || (await caches.match(req, { cacheName: ASSET_CACHE }));

/** Without a connection: the kept copy, else the network after all. */
async function asset(req) {
  return (await keptCopy(req)) || fetch(req);
}

/** Online: a copy of a file the page loads, kept for a start without a connection, unless there is one. */
async function keep(req) {
  try {
    if (await keptCopy(req)) return;
    // A little later: then the browser answers from its own cache, the file is not loaded twice.
    await new Promise((resolve) => setTimeout(resolve, KEEP_AFTER_MS));
    const res = await fetch(req);
    if (res.ok && res.status === 200) await (await caches.open(ASSET_CACHE)).put(req, res);
  } catch {
    // Not kept this time: the next visit tries again.
  }
}
