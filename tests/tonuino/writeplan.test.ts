import { describe, expect, it } from 'vitest';
import { diffForPackage, MANY_REPLACEMENTS } from '../../src/core/tonuino/writeplan';
import { CATALOG_FILE, COVERS_FILE } from '../../src/core/tonuino/sd';
import { createOverlay, memoryScratch } from '../../src/platform/overlay';
import type { MemTree } from '../../src/platform/memory';
import { blobTree } from '../platform/blobfixtures';

const enc = new TextEncoder();

const CARD: MemTree = {
  mp3: { '0001.mp3': 10 },
  advert: { '0001.mp3': 10 },
  '01': { '001.mp3': 100, '002.mp3': 100 },
  '05': { '001.mp3': 50, '._001.mp3': 4 },
  Musik: { 'lied.mp3': 7 },
  '.Trashes': { x: 1 },
  'System Volume Information': { y: 1 },
  [CATALOG_FILE]: '{}',
  [COVERS_FILE]: 'PK',
};

function setup(tree: MemTree = CARD) {
  const base = blobTree(tree, 'TONUINO');
  const ov = createOverlay(base, memoryScratch(), 'TONUINO');
  return { base, ov, plan: () => diffForPackage(base, ov.tree) };
}

describe('diffForPackage', () => {
  it('finds nothing when nothing changed', () => {
    const { plan } = setup();
    const p = plan();
    expect(p.changes).toEqual([]);
    expect(p.appFiles).toEqual([]);
    expect(p.deleteFirst).toEqual([]);
    expect(p.count).toBe(0);
    expect(p.fresh).toBe(false);
    // The junk in folder 05 stays on the card with a Paket of changes.
    expect(p.junk).toEqual({ inFolders: 1, atRoot: 2, tempFolders: [] });
    expect(p.recommend).toBe('full');
    expect(p.reasons).toEqual(['junk-in-folders']);
  });

  it('does not replace a folder for a hidden file the app cleaned up', async () => {
    const { ov, plan } = setup();
    await (await ov.root.dir('05')).remove('._001.mp3');
    const p = plan();
    expect(p.changes).toEqual([]);
    expect(p.deleteFirst).toEqual([]);
    expect(p.deleteJunk).toEqual(['05/._001.mp3']);
    expect(p.count).toBe(1);
    // A real change in the same folder still brings the whole folder.
    await (await ov.root.dir('05')).write('002.mp3', new Uint8Array(9));
    expect(plan().changes.map((c) => [c.kind, c.name])).toEqual([['replace', '05']]);
    expect(plan().deleteJunk).toEqual([]);
  });

  it('adds a new album, and replaces a folder that got a track more', async () => {
    const { ov, plan } = setup();
    const six = await ov.root.dir('06', { create: true });
    await six.write('001.mp3', new Uint8Array(30));
    await six.write('002.mp3', new Uint8Array(40));
    await (await ov.root.dir('01')).write('003.mp3', new Uint8Array(5));
    const p = plan();
    expect(p.changes).toEqual([
      { kind: 'replace', name: '01', entry: 'directory', folder: 1, bytes: 205 },
      { kind: 'add', name: '06', entry: 'directory', folder: 6, bytes: 70 },
    ]);
    expect(p.deleteFirst).toEqual(['01']);
    expect(p.count).toBe(2);
    expect(p.bytes.changes).toBe(275);
  });

  it('replaces a folder whose names were changed, and lists junk that went away for deleting by hand', async () => {
    const { ov, plan } = setup();
    await (await ov.root.dir('01')).rename('002.mp3', '002 Kapitel.mp3');
    await (await ov.root.dir('05')).remove('._001.mp3');
    const p = plan();
    expect(p.changes.map((c) => [c.kind, c.name])).toEqual([['replace', '01']]);
    expect(p.deleteJunk).toEqual(['05/._001.mp3']);
    expect(p.count).toBe(2);
    expect(p.junk.inFolders).toBe(0);
    expect(p.reasons).toEqual([]);
    expect(p.recommend).toBe('changes');
  });

  it('removes a deleted folder, but never asks to delete junk', async () => {
    const { ov, plan } = setup();
    await ov.root.remove('Musik', { recursive: true });
    await ov.root.remove('.Trashes', { recursive: true });
    const p = plan();
    expect(p.changes).toEqual([{ kind: 'remove', name: 'Musik', entry: 'directory', bytes: 7 }]);
    expect(p.deleteFirst).toEqual(['Musik']);
    expect(p.bytes.changes).toBe(0);
  });

  it('puts changed app files apart, and an empty covers file when no cover is left', async () => {
    const { ov, plan } = setup();
    await ov.root.write(CATALOG_FILE, enc.encode('{"a":1}'));
    let p = plan();
    expect(p.changes).toEqual([]);
    expect(p.appFiles).toEqual([{ name: CATALOG_FILE }]);
    expect(p.count).toBe(1);
    await ov.root.remove(COVERS_FILE);
    p = plan();
    expect(p.appFiles).toEqual([{ name: CATALOG_FILE }, { name: COVERS_FILE, empty: true }]);
    expect(p.count).toBe(1);
    expect(p.deleteFirst).toEqual([]);
    expect(p.bytes.changes).toBe(7 + 22);
  });

  it('notices new system sounds and keeps the order of the card', async () => {
    const { ov, plan } = setup();
    await (await ov.root.dir('advert')).write('0002.mp3', new Uint8Array(3));
    await (await ov.root.dir('mp3')).write('0002.mp3', new Uint8Array(3));
    await (await ov.root.dir('Zeug', { create: true })).write('a.txt', new Uint8Array(1));
    await (await ov.root.dir('03', { create: true })).write('001.mp3', new Uint8Array(1));
    await ov.root.write('liesmich.txt', new Uint8Array(2));
    await ov.root.write(CATALOG_FILE, enc.encode('{}\n'));
    const p = plan();
    expect(p.changes.map((c) => [c.kind, c.name, c.system ?? c.folder ?? c.entry])).toEqual([
      ['replace', 'mp3', 'mp3'],
      ['replace', 'advert', 'advert'],
      ['add', '03', 3],
      ['add', 'Zeug', 'directory'],
      ['add', 'liesmich.txt', 'file'],
    ]);
    expect(p.deleteFirst).toEqual(['mp3', 'advert']);
    expect(p.count).toBe(6);
  });

  it('removes a helper folder that was cleaned up, and recommends rebuilding while one stays', async () => {
    const tree: MemTree = { '01': { '001.mp3': 1 }, '_tonuino-studio-temp-01': { '002.mp3': 1 } };
    const a = setup(tree);
    expect(a.plan().junk.tempFolders).toEqual(['_tonuino-studio-temp-01']);
    expect(a.plan().reasons).toEqual(['temp-folders']);
    await a.ov.root.move('_tonuino-studio-temp-01', a.ov.root, '_x');
    await a.ov.root.remove('_x', { recursive: true });
    const p = a.plan();
    expect(p.changes).toEqual([{ kind: 'remove', name: '_tonuino-studio-temp-01', entry: 'directory', bytes: 1 }]);
    expect(p.reasons).toEqual([]);
  });

  it('recommends rebuilding the card when many folders are replaced', async () => {
    const tree: MemTree = {};
    for (let n = 1; n <= MANY_REPLACEMENTS + 1; n++) tree[String(n).padStart(2, '0')] = { '001.mp3': 1 };
    const { ov, plan } = setup(tree);
    for (let n = 1; n <= MANY_REPLACEMENTS; n++) await (await ov.root.dir(String(n).padStart(2, '0'))).write('002.mp3', new Uint8Array(1));
    expect(plan().reasons).toEqual([]);
    await (await ov.root.dir(String(MANY_REPLACEMENTS + 1).padStart(2, '0'))).write('002.mp3', new Uint8Array(1));
    expect(plan().reasons).toEqual(['many-replacements']);
    expect(plan().recommend).toBe('full');
  });

  it('treats a card with nothing but junk as fresh, with one option only', async () => {
    const { ov, plan } = setup({ '.Trashes': {}, 'System Volume Information': { a: 1 }, '._x': 'x' });
    await (await ov.root.dir('01', { create: true })).write('001.mp3', new Uint8Array(9));
    const p = plan();
    expect(p.fresh).toBe(true);
    expect(p.changes).toEqual([{ kind: 'add', name: '01', entry: 'directory', folder: 1, bytes: 9 }]);
    expect(p.recommend).toBe('changes');
    expect(p.reasons).toEqual([]);
    expect(p.bytes.full).toBe(9);
  });

  it('counts the whole card without junk and without empty helper folders', () => {
    const { plan } = setup({ ...CARD, '_tonuino-studio-temp-07': { '._a': 'x' }, '_tonuino-studio-temp-08': { '001.mp3': 3 } });
    // mp3 10, advert 10, 01 200, 05 50, Musik 7, catalog 2, covers 2, the helper folder with a file 3.
    expect(plan().bytes.full).toBe(10 + 10 + 200 + 50 + 7 + 2 + 2 + 3);
  });
});
