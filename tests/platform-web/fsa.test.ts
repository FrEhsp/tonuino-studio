import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { FsaDir } from '../../src/platform/web/fsa';
import { scanSd } from '../../src/core/tonuino/sd';
import { newCatalog, saveCatalog } from '../../src/core/tonuino/catalog';
import { saveCovers } from '../../src/core/tonuino/covers';
import { executePlan, planReorder } from '../../src/core/tonuino/repair';
import { installSystemSounds, readSoundPackage } from '../../src/core/tonuino/soundsinstall';

/**
 * A small stand-in for the File System Access API with Chrome's behaviour:
 * file handles have move(), which replaces an existing file without asking;
 * folder handles have none; saving goes through a visible "*.crswap" file;
 * names are case-sensitive (like the origin private file system).
 */
interface Options {
  failMove?: (name: string) => boolean;
  failWrite?: (name: string) => boolean;
  /** Like macOS on a FAT card: a hidden "._" twin appears next to every file written or moved. */
  macTwins?: boolean;
  /** Entries that cannot be removed; a string is the name of the error the browser gives. */
  failRemove?: (name: string) => boolean | string;
  /** Like Safari and Firefox: file handles without move(). */
  noMove?: boolean;
  /** A write that ends without an error but a byte short, like a card pulled at the wrong moment. */
  shortWrite?: (name: string) => boolean;
}

/** What macOS writes next to a file on FAT (AppleDouble). */
function appleDouble(parent: FakeDir, name: string) {
  if (parent.options.macTwins && !name.startsWith('._')) parent.children.set(`._${name}`, { kind: 'file', data: new Uint8Array(4096) });
}

interface Stats {
  writables: number;
}

type FakeNode = FakeDir | { kind: 'file'; data: Uint8Array };

const domError = (name: string, message = name) => new DOMException(message, name);

class FakeFileHandle {
  readonly kind = 'file';
  constructor(
    private parent: FakeDir,
    public name: string,
  ) {}

  private node(): { kind: 'file'; data: Uint8Array } {
    const n = this.parent.children.get(this.name);
    if (!n || n.kind !== 'file') throw domError('NotFoundError');
    return n;
  }

  async getFile(): Promise<File> {
    return new File([this.node().data as BlobPart], this.name, { lastModified: 1 });
  }

  async createWritable() {
    this.node();
    const parent = this.parent;
    const target = this.name;
    const swap = `${target}.crswap`;
    parent.stats.writables++;
    parent.children.set(swap, { kind: 'file', data: new Uint8Array(0) });
    const parts: Uint8Array[] = [];
    return {
      write: async (blob: Blob) => {
        if (parent.options.failWrite?.(target)) throw domError('QuotaExceededError');
        parts.push(new Uint8Array(await blob.arrayBuffer()));
      },
      close: async () => {
        const length = parts.reduce((n, p) => n + p.length, 0);
        const data = new Uint8Array(parent.options.shortWrite?.(target) ? Math.max(0, length - 1) : length);
        let at = 0;
        for (const p of parts) {
          data.set(p.subarray(0, Math.max(0, data.length - at)), at);
          at += p.length;
        }
        parent.children.delete(swap);
        parent.children.set(target, { kind: 'file', data });
        appleDouble(parent, target);
      },
      abort: async () => {
        parent.children.delete(swap);
      },
    };
  }

  /** Like Chrome: an existing file at the target is replaced. */
  async move(target: FakeDir, name: string): Promise<void> {
    if (this.parent.options.failMove?.(this.name)) throw domError('NoModificationAllowedError');
    const node = this.node();
    this.parent.children.delete(this.name);
    target.children.delete(name);
    target.children.set(name, node);
    appleDouble(target, name);
    this.parent = target;
    this.name = name;
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other instanceof FakeFileHandle && other.parent === this.parent && other.name === this.name;
  }
}

class FakeDir {
  readonly kind = 'directory';
  readonly children = new Map<string, FakeNode>();
  constructor(
    public name: string,
    readonly options: Options,
    readonly stats: Stats,
  ) {}

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeFileHandle> {
    const n = this.children.get(name);
    if (n?.kind === 'directory') throw domError('TypeMismatchError');
    if (!n) {
      if (!opts.create) throw domError('NotFoundError');
      this.children.set(name, { kind: 'file', data: new Uint8Array(0) });
    }
    return this.handle(name);
  }

  private handle(name: string): FakeFileHandle {
    const h = new FakeFileHandle(this, name);
    if (this.options.noMove) Object.defineProperty(h, 'move', { value: undefined });
    return h;
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeDir> {
    const n = this.children.get(name);
    if (n && n.kind !== 'directory') throw domError('TypeMismatchError');
    if (n) return n;
    if (!opts.create) throw domError('NotFoundError');
    const d = new FakeDir(name, this.options, this.stats);
    this.children.set(name, d);
    return d;
  }

  async removeEntry(name: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const n = this.children.get(name);
    if (!n) throw domError('NotFoundError');
    const fail = this.options.failRemove?.(name);
    if (fail) throw domError(typeof fail === 'string' ? fail : 'NoModificationAllowedError');
    if (n.kind === 'directory' && n.children.size && !opts.recursive) throw domError('InvalidModificationError');
    this.children.delete(name);
  }

  async *entries(): AsyncGenerator<[string, FakeDir | FakeFileHandle]> {
    for (const [name, n] of [...this.children]) yield [name, n.kind === 'directory' ? n : this.handle(name)];
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }
}

type Tree = { [name: string]: string | Tree };

function fakeCard(tree: Tree, options: Options = {}) {
  const stats: Stats = { writables: 0 };
  const build = (d: FakeDir, t: Tree) => {
    for (const [name, v] of Object.entries(t)) {
      if (typeof v === 'string') d.children.set(name, { kind: 'file', data: new TextEncoder().encode(v) });
      else build(d.children.set(name, new FakeDir(name, options, stats)).get(name) as FakeDir, v);
    }
  };
  const handle = new FakeDir('SD', options, stats);
  build(handle, tree);
  return { root: new FsaDir(handle as unknown as FileSystemDirectoryHandle), handle, stats };
}

/** The card as names and contents, in directory order. */
function dump(d: FakeDir): Tree {
  const out: Tree = {};
  for (const [name, n] of d.children) out[name] = n.kind === 'directory' ? dump(n) : new TextDecoder().decode(n.data);
  return out;
}

describe('FsaDir', () => {
  it('never replaces a file when renaming or moving', async () => {
    const { root, handle } = fakeCard({ a: { '001.mp3': 'A', '002.mp3': 'B', '003.mp3': 'C' }, temp: { '003.mp3': 'WARTET' } });
    const a = await root.dir('a');
    await expect(a.rename('001.mp3', '002.mp3')).rejects.toThrow('002.mp3 gibt es schon.');
    await expect(a.move('003.mp3', await root.dir('temp'))).rejects.toThrow('003.mp3 gibt es dort schon.');
    expect(dump(handle)).toEqual({ a: { '001.mp3': 'A', '002.mp3': 'B', '003.mp3': 'C' }, temp: { '003.mp3': 'WARTET' } });
    await a.rename('001.mp3', '004.mp3');
    await a.move('003.mp3', await root.dir('temp'), '001.mp3');
    expect(dump(handle)).toEqual({ a: { '002.mp3': 'B', '004.mp3': 'A' }, temp: { '003.mp3': 'WARTET', '001.mp3': 'C' } });
  });

  it('changes only the case of a name, but not onto another file', async () => {
    const { root, handle } = fakeCard({ '001.MP3': 'A', 'X.mp3': 'B', 'x.mp3': 'C' });
    await root.rename('001.MP3', '001.mp3');
    await expect(root.rename('X.mp3', 'x.mp3')).rejects.toThrow('x.mp3 gibt es schon.');
    expect(dump(handle)).toEqual({ 'X.mp3': 'B', 'x.mp3': 'C', '001.mp3': 'A' });
  });

  it('renames a folder by moving its files, without copying them', async () => {
    const { root, handle, stats } = fakeCard({ '5': { '001.mp3': 'A', '002.mp3': 'B', Bonus: { 'x.mp3': 'X' } } });
    await root.rename('5', '05');
    expect(dump(handle)).toEqual({ '05': { '001.mp3': 'A', '002.mp3': 'B', Bonus: { 'x.mp3': 'X' } } });
    // A copy would need free space and could stop half way on a full card.
    expect(stats.writables).toBe(0);
  });

  it('puts everything back when a folder cannot be moved completely', async () => {
    const { root, handle } = fakeCard({ '5': { '001.mp3': 'A', Bonus: { 'x.mp3': 'X' }, '002.mp3': 'B' } }, { failMove: (n) => n === '002.mp3' });
    await expect(root.rename('5', '05')).rejects.toThrow(/gesperrt/);
    expect(dump(handle)).toEqual({ '5': { '001.mp3': 'A', Bonus: { 'x.mp3': 'X' }, '002.mp3': 'B' } });
  });

  it('without move() copies a folder, checks every file and only then removes the original', async () => {
    const { root, handle } = fakeCard({ '45': { '001.mp3': 'AAA', '002.mp3': 'BBB' }, '03': { '001.mp3': 'C' } }, { noMove: true });
    await root.rename('45', '05');
    expect(dump(handle)).toEqual({ '03': { '001.mp3': 'C' }, '05': { '001.mp3': 'AAA', '002.mp3': 'BBB' } });
  });

  it('without move() keeps the original and drops the copy when a file arrives short', async () => {
    const { root, handle } = fakeCard({ '45': { '001.mp3': 'AAA', '002.mp3': 'BBB' } }, { noMove: true, shortWrite: (n) => n === '002.mp3' });
    await expect(root.rename('45', '05')).rejects.toThrow('nicht vollständig');
    expect(dump(handle)).toEqual({ '45': { '001.mp3': 'AAA', '002.mp3': 'BBB' } });
  });

  it('does not merge a folder into one that exists', async () => {
    const { root, handle } = fakeCard({ '5': { '001.mp3': 'A' }, '05': { '001.mp3': 'B' } });
    await expect(root.rename('5', '05')).rejects.toThrow('05 gibt es schon.');
    expect(dump(handle)).toEqual({ '5': { '001.mp3': 'A' }, '05': { '001.mp3': 'B' } });
  });

  it('leaves no new file behind when writing fails, and keeps an old one', async () => {
    const { root, handle } = fakeCard({ 'alt.json': 'ALT' }, { failWrite: () => true });
    await expect(root.write('neu.mp3', new Uint8Array([1, 2, 3]))).rejects.toThrow(/voll/);
    await expect(root.write('alt.json', new TextEncoder().encode('NEU'))).rejects.toThrow(/voll/);
    expect(dump(handle)).toEqual({ 'alt.json': 'ALT' });
  });

  it("lists Chrome's swap files, so a left-over one can be cleaned up", async () => {
    const { root } = fakeCard({ '01': { '001.mp3': 'A' }, 'tonuino-studio.json.crswap': '' });
    expect((await root.list()).map((e) => e.name)).toContain('tonuino-studio.json.crswap');
    expect((await scanSd(root)).rootJunk.map((e) => e.name)).toEqual(['tonuino-studio.json.crswap']);
  });

  it('says a folder is not empty instead of blaming the lock switch', async () => {
    const { root } = fakeCard({ '05': { '001.mp3': 'A' } });
    await expect(root.remove('05')).rejects.toThrow('05 löschen: Der Ordner ist nicht leer.');
  });

  it('does not call a file that cannot be deleted a folder', async () => {
    const { root } = fakeCard({ '05': { '001.mp3': 'A' } }, { failRemove: (n) => n === '001.mp3' && 'InvalidModificationError' });
    const folder = await root.dir('05');
    await expect(folder.remove('001.mp3')).rejects.toThrow('001.mp3 löschen: Die Datei ist gesperrt oder schreibgeschützt. Ist der Schreibschutzschalter der SD-Karte auf „Lock“?');
  });

  it("removes the Mac's hidden twin of a file it writes, renames or moves, and no other", async () => {
    const { root, handle } = fakeCard({ '01': { '._notes.txt': 'MAC', '001.mp3': 'A' }, temp: {} }, { macTwins: true });
    const folder = await root.dir('01');
    await folder.write('002.mp3', new TextEncoder().encode('B'));
    await root.write('tonuino-studio.json', new TextEncoder().encode('{}'));
    await folder.rename('001.mp3', '003.mp3');
    await folder.move('002.mp3', await root.dir('temp'), '009.mp3');
    expect(dump(handle)).toEqual({ '01': { '._notes.txt': 'MAC', '003.mp3': 'A' }, temp: { '009.mp3': 'B' }, 'tonuino-studio.json': '{}' });
  });

  it('leaves no twin behind when it installs announcements, reorders, or saves catalog and covers', async () => {
    // These write through the same Dir as adding tracks does, so they get the same clean-up.
    const { root, handle } = fakeCard({ '03': { '001.mp3': 'A', '002.mp3': 'B' } }, { macTwins: true });
    const zip = new JSZip();
    zip.file('sd-card/mp3/0001.mp3', 'M');
    zip.file('sd-card/advert/0001.mp3', 'W');
    await installSystemSounds(root, await readSoundPackage(await zip.generateAsync({ type: 'uint8array' })));
    const plan = planReorder((await scanSd(root)).folders[0], ['002.mp3', '001.mp3'], { pureNumbers: true });
    expect((await executePlan(root, plan)).error).toBeUndefined();
    await saveCatalog(root, newCatalog());
    await saveCovers(root, new Map([['03.jpg', new Uint8Array([1])]]));
    const names = (d: Tree): string[] => Object.entries(d).flatMap(([n, v]) => (typeof v === 'string' ? [n] : [n, ...names(v)]));
    expect(names(dump(handle)).filter((n) => n.startsWith('._'))).toEqual([]);
    expect(dump(handle)['03']).toEqual({ '001.mp3': 'B', '002.mp3': 'A' });
  });

  it('writes even when a twin cannot be removed', async () => {
    const { root, handle } = fakeCard({}, { macTwins: true, failRemove: (n) => n.startsWith('._') });
    await root.write('001.mp3', new TextEncoder().encode('A'));
    expect(Object.keys(dump(handle))).toEqual(['001.mp3', '._001.mp3']);
  });
});
