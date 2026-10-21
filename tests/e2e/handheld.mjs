/**
 * Phones and tablets: their browsers have a folder chooser but no way to
 * the SD card, so the app asks to open it on a computer instead of
 * offering the Paket mode. A narrow window on a computer keeps the Paket.
 */
import { APP_URL, check, failed, launch, noErrors, openApp, shot } from './lib.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

/** What iOS Safari lacks next to Chrome: folder access and USB. */
const SAFARI_INIT = () => {
  delete window.showDirectoryPicker;
  delete window.showOpenFilePicker;
  delete window.showSaveFilePicker;
  if (window.DataTransferItem) delete DataTransferItem.prototype.getAsFileSystemHandle;
  delete Navigator.prototype.serial;
};

export async function handheld(browser) {
  console.log('handheld: a phone gets "Bitte am Computer öffnen"');
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: IPHONE,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      colorScheme: theme,
      locale: 'de-DE',
    });
    await context.addInitScript(SAFARI_INIT);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(APP_URL);
    const title = page.getByRole('heading', { name: 'Bitte am Computer öffnen' });
    await title.waitFor();
    check(true, `handheld (${theme}): the phone is asked to open the app on a computer`);
    check((await page.locator('.sidebar').count()) === 0, `handheld (${theme}): no app behind the notice`);
    const stepFirst = await page.evaluate(() => {
      const step = [...document.querySelectorAll('.handheld-notice p')].find((p) => p.textContent?.includes('in Firefox, Chrome, Edge oder Safari'));
      const button = [...document.querySelectorAll('.handheld-notice button')].find((b) => b.textContent?.includes('Trotzdem ansehen'));
      return !!step && !!button && !!(step.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    check(stepFirst, `handheld (${theme}): what to do comes before the buttons`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `handheld (${theme}): no sideways scrolling at 390 px`, overflow);
    await shot(page, `handheld-01-notice-390-${theme}`);
    if (theme === 'light') {
      await page.getByRole('button', { name: 'Trotzdem ansehen' }).click();
      await page.locator('.sidebar').waitFor();
      check(await page.getByRole('heading', { name: 'Die SD-Karte geht nur am Computer' }).isVisible(), 'handheld: looking around, the start page says the card needs a computer');
      check((await page.getByRole('button', { name: 'SD-Karte einlesen' }).count()) === 0, 'handheld: no Paket mode on a phone');
      await shot(page, 'handheld-02-look-around-390-light');
      await page.reload();
      await page.locator('.sidebar').waitFor();
      check((await title.count()) === 0, 'handheld: the choice holds for this visit');
    }
    noErrors(errors);
    await context.close();
  }

  console.log('handheld: a narrow window on a computer keeps the Paket mode');
  const { page, errors, context } = await openApp(browser, { width: 390, height: 844 });
  await page.getByRole('button', { name: 'SD-Karte einlesen' }).first().waitFor();
  check((await page.getByRole('heading', { name: 'Bitte am Computer öffnen' }).count()) === 0, 'handheld: a narrow window on a computer is no phone');
  noErrors(errors);
  await context.close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await handheld(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
