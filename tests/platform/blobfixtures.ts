import type { BlobFolder, BlobNode } from '../../src/platform/blobtree';
import type { MemTree } from '../../src/platform/memory';

/**
 * A snapshot tree from a plain object, like memDir(): strings and byte
 * arrays become files, numbers zero-filled files of that size, objects
 * folders. Files are Files, as a folder chooser hands them out.
 */
export function blobTree(tree: MemTree, name = 'SD'): BlobFolder {
  return {
    kind: 'directory',
    name,
    children: Object.entries(tree).map(([k, v]): BlobNode => {
      if (typeof v === 'string' || v instanceof Uint8Array) return { kind: 'file', name: k, blob: new File([v as BlobPart], k), modified: 0 };
      if (typeof v === 'number') return { kind: 'file', name: k, blob: new File([new Uint8Array(v)], k), modified: 0 };
      return blobTree(v, k);
    }),
  };
}

/** Names and sizes of a tree, in tree order, for comparisons. */
export function treeShape(folder: BlobFolder): unknown {
  const out: Record<string, unknown> = {};
  for (const c of folder.children) out[c.name] = c.kind === 'file' ? c.blob.size : treeShape(c);
  return out;
}

/** A Blob whose reads fail as when the card was pulled. */
export class GoneBlob extends Blob {
  constructor(size: number, private readonly errorName = 'NotFoundError') {
    super([new Uint8Array(size)]);
  }

  override slice(): Blob {
    return new GoneBlob(0, this.errorName);
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    throw new DOMException('A requested file or directory could not be found at the time an operation was processed.', this.errorName);
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const name = this.errorName;
    return new ReadableStream({
      pull(c) {
        c.error(new DOMException('gone', name));
      },
    });
  }
}
