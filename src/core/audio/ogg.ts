/**
 * Ogg demuxer (Opus, Vorbis and FLAC in Ogg) for the WebCodecs path. Pages
 * are read in order and split into packets of the first audio stream; the
 * header packets become the WebCodecs description. The real length comes
 * from the granule position of the last page (one read at the file end).
 * A chained file, where whole streams follow one another (as
 * `cat a.opus b.opus` makes it), goes to the browser's own decoder.
 */
import type { ByteSource } from '../../platform/types';
import { chaptersFromVorbisComments, parseVorbisComments, type EncodedAudioInfo, type EncodedPacket, type PacketReader } from './demux';
import { AudioError, checkAborted } from './errors';
import { readRange, WindowReader } from './source';

interface OggPage {
  offset: number;
  flags: number;
  /** Granule position; -1 when no packet ends on this page. */
  granule: number;
  serial: number;
  /** Lacing values. */
  segments: Uint8Array;
  /** Offset of the page payload. */
  body: number;
  end: number;
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function granuleAt(b: Uint8Array, o: number): number {
  const lo = u32le(b, o);
  const hi = u32le(b, o + 4);
  if (hi === 0xffffffff && lo === 0xffffffff) return -1;
  return hi * 2 ** 32 + lo;
}

function isCapture(b: Uint8Array, i: number): boolean {
  return b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53 && b[i + 4] === 0;
}

/** Parses the page header at `i` of `b` (file offset `fileOffset`); null when it is not a page. */
function pageAt(b: Uint8Array, i: number, fileOffset: number): OggPage | null {
  if (i + 27 > b.length || !isCapture(b, i)) return null;
  const n = b[i + 26];
  if (i + 27 + n > b.length) return null;
  const segments = b.subarray(i + 27, i + 27 + n);
  let size = 0;
  for (let k = 0; k < n; k++) size += segments[k];
  const body = fileOffset + 27 + n;
  return { offset: fileOffset, flags: b[i + 5], granule: granuleAt(b, i + 6), serial: u32le(b, i + 14), segments, body, end: body + size };
}

/** Where a walk through the pages stands. */
interface PageCursor {
  reader: WindowReader;
  /** Offset of the next page. */
  pos: number;
}

/** Reads the page at the cursor (any stream) and moves past it; null at the end. */
async function readPage(c: PageCursor, signal?: AbortSignal): Promise<OggPage | null> {
  const r = c.reader;
  for (;;) {
    checkAborted(signal);
    if (c.pos + 27 > r.end) return null;
    await r.ensure(c.pos, 27 + 255 + 65025);
    const i = c.pos - r.base;
    const page = pageAt(r.buf, i, c.pos);
    if (page && page.end <= r.end) {
      await r.ensure(c.pos, page.end - c.pos);
      c.pos = page.end;
      return page;
    }
    // Lost sync: search the next capture pattern.
    let k = i + 1;
    const lim = r.buf.length - 5;
    while (k < lim && !isCapture(r.buf, k)) k++;
    if (k >= lim && r.limit >= r.end) return null;
    c.pos = r.base + k;
  }
}

/** Xiph lacing of the three Vorbis headers, the description WebCodecs expects for 'vorbis'. */
export function xiphLacing(headers: readonly Uint8Array[]): Uint8Array {
  const lace: number[] = [headers.length - 1];
  for (let h = 0; h < headers.length - 1; h++) {
    let len = headers[h].length;
    while (len >= 255) {
      lace.push(255);
      len -= 255;
    }
    lace.push(len);
  }
  const total = lace.length + headers.reduce((n, h) => n + h.length, 0);
  const out = new Uint8Array(total);
  out.set(lace, 0);
  let o = lace.length;
  for (const h of headers) {
    out.set(h, o);
    o += h.length;
  }
  return out;
}

/** Duration of an Opus packet in 48 kHz samples (RFC 6716, section 3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frame: number;
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) frame = [480, 960][config & 1];
  else frame = [120, 240, 480, 960][config & 3];
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet.length > 1 ? packet[1] & 0x3f : 0) : 2;
  return frame * frames;
}

type OggCodec = 'opus' | 'vorbis' | 'flac';

function codecOf(packet: Uint8Array): OggCodec | null {
  const s = String.fromCharCode(...packet.subarray(0, 8));
  if (s === 'OpusHead') return 'opus';
  if (s.startsWith('\u0001vorbis')) return 'vorbis';
  if (s.startsWith('\u007fFLAC')) return 'flac';
  return null;
}

/** Rate of the granule positions and the samples to skip at the start, from the first header packet of a stream. */
function clockOf(codec: OggCodec, id: Uint8Array): { rate: number; preSkip: number } {
  if (codec === 'opus') return { rate: 48000, preSkip: id[10] | (id[11] << 8) };
  if (codec === 'vorbis') return { rate: u32le(id, 12), preSkip: 0 };
  return { rate: (id[27] << 12) | (id[28] << 4) | (id[29] >> 4), preSkip: 0 }; // FLAC: STREAMINFO from byte 17
}

/**
 * Counts the links of a chained file, where whole streams follow one another,
 * and adds up the playing time of the first audio stream of each link. Reads
 * every page once.
 */
async function chainOf(source: ByteSource, signal?: AbortSignal): Promise<{ links: number; durationSec: number }> {
  const c: PageCursor = { reader: new WindowReader(source), pos: 0 };
  const audio: { serial: number; rate: number; preSkip: number; granule: number }[] = [];
  let links = 0;
  let opening = false; // on the first pages of a link, which start its streams
  for (let page = await readPage(c, signal); page; page = await readPage(c, signal)) {
    if (page.flags & 0x02) {
      if (!opening) links++;
      opening = true;
      const r = c.reader;
      const id = r.buf.subarray(page.body - r.base, Math.min(page.end, page.body + 64) - r.base);
      const codec = codecOf(id);
      if (codec && audio.length < links) audio.push({ serial: page.serial, ...clockOf(codec, id), granule: -1 });
    } else opening = false;
    const a = audio[audio.length - 1];
    if (a?.serial === page.serial && page.granule >= 0) a.granule = page.granule;
  }
  let durationSec = 0;
  for (const a of audio) if (a.granule > 0 && a.rate > 0) durationSec += Math.max(0, a.granule - a.preSkip) / a.rate;
  return { links, durationSec };
}

/** Name of an audio codec this reader does not decode, from the first header packet of its stream. */
function otherCodecOf(packet: Uint8Array): string | undefined {
  const s = String.fromCharCode(...packet.subarray(0, 8));
  if (s === 'Speex   ') return 'speex';
  if (s === 'CELT    ') return 'celt';
  if (s === 'PCM     ') return 'pcm';
  return undefined;
}

export class OggPacketReader implements PacketReader {
  private readonly reader: WindowReader;
  private pos = 0;
  private serial = -1;
  private partial: Uint8Array[] = [];
  private queue: Uint8Array[] = [];
  private lastGranule = 0;
  private timeSamples = 0;
  private ended = false;
  info!: EncodedAudioInfo;

  private constructor(
    private readonly source: ByteSource,
    private readonly signal?: AbortSignal,
  ) {
    this.reader = new WindowReader(source);
  }

  static async open(source: ByteSource, signal?: AbortSignal): Promise<OggPacketReader> {
    const r = new OggPacketReader(source, signal);
    await r.init();
    return r;
  }

  /** Reads the next page (any stream); null at the end. */
  private async nextPage(): Promise<OggPage | null> {
    const c: PageCursor = { reader: this.reader, pos: this.pos };
    const page = await readPage(c, this.signal);
    this.pos = c.pos;
    return page;
  }

  /** Splits a page into packets of the chosen stream; completed packets go to the queue. */
  private takePage(page: OggPage): void {
    const r = this.reader;
    if (!(page.flags & 0x01) && this.partial.length) this.partial = []; // a packet was lost
    let o = page.body - r.base;
    let start = o;
    for (let k = 0; k < page.segments.length; k++) {
      const lace = page.segments[k];
      o += lace;
      if (lace < 255) {
        this.partial.push(r.buf.subarray(start, o));
        this.queue.push(this.partial.length === 1 ? this.partial[0] : concat(this.partial));
        this.partial = [];
        start = o;
      }
    }
    if (o > start) this.partial.push(r.buf.slice(start, o));
  }

  private async nextRawPacket(): Promise<Uint8Array | null> {
    while (this.queue.length === 0) {
      const page = await this.nextPage();
      if (!page) return null;
      if (page.serial !== this.serial) continue;
      this.takePage(page);
      if (page.granule >= 0) this.lastGranule = page.granule;
    }
    return this.queue.shift() as Uint8Array;
  }

  private async init(): Promise<void> {
    // Choose the first stream that starts with a known audio header.
    let codec: OggCodec | null = null;
    let other: string | undefined;
    for (let guard = 0; guard < 64 && !codec; guard++) {
      const page = await this.nextPage();
      if (!page || !(page.flags & 0x02)) break;
      const first = this.reader.buf.subarray(page.body - this.reader.base, Math.min(page.end, page.body + 64) - this.reader.base);
      codec = codecOf(first);
      other ??= otherCodecOf(first);
      if (codec) {
        this.serial = page.serial;
        this.takePage(page);
      }
    }
    if (!codec) throw new AudioError('unsupported-format', undefined, { details: { container: 'ogg', codec: other } });
    const id = (await this.nextRawPacket()) as Uint8Array;
    const headers: Uint8Array[] = [id.slice()];
    let comments: string[] = [];
    let info: EncodedAudioInfo;
    const dv = new DataView(id.buffer, id.byteOffset, id.byteLength);
    if (codec === 'opus') {
      if (id.length < 19) throw new AudioError('decode-failed');
      const tags = await this.nextRawPacket();
      if (tags && String.fromCharCode(...tags.subarray(0, 8)) === 'OpusTags') comments = parseVorbisComments(tags, 8);
      info = {
        container: 'ogg',
        codec: 'opus',
        webCodecs: 'opus',
        description: headers[0],
        sampleRate: 48000,
        channels: id[9],
        skipSamples: dv.getUint16(10, true),
        durationSec: 0,
        durationExact: false,
      };
    } else if (codec === 'vorbis') {
      if (id.length < 30) throw new AudioError('decode-failed');
      for (let h = 0; h < 2; h++) {
        const p = await this.nextRawPacket();
        if (!p) throw new AudioError('decode-failed');
        headers.push(p.slice());
      }
      comments = parseVorbisComments(headers[1], 7);
      info = {
        container: 'ogg',
        codec: 'vorbis',
        webCodecs: 'vorbis',
        description: xiphLacing(headers),
        sampleRate: dv.getUint32(12, true),
        channels: id[11],
        skipSamples: 0,
        durationSec: 0,
        durationExact: false,
      };
    } else {
      // 0x7F "FLAC" major minor count(2) "fLaC" STREAMINFO block
      if (id.length < 13 + 38) throw new AudioError('decode-failed');
      const count = (id[7] << 8) | id[8];
      const block = id.slice(13, 13 + 38);
      block[0] |= 0x80; // the only block in the description
      const desc = new Uint8Array(4 + block.length);
      desc.set([0x66, 0x4c, 0x61, 0x43], 0);
      desc.set(block, 4);
      const si = 13 + 4;
      const sampleRate = (id[si + 10] << 12) | (id[si + 11] << 4) | (id[si + 12] >> 4);
      for (let h = 0; h < count || count === 0; h++) {
        const p = this.queue[0] ?? null;
        const next = p ?? (await this.peekPacket());
        if (!next || (next[0] === 0xff && (next[1] & 0xfe) === 0xf8)) break;
        await this.nextRawPacket();
        if ((next[0] & 0x7f) === 4) comments = parseVorbisComments(next, 4);
      }
      const total = (id[si + 13] & 0x0f) * 2 ** 32 + (((id[si + 14] << 24) | (id[si + 15] << 16) | (id[si + 16] << 8) | id[si + 17]) >>> 0);
      info = {
        container: 'ogg',
        codec: 'flac',
        webCodecs: 'flac',
        description: desc,
        sampleRate,
        channels: ((id[si + 12] >> 1) & 7) + 1,
        skipSamples: 0,
        totalSamples: total > 0 ? total : undefined,
        durationSec: total > 0 && sampleRate > 0 ? total / sampleRate : 0,
        durationExact: total > 0,
      };
    }
    if (!(info.sampleRate > 0) || !(info.channels > 0)) throw new AudioError('decode-failed');

    // Real length from the last page of our stream.
    const { granule: last, lastSerial } = await this.tailOf(this.serial);
    if (lastSerial >= 0 && lastSerial !== this.serial) {
      // Another stream ends the file. When it follows ours (a chain), this reader would play the first stream only.
      const chain = await chainOf(this.source, this.signal);
      if (chain.links > 1) {
        throw new AudioError('unsupported-format', undefined, { details: { container: 'ogg', codec, durationSec: chain.durationSec > 0 ? chain.durationSec : undefined, fallback: true } });
      }
    }
    if (last > 0 && info.totalSamples === undefined) {
      info.totalSamples = Math.max(0, last - info.skipSamples);
      info.durationSec = info.totalSamples / info.sampleRate;
      info.durationExact = true;
    }
    if (info.durationSec > 0) info.bitrateKbps = Math.round((this.source.size * 8) / info.durationSec / 1000);
    const chapters = chaptersFromVorbisComments(comments);
    if (chapters.length > 0) info.chapters = chapters;
    this.info = info;
    this.timeSamples = 0;
  }

  private async peekPacket(): Promise<Uint8Array | null> {
    const p = await this.nextRawPacket();
    if (p) this.queue.unshift(p);
    return p;
  }

  /** The granule position of the last page of `serial` (-1 when none is found) and the serial of the file's last page. */
  private async tailOf(serial: number): Promise<{ granule: number; lastSerial: number }> {
    let lastSerial = -1;
    for (const span of [64 * 1024, 1024 * 1024]) {
      const start = Math.max(0, this.source.size - span);
      const tail = await readRange(this.source, start, this.source.size - start);
      for (let i = tail.length - 27; i >= 0; i--) {
        if (!isCapture(tail, i)) continue;
        const page = pageAt(tail, i, start + i);
        if (!page) continue;
        if (lastSerial < 0) lastSerial = page.serial;
        if (page.serial === serial && page.granule >= 0) return { granule: page.granule, lastSerial };
      }
      if (start === 0) break;
    }
    return { granule: -1, lastSerial };
  }

  async next(): Promise<EncodedPacket | null> {
    if (this.ended) return null;
    const p = await this.nextRawPacket();
    if (!p) {
      this.ended = true;
      return null;
    }
    const rate = this.info.sampleRate;
    const samples = this.info.codec === 'opus' ? opusPacketSamples(p) : 0;
    const packet: EncodedPacket = {
      data: p,
      timestampUs: Math.round((this.timeSamples * 1e6) / rate),
      durationUs: samples ? Math.round((samples * 1e6) / rate) : undefined,
    };
    this.timeSamples = samples ? this.timeSamples + samples : this.lastGranule;
    return packet;
  }

  progress(): number {
    return Math.min(1, this.pos / Math.max(1, this.source.size));
  }

  async close(): Promise<void> {
    this.ended = true;
    this.queue = [];
    this.partial = [];
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
