import type { BlobFolder, BlobNode } from './blobtree';

/**
 * Reads an SD card once, read-only, in browsers that cannot open folders
 * for writing (Firefox, Safari): from the files of a folder chooser
 * (<input webkitdirectory>) or from a dropped folder. The result is a tree
 * of File references; nothing is copied.
 *
 * Hidden files and junk stay in the tree: the scan and the health check
 * need to see them.
 */

/** A dropped file or folder, as webkitGetAsEntry() hands it out. */
export type EntryLike = { isFile: boolean; isDirectory: boolean; name: string };
export type FileEntryLike = EntryLike & { file(ok: (f: File) => void, err: (e: unknown) => void): void };
export type DirEntryLike = EntryLike & { createReader(): { readEntries(ok: (e: EntryLike[]) => void, err: (e: unknown) => void): void } };

/** One file of a folder chooser: its path includes the chosen folder ("TONUINO/05/003.mp3"). */
export interface SnapshotItem {
  path: string;
  blob: Blob;
  modified?: number;
}

export interface SnapshotResult {
  root: BlobFolder;
  /** Name of the card (the chosen folder), "SD-Karte" when the browser gives none. */
  label: string;
  takenAt: number;
  files: number;
  bytes: number;
  source: 'chooser' | 'drop';
}

export type SnapshotProblem =
  /** Nothing in it. `label` when the browser still told the folder's name (a drop). */
  | { kind: 'empty'; label?: string }
  | { kind: 'not-a-folder' }
  | { kind: 'several-items' }
  | { kind: 'read-failed'; path: string; message: string };

/**
 * Whether the browser lists a folder in the order its entries sit on the
 * card. Unknown for Firefox and Safari, so the health check does not judge
 * track order on a snapshot. Only to be switched on after checking it in
 * both browsers, for the folder chooser and for drag and drop.
 */
export const SNAPSHOT_LISTING_IS_FAT_ORDER = false;

export function isSnapshotProblem(r: SnapshotResult | SnapshotProblem): r is SnapshotProblem {
  return 'kind' in r;
}

/** The name to show for a card: Windows drive roots ("E:") and empty names become "SD-Karte". */
export function cardLabel(rawName: string): string {
  const name = rawName.trim().replace(/[\\/]+$/, '');
  if (!name || /^[a-z]:$/i.test(name)) return 'SD-Karte';
  return name;
}

/**
 * The name of the folder the user chose when it is a folder of the card
 * ("05", "mp3", "advert") rather than the card itself; null otherwise.
 */
export function pickedSubfolder(r: SnapshotResult): string | null {
  if (!/^(\d{2}|mp3|advert)$/i.test(r.label)) return null;
  return r.root.children.some((c) => c.kind === 'file' && /^\d{1,4}.*\.(mp3|wav)$/i.test(c.name)) ? r.label : null;
}

/** Builds the tree, merging folder names that differ only in case, as FAT does. */
class TreeBuilder {
  readonly root: BlobFolder;
  files = 0;
  bytes = 0;
  private readonly index = new Map<BlobFolder, Map<string, BlobNode>>();

  constructor(label: string) {
    this.root = { kind: 'directory', name: label, children: [] };
  }

  private add(parent: BlobFolder, node: BlobNode) {
    parent.children.push(node);
    let names = this.index.get(parent);
    if (!names) this.index.set(parent, (names = new Map()));
    names.set(node.name.toLowerCase(), node);
  }

  private find(parent: BlobFolder, name: string): BlobNode | undefined {
    return this.index.get(parent)?.get(name.toLowerCase());
  }

  /** The subfolder `name`, created when new; null when a file has that name. */
  folder(parent: BlobFolder, name: string): BlobFolder | null {
    const found = this.find(parent, name);
    if (found) return found.kind === 'directory' ? found : null;
    const f: BlobFolder = { kind: 'directory', name, children: [] };
    this.add(parent, f);
    return f;
  }

  /** Adds a file. A second file whose name differs only in case cannot exist on FAT: the first one stays. */
  file(parent: BlobFolder, name: string, blob: Blob, modified?: number) {
    if (this.find(parent, name)) return;
    this.add(parent, { kind: 'file', name, blob, modified });
    this.files++;
    this.bytes += blob.size;
  }
}

/** The card from the files of a folder chooser, in the order the browser listed them. */
export function snapshotFromFiles(items: readonly SnapshotItem[], now = Date.now()): SnapshotResult | SnapshotProblem {
  if (!items.length) return { kind: 'empty' };
  if (items.some((i) => !i.path.includes('/'))) return { kind: 'not-a-folder' };
  const b = new TreeBuilder(cardLabel(items[0].path.split('/').find(Boolean) ?? ''));
  for (const item of items) {
    // The first part is the chosen folder itself.
    const parts = item.path.split('/').filter(Boolean).slice(1);
    if (!parts.length) continue;
    let at: BlobFolder | null = b.root;
    for (const p of parts.slice(0, -1)) {
      at = b.folder(at, p);
      if (!at) break;
    }
    if (at) b.file(at, parts[parts.length - 1], item.blob, item.modified);
  }
  return { root: b.root, label: b.root.name, takenAt: now, files: b.files, bytes: b.bytes, source: 'chooser' };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message || e.name : String(e);
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/**
 * The card from a dropped folder. Empty folders are included (the folder
 * chooser cannot see them). Rejects with an AbortError when `signal` aborts.
 */
export async function snapshotFromEntry(
  entry: EntryLike,
  opts: { signal?: AbortSignal; onProgress?: (files: number) => void; now?: number } = {},
): Promise<SnapshotResult | SnapshotProblem> {
  if (!entry.isDirectory) return { kind: 'not-a-folder' };
  const now = opts.now ?? Date.now();
  const b = new TreeBuilder(cardLabel(entry.name));

  const walk = async (dir: DirEntryLike, folder: BlobFolder, prefix: string): Promise<SnapshotProblem | null> => {
    const reader = dir.createReader();
    // Chrome hands out at most 100 entries per call, Firefox all at once: ask until a call brings none.
    for (;;) {
      opts.signal?.throwIfAborted();
      let batch: EntryLike[];
      try {
        batch = await new Promise<EntryLike[]>((ok, err) => reader.readEntries(ok, err));
      } catch (e) {
        if (isAbort(e)) throw e;
        return { kind: 'read-failed', path: prefix || b.root.name, message: errorText(e) };
      }
      if (!batch.length) return null;
      // The files of a batch are asked for together: one by one takes long on a full card.
      const got = await Promise.all(
        batch.map((e) =>
          e.isFile
            ? new Promise<File>((ok, err) => (e as FileEntryLike).file(ok, err)).then(
                (file) => ({ file }),
                (error: unknown) => ({ error }),
              )
            : null,
        ),
      );
      opts.signal?.throwIfAborted();
      for (let i = 0; i < batch.length; i++) {
        const e = batch[i];
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        const r = got[i];
        if (r) {
          if ('error' in r) return { kind: 'read-failed', path, message: errorText(r.error) };
          b.file(folder, e.name, r.file, r.file.lastModified);
        } else if (e.isDirectory) {
          const sub = b.folder(folder, e.name);
          if (!sub) continue;
          const problem = await walk(e as DirEntryLike, sub, path);
          if (problem) return problem;
        }
      }
      opts.onProgress?.(b.files);
    }
  };

  const problem = await walk(entry as DirEntryLike, b.root, '');
  if (problem) return problem;
  if (!b.root.children.length) return { kind: 'empty', label: b.root.name };
  return { root: b.root, label: b.root.name, takenAt: now, files: b.files, bytes: b.bytes, source: 'drop' };
}
