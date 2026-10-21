import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { defaultGuideOs, guideSteps, linuxExtractCommands, macExtractCommand, namesList, needsPackageCheck, shQuote, type GuideInput } from '../../src/core/tonuino/guide';

const NAME = 'TonUINO-Paket-0610-1432-7KQ.zip';

/** What a POSIX shell makes of a quoted word. */
function shellSees(word: string): string {
  const r = spawnSync('sh', ['-c', `printf '%s' ${word}`], { encoding: 'utf8' });
  return r.stdout;
}

const input = (patch: Partial<GuideInput> = {}): GuideInput => ({
  os: 'windows',
  mode: 'changes',
  fresh: false,
  zipName: NAME,
  cardLabel: 'TONUINO',
  deleteFirst: ['mp3', '05'],
  ...patch,
});

const kinds = (i: GuideInput) => guideSteps(i).map((s) => s.kind);

describe('shQuote', () => {
  it('keeps spaces, quotes, ! and $ as they are', () => {
    for (const s of ['NO NAME', "Lenas Box's", 'Hallo!', '$HOME', 'a"b', 'TonUINO-Paket (1).zip', '']) {
      expect(shellSees(shQuote(s)), s).toBe(s);
    }
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe('commands', () => {
  it('the Mac command unpacks with ditto and cleans up the ._ files', () => {
    expect(macExtractCommand(NAME, 'NO NAME')).toBe(
      `ditto -x -k --norsrc --noextattr --noqtn --noacl ~/Downloads/'${NAME}' '/Volumes/NO NAME' && dot_clean -m '/Volumes/NO NAME'`,
    );
    expect(macExtractCommand('TonUINO-Paket-0610-1432-7KQ (1).zip', 'TONUINO')).toBe(
      `ditto -x -k --norsrc --noextattr --noqtn --noacl ~/Downloads/'TonUINO-Paket-0610-1432-7KQ (1).zip' '/Volumes/TONUINO' && dot_clean -m '/Volumes/TONUINO'`,
    );
  });

  it('Linux gets unzip and the Python fallback, both in archive order', () => {
    expect(linuxExtractCommands(NAME)).toEqual({ unzip: `unzip -o ~/Downloads/'${NAME}'`, python: `python3 -m zipfile -e ~/Downloads/'${NAME}' .` });
  });

  it('lists names the German way', () => {
    expect(namesList(['05'])).toBe('05');
    expect(namesList(['05', 'mp3'])).toBe('05 und mp3');
    expect(namesList(['mp3', '05', '07'])).toBe('mp3, 05 und 07');
  });

  it('picks the guide for the computer', () => {
    expect(defaultGuideOs('macos')).toBe('macos');
    expect(defaultGuideOs('linux')).toBe('linux');
    expect(defaultGuideOs('windows')).toBe('windows');
    expect(defaultGuideOs('other')).toBe('windows');
  });
});

describe('guideSteps', () => {
  it('Windows, changes: check the Paket before deleting, then unpack, check and eject', () => {
    expect(kinds(input())).toEqual(['wait', 'verify-package', 'delete', 'open', 'extract', 'extract', 'extract', 'extract', 'check', 'eject']);
    const steps = guideSteps(input());
    expect(steps[2].text).toBe('Öffne im Explorer die SD-Karte (zum Beispiel „TONUINO (E:)“) und lösche dort diese Ordner: mp3 und 05.');
    expect(steps[2].warnings).toEqual(['Lösche nichts, was nicht in der Liste steht. Deine anderen Ordner bleiben, wie sie sind.']);
    expect(steps[4].text).toBe(`Klicke mit der rechten Maustaste auf „${NAME}“ und dann auf „Alle extrahieren …“.`);
    expect(steps.flatMap((s) => s.warnings ?? [])).toContain(
      'Die Box liest nur Karten mit FAT32 und höchstens 32 GB. Im Zweifel nimm „Karte komplett neu aufbauen“ und formatiere dabei.',
    );
  });

  it('Windows, full: check the Paket before formatting', () => {
    const steps = guideSteps(input({ mode: 'full', deleteFirst: [] }));
    expect(steps.map((s) => s.kind)).toEqual(['wait', 'verify-package', 'format', 'open', 'extract', 'extract', 'extract', 'extract', 'check', 'eject']);
    expect(steps[2].warnings).toEqual([
      'Das Paket muss auf dem Computer liegen (meist in „Downloads“), nicht auf der Karte.',
      'Beim Formatieren wird alles auf der Karte gelöscht. Mache das erst, wenn ich das Paket geprüft hab.',
      'Bietet Windows kein „FAT32“ an, ist die Karte größer als 32 GB. Nimm eine Karte mit höchstens 32 GB.',
    ]);
    // No FAT32 hint: formatting takes care of it.
    expect(steps.flatMap((s) => s.warnings ?? []).some((w) => w.startsWith('Die Box liest nur'))).toBe(false);
  });

  it('a fresh card needs no gate and nothing deleted', () => {
    const fresh = input({ fresh: true, deleteFirst: [] });
    expect(kinds(fresh)).toEqual(['wait', 'open', 'extract', 'extract', 'extract', 'extract', 'check', 'eject']);
    expect(guideSteps(fresh).flatMap((s) => s.warnings ?? [])).toContain(
      'Die Box liest nur Karten mit FAT32 und höchstens 32 GB. Neue Karten bis 32 GB sind meist schon so formatiert.',
    );
    expect(needsPackageCheck(fresh)).toBe(false);
    expect(needsPackageCheck(input())).toBe(true);
    expect(needsPackageCheck(input({ mode: 'full', deleteFirst: [] }))).toBe(true);
  });

  it('one folder to delete reads as one', () => {
    expect(guideSteps(input({ deleteFirst: ['05'] }))[2].text).toBe('Öffne im Explorer die SD-Karte (zum Beispiel „TONUINO (E:)“) und lösche dort den Ordner 05.');
    expect(guideSteps(input({ deleteFirst: ['05'], cardLabel: 'SD-Karte' }))[2].text).toContain('„TONUINO (E:)“');
  });

  it('Mac: Safari note, Terminal with the ditto command and a way out', () => {
    const steps = guideSteps(input({ os: 'macos', cardLabel: 'NO NAME' }));
    expect(steps.map((s) => s.kind)).toEqual(['wait', 'note', 'verify-package', 'delete', 'open', 'extract', 'note', 'extract', 'check', 'eject']);
    const extract = steps[5];
    expect(extract.command).toBe(macExtractCommand(NAME, 'NO NAME'));
    expect(extract.troubleshoot?.map((t) => t.command)).toEqual(['ditto -x -k --norsrc --noextattr --noqtn --noacl ', 'dot_clean -m ', undefined]);
    expect(steps[3].text).toBe('Öffne im Finder die SD-Karte und lege diese Ordner in den Papierkorb: mp3 und 05. Leere danach den Papierkorb, solange die Karte noch steckt.');
    expect(guideSteps(input({ os: 'macos', deleteFirst: ['05'] }))[3].text).toBe(
      'Öffne im Finder die SD-Karte und lege den Ordner 05 in den Papierkorb. Leere danach den Papierkorb, solange die Karte noch steckt.',
    );
    const full = guideSteps(input({ os: 'macos', mode: 'full', deleteFirst: [] }));
    expect(full.map((s) => s.kind)).toEqual(['wait', 'note', 'verify-package', 'format', 'open', 'extract', 'note', 'extract', 'check', 'eject']);
  });

  it('Linux: unzip with the Python fallback', () => {
    const steps = guideSteps(input({ os: 'linux' }));
    expect(steps.map((s) => s.kind)).toEqual(['wait', 'verify-package', 'delete', 'open', 'extract', 'extract', 'check', 'eject']);
    expect(steps[2].text).toBe('Öffne die SD-Karte im Dateimanager und lösche diese Ordner mit Umschalt+Entf (sonst landen sie im Papierkorb auf der Karte): mp3 und 05.');
    expect(guideSteps(input({ os: 'linux', deleteFirst: ['05'] }))[2].text).toBe(
      'Öffne die SD-Karte im Dateimanager und lösche den Ordner 05 mit Umschalt+Entf (sonst landet er im Papierkorb auf der Karte).',
    );
    expect(steps[4].command).toBe(linuxExtractCommands(NAME).unzip);
    expect(steps[4].altCommands).toEqual([{ label: 'Meldet das Terminal „Befehl nicht gefunden“, nimm diesen:', command: linuxExtractCommands(NAME).python }]);
    const full = guideSteps(input({ os: 'linux', mode: 'full', deleteFirst: [] }));
    expect(full.map((s) => s.kind)).toEqual(['wait', 'verify-package', 'format', 'open', 'extract', 'extract', 'check', 'eject']);
    expect(full[3].text).toMatch(/^Öffne die SD-Karte im Dateimanager/);
  });

  it('after a Paket was thrown away, says to take the newest one', () => {
    const steps = guideSteps(input({ replacesOlder: true }));
    expect(steps[1]).toEqual({ kind: 'note', text: `Nimm nur das neueste Paket, „${NAME}“. Ältere Pakete im Download-Ordner brauchst du nicht mehr.` });
    expect(guideSteps(input({ os: 'macos', replacesOlder: true })).filter((s) => s.text.startsWith('Nimm nur das neueste Paket'))).toHaveLength(1);
    expect(guideSteps(input()).some((s) => s.text.startsWith('Nimm nur'))).toBe(false);
  });

  it('a Paket from elsewhere: delete its folders only where they exist', () => {
    const foreign = (patch: Partial<GuideInput>) => guideSteps(input({ foreign: true, ...patch })).find((s) => s.kind === 'delete')?.text;
    expect(foreign({})).toBe('Öffne im Explorer die SD-Karte (zum Beispiel „TONUINO (E:)“) und lösche dort diese Ordner, falls es sie gibt: mp3 und 05.');
    expect(foreign({ deleteFirst: ['05'] })).toBe('Öffne im Explorer die SD-Karte (zum Beispiel „TONUINO (E:)“) und lösche dort den Ordner 05, falls es ihn gibt.');
    expect(foreign({ os: 'macos', deleteFirst: ['05'] })).toBe(
      'Öffne im Finder die SD-Karte und lege den Ordner 05 in den Papierkorb, falls es ihn gibt. Leere danach den Papierkorb, solange die Karte noch steckt.',
    );
    expect(foreign({ os: 'macos' })).toBe(
      'Öffne im Finder die SD-Karte und lege diese Ordner in den Papierkorb, falls es sie gibt: mp3 und 05. Leere danach den Papierkorb, solange die Karte noch steckt.',
    );
    expect(foreign({ os: 'linux' })).toBe(
      'Öffne die SD-Karte im Dateimanager und lösche diese Ordner, falls es sie gibt, mit Umschalt+Entf (sonst landen sie im Papierkorb auf der Karte): mp3 und 05.',
    );
    expect(foreign({ os: 'linux', deleteFirst: ['05'] })).toBe(
      'Öffne die SD-Karte im Dateimanager und lösche den Ordner 05, falls es ihn gibt, mit Umschalt+Entf (sonst landet er im Papierkorb auf der Karte).',
    );
  });

  it('says which file to show the app at "Paket prüfen", and that more steps follow', () => {
    const gate = guideSteps(input()).find((s) => s.kind === 'verify-package');
    expect(gate?.text).toBe(
      `Klicke auf „Paket prüfen“ und wähle im Download-Ordner die Datei „${NAME}“. Dann weiß ich, dass das Paket heil angekommen ist, und zeige dir die nächsten Schritte.`,
    );
  });

  it('Linux: a way for a Paket that is not in Downloads', () => {
    const extract = guideSteps(input({ os: 'linux' })).find((s) => s.command);
    expect(extract?.troubleshoot).toEqual([
      {
        text: 'Liegt das Paket nicht im Ordner „Downloads“? Tippe diesen Anfang ins Terminal (mit dem Leerzeichen am Ende), ziehe dann das Paket ins Terminal-Fenster und drücke Enter:',
        command: 'unzip -o ',
      },
    ]);
  });

  it('a Paket from elsewhere: the commands look in Downloads, and say where the other way is', () => {
    const elsewhere = 'Der Befehl sucht das Paket im Ordner „Downloads“. Liegt es woanders, nimm den Weg unter „Klappt das nicht?“.';
    for (const os of ['macos', 'linux'] as const) {
      expect(guideSteps(input({ os, foreign: true })).find((s) => s.command)?.warnings).toContain(elsewhere);
      expect(guideSteps(input({ os })).find((s) => s.command)?.warnings ?? []).not.toContain(elsewhere);
    }
  });

  it('Chromebook: Chrome writes to the card itself', () => {
    expect(guideSteps(input({ os: 'chromebook' }))).toEqual([{ kind: 'note', text: 'Öffne TonUINO Studio in Chrome. Dort schreibe ich direkt auf die Karte, ganz ohne Paket.' }]);
  });
});

describe('hidden files to delete by hand', () => {
  it('lists them with the way to show hidden files, for each system', () => {
    const junk = (os: GuideInput['os']) => guideSteps(input({ os, deleteFirst: [], deleteJunk: ['05/._001.mp3'] })).find((s) => s.kind === 'delete')?.text;
    expect(junk('windows')).toMatch(/^Lösche auf der Karte die versteckte Datei 05\/\._001\.mp3\. .*Ausgeblendete Elemente/);
    expect(junk('macos')).toContain('⌘, Umschalt und Punkt');
    expect(junk('linux')).toContain('Strg+H');
    // A whole-card Paket formats the card: nothing to delete by hand.
    expect(kinds(input({ mode: 'full', deleteFirst: [], deleteJunk: ['05/._001.mp3'] }))).not.toContain('delete');
    // Hidden files alone need no check of the Paket first.
    expect(needsPackageCheck(input({ deleteFirst: [], deleteJunk: ['05/._001.mp3'] }))).toBe(false);
  });
});
