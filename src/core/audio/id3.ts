/**
 * ID3 tags: find and measure ID3v2 (2.2, 2.3, 2.4), ID3v1, APE and Lyrics3
 * blocks, read the basic text frames, picture sizes and chapters (CHAP/CTOC),
 * and build small text-only ID3v2.3 tags for files on the SD card.
 *
 * Big embedded covers are reported (`pictures[].size`) because they can make
 * the DFPlayer stumble; the tags we write never contain pictures.
 */
import type { ByteSource } from '../../platform/types';
import { blobOfRange, readRange } from './source';

export interface BasicTags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  /** As stored, e.g. "3" or "3/12". */
  track?: string;
  /** As stored, e.g. "1/2". */
  disc?: string;
  genre?: string;
  year?: string;
  comment?: string;
  /** TCOP, e.g. "2026 Deutschlandradio": kept when the app writes new tags. */
  copyright?: string;
  /** WCOP: licence or terms of use. */
  copyrightUrl?: string;
  /** WOAS: the page the file came from. */
  sourceUrl?: string;
  /** TXXX "TonUINO Studio Ansage": a spoken title in front of the sound (core/audio/announce.ts). */
  announcement?: string;
}

/** Description of the TXXX frame that notes a spoken title in front of the sound. */
export const ANNOUNCEMENT_TXXX = 'TonUINO Studio Ansage';

export interface Id3Picture {
  mime: string;
  /** APIC picture type, 3 = front cover. */
  pictureType: number;
  description: string;
  /** Size of the whole frame body in bytes (image plus a few header bytes). */
  size: number;
}

export interface Id3Chapter {
  id: string;
  startMs: number;
  endMs: number;
  title?: string;
}

export interface Id3Toc {
  id: string;
  topLevel: boolean;
  ordered: boolean;
  children: string[];
  title?: string;
}

export interface Id3v2Tag {
  version: 2 | 3 | 4;
  revision: number;
  /** Total size in bytes including header and footer. */
  size: number;
  flags: number;
  tags: BasicTags;
  pictures: Id3Picture[];
  chapters: Id3Chapter[];
  tocs: Id3Toc[];
  /** Every frame in order with its stored size (for diagnostics). */
  frames: { id: string; size: number }[];
}

export interface Id3v2Header {
  version: 2 | 3 | 4;
  revision: number;
  flags: number;
  /** Size of the tag body as stored (after unsynchronisation), without header/footer. */
  bodySize: number;
  /** Total bytes the tag occupies in the file. */
  size: number;
  unsync: boolean;
  extended: boolean;
  footer: boolean;
}

export interface TagBlock {
  offset: number;
  size: number;
}

export interface TagLayout {
  fileSize: number;
  /** ID3v2 tags at the start of the file, in order (usually one). */
  id3v2: (TagBlock & { version: number })[];
  /** First byte after the leading tags. */
  audioStart: number;
  /** First byte of the trailing tags (or the file size). */
  audioEnd: number;
  id3v1?: TagBlock;
  ape?: TagBlock;
  lyrics3?: TagBlock;
  /** ID3v2.4 tag appended at the end (with "3DI" footer). */
  id3v2Appended?: TagBlock;
}

/* ------------------------------------------------------------ low level */

function syncsafe32(b: Uint8Array, o: number): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function latin1(b: Uint8Array, start = 0, end = b.length): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

function isAscii(b: Uint8Array, o: number, text: string): boolean {
  if (o < 0 || o + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[o + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** Removes ID3 unsynchronisation (every 0xFF 0x00 becomes 0xFF). */
export function removeUnsync(b: Uint8Array): Uint8Array {
  let hits = 0;
  for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0) hits++;
  if (hits === 0) return b;
  const out = new Uint8Array(b.length - hits);
  let o = 0;
  for (let i = 0; i < b.length; i++) {
    out[o++] = b[i];
    if (b[i] === 0xff && i + 1 < b.length && b[i + 1] === 0) i++;
  }
  return out;
}

/** Parses an ID3v2 header ("ID3") at `offset`; null when there is none. */
export function parseId3v2Header(b: Uint8Array, offset = 0): Id3v2Header | null {
  if (offset + 10 > b.length || !isAscii(b, offset, 'ID3')) return null;
  const major = b[offset + 3];
  const revision = b[offset + 4];
  const flags = b[offset + 5];
  if (major < 2 || major > 4 || revision === 0xff) return null;
  if ((b[offset + 6] | b[offset + 7] | b[offset + 8] | b[offset + 9]) & 0x80) return null;
  const bodySize = syncsafe32(b, offset + 6);
  const footer = major === 4 && (flags & 0x10) !== 0;
  return {
    version: major as 2 | 3 | 4,
    revision,
    flags,
    bodySize,
    size: 10 + bodySize + (footer ? 10 : 0),
    unsync: (flags & 0x80) !== 0,
    extended: major >= 3 && (flags & 0x40) !== 0,
    footer,
  };
}

/* ------------------------------------------------------------ layout */

/**
 * Finds the tag blocks at both ends of the file. Audio lies in
 * `[audioStart, audioEnd)`; parsers should not look outside.
 */
export async function measureTags(source: ByteSource): Promise<TagLayout> {
  const size = source.size;
  const layout: TagLayout = { fileSize: size, id3v2: [], audioStart: 0, audioEnd: size };

  let pos = 0;
  while (pos + 10 <= size && layout.id3v2.length < 16) {
    const head = await readRange(source, pos, 10);
    const h = parseId3v2Header(head, 0);
    if (!h || pos + h.size > size) break;
    layout.id3v2.push({ offset: pos, size: h.size, version: h.version });
    pos += h.size;
  }
  layout.audioStart = pos;

  let end = size;
  if (end - pos >= 128) {
    const t = await readRange(source, end - 128, 3);
    if (isAscii(t, 0, 'TAG')) {
      layout.id3v1 = { offset: end - 128, size: 128 };
      end -= 128;
      if (end - pos >= 227) {
        const ext = await readRange(source, end - 227, 4);
        if (isAscii(ext, 0, 'TAG+')) {
          layout.id3v1 = { offset: end - 227, size: 355 };
          end -= 227;
        }
      }
    }
  }

  for (let round = 0; round < 4; round++) {
    if (!layout.ape && end - pos >= 32) {
      const f = await readRange(source, end - 32, 32);
      if (isAscii(f, 0, 'APETAGEX')) {
        const tagSize = u32le(f, 12);
        const flags = u32le(f, 20);
        const total = tagSize + ((flags & 0x80000000) !== 0 ? 32 : 0);
        if (tagSize >= 32 && total <= end - pos) {
          layout.ape = { offset: end - total, size: total };
          end -= total;
          continue;
        }
      }
    }
    if (!layout.lyrics3 && end - pos >= 15) {
      const f = await readRange(source, end - 15, 15);
      if (isAscii(f, 6, 'LYRICS200')) {
        const n = Number.parseInt(latin1(f, 0, 6), 10);
        const total = n + 15;
        if (Number.isFinite(n) && n > 11 && total <= end - pos) {
          const begin = await readRange(source, end - total, 11);
          if (isAscii(begin, 0, 'LYRICSBEGIN')) {
            layout.lyrics3 = { offset: end - total, size: total };
            end -= total;
            continue;
          }
        }
      }
    }
    if (!layout.id3v2Appended && end - pos >= 20) {
      const f = await readRange(source, end - 10, 10);
      if (isAscii(f, 0, '3DI') && f[3] === 4 && !((f[6] | f[7] | f[8] | f[9]) & 0x80)) {
        const total = syncsafe32(f, 6) + 20;
        if (total <= end - pos) {
          layout.id3v2Appended = { offset: end - total, size: total };
          end -= total;
          continue;
        }
      }
    }
    break;
  }
  layout.audioEnd = end;
  return layout;
}

/* ------------------------------------------------------------ text decoding */

const utf8 = new TextDecoder('utf-8');

function decodeUtf16(b: Uint8Array, littleEndian: boolean): string {
  let s = '';
  const n = b.length - (b.length & 1);
  const step = 4096;
  for (let start = 0; start < n; start += step * 2) {
    const end = Math.min(n, start + step * 2);
    const codes: number[] = [];
    for (let i = start; i < end; i += 2) codes.push(littleEndian ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
    s += String.fromCharCode(...codes);
  }
  return s;
}

function decodeOne(enc: number, b: Uint8Array): string {
  switch (enc) {
    case 0:
      return latin1(b);
    case 1: {
      if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return decodeUtf16(b.subarray(2), true);
      if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return decodeUtf16(b.subarray(2), false);
      return decodeUtf16(b, true);
    }
    case 2:
      return decodeUtf16(b, false);
    case 3:
      return utf8.decode(b);
    default:
      return latin1(b);
  }
}

function terminatorWidth(enc: number): number {
  return enc === 1 || enc === 2 ? 2 : 1;
}

/** Index of the terminator starting at `pos`, or -1. */
function findTerminator(enc: number, b: Uint8Array, pos: number): number {
  if (terminatorWidth(enc) === 1) {
    for (let i = pos; i < b.length; i++) if (b[i] === 0) return i;
    return -1;
  }
  for (let i = pos; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
  return -1;
}

/** Reads one terminated string; returns the text and the position after the terminator. */
function readTerminated(enc: number, b: Uint8Array, pos: number): { text: string; next: number } {
  const t = findTerminator(enc, b, pos);
  if (t < 0) return { text: decodeOne(enc, b.subarray(pos)), next: b.length };
  return { text: decodeOne(enc, b.subarray(pos, t)), next: t + terminatorWidth(enc) };
}

/** Splits a text frame body (after the encoding byte) into its values. */
function decodeStrings(enc: number, b: Uint8Array): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos < b.length) {
    const { text, next } = readTerminated(enc, b, pos);
    out.push(text);
    if (next <= pos) break;
    pos = next;
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/* ------------------------------------------------------------ genres */

const GENRES = (
  'Blues|Classic Rock|Country|Dance|Disco|Funk|Grunge|Hip-Hop|Jazz|Metal|New Age|Oldies|Other|Pop|R&B|Rap|Reggae|Rock|' +
  'Techno|Industrial|Alternative|Ska|Death Metal|Pranks|Soundtrack|Euro-Techno|Ambient|Trip-Hop|Vocal|Jazz+Funk|Fusion|' +
  'Trance|Classical|Instrumental|Acid|House|Game|Sound Clip|Gospel|Noise|Alternative Rock|Bass|Soul|Punk|Space|Meditative|' +
  'Instrumental Pop|Instrumental Rock|Ethnic|Gothic|Darkwave|Techno-Industrial|Electronic|Pop-Folk|Eurodance|Dream|' +
  'Southern Rock|Comedy|Cult|Gangsta|Top 40|Christian Rap|Pop/Funk|Jungle|Native American|Cabaret|New Wave|Psychedelic|' +
  'Rave|Showtunes|Trailer|Lo-Fi|Tribal|Acid Punk|Acid Jazz|Polka|Retro|Musical|Rock & Roll|Hard Rock|Folk|Folk-Rock|' +
  'National Folk|Swing|Fast Fusion|Bebop|Latin|Revival|Celtic|Bluegrass|Avantgarde|Gothic Rock|Progressive Rock|' +
  'Psychedelic Rock|Symphonic Rock|Slow Rock|Big Band|Chorus|Easy Listening|Acoustic|Humour|Speech|Chanson|Opera|' +
  'Chamber Music|Sonata|Symphony|Booty Bass|Primus|Porn Groove|Satire|Slow Jam|Club|Tango|Samba|Folklore|Ballad|' +
  'Power Ballad|Rhythmic Soul|Freestyle|Duet|Punk Rock|Drum Solo|A Cappella|Euro-House|Dance Hall|Goa|Drum & Bass|' +
  'Club-House|Hardcore|Terror|Indie|Britpop|Afro-Punk|Polsk Punk|Beat|Christian Gangsta Rap|Heavy Metal|Black Metal|' +
  'Crossover|Contemporary Christian|Christian Rock|Merengue|Salsa|Thrash Metal|Anime|J-Pop|Synthpop|Abstract|Art Rock|' +
  'Baroque|Bhangra|Big Beat|Breakbeat|Chillout|Downtempo|Dub|EBM|Eclectic|Electro|Electroclash|Emo|Experimental|Garage|' +
  'Global|IDM|Illbient|Industro-Goth|Jam Band|Krautrock|Leftfield|Lounge|Math Rock|New Romantic|Nu-Breakz|Post-Punk|' +
  'Post-Rock|Psytrance|Shoegaze|Space Rock|Trop Rock|World Music|Neoclassical|Audiobook|Audio Theatre|' +
  'Neue Deutsche Welle|Podcast|Indie Rock|G-Funk|Dubstep|Garage Rock|Psybient'
).split('|');

/** Resolves numeric genre references like "(12)", "(12)Rock", "12", "(RX)". */
export function resolveGenre(raw: string): string {
  const text = raw.trim();
  if (/^\d+$/.test(text)) return GENRES[Number(text)] ?? text;
  const parts: string[] = [];
  let rest = text;
  for (let m = /^\((\d+|RX|CR)\)/.exec(rest); m; m = /^\((\d+|RX|CR)\)/.exec(rest)) {
    const ref = m[1];
    parts.push(ref === 'RX' ? 'Remix' : ref === 'CR' ? 'Cover' : (GENRES[Number(ref)] ?? ref));
    rest = rest.slice(m[0].length);
  }
  if (rest.startsWith('((')) rest = rest.slice(1);
  if (rest.trim()) return rest.trim();
  return parts.length > 0 ? parts.join(', ') : text;
}

/* ------------------------------------------------------------ ID3v2 frames */

const V22_IDS: Record<string, string> = {
  TT1: 'TIT1', TT2: 'TIT2', TT3: 'TIT3', TP1: 'TPE1', TP2: 'TPE2', TP3: 'TPE3', TAL: 'TALB', TRK: 'TRCK',
  TPA: 'TPOS', TCO: 'TCON', TYE: 'TYER', COM: 'COMM', PIC: 'APIC', TLE: 'TLEN',
};

interface FrameSink {
  tags: BasicTags;
  pictures: Id3Picture[];
  chapters: Id3Chapter[];
  tocs: Id3Toc[];
  frames: { id: string; size: number }[];
  commentPriority: number;
}

function newSink(): FrameSink {
  return { tags: {}, pictures: [], chapters: [], tocs: [], frames: [], commentPriority: -1 };
}

function isFrameId(b: Uint8Array, o: number, len: number): boolean {
  if (o + len > b.length) return false;
  for (let i = 0; i < len; i++) {
    const c = b[o + i];
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) return false;
  }
  return true;
}

function plausibleFrameStart(b: Uint8Array, p: number, end: number): boolean {
  if (p === end) return true;
  if (p > end) return false;
  if (b[p] === 0) return true; // padding
  return isFrameId(b, p, 4);
}

/** ID3v2.4 frame size: syncsafe per spec, but iTunes wrote plain integers for years. */
function frameSizeV24(b: Uint8Array, pos: number, end: number): number {
  const o = pos + 4;
  const plain = u32be(b, o);
  if ((b[o] | b[o + 1] | b[o + 2] | b[o + 3]) & 0x80) return plain;
  const safe = syncsafe32(b, o);
  if (safe === plain) return safe;
  if (plausibleFrameStart(b, pos + 10 + safe, end)) return safe;
  if (plausibleFrameStart(b, pos + 10 + plain, end)) return plain;
  return safe;
}

function parseFrames(data: Uint8Array, start: number, end: number, version: 2 | 3 | 4, unsyncAll: boolean, sink: FrameSink, depth: number): void {
  const idLen = version === 2 ? 3 : 4;
  const headLen = version === 2 ? 6 : 10;
  let pos = start;
  while (pos + headLen <= end) {
    if (data[pos] === 0) break; // padding
    if (!isFrameId(data, pos, idLen)) break;
    const rawId = latin1(data, pos, pos + idLen);
    let size: number;
    if (version === 2) size = (data[pos + 3] << 16) | (data[pos + 4] << 8) | data[pos + 5];
    else if (version === 3) size = u32be(data, pos + 4);
    else size = frameSizeV24(data, pos, end);
    if (pos + headLen + size > end) break; // truncated tag
    const flags = version === 2 ? 0 : (data[pos + 8] << 8) | data[pos + 9];
    let body = data.subarray(pos + headLen, pos + headLen + size);
    let usable = true;
    if (version === 3) {
      let extra = 0;
      if (flags & 0x0080) {
        usable = false; // zlib compressed
        extra += 4;
      }
      if (flags & 0x0040) {
        usable = false; // encrypted
        extra += 1;
      }
      if (flags & 0x0020) extra += 1; // group id
      body = body.subarray(Math.min(extra, body.length));
    } else if (version === 4) {
      let extra = 0;
      if (flags & 0x0040) extra += 1; // group id
      if (flags & 0x0008) usable = false; // compressed
      if (flags & 0x0004) {
        usable = false; // encrypted
        extra += 1;
      }
      if (flags & 0x0001) extra += 4; // data length indicator
      body = body.subarray(Math.min(extra, body.length));
      if (usable && (unsyncAll || (flags & 0x0002))) body = removeUnsync(body);
    }
    const id = version === 2 ? (V22_IDS[rawId] ?? rawId) : rawId;
    if (depth === 0) sink.frames.push({ id, size });
    if (usable && body.length > 0) handleFrame(id, body, version, sink, depth);
    pos += headLen + size;
  }
}

function handleFrame(id: string, body: Uint8Array, version: 2 | 3 | 4, sink: FrameSink, depth: number): void {
  if (id[0] === 'T' && id !== 'TXXX') {
    const values = decodeStrings(body[0], body.subarray(1)).map((v) => v.trim()).filter((v) => v !== '');
    if (values.length === 0) return;
    const t = sink.tags;
    switch (id) {
      case 'TIT2':
        t.title ??= values.join(' / ');
        break;
      case 'TPE1':
        t.artist ??= values.join(', ');
        break;
      case 'TPE2':
        t.albumArtist ??= values.join(', ');
        break;
      case 'TALB':
        t.album ??= values.join(' / ');
        break;
      case 'TRCK':
        t.track ??= values[0];
        break;
      case 'TPOS':
        t.disc ??= values[0];
        break;
      case 'TCON':
        t.genre ??= values.map(resolveGenre).join(', ');
        break;
      case 'TCOP':
        t.copyright ??= values[0];
        break;
      case 'TDRC':
      case 'TYER':
      case 'TORY':
      case 'TDOR': {
        const m = /\d{4}/.exec(values[0]);
        if (m && (id === 'TDRC' || id === 'TYER' || !t.year)) t.year = m[0];
        break;
      }
      default:
        break;
    }
    return;
  }
  if (id === 'TXXX' && depth === 0) {
    if (body.length < 2) return;
    const enc = body[0];
    const desc = readTerminated(enc, body, 1);
    if (desc.text !== ANNOUNCEMENT_TXXX) return;
    const value = decodeOne(enc, body.subarray(desc.next)).replace(/\0+$/, '').trim();
    if (value) sink.tags.announcement ??= value;
    return;
  }
  if ((id === 'WCOP' || id === 'WOAS') && depth === 0) {
    const end = body.indexOf(0);
    const url = latin1(body, 0, end < 0 ? body.length : end).trim();
    if (url) sink.tags[id === 'WCOP' ? 'copyrightUrl' : 'sourceUrl'] ??= url;
    return;
  }
  if (id === 'COMM' && depth === 0) {
    if (body.length < 5) return;
    const enc = body[0];
    const desc = readTerminated(enc, body, 4);
    const text = decodeOne(enc, body.subarray(desc.next)).replace(/\0+$/, '').trim();
    if (!text) return;
    // Prefer a comment without description; skip iTunes housekeeping comments.
    const priority = desc.text === '' ? 2 : desc.text.startsWith('iTun') ? 0 : 1;
    if (priority > sink.commentPriority) {
      sink.tags.comment = text;
      sink.commentPriority = priority;
    }
    return;
  }
  if (id === 'APIC') {
    const enc = body[0];
    let pos = 1;
    let mime: string;
    if (version === 2) {
      mime = latin1(body, 1, Math.min(4, body.length)).toUpperCase();
      mime = mime === 'JPG' ? 'image/jpeg' : mime === 'PNG' ? 'image/png' : mime.toLowerCase();
      pos = 4;
    } else {
      const m = readTerminated(0, body, 1);
      mime = m.text;
      pos = m.next;
    }
    const pictureType = body[pos] ?? 0;
    const desc = readTerminated(enc, body, pos + 1);
    sink.pictures.push({ mime, pictureType, description: desc.text, size: body.length });
    return;
  }
  if (id === 'CHAP' && version >= 3 && depth < 2) {
    const elem = readTerminated(0, body, 0);
    const p = elem.next;
    if (p + 16 > body.length) return;
    const sub = newSink();
    parseFrames(body, p + 16, body.length, version, false, sub, depth + 1);
    sink.chapters.push({
      id: elem.text,
      startMs: u32be(body, p),
      endMs: u32be(body, p + 4),
      title: sub.tags.title,
    });
    return;
  }
  if (id === 'CTOC' && version >= 3 && depth < 2) {
    const elem = readTerminated(0, body, 0);
    let p = elem.next;
    if (p + 2 > body.length) return;
    const flags = body[p];
    const count = body[p + 1];
    p += 2;
    const children: string[] = [];
    for (let i = 0; i < count && p < body.length; i++) {
      const c = readTerminated(0, body, p);
      children.push(c.text);
      p = c.next;
    }
    const sub = newSink();
    parseFrames(body, p, body.length, version, false, sub, depth + 1);
    sink.tocs.push({ id: elem.text, topLevel: (flags & 0x02) !== 0, ordered: (flags & 0x01) !== 0, children, title: sub.tags.title });
  }
}

/** Parses a complete ID3v2 tag (bytes start with "ID3"). */
export function parseId3v2(bytes: Uint8Array): Id3v2Tag | null {
  const h = parseId3v2Header(bytes, 0);
  if (!h) return null;
  const sink = newSink();
  const result: Id3v2Tag = {
    version: h.version,
    revision: h.revision,
    size: h.size,
    flags: h.flags,
    tags: sink.tags,
    pictures: sink.pictures,
    chapters: sink.chapters,
    tocs: sink.tocs,
    frames: sink.frames,
  };
  if (h.version === 2 && (h.flags & 0x40) !== 0) return result; // compressed v2.2 tag: no known reader
  let data = bytes.subarray(10, Math.min(bytes.length, 10 + h.bodySize));
  if (h.unsync && h.version < 4) data = removeUnsync(data);
  let pos = 0;
  if (h.extended) {
    if (data.length < 4) return result;
    pos = h.version === 3 ? 4 + u32be(data, 0) : syncsafe32(data, 0);
  }
  parseFrames(data, pos, data.length, h.version, h.unsync && h.version === 4, sink, 0);
  return result;
}

/** Parses a 128 byte ID3v1 / ID3v1.1 tag. */
export function parseId3v1(b: Uint8Array): BasicTags | null {
  if (b.length < 128 || !isAscii(b, 0, 'TAG')) return null;
  const field = (start: number, len: number) => {
    let end = start;
    while (end < start + len && b[end] !== 0) end++;
    const s = latin1(b, start, end).trim();
    return s === '' ? undefined : s;
  };
  const tags: BasicTags = {
    title: field(3, 30),
    artist: field(33, 30),
    album: field(63, 30),
    year: field(93, 4),
    comment: field(97, b[125] === 0 && b[126] !== 0 ? 28 : 30),
  };
  if (b[125] === 0 && b[126] !== 0) tags.track = String(b[126]);
  if (b[127] < GENRES.length) tags.genre = GENRES[b[127]];
  for (const k of Object.keys(tags) as (keyof BasicTags)[]) if (tags[k] === undefined) delete tags[k];
  return tags;
}

export interface TagReadResult {
  layout: TagLayout;
  id3v2?: Id3v2Tag;
  id3v1?: BasicTags;
  /** ID3v2 values, completed from ID3v1. */
  tags: BasicTags;
}

/** Reads the tags of a file. Tags larger than `maxTagBytes` are skipped. */
export async function readTags(source: ByteSource, opts: { maxTagBytes?: number } = {}): Promise<TagReadResult> {
  const layout = await measureTags(source);
  const result: TagReadResult = { layout, tags: {} };
  const first = layout.id3v2[0];
  if (first && first.size <= (opts.maxTagBytes ?? 64 << 20)) {
    result.id3v2 = parseId3v2(await readRange(source, first.offset, first.size)) ?? undefined;
  }
  if (layout.id3v1) {
    const off = layout.id3v1.offset + layout.id3v1.size - 128;
    result.id3v1 = parseId3v1(await readRange(source, off, 128)) ?? undefined;
  }
  result.tags = { ...(result.id3v1 ?? {}), ...(result.id3v2?.tags ?? {}) };
  return result;
}

/** Chapter marks of a tag in playing order, in seconds. */
export function chaptersFromId3(tag: Id3v2Tag): { startSec: number; endSec: number; title?: string }[] {
  if (tag.chapters.length === 0) return [];
  const byId = new Map(tag.chapters.map((c) => [c.id, c] as const));
  const toc = tag.tocs.find((t) => t.topLevel) ?? tag.tocs[0];
  let ordered: Id3Chapter[];
  if (toc && toc.ordered && toc.children.every((id) => byId.has(id))) {
    ordered = toc.children.map((id) => byId.get(id) as Id3Chapter);
  } else {
    ordered = [...tag.chapters].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  }
  return ordered.map((c) => ({ startSec: c.startMs / 1000, endSec: c.endMs / 1000, title: c.title }));
}

/** Splits "3/12" into numbers. */
export function parseNumberPair(value: string | undefined): { no?: number; of?: number } {
  if (!value) return {};
  const m = /^\s*(\d+)\s*(?:\/\s*(\d+))?/.exec(value);
  if (!m) return {};
  return { no: Number(m[1]), of: m[2] !== undefined ? Number(m[2]) : undefined };
}

/* ------------------------------------------------------------ copying with new tags */

/**
 * A copy of an MP3 file with all tags replaced: `tag` (e.g. from
 * buildSmallId3; null or empty for none) in front, then the bytes between
 * the leading and trailing tags. Big embedded covers disappear this way
 * without touching the audio. Pass `layout` when measureTags already ran.
 */
export async function replaceTags(source: ByteSource, tag: Uint8Array | null, layout?: TagLayout): Promise<Blob> {
  const l = layout ?? (await measureTags(source));
  const parts: BlobPart[] = [];
  if (tag && tag.length > 0) parts.push(tag as unknown as BlobPart);
  if (l.audioEnd > l.audioStart) parts.push(await blobOfRange(source, l.audioStart, l.audioEnd));
  return new Blob(parts, { type: 'audio/mpeg' });
}

/** Bytes the tags of a file take (ID3v2 at the start plus everything at the end). */
export function tagBytes(layout: TagLayout): number {
  return layout.audioStart + (layout.fileSize - layout.audioEnd);
}

/* ------------------------------------------------------------ writer */

export interface SmallTags {
  title?: string;
  artist?: string;
  /** TPE2. */
  albumArtist?: string;
  album?: string;
  track?: string | number;
  disc?: string | number;
  /** TYER: four digits. */
  year?: string;
  /** TCON, as plain text ("Hörspiel"). */
  genre?: string;
  comment?: string;
  /** TCOP: must start with the year and a space, e.g. "2026 Deutschlandradio". */
  copyright?: string;
  /** WCOP: licence or terms of use. */
  copyrightUrl?: string;
  /** WOAS: the page the file came from. */
  sourceUrl?: string;
  /** TXXX "TonUINO Studio Ansage" (see BasicTags.announcement). */
  announcement?: string;
}

/** URL frames hold ISO-8859-1: the address in its encoded form, or nothing when it is not a plain http(s) address. */
function urlFrameText(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let href: string;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    href = u.href;
  } catch {
    return undefined;
  }
  return /^[\x21-\x7e]+$/.test(href) ? href : undefined;
}

function encodeText(text: string): { enc: number; bytes: Uint8Array } {
  let latin = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) {
      latin = false;
      break;
    }
  }
  if (latin) {
    const b = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i);
    return { enc: 0, bytes: b };
  }
  const b = new Uint8Array(2 + text.length * 2);
  b[0] = 0xff;
  b[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    b[2 + i * 2] = c & 0xff;
    b[3 + i * 2] = c >> 8;
  }
  return { enc: 1, bytes: b };
}

function frameV23(id: string, body: Uint8Array): Uint8Array {
  const f = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
  f[4] = (body.length >>> 24) & 0xff;
  f[5] = (body.length >>> 16) & 0xff;
  f[6] = (body.length >>> 8) & 0xff;
  f[7] = body.length & 0xff;
  f.set(body, 10);
  return f;
}

/**
 * Builds a small ID3v2.3 tag with text frames only (TIT2, TPE1, TPE2, TALB,
 * TRCK, TPOS, TYER, TCON, COMM, TCOP, the TXXX of a spoken title) and the
 * URL frames WCOP and WOAS. Latin-1 text is stored
 * as ISO-8859-1, anything else as UTF-16. Returns an empty array when there
 * is nothing to write.
 */
export function buildSmallId3(tags: SmallTags, opts: { padding?: number } = {}): Uint8Array {
  const frames: Uint8Array[] = [];
  const text = (id: string, value: string | number | undefined) => {
    const v = value === undefined ? '' : String(value).replace(/\0/g, '').trim();
    if (!v) return;
    const { enc, bytes } = encodeText(v);
    const body = new Uint8Array(1 + bytes.length);
    body[0] = enc;
    body.set(bytes, 1);
    frames.push(frameV23(id, body));
  };
  text('TIT2', tags.title);
  text('TPE1', tags.artist);
  text('TPE2', tags.albumArtist);
  text('TALB', tags.album);
  text('TRCK', tags.track);
  text('TPOS', tags.disc);
  text('TYER', tags.year);
  text('TCON', tags.genre);
  const comment = tags.comment?.replace(/\0/g, '').trim();
  if (comment) {
    const { enc, bytes } = encodeText(comment);
    const emptyDesc = enc === 1 ? [0xff, 0xfe, 0, 0] : [0];
    const body = new Uint8Array(4 + emptyDesc.length + bytes.length);
    body[0] = enc;
    body.set([0x64, 0x65, 0x75], 1); // "deu"
    body.set(emptyDesc, 4);
    body.set(bytes, 4 + emptyDesc.length);
    frames.push(frameV23('COMM', body));
  }
  text('TCOP', tags.copyright);
  const announcement = tags.announcement?.replace(/\0/g, '').trim();
  if (announcement) {
    // Description and value in Latin-1: the app writes only ASCII there.
    const { enc, bytes } = encodeText(`${ANNOUNCEMENT_TXXX}\0${announcement}`);
    const body = new Uint8Array(1 + bytes.length);
    body[0] = enc;
    body.set(bytes, 1);
    frames.push(frameV23('TXXX', body));
  }
  for (const [id, value] of [
    ['WCOP', tags.copyrightUrl],
    ['WOAS', tags.sourceUrl],
  ] as const) {
    const href = urlFrameText(value);
    if (!href) continue;
    const body = new Uint8Array(href.length);
    for (let i = 0; i < href.length; i++) body[i] = href.charCodeAt(i);
    frames.push(frameV23(id, body));
  }
  if (frames.length === 0) return new Uint8Array(0);
  const padding = Math.max(0, Math.floor(opts.padding ?? 0));
  let bodySize = padding;
  for (const f of frames) bodySize += f.length;
  const out = new Uint8Array(10 + bodySize);
  out.set([0x49, 0x44, 0x33, 3, 0, 0], 0);
  out[6] = (bodySize >>> 21) & 0x7f;
  out[7] = (bodySize >>> 14) & 0x7f;
  out[8] = (bodySize >>> 7) & 0x7f;
  out[9] = bodySize & 0x7f;
  let o = 10;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}
