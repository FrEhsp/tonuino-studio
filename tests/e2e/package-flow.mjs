/**
 * The whole way in the Paket mode: read the card, add an album, download
 * the Paket, check it, unpack it as the guide says, check the card. Then
 * add titles to a folder (the folder is replaced), and the card is checked
 * again.
 */
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { check, chooseFiles, chooseFolder, downloadFrom, failed, go, launch, makeCard, MP3, noErrors, openApp, OUT, paths, same, shot, shown, testZip, treeOf, unpackOnto } from './lib.mjs';

export async function packageFlow(browser) {
  console.log('package flow');
  const card = makeCard(join(OUT, 'cards', 'TONUINO'), {
    mp3: { '0001.mp3': MP3, '0002.mp3': MP3 },
    advert: { '0001.mp3': MP3 },
    '01': { '001.mp3': MP3, '002.mp3': MP3 },
    '02': { '001.mp3': MP3 },
  });
  const album = join(OUT, 'music', 'Die Olchis');
  rmSync(album, { recursive: true, force: true });
  mkdirSync(album, { recursive: true });
  makeCard(album, { '01 Anfang.mp3': MP3, '02 Mitte.mp3': MP3, '03 Ende.mp3': MP3 });

  // 0.6: the bare address opens „Musik auf die SD-Karte“; "#/" (below) stays Meine Box.
  {
    const bare = await openApp(browser, { hash: '' });
    await bare.page.getByRole('heading', { name: 'Musik auf die SD-Karte' }).waitFor();
    check(bare.page.url().endsWith('#/musik'), 'the bare address opens „Musik auf die SD-Karte“', bare.page.url());
    await bare.context.close();
  }
  const { page, errors } = await openApp(browser);

  // Welcome: what this browser can do, and the way in.
  await page.getByRole('heading', { name: 'Hallo! Stecke die SD-Karte deiner Box in den Computer.' }).waitFor();
  check(await page.getByText('Mit der Desktop-App oder Chrome geht alles direkt.').isVisible(), 'welcome names the desktop app and Chrome before the button');
  // The bar on top shows the card with what is missing.
  check(await page.locator('.kopf .sd-zeile').getByText('Keine SD-Karte eingelesen').isVisible(), 'bar on top: no card read in');
  await shot(page, 'flow-01-welcome');

  // Read the card in.
  await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
  await shown(page).locator('.page-header h1').waitFor();
  const meta = await shown(page).locator('.page-header p').first().textContent();
  check(/eingelesen um \d\d:\d\d/.test(meta ?? ''), 'shelf says when the card was read', meta);
  check(await page.locator('.kopf .sd-zeile').getByText(/Eingelesen um \d\d:\d\d/).isVisible(), 'the bar on top says when the card was read');
  check((await shown(page).locator('.package-banner').count()) === 0, 'nothing waits for a card just read');
  await shot(page, 'flow-02-shelf');

  // Add an album.
  await go(page, '#/hinzufuegen');
  await page.getByRole('button', { name: 'Dateien auswählen' }).waitFor();
  check(await page.getByText('Fragt der Browser nach „Hochladen“? Keine Sorge, die Dateien bleiben auf deinem Computer.').isVisible(), 'add page explains the Hochladen question');
  await chooseFiles(page, [join(album, '01 Anfang.mp3'), join(album, '02 Mitte.mp3'), join(album, '03 Ende.mp3')], page.getByRole('button', { name: 'Dateien auswählen' }));
  const into = page.getByRole('button', { name: 'Ins Paket für die Karte' });
  await into.waitFor({ timeout: 60_000 });
  check(await page.getByText('Lasse die Karte stecken, bis das Paket heruntergeladen ist.').isVisible(), 'review footer: keep the card in');
  await shot(page, 'flow-03-review');
  await into.click();
  await page.getByText(/ist bereit fürs Paket|sind bereit fürs Paket/).waitFor({ timeout: 120_000 });
  await shot(page, 'flow-04-done');
  check(await shown(page).locator('.package-banner.pending').isVisible(), 'the done page shows what waits for the card');

  // The Paket.
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Das kommt auf die Karte:').waitFor();
  const lines = await dialog.locator('.package-lines li').allTextContents();
  check(lines.some((l) => /^Neu: Ordner 03/.test(l)), 'the dialog lists the new folder', lines);
  check(lines.includes('Namen, Bilder und Sticker der App'), 'the dialog lists the app files', lines);
  await shot(page, 'flow-05-choose');
  const zip = await saveThePaket(page, dialog);
  check(/^TonUINO-Paket-\d{4}-\d{4}-[A-Z2-9]{3}\.zip$/.test(zip.split('/').pop()), 'the Paket has its name', zip);
  const entries = testZip(zip);
  same(entries, ['03/', '03/001.mp3', '03/002.mp3', '03/003.mp3', 'tonuino-studio.json', 'tonuino-studio-covers.zip'], 'the Paket holds the new folder, the catalog and the covers, in order');

  // The guide.
  await page.getByRole('dialog', { name: 'Paket auf die Karte bringen' }).waitFor().catch(() => undefined);
  await dialog.getByText('Das Paket ist in deinem Download-Ordner').waitFor();
  check(await dialog.getByRole('tab', { name: 'Linux' }).isVisible(), 'the guide has tabs per system');
  await dialog.getByRole('tab', { name: 'Linux' }).click();
  const cmd = await dialog.locator('.command-line code').first().textContent();
  check(cmd === `unzip -o ~/Downloads/'${zip.split('/').pop()}'`, 'Linux: unzip command with the Paket name', cmd);
  await shot(page, 'flow-06-guide');

  // Unpack it as the guide says, then check the card.
  unpackOnto(zip, card);
  await dialog.getByRole('button', { name: 'Karte prüfen' }).last().click();
  await dialog.getByText('Wähle die SD-Karte noch einmal aus.').waitFor();
  await chooseFolder(page, card, dialog.getByRole('button', { name: 'SD-Karte einlesen' }));
  await dialog.getByText('Alles ist richtig auf der Karte.').waitFor({ timeout: 30_000 });
  await shot(page, 'flow-07-checked');
  await dialog.getByRole('button', { name: 'Fertig' }).click();
  same(paths(card), [
    '01/001.mp3',
    '01/002.mp3',
    '02/001.mp3',
    '03/001.mp3',
    '03/002.mp3',
    '03/003.mp3',
    'advert/0001.mp3',
    'mp3/0001.mp3',
    'mp3/0002.mp3',
    'tonuino-studio-covers.zip',
    'tonuino-studio.json',
  ], 'the card has the new album');
  await go(page, '#/');
  check((await shown(page).locator('.package-banner').count()) === 0, 'after the check nothing waits any more');

  // Titles for folder 01: the whole folder is replaced, so the guide first asks for the downloaded Paket.
  console.log('package flow: titles for a folder');
  const before = paths(card);
  await page.goto(`${page.url().split('#')[0]}#/ordner/01`);
  await page.getByRole('button', { name: 'Titel hinzufügen' }).click();
  await chooseFiles(page, [join(album, '03 Ende.mp3')], page.getByRole('button', { name: 'Dateien auswählen' }));
  await page.getByRole('button', { name: 'Ins Paket für die Karte' }).click();
  await page.getByText('Die neuen Titel sind bereit fürs Paket').waitFor({ timeout: 120_000 });
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  await dialog.getByText('Vorher löschst du auf der Karte: Ordner 01.').waitFor();
  const lines2 = await dialog.locator('.package-lines li').allTextContents();
  check(lines2.some((l) => /^Ersetzt: Ordner 01/.test(l)), 'the dialog says folder 01 is replaced', lines2);
  const zip2 = await saveThePaket(page, dialog);
  same(testZip(zip2), ['01/', '01/001.mp3', '01/002.mp3', '01/003.mp3', 'tonuino-studio.json', 'tonuino-studio-covers.zip'], 'the Paket brings folder 01 whole');
  await dialog.getByRole('tab', { name: 'Linux' }).click();
  check((await dialog.getByText('Lasse mich nachsehen, ob alles stimmt.').count()) === 0, 'before the Paket is checked, the later steps wait');
  await shot(page, 'flow-08-guide-gate');
  // The wrong file first: the app says so.
  await chooseFiles(page, [zip], dialog.getByRole('button', { name: 'Paket prüfen' }));
  await dialog.getByText(`Das ist ein anderes Paket. Wähle „${zip2.split('/').pop()}“.`).waitFor();
  check(true, 'an older Paket is told apart');
  await chooseFiles(page, [zip2], dialog.getByRole('button', { name: 'Paket prüfen' }));
  await dialog.getByText('Das Paket ist vollständig.').waitFor();
  check(await dialog.getByText(/lösche den Ordner 01 mit Umschalt\+Entf/).isVisible(), 'then the guide says to delete folder 01');
  await shot(page, 'flow-09-guide-open');
  unpackOnto(zip2, card, { deleteFirst: ['01'] });
  await dialog.getByRole('button', { name: 'Karte prüfen' }).last().click();
  await chooseFolder(page, card, dialog.getByRole('button', { name: 'SD-Karte einlesen' }));
  await dialog.getByText('Alles ist richtig auf der Karte.').waitFor({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Fertig' }).click();
  same(paths(card), [...before.slice(0, 2), '01/003.mp3', ...before.slice(2)], 'folder 01 has three titles now');

  // The whole card as a Paket: format, unpack, check.
  console.log('package flow: the whole card');
  await go(page, '#/');
  await shown(page).locator('.page-header').getByRole('button', { name: 'Paket' }).click();
  await dialog.getByText(/Alles, was ich auf der Karte lesen konnte, kommt sauber sortiert in ein Paket/).waitFor();
  await shot(page, 'flow-10-full');
  const full = await saveThePaket(page, dialog);
  check(/^TonUINO-Karte-komplett-/.test(full.split('/').pop()), 'the whole card has its own name', full);
  const fullEntries = testZip(full);
  same(fullEntries.slice(0, 5), ['mp3/', 'mp3/0001.mp3', 'mp3/0002.mp3', 'advert/', 'advert/0001.mp3'], 'mp3 and advert come first');
  await dialog.getByRole('tab', { name: 'Windows' }).click();
  await chooseFiles(page, [full], dialog.getByRole('button', { name: 'Paket prüfen' }));
  await dialog.getByText('Das Paket ist vollständig.').waitFor();
  check(await dialog.getByText(/Formatieren …/).isVisible(), 'the Windows guide says how to format');
  const kept = treeOf(card);
  unpackOnto(full, card, { format: true });
  same(treeOf(card), kept, 'the rebuilt card has the same files, byte for byte');
  await dialog.getByRole('button', { name: 'Karte prüfen' }).last().click();
  await chooseFolder(page, card, dialog.getByRole('button', { name: 'SD-Karte einlesen' }));
  await dialog.getByText('Alles ist richtig auf der Karte.').waitFor({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Fertig' }).click();

  noErrors(errors);
  await page.context().close();
  return failed();
}

/** Clicks "Paket herunterladen" in the dialog and saves the Paket, with the extra click when it took a while. */
export async function saveThePaket(page, dialog) {
  const [first] = await Promise.all([
    page.waitForEvent('download', { timeout: 4000 }).catch(() => null),
    dialog.getByRole('button', { name: 'Paket herunterladen' }).click(),
  ]);
  if (first) {
    const path = join(OUT, 'downloads', first.suggestedFilename());
    await first.saveAs(path);
    return path;
  }
  await dialog.getByText(/Das Paket ist fertig/).waitFor({ timeout: 60_000 });
  return downloadFrom(page, dialog.getByRole('button', { name: 'Paket speichern' }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await packageFlow(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
