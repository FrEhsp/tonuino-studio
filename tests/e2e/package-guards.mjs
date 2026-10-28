/**
 * Guards of the Paket mode (Firefox, Safari) around features that came in
 * next to it: no "not FAT32" guess from times the app made up, no Paket
 * while the app still writes into its copy, the add flow speaks of the
 * Paket, the guide at the box knows announcements that only wait in the
 * Paket, and "Box einstellen" does not send to a Box-Logbuch that cannot
 * read the box here.
 */
import { join } from 'node:path';
import { check, chooseFiles, chooseFolder, failed, FIXTURES, launch, makeCard, MP3, noErrors, openApp, OUT, paths, shot, shown } from './lib.mjs';
import { pythonZip } from './merged-features.mjs';

const FLAC = join(FIXTURES, 'song.flac');
const BUSY = 'Gerade lege ich noch etwas fürs Paket bereit. Warte, bis ich fertig bin. Danach kannst du das Paket herunterladen.';
const NOT_FAT = 'Die SD-Karte ist wahrscheinlich nicht mit FAT32 formatiert';

export async function packageGuards(browser) {
  const base = join(OUT, 'guards');
  const card = makeCard(join(base, 'TONUINO'), {
    '01': { '001.mp3': MP3 },
  });
  // One MP3 and eleven FLAC files: the FLAC files are converted, which takes a while.
  const names = ['01.mp3', ...Array.from({ length: 11 }, (_, i) => `${String(i + 2).padStart(2, '0')}.flac`)];
  const music = makeCard(join(base, 'music', 'Langsam'), Object.fromEntries(names.map((n) => [n, n.endsWith('.mp3') ? MP3 : FLAC])));
  const { page, errors } = await openApp(browser);
  page.on('dialog', (d) => d.accept().catch(() => undefined));
  const dialog = page.getByRole('dialog');
  const go = (hash) => page.goto(`${page.url().split('#')[0]}${hash}`);
  /** The titles of the health check, from its dialog when the shelf offers one. */
  const healthTitles = async () => {
    await go('#/');
    await shown(page).locator('.page-header h1').waitFor();
    const open = page.getByRole('button', { name: 'Ansehen und reparieren' });
    if (!(await open.count())) return '';
    await open.first().click();
    await dialog.waitFor();
    const text = (await dialog.textContent()) ?? '';
    await shot(page, 'guards-health');
    await dialog.getByRole('button', { name: 'Schließen', exact: true }).last().click();
    await dialog.waitFor({ state: 'detached' });
    return text;
  };

  /* ---------------------------------------------------------------- format guess */
  console.log('guards: the format of the card');
  await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
  await page.locator('.kopf .sd-zeile').getByText(/Eingelesen um/).waitFor();
  check(!(await healthTitles()).includes(NOT_FAT), 'format: a card with FAT times is not taken for exFAT');

  /* ---------------------------------------------------------------- texts while choosing */
  console.log('guards: the add flow speaks of the Paket');
  await go('#/hinzufuegen');
  await chooseFiles(page, [join(music, '01.mp3')], page.getByRole('button', { name: 'Dateien auswählen' }));
  await page.getByRole('button', { name: 'Ins Paket für die Karte' }).waitFor({ timeout: 60_000 });
  check(await page.getByText('Ein Album gefunden. Prüfe Titel und Art, dann kommt es ins Paket für die Karte.').isVisible(), 'add: the review says the album goes into the Paket');
  await go('#/hinzufuegen/01');
  await page.getByRole('heading', { name: 'Da liegt noch eine Auswahl bereit' }).waitFor();
  check(await page.getByText(/Du hast vorhin „.+“ ausgewählt und noch nicht vorbereitet\./).isVisible(), 'add: another folder says the choice is not prepared yet');
  await page.getByRole('button', { name: 'Verwerfen und neu beginnen' }).click();

  /* ---------------------------------------------------------------- no Paket while writing */
  console.log('guards: no Paket while titles are still prepared');
  await go('#/hinzufuegen');
  await chooseFiles(
    page,
    names.map((n) => join(music, n)),
    page.getByRole('button', { name: 'Dateien auswählen' }),
  );
  const into = page.getByRole('button', { name: 'Ins Paket für die Karte' });
  await into.waitFor({ timeout: 60_000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  let downloads = 0;
  page.on('download', () => downloads++);
  await into.click();
  await page.getByText('Paket wird vorbereitet').waitFor();
  await page.locator('.kopf .sd-zeile').getByRole('button', { name: 'Paket' }).click();
  await dialog.getByText(BUSY).waitFor();
  const button = dialog.getByRole('button', { name: 'Paket herunterladen' });
  check(await button.isDisabled(), 'busy: "Paket herunterladen" waits while titles are prepared');
  await shot(page, 'guards-01-busy');
  await button.click({ force: true }).catch(() => undefined);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.getByText(/sind bereit fürs Paket|ist bereit fürs Paket/).waitFor({ timeout: 180_000 });
  check(downloads === 0, 'busy: nothing was downloaded meanwhile');
  check((await shown(page).locator('.package-banner.pending').count()) === 1, 'busy: afterwards everything waits for one Paket');
  await page.locator('.kopf .sd-zeile').getByRole('button', { name: 'Paket' }).click();
  await dialog.getByText('Das kommt auf die Karte:').waitFor();
  check((await dialog.getByText(BUSY).count()) === 0 && (await dialog.getByRole('button', { name: 'Paket herunterladen' }).isEnabled()), 'busy: then the Paket can be downloaded');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  check(!(await healthTitles()).includes(NOT_FAT), 'format: titles in the Paket do not make the card look like exFAT');

  /* ---------------------------------------------------------------- announcements in the Paket */
  console.log('guards: the guide at the box and announcements in the Paket');
  await go('#/karten');
  await page.getByRole('radio', { name: /An der Box/ }).click();
  await shown(page).locator('.pick-list input[type="checkbox"]').first().check();
  await page.getByText('Auf dieser SD-Karte fehlen die Systemansagen', { exact: false }).waitFor();
  check(true, 'box guide: warns that the card has no announcements');
  const sounds = pythonZip(join(base, 'Ansagen.zip'), [
    ['mp3/', ''],
    ['mp3/0001.mp3', MP3],
    ['advert/', ''],
    ['advert/0001.mp3', MP3],
  ]);
  await go('#/werkstatt/ansagen');
  await page.locator('#ws-sounds-title').waitFor();
  await page.locator('.ws-page').getByRole('button').filter({ has: page.locator('svg') }).filter({ hasText: /Ansagen|installieren|erneuern/ }).first().click();
  await chooseFiles(page, [sounds], dialog.getByRole('button', { name: 'ZIP-Datei auswählen …' }));
  await page.getByText('Die Ansagen sind im Paket.').waitFor({ timeout: 30_000 });
  await go('#/karten');
  const pending = page.getByText('Die Systemansagen sind im Paket für die Karte, aber noch nicht auf der Karte.', { exact: false });
  await pending.waitFor();
  check(await pending.isVisible(), 'box guide: says the announcements still wait in the Paket');
  await page.getByRole('button', { name: 'Paket für die SD-Karte' }).click();
  await dialog.getByText('Das kommt auf die Karte:').waitFor();
  check(true, 'box guide: the button opens the Paket');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  // Escape in the very next task after the dialog shows: it once got lost because the dialog
  // listened for keys only a frame later, and this flow waited 30 s for the dialog to go.
  await page.evaluate(() => {
    const seen = new MutationObserver(() => {
      if (!document.querySelector('[role="dialog"]')) return;
      seen.disconnect();
      setTimeout(() => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 0);
    });
    seen.observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole('button', { name: 'Paket für die SD-Karte' }).click();
  const closedAtOnce = await dialog
    .waitFor({ state: 'detached', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  check(closedAtOnce, 'dialogs: Escape right after opening closes the dialog');
  if (!closedAtOnce) {
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }
  await pending.scrollIntoViewIfNeeded();
  await shot(page, 'guards-02-box-sounds-1280-light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await pending.scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, 'box guide: no sideways scrolling at 390 px', overflow);
  await shot(page, 'guards-03-box-sounds-390-dark');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  check(!paths(card).some((p) => p.startsWith('mp3/')), 'box guide: the card itself is not touched');

  /* ---------------------------------------------------------------- Box einstellen without USB */
  console.log('guards: Box einstellen without USB');
  await go('#/werkstatt/einstellen');
  await page.getByRole('heading', { name: 'Box einstellen' }).waitFor();
  check(await page.getByText('Genau zählen kann ich nur, wenn ich die Box über USB auslese.', { exact: false }).isVisible(), 'Box einstellen: says where the box can be read');
  check((await page.getByRole('link', { name: 'Box-Logbuch öffnen' }).count()) === 0, 'Box einstellen: no link to a Box-Logbuch that cannot read the box here');

  noErrors(errors);
  await page.context().close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await packageGuards(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
