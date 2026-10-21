/**
 * Path-based Dir and ByteSource on top of the fs_* commands.
 * Large reads go out in 8 MiB pieces, large writes in 4 MiB chunks with
 * progress; every write is flushed to the device before it resolves.
 */
import type { ByteSource, Dir, DirEntry, WriteOptions } from '../types';
import { sliceBytes, toBytes } from './binary';
import { encodeHeader, uniqueId, type Bridge } from './bridge';
import { abortReason, platformError, toPlatformError, type ErrorArea } from './errors';

export const READ_CHUNK = 8 * 1024 * 1024;
export const WRITE_CHUNK = 4 * 1024 * 1024;

interface DirEntryDto {
  name: string;
  kind: 'file' | 'directory';
  size?: number;
  modified?: number;
  readOnly?: boolean;
}

export interface StatDto {
  kind: 'file' | 'directory' | 'other';
  size: number;
  modified: number | null;
  readOnly: boolean;
}

interface CopyProgressDto {
  copyId: string;
  copied: number;
  total: number;
}

export function joinPath(dir: string, name: string, sep: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed;
}

/** Entry names must be plain names: no separators, no "." or "..". */
export function checkName(name: string): void {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw platformError('invalid-name', 'fs', `invalid name: ${JSON.stringify(name)}`);
  }
}

export async function readRange(bridge: Bridge, path: string, start: number, length: number): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array(0);
  if (length <= READ_CHUNK) {
    return toBytes(await bridge.call('fs', 'fs_read_range', { path, start, length }));
  }
  const parts: Uint8Array[] = [];
  let got = 0;
  while (got < length) {
    const n = Math.min(READ_CHUNK, length - got);
    const part = toBytes(await bridge.call('fs', 'fs_read_range', { path, start: start + got, length: n }));
    parts.push(part);
    got += part.length;
    if (part.length < n) break; // end of file
  }
  const out = new Uint8Array(got);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Hands out the bytes [start, end) of whatever is being written. */
export type ChunkReader = (start: number, end: number) => Promise<Uint8Array>;

export interface WriteFileOptions extends WriteOptions {
  /** Which messages errors get: "fs" (SD card, default), "save" (export), "audio" (temp copy). */
  area?: ErrorArea;
}

/**
 * Creates or replaces `path` with `size` bytes from `readChunk`; resolves
 * after the data is flushed to the device. Small files go out in one call,
 * big ones in WRITE_CHUNK pieces with progress. A failed or aborted chunked
 * write removes the partial file.
 */
export async function writeChunks(
  bridge: Bridge,
  path: string,
  size: number,
  readChunk: ChunkReader,
  opts: WriteFileOptions = {},
): Promise<void> {
  const { onProgress, signal, area = 'fs' } = opts;
  const header = encodeHeader(path);
  const piece = async (start: number, end: number) => {
    const bytes = await readChunk(start, end);
    if (bytes.byteLength !== end - start) {
      throw platformError('source-changed', area, `expected ${end - start} bytes at ${start}, got ${bytes.byteLength}`);
    }
    if (signal?.aborted) throw abortReason(signal);
    return bytes;
  };
  if (signal?.aborted) throw abortReason(signal);
  if (size <= WRITE_CHUNK) {
    try {
      const bytes = await piece(0, size);
      await bridge.call(area, 'fs_write', bytes, { headers: { 'x-path': header } });
    } catch (e) {
      if (signal?.aborted) throw abortReason(signal);
      throw toPlatformError(e, area);
    }
    onProgress?.(size);
    return;
  }
  let offset = 0;
  try {
    while (offset < size) {
      const end = Math.min(size, offset + WRITE_CHUNK);
      const chunk = await piece(offset, end);
      await bridge.call(area, 'fs_write_chunk', chunk, { headers: { 'x-path': header, 'x-offset': String(offset) } });
      offset = end;
      onProgress?.(offset);
    }
    if (signal?.aborted) throw abortReason(signal);
    await bridge.call(area, 'fs_write_finish', { path });
  } catch (e) {
    // Never leave a half-written file behind.
    await bridge.ipc.invoke('fs_write_abort', { path }).catch(() => undefined);
    if (signal?.aborted) throw abortReason(signal);
    throw toPlatformError(e, area);
  }
}

/** Creates or replaces a file; resolves after the data is flushed to the device. */
export function writeFile(bridge: Bridge, path: string, data: Uint8Array | Blob, opts: WriteFileOptions = {}): Promise<void> {
  const size = data instanceof Uint8Array ? data.byteLength : data.size;
  return writeChunks(bridge, path, size, (start, end) => sliceBytes(data, start, end), opts);
}

/** Writes the content of a ByteSource without holding all of it in memory. */
export function writeSource(bridge: Bridge, path: string, source: ByteSource, opts: WriteFileOptions = {}): Promise<void> {
  if (source.blob) return writeFile(bridge, path, source.blob, opts);
  return writeChunks(bridge, path, source.size, (start, end) => source.read(start, end - start), opts);
}

export class PathByteSource implements ByteSource {
  readonly name: string;
  readonly size: number;
  readonly path: string;
  readonly relativePath?: string;
  private readonly bridge: Bridge;

  constructor(bridge: Bridge, file: { path: string; name: string; size: number; relativePath?: string | null }) {
    this.bridge = bridge;
    this.path = file.path;
    this.name = file.name;
    this.size = file.size;
    if (file.relativePath) this.relativePath = file.relativePath;
  }

  read(start: number, length: number): Promise<Uint8Array> {
    const from = Math.max(0, Math.min(start, this.size));
    const n = Math.max(0, Math.min(length, this.size - from));
    return readRange(this.bridge, this.path, from, n);
  }
}

export interface CopyOptions extends WriteOptions {}

export class TauriDir implements Dir {
  readonly name: string;
  readonly path: string;
  private readonly bridge: Bridge;

  constructor(bridge: Bridge, path: string, name?: string) {
    this.bridge = bridge;
    this.path = path;
    this.name = name ?? baseName(path);
  }

  private child(name: string): string {
    checkName(name);
    return joinPath(this.path, name, this.bridge.sep);
  }

  /** Entries in the order the filesystem returns them (FAT: on-disk order). */
  async list(): Promise<DirEntry[]> {
    const entries = await this.bridge.call<DirEntryDto[]>('fs', 'fs_list', { path: this.path });
    return entries.map((e) => {
      const entry: DirEntry = { name: e.name, kind: e.kind };
      if (e.size !== undefined && e.size !== null) entry.size = e.size;
      if (e.modified !== undefined && e.modified !== null) entry.modified = e.modified;
      if (e.readOnly) entry.readOnly = true;
      return entry;
    });
  }

  async dir(name: string, opts: { create?: boolean } = {}): Promise<Dir> {
    const path = this.child(name);
    if (opts.create) {
      await this.bridge.call('fs', 'fs_mkdir', { path });
    } else {
      const stat = await this.bridge.call<StatDto>('fs', 'fs_stat', { path });
      if (stat.kind !== 'directory') throw platformError('not-a-directory', 'fs', `${path} is not a folder`);
    }
    return new TauriDir(this.bridge, path, name);
  }

  async exists(name: string): Promise<boolean> {
    return this.bridge.call<boolean>('fs', 'fs_exists', { path: this.child(name) });
  }

  async read(name: string): Promise<Uint8Array> {
    return toBytes(await this.bridge.call('fs', 'fs_read', { path: this.child(name) }));
  }

  async readRange(name: string, start: number, length: number): Promise<Uint8Array> {
    return readRange(this.bridge, this.child(name), start, length);
  }

  async source(name: string): Promise<ByteSource> {
    const path = this.child(name);
    const stat = await this.bridge.call<StatDto>('fs', 'fs_stat', { path });
    if (stat.kind !== 'file') throw platformError('not-a-file', 'fs', `${path} is not a file`);
    return new PathByteSource(this.bridge, { path, name, size: stat.size });
  }

  async write(name: string, data: Uint8Array | Blob, opts?: WriteOptions): Promise<void> {
    return writeFile(this.bridge, this.child(name), data, opts);
  }

  async makeWritable(paths: string[]): Promise<number> {
    return this.bridge.call<number>('fs', 'fs_make_writable', { root: this.path, paths });
  }

  async remove(name: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await this.bridge.call('fs', 'fs_remove', { path: this.child(name), recursive: opts.recursive ?? false });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.bridge.call('fs', 'fs_rename', { from: this.child(from), to: this.child(to) });
  }

  async move(name: string, target: Dir, newName?: string): Promise<void> {
    if (!target.path) throw platformError('invalid-argument', 'fs', 'target folder has no path');
    checkName(newName ?? name);
    const to = joinPath(target.path, newName ?? name, this.bridge.sep);
    await this.bridge.call('fs', 'fs_rename', { from: this.child(name), to });
  }

  /**
   * Desktop extra: copies a file into this folder without sending the bytes
   * through the WebView when the source lives on disk (big audiobooks).
   */
  async copyFrom(name: string, source: ByteSource, opts: CopyOptions = {}): Promise<void> {
    const to = this.child(name);
    if (!source.path) return writeSource(this.bridge, to, source, opts);
    const copyId = uniqueId('copy');
    const { onProgress, signal } = opts;
    if (signal?.aborted) throw abortReason(signal);
    const unlisten = onProgress
      ? await this.bridge.ipc.listen<CopyProgressDto>('copy-progress', (p) => {
          if (p.copyId === copyId) onProgress(p.copied);
        })
      : undefined;
    const onAbort = () => void this.bridge.ipc.invoke('fs_copy_cancel', { copyId }).catch(() => undefined);
    signal?.addEventListener('abort', onAbort);
    try {
      await this.bridge.call('fs', 'fs_copy', { from: source.path, to, copyId });
    } catch (e) {
      if (signal?.aborted) throw abortReason(signal);
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      unlisten?.();
    }
  }
}
