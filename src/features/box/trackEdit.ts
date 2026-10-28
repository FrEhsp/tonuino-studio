/**
 * The two extras that change the sound of tracks on the card: "Titel
 * zusammenfügen" (JoinDialog) and "Zuschneiden"
 * (TrimDialog). The new file takes the old one's place only once it is
 * complete (platform write()), and afterwards the catalog learns the new
 * sizes and lengths, so the folder does not look changed elsewhere. Writes
 * go through the card's Dir, so they land in the Paket where the card is
 * read as a snapshot (Firefox, Safari).
 */
import { folderFingerprint, type CatalogFolder } from '../../core/tonuino/catalog';
import { folderName, isOutOfOrder, type SdFolder } from '../../core/tonuino/sd';
import type { Dir } from '../../platform/types';
import { card, rescan, updateCatalog } from '../../app/state';
import { fixOrder, removeTwins } from '../add/session';
import { emptyEntry } from './shownRows';
import { isMp3 } from './tagWrite';

/** A file on the card that got new contents. */
export interface Rewritten {
  file: string;
  oldSize: number;
  size: number;
  durationSec?: number;
  /** A new title for the track (the joined one). */
  title?: string;
}

export interface JoinPlan {
  /** The picked tracks in the order of the list: they are joined in this order. */
  files: string[];
  /** Gets the joined sound. */
  first: string;
  /** Deleted once the joined file is on the card. */
  removed: string[];
  /** The folder's order afterwards, for planReorder. */
  order: string[];
  /** Why it cannot be done, in plain words. */
  problem?: string;
}

/** What joining `picked` means for a folder whose tracks show in `rows` (in their order). */
export function planJoin(rows: readonly { file: string }[], picked: ReadonlySet<string>): JoinPlan {
  const files = rows.map((r) => r.file).filter((f) => picked.has(f));
  const first = files[0] ?? '';
  const removed = files.slice(1);
  const gone = new Set(removed);
  const order = rows.map((r) => r.file).filter((f) => !gone.has(f));
  const problem =
    files.length < 2 ? 'Wähle mindestens zwei Titel.' : !isMp3(first) ? `Der erste Titel „${first}“ ist keine MP3-Datei. Der neue Titel wird eine MP3 an seiner Stelle, wähle zuerst eine MP3.` : undefined;
  return { files, first, removed, order, problem };
}

/**
 * Notes new contents in the catalog entry: size and length of each file,
 * a new title where one is given, and the folder's new fingerprint when the
 * old one matched the card before the write (`fingerprint.before`); a folder
 * changed elsewhere stays marked as such.
 */
export function noteRewritten(e: CatalogFolder, written: readonly Rewritten[], fingerprint?: { before: string; after: string }): void {
  for (const w of written) {
    let t = e.tracks.find((x) => x.file.toLowerCase() === w.file.toLowerCase());
    if (!t) e.tracks.push((t = { file: w.file }));
    if (t.size === undefined || t.size === w.oldSize) t.size = w.size;
    if (w.durationSec !== undefined) {
      t.durationSec = w.durationSec;
      t.durationExact = true;
    }
    if (w.title !== undefined) {
      if (w.title.trim()) t.title = w.title.trim();
      delete t.titleAuto;
    }
  }
  if (fingerprint && e.fingerprint === fingerprint.before) e.fingerprint = fingerprint.after;
  e.updatedAt = Date.now();
}

/**
 * After files of a folder got new contents: hidden twins away, the order
 * on the card as before (some players play in the order the files lie),
 * and the catalog up to date. `before` is the folder as scanned before the
 * writes.
 */
export async function afterRewrite(dir: Dir, folder: number, before: SdFolder, written: readonly Rewritten[]): Promise<void> {
  if (!written.length) return;
  const s = card.value;
  if (!s) return;
  await removeTwins(
    dir,
    written.map((w) => w.file),
  ).catch(() => undefined);
  let scan = await rescan().catch(() => undefined);
  if (s.volume.access !== 'snapshot' && !isOutOfOrder(before.tracks)) {
    const now = scan?.folders.find((x) => x.number === folder);
    if (now && isOutOfOrder(now.tracks)) scan = (await fixOrder(s.volume.root, scan, [folder]).catch(() => undefined))?.scan ?? scan;
  }
  const after = scan?.folders.find((x) => x.number === folder);
  const sizes = new Map(written.map((w) => [w.file.toLowerCase(), w.size]));
  const afterPrint = after ? folderFingerprint(after) : folderFingerprint({ ...before, tracks: before.tracks.map((t) => ({ ...t, size: sizes.get(t.name.toLowerCase()) ?? t.size })) });
  const name = folderName(folder);
  const known = !!card.value?.catalog?.folders[name];
  await updateCatalog(
    (c) => {
      const e = c.folders[name] ?? (c.folders[name] = emptyEntry(folder));
      noteRewritten(e, written, { before: folderFingerprint(before), after: afterPrint });
    },
    { touchFolders: known ? [] : [folder] },
  );
}

/** An error's text as a sentence. */
export function messageOf(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).trim();
  return m && !/[.!?“]$/.test(m) ? `${m}.` : m;
}

/** Room left on the card, when the platform tells it and the card is written directly. */
export function noRoomFor(bytes: number): string | null {
  const s = card.value;
  const free = s?.info.freeBytes;
  if (!s || s.volume.access === 'snapshot' || free === undefined || bytes <= free) return null;
  return 'Auf der SD-Karte ist nicht genug Platz für den neuen Titel. Lösche zuerst etwas, zum Beispiel unter „Meine Box“.';
}

/** Seconds as typed: "12", "2,5" or "1:30". NaN when it is none. */
export function parseSeconds(text: string): number {
  const t = text.trim().replace(',', '.');
  if (!t) return 0;
  const m = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
}
