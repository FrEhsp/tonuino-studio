import { describe, expect, it } from 'vitest';
import { sameSoundGroups, soundFingerprint } from '../../src/core/library/sameaudio';
import { memSource } from '../../src/platform/memory';

/** An ID3v2 tag of `n` bytes after its header: a different tag, the same sound. */
function tag(n: number): Uint8Array {
  const t = new Uint8Array(10 + n);
  t.set([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
  return t;
}

function sound(seed: number, length = 400_000): Uint8Array {
  let x = seed;
  return Uint8Array.from({ length }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 24) & 0xff);
}

const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

describe('the same sound under two names', () => {
  it('finds two files with different tags and the same sound, and not a different one', async () => {
    const a = memSource('2. Kapitel 01.mp3', join(tag(1000), sound(1)));
    const b = memSource('4. Kapitel 03.mp3', join(tag(1800), sound(1)));
    const c = memSource('8. Kapitel 02.mp3', join(tag(1000), sound(2)));
    const prints = new Map(await Promise.all([a, b, c].map(async (s) => [s, await soundFingerprint(s)] as const)));
    expect(prints.get(a)).toBeDefined();
    expect(prints.get(a)).toBe(prints.get(b));
    expect(sameSoundGroups([a, b, c], (s) => prints.get(s))).toEqual([[a, b]]);
  });

  it('leaves short files alone: jingles may be the same on purpose', async () => {
    expect(await soundFingerprint(memSource('Jingle.mp3', sound(1, 50_000)))).toBeUndefined();
  });
});
