/**
 * CRC-32 (IEEE 802.3, as in ZIP) of bytes and of Blobs. Eight tables, so it
 * takes eight bytes per step: a card's worth of audio is checked about as
 * fast as the card can be read.
 */

const TABLES = (() => {
  const t = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 8; k++) {
      c = t[c & 0xff] ^ (c >>> 8);
      t[k * 256 + n] = c >>> 0;
    }
  }
  return t;
})();

/** CRC-32 of `data`; pass the CRC of the bytes before to go on with them. Unsigned. */
export function crc32(data: Uint8Array, prev = 0): number {
  const t = TABLES;
  let crc = ~prev >>> 0;
  let i = 0;
  const n = data.length;
  const end8 = n - (n % 8);
  for (; i < end8; i += 8) {
    const one = (crc ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24))) >>> 0;
    const two = (data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24)) >>> 0;
    crc =
      t[1792 + (one & 0xff)] ^
      t[1536 + ((one >>> 8) & 0xff)] ^
      t[1280 + ((one >>> 16) & 0xff)] ^
      t[1024 + (one >>> 24)] ^
      t[768 + (two & 0xff)] ^
      t[512 + ((two >>> 8) & 0xff)] ^
      t[256 + ((two >>> 16) & 0xff)] ^
      t[two >>> 24];
  }
  for (; i < n; i++) crc = t[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

export interface CrcOptions {
  signal?: AbortSignal;
  /** Bytes of this Blob done so far. */
  onProgress?: (bytesDone: number) => void;
}

/** CRCs of Blobs already read in this session; a File of the card or staged data does not change. */
const known = new WeakMap<Blob, number>();

function aborted(): DOMException {
  return new DOMException('Abgebrochen', 'AbortError');
}

/** The CRC a Blob is known to have, without reading it. */
export function knownCrc32(blob: Blob): number | undefined {
  return known.get(blob);
}

/**
 * Forgets the CRC of a Blob, so the next pass reads it again. For card
 * files that may have changed on the card since they were read.
 */
export function forgetCrc32(blob: Blob): void {
  known.delete(blob);
}

/** Notes the CRC of a Blob that was computed while it was written. */
export function rememberCrc32(blob: Blob, crc: number): void {
  known.set(blob, crc >>> 0);
}

/**
 * Reads a Blob as a stream and returns its CRC-32. Rejects with an
 * AbortError DOMException when `signal` aborts, and with the browser's
 * error when the Blob cannot be read (a card that was pulled).
 */
export async function crc32OfBlob(blob: Blob, opts: CrcOptions = {}): Promise<number> {
  const hit = known.get(blob);
  if (hit !== undefined) {
    opts.onProgress?.(blob.size);
    return hit;
  }
  if (opts.signal?.aborted) throw aborted();
  const reader = blob.stream().getReader();
  let crc = 0;
  let done = 0;
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      if (opts.signal?.aborted) throw aborted();
      crc = crc32(value, crc);
      done += value.length;
      opts.onProgress?.(done);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  known.set(blob, crc);
  return crc;
}
