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
    const pads = {};
    for (const hash of PAGES) {
      await page.goto(base + hash);
      await shown(page).locator('h1').first().waitFor();
      lefts[hash] = await shown(page)
        .locator('h1')
        .first()
        .evaluate((h) => Math.round(h.getBoundingClientRect().left));
      pads[hash] = await shown(page)
        .locator('.page')
        .first()
        .evaluate((p) => Math.round(p.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(p).paddingLeft)));
    }
    // "Meine Box" without a card is the welcome page: its title sits in a column of its own.
    // „Entdecken“ uses the whole window for its rows of covers (TODO 0.3 #119): its title starts at the window's edge.
    const WIDE = ['#/', '#/entdecken'];
    const edges = new Set(PAGES.filter((h) => !WIDE.includes(h)).map((h) => lefts[h]));
    check(edges.size === 1, `page edges ${width}: every title starts at the same place`, lefts);
    check(lefts['#/entdecken'] === pads['#/entdecken'] && pads['#/entdecken'] <= lefts['#/karten'], `page edges ${width}: „Entdecken“ starts where its page starts, never right of the others`, { lefts, pads });

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

  // „Alle Einstellungen …“ of the stickers is never hidden under „Drucken“, also without a card (Prüfrunde 2, eltern 2).
  for (const [width, height] of [[1440, 900], [1280, 720], [1366, 768]]) {
    const { page, context } = await openApp(browser, { width, height, hash: '#/sticker' });
    const link = shown(page).getByRole('link', { name: 'Alle Einstellungen …' });
    await link.waitFor();
    const hit = await link.evaluate((a) => {
      const r = a.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { inWindow: r.bottom <= innerHeight, mine: !!at && a.contains(at) };
    });
    check(hit.inWindow && hit.mine, `page edges ${width}×${height}: „Alle Einstellungen …“ of the stickers is in view and clickable`, hit);
    await context.close();
  }

  // The names of the four looks are never under „Drucken“, also in a window of 1024 × 768 (Prüfrunde 3, M1).
  for (const [width, height] of [[1024, 768], [1000, 728], [1280, 720]]) {
    const { page, context } = await openApp(browser, { width, height, hash: '#/sticker' });
    await shown(page).getByRole('radio', { name: /Vollbild/ }).waitFor();
    const hidden = await page.evaluate(() =>
      [...document.querySelectorAll('.stil-name')]
        .filter((n) => n.offsetParent !== null)
        .filter((n) => {
          const r = n.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !at || at.closest('.stil-wahl') !== n.closest('.stil-wahl');
        })
        .map((n) => n.textContent),
    );
    check(hidden.length === 0, `page edges ${width}×${height}: the names of the sticker looks are not hidden`, hidden);
    await context.close();
  }
}
