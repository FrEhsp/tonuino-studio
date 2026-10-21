import { ID3Writer } from 'browser-id3-writer';
import { describe, expect, it } from 'vitest';
import {
  buildSmallId3,
  chaptersFromId3,
  measureTags,
  parseId3v1,
  parseId3v2,
  parseId3v2Header,
  parseNumberPair,
  readTags,
  removeUnsync,
  resolveGenre,
} from '../../src/core/audio/id3';
import { bufferSource } from '../../src/core/audio/source';
import { concat } from './helpers';

const enc = new TextEncoder();

function syncsafe(n: number): number[] {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function frame24(id: string, body: Uint8Array | number[], flags = 0, plainSize = false): Uint8Array {
  const b = Uint8Array.from(body);
  return Uint8Array.from([...enc.encode(id), ...(plainSize ? be32(b.length) : syncsafe(b.length)), flags >> 8, flags & 0xff, ...b]);
}

function tag(version: number, frames: Uint8Array[], flags = 0, extra: number[] = []): Uint8Array {
  const body = concat([Uint8Array.from(extra), ...frames]);
  return concat([Uint8Array.from([0x49, 0x44, 0x33, version, 0, flags, ...syncsafe(body.length)]), body]);
}

describe('ID3v2 reading', () => {
  it('reads frames written by browser-id3-writer (v2.3, UTF-16, APIC, CHAP, CTOC)', () => {
    const jpeg = new Uint8Array(5000);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    const w = new ID3Writer(new ArrayBuffer(0));
    w.setFrame('TIT2', 'Die kleine Raupe – Teil 1')
      .setFrame('TPE1', ['Erzählerin', 'Sprecher'])
      .setFrame('TPE2', 'Verlag')
      .setFrame('TALB', 'Gute-Nacht-Geschichten')
      .setFrame('TRCK', '3/12')
      .setFrame('TPOS', '1/2')
      .setFrame('TCON', ['Hörbuch'])
      .setFrame('TYER', 2021)
      .setFrame('COMM', { description: '', text: 'Für Kinder ab 4' })
      .setFrame('APIC', { type: 3, data: jpeg.buffer, description: 'Cover' })
      .setFrame('CHAP', { id: 'ch0', startTime: 0, endTime: 61000, subFrames: { TIT2: 'Anfang' } })
      .setFrame('CHAP', { id: 'ch1', startTime: 61000, endTime: 125500, subFrames: { TIT2: 'Mitte' } })
      .setFrame('CHAP', { id: 'ch2', startTime: 125500, endTime: 200000, subFrames: { TIT2: 'Ende' } })
      .setFrame('CTOC', { id: 'toc', ordered: true, topLevel: true, childElementIds: ['ch0', 'ch2', 'ch1'] });
    const bytes = new Uint8Array(w.addTag());
    const t = parseId3v2(bytes);
    expect(t).not.toBeNull();
    expect(t?.version).toBe(3);
    expect(t?.tags).toEqual({
      title: 'Die kleine Raupe – Teil 1',
      artist: 'Erzählerin/Sprecher',
      albumArtist: 'Verlag',
      album: 'Gute-Nacht-Geschichten',
      track: '3/12',
      disc: '1/2',
      genre: 'Hörbuch',
      year: '2021',
      comment: 'Für Kinder ab 4',
    });
    expect(t?.pictures).toHaveLength(1);
    expect(t?.pictures[0]).toMatchObject({ mime: 'image/jpeg', pictureType: 3, description: 'Cover' });
    expect(t?.pictures[0].size).toBeGreaterThan(5000);
    expect(t?.chapters.map((c) => [c.id, c.startMs, c.endMs, c.title])).toEqual([
      ['ch0', 0, 61000, 'Anfang'],
      ['ch1', 61000, 125500, 'Mitte'],
      ['ch2', 125500, 200000, 'Ende'],
    ]);
    expect(t?.tocs[0]).toMatchObject({ id: 'toc', topLevel: true, ordered: true, children: ['ch0', 'ch2', 'ch1'] });
    // playing order follows the table of contents
    expect(chaptersFromId3(t!).map((c) => c.title)).toEqual(['Anfang', 'Ende', 'Mitte']);
    expect(t?.size).toBe(parseId3v2Header(bytes)?.size);
  });

  it('reads ID3v2.4: UTF-8, multiple values, frame unsync, data length indicator, iTunes sizes', () => {
    const unsyncBody = [0, ...enc.encode('A'), 0xff, 0x00, 0xfe]; // Latin-1, stored with unsync: FF 00 → FF
    const t = parseId3v2(
      tag(4, [
        frame24('TIT2', [3, ...enc.encode('Grüße 🐻')]),
        frame24('TPE1', [3, ...enc.encode('Anna'), 0, ...enc.encode('Ben')]),
        frame24('TDRC', [3, ...enc.encode('2019-05-03')]),
        frame24('TCON', [0, ...enc.encode('(183)')]),
        frame24('TALB', unsyncBody, 0x0002),
        frame24('TRCK', [0, 0, 0, 2, 3, ...enc.encode('7')], 0x0001), // data length indicator
        frame24('TPOS', [0, ...enc.encode('2')], 0, true),
      ]),
    );
    expect(t?.tags).toEqual({ title: 'Grüße 🐻', artist: 'Anna, Ben', year: '2019', genre: 'Audiobook', album: 'Aÿþ', track: '7', disc: '2' });
  });

  it('removes whole-tag unsynchronisation in ID3v2.3 and skips the extended header', () => {
    const titleBody = [0, ...enc.encode('X'), 0xff, 0x00, 0xe0];
    const frame = Uint8Array.from([...enc.encode('TIT2'), ...be32(titleBody.length - 1), 0, 0, ...titleBody]);
    const ext = [0, 0, 0, 6, 0, 0, 0, 0, 0, 0];
    const t = parseId3v2(tag(3, [frame], 0x80 | 0x40, ext));
    expect(t?.tags.title).toBe('Xÿà');
    expect([...removeUnsync(Uint8Array.from([1, 0xff, 0, 2, 0xff, 0, 0]))]).toEqual([1, 0xff, 2, 0xff, 0]);
  });

  it('reads ID3v2.2 tags', () => {
    const f = (id: string, body: number[]) => Uint8Array.from([...enc.encode(id), 0, (body.length >> 8) & 0xff, body.length & 0xff, ...body]);
    const t = parseId3v2(
      tag(2, [
        f('TT2', [0, ...enc.encode('Alt')]),
        f('TP1', [1, 0xff, 0xfe, ...[...'Bär'].flatMap((c) => [c.charCodeAt(0), 0])]),
        f('TCO', [0, ...enc.encode('(12)')]),
        f('PIC', [0, ...enc.encode('JPG'), 3, 0, 1, 2, 3, 4]),
      ]),
    );
    expect(t?.version).toBe(2);
    expect(t?.tags).toEqual({ title: 'Alt', artist: 'Bär', genre: 'Other' });
    expect(t?.pictures[0]).toMatchObject({ mime: 'image/jpeg', pictureType: 3, size: 10 });
  });

  it('resolves numeric genres', () => {
    expect(resolveGenre('(12)')).toBe('Other');
    expect(resolveGenre('17')).toBe('Rock');
    expect(resolveGenre('(183)(184)')).toBe('Audiobook, Audio Theatre');
    expect(resolveGenre('(12)Hörspiel')).toBe('Hörspiel');
    expect(resolveGenre('(RX)')).toBe('Remix');
    expect(resolveGenre('Kinderlieder')).toBe('Kinderlieder');
  });

  it('parses ID3v1.1 and number pairs', () => {
    const b = new Uint8Array(128);
    b.set(enc.encode('TAG'));
    b.set(enc.encode('Titel'), 3);
    b.set(enc.encode('Kuenstler'), 33);
    b.set(enc.encode('Album'), 63);
    b.set(enc.encode('1999'), 93);
    b.set(enc.encode('Kommentar'), 97);
    b[126] = 5;
    b[127] = 101;
    expect(parseId3v1(b)).toEqual({ title: 'Titel', artist: 'Kuenstler', album: 'Album', year: '1999', comment: 'Kommentar', track: '5', genre: 'Speech' });
    expect(parseNumberPair('3/12')).toEqual({ no: 3, of: 12 });
    expect(parseNumberPair('7')).toEqual({ no: 7, of: undefined });
    expect(parseNumberPair('x')).toEqual({});
  });
});

describe('tag layout', () => {
  it('measures leading ID3v2 tags and trailing APE, Lyrics3, ID3v2.4 footer and ID3v1', async () => {
    const lead1 = buildSmallId3({ title: 'a' });
    const lead2 = buildSmallId3({ title: 'b' }, { padding: 20 });
    const audio = new Uint8Array(1000).fill(0x11);
    const appended = concat([tag(4, [frame24('TIT2', [0, 0x41])], 0x10), Uint8Array.from([0x33, 0x44, 0x49, 4, 0, 0x10, ...syncsafe(12)])]);
    const lyricsBody = enc.encode('LYRICSBEGININD0000210');
    const lyrics = concat([lyricsBody, enc.encode(String(lyricsBody.length).padStart(6, '0')), enc.encode('LYRICS200')]);
    const ape = new Uint8Array(32 + 40);
    const footer = new DataView(ape.buffer, 40);
    ape.set(enc.encode('APETAGEX'), 40);
    footer.setUint32(12, 72, true); // items + footer, no header
    const v1 = new Uint8Array(128);
    v1.set(enc.encode('TAG'));
    const file = concat([lead1, lead2, audio, appended, lyrics, ape, v1]);
    const layout = await measureTags(bufferSource(file));
    expect(layout.id3v2).toEqual([
      { offset: 0, size: lead1.length, version: 3 },
      { offset: lead1.length, size: lead2.length, version: 3 },
    ]);
    expect(layout.audioStart).toBe(lead1.length + lead2.length);
    expect(layout.audioEnd).toBe(layout.audioStart + audio.length);
    expect(layout.id3v1).toEqual({ offset: file.length - 128, size: 128 });
    expect(layout.ape?.size).toBe(72);
    expect(layout.lyrics3?.size).toBe(lyrics.length);
    expect(layout.id3v2Appended?.size).toBe(appended.length);
  });

  it('reads tags of a file and completes ID3v2 with ID3v1', async () => {
    const v1 = new Uint8Array(128);
    v1.set(enc.encode('TAG'));
    v1.set(enc.encode('Alter Titel'), 3);
    v1.set(enc.encode('2001'), 93);
    const file = concat([buildSmallId3({ title: 'Neuer Titel', album: 'Album' }), new Uint8Array(500), v1]);
    const r = await readTags(bufferSource(file));
    expect(r.tags).toMatchObject({ title: 'Neuer Titel', album: 'Album', year: '2001' });
  });
});

describe('buildSmallId3', () => {
  it('writes small text-only ID3v2.3 tags that read back', () => {
    const latin = buildSmallId3({ title: 'Hänsel & Gretel', artist: 'Brüder Grimm', album: 'Märchen', track: 4, disc: '1/2', comment: 'Ab 5 Jahren' });
    expect([...latin.subarray(0, 4)]).toEqual([0x49, 0x44, 0x33, 3]);
    expect(latin.length).toBeLessThan(200);
    const t = parseId3v2(latin);
    expect(t?.tags).toEqual({ title: 'Hänsel & Gretel', artist: 'Brüder Grimm', album: 'Märchen', track: '4', disc: '1/2', comment: 'Ab 5 Jahren' });
    expect(t?.pictures).toEqual([]);
    expect(t?.frames.map((f) => f.id)).toEqual(['TIT2', 'TPE1', 'TALB', 'TRCK', 'TPOS', 'COMM']);

    const uni = buildSmallId3({ title: 'Der Bär 🐻', comment: 'Ελληνικά' });
    expect(parseId3v2(uni)?.tags).toEqual({ title: 'Der Bär 🐻', comment: 'Ελληνικά' });

    expect(buildSmallId3({ title: '  ', artist: '' }).length).toBe(0);
    const padded = buildSmallId3({ title: 'x' }, { padding: 64 });
    expect(padded.length).toBe(10 + 10 + 2 + 64);
    expect(parseId3v2(padded)?.tags.title).toBe('x');
  });

  it('writes copyright, licence and source frames for credits', async () => {
    const bytes = buildSmallId3({
      title: 'Ein sehr großer Mann',
      comment: '„Ein sehr großer Mann“. Lizenz: CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/).',
      copyright: '2017 Global Storybooks. Licensed to the public under https://creativecommons.org/licenses/by/3.0/ verify at https://gitlab.com/global-asp/gsn-audio',
      copyrightUrl: 'https://creativecommons.org/licenses/by/3.0/',
      sourceUrl: 'https://www.kakadu.de/kinderhörspiel-102.html',
    });
    const t = parseId3v2(bytes);
    expect(t?.frames.map((f) => f.id)).toEqual(['TIT2', 'COMM', 'TCOP', 'WCOP', 'WOAS']);
    const body = (id: string) => {
      let pos = 10;
      while (pos < bytes.length) {
        const fid = String.fromCharCode(...bytes.subarray(pos, pos + 4));
        const size = (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7];
        if (fid === id) return bytes.subarray(pos + 10, pos + 10 + size);
        pos += 10 + size;
      }
      return undefined;
    };
    const latin1 = (b: Uint8Array | undefined) => String.fromCharCode(...(b ?? []));
    // URL frames: plain ISO-8859-1, no encoding byte; addresses in their encoded form.
    expect(latin1(body('WCOP'))).toBe('https://creativecommons.org/licenses/by/3.0/');
    expect(latin1(body('WOAS'))).toBe('https://www.kakadu.de/kinderh%C3%B6rspiel-102.html');
    expect(latin1(body('TCOP')).slice(1, 6)).toBe('2017 ');

    const { parseBuffer } = await import('music-metadata');
    const meta = await parseBuffer(concat([bytes, new Uint8Array(32)]), { mimeType: 'audio/mpeg' }, { duration: false, skipPostHeaders: true });
    expect(meta.common.copyright).toMatch(/^2017 Global Storybooks\. Licensed to the public under/);
    const native = (meta.native['ID3v2.3'] ?? []).map((tag) => tag.id);
    expect(native).toEqual(expect.arrayContaining(['TCOP', 'WCOP', 'WOAS', 'COMM']));
  });

  it('leaves out addresses that are not plain http(s)', () => {
    const bytes = buildSmallId3({ title: 'x', copyrightUrl: 'javascript:alert(1)', sourceUrl: 'kein Link' });
    expect(parseId3v2(bytes)?.frames.map((f) => f.id)).toEqual(['TIT2']);
  });
});
