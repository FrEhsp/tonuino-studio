import { AbstractTokenizer, EndOfStreamError, type IFileInfo, type IReadChunkOptions } from 'strtok3';
import type { ByteSource } from '../../platform/types';

/**
 * Lets music-metadata read any ByteSource (browser File, file on the SD card,
 * file on disk via the desktop app) with random access. Reads are served from
 * a small block cache, because the desktop app answers every read with a
 * round trip.
 */
export class ByteSourceTokenizer extends AbstractTokenizer {
  fileInfo: IFileInfo;
  private cache = new Map<number, Promise<Uint8Array>>();
  private static readonly BLOCK = 64 * 1024;
  private static readonly MAX_BLOCKS = 32;

  constructor(
    private readonly source: ByteSource,
    mimeType?: string,
  ) {
    super();
    this.fileInfo = { size: source.size, path: source.name, mimeType };
  }

  supportsRandomAccess(): boolean {
    return true;
  }

  setPosition(position: number): void {
    this.position = position;
  }

  async readBuffer(buffer: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    if (options?.position) this.position = options.position;
    const n = await this.peekBuffer(buffer, options);
    this.position += n;
    return n;
  }

  async peekBuffer(buffer: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const o = this.normalizeOptions(buffer, options);
    const available = Math.max(0, Math.min(this.source.size - o.position, o.length));
    if (!o.mayBeLess && available < o.length) throw new EndOfStreamError();
    let written = 0;
    while (written < available) {
      const pos = o.position + written;
      const blockIndex = Math.floor(pos / ByteSourceTokenizer.BLOCK);
      const block = await this.block(blockIndex);
      const offset = pos - blockIndex * ByteSourceTokenizer.BLOCK;
      const take = Math.min(block.length - offset, available - written);
      if (take <= 0) break;
      buffer.set(block.subarray(offset, offset + take), written);
      written += take;
    }
    return written;
  }

  private block(index: number): Promise<Uint8Array> {
    let p = this.cache.get(index);
    if (!p) {
      const start = index * ByteSourceTokenizer.BLOCK;
      p = this.source.read(start, Math.min(ByteSourceTokenizer.BLOCK, this.source.size - start));
      this.cache.set(index, p);
      if (this.cache.size > ByteSourceTokenizer.MAX_BLOCKS) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }
}
