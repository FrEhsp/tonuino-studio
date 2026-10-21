/**
 * A folder made quieter on purpose (Frank 20.10.: "Leiser für die Nacht"),
 * in Chrome straight on the card: the choice in "Lautstärke anpassen", the
 * offset kept in the catalog on the card, the note on the folder page and
 * on the shelf, and the dialog opening again with the choice kept.
 */
import { readFileSync } from 'node:fs';
import { check, failed, folderPage, launch, MP3, noErrors, openApp, shot, shown } from './lib.mjs';

const PICKER = () => {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('TONUINO', { create: true });
  };
};

async function fillCard(page, tree) {
  await page.evaluate(async (tree) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('TONUINO', { recursive: true }).catch(() => undefined);
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
    await write(await root.getDirectoryHandle('TONUINO', { create: true }), tree);
  }, tree);
}

/**
 * The catalog on the card, as the app wrote it. The app may still be
 * writing it when the note shows: a file replaced between getFile() and
 * text() reads as NotReadableError in Chrome, so it is read again.
 */
async function catalogOnCard(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const card = await root.getDirectoryHandle('TONUINO');
    for (let tries = 0; ; tries++) {
      try {
        const file = await (await card.getFileHandle('tonuino-studio.json')).getFile();
        return JSON.parse(await file.text());
      } catch (e) {
        if (tries >= 20) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });
}

export async function folderLoudness(browser) {
  console.log('folder made quieter on purpose');
  const mp3 = readFileSync(MP3).toString('base64');
  const { page, errors } = await openApp(browser, { mode: 'direct', init: [{ fn: PICKER }] });
  await fillCard(page, { mp3: { '0001.mp3': mp3 }, '01': { '001.mp3': mp3, '002.mp3': mp3 } });
  await page.getByRole('button', { name: 'SD-Karte auswählen' }).first().click();
  await shown(page).locator('.page-header h1').waitFor();

  await (await folderPage(page, '01')).click();
  await page.getByRole('menuitem', { name: 'Lautstärke anpassen …' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Lautstärke anpassen' }).waitFor();
  const night = dialog.getByRole('button', { name: 'Leiser für die Nacht' });
  const same = dialog.getByRole('button', { name: 'Wie die anderen' });
  check((await same.getAttribute('aria-pressed')) === 'true', 'a folder starts as loud as the others');
  // Chosen while it measures: the plan follows once the measuring is done.
  await night.click();
  check((await night.getAttribute('aria-pressed')) === 'true', '"Leiser für die Nacht" is chosen');
  const slider = dialog.getByRole('slider');
  check((await slider.inputValue()) === '-8', 'the slider moved to -8', await slider.inputValue());
  check((await slider.getAttribute('aria-valuetext')) === '−8 dB', 'the slider says its dB');
  check(!/dB/.test((await dialog.locator('.level-pick .segmented').textContent()) ?? ''), 'no dB in the four choices');
  const go = dialog.getByRole('button', { name: /^(Leiser machen|Lauter machen|Übernehmen)$/ });
  await go.waitFor({ timeout: 60_000 });
  await dialog.getByText('Ich merke mir das für diesen Ordner.', { exact: false }).waitFor();
  await shot(page, 'loudness-01-night');
  await go.click();
  await page.getByText(/Ordner ist leiser gestellt/).first().waitFor({ timeout: 60_000 }).catch(async (e) => {
    await shot(page, 'loudness-01-failed');
    throw e;
  });
  const cat = await catalogOnCard(page);
  check(cat.folders?.['01']?.levelOffsetDb === -8, 'the catalog on the card keeps -8 dB for folder 01', cat.folders?.['01']);

  // The folder page notes it, and the note opens the dialog with the choice kept.
  const note = shown(page).getByRole('button', { name: 'leiser gestellt' });
  await note.waitFor();
  await note.click();
  await dialog.getByRole('heading', { name: 'Lautstärke anpassen' }).waitFor();
  check((await dialog.getByRole('button', { name: 'Leiser für die Nacht' }).getAttribute('aria-pressed')) === 'true', 'opened again, the night is still chosen');
  await dialog.getByText('Der Ordner hat schon diese Lautstärke.', { exact: false }).waitFor({ timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Wie die anderen' }).click();
  await dialog.getByRole('button', { name: 'Angleichen' }).waitFor();
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  check((await catalogOnCard(page)).folders['01'].levelOffsetDb === -8, 'cancelled: the offset stays');

  // The shelf: in the tooltip of the cover and in the list.
  await page.goto(page.url().replace(/#.*$/, '#/'));
  const tile = shown(page).locator('.shelf .tile[title*="leiser gestellt"]');
  await tile.first().waitFor();
  check((await tile.count()) === 1, 'the cover says "leiser gestellt" in its tooltip');
  await shown(page).getByRole('button', { name: 'Liste' }).click();
  await shown(page).locator('.shelf-row-meta', { hasText: 'leiser gestellt' }).waitFor();
  await shot(page, 'loudness-02-shelf-list');
  await shown(page).getByRole('button', { name: 'Cover' }).click();

  noErrors(errors);
  await page.context().close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await folderLoudness(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
