import { describe, expect, it, vi } from 'vitest';
import { LeaseCache } from '../../src/core/stickers/cache';

interface Pic {
  name: string;
  size: number;
}

function setup(budget: number) {
  const freed: string[] = [];
  const cache = new LeaseCache<Pic>(budget, (p) => p.size, (p) => freed.push(p.name));
  const load = (name: string, size: number) => vi.fn(async () => ({ name, size }));
  return { cache, freed, load };
}

describe('LeaseCache', () => {
  it('loads a value once and shares it between users', async () => {
    const { cache, load } = setup(100);
    const loadA = load('a', 10);
    const [first, second] = await Promise.all([cache.lease('a', loadA), cache.lease('a', loadA)]);
    expect(first.value).toBe(second.value);
    expect(loadA).toHaveBeenCalledTimes(1);
    first.release();
    second.release();
    const again = await cache.lease('a', loadA);
    expect(again.value.name).toBe('a');
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(cache.usage).toBe(10);
  });

  it('frees the least recently used values when the budget is exceeded', async () => {
    const { cache, freed, load } = setup(25);
    for (const name of ['a', 'b']) (await cache.lease(name, load(name, 10))).release();
    // Using "a" again makes "b" the oldest.
    (await cache.lease('a', load('a', 10))).release();
    (await cache.lease('c', load('c', 10))).release();
    expect(freed).toEqual(['b']);
    expect(cache.has('a') && cache.has('c') && !cache.has('b')).toBe(true);
    expect(cache.usage).toBe(20);
  });

  it('never frees a value while it is leased', async () => {
    const { cache, freed, load } = setup(15);
    const a = await cache.lease('a', load('a', 10));
    const b = await cache.lease('b', load('b', 10));
    // Both in use: over budget, but nothing is freed.
    expect(freed).toEqual([]);
    a.release();
    expect(freed).toEqual(['a']);
    b.release();
    b.release();
    expect(freed).toEqual(['a']);
    expect(cache.usage).toBe(10);
  });

  it('frees a dropped value at once or after its last lease', async () => {
    const { cache, freed, load } = setup(100);
    (await cache.lease('a', load('a', 10))).release();
    cache.drop('a');
    expect(freed).toEqual(['a']);
    expect(cache.has('a')).toBe(false);

    const b = await cache.lease('b', load('b', 10));
    cache.drop('b');
    expect(freed).toEqual(['a']);
    expect(b.value.name).toBe('b');
    b.release();
    expect(freed).toEqual(['a', 'b']);
    cache.drop('unknown');
  });

  it('frees a value that was dropped while it was still loading', async () => {
    const { cache, freed } = setup(100);
    let finish: (p: Pic) => void = () => undefined;
    const leased = cache.lease('a', () => new Promise<Pic>((resolve) => (finish = resolve)));
    cache.drop('a');
    finish({ name: 'a', size: 10 });
    const a = await leased;
    expect(freed).toEqual([]);
    a.release();
    expect(freed).toEqual(['a']);
    expect(cache.usage).toBe(0);
  });

  it('does not keep failed loads', async () => {
    const { cache, load } = setup(100);
    const broken = vi.fn(async (): Promise<Pic> => Promise.reject(new Error('kaputt')));
    await expect(cache.lease('a', broken)).rejects.toThrow('kaputt');
    expect(cache.has('a')).toBe(false);
    const fixed = load('a', 10);
    expect((await cache.lease('a', fixed)).value.name).toBe('a');
    expect(fixed).toHaveBeenCalledTimes(1);
  });
});
