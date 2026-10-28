/**
 * Which work each folder is, worked out ahead after the card is read
 * (src/features/stickers/warmup.ts, Tempo #121): every folder once, in
 * short steps, and not for a catalog that was replaced meanwhile.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen: string[] = [];
vi.mock('../../src/core/stickers/works', () => ({
  workColors: (f: { title: string }) => {
    seen.push(f.title);
    return undefined;
  },
}));

const { warmCatalog } = await import('../../src/features/stickers/warmup');
const { newCatalog } = await import('../../src/core/tonuino/catalog');

function card(n: number) {
  const cat = newCatalog();
  for (let i = 1; i <= n; i++) cat.folders[String(i).padStart(2, '0')] = { title: `Ordner ${i}`, tracks: [] } as never;
  return cat;
}

/** A schedule that runs nothing by itself: the test says when each step comes. */
function steps() {
  const queue: (() => void)[] = [];
  const firsts: number[] = [];
  return {
    schedule: {
      first: (run: () => void) => {
        firsts.push(queue.length);
        queue.push(run);
      },
      next: (run: () => void) => void queue.push(run),
    },
    firsts,
    runAll() {
      let n = 0;
      while (queue.length) {
        queue.shift()!();
        n++;
      }
      return n;
    },
  };
}

beforeEach(() => {
  seen.length = 0;
});

describe('working out the folders ahead', () => {
  it('waits for a quiet moment first and then goes over every folder once', () => {
    const s = steps();
    warmCatalog(card(52), () => true, s.schedule, () => 0);
    expect(seen).toEqual([]);
    expect(s.firsts).toEqual([0]);
    s.runAll();
    expect(seen).toHaveLength(52);
    expect(new Set(seen).size).toBe(52);
  });

  it('goes in steps of a few milliseconds, with a turn for the browser between them', () => {
    const s = steps();
    let t = 0;
    // Each folder takes 3 ms here: at most three to a step of 8 ms.
    const now = () => {
      const was = t;
      t += 3;
      return was;
    };
    warmCatalog(card(12), () => true, s.schedule, now);
    const count = s.runAll();
    expect(seen).toHaveLength(12);
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it('stops when another catalog took its place', () => {
    const s = steps();
    let current = true;
    let t = 0;
    warmCatalog(card(30), () => current, s.schedule, () => (t += 5));
    s.runAll();
    expect(seen).toHaveLength(30);

    seen.length = 0;
    const s2 = steps();
    warmCatalog(card(30), () => current, s2.schedule, () => (t += 5));
    current = false;
    s2.runAll();
    expect(seen).toEqual([]);
  });

  it('has nothing to do for a card without folders', () => {
    const s = steps();
    warmCatalog(card(0), () => true, s.schedule);
    expect(s.firsts).toEqual([]);
  });
});
