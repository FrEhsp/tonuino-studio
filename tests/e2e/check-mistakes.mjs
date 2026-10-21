/**
 * "Karte prüfen" after the usual mistakes when unpacking: each one is told
 * in plain words. Then a folder deleted in the app but not on the card, and
 * "Karte so übernehmen, wie sie ist".
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveThePaket } from './package-flow.mjs';
import { addAlbum, check, chooseFiles, chooseFolder, copyDir, failed, folderPage, launch, makeCard, MP3, noErrors, openApp, OUT, same, shot, shown, testZip, unpackOnto } from './lib.mjs';

export async function checkMistakes(browser) {
  console.log('check mistakes');
  const base = join(OUT, 'mistakes');
  rmSync(base, { recursive: true, force: true });
  const card = makeCard(join(base, 'real', 'TONUINO'), {
    mp3: { '0001.mp3': MP3 },
    '01': { '001.mp3': MP3 },
    '02': { '001.mp3': MP3 },
  });
  const album = makeCard(join(base, 'music', 'Pippi'), { '01.mp3': MP3, '02.mp3': MP3, '03.mp3': MP3 });

  const { page, errors } = await openApp(browser);
  await chooseFolder(page, card, page.getByRole('button', { name: 'SD-Karte einlesen' }));
  await shown(page).locator('.page-header h1').waitFor();
  await addAlbum(page, [join(album, '01.mp3'), join(album, '02.mp3'), join(album, '03.mp3')]);
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  const dialog = page.getByRole('dialog');
  const zip = await saveThePaket(page, dialog);
  const zipName = zip.split('/').pop();
  await dialog.getByRole('button', { name: 'Karte prüfen' }).last().click();
  await dialog.getByText('Wähle die SD-Karte noch einmal aus.').waitFor();

  /** A copy of the card as it was read, changed by `make`, shown to the check. */
  let n = 0;
  const variant = (make) => {
    const dir = copyDir(card, join(base, `v${++n}`, 'TONUINO'));
    make(dir);
    return dir;
  };
  const tryCard = async (dir, expected, what) => {
    const again = dialog.getByRole('button', { name: 'Noch einmal prüfen' });
    const button = (await again.count()) ? again : dialog.getByRole('button', { name: 'SD-Karte einlesen' });
    await chooseFolder(page, dir, button);
    try {
      await dialog.getByText(expected).first().waitFor({ timeout: 30_000 });
      check(true, what);
    } catch {
      check(false, what, await dialog.textContent());
    }
  };

  await tryCard(variant(() => undefined), 'Auf der Karte ist noch nichts aus dem Paket.', 'not unpacked: nothing arrived');
  await shot(page, 'mistakes-01-nothing');
  await tryCard(
    variant((d) => {
      const into = join(d, zipName.replace(/\.zip$/, ''));
      mkdirSync(into);
      execFileSync('unzip', ['-o', '-q', zip, '-d', into]);
    }),
    /in einem eigenen Ordner „TonUINO-Paket-/,
    'unpacked into a folder of its own',
  );
  await tryCard(
    variant((d) => {
      unpackOnto(zip, d);
      rmSync(join(d, '03', '002.mp3'));
    }),
    'Es fehlt noch eine Datei: „03/002.mp3“.',
    'a missing title is named',
  );
  await tryCard(
    variant((d) => {
      unpackOnto(zip, d);
      truncateSync(join(d, '03', '003.mp3'), 100);
    }),
    'Die Datei „03/003.mp3“ ist nicht vollständig.',
    'a cut title is named',
  );
  await tryCard(
    variant((d) => {
      mkdirSync(join(d, '03'));
      copyFileSync(MP3, join(d, '03', '004.mp3'));
      unpackOnto(zip, d);
    }),
    'In Ordner 03 lagen schon Dateien, bevor du das Paket entpackt hast (zum Beispiel „004.mp3“).',
    'old files in the new folder are named',
  );
  await tryCard(
    variant((d) => {
      unpackOnto(zip, d);
      copyFileSync(zip, join(d, zipName));
    }),
    `Das Paket selbst liegt auch auf der Karte. Lösche die Datei „${zipName}“ von der Karte.`,
    'the Paket copied onto the card',
  );
  await tryCard(
    variant((d) => {
      unpackOnto(zip, d);
      writeFileSync(join(d, '03', '._001.mp3'), 'Mac');
    }),
    /versteckte Mac-Dateien/,
    'hidden Mac files',
  );
  check((await dialog.locator('.command-line code').filter({ hasText: "dot_clean -m '/Volumes/TONUINO'" }).count()) === 1, 'with the dot_clean command for the card');
  await shot(page, 'mistakes-02-appledouble');
  const sub = variant((d) => unpackOnto(zip, d));
  await tryCard(join(sub, '03'), 'Du hast den Ordner „03“ gewählt.', 'a folder of the card chosen');
  await tryCard(album, 'Das sieht nicht nach der SD-Karte aus.', 'a folder that is no card');

  // Now right.
  unpackOnto(zip, card);
  await tryCard(card, 'Alles ist richtig auf der Karte.', 'unpacked right: all good');
  await dialog.getByRole('button', { name: 'Fertig' }).click();

  // Folder 02 deleted in the app, but left on the card.
  console.log('check mistakes: folder not deleted, take the card as it is');
  await (await folderPage(page, '02')).click();
  await page.getByRole('menuitem', { name: 'Ordner löschen' }).click();
  await page.getByText(/Beim Entpacken löschst du ihn, ich sag dir, wann\./).waitFor();
  await page.getByRole('button', { name: 'Löschen', exact: true }).click();
  await shown(page).locator('.package-banner.pending').waitFor();
  await shown(page).locator('.package-banner').getByRole('button', { name: 'Paket herunterladen' }).click();
  await dialog.getByText(/Weg: Ordner 02/).waitFor();
  const weiter = dialog.getByRole('button', { name: 'Weiter' });
  if (await weiter.count()) {
    await weiter.click();
    await dialog.getByText('Dafür brauchst du kein Paket.', { exact: false }).waitFor();
    check(true, 'only a deletion: no Paket to download');
  } else {
    const delZip = await saveThePaket(page, dialog);
    same(testZip(delZip), ['tonuino-studio.json'], 'the deletion comes with the new catalog in a Paket, and nothing else');
    // The guide asks to delete a folder: first the Paket is checked, then the rest shows.
    check((await dialog.getByRole('button', { name: 'Karte prüfen' }).count()) === 0, 'before the Paket is checked, there is no "Karte prüfen"');
    await chooseFiles(page, [delZip], dialog.getByRole('button', { name: 'Paket prüfen' }));
    await dialog.getByText('Das Paket ist vollständig.').waitFor();
    check(await dialog.getByText(/den Ordner 02/).first().isVisible(), 'then the guide says to delete folder 02');
  }
  await dialog.getByRole('button', { name: 'Karte prüfen' }).last().click();
  await tryCard(card, 'Der Ordner 02 sollte weg sein, ist aber noch auf der Karte. Lösche ihn.', 'folder 02 still on the card');
  await dialog.getByRole('button', { name: 'Karte so übernehmen, wie sie ist' }).click();
  await dialog.getByText('Die Änderungen, die nicht auf der Karte angekommen sind, gehen dann verloren.').waitFor();
  await shot(page, 'mistakes-03-take-as-is');
  await dialog.getByRole('button', { name: 'So übernehmen' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.goto(`${page.url().split('#')[0]}#/`);
  await shown(page).locator('.page-header h1').waitFor();
  check((await shown(page).locator('.package-banner').count()) === 0, 'after taking the card as it is, nothing waits');
  check(await shown(page).getByText('02', { exact: true }).first().isVisible(), 'folder 02 is back in the app, as on the card');

  noErrors(errors);
  await page.context().close();
  return failed();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await launch();
  try {
    await checkMistakes(browser);
  } finally {
    await browser.close();
  }
  process.exit(failed() ? 1 : 0);
}
