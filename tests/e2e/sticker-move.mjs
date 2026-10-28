/**
 * Moving stickers on the sheet preview of "Sticker drucken" (forum wish of
 * 13.10.2026): a real drag with the mouse swaps two stickers, onto a free
 * label it moves one, over the pager it goes to the other sheet, and the
 * keyboard does the same. A click without moving still opens "Sticker
 * anpassen", and the PDF follows the placement.
 *
 * No card: own pictures, drawn in the page, handed out by a stubbed file
 * picker (as in direct-mode.mjs). The PDF lands in the origin private file
 * system and is drawn with pdftoppm.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, failed, launch, noErrors, openApp, OUT, same, shot, shown } from './lib.mjs';

const STUBS = () => {
  window.showOpenFilePicker = async () => {
    const root = await navigator.storage.getDirectory();
    const album = await root.getDirectoryHandle('BILDER', { create: true });
    const out = [];
    for await (const h of album.values()) if (h.kind === 'file') out.push(h);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
  window.showSaveFilePicker = async ({ suggestedName }) => {
    const root = await navigator.storage.getDirectory();
    const saved = await root.getDirectoryHandle('GESPEICHERT', { create: true });
    return saved.getFileHandle(suggestedName, { create: true });
  };
};

const TITLES = ['Mondreise', 'Waldkonzert', 'Leuchtturm', 'Schneckenpost', 'Drachenfest', 'Regenbogen', 'Piratenbucht', 'Sternenzelt', 'Bauernhof', 'Wolkenschloss', 'Eisbärenland', 'Zauberwald'];

/** Twelve made-up pictures, one colour and a big number each. */
async function drawPictures(page) {
  await page.evaluate(async (titles) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('BILDER', { recursive: true }).catch(() => undefined);
    const album = await root.getDirectoryHandle('BILDER', { create: true });
    for (const [i, title] of titles.entries()) {
      const c = new OffscreenCanvas(600, 600);
      const g = c.getContext('2d');
      g.fillStyle = `hsl(${(i * 31) % 360} 65% 55%)`;
      g.fillRect(0, 0, 600, 600);
      g.fillStyle = 'rgb(255 255 255 / 0.85)';
      g.beginPath();
      g.arc(300, 300, 190, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#1f1a16';
      g.font = 'bold 220px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i + 1), 300, 310);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const h = await album.getFileHandle(`${String(i + 1).padStart(2, '0')} ${title}.png`, { create: true });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
    }
  }, TITLES);
}

/** Titles on the labels of the sheet shown, null for an empty one. */
async function labels(page) {
  return page.evaluate(() => {
    const sheet = [...document.querySelectorAll('.page-slot:not(.page-slot-hidden) .sheet-preview')].pop();
    const out = new Array(10).fill(null);
    for (const b of sheet.querySelectorAll('.sheet-hit:not(.empty)')) {
      const m = /^Etikett (\d+): (.*)\. Anpassen$/.exec(b.getAttribute('aria-label'));
      if (m) out[Number(m[1]) - 1] = m[2];
    }
    return out;
  });
}

/** The centre of label `slot` (0-based) on the sheet shown, in page pixels. */
async function centre(page, slot) {
  const box = await page.locator('.page-slot:not(.page-slot-hidden) .sheet-preview').boundingBox();
  // HERMA 5028: 2 × 5 labels of 83.8 × 50.8 mm on A4.
  const col = slot % 2;
  const row = Math.floor(slot / 2);
  const x = 18.64 + col * 88.88 + 83.8 / 2;
  const y = 21.5 + row * 50.8 + 50.8 / 2;
  return { x: box.x + (x / 210) * box.width, y: box.y + (y / 297) * box.height };
}

async function drag(page, from, to, { steps = 12, before } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  if (before) await before();
  await page.mouse.up();
}

const sheetSays = (page) => shown(page).locator('.sheet-count').textContent();
/** The number of sheets, in the short line of "Welche Sticker?" ("Mondreise, Waldkonzert … · 2 Bögen"). */
const sheetCount = (page, sheets) => shown(page).locator('.pick-summary-text .soft', { hasText: new RegExp(`· ${sheets}$`) });
/** A small sheet above the big one: a click shows it, a sticker held over it turns to it. */
const mini = (page, n) => shown(page).getByRole('button', { name: `Bogen ${n}`, exact: true });

export async function stickerMove(browser, { shots = OUT } = {}) {
  console.log('moving stickers on the sheet');
  // 1000 px high: without the sidebar of 0.5 the sheet is wider and its labels taller; the drag from label 1 to 7 needs both in view.
  const { page, errors } = await openApp(browser, { mode: 'direct', width: 1280, height: 1000, init: [{ fn: STUBS }], hash: '#/sticker/alle' });
  await drawPictures(page);
  await shown(page).getByRole('button', { name: 'Bilder hinzufügen' }).click();
  await sheetCount(page, '2 Bögen').waitFor({ timeout: 60_000 });
  // The sheet drawn: every sticker of the first sheet ready.
  await page.waitForTimeout(2500);
  // The number in front of a file name becomes the sticker's number, the rest its title.
  const first = TITLES.slice(0, 10);
  const titleOf = async (slot) => (await labels(page))[slot];
  check((await labels(page)).every(Boolean), 'the first sheet is full');
  const before = await labels(page);
  await shot(page, 'bogen-1-vorher');

  // A click without moving: "Sticker anpassen" as before.
  const c0 = await centre(page, 0);
  await page.mouse.click(c0.x, c0.y);
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  check(/anpassen/i.test((await dialog.textContent()) ?? ''), 'a click still opens "Sticker anpassen"');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // A real drag: sticker 1 onto sticker 4, they swap.
  const c3 = await centre(page, 3);
  await drag(page, c0, c3, {
    before: async () => {
      check(await page.locator('.sheet-ghost').isVisible(), 'the sticker in hand follows the pointer');
      check((await shown(page).locator('.sheet-drop').getAttribute('data-kind')) === 'swap', 'over another sticker the mark says "Tauschen"');
      await shot(page, 'bogen-2-beim-ziehen-tauschen');
    },
  });
  await page.waitForTimeout(300);
  const swapped = await labels(page);
  same([swapped[0], swapped[3]], [before[3], before[0]], 'dropped on another sticker, the two swap');
  check((await page.getByRole('dialog').count()) === 0, 'the drop opens no dialog');
  check(await shown(page).getByRole('button', { name: 'Reihenfolge zurücksetzen' }).isVisible(), '"Reihenfolge zurücksetzen" shows once something moved');
  check((await page.locator('.sheet-ghost').count()) === 0, 'the copy in hand is gone after the drop');

  // To the second sheet: two stickers there, eight free labels.
  check(/Bogen 1 von 2/.test((await sheetSays(page)) ?? ''), 'over the sheet: "Bogen 1 von 2"');
  await mini(page, 2).click();
  await page.waitForTimeout(800);
  const second = await labels(page);
  same(second.slice(0, 3), ['Eisbärenland', 'Zauberwald', null], 'the second sheet starts with sticker 11');
  // Held on the print bar, the page scrolls by itself: label 8 hides behind the bar at this size.
  const scrolled = () => page.evaluate(() => document.querySelector('main').scrollTop);
  const top0 = await scrolled();
  const bar = await shown(page).locator('.print-bar').boundingBox();
  const c1 = await centre(page, 1);
  await page.mouse.move(c1.x, c1.y);
  await page.mouse.down();
  await page.mouse.move(c1.x, bar.y + 10, { steps: 12 });
  await page.waitForTimeout(1200);
  check((await scrolled()) > top0, 'held on the print bar, the page scrolls to the labels behind it', `${top0} → ${await scrolled()}`);
  await page.keyboard.press('Escape');
  same((await labels(page)).slice(0, 3), ['Eisbärenland', 'Zauberwald', null], 'Escape puts the sticker back');
  // Onto a free label, in view: it moves there.
  await page.evaluate((y) => document.querySelector('main').scrollTo(0, y), top0);
  const c7 = await centre(page, 7);
  // Labels 1 and 7 both in view, between the bar on top and the print bar.
  const mainTop = (await page.locator('main').boundingBox()).y;
  await page.evaluate((dy) => document.querySelector('main').scrollBy(0, dy), (c1.y + c7.y) / 2 - (mainTop + bar.y) / 2);
  await drag(page, await centre(page, 1), await centre(page, 7), {
    before: async () => {
      check((await shown(page).locator('.sheet-drop').getAttribute('data-kind')) === 'move', 'over a free label the mark says "Hierhin"');
      await shot(page, 'bogen-3-beim-ziehen-hierhin');
    },
  });
  await page.waitForTimeout(300);
  same((await labels(page)).slice(0, 8), ['Eisbärenland', null, null, null, null, null, null, 'Zauberwald'], 'dropped on a free label, the sticker moves there');

  // Across the sheets: held over the small first sheet, then onto label 10 of the first.
  await page.evaluate((y) => document.querySelector('main').scrollTo(0, y), top0);
  const back = await mini(page, 1).boundingBox();
  await page.mouse.move((await centre(page, 0)).x, (await centre(page, 0)).y);
  await page.mouse.down();
  await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2, { steps: 15 });
  await page.waitForTimeout(900);
  check(/Bogen 1 von 2/.test((await sheetSays(page)) ?? ''), 'held over the small sheet, the first sheet turns up');
  const c9 = await centre(page, 9);
  await page.mouse.move(c9.x, c9.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  check((await titleOf(9)) === 'Eisbärenland', 'across sheets: sticker 11 is on label 10 of the first sheet');
  await page.mouse.move(640, 790);
  await shot(page, 'bogen-4-nachher');

  // Keyboard: sticker on label 2, arrow right, Enter: swapped with label 3.
  const kb = await labels(page);
  await page.locator('.page-slot:not(.page-slot-hidden) .sheet-hit[data-slot="1"]').focus();
  await page.keyboard.press('ArrowRight');
  check((await shown(page).locator('.sheet-drop').getAttribute('data-kind')) === 'swap', 'keyboard: the arrow shows the mark on the next label');
  const picked = await page.locator('.page-slot:not(.page-slot-hidden) [aria-live="assertive"]').textContent();
  check(/aufgenommen\. Pfeiltasten .*Escape bricht ab\. (Bogen 1, )?Etikett 3: tauschen/.test(picked ?? ''), 'keyboard: picking up says how to drop, together with the label', picked);
  const keysHint = await shown(page).locator('.print-bar .carry-note', { hasText: 'Bild auf und Bild ab den Bogen' }).count();
  const mouseHint = await shown(page).getByText('Halte den Sticker kurz über einen der kleinen Bögen').count();
  check(keysHint === 1 && mouseHint === 0, 'keyboard: the line in the print bar tells the keys, not the mouse');
  await shot(page, 'bogen-4b-tastatur-tragen');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const kbAfter = await labels(page);
  same([kbAfter[1], kbAfter[2]], [kb[2], kb[1]], 'keyboard: arrow and Enter swap with the next label');
  check((await page.getByRole('dialog').count()) === 0, 'keyboard: Enter after carrying opens no dialog');
  const said = await page.locator('.page-slot:not(.page-slot-hidden) [aria-live="assertive"]').textContent();
  check(/getauscht/.test(said ?? ''), 'keyboard: the screen reader hears what happened', said);
  // Escape puts it back.
  await page.locator('.page-slot:not(.page-slot-hidden) .sheet-hit[data-slot="4"]').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  same(await labels(page), kbAfter, 'keyboard: Escape leaves everything where it was');

  // The PDF follows the placement.
  const placed = await labels(page);
  await shown(page).getByRole('button', { name: 'PDF speichern' }).click();
  await page.getByText('PDF gespeichert').first().waitFor({ timeout: 120_000 });
  const pdf = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const saved = await root.getDirectoryHandle('GESPEICHERT');
    for await (const h of saved.values()) {
      if (h.name.endsWith('.pdf')) {
        const bytes = new Uint8Array(await (await h.getFile()).arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      }
    }
    return null;
  });
  check(!!pdf, 'the PDF is saved');
  if (pdf) {
    mkdirSync(shots, { recursive: true });
    const file = join(shots, 'bogen.pdf');
    writeFileSync(file, Buffer.from(pdf, 'base64'));
    execFileSync('pdftoppm', ['-png', '-r', '60', '-f', '1', '-l', '2', file, join(shots, 'bogen-5-pdf')]);
    const pages = execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)?.[1];
    check(pages === '2', 'the PDF has the two sheets', pages);
  }
  check(placed[9] === 'Eisbärenland' && placed[0] === first[3], 'the placement checked in the PDF is the one moved');

  // Labels marked as gone and back: the stickers come back onto them. The picker sits under "Mehr …".
  await shown(page).locator('.bench-more-toggle').click();
  const usedPicker = shown(page).locator('.used-picker');
  const slotButton = (n) => usedPicker.getByRole('button', { name: `Etikett ${n}`, exact: true });
  const beforeGone = await labels(page);
  await slotButton(1).click();
  await slotButton(2).click();
  await page.waitForTimeout(600);
  same((await labels(page)).slice(0, 3), [null, null, beforeGone[0]], 'labels marked as gone stay free, the stickers move on in their order');
  await usedPicker.getByRole('button', { name: 'Etikett 1, fehlt schon' }).click();
  await usedPicker.getByRole('button', { name: 'Etikett 2, fehlt schon' }).click();
  await page.waitForTimeout(600);
  same(await labels(page), beforeGone, 'unmarked again, the stickers are back on labels 1 and 2');

  // Another paper: the stickers fill its labels anew in their order, no sheet nearly empty.
  await shown(page).locator('.paper-option', { hasText: 'Runde Sticker Ø 30 mm' }).click();
  await sheetCount(page, '1 Bogen').waitFor({ timeout: 10_000 }).catch(() => undefined);
  check((await sheetCount(page, '1 Bogen').count()) === 1, 'on 40-label paper the moved stickers fit one sheet');
  await page.waitForTimeout(1500);
  await shot(page, 'bogen-6-anderes-papier');
  await shown(page).locator('.paper-option', { hasText: 'HERMA 5028' }).click();
  await sheetCount(page, '2 Bögen').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  same(await labels(page), placed, 'back on HERMA the first sheet is full, in the order moved by hand');

  // Back to the plain order.
  await shown(page).getByRole('button', { name: 'Reihenfolge zurücksetzen' }).click();
  await page.waitForTimeout(400);
  same(await labels(page), first, '"Reihenfolge zurücksetzen" puts them back in order');
  check((await shown(page).getByRole('button', { name: 'Reihenfolge zurücksetzen' }).count()) === 0, 'the link goes once the order is plain');

  // Off the sheet (0.5.1): the × at a sticker's corner, shown with the pointer on it, and the button in "Sticker anpassen".
  const sheetShown = page.locator('.page-slot:not(.page-slot-hidden) .sheet-preview');
  await page.mouse.move(c0.x, c0.y);
  await page.waitForTimeout(300);
  const cross = sheetShown.getByRole('button', { name: `„${first[0]}“ vom Bogen nehmen` });
  check((await cross.evaluate((b) => getComputedStyle(b).opacity)) === '1', 'the × shows at the sticker under the pointer');
  await shot(page, 'bogen-7-kreuz');
  await cross.click();
  await page.waitForTimeout(600);
  const afterCross = await labels(page);
  check(!afterCross.includes(first[0]), 'the × takes the sticker off the sheet');
  same(afterCross[0], first[1], 'the next sticker moves up');
  check((await page.getByRole('dialog').count()) === 0, 'the × opens no dialog');
  await page.mouse.click(c0.x, c0.y);
  await dialog.waitFor();
  await shot(page, 'bogen-8-anpassen-entfernen');
  await dialog.getByRole('button', { name: 'Vom Bogen nehmen' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForTimeout(600);
  check(!(await labels(page)).includes(first[1]), '"Vom Bogen nehmen" in "Sticker anpassen" takes it off too');

  noErrors(errors);
  await page.context().close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await stickerMove(browser, { shots: process.env.E2E_SHOTS ?? join(OUT, 'shots') });
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
