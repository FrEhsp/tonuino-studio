import type { ByteSource, Dir, DirEntry, WriteOptions } from './types';

/**
 * A Dir that lives in memory. Used by tests and by the demo card. Behaves like
 * FAT: names are case-insensitive but keep their case, and entries stay in the
 * order they were created in.
 */

interface MemNode {
  name: string;
  kind: 'file' | 'directory';
  data?: Uint8Array;
  children?: MemNode[];
  modified: number;
}

export type MemTree = { [name: string]: MemTree | string | Uint8Array | number };

export class MemDirError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'exists' | 'not-empty' | 'not-a-directory' | 'not-a-file',
  ) {
    super(message);
    this.name = 'MemDirError';
  }
}

function find(parent: MemNode, name: string): MemNode | undefined {
  const n = name.toLowerCase();
  return parent.children!.find((c) => c.name.toLowerCase() === n);
}

function toBytes(data: Uint8Array | Blob): Promise<Uint8Array> {
  return data instanceof Uint8Array ? Promise.resolve(data) : data.arrayBuffer().then((b) => new Uint8Array(b));
}

export class MemDir implements Dir {
  constructor(
    private readonly node: MemNode,
    readonly path?: string,
  ) {}

  get name(): string {
    return this.node.name;
  }

  async list(): Promise<DirEntry[]> {
    return this.node.children!.map((c) => ({
      name: c.name,
      kind: c.kind,
      size: c.kind === 'file' ? c.data!.length : undefined,
      modified: c.modified,
    }));
  }

  async dir(name: string, opts: { create?: boolean } = {}): Promise<Dir> {
    let c = find(this.node, name);
    if (!c) {
      if (!opts.create) throw new MemDirError(`${name} gibt es nicht.`, 'not-found');
      c = { name, kind: 'directory', children: [], modified: Date.now() };
      this.node.children!.push(c);
    }
    if (c.kind !== 'directory') throw new MemDirError(`${name} ist kein Ordner.`, 'not-a-directory');
    return new MemDir(c, this.path ? `${this.path}/${c.name}` : undefined);
  }

  async exists(name: string): Promise<boolean> {
    return !!find(this.node, name);
  }

  private file(name: string): MemNode {
    const c = find(this.node, name);
    if (!c) throw new MemDirError(`${name} gibt es nicht.`, 'not-found');
    if (c.kind !== 'file') throw new MemDirError(`${name} ist keine Datei.`, 'not-a-file');
    return c;
  }

  async read(name: string): Promise<Uint8Array> {
    return this.file(name).data!.slice();
  }

  async readRange(name: string, start: number, length: number): Promise<Uint8Array> {
    return this.file(name).data!.slice(start, start + length);
  }

  async source(name: string): Promise<ByteSource> {
    const f = this.file(name);
    return memSource(f.name, f.data!);
  }

  async write(name: string, data: Uint8Array | Blob, opts?: WriteOptions): Promise<void> {
    opts?.signal?.throwIfAborted();
    const bytes = await toBytes(data);
    const c = find(this.node, name);
    if (c && c.kind !== 'file') throw new MemDirError(`${name} ist ein Ordner.`, 'not-a-file');
    if (c) {
      c.data = bytes.slice();
      c.modified = Date.now();
    } else {
      this.node.children!.push({ name, kind: 'file', data: bytes.slice(), modified: Date.now() });
    }
    opts?.onProgress?.(bytes.length);
  }

  async remove(name: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const c = find(this.node, name);
    if (!c) throw new MemDirError(`${name} gibt es nicht.`, 'not-found');
    if (c.kind === 'directory' && c.children!.length && !opts.recursive) {
      throw new MemDirError(`${name} ist nicht leer.`, 'not-empty');
    }
    this.node.children!.splice(this.node.children!.indexOf(c), 1);
  }

  async rename(from: string, to: string): Promise<void> {
    const c = find(this.node, from);
    if (!c) throw new MemDirError(`${from} gibt es nicht.`, 'not-found');
    const other = find(this.node, to);
    if (other && other !== c) throw new MemDirError(`${to} gibt es schon.`, 'exists');
    c.name = to;
  }

  async move(name: string, target: Dir, newName?: string): Promise<void> {
    if (!(target instanceof MemDir)) throw new Error('MemDir can only move into another MemDir.');
    const c = find(this.node, name);
    if (!c) throw new MemDirError(`${name} gibt es nicht.`, 'not-found');
    const to = newName ?? c.name;
    const other = find(target.node, to);
    if (other && other !== c) throw new MemDirError(`${to} gibt es schon.`, 'exists');
    this.node.children!.splice(this.node.children!.indexOf(c), 1);
    c.name = to;
    target.node.children!.push(c);
  }
}

export function memSource(name: string, data: Uint8Array, relativePath?: string): ByteSource {
  return {
    name,
    size: data.length,
    relativePath,
    read: async (start, length) => data.slice(start, start + length),
  };
}

/**
 * Builds a directory from a plain object. Strings and byte arrays become
 * files, numbers become zero-filled files of that size, objects folders.
 * Object key order is the directory order.
 */
export function memDir(tree: MemTree = {}, name = 'SD'): MemDir {
  const build = (n: string, t: MemTree): MemNode => ({
    name: n,
    kind: 'directory',
    modified: 0,
    children: Object.entries(t).map(([k, v]): MemNode => {
      if (typeof v === 'string') return { name: k, kind: 'file', data: new TextEncoder().encode(v), modified: 0 };
      if (typeof v === 'number') return { name: k, kind: 'file', data: new Uint8Array(v), modified: 0 };
      if (v instanceof Uint8Array) return { name: k, kind: 'file', data: v, modified: 0 };
      return build(k, v);
    }),
  });
  return new MemDir(build(name, tree));
}

/** Snapshot of a directory as nested names, in directory order (for tests and debugging). */
export async function memTreeNames(dir: Dir): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const e of await dir.list()) {
    out[e.name] = e.kind === 'directory' ? await memTreeNames(await dir.dir(e.name)) : e.size;
  }
  return out;
}
