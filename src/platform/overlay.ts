import { APP_FILES } from '../core/tonuino/sd';
import { crc32, crc32OfBlob, rememberCrc32 } from '../core/zip/crc32';
import { childOf, cloneTree, files, type BlobFile, type BlobFolder, type BlobNode } from './blobtree';
import { MemDirError } from './memory';
import type { ByteSource, Dir, DirEntry, WriteOptions } from './types';

/**
 * A copy-on-write layer over a card snapshot. The app's features change
 * the card through `root` as on any other card; the snapshot stays as it
 * was read, and what differs between the two becomes the Paket.
 *
 * BlobTreeDir behaves exactly like MemDir (case-insensitive names, creation
 * order, rename keeps the place, move appends), with MemDir's errors.
 */

/** Data below this size stays in memory and counts against no budget (catalog, covers, system sounds). */
export const SMALL_DATA = 1024 * 1024;
/** How much music the browser may hold in memory when it has no disk space for staging. */
export const MEMORY_BUDGET = 512 * 1024 * 1024;

/** Where new files wait until they go into a Paket. */
export interface ScratchStore {
  readonly kind: 'opfs' | 'memory';
  /** Keeps the data; the Blob stays readable for this session. */
  put(data: Uint8Array | Blob, opts?: WriteOptions): Promise<{ blob: Blob; crc32: number }>;
  /** Bytes that still fit, when known. */
  available(): Promise<number | undefined>;
  /** A Blob from put() that is no longer in the card's tree. */
  release?(blob: Blob): void;
  dispose(): Promise<void>;
}

const FULL_TEXT: Record<ScratchFullError['reason'], string> = {
  quota: 'Für so viel Musik auf einmal hat der Browser zu wenig Platz. Nimm weniger Alben auf einmal.',
  private:
    'Im privaten Fenster hält der Browser alles im Arbeitsspeicher, und der reicht für so viel Musik nicht. Öffne die App in einem normalen Fenster oder nimm weniger Alben auf einmal.',
  budget:
    'Dein Browser hält das Paket im Arbeitsspeicher, und der reicht für so viel Musik nicht. Nimm weniger Alben auf einmal oder einen neueren Browser.',
};

export class ScratchFullError extends Error {
  constructor(readonly reason: 'quota' | 'budget' | 'private') {
    super(FULL_TEXT[reason]);
    this.name = 'ScratchFullError';
  }
}

/**
 * Keeps new files in memory, up to `budgetBytes`. Small data and Files
 * (which the browser reads from disk) do not count.
 */
export function memoryScratch(opts: { budgetBytes?: number; reason?: 'budget' | 'private' } = {}): ScratchStore {
  const budget = opts.budgetBytes ?? MEMORY_BUDGET;
  const reason = opts.reason ?? 'budget';
  let used = 0;
  const counted = new WeakMap<Blob, number>();
  return {
    kind: 'memory',
    async put(data, o = {}) {
      o.signal?.throwIfAborted();
      const size = data instanceof Uint8Array ? data.length : data.size;
      const counts = !(data instanceof File) && size >= SMALL_DATA;
      if (counts && used + size > budget) throw new ScratchFullError(reason);
      if (counts) used += size;
      try {
        let blob: Blob;
        let crc: number;
        if (data instanceof Uint8Array) {
          crc = crc32(data);
          blob = new Blob([data as BlobPart]);
        } else {
          crc = await crc32OfBlob(data, { signal: o.signal, onProgress: o.onProgress });
          blob = data;
        }
        rememberCrc32(blob, crc);
        if (counts) counted.set(blob, (counted.get(blob) ?? 0) + size);
        o.onProgress?.(size);
        return { blob, crc32: crc };
      } catch (e) {
        if (counts) used -= size;
        throw e;
      }
    },
    async available() {
      return Math.max(0, budget - used);
    },
    release(blob) {
      const n = counted.get(blob);
      if (!n) return;
      counted.delete(blob);
      used -= n;
    },
    async dispose() {
      used = 0;
    },
  };
}

export class OverlayLockedError extends Error {
  constructor() {
    super('Erst das heruntergeladene Paket auf die Karte bringen und die Karte prüfen. Danach geht das wieder.');
    this.name = 'OverlayLockedError';
  }
}

export interface Overlay {
  /** The card as the features see it. */
  readonly root: Dir;
  /** The snapshot as it was read; never changed. */
  readonly base: BlobFolder;
  /** The card as it is now. */
  readonly tree: BlobFolder;
  readonly store: ScratchStore;
  /** Goes up by one with every change. */
  readonly version: number;
  /** Writes started but not done yet (their data is still being stored). */
  readonly writing: number;
  readonly locked: boolean;
  onChange(cb: () => void): () => void;
  /**
   * While locked, only the app's own files in the root may change (catalog,
   * covers). `all`: nothing may change, not even those.
   */
  lock(all?: boolean): void;
  unlock(): void;
}

const APP_NAMES = new Set(APP_FILES.map((n) => n.toLowerCase()));

function readFailed(path: string, file: BlobFile, e: unknown): unknown {
  if (!(e instanceof DOMException) || e.name === 'AbortError') return e;
  const text = file.staged
    ? `Die vorbereitete Datei „${path}“ ließ sich nicht mehr lesen. Lies die Karte neu ein und versuche es noch einmal.`
    : `Die Datei „${path}“ ließ sich nicht lesen. Steckt die SD-Karte noch? Sonst lies die Karte neu ein.`;
  return new Error(text, { cause: e });
}

function contains(folder: BlobFolder, node: BlobNode): boolean {
  return folder.children.some((c) => c === node || (c.kind === 'directory' && contains(c, node)));
}

class OverlayImpl implements Overlay {
  readonly tree: BlobFolder;
  readonly root: BlobTreeDir;
  version = 0;
  writing = 0;
  locked = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly base: BlobFolder,
    readonly store: ScratchStore,
    label: string,
  ) {
    this.tree = cloneTree(base);
    this.tree.name = label;
    this.root = new BlobTreeDir(this, this.tree);
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private lockedAll = false;

  lock(all = false) {
    this.locked = true;
    this.lockedAll = all;
  }

  unlock() {
    this.locked = false;
    this.lockedAll = false;
  }

  changed() {
    this.version++;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        // A listener's trouble must not undo a change that already happened.
      }
    }
  }

  /** Throws while locked, unless `name` is one of the app's files in the root. */
  guard(folder: BlobFolder, name?: string) {
    if (!this.locked) return;
    if (!this.lockedAll && folder === this.tree && name !== undefined && APP_NAMES.has(name.toLowerCase())) return;
    throw new OverlayLockedError();
  }

  /** Path of an entry for messages, e.g. "05/003.mp3". */
  pathOf(folder: BlobFolder, name: string): string {
    const walk = (at: BlobFolder, prefix: string): string | null => {
      if (at === folder) return prefix;
      for (const c of at.children) {
        if (c.kind !== 'directory') continue;
        const found = walk(c, prefix ? `${prefix}/${c.name}` : c.name);
        if (found !== null) return found;
      }
      return null;
    };
    const dir = walk(this.tree, '');
    return dir ? `${dir}/${name}` : name;
  }

  /** Tells the store that staged data below `node` left the tree. */
  release(node: BlobNode) {
    if (!this.store.release) return;
    if (node.kind === 'file') {
      if (node.staged) this.store.release(node.blob);
      return;
    }
    for (const { file } of files(node)) if (file.staged) this.store.release(file.blob);
  }
}

class BlobTreeDir implements Dir {
  constructor(
    private readonly ov: OverlayImpl,
    private readonly node: BlobFolder,
  ) {}

  get name(): string {
    return this.node.name;
  }

  async list(): Promise<DirEntry[]> {
    return this.node.children.map((c) =>
      c.kind === 'file' ? { name: c.name, kind: 'file', size: c.blob.size, modified: c.modified } : { name: c.name, kind: 'directory', modified: c.modified },
    );
  }

  async dir(name: string, opts: { create?: boolean } = {}): Promise<Dir> {
    let c = childOf(this.node, name);
    if (!c) {
      if (!opts.create) throw new MemDirError(`${name} gibt es nicht.`, 'not-found');
      this.ov.guard(this.node);
      c = { kind: 'directory', name, children: [], modified: Date.now() };
      this.node.children.push(c);
      this.ov.changed();
    }
    if (c.kind !== 'directory') throw new MemDirError(`${name} ist kein Ordner.`, 'not-a-directory');
    return new BlobTreeDir(this.ov, c);
  }

  async exists(name: string): Promise<boolean> {
    return !!childOf(this.node, name);
  }

  private file(name: string): BlobFile {
    const c = childOf(this.node, name);
    if (!c) throw new MemDirError(`${name} gibt es nicht.`, 'not-found');
    if (c.kind !== 'file') throw new MemDirError(`${name} ist keine Datei.`, 'not-a-file');
    return c;
  }

  private async bytes(f: BlobFile, blob: Blob): Promise<Uint8Array> {
    try {
      return new Uint8Array(await blob.arrayBuffer());
    } catch (e) {
      throw readFailed(this.ov.pathOf(this.node, f.name), f, e);
    }
  }

  async read(name: string): Promise<Uint8Array> {
    const f = this.file(name);
    return this.bytes(f, f.blob);
  }

  async readRange(name: string, start: number, length: number): Promise<Uint8Array> {
    const f = this.file(name);
    return this.bytes(f, f.blob.slice(start, start + length));
  }

  async source(name: string): Promise<ByteSource> {
    const f = this.file(name);
    const { blob } = f;
    return {
      name: f.name,
      size: blob.size,
      blob,
      read: (start, length) => this.bytes(f, blob.slice(start, start + length)),
    };
  }

  async write(name: string, data: Uint8Array | Blob, opts: WriteOptions = {}): Promise<void> {
    opts.signal?.throwIfAborted();
    this.ov.guard(this.node, name);
    const before = childOf(this.node, name);
    if (before && before.kind !== 'file') throw new MemDirError(`${name} ist ein Ordner.`, 'not-a-file');
    let stored: Awaited<ReturnType<ScratchStore['put']>>;
    this.ov.writing++;
    try {
      stored = await this.ov.store.put(data, opts);
    } finally {
      this.ov.writing--;
    }
    const { blob, crc32: crc } = stored;
    // Things may have changed while the data was stored.
    const c = childOf(this.node, name);
    try {
      this.ov.guard(this.node, name);
      if (c && c.kind !== 'file') throw new MemDirError(`${name} ist ein Ordner.`, 'not-a-file');
    } catch (e) {
      this.ov.store.release?.(blob);
      throw e;
    }
    const modified = Date.now();
    if (c) {
      this.ov.release(c);
      Object.assign(c, { blob, crc32: crc, modified, staged: true });
    } else {
      this.node.children.push({ kind: 'file', name, blob, crc32: crc, modified, staged: true });
    }
    opts.onProgress?.(blob.size);
    this.ov.changed();
  }

  async remove(name: string, opts: { recursive?: boolean } = {}): Promise<void> {
    this.ov.guard(this.node, name);
    const c = childOf(this.node, name);
    if (!c) throw new MemDirError(`${name} gibt es nicht.`, 'not-found');
    if (c.kind === 'directory' && c.children.length && !opts.recursive) {
      throw new MemDirError(`${name} ist nicht leer.`, 'not-empty');
    }
    this.node.children.splice(this.node.children.indexOf(c), 1);
    this.ov.release(c);
    this.ov.changed();
  }

  async rename(from: string, to: string): Promise<void> {
    this.ov.guard(this.node);
    const c = childOf(this.node, from);
    if (!c) throw new MemDirError(`${from} gibt es nicht.`, 'not-found');
    const other = childOf(this.node, to);
    if (other && other !== c) throw new MemDirError(`${to} gibt es schon.`, 'exists');
    if (c.name === to) return;
    c.name = to;
    this.ov.changed();
  }

  async move(name: string, target: Dir, newName?: string): Promise<void> {
    if (!(target instanceof BlobTreeDir) || target.ov !== this.ov) throw new Error('Verschieben geht nur innerhalb der eingelesenen Karte.');
    this.ov.guard(this.node);
    const c = childOf(this.node, name);
    if (!c) throw new MemDirError(`${name} gibt es nicht.`, 'not-found');
    const to = newName ?? c.name;
    const other = childOf(target.node, to);
    if (other && other !== c) throw new MemDirError(`${to} gibt es schon.`, 'exists');
    if (c.kind === 'directory' && (c === target.node || contains(c, target.node))) {
      throw new Error(`${name} lässt sich nicht in sich selbst verschieben.`);
    }
    this.node.children.splice(this.node.children.indexOf(c), 1);
    c.name = to;
    target.node.children.push(c);
    this.ov.changed();
  }
}

/** A changeable card on top of `base`. The base tree itself is never changed. */
export function createOverlay(base: BlobFolder, store: ScratchStore, label: string): Overlay {
  return new OverlayImpl(base, store, label);
}
