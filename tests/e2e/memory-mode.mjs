/**
 * Without the browser's private file storage (OPFS; Firefox in a private
 * window, older Safari) new files wait in memory: the Paket still comes out
 * right, and when the memory budget is used up, the app says so.
 * The budget is lowered through a key the dev server reads.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { saveThePaket } from './package-flow.mjs';
import { addAlbum, check, chooseFolder, failed, go, launch, makeCard, MP3, noErrors, openApp, OUT, same, shot, shown, testZip, unpackOnto } from './lib.mjs';

const NO_OPFS = () => {
  if (window.StorageManager) delete StorageManager.prototype.getDirectory;
};
const BUDGET = (bytes) => {
  try {
    localStorage.setItem('tonuino-studio:dev-scratch-budget', String(bytes));
  } catch {
    // about:blank has no storage.
  }
};

/** A 150 s MP3 (about 2.4 MB) made with ffmpeg: big enough to count against the memory budget. */
function longMp3() {
  const dir = join(OUT, 'fixtures');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'long.mp3');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=150', '-ac', '2', '-b:a', '128k', out]);
  return out;
}

export async function memoryMode(browser) {
  console.log('memory mode (no OPFS)');
  const album = makeCard(join(OUT, 'music', 'Speicher'), { '01.mp3': MP3, '02.mp3': MP3, '03.mp3': MP3 });
  const files = [join(album, '01.mp3'), join(album, '02.mp3'), join(album, '03.mp3')];

  // Enough memory: the Paket is right.
  {
    const card = makeCard(join(OUT, 'cards', 'MEMORY'), { mp3: { '0001.mp3': MP3 }, '01': { '001.mp3': MP3 } });
    const { page, errors } = await openApp(browser, { init: [{ fn: NO_OPFS }] });
    check(await page.evaluate(() => !('getDirectory' in navigator.storage)), 'the page has no OPFS');
    await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
    await shown(page).locator('.page-header h1').waitFor();
    await addAlbum(page, files);
    await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
    const dialog = page.getByRole('dialog');
    const zip = await saveThePaket(page, dialog);
    same(testZip(zip), ['02/', '02/001.mp3', '02/002.mp3', '02/003.mp3', 'tonuino-studio.json', 'tonuino-studio-covers.zip'], 'memory mode: the Paket holds the new folder');
    unpackOnto(zip, card);
    await dialog.getByRole('button', { name: 'Karte prüfen' }).last().click();
    await chooseFolder(page, card, dialog.getByRole('button', { name: 'SD-Karte einlesen' }));
    await dialog.getByText('Alles ist richtig auf der Karte.').waitFor({ timeout: 30_000 });
    check(true, 'memory mode: the card checks out');
    noErrors(errors);
    await page.context().close();
  }

  // Too little memory: the app says so and what to do.
  let long;
  try {
    long = longMp3();
  } catch {
    console.log('  skip memory full: ffmpeg is missing');
    return failed();
  }
  const big = makeCard(join(OUT, 'music', 'Lang'), { '01.mp3': long, '02.mp3': long, '03.mp3': long });
  {
    const card = makeCard(join(OUT, 'cards', 'MEMORY2'), { mp3: { '0001.mp3': MP3 }, '01': { '001.mp3': MP3 } });
    const { page, errors } = await openApp(browser, { init: [{ fn: NO_OPFS }, { fn: BUDGET, arg: 3_000_000 }] });
    await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
    await shown(page).locator('.page-header h1').waitFor();
    await go(page, '#/hinzufuegen');
    const { chooseFiles } = await import('./lib.mjs');
    await chooseFiles(page, [join(big, '01.mp3'), join(big, '02.mp3'), join(big, '03.mp3')], page.getByRole('button', { name: 'Dateien auswählen' }));
    const into = page.getByRole('button', { name: 'Ins Paket für die Karte' });
    await into.waitFor({ timeout: 60_000 });
    await into.click();
    const text = shown(page).getByText('Dein Browser hält das Paket im Arbeitsspeicher, und der reicht für so viel Musik nicht. Nimm weniger Alben auf einmal oder einen neueren Browser.');
    try {
      await text.first().waitFor({ timeout: 60_000 });
      check(true, 'memory full: the app says what happened and what to do');
    } catch {
      check(false, 'memory full: the app says what happened and what to do', await page.locator('main, .page').first().textContent());
    }
    check(await page.getByRole('heading', { name: 'Das Vorbereiten hat nicht ganz geklappt' }).isVisible(), 'memory full: the done page speaks of the Paket, not of the card');
    check(await page.getByRole('button', { name: 'Rest vorbereiten' }).isVisible(), 'memory full: "Rest vorbereiten"');
    await shot(page, 'memory-full');
    noErrors(errors);
    await page.context().close();
  }
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await memoryMode(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
