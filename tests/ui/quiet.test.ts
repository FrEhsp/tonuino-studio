/**
 * Turns for the browser (src/ui/quiet.ts, Tempo #121): `nextTask` goes on in
 * a task of its own and in order; a page come to the front is painted before
 * its stickers are drawn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTask, pageComingUp, pageSettled, quietMoment } from '../../src/ui/quiet';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a turn for the browser', () => {
  it('goes on after what was already waiting, in the order asked', async () => {
    const order: string[] = [];
    const a = nextTask().then(() => order.push('a'));
    const b = nextTask().then(() => order.push('b'));
    void Promise.resolve().then(() => order.push('microtask'));
    await Promise.all([a, b]);
    expect(order).toEqual(['microtask', 'a', 'b']);
  });
});

describe('a page coming to the front', () => {
  it('is settled after three frames', async () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => frames.push(f));
    expect(pageSettled()).toBeNull();
    pageComingUp();
    const settled = pageSettled();
    expect(settled).not.toBeNull();
    let done = false;
    void settled!.then(() => (done = true));
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      expect(done).toBe(false);
      frames.shift()!();
    }
    await settled;
    expect(done).toBe(true);
    // Nothing to wait for any more.
    await Promise.resolve();
    expect(pageSettled()).toBeNull();
  });

  it('waits for the page that came last', async () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => frames.push(f));
    pageComingUp();
    const first = pageSettled();
    pageComingUp();
    const second = pageSettled();
    expect(second).not.toBe(first);
    while (frames.length) frames.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    while (frames.length) frames.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    while (frames.length) frames.shift()!();
    await Promise.all([first, second]);
    await Promise.resolve();
    expect(pageSettled()).toBeNull();
  });

  it('draws at once where there are no frames (tests, a worker)', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    pageComingUp();
    expect(pageSettled()).toBeNull();
  });
});

describe('a quiet moment', () => {
  it('waits after a page came to the front, as after a click', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('requestIdleCallback', undefined);
    const t0 = performance.now();
    pageComingUp();
    await quietMoment(60);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(55);
  });
});
