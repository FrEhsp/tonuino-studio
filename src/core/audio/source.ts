/**
 * Helpers around ByteSource: wrap a Blob or a buffer, stream a source in
 * chunks, and a sliding window reader for parsers that walk a file forward.
 *
 * Bytes returned by `ByteSource.read` are treated as read-only everywhere in
 * the audio core; `bufferSource` returns views into the original buffer.
 */
import type { ByteSource } from '../../platform/types';
import { AudioError, checkAborted } from './errors';

/** Default chunk size for streaming reads (1 MiB). */
export const CHUNK_SIZE = 1 << 20;

/** A ByteSource backed by a browser Blob or File. */
export function fileSource(blob: Blob, name?: string, relativePath?: string): ByteSource {
  const isFile = typeof File !== 'undefined' && blob instanceof File;
  const fileName = name ?? (isFile ? (blob as File).name : 'audio');
  const rel = relativePath ?? (isFile && (blob as File).webkitRelativePath ? (blob as File).webkitRelativePath : undefined);
  return {
    name: fileName,
    size: blob.size,
    blob,
    relativePath: rel,
    async read(start: number, length: number): Promise<Uint8Array> {
      const s = Math.max(0, Math.min(blob.size, start));
      const e = Math.max(s, Math.min(blob.size, start + length));
      if (e === s) return new Uint8Array(0);
      try {
        return new Uint8Array(await blob.slice(s, e).arrayBuffer());
      } catch (err) {
        throw new AudioError('read-failed', undefined, { cause: err });
      }
    },
  };
}

/** A ByteSource backed by bytes in memory. Reads return views, not copies. */
export function bufferSource(data: Uint8Array, name = 'audio'): ByteSource {
  return {
    name,
    size: data.length,
    async read(start: number, length: number): Promise<Uint8Array> {
      const s = Math.max(0, Math.min(data.length, start));
      const e = Math.max(s, Math.min(data.length, start + length));
      return data.subarray(s, e);
    },
  };
}

/**
 * Reads `source` from `start` to `end` in chunks of `chunkSize` bytes. The next
 * chunk is requested while the caller works on the current one.
 */
export async function* readChunks(
  source: ByteSource,
  chunkSize: number = CHUNK_SIZE,
  signal?: AbortSignal,
  start = 0,
  end: number = source.size,
): AsyncGenerator<Uint8Array, void, undefined> {
  let pos = Math.max(0, start);
  const stop = Math.min(end, source.size);
  let pending: Promise<Uint8Array> | null = pos < stop ? source.read(pos, Math.min(chunkSize, stop - pos)) : null;
  try {
    while (pending) {
      checkAborted(signal);
      const chunk = await pending;
      pending = null;
      checkAborted(signal);
      if (chunk.length === 0) return; // source shorter than announced
      pos += chunk.length;
      if (pos < stop) pending = source.read(pos, Math.min(chunkSize, stop - pos));
      yield chunk;
    }
  } finally {
    // The consumer stopped early or failed: keep a prefetch from turning into an unhandled rejection.
    pending?.catch(() => undefined);
  }
}

/** Reads a range, tolerating sources that return the bytes in several pieces. */
export async function readRange(source: ByteSource, start: number, length: number): Promise<Uint8Array> {
  const first = await source.read(start, length);
  if (first.length >= length || start + first.length >= source.size || first.length === 0) return first;
  const out = new Uint8Array(Math.min(length, source.size - start));
  out.set(first);
  let filled = first.length;
  while (filled < out.length) {
    const more = await source.read(start + filled, out.length - filled);
    if (more.length === 0) break;
    out.set(more, filled);
    filled += more.length;
  }
  return filled === out.length ? out : out.subarray(0, filled);
}

/**
 * Sliding window over a byte range for forward parsers. `ensure(pos, len)`
 * makes `[pos, pos + len)` available in `buf` (at `pos - base`) and keeps the
 * bytes that are still needed when it has to read more.
 */
export class WindowReader {
  buf: Uint8Array = new Uint8Array(0);
  /** File offset of buf[0]. */
  base = 0;

  constructor(
    readonly source: ByteSource,
    readonly end: number = source.size,
    readonly chunkSize: number = CHUNK_SIZE,
  ) {}

  /** End offset (exclusive) of the bytes currently in the window. */
  get limit(): number {
    return this.base + this.buf.length;
  }

  /**
   * Returns true when the whole range is available. Near `end` only the bytes
   * before `end` can be loaded; the function then returns false.
   */
  async ensure(pos: number, len: number): Promise<boolean> {
    const want = Math.min(pos + len, this.end);
    if (pos >= this.base && want <= this.limit) return pos + len <= this.end;
    if (pos >= this.end) return false;
    const readEnd = Math.min(this.end, Math.max(want, pos + this.chunkSize));
    if (pos >= this.base && pos < this.limit) {
      const keep = this.buf.subarray(pos - this.base);
      const more = await readRange(this.source, this.limit, readEnd - this.limit);
      const merged = new Uint8Array(keep.length + more.length);
      merged.set(keep);
      merged.set(more, keep.length);
      this.buf = merged;
    } else {
      this.buf = await readRange(this.source, pos, readEnd - pos);
    }
    this.base = pos;
    return pos + len <= Math.min(this.end, this.limit);
  }
}

/** Concatenates byte arrays. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Wraps bytes so they can go into a Blob under strict DOM typings. */
export function blobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart;
}

/** Collects output and packs it into Blobs every few MB, so the browser can keep big results out of the JS heap. */
export class BlobCollector {
  private blobs: Blob[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  bytes = 0;

  push(parts: readonly Uint8Array[]): void {
    for (const p of parts) {
      this.pending.push(p);
      this.pendingBytes += p.length;
      this.bytes += p.length;
    }
    if (this.pendingBytes >= 8 << 20) this.pack();
  }

  /** Adds a Blob (e.g. a slice of the source) after what came so far. */
  pushBlob(blob: Blob): void {
    this.pack();
    this.blobs.push(blob);
    this.bytes += blob.size;
  }

  private pack(): void {
    if (this.pending.length === 0) return;
    this.blobs.push(new Blob(this.pending.map(blobPart)));
    this.pending = [];
    this.pendingBytes = 0;
  }

  toBlob(head: readonly Uint8Array[] = []): Blob {
    this.pack();
    return new Blob([...head.filter((h) => h.length > 0).map(blobPart), ...this.blobs], { type: 'audio/mpeg' });
  }
}

/** Bytes [start, end) of a source as a Blob; read piece by piece when no Blob is behind the source (desktop). */
export async function blobOfRange(source: ByteSource, start: number, end: number, signal?: AbortSignal): Promise<Blob> {
  if (source.blob) return source.blob.slice(start, end);
  const out = new BlobCollector();
  for await (const chunk of readChunks(source, 4 << 20, signal, start, end)) out.push([chunk]);
  return out.toBlob();
}

/**
 * Buffers to transfer with postMessage: each array's buffer once, and only
 * when the array owns the whole buffer (others are copied instead).
 */
export function transferList(arrays: readonly ArrayBufferView[]): Transferable[] {
  const set = new Set<ArrayBuffer>();
  for (const a of arrays) if (a.buffer instanceof ArrayBuffer && a.byteOffset === 0 && a.byteLength === a.buffer.byteLength) set.add(a.buffer);
  return [...set];
}
