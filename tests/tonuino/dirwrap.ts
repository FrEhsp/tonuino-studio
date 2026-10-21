import type { ByteSource, Dir, DirEntry, WriteOptions } from '../../src/platform/types';

/**
 * A Dir around another one for tests of the copy flows: notes every write
 * ("05/001.mp3"), can change what gets written, can stop after some writes,
 * and throws on every remove, rename and move (nothing may be deleted).
 */
export interface WrapOptions {
  /** Called with each file's path before it is written; may return other bytes. */
  onWrite?: (path: string, data: Uint8Array) => Uint8Array | void;
  /** Throw on remove, rename and move (default). */
  noRemove?: boolean;
}

export class WrapDir implements Dir {
  constructor(
    readonly inner: Dir,
    readonly log: string[] = [],
    private readonly opts: WrapOptions = { noRemove: true },
    private readonly prefix = '',
  ) {}

  get name(): string {
    return this.inner.name;
  }

  list(): Promise<DirEntry[]> {
    return this.inner.list();
  }

  async dir(name: string, opts?: { create?: boolean }): Promise<Dir> {
    return new WrapDir(await this.inner.dir(name, opts), this.log, this.opts, `${this.prefix}${name}/`);
  }

  exists(name: string): Promise<boolean> {
    return this.inner.exists(name);
  }

  read(name: string): Promise<Uint8Array> {
    return this.inner.read(name);
  }

  readRange(name: string, start: number, length: number): Promise<Uint8Array> {
    return this.inner.readRange(name, start, length);
  }

  source(name: string): Promise<ByteSource> {
    return this.inner.source(name);
  }

  async write(name: string, data: Uint8Array | Blob, opts?: WriteOptions): Promise<void> {
    const path = `${this.prefix}${name}`;
    let bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
    const changed = this.opts.onWrite?.(path, bytes);
    if (changed) bytes = changed;
    await this.inner.write(name, bytes, opts);
    this.log.push(path);
  }

  async remove(name: string, opts?: { recursive?: boolean }): Promise<void> {
    if (this.opts.noRemove !== false) throw new Error(`remove ${this.prefix}${name}`);
    return this.inner.remove(name, opts);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.opts.noRemove !== false) throw new Error(`rename ${this.prefix}${from}`);
    return this.inner.rename(from, to);
  }

  async move(name: string, target: Dir, newName?: string): Promise<void> {
    if (this.opts.noRemove !== false) throw new Error(`move ${this.prefix}${name}`);
    return this.inner.move(name, target instanceof WrapDir ? target.inner : target, newName);
  }
}
