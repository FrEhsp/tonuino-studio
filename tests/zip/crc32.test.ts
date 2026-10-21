import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, crc32OfBlob, knownCrc32, rememberCrc32 } from '../../src/core/zip/crc32';

const enc = new TextEncoder();

function noise(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** A Blob that hands out its stream in chunks of a given size and counts how often it was read. */
class ChunkedBlob extends Blob {
  reads = 0;
  constructor(
    private readonly data: Uint8Array,
    private readonly chunk: number,
    private readonly failAt?: number,
  ) {
    super([data as BlobPart]);
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    this.reads++;
    let at = 0;
    const { data: bytes, chunk, failAt } = this;
    return new ReadableStream({
      pull(c) {
        if (failAt !== undefined && at >= failAt) {
          c.error(new DOMException('Die Datei ist weg', 'NotFoundError'));
          return;
        }
        if (at >= bytes.length) return c.close();
        c.enqueue(bytes.slice(at, at + chunk));
        at += chunk;
      },
    });
  }
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('matches zlib for every length around the eight-byte steps', () => {
    for (let n = 0; n < 70; n++) {
      const d = noise(n, n + 1);
      expect(crc32(d), String(n)).toBe(zlibCrc32(d) >>> 0);
    }
    const big = noise(1_000_003);
    expect(crc32(big)).toBe(zlibCrc32(big) >>> 0);
  });

  it('goes on from an earlier CRC, chunk by chunk', () => {
    const d = noise(100_000);
    let c = 0;
    for (let i = 0; i < d.length; i += 777) c = crc32(d.subarray(i, i + 777), c);
    expect(c).toBe(crc32(d));
  });
});

describe('crc32OfBlob', () => {
  it('reads across chunk borders and reports progress', async () => {
    const d = noise(300_001);
    const blob = new ChunkedBlob(d, 4093);
    const seen: number[] = [];
    expect(await crc32OfBlob(blob, { onProgress: (n) => seen.push(n) })).toBe(zlibCrc32(d) >>> 0);
    expect(seen.at(-1)).toBe(d.length);
    expect(seen.length).toBeGreaterThan(10);
  });

  it('remembers the CRC of a Blob it has read', async () => {
    const blob = new ChunkedBlob(noise(5000), 1000);
    const a = await crc32OfBlob(blob);
    const b = await crc32OfBlob(blob);
    expect(a).toBe(b);
    expect(blob.reads).toBe(1);
    expect(knownCrc32(blob)).toBe(a);
  });

  it('takes a CRC computed while writing', async () => {
    const blob = new ChunkedBlob(noise(10), 10);
    rememberCrc32(blob, 0x1234);
    expect(await crc32OfBlob(blob)).toBe(0x1234);
    expect(blob.reads).toBe(0);
  });

  it('stops with an AbortError', async () => {
    const ctrl = new AbortController();
    const blob = new ChunkedBlob(noise(100_000), 1000);
    let calls = 0;
    const p = crc32OfBlob(blob, {
      signal: ctrl.signal,
      onProgress: () => {
        if (++calls === 3) ctrl.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(knownCrc32(blob)).toBeUndefined();
    const ctrl2 = new AbortController();
    ctrl2.abort();
    await expect(crc32OfBlob(new Blob(['x']), { signal: ctrl2.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes on the error of a file that cannot be read', async () => {
    await expect(crc32OfBlob(new ChunkedBlob(noise(10_000), 1000, 3000))).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
