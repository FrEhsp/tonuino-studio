import { formatBytes } from '../../app/format';
import type { Catalog } from '../../core/tonuino/catalog';
import { namesList, shQuote } from '../../core/tonuino/guide';
import { folderName, parseFolderNumber, parseTempDir } from '../../core/tonuino/sd';
import type { CheckFinding } from '../../core/tonuino/verify';
import type { TopChange, WritePlan } from '../../core/tonuino/writeplan';
import type { SnapshotProblem } from '../../platform/snapshot';

/**
 * The words of the Paket mode (Firefox, Safari): what waits for the card,
 * what the check found, what a reading of the card brought. Plain
 * functions, so they can be tested without a page.
 */

/** "14:32" */
export function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** When a Paket was downloaded: "um 14:32" today, else "am 5.10. um 14:32". */
export function atText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  if (sameDay(d, new Date(now))) return `um ${timeOfDay(ms)}`;
  return `am ${d.getDate()}.${d.getMonth() + 1}. um ${timeOfDay(ms)}`;
}

/** "Das Paket von 14:32", or "vom 5.10." when it is older than today. */
export function fromText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  if (sameDay(d, new Date(now))) return `von ${timeOfDay(ms)}`;
  return `vom ${d.getDate()}.${d.getMonth() + 1}.`;
}

/** "3 Änderungen warten auf die Karte", or shorter for the sidebar. */
export function waitingText(n: number, short = false): string {
  const what = n === 1 ? '1 Änderung wartet' : `${n.toLocaleString('de-DE')} Änderungen warten`;
  return short ? what : `${what} auf die Karte`;
}

function changeVerb(c: TopChange): string {
  return c.kind === 'add' ? 'Neu' : c.kind === 'replace' ? 'Ersetzt' : 'Weg';
}

function changeLine(c: TopChange, catalog: Catalog | null, detailed: boolean): string {
  const verb = changeVerb(c);
  if (c.folder) {
    const name = folderName(c.folder);
    const title = detailed && c.kind !== 'remove' ? catalog?.folders[name]?.title : undefined;
    // A folder without a name of its own is called "Ordner 05" in the catalog: say it once.
    const own = title && title !== `Ordner ${name}` ? title : undefined;
    return `${verb}: Ordner ${name}${own ? ` · ${own}` : ''}`;
  }
  if (parseTempDir(c.name) !== undefined) return `${verb}: Hilfsordner der App`;
  if (c.system) return `${verb}: Ordner ${c.name}`;
  return `${verb}: „${c.name}“`;
}

/** Asked before the card is read again while changes wait. */
export function rereadText(n: number): string {
  if (n === 1) return '1 Änderung ist noch nicht auf der Karte. Beim neuen Einlesen geht sie verloren.';
  if (n > 1) return `${n.toLocaleString('de-DE')} Änderungen sind noch nicht auf der Karte. Beim neuen Einlesen gehen sie verloren.`;
  return 'Beim neuen Einlesen gehen Änderungen verloren, die noch nicht auf der Karte sind.';
}

/** The app's own files in a Paket: names, pictures and stickers. */
export const APP_FILES_TEXT = 'Namen, Bilder und Sticker';

/**
 * What a Paket brings, one line each: "Neu: Ordner 07 · Die Olchis",
 * "Systemansagen (mp3 und advert)", "Namen, Bilder und Sticker der App". `detailed`
 * adds titles and names; without it the lines stay short (banner).
 */
export function changeLines(plan: WritePlan, catalog: Catalog | null, detailed: boolean): string[] {
  const lines: string[] = [];
  const sounds = plan.changes.filter((c) => c.system && c.kind !== 'remove');
  for (const c of plan.changes) {
    if (c.system && c.kind !== 'remove') {
      if (c !== sounds[0]) continue;
      lines.push(detailed ? `Systemansagen (${namesList(sounds.map((x) => x.name))})` : 'Systemansagen');
      continue;
    }
    lines.push(changeLine(c, catalog, detailed));
  }
  if (plan.appFiles.length) lines.push(detailed ? `${APP_FILES_TEXT} der App` : APP_FILES_TEXT);
  if (plan.deleteJunk.length) lines.push(detailed ? `${hiddenFilesText(plan.deleteJunk.length)} von Hand löschen` : 'Versteckte Dateien löschen');
  return [...new Set(lines)];
}

/** "1 versteckte Datei", "3 versteckte Dateien". */
export function hiddenFilesText(n: number): string {
  return n === 1 ? '1 versteckte Datei' : `${n.toLocaleString('de-DE')} versteckte Dateien`;
}

/** At most `max` lines; the rest as "und 3 mehr" (detailed) or "und mehr". */
export function firstLines(lines: string[], max: number, detailed: boolean): string[] {
  if (lines.length <= max) return lines;
  const rest = lines.length - max;
  return [...lines.slice(0, max), detailed ? `und ${rest} mehr` : 'und mehr'];
}

/** "Ordner 05 und mp3" for what is deleted on the card first. */
export function foldersText(names: readonly string[]): string {
  return `Ordner ${namesList(names)}`;
}

export const REASON_TEXT: Record<WritePlan['reasons'][number], string> = {
  'junk-in-folders': 'Auf der Karte liegen versteckte Dateien, die die Box durcheinanderbringen.',
  'temp-folders': 'Auf der Karte liegt noch ein Hilfsordner von einer abgebrochenen Übertragung.',
  'many-replacements': 'Es ändern sich viele Ordner auf einmal.',
};

/** Above this size the dialog says how much room the download needs. */
export const SAY_SPACE_FROM = 1024 ** 3;

export function spaceText(bytes: number): string {
  return `Auf dem Computer brauchst du dafür ${formatBytes(bytes)} freien Platz.`;
}

/** Files a card for the box cannot hold (FAT32: at most 4 GB each). */
export function tooBigText(paths: readonly string[]): string {
  const what =
    paths.length === 1 ? `${example(paths)} ist größer als 4 GB.` : `${paths.length.toLocaleString('de-DE')} Dateien sind größer als 4 GB, zum Beispiel ${example(paths)}.`;
  return `${what} So große Dateien passen nicht auf eine Karte für die Box. Kopiere ${paths.length === 1 ? 'die Datei' : 'sie'} auf deinen Computer, lösche ${paths.length === 1 ? 'sie' : 'sie'} von der Karte und lies die Karte neu ein.`;
}

export const OVER_CARD_TEXT =
  'Das Paket ist größer, als auf eine Karte mit 32 GB passt, und größere Karten liest die Box nicht. Lösche vorher etwas von der Karte, zum Beispiel Ordner, die du nicht mehr brauchst, und lies sie neu ein.';

/** Folders the app knows but did not find when it read the card, before the card is formatted. */
export function unreadText(names: readonly string[]): string {
  const one = names.length === 1;
  return `Ich kenne ${one ? `Ordner ${names[0]}` : `die Ordner ${namesList(names)}`}, hab ${one ? 'ihn' : 'sie'} beim Einlesen aber nicht gefunden. Ist ${one ? 'er' : 'sie'} noch auf der Karte? Dann lies die Karte neu ein, bevor du sie formatierst, sonst ${one ? 'fehlt er' : 'fehlen sie'} danach.`;
}

/** What a reading of the card brought instead of a card. */
export function problemText(p: SnapshotProblem, source: 'chooser' | 'drop'): string {
  switch (p.kind) {
    case 'not-a-folder':
      return source === 'drop'
        ? 'Ziehe die ganze SD-Karte hierher, nicht einzelne Dateien.'
        : 'Das war keine Ordnerauswahl. Wähle die SD-Karte selbst aus, nicht eine Datei darauf.';
    case 'several-items':
      return 'Ziehe nur die SD-Karte hierher, nicht mehrere Dinge auf einmal.';
    case 'read-failed':
      return `Die Karte ließ sich nicht ganz lesen${p.path ? ` (bei „${p.path}“)` : ''}. Lies sie noch einmal ein. Klappt es wieder nicht, ist die Karte vielleicht beschädigt.`;
    case 'empty':
      return 'Die Karte sieht leer aus. Hast du aus Versehen eine Datei statt der Karte gewählt? Dann lies sie noch einmal ein.';
  }
}

export function pickedSubfolderText(name: string): string {
  return `Du hast den Ordner „${name}“ gewählt. Wähle die ganze SD-Karte aus, also den Ordner darüber.`;
}

export const LOOKS_EMPTY_TEXT = 'Die Karte sieht leer aus. Hast du aus Versehen eine Datei statt der Karte gewählt? Dann lies sie noch einmal ein.';

export interface FindingText {
  text: string;
  /** A command to copy (Mac). */
  command?: string;
  /** Only worth knowing: the box works anyway. */
  warning?: boolean;
}

const example = (paths: readonly string[]) => `„${paths[0]}“`;

/** What a "Karte prüfen" finding means, and what to do about it. */
export function findingText(f: CheckFinding, cardLabel: string): FindingText {
  switch (f.kind) {
    case 'picked-subfolder':
      return { text: pickedSubfolderText(f.name) };
    case 'nested':
      return {
        text: `Die Dateien sind in einem eigenen Ordner „${f.folder}“ gelandet statt direkt auf der Karte. Lösche diesen Ordner auf der Karte und entpacke das Paket noch einmal. Wähle dabei die Karte selbst als Ziel.`,
      };
    case 'not-a-card':
      return { text: 'Das sieht nicht nach der SD-Karte aus. Wähle das Laufwerk der Karte aus (zum Beispiel „TONUINO“).' };
    case 'nothing-arrived':
      return { text: 'Auf der Karte ist noch nichts aus dem Paket. Hast du in einen anderen Ordner entpackt? Entpacke noch einmal und wähle dabei die Karte als Ziel.' };
    case 'missing':
      return {
        text:
          f.paths.length === 1
            ? `Es fehlt noch eine Datei: ${example(f.paths)}. Ist die Karte voll? Sonst entpacke das Paket noch einmal.`
            : `Es fehlen noch ${f.paths.length.toLocaleString('de-DE')} Dateien, zum Beispiel ${example(f.paths)}. Ist die Karte voll? Sonst entpacke das Paket noch einmal.`,
      };
    case 'incomplete':
      return {
        text:
          f.paths.length === 1
            ? `Die Datei ${example(f.paths)} ist nicht vollständig. Entpacke das Paket noch einmal und ersetze dabei alle Dateien.`
            : `${f.paths.length.toLocaleString('de-DE')} Dateien sind nicht vollständig, zum Beispiel ${example(f.paths)}. Entpacke das Paket noch einmal und ersetze dabei alle Dateien.`,
      };
    case 'outdated':
      return {
        text:
          f.paths.length === 1
            ? `Die Datei ${example(f.paths)} auf der Karte ist nicht die aus dem Paket. Entpacke das Paket noch einmal und ersetze dabei alle Dateien.`
            : `${f.paths.length.toLocaleString('de-DE')} Dateien auf der Karte sind nicht die aus dem Paket, zum Beispiel ${example(f.paths)}. Entpacke das Paket noch einmal und ersetze dabei alle Dateien.`,
      };
    case 'leftovers':
      if (f.added) {
        return {
          text: `In Ordner ${f.folder} lagen schon Dateien, bevor du das Paket entpackt hast (zum Beispiel ${example(f.paths)}). Vielleicht von einem anderen Paket. Lösche sie nicht einfach: Übernimm die Karte so, wie sie ist, und sieh dir Ordner ${f.folder} in der App an.`,
        };
      }
      return {
        text: `In Ordner ${f.folder} liegen noch alte Dateien (zum Beispiel ${example(f.paths)}). Lösche den Ordner ${f.folder} auf der Karte und entpacke das Paket noch einmal.`,
      };
    case 'not-deleted': {
      const folders = f.names.every((n) => parseFolderNumber(n) !== null || /^(mp3|advert)$/i.test(n));
      if (folders) {
        return {
          text:
            f.names.length === 1
              ? `Der Ordner ${f.names[0]} sollte weg sein, ist aber noch auf der Karte. Lösche ihn.`
              : `Die Ordner ${namesList(f.names)} sollten weg sein, sind aber noch auf der Karte. Lösche sie.`,
        };
      }
      const names = namesList(f.names.map((n) => `„${n}“`));
      return { text: `${names} ${f.names.length === 1 ? 'sollte weg sein, ist aber' : 'sollten weg sein, sind aber'} noch auf der Karte. Lösche ${f.names.length === 1 ? 'es' : 'sie'}.` };
    }
    case 'appledouble':
      return {
        text: 'Auf der Karte liegen versteckte Mac-Dateien („._“). Sie bringen die Box durcheinander. Tippe im Terminal:',
        command: `dot_clean -m ${shQuote(`/Volumes/${cardLabel}`)}`,
      };
    case 'package-on-card':
      return { text: `Das Paket selbst liegt auch auf der Karte. Lösche die Datei „${f.name}“ von der Karte.` };
    case 'not-formatted':
      return {
        text: `Auf der Karte liegen noch Dinge, die nicht im Paket sind: ${namesList(f.names.slice(0, 5).map((n) => `„${n}“`))}${f.names.length > 5 ? ' und mehr' : ''}. Wurde die Karte vorher formatiert?`,
        warning: true,
      };
  }
}

/** Files whose content differs from the Paket (gründlich prüfen). */
export function crcMismatchText(paths: readonly string[]): string {
  return paths.length === 1
    ? `Die Datei ${example(paths)} ist auf der Karte anders als im Paket. Die Karte könnte kaputt sein. Entpacke noch einmal, und nimm eine andere Karte, wenn es wieder passiert.`
    : `${paths.length.toLocaleString('de-DE')} Dateien sind auf der Karte anders als im Paket, zum Beispiel ${example(paths)}. Die Karte könnte kaputt sein. Entpacke noch einmal, und nimm eine andere Karte, wenn es wieder passiert.`;
}

export function decodeFailedText(paths: readonly string[]): string {
  return paths.length === 1
    ? `${example(paths)} lässt sich nicht abspielen. Entpacke das Paket noch einmal.`
    : `${paths.length.toLocaleString('de-DE')} Titel lassen sich nicht abspielen, zum Beispiel ${example(paths)}. Entpacke das Paket noch einmal.`;
}

export const CHECK_OK_TEXT = 'Alles ist richtig auf der Karte. Du kannst sie jetzt auswerfen und in die Box stecken.';

/** The answer to "Paket prüfen" (is the downloaded file the whole Paket?). */
export function packageCheckText(r: { ok: true } | { ok: false; reason: 'not-finished' | 'not-zip' | 'other-package' }, expected: string): string {
  if (r.ok) return 'Das Paket ist vollständig.';
  switch (r.reason) {
    case 'not-finished':
      return 'Das Paket ist noch nicht fertig heruntergeladen. Warte noch etwas und versuche es dann noch einmal.';
    case 'not-zip':
      return `Das ist keine ZIP-Datei. Wähle „${expected}“.`;
    case 'other-package':
      return `Das ist ein anderes Paket. Wähle „${expected}“.`;
  }
}

/**
 * After a Paket from elsewhere went onto the card while own changes wait
 * (ChangedElsewhere in app/pending.ts): what happened, why the own changes
 * no longer fit, and what to do. One paragraph each. `ownPackageAt`: an own
 * Paket was downloaded already.
 */
export function changedElsewhereText(o: { packageName: string; pending: number; ownPackageAt?: number }): string[] {
  const one = o.ownPackageAt === undefined && o.pending === 1;
  const lines = [`Auf der Karte ist jetzt das Paket „${o.packageName}“.`];
  if (o.ownPackageAt !== undefined) {
    lines.push(`Dein eigenes Paket ${fromText(o.ownPackageAt)} hab ich aber für die Karte von vorher gepackt. Entpacke es nicht mehr, es passt nicht mehr sicher dazu.`);
  } else if (one) {
    lines.push('Deine eigene Änderung hab ich aber für die Karte von vorher geplant. So passt sie nicht mehr sicher dazu.');
  } else {
    // No number: names and pictures count as a change of their own, an album brings both.
    lines.push('Deine eigenen Änderungen hab ich aber für die Karte von vorher geplant. So passen sie nicht mehr sicher dazu.');
  }
  lines.push(`Übernimm die Karte, wie sie jetzt ist. ${one ? 'Deine Änderung geht' : 'Deine Änderungen gehen'} dabei verloren. Mache sie danach einfach noch einmal.`);
  return lines;
}
