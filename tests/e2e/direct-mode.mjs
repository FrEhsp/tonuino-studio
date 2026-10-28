/**
 * Chrome and Edge stay as they were: with showDirectoryPicker the app
 * writes straight onto the card. The picker is stubbed to hand out a folder
 * in the origin private file system, filled like a card.
 */
import { readFileSync } from 'node:fs';
import { check, failed, folderPage, go, launch, MP3, noErrors, openApp, shot, shown } from './lib.mjs';

const PICKER = () => {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('TONUINO', { create: true });
  };
  // The files of OPFS/ALBUM, as if picked.
  window.showOpenFilePicker = async () => {
    const root = await navigator.storage.getDirectory();
    const album = await root.getDirectoryHandle('ALBUM', { create: true });
    const out = [];
    for await (const h of album.values()) if (h.kind === 'file') out.push(h);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
};

/** Fills OPFS/<top> with a tree: { '01': { '001.mp3': base64 } }. */
async function fillCard(page, tree, top = 'TONUINO') {
  await page.evaluate(async ({ tree, top }) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(top, { recursive: true }).catch(() => undefined);
    const write = async (dir, t) => {
      for (const [name, v] of Object.entries(t)) {
        if (typeof v === 'string') {
          const h = await dir.getFileHandle(name, { create: true });
          const w = await h.createWritable();
          await w.write(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
          await w.close();
        } else await write(await dir.getDirectoryHandle(name, { create: true }), v);
      }
    };
    await write(await root.getDirectoryHandle(top, { create: true }), tree);
  }, { tree, top });
}

async function listCard(page) {
  return page.evaluate(async () => {
    const out = [];
    const walk = async (dir, prefix) => {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') await walk(h, `${prefix}${name}/`);
        else out.push(prefix + name);
      }
    };
    const root = await navigator.storage.getDirectory();
    await walk(await root.getDirectoryHandle('TONUINO'), '');
    return out.sort();
  });
}

export async function directMode(browser) {
  console.log('direct mode (Chrome, Edge)');
  const mp3 = readFileSync(MP3).toString('base64');
  const { page, errors } = await openApp(browser, { mode: 'direct', init: [{ fn: PICKER }] });
  // A hidden Mac file in folder 01, for the repair below.
  await fillCard(page, { mp3: { '0001.mp3': mp3 }, '01': { '001.mp3': mp3, '._001.mp3': btoa('mac') } });

  await page.getByRole('heading', { name: 'Hallo! Stecke die SD-Karte deiner Box in den Computer.' }).waitFor();
  check((await page.getByRole('button', { name: 'SD-Karte einlesen' }).count()) === 0, 'no "einlesen" in Chrome');
  check((await page.getByText('geht alles direkt').filter({ visible: true }).count()) === 0, 'no note about other browsers');
  await page.getByRole('button', { name: 'SD-Karte auswählen' }).first().click();
  await shown(page).locator('.page-header h1').waitFor();
  check(!/eingelesen um/.test((await shown(page).locator('.page-header p').first().textContent()) ?? ''), 'the shelf has no "eingelesen um"');
  check((await page.getByRole('button', { name: 'Neu einlesen' }).count()) === 0, 'no "Neu einlesen"');
  check((await shown(page).locator('.page-header').getByRole('button', { name: 'Paket' }).count()) === 0, 'no Paket button');
  await shot(page, 'direct-01-shelf');

  await go(page, '#/hinzufuegen');
  check((await page.getByText(/Fragt der Browser nach „Hochladen“/).filter({ visible: true }).count()) === 0, 'no "Hochladen" hint');
  await fillCard(page, { '01 Anfang.mp3': mp3, '02 Ende.mp3': mp3 }, 'ALBUM');
  await page.getByRole('button', { name: 'Dateien auswählen' }).click();
  const into = page.getByRole('button', { name: 'Auf die SD-Karte übertragen' });
  await into.waitFor({ timeout: 60_000 });
  await into.click();
  await shown(page).getByText(/ist auf der Karte|sind auf der Karte/).first().waitFor({ timeout: 120_000 });
  check((await shown(page).locator('.package-banner').count()) === 0, 'nothing waits for a Paket');
  const files = await listCard(page);
  check(['02/001.mp3', '02/002.mp3', 'tonuino-studio.json'].every((f) => files.includes(f)), 'the album is written straight onto the card', files);
  await shot(page, 'direct-02-done');

  // Repair: straight on the card, as before.
  await page.goto(page.url().replace(/#.*$/, '#/'));
  await page.getByRole('button', { name: 'Ansehen und reparieren' }).click();
  const health = page.getByRole('dialog');
  const junk = health.locator('.issue', { has: page.getByText('01/._001.mp3', { exact: true }) });
  await junk.getByRole('button').click();
  await health.getByRole('button', { name: 'Jetzt reparieren' }).click();
  await page.getByText('Erledigt.', { exact: true }).waitFor();
  check(!(await listCard(page)).includes('01/._001.mp3'), 'repair: the hidden Mac file is gone from the card');
  check((await shown(page).locator('.package-banner').count()) === 0, 'repair: nothing waits for a Paket');
  await page.keyboard.press('Escape');

  // Delete a folder: straight on the card, with the words of before.
  await (await folderPage(page, '02')).click();
  await page.getByRole('menuitem', { name: 'Ordner löschen' }).click();
  await page.getByText(/Ordner 02 mit allen Titeln wird von der SD-Karte gelöscht\. Das lässt sich nicht rückgängig machen\./).waitFor();
  check((await page.getByText(/Paket/).filter({ visible: true }).count()) === 0, 'delete: no word about a Paket');
  await page.getByRole('button', { name: 'Endgültig löschen' }).click();
  await shown(page).locator('.page-header h1').waitFor();
  await page.waitForFunction(async () => {
    const root = await navigator.storage.getDirectory();
    const card = await root.getDirectoryHandle('TONUINO');
    for await (const name of card.keys()) if (name === '02') return false;
    return true;
  });
  check(!(await listCard(page)).some((f) => f.startsWith('02/')), 'delete: folder 02 is gone from the card');

  await page.goto(page.url().replace(/#.*$/, '#/werkstatt'));
  await page.getByRole('heading', { name: 'Werkstatt' }).waitFor();
  check((await page.getByRole('link', { name: /Paket auf die Karte bringen/ }).count()) === 0, 'no Paket tool in the Werkstatt');

  // Chrome shows its USB chooser right away: no word about what the browser asks (that is for Firefox's add-on).
  await page.goto(page.url().replace(/#.*$/, '#/werkstatt/logbuch'));
  await page.getByRole('button', { name: /Box verbinden/ }).waitFor();
  check((await page.getByText('Dein Browser fragt gleich, welches Gerät ich benutzen darf.', { exact: false }).filter({ visible: true }).count()) === 0, 'USB: no hint about the browser question in Chrome');
  check((await page.getByText(/Add-on/).filter({ visible: true }).count()) === 0, 'USB: no add-on hint in Chrome');

  noErrors(errors);
  await page.context().close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await directMode(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
