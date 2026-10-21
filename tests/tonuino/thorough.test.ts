import { describe, expect, it } from 'vitest';
import { byFolder, thoroughCheck, thoroughTargets, thoroughVerdict, type ThoroughProgress } from '../../src/core/tonuino/thorough';
import type { SdScan } from '../../src/core/tonuino/sd';
import type { ByteSource, Dir } from '../../src/platform/types';

const track = (number: number, size = 1000, ext: 'mp3' | 'wav' = 'mp3') => ({ number, name: `${String(number).padStart(3, '0')}.${ext}`, size, suffix: '', ext, order: number });
const scan = {
  folders: [
    { number: 2, name: '02', tracks: [track(1), track(2, 0), track(3, 500, 'wav')] },
    { number: 1, name: '01', tracks: [track(1), track(2), track(3)] },
  ],
} as unknown as SdScan;

/** A card whose files are named after what the check finds. */
function root(unreadable: Set<string>): Dir {
  const dir = (folder: string) =>
    ({
      source: async (name: string) => {
        const key = `${folder}/${name}`;
        if (unreadable.has(key)) throw new Error('E/A-Fehler');
        return { size: 1, key } as unknown as ByteSource;
      },
    }) as unknown as Dir;
  return { dir: async (name: string) => dir(name) } as unknown as Dir;
}
const check = (broken: Set<string>) => async (s: ByteSource) => ({ check: broken.has((s as unknown as { key: string }).key) ? { rebuild: 'damaged' as const } : {} });

describe('Gründlich prüfen', () => {
  it('reads every MP3 of the folders in order, not empty files and not WAV', () => {
    expect(thoroughTargets(scan).map((t) => `${t.folderName}/${t.file}`)).toEqual(['01/001.mp3', '01/002.mp3', '01/003.mp3', '02/001.mp3']);
  });

  it('calls a track cut off while written broken without reading it (Testlabor)', async () => {
    const cut = { folders: [{ number: 1, name: '01', tracks: [track(1), track(2)], unfinished: ['002.mp3'] }] } as unknown as SdScan;
    const r = await thoroughCheck(root(new Set()), cut, { check: check(new Set()) });
    expect(r.checked).toBe(1);
    expect(r.damaged).toEqual([{ folder: 1, folderName: '01', file: '002.mp3' }]);
    expect(thoroughVerdict(r)).toBe('damaged');
  });

  it('finds broken files and files the card cannot read', async () => {
    const broken = new Set(['01/002.mp3']);
    const progress: ThoroughProgress[] = [];
    const r = await thoroughCheck(root(new Set(["02/001.mp3"])), scan, { check: check(broken), onProgress: (p) => progress.push(p) });
    expect(r.checked).toBe(3);
    expect(r.damaged).toEqual([{ folder: 1, folderName: '01', file: '002.mp3' }]);
    expect(r.unreadable).toEqual([{ folder: 2, folderName: '02', file: '001.mp3', error: 'E/A-Fehler' }]);
    expect(thoroughVerdict(r)).toBe('wearing');
    expect(progress.at(-1)).toMatchObject({ done: 4, total: 4, bytesDone: 4000, bytesTotal: 4000 });
  });

  it('can be stopped', async () => {
    const ctrl = new AbortController();
    const r = await thoroughCheck(root(new Set()), scan, {
      signal: ctrl.signal,
      check: async () => {
        ctrl.abort();
        return { check: {} };
      },
    });
    expect(r.stopped).toBe(true);
    expect(r.checked).toBe(1);
    expect(thoroughVerdict(r)).toBe('fine');
  });

  it('groups files by folder', () => {
    expect(byFolder([{ folder: 3, folderName: '03', file: 'a' }, { folder: 1, folderName: '01', file: 'b' }, { folder: 3, folderName: '03', file: 'c' }])).toEqual([
      { folder: 1, folderName: '01', files: ['b'] },
      { folder: 3, folderName: '03', files: ['a', 'c'] },
    ]);
    expect(thoroughVerdict({ checked: 1, bytes: 1, damaged: [{ folder: 1, folderName: '01', file: 'x' }], unreadable: [], stopped: false })).toBe('damaged');
  });
});
