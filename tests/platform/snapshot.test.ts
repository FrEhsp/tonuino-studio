import { describe, expect, it } from 'vitest';
import {
  cardLabel,
  isSnapshotProblem,
  pickedSubfolder,
  snapshotFromEntry,
  snapshotFromFiles,
  type DirEntryLike,
  type EntryLike,
  type FileEntryLike,
  type SnapshotResult,
} from '../../src/platform/snapshot';
import { treeShape } from './blobfixtures';

const item = (path: string, text = 'x', modified = 1000) => ({ path, blob: new File([text], path.split('/').pop()!), modified });

function result(r: ReturnType<typeof snapshotFromFiles> | Awaited<ReturnType<typeof snapshotFromEntry>>): SnapshotResult {
  if (isSnapshotProblem(r)) throw new Error(`problem ${r.kind}`);
  return r;
}

describe('snapshotFromFiles', () => {
  it('builds the card from the chosen folder, hidden files included', () => {
    const r = result(
      snapshotFromFiles(
        [
          item('TONUINO/01/002.mp3', 'two'),
          item('TONUINO/mp3/0001.mp3', 'sound'),
          item('TONUINO/01/001.mp3', 'one'),
          item('TONUINO/01/._001.mp3', 'ad'),
          item('TONUINO/tonuino-studio.json', '{}'),
          item('TONUINO/.Trashes/501/x', 'old'),
        ],
        1234,
      ),
    );
    expect(r.label).toBe('TONUINO');
    expect(r.root.name).toBe('TONUINO');
    expect(r.takenAt).toBe(1234);
    expect(r.source).toBe('chooser');
    expect(r.files).toBe(6);
    expect(r.bytes).toBe(3 + 5 + 3 + 2 + 2 + 3);
    // The order is the browser's, unsorted.
    expect(treeShape(r.root)).toEqual({
      '01': { '002.mp3': 3, '001.mp3': 3, '._001.mp3': 2 },
      mp3: { '0001.mp3': 5 },
      'tonuino-studio.json': 2,
      '.Trashes': { '501': { x: 3 } },
    });
    const f = r.root.children[0];
    expect(f.kind === 'directory' && f.children[0].kind === 'file' && f.children[0].modified).toBe(1000);
  });

  it('merges folders whose names differ only in case, as FAT does', () => {
    const r = result(snapshotFromFiles([item('K/Musik/a.mp3'), item('K/MUSIK/b.mp3'), item('K/musik/A.MP3', 'zweites')]));
    expect(treeShape(r.root)).toEqual({ Musik: { 'a.mp3': 1, 'b.mp3': 1 } });
    expect(r.files).toBe(2);
  });

  it('calls a Windows drive root or a nameless card "SD-Karte"', () => {
    expect(result(snapshotFromFiles([item('E:/01/001.mp3')])).label).toBe('SD-Karte');
    expect(cardLabel('')).toBe('SD-Karte');
    expect(cardLabel('E:')).toBe('SD-Karte');
    expect(cardLabel('e:\\')).toBe('SD-Karte');
    expect(cardLabel(' NO NAME ')).toBe('NO NAME');
    expect(cardLabel('TONUINO/')).toBe('TONUINO');
  });

  it('reports an empty choice and a choice that was no folder', () => {
    expect(snapshotFromFiles([])).toEqual({ kind: 'empty' });
    expect(snapshotFromFiles([item('001.mp3')])).toEqual({ kind: 'not-a-folder' });
    expect(snapshotFromFiles([item('K/001.mp3'), item('002.mp3')])).toEqual({ kind: 'not-a-folder' });
  });
});

describe('pickedSubfolder', () => {
  it('notices a folder of the card chosen instead of the card', () => {
    expect(pickedSubfolder(result(snapshotFromFiles([item('05/001.mp3'), item('05/002.mp3')])))).toBe('05');
    expect(pickedSubfolder(result(snapshotFromFiles([item('mp3/0001.mp3')])))).toBe('mp3');
    expect(pickedSubfolder(result(snapshotFromFiles([item('ADVERT/0001.mp3')])))).toBe('ADVERT');
    expect(pickedSubfolder(result(snapshotFromFiles([item('TONUINO/05/001.mp3')])))).toBeNull();
    // A card that happens to be called "05" has folders, not numbered files, in its root.
    expect(pickedSubfolder(result(snapshotFromFiles([item('05/01/001.mp3'), item('05/tonuino-studio.json')])))).toBeNull();
  });
});

/* ------------------------------------------------------------ fake entries */

type Fake = { name: string; text?: string; fail?: boolean; children?: Fake[] };

function fakeEntry(f: Fake, batchSize: number, calls: { readEntries: number }): EntryLike {
  if (f.children === undefined) {
    const e: FileEntryLike = {
      name: f.name,
      isFile: true,
      isDirectory: false,
      file(ok, err) {
        queueMicrotask(() => (f.fail ? err(new DOMException('Die Datei ist weg', 'NotFoundError')) : ok(new File([f.text ?? ''], f.name, { lastModified: 5 }))));
      },
    };
    return e;
  }
  const kids = f.children;
  const e: DirEntryLike = {
    name: f.name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let at = 0;
      return {
        readEntries(ok, err) {
          calls.readEntries++;
          if (f.fail) {
            queueMicrotask(() => err(new DOMException('kaputt', 'NotReadableError')));
            return;
          }
          const batch = kids.slice(at, at + batchSize).map((k) => fakeEntry(k, batchSize, calls));
          at += batchSize;
          queueMicrotask(() => ok(batch));
        },
      };
    },
  };
  return e;
}

const many = (n: number): Fake[] => Array.from({ length: n }, (_, i) => ({ name: `${String(i + 1).padStart(3, '0')}.mp3`, text: 'ab' }));

const card = (): Fake => ({
  name: 'TONUINO',
  children: [
    { name: 'mp3', children: [{ name: '0001.mp3', text: 'sound' }] },
    { name: '01', children: many(250) },
    { name: '02', children: [] },
    { name: '._01', text: 'apple' },
    { name: 'tonuino-studio.json', text: '{}' },
  ],
});

describe('snapshotFromEntry', () => {
  for (const [browser, batch] of [
    ['Chrome (100 per call)', 100],
    ['Firefox (all at once)', 10_000],
  ] as const) {
    it(`reads a dropped card, empty folders included: ${browser}`, async () => {
      const calls = { readEntries: 0 };
      const seen: number[] = [];
      const r = result(await snapshotFromEntry(fakeEntry(card(), batch, calls), { now: 77, onProgress: (n) => seen.push(n) }));
      expect(r.label).toBe('TONUINO');
      expect(r.source).toBe('drop');
      expect(r.takenAt).toBe(77);
      expect(r.files).toBe(253);
      expect(r.bytes).toBe(5 + 250 * 2 + 5 + 2);
      const shape = treeShape(r.root) as Record<string, unknown>;
      expect(Object.keys(shape)).toEqual(['mp3', '01', '02', '._01', 'tonuino-studio.json']);
      expect(Object.keys(shape['01'] as object)).toEqual(many(250).map((f) => f.name));
      expect(shape['02']).toEqual({});
      expect(seen.at(-1)).toBe(253);
      // Every folder is asked until it hands out nothing more.
      const perFolder = (n: number) => Math.ceil(n / batch) + 1;
      expect(calls.readEntries).toBe(perFolder(5) + perFolder(1) + perFolder(250) + perFolder(0));
    });
  }

  it('reports a file that cannot be read, with its path', async () => {
    const c = card();
    c.children![1].children![7].fail = true;
    expect(await snapshotFromEntry(fakeEntry(c, 100, { readEntries: 0 }))).toEqual({ kind: 'read-failed', path: '01/008.mp3', message: 'Die Datei ist weg' });
  });

  it('reports a folder that cannot be listed', async () => {
    const c = card();
    c.children![0].fail = true;
    expect(await snapshotFromEntry(fakeEntry(c, 100, { readEntries: 0 }))).toEqual({ kind: 'read-failed', path: 'mp3', message: 'kaputt' });
  });

  it('wants a folder, and says when it is empty', async () => {
    const calls = { readEntries: 0 };
    expect(await snapshotFromEntry(fakeEntry({ name: 'x.mp3', text: 'x' }, 100, calls))).toEqual({ kind: 'not-a-folder' });
    expect(await snapshotFromEntry(fakeEntry({ name: 'E:', children: [] }, 100, calls))).toEqual({ kind: 'empty', label: 'SD-Karte' });
    expect(await snapshotFromEntry(fakeEntry({ name: 'TONUINO', children: [] }, 100, calls))).toEqual({ kind: 'empty', label: 'TONUINO' });
    const r = result(await snapshotFromEntry(fakeEntry({ name: '', children: [{ name: '01', children: [] }] }, 100, calls)));
    expect(r.label).toBe('SD-Karte');
    expect(r.files).toBe(0);
  });

  it('stops when aborted', async () => {
    const ctrl = new AbortController();
    const p = snapshotFromEntry(fakeEntry(card(), 100, { readEntries: 0 }), {
      signal: ctrl.signal,
      onProgress: (n) => {
        if (n > 50) ctrl.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
