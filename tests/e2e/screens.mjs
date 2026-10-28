/**
 * Screenshots of the Paket mode in light and dark, at 1280 and 390 px, and
 * a check that no screen scrolls sideways on a phone.
 */
import { join } from 'node:path';
import { saveThePaket } from './package-flow.mjs';
import { addAlbum, check, chooseFolder, failed, launch, makeCard, MP3, noErrors, openApp, OUT, shot, shown } from './lib.mjs';

async function noSideScroll(page, what) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  check(sw <= w + 1, `${what}: no sideways scrolling`, `${sw} > ${w}`);
}

async function screens(browser, theme, width) {
  const tag = `${theme}-${width}`;
  console.log(`screens ${tag}`);
  // A long name: shown in the SD chip on top of a phone, it must not widen the page.
  const card = makeCard(join(OUT, 'cards', `SCREENS-${tag}-Emmas-allerliebste-Kinderzimmer-Hoerspielbox`), {
    mp3: { '0001.mp3': MP3 },
    advert: { '0001.mp3': MP3 },
    '01': { '001.mp3': MP3, '002.mp3': MP3 },
  });
  const album = makeCard(join(OUT, 'music', `Screens-${tag}`), { '01.mp3': MP3, '02.mp3': MP3 });
  const { page, errors } = await openApp(browser, { theme, width, height: width < 600 ? 844 : 900 });
  const snap = async (name) => {
    await noSideScroll(page, `${tag} ${name}`);
    await shot(page, `screens-${tag}-${name}`);
  };
  // On a phone the menu is folded away; the page links are used instead.
  const go = (hash) => page.goto(`${page.url().split('#')[0]}${hash}`);

  await page.getByRole('heading', { name: 'Hallo! Stecke die SD-Karte deiner Box in den Computer.' }).waitFor();
  await snap('01-welcome');
  await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
  await shown(page).locator('.page-header h1').waitFor();
  await snap('02-shelf');
  await addAlbum(page, [join(album, '01.mp3'), join(album, '02.mp3')]);
  await go('#/');
  await shown(page).locator('.package-banner.pending').waitFor();
  await snap('03-pending');
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Das kommt auf die Karte:').waitFor();
  await snap('04-choose');
  await saveThePaket(page, dialog);
  await dialog.getByText('Das Paket ist in deinem Download-Ordner').waitFor();
  await dialog.getByRole('tab', { name: 'Mac' }).click();
  await snap('05-guide-mac');
  await dialog.getByRole('button', { name: 'Karte prüfen' }).last().click();
  await dialog.getByText('Wähle die SD-Karte noch einmal aus.').waitFor();
  await snap('06-check');
  await chooseFolder(page, card, dialog.getByRole('button', { name: 'SD-Karte einlesen' }));
  await dialog.getByText('Auf der Karte ist noch nichts aus dem Paket.').waitFor({ timeout: 30_000 });
  await snap('07-check-failed');
  await dialog.locator('.dialog-foot').getByRole('button', { name: 'Schließen' }).click();
  await shown(page).locator('.package-banner.downloaded').waitFor();
  await snap('08-downloaded');
  await go('#/hinzufuegen');
  // Coming back after an add that went well, the add page starts afresh: the gate shows at once.
  await shown(page).getByText('Erst das Paket auf die Karte bringen').first().waitFor();
  await snap('09-gate');
  await go('#/werkstatt/paket');
  await page.getByRole('heading', { name: 'Paket auf die Karte bringen' }).waitFor();
  await snap('10-werkstatt');
  await go('#/hilfe/paket');
  await page.getByRole('heading', { name: 'Ein Paket auf die Karte bringen' }).waitFor();
  await snap('11-help');

  // The cover lookup for the new album may go out (setting „Fehlende Cover selbst suchen“); without a network that fails, as in page-edges.mjs.
  noErrors(errors, `${tag}: no errors on the page`, [/ERR_TUNNEL|ERR_INTERNET_DISCONNECTED|Failed to load resource/]);
  await page.context().close();
}

export async function allScreens(browser) {
  await screens(browser, 'light', 1280);
  await screens(browser, 'dark', 1280);
  await screens(browser, 'light', 390);
  await screens(browser, 'dark', 390);
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await allScreens(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
