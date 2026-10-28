/**
 * "Anhören" in a folder and on "Hinzufügen" (TODO 0.3 #35, #38): the bar
 * shows the length the list shows, also for a VBR file without a Xing frame
 * (the browser alone guesses 22 s for its 15 s); back to the start lands on
 * 0:00; quick changes between tracks never end in an error; the row that
 * plays grows with its bar and covers no other row.
 *
 * Runs in Chrome mode (showDirectoryPicker stubbed with a folder in the
 * origin private file system, as in direct-mode.mjs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, FIXTURES, MP3, noDeezer, noErrors, openApp, shot, shown } from './lib.mjs';

const VBR = join(FIXTURES, 'vbr-no-xing.mp3');

const PICKER = () => {
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('TONUINO', { create: true });
  window.showOpenFilePicker = async () => {
    const album = await (await navigator.storage.getDirectory()).getDirectoryHandle('ALBUM', { create: true });
    const out = [];
    for await (const h of album.values()) if (h.kind === 'file') out.push(h);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
};

async function fill(page, tree, top) {
  await page.evaluate(
    async ({ tree, top }) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(top, { recursive: true }).catch(() => undefined);
      const write = async (dir, t) => {
        for (const [name, v] of Object.entries(t)) {
          if (typeof v === 'string') {
            const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
            await w.write(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
            await w.close();
          } else await write(await dir.getDirectoryHandle(name, { create: true }), v);
        }
      };
      await write(await root.getDirectoryHandle(top, { create: true }), tree);
    },
    { tree, top },
  );
}

/** Rows of a list that overlap the row before or after them. */
async function overlaps(list) {
  return list.evaluate((el) => {
    const rows = [...el.querySelectorAll(':scope > .list-row')].map((r) => r.getBoundingClientRect());
    const out = [];
    for (let i = 1; i < rows.length; i++) if (rows[i].top < rows[i - 1].bottom - 0.5) out.push(i);
    // Everything inside a row stays inside it (the bar, the file name).
    el.querySelectorAll(':scope > .list-row').forEach((r, i) => {
      const box = r.getBoundingClientRect();
      for (const c of r.querySelectorAll('.seekbar, .tiny')) {
        const b = c.getBoundingClientRect();
        if (b.height && (b.bottom > box.bottom + 0.5 || b.top < box.top - 0.5)) out.push(`inside ${i}`);
      }
    });
    return out;
  });
}

const clock = (row) => row.locator('.seekbar-clock').textContent();

export async function player(browser) {
  console.log('Anhören: length, jumps, changing tracks, rows');
  const vbr = readFileSync(VBR).toString('base64');
  const mp3 = readFileSync(MP3).toString('base64');
  const { page, errors } = await openApp(browser, { mode: 'direct', init: [{ fn: PICKER }] });
  // The shelf looks for missing covers by itself after a card is read: never the real services here.
  await page.context().route(/itunes\.apple\.com\/|musicbrainz\.org\/|coverartarchive\.org\/|mzstatic\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"results":[],"releases":[]}' }),
  );
  await noDeezer(page.context());
  await fill(page, { mp3: { '0001.mp3': mp3 }, '01': { '001.mp3': vbr, '002.mp3': mp3, '003.mp3': vbr } }, 'TONUINO');
  await page.getByRole('button', { name: 'SD-Karte auswählen' }).first().click();
  await shown(page).locator('.page-header h1').waitFor();
  await page.goto(`${page.url().split('#')[0]}#/ordner/01`);
  const list = shown(page).locator('.list').first();
  const row = list.locator('.list-row').first();
  await row.getByRole('button', { name: 'Anhören' }).click();
  await row.locator('.seekbar').waitFor();
  // The length from the frames: 15 s, as the list says, not the 22 s the browser guesses.
  await page.waitForFunction(() => /\/ 0:15$/.test(document.querySelector('.page-slot:not(.page-slot-hidden) .seekbar-clock')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => undefined);
  const total = ((await clock(row)) ?? '').split(' / ')[1];
  const listed = (await row.locator('.small.nowrap').last().textContent())?.trim();
  check(total === '0:15', 'the bar shows the length from the frames', `bar ${total}`);
  check(listed === total, 'the list and the bar show the same length', `list ${listed}, bar ${total}`);
  check((await overlaps(list)).length === 0, 'the playing row grows with its bar (folder)', await overlaps(list));
  await shot(page, 'player-01-folder');
  await page.setViewportSize({ width: 390, height: 900 });
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  check((await overlaps(list)).length === 0, 'the playing row grows with its bar (folder, 390 px)', await overlaps(list));
  await shot(page, 'player-01b-folder-390');
  await page.setViewportSize({ width: 1280, height: 900 });

  // A jump into the middle, then back to the very start with the keyboard. Two small steps from the
  // start: a big one (30 s) runs past the end of this 15 s track, and then the next title plays on like a CD.
  const bar = row.getByRole('slider');
  await bar.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(700);
  const mid = (await clock(row)) ?? '';
  check(/^0:(0[5-9]|1\d) /.test(mid), 'a jump forward lands there', mid);
  await page.keyboard.press('Home');
  await page.waitForTimeout(150);
  check(((await clock(row)) ?? '').startsWith('0:00'), 'back to the start shows 0:00', await clock(row));
  check((await bar.getAttribute('aria-valuetext'))?.startsWith('0:00') ?? false, 'the slider is at 0:00', await bar.getAttribute('aria-valuetext'));

  // Quick changes between tracks: never an error.
  const rows = list.locator('.list-row');
  for (let i = 0; i < 12; i++) {
    await rows.nth(i % 3).getByRole('button', { name: /anhören|anhalten/i }).click();
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
  const toasts = await page.locator('.toast.error').allTextContents();
  check(toasts.length === 0, 'changing tracks quickly never fails', toasts);
  check(!toasts.some((t) => /operation|supported/i.test(t)), 'no English error text');
  await rows.first().getByRole('button', { name: /anhalten|anhören/i }).click();

  // Hinzufügen: the row with the bar pushes the next ones down.
  await page.goto(`${page.url().split('#')[0]}#/hinzufuegen`);
  await fill(page, { '01.mp3': vbr, '02.mp3': vbr, '03.mp3': vbr, '04.mp3': vbr }, 'ALBUM');
  await page.getByRole('button', { name: 'Dateien auswählen' }).click();
  await shown(page).getByRole('button', { name: 'Titel anzeigen' }).first().click({ timeout: 60_000 }).catch(() => undefined);
  const tracks = shown(page).locator('.import-tracks').first();
  await tracks.waitFor({ timeout: 60_000 });
  const second = tracks.locator('.list-row').nth(1);
  await second.getByRole('button', { name: 'Anhören' }).click();
  await second.locator('.seekbar').waitFor();
  await page.waitForTimeout(600);
  check((await overlaps(tracks)).length === 0, 'the playing row grows with its bar (Hinzufügen)', await overlaps(tracks));
  const addTotal = ((await clock(second)) ?? '').split(' / ')[1];
  const addListed = (await second.locator('.import-track-duration').textContent())?.trim();
  check(addTotal === addListed, 'Hinzufügen: the list and the bar show the same length', `list ${addListed}, bar ${addTotal}`);
  await shot(page, 'player-02-add');
  for (const width of [390, 700]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    check((await overlaps(tracks)).length === 0, `no overlap at ${width} px`, await overlaps(tracks));
    await shot(page, `player-03-add-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // The downloader's name is gone from the album before it reaches the card.
  const head = (await shown(page).locator('.import-album, .card').first().textContent()) ?? '';
  check(!/SomeDownloader/i.test(head) && head.includes('Igel Sucht Den Mond'), 'Hinzufügen: no downloader name in the album', head.slice(0, 120));
  check((await shown(page).locator('.import-album').getByRole('button', { name: 'Im Internet suchen' }).count()) === 1, 'Hinzufügen offers to look for the missing names');
  await shot(page, 'player-02b-add-lookup');
  await second.getByRole('button', { name: /Anhalten|Anhören/ }).click();
  await shown(page).getByRole('button', { name: 'Auf die SD-Karte übertragen' }).click();
  await page.getByText(/ist auf der Karte|sind auf der Karte|Fertig/).first().waitFor({ timeout: 120_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);

  // Names from iTunes for tracks that have none, and the album's right spelling.
  const songs = ['Igel sucht den Mond', 'Der Mond im Wald', 'Hip-Hop-Hase', 'Gute Nacht, Igel'];
  const asked = [];
  await page.route(/itunes\.apple\.com\//, (route) => {
    const url = route.request().url();
    asked.push(url);
    const body = /\/lookup/.test(url)
      ? { results: [{ wrapperType: 'collection', collectionId: 9, collectionName: 'Igel sucht den Mond', artistName: 'Igel' }, ...songs.map((trackName, i) => ({ wrapperType: 'track', trackName, trackNumber: i + 1, trackTimeMillis: 15000 }))] }
      : { results: [{ wrapperType: 'collection', collectionId: 9, collectionName: 'Igel sucht den Mond', trackCount: 4 }] };
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  await page.route(/musicbrainz\.org\//, (route) => route.fulfill({ status: 503, body: '' }));
  await page.goto(`${page.url().split('#')[0]}#/ordner/02`);
  await shown(page).locator('.folder-info').waitFor();
  const search = shown(page).getByRole('button', { name: 'Im Internet suchen' });
  await search.waitFor({ timeout: 20_000 }).catch(() => undefined);
  check((await search.count()) === 1, 'the folder offers to look for the names', await shown(page).locator('.track-list').textContent());
  check(asked.length === 0, 'nothing goes to the internet before the click');
  if (await search.count()) {
    await search.click();
    await page.getByText(/Titelnamen gefunden/).waitFor({ timeout: 20_000 }).catch(() => undefined);
    const names = await shown(page).locator('.track-list .list-row .ellipsis[title], .track-list .list-row span[style*="font-weight"]').allTextContents();
    check(songs.every((n) => names.includes(n)), 'the tracks have the names from iTunes', names);
    check((await shown(page).getByText('automatisch erkannt').count()) >= 4, 'they are marked "automatisch erkannt"');
    const h = await shown(page).getByLabel('Titel des Ordners').inputValue();
    check(h === 'Igel sucht den Mond', 'the album has the right spelling', h);
    check(!asked.some((u) => /somedownloader/i.test(decodeURIComponent(u))), 'the downloader name never goes to iTunes');
    await shot(page, 'player-04-names');
  }
  noErrors(errors, 'no errors on the page', [/musicbrainz|503/i]);
  await page.context().close();
}
