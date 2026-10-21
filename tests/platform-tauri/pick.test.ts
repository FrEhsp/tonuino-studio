import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../src/platform/types';
import { onFileDrop, pickFiles, recentDownloads } from '../../src/platform/tauri/pick';
import { fakeBridge, flush } from './fake-ipc';

describe('pickFiles', () => {
  it('returns path-based sources for picked files', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('dialog_pick_files', () => [{ path: '/home/anna/cover.JPG', name: 'cover.JPG', size: 1234 }]);
    const [src, ...rest] = await pickFiles(bridge, { multiple: false, extensions: ['.JPG', 'png', 'jpg'] });
    expect(rest).toEqual([]);
    expect(src).toMatchObject({ name: 'cover.JPG', size: 1234, path: '/home/anna/cover.JPG' });
    expect(src.relativePath).toBeUndefined();
    expect(ipc.calls[0].args).toMatchObject({ multiple: false, extensions: ['jpg', 'png'] });
  });

  it('lists a picked folder recursively with the folder name in relativePath', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('dialog_pick_folder', () => ({
      path: '/home/anna/Bibi Blocksberg',
      name: 'Bibi Blocksberg',
      files: [
        { path: '/home/anna/Bibi Blocksberg/CD 1/01 Intro.mp3', name: '01 Intro.mp3', size: 10, relativePath: 'Bibi Blocksberg/CD 1/01 Intro.mp3' },
        { path: '/home/anna/Bibi Blocksberg/cover.jpg', name: 'cover.jpg', size: 5, relativePath: 'Bibi Blocksberg/cover.jpg' },
      ],
    }));
    const files = await pickFiles(bridge, { directory: true });
    expect(ipc.calls[0].args).toMatchObject({ purpose: 'import', extensions: null });
    expect(files.map((f) => f.relativePath)).toEqual(['Bibi Blocksberg/CD 1/01 Intro.mp3', 'Bibi Blocksberg/cover.jpg']);
    expect(files[0].path).toBe('/home/anna/Bibi Blocksberg/CD 1/01 Intro.mp3');
  });

  it('resolves [] when the dialog is cancelled', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('dialog_pick_folder', () => null);
    ipc.on('dialog_pick_files', () => []);
    expect(await pickFiles(bridge, { directory: true })).toEqual([]);
    expect(await pickFiles(bridge, {})).toEqual([]);
    expect(ipc.callsOf('dialog_pick_files')[0].args).toMatchObject({ multiple: true });
  });
});

describe('onFileDrop', () => {
  it('turns native drops into sources and stops after unsubscribe', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('drop_resolve', (args) => {
      const { paths } = args as { paths: string[] };
      expect(paths).toEqual(['/home/anna/Bibi Blocksberg']);
      return [{ path: '/home/anna/Bibi Blocksberg/CD 1/01 Intro.mp3', name: '01 Intro.mp3', size: 10, relativePath: 'Bibi Blocksberg/CD 1/01 Intro.mp3' }];
    });
    const got: ByteSource[][] = [];
    const stop = onFileDrop(bridge, (s) => got.push(s));
    await flush();
    ipc.drop({ type: 'enter', paths: ['/home/anna/Bibi Blocksberg'] });
    ipc.drop({ type: 'over' });
    ipc.drop({ type: 'drop', paths: ['/home/anna/Bibi Blocksberg'] });
    await flush();
    expect(got).toHaveLength(1);
    expect(got[0][0].relativePath).toBe('Bibi Blocksberg/CD 1/01 Intro.mp3');
    expect(ipc.callsOf('drop_resolve')).toHaveLength(1);
    stop();
    expect(ipc.dropListenerCount).toBe(0);
  });

  it('unsubscribes even when called before the listener is ready', async () => {
    const { ipc, bridge } = fakeBridge();
    const stop = onFileDrop(bridge, () => undefined);
    stop();
    await flush();
    expect(ipc.dropListenerCount).toBe(0);
  });
});

describe('recentDownloads', () => {
  it('asks for new audio files in the download folder and reads them by path', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('downloads_recent', () => ({ folder: '/home/anna/Downloads', files: [{ path: '/home/anna/Downloads/folge.mp3', name: 'folge.mp3', size: 99, modifiedMs: 1_700_000_000_000 }] }));
    const got = await recentDownloads(bridge, 1_699_999_999_999.7, ['MP3', '.m4a', 'mp3']);
    expect(ipc.calls[0].args).toEqual({ sinceMs: 1_699_999_999_999, extensions: ['mp3', 'm4a'] });
    expect(got.folder).toBe('/home/anna/Downloads');
    expect(got.files[0]).toMatchObject({ modifiedMs: 1_700_000_000_000, source: { name: 'folge.mp3', size: 99, path: '/home/anna/Downloads/folge.mp3' } });
    // A system without a download folder.
    ipc.on('downloads_recent', () => ({ folder: null, files: [] }));
    expect(await recentDownloads(bridge, 0, ['mp3'])).toEqual({ files: [] });
  });
});
