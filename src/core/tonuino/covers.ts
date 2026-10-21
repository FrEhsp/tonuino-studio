import type { Dir } from '../../platform/types';
import { COVERS_FILE, folderName } from './sd';

/**
 * Covers travel with the card in one zip file, because extra folders on the
 * card would confuse the folder count of the MP3 player.
 */

export type CoverMap = Map<string, Uint8Array>;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function coverEntryName(folder: number, mimeType = 'image/jpeg'): string {
  return `${folderName(folder)}.${EXT[mimeType] ?? 'jpg'}`;
}

export function coverMimeType(entry: string): string {
  const ext = entry.split('.').pop()?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
}

/**
 * The covers after a folder got another number: its picture is stored
 * under the new number ("45.jpg" → "05.jpg"), so a later folder 45 never
 * takes it or removes it. A stale picture under the new number goes.
 * Returns the new map and the entry the picture has now.
 */
export function renumberCovers(covers: CoverMap, from: number, to: number): { covers: CoverMap; entry?: string } {
  const out: CoverMap = new Map();
  const old = `${folderName(from)}.`;
  const taken = `${folderName(to)}.`;
  let entry: string | undefined;
  for (const [name, data] of covers) {
    if (name.startsWith(taken)) continue;
    if (name.startsWith(old)) {
      entry = coverEntryName(to, coverMimeType(name));
      out.set(entry, data);
    } else out.set(name, data);
  }
  return { covers: out, entry };
}

/**
 * The covers after two folders swapped their numbers: the pictures under
 * "05." and "12." swap their names. Returns the new map and each old entry
 * name with its new one.
 */
export function swapCovers(covers: CoverMap, a: number, b: number): { covers: CoverMap; renamed: Map<string, string> } {
  const out: CoverMap = new Map();
  const renamed = new Map<string, string>();
  const pa = `${folderName(a)}.`;
  const pb = `${folderName(b)}.`;
  for (const [name, data] of covers) {
    const to = name.startsWith(pa) ? coverEntryName(b, coverMimeType(name)) : name.startsWith(pb) ? coverEntryName(a, coverMimeType(name)) : name;
    if (to !== name) renamed.set(name, to);
    out.set(to, data);
  }
  return { covers: out, renamed };
}

export async function loadCovers(root: Dir): Promise<CoverMap> {
  const map: CoverMap = new Map();
  if (!(await root.exists(COVERS_FILE))) return map;
  // Loaded outside the try: a library that does not come is an error, not a broken zip without covers.
  const { default: JSZip } = await import('jszip');
  try {
    const zip = await JSZip.loadAsync(await root.read(COVERS_FILE));
    for (const f of Object.values(zip.files)) {
      if (f.dir) continue;
      map.set(f.name, await f.async('uint8array'));
    }
  } catch {
    // A broken zip only costs the covers; the catalog still knows the titles.
  }
  return map;
}

export async function packCovers(covers: CoverMap): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const name of [...covers.keys()].sort()) zip.file(name, covers.get(name)!, { binary: true, date: new Date(0) });
  // Images are compressed already: store them as they are.
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

export async function saveCovers(root: Dir, covers: CoverMap): Promise<void> {
  if (!covers.size) {
    if (await root.exists(COVERS_FILE)) await root.remove(COVERS_FILE);
    return;
  }
  await root.write(COVERS_FILE, await packCovers(covers));
}
