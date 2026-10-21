/**
 * What came in next to the Paket mode, in the Paket mode (Firefox,
 * Safari): repairs that move files of the helper folder back, new system
 * announcements, and "Box einstellen", which must not touch the card. Also:
 * a Paket from elsewhere while own changes wait, a remembered Paket and a
 * card without a catalog, and the keyboard in the Paket dialog.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { saveThePaket } from './package-flow.mjs';
import { addAlbum, check, chooseFiles, chooseFolder, failed, launch, makeCard, MP3, noErrors, openApp, OUT, paths, same, shot, shown, testZip, unpackOnto, visitAgain } from './lib.mjs';

/** A ZIP as Python's zipfile writes it (stored), entries in the order given. */
export function pythonZip(zip, entries) {
  rmSync(zip, { force: true });
  const script = [
    'import sys, zipfile, json',
    'entries = json.loads(sys.argv[2])',
    'with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_STORED) as z:',
    '    for name, src in entries:',
    '        if name.endswith("/"): z.writestr(name, b"")',
    '        else: z.write(src, name)',
  ].join('\n');
  execFileSync('python3', ['-c', script, zip, JSON.stringify(entries)]);
  return zip;
}

const KEY = 'tonuino-studio:waiting-package';

export async function mergedFeatures(browser) {
  const base = join(OUT, 'merged');
  mkdirSync(base, { recursive: true });
  const opened = await openApp(browser);
  const errors = opened.errors;
  // Every later visit is a new tab (visitAgain): what follows always means the current one.
  let page = opened.page;
  const answerDialogs = (p) => p.on('dialog', (d) => d.accept().catch(() => undefined));
  answerDialogs(page);
  const dialog = () => page.getByRole('dialog');
  const go = (hash) => page.goto(`${page.url().split('#')[0]}${hash}`);
  const readCard = async (dir) => {
    await go('#/');
    await chooseFolder(page, dir, page.getByRole('button', { name: /SD-Karte einlesen|Neu einlesen/ }).first());
    await page.locator('.sidebar').getByText(/Eingelesen um/).waitFor();
  };
  /** Hinzufügen once more: coming back after an add that went well, the page starts afresh. */
  const addAnother = (files) => addAlbum(page, files);
  /** The guide asks to show it the Paket first when something gets deleted on the card. */
  const showPaket = async (zip) => {
    const verify = dialog().getByRole('button', { name: 'Paket prüfen' });
    if (!(await verify.count())) return;
    await chooseFiles(page, [zip], verify);
    await dialog().getByText('Das Paket ist vollständig.').waitFor();
  };
  const checkCardIn = async (dir) => {
    await dialog().getByRole('button', { name: 'Karte prüfen' }).last().click();
    await chooseFolder(page, dir, dialog().getByRole('button', { name: 'SD-Karte einlesen' }));
    await dialog().getByText('Alles ist richtig auf der Karte.').waitFor({ timeout: 30_000 });
    await dialog().getByRole('button', { name: 'Fertig' }).click();
  };

  /* ---------------------------------------------------------------- helper folder */
  console.log('merged: files back from the helper folder, through a Paket');
  const helperCard = makeCard(join(base, 'HELFER'), {
    mp3: { '0001.mp3': MP3 },
    '01': { '001.mp3': MP3 },
    // A repair stopped half way on another computer: track 2 of folder 01 waits in the helper folder.
    '_tonuino-studio-temp-01': { '002.mp3': MP3 },
  });
  await readCard(helperCard);
  await page.getByRole('button', { name: 'Ansehen und reparieren' }).click();
  const issue = dialog().locator('.issue', { has: page.getByText('Eine Reparatur wurde unterbrochen') });
  await issue.waitFor();
  await issue.getByRole('button', { name: 'Dateien zurücklegen' }).click();
  await dialog().getByRole('button', { name: 'Reparatur planen' }).click();
  await page.getByText('Kommt ins Paket für die Karte.').waitFor();
  check(true, 'helper folder: the repair is planned for the Paket');
  await page.keyboard.press('Escape');
  check((await shown(page).locator('.package-banner.pending').count()) === 1, 'helper folder: the change waits for the Paket');
  check(paths(helperCard).includes('_tonuino-studio-temp-01/002.mp3'), 'helper folder: the card itself is not touched');
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  await dialog().getByText('Das kommt auf die Karte:').waitFor();
  const helperLines = await dialog().locator('.package-lines li').allTextContents();
  check(helperLines.some((l) => /Hilfsordner der App/.test(l)), 'helper folder: the dialog names the helper folder', helperLines);
  const helperZip = await saveThePaket(page, dialog());
  const helperEntries = testZip(helperZip);
  check(['01/001.mp3', '01/002.mp3'].every((e) => helperEntries.includes(e)), 'helper folder: the Paket brings folder 01 with both titles', helperEntries);
  check(!helperEntries.some((e) => e.startsWith('_tonuino-studio-temp')), 'helper folder: the Paket brings no helper folder', helperEntries);
  await dialog().getByRole('tab', { name: 'Linux' }).click();
  await chooseFiles(page, [helperZip], dialog().getByRole('button', { name: 'Paket prüfen' }));
  await dialog().getByText('Das Paket ist vollständig.').waitFor();
  const guide = (await dialog().locator('ol.guide-steps').textContent()) ?? '';
  check(/_tonuino-studio-temp-01/.test(guide), 'helper folder: the guide says to delete the helper folder', guide.slice(0, 400));
  unpackOnto(helperZip, helperCard, { deleteFirst: ['01', '_tonuino-studio-temp-01'] });
  await checkCardIn(helperCard);
  same(
    paths(helperCard).filter((p) => !p.startsWith('tonuino-studio')),
    ['01/001.mp3', '01/002.mp3', 'mp3/0001.mp3'],
    'helper folder: on the card the title is back in folder 01, the helper folder is gone',
  );

  /* ---------------------------------------------------------------- Box einstellen */
  console.log('merged: Box einstellen leaves the card alone');
  await go('#/werkstatt/einstellen');
  await page.getByRole('heading', { name: 'Box einstellen' }).waitFor();
  await page.getByRole('checkbox', { name: /^Lautstärke/ }).check();
  await page.getByText('Fürs Kinderzimmer', { exact: true }).click();
  await page.getByRole('button', { name: 'Erledigt: Die Box ist eingestellt' }).click();
  await page.getByText(/^Erledigt\. Oben stehen jetzt die neuen Werte/).waitFor();
  check((await page.locator('.sidebar').getByText(/Änderung(en)? wartet|Änderungen warten/).count()) === 0, 'Box einstellen: nothing waits for the card');
  await go('#/');
  await shown(page).locator('.page-header h1').waitFor();
  check((await shown(page).locator('.package-banner').count()) === 0, 'Box einstellen: no Paket banner on the shelf');

  /* ---------------------------------------------------------------- system sounds */
  console.log('merged: own announcements go into the Paket');
  const sounds = pythonZip(join(base, 'Meine-Ansagen.zip'), [
    ['mp3/', ''],
    ['mp3/0001.mp3', MP3],
    ['mp3/0002.mp3', MP3],
    ['advert/', ''],
    ['advert/0001.mp3', MP3],
  ]);
  await go('#/werkstatt/ansagen');
  await page.getByRole('heading', { name: 'Systemansagen', exact: true }).waitFor();
  await page.locator('#ws-sounds-title').waitFor();
  await page.locator('.ws-page').getByRole('button').filter({ has: page.locator('svg') }).filter({ hasText: /Ansagen|installieren|erneuern/ }).first().click();
  await dialog().getByText('Systemansagen installieren').first().waitFor();
  check(await dialog().getByText(/lege sie ins Paket für die Karte/).isVisible(), 'sounds: the dialog says they go into the Paket');
  check(await dialog().getByText('Die neuen Ansagen kommen ins Paket.', { exact: false }).isVisible(), 'sounds: the dialog warns that mp3 and advert get replaced');
  await chooseFiles(page, [sounds], dialog().getByRole('button', { name: 'ZIP-Datei auswählen …' }));
  await page.getByText('Die Ansagen sind im Paket.').waitFor({ timeout: 30_000 });
  await page.getByRole('heading', { name: 'Im Paket, noch nicht auf der Karte' }).waitFor();
  check(true, 'sounds: the tool says they wait in the Paket');
  check(!paths(helperCard).includes('mp3/0002.mp3'), 'sounds: the card itself is not touched');
  await go('#/');
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  await dialog().getByText('Das kommt auf die Karte:').waitFor();
  const soundZip = await saveThePaket(page, dialog());
  const soundEntries = testZip(soundZip);
  same(soundEntries.slice(0, 6), ['mp3/', 'mp3/0001.mp3', 'mp3/0002.mp3', 'advert/', 'advert/0001.mp3', 'tonuino-studio.json'], 'sounds: mp3 and advert come first in the Paket');
  await showPaket(soundZip);
  unpackOnto(soundZip, helperCard, { deleteFirst: ['mp3'] });
  await checkCardIn(helperCard);
  check(['advert/0001.mp3', 'mp3/0001.mp3', 'mp3/0002.mp3'].every((p) => paths(helperCard).includes(p)), 'sounds: the announcements are on the card');

  /* ---------------------------------------------------------------- keyboard */
  console.log('merged: the Paket dialog with the keyboard');
  const keysAlbum = makeCard(join(base, 'music', 'Tasten'), { '01.mp3': MP3 });
  await addAnother([join(keysAlbum, '01.mp3')]);
  await go('#/');
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  const radios = dialog().getByRole('radio');
  await radios.first().waitFor();
  same(await radios.evaluateAll((els) => els.map((e) => e.getAttribute('tabindex'))), ['0', '-1'], 'keys: only the chosen mode is in the tab order');
  await radios.first().focus();
  await page.keyboard.press('ArrowDown');
  same(await radios.evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked'))), ['false', 'true'], 'keys: ArrowDown chooses the whole card');
  check(await radios.nth(1).evaluate((e) => e === document.activeElement), 'keys: the focus moves along');
  await page.keyboard.press('ArrowUp');
  same(await radios.evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked'))), ['true', 'false'], 'keys: ArrowUp goes back to the changes');
  const keysZip = await saveThePaket(page, dialog());
  testZip(keysZip);
  const tabs = dialog().getByRole('tab');
  await tabs.first().waitFor();
  await dialog().getByRole('tab', { name: 'Windows' }).click();
  await dialog().getByRole('tab', { name: 'Windows' }).focus();
  await page.keyboard.press('ArrowRight');
  check((await dialog().getByRole('tab', { name: 'Mac' }).getAttribute('aria-selected')) === 'true', 'keys: ArrowRight goes to the next system');
  check(await dialog().getByRole('tab', { name: 'Mac' }).evaluate((e) => e === document.activeElement), 'keys: the focus is on the chosen tab');
  await page.keyboard.press('End');
  check((await dialog().getByRole('tab', { name: 'Chromebook' }).getAttribute('aria-selected')) === 'true', 'keys: End goes to the last system');
  await page.keyboard.press('ArrowRight');
  check((await dialog().getByRole('tab', { name: 'Windows' }).getAttribute('aria-selected')) === 'true', 'keys: and wraps around to the first');
  const controls = await dialog().getByRole('tab', { name: 'Windows' }).getAttribute('aria-controls');
  const panel = dialog().locator('[role="tabpanel"]');
  check(!!controls && (await panel.getAttribute('id')) === controls, 'keys: the tab points to its panel');
  check((await panel.getAttribute('aria-labelledby')) === (await dialog().getByRole('tab', { name: 'Windows' }).getAttribute('id')), 'keys: the panel names its tab');
  await shot(page, 'merged-01-keys');
  await showPaket(keysZip);
  unpackOnto(keysZip, helperCard);
  await checkCardIn(helperCard);

  /* ---------------------------------------------------------------- Paket from elsewhere */
  console.log('merged: a Paket from elsewhere while own changes wait');
  const otherZip = pythonZip(join(base, 'Von-Oma.zip'), [
    ['07/', ''],
    ['07/001.mp3', MP3],
  ]);
  const ownAlbum = makeCard(join(base, 'music', 'Eigenes'), { '01.mp3': MP3 });
  await addAnother([join(ownAlbum, '01.mp3')]);
  await go('#/werkstatt/paket');
  await chooseFiles(page, [otherZip], page.getByRole('button', { name: 'Paket auswählen' }));
  await page.getByRole('heading', { name: 'So kommt das Paket auf die Karte' }).waitFor();
  unpackOnto(otherZip, helperCard, { deleteFirst: ['07'] });
  await page.getByRole('button', { name: 'Karte prüfen' }).last().click();
  await chooseFolder(page, helperCard, page.getByRole('button', { name: 'SD-Karte einlesen' }));
  await page.getByText('Alles ist richtig auf der Karte.').waitFor({ timeout: 30_000 });
  const notice = shown(page).locator('.changed-elsewhere');
  await notice.waitFor();
  check(/Auf der Karte ist jetzt das Paket „Von-Oma\.zip“\./.test((await notice.textContent()) ?? ''), 'elsewhere: the app names the other Paket');
  check(/für die Karte von vorher geplant/.test((await notice.textContent()) ?? ''), 'elsewhere: and says the own change was planned for the card as it was');
  await shot(page, 'merged-02-elsewhere');
  await go('#/');
  await shown(page).locator('.changed-elsewhere').waitFor();
  check((await page.getByRole('button', { name: 'Paket herunterladen' }).count()) === 0, 'elsewhere: no Paket from the old reading on the shelf');
  check(await page.locator('.sidebar').getByText('Karte hat sich geändert').isVisible(), 'elsewhere: the sidebar says so');
  // On a phone and in the dark the notice stays readable and its buttons fit.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shown(page).locator('.changed-elsewhere').scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, 'elsewhere: no sideways scrolling at 390 px', overflow);
  await shot(page, 'merged-03-elsewhere-390-dark');
  await page.setViewportSize({ width: 1280, height: 900 });
  await shown(page).locator('.changed-elsewhere').scrollIntoViewIfNeeded();
  await shot(page, 'merged-04-elsewhere-1280-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, 'merged-05-elsewhere-1280-light');
  // While own changes wait, the shelf has no "Paket" button of its own (the banner leads there); the sidebar has one.
  await page.locator('.sidebar').getByRole('button', { name: 'Paket' }).click();
  await page.getByRole('dialog', { name: 'Erst die Karte neu übernehmen' }).waitFor();
  check(true, 'elsewhere: the Paket dialog asks to take the card first');
  await page.getByRole('dialog').getByRole('button', { name: 'Neuen Stand übernehmen' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await shown(page).locator('.changed-elsewhere').waitFor({ state: 'detached' });
  check((await shown(page).locator('.package-banner').count()) === 0, 'elsewhere: after taking the card nothing waits');
  check(await shown(page).locator('.tile', { hasText: '07' }).first().isVisible(), 'elsewhere: folder 07 from the other Paket is on the shelf');

  /* ---------------------------------------------------------------- card without a catalog */
  console.log('merged: a remembered Paket and cards without a catalog');
  const bare = makeCard(join(base, 'OHNE'), { mp3: { '0001.mp3': MP3 }, '01': { '001.mp3': MP3 } });
  const otherBare = makeCard(join(base, 'ANDERE'), { '01': { '001.mp3': MP3, '002.mp3': MP3 }, '04': { '001.mp3': MP3 } });
  page = await visitAgain(page, errors, answerDialogs);
  await readCard(bare);
  await addAnother([join(ownAlbum, '01.mp3')]);
  await go('#/');
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  testZip(await saveThePaket(page, dialog()));
  await dialog().getByRole('button', { name: 'Später' }).click();
  await dialog().waitFor({ state: 'detached' });
  check(await page.evaluate((k) => localStorage.getItem(k) !== null, KEY), 'no catalog: the Paket is remembered');
  page = await visitAgain(page, errors, answerDialogs);
  await readCard(otherBare);
  check((await shown(page).locator('.package-banner.downloaded').count()) === 0, 'no catalog: another card without a catalog is not locked');
  check((await page.getByText(/wartet aufs Entpacken/).filter({ visible: true }).count()) === 0, 'no catalog: no "wartet aufs Entpacken" on the other card');
  page = await visitAgain(page, errors, answerDialogs);
  await readCard(bare);
  await shown(page).locator('.package-banner.downloaded').waitFor();
  check(true, 'no catalog: its own card still waits for the Paket');

  noErrors(errors);
  await page.context().close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await mergedFeatures(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
