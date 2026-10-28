/**
 * Helpers for the browser checks of the Paket mode (Firefox, Safari).
 *
 * The checks run in Chromium: for the Paket mode the page loses
 * showDirectoryPicker, showOpenFilePicker, showSaveFilePicker,
 * getAsFileSystemHandle and navigator.serial before the app starts, which
 * is what Firefox and Safari look like to the app. Fake SD cards are
 * folders on disk; every ZIP the app hands out is tested with "unzip -t"
 * and unpacked the way the guide tells the user to.
 *
 * Not part of `npm test`: these need Playwright and a running dev server.
 *
 *   npx vite --port 5241 --strictPort &
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chrome node tests/e2e/run.mjs
 *
 * Environment: APP_URL (default http://localhost:5241/), E2E_OUT (default
 * /tmp/tonuino-e2e), PLAYWRIGHT_MODULE (default "playwright"),
 * CHROMIUM_PATH (default: Playwright's own Chromium).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_URL = process.env.APP_URL ?? 'http://localhost:5241/';
export const OUT = process.env.E2E_OUT ?? '/tmp/tonuino-e2e';
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'library');
export const MP3 = join(FIXTURES, 'tagged.mp3');

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

/** What Firefox and Safari lack, taken away before the app starts. */
const PACKAGE_MODE_INIT = () => {
  delete window.showDirectoryPicker;
  delete window.showOpenFilePicker;
  delete window.showSaveFilePicker;
  if (window.DataTransferItem) delete DataTransferItem.prototype.getAsFileSystemHandle;
  delete Navigator.prototype.serial;
};

export async function launch() {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
}

/**
 * A page of the app. mode 'package': as in Firefox and Safari; 'direct': as
 * in Chrome and Edge. `init`: more scripts to run before the app. `hash`:
 * the page to open; "#/" is Meine Box, where most checks begin (the bare
 * address opens „Musik auf die SD-Karte“ since 0.6: pass '' for that).
 */
export async function openApp(browser, { mode = 'package', theme = 'light', width = 1280, height = 900, init = [], hash = '#/' } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    acceptDownloads: true,
  });
  if (mode === 'package') await context.addInitScript(PACKAGE_MODE_INIT);
  for (const s of init) await context.addInitScript(s.fn, s.arg);
  const page = await context.newPage();
  const errors = [];
  collectErrors(page, errors);
  await page.goto(APP_URL + hash);
  // Attached: on a phone the bar on top hides and the one at the bottom takes over.
  await page.waitForSelector('.kopf', { state: 'attached' });
  return { context, page, errors };
}

function collectErrors(page, errors) {
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
}

/**
 * A later visit: the tab is closed and the app opened again at the same
 * address in a new tab of the same browser, so it finds what it stored.
 * Not page.reload(): the dev server hands out the app as some 500 single
 * modules, and Chromium leaves a tab less room for them after every reload;
 * after three or four reloads of one tab the next start fails with
 * ERR_INSUFFICIENT_RESOURCES and the menu never comes (the built app is a
 * handful of files and never gets there). Errors of the new tab go to the
 * same list; `prepare` hooks up on it what the old tab had (dialog answers).
 */
export async function visitAgain(page, errors, prepare = () => undefined) {
  const url = page.url();
  const context = page.context();
  await page.close();
  const next = await context.newPage();
  collectErrors(next, errors);
  prepare(next);
  await next.goto(url);
  await next.waitForSelector('.kopf', { state: 'attached' });
  return next;
}

/* ------------------------------------------------------------------ cards on disk */

/** A time as FAT stores it: whole even seconds (2 March 2024, 10:00). */
export const FAT_TIME = new Date('2024-03-02T10:00:00Z');

/**
 * Gives every file and folder below `dir` a time on the FAT grid, as on a
 * real FAT32 card. Otherwise the health check would rightly guess "not
 * FAT32" from the times of the disk, and could not show when the app makes
 * up times itself.
 */
export function fatTimes(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) fatTimes(p);
    utimesSync(p, FAT_TIME, FAT_TIME);
  }
  utimesSync(dir, FAT_TIME, FAT_TIME);
}

/**
 * Writes a fake card: { '01': { '001.mp3': MP3 }, 'x.txt': 'text' }. A
 * string that is a file path is copied, any other string is written. All
 * times are on the FAT grid (see fatTimes).
 */
export function makeCard(dir, tree) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const write = (at, t) => {
    for (const [name, v] of Object.entries(t)) {
      const p = join(at, name);
      if (typeof v === 'object' && !Buffer.isBuffer(v)) {
        mkdirSync(p, { recursive: true });
        write(p, v);
      } else if (typeof v === 'string' && v.startsWith('/') && existsSync(v)) cpSync(v, p);
      else writeFileSync(p, v);
    }
  };
  write(dir, tree);
  fatTimes(dir);
  return dir;
}

/** Every file below `dir`: path, size and a short hash, sorted. */
export function treeOf(dir) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const p = join(at, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push({ path: relative(dir, p), size: st.size, hash: createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 10) });
    }
  };
  walk(dir);
  return out;
}

export function paths(dir) {
  return treeOf(dir).map((f) => f.path);
}

/** What the guide asks for: delete these folders on the card, then unpack the Paket onto it with unzip. */
export function unpackOnto(zip, card, { deleteFirst = [], format = false } = {}) {
  if (format) {
    rmSync(card, { recursive: true, force: true });
    mkdirSync(card, { recursive: true });
  }
  for (const name of deleteFirst) rmSync(join(card, name), { recursive: true, force: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', card]);
}

/** "unzip -t" must find no error. Returns the entries in archive order. */
export function testZip(zip) {
  const out = execFileSync('unzip', ['-t', zip], { encoding: 'utf8' });
  if (!/No errors detected/.test(out)) throw new Error(`unzip -t ${zip}:\n${out}`);
  const list = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  return list.split('\n').filter(Boolean);
}

/* ------------------------------------------------------------------ page helpers */

/**
 * The page that shows. Pages the user visited (and some built ahead in quiet
 * moments) stay mounted but hidden (App.tsx, "page-slot-hidden"), so the
 * header or the Paket banner of a page can be in the document more than once.
 * Look for what is on the page through this.
 */
export function shown(page) {
  // aria-busy: the page before, kept on screen until the code of the next one is there (src/app/App.tsx).
  return page.locator('.page-slot:not(.page-slot-hidden):not([aria-busy="true"])');
}

/**
 * The page of folder `name` ("02") with its „…“ button, ready to click. Waits
 * for that page itself: right after the address changed, the page before is
 * still on screen, and on a busy computer the „Mehr für die Karte“ of „Meine
 * Box“ was the first button named „Mehr“, its menu had no „Ordner löschen“
 * and the check ran out of time.
 */
export async function folderPage(page, name) {
  await page.goto(`${page.url().split('#')[0]}#/ordner/${name}`);
  const more = shown(page).getByRole('button', { name: 'Mehr', exact: true });
  await more.waitFor();
  return more;
}

/**
 * Opens the page at `hash` the way a link does („Meine Box“ is "#/"). Since
 * 0.6 most pages have no link in the bar on top; they are in the Werkstatt.
 */
export async function go(page, hash) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

/** Clicks a button that opens the folder chooser and hands it `dir`. */
export async function chooseFolder(page, dir, button) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(dir);
}

/** Clicks a button that opens a file chooser and hands it `files`. */
export async function chooseFiles(page, files, button) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(files);
}

/** Clicks and saves the download that follows into OUT/downloads. */
export async function downloadFrom(page, button) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), button.click()]);
  const dir = join(OUT, 'downloads');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, dl.suggestedFilename());
  await dl.saveAs(path);
  return path;
}

/** Hinzufügen in the Paket mode: the files become a new folder that waits for the Paket. */
export async function addAlbum(page, files) {
  // Only the hash changes: the page stays as it is (also on a phone, where the menu is folded away).
  await page.goto(`${page.url().split('#')[0]}#/hinzufuegen`);
  await chooseFiles(page, files, page.getByRole('button', { name: 'Dateien auswählen' }));
  const into = page.getByRole('button', { name: 'Ins Paket für die Karte' });
  await into.waitFor({ timeout: 60_000 });
  await into.click();
  await page.getByText(/ist bereit fürs Paket|sind bereit fürs Paket/).waitFor({ timeout: 120_000 });
}

/** A copy of a folder at `to` (replaced). */
export function copyDir(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, preserveTimestamps: true });
  return to;
}

/**
 * Deezer for the cover search, knowing nothing: in the browser it is asked by
 * JSONP (its answers have no CORS header), so the answer is a script calling
 * back with no hits. `target` is a page or a context.
 */
export async function noDeezer(target) {
  await target.route('https://api.deezer.com/**', (route) => {
    const callback = new URL(route.request().url()).searchParams.get('callback') ?? 'callback';
    return route.fulfill({ headers: { 'content-type': 'application/javascript' }, body: `${callback}({"data":[],"total":0})` });
  });
}

export async function shot(page, name) {
  const dir = join(OUT, 'shots');
  mkdirSync(dir, { recursive: true });
  // Dialogs fade in.
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
}

/* ------------------------------------------------------------------ checks */

let failures = 0;

export function check(ok, what, detail) {
  if (ok) console.log(`  ok   ${what}`);
  else {
    failures++;
    console.log(`  FAIL ${what}${detail !== undefined ? `\n       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

export function same(a, b, what) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  check(x === y, what, x === y ? undefined : `got      ${x}\n       expected ${y}`);
}

export function failed() {
  return failures;
}

/** Fails the page when it logged errors (other than the ones expected). */
export function noErrors(errors, what = 'no errors on the page', allow = []) {
  const real = errors.filter((e) => !allow.some((a) => a.test(e)));
  check(real.length === 0, what, real.join('\n       '));
}
