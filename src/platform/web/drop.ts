import type { DirEntryLike, EntryLike, FileEntryLike } from '../snapshot';
import type { ByteSource } from '../types';
import { collectFiles, fileSource } from './fsa';

async function fromEntry(entry: EntryLike, prefix: string): Promise<ByteSource[]> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.name.startsWith('.')) return [];
  if (entry.isFile) {
    const file = await new Promise<File>((ok, err) => (entry as FileEntryLike).file(ok, err));
    return [fileSource(file, path)];
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as DirEntryLike).createReader();
  const out: ByteSource[] = [];
  // readEntries returns at most 100 entries per call.
  for (;;) {
    const batch = await new Promise<EntryLike[]>((ok, err) => reader.readEntries(ok, err));
    if (!batch.length) break;
    for (const e of batch) out.push(...(await fromEntry(e, path)));
  }
  return out;
}

/** What one dropped item offers, taken while the drop event runs. */
interface CapturedItem {
  handle: Promise<FileSystemHandle | null> | null;
  entry: EntryLike | null;
  file: File | null;
}

/** The files of a drop, taken out of the event. Read them with sourcesFromCapture. */
export interface CapturedDrop {
  readonly items: readonly CapturedItem[];
}

type HandleItem = DataTransferItem & { getAsFileSystemHandle(): Promise<FileSystemHandle | null> };

/**
 * Takes everything a drop offers right away. The browser empties the
 * DataTransfer once the drop event is over, so this must run in the event
 * handler itself, before anything is awaited.
 */
export function captureDrop(dt: DataTransfer): CapturedDrop {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  return {
    items: items.map((i) => ({
      handle: 'getAsFileSystemHandle' in i ? (i as HandleItem).getAsFileSystemHandle().catch(() => null) : null,
      entry: (i.webkitGetAsEntry?.() as EntryLike | null) ?? null,
      file: i.getAsFile(),
    })),
  };
}

/** Files and folders of a drop, folders read recursively. */
export async function sourcesFromCapture(drop: CapturedDrop): Promise<ByteSource[]> {
  const out: ByteSource[] = [];
  for (const item of drop.items) {
    const h = await item.handle;
    if (h?.kind === 'directory') out.push(...(await collectFiles(h as FileSystemDirectoryHandle)));
    else if (h?.kind === 'file') out.push(fileSource(await (h as FileSystemFileHandle).getFile()));
    else if (item.entry) out.push(...(await fromEntry(item.entry, '')));
    else if (item.file) out.push(fileSource(item.file));
  }
  return out;
}

/** Files and folders dropped onto the page. Call it in the drop event handler itself. */
export function sourcesFromDrop(dt: DataTransfer): Promise<ByteSource[]> {
  return sourcesFromCapture(captureDrop(dt));
}
