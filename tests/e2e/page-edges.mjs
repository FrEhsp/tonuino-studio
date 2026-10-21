/**
 * Page titles stay in place from page to page (Werkstatt, Hilfe,
 * Einstellungen and the others start at the same edge), and a dialog on a
 * narrow page darkens the whole window, with the dialog in its middle.
 */
import { join } from 'node:path';
import { check, chooseFolder, makeCard, MP3, noErrors, openApp, OUT, shown } from './lib.mjs';

const PAGES = ['#/', '#/entdecken', '#/karten', '#/werkstatt', '#/werkstatt/ansagen', '#/werkstatt/box-einstellen', '#/hilfe', '#/einstellungen'];

export async function pageEdges(browser) {
  console.log('page edges: titles stay in place, dialogs cover the window');
  for (const width of [1600, 1280, 1024, 390]) {
    const { page, context, errors } = await openApp(browser, { width, height: 900 });
    const base = page.url().split('#')[0];
    const lefts = {};
    for (const hash of PAGES) {
      await page.goto(base + hash);
      await shown(page).locator('h1').first().waitFor();
      lefts[hash] = await shown(page)
        .locator('h1')
        .first()
        .evaluate((h) => Math.round(h.getBoundingClientRect().left));
    }
    // "Meine Box" without a card is the welcome page: its title sits in a column of its own.
    const edges = new Set(PAGES.filter((h) => h !== '#/').map((h) => lefts[h]));
    check(edges.size === 1, `page edges ${width}: every title starts at the same place`, lefts);

    if (width !== 390) {
      const card = makeCard(join(OUT, 'cards', `EDGES-${width}`), { '01': { '001.mp3': MP3 } });
      await page.goto(base + '#/');
      await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
      await shown(page).locator('.page-header h1').waitFor();
      await page.goto(base + '#/werkstatt/ansagen');
      await shown(page).getByRole('button', { name: /^Ansagen (neu )?(installieren|erneuern)$/ }).first().click();
      const backdrop = page.locator('.dialog-backdrop');
      await backdrop.waitFor();
      await page.waitForTimeout(350);
      const r = await backdrop.evaluate((b) => {
        const box = b.getBoundingClientRect();
        const d = b.querySelector('[role="dialog"]').getBoundingClientRect();
        return { left: box.left, width: box.width, middle: d.left + d.width / 2 };
      });
      check(r.left === 0 && r.width === width, `page edges ${width}: the dialog darkens the whole window`, r);
      check(Math.abs(r.middle - width / 2) < 2, `page edges ${width}: the dialog stands in the middle`, r);
    }
    noErrors(errors, `page edges ${width}: no errors`, [/ERR_TUNNEL|Failed to load resource/]);
    await context.close();
  }
}
