import { describe, expect, it } from 'vitest';
import { crc32 } from '../../src/core/zip/crc32';
import { cloneTree, nodeAt, sameContent, type BlobFile } from '../../src/platform/blobtree';
import { createOverlay, memoryScratch, OverlayLockedError, ScratchFullError, SMALL_DATA } from '../../src/platform/overlay';
import { blobTree, GoneBlob, treeShape } from './blobfixtures';
import { dirContract } from './dirContract';

dirContract('BlobTreeDir', (tree) => createOverlay(blobTree(tree), memoryScratch(), 'SD').root);

const enc = new TextEncoder();
const MiB = 1024 * 1024;

const card = () =>
  blobTree(
    {
      mp3: { '0001.mp3': 'sound' },
      '01': { '001.mp3': 'one', '002.mp3': 'two' },
      '02': { '001.mp3': 'eins' },
      'tonuino-studio.json': '{}',
    },
    'TONUINO',
  );

describe('createOverlay', () => {
  it('never changes the snapshot it was made from', async () => {
    const base = card();
    const before = cloneTree(base);
    const ov = createOverlay(base, memoryScratch(), 'TONUINO');
    const one = await ov.root.dir('01');
    await one.write('003.mp3', enc.encode('three'));
    await one.write('001.mp3', enc.encode('neu'));
    await one.rename('002.mp3', '009.mp3');
    await ov.root.remove('02', { recursive: true });
    await ov.root.move('mp3', await ov.root.dir('01'));
    await ov.root.dir('03', { create: true });
    expect(sameContent(base, before)).toBe(true);
    expect(treeShape(base)).toEqual(treeShape(before));
    expect(treeShape(ov.tree)).toEqual({ '01': { '001.mp3': 3, '009.mp3': 3, '003.mp3': 5, mp3: { '0001.mp3': 5 } }, 'tonuino-studio.json': 2, '03': {} });
    expect(ov.base).toBe(base);
  });

  it('starts as the same content as the snapshot, with the same Blobs', () => {
    const base = card();
    const ov = createOverlay(base, memoryScratch(), 'TONUINO');
    expect(ov.tree).not.toBe(base);
    expect(ov.tree.children.map((c) => c.name)).toEqual(base.children.map((c) => c.name));
    expect((nodeAt(ov.tree, '01/001.mp3') as BlobFile).blob).toBe((nodeAt(base, '01/001.mp3') as BlobFile).blob);
    expect(ov.root.name).toBe('TONUINO');
  });

  it('hands out the Blob of card files and of new files', async () => {
    const base = card();
    const ov = createOverlay(base, memoryScratch(), 'TONUINO');
    const one = await ov.root.dir('01');
    const src = await one.source('001.mp3');
    expect(src.blob).toBe((nodeAt(base, '01/001.mp3') as BlobFile).blob);
    await one.write('003.mp3', enc.encode('three'));
    const staged = await one.source('003.mp3');
    expect(staged.blob).toBeInstanceOf(Blob);
    expect(new TextDecoder().decode(new Uint8Array(await staged.blob!.arrayBuffer()))).toBe('three');
  });

  it('marks written files as staged and knows their CRC', async () => {
    const ov = createOverlay(card(), memoryScratch(), 'TONUINO');
    const data = enc.encode('three');
    await (await ov.root.dir('01')).write('003.mp3', data);
    const f = nodeAt(ov.tree, '01/003.mp3') as BlobFile;
    expect(f.staged).toBe(true);
    expect(f.crc32).toBe(crc32(data));
    expect((nodeAt(ov.tree, '01/001.mp3') as BlobFile).staged).toBeUndefined();
    await (await ov.root.dir('01')).write('004.mp3', new Blob(['vier']));
    expect((nodeAt(ov.tree, '01/004.mp3') as BlobFile).crc32).toBe(crc32(enc.encode('vier')));
  });

  it('counts every change and tells listeners', async () => {
    const ov = createOverlay(card(), memoryScratch(), 'TONUINO');
    let calls = 0;
    const off = ov.onChange(() => calls++);
    expect(ov.version).toBe(0);
    const one = await ov.root.dir('01');
    await ov.root.dir('01', { create: true });
    expect(ov.version).toBe(0);
    await one.write('003.mp3', enc.encode('x'));
    await one.rename('003.mp3', '004.mp3');
    await one.remove('004.mp3');
    await ov.root.dir('05', { create: true });
    await ov.root.move('05', one);
    expect(ov.version).toBe(5);
    expect(calls).toBe(5);
    off();
    await ov.root.dir('06', { create: true });
    expect(ov.version).toBe(6);
    expect(calls).toBe(5);
  });

  it('only lets the app files change while locked', async () => {
    const ov = createOverlay(card(), memoryScratch(), 'TONUINO');
    const one = await ov.root.dir('01');
    ov.lock();
    expect(ov.locked).toBe(true);
    await expect(one.write('003.mp3', enc.encode('x'))).rejects.toBeInstanceOf(OverlayLockedError);
    await expect(one.remove('001.mp3')).rejects.toBeInstanceOf(OverlayLockedError);
    await expect(one.rename('001.mp3', '005.mp3')).rejects.toBeInstanceOf(OverlayLockedError);
    await expect(ov.root.move('02', one)).rejects.toBeInstanceOf(OverlayLockedError);
    await expect(ov.root.dir('07', { create: true })).rejects.toBeInstanceOf(OverlayLockedError);
    await expect(ov.root.write('neu.txt', enc.encode('x'))).rejects.toBeInstanceOf(OverlayLockedError);
    // Names, titles and covers may still change.
    await ov.root.write('tonuino-studio.json', enc.encode('{"a":1}'));
    await ov.root.write('TONUINO-studio-covers.zip', enc.encode('PK'));
    await ov.root.remove('tonuino-studio-covers.zip');
    // Not in a folder, though.
    await expect(one.write('tonuino-studio.json', enc.encode('{}'))).rejects.toBeInstanceOf(OverlayLockedError);
    // Reading works as always.
    expect(await ov.root.exists('01')).toBe(true);
    expect((await one.read('001.mp3')).length).toBe(3);
    ov.unlock();
    await one.write('003.mp3', enc.encode('x'));
    expect(treeShape(ov.tree)).toMatchObject({ '01': { '003.mp3': 1 }, 'tonuino-studio.json': 7 });
  });

  it('gives a clear message when a card file cannot be read any more', async () => {
    const base = card();
    const one = base.children[1];
    if (one.kind !== 'directory') throw new Error('fixture');
    one.children.push({ kind: 'file', name: '003.mp3', blob: new GoneBlob(10) });
    const ov = createOverlay(base, memoryScratch(), 'TONUINO');
    const dir = await ov.root.dir('01');
    const message = 'Die Datei „01/003.mp3“ ließ sich nicht lesen. Steckt die SD-Karte noch? Sonst lies die Karte neu ein.';
    await expect(dir.read('003.mp3')).rejects.toThrow(message);
    await expect(dir.readRange('003.mp3', 0, 4)).rejects.toThrow(message);
    await expect((await dir.source('003.mp3')).read(0, 4)).rejects.toThrow(message);
    const unreadable = createOverlay(blobTree({}), memoryScratch(), 'SD');
    unreadable.tree.children.push({ kind: 'file', name: 'x.mp3', blob: new GoneBlob(3, 'NotReadableError') });
    await expect(unreadable.root.read('x.mp3')).rejects.toThrow('Die Datei „x.mp3“ ließ sich nicht lesen.');
  });

  it('only moves within the same card, and never a folder into itself', async () => {
    const a = createOverlay(card(), memoryScratch(), 'A');
    const b = createOverlay(card(), memoryScratch(), 'B');
    await expect(a.root.move('02', await b.root.dir('01'))).rejects.toThrow('Verschieben geht nur innerhalb der eingelesenen Karte.');
    const one = await a.root.dir('01');
    const inner = await one.dir('innen', { create: true });
    await expect(a.root.move('01', inner)).rejects.toThrow('lässt sich nicht in sich selbst verschieben');
    await expect(a.root.move('01', one)).rejects.toThrow('lässt sich nicht in sich selbst verschieben');
    expect(treeShape(a.tree)).toMatchObject({ '01': { innen: {} } });
  });
});

describe('memoryScratch', () => {
  it('counts big data against the budget, small data and Files not', async () => {
    const store = memoryScratch({ budgetBytes: 3 * MiB });
    await store.put(new Uint8Array(SMALL_DATA - 1));
    expect(await store.available()).toBe(3 * MiB);
    await store.put(new File([new Uint8Array(5 * MiB)], 'big.mp3'));
    expect(await store.available()).toBe(3 * MiB);
    await store.put(new Uint8Array(2 * MiB));
    expect(await store.available()).toBe(MiB);
    await store.put(new Blob([new Uint8Array(MiB)]));
    expect(await store.available()).toBe(0);
    await expect(store.put(new Uint8Array(MiB))).rejects.toBeInstanceOf(ScratchFullError);
  });

  it('names the reason, and the message says what to do', async () => {
    const priv = memoryScratch({ budgetBytes: MiB, reason: 'private' });
    const err = await priv.put(new Uint8Array(2 * MiB)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScratchFullError);
    expect((err as ScratchFullError).reason).toBe('private');
    expect((err as Error).message).toMatch(/^Im privaten Fenster/);
    const budget = await memoryScratch({ budgetBytes: MiB }).put(new Uint8Array(2 * MiB)).catch((e: unknown) => e);
    expect((budget as ScratchFullError).reason).toBe('budget');
  });

  it('frees the budget when a new file leaves the card again', async () => {
    const store = memoryScratch({ budgetBytes: 4 * MiB });
    const ov = createOverlay(card(), store, 'TONUINO');
    const one = await ov.root.dir('01');
    await one.write('003.mp3', new Uint8Array(2 * MiB));
    await one.write('004.mp3', new Uint8Array(2 * MiB));
    expect(await store.available()).toBe(0);
    const full = await one.write('005.mp3', new Uint8Array(MiB)).catch((e: unknown) => e);
    expect(full).toBeInstanceOf(ScratchFullError);
    expect(await one.exists('005.mp3')).toBe(false);
    // Removing a file frees its data, replacing one frees the old data.
    await one.remove('004.mp3');
    expect(await store.available()).toBe(2 * MiB);
    await one.write('003.mp3', new Uint8Array(MiB));
    expect(await store.available()).toBe(3 * MiB);
    // Removing a folder frees what was in it.
    await ov.root.remove('01', { recursive: true });
    expect(await store.available()).toBe(4 * MiB);
  });

  it('stops when aborted', async () => {
    const store = memoryScratch({ budgetBytes: 4 * MiB });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(store.put(new Blob([new Uint8Array(2 * MiB)]), { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await store.available()).toBe(4 * MiB);
  });
});
