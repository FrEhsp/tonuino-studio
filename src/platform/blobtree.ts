/**
 * A folder tree whose files are Blobs: the read-only picture of an SD card
 * that a browser without file system access hands out (Files from a folder
 * chooser or a drop), and the copy the app changes in its place.
 *
 * Like FAT, names are case-insensitive but keep their case, and entries
 * keep their order.
 */

export interface BlobFile {
  kind: 'file';
  name: string;
  blob: Blob;
  /** CRC-32 of the content, when already known. */
  crc32?: number;
  /** Last modification, ms since epoch, when known. */
  modified?: number;
  /** Produced in this session (not a file of the card). */
  staged?: boolean;
}

export interface BlobFolder {
  kind: 'directory';
  name: string;
  children: BlobNode[];
  modified?: number;
}

export type BlobNode = BlobFile | BlobFolder;

/** The entry called `name`, ignoring case. */
export function childOf(folder: BlobFolder, name: string): BlobNode | undefined {
  const n = name.toLowerCase();
  return folder.children.find((c) => c.name.toLowerCase() === n);
}

/** A copy with new nodes and the same Blob objects. */
export function cloneTree(folder: BlobFolder): BlobFolder {
  return { ...folder, children: folder.children.map((c) => (c.kind === 'file' ? { ...c } : cloneTree(c))) };
}

/**
 * Same names in the same order, and every file is the same Blob object. A
 * file that was written again counts as changed even with equal bytes.
 */
export function sameContent(a: BlobNode, b: BlobNode): boolean {
  if (a.name !== b.name || a.kind !== b.kind) return false;
  if (a.kind === 'file') return a.blob === (b as BlobFile).blob;
  const other = (b as BlobFolder).children;
  return a.children.length === other.length && a.children.every((c, i) => sameContent(c, other[i]));
}

/** Every file below `folder`, depth first in tree order, with its path ("05/003.mp3"). */
export function* files(folder: BlobFolder, prefix = ''): Generator<{ path: string; file: BlobFile }> {
  for (const c of folder.children) {
    const path = prefix ? `${prefix}/${c.name}` : c.name;
    if (c.kind === 'file') yield { path, file: c };
    else yield* files(c, path);
  }
}

/** The node at a path like "05/003.mp3", ignoring case; the folder itself for "". */
export function nodeAt(folder: BlobFolder, path: string): BlobNode | undefined {
  let node: BlobNode = folder;
  for (const seg of path.split('/')) {
    if (!seg) continue;
    if (node.kind !== 'directory') return undefined;
    const next: BlobNode | undefined = childOf(node, seg);
    if (!next) return undefined;
    node = next;
  }
  return node;
}

/** Size of all files below `folder` in bytes. */
export function treeBytes(folder: BlobFolder): number {
  let n = 0;
  for (const { file } of files(folder)) n += file.blob.size;
  return n;
}
