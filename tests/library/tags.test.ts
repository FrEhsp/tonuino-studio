import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { memSource } from '../../src/platform/memory';
import { isAudioFile, readTrackInfo } from '../../src/core/library/tags';
import { replaceTags } from '../../src/core/audio/id3';
import { readMp4Chapters } from '../../src/core/library/mp4chapters';

const fixture = (name: string) => {
  const data = new Uint8Array(readFileSync(new URL(`../fixtures/library/${name}`, import.meta.url)));
  let reads = 0;
  const src = memSource(name, data);
  return {
    source: { ...src, read: (s: number, l: number) => (reads++, src.read(s, l)) },
    reads: () => reads,
  };
};

/** An ID3v2.4 tag as Tonuino-Manager 1.5.0 writes it (mutagen, TXXX in UTF-8), with an album. */
function managerTag(folderName: string, album: string): Uint8Array {
  const enc = new TextEncoder();
  const syncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
  const frame = (id: string, body: Uint8Array) => [...enc.encode(id), ...syncsafe(body.length), 0, 0, ...body];
  const frames = [
    ...frame('TALB', new Uint8Array([3, ...enc.encode(album)])),
    ...frame('TXXX', new Uint8Array([3, ...enc.encode('TONUINO_FOLDER_NAME'), 0, ...enc.encode(folderName)])),
  ];
  return new Uint8Array([...enc.encode('ID3'), 4, 0, 0, ...syncsafe(frames.length), ...frames]);
}

describe('readTrackInfo', () => {
  it('reads the folder name of Tonuino-Manager (TXXX TONUINO_FOLDER_NAME)', async () => {
    const { source } = fixture('tagged.mp3');
    const blob = await replaceTags(source, managerTag('Bibi im Zoo', 'Folge 12'));
    const info = await readTrackInfo(memSource('001.mp3', new Uint8Array(await blob.arrayBuffer())));
    expect(info).toMatchObject({ album: 'Folge 12', folderName: 'Bibi im Zoo' });
    expect((await readTrackInfo(source)).folderName).toBeUndefined();
  });

  it('reads ID3 tags, cover and chapters of an MP3', async () => {
    const { source } = fixture('tagged.mp3');
    const info = await readTrackInfo(source);
    expect(info).toMatchObject({ title: 'Kapitel 1', artist: 'Erzählerin', album: 'Testbuch', trackNo: 2, trackOf: 5, discNo: 1, discOf: 2, year: 2021, codec: 'mp3', channels: 1, sampleRate: 22050 });
    expect(info.durationSec).toBeGreaterThan(2.9);
    expect(info.durationSec).toBeLessThan(3.2);
    expect(info.picture?.mimeType).toBe('image/jpeg');
    expect(info.picture?.data[0]).toBe(0xff);
    expect(info.chapters).toEqual([
      { startSec: 0, title: 'Anfang' },
      { startSec: 1.5, title: 'Ende' },
    ]);
  });

  it('reads MP4 audiobooks with chapters', async () => {
    const { source } = fixture('book.m4b');
    const info = await readTrackInfo(source);
    expect(info).toMatchObject({ title: 'Kapitel 1', album: 'Testbuch', codec: 'aac' });
    expect(info.durationSec).toBeGreaterThan(3.9);
    expect(info.chapters?.map((c) => [Math.round(c.startSec * 10) / 10, c.title])).toEqual([
      [0, 'Anfang'],
      [1.5, 'Ende'],
    ]);
    expect(info.picture).toBeTruthy();
  });

  it('reads FLAC and can skip covers', async () => {
    const { source } = fixture('song.flac');
    const info = await readTrackInfo(source, { cover: false });
    expect(info).toMatchObject({ title: 'Lied', artist: 'Band', album: 'Platte', trackNo: 3, codec: 'flac' });
    expect(info.durationSec).toBeCloseTo(1, 1);
  });

  it('knows audio file names', () => {
    expect(isAudioFile('01 Intro.MP3')).toBe(true);
    expect(isAudioFile('book.m4b')).toBe(true);
    expect(isAudioFile('._book.m4b')).toBe(false);
    expect(isAudioFile('cover.jpg')).toBe(false);
  });
});

describe('readMp4Chapters', () => {
  it('reads chapters with the index before and after the audio', async () => {
    for (const name of ['book.m4b', 'book-faststart.m4b']) {
      const chapters = await readMp4Chapters(fixture(name).source);
      expect(chapters?.map((c) => [Math.round(c.startSec * 10) / 10, c.title]), name).toEqual([
        [0, 'Anfang'],
        [1.5, 'Ende'],
      ]);
    }
  });

  it('reads Nero chapter lists', async () => {
    const atom = (type: string, ...body: Uint8Array[]) => {
      const len = 8 + body.reduce((n, b) => n + b.length, 0);
      const out = new Uint8Array(len);
      new DataView(out.buffer).setUint32(0, len);
      out.set(new TextEncoder().encode(type), 4);
      let p = 8;
      for (const b of body) {
        out.set(b, p);
        p += b.length;
      }
      return out;
    };
    const entry = (sec: number, title: string) => {
      const t = new TextEncoder().encode(title);
      const b = new Uint8Array(9 + t.length);
      new DataView(b.buffer).setBigUint64(0, BigInt(Math.round(sec * 1e7)));
      b[8] = t.length;
      b.set(t, 9);
      return b;
    };
    const chpl = atom('chpl', new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 2]), entry(0, 'Teil 1'), entry(754.25, 'Teil Zwei – Ü'));
    const file = new Uint8Array([...atom('ftyp', new TextEncoder().encode('M4B 0000')), ...atom('moov', atom('udta', chpl))]);
    expect(await readMp4Chapters(memSource('x.m4b', file))).toEqual([
      { startSec: 0, title: 'Teil 1' },
      { startSec: 754.25, title: 'Teil Zwei – Ü' },
    ]);
  });

  it('returns null for files without chapters', async () => {
    expect(await readMp4Chapters(fixture('song.flac').source)).toBeNull();
  });
});
