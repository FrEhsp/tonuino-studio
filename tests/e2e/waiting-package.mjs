/**
 * A Paket that was downloaded, and then the page was closed: on the next
 * visit, the card read in again still waits for it. Before such a Paket is
 * thrown away, the app asks whether the card was already changed for it.
 * Also: the cards page names folders that are only in the Paket.
 */
import { join } from 'node:path';
import { saveThePaket } from './package-flow.mjs';
import { addAlbum, check, chooseFiles, chooseFolder, failed, folderPage, launch, makeCard, MP3, noErrors, openApp, OUT, paths, same, shot, shown, testZip, unpackOnto, visitAgain } from './lib.mjs';

const KEY = 'tonuino-studio:waiting-package';

export async function waitingPackage(browser) {
  console.log('waiting Paket: back on a later visit');
  const base = join(OUT, 'waiting');
  const card = makeCard(join(base, 'TONUINO'), {
    mp3: { '0001.mp3': MP3 },
    '01': { '001.mp3': MP3 },
    '02': { '001.mp3': MP3 },
  });
  const album = makeCard(join(base, 'music', 'Neu'), { '01.mp3': MP3, '02.mp3': MP3 });
  const opened = await openApp(browser);
  const errors = opened.errors;
  // Every later visit is a new tab (visitAgain): what follows always means the current one.
  let page = opened.page;
  // "Leave the page?" while changes wait: yes, as the user would.
  const answerDialogs = (p) => p.on('dialog', (d) => d.accept().catch(() => undefined));
  answerDialogs(page);
  const laterVisit = async () => {
    page = await visitAgain(page, errors, answerDialogs);
  };
  const dialog = () => page.getByRole('dialog');
  const go = (hash) => page.goto(`${page.url().split('#')[0]}${hash}`);
  const readCard = async () => {
    await go('#/');
    await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }).first());
    await shown(page).locator('.page-header h1').waitFor();
  };
  const banner = () => shown(page).locator('.package-banner.downloaded');

  /** Folder 02 away, a new album in: a Paket that asks to delete a folder first. */
  const changeAndDownload = async () => {
    await (await folderPage(page, '02')).click();
    await page.getByRole('menuitem', { name: 'Ordner löschen' }).click();
    await page.getByRole('button', { name: 'Löschen', exact: true }).click();
    await shown(page).locator('.package-banner.pending').waitFor();
    await addAlbum(page, [join(album, '01.mp3'), join(album, '02.mp3')]);
    await go('#/');
    await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
    const zip = await saveThePaket(page, dialog());
    testZip(zip);
    await dialog().getByRole('button', { name: 'Später' }).click();
    await dialog().waitFor({ state: 'detached' });
    return zip;
  };

  await readCard();

  // The cards page: what is only in the Paket is said so.
  await folderPage(page, '02');
  await addAlbum(page, [join(album, '01.mp3'), join(album, '02.mp3')]);
  await go('#/karten');
  const waitingRow = shown(page).locator('.pick-row', { has: page.getByText('noch nicht auf der Karte', { exact: true }) });
  await waitingRow.first().waitFor();
  same(await waitingRow.locator('.pick-num').allTextContents(), ['03'], 'cards: only the new folder is "noch nicht auf der Karte"');
  await waitingRow.first().locator('input[type="checkbox"]').check();
  await shown(page).getByText('An der Box', { exact: true }).first().click();
  await page.getByText(/Ordner 03 ist noch nicht auf der SD-Karte\. Bringe erst das Paket auf die Karte/).waitFor();
  check(true, 'cards, "An der Box": the box cannot play folder 03 yet');
  await shot(page, 'waiting-01-cards');
  // Start over from the card as it is.
  await laterVisit();
  await readCard();

  // 1. Downloaded, page closed, back again: the Paket still waits. Thrown away after "not yet".
  const zip1 = await changeAndDownload();
  const name1 = zip1.split('/').pop();
  check(await page.evaluate((k) => localStorage.getItem(k) !== null, KEY), 'the waiting Paket is remembered');
  await laterVisit();
  await readCard();
  await banner().waitFor();
  check(await banner().getByText(`„${name1}“`).isVisible(), 'later visit: the banner names the waiting Paket', await banner().textContent());
  check(/Es ist noch nicht auf der Karte/.test(await banner().textContent()), 'later visit: the banner says it is not on the card yet');
  await shot(page, 'waiting-02-restored');
  await go('#/hinzufuegen');
  await page.getByRole('heading', { name: 'Erst das Paket auf die Karte bringen' }).waitFor();
  check(await page.getByText(new RegExp(`ein Paket heruntergeladen: „${name1.replace(/\./g, '\\.')}“`)).isVisible(), 'the gate names the Paket too');
  await page.getByRole('button', { name: 'Noch nicht entpackt? Paket verwerfen' }).click();
  await page.getByText('Hast du auf der Karte schon den Ordner 02 gelöscht?').waitFor();
  check(true, 'before throwing it away: asked about folder 02');
  await shot(page, 'waiting-03-asked');
  await page.getByRole('button', { name: 'Nein, noch nicht' }).click();
  await page.getByText('Was im Paket ist, kommt dann nicht auf die Karte.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Paket verwerfen' }).click();
  await page.getByRole('heading', { name: 'Erst das Paket auf die Karte bringen' }).waitFor({ state: 'detached' });
  check(!(await page.evaluate((k) => localStorage.getItem(k) !== null, KEY)), 'thrown away: no longer remembered');
  await laterVisit();
  await readCard();
  check((await shown(page).locator('.package-banner').count()) === 0, 'thrown away: the next visit has nothing waiting');

  // 2. Again, but folder 02 is already gone on the card: the app keeps the Paket and leads to the guide.
  const zip2 = await changeAndDownload();
  await laterVisit();
  await readCard();
  await banner().waitFor();
  await go('#/hinzufuegen');
  await page.getByRole('button', { name: 'Noch nicht entpackt? Paket verwerfen' }).click();
  await page.getByRole('button', { name: 'Ja, schon gelöscht' }).click();
  await page.getByRole('heading', { name: 'Dann brauchst du das Paket noch' }).waitFor();
  check(true, '"schon gelöscht": the Paket is kept');
  await page.getByRole('button', { name: 'So geht’s' }).click();
  await dialog().getByRole('tab', { name: 'Linux' }).click();
  const steps = await dialog().locator('ol.guide-steps > li').allTextContents();
  check(!/Warte, bis der Download fertig ist/.test(steps[0] ?? ''), 'no download in this visit: no step to wait for it', steps[0]);
  await shot(page, 'waiting-04-guide');
  await chooseFiles(page, [zip2], dialog().getByRole('button', { name: 'Paket prüfen' }));
  await dialog().getByText('Das Paket ist vollständig.').waitFor();
  unpackOnto(zip2, card, { deleteFirst: ['02'] });
  await dialog().getByRole('button', { name: 'Karte prüfen' }).last().click();
  await chooseFolder(page, card, dialog().getByRole('button', { name: 'SD-Karte einlesen' }));
  await dialog().getByText('Alles ist richtig auf der Karte.').waitFor({ timeout: 30_000 });
  await dialog().getByRole('button', { name: 'Fertig' }).click();
  same(
    paths(card).filter((p) => /^\d\d\//.test(p)),
    ['01/001.mp3', '02/001.mp3', '02/002.mp3'],
    'the new album took the place of folder 02',
  );
  check(!(await page.evaluate((k) => localStorage.getItem(k) !== null, KEY)), 'checked: no longer remembered');
  await laterVisit();
  await readCard();
  check((await shown(page).locator('.package-banner').count()) === 0, 'checked: the next visit has nothing waiting');

  noErrors(errors);
  await page.context().close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await waitingPackage(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
