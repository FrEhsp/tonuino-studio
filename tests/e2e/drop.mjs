/**
 * The SD card dragged onto the page (Firefox, Safari). Playwright cannot
 * drag a folder from the desktop, so the page gets a drop event with a
 * DataTransfer that hands out directory entries (webkitGetAsEntry), the way
 * Firefox and Safari do. The reader hands out its entries in small batches,
 * like Chrome's 100 per call.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { saveThePaket } from './package-flow.mjs';
import { addAlbum, check, failed, launch, makeCard, MP3, noErrors, openApp, OUT, shot, shown, unpackOnto } from './lib.mjs';

/** The folder as { name: base64 | {…} }, for the page. */
function treeData(dir) {
  const out = {};
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out[name] = statSync(p).isDirectory() ? treeData(p) : readFileSync(p).toString('base64');
  }
  return out;
}

/** Drops `items` (each { dir: name, tree } or { file: name, data }) onto the element matching `selector`. */
async function dropOnto(page, selector, items, { hoverOnly = false } = {}) {
  await page.evaluate(
    ({ selector, items, hoverOnly }) => {
      const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const fileEntry = (name, b64) => ({
        isFile: true,
        isDirectory: false,
        name,
        file: (ok) => setTimeout(() => ok(new File([bytes(b64)], name, { lastModified: Date.now() })), 0),
      });
      const dirEntry = (name, tree) => ({
        isFile: false,
        isDirectory: true,
        name,
        createReader() {
          const all = Object.entries(tree).map(([n, v]) => (typeof v === 'string' ? fileEntry(n, v) : dirEntry(n, v)));
          let at = 0;
          // Two at a time, then an empty batch: the end.
          return { readEntries: (ok) => setTimeout(() => ok(all.slice(at, (at += 2))), 0) };
        },
      });
      const dtItems = items.map((it) => ({
        kind: 'file',
        type: '',
        webkitGetAsEntry: () => (it.dir ? dirEntry(it.dir, it.tree) : fileEntry(it.file, it.data)),
        getAsFile: () => null,
      }));
      const dt = { types: ['Files'], items: dtItems, files: [], dropEffect: 'none', effectAllowed: 'all', getData: () => '' };
      const target = document.querySelector(selector);
      const fire = (type) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        target.dispatchEvent(ev);
      };
      fire('dragenter');
      fire('dragover');
      if (!hoverOnly) fire('drop');
    },
    { selector, items, hoverOnly },
  );
}

export async function dropFlow(browser) {
  console.log('drop the card');
  const card = makeCard(join(OUT, 'cards', 'DROP'), {
    mp3: { '0001.mp3': MP3, '0002.mp3': MP3 },
    '01': { '001.mp3': MP3, '002.mp3': MP3, '003.mp3': MP3 },
    '02': { '001.mp3': MP3 },
  });
  const { page, errors } = await openApp(browser);
  await page.getByRole('heading', { name: 'Hallo! Stecke die SD-Karte deiner Box in den Computer.' }).waitFor();

  await dropOnto(page, '.hero.card-drop', [{ dir: 'DROP', tree: treeData(card) }], { hoverOnly: true });
  await page.getByText('Loslassen, dann lese ich die Karte ein.').waitFor();
  check(await shown(page).locator('.hero.card-drop.over').isVisible(), 'dragging over: the welcome box lights up');
  await shot(page, 'drop-01-over');

  await dropOnto(page, '.hero.card-drop', [{ file: '001.mp3', data: readFileSync(MP3).toString('base64') }]);
  await page.getByText('Ziehe die ganze SD-Karte hierher, nicht einzelne Dateien.').waitFor();
  check(true, 'a dropped file: the app asks for the whole card');
  await dropOnto(page, '.hero.card-drop', [
    { dir: 'A', tree: {} },
    { dir: 'B', tree: {} },
  ]);
  await page.getByText('Ziehe nur die SD-Karte hierher, nicht mehrere Dinge auf einmal.').waitFor();
  check(true, 'several things dropped: one at a time');
  await shot(page, 'drop-02-problem');

  await dropOnto(page, '.hero.card-drop', [{ dir: 'DROP', tree: treeData(card) }]);
  await shown(page).locator('.page-header h1').waitFor({ timeout: 30_000 });
  check(/eingelesen um/.test((await shown(page).locator('.page-header p').first().textContent()) ?? ''), 'the dropped card is read in');
  const tiles = await shown(page).locator('.shelf .tile-num').allTextContents();
  check(tiles.includes('01') && tiles.includes('02'), 'both folders are on the shelf (entries read in batches)', tiles);

  // The check takes a dropped card as well.
  const album = makeCard(join(OUT, 'music', 'Dropped'), { '01.mp3': MP3 });
  await addAlbum(page, [join(album, '01.mp3')]);
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  const dialog = page.getByRole('dialog');
  const zip = await saveThePaket(page, dialog);
  unpackOnto(zip, card);
  await dialog.getByRole('button', { name: 'Karte prüfen' }).last().click();
  await dialog.getByText('Wähle die SD-Karte noch einmal aus.').waitFor();
  await dropOnto(page, '.dropzone.card-drop.compact', [{ dir: 'DROP', tree: treeData(card) }]);
  await dialog.getByText('Alles ist richtig auf der Karte.').waitFor({ timeout: 30_000 });
  check(true, 'a card dropped onto the check is checked');
  await dialog.getByRole('button', { name: 'Fertig' }).click();

  noErrors(errors);
  await page.context().close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await dropFlow(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
