/**
 * Synthetic container files for the demuxer tests, and a fake WebCodecs API.
 *
 * Node has no AAC/Opus decoder, so the "encoded" packets here simply hold
 * 16-bit little-endian PCM (interleaved); the fake decoder turns them back
 * into float PCM. FLAC fixtures are real FLAC (verbatim subframes) and the
 * fake decodes them for real, which checks the frame boundaries exactly.
 */
import { crc16 } from '../../src/core/audio/bits';
import { crc8, parseFlacFrameHeader } from '../../src/core/audio/flac';
import type { AudioDataLike, AudioDecoderLike, WebCodecsApi } from '../../src/core/audio/webcodecs';
import { concat, sine } from './helpers';

const te = new TextEncoder();

/* ------------------------------------------------------------ byte helpers */

export function be16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

export function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function be64(n: number): number[] {
  return [...be32(Math.floor(n / 2 ** 32)), ...be32(n >>> 0)];
}

function le16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}

function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function bytes(...parts: (number[] | Uint8Array | string)[]): Uint8Array {
  return concat(parts.map((p) => (typeof p === 'string' ? te.encode(p) : Uint8Array.from(p))));
}

/** Interleaved 16-bit little-endian PCM of `frames` frames starting at `start`. */
export function pcmPacket(signal: Float32Array[], start: number, frames: number): Uint8Array {
  const ch = signal.length;
  const out = new Uint8Array(frames * ch * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const x = signal[c][start + i] ?? 0;
      v.setInt16((i * ch + c) * 2, Math.max(-32768, Math.min(32767, Math.round(x * 32767))), true);
    }
  }
  return out;
}

/** Splits a signal into PCM packets of `frames` frames. */
export function pcmPackets(signal: Float32Array[], frames: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let s = 0; s < signal[0].length; s += frames) out.push(pcmPacket(signal, s, Math.min(frames, signal[0].length - s)));
  return out;
}

/** A recognisable test signal: a slow ramp, so every sample value tells its position. */
export function ramp(n: number, channels = 1, scale = 0.5): Float32Array[] {
  return Array.from({ length: channels }, (_, c) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (((i * 37 + c * 1000) % 20000) / 20000 - 0.5) * scale;
    return x;
  });
}

/* ------------------------------------------------------------ MP4 */

export function box(type: string, ...payload: (number[] | Uint8Array | string)[]): Uint8Array {
  const body = bytes(...payload);
  return bytes(be32(body.length + 8), type, body);
}

function fullBox(type: string, version: number, flags: number, ...payload: (number[] | Uint8Array | string)[]): Uint8Array {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...payload);
}

function descriptor(tag: number, body: Uint8Array): Uint8Array {
  return bytes([tag, 0x80, 0x80, 0x80, body.length], body);
}

export function esds(asc: Uint8Array, objectType = 0x40): Uint8Array {
  const dsi = descriptor(0x05, asc);
  const dcd = descriptor(0x04, bytes([objectType, 0x15, 0, 0, 0], be32(128000), be32(96000), dsi));
  const es = descriptor(0x03, bytes(be16(1), [0], dcd, descriptor(0x06, Uint8Array.from([2]))));
  return fullBox('esds', 0, 0, es);
}

export interface Mp4Spec {
  sampleRate: number;
  channels: number;
  /** Audio sample payloads. */
  packets: Uint8Array[];
  /** Duration of every packet in samples (the last one may be given separately). */
  frameSamples: number;
  lastFrameSamples?: number;
  /** Edit list: priming (media time) and real length in samples. */
  edit?: { mediaTime: number; duration: number };
  smpb?: { priming: number; padding: number; total: number };
  /** QuickTime chapter track. */
  chapters?: { startSec: number; title: string }[];
  nero?: { startSec: number; title: string }[];
  moovFirst?: boolean;
  /** Write the samples as movie fragments (moof/mdat pairs of this many samples). */
  fragmentSamples?: number;
  samplesPerChunk?: number;
  entryType?: string;
  /** Sample entry children (default: esds with AAC-LC ASC). */
  entryChildren?: Uint8Array[];
  brand?: string;
  co64?: boolean;
}

/** AudioSpecificConfig for AAC-LC. */
export function ascFor(sampleRate: number, channels: number, objectType = 2): Uint8Array {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const i = rates.indexOf(sampleRate);
  return Uint8Array.from([(objectType << 3) | (i >> 1), ((i & 1) << 7) | (channels << 3)]);
}

function audioEntry(spec: Mp4Spec): Uint8Array {
  const children = spec.entryChildren ?? [esds(ascFor(spec.sampleRate, spec.channels))];
  return box(spec.entryType ?? 'mp4a', [0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0, 0], be16(spec.channels), be16(16), [0, 0, 0, 0], be32(spec.sampleRate * 65536), ...children);
}

function tkhd(id: number): Uint8Array {
  return fullBox('tkhd', 0, 3, be32(0), be32(0), be32(id), be32(0), be32(0), new Uint8Array(8), [0, 0, 0, 0, 1, 0, 0, 0], new Uint8Array(36), be32(0), be32(0));
}

function mdhd(timescale: number, duration: number): Uint8Array {
  return fullBox('mdhd', 0, 0, be32(0), be32(0), be32(timescale), be32(duration), [0x55, 0xc4, 0, 0]);
}

function hdlr(type: string): Uint8Array {
  return fullBox('hdlr', 0, 0, be32(0), type, new Uint8Array(12), 'handler\0');
}

function stbl(entry: Uint8Array, stts: [number, number][], sizes: number[], chunks: { offset: number; count: number }[], co64 = false): Uint8Array {
  const stsc: number[] = [];
  let prev = -1;
  chunks.forEach((c, i) => {
    if (c.count !== prev) stsc.push(...be32(i + 1), ...be32(c.count), ...be32(1));
    prev = c.count;
  });
  return box(
    'stbl',
    fullBox('stsd', 0, 0, be32(1), entry),
    fullBox('stts', 0, 0, be32(stts.length), ...stts.map(([n, d]) => [...be32(n), ...be32(d)])),
    fullBox('stsz', 0, 0, be32(0), be32(sizes.length), ...sizes.map(be32)),
    fullBox('stsc', 0, 0, be32(stsc.length / 12), stsc),
    co64 ? fullBox('co64', 0, 0, be32(chunks.length), ...chunks.map((c) => be64(c.offset))) : fullBox('stco', 0, 0, be32(chunks.length), ...chunks.map((c) => be32(c.offset))),
  );
}

function ilstSmpb(s: { priming: number; padding: number; total: number }): Uint8Array {
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');
  const value = ` 00000000 ${hex(s.priming, 8)} ${hex(s.padding, 8)} ${hex(s.total, 16)} 00000000 00000000`;
  const item = box('----', fullBox('mean', 0, 0, 'com.apple.iTunes'), fullBox('name', 0, 0, 'iTunSMPB'), box('data', be32(1), be32(0), value));
  return fullBox('meta', 0, 0, fullBox('hdlr', 0, 0, be32(0), 'mdir', 'appl', new Uint8Array(9)), box('ilst', item));
}

function chpl(list: { startSec: number; title: string }[]): Uint8Array {
  const entries = list.map((c) => {
    const t = te.encode(c.title);
    return bytes(be64(Math.round(c.startSec * 1e7)), [t.length], t);
  });
  return fullBox('chpl', 1, 0, be32(0), [list.length], ...entries);
}

/** Builds an M4A/M4B file. */
export function buildMp4(spec: Mp4Spec): Uint8Array {
  const sr = spec.sampleRate;
  const n = spec.packets.length;
  const durations = spec.packets.map((_, i) => (i === n - 1 && spec.lastFrameSamples !== undefined ? spec.lastFrameSamples : spec.frameSamples));
  const mediaDuration = durations.reduce((a, b) => a + b, 0);
  const stts: [number, number][] = [];
  for (const d of durations) {
    const last = stts[stts.length - 1];
    if (last && last[1] === d) last[0]++;
    else stts.push([1, d]);
  }
  const chapterSamples = (spec.chapters ?? []).map((c) => {
    const t = te.encode(c.title);
    return bytes(be16(t.length), t, box('encd', be32(0x100)));
  });
  const ftyp = box('ftyp', spec.brand ?? 'M4B ', be32(0), 'M4B mp42isom');

  const build = (mdatStart: number): { moov: Uint8Array; mdat: Uint8Array; tail: Uint8Array } => {
    const dataStart = mdatStart + 8;
    const audioChunks: { offset: number; count: number }[] = [];
    const spc = spec.samplesPerChunk ?? 7;
    let pos = dataStart;
    if (!spec.fragmentSamples) {
      for (let i = 0; i < n; i += spc) {
        const count = Math.min(spc, n - i);
        audioChunks.push({ offset: pos, count });
        for (let k = 0; k < count; k++) pos += spec.packets[i + k].length;
      }
    }
    const chapterChunks = chapterSamples.map((s) => {
      const c = { offset: pos, count: 1 };
      pos += s.length;
      return c;
    });
    const trak1Children: Uint8Array[] = [tkhd(1)];
    if (spec.edit) trak1Children.push(box('edts', fullBox('elst', 0, 0, be32(1), be32(spec.edit.duration), be32(spec.edit.mediaTime), be32(0x10000))));
    if (spec.chapters) trak1Children.push(box('tref', box('chap', be32(2))));
    const fragmented = !!spec.fragmentSamples;
    trak1Children.push(
      box(
        'mdia',
        mdhd(sr, fragmented ? 0 : mediaDuration),
        hdlr('soun'),
        box('minf', fullBox('smhd', 0, 0, be32(0)), fragmented ? stbl(audioEntry(spec), [], [], []) : stbl(audioEntry(spec), stts, spec.packets.map((p) => p.length), audioChunks, spec.co64)),
      ),
    );
    const moovChildren: Uint8Array[] = [fullBox('mvhd', 0, 0, be32(0), be32(0), be32(sr), be32(fragmented ? 0 : mediaDuration), be32(0x10000), [1, 0], new Uint8Array(10), new Uint8Array(36), new Uint8Array(24), be32(3)), box('trak', ...trak1Children)];
    if (spec.chapters) {
      const total = spec.edit?.duration ?? mediaDuration;
      const ms = spec.chapters.map((c) => Math.round(c.startSec * 1000));
      const deltas = ms.map((m, i) => (i + 1 < ms.length ? ms[i + 1] : Math.round((total / sr) * 1000)) - m);
      const textEntry = box('text', new Uint8Array(6), be16(1), new Uint8Array(51));
      moovChildren.push(
        box(
          'trak',
          tkhd(2),
          box('mdia', mdhd(1000, deltas.reduce((a, b) => a + b, 0)), hdlr('text'), box('minf', box('gmhd'), stbl(textEntry, deltas.map((d) => [1, d] as [number, number]), chapterSamples.map((s) => s.length), chapterChunks))),
        ),
      );
    }
    if (fragmented) moovChildren.push(box('mvex', fullBox('mehd', 0, 0, be32(mediaDuration)), fullBox('trex', 0, 0, be32(1), be32(1), be32(spec.frameSamples), be32(0), be32(0))));
    const udta: Uint8Array[] = [];
    if (spec.nero) udta.push(chpl(spec.nero));
    if (spec.smpb) udta.push(ilstSmpb(spec.smpb));
    if (udta.length) moovChildren.push(box('udta', ...udta));
    const moov = box('moov', ...moovChildren);
    const mdat = box('mdat', ...(fragmented ? [] : spec.packets), ...chapterSamples);
    // Fragments follow the index.
    const tail: Uint8Array[] = [];
    if (fragmented) {
      const per = spec.fragmentSamples as number;
      for (let i = 0, seq = 1; i < n; i += per, seq++) {
        const group = spec.packets.slice(i, i + per);
        const trunFor = (dataOffset: number) =>
          fullBox('trun', 0, 0x000001 | 0x000100 | 0x000200, be32(group.length), be32(dataOffset), ...group.map((p, k) => [...be32(durations[i + k]), ...be32(p.length)]));
        const moofFor = (dataOffset: number) =>
          box('moof', fullBox('mfhd', 0, 0, be32(seq)), box('traf', fullBox('tfhd', 0, 0x020000, be32(1)), fullBox('tfdt', 1, 0, be64(i * spec.frameSamples)), trunFor(dataOffset)));
        const size = moofFor(0).length;
        tail.push(moofFor(size + 8), box('mdat', ...group));
      }
    }
    return { moov, mdat, tail: concat(tail) };
  };

  if (spec.moovFirst || spec.fragmentSamples) {
    const probe = build(0);
    const real = build(ftyp.length + probe.moov.length);
    return concat([ftyp, real.moov, real.mdat, real.tail]);
  }
  const real = build(ftyp.length);
  return concat([ftyp, real.mdat, real.moov]);
}

/* ------------------------------------------------------------ Ogg */

/** Muxes packets into Ogg pages (granule = position after each packet, -1 = none). */
export function buildOgg(packets: { data: Uint8Array; granule: number }[], opts: { serial?: number; maxSegments?: number; headerCount?: number } = {}): Uint8Array {
  const serial = opts.serial ?? 0x1234;
  const maxSeg = opts.maxSegments ?? 255;
  const pages: Uint8Array[] = [];
  let seq = 0;
  let segs: number[] = [];
  let body: Uint8Array[] = [];
  let granule = -1;
  let continued = false;
  let first = true;
  const flush = (nextContinued: boolean) => {
    if (segs.length === 0) return;
    const flags = (continued ? 1 : 0) | (first ? 2 : 0);
    const g = granule < 0 ? [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : [...le32(granule >>> 0), ...le32(Math.floor(granule / 2 ** 32))];
    pages.push(bytes('OggS', [0, flags], g, le32(serial), le32(seq++), le32(0), [segs.length], segs, concat(body)));
    first = false;
    segs = [];
    body = [];
    granule = -1;
    continued = nextContinued;
  };
  packets.forEach((p, idx) => {
    const lace: number[] = [];
    let left = p.data.length;
    while (left >= 255) {
      lace.push(255);
      left -= 255;
    }
    lace.push(left);
    let off = 0;
    for (let k = 0; k < lace.length; k++) {
      if (segs.length === maxSeg) flush(k > 0);
      segs.push(lace[k]);
      body.push(p.data.subarray(off, off + lace[k]));
      off += lace[k];
    }
    granule = p.granule;
    if (idx < (opts.headerCount ?? 0)) flush(false); // header packets end their page
  });
  flush(false);
  return concat(pages);
}

export function vorbisComment(vendor: string, comments: string[]): Uint8Array {
  const v = te.encode(vendor);
  return bytes(le32(v.length), v, le32(comments.length), ...comments.map((c) => bytes(le32(te.encode(c).length), c)));
}

export function opusHead(channels: number, preSkip: number): Uint8Array {
  return bytes('OpusHead', [1, channels], le16(preSkip), le32(44100), le16(0), [0]);
}

/**
 * An Opus file: a mono ramp of `sec` seconds, pre-skip 312, as one stream of
 * a chain. `lastGranule` lets a few packets tell a long playing time.
 */
export function opusFile(serial: number, sec: number, lastGranule?: number): Uint8Array {
  const pk = pcmPackets(ramp(48000 * sec, 1), 960);
  return buildOgg(
    [
      { data: opusHead(1, 312), granule: 0 },
      { data: bytes('OpusTags', vorbisComment('x', [])), granule: 0 },
      ...pk.map((data, i) => ({ data, granule: i === pk.length - 1 && lastGranule !== undefined ? lastGranule : (i + 1) * 960 })),
    ],
    { serial, headerCount: 2 },
  );
}

/** Splits an Ogg file into its pages. */
export function oggPages(file: Uint8Array): Uint8Array[] {
  const pages: Uint8Array[] = [];
  for (let o = 0; o + 27 <= file.length; ) {
    const n = file[o + 26];
    let size = 27 + n;
    for (let k = 0; k < n; k++) size += file[o + 27 + k];
    pages.push(file.subarray(o, o + size));
    o += size;
  }
  return pages;
}

export function vorbisHeaders(channels: number, sampleRate: number, comments: string[]): Uint8Array[] {
  return [
    bytes([1], 'vorbis', le32(0), [channels], le32(sampleRate), le32(0), le32(128000), le32(0), [0xb8, 1]),
    bytes([3], 'vorbis', vorbisComment('test', comments), [1]),
    bytes([5], 'vorbis', new Uint8Array(300).fill(7)),
  ];
}

/* ------------------------------------------------------------ FLAC */

function utf8Number(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x800) return [0xc0 | (n >> 6), 0x80 | (n & 0x3f)];
  return [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
}

/** One FLAC frame with verbatim 16-bit subframes at 44.1 kHz. */
export function flacFrame(frameNumber: number, block: Int16Array[]): Uint8Array {
  const n = block[0].length;
  const head = [0xff, 0xf8, (7 << 4) | 9, ((block.length - 1) << 4) | (4 << 1), ...utf8Number(frameNumber), ...be16(n - 1)];
  const h = Uint8Array.from(head);
  const parts: number[] = [...head, crc8(h, 0, h.length)];
  for (const ch of block) {
    parts.push(0x02); // verbatim, no wasted bits
    for (let i = 0; i < n; i++) parts.push((ch[i] >> 8) & 0xff, ch[i] & 0xff);
  }
  const frame = Uint8Array.from(parts);
  const crc = crc16(frame, 0, frame.length, 0);
  return bytes(frame, be16(crc));
}

export function int16Channels(signal: Float32Array[]): Int16Array[] {
  return signal.map((x) => Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)))));
}

export function streamInfo(sampleRate: number, channels: number, totalSamples: number, blockSize: number): Uint8Array {
  const b = new Uint8Array(34);
  b.set(be16(blockSize), 0);
  b.set(be16(blockSize), 2);
  b[10] = (sampleRate >> 12) & 0xff;
  b[11] = (sampleRate >> 4) & 0xff;
  b[12] = ((sampleRate & 0xf) << 4) | ((channels - 1) << 1) | 0; // bps-1 = 15: top bit 0
  b[13] = (15 << 4) | Math.floor(totalSamples / 2 ** 32);
  b.set(be32(totalSamples >>> 0), 14);
  return b;
}

export function metadataBlock(type: number, body: Uint8Array, last: boolean): Uint8Array {
  return bytes([(last ? 0x80 : 0) | type, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff], body);
}

export function flacFrames(signal: Float32Array[], blockSize: number): Uint8Array[] {
  const pcm = int16Channels(signal);
  const frames: Uint8Array[] = [];
  for (let s = 0, k = 0; s < pcm[0].length; s += blockSize, k++) frames.push(flacFrame(k, pcm.map((c) => c.subarray(s, s + blockSize))));
  return frames;
}

/** A native FLAC file (44.1 kHz, 16 bit). */
export function buildFlac(signal: Float32Array[], opts: { blockSize?: number; comments?: string[]; cueTrackStarts?: number[]; id3?: Uint8Array } = {}): Uint8Array {
  const blockSize = opts.blockSize ?? 4096;
  const blocks: Uint8Array[] = [streamInfo(44100, signal.length, signal[0].length, blockSize)];
  const types = [0];
  if (opts.comments) {
    blocks.push(vorbisComment('test', opts.comments));
    types.push(4);
  }
  if (opts.cueTrackStarts) {
    const tracks = [...opts.cueTrackStarts.map((s, i) => ({ offset: s, number: i + 1 })), { offset: signal[0].length, number: 170 }];
    const body = bytes(
      new Uint8Array(128),
      be64(88200),
      [0x80],
      new Uint8Array(258),
      [tracks.length],
      ...tracks.map((t) => bytes(be64(t.offset), [t.number], new Uint8Array(12), [0], new Uint8Array(13), [t.number === 170 ? 0 : 1], t.number === 170 ? [] : bytes(be64(0), [1], [0, 0, 0]))),
    );
    blocks.push(body);
    types.push(5);
  }
  const meta = blocks.map((b, i) => metadataBlock(types[i], b, i === blocks.length - 1));
  return concat([opts.id3 ?? new Uint8Array(0), te.encode('fLaC'), ...meta, ...flacFrames(signal, blockSize)]);
}

/* ------------------------------------------------------------ ADTS and AIFF */

export function adtsFrame(payload: Uint8Array, sampleRateIndex: number, channels: number): Uint8Array {
  const len = payload.length + 7;
  return bytes([0xff, 0xf1, (1 << 6) | (sampleRateIndex << 2) | (channels >> 2), ((channels & 3) << 6) | (len >> 11), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc], payload);
}

function extended80(rate: number): number[] {
  let exp = 16383 + 63;
  let m = rate;
  while (m < 2 ** 63) {
    m *= 2;
    exp--;
  }
  const hi = Math.floor(m / 2 ** 32);
  const lo = m - hi * 2 ** 32;
  return [...be16(exp), ...be32(hi), ...be32(lo)];
}

/** AIFF (big endian) or AIFF-C 'sowt' (little endian) file with integer PCM. */
export function buildAiff(signal: Float32Array[], sampleRate: number, opts: { bits?: 16 | 24; sowt?: boolean } = {}): Uint8Array {
  const bits = opts.bits ?? 16;
  const ch = signal.length;
  const n = signal[0].length;
  const data = new Uint8Array(n * ch * (bits / 8));
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const full = bits === 16 ? 32767 : 8388607;
      const v = Math.max(-full - 1, Math.min(full, Math.round(signal[c][i] * full)));
      const bs = bits === 16 ? [(v >> 8) & 0xff, v & 0xff] : [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
      if (opts.sowt) bs.reverse();
      data.set(bs, o);
      o += bs.length;
    }
  }
  const comm = opts.sowt
    ? bytes('COMM', be32(24), be16(ch), be32(n), be16(bits), extended80(sampleRate), 'sowt', [0, 0])
    : bytes('COMM', be32(18), be16(ch), be32(n), be16(bits), extended80(sampleRate));
  const ssnd = bytes('SSND', be32(data.length + 8), be32(0), be32(0), data);
  const body = bytes(opts.sowt ? 'AIFC' : 'AIFF', opts.sowt ? bytes('FVER', be32(4), be32(0xa2805140)) : [], comm, ssnd);
  return bytes('FORM', be32(body.length), body);
}

/* ------------------------------------------------------------ WebM */

/** One EBML element: `id` as written (with its length marker), an 8-byte size or "unknown". */
export function ebml(id: number[], body: number[] | Uint8Array | string, unknownSize = false): Uint8Array {
  const data = bytes(body);
  const size = [0x01];
  for (let i = 6; i >= 0; i--) size.push(unknownSize ? 0xff : Math.floor(data.length / 2 ** (8 * i)) & 0xff);
  return bytes(id, size, data);
}

function float64(x: number): number[] {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return [...new Uint8Array(v.buffer)];
}

export interface WebmSpec {
  /** Default "A_OPUS". */
  codecId?: string;
  /** Nanoseconds per timecode unit (default 1 ms). */
  timecodeScale?: number;
  /** Info Duration in timecode units; MediaRecorder leaves it out. */
  duration?: number;
  /** Clusters with their timecode and the relative timecodes of their blocks. */
  clusters?: { timecode: number; blocks: number[] }[];
  /** Segment and clusters of unknown size, as live recordings write them. */
  live?: boolean;
}

/** A WebM file with one audio track; the blocks carry filler bytes, not real audio. */
export function buildWebm(spec: WebmSpec = {}): Uint8Array {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], bytes(ebml([0x42, 0x82], 'webm'), ebml([0x42, 0x87], [4]), ebml([0x42, 0x85], [2])));
  const info = ebml(
    [0x15, 0x49, 0xa9, 0x66],
    bytes(ebml([0x2a, 0xd7, 0xb1], be32(spec.timecodeScale ?? 1_000_000)), ...(spec.duration !== undefined ? [ebml([0x44, 0x89], float64(spec.duration))] : [])),
  );
  const audio = ebml([0xe1], bytes(ebml([0xb5], float64(48000)), ebml([0x9f], [2])));
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], ebml([0xae], bytes(ebml([0xd7], [1]), ebml([0x83], [2]), ebml([0x86], spec.codecId ?? 'A_OPUS'), audio)));
  const clusters = (spec.clusters ?? []).map((c) =>
    ebml([0x1f, 0x43, 0xb6, 0x75], bytes(ebml([0xe7], be32(c.timecode)), ...c.blocks.map((t) => ebml([0xa3], bytes([0x81], be16(t & 0xffff), [0x80], new Uint8Array(60).fill(0x55))))), spec.live),
  );
  return bytes(header, ebml([0x18, 0x53, 0x80, 0x67], bytes(info, tracks, ...clusters), spec.live));
}

/** Clusters every 5 s up to `sec` seconds, with a block every second, as a recorder makes them. */
export function webmClusters(sec: number): { timecode: number; blocks: number[] }[] {
  const out: { timecode: number; blocks: number[] }[] = [];
  for (let t = 0; t < sec; t += 5) out.push({ timecode: t * 1000, blocks: Array.from({ length: Math.min(5, sec - t) }, (_, i) => i * 1000) });
  return out;
}

/* ------------------------------------------------------------ fake WebCodecs */

export interface FakeCodecOptions {
  /** Codec strings isConfigSupported accepts (default: all). */
  supported?: string[];
  /** Output rate = configured rate × this (like HE-AAC). */
  rateFactor?: number;
  /** Decode error after this many packets. */
  failAfter?: number;
}

interface FakeChunk {
  data: Uint8Array;
  timestamp: number;
}

/** Decodes a verbatim-only FLAC frame (checks its CRC-16, so boundaries must be exact). */
function decodeFlacFrame(frame: Uint8Array, channels: number): Float32Array[] {
  const crc = crc16(frame, 0, frame.length - 2, 0);
  if (crc !== ((frame[frame.length - 2] << 8) | frame[frame.length - 1])) throw new Error('FLAC frame CRC mismatch');
  const h = parseFlacFrameHeader(frame, 0);
  if (!h) throw new Error('bad FLAC header');
  let p = h.headerLength;
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    if (frame[p++] !== 0x02) throw new Error('not verbatim');
    const x = new Float32Array(h.blockSize);
    for (let i = 0; i < h.blockSize; i++, p += 2) x[i] = (((frame[p] << 8) | frame[p + 1]) << 16 >> 16) / 32767;
    out.push(x);
  }
  return out;
}

export function fakeWebCodecs(opts: FakeCodecOptions = {}): WebCodecsApi & { decoders: number; closed: number } {
  const api = {
    decoders: 0,
    closed: 0,
    async isConfigSupported(config: AudioDecoderConfig) {
      return !opts.supported || opts.supported.includes(config.codec);
    },
    createChunk(init: { type: 'key'; timestamp: number; duration?: number; data: Uint8Array }) {
      return { data: init.data.slice(), timestamp: init.timestamp } as unknown as EncodedAudioChunk;
    },
    createDecoder(output: (d: AudioDataLike) => void, error: (e: unknown) => void): AudioDecoderLike {
      api.decoders++;
      let config: AudioDecoderConfig | null = null;
      let queue: FakeChunk[] = [];
      let count = 0;
      let state: 'configured' | 'closed' = 'configured';
      const dequeueListeners: (() => void)[] = [];
      let pump: Promise<void> = Promise.resolve();
      const decodeOne = (chunk: FakeChunk) => {
        if (!config || state === 'closed') return;
        count++;
        if (opts.failAfter !== undefined && count > opts.failAfter) {
          state = 'closed';
          error(new Error('fake decode error'));
          return;
        }
        const ch = config.numberOfChannels;
        let planes: Float32Array[];
        if (config.codec === 'flac') planes = decodeFlacFrame(chunk.data, ch);
        else {
          const n = chunk.data.length / (2 * ch);
          const v = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
          planes = Array.from({ length: ch }, (_, c) => Float32Array.from({ length: n }, (_, i) => v.getInt16((i * ch + c) * 2, true) / 32767));
        }
        const factor = opts.rateFactor ?? 1;
        if (factor !== 1) planes = planes.map((p) => Float32Array.from({ length: p.length * factor }, (_, i) => p[Math.floor(i / factor)]));
        const rate = config.codec === 'opus' ? 48000 : config.sampleRate * factor;
        output({
          numberOfFrames: planes[0].length,
          numberOfChannels: planes.length,
          sampleRate: rate,
          copyTo(dest: Float32Array, o: AudioDataCopyToOptions) {
            dest.set(planes[o.planeIndex]);
          },
          close() {},
        });
      };
      const schedule = () => {
        pump = pump.then(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                const chunk = queue.shift();
                if (chunk) {
                  try {
                    decodeOne(chunk);
                  } catch (e) {
                    state = 'closed';
                    error(e);
                  }
                  for (const l of dequeueListeners) l();
                }
                resolve();
              }, 0);
            }),
        );
      };
      return {
        get decodeQueueSize() {
          return queue.length;
        },
        configure(c: AudioDecoderConfig) {
          config = c;
        },
        decode(chunk: EncodedAudioChunk) {
          if (state === 'closed') throw new DOMException('closed', 'InvalidStateError');
          queue.push(chunk as unknown as FakeChunk);
          schedule();
        },
        async flush() {
          await pump;
          if (state === 'closed') throw new DOMException('closed', 'InvalidStateError');
        },
        close() {
          if (state !== 'closed') api.closed++;
          state = 'closed';
          queue = [];
        },
        addEventListener(_type: 'dequeue', l: () => void) {
          dequeueListeners.push(l);
        },
      };
    },
  };
  return api;
}

/* ------------------------------------------------------------ ready-made files */

/** A small M4B: two tones, 43 AAC-sized packets, two chapters (PCM packets for the fake decoder). */
export function smallM4b(): { file: Uint8Array; samples: number } {
  const samples = 43 * 1024;
  const signal = [sine(44100, 440, samples / 44100, 0.3), sine(44100, 660, samples / 44100, 0.2)];
  const file = buildMp4({
    sampleRate: 44100,
    channels: 2,
    packets: pcmPackets(signal, 1024),
    frameSamples: 1024,
    chapters: [
      { startSec: 0, title: 'Anfang' },
      { startSec: 0.5, title: 'Schluss' },
    ],
  });
  return { file, samples };
}
