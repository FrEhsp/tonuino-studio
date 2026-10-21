import type { VolumeInfo } from '../../platform/types';
import type { TngRelease } from './boxguide';
import type { FirmwareProfile } from './card';
import { guessNotFat } from './fsguess';
import {
  duplicateTracks,
  folderName,
  isOutOfOrder,
  junkOrigin,
  MAX_FOLDER,
  MAX_TRACKS,
  missingTrackNumbers,
  nextFolderNumber,
  systemTrackName,
  type SdFolder,
  isUnplayableAudio,
  type SdNearFolder,
  type SdNearSystem,
  type SdScan,
  type SystemDirName,
} from './sd';
import { checkSystemSounds, TNG_START_TONE } from './systemsounds';

/**
 * The SD health check: everything the forum knows that makes a box play the
 * wrong file, stay silent or hiss, in plain language and with a fix.
 */

export type Severity = 'error' | 'warning' | 'info';

export type FixAction =
  /** `keepRoot`: leave the top level alone (a built-in drive, not a card). */
  | { kind: 'clean-junk'; keepRoot?: boolean }
  | { kind: 'remove-empty-tracks'; folder: number }
  /** `pure`: always pure numbers ("001.mp3"), whatever the setting says (for text after the number). */
  | { kind: 'normalize-names'; folder: number; pure?: boolean }
  | { kind: 'close-gaps'; folder: number }
  | { kind: 'resolve-duplicates'; folder: number }
  | { kind: 'number-unnumbered'; folder: number }
  | { kind: 'remove-empty-folder'; folder: number }
  /** Files that are neither tracks nor junk (pictures, lists, texts) in a folder with tracks. */
  | { kind: 'remove-others'; folder: number }
  /** `title`: the text of a name like "02 Bibi", for the catalog when the folder has no entry yet. */
  | { kind: 'rename-invalid-folder'; name: string; to: number; title?: string }
  /** A top-level folder named almost like a system folder, e.g. "advent" for "advert". */
  | { kind: 'rename-root-folder'; name: string; to: SystemDirName }
  | { kind: 'rebuild-order'; folder: number }
  | { kind: 'recover-temp' }
  | { kind: 'install-system-sounds' }
  | { kind: 'normalize-system-names' }
  /** The parent looked on a computer and saw FAT32: the web app stops guessing for this card. */
  | { kind: 'confirm-fat32' }
  /** Files or folders with the FAT read-only attribute: the desktop app clears it. */
  | { kind: 'make-writable' };

export interface Issue {
  /** Stable id for this issue on this card, e.g. "gap:05". */
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  folder?: number;
  /** Affected file or folder names, for the details view. */
  items?: string[];
  /** How many there are when `items` shows only the first of them. */
  itemsTotal?: number;
  fix?: FixAction;
  /** Label of the fix button. */
  fixLabel?: string;
  /** Warning shown before the fix runs. */
  fixWarning?: string;
  /** Where the help says more, as a link inside the app ("#/hilfe/…"). */
  help?: string;
}

export interface HealthReport {
  status: 'ok' | 'warning' | 'error';
  issues: Issue[];
  /** Counts for the summary line. */
  counts: Record<Severity, number>;
}

export interface HealthContext {
  profile: FirmwareProfile;
  /** Whether the TNG box runs the release of 17.09.2026 or newer (systemsounds.ts TNG_SEPTEMBER_SOUNDS). */
  tngRelease?: TngRelease;
  volume?: VolumeInfo;
  /** Someone saw FAT32 on a computer for this card (Catalog.formatChecked): no guessing from file times. */
  formatChecked?: boolean;
  /** Whether the directory order reported by the platform is the real FAT order (desktop). */
  trustsDirectoryOrder?: boolean;
  /** Folders referenced by cards the app knows about (to warn before renumbering). */
  foldersWithRangeCards?: Set<number>;
  /**
   * Leave junk in the card's root alone: the card was read as a snapshot
   * (Firefox, Safari), and a Paket cannot delete anything there. The box
   * ignores it anyway.
   */
  keepRootJunk?: boolean;
  /** The platform can remove the write protection of single files (desktop). */
  canUnlock?: boolean;
  /** The system the app runs on: the format hints name only its way to look (audit 0.4 #3). */
  system?: FormatSystem;
  /**
   * False: the user chose names with words ("001 Der Hund.mp3", setting
   * „Nur Nummern als Dateinamen“ off). Such names are then only a hint,
   * not a risk.
   */
  pureNumbers?: boolean;
}

/** Where someone reads the card's format: each has one way, the help has all of them. */
export type FormatSystem = 'windows' | 'macos' | 'linux' | 'chromeos' | 'phone' | 'other';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const decimal = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

/** The help on formatting the card, linked from the file system issues. */
const FORMAT_HELP = '#/hilfe/sd-karte-geht-nicht';
/** Said before names lose their words (forum 14978#72, #75: only after a warning). */
const SAFE_RENAME_WARNING =
  'Die Dateien heißen danach nur noch nach ihrer Nummer, die Reihenfolge bleibt. Die Wörter aus dem alten Namen schreibe ich in den Titel der Datei, wenn dort noch nichts steht. Rückgängig machen lässt sich das nicht. Bekommt eine Datei so ihren Titel, fallen Bilder in ihr weg, die Box braucht sie nicht.';

/** The help on folder and file names, linked from the name issues. */
const NAMES_HELP = '#/hilfe/dateinamen';
/** Missing or empty announcements, with the start tone of TNG (mp3/0262). */
const SOUNDS_HELP = '#/hilfe/keine-ansagen';
/** TonUINO TNG plays mp3/0262 whenever a card is put on (StartPlay); without it the box stops after the first card (forum 12980#1). */
export const START_TONE_TEXT = 'mp3/0262.mp3, der kurze Ton, wenn du eine Karte auflegst. Ohne ihn spielt die erste Karte noch, danach reagiert die Box oft nicht mehr („Fehler 6“).';
/**
 * How to look at the format, only for the computer in use: four systems at
 * once were a wall of text (audit 0.4 #3). All four ways stay in the help.
 */
function checkFormat(system: FormatSystem | undefined): string {
  switch (system) {
    case 'windows':
      return 'Schaue im Explorer nach, mit Rechtsklick auf die Karte und „Eigenschaften“. Dort steht es bei „Dateisystem“.';
    case 'macos':
      return 'Schaue im Finder nach, mit Rechtsklick auf die Karte und „Informationen“. Dort steht es bei „Format“.';
    case 'linux':
      return 'Schaue im Programm „Laufwerke“ nach und klicke dort die Karte an.';
    case 'chromeos':
      return 'Am Chromebook sieht man das leider nicht. Schaue an einem Windows-PC oder Mac nach, wie es in der Hilfe steht.';
    case 'phone':
      return 'Am Handy sieht man das nicht. Wie du an einem Computer nachschaust, steht in der Hilfe.';
    default:
      return 'Wie du nachschaust, steht in der Hilfe.';
  }
}

/** FAT12/16/32 as reported by Linux (vfat, msdos), Windows (FAT, FAT32) and macOS (msdos). exFAT is not FAT. */
export function isFatFilesystem(fsType: string): boolean {
  return /^(v?fat(12|16|32)?|msdos)$/i.test(fsType.trim());
}

/**
 * A folder on the computer's own drive, not an SD card: the desktop says the
 * drive is built in, and its file system is none a card for the box would
 * have (ext4, NTFS, APFS, …). Its size, free space and format are the
 * computer's, not the card's. A built-in drive with FAT or exFAT may be a card
 * in a reader the system does not report as removable: that still counts as
 * a card. Unknown (browser): a card.
 */
export function isComputerDrive(v: Pick<VolumeInfo, 'removable' | 'fsType'> | undefined): boolean {
  if (!v || v.removable !== false) return false;
  const fs = (v.fsType ?? '').trim();
  return !isFatFilesystem(fs) && !/^exfat$/i.test(fs);
}

export function checkHealth(scan: SdScan, ctx: HealthContext): HealthReport {
  const issues: Issue[] = [];
  const add = (i: Issue) => issues.push(i);

  checkVolume(scan, ctx, add);
  checkReadOnly(scan, ctx, add);
  checkTemp(scan, add);
  checkJunk(scan, ctx, add);
  checkSystem(scan, ctx, add);
  for (const folder of scan.folders) checkFolder(folder, ctx, add);
  checkRoot(scan, add);

  const counts = { error: 0, warning: 0, info: 0 } as Record<Severity, number>;
  for (const i of issues) counts[i.severity]++;
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.folder ?? 0) - (b.folder ?? 0));
  return {
    status: counts.error ? 'error' : counts.warning ? 'warning' : 'ok',
    issues,
    counts,
  };
}

/**
 * Single files or folders marked write-protected (the FAT read-only
 * attribute, often set by a copy from a CD or by another program). The card
 * itself is writable, so the app only fails at exactly these: renaming,
 * deleting or saving them breaks off. A card whose lock slider is down is a
 * different case, told by "Meine Box" (writeAccess.ts).
 */
function checkReadOnly(scan: SdScan, ctx: HealthContext, add: (i: Issue) => void) {
  const list = scan.readOnly ?? [];
  if (!list.length || ctx.volume?.readOnly || ctx.volume?.writable === false) return;
  const total = scan.readOnlyTotal ?? list.length;
  add({
    id: 'read-only-files',
    severity: 'warning',
    title: total === 1 ? 'Eine Datei auf der Karte ist schreibgeschützt' : `${total} Dateien auf der Karte sind schreibgeschützt`,
    detail:
      'Diese Dateien sind gegen Ändern geschützt, zum Beispiel weil sie von einer CD oder mit einem anderen Programm kopiert wurden. Die Box spielt sie ganz normal. Nur ich kann sie nicht umbenennen, löschen oder ersetzen, dann bricht das Speichern dort ab. „Schutz entfernen“ hebt den Schutz auf, an den Dateien selbst ändert sich nichts.',
    items: list.slice(0, 20),
    ...(total > 20 ? { itemsTotal: total } : {}),
    ...(ctx.canUnlock ? { fix: { kind: 'make-writable' } as FixAction, fixLabel: 'Schutz entfernen' } : {}),
    help: '#/hilfe/sd-karte-schreibrechte',
  });
}

function checkVolume(scan: SdScan, ctx: HealthContext, add: (i: Issue) => void) {
  const v = ctx.volume;
  if (!v) return;
  if (isComputerDrive(v)) {
    // The format and size of the computer's drive say nothing about a card: no alarm about them.
    add({
      id: 'not-a-card',
      severity: 'info',
      title: 'Das ist ein Ordner auf dem Computer',
      detail:
        'Ich arbeite hier in einem Ordner auf deinem Computer, nicht auf einer SD-Karte. Format, Größe und freien Platz der Karte prüfe ich, wenn du die Karte selbst öffnest. Kopierst du den Ordner später auf eine Karte, nimm eine mit FAT32 und höchstens 32 GB.',
      help: FORMAT_HELP,
    });
    return;
  }
  const fs = (v.fsType ?? '').trim();
  const fat = !fs || isFatFilesystem(fs);
  // The SD Card Formatter always writes exFAT on cards over 32 GB (SDXC), so it is no help there.
  const big = !!v.totalBytes && v.totalBytes > 32.5 * GB;
  if (!fs && ctx.formatChecked) {
    // Someone saw FAT32 on a computer: nothing left to guess or to ask.
  } else if (!fs && v.fileTimesFromCard && guessNotFat(scan.fileTimes, scan.catalogTime) === 'not-fat') {
    // The browser does not tell, but the times of the files do (see fsguess.ts). Only a guess, so a
    // warning the parent can answer, not an error: an operating system may report times FAT never stored.
    add({
      id: 'fs-type',
      severity: 'warning',
      title: 'Die SD-Karte ist wahrscheinlich nicht mit FAT32 formatiert',
      detail: `Die Uhrzeiten der Dateien passen zu exFAT oder NTFS, die Box liest aber nur FAT32. ${checkFormat(ctx.system)} Steht dort FAT32, ist die Karte in Ordnung, dann klicke auf „Ist FAT32“. Steht dort exFAT oder NTFS, zeigt dir die Hilfe, wie du die Karte neu formatierst.`,
      help: FORMAT_HELP,
      fix: { kind: 'confirm-fat32' },
      fixLabel: 'Ist FAT32',
    });
  } else if (!fs) {
    // The browser does not tell: say so instead of calling the card fine.
    add({
      id: 'fs-unknown',
      severity: 'info',
      title: 'Das Format der Karte ist nicht bekannt',
      detail: `Ich sehe hier nicht, wie die Karte formatiert ist, und die Box liest nur FAT32. ${checkFormat(ctx.system)} Steht dort exFAT oder NTFS, zeigt dir die Hilfe, wie du die Karte neu formatierst.`,
      help: FORMAT_HELP,
    });
  }
  if (!fat) {
    add({
      id: 'fs-type',
      severity: 'error',
      title: `Die SD-Karte ist als ${v.fsType} formatiert`,
      detail: big
        ? 'Der MP3-Player der Box liest nur FAT32. Karten über 32 GB richtet der „SD Card Formatter“ aber immer mit exFAT ein. Sichere die Inhalte und nimm am besten eine Karte mit höchstens 32 GB.'
        : 'Der MP3-Player der Box liest nur FAT32. Sichere die Inhalte, formatiere die Karte mit FAT32 (am besten mit dem Programm „SD Card Formatter“) und spiele sie danach wieder auf.',
      help: FORMAT_HELP,
    });
  }
  if (big) {
    add({
      id: 'size',
      severity: 'warning',
      title: 'Die SD-Karte ist größer als 32 GB',
      detail:
        'Offiziell unterstützt der MP3-Player Karten bis 32 GB. Größere Karten funktionieren mit manchen, mit anderen nicht. Wenn die Box Probleme macht, nimm eine Karte mit höchstens 32 GB.',
    });
  }
  // Not on big cards: reformatting them as advised would end in exFAT.
  if (v.clusterSize && fs && fat && !big && v.clusterSize < 32 * 1024) {
    add({
      id: 'cluster',
      severity: 'info',
      title: `Kleine Zuordnungseinheiten (${Math.round(v.clusterSize / 1024)} KB)`,
      detail:
        'Im Forum hat sich FAT32 mit 32 KB großen Zuordnungseinheiten bewährt, wie es der „SD Card Formatter“ einrichtet. Bei Stottern oder langen Startzeiten hilft es, die Karte so neu zu formatieren.',
    });
  }
  if (scan.kind === 'tonuino' && scan.rootOrder.length > 1 && ctx.trustsDirectoryOrder) {
    const sysFirst = scan.rootOrder.findIndex((n) => /^\d{2}$/.test(n));
    const lastSys = Math.max(scan.rootOrder.findIndex((n) => n.toLowerCase() === 'mp3'), scan.rootOrder.findIndex((n) => n.toLowerCase() === 'advert'));
    if (sysFirst !== -1 && lastSys > sysFirst) {
      add({
        id: 'root-order',
        severity: 'info',
        title: 'Die Ansagen liegen auf der Karte hinter den Hörspielen',
        detail:
          'Die Ordner „mp3“ und „advert“ mit den Ansagen der Box wurden erst nach den Hörspielen auf die Karte kopiert. Manche MP3-Player in der Box finden die Ansagen schneller, wenn diese beiden Ordner zuerst auf der Karte liegen. Das ist nur wichtig, wenn Ansagen fehlen oder falsch klingen.',
      });
    }
  }
}

function checkTemp(scan: SdScan, add: (i: Issue) => void) {
  if (!scan.tempDirs.length) return;
  const files = scan.tempDirs.reduce((n, t) => n + t.entries.length, 0);
  add({
    id: 'temp',
    severity: 'error',
    title: 'Eine Reparatur wurde unterbrochen',
    detail: files
      ? `Im Hilfsordner der App ${files === 1 ? 'liegt noch 1 Datei' : `liegen noch ${files} Dateien`}. Ich lege sie zurück in ihren Ordner, damit nichts verloren geht.`
      : 'Der Hilfsordner der App ist übrig geblieben, er ist aber leer. Ich räume ihn weg.',
    items: scan.tempDirs.flatMap((t) => t.entries.map((e) => `${t.name}/${e.name}`)).slice(0, 40),
    itemsTotal: files,
    fix: { kind: 'recover-temp' },
    fixLabel: 'Dateien zurücklegen',
  });
}

function checkJunk(scan: SdScan, ctx: HealthContext, add: (i: Issue) => void) {
  const items: string[] = [];
  // On a built-in drive "$RECYCLE.BIN" and friends belong to the computer: hands off.
  const keepRoot = ctx.volume?.removable === false || !!ctx.keepRootJunk;
  if (!keepRoot) for (const e of scan.rootJunk) items.push(e.name);
  // Only the "._" companions of macOS count as tracks for the player, wherever they lie; .DS_Store and the rest do not.
  let inAudio = 0;
  for (const f of scan.folders) for (const e of f.junk) {
    items.push(`${f.name}/${e.name}`);
    if (e.name.startsWith('._')) inAudio++;
  }
  for (const s of Object.values(scan.system)) for (const e of s?.junk ?? []) {
    items.push(`${s!.dirName}/${e.name}`);
    if (e.name.startsWith('._')) inAudio++;
  }
  if (!items.length) return;
  const origins = new Set(items.map((p) => junkOrigin(p.split('/').pop()!)));
  const systems = [origins.has('macos') && 'macOS', origins.has('windows') && 'Windows', origins.has('linux') && 'Linux'].filter((x): x is string => !!x);
  const who = !systems.length ? 'Der Computer hat' : systems.length === 1 ? `${systems[0]} hat` : `${systems.slice(0, -1).join(', ')} und ${systems[systems.length - 1]} haben`;
  const onlyPartial = origins.size === 1 && origins.has('app');
  // Linux keeps deleted files in ".Trash-1000" on the card itself.
  const trash = items.some((p) => /^\.trash/i.test(p)) ? ' Dazu kommt der Papierkorb von Linux, darin liegen noch gelöschte Dateien.' : '';
  const more = items.length - inAudio;
  add({
    id: 'junk',
    severity: inAudio ? 'error' : 'warning',
    title: inAudio
      ? `${inAudio} ${inAudio === 1 ? 'Begleitdatei' : 'Begleitdateien'} von macOS bei den Titeln${more ? `, dazu ${more} weitere versteckte ${more === 1 ? 'Datei' : 'Dateien'}` : ''}`
      : onlyPartial
        ? `${items.length} ${items.length === 1 ? 'Rest' : 'Reste'} von abgebrochenem Speichern`
        : `${items.length} ${items.length === 1 ? 'versteckte Systemdatei' : 'versteckte Systemdateien'}`,
    detail: inAudio
      ? `${who} unsichtbare Begleitdateien angelegt. Der MP3-Player zählt sie als Titel mit und spielt dann Rauschen oder die falsche Datei.${trash}`
      : onlyPartial
        ? 'Beim Speichern wurde etwas abgebrochen. Übrig sind halbfertige Hilfsdateien, die niemand mehr braucht.'
        : `${who} unsichtbare Dateien angelegt. Sie stören die Box meist nicht, gehören aber nicht auf die Karte.${trash}`,
    items,
    fix: keepRoot ? { kind: 'clean-junk', keepRoot } : { kind: 'clean-junk' },
    fixLabel: 'Aufräumen',
  });
}

/**
 * Folders that hold announcements under a misspelt name ("advent") while the
 * system folder of that name is missing. One per system folder: the one with
 * the most announcements.
 */
function systemTypos(scan: SdScan): SdNearSystem[] {
  if (scan.kind !== 'tonuino') return [];
  const best = new Map<SystemDirName, SdNearSystem>();
  for (const t of scan.nearSystem) {
    if (scan.system[t.target] || !t.sounds) continue;
    const seen = best.get(t.target);
    if (!seen || t.sounds > seen.sounds) best.set(t.target, t);
  }
  return [...best.values()];
}

function checkSystem(scan: SdScan, ctx: HealthContext, add: (i: Issue) => void) {
  if (scan.kind !== 'tonuino') return;
  const st = checkSystemSounds(scan, ctx.profile, ctx.tngRelease);
  const typos = systemTypos(scan);
  for (const { entry, target } of typos) {
    add({
      id: `system-typo:${entry.name}`,
      severity: 'error',
      title: `Heißt der Ordner „${entry.name}“ richtig?`,
      detail: `Die Box sucht ihre Ansagen im Ordner „${target}“. Im Ordner „${entry.name}“ liegen Ansagen, doch unter diesem Namen findet die Box sie nicht und bleibt an diesen Stellen stumm („Fehler 6“). Gib dem Ordner den richtigen Namen, die Ansagen darin bleiben, wie sie sind.`,
      items: [`${entry.name}/`],
      fix: { kind: 'rename-root-folder', name: entry.name, to: target },
      fixLabel: `In ${target} umbenennen`,
      help: NAMES_HELP,
    });
  }
  if (st.state === 'missing') {
    // A folder with a misspelt name is not missing: renaming it is the fix (above).
    const absent = (['mp3', 'advert'] as const).filter((n) => !st.present[n] && !typos.some((t) => t.target === n));
    if (absent.length) {
      add({
        id: 'system-missing',
        severity: 'error',
        title: `Die Systemansagen fehlen (Ordner ${absent.join(' und ')})`,
        detail: `Ohne ${absent.length === 1 ? 'diesen Ordner' : 'diese Ordner'} kann die Box keine Ansagen abspielen: kein „Oh, eine neue Karte“, kein Admin-Menü, keine Titelnummern.`,
        fix: { kind: 'install-system-sounds' },
        fixLabel: 'Systemansagen installieren',
      });
    }
  } else if (st.state === 'incomplete' || st.state === 'outdated') {
    // Empty announcements are not missing ones: system-empty below says so.
    const n = st.missing.mp3.length + st.missing.advert.length;
    const core = st.coreMissing.mp3.length + st.coreMissing.advert.length;
    const startTone = ctx.profile === 'tng' && st.coreMissing.mp3.includes(TNG_START_TONE);
    const newer = (k: number) => (k === 1 ? 'eine Ansage, die neuere Firmware-Versionen nutzen' : `${k} Ansagen, die neuere Firmware-Versionen nutzen`);
    let detail: string;
    if (st.state === 'outdated') {
      detail = `Es ${n === 1 ? 'fehlt' : 'fehlen'} ${newer(n)}. Nach einem Firmware-Update gehören auch die passenden Systemansagen auf die Karte.`;
    } else if (startTone && core === 1) {
      // Forum 12980: the one file the box needs whenever a card is put on.
      detail = `Es fehlt ${START_TONE_TEXT}`;
      if (n > 1) detail += ` Außerdem ${n - 1 === 1 ? 'fehlt' : 'fehlen'} ${newer(n - 1)}.`;
    } else {
      const which = core === n ? (n === 1 ? 'eine Ansage, die jede Box braucht' : `${n} Ansagen, die jede Box braucht`) : `${n} Ansagen, darunter ${core === 1 ? 'eine' : 'solche'}, die jede Box braucht`;
      detail = `Es ${n === 1 ? 'fehlt' : 'fehlen'} ${which}. Die Box bricht dann mit „Fehler 6“ ab oder bleibt stumm.`;
      // „Fehler 6“ is said just before: once is enough.
      if (startTone) detail += ` Darunter ist auch ${START_TONE_TEXT.replace(/ \(„Fehler 6“\)\.$/, '.')}`;
    }
    add({
      id: 'system-outdated',
      severity: st.state === 'incomplete' ? 'error' : 'warning',
      title:
        st.state === 'outdated' ? 'Die Systemansagen sind älter als die Firmware' : core === 1 ? 'Eine wichtige Systemansage fehlt' : 'Wichtige Systemansagen fehlen',
      detail,
      items: [
        ...st.missing.mp3.slice(0, 40).map((x) => `mp3/${String(x).padStart(4, '0')}.mp3`),
        ...st.missing.advert.slice(0, 40).map((x) => `advert/${String(x).padStart(4, '0')}.mp3`),
      ],
      itemsTotal: n,
      fix: { kind: 'install-system-sounds' },
      fixLabel: 'Systemansagen aktualisieren',
      help: SOUNDS_HELP,
    });
  }
  for (const name of ['mp3', 'advert'] as const) {
    const dir = scan.system[name];
    if (!dir) continue;
    if (dir.empty.length) {
      add({
        id: `system-empty:${name}`,
        severity: 'error',
        title: `Leere Ansagen im Ordner ${name}`,
        detail: `${dir.empty.length === 1 ? 'Eine Ansage ist' : `${dir.empty.length} Ansagen sind`} leer oder nur halb kopiert, meist weil das Kopieren abgebrochen ist. An diesen Stellen bleibt die Box stumm.`,
        items: dir.empty.map((n) => `${dir.dirName}/${n}`),
        fix: { kind: 'install-system-sounds' },
        fixLabel: 'Systemansagen neu installieren',
        help: SOUNDS_HELP,
      });
    }
    if (dir.wrongDigits.length) {
      add({
        id: `system-digits:${name}`,
        severity: 'error',
        title: `Falsch benannte Ansagen im Ordner ${name}`,
        detail: `Im Ordner ${name} müssen Dateien vierstellig heißen, zum Beispiel 0001.mp3. Sonst findet der MP3-Player der Box sie nicht („File mismatch“).`,
        items: dir.wrongDigits.map((t) => `${dir.dirName}/${t.name}`),
        fix: { kind: 'normalize-system-names' },
        fixLabel: 'Namen korrigieren',
      });
    }
    // Text after the number ("0300_new_tag.mp3", as in packages from the internet). Doubled numbers
    // are left to system-dup: renaming cannot help there.
    const doubled = new Set(st.duplicates[name]);
    const suffixed = dir.files.filter((t) => t.suffix !== '' && !doubled.has(t.number));
    if (suffixed.length) {
      const example = suffixed[0];
      add({
        id: `system-suffix:${name}`,
        severity: 'warning',
        title: `Ansagen mit Text im Namen (Ordner ${name})`,
        detail: `Dateien wie „${example.name}“ findet nicht jeder MP3-Player. Mit der AiO-Platine oder dem LKP-Player kann die Box an diesen Stellen stumm bleiben („Fehler 6“). Reine Nummern wie „${systemTrackName(example.number, example.ext)}“ gehen mit jedem MP3-Player. Kürze die Namen auf die Nummer, die Ansagen selbst bleiben dabei, wie sie sind.`,
        items: suffixed.slice(0, 40).map((t) => `${dir.dirName}/${t.name}`),
        fix: { kind: 'normalize-system-names' },
        fixLabel: 'Sicher umbenennen',
        fixWarning: SAFE_RENAME_WARNING,
      });
    }
    if (st.duplicates[name].length) {
      add({
        id: `system-dup:${name}`,
        severity: 'warning',
        title: `Doppelte Nummern im Ordner ${name}`,
        detail: 'Mehrere Ansagen haben dieselbe Nummer. Der MP3-Player der Box spielt dann zufällig eine davon.',
        items: st.duplicates[name].map((x) => `${dir.dirName}/${String(x).padStart(4, '0')}`),
        fix: { kind: 'install-system-sounds' },
        fixLabel: 'Systemansagen neu installieren',
      });
    }
    const big = st.oversized[name];
    if (big.length) {
      const one = big.length === 1;
      add({
        id: `system-oversized:${name}`,
        severity: 'warning',
        title: one ? `Sehr große Datei im Ordner ${name}` : `${big.length} sehr große Dateien im Ordner ${name}`,
        detail: `Ansagen dauern nur ein paar Sekunden. ${one ? 'Diese Datei ist' : 'Diese Dateien sind'} viel größer, vermutlich ein Hörspiel oder Lied am falschen Platz. Die Box spielt dann ${one ? 'an dieser Stelle' : 'an diesen Stellen'} die lange Datei statt einer kurzen Ansage, ${name === 'mp3' ? 'zum Beispiel beim Anlernen einer Karte' : 'zum Beispiel wenn sie beim Abspielen die Nummer des Titels ansagt'}, und wirkt dabei wie eingefroren. Brauchst du ${one ? 'die Datei' : 'die Dateien'} noch, kopiere sie zuerst auf deinen Computer. Dann installiere die Systemansagen neu.`,
        items: big.slice(0, 40).map((t) => `${dir.dirName}/${t.name} (${decimal.format(t.size / MB)}\u00a0MB)`),
        fix: { kind: 'install-system-sounds' },
        fixLabel: 'Systemansagen neu installieren',
      });
    }
  }
}

function checkFolder(folder: SdFolder, ctx: HealthContext, add: (i: Issue) => void) {
  const name = folder.name;
  const label = `Ordner ${name}`;
  const hasRangeCards = ctx.foldersWithRangeCards?.has(folder.number);
  const renumberWarning = hasRangeCards
    ? 'Für diesen Ordner gibt es Karten, die bestimmte Titelnummern abspielen (Einzeltitel oder von … bis …). Diese Karten musst du danach neu beschreiben.'
    : 'Karten, die einen bestimmten Titel oder einen Bereich von … bis … abspielen, zeigen danach eventuell auf andere Titel.';

  if (!folder.tracks.length && !folder.unnumbered.length && !folder.wrongDigits.length) {
    const reallyEmpty = !folder.others.length && !folder.subfolders.length;
    add({
      id: `empty:${name}`,
      severity: 'warning',
      title: reallyEmpty ? `${label} ist leer` : `${label} enthält keine Audiodateien`,
      detail: 'Eine Karte für diesen Ordner spielt nichts ab, und beim Einrichten von Karten an der Box bricht die Vorschau mit „Fehler 6“ ab.',
      folder: folder.number,
      items: reallyEmpty ? undefined : [...folder.others, ...folder.subfolders].map((e) => `${name}/${e.name}${e.kind === 'directory' ? '/' : ''}`),
      ...(reallyEmpty ? { fix: { kind: 'remove-empty-folder', folder: folder.number } as FixAction, fixLabel: 'Leeren Ordner entfernen' } : {}),
    });
    return;
  }

  if (folder.empty.length) {
    const n = folder.empty.length;
    add({
      id: `empty-tracks:${name}`,
      severity: 'error',
      title: `${label}: ${n === 1 ? 'eine leere Datei' : `${n} leere Dateien`}`,
      detail: `${n === 1 ? 'Diese Datei hat' : 'Diese Dateien haben'} 0 Byte, meist weil das Kopieren abgebrochen ist. Die Box spielt an dieser Stelle nichts ab oder bleibt hängen. Lösche sie und spiel ${n === 1 ? 'den Titel' : 'die Titel'} danach noch einmal auf.`,
      folder: folder.number,
      items: folder.empty.map((x) => `${name}/${x}`),
      fix: { kind: 'remove-empty-tracks', folder: folder.number },
      fixLabel: n === 1 ? 'Leere Datei löschen' : 'Leere Dateien löschen',
    });
  } else if (folder.unfinished?.length) {
    // The same fix deletes both kinds (planRemoveEmptyTracks), so one issue per folder is enough.
    const n = folder.unfinished.length;
    add({
      id: `unfinished-tracks:${name}`,
      severity: 'error',
      title: `${label}: ${n === 1 ? 'ein Titel ist nur halb kopiert' : `${n} Titel sind nur halb kopiert`}`,
      detail: `Beim Kopieren wurde die Karte zu früh herausgezogen oder die Verbindung brach ab. Die Box spielt ${n === 1 ? 'diesen Titel' : 'diese Titel'} nur zum Teil oder bleibt hängen. Lösche ${n === 1 ? 'ihn' : 'sie'} und spiele ${n === 1 ? 'den Titel' : 'die Titel'} danach noch einmal auf.`,
      folder: folder.number,
      items: folder.unfinished.map((x) => `${name}/${x}`),
      fix: { kind: 'remove-empty-tracks', folder: folder.number },
      fixLabel: n === 1 ? 'Halben Titel löschen' : 'Halbe Titel löschen',
    });
  }

  if (folder.tracks.length > MAX_TRACKS || folder.tracks.some((t) => t.number > MAX_TRACKS)) {
    add({
      id: `too-many:${name}`,
      severity: 'error',
      title: `${label} hat mehr als ${MAX_TRACKS} Titel`,
      detail: `Der MP3-Player der Box kann pro Ordner höchstens ${MAX_TRACKS} Titel abspielen. Verteile den Inhalt auf zwei Ordner.`,
      folder: folder.number,
    });
  }

  const dups = duplicateTracks(folder);
  if (dups.length) {
    add({
      id: `dup:${name}`,
      severity: 'error',
      title: `${label}: mehrere Dateien mit derselben Nummer`,
      detail: 'Zum Beispiel 001.mp3 und 001_Startsound.mp3. Der MP3-Player der Box kann nur eine davon abspielen und verzählt sich bei den übrigen Titeln.',
      folder: folder.number,
      items: dups.flat().map((t) => `${name}/${t.name}`),
      fix: { kind: 'resolve-duplicates', folder: folder.number },
      fixLabel: 'Doppelte ans Ende stellen',
      fixWarning: 'Die zusätzlichen Dateien bekommen neue Nummern am Ende des Ordners.',
    });
  }

  if (folder.unnumbered.length) {
    add({
      id: `unnumbered:${name}`,
      severity: 'error',
      title: `${label}: Audiodateien ohne Nummer`,
      detail: 'Der MP3-Player der Box zählt diese Dateien mit, kann sie aber nicht gezielt abspielen. Die Box verzählt sich dann und meldet „Fehler 6“.',
      folder: folder.number,
      items: folder.unnumbered.map((e) => `${name}/${e.name}`),
      fix: { kind: 'number-unnumbered', folder: folder.number },
      fixLabel: 'Nummern vergeben',
    });
  }

  if (folder.wrongDigits.length) {
    add({
      id: `digits:${name}`,
      severity: 'error',
      title: `${label}: Dateinamen mit falscher Stellenzahl`,
      detail: 'Titel in Hörspielordnern müssen dreistellig beginnen, zum Beispiel 001.mp3. Der MP3-Player der Box findet 1.mp3 oder 0001.mp3 nicht.',
      folder: folder.number,
      items: folder.wrongDigits.map((t) => `${name}/${t.name}`),
      fix: { kind: 'normalize-names', folder: folder.number },
      fixLabel: 'Namen korrigieren',
    });
  }

  // Files with the wrong digit count are fixed by renaming, so they do not count as gaps.
  const missing = missingTrackNumbers({ ...folder, tracks: [...folder.tracks, ...folder.wrongDigits.filter((t) => t.number >= 1 && t.number <= MAX_TRACKS)] });
  if (missing.length) {
    add({
      id: `gap:${name}`,
      severity: 'error',
      title: `${label}: Titelnummern fehlen`,
      detail: `${missing.length === 1 ? 'Es fehlt Titel' : 'Es fehlen die Titel'} ${missing.slice(0, 8).map((n) => String(n).padStart(3, '0')).join(', ')}${missing.length > 8 ? ' …' : ''}. Bei einer Lücke bricht die Wiedergabe mit „Fehler 6“ ab.`,
      folder: folder.number,
      fix: { kind: 'close-gaps', folder: folder.number },
      fixLabel: 'Lücken schließen',
      fixWarning: renumberWarning,
    });
  }

  const suffixed = folder.tracks.filter((t) => t.suffix !== '');
  if (suffixed.length) {
    // Forum 14978#71/72: names with letters made errors on a box until they were pure numbers, which work with every player.
    const chosen = ctx.pureNumbers === false;
    add({
      id: `suffix:${name}`,
      severity: chosen ? 'info' : 'warning',
      title: `${label}: Text hinter der Nummer`,
      detail: chosen
        ? 'Dateinamen wie „001 Kapitel 1.mp3“ spielen die meisten MP3-Player in der Box ab. Manche nachgebauten spielen aber nur reine Nummern.'
        : `Dateinamen wie „${suffixed[0].name}“ spielen die meisten MP3-Player in der Box ab, manche nachgebauten aber nicht: Dann bleibt die Box an dieser Stelle stumm oder spielt den falschen Titel. Reine Nummern wie „${String(suffixed[0].number).padStart(3, '0')}.${suffixed[0].ext}“ gehen mit jedem MP3-Player.`,
      folder: folder.number,
      items: suffixed.slice(0, 20).map((t) => `${name}/${t.name}`),
      fix: { kind: 'normalize-names', folder: folder.number, pure: true },
      fixLabel: 'Sicher umbenennen',
      fixWarning: SAFE_RENAME_WARNING,
    });
  }

  // Only next to numbered tracks: the plan may take a picture as the cover, and that needs tracks.
  // While all audio still lacks a number, those issues come first.
  if (folder.tracks.length && folder.others.length) {
    const music = folder.others.some((e) => isUnplayableAudio(e.name));
    add({
      id: `others:${name}`,
      severity: 'warning',
      title: `${label}: Andere Dateien zwischen den Titeln`,
      detail: `In die Ordner der Box gehören nur die nummerierten Titel. ${
        music ? 'Bilder, Listen, Texte und Musik in einem Format, das die Box nicht abspielt,' : 'Bilder, Listen oder Texte'
      } braucht sie nicht. Meldet die Box „Fehler 6“, rät man im Forum, solche Dateien zu entfernen. Entferne sie, deine Titel bleiben dabei, wie sie sind.`,
      folder: folder.number,
      help: NAMES_HELP,
      items: folder.others.map((e) => `${name}/${e.name}`),
      fix: { kind: 'remove-others', folder: folder.number },
      fixLabel: 'Entfernen',
    });
  }

  if (folder.subfolders.length) {
    add({
      id: `subdirs:${name}`,
      severity: 'warning',
      title: `${label} enthält Unterordner`,
      detail: 'Der MP3-Player der Box spielt keine Unterordner ab. Ihr Inhalt bleibt unerreichbar.',
      folder: folder.number,
      items: folder.subfolders.map((e) => `${name}/${e.name}/`),
    });
  }

  if (ctx.trustsDirectoryOrder && !dups.length && isOutOfOrder(folder.tracks)) {
    add({
      id: `order:${name}`,
      severity: 'warning',
      title: `${label}: Reihenfolge auf der Karte stimmt nicht`,
      detail: 'Die Dateien liegen nicht in der Reihenfolge ihrer Nummern auf der Karte. Manche MP3-Player in der Box spielen dann falsche Titel oder zählen falsch.',
      folder: folder.number,
      fix: { kind: 'rebuild-order', folder: folder.number },
      fixLabel: 'Ordner neu ordnen',
    });
  }

  const wav = folder.tracks.filter((t) => t.ext === 'wav');
  if (wav.length) {
    add({
      id: `wav:${name}`,
      severity: 'info',
      title: `${label}: WAV-Dateien`,
      detail: 'WAV-Dateien brauchen etwa zehnmal so viel Platz wie MP3. Beim nächsten Hinzufügen wandle ich sie automatisch um.',
      folder: folder.number,
    });
  }
}

function checkRoot(scan: SdScan, add: (i: Issue) => void) {
  // Folder numbers in use or offered to a rename below, so two folders are never offered the same one.
  const claimed = new Set(scan.folders.map((f) => f.number));
  /** Numbers offered to a rename, with the folder that gets them. */
  const offered = new Map<number, string>();
  for (const e of scan.invalidFolders) {
    const n = Number(e.name);
    if (n >= 1 && n <= MAX_FOLDER && !claimed.has(n)) {
      claimed.add(n);
      offered.set(n, e.name);
      add({
        id: `invalid-folder:${e.name}`,
        severity: 'error',
        title: `Ordner „${e.name}“ wird nicht gefunden`,
        detail: `Ordner müssen zweistellig heißen. Die Box sucht „${folderName(n)}“.`,
        items: [`${e.name}/`],
        fix: { kind: 'rename-invalid-folder', name: e.name, to: n },
        fixLabel: `In ${folderName(n)} umbenennen`,
      });
    } else {
      add({
        id: `invalid-folder:${e.name}`,
        severity: 'warning',
        title: `Ordner „${e.name}“ wird nicht abgespielt`,
        detail: 'Die Box kennt nur die Ordner 01 bis 99 und die Ordner „mp3“ und „advert“ mit ihren Ansagen.',
        items: [`${e.name}/`],
      });
    }
  }

  // Audio folders with text after the number ("02 Bibi"). Without audio files it is some other folder.
  const named = scan.nearFolders.filter((x) => x.audio > 0);
  const blocked: SdNearFolder[] = [];
  for (const near of named) {
    const { entry, number: n, rest } = near;
    if (n < 1 || n > MAX_FOLDER || claimed.has(n)) {
      blocked.push(near);
      continue;
    }
    claimed.add(n);
    offered.set(n, entry.name);
    const target = folderName(n);
    add({
      id: `named-folder:${entry.name}`,
      severity: 'error',
      title: `Ordner „${entry.name}“ wird nicht abgespielt`,
      detail: `Die Box findet nur Ordner, die genau „${target}“ heißen, ohne Text dahinter. Benenne ihn um: Den Namen „${rest}“ übernehme ich als Titel, die Dateien darin bleiben, wie sie sind.`,
      items: [`${entry.name}/`],
      fix: { kind: 'rename-invalid-folder', name: entry.name, to: n, title: rest },
      fixLabel: `In ${target} umbenennen`,
      help: NAMES_HELP,
    });
  }
  // The number is taken: which other one is right, only the user knows (the cards of the box point to numbers).
  for (const { entry, number: n } of blocked) {
    const other = offered.get(n);
    const why =
      n < 1 || n > MAX_FOLDER
        ? 'Die Box kennt nur die Ordner 01 bis 99 und die Ordner „mp3“ und „advert“ mit ihren Ansagen.'
        : other !== undefined
          ? `Die Box findet nur Ordner, die genau „${folderName(n)}“ heißen, und die Nummer ${folderName(n)} ist schon für den Ordner „${other}“ vorgesehen.`
          : `Die Box findet nur Ordner, die genau „${folderName(n)}“ heißen, und die Nummer ${folderName(n)} hat schon ein anderer Ordner.`;
    const free = nextFolderNumber(scan, claimed);
    if (free !== null) claimed.add(free);
    add({
      id: `named-folder:${entry.name}`,
      severity: 'warning',
      title: `Ordner „${entry.name}“ wird nicht abgespielt`,
      detail:
        free === null
          ? `${why} Auf der Karte ist auch keine andere Nummer mehr frei.`
          : `${why} Benenne ihn am Computer in eine freie Nummer um, zum Beispiel „${folderName(free)}“, und beschreibe dann eine Karte dafür.`,
      items: [`${entry.name}/`],
      help: NAMES_HELP,
    });
  }

  // Reported above or in checkSystem, so not again as "other files".
  const reported = new Set([...named.map((x) => x.entry.name), ...systemTypos(scan).map((t) => t.entry.name)]);
  const others = scan.rootOthers.filter((e) => !reported.has(e.name));
  if (others.length) {
    add({
      id: 'root-others',
      severity: 'info',
      title: 'Andere Dateien auf der Karte',
      detail: 'Die Box ignoriert sie. Sie belegen nur Platz.',
      items: others.map((e) => (e.kind === 'directory' ? `${e.name}/` : e.name)),
    });
  }
}
