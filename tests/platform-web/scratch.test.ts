/**
 * Where new files wait for the Paket in the browser: the origin private
 * file system when it works, memory otherwise. A small stand-in for OPFS
 * plays the browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32, knownCrc32 } from '../../src/core/zip/crc32';
import { ScratchFullError } from '../../src/platform/overlay';
import { cleanupScratch, createScratchStore } from '../../src/platform/web/scratch';

const MiB = 1024 * 1024;

interface Opts {
  /** Bytes the whole store may hold. */
  quota?: number;
  /** Safari before 26: no createWritable outside a worker. */
  noWritable?: boolean;
}

class FakeFile {
  readonly kind = 'file';
  data = new Uint8Array(0);
  constructor(
    readonly name: string,
    private readonly fs: FakeFs,
  ) {
    if (fs.opts.noWritable) (this as { createWritable?: unknown }).createWritable = undefined;
  }

  async getFile(): Promise<File> {
    return new File([this.data as BlobPart], this.name);
  }

  async createWritable() {
    const parts: Uint8Array[] = [];
    let open = true;
    this.fs.writables++;
    return {
      write: async (d: Uint8Array | Blob) => {
        if (!open) throw new TypeError('closed');
        const bytes = d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : new Uint8Array(d);
        const pending = parts.reduce((n, p) => n + p.length, 0) + bytes.length;
        if (this.fs.used() + pending > (this.fs.opts.quota ?? Infinity)) throw new DOMException('voll', 'QuotaExceededError');
        parts.push(bytes);
      },
      close: async () => {
        open = false;
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
          all.set(p, at);
          at += p.length;
        }
        this.data = all;
      },
      abort: async () => {
        open = false;
        this.fs.aborted++;
      },
    };
  }
}

class FakeDir {
  readonly kind = 'directory';
  readonly children = new Map<string, FakeDir | FakeFile>();
  constructor(
    readonly name: string,
    private readonly fs: FakeFs,
  ) {}

  async getDirectoryHandle(name: string, o: { create?: boolean } = {}): Promise<FakeDir> {
    let c = this.children.get(name);
    if (!c && o.create) this.children.set(name, (c = new FakeDir(name, this.fs)));
    if (!c) throw new DOMException(name, 'NotFoundError');
    if (!(c instanceof FakeDir)) throw new DOMException(name, 'TypeMismatchError');
    return c;
  }

  async getFileHandle(name: string, o: { create?: boolean } = {}): Promise<FakeFile> {
    let c = this.children.get(name);
    if (!c && o.create) this.children.set(name, (c = new FakeFile(name, this.fs)));
    if (!c) throw new DOMException(name, 'NotFoundError');
    if (!(c instanceof FakeFile)) throw new DOMException(name, 'TypeMismatchError');
    return c;
  }

  async removeEntry(name: string, o: { recursive?: boolean } = {}): Promise<void> {
    const c = this.children.get(name);
    if (!c) throw new DOMException(name, 'NotFoundError');
    if (c instanceof FakeDir && c.children.size && !o.recursive) throw new DOMException(name, 'InvalidModificationError');
    this.children.delete(name);
  }

  async *keys(): AsyncGenerator<string> {
    yield* [...this.children.keys()];
  }

  bytes(): number {
    let n = 0;
    for (const c of this.children.values()) n += c instanceof FakeDir ? c.bytes() : c.data.length;
    return n;
  }
}

class FakeFs {
  readonly root: FakeDir;
  writables = 0;
  aborted = 0;
  constructor(readonly opts: Opts = {}) {
    this.root = new FakeDir('', this);
  }

  used(): number {
    return this.root.bytes();
  }

  /** The folders of this session's store: tonuino-studio-staging/s-…/ */
  sessions(): FakeDir[] {
    const top = this.root.children.get('tonuino-studio-staging');
    return top instanceof FakeDir ? ([...top.children.values()] as FakeDir[]) : [];
  }
}

/** Web Locks as a browser keeps them for this origin: one holder per name, across all tabs. */
class FakeLocks {
  readonly held = new Set<string>();
  readonly waiting = new Map<string, (() => void)[]>();

  async request(name: string, opts: { ifAvailable?: boolean }, cb: (lock: { name: string } | null) => unknown): Promise<unknown> {
    if (this.held.has(name)) {
      if (opts.ifAvailable) return cb(null);
      await new Promise<void>((resolve) => this.waiting.set(name, [...(this.waiting.get(name) ?? []), resolve]));
    }
    this.held.add(name);
    try {
      return await cb({ name });
    } finally {
      this.held.delete(name);
      const next = this.waiting.get(name)?.shift();
      next?.();
    }
  }

  /** Another tab that holds the lock until the returned function is called. */
  holdElsewhere(name: string): () => void {
    let release = () => {};
    void this.request(name, {}, () => new Promise<void>((resolve) => (release = resolve)));
    return () => release();
  }
}

let locks: FakeLocks | undefined;

function useStorage(storage: unknown) {
  vi.stubGlobal('navigator', { storage, ...(locks ? { locks } : {}) });
}

function opfs(opts: Opts = {}): FakeFs {
  const fs = new FakeFs(opts);
  useStorage({
    getDirectory: async () => fs.root,
    estimate: async () => ({ quota: opts.quota ?? 10 * MiB, usage: fs.used() }),
  });
  return fs;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Byte for byte, without the deep comparison that takes ages on megabytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

function bytes(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  locks = undefined;
});

describe('the store for new files', () => {
  it('keeps big files on disk and small ones in memory, with their checksums', async () => {
    const fs = opfs();
    const store = await createScratchStore();
    expect(store.kind).toBe('opfs');
    const [session] = fs.sessions();
    // The probe is gone again.
    expect([...session.children.keys()]).toEqual([]);

    const small = bytes(1000);
    const a = await store.put(small);
    expect(a.crc32).toBe(crc32(small));
    expect([...session.children.keys()]).toEqual([]);

    const big = bytes(3 * MiB + 5);
    const seen: number[] = [];
    const b = await store.put(new Blob([big as BlobPart]), { onProgress: (n) => seen.push(n) });
    expect([...session.children.keys()]).toEqual(['1.bin']);
    expect(same(new Uint8Array(await b.blob.arrayBuffer()), big)).toBe(true);
    expect(b.crc32).toBe(crc32(big));
    expect(knownCrc32(b.blob)).toBe(b.crc32);
    expect(seen.at(-1)).toBe(big.length);

    const c = await store.put(bytes(2 * MiB, 9));
    expect([...session.children.keys()]).toEqual(['1.bin', '2.bin']);
    expect(c.crc32).toBe(crc32(bytes(2 * MiB, 9)));
    expect(await store.available()).toBe(10 * MiB - fs.used());

    await store.dispose();
    expect(fs.sessions()).toEqual([]);
  });

  it('says clearly when the disk is full, and leaves nothing behind', async () => {
    const fs = opfs({ quota: 2 * MiB });
    const store = await createScratchStore();
    const err = await store.put(bytes(3 * MiB)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScratchFullError);
    expect((err as ScratchFullError).reason).toBe('quota');
    expect((err as Error).message).toBe('Für so viel Musik auf einmal hat der Browser zu wenig Platz. Nimm weniger Alben auf einmal.');
    expect(fs.aborted).toBe(1);
    expect([...fs.sessions()[0].children.keys()]).toEqual([]);
  });

  it('stops when cancelled, and leaves nothing behind', async () => {
    const fs = opfs();
    const store = await createScratchStore();
    const ctrl = new AbortController();
    const err = await store
      .put(bytes(4 * MiB), {
        signal: ctrl.signal,
        onProgress: () => ctrl.abort(),
      })
      .catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
    expect([...fs.sessions()[0].children.keys()]).toEqual([]);
  });

  it('holds new files in memory in a private window, and says why it is full', async () => {
    useStorage({
      getDirectory: async () => {
        throw new DOMException('Security error', 'SecurityError');
      },
    });
    // Only during development: a small budget to try the message.
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'tonuino-studio:dev-scratch-budget' ? String(1.5 * MiB) : null) });
    const store = await createScratchStore();
    expect(store.kind).toBe('memory');
    const err = await store.put(bytes(2 * MiB)).catch((e: unknown) => e);
    expect((err as ScratchFullError).reason).toBe('private');
  });

  it('holds new files in memory when the browser cannot write files there (Safari before 26)', async () => {
    const fs = opfs({ noWritable: true });
    const store = await createScratchStore();
    expect(store.kind).toBe('memory');
    // The folder for the probe went again.
    expect(fs.sessions()).toEqual([]);
    vi.stubGlobal('localStorage', { getItem: () => String(1.5 * MiB) });
    const again = await createScratchStore();
    expect((await again.put(bytes(2 * MiB)).catch((e: unknown) => e)) as ScratchFullError).toMatchObject({ reason: 'budget' });
  });

  it('holds new files in memory without any storage of its own', async () => {
    useStorage(undefined);
    expect((await createScratchStore()).kind).toBe('memory');
  });
});

describe('cleaning up', () => {
  it('removes what earlier visits left after two days', async () => {
    locks = new FakeLocks();
    const fs = opfs();
    const top = await fs.root.getDirectoryHandle('tonuino-studio-staging', { create: true });
    const now = Date.now();
    await top.getDirectoryHandle(`s-${now - 49 * 3600_000}-abc`, { create: true });
    await top.getDirectoryHandle(`s-${now - 3600_000}-def`, { create: true });
    await top.getDirectoryHandle('etwas', { create: true });
    await cleanupScratch();
    expect([...top.children.keys()]).toEqual([`s-${now - 3600_000}-def`]);
  });

  it('keeps the files of a tab that is still open, however old', async () => {
    locks = new FakeLocks();
    const fs = opfs();
    // A tab opened three days ago that still waits for its Paket.
    const threeDaysAgo = Date.now() - 72 * 3600_000;
    vi.spyOn(Date, 'now').mockReturnValue(threeDaysAgo);
    const store = await createScratchStore();
    vi.mocked(Date.now).mockRestore();
    await store.put(bytes(2 * MiB));
    await settle();
    const [open] = fs.sessions();
    expect(open.name).toMatch(new RegExp(`^s-${threeDaysAgo}-`));
    expect(locks.held.has(`tonuino-studio-scratch:${open.name}`)).toBe(true);
    // Another tab of the same visit, as old, that is still open too.
    const top = await fs.root.getDirectoryHandle('tonuino-studio-staging');
    const other = `s-${threeDaysAgo}-zzz`;
    await top.getDirectoryHandle(other, { create: true });
    const releaseOther = locks.holdElsewhere(`tonuino-studio-scratch:${other}`);
    // And one whose tab is gone.
    await top.getDirectoryHandle(`s-${threeDaysAgo}-old`, { create: true });

    await cleanupScratch();
    expect([...top.children.keys()].sort()).toEqual([open.name, other].sort());
    expect([...open.children.keys()]).toEqual(['1.bin']);

    // Once the other tab is closed, its files go with the next cleanup.
    releaseOther();
    await settle();
    await cleanupScratch();
    expect([...top.children.keys()]).toEqual([open.name]);

    // Done with the Paket: the store removes its folder and lets the lock go.
    await store.dispose();
    await settle();
    expect(fs.sessions()).toEqual([]);
    expect(locks.held.size).toBe(0);
  });

  it('removes nothing when the browser cannot tell which tabs are open', async () => {
    const fs = opfs();
    const top = await fs.root.getDirectoryHandle('tonuino-studio-staging', { create: true });
    await top.getDirectoryHandle(`s-${Date.now() - 72 * 3600_000}-abc`, { create: true });
    await cleanupScratch();
    expect(top.children.size).toBe(1);
  });

  it('never fails', async () => {
    useStorage({
      getDirectory: async () => {
        throw new Error('kaputt');
      },
    });
    await expect(cleanupScratch()).resolves.toBeUndefined();
    useStorage(undefined);
    await expect(cleanupScratch()).resolves.toBeUndefined();
    opfs();
    await expect(cleanupScratch()).resolves.toBeUndefined();
  });
});
