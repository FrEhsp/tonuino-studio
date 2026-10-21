import type { Dir } from '../../platform/types';
import { buildSmallId3, readTags, replaceTags } from '../audio/id3';
import { unusedFolderNumbers, type Catalog } from './catalog';
import type { FixAction, HealthReport, Issue } from './health';
import {
  duplicateTracks,
  folderName,
  helperFolders,
  helperTrackName,
  isJunk,
  isUnplayableAudio,
  MAX_FOLDER,
  MAX_TRACKS,
  nextFolderNumber,
  OPEN_SUFFIX,
  parseFolderNumber,
  parseHelperTrackName,
  parseNumberedAudio,
  REORDER_DONE_MARKER,
  REORDER_MARKER,
  scanSd,
  swapHelperName,
  swapMarkerName,
  tempDirName,
  type SdFolder,
  type SdScan,
  type SdTempDir,
  type SdTrack,
} from './sd';

/**
 * Repairs are planned first and shown to the user, then executed step by
 * step. Every step is a single, simple file operation.
 */

export type Path = string[];

export type PlanStep =
  /** `ifEmpty`: only while the file still has 0 bytes. */
  | { op: 'delete'; path: Path; recursive?: boolean; ifEmpty?: boolean }
  /** Removes a directory that holds nothing but junk files; fails otherwise, so nothing is lost. */
  | { op: 'rmdir'; path: Path }
  | { op: 'rename'; dir: Path; from: string; to: string }
  | { op: 'move'; from: Path; toDir: Path; name: string }
  /** `fresh`: fails when the folder is already there (a helper folder is never shared with an older repair). */
  | { op: 'mkdir'; path: Path; fresh?: boolean }
  /** Removes the write protection of entries below the card ("05/003.mp3"); none listed: of everything. */
  | { op: 'unlock'; paths: string[] }
  /**
   * Writes `title` into the ID3 title of an MP3 whose title is empty, so the
   * words of its name stay when a rename drops them (forum 14978#71/72).
   * Other files, and files with a title, stay as they are.
   */
  | { op: 'title'; dir: Path; file: string; title: string };

export interface RepairPlan {
  title: string;
  /** Plain-language lines for the preview, at most a few dozen. */
  summary: string[];
  steps: PlanStep[];
  /** Things the plan cannot fix automatically. */
  leftovers: string[];
  /** The steps do not build on each other: one that fails is skipped and the others still run. */
  bestEffort?: boolean;
  /** A folder renamed into place gets this title, when the catalog has no entry for it yet (see noteNewFolder). */
  newTitle?: { folder: number; title: string };
  /** A picture the app takes as the cover of the folder before the steps delete it (see planRemoveOthers). */
  takeCover?: { folder: number; file: string };
  /**
   * Index of the step from which an interrupted run comes back with the new
   * names ("Dateien zurücklegen" then gives the tracks their new numbers, see
   * planReorder). The catalog switches to those names right before that step
   * (executePlan calls `beforeCommit`), marked with CatalogFolder.renumbered,
   * so it fits the tracks whether the run stops before or after the step.
   */
  commitAt?: number;
  /** Two folders swap their numbers (planSwapFolders); the catalog swaps them at `commitAt`. */
  swap?: { a: number; b: number };
}

export interface PlanOptions {
  /** Use pure numbers ("001.mp3") when renaming. */
  pureNumbers?: boolean;
  /** The catalog of the card, so the preview can say what happens to titles and covers. */
  catalog?: Pick<Catalog, 'folders' | 'swap'> | null;
}

export function planFix(scan: SdScan, fix: FixAction, opts: PlanOptions = {}): RepairPlan {
  switch (fix.kind) {
    case 'clean-junk':
      return planCleanJunk(scan, !!fix.keepRoot);
    case 'remove-empty-tracks':
      return planRemoveEmptyTracks(folderOf(scan, fix.folder));
    case 'normalize-names':
      return planNormalizeNames(folderOf(scan, fix.folder), fix.pure ? { ...opts, pureNumbers: true } : opts, scan.tempDirs);
    case 'close-gaps':
      return planCloseGaps(folderOf(scan, fix.folder), opts);
    case 'resolve-duplicates':
      return planResolveDuplicates(folderOf(scan, fix.folder), opts);
    case 'number-unnumbered':
      return planNumberUnnumbered(folderOf(scan, fix.folder), opts);
    case 'remove-empty-folder': {
      const f = folderOf(scan, fix.folder);
      return {
        title: `Ordner ${f.name} entfernen`,
        summary: [`Der leere Ordner ${f.name} wird gelöscht.`],
        steps: [{ op: 'rmdir', path: [f.name] }],
        leftovers: [],
      };
    }
    case 'remove-others':
      return planRemoveOthers(folderOf(scan, fix.folder), opts.catalog);
    case 'rename-invalid-folder':
      return planRenameFolder(scan, fix, opts.catalog);
    case 'rename-root-folder': {
      const title = `Ordner „${fix.name}“ umbenennen`;
      if (scan.system[fix.to]) return { title, summary: [], steps: [], leftovers: [`Den Ordner ${fix.to} gibt es schon. Lies die Karte neu ein.`] };
      return {
        title,
        summary: [`„${fix.name}“ heißt danach „${fix.to}“.`, 'Die Ansagen darin bleiben, wie sie sind.'],
        steps: [{ op: 'rename', dir: [], from: fix.name, to: fix.to }],
        leftovers: [],
      };
    }
    case 'rebuild-order':
      return planRebuildOrder(folderOf(scan, fix.folder), scan.tempDirs);
    case 'normalize-system-names':
      return planNormalizeSystemNames(scan);
    case 'recover-temp':
      return planRecoverTemp(scan, opts.catalog);
    case 'install-system-sounds':
      throw new Error('Dieser Schritt wird mit dem Systemansagen-Assistenten ausgeführt.');
    case 'confirm-fat32':
      throw new Error('Diesen Schritt bestätigst du direkt im Gesundheitscheck.');
    case 'make-writable': {
      const paths = scan.readOnly ?? [];
      const all = (scan.readOnlyTotal ?? 0) > paths.length;
      const n = scan.readOnlyTotal ?? paths.length;
      return {
        title: 'Schreibschutz entfernen',
        summary: [n === 1 ? 'Bei einer Datei wird der Schreibschutz aufgehoben.' : `Bei ${n} Dateien wird der Schreibschutz aufgehoben.`, 'Die Dateien selbst bleiben, wie sie sind.'],
        steps: [{ op: 'unlock', paths: all ? [] : paths }],
        leftovers: [],
      };
    }
  }
}

/** FAT ignores case, so "001.MP3" → "001.mp3" is not a rename worth doing. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function folderOf(scan: SdScan, n: number): SdFolder {
  const f = scan.folders.find((x) => x.number === n);
  if (!f) throw new Error(`Ordner ${folderName(n)} gibt es nicht mehr. Lies die Karte neu ein.`);
  return f;
}

function trackFileName(n: number, t: { suffix: string; ext: string }, pure: boolean | undefined): string {
  return `${String(n).padStart(3, '0')}${pure ? '' : t.suffix}.${t.ext}`;
}

/** A helper folder of an earlier repair of this folder that still holds files. */
function pendingHelper(folder: SdFolder, tempDirs: SdTempDir[] | undefined): string | null {
  if (!tempDirs?.some((t) => helperFolders(t).includes(folder.number))) return null;
  return `Eine frühere Änderung an Ordner ${folder.name} wurde unterbrochen. Lege zuerst die Dateien zurück: Tippe unter „Meine Box“ auf „Ansehen und reparieren“ und dann auf „Dateien zurücklegen“.`;
}

function planCleanJunk(scan: SdScan, keepRoot: boolean): RepairPlan {
  const steps: PlanStep[] = [];
  const remove = (path: Path, kind: 'file' | 'directory') => steps.push({ op: 'delete', path, recursive: kind === 'directory' });
  // Audio folders first: there the player counts junk as tracks. The top level
  // comes last, operating systems protect some of it (".Spotlight-V100" on a Mac).
  for (const f of scan.folders) for (const e of f.junk) remove([f.name, e.name], e.kind);
  for (const s of Object.values(scan.system)) {
    if (!s) continue;
    for (const e of s.junk) remove([s.dirName, e.name], e.kind);
  }
  if (!keepRoot) for (const e of scan.rootJunk) remove([e.name], e.kind);
  const dirs = steps.filter((st) => st.op === 'delete' && st.recursive).length;
  const filesOnly = steps.length - dirs;
  const what = [
    filesOnly ? (filesOnly === 1 ? '1 versteckte Datei' : `${filesOnly} versteckte Dateien`) : '',
    dirs ? (dirs === 1 ? '1 versteckter Ordner' : `${dirs} versteckte Ordner`) : '',
  ]
    .filter(Boolean)
    .join(' und ');
  return {
    title: 'Versteckte Dateien entfernen',
    summary: [
      `${what} ${steps.length === 1 ? 'wird' : 'werden'} gelöscht.`,
      'Deine Hörspiele, die Systemansagen und der Katalog bleiben unverändert.',
    ],
    steps,
    leftovers: [],
    bestEffort: true,
  };
}

function planRemoveEmptyTracks(folder: SdFolder): RepairPlan {
  const n = folder.empty.length;
  const cut = folder.unfinished ?? [];
  const summary: string[] = [];
  if (n) summary.push(`${n === 1 ? 'Diese Datei hat' : `Diese ${n} Dateien haben`} 0 Byte und ${n === 1 ? 'wird' : 'werden'} gelöscht:`, ...folder.empty.slice(0, 20));
  if (cut.length) summary.push(`${cut.length === 1 ? 'Dieser Titel ist' : `Diese ${cut.length} Titel sind`} nur halb kopiert und ${cut.length === 1 ? 'wird' : 'werden'} gelöscht:`, ...cut.slice(0, 20));
  summary.push('Spiele die fehlenden Titel danach noch einmal auf.');
  return {
    title: n ? `Leere Dateien in Ordner ${folder.name} löschen` : `Halbe Titel in Ordner ${folder.name} löschen`,
    summary,
    steps: [
      ...folder.empty.map((name): PlanStep => ({ op: 'delete', path: [folder.name, name], ifEmpty: true })),
      // The half file, then its marker (sd.ts OPEN_SUFFIX): a marker without file is mere junk.
      ...cut.flatMap((name): PlanStep[] => [
        { op: 'delete', path: [folder.name, name] },
        { op: 'delete', path: [folder.name, `${name}${OPEN_SUFFIX}`] },
      ]),
    ],
    leftovers: [],
    bestEffort: true,
  };
}

/** Names programs and players give the cover picture of an album, best first. */
const COVER_NAMES = [/^folder\.(jpe?g|png)$/i, /^cover\.(jpe?g|png)$/i, /^front\.(jpe?g|png)$/i, /^albumart.*large\.(jpe?g|png)$/i];
const IMAGE = /\.(jpe?g|png)$/i;

/** The picture of a folder that makes a good cover: a known cover name, otherwise its only picture. */
export function coverCandidate(names: string[]): string | undefined {
  for (const re of COVER_NAMES) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  // Thumbnails ("AlbumArtSmall.jpg") are too small for a sticker.
  const images = names.filter((n) => IMAGE.test(n) && !/small/i.test(n));
  return images.length === 1 ? images[0] : undefined;
}

/**
 * Deletes everything in a folder that is neither a track nor junk: pictures,
 * playlists, texts. A picture that would make a good cover becomes the cover
 * first, when the folder has none yet; the dialog does that before the steps run.
 */
function planRemoveOthers(folder: SdFolder, catalog: PlanOptions['catalog']): RepairPlan {
  const files = folder.others.map((e) => e.name).sort(collator.compare);
  const entry = catalog?.folders[folder.name];
  const summary: string[] = [];
  // Only when there is no cover yet. A folder the catalog does not know is first taken over from the tags of its tracks, so it needs tracks.
  const canTakeCover = entry ? !entry.cover : folder.tracks.length > 0;
  const cover = canTakeCover ? coverCandidate(files) : undefined;
  if (cover) {
    summary.push(
      entry
        ? `Das Bild ${cover} übernehme ich vorher als Cover.`
        : `Ordner ${folder.name} kenne ich noch nicht. Ich übernehme ihn vorher mit den Angaben aus den Dateien und das Bild ${cover} als Cover.`,
    );
  }
  const n = files.length;
  summary.push(n === 1 ? 'Diese Datei wird gelöscht:' : `Diese ${n} Dateien werden gelöscht:`, ...files.slice(0, 20));
  if (n > 20) summary.push(`… und ${n - 20} weitere.`);
  const music = files.filter(isUnplayableAudio);
  if (music.length) {
    const one = music.length === 1;
    summary.push(
      `${one ? `${music[0]} ist` : `${music.length} Dateien davon sind`} Musik in einem Format, das die Box nicht abspielen kann. Brauchst du sie noch, kopiere sie vorher auf deinen Computer und füge sie dann über „Hinzufügen“ wieder hinzu. Ich wandle sie dabei in MP3 um.`,
    );
  }
  summary.push('Deine Titel bleiben, wie sie sind.');
  return {
    title: `Andere Dateien aus Ordner ${folder.name} entfernen`,
    summary,
    steps: files.map((name): PlanStep => ({ op: 'delete', path: [folder.name, name] })),
    leftovers: [],
    bestEffort: true,
    ...(cover ? { takeCover: { folder: folder.number, file: cover } } : {}),
  };
}

/** "5" → "05", "02 Bibi" → "02"; the text after the number can become the title. */
function planRenameFolder(scan: SdScan, fix: Extract<FixAction, { kind: 'rename-invalid-folder' }>, catalog: PlanOptions['catalog']): RepairPlan {
  const to = folderName(fix.to);
  const title = `Ordner „${fix.name}“ umbenennen`;
  if (scan.folders.some((f) => f.number === fix.to)) {
    return { title, summary: [], steps: [], leftovers: [`Ordner ${to} gibt es schon. Lies die Karte neu ein.`] };
  }
  const summary = [`„${fix.name}“ heißt danach „${to}“.`];
  const known = catalog?.folders[to];
  if (fix.title && known) summary.push(`Ordner ${to} kenne ich schon als „${known.title}“ und behalte diesen Titel.`);
  else if (fix.title) summary.push(`Den Namen „${fix.title}“ übernehme ich als Titel.`);
  return {
    title,
    summary,
    steps: [{ op: 'rename', dir: [], from: fix.name, to }],
    leftovers: [],
    ...(fix.title && !known ? { newTitle: { folder: fix.to, title: fix.title } } : {}),
  };
}

/**
 * Gives a folder renamed into place ("02 Bibi" → "02") the title from its old
 * name, when the catalog has no entry for it yet. For the `prepare` step of
 * catalogAfterRepair; does nothing when the rename did not run.
 */
export function noteNewFolder(c: Catalog, plan: RepairPlan, done: PlanStep[]): void {
  const t = plan.newTitle;
  if (!t) return;
  const name = folderName(t.folder);
  if (c.folders[name] || !done.some((s) => s.op === 'rename' && !s.dir.length && s.to === name)) return;
  const now = Date.now();
  c.folders[name] = { title: t.title, tracks: [], addedAt: now, updatedAt: now };
}

/**
 * Numbers a folder can move to (audit 0.4 #6): free on the card and in the
 * catalog. A number also counts as taken while a misnamed folder ("5",
 * "05 Bibi") waits to be renamed into it, and while the catalog still lists
 * a folder under it that is missing on the card, so its title and cover are
 * never handed to another folder by accident.
 */
export function renumberTargets(scan: SdScan, catalog?: Pick<Catalog, 'folders'> | null): number[] {
  const waiting = new Set<number>([...scan.invalidFolders.map((e) => Number(e.name)), ...scan.nearFolders.map((n) => n.number)]);
  for (const t of scan.tempDirs) for (const n of helperFolders(t)) waiting.add(n);
  return unusedFolderNumbers(scan, catalog ?? null).filter((n) => !waiting.has(n));
}

/**
 * Gives a folder another number ("45" → "05", audit 0.4 #6). It is one
 * rename of the folder, and every platform does that as a whole or not at
 * all: the desktop and Android rename it in place, the browser moves it, or
 * copies it, checks every file and only then removes the original (FsaDir).
 * Moving the tracks one by one through the helper folder like planReorder
 * would leave half of them under each number when the run stops.
 */
export function planRenumberFolder(scan: SdScan, from: number, to: number, catalog?: Pick<Catalog, 'folders'> | null): RepairPlan {
  const name = folderName(from);
  const target = folderName(to);
  const title = `Ordner ${name} bekommt die Nummer ${target}`;
  const stop = (why: string): RepairPlan => ({ title, summary: [], steps: [], leftovers: [why] });
  const folder = scan.folders.find((f) => f.number === from);
  if (!folder) return stop(`Ordner ${name} gibt es auf der Karte nicht mehr. Lies die Karte neu ein.`);
  if (to === from || to < 1 || to > MAX_FOLDER || !renumberTargets(scan, catalog).includes(to)) return stop(`Die Nummer ${target} ist nicht frei.`);
  if (scan.tempDirs.some((t) => t.folder === null || helperFolders(t).includes(from))) {
    return stop('Eine frühere Änderung wurde unterbrochen, ein Teil der Dateien wartet noch im Hilfsordner. Lege sie erst zurück, unter „Meine Box“ mit „Ansehen und reparieren“.');
  }
  if (scan.readOnly?.includes(name)) return stop(`Ordner ${name} ist schreibgeschützt. Hebe den Schutz erst unter „Meine Box“ mit „Ansehen und reparieren“ auf.`);
  const known = catalog?.folders[name];
  return {
    title,
    summary: [`${known ? `„${known.title}“` : `Ordner ${name}`} liegt danach in Ordner ${target}, mit allen Titeln${known?.cover ? ' und dem Cover' : ''}.`],
    steps: [{ op: 'rename', dir: [], from: name, to: target }],
    leftovers: [],
  };
}

/**
 * Checks a renumbered folder against how it looked before: every file is
 * there under the new number with the same size, and the old number is
 * gone. Null when all is well, else what is wrong, in plain German.
 */
export function checkRenumbered(before: SdFolder, scan: SdScan, to: number): string | null {
  const moved = checkArrived(before, scan, to);
  if (moved) return moved;
  if (scan.folders.some((f) => f.number === before.number)) return `Ordner ${before.name} ist noch auf der Karte.`;
  return null;
}

/** Every file of `before` is in folder `to` now, with the same size. */
function checkArrived(before: SdFolder, scan: SdScan, to: number): string | null {
  const after = scan.folders.find((f) => f.number === to);
  if (!after) return `Ordner ${folderName(to)} ist nicht auf der Karte.`;
  const files = (f: SdFolder) =>
    new Map([...f.tracks, ...f.wrongDigits, ...f.unnumbered, ...f.others].map((e) => [e.name.toLowerCase(), e.size ?? -1] as const));
  const was = files(before);
  const now = files(after);
  const missing = [...was].filter(([n, size]) => now.get(n) !== size).map(([n]) => n);
  if (missing.length) {
    const what = missing.length === 1 ? 'fehlt eine Datei oder ist anders groß' : `fehlen ${missing.length} Dateien oder sind anders groß`;
    return `In Ordner ${folderName(to)} ${what} als vorher (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}).`;
  }
  return null;
}

/** Folders a folder can swap its number with: every other folder on the card, also when all 99 are taken. */
export function swapTargets(scan: SdScan, folder: number): number[] {
  return scan.folders.map((f) => f.number).filter((n) => n !== folder);
}

/**
 * Two folders swap their numbers ("05" ↔ "12"), nothing else moves. Each
 * goes as a whole into a helper folder named after both numbers, then each
 * comes out under the other number. The helpers lie outside 01 to 99, so
 * this works with all 99 folders taken.
 *
 * In between, an empty marker folder says the swap goes forward. Right
 * before it appears the catalog is written with the folders swapped and
 * Catalog.swap set (RepairPlan.commitAt). An interrupted run is put right
 * by "Dateien zurücklegen" (planRecoverTemp): without the marker and the
 * note each helper goes back to its old number, with either of them to its
 * new one. Every rename is of a whole folder; where the browser moves one
 * file at a time, putting back joins what arrived with what still waits,
 * so nothing is lost wherever the run stops.
 */
export function planSwapFolders(scan: SdScan, a: number, b: number): RepairPlan {
  const na = folderName(a);
  const nb = folderName(b);
  const title = `Ordner ${na} und ${nb} tauschen ihre Nummern`;
  const stop = (why: string): RepairPlan => ({ title, summary: [], steps: [], leftovers: [why] });
  for (const n of [a, b]) {
    if (!scan.folders.some((f) => f.number === n)) return stop(`Ordner ${folderName(n)} gibt es auf der Karte nicht mehr. Lies die Karte neu ein.`);
  }
  if (a === b) return stop('Ein Ordner kann nicht mit sich selbst tauschen.');
  if (scan.tempDirs.length) {
    return stop('Eine frühere Änderung wurde unterbrochen, ein Teil der Dateien wartet noch im Hilfsordner. Lege sie erst zurück, unter „Meine Box“ mit „Ansehen und reparieren“.');
  }
  for (const n of [na, nb]) {
    if (scan.readOnly?.includes(n)) return stop(`Ordner ${n} ist schreibgeschützt. Hebe den Schutz erst unter „Meine Box“ mit „Ansehen und reparieren“ auf.`);
  }
  const ha = swapHelperName(a, b);
  const hb = swapHelperName(b, a);
  const marker = swapMarkerName(a, b);
  const steps: PlanStep[] = [
    { op: 'rename', dir: [], from: na, to: ha },
    { op: 'rename', dir: [], from: nb, to: hb },
    { op: 'mkdir', path: [marker], fresh: true },
    { op: 'rename', dir: [], from: hb, to: na },
    { op: 'rename', dir: [], from: ha, to: nb },
    { op: 'rmdir', path: [marker] },
  ];
  return { title, summary: [`Ordner ${na} wird ${nb}, Ordner ${nb} wird ${na}.`], steps, leftovers: [], commitAt: 2, swap: { a, b } };
}

/** Checks a swap against how both folders looked before: each one's files under the other number. */
export function checkSwapped(beforeA: SdFolder, beforeB: SdFolder, scan: SdScan): string | null {
  return checkArrived(beforeA, scan, beforeB.number) ?? checkArrived(beforeB, scan, beforeA.number);
}

/**
 * The words of a name the number goes without ("0007_Intro.mp3" → "Intro",
 * "001 Der_Hund.mp3" → "Der Hund"); undefined when there are none.
 */
export function titleFromSuffix(suffix: string): string | undefined {
  const t = suffix.replace(/[_]+/g, ' ').replace(/^[\s\-.]+/, '').replace(/\s+/g, ' ').trim();
  return /\p{L}/u.test(t) ? t : undefined;
}

/** Before a rename that drops the words after the number: those words into the file's title, when it has none. */
function keepWords(dir: string, t: { name: string; suffix: string; ext: string }, target: string): PlanStep[] {
  const words = t.ext === 'mp3' && target.toLowerCase() !== t.name.toLowerCase() && !target.includes(t.suffix) ? titleFromSuffix(t.suffix) : undefined;
  return words ? [{ op: 'title', dir: [dir], file: t.name, title: words }] : [];
}

/** The line for the preview when words go into titles. */
export const KEEP_WORDS_LINE = 'Die Reihenfolge bleibt. Hat eine Datei noch keinen Titel, schreibe ich die Wörter aus ihrem alten Namen hinein, damit sie nicht verloren gehen.';

function planNormalizeNames(folder: SdFolder, opts: PlanOptions, tempDirs?: SdTempDir[]): RepairPlan {
  const title = `Dateinamen in Ordner ${folder.name} korrigieren`;
  const steps: PlanStep[] = [];
  const leftovers: string[] = [];
  const taken = new Set(folder.tracks.map((t) => t.name.toLowerCase()));
  const all: SdTrack[] = [...folder.tracks, ...folder.wrongDigits].sort((a, b) => a.number - b.number || a.order - b.order);
  const dupNumbers = new Set(duplicateTracks(folder).flat().map((t) => t.number));
  /** Old name → new name of the tracks that get one. */
  const renamed = new Map<string, string>();
  for (const t of all) {
    if (t.number < 1 || t.number > MAX_TRACKS) {
      leftovers.push(`${folder.name}/${t.name}: Nummer ${t.number} ist zu groß.`);
      continue;
    }
    const target = trackFileName(t.number, t, opts.pureNumbers ?? true);
    if (sameName(target, t.name)) continue;
    if (dupNumbers.has(t.number) || taken.has(target.toLowerCase())) {
      leftovers.push(`${folder.name}/${t.name}: Nummer ${t.number} ist doppelt vergeben.`);
      continue;
    }
    taken.delete(t.name.toLowerCase());
    taken.add(target.toLowerCase());
    steps.push(...keepWords(folder.name, t, target));
    renamed.set(t.name, target);
  }
  const lines = [...renamed].slice(0, 30).map(([from, to]) => `${from} → ${to}`);
  const summary = [...(steps.some((s) => s.op === 'title') ? [KEEP_WORDS_LINE] : []), ...lines];
  if (!renamed.size) return { title, summary, steps, leftovers };
  // A renamed file gets a new entry in the folder, mostly at its end: renamed in place, the tracks would
  // no longer lie in the order of their numbers on the card, which is what some MP3 players play by.
  // So they move through the helper folder in that order and come back under their new names, as in
  // "Ordner neu ordnen" (planRebuildOrder); an interruption is put back by planRecoverTemp.
  const pending = folder.subfolders.length ? `Ordner ${folder.name} enthält Unterordner. Verschiebe sie zuerst.` : pendingHelper(folder, tempDirs);
  if (pending) {
    for (const [from, to] of renamed) steps.push({ op: 'rename', dir: [folder.name], from, to });
    return { title, summary, steps, leftovers };
  }
  const temp = tempDirName(folder.number);
  const names = [...all.map((t) => t.name), ...[...folder.unnumbered, ...folder.others].map((e) => e.name).sort(collator.compare)];
  steps.push({ op: 'mkdir', path: [temp], fresh: true });
  for (const n of names) steps.push({ op: 'move', from: [folder.name, n], toDir: [temp], name: renamed.get(n) ?? n });
  steps.push({ op: 'rmdir', path: [folder.name] });
  steps.push({ op: 'mkdir', path: [folder.name] });
  for (const n of names) steps.push({ op: 'move', from: [temp, renamed.get(n) ?? n], toDir: [folder.name], name: renamed.get(n) ?? n });
  steps.push({ op: 'rmdir', path: [temp] });
  return { title, summary, steps, leftovers };
}

function planCloseGaps(folder: SdFolder, opts: PlanOptions): RepairPlan {
  if (duplicateTracks(folder).length) {
    return { title: 'Lücken schließen', summary: [], steps: [], leftovers: ['Erst die doppelten Nummern auflösen.'] };
  }
  if (folder.wrongDigits.length) {
    return { title: 'Lücken schließen', summary: [], steps: [], leftovers: ['Erst die Dateinamen korrigieren.'] };
  }
  const steps: PlanStep[] = [];
  folder.tracks.forEach((t, i) => {
    const n = i + 1;
    if (n !== t.number) steps.push({ op: 'rename', dir: [folder.name], from: t.name, to: trackFileName(n, t, opts.pureNumbers) });
  });
  return {
    title: `Lücken in Ordner ${folder.name} schließen`,
    summary: [
      `${steps.length} ${steps.length === 1 ? 'Titel rückt' : 'Titel rücken'} nach vorn, die Reihenfolge bleibt gleich.`,
      ...steps.slice(0, 20).map((s) => (s.op === 'rename' ? `${s.from} → ${s.to}` : '')),
    ],
    steps,
    leftovers: [],
  };
}

function planResolveDuplicates(folder: SdFolder, opts: PlanOptions): RepairPlan {
  const groups = duplicateTracks(folder);
  let next = folder.tracks.reduce((m, t) => Math.max(m, t.number), 0) + 1;
  const steps: PlanStep[] = [];
  const leftovers: string[] = [];
  const summary: string[] = [];
  for (const g of groups) {
    const keep = g.find((t) => t.suffix === '') ?? [...g].sort((a, b) => a.order - b.order)[0];
    summary.push(`${keep.name} behält die Nummer ${String(keep.number).padStart(3, '0')}.`);
    for (const t of g) {
      if (t === keep) continue;
      if (next > MAX_TRACKS) {
        leftovers.push(`${folder.name}/${t.name}: kein Platz mehr im Ordner.`);
        continue;
      }
      const to = trackFileName(next++, t, opts.pureNumbers);
      steps.push({ op: 'rename', dir: [folder.name], from: t.name, to });
      summary.push(`${t.name} → ${to}`);
    }
  }
  return { title: `Doppelte Nummern in Ordner ${folder.name} auflösen`, summary, steps, leftovers };
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Tracks in number order first, everything else by name. */
function byTrackName(a: string, b: string): number {
  const pa = parseNumberedAudio(a);
  const pb = parseNumberedAudio(b);
  if (pa && pb) return pa.number - pb.number;
  if (pa || pb) return pa ? -1 : 1;
  return collator.compare(a, b);
}

function planNumberUnnumbered(folder: SdFolder, opts: PlanOptions): RepairPlan {
  let next = folder.tracks.reduce((m, t) => Math.max(m, t.number), 0) + 1;
  const steps: PlanStep[] = [];
  const leftovers: string[] = [];
  const files = [...folder.unnumbered].sort((a, b) => collator.compare(a.name, b.name));
  const pure = opts.pureNumbers ?? true;
  for (const e of files) {
    const ext = (/\.(mp3|wav)$/i.exec(e.name)?.[1] ?? 'mp3').toLowerCase();
    if (next > MAX_TRACKS) {
      leftovers.push(`${folder.name}/${e.name}: kein Platz mehr im Ordner.`);
      continue;
    }
    const parsed = parseNumberedAudio(e.name);
    const suffix = pure || parsed ? '' : ` ${e.name.replace(/\.(mp3|wav)$/i, '').replace(/^\d+\s*[-_.]?\s*/, '')}`.trimEnd();
    const to = `${String(next++).padStart(3, '0')}${suffix}.${ext}`;
    steps.push({ op: 'rename', dir: [folder.name], from: e.name, to });
  }
  return {
    title: `Dateien in Ordner ${folder.name} nummerieren`,
    summary: steps.map((s) => (s.op === 'rename' ? `${s.from} → ${s.to}` : '')),
    steps,
    leftovers,
  };
}

/**
 * Rewrites a folder so the directory entries are in number order: move all
 * files to a helper folder, recreate the folder, move them back in order.
 * Every step only moves directory entries, the audio data is not copied.
 */
function planRebuildOrder(folder: SdFolder, tempDirs?: SdTempDir[]): RepairPlan {
  const title = `Ordner ${folder.name} neu ordnen`;
  if (folder.subfolders.length) {
    return { title, summary: [], steps: [], leftovers: [`Ordner ${folder.name} enthält Unterordner. Verschiebe sie zuerst, dann kann ich den Ordner neu ordnen.`] };
  }
  const pending = pendingHelper(folder, tempDirs);
  if (pending) return { title, summary: [], steps: [], leftovers: [pending] };
  const temp = tempDirName(folder.number);
  const byNumber = (a: SdTrack, b: SdTrack) => a.number - b.number || a.order - b.order;
  const names = [
    ...[...folder.tracks].sort(byNumber).map((t) => t.name),
    ...[...folder.wrongDigits].sort(byNumber).map((t) => t.name),
    ...[...folder.unnumbered, ...folder.others].map((e) => e.name).sort(collator.compare),
  ];
  const steps: PlanStep[] = [{ op: 'mkdir', path: [temp], fresh: true }];
  for (const n of names) steps.push({ op: 'move', from: [folder.name, n], toDir: [temp], name: n });
  steps.push({ op: 'rmdir', path: [folder.name] });
  steps.push({ op: 'mkdir', path: [folder.name] });
  for (const n of names) steps.push({ op: 'move', from: [temp, n], toDir: [folder.name], name: n });
  steps.push({ op: 'rmdir', path: [temp] });
  return {
    title,
    summary: [
      `Die ${folder.tracks.length} Titel werden in der Reihenfolge ihrer Nummern neu in den Ordner gelegt.`,
      'Dazu wandern sie kurz in einen Hilfsordner. Ziehe die Karte währenddessen nicht ab.',
    ],
    steps,
    leftovers: [],
  };
}

/**
 * An interrupted repair leaves a helper folder behind; this puts the files
 * back. A reorder that had not emptied the folder yet goes back to the old
 * names, after that the new numbers apply (see planReorder). A swap of two
 * folders is undone or finished, as its marker and the catalog say (see
 * planSwapFolders). Nothing is ever overwritten: a track whose name is
 * taken comes back with the next free number at the end of the folder.
 */
function planRecoverTemp(scan: SdScan, catalog: PlanOptions['catalog']): RepairPlan {
  const steps: PlanStep[] = [];
  const leftovers: string[] = [];
  const summary: string[] = [];
  const reserved: number[] = [];
  // A swap goes forward once its marker is there or the catalog lists the folders swapped (planSwapFolders).
  const pair = (x: number, y: number) => `${Math.min(x, y)}-${Math.max(x, y)}`;
  const forward = new Set(scan.tempDirs.filter((t) => t.swap?.marker && t.folder !== null).map((t) => pair(t.folder!, t.swap!.to)));
  if (catalog?.swap) forward.add(pair(catalog.swap.a, catalog.swap.b));
  const markers: SdTempDir[] = [];
  let blocked = false;
  for (const t of scan.tempDirs) {
    if (t.swap?.marker && !t.entries.length) {
      markers.push(t);
      continue;
    }
    const ahead = !!t.swap && !t.swap.marker && t.folder !== null && forward.has(pair(t.folder, t.swap.to));
    let target = ahead ? t.swap!.to : t.folder;
    if (target === null) {
      target = nextFolderNumber(scan, reserved);
      if (target === null) {
        leftovers.push(`${t.name}: Auf der Karte ist kein Ordner mehr frei.`);
        continue;
      }
      reserved.push(target);
    }
    const name = folderName(target);
    const existing = scan.folders.find((f) => f.number === target);
    const taken = new Set(
      existing
        ? [...existing.tracks, ...existing.wrongDigits].map((x) => x.name.toLowerCase()).concat([...existing.unnumbered, ...existing.others, ...existing.subfolders, ...existing.junk].map((e) => e.name.toLowerCase()))
        : [],
    );
    const used = new Set(existing?.tracks.map((x) => x.number) ?? []);
    const back = t.entries
      .map((e) => {
        const h = t.encoded && e.kind === 'file' ? parseHelperTrackName(e.name) : null;
        return { from: e.name, to: h ? (t.newNumbers ? h.newName : h.oldName) : e.name };
      })
      .sort((a, b) => byTrackName(a.to, b.to));
    if (!existing && back.length) steps.push({ op: 'mkdir', path: [name] });
    const clashes: typeof back = [];
    for (const b of back) {
      if (taken.has(b.to.toLowerCase())) {
        clashes.push(b);
        continue;
      }
      taken.add(b.to.toLowerCase());
      const p = parseNumberedAudio(b.to);
      if (p?.digits === 3) used.add(p.number);
      steps.push({ op: 'move', from: [t.name, b.from], toDir: [name], name: b.to });
    }
    summary.push(
      back.length
        ? `${back.length} ${back.length === 1 ? 'Datei kommt' : 'Dateien kommen'} ${ahead ? 'in' : 'zurück in'} Ordner ${name}.`
        : `Der leere Hilfsordner ${t.name} wird entfernt.`,
    );
    let stuck = false;
    let next = Math.max(0, ...used) + 1;
    for (const b of clashes) {
      const p = parseNumberedAudio(b.to);
      if (!p || p.digits !== 3) {
        leftovers.push(`${t.name}/${b.from}: In Ordner ${name} gibt es schon eine Datei mit diesem Namen.`);
        stuck = true;
        continue;
      }
      let to = trackFileName(next, p, false);
      while (next <= MAX_TRACKS && taken.has(to.toLowerCase())) to = trackFileName(++next, p, false);
      if (next > MAX_TRACKS) {
        leftovers.push(`${t.name}/${b.from}: In Ordner ${name} ist keine Nummer mehr frei.`);
        stuck = true;
        continue;
      }
      next++;
      taken.add(to.toLowerCase());
      steps.push({ op: 'move', from: [t.name, b.from], toDir: [name], name: to });
      summary.push(`${b.to} gibt es in Ordner ${name} schon. Die Datei aus dem Hilfsordner kommt als ${to} ans Ende.`);
    }
    // Leftovers keep their names and markers, so a later run still knows what they are.
    if (!stuck) {
      if (t.newNumbers) steps.push({ op: 'rmdir', path: [t.name, REORDER_DONE_MARKER] });
      if (t.encoded) steps.push({ op: 'rmdir', path: [t.name, REORDER_MARKER] });
      steps.push({ op: 'rmdir', path: [t.name] });
    }
    blocked ||= stuck;
  }
  // The marker of a swap goes last: while a helper of it still waits, it says which way the files go.
  if (!blocked) for (const t of markers) steps.push({ op: 'rmdir', path: [t.name] });
  return { title: 'Unterbrochene Reparatur abschließen', summary, steps, leftovers };
}

function planNormalizeSystemNames(scan: SdScan): RepairPlan {
  const steps: PlanStep[] = [];
  const leftovers: string[] = [];
  for (const s of Object.values(scan.system)) {
    if (!s) continue;
    const taken = new Set(s.files.map((f) => f.name.toLowerCase()));
    const counts = new Map<number, number>();
    for (const f of [...s.files, ...s.wrongDigits]) counts.set(f.number, (counts.get(f.number) ?? 0) + 1);
    for (const f of [...s.files, ...s.wrongDigits]) {
      const to = `${String(f.number).padStart(4, '0')}.${f.ext}`;
      if (sameName(to, f.name)) continue;
      if ((counts.get(f.number) ?? 0) > 1 || taken.has(to.toLowerCase())) {
        leftovers.push(`${s.dirName}/${f.name}: Nummer doppelt vergeben.`);
        continue;
      }
      taken.add(to.toLowerCase());
      steps.push(...keepWords(s.dirName, f, to), { op: 'rename', dir: [s.dirName], from: f.name, to });
    }
  }
  const renames = steps.filter((s) => s.op === 'rename');
  const n = renames.length;
  return {
    title: 'Namen der Systemansagen korrigieren',
    summary: [
      `${n === 1 ? 'Eine Ansage bekommt eine reine Nummer' : `${n} Ansagen bekommen reine Nummern`} als Namen. Was sie sagen, bleibt gleich.`,
      ...(steps.some((s) => s.op === 'title') ? [KEEP_WORDS_LINE] : []),
      ...renames.slice(0, 30).map((s) => (s.op === 'rename' ? `${s.dir.join('/')}/${s.from} → ${s.to}` : '')),
    ],
    steps,
    leftovers,
  };
}

export interface ExecuteProgress {
  done: number;
  total: number;
  step: PlanStep;
}

export interface StepFailure {
  step: PlanStep;
  message: string;
}

export interface ExecuteResult {
  /** Steps that ran through. */
  completed: number;
  /** Steps of a best-effort plan that failed while the others went on. */
  skipped: StepFailure[];
  /** The step a plan stopped at. */
  error?: StepFailure;
}

/**
 * Runs a plan. Stops at the first failing step and reports how far it got;
 * a best-effort plan skips the failing step and goes on.
 */
export async function executePlan(
  root: Dir,
  plan: RepairPlan,
  opts: {
    onProgress?: (p: ExecuteProgress) => void;
    signal?: AbortSignal;
    /**
     * Runs right before the step at `plan.commitAt`, with the steps done so
     * far, e.g. to write the catalog with the new names. When it fails, the
     * plan stops there: an interrupted run still comes back with the old names.
     */
    beforeCommit?: (done: PlanStep[]) => Promise<void>;
  } = {},
): Promise<ExecuteResult> {
  const cache = new Map<string, Dir>();
  const dirAt = async (path: Path, create = false): Promise<Dir> => {
    let d = root;
    let key = '';
    for (const seg of path) {
      key += '/' + seg;
      const hit = cache.get(key);
      if (hit) {
        d = hit;
        continue;
      }
      d = await d.dir(seg, { create });
      cache.set(key, d);
    }
    return d;
  };
  const forget = (path: Path) => {
    const prefix = '/' + path.join('/');
    for (const k of [...cache.keys()]) if (k === prefix || k.startsWith(prefix + '/')) cache.delete(k);
  };

  let completed = 0;
  let processed = 0;
  const skipped: StepFailure[] = [];
  const ran: PlanStep[] = [];
  for (const [index, step] of plan.steps.entries()) {
    opts.signal?.throwIfAborted();
    try {
      if (index === plan.commitAt && opts.beforeCommit) await opts.beforeCommit([...ran]);
      switch (step.op) {
        case 'delete': {
          const parent = await dirAt(step.path.slice(0, -1));
          const name = step.path[step.path.length - 1];
          if (await parent.exists(name)) {
            if (step.ifEmpty && (await parent.source(name)).size !== 0) throw new Error(`${step.path.join('/')} ist nicht mehr leer und bleibt.`);
            await parent.remove(name, { recursive: step.recursive });
          }
          forget(step.path);
          break;
        }
        case 'rmdir': {
          const parent = await dirAt(step.path.slice(0, -1));
          const name = step.path[step.path.length - 1];
          if (!(await parent.exists(name))) break;
          const d = await dirAt(step.path);
          const entries = await d.list();
          const real = entries.filter((e) => !isJunk(e.name));
          if (real.length) {
            throw new Error(`Ordner ${step.path.join('/')} ist nicht leer (${real.slice(0, 3).map((e) => e.name).join(', ')}${real.length > 3 ? ' …' : ''}).`);
          }
          for (const e of entries) await d.remove(e.name, { recursive: true });
          forget(step.path);
          await parent.remove(name);
          break;
        }
        case 'rename': {
          const d = await dirAt(step.dir);
          await d.rename(step.from, step.to);
          forget([...step.dir, step.from]);
          forget([...step.dir, step.to]);
          break;
        }
        case 'move': {
          const src = await dirAt(step.from.slice(0, -1));
          const target = await dirAt(step.toDir);
          await src.move(step.from[step.from.length - 1], target, step.name);
          forget(step.from);
          break;
        }
        case 'mkdir':
          if (step.fresh) {
            const parent = await dirAt(step.path.slice(0, -1));
            if (await parent.exists(step.path[step.path.length - 1])) {
              throw new Error(`Den Hilfsordner ${step.path.join('/')} gibt es schon: Eine frühere Reparatur wurde unterbrochen. Öffne den Gesundheitscheck und tippe auf „Dateien zurücklegen“.`);
            }
          }
          await dirAt(step.path, true);
          break;
        case 'unlock': {
          const root = await dirAt([]);
          if (!root.makeWritable) throw new Error('Den Schreibschutz kann nur die Desktop-App aufheben.');
          await root.makeWritable(step.paths);
          break;
        }
        case 'title':
          await titleIfEmpty(await dirAt(step.dir), step.file, step.title);
          break;
      }
      ran.push(step);
      completed++;
    } catch (e) {
      const failure = { step, message: e instanceof Error ? e.message : String(e) };
      if (!plan.bestEffort) return { completed, skipped, error: failure };
      skipped.push(failure);
    }
    processed++;
    opts.onProgress?.({ done: processed, total: plan.steps.length, step });
  }
  return { completed, skipped };
}

/**
 * Writes `title` into an MP3 whose ID3 title is empty: a small tag with the
 * words of the old one and the new title (as "Titel-Infos bearbeiten"
 * writes them, without pictures). The file is replaced only once the new
 * one is complete (platform write()).
 */
async function titleIfEmpty(dir: Dir, file: string, title: string): Promise<void> {
  if (!/\.mp3$/i.test(file)) return;
  const source = await dir.source(file);
  const r = await readTags(source);
  // A tag too big to read (pictures) would be lost unseen; a file without sound between its tags is no track.
  if (r.tags.title?.trim() || (r.layout.id3v2.length && !r.id3v2) || r.layout.audioEnd <= r.layout.audioStart) return;
  // The sound stays as it is, so a spoken title's note (TXXX) still fits it and stays too.
  await dir.write(file, await replaceTags(source, buildSmallId3({ ...r.tags, title }), r.layout));
}

/** The steps of a plan that actually ran, in order (for the catalog). */
export function doneSteps(plan: RepairPlan, result: ExecuteResult): PlanStep[] {
  const failed = new Set(result.skipped.map((s) => s.step));
  const end = result.error ? plan.steps.indexOf(result.error.step) : plan.steps.length;
  return plan.steps.slice(0, end).filter((s) => !failed.has(s));
}

/** Numbered folders whose tracks the steps touched, so their fingerprints can be renewed. */
export function touchedFolders(steps: PlanStep[]): number[] {
  const out = new Set<number>();
  const note = (name: string | undefined) => {
    const n = name === undefined ? null : parseFolderNumber(name);
    if (n !== null) out.add(n);
  };
  for (const s of steps) {
    if (s.op === 'rename') {
      note(s.dir[0]);
      if (!s.dir.length) note(s.to);
    } else if (s.op === 'move') {
      note(s.from[0]);
      note(s.toDir[0]);
    } else if (s.op === 'title') {
      note(s.dir[0]);
    } else if (s.op !== 'unlock' && s.path.length > 1) {
      note(s.path[0]);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The order "Alles reparieren" works in: renames before renumbering, folder
 * order last. Deleting empty tracks is not part of it: the run would then
 * close the gap or remove the emptied folder by itself, and deleting must
 * never renumber tracks behind the user's back.
 */
export const AUTO_FIX_ORDER: FixAction['kind'][] = [
  // First: a write-protected file would make every later step on it break off.
  'make-writable',
  'recover-temp',
  'clean-junk',
  'rename-invalid-folder',
  'normalize-system-names',
  'normalize-names',
  'resolve-duplicates',
  'number-unnumbered',
  'close-gaps',
  'remove-empty-folder',
  'rebuild-order',
];

/** Issues "Alles reparieren" handles. Hints, empty tracks and the system sounds installer are left to the user. */
export function isAutoFixable(issue: Issue): boolean {
  const fix = issue.fix;
  if (!fix || issue.severity === 'info' || !AUTO_FIX_ORDER.includes(fix.kind)) return false;
  // "02 Bibi" → "02" is a guess from a name the user chose ("1. Advent", "99 Luftballons"):
  // only after its own preview, never in passing.
  if (fix.kind === 'rename-invalid-folder' && fix.title !== undefined) return false;
  return true;
}

export interface AutoRepairStep {
  issue: Issue;
  plan: RepairPlan;
  completed: number;
  /** Steps that failed while the rest of the plan went on. */
  skipped: StepFailure[];
  /** Why the plan stopped, when it did. */
  error?: string;
}

export interface AutoRepairResult {
  steps: AutoRepairStep[];
  leftovers: string[];
  error?: { issue: Issue; step: PlanStep; message: string };
  scan: SdScan;
  report: HealthReport;
}

/**
 * Fixes one issue at a time and reads the card again after each, because a
 * rename can change what the next fix has to do.
 */
export async function repairAll(
  root: Dir,
  check: (scan: SdScan) => HealthReport,
  opts: {
    planOptions?: PlanOptions;
    /** Called after a plan ran, with the steps that went through, e.g. to update the catalog. */
    onExecuted?: (issue: Issue, plan: RepairPlan, done: PlanStep[]) => void | Promise<void>;
    onProgress?: (p: ExecuteProgress & { issue: Issue }) => void;
    signal?: AbortSignal;
    maxSteps?: number;
  } = {},
): Promise<AutoRepairResult> {
  const steps: AutoRepairStep[] = [];
  const leftovers: string[] = [];
  const attempted = new Set<string>();
  const rank = (i: Issue) => AUTO_FIX_ORDER.indexOf(i.fix!.kind);
  for (let round = 0; round < (opts.maxSteps ?? 200); round++) {
    opts.signal?.throwIfAborted();
    const scan = await scanSd(root, { signal: opts.signal });
    const report = check(scan);
    const next = report.issues.filter((i) => isAutoFixable(i) && !attempted.has(i.id)).sort((a, b) => rank(a) - rank(b))[0];
    if (!next) return { steps, leftovers, scan, report };
    attempted.add(next.id);
    const plan = planFix(scan, next.fix!, opts.planOptions);
    leftovers.push(...plan.leftovers);
    if (!plan.steps.length) continue;
    const result = await executePlan(root, plan, { signal: opts.signal, onProgress: (p) => opts.onProgress?.({ ...p, issue: next }) });
    await opts.onExecuted?.(next, plan, doneSteps(plan, result));
    steps.push({ issue: next, plan, completed: result.completed, skipped: result.skipped, error: result.error?.message });
    for (const s of result.skipped) leftovers.push(s.message);
    if (result.error) {
      const after = await scanSd(root);
      return { steps, leftovers, error: { issue: next, ...result.error }, scan: after, report: check(after) };
    }
  }
  const scan = await scanSd(root);
  return { steps, leftovers, scan, report: check(scan) };
}

/**
 * Gives the tracks of a folder a new order (and drops tracks left out). The
 * files move to the helper folder under a name that holds their new number
 * and their old name, the folder is created again, and the files move back
 * in order under the new name. Nothing is copied, nothing is overwritten,
 * and an interruption at any point can be put back by planRecoverTemp.
 */
export function planReorder(folder: SdFolder, order: string[], opts: PlanOptions & { tempDirs?: SdTempDir[] } = {}): RepairPlan {
  const title = `Ordner ${folder.name} neu sortieren`;
  if (folder.subfolders.length) {
    return { title, summary: [], steps: [], leftovers: [`Ordner ${folder.name} enthält Unterordner. Verschiebe sie zuerst.`] };
  }
  if (order.length > MAX_TRACKS) {
    return { title, summary: [], steps: [], leftovers: [`Ein Ordner kann höchstens ${MAX_TRACKS} Titel haben.`] };
  }
  const pending = pendingHelper(folder, opts.tempDirs);
  if (pending) return { title, summary: [], steps: [], leftovers: [pending] };
  const byName = new Map(folder.tracks.map((t) => [t.name.toLowerCase(), t]));
  const keep = new Set(order.map((n) => n.toLowerCase()));
  const missing = order.filter((n) => !byName.has(n.toLowerCase()));
  if (missing.length) {
    return { title, summary: [], steps: [], leftovers: missing.map((n) => `${folder.name}/${n} gibt es nicht mehr. Lies die Karte neu ein.`) };
  }
  const temp = tempDirName(folder.number);
  const pure = !!opts.pureNumbers;
  const steps: PlanStep[] = [];
  const removed = folder.tracks.filter((t) => !keep.has(t.name.toLowerCase()));
  for (const t of removed) steps.push({ op: 'delete', path: [folder.name, t.name] });
  steps.push({ op: 'mkdir', path: [temp], fresh: true });
  steps.push({ op: 'mkdir', path: [temp, REORDER_MARKER] });
  const targets = order.map((name, i) => {
    const t = byName.get(name.toLowerCase())!;
    return { from: t.name, parked: helperTrackName(i + 1, t.name, pure), to: trackFileName(i + 1, t, pure) };
  });
  const extras = [...folder.wrongDigits.map((t) => t.name), ...[...folder.unnumbered, ...folder.others].map((e) => e.name)];
  for (const x of targets) steps.push({ op: 'move', from: [folder.name, x.from], toDir: [temp], name: x.parked });
  for (const n of extras) steps.push({ op: 'move', from: [folder.name, n], toDir: [temp], name: n });
  steps.push({ op: 'rmdir', path: [folder.name] });
  steps.push({ op: 'mkdir', path: [folder.name] });
  // From here on "Dateien zurücklegen" gives the tracks their new names.
  const commitAt = steps.length;
  steps.push({ op: 'mkdir', path: [temp, REORDER_DONE_MARKER] });
  for (const x of targets) steps.push({ op: 'move', from: [temp, x.parked], toDir: [folder.name], name: x.to });
  for (const n of extras) steps.push({ op: 'move', from: [temp, n], toDir: [folder.name], name: n });
  steps.push({ op: 'rmdir', path: [temp, REORDER_DONE_MARKER] });
  steps.push({ op: 'rmdir', path: [temp, REORDER_MARKER] });
  steps.push({ op: 'rmdir', path: [temp] });
  const summary: string[] = [];
  if (removed.length) summary.push(`${removed.length === 1 ? '1 Titel wird' : `${removed.length} Titel werden`} gelöscht.`);
  summary.push(`${order.length} Titel bekommen die Nummern 1 bis ${order.length} in der neuen Reihenfolge.`);
  return { title, summary, steps, leftovers: [], commitAt };
}
