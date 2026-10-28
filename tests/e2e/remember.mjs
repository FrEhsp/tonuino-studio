/**
 * „Box merken“: once a card was read, the app offers to remember the box on
 * this device. Without the card, "Meine Box" then shows it read only, and
 * "Karten beschreiben" and "Sticker drucken" work with it. On the next read
 * of the card the memory follows by itself; "Gemerkte Box vergessen" takes
 * it away again.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, chooseFiles, chooseFolder, failed, launch, makeCard, MP3, noErrors, openApp, OUT, shot, shown, unpackOnto } from './lib.mjs';
import { saveThePaket } from './package-flow.mjs';

const BOX_ID = 'e2e-merken-box';

function catalog(second = 'Gute-Nacht-Lieder') {
  const at = Date.UTC(2026, 9, 1);
  return {
    app: 'tonuino-studio',
    format: 1,
    id: BOX_ID,
    name: 'Emmas TonUINO',
    profile: 'tng',
    folders: {
      '01': { title: 'Bibi Blocksberg', artist: 'Bibi', kind: 'hoerspiel', tracks: [{ file: '001.mp3', title: 'Hexen-Ei' }, { file: '002.mp3', title: 'Hexkraft' }], cover: '01.jpg', addedAt: at, updatedAt: at },
      '02': { title: second, kind: 'lieder', tracks: [{ file: '001.mp3', title: 'Der Mond ist aufgegangen' }], addedAt: at, updatedAt: at },
    },
    extraCards: [{ id: 'x1', label: 'Schlummerkarte, 15 Minuten', folder: 0, mode: 1, special: 15, special2: 0 }],
    updatedAt: at,
  };
}

/** A card the app has set up before: catalog, a cover in the cover zip, two folders. */
function boxCard(dir) {
  const work = join(OUT, 'fixtures', 'merken');
  mkdirSync(work, { recursive: true });
  const jpg = join(work, '01.jpg');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=600x600:rate=1', '-frames:v', '1', jpg]);
  const zip = join(work, 'covers.zip');
  execFileSync('rm', ['-f', zip]);
  execFileSync('zip', ['-0', '-j', '-q', zip, jpg]);
  return makeCard(dir, {
    mp3: { '0001.mp3': MP3 },
    advert: { '0001.mp3': MP3 },
    '01': { '001.mp3': MP3, '002.mp3': MP3 },
    '02': { '001.mp3': MP3 },
    'tonuino-studio.json': JSON.stringify(catalog()),
    'tonuino-studio-covers.zip': readFileSync(zip),
  });
}

/** What the app keeps in IndexedDB for the box. */
function stored(page) {
  return page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const req = indexedDB.open('tonuino-studio', 1);
        req.onsuccess = () => {
          const tx = req.result.transaction('kv', 'readonly');
          const s = tx.objectStore('kv');
          const a = s.get(`box-memory:${id}`);
          const b = s.get(`box-memory-thumbs:${id}`);
          tx.oncomplete = () =>
            resolve({
              memory: a.result ? { name: a.result.name, folders: a.result.folders.length, catalog: a.result.catalog } : null,
              thumbs: b.result ? Object.fromEntries(Object.entries(b.result).map(([k, v]) => [k, v.data.length])) : null,
            });
        };
        req.onerror = () => resolve({ memory: null, thumbs: null });
      }),
    BOX_ID,
  );
}

async function noSideScroll(page, what) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  check(sw <= w + 1, `${what}: no sideways scrolling`, `${sw} > ${w}`);
}

/** The same screen at 1280 × 820 and at 390 px. */
/**
 * One song for folder 01 through a Paket onto the card, checked: the
 * question comes only after the first transfer to the card (audit 0.4 #1),
 * and in the Paket mode only once nothing waits for the card any more.
 */
async function transferOnce(page, card) {
  const go = (hash) => page.goto(`${page.url().split('#')[0]}${hash}`);
  const song = join(OUT, 'fixtures', 'merken-lied');
  makeCard(song, { 'Schlaf.mp3': MP3 });
  await go('#/hinzufuegen/1');
  await chooseFiles(page, [join(song, 'Schlaf.mp3')], page.getByRole('button', { name: 'Dateien auswählen' }));
  const into = page.getByRole('button', { name: 'Ins Paket für die Karte' });
  await into.waitFor({ timeout: 60_000 });
  await into.click();
  await page.getByText(/ist bereit fürs Paket|sind bereit fürs Paket/).waitFor({ timeout: 120_000 });
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  const dialog = page.getByRole('dialog');
  const zip = await saveThePaket(page, dialog);
  await dialog.getByText('Das Paket ist in deinem Download-Ordner').waitFor();
  unpackOnto(zip, card);
  // The guide may first offer to check the downloaded file; that is not what this is about.
  const skip = dialog.getByRole('button', { name: 'Ohne Prüfung weiter' });
  if (await skip.isVisible()) await skip.click();
  await dialog.getByRole('button', { name: 'Karte prüfen' }).last().click();
  await dialog.getByText('Wähle die SD-Karte noch einmal aus.').waitFor();
  await chooseFolder(page, card, dialog.getByRole('button', { name: 'SD-Karte einlesen' }));
  await dialog.getByText('Alles ist richtig auf der Karte.').waitFor({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Fertig' }).click();
  await go('#/');
}

async function shots(page, name) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await shot(page, `merken-${name}-1280`);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page, name);
  await shot(page, `merken-${name}-390`);
  await page.setViewportSize({ width: 1280, height: 820 });
}

export async function remember(browser) {
  console.log('Box merken');
  const card = boxCard(join(OUT, 'cards', 'MERKEN'));
  const { page, errors } = await openApp(browser, { width: 1280, height: 820 });
  const go = (hash) => page.goto(`${page.url().split('#')[0]}${hash}`);

  // 1. The card is read: no question yet. After the first transfer one quiet question under the header.
  await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
  await shown(page).getByRole('heading', { name: 'Emmas TonUINO' }).waitFor();
  const offer = shown(page).locator('.remember-offer');
  await page.waitForTimeout(500);
  check((await offer.count()) === 0, 'no question when the card was only read');
  await transferOnce(page, card);
  await shown(page).getByRole('heading', { name: 'Emmas TonUINO' }).waitFor();
  // One note at a time (Prüfrunde 1 Aussehen 11): the others wait behind „Zeigen“.
  await page.waitForTimeout(500);
  const more = shown(page).locator('.box-notes-more button');
  if (await more.count()) await more.click();
  await offer.waitFor();
  check((await offer.textContent()).includes('Box auf diesem Gerät merken?'), 'the shelf asks whether to remember the box');
  check((await stored(page)).memory === null, 'nothing is remembered before the answer');
  await shots(page, '01-angebot');

  await offer.getByRole('button', { name: 'Ja' }).click();
  await page.getByText('Box gemerkt').waitFor();
  check((await offer.count()) === 0, 'the question is gone after the answer');
  const first = await stored(page);
  check(first.memory?.name === 'Emmas TonUINO' && first.memory.folders === 2, 'the box is remembered with its folders', first.memory);
  check(!!first.thumbs?.['01'] && first.thumbs['01'] < 60_000 && !first.thumbs['02'], 'a small cover for the folder with a picture, none for the other', first.thumbs);

  // 2. Without the card (a new visit): "Meine Box" offers the remembered box.
  await page.reload();
  await page.getByRole('heading', { name: 'Hallo! Stecke die SD-Karte deiner Box in den Computer.' }).waitFor();
  const boxes = shown(page).locator('.remembered-boxes');
  await boxes.waitFor();
  check(/Emmas TonUINO\s*2 Ordner · gemerkt am \d\d\.\d\d\.\d{4}/.test(await boxes.textContent()), 'the start page names the remembered box and its day', await boxes.textContent());
  await shots(page, '02-start-ohne-karte');
  await boxes.getByRole('button', { name: 'Ansehen' }).click();

  // 3. The remembered box: its shelf, clearly not the card, nothing to change.
  const header = shown(page).locator('.page-header');
  await header.getByRole('heading', { name: 'Emmas TonUINO' }).waitFor();
  check(/2 Ordner · gemerkt am \d\d\.\d\d\.\d{4}/.test(await header.textContent()), 'the header says when the box was remembered');
  check((await header.getByText('Gemerkt', { exact: true }).count()) === 1, 'a badge says "Gemerkt"');
  check((await shown(page).getByText(/nicht die Karte selbst/).count()) === 1, 'the page says it is not the card');
  check((await header.getByRole('button', { name: 'Hinzufügen' }).count()) === 0, 'nothing to add without the card');
  const tiles = shown(page).locator('.shelf .tile');
  check((await tiles.count()) === 2, 'two folders on the shelf');
  check((await tiles.nth(0).textContent()).includes('Bibi Blocksberg') && (await tiles.nth(1).textContent()).includes('Gute-Nacht-Lieder'), 'with their names');
  await page.waitForFunction(() => [...document.querySelectorAll('.page-slot:not(.page-slot-hidden) .shelf .tile img.cover-img')].some((i) => i.complete && i.naturalWidth > 0));
  check((await tiles.nth(0).locator('img.cover-img').count()) === 1, 'folder 01 shows its remembered cover');
  // 0.6: the bar on top says it when the pointer rests on the card's line.
  check(/Keine SD-Karte/.test(await page.locator('.kopf .sd-zeile').textContent()) && /gemerkten Stand von „Emmas TonUINO“/.test((await page.locator('.kopf .sd-zeile .sd-none').getAttribute('title')) ?? ''), 'the bar on top says: no card, the remembered box');
  await shots(page, '03-gemerkte-box');
  await tiles.nth(0).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Hexkraft').waitFor();
  check((await dialog.textContent()).includes('Hexen-Ei'), 'a folder lists its remembered titles');
  await dialog.getByRole('button', { name: 'Schließen' }).last().click();

  // 4. Karten beschreiben: the folders and the box's cards, as with the card.
  await go('#/karten');
  const cards = shown(page);
  await cards.getByText(/Gemerkter Stand von „Emmas TonUINO“/).waitFor();
  const rows = cards.locator('.pick-list .pick-row');
  check((await rows.count()) === 3, 'two folder cards and the special card of the box', await rows.allTextContents());
  check((await cards.locator('.pick-change').count()) === 0, 'how a folder plays cannot change without the card');
  check((await rows.nth(2).getByRole('button', { name: /entfernen/ }).count()) === 0, 'the box’s own special card stays');
  await rows.nth(0).locator('input[type=checkbox]').check();
  await cards.getByRole('radio', { name: /Mit dem Handy/ }).click();
  await cards.locator('.qr-block canvas, .qr-block img, .qr-block svg').first().waitFor({ timeout: 20_000 });
  check(true, 'the QR code for the phone is there without the card');
  await page.evaluate(() => document.querySelector('.main')?.scrollTo(0, 0));
  await shots(page, '04-karten');

  // 5. Sticker drucken: the remembered folders with their small covers.
  await go('#/sticker/alle');
  const stickers = shown(page);
  await stickers.getByText(/Gemerkter Stand von „Emmas TonUINO“/).waitFor();
  // The folder picked for cards is the one sticker here: the short line of question 1 says so, "Ändern …" opens the list.
  check(/1 Ordner/.test((await stickers.locator('.pick-summary').textContent()) ?? ''), 'the summary of "Welche Sticker?" counts the picked folder');
  await stickers.getByRole('button', { name: 'Ändern …' }).click();
  const picks = page.getByRole('dialog', { name: 'Welche Sticker?' }).locator('.sticker-pick .pick-row');
  await picks.first().waitFor();
  check((await picks.count()) >= 2 && (await picks.nth(0).textContent()).includes('Bibi Blocksberg'), 'the sticker list has the folders');
  check(await picks.nth(0).locator('input[type=checkbox]').isChecked(), 'the folder picked for cards is picked here too');
  // The sheet is drawn on a canvas: wait for the sticker's colours on it.
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.page-slot:not(.page-slot-hidden) .sheet-preview canvas');
      if (!c || !c.width) return false;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 64) if (d[i] + d[i + 1] + d[i + 2] < 400) return true;
      return false;
    },
    undefined,
    { timeout: 20_000, polling: 250 },
  );
  check(true, 'the sticker of the remembered folder is drawn on the sheet');
  await picks.nth(0).getByRole('button', { name: /anpassen/ }).click();
  // Since 7db572c a remembered sticker can be adjusted without the card.
  const adjust = page.getByRole('dialog', { name: 'Sticker anpassen' });
  await adjust.waitFor();
  check(true, 'a remembered sticker can be adjusted without the card');
  await page.keyboard.press('Escape');
  await adjust.waitFor({ state: 'detached' });
  await page.getByRole('dialog', { name: 'Welche Sticker?' }).getByRole('button', { name: 'Fertig' }).click();
  await shots(page, '05-sticker');

  // 6. The switch in the settings, with the box to forget.
  await go('#/einstellungen');
  const settings = shown(page);
  const sw = settings.locator('#setting-rememberBoxes-input');
  check(await sw.isChecked(), 'the switch in the settings is on after "Ja"');
  await settings.locator('.remembered-settings').getByText('Emmas TonUINO').waitFor();

  // 7. The card again, with a new name for folder 02: the memory follows by itself.
  writeFileSync(join(card, 'tonuino-studio.json'), JSON.stringify(catalog('Schlaflieder')));
  await go('#/');
  await shown(page).getByRole('button', { name: 'Schließen' }).click();
  await chooseFolder(page, card, shown(page).getByRole('button', { name: 'SD-Karte einlesen' }));
  await shown(page).getByRole('heading', { name: 'Emmas TonUINO' }).waitFor();
  check((await shown(page).locator('.remember-offer').count()) === 0, 'no question once answered');
  await page.waitForFunction(
    (id) =>
      new Promise((resolve) => {
        const req = indexedDB.open('tonuino-studio', 1);
        req.onsuccess = () => {
          const get = req.result.transaction('kv').objectStore('kv').get(`box-memory:${id}`);
          get.onsuccess = () => resolve(!!get.result?.catalog.includes('Schlaflieder'));
        };
      }),
    BOX_ID,
    { timeout: 20_000, polling: 300 },
  );
  check(true, 'the memory follows the card on the next read');
  const again = await stored(page);
  check(JSON.stringify(again.thumbs) === JSON.stringify(first.thumbs), 'the unchanged cover keeps its thumbnail', again.thumbs);

  // 8. Forgotten: gone from this device.
  await page.reload();
  await go('#/einstellungen');
  const list = shown(page).locator('.remembered-settings');
  await list.getByRole('button', { name: 'Gemerkte Box vergessen' }).click();
  await page.getByText('Box vergessen').waitFor();
  check((await stored(page)).memory === null && (await stored(page)).thumbs === null, 'nothing of the box is left on the device');
  await go('#/');
  await page.getByRole('heading', { name: 'Hallo! Stecke die SD-Karte deiner Box in den Computer.' }).waitFor();
  await page.waitForTimeout(300);
  check((await shown(page).locator('.remembered-boxes').count()) === 0, 'the start page offers no box any more');
  noErrors(errors);
  await page.context().close();

  // "Nein": nothing is remembered, and the question does not come again.
  {
    const { page, errors } = await openApp(browser);
    await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
    await shown(page).getByRole('heading', { name: 'Emmas TonUINO' }).waitFor();
    await transferOnce(page, card);
    await shown(page).getByRole('heading', { name: 'Emmas TonUINO' }).waitFor();
    await page.waitForTimeout(500);
    const more = shown(page).locator('.box-notes-more button');
    if (await more.count()) await more.click();
    const offer = shown(page).locator('.remember-offer');
    await offer.waitFor();
    await offer.getByRole('button', { name: 'Nein' }).click();
    check((await offer.count()) === 0, '"Nein" takes the question away');
    await page.waitForTimeout(2500);
    check((await stored(page)).memory === null, '"Nein" remembers nothing');
    await page.reload();
    await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
    await shown(page).getByRole('heading', { name: 'Emmas TonUINO' }).waitFor();
    await page.waitForTimeout(500);
    check((await shown(page).locator('.remember-offer').count()) === 0, 'the question is asked only once');
    noErrors(errors);
    await page.context().close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await remember(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
