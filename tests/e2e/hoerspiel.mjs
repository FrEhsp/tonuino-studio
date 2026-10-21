/**
 * A Hörspiel in one file from a video site on "Hinzufügen" (TODO 0.5 #81):
 * when the shops know no track list for its name, the album card says so
 * and offers a field to search under another name; a search there, or a
 * cover chosen in the online search, finds the album and offers to cut the
 * file at its tracks.
 *
 * The shops are not asked: iTunes and MusicBrainz answer from the fixtures
 * (tests/fixtures/library/*-bibi-tina.json, in the form of their answers).
 * The file is 41:04 of MP3 frames, named like a download from a video site, no tags.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, chooseFiles, chooseFolder, FIXTURES, makeCard, MP3, noErrors, openApp, OUT, shot, shown } from './lib.mjs';

const NAME = 'Bibi & Tina - Das Kürbisfest (Folge 50) | HÖRSPIEL DES MONATS OKTOBER [Xq7Lm2Pz9Rt].mp3';
const LENGTH_SEC = 41 * 60 + 4;
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/**
 * An MP3 of `sec` seconds: the frames of a short MP3 (MPEG-2, 22.05 kHz,
 * 576 samples a frame) over and over, without its tag and Xing frame.
 */
function longMp3(sec, path) {
  const src = readFileSync(join(FIXTURES, 'short.mp3'));
  let at = src[0] === 0x49 && src[1] === 0x44 && src[2] === 0x33 ? 10 + ((src[6] << 21) | (src[7] << 14) | (src[8] << 7) | src[9]) : 0;
  const frames = [];
  while (at + 4 <= src.length && src[at] === 0xff && (src[at + 1] & 0xe0) === 0xe0) {
    // MPEG-2 Layer III: bitrate index in the third byte, 8..160 kbit/s; 72 * bitrate / samplerate bytes.
    const kbps = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][src[at + 2] >> 4];
    const rate = [22050, 24000, 16000][(src[at + 2] >> 2) & 3];
    const size = Math.floor((72 * kbps * 1000) / rate) + ((src[at + 2] >> 1) & 1);
    const frame = src.subarray(at, at + size);
    if (!frame.includes(Buffer.from('Xing')) && !frame.includes(Buffer.from('Info'))) frames.push(frame);
    at += size;
  }
  const need = Math.round((sec * 22050) / 576);
  const out = [];
  for (let i = 0; i < need; i++) out.push(frames[i % frames.length]);
  writeFileSync(path, Buffer.concat(out));
  return path;
}

const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

/**
 * The shops for this page: `itunes(url)` and `musicbrainz(url)` give the
 * JSON for a request (undefined: an empty answer). Cover pictures are a
 * small PNG.
 */
async function shops(page, { itunes = () => undefined, musicbrainz = () => undefined }) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('https://itunes.apple.com/**', (route) => route.fulfill({ headers: CORS, body: itunes(route.request().url()) ?? '{"resultCount":0,"results":[]}' }));
  await page.route('https://musicbrainz.org/**', (route) => route.fulfill({ headers: CORS, body: musicbrainz(route.request().url()) ?? '{"releases":[]}' }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.route(/mzstatic\.com|coverartarchive\.org/, (route) => route.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' }, body: png }));
}

/** A card with one folder, read in; then the file on "Hinzufügen". */
async function review(page, file) {
  const card = join(OUT, 'cards', 'hoerspiel');
  makeCard(card, { mp3: { '0001.mp3': MP3 }, '01': { '001.mp3': MP3 } });
  await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
  await shown(page).locator('.page-header h1').waitFor();
  await page.goto(`${page.url().split('#')[0]}#/hinzufuegen`);
  await chooseFiles(page, [file], page.getByRole('button', { name: 'Dateien auswählen' }));
  await shown(page).locator('.import-album').first().waitFor({ timeout: 60_000 });
}

export async function hoerspiel(browser) {
  console.log('Hörspiel in einer Datei (TODO 0.5 #81)');
  mkdirSync(OUT, { recursive: true });
  const file = longMp3(LENGTH_SEC, join(OUT, NAME));

  // 1. The shops know nothing by that name: a line and a search field.
  {
    const { context, page, errors } = await openApp(browser, { width: 1280, height: 900 });
    await shops(page, {});
    await review(page, file);
    const page_ = shown(page);
    const note = page_.getByText(/Keine Titelliste gefunden, die zusammen so lang ist wie die Datei \(41 Min\. 4 Sek\.\)/);
    await note.waitFor({ timeout: 30_000 });
    check(await note.isVisible(), 'nothing found: the card says so');
    const field = page_.getByRole('textbox', { name: 'Name des Albums' });
    check(await field.isVisible(), 'nothing found: a search field');
    check((await field.inputValue()) === 'Bibi & Tina – Das Kürbisfest (Folge 50)', 'the field holds what was looked for, without the video site\'s leftovers', await field.inputValue());
    const title = page_.getByRole('textbox', { name: 'Titel des Albums' });
    check((await title.inputValue()) === 'Bibi & Tina - Das Kürbisfest (Folge 50)', 'the album is named without the video site\'s leftovers', await title.inputValue());
    check((await page_.getByText(/jedes Wort großgeschrieben/).count()) === 0, 'no word about capital letters for a name in capitals from a video site');
    await shot(page, 'hoerspiel-nichts-gefunden');

    // 2. Searched under another name, and this time the shop knows it.
    await shops(page, {
      itunes: (url) => (url.includes('/search') ? fixture('itunes-search-bibi-tina.json') : url.includes('/lookup') ? fixture('itunes-lookup-bibi-tina.json') : undefined),
    });
    await field.fill('Bibi und Tina Folge 50');
    await field.press('Enter');
    const found = page_.getByText(/Das sieht nach „Folge 50: Das Kürbisfest“ von Bibi und Tina in einer Datei aus/);
    await found.waitFor({ timeout: 30_000 });
    check(await found.isVisible(), 'the search field finds the album');
    check(await page_.getByRole('button', { name: 'An den Titeln teilen' }).isVisible(), 'and offers to cut at its tracks');
    check(await page_.getByText(/fast genau so lang sind \(24 Sek\. Unterschied\)/).isVisible(), 'says the file is 24 s longer');
    await shot(page, 'hoerspiel-gefunden');

    // Cut at the tracks: the album takes the shop's name, artist and kind (here set to "Hörbuch" before).
    await page_.getByRole('combobox', { name: 'Art', exact: true }).selectOption('hoerbuch');
    await page_.getByRole('button', { name: 'An den Titeln teilen' }).click();
    const apply = page.getByRole('button', { name: 'So teilen' });
    await apply.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('So teilen') && !b.disabled), undefined, { timeout: 180_000 });
    check((await page.locator('.dialog .track-title textarea').count()) === 8, 'the dialog lists the 8 tracks of the shop');
    await shot(page, 'hoerspiel-schnitte');
    await apply.click();
    await apply.waitFor({ state: 'detached' });
    check((await title.inputValue()) === 'Folge 50: Das Kürbisfest', 'the album takes the shop\'s name', await title.inputValue());
    const artist = page_.getByRole('textbox', { name: 'Interpret oder Autor' });
    check((await artist.inputValue()) === 'Bibi und Tina', 'and its artist', await artist.inputValue());
    check((await page_.getByRole('combobox', { name: 'Art', exact: true }).inputValue()) === 'hoerspiel', 'and its kind: Hörspiel');
    await shot(page, 'hoerspiel-geteilt');
    noErrors(errors, 'no errors (search field)');
    await context.close();
  }

  // 3. Nothing by name, but the cover chosen in the online search names the album: its track list comes with it.
  {
    const { context, page, errors } = await openApp(browser, { width: 1280, height: 900 });
    // The search for track lists (25 hits) finds nothing; the cover search (12 hits) finds the album.
    await shops(page, {
      itunes: (url) => (url.includes('/search') && url.includes('limit=12') ? fixture('itunes-search-bibi-tina.json') : url.includes('/lookup?id=1440000050&') ? fixture('itunes-lookup-bibi-tina.json') : undefined),
    });
    await review(page, file);
    const page_ = shown(page);
    await page_.getByText(/Keine Titelliste gefunden/).waitFor({ timeout: 30_000 });
    await page_.getByRole('button', { name: 'Cover suchen' }).click();
    const tile = page.locator('.cover-result', { hasText: 'Folge 50: Das Kürbisfest' }).first();
    await tile.waitFor({ timeout: 30_000 });
    await tile.click();
    const found = page_.getByText(/Das sieht nach „Folge 50: Das Kürbisfest“ von Bibi und Tina in einer Datei aus/);
    await found.waitFor({ timeout: 30_000 });
    check(await found.isVisible(), 'the chosen cover brings the track list');
    await shot(page, 'hoerspiel-cover');
    noErrors(errors, 'no errors (cover)');
    await context.close();
  }

  // 4. On a phone: the line and the field fit the screen.
  {
    const { context, page, errors } = await openApp(browser, { width: 390, height: 844 });
    await shops(page, {});
    await review(page, file);
    const field = shown(page).getByRole('textbox', { name: 'Name des Albums' });
    await field.waitFor({ timeout: 30_000 });
    await field.scrollIntoViewIfNeeded();
    const box = await field.boundingBox();
    const button = await shown(page).locator('.album-search-form button').boundingBox();
    check(!!box && !!button && box.x >= 0 && button.x + button.width <= 390 && box.width > 150, 'phone: field and button fit the screen', { box, button });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'phone: no sideways scrolling');
    await shot(page, 'hoerspiel-handy');
    noErrors(errors, 'no errors (phone)');
    await context.close();
  }
}
