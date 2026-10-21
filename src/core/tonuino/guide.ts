import type { PackageMode } from './package';

/**
 * Step-by-step instructions for bringing a Paket onto the card, for each
 * system. Unpacking happens in archive order (unzip, Python and ditto do
 * that), so the box finds the tracks in the right order.
 */

export type GuideOs = 'windows' | 'macos' | 'linux' | 'chromebook';

export interface GuideStep {
  kind: 'wait' | 'verify-package' | 'format' | 'delete' | 'open' | 'extract' | 'note' | 'check' | 'eject';
  text: string;
  /** A command to copy. */
  command?: string;
  /** Other commands that do the same, shown right below. */
  altCommands?: { label: string; command: string }[];
  /** Help folded away under "Klappt das nicht?". */
  troubleshoot?: { text: string; command?: string }[];
  warnings?: string[];
}

export interface GuideInput {
  os: GuideOs;
  mode: PackageMode;
  /** The card had nothing on it before. */
  fresh: boolean;
  zipName: string;
  /** Name of the card as the system shows it (Mac: in the Finder). */
  cardLabel: string;
  deleteFirst: string[];
  /** Hidden files to delete by hand ("01/._001.mp3"), see WritePlan. */
  deleteJunk?: string[];
  /** An earlier Paket was thrown away: only the newest one may go onto the card. */
  replacesOlder?: boolean;
  /** A Paket the app did not make for this card: its folders may not be on the card at all. */
  foreign?: boolean;
}

/** For POSIX shells: single quotes, a quote inside becomes '\''. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Unpacks with ditto in archive order and without the "._" files macOS
 * would put on a FAT card, then cleans up what is left of them. The tilde
 * stays outside the quotes so the shell expands it.
 */
export function macExtractCommand(zipName: string, cardLabel: string): string {
  const card = shQuote(`/Volumes/${cardLabel}`);
  return `ditto -x -k --norsrc --noextattr --noqtn --noacl ~/Downloads/${shQuote(zipName)} ${card} && dot_clean -m ${card}`;
}

export function linuxExtractCommands(zipName: string): { unzip: string; python: string } {
  return {
    unzip: `unzip -o ~/Downloads/${shQuote(zipName)}`,
    python: `python3 -m zipfile -e ~/Downloads/${shQuote(zipName)} .`,
  };
}

export function defaultGuideOs(os: 'linux' | 'windows' | 'macos' | 'other'): GuideOs {
  return os === 'other' ? 'windows' : os;
}

/** "05", "05 und mp3", "05, 07 und mp3". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

const WAIT: GuideStep = { kind: 'wait', text: 'Warte, bis der Download fertig ist. Dein Browser zeigt das oben rechts bei den Downloads.' };
/** "Paket prüfen": says which file to pick, and that the next steps follow. */
function verifyStep(zipName: string): GuideStep {
  return {
    kind: 'verify-package',
    text: `Klicke auf „Paket prüfen“ und wähle im Download-Ordner die Datei „${zipName}“. Dann weiß ich, dass das Paket heil angekommen ist, und zeige dir die nächsten Schritte.`,
  };
}
const CHECK: GuideStep = { kind: 'check', text: 'Lasse mich nachsehen, ob alles stimmt.' };
const KEEP_OTHERS = 'Lösche nichts, was nicht in der Liste steht. Deine anderen Ordner bleiben, wie sie sind.';
const FAT32_CHANGES = 'Die Box liest nur Karten mit FAT32 und höchstens 32 GB. Im Zweifel nimm „Karte komplett neu aufbauen“ und formatiere dabei.';
const FAT32_FRESH = 'Die Box liest nur Karten mit FAT32 und höchstens 32 GB. Neue Karten bis 32 GB sind meist schon so formatiert.';
const ZIP_ON_COMPUTER = 'Das Paket muss auf dem Computer liegen (meist in „Downloads“), nicht auf der Karte.';
const FORMAT_LATE = 'Beim Formatieren wird alles auf der Karte gelöscht. Mache das erst, wenn ich das Paket geprüft hab.';
const ELSEWHERE = 'Der Befehl sucht das Paket im Ordner „Downloads“. Liegt es woanders, nimm den Weg unter „Klappt das nicht?“.';

/** Warnings of the extract step: FAT32 for the card, and where the command looks for a Paket the user picked. */
function extractWarnings(fat32: string | undefined, foreign: boolean | undefined, posix: boolean): { warnings?: string[] } {
  const w = [...(fat32 ? [fat32] : []), ...(foreign && posix ? [ELSEWHERE] : [])];
  return w.length ? { warnings: w } : {};
}

function deleteText(names: readonly string[], foreign?: boolean): string {
  if (names.length === 1) return `den Ordner ${names[0]}${foreign ? ', falls es ihn gibt' : ''}`;
  return `diese Ordner${foreign ? ', falls es sie gibt' : ''}: ${namesList(names)}`;
}

const SHOW_HIDDEN: Record<'windows' | 'macos' | 'linux', string> = {
  windows: 'Damit du sie siehst, klicke im Explorer oben auf „Anzeigen“ und dann auf „Ausgeblendete Elemente“ (Windows 10: „Ansicht“, Haken bei „Ausgeblendete Elemente“).',
  macos: 'Damit du sie siehst, drücke im Finder ⌘, Umschalt und Punkt zugleich.',
  linux: 'Damit du sie siehst, drücke im Dateimanager Strg+H. Lösche sie mit Umschalt+Entf.',
};

/** Hidden files the app cleaned up in its copy: deleted on the card by hand, no folder comes new for them. */
function junkStep(os: 'windows' | 'macos' | 'linux', paths: readonly string[]): GuideStep {
  const what = paths.length === 1 ? `die versteckte Datei ${paths[0]}` : `diese versteckten Dateien: ${namesList(paths)}`;
  return { kind: 'delete', text: `Lösche auf der Karte ${what}. ${SHOW_HIDDEN[os]}`, warnings: [KEEP_OTHERS] };
}

/** Systems with their own tool for formatting a card. */
export type FormatOs = Exclude<GuideOs, 'chromebook'>;

const FORMAT: Record<FormatOs, { text: string; notes: string[] }> = {
  windows: {
    text: 'Rechtsklick auf die Karte im Explorer, dann „Formatieren …“. Dateisystem „FAT32“, Größe der Zuordnungseinheit „32 Kilobytes“, Volumebezeichnung „TONUINO“. Nimm den Haken bei „Schnellformatierung“ weg (dauert länger, prüft die Karte aber gründlich). Klicke auf „Starten“.',
    notes: ['Bietet Windows kein „FAT32“ an, ist die Karte größer als 32 GB. Nimm eine Karte mit höchstens 32 GB.'],
  },
  macos: {
    text: 'Öffne das „Festplattendienstprogramm“ (⌘ + Leertaste). Klicke auf „Darstellung“ > „Alle Geräte einblenden“, wähle links die SD-Karte (das Gerät, nicht nur das Volume) und klicke auf „Löschen“. Name „TONUINO“, Format „MS-DOS-Dateisystem (FAT)“, Schema „Master Boot Record“.',
    notes: [],
  },
  linux: {
    text: 'Öffne „Laufwerke“, wähle die SD-Karte, dann „Partition formatieren …“, Name „TONUINO“, Typ FAT („Zur Verwendung mit allen Systemen und Geräten“).',
    notes: [],
  },
};

/**
 * Formatting the card with the system's own tool: FAT32, 32 KB clusters
 * where the tool lets you choose, no quick format. Used by the Paket guide
 * and by "Karte neu aufbauen" (src/features/box/RebuildDialog.tsx);
 * `warnings` come before the system's own notes.
 */
export function formatStep(os: FormatOs, warnings: string[] = []): GuideStep {
  return { kind: 'format', text: FORMAT[os].text, warnings: [...warnings, ...FORMAT[os].notes] };
}

/** Whether the guide asks to check the downloaded Paket before anything is deleted or formatted. */
export function needsPackageCheck(i: Pick<GuideInput, 'mode' | 'deleteFirst'>): boolean {
  return i.mode === 'full' || i.deleteFirst.length > 0;
}

export function guideSteps(i: GuideInput): GuideStep[] {
  if (i.os === 'chromebook') {
    return [{ kind: 'note', text: 'Öffne TonUINO Studio in Chrome. Dort schreibe ich direkt auf die Karte, ganz ohne Paket.' }];
  }
  const full = i.mode === 'full';
  const deletes = !full && i.deleteFirst.length > 0;
  const junk = !full && i.deleteJunk?.length ? i.deleteJunk : null;
  const fat32 = full ? undefined : i.fresh ? FAT32_FRESH : FAT32_CHANGES;
  const steps: GuideStep[] = [WAIT];
  if (i.replacesOlder) {
    steps.push({ kind: 'note', text: `Nimm nur das neueste Paket, „${i.zipName}“. Ältere Pakete im Download-Ordner brauchst du nicht mehr.` });
  }
  const gate = () => {
    if (needsPackageCheck(i)) steps.push(verifyStep(i.zipName));
  };

  if (i.os === 'windows') {
    gate();
    const card = i.cardLabel && i.cardLabel !== 'SD-Karte' ? i.cardLabel : 'TONUINO';
    if (full) steps.push(formatStep('windows', [ZIP_ON_COMPUTER, FORMAT_LATE]));
    if (deletes) {
      steps.push({
        kind: 'delete',
        text: `Öffne im Explorer die SD-Karte (zum Beispiel „${card} (E:)“) und lösche dort ${deleteText(i.deleteFirst, i.foreign)}.`,
        warnings: [KEEP_OTHERS],
      });
      if (junk) steps.push(junkStep('windows', junk));
      steps.push({ kind: 'open', text: 'Gehe im Explorer links auf den Ordner „Downloads“.' });
    } else {
      if (junk) steps.push(junkStep('windows', junk));
      steps.push({ kind: 'open', text: 'Öffne den Explorer und links den Ordner „Downloads“.' });
    }
    steps.push(
      { kind: 'extract', text: `Klicke mit der rechten Maustaste auf „${i.zipName}“ und dann auf „Alle extrahieren …“.` },
      {
        kind: 'extract',
        text: 'Klicke auf „Durchsuchen …“, wähle links die SD-Karte aus und klicke auf „Ordner auswählen“.',
        warnings: ['Im Feld steht jetzt nur der Buchstabe der Karte, zum Beispiel „E:\\“. Steht dahinter noch ein Ordnername, lösche ihn.'],
      },
      {
        kind: 'extract',
        text: 'Klicke auf „Extrahieren“. Fragt Windows nach Dateien, die es schon gibt: „Dateien im Ziel ersetzen“.',
        ...(fat32 ? { warnings: [fat32] } : {}),
      },
      { kind: 'extract', text: 'Warte, bis das Fenster von selbst zugeht.' },
      CHECK,
      { kind: 'eject', text: 'Rechtsklick auf die Karte im Explorer, dann „Auswerfen“. Danach kannst du sie herausziehen.' },
    );
    return steps;
  }

  if (i.os === 'macos') {
    steps.push({
      kind: 'note',
      text: 'Nur bei Safari: Liegt in „Downloads“ statt der ZIP-Datei ein Ordner „TonUINO-Paket-…“? Dann hat Safari das Paket schon ausgepackt. Lösche den Ordner und hole die ZIP-Datei aus dem Papierkorb zurück (Rechtsklick, „Zurücklegen“).',
    });
    gate();
    if (full) steps.push(formatStep('macos', [ZIP_ON_COMPUTER, FORMAT_LATE]));
    if (deletes) {
      steps.push({
        kind: 'delete',
        text: `Öffne im Finder die SD-Karte und lege ${
          i.deleteFirst.length === 1
            ? `den Ordner ${i.deleteFirst[0]} in den Papierkorb${i.foreign ? ', falls es ihn gibt' : ''}`
            : `diese Ordner in den Papierkorb${i.foreign ? ', falls es sie gibt' : ''}: ${namesList(i.deleteFirst)}`
        }. Leere danach den Papierkorb, solange die Karte noch steckt.`,
        warnings: [KEEP_OTHERS],
      });
    }
    if (junk) steps.push(junkStep('macos', junk));
    steps.push(
      { kind: 'open', text: 'Öffne das Programm „Terminal“: Drücke ⌘ und die Leertaste, tippe „Terminal“ und drücke Enter.' },
      {
        kind: 'extract',
        text: 'Kopiere diesen Befehl, füge ihn im Terminal ein (⌘V) und drücke Enter:',
        command: macExtractCommand(i.zipName, i.cardLabel),
        troubleshoot: [
          {
            text: 'Tippe diesen Anfang ins Terminal (mit dem Leerzeichen am Ende). Ziehe dann das Paket ins Terminal-Fenster, dann die SD-Karte vom Schreibtisch, und drücke Enter:',
            command: 'ditto -x -k --norsrc --noextattr --noqtn --noacl ',
          },
          { text: 'Danach genauso diesen Anfang, dann die SD-Karte ins Fenster ziehen und Enter drücken:', command: 'dot_clean -m ' },
          {
            text: 'Steht da „Operation not permitted“? Erlaube „Terminal“ in den Systemeinstellungen unter Datenschutz & Sicherheit den Zugriff auf Downloads und Wechseldatenträger.',
          },
        ],
        ...extractWarnings(fat32, i.foreign, true),
      },
      { kind: 'note', text: 'Fragt der Mac, ob „Terminal“ auf Dateien zugreifen darf: Klicke auf „OK“ oder „Erlauben“.' },
      { kind: 'extract', text: 'Warte, bis im Terminal wieder eine neue Zeile erscheint.' },
      CHECK,
      { kind: 'eject', text: 'Klicke im Finder auf den Pfeil neben dem Namen der Karte.' },
    );
    return steps;
  }

  // Linux
  gate();
  if (full) steps.push(formatStep('linux', [ZIP_ON_COMPUTER, FORMAT_LATE]));
  if (deletes) {
    steps.push({
      kind: 'delete',
      text: `Öffne die SD-Karte im Dateimanager und lösche ${
        i.deleteFirst.length === 1
          ? `den Ordner ${i.deleteFirst[0]}${i.foreign ? ', falls es ihn gibt,' : ''} mit Umschalt+Entf (sonst landet er im Papierkorb auf der Karte)`
          : `diese Ordner${i.foreign ? ', falls es sie gibt,' : ''} mit Umschalt+Entf (sonst landen sie im Papierkorb auf der Karte): ${namesList(i.deleteFirst)}`
      }.`,
      warnings: [KEEP_OTHERS],
    });
    if (junk) steps.push(junkStep('linux', junk));
    steps.push({ kind: 'open', text: 'Klicke mit der rechten Maustaste auf eine freie Stelle der Karte und wähle „Im Terminal öffnen“ (oder „Terminal hier öffnen“).' });
  } else {
    if (junk) steps.push(junkStep('linux', junk));
    steps.push({
      kind: 'open',
      text: 'Öffne die SD-Karte im Dateimanager, klicke mit der rechten Maustaste auf eine freie Stelle und wähle „Im Terminal öffnen“ (oder „Terminal hier öffnen“).',
    });
  }
  const cmd = linuxExtractCommands(i.zipName);
  steps.push(
    {
      kind: 'extract',
      text: 'Füge diesen Befehl ein (Strg+Umschalt+V) und drücke Enter:',
      command: cmd.unzip,
      altCommands: [{ label: 'Meldet das Terminal „Befehl nicht gefunden“, nimm diesen:', command: cmd.python }],
      troubleshoot: [
        {
          text: 'Liegt das Paket nicht im Ordner „Downloads“? Tippe diesen Anfang ins Terminal (mit dem Leerzeichen am Ende), ziehe dann das Paket ins Terminal-Fenster und drücke Enter:',
          command: 'unzip -o ',
        },
      ],
      ...extractWarnings(fat32, i.foreign, true),
    },
    { kind: 'extract', text: 'Warte, bis wieder eine Eingabezeile erscheint.' },
    CHECK,
    { kind: 'eject', text: 'Wirf die Karte im Dateimanager aus (Auswerfen-Symbol neben der Karte).' },
  );
  return steps;
}
