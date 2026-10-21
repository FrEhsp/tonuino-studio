import { describe, expect, it } from 'vitest';
import { TauriDir, PathByteSource, READ_CHUNK, WRITE_CHUNK, writeSource } from '../../src/platform/tauri/fs';
import { TauriPlatformError } from '../../src/platform/tauri/errors';
import { fakeBridge } from './fake-ipc';

describe('TauriDir', () => {
  it('lists entries in the order the backend returns them', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('fs_list', () => [
      { name: '02', kind: 'directory', modified: 1 },
      { name: '01', kind: 'directory' },
      { name: 'tonuino-studio.json', kind: 'file', size: 12, modified: 1700000000000 },
    ]);
    const dir = new TauriDir(bridge, '/media/anna/TONUINO');
    expect(dir.name).toBe('TONUINO');
    const list = await dir.list();
    expect(list.map((e) => e.name)).toEqual(['02', '01', 'tonuino-studio.json']);
    expect(list[1]).toEqual({ name: '01', kind: 'directory' });
    expect(list[2]).toEqual({ name: 'tonuino-studio.json', kind: 'file', size: 12, modified: 1700000000000 });
    expect(ipc.calls[0]).toEqual({ cmd: 'fs_list', args: { path: '/media/anna/TONUINO' } });
  });

  it('joins paths with the platform separator and rejects tricky names', async () => {
    const { ipc, bridge } = fakeBridge('windows');
    ipc.on('fs_exists', () => true);
    const dir = new TauriDir(bridge, 'E:\\');
    await dir.exists('01');
    expect(ipc.calls[0].args).toEqual({ path: 'E:\\01' });
    await new TauriDir(bridge, 'E:\\01').exists('001.mp3');
    expect(ipc.calls[1].args).toEqual({ path: 'E:\\01\\001.mp3' });
    for (const bad of ['..', '.', '', 'a/b', 'a\\b']) {
      await expect(dir.exists(bad)).rejects.toMatchObject({ code: 'invalid-name' });
    }
  });

  it('writes small files in one call with the path in a header', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('fs_write', () => null);
    const progress: number[] = [];
    await new TauriDir(bridge, '/media/a/TONUINO/01').write('001.mp3', new Uint8Array([1, 2, 3]), { onProgress: (n) => progress.push(n) });
    expect(ipc.calls).toHaveLength(1);
    expect(ipc.calls[0].headers).toEqual({ 'x-path': encodeURIComponent('/media/a/TONUINO/01/001.mp3') });
    expect(ipc.calls[0].args).toEqual(new Uint8Array([1, 2, 3]));
    expect(progress).toEqual([3]);
  });

  it('uploads big blobs in chunks with progress and flushes at the end', async () => {
    const { ipc, bridge } = fakeBridge();
    const received = new Map<number, number>();
    ipc.on('fs_write_chunk', (args, headers) => {
      received.set(Number(headers['x-offset']), (args as Uint8Array).byteLength);
      return null;
    });
    ipc.on('fs_write_finish', () => null);
    const size = 2 * WRITE_CHUNK + 1000;
    const blob = new Blob([new Uint8Array(size).fill(7)]);
    const progress: number[] = [];
    await new TauriDir(bridge, '/media/a/C').write('Hörbuch.mp3', blob, { onProgress: (n) => progress.push(n) });
    expect([...received.entries()]).toEqual([
      [0, WRITE_CHUNK],
      [WRITE_CHUNK, WRITE_CHUNK],
      [2 * WRITE_CHUNK, 1000],
    ]);
    expect(progress).toEqual([WRITE_CHUNK, 2 * WRITE_CHUNK, size]);
    expect(ipc.calls.at(-1)).toEqual({ cmd: 'fs_write_finish', args: { path: '/media/a/C/Hörbuch.mp3' } });
    expect(ipc.calls[0].headers?.['x-path']).toBe('%2Fmedia%2Fa%2FC%2FH%C3%B6rbuch.mp3');
  });

  it('removes the partial file when a chunked write is aborted or fails', async () => {
    const { ipc, bridge } = fakeBridge();
    const controller = new AbortController();
    ipc.on('fs_write_chunk', () => {
      controller.abort();
      return null;
    });
    ipc.on('fs_write_abort', () => null);
    const dir = new TauriDir(bridge, '/media/a/C');
    const data = new Uint8Array(WRITE_CHUNK * 3);
    await expect(dir.write('x.mp3', data, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(ipc.callsOf('fs_write_chunk')).toHaveLength(1);
    expect(ipc.callsOf('fs_write_abort')).toEqual([{ cmd: 'fs_write_abort', args: { path: '/media/a/C/x.mp3' } }]);

    ipc.on('fs_write_chunk', () => {
      throw { code: 'no-space', detail: 'ENOSPC' };
    });
    const err = await dir.write('y.mp3', data).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TauriPlatformError);
    expect(err).toMatchObject({ code: 'no-space', detail: 'ENOSPC' });
    expect((err as Error).message).toMatch(/kein Platz/);
    expect(ipc.callsOf('fs_write_abort')).toHaveLength(2);
  });

  it('reads big ranges in pieces and stops at the end of the file', async () => {
    const { ipc, bridge } = fakeBridge();
    const size = READ_CHUNK + 10;
    ipc.on('fs_read_range', (args) => {
      const { start, length } = args as { start: number; length: number };
      const n = Math.max(0, Math.min(length, size - start));
      return new Uint8Array(n).fill(start === 0 ? 1 : 2).buffer;
    });
    const src = new PathByteSource(bridge, { path: '/home/anna/a.mp3', name: 'a.mp3', size });
    const all = await src.read(0, size + 100);
    expect(all.length).toBe(size);
    expect(all[0]).toBe(1);
    expect(all[size - 1]).toBe(2);
    expect(ipc.callsOf('fs_read_range').map((c) => c.args)).toEqual([
      { path: '/home/anna/a.mp3', start: 0, length: READ_CHUNK },
      { path: '/home/anna/a.mp3', start: READ_CHUNK, length: 10 },
    ]);
    expect(await src.read(size, 10)).toEqual(new Uint8Array(0));
  });

  it('moves entries by full path and copies files natively with progress', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('fs_rename', () => null);
    ipc.on('fs_copy', (args) => {
      const { copyId } = args as { copyId: string };
      ipc.emit('copy-progress', { copyId, copied: 50, total: 100 });
      ipc.emit('copy-progress', { copyId: 'other', copied: 1, total: 1 });
      ipc.emit('copy-progress', { copyId, copied: 100, total: 100 });
      return 100;
    });
    const root = new TauriDir(bridge, '/media/a/C');
    const target = new TauriDir(bridge, '/media/a/C/02');
    await root.move('tmp.mp3', target, '001.mp3');
    expect(ipc.calls[0].args).toEqual({ from: '/media/a/C/tmp.mp3', to: '/media/a/C/02/001.mp3' });

    const progress: number[] = [];
    const source = new PathByteSource(bridge, { path: '/home/anna/Hörspiel/01.mp3', name: '01.mp3', size: 100 });
    await target.copyFrom('002.mp3', source, { onProgress: (n) => progress.push(n) });
    expect(progress).toEqual([50, 100]);
    expect(ipc.callsOf('fs_copy')[0].args).toMatchObject({ from: '/home/anna/Hörspiel/01.mp3', to: '/media/a/C/02/002.mp3' });
    expect(ipc.listenerCount('copy-progress')).toBe(0);
  });

  it('streams sources without a blob through the chunked writer', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('fs_write_chunk', () => null);
    ipc.on('fs_write_finish', () => null);
    const size = WRITE_CHUNK + 5;
    const reads: [number, number][] = [];
    const source = {
      name: 'x.mp3',
      size,
      read: async (start: number, length: number) => {
        reads.push([start, length]);
        return new Uint8Array(length);
      },
    };
    await writeSource(bridge, '/tmp/tonuino-studio/x.mp3', source);
    expect(reads).toEqual([
      [0, WRITE_CHUNK],
      [WRITE_CHUNK, 5],
    ]);
    // A source that shrinks while it is copied is an error, not a short file.
    const shrinking = { ...source, read: async () => new Uint8Array(3) };
    ipc.on('fs_write_abort', () => null);
    await expect(writeSource(bridge, '/tmp/tonuino-studio/y.mp3', shrinking)).rejects.toMatchObject({ code: 'source-changed' });
  });
});
