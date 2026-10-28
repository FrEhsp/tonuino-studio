import { describe, expect, it } from 'vitest';
import { createSmallCovers, type SmallCoverParts } from '../../src/ui/smallCovers';

function fakes(over: Partial<SmallCoverParts> = {}) {
  const shrunk: string[] = [];
  const revoked: string[] = [];
  let calms = 0;
  const parts: SmallCoverParts = {
    shrink: async (url) => {
      shrunk.push(url);
      return `small:${url}`;
    },
    revoke: (url) => void revoked.push(url),
    calm: async () => void calms++,
    ...over,
  };
  return { parts, shrunk, revoked, calms: () => calms };
}

describe('small copies of the covers', () => {
  it('shows the cover itself until its small copy is there, then the copy', async () => {
    const f = fakes();
    const s = createSmallCovers(f.parts);
    expect(s.get('blob:a')).toBe('blob:a');
    s.want(['blob:a', 'blob:b']);
    await s.idle();
    expect(s.get('blob:a')).toBe('small:blob:a');
    expect(s.get('blob:b')).toBe('small:blob:b');
    expect(s.get('blob:c')).toBe('blob:c');
  });

  it('makes each copy once, each in a quiet moment of its own', async () => {
    const f = fakes();
    const s = createSmallCovers(f.parts);
    s.want(['blob:a', 'blob:b']);
    s.want(['blob:a', 'blob:b']);
    await s.idle();
    s.want(['blob:b', 'blob:a']);
    await s.idle();
    expect(f.shrunk).toEqual(['blob:a', 'blob:b']);
    expect(f.calms()).toBe(2);
  });

  it('frees the copies of covers that are gone (another card)', async () => {
    const f = fakes();
    const s = createSmallCovers(f.parts);
    s.want(['blob:a', 'blob:b']);
    await s.idle();
    s.want(['blob:b', 'blob:c']);
    await s.idle();
    expect(f.revoked).toEqual(['small:blob:a']);
    expect(s.get('blob:a')).toBe('blob:a');
    expect(s.get('blob:c')).toBe('small:blob:c');
  });

  it('frees a copy finished after its cover went', async () => {
    let release = () => {};
    const f = fakes({
      shrink: (url) =>
        new Promise((resolve) => {
          release = () => resolve(`small:${url}`);
        }),
    });
    const s = createSmallCovers(f.parts);
    s.want(['blob:a']);
    await new Promise((r) => setTimeout(r, 0));
    s.want([]);
    release();
    await s.idle();
    expect(f.revoked).toEqual(['small:blob:a']);
    expect(s.get('blob:a')).toBe('blob:a');
  });

  it('keeps the cover where no copy can be made, and does not try again', async () => {
    let tries = 0;
    const f = fakes({
      shrink: async () => {
        tries++;
        throw new Error('no picture');
      },
    });
    const s = createSmallCovers(f.parts);
    s.want(['blob:a']);
    await s.idle();
    s.want(['blob:a']);
    await s.idle();
    expect(s.get('blob:a')).toBe('blob:a');
    expect(tries).toBe(1);
  });

  it('takes covers wanted while it works', async () => {
    const f = fakes();
    const s = createSmallCovers(f.parts);
    s.want(['blob:a']);
    s.want(['blob:a', 'blob:b']);
    await s.idle();
    expect(s.get('blob:b')).toBe('small:blob:b');
  });
});
