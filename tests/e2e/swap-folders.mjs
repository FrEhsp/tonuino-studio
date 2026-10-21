/**
 * "Nummer ändern oder tauschen …" in the Paket mode: folder 01 and folder
 * 03 swap their numbers, folder 02 stays. The cards of both are offered
 * ticked under "Karten beschreiben", the Paket brings both folders whole
 * and no helper folder, and the card unpacked as the guide says has each
 * folder's files under the other number.
 */
import { join } from 'node:path';
import { check, chooseFolder, failed, FIXTURES, launch, makeCard, MP3, noErrors, openApp, OUT, same, shot, shown, testZip, treeOf, unpackOnto } from './lib.mjs';
import { saveThePaket } from './package-flow.mjs';

const VBR = join(FIXTURES, 'vbr-no-xing.mp3');

export async function swapFolders(browser) {
  console.log('swap folders');
  const card = makeCard(join(OUT, 'swap', 'TONUINO'), {
    mp3: { '0001.mp3': MP3 },
    advert: { '0001.mp3': MP3 },
    '01': { '001.mp3': MP3 },
    '02': { '001.mp3': MP3 },
    '03': { '001.mp3': VBR, '002.mp3': VBR },
  });
  const sizes = (dir) => treeOf(card).filter((f) => f.path.startsWith(`${dir}/`)).map((f) => [f.path, f.size]);
  const one = sizes('01');
  const three = sizes('03');
  const { page, errors } = await openApp(browser);
  const dialog = page.getByRole('dialog');

  await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
  await shown(page).locator('.page-header h1').waitFor();
  await page.goto(`${page.url().split('#')[0]}#/ordner/01`);
  await shown(page).locator('.folder-actions .page-more').click();
  await page.getByRole('menuitem', { name: 'Nummer ändern oder tauschen …' }).click();
  await dialog.waitFor();
  const options = await dialog.locator('#renumber-to option').allTextContents();
  check(options.some((o) => /^Ordner 03 · tauschen mit „.+“$/.test(o)), 'the list offers the taken numbers for a swap', options.slice(0, 5));
  check(options.some((o) => o === 'Ordner 04 · frei'), 'and the free ones');
  await dialog.locator('#renumber-to').selectOption('3');
  await dialog.getByText('Ordner 01 wird 03, Ordner 03 wird 01.').waitFor();
  check(await dialog.getByText('Danach musst du die Karten für beide Ordner neu beschreiben.').isVisible(), 'the dialog says both cards need writing again');
  await shot(page, 'swap-01-dialog');
  await dialog.getByRole('button', { name: 'Mit 03 tauschen' }).click();
  await shown(page).getByText('Das ist jetzt Ordner 03.').waitFor({ timeout: 30_000 });
  check(page.url().endsWith('#/ordner/03'), 'the folder page of the new number shows', page.url());
  await shot(page, 'swap-02-done');

  await shown(page).getByRole('button', { name: 'Karten neu beschreiben' }).click();
  await shown(page).locator('.pick-row.checked').first().waitFor();
  same(await shown(page).locator('.pick-row.checked').count(), 2, 'both cards are ticked under "Karten beschreiben"');

  await page.goto(`${page.url().split('#')[0]}#/`);
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  await dialog.getByText('Das kommt auf die Karte:').waitFor();
  const zip = await saveThePaket(page, dialog);
  const entries = testZip(zip);
  check(!entries.some((e) => e.startsWith('_tonuino-studio-temp')), 'no helper folder in the Paket', entries);
  same(
    entries.filter((e) => /^0\d\//.test(e)),
    ['01/', '01/001.mp3', '01/002.mp3', '03/', '03/001.mp3'],
    'the Paket brings both folders whole, and not folder 02',
  );
  unpackOnto(zip, card, { deleteFirst: ['01', '03'] });
  same(
    sizes('01').map(([, s]) => s),
    three.map(([, s]) => s),
    'folder 01 has the files of the old 03',
  );
  same(
    sizes('03').map(([, s]) => s),
    one.map(([, s]) => s),
    'folder 03 has the files of the old 01',
  );
  check(!treeOf(card).some((f) => f.path.startsWith('_tonuino-studio-temp')), 'no helper folder on the card');

  noErrors(errors);
  await page.context().close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await swapFolders(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
