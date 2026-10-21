/**
 * Hidden files macOS puts on a card (TODO #95c, forum 14978#76–82): the
 * folders .fseventsd, .Spotlight-V100 and .Trashes in the top level, their
 * AppleDouble twins ("._.Trashes") and a "._" twin next to every file the
 * Finder copies. In the folders of the box the player counts the "._"
 * files as tracks. macOS makes the top-level folders again when the card
 * is mounted, so the app removes them right before ejecting and looks again
 * afterwards: what macOS keeps or makes at once stays and is reported.
 */
import type { Dir } from '../../platform/types';
import { junkOrigin, parseFolderNumber } from './sd';

/** Junk macOS leaves, including "._" twins of anything. */
export function isMacJunk(name: string): boolean {
  return junkOrigin(name) === 'macos';
}

export interface MacTidy {
  /** Paths removed, e.g. ".fseventsd", "01/._001.mp3". */
  removed: string[];
  /** Paths still there when looked at again (protected, or made again at once). */
  left: string[];
}

/** The top level, the numbered folders and mp3/advert: where junk matters or comes back. */
async function boxDirs(root: Dir): Promise<{ prefix: string; dir: Dir }[]> {
  const out = [{ prefix: '', dir: root }];
  for (const e of await root.list()) {
    if (e.kind !== 'directory' || isMacJunk(e.name)) continue;
    if (parseFolderNumber(e.name) === null && !/^(mp3|advert)$/i.test(e.name)) continue;
    out.push({ prefix: `${e.name}/`, dir: await root.dir(e.name) });
  }
  return out;
}

async function macEntries(dirs: { prefix: string; dir: Dir }[]): Promise<{ path: string; name: string; dir: Dir; folder: boolean }[]> {
  const found: { path: string; name: string; dir: Dir; folder: boolean }[] = [];
  for (const d of dirs) {
    const entries = await d.dir.list().catch(() => []);
    for (const e of entries) if (isMacJunk(e.name)) found.push({ path: d.prefix + e.name, name: e.name, dir: d.dir, folder: e.kind === 'directory' });
  }
  return found;
}

/**
 * Removes the macOS junk from the card and looks again. Never throws for a
 * single entry: one that cannot go (macOS protects .Spotlight-V100 while
 * the card is mounted) is listed in `left`.
 */
export async function tidyMacJunk(root: Dir): Promise<MacTidy> {
  const dirs = await boxDirs(root);
  const removed: string[] = [];
  for (const e of await macEntries(dirs)) {
    try {
      await e.dir.remove(e.name, { recursive: e.folder });
      removed.push(e.path);
    } catch {
      // Left for the second look.
    }
  }
  const left = (await macEntries(dirs)).map((e) => e.path);
  return { removed: removed.filter((p) => !left.includes(p)), left };
}

/** What the tidying before ejecting means, in a sentence or two; undefined when there was nothing. */
export function macTidyText(t: MacTidy | undefined): string | undefined {
  if (!t || (!t.removed.length && !t.left.length)) return undefined;
  const parts: string[] = [];
  if (t.removed.length) parts.push(`Vorher hab ich ${t.removed.length === 1 ? 'eine versteckte Datei' : `${t.removed.length} versteckte Dateien`} vom Mac weggeräumt.`);
  const inFolders = t.left.filter((p) => p.includes('/'));
  if (inFolders.length) {
    parts.push(`${inFolders.length === 1 ? 'Eine versteckte Datei' : `${inFolders.length} versteckte Dateien`} vom Mac in den Ordnern der Box ${inFolders.length === 1 ? 'ließ' : 'ließen'} sich nicht löschen, zum Beispiel ${inFolders[0]}. Die Box spielt sie vielleicht als Titel ab. Lösche sie am Computer und prüfe die Karte noch einmal.`);
  } else if (t.left.length) {
    parts.push('Der Mac legt ein paar versteckte Ordner beim Einstecken immer wieder an. Die Box stört das nicht.');
  }
  return parts.join(' ');
}
