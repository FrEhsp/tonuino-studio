import { describe, expect, it } from 'vitest';
import { PickQueue } from '../../src/platform/web/pickqueue';
import { captureDrop, sourcesFromCapture } from '../../src/platform/web/drop';

describe('PickQueue', () => {
  it('lets a pick settle once', () => {
    const q = new PickQueue<string[]>([]);
    const got: string[][] = [];
    const finish = q.begin((v) => got.push(v));
    expect(q.waiting).toBe(true);
    finish(['a']);
    finish(['b']);
    expect(got).toEqual([['a']]);
    expect(q.waiting).toBe(false);
  });

  it('a new pick settles the one that still waits with the empty answer', () => {
    // Firefox: "Hochladen" declined, neither change nor cancel arrives.
    const q = new PickQueue<string[]>([]);
    const first: string[][] = [];
    const second: string[][] = [];
    const finishFirst = q.begin((v) => first.push(v));
    const finishSecond = q.begin((v) => second.push(v));
    expect(first).toEqual([[]]);
    // A late event of the first input changes nothing any more.
    finishFirst(['late']);
    expect(first).toEqual([[]]);
    expect(q.waiting).toBe(true);
    finishSecond(['x.mp3']);
    expect(second).toEqual([['x.mp3']]);
    expect(q.waiting).toBe(false);
  });

  it('a pick that ended normally is not settled again by the next', () => {
    const q = new PickQueue<number>(0);
    const got: number[] = [];
    q.begin((v) => got.push(v))(5);
    q.begin((v) => got.push(v));
    expect(got).toEqual([5]);
  });
});

/** A DataTransfer like the browser's: emptied once the drop event is over. */
function fakeDrop(files: File[]) {
  const items = files.map((f) => ({
    kind: 'file',
    type: f.type,
    getAsFile: () => f,
    webkitGetAsEntry: () => ({
      isFile: true,
      isDirectory: false,
      name: f.name,
      file: (ok: (x: File) => void) => ok(f),
    }),
  }));
  const dt = { items, types: ['Files'] };
  return { dt: dt as unknown as DataTransfer, endEvent: () => items.splice(0) };
}

describe('drops', () => {
  it('takes the files during the event, so they are still there after it', async () => {
    const { dt, endEvent } = fakeDrop([new File(['abc'], '001.mp3'), new File(['de'], 'cover.jpg')]);
    const captured = captureDrop(dt);
    endEvent();
    const sources = await sourcesFromCapture(captured);
    expect(sources.map((s) => [s.relativePath, s.size])).toEqual([
      ['001.mp3', 3],
      ['cover.jpg', 2],
    ]);
    expect(new TextDecoder().decode(await sources[0].read(0, 3))).toBe('abc');
  });

  it('reading the event after it ended finds nothing (the old bug)', async () => {
    const { dt, endEvent } = fakeDrop([new File(['abc'], '001.mp3')]);
    endEvent();
    expect(await sourcesFromCapture(captureDrop(dt))).toEqual([]);
  });
});
