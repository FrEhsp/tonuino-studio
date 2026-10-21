import JSZip from 'jszip';
import { childOf, files, type BlobFile, type BlobFolder } from '../../src/platform/blobtree';
import { snapshotFromFiles, type SnapshotResult } from '../../src/platform/snapshot';

/** The folder at `parts` below `root`, created when missing. */
export function folderAt(root: BlobFolder, parts: string[]): BlobFolder {
  let at = root;
  for (const p of parts) {
    let next = childOf(at, p);
    if (!next) {
      next = { kind: 'directory', name: p, children: [] };
      at.children.push(next);
    }
    if (next.kind !== 'directory') throw new Error(`${p} ist kein Ordner`);
    at = next;
  }
  return at;
}

/** Unpacks like unzip -o: in archive order, replacing files, into the root or a folder. */
export async function unpack(card: BlobFolder, bytes: Uint8Array, into?: string): Promise<BlobFolder> {
  const zip = await JSZip.loadAsync(bytes);
  const target = into ? folderAt(card, [into]) : card;
  for (const [path, entry] of Object.entries(zip.files)) {
    const parts = path.replace(/\/$/, '').split('/');
    if (entry.dir) {
      folderAt(target, parts);
      continue;
    }
    const folder = folderAt(target, parts.slice(0, -1));
    const name = parts[parts.length - 1];
    const file: BlobFile = { kind: 'file', name, blob: new File([(await entry.async('uint8array')) as BlobPart], name) };
    const old = childOf(folder, name);
    if (old) folder.children[folder.children.indexOf(old)] = file;
    else folder.children.push(file);
  }
  return card;
}

/** The card read again through the folder chooser: new File objects with the same content. */
export async function readAgain(card: BlobFolder, at: number): Promise<SnapshotResult> {
  const items = [];
  for (const { path, file } of files(card)) {
    items.push({ path: `${card.name}/${path}`, blob: new File([await file.blob.arrayBuffer()], file.name) });
  }
  const r = snapshotFromFiles(items, at);
  if ('kind' in r) throw new Error(`Die Karte ließ sich nicht einlesen: ${r.kind}`);
  return r;
}
