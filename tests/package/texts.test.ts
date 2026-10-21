import { describe, expect, it } from 'vitest';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { CATALOG_FILE } from '../../src/core/tonuino/sd';
import type { CheckFinding } from '../../src/core/tonuino/verify';
import { diffForPackage } from '../../src/core/tonuino/writeplan';
import {
  changedElsewhereText,
  changeLines,
  crcMismatchText,
  decodeFailedText,
  findingText,
  firstLines,
  packageCheckText,
  problemText,
  atText,
  fromText,
  rereadText,
  timeOfDay,
  waitingText,
} from '../../src/features/box/packageTexts';
import { blobTree } from '../platform/blobfixtures';

describe('what waits for the card', () => {
  const base = blobTree({ mp3: { '0001.mp3': 'a' }, advert: { '0001.mp3': 'b' }, '05': { '001.mp3': 'x' }, '09': { '001.mp3': 'y' }, Musik: { 'a.mp3': 'm' } }, 'TONUINO');
  const current = blobTree(
    {
      mp3: { '0001.mp3': 'neu' },
      advert: { '0001.mp3': 'neu' },
      '05': { '001.mp3': 'x', '002.mp3': 'z' },
      '07': { '001.mp3': 'o' },
      [CATALOG_FILE]: '{}',
      _tonuino_unused: {},
    },
    'TONUINO',
  );
  // The folder that is not in the base and has nothing in it does not count: drop it for a clean comparison.
  current.children = current.children.filter((c) => c.name !== '_tonuino_unused');
  const plan = diffForPackage(base, current);
  const catalog = newCatalog('Box');
  catalog.folders['05'] = { title: 'Benjamin Blümchen', tracks: [], addedAt: 1, updatedAt: 1 };
  catalog.folders['07'] = { title: 'Die Olchis', tracks: [], addedAt: 1, updatedAt: 1 };

  it('names folders, titles, the system sounds and the app files', () => {
    expect(changeLines(plan, catalog, true)).toEqual([
      'Systemansagen (mp3 und advert)',
      'Ersetzt: Ordner 05 · Benjamin Blümchen',
      'Neu: Ordner 07 · Die Olchis',
      'Weg: Ordner 09',
      'Weg: „Musik“',
      'Namen, Bilder und Sticker der App',
    ]);
    expect(changeLines(plan, catalog, false)).toEqual(['Systemansagen', 'Ersetzt: Ordner 05', 'Neu: Ordner 07', 'Weg: Ordner 09', 'Weg: „Musik“', 'Namen, Bilder und Sticker']);
  });

  it('shows a few lines and counts the rest', () => {
    const lines = changeLines(plan, catalog, true);
    expect(firstLines(lines, 8, true)).toEqual(lines);
    expect(firstLines(lines, 3, true)).toEqual([...lines.slice(0, 3), 'und 3 mehr']);
    expect(firstLines(lines, 3, false)).toEqual([...lines.slice(0, 3), 'und mehr']);
  });

  it('says the name of a folder without a title only once', () => {
    const unnamed = newCatalog('Box');
    unnamed.folders['05'] = { title: 'Ordner 05', tracks: [], addedAt: 1, updatedAt: 1 };
    unnamed.folders['07'] = { title: 'Die Olchis', tracks: [], addedAt: 1, updatedAt: 1 };
    expect(changeLines(plan, unnamed, true).slice(1, 3)).toEqual(['Ersetzt: Ordner 05', 'Neu: Ordner 07 · Die Olchis']);
  });

  it('calls the repair helper folder by what it is', () => {
    const withTemp = blobTree({ '05': { '001.mp3': 'x' }, '_tonuino-studio-temp-05': { '002.mp3': 'y' } }, 'T');
    const recovered = blobTree({ '05': { '001.mp3': 'x', '002.mp3': 'y' } }, 'T');
    expect(changeLines(diffForPackage(withTemp, recovered), null, true)).toEqual(['Ersetzt: Ordner 05', 'Weg: Hilfsordner der App']);
  });

  it('says when a Paket was downloaded, with the day when it was not today', () => {
    const at = new Date(2026, 9, 5, 14, 32).getTime();
    expect(atText(at, new Date(2026, 9, 5, 20, 0).getTime())).toBe('um 14:32');
    expect(atText(at, new Date(2026, 9, 6, 9, 0).getTime())).toBe('am 5.10. um 14:32');
    expect(fromText(at, new Date(2026, 9, 5, 20, 0).getTime())).toBe('von 14:32');
    expect(fromText(at, new Date(2026, 9, 6, 9, 0).getTime())).toBe('vom 5.10.');
  });

  it('counts in words', () => {
    expect(waitingText(1)).toBe('1 Änderung wartet auf die Karte');
    expect(waitingText(3)).toBe('3 Änderungen warten auf die Karte');
    expect(waitingText(3, true)).toBe('3 Änderungen warten');
    expect(waitingText(1, true)).toBe('1 Änderung wartet');
  });

  it('asks before the card is read again', () => {
    expect(rereadText(3)).toBe('3 Änderungen sind noch nicht auf der Karte. Beim neuen Einlesen gehen sie verloren.');
    expect(rereadText(1)).toBe('1 Änderung ist noch nicht auf der Karte. Beim neuen Einlesen geht sie verloren.');
  });

  it('tells the time of day', () => {
    expect(timeOfDay(new Date(2026, 9, 6, 14, 32).getTime())).toBe('14:32');
    expect(timeOfDay(new Date(2026, 9, 6, 9, 5).getTime())).toBe('09:05');
  });
});

describe('a reading of the card that did not work', () => {
  it('says what to do', () => {
    expect(problemText({ kind: 'not-a-folder' }, 'chooser')).toBe('Das war keine Ordnerauswahl. Wähle die SD-Karte selbst aus, nicht eine Datei darauf.');
    expect(problemText({ kind: 'not-a-folder' }, 'drop')).toBe('Ziehe die ganze SD-Karte hierher, nicht einzelne Dateien.');
    expect(problemText({ kind: 'several-items' }, 'drop')).toBe('Ziehe nur die SD-Karte hierher, nicht mehrere Dinge auf einmal.');
    expect(problemText({ kind: 'read-failed', path: '05/003.mp3', message: 'x' }, 'drop')).toBe(
      'Die Karte ließ sich nicht ganz lesen (bei „05/003.mp3“). Lies sie noch einmal ein. Klappt es wieder nicht, ist die Karte vielleicht beschädigt.',
    );
    expect(problemText({ kind: 'read-failed', path: '', message: 'x' }, 'chooser')).toBe(
      'Die Karte ließ sich nicht ganz lesen. Lies sie noch einmal ein. Klappt es wieder nicht, ist die Karte vielleicht beschädigt.',
    );
  });
});

describe('what the check found', () => {
  const text = (f: CheckFinding) => findingText(f, 'NO NAME').text;

  it('has a sentence with a way out for each finding', () => {
    expect(text({ kind: 'picked-subfolder', name: '05' })).toBe('Du hast den Ordner „05“ gewählt. Wähle die ganze SD-Karte aus, also den Ordner darüber.');
    expect(text({ kind: 'nested', folder: 'TonUINO-Paket-0610-1432-7KQ' })).toBe(
      'Die Dateien sind in einem eigenen Ordner „TonUINO-Paket-0610-1432-7KQ“ gelandet statt direkt auf der Karte. Lösche diesen Ordner auf der Karte und entpacke das Paket noch einmal. Wähle dabei die Karte selbst als Ziel.',
    );
    expect(text({ kind: 'not-a-card' })).toBe('Das sieht nicht nach der SD-Karte aus. Wähle das Laufwerk der Karte aus (zum Beispiel „TONUINO“).');
    expect(text({ kind: 'nothing-arrived' })).toBe(
      'Auf der Karte ist noch nichts aus dem Paket. Hast du in einen anderen Ordner entpackt? Entpacke noch einmal und wähle dabei die Karte als Ziel.',
    );
    expect(text({ kind: 'missing', paths: ['05/011.mp3', ...Array.from({ length: 11 }, (_, i) => `05/0${20 + i}.mp3`)] })).toBe(
      'Es fehlen noch 12 Dateien, zum Beispiel „05/011.mp3“. Ist die Karte voll? Sonst entpacke das Paket noch einmal.',
    );
    expect(text({ kind: 'missing', paths: ['05/011.mp3'] })).toBe('Es fehlt noch eine Datei: „05/011.mp3“. Ist die Karte voll? Sonst entpacke das Paket noch einmal.');
    expect(text({ kind: 'incomplete', paths: ['05/002.mp3', '05/003.mp3', '05/004.mp3'] })).toBe(
      '3 Dateien sind nicht vollständig, zum Beispiel „05/002.mp3“. Entpacke das Paket noch einmal und ersetze dabei alle Dateien.',
    );
    expect(text({ kind: 'incomplete', paths: ['05/002.mp3'] })).toBe('Die Datei „05/002.mp3“ ist nicht vollständig. Entpacke das Paket noch einmal und ersetze dabei alle Dateien.');
    expect(text({ kind: 'leftovers', folder: '05', paths: ['016.mp3'], added: false })).toBe(
      'In Ordner 05 liegen noch alte Dateien (zum Beispiel „016.mp3“). Lösche den Ordner 05 auf der Karte und entpacke das Paket noch einmal.',
    );
    // A folder that was new in the Paket: what else is in it was there before, so nothing is to be deleted blindly.
    expect(text({ kind: 'leftovers', folder: '03', paths: ['004.mp3'], added: true })).toBe(
      'In Ordner 03 lagen schon Dateien, bevor du das Paket entpackt hast (zum Beispiel „004.mp3“). Vielleicht von einem anderen Paket. Lösche sie nicht einfach: Übernimm die Karte so, wie sie ist, und sieh dir Ordner 03 in der App an.',
    );
    expect(text({ kind: 'outdated', paths: ['tonuino-studio.json'] })).toBe(
      'Die Datei „tonuino-studio.json“ auf der Karte ist nicht die aus dem Paket. Entpacke das Paket noch einmal und ersetze dabei alle Dateien.',
    );
    expect(text({ kind: 'outdated', paths: ['tonuino-studio.json', 'tonuino-studio-covers.zip'] })).toBe(
      '2 Dateien auf der Karte sind nicht die aus dem Paket, zum Beispiel „tonuino-studio.json“. Entpacke das Paket noch einmal und ersetze dabei alle Dateien.',
    );
    expect(text({ kind: 'not-deleted', names: ['09'] })).toBe('Der Ordner 09 sollte weg sein, ist aber noch auf der Karte. Lösche ihn.');
    expect(text({ kind: 'not-deleted', names: ['09', '11'] })).toBe('Die Ordner 09 und 11 sollten weg sein, sind aber noch auf der Karte. Lösche sie.');
    expect(text({ kind: 'not-deleted', names: ['Musik'] })).toBe('„Musik“ sollte weg sein, ist aber noch auf der Karte. Lösche es.');
    expect(findingText({ kind: 'appledouble', count: 4 }, 'NO NAME')).toEqual({
      text: 'Auf der Karte liegen versteckte Mac-Dateien („._“). Sie bringen die Box durcheinander. Tippe im Terminal:',
      command: "dot_clean -m '/Volumes/NO NAME'",
    });
    expect(text({ kind: 'package-on-card', name: 'TonUINO-Paket-0610-1432-7KQ.zip' })).toBe(
      'Das Paket selbst liegt auch auf der Karte. Lösche die Datei „TonUINO-Paket-0610-1432-7KQ.zip“ von der Karte.',
    );
    expect(findingText({ kind: 'not-formatted', names: ['Musik'] }, 'X')).toEqual({
      text: 'Auf der Karte liegen noch Dinge, die nicht im Paket sind: „Musik“. Wurde die Karte vorher formatiert?',
      warning: true,
    });
  });

  it('names files that differ or do not play', () => {
    expect(crcMismatchText(['05/003.mp3', '05/004.mp3'])).toBe(
      '2 Dateien sind auf der Karte anders als im Paket, zum Beispiel „05/003.mp3“. Die Karte könnte kaputt sein. Entpacke noch einmal, und nimm eine andere Karte, wenn es wieder passiert.',
    );
    expect(crcMismatchText(['05/003.mp3'])).toMatch(/^Die Datei „05\/003.mp3“ ist auf der Karte anders als im Paket\./);
    expect(decodeFailedText(['05/003.mp3'])).toBe('„05/003.mp3“ lässt sich nicht abspielen. Entpacke das Paket noch einmal.');
    expect(decodeFailedText(['05/003.mp3', '05/004.mp3'])).toBe('2 Titel lassen sich nicht abspielen, zum Beispiel „05/003.mp3“. Entpacke das Paket noch einmal.');
  });

  it('answers "Paket prüfen"', () => {
    const name = 'TonUINO-Paket-0610-1432-7KQ.zip';
    expect(packageCheckText({ ok: true }, name)).toBe('Das Paket ist vollständig.');
    expect(packageCheckText({ ok: false, reason: 'not-finished' }, name)).toBe(
      'Das Paket ist noch nicht fertig heruntergeladen. Warte noch etwas und versuche es dann noch einmal.',
    );
    expect(packageCheckText({ ok: false, reason: 'other-package' }, name)).toBe(`Das ist ein anderes Paket. Wähle „${name}“.`);
    expect(packageCheckText({ ok: false, reason: 'not-zip' }, name)).toBe(`Das ist keine ZIP-Datei. Wähle „${name}“.`);
  });
});

describe('a Paket from elsewhere while own changes wait', () => {
  it('says what happened, why the own changes no longer fit, and what to do', () => {
    expect(changedElsewhereText({ packageName: 'TonUINO-Paket-oma.zip', pending: 3 })).toEqual([
      'Auf der Karte ist jetzt das Paket „TonUINO-Paket-oma.zip“.',
      'Deine eigenen Änderungen hab ich aber für die Karte von vorher geplant. So passen sie nicht mehr sicher dazu.',
      'Übernimm die Karte, wie sie jetzt ist. Deine Änderungen gehen dabei verloren. Mache sie danach einfach noch einmal.',
    ]);
    expect(changedElsewhereText({ packageName: 'p.zip', pending: 1 })[1]).toBe('Deine eigene Änderung hab ich aber für die Karte von vorher geplant. So passt sie nicht mehr sicher dazu.');
    expect(changedElsewhereText({ packageName: 'p.zip', pending: 1 })[2]).toMatch(/^Übernimm die Karte, wie sie jetzt ist\. Deine Änderung geht dabei verloren\./);
  });

  it('tells not to unpack an own Paket any more', () => {
    const at = new Date(2026, 9, 6, 14, 2).getTime();
    expect(changedElsewhereText({ packageName: 'p.zip', pending: 2, ownPackageAt: at })[1]).toMatch(/^Dein eigenes Paket (von 14:02|vom 6\.10\.) hab ich aber für die Karte von vorher gepackt\. Entpacke es nicht mehr/);
  });
});
