/**
 * Werkstatt > Paket auf die Karte bringen, with a Paket someone else made:
 * wrong files are told apart, the guide says to delete the folders first,
 * and the checked card opens in the app.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, chooseFiles, chooseFolder, failed, launch, makeCard, MP3, noErrors, openApp, OUT, paths, same, shot, testZip, unpackOnto } from './lib.mjs';

/** A ZIP as Python's zipfile writes it (stored), entries in the order given. */
function pythonZip(zip, entries) {
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

export async function workshopPackage(browser) {
  console.log('werkstatt: Paket auf die Karte bringen');
  const dir = join(OUT, 'werkstatt');
  mkdirSync(dir, { recursive: true });
  const card = makeCard(join(OUT, 'cards', 'OMA'), {
    mp3: { '0001.mp3': MP3 },
    '01': { '001.mp3': MP3 },
    '05': { '001.mp3': MP3, '002.mp3': MP3, '003.mp3': MP3 },
  });
  const zip = pythonZip(join(dir, 'Hoerspiel-von-Oma.zip'), [
    ['05/', ''],
    ['05/001.mp3', MP3],
    ['05/002.mp3', MP3],
  ]);
  same(testZip(zip), ['05/', '05/001.mp3', '05/002.mp3'], 'the Paket from elsewhere is a valid ZIP');
  const notZip = join(dir, 'Notizen.zip');
  writeFileSync(notZip, 'Das ist keine ZIP-Datei, nur Text.');
  const music = pythonZip(join(dir, 'Urlaubsfotos.zip'), [['bild.mp3', MP3]]);
  const half = join(dir, 'Halb-geladen.zip');
  copyFileSync(zip, half);
  truncateSync(half, Math.floor(readFileSync(zip).length / 2));

  const { page, errors } = await openApp(browser, { hash: '#/werkstatt' });
  await page.getByRole('heading', { name: 'Werkstatt' }).waitFor();
  check(await page.getByText('Per USB nur in Chrome, Edge, Firefox ab 151 oder der Desktop-App').isVisible(), 'overview: USB note names Firefox 151');
  check(await page.getByText('Das geht mit Firefox ab Version 151, Google Chrome oder Microsoft Edge auf einem Computer, oder mit der Desktop-App für Windows und Linux.').isVisible(), 'overview: NoSerial text');
  check((await page.getByText('Braucht Chrome, Edge oder die Desktop-App').filter({ visible: true }).count()) === 0, 'overview: no "Braucht Chrome" note for the announcements');
  await shot(page, 'werkstatt-01-overview');
  await page.getByRole('link', { name: /Systemansagen/ }).click();
  await page.getByRole('button', { name: 'SD-Karte einlesen' }).waitFor();
  check((await page.getByText('Dieser Browser kann keine Ordner von der SD-Karte lesen.').filter({ visible: true }).count()) === 0, 'Systemansagen: the card can be read in');
  await shot(page, 'werkstatt-01b-sounds');
  await page.goto(page.url().replace(/#.*$/, '#/werkstatt'));
  await page.getByRole('link', { name: /Paket auf die Karte bringen/ }).click();
  await page.getByRole('heading', { name: 'Paket auf die Karte bringen' }).waitFor();

  const pick = page.getByRole('button', { name: 'Paket auswählen' });
  await chooseFiles(page, [notZip], pick);
  await page.getByText('Das ist kein TonUINO-Paket.').waitFor();
  check(true, 'a text file is no Paket');
  await chooseFiles(page, [music], pick);
  await page.getByText('Das ist kein TonUINO-Paket.').waitFor();
  check(true, 'a ZIP without card folders is no Paket');
  await chooseFiles(page, [half], pick);
  await page.getByText('Das Paket ist nicht vollständig heruntergeladen. Lade es noch einmal herunter.').waitFor();
  check(true, 'a half downloaded Paket is told');
  await shot(page, 'werkstatt-02-wrong');

  await chooseFiles(page, [zip], pick);
  await page.getByRole('heading', { name: 'So kommt das Paket auf die Karte' }).waitFor();
  await page.getByRole('tab', { name: 'Linux' }).click();
  check(await page.getByText(/lösche den Ordner 05, falls es ihn gibt,/).isVisible(), 'the guide says to delete folder 05 if it is there');
  check((await page.getByRole('button', { name: 'Paket prüfen' }).count()) === 0, 'no Paket check: the file was read already');
  check((await page.getByText(/Warte, bis der Download fertig ist/).filter({ visible: true }).count()) === 0, 'no download to wait for');
  check(await page.getByText(/Es ist vollständig\./).isVisible(), 'the Paket is said to be whole');
  check((await page.getByText(/Prüfen kannst du die Karte später unter Werkstatt/).filter({ visible: true }).count()) === 0, 'no hint to come back here');
  await shot(page, 'werkstatt-03-guide');

  unpackOnto(zip, card, { deleteFirst: ['05'] });
  await page.getByRole('button', { name: 'Karte prüfen' }).last().click();
  await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
  await page.getByText('Alles ist richtig auf der Karte.').waitFor({ timeout: 30_000 });
  await shot(page, 'werkstatt-04-checked');
  check(await page.getByText(/Eingelesen um \d\d:\d\d/).isVisible(), 'the checked card is now open in the app');
  same(paths(card), ['01/001.mp3', '05/001.mp3', '05/002.mp3', 'mp3/0001.mp3'], 'folder 05 has the two titles of the Paket');
  await page.getByRole('button', { name: 'Fertig' }).click();
  await pick.waitFor();

  // A check that fails: no "take it as it is" for a Paket from elsewhere.
  // The card in the app has folder 05 now: the same Paket again would replace it.
  await chooseFiles(page, [zip], pick);
  const replace = page.getByRole('heading', { name: 'Das Paket ersetzt etwas auf deiner Karte' });
  await replace.waitFor();
  check(await page.getByText(/^Ordner 05.*Er wird gelöscht, und das aus dem Paket kommt an seine Stelle\.$/).isVisible(), 'the replace warning names folder 05');
  await shot(page, 'werkstatt-replace');
  await page.getByRole('button', { name: 'Anderes Paket' }).click();
  await pick.waitFor();
  check(true, '"Anderes Paket" goes back to the choice');
  await chooseFiles(page, [zip], pick);
  await replace.waitFor();
  await page.getByRole('button', { name: 'Verstanden, weiter' }).click();
  await page.getByRole('heading', { name: 'So kommt das Paket auf die Karte' }).waitFor();
  check(true, 'after "Verstanden, weiter" the guide comes');
  await page.getByRole('button', { name: 'Karte prüfen' }).last().click();
  rmSync(join(card, '05', '002.mp3'));
  await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
  await page.getByText('Es fehlt noch eine Datei: „05/002.mp3“. Ist die Karte voll? Sonst entpacke das Paket noch einmal.').waitFor({ timeout: 30_000 });
  check((await page.getByText('Karte so übernehmen, wie sie ist').filter({ visible: true }).count()) === 0, 'no "so übernehmen" for a Paket from elsewhere');

  noErrors(errors);
  await page.context().close();

  // Chrome and Edge: nothing to do here.
  const direct = await openApp(browser, { mode: 'direct', hash: '#/werkstatt/paket' });
  await direct.page.getByText('Hier schreibe ich direkt auf die SD-Karte. Ein Paket brauchst du nur in Firefox und Safari.').waitFor();
  check(true, 'direct mode: the tool says no Paket is needed');
  await direct.page.goto(direct.page.url().replace(/#.*$/, '#/werkstatt'));
  await direct.page.getByRole('heading', { name: 'Werkstatt' }).waitFor();
  check((await direct.page.getByRole('link', { name: /Paket auf die Karte bringen/ }).count()) === 0, 'direct mode: no Paket tool card');
  noErrors(direct.errors);
  await direct.context.close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await workshopPackage(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
