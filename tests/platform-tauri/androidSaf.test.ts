import { describe, expect, it } from 'vitest';
import { AndroidBridgeError, AndroidCalls, fromBase64, toBase64 } from '../../src/platform/tauri/androidBridge';
import { findEntry, ListCache, LIST_TTL_MS, newSafCard, SafDir, SafFs, safWithin, splitStorageId, WRITE_CHUNK, collectSafFiles, type SafEntry } from '../../src/platform/tauri/androidSaf';
import { AndroidVolumes, rootInfo } from '../../src/platform/tauri/androidVolumes';
import { createAndroidPlatform } from '../../src/platform/tauri/android';
import type { AudioBackend } from '../../src/platform/types';
import { FakeFiles, type FakeTree, type Host } from './fake-android';
import { FakeIpc } from './fake-ipc';

const enc = new TextEncoder();
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(tree: FakeTree = {}) {
  const host: Host = {};
  const files = new FakeFiles(host, tree);
  const calls = new AndroidCalls(host);
  const fs = new SafFs(files, calls);
  const root = new SafDir(newSafCard(fs, files.treeUri), files.tree.doc, 'TONUINO');
  return { host, files, calls, fs, root };
}

const sample = (): FakeTree => ({
  mp3: { '0001.mp3': 'sound' },
  '01': { '001.mp3': 'one', '002.mp3': 'two', '003.mp3': 'three' },
  '02': {},
  'tonuino-studio.json': '{}',
});

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } as Storage;
}

describe('base64 across the bridge', () => {
  it('round-trips every length and byte, like android.util.Base64', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 3 * 8192 + 1, 70_000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      const b64 = toBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect(fromBase64(b64)).toEqual(bytes);
    }
    expect(fromBase64('aGFs\nbG8=')).toEqual(enc.encode('hallo'));
    expect(() => fromBase64('a$==')).toThrow();
  });
});

describe('AndroidCalls', () => {
  it('matches answers to calls, takes payloads at once and times out', async () => {
    const host: Host = {};
    const calls = new AndroidCalls(host);
    const sent: string[] = [];
    const a = calls.call((id) => sent.push(id), 1000);
    const b = calls.call((id) => sent.push(id), 1000, (id) => `payload of ${id}`);
    host.__tonuinoAndroid!.done(sent[1], { ok: true, payload: true, size: 3 });
    host.__tonuinoAndroid!.done(sent[0], { ok: false, code: 'not-found', message: 'gone' });
    await expect(b).resolves.toEqual({ size: 3, payload: `payload of ${sent[1]}` });
    await expect(a).rejects.toMatchObject({ code: 'not-found', detail: 'gone' });
    // A late or unknown answer is ignored.
    host.__tonuinoAndroid!.done('a999', { ok: true });
    await expect(calls.call(() => undefined, 5)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('passes events to listeners until they stop', () => {
    const host: Host = {};
    const calls = new AndroidCalls(host);
    const seen: unknown[] = [];
    const stop = calls.on('storage', (d) => seen.push(d));
    calls.on('storage', () => {
      throw new Error('one bad listener');
    });
    host.__tonuinoAndroid!.event('storage', { n: 1 });
    stop();
    host.__tonuinoAndroid!.event('storage', { n: 2 });
    expect(seen).toEqual([{ n: 1 }]);
  });
});

describe('SafDir on a card in a USB reader', () => {
  it('lists, reads, ranges and sources like the other Dirs', async () => {
    const { root } = setup(sample());
    expect((await root.list()).map((e) => [e.name, e.kind, e.size])).toEqual([
      ['mp3', 'directory', undefined],
      ['01', 'directory', undefined],
      ['02', 'directory', undefined],
      ['tonuino-studio.json', 'file', 2],
    ]);
    const one = await root.dir('01');
    expect(text(await one.read('003.mp3'))).toBe('three');
    expect(text(await one.readRange('003.mp3', 1, 3))).toBe('hre');
    expect(text(await one.readRange('003.mp3', 3, 100))).toBe('ee');
    const src = await one.source('003.mp3');
    expect([src.name, src.size]).toEqual(['003.mp3', 5]);
    expect(text(await src.read(0, 2))).toBe('th');
    await expect(one.read('009.mp3')).rejects.toThrow(/009\.mp3: nicht gefunden\. Steckt die SD-Karte noch\?/);
    await expect(root.dir('03')).rejects.toThrow(/nicht gefunden/);
    await expect(root.dir('tonuino-studio.json')).rejects.toThrow(/Datei/);
    await expect(root.read('01')).rejects.toThrow(/Ordner/);
  });

  it('finds names ignoring case and keeps their spelling when writing', async () => {
    const { root, files } = setup({ Musik: { 'Lied.MP3': 'la' } });
    expect(await root.exists('MUSIK')).toBe(true);
    const m = await root.dir('musik');
    expect(m.name).toBe('Musik');
    expect(text(await m.read('lied.mp3'))).toBe('la');
    await m.write('LIED.mp3', enc.encode('lala'));
    expect(files.names('Musik')).toEqual(['Lied.MP3']);
    expect(files.text('Musik/Lied.MP3')).toBe('lala');
  });

  it('writes new files in chunks with progress, replaces in place, and creates folders', async () => {
    const { root, files } = setup(sample());
    const one = await root.dir('01');
    await one.write('002.mp3', enc.encode('neu'));
    expect(files.names('01')).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    expect(files.text('01/002.mp3')).toBe('neu');
    const big = Uint8Array.from({ length: WRITE_CHUNK * 2 + 10 }, (_, i) => i & 255);
    const seen: number[] = [];
    await one.write('004.mp3', new Blob([big]), { onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([WRITE_CHUNK, WRITE_CHUNK * 2, WRITE_CHUNK * 2 + 10]);
    expect(Buffer.compare(await one.read('004.mp3'), big)).toBe(0);
    const made = await root.dir('03', { create: true });
    await made.write('001.mp3', enc.encode('x'));
    expect(files.names()).toEqual(['mp3', '01', '02', 'tonuino-studio.json', '03']);
    expect(files.names('03')).toEqual(['001.mp3']);
    // The list of a folder is read once while files are written into it.
    files.calls.length = 0;
    for (let i = 5; i < 15; i++) await one.write(`0${i}.mp3`.slice(-7), enc.encode('a'));
    expect(files.calls.filter((c) => c === 'list').length).toBeLessThanOrEqual(1);
  });

  it('leaves no half-written new file behind on abort or failure', async () => {
    const { root, files } = setup(sample());
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(root.write('b.bin', new Uint8Array(10), { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await root.exists('b.bin')).toBe(false);
    files.failNext.writeChunk = 'full';
    await expect(root.write('c.bin', new Uint8Array(10))).rejects.toThrow(/c\.bin schreiben: Die SD-Karte ist voll\./);
    expect(files.names()).not.toContain('c.bin');
    files.failNext.create = 'read-only';
    await expect(root.write('d.bin', new Uint8Array(1))).rejects.toThrow(/schreibgeschützt/);
  });

  it('marks an audio file while it is written in place, so a cut-off write shows as half copied (Testlabor)', async () => {
    const { root, files } = setup(sample());
    const one = await root.dir('01');
    // "wt" cut the old 003.mp3 short, then the card went: the marker stays next to it.
    files.failNext.writeChunk = 'io';
    await expect(one.write('003.mp3', enc.encode('new content'))).rejects.toThrow();
    expect(files.names('01')).toEqual(['001.mp3', '002.mp3', '003.mp3', '003.mp3.tonuino-open']);
    // Written again completely: no marker left.
    await one.write('003.mp3', enc.encode('new content'));
    expect(files.names('01')).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    // A new file that failed goes with its marker.
    files.failNext.writeChunk = 'full';
    await expect(one.write('004.mp3', enc.encode('x'))).rejects.toThrow(/voll/);
    expect(files.names('01')).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    // Not audio: no marker at all.
    files.calls.length = 0;
    await root.write('tonuino-studio.json', enc.encode('{}'));
    expect(files.calls.filter((c) => c === 'create')).toEqual([]);
  });

  it('never makes "001 (1).mp3": a file another SafDir made meanwhile is written in place', async () => {
    const { root, files } = setup(sample());
    const a = await root.dir('02');
    const b = await root.dir('02');
    expect(await a.exists('001.mp3')).toBe(false);
    expect(await b.exists('001.mp3')).toBe(false);
    await a.write('001.mp3', enc.encode('from a'));
    // b shares the list with a, so it sees the file at once.
    expect(await b.exists('001.mp3')).toBe(true);
    await b.write('001.mp3', enc.encode('from b'));
    expect(files.names('02')).toEqual(['001.mp3']);
    expect(files.text('02/001.mp3')).toBe('from b');
  });

  it('copes with a list grown old by changes outside the app', async () => {
    const { root, files } = setup(sample());
    const two = await root.dir('02');
    expect(await two.exists('001.mp3')).toBe(false);
    // Another app writes the file behind the app's back: Android would answer "001 (1).mp3".
    files.create('x', '', `${files.rootId}:02`, '001.mp3', false);
    await sleep(5);
    await two.write('001.mp3', enc.encode('mine'));
    expect(files.names('02')).toEqual(['001.mp3']);
    expect(files.text('02/001.mp3')).toBe('mine');
  });

  it('removes files and folders, but a full folder only when asked to', async () => {
    const { root, files } = setup(sample());
    await expect(root.remove('01')).rejects.toThrow(/nicht leer/);
    await root.remove('02');
    await root.remove('tonuino-studio.json');
    await root.remove('01', { recursive: true });
    expect(files.names()).toEqual(['mp3']);
    await expect(root.remove('01')).rejects.toThrow(/nicht gefunden/);
  });

  it('renames in place, also when only the case changes, and never onto a taken name', async () => {
    const { root, files } = setup(sample());
    const one = await root.dir('01');
    await one.rename('001.mp3', '009.mp3');
    expect(files.names('01')).toEqual(['009.mp3', '002.mp3', '003.mp3']);
    await one.rename('002.mp3', '002.MP3');
    expect(files.names('01')).toEqual(['009.mp3', '002.MP3', '003.mp3']);
    await expect(one.rename('003.mp3', '009.MP3')).rejects.toThrow(/gibt es schon/);
    await expect(one.rename('nichts', 'x')).rejects.toThrow(/nicht gefunden/);
    await root.rename('01', '05');
    expect(files.names()).toEqual(['mp3', '05', '02', 'tonuino-studio.json']);
    // The ids below the folder changed with its name: the folder opened anew works.
    const five = await root.dir('05');
    expect(text(await five.read('009.mp3'))).toBe('one');
  });

  it('moves files and folders, with Android\'s move or by copying', async () => {
    for (const noMove of [false, true]) {
      const { root, files } = setup(sample());
      files.noMove = noMove;
      const one = await root.dir('01');
      const two = await root.dir('02');
      await one.move('001.mp3', two);
      await one.move('003.mp3', two, '002.mp3');
      expect(files.names('01')).toEqual(['002.mp3']);
      expect(files.names('02')).toEqual(['001.mp3', '002.mp3']);
      expect(files.text('02/002.mp3')).toBe('three');
      await expect(one.move('002.mp3', two)).rejects.toThrow(/gibt es dort schon/);
      const temp = await root.dir('_temp', { create: true });
      await root.move('01', temp, '01-alt');
      expect(files.names('_temp')).toEqual(['01-alt']);
      expect(files.names('_temp/01-alt')).toEqual(['002.mp3']);
      expect(files.text('_temp/01-alt/002.mp3')).toBe('two');
      expect(files.names()).not.toContain('01');
    }
  });

  it('collects a picked folder of audio with paths below its name', async () => {
    const { files, fs } = setup({ Hörspiel: { 'CD 1': { '01.mp3': 'a' }, '.nomedia': '', 'cover.jpg': 'c' } });
    const card = newSafCard(fs, files.treeUri);
    const all = await collectSafFiles(card, `${files.rootId}:Hörspiel`, 'Hörspiel');
    expect(all.map((s) => [s.relativePath, s.size])).toEqual([
      ['Hörspiel/CD 1/01.mp3', 1],
      ['Hörspiel/cover.jpg', 1],
    ]);
    expect(text(await all[0].read(0, 1))).toBe('a');
  });
});

describe('the lists kept for a while', () => {
  it('forgets a list after a while and finds names like FAT', () => {
    let now = 1000;
    const cache = new ListCache(() => now);
    const e = (name: string): SafEntry => ({ id: name, name, mime: 'x' });
    cache.set('d', [e('A.mp3')]);
    expect(cache.get('d')).toHaveLength(1);
    cache.update('d', (l) => [...l, e('b.mp3')]);
    expect(findEntry(cache.get('d')!, 'B.MP3')?.name).toBe('b.mp3');
    expect(findEntry([e('x'), e('X')], 'X')?.id).toBe('X');
    now += LIST_TTL_MS + 1;
    expect(cache.get('d')).toBeUndefined();
  });
});

describe('where a folder lies', () => {
  const ext = 'content://com.android.externalstorage.documents/tree/x';
  it('tells inside from outside by the card provider\'s ids', () => {
    expect(splitStorageId('1234-ABCD:Musik/05')).toEqual({ root: '1234-ABCD', path: 'Musik/05' });
    expect(safWithin({ tree: ext, doc: '1234-ABCD:Musik/05' }, { tree: ext, doc: '1234-ABCD:Musik' })).toBe(true);
    expect(safWithin({ tree: ext, doc: '1234-ABCD:Musik' }, { tree: ext, doc: '1234-ABCD:' })).toBe(true);
    expect(safWithin({ tree: ext, doc: '1234-ABCD:Musikalisch' }, { tree: ext, doc: '1234-ABCD:Musik' })).toBe(false);
    expect(safWithin({ tree: ext, doc: 'primary:Backup' }, { tree: ext, doc: '1234-ABCD:' })).toBe(false);
    expect(safWithin({ tree: 'content://other/tree/a', doc: 'x' }, { tree: 'content://other/tree/b', doc: 'y' })).toBeNull();
    expect(safWithin({ tree: 'content://other/tree/a', doc: 'x' }, { tree: ext, doc: 'y' })).toBe(false);
  });

  it('knows a card in a reader from the phone\'s own storage', () => {
    expect(rootInfo({ uri: ext, doc: '1234-ABCD:', name: 'K' }, 0x8)).toEqual({ fileTimesFromCard: true, removable: true, writable: true });
    expect(rootInfo({ uri: ext, doc: 'primary:Musik', name: 'M' }, 0x8)).toMatchObject({ removable: false });
    // The lock slider: Android mounts the card read-only, the folder takes no new files.
    expect(rootInfo({ uri: ext, doc: '1234-ABCD:', name: 'K' }, 0)).toMatchObject({ writable: false, readOnly: true });
  });
});

describe('AndroidVolumes', () => {
  it('shows granted cards while they are plugged in and remembers a picked one', async () => {
    const host: Host = {};
    const files = new FakeFiles(host, sample());
    const calls = new AndroidCalls(host);
    const fs = new SafFs(files, calls);
    const volumes = new AndroidVolumes(fs, calls, memoryStorage());
    await volumes.settled();
    const seen: string[][] = [];
    const stop = volumes.subscribe((list) => seen.push(list.map((v) => v.label)));
    expect(seen.at(-1)).toEqual([]);

    files.nextPick = files.tree;
    const v = await volumes.pick();
    expect(v).toMatchObject({ label: 'TONUINO', canEject: false, info: { fileTimesFromCard: true, removable: true, writable: true } });
    expect(files.persisted).toHaveLength(1);
    expect(seen.at(-1)).toEqual(['TONUINO']);
    expect((await v!.root.list()).map((e) => e.name)).toContain('01');
    expect(await volumes.info(v!)).toMatchObject({ freeBytes: 1000, totalBytes: 4000 });

    // Pulled out: Android says so, the card goes from the list; plugged in again, it comes back.
    files.present = false;
    host.__tonuinoAndroid!.event('storage', {});
    await sleep(10);
    expect(seen.at(-1)).toEqual([]);
    files.present = true;
    await volumes.refresh();
    expect(seen.at(-1)).toEqual(['TONUINO']);

    files.nextPick = null;
    expect(await volumes.pick()).toBeNull();
    await volumes.forget(v!);
    expect(files.released).toEqual([files.treeUri]);
    expect(seen.at(-1)).toEqual([]);
    await expect(volumes.eject()).rejects.toThrow(/Einstellungen des Handys/);
    stop();
  });
});

describe('the Android platform with its bridges', () => {
  const audio = {} as AudioBackend;

  it('has the SD card, saving and printing when the file bridge is there', async () => {
    const host: Host = {};
    const files = new FakeFiles(host, sample());
    const p = createAndroidPlatform({ audio, ipc: new FakeIpc(), filesBridge: files, host, storage: memoryStorage(), nfcBridge: undefined });
    expect(p.capabilities).toMatchObject({ sd: true, sdPackage: false, eject: false, serial: false, nfcReader: true, builtInMic: true });
    expect(await p.files.save('Sticker.pdf', new Blob(['%PDF']))).toBe(true);
    expect(files.saved).toEqual([{ name: 'Sticker.pdf', mime: 'application/pdf', data: enc.encode('%PDF') }]);
    await p.printPdf!('Sticker.pdf', new Blob(['%PDF'], { type: 'application/pdf' }));
    expect(files.printed.map((x) => text(x.data))).toEqual(['%PDF']);
    p.openAppSettings!();
    expect(files.appSettings).toBe(1);

    // A folder of audio goes through Android's folder chooser, not kept as a card.
    files.nextPick = { uri: files.treeUri, doc: `${files.rootId}:01`, name: '01' };
    const picked = await p.pickFiles({ directory: true });
    expect(picked.map((s) => s.relativePath)).toEqual(['01/001.mp3', '01/002.mp3', '01/003.mp3']);
    expect(files.persisted).toEqual([]);

    files.nextPick = { uri: files.treeUri, doc: `${files.rootId}:02`, name: '02' };
    const backup = await p.pickBackupFolder();
    files.nextPick = files.tree;
    const card = await p.volumes.pick();
    expect(await p.isWithin(backup!, card!.root)).toBe(true);
    expect(await p.isWithin(card!.root, backup!)).toBe(false);

    files.nextPick = null;
    expect(await p.pickBackupFolder()).toBeNull();
    files.failNext.saveAs = 'cancelled';
    expect(await p.files.save('x.txt', new Blob(['x']))).toBe(false);
  });

  it('reports errors of the bridge in German with the code kept', async () => {
    const { root, files } = setup(sample());
    files.failNext.list = 'denied';
    const err = await root.list().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'denied', message: expect.stringMatching(/noch einmal aus/) });
    expect(new AndroidBridgeError('x', 'y')).toBeInstanceOf(Error);
  });
});
