import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  buildPackageBlob,
  crcPending,
  entryOrder,
  fat32Limits,
  isCardPackage,
  knownFoldersMissing,
  manifestFromZip,
  manifestOf,
  PACKAGE_FILE_PATTERN,
  packageContent,
  packageName,
  topLevelOrder,
  type TopEntry,
} from '../../src/core/tonuino/package';
import { CATALOG_FILE, COVERS_FILE } from '../../src/core/tonuino/sd';
import { diffForPackage } from '../../src/core/tonuino/writeplan';
import { crc32 } from '../../src/core/zip/crc32';
import { readZipDirectory } from '../../src/core/zip/zipreader';
import { EMPTY_ZIP } from '../../src/core/zip/zipwriter';
import { files, type BlobFile } from '../../src/platform/blobtree';
import type { MemTree } from '../../src/platform/memory';
import { createOverlay, memoryScratch } from '../../src/platform/overlay';
import { blobTree, GoneBlob } from '../platform/blobfixtures';
import { hasTool, tool, withTool } from '../zip/helpers';

const enc = new TextEncoder();

const CARD: MemTree = {
  '02': { '002.mp3': 'zwei', '001.mp3': 'eins', '._001.mp3': 'mac', Extra: { 'b.txt': 'b' } },
  Musik: { 'lied.mp3': 'la' },
  advert: { '0001.mp3': 'werbung' },
  mp3: { '0002.mp3': 'b', '0001.mp3': 'a' },
  '01': { '010.mp3': 'zehn', '002.mp3': 'zwei', '001 Intro.mp3': 'intro' },
  '.Trashes': { x: 'x' },
  'liesmich.txt': 'hallo',
  [COVERS_FILE]: 'PK',
  [CATALOG_FILE]: '{}',
  '_tonuino-studio-temp-03': { '._a': 'x' },
};

function setup(tree: MemTree = CARD) {
  const base = blobTree(tree, 'TONUINO');
  const ov = createOverlay(base, memoryScratch(), 'TONUINO');
  return { base, ov, plan: () => diffForPackage(base, ov.tree) };
}

async function zipNames(blob: Blob): Promise<string[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dir = await readZipDirectory(async (s, l) => bytes.slice(s, s + l), bytes.length);
  return dir.entries.map((e) => e.path);
}

describe('order', () => {
  it('puts the root in the order the box wants it', () => {
    const tops: TopEntry[] = [
      { name: 'liesmich.txt', entry: 'file' },
      { name: COVERS_FILE, entry: 'file' },
      { name: '10', entry: 'directory' },
      { name: 'Zeug', entry: 'directory' },
      { name: CATALOG_FILE, entry: 'file' },
      { name: '02', entry: 'directory' },
      { name: 'ADVERT', entry: 'directory' },
      { name: 'Andere', entry: 'directory' },
      { name: 'MP3', entry: 'directory' },
      { name: '00', entry: 'directory' },
    ];
    expect(tops.sort(topLevelOrder).map((t) => t.name)).toEqual(['MP3', 'ADVERT', '02', '10', CATALOG_FILE, COVERS_FILE, '00', 'Andere', 'Zeug', 'liesmich.txt']);
  });

  it('puts numbered names first, by number', () => {
    expect(['b.txt', '010.mp3', 'A.txt', '002.mp3', '2 doppelt.mp3', '001 Intro.mp3'].sort(entryOrder)).toEqual([
      '001 Intro.mp3',
      '002.mp3',
      '2 doppelt.mp3',
      '010.mp3',
      'A.txt',
      'b.txt',
    ]);
  });
});

describe('packageContent', () => {
  it('changes: whole folders in card order, files before subfolders, junk left out, app files last', async () => {
    const { ov, plan } = setup();
    await (await ov.root.dir('02')).write('003.mp3', enc.encode('drei'));
    await (await ov.root.dir('mp3')).write('0003.mp3', enc.encode('c'));
    await ov.root.write(CATALOG_FILE, enc.encode('{"x":1}'));
    await ov.root.remove('Musik', { recursive: true });
    const c = packageContent(plan(), ov.tree, 'changes');
    expect(c.items.map((i) => i.path)).toEqual([
      'mp3/',
      'mp3/0001.mp3',
      'mp3/0002.mp3',
      'mp3/0003.mp3',
      '02/',
      '02/001.mp3',
      '02/002.mp3',
      '02/003.mp3',
      '02/Extra/',
      '02/Extra/b.txt',
      CATALOG_FILE,
    ]);
    expect(c.files).toBe(8);
    expect(c.bytes).toBe(1 + 1 + 1 + 4 + 4 + 4 + 1 + 7);
    expect(c.deleteFirst).toEqual(['mp3', '02', 'Musik']);
    expect(c.removeOnly).toEqual(['Musik']);
    expect(c.format).toBe(false);
  });

  it('changes: an empty covers file when the last cover went away', async () => {
    const { ov, plan } = setup();
    await ov.root.remove(COVERS_FILE);
    const c = packageContent(plan(), ov.tree, 'changes');
    expect(c.items.map((i) => i.path)).toEqual([COVERS_FILE]);
    const f = c.items[0].file!;
    expect(new Uint8Array(await f.blob.arrayBuffer())).toEqual(EMPTY_ZIP);
    expect(f.crc32).toBe(crc32(EMPTY_ZIP));
  });

  it('full: everything that belongs on the card, other folders and files included', () => {
    const { ov, plan } = setup({ ...CARD, '_tonuino-studio-temp-04': { '001.mp3': 'gerettet' } });
    const c = packageContent(plan(), ov.tree, 'full');
    expect(c.items.map((i) => i.path)).toEqual([
      'mp3/',
      'mp3/0001.mp3',
      'mp3/0002.mp3',
      'advert/',
      'advert/0001.mp3',
      '01/',
      '01/001 Intro.mp3',
      '01/002.mp3',
      '01/010.mp3',
      '02/',
      '02/001.mp3',
      '02/002.mp3',
      '02/Extra/',
      '02/Extra/b.txt',
      // Names and pictures right after the box's folders: a family's big file further down cannot cost them.
      CATALOG_FILE,
      COVERS_FILE,
      // A helper folder with files in it stays, so nothing is lost when the card is formatted.
      '_tonuino-studio-temp-04/',
      '_tonuino-studio-temp-04/001.mp3',
      'Musik/',
      'Musik/lied.mp3',
      'liesmich.txt',
    ]);
    expect(c.deleteFirst).toEqual([]);
    expect(c.removeOnly).toEqual([]);
    expect(c.format).toBe(true);
    expect(c.bytes).toBe(plan().bytes.full);
  });
});

describe('packageName', () => {
  it('names the Paket after the moment and three letters', () => {
    const at = new Date(2026, 9, 6, 14, 32);
    const seq = [0, 0.5, 0.99];
    let k = 0;
    const name = packageName('changes', at, () => seq[k++ % 3]);
    expect(name).toBe('TonUINO-Paket-0610-1432-AS9.zip');
    expect(packageName('full', at)).toMatch(/^TonUINO-Karte-komplett-0610-1432-[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{3}\.zip$/);
    expect(packageName('changes', new Date(2026, 0, 2, 3, 4), () => 0.999999)).toBe('TonUINO-Paket-0201-0304-999.zip');
    for (const n of [name, 'TonUINO-Paket-0610-1432-AS9 (1).zip', 'TonUINO-Karte-komplett-0610-1432-AS9(2).zip', 'tonuino-paket-0610-1432-as9-1.zip']) {
      expect(PACKAGE_FILE_PATTERN.test(n), n).toBe(true);
    }
    expect(PACKAGE_FILE_PATTERN.test('sd-card.zip')).toBe(false);
  });
});

describe('buildPackageBlob', () => {
  it('builds a ZIP that holds exactly the content, CRC-checked by JSZip', async () => {
    const { ov, plan } = setup();
    await (await ov.root.dir('02')).write('003.mp3', enc.encode('drei'));
    await ov.root.remove(COVERS_FILE);
    const content = packageContent(plan(), ov.tree, 'changes');
    // The card files of folder 02 are read once; the new ones are known already.
    expect(crcPending(content)).toEqual({ files: 3, bytes: 4 + 4 + 1 });
    const seen: [number, number][] = [];
    const { blob, layout } = await buildPackageBlob(content, { now: new Date(2026, 9, 6, 14, 32), onProgress: (d, t) => seen.push([d, t]) });
    expect(seen.at(-1)).toEqual([9, 9]);
    expect(crcPending(content)).toEqual({ files: 0, bytes: 0 });
    expect(blob.size).toBe(layout.size);
    expect(blob.type).toBe('application/zip');
    const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
    expect(Object.keys(zip.files)).toEqual(content.items.map((i) => i.path));
    for (const i of content.items) {
      if (!i.file) continue;
      expect(await zip.file(i.path)!.async('uint8array'), i.path).toEqual(new Uint8Array(await i.file.blob.arrayBuffer()));
    }
  });

  it('a full Paket unpacks to the card without junk', async () => {
    const { ov, plan } = setup();
    const content = packageContent(plan(), ov.tree, 'full');
    const { blob } = await buildPackageBlob(content);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
    const unpacked = Object.values(zip.files)
      .filter((f) => !f.dir)
      .map((f) => f.name);
    const expected = [...files(ov.tree)].map((f) => f.path).filter((p) => !/(^|\/)(\._|\.Trashes)/.test(p) && !p.startsWith('_tonuino-studio-temp'));
    expect(unpacked.sort()).toEqual(expected.sort());
  });

  it('says which card file cannot be read', async () => {
    const { base, ov, plan } = setup();
    const two = base.children[0];
    if (two.kind !== 'directory') throw new Error('fixture');
    // The same Blob in the snapshot and in the copy: the card was pulled.
    const gone = new GoneBlob(4);
    two.children[0] = { kind: 'file', name: '002.mp3', blob: gone };
    const copy = ov.tree.children[0];
    if (copy.kind !== 'directory') throw new Error('fixture');
    copy.children[0] = { kind: 'file', name: '002.mp3', blob: gone };
    await (await ov.root.dir('02')).write('003.mp3', enc.encode('drei'));
    await expect(buildPackageBlob(packageContent(plan(), ov.tree, 'changes'))).rejects.toThrow(
      'Die Datei „02/002.mp3“ auf der Karte ließ sich nicht lesen. Steckt die Karte noch? Lies die Karte neu ein und versuche es noch einmal.',
    );
  });

  it('stops when aborted', async () => {
    const { ov, plan } = setup();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(buildPackageBlob(packageContent(plan(), ov.tree, 'full'), { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.runIf(hasTool('unzip'))('unzip finds no error and keeps the order', async () => {
    const { ov, plan } = setup();
    await (await ov.root.dir('01')).write('011.mp3', new Uint8Array(1000));
    const content = packageContent(plan(), ov.tree, 'full');
    const { blob } = await buildPackageBlob(content);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    withTool(bytes, (path) => {
      const t = tool('unzip', ['-t', path]);
      expect(t.stdout).toContain('No errors detected');
      const list = tool('zipinfo', ['-1', path]);
      expect(list.stdout.trim().split('\n')).toEqual(content.items.map((i) => i.path));
    });
  });
});

describe('manifests', () => {
  it('manifestOf lists every file with its CRC, and what is new', async () => {
    const { ov, plan } = setup();
    await (await ov.root.dir('02')).write('003.mp3', enc.encode('drei'));
    await ov.root.remove('Musik', { recursive: true });
    const content = packageContent(plan(), ov.tree, 'changes');
    const { layout } = await buildPackageBlob(content);
    const m = manifestOf(content, layout, 'TonUINO-Paket-0610-1432-AS9.zip', 1234);
    expect(m).toMatchObject({ name: 'TonUINO-Paket-0610-1432-AS9.zip', mode: 'changes', createdAt: 1234, size: layout.size, topLevel: ['02'], deleteFirst: ['02', 'Musik'], removeOnly: ['Musik'] });
    expect(m.files).toEqual([
      { path: '02/001.mp3', size: 4, crc32: crc32(enc.encode('eins')), isNew: false },
      { path: '02/002.mp3', size: 4, crc32: crc32(enc.encode('zwei')), isNew: false },
      { path: '02/003.mp3', size: 4, crc32: crc32(enc.encode('drei')), isNew: true },
      { path: '02/Extra/b.txt', size: 1, crc32: crc32(enc.encode('b')), isNew: false },
    ]);
  });

  it('manifestFromZip reads a Paket from earlier', async () => {
    const { ov, plan } = setup();
    await (await ov.root.dir('02')).write('003.mp3', enc.encode('drei'));
    await ov.root.write(CATALOG_FILE, enc.encode('{"y":2}'));
    const content = packageContent(plan(), ov.tree, 'changes');
    const { blob, layout } = await buildPackageBlob(content);
    const own = manifestOf(content, layout, 'x.zip', 0);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dir = await readZipDirectory(async (s, l) => bytes.slice(s, s + l), bytes.length);
    const m = manifestFromZip(dir, 'TonUINO-Paket-0610-1432-AS9 (1).zip');
    expect(m.mode).toBe('changes');
    expect(m.topLevel).toEqual(['02', CATALOG_FILE]);
    expect(m.deleteFirst).toEqual(['02']);
    expect(m.removeOnly).toEqual([]);
    expect(m.size).toBe(bytes.length);
    expect(m.files.map((f) => [f.path, f.size, f.crc32])).toEqual(own.files.map((f) => [f.path, f.size, f.crc32]));
    expect(isCardPackage(m)).toBe(true);
    const full = manifestFromZip(dir, 'TonUINO-Karte-komplett-0610-1432-AS9.zip');
    expect(full.mode).toBe('full');
    expect(full.deleteFirst).toEqual([]);
    expect(await zipNames(blob)).toEqual(content.items.map((i) => i.path));
  });

  it('isCardPackage wants something for a TonUINO card', () => {
    const m = (topLevel: string[]) => ({ name: 'a.zip', mode: 'changes' as const, createdAt: 0, size: 0, files: [], topLevel, deleteFirst: [], removeOnly: [] });
    expect(isCardPackage(m(['Fotos', 'urlaub.jpg']))).toBe(false);
    expect(isCardPackage(m(['sd-card']))).toBe(false);
    expect(isCardPackage(m(['mp3']))).toBe(true);
    expect(isCardPackage(m(['07']))).toBe(true);
    expect(isCardPackage(m([CATALOG_FILE]))).toBe(true);
  });
});

describe('BlobFile CRCs', () => {
  it('a staged file brings its CRC along, a card file gets one once', async () => {
    const { ov, plan } = setup();
    await (await ov.root.dir('01')).write('011.mp3', enc.encode('elf'));
    const content = packageContent(plan(), ov.tree, 'changes');
    const staged = content.items.find((i) => i.path === '01/011.mp3')!.file as BlobFile;
    expect(staged.crc32).toBe(crc32(enc.encode('elf')));
    const card = content.items.find((i) => i.path === '01/002.mp3')!.file as BlobFile;
    expect(card.crc32).toBeUndefined();
    await buildPackageBlob(content);
    expect(card.crc32).toBe(crc32(enc.encode('zwei')));
  });
});

describe('what fits on a card for the box', () => {
  const item = (path: string, size: number) => ({ path, file: { kind: 'file' as const, name: path.split('/').pop()!, blob: { size } as Blob } });
  const content = (items: { path: string; file?: BlobFile }[]) => ({ mode: 'full' as const, items, files: items.length, bytes: 0, deleteFirst: [], deleteJunk: [], removeOnly: [], format: true });

  it('names files too big for FAT32', () => {
    const c = content([{ path: '01/' }, item('01/001.mp3', 5_000_000), item('Urlaub/film.mp4', 2 ** 32), item('Urlaub/klein.mp4', 2 ** 32 - 1)]);
    expect(fat32Limits(c).tooBig).toEqual(['Urlaub/film.mp4']);
  });

  it('counts in clusters, and says when it is more than a 32 GB card holds', () => {
    expect(fat32Limits(content([item('a.mp3', 1), item('b.mp3', 32 * 1024 + 1)])).onCard).toBe(3 * 32 * 1024);
    expect(fat32Limits(content([item('a.mp3', 30_000_000_000)])).overCard).toBe(false);
    expect(fat32Limits(content([item('a.mp3', 30_000_000_000), item('b.mp3', 1_500_000_000)])).overCard).toBe(true);
  });
});

describe('folders the app knows but did not read', () => {
  it('lists numbered folders of the catalog that the reading lacks', () => {
    const tree = blobTree({ '01': { '001.mp3': 'a' }, '03': {}, mp3: {} }, 'TONUINO');
    expect(knownFoldersMissing(['01', '02', '03', '05', 'foo'], tree)).toEqual(['02', '05']);
    expect(knownFoldersMissing([], tree)).toEqual([]);
  });
});
