import { describe, expect, it } from 'vitest';
import { MemDirError, memTreeNames, type MemTree } from '../../src/platform/memory';
import type { Dir } from '../../src/platform/types';

const enc = new TextEncoder();
const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function failsWith(p: Promise<unknown>, code: MemDirError['code']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MemDirError);
  expect((err as MemDirError).code).toBe(code);
}

const names = async (d: Dir) => (await d.list()).map((e) => e.name);

/**
 * What every Dir that stands for an SD card in memory must do, the way
 * FAT does it: names are case-insensitive but keep their case, entries keep
 * the order they were created in, rename keeps the place, move appends.
 */
export function dirContract(label: string, make: (tree: MemTree) => Dir | Promise<Dir>) {
  describe(`Dir contract: ${label}`, () => {
    const sample = (): MemTree => ({
      mp3: { '0001.mp3': 'sound' },
      '01': { '001.mp3': 'one', '002.mp3': 'two', '003.mp3': 'three' },
      '02': {},
      'tonuino-studio.json': '{}',
    });

    it('lists entries in the order they were created, with sizes', async () => {
      const root = await make(sample());
      expect(await root.list()).toEqual([
        expect.objectContaining({ name: 'mp3', kind: 'directory' }),
        expect.objectContaining({ name: '01', kind: 'directory' }),
        expect.objectContaining({ name: '02', kind: 'directory' }),
        expect.objectContaining({ name: 'tonuino-studio.json', kind: 'file', size: 2 }),
      ]);
      const one = await root.dir('01');
      expect((await one.list()).map((e) => [e.name, e.size])).toEqual([
        ['001.mp3', 3],
        ['002.mp3', 3],
        ['003.mp3', 5],
      ]);
      await one.write('000.mp3', enc.encode('zero'));
      expect(await names(one)).toEqual(['001.mp3', '002.mp3', '003.mp3', '000.mp3']);
    });

    it('finds names ignoring case and keeps their spelling', async () => {
      const root = await make({ Musik: { 'Lied.MP3': 'la' } });
      expect(await root.exists('MUSIK')).toBe(true);
      const m = await root.dir('musik');
      expect(m.name).toBe('Musik');
      expect(text(await m.read('lied.mp3'))).toBe('la');
      await m.write('LIED.mp3', enc.encode('lala'));
      expect(await m.list()).toEqual([expect.objectContaining({ name: 'Lied.MP3', size: 4 })]);
      expect(await root.exists('nichts')).toBe(false);
    });

    it('opens and creates folders', async () => {
      const root = await make(sample());
      await failsWith(root.dir('03'), 'not-found');
      await failsWith(root.dir('tonuino-studio.json'), 'not-a-directory');
      const created = await root.dir('03', { create: true });
      expect(created.name).toBe('03');
      expect(await names(root)).toEqual(['mp3', '01', '02', 'tonuino-studio.json', '03']);
      // An existing folder stays as it is.
      const again = await root.dir('01', { create: true });
      expect(await names(again)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
      expect(await names(root)).toEqual(['mp3', '01', '02', 'tonuino-studio.json', '03']);
    });

    it('reads files, ranges and sources', async () => {
      const root = await make(sample());
      const one = await root.dir('01');
      expect(text(await one.read('003.mp3'))).toBe('three');
      expect(text(await one.readRange('003.mp3', 1, 3))).toBe('hre');
      expect(text(await one.readRange('003.mp3', 3, 100))).toBe('ee');
      const src = await one.source('003.mp3');
      expect(src.name).toBe('003.mp3');
      expect(src.size).toBe(5);
      expect(text(await src.read(0, 2))).toBe('th');
      await failsWith(one.read('009.mp3'), 'not-found');
      await failsWith(root.read('01'), 'not-a-file');
      await failsWith(root.source('01'), 'not-a-file');
      await failsWith(root.readRange('nichts', 0, 1), 'not-found');
    });

    it('writes new files at the end and replaces files in place', async () => {
      const root = await make(sample());
      const one = await root.dir('01');
      await one.write('002.mp3', enc.encode('neu'));
      expect(await names(one)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
      expect(text(await one.read('002.mp3'))).toBe('neu');
      await one.write('004.mp3', new Blob(['vier']));
      expect(await names(one)).toEqual(['001.mp3', '002.mp3', '003.mp3', '004.mp3']);
      expect(text(await one.read('004.mp3'))).toBe('vier');
      await failsWith(root.write('01', enc.encode('x')), 'not-a-file');
    });

    it('reports write progress and stops when aborted', async () => {
      const root = await make(sample());
      const seen: number[] = [];
      await root.write('a.bin', new Uint8Array(1000), { onProgress: (n) => seen.push(n) });
      expect(seen.at(-1)).toBe(1000);
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(root.write('b.bin', new Uint8Array(10), { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(await root.exists('b.bin')).toBe(false);
    });

    it('removes files and folders', async () => {
      const root = await make(sample());
      await failsWith(root.remove('01'), 'not-empty');
      await root.remove('02');
      await root.remove('tonuino-studio.json');
      await root.remove('01', { recursive: true });
      expect(await names(root)).toEqual(['mp3']);
      await failsWith(root.remove('01'), 'not-found');
    });

    it('renames in place', async () => {
      const root = await make(sample());
      const one = await root.dir('01');
      await one.rename('001.mp3', '009.mp3');
      expect(await names(one)).toEqual(['009.mp3', '002.mp3', '003.mp3']);
      await one.rename('002.mp3', '002.MP3');
      expect(await names(one)).toEqual(['009.mp3', '002.MP3', '003.mp3']);
      await failsWith(one.rename('003.mp3', '009.MP3'), 'exists');
      await failsWith(one.rename('nichts', 'x'), 'not-found');
      await root.rename('01', '05');
      expect(await names(root)).toEqual(['mp3', '05', '02', 'tonuino-studio.json']);
      // A folder opened before keeps working under its new name.
      expect(one.name).toBe('05');
      expect(await names(one)).toEqual(['009.mp3', '002.MP3', '003.mp3']);
    });

    it('moves to the end of the target', async () => {
      const root = await make(sample());
      const one = await root.dir('01');
      const two = await root.dir('02');
      await one.move('001.mp3', two);
      await one.move('003.mp3', two, '002.mp3');
      expect(await names(one)).toEqual(['002.mp3']);
      expect(await names(two)).toEqual(['001.mp3', '002.mp3']);
      expect(text(await two.read('002.mp3'))).toBe('three');
      await failsWith(one.move('002.mp3', two), 'exists');
      await failsWith(one.move('nichts', two), 'not-found');
      // Within the same folder it goes to the end as well.
      await two.move('001.mp3', two);
      expect(await names(two)).toEqual(['002.mp3', '001.mp3']);
      // Folders move with what is in them.
      const temp = await root.dir('_temp', { create: true });
      await root.move('01', temp, '01-alt');
      expect(await memTreeNames(root)).toEqual({ mp3: { '0001.mp3': 5 }, '02': { '002.mp3': 5, '001.mp3': 3 }, 'tonuino-studio.json': 2, _temp: { '01-alt': { '002.mp3': 3 } } });
    });
  });
}
