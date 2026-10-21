/**
 * The import session from dropped files to the card, on an SD card in memory
 * and the browser audio backend on fake workers.
 */
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { card, platform, settings } from '../../src/app/state';
import { AudioError, bufferSource, createBrowserAudioBackend, encodeWav16, scanMp3 } from '../../src/core/audio';
import { isLongTrack, type DraftTrack } from '../../src/core/library/grouping';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { scanSd, tempDirName } from '../../src/core/tonuino/sd';
import { addSources, albumProgress, cancelImport, doubles, PREPARE_SHARE, prepareShare, problems, resetImport, resultNotes, resumeImport, runImport, session, setCoverFor, trackCountOf, updateAlbum, type ImportResult, type WriteState } from '../../src/features/add/session';
import { memDir, memSource, type MemTree } from '../../src/platform/memory';
import type { AudioAnalysis, AudioBackend, ByteSource, Dir, PcmReader, Platform } from '../../src/platform/types';
import { fakeWebCodecs, opusFile } from '../audio/containers';
import { workers } from '../audio/fakeWorkers';
import { mono96Mp3, monoMp3, SR, stereoMp3, withInfoFrame } from '../audio/fixtures';
import { concat, synth } from '../audio/helpers';

const audio = createBrowserAudioBackend({ createWorker: workers({ webCodecs: fakeWebCodecs() }).create });
const defaults = settings.value;

/** An SD card in memory, ready for the import. */
async function useCard(tree: MemTree = {}, backend: AudioBackend = audio) {
  const root = memDir(tree);
  platform.value = { kind: 'web', os: 'linux', audio: backend, volumes: { info: async () => ({}) } } as unknown as Platform;
  card.value = {
    volume: { id: 'sd', label: 'SD', root, info: {}, canEject: false },
    status: 'ready',
    scan: await scanSd(root),
    catalog: newCatalog(),
    catalogOnCard: true,
    covers: new Map(),
    coverUrls: new Map(),
    info: {},
  };
  resetImport();
  return root;
}

async function framesOf(mp3: Uint8Array): Promise<Uint8Array[]> {
  const idx = await scanMp3(bufferSource(mp3));
  return Array.from(idx.frameOffsets, (o, i) => mp3.subarray(o, i + 1 < idx.frameCount ? idx.frameOffsets[i + 1] : idx.audioEnd));
}

/** About 22 minutes of MP3: long enough to be cut. */
function longMp3(): Uint8Array {
  const one = monoMp3();
  return concat(Array.from({ length: 110 }, () => one));
}

/** The ID3 tag of the fixture, with two chapters. */
function chapterTag(): Uint8Array {
  const data = new Uint8Array(readFileSync(new URL('../fixtures/library/tagged.mp3', import.meta.url)));
  const size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9];
  return data.subarray(0, 10 + size);
}

function wav(sec: number): Uint8Array {
  return encodeWav16([synth(SR, [{ sec, freq: 440, amp: 0.2 }])], SR);
}

/** Speech with a pause of 2 s every `every` seconds, as the analysis of a long recording reports it. */
function speech(durationSec: number, every: number): AudioAnalysis {
  const windowSec = 0.1;
  const power = new Float32Array(Math.ceil(durationSec / windowSec)).fill(0.01);
  for (let t = every; t < durationSec - 2; t += every) power.fill(1e-9, Math.round((t - 1) / windowSec), Math.round((t + 1) / windowSec));
  return { durationSec, sampleRate: SR, channels: 1, windowSec, power };
}

/** PCM that takes its time, so a conversion is still running when the test needs it. */
function endless(): PcmReader {
  return {
    sampleRate: 44100,
    channels: 1,
    durationSec: 600,
    next: async (n) => {
      await new Promise((r) => setTimeout(r, 2));
      return { channels: [new Float32Array(Math.min(n, 4410))], sampleRate: 44100 };
    },
    close: async () => undefined,
  };
}

/** The browser backend, with made-up analyses for some files, and files that cannot be converted or take long. */
function backend(opts: { analyses?: Record<string, AudioAnalysis>; broken?: string[]; slow?: string[] }): AudioBackend {
  return {
    ...audio,
    analyze: async (input, onProgress, signal) => opts.analyses?.[input.name] ?? audio.analyze(input, onProgress, signal),
    openPcm: async (input, o) => {
      if (opts.broken?.includes(input.name)) throw new AudioError('decode-failed');
      if (opts.slow?.includes(input.name)) return endless();
      return audio.openPcm(input, o);
    },
  };
}

/** Calls `fn` once, as soon as the transfer gets to where `when` says. */
function onWrite(when: (w: WriteState) => boolean, fn: () => void): () => void {
  let fired = false;
  return session.subscribe((s) => {
    if (fired || !s.write || !when(s.write)) return;
    fired = true;
    fn();
  });
}

/** Transfers what the review shows. */
async function transfer(): Promise<ImportResult> {
  await runImport();
  expect(session.value.phase).toBe('done');
  return session.value.result!;
}

/** File names in a folder of the card; undefined when there is no such folder. */
async function filesIn(root: Dir, folder: string): Promise<string[] | undefined> {
  if (!(await root.exists(folder))) return undefined;
  return (await (await root.dir(folder)).list()).map((e) => e.name).sort();
}

function titlesIn(folder: string): (string | undefined)[] | undefined {
  return card.value?.catalog?.folders[folder]?.tracks.map((t) => t.title);
}

afterEach(() => {
  settings.value = defaults;
});

/** Real audio work: a test takes a second or two alone, much longer while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('reading the files', SLOW, () => {
  it('counts the frames of MP3s whose header tells only the first part, so long ones are cut', async () => {
    await useCard();
    const one = monoMp3();
    const first = withInfoFrame(one, (await scanMp3(bufferSource(one))).frameCount);
    const book = concat([first, ...Array.from({ length: 110 }, () => one)]); // 22 minutes joined, the header says 12 s
    await addSources([memSource('Buch.mp3', book)]);
    const [a] = session.value.albums;
    expect(a.tracks[0].info?.durationSec).toBeGreaterThan(21 * 60);
    expect(a.split).toBe('pauses');
  });

  it('counts the frames of VBR MP3s without a Xing frame', async () => {
    await useCard();
    const [a, b] = [await framesOf(monoMp3()), await framesOf(mono96Mp3())];
    const n = Math.ceil((21 * 60 * SR) / 1152);
    const book = concat(Array.from({ length: n }, (_, i) => (i % 2 ? b[i % b.length] : a[i % a.length]))); // 64 and 96 kbps by turns
    await addSources([memSource('Buch.mp3', book)]);
    const [album] = session.value.albums;
    expect(album.tracks[0].info?.durationSec).toBeCloseTo((n * 1152) / SR, 3);
    expect(album.split).toBe('pauses');
  });

  it('takes the playing time of all streams of a chained Ogg file, so a long one is cut', async () => {
    await useCard();
    // Two streams of 15 minutes one after the other: the tags tell the first one only.
    const chain = concat([opusFile(1, 0.1, 15 * 60 * 48000), opusFile(2, 0.1, 15 * 60 * 48000)]);
    await addSources([memSource('Buch.opus', chain)]);
    const [a] = session.value.albums;
    expect(a.tracks[0].info?.durationSec).toBeCloseTo(30 * 60, 0);
    expect(a.split).toBe('pauses');
  });

  it('shows why when none of the files can go to the card', async () => {
    await useCard();
    await addSources([memSource('Folge.flac', new Uint8Array(4096).fill(7)), memSource('Notizen.docx', new Uint8Array(10))]);
    expect(session.value.phase).toBe('review');
    expect(session.value.albums).toEqual([]);
    expect(session.value.rejected.map((r) => r.name)).toEqual(['Notizen.docx', 'Folge.flac']);
  });

  it('says why nothing happens when only a PDF or a picture comes, and keeps quiet about them next to audio', async () => {
    await useCard();
    await addSources([memSource('Rechnung.pdf', new Uint8Array(100))]);
    expect(session.value).toMatchObject({ phase: 'review', albums: [], rejected: [{ name: 'Rechnung.pdf', reason: 'Keine Audiodatei.' }] });
    resetImport();
    await addSources([memSource('Foto.jpg', new Uint8Array(100)), memSource('.DS_Store', new Uint8Array(10))]);
    expect(session.value.rejected).toEqual([{ name: 'Foto.jpg', reason: 'Ein Bild, keine Audiodatei.' }]);
    resetImport();
    await addSources([memSource('Rechnung.pdf', new Uint8Array(100)), memSource('1.mp3', monoMp3())]);
    expect(session.value).toMatchObject({ phase: 'review', rejected: [] });
    expect(session.value.albums).toHaveLength(1);
  });

  it('refuses a file named .mp3 without a single MP3 frame in it, also when its tags read fine', async () => {
    await useCard();
    // 60 KB of noise: no frame header, so nothing in it would play.
    let x = 1;
    const noise = Uint8Array.from({ length: 60_000 }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 24) & 0xfe);
    await addSources([memSource('Rauschen.mp3', noise), memSource('1.mp3', monoMp3())]);
    expect(session.value.rejected.map((r) => r.name)).toEqual(['Rauschen.mp3']);
    expect(session.value.albums.flatMap((a) => a.tracks.map((t) => t.source.name))).toEqual(['1.mp3']);
  });

  it('takes the album out of a ZIP, as if the unpacked folder had been picked', async () => {
    await useCard();
    const zip = new JSZip();
    zip.file('01 Anfang.mp3', monoMp3());
    zip.file('02 Ende.mp3', monoMp3());
    zip.file('__MACOSX/._01 Anfang.mp3', new Uint8Array(10));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await addSources([memSource('Bibi Blocksberg 12.zip', bytes)]);
    expect(session.value.rejected).toEqual([]);
    const tracks = session.value.albums.flatMap((a) => a.tracks.map((t) => t.source.relativePath));
    expect(tracks).toEqual(['Bibi Blocksberg 12/01 Anfang.mp3', 'Bibi Blocksberg 12/02 Ende.mp3']);
  });

  it('warns when two titles of an album hold the same sound under different names (a broken download)', async () => {
    await useCard();
    const bytes = (...parts: Uint8Array[]) => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) (out.set(p, o), (o += p.length));
      return out;
    };
    const long = bytes(monoMp3(), monoMp3(), monoMp3());
    const other = bytes(stereoMp3(), stereoMp3(), stereoMp3(), stereoMp3(), stereoMp3(), stereoMp3());
    await addSources([
      memSource('1. Kapitel 01.mp3', long, 'Halloween/1. Kapitel 01.mp3'),
      memSource('2. Kapitel 02.mp3', other, 'Halloween/2. Kapitel 02.mp3'),
      memSource('3. Kapitel 03.mp3', bytes(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20]), new Uint8Array(20), long), 'Halloween/3. Kapitel 03.mp3'),
    ]);
    const hints = doubles(session.value, undefined).map((p) => p.text);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/zweimal derselbe Ton unter anderem Namen: „.*Kapitel 01“ und „.*Kapitel 03“/);
  });

  it('warns when titles are missing from the numbering or one is just a blip', async () => {
    await useCard();
    const long = withInfoFrame(monoMp3(), Math.ceil((30 * SR) / 1152));
    await addSources([
      memSource('01 Anfang.mp3', long, 'Hexe/01 Anfang.mp3'),
      memSource('02 Mitte.mp3', monoMp3().slice(0, 4000), 'Hexe/02 Mitte.mp3'),
      memSource('04 Weiter.mp3', long, 'Hexe/04 Weiter.mp3'),
      memSource('05 Ende.mp3', long, 'Hexe/05 Ende.mp3'),
    ]);
    const hints = doubles(session.value, undefined).map((p) => p.text);
    expect(hints).toEqual([
      expect.stringMatching(/fehlt Titel 3\. Vielleicht ist der Download unvollständig/),
      expect.stringMatching(/ist „.*Mitte“ kürzer als 2 Sekunden/),
    ]);
  });

  it('says why a broken ZIP or a RAR file brings nothing', async () => {
    await useCard();
    await addSources([memSource('Bibi Blocksberg 12.zip', new Uint8Array(100)), memSource('Benjamin 3.rar', new Uint8Array(100))]);
    expect(session.value.rejected).toEqual([
      { name: 'Bibi Blocksberg 12.zip', reason: 'ZIP-Datei: Sie lässt sich nicht öffnen, vielleicht ist sie unvollständig. Entpacke sie zuerst und nimm dann den Ordner mit den Audiodateien.' },
      { name: 'Benjamin 3.rar', reason: 'RAR-Datei. Ich öffne nur ZIP-Archive. Entpacke sie zuerst (Rechtsklick › Hier entpacken) und nimm dann den Ordner mit den Audiodateien.' },
    ]);
  });

  it('adds no empty album to a folder when none of the files can go there', async () => {
    await useCard({ '01': { '001.mp3': monoMp3() } });
    resetImport(1);
    await addSources([memSource('Folge.flac', new Uint8Array(4096).fill(7))]);
    expect(session.value).toMatchObject({ phase: 'review', forFolder: 1, albums: [] });
    expect(session.value.rejected.map((r) => r.name)).toEqual(['Folge.flac']);
  });

  it('cuts a long file added to a folder after short ones', async () => {
    await useCard({ '01': { '001.mp3': monoMp3() } });
    resetImport(1);
    await addSources([memSource('Kurz.mp3', stereoMp3())]);
    expect(session.value.albums[0].split).toBe('none');
    await addSources([memSource('Buch.mp3', longMp3())]);
    const [a] = session.value.albums;
    expect(a.tracks.map((t) => [t.title, isLongTrack(t)])).toEqual([
      ['Kurz', false],
      ['Buch', true],
    ]);
    expect(a.split).toBe('pauses');
  });

  it('cuts at pauses when a long file without chapters joins one with chapters', async () => {
    await useCard({ '01': { '001.mp3': monoMp3() } });
    resetImport(1);
    await addSources([memSource('Kapitel.mp3', concat([chapterTag(), longMp3()]))]);
    expect(session.value.albums[0].tracks[0].info?.chapters).toHaveLength(2);
    expect(session.value.albums[0].split).toBe('chapters');
    await addSources([memSource('Buch.mp3', longMp3())]);
    expect(session.value.albums[0].split).toBe('pauses');
  });
});

describe('files and albums picked twice', SLOW, () => {
  it('leaves out files that are in the selection already and says how many', async () => {
    await useCard();
    const pick = () => [memSource('1.mp3', monoMp3(), 'Bibi/1.mp3'), memSource('2.mp3', stereoMp3(), 'Bibi/2.mp3')];
    expect(await addSources(pick())).toEqual({ accepted: 2, rejected: [] });
    expect(await addSources(pick())).toEqual({ accepted: 0, rejected: [], doubled: 2 });
    expect(await addSources([...pick(), memSource('3.mp3', monoMp3(), 'Bibi/3.mp3')])).toMatchObject({ accepted: 1, doubled: 2 });
    // A file from another call makes an album of its own, as before.
    expect(session.value.albums.map((a) => a.tracks.length)).toEqual([2, 1]);
  });

  it('knows a file picked alone again after its folder was picked', async () => {
    await useCard();
    const data = monoMp3();
    await addSources([memSource('1.mp3', data, 'Bibi/1.mp3')]);
    expect(await addSources([memSource('1.mp3', data)])).toEqual({ accepted: 0, rejected: [], doubled: 1 });
    expect(session.value.albums).toHaveLength(1);
  });

  it('says nothing about the cover when the same folder is picked again', async () => {
    await useCard();
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const pick = () => [memSource('1.mp3', monoMp3(), 'Bibi/1.mp3'), memSource('cover.jpg', jpeg, 'Bibi/cover.jpg')];
    await addSources(pick());
    expect(await addSources(pick())).toMatchObject({ accepted: 0, rejected: [], doubled: 1 });
    expect(session.value).toMatchObject({ phase: 'review', rejected: [] });
    expect(session.value.albums).toHaveLength(1);
  });

  it('hints at albums with the same name, in the selection or on the card, without stopping the transfer', async () => {
    await useCard({ '01': { '001.mp3': monoMp3() } });
    card.value!.catalog!.folders['01'] = { title: 'Bibi & Tina 1', artist: 'Kiddinx', kind: 'hoerspiel', tracks: [], addedAt: 0, updatedAt: 0 };
    const tracks = [memSource('1.mp3', monoMp3(), 'a/1.mp3'), memSource('2.mp3', monoMp3(), 'b/2.mp3'), memSource('3.mp3', monoMp3(), 'c/3.mp3')];
    const hints = new Map([
      [tracks[0], { album: 'Bibi Blocksberg 3', artist: 'Kiddinx' }],
      [tracks[1], { album: 'Bibi Blocksberg - 3', artist: 'kiddinx' }],
      [tracks[2], { album: 'Bibi und Tina 1', albumArtist: 'Kiddinx' }],
    ]);
    await addSources(tracks, { hints });
    expect(doubles(session.value, card.value!.catalog).map((p) => p.text)).toEqual([expect.stringMatching(/^„Bibi Blocksberg (- )?3“ ist zweimal ausgewählt\. Ist es dasselbe Album, nimm eins heraus\.$/)]);
    updateAlbum(session.value.albums.find((a) => a.title === 'Bibi und Tina 1')!.id, { title: 'Bibi & Tina 1' });
    expect(doubles(session.value, card.value!.catalog).map((p) => p.text)).toContain('„Bibi & Tina 1“ ist schon in Ordner 01 auf der Karte. Ist es dasselbe Album, nimm es hier heraus.');
    // A folder that comes with the next Paket is not on the card yet.
    expect(doubles(session.value, card.value!.catalog, new Set([1])).map((p) => p.text)).toContain('„Bibi & Tina 1“ wartet schon als Ordner 01 im Paket. Ist es dasselbe Album, lasse es hier weg.');
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
  });
});

describe('finding the cover', SLOW, () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
  /** Two albums by their tags: the files themselves have none. */
  const twoAlbums = (sources: ByteSource[]) => new Map(sources.map((s, i) => [s, { album: i % 2 ? 'Bibi' : 'Benjamin', trackNo: i + 1 }]));
  const coverOf = async (title: string) => {
    const a = session.value.albums.find((x) => x.title === title);
    return a?.cover ? Array.from(a.cover.data) : undefined;
  };

  it('gives a loose photo to no album when the loose files make several', async () => {
    await useCard();
    const tracks = [memSource('1.mp3', monoMp3()), memSource('2.mp3', monoMp3())];
    await addSources([...tracks, memSource('Urlaub.jpg', jpeg)], { hints: twoAlbums(tracks) });
    expect(session.value.albums).toHaveLength(2);
    expect(await coverOf('Bibi')).toBeUndefined();
    expect(await coverOf('Benjamin')).toBeUndefined();
  });

  it('takes a loose photo for the one album the loose files make', async () => {
    await useCard();
    await addSources([memSource('1.mp3', monoMp3()), memSource('Bild.jpg', jpeg)]);
    expect(session.value.albums).toHaveLength(1);
    expect(session.value.albums[0].cover).toEqual({ data: jpeg, mimeType: 'image/jpeg' });
  });

  it('takes a cover file in a folder for its albums, any other picture only for one album alone there', async () => {
    await useCard();
    const tracks = [memSource('1.mp3', monoMp3(), 'Kassetten/1.mp3'), memSource('2.mp3', monoMp3(), 'Kassetten/2.mp3')];
    await addSources([...tracks, memSource('scan.png', png, 'Kassetten/scan.png')], { hints: twoAlbums(tracks) });
    expect(await coverOf('Bibi')).toBeUndefined();
    resetImport();
    await addSources([...tracks, memSource('scan.png', png, 'Kassetten/scan.png'), memSource('folder.jpg', jpeg, 'Kassetten/folder.jpg')], { hints: twoAlbums(tracks) });
    expect(await coverOf('Bibi')).toEqual(Array.from(jpeg));
    expect(await coverOf('Benjamin')).toEqual(Array.from(jpeg));
    resetImport();
    await addSources([memSource('1.mp3', monoMp3(), 'Bibi/1.mp3'), memSource('scan.png', png, 'Bibi/scan.png')]);
    expect(session.value.albums[0].cover).toEqual({ data: png, mimeType: 'image/png' });
  });

  it('lets „Ohne Bild“ stand when more files for the folder bring a picture', async () => {
    await useCard({ '01': { '001.mp3': monoMp3() } });
    resetImport(1);
    await addSources([memSource('1.mp3', monoMp3()), memSource('Bild.jpg', jpeg)]);
    const [a] = session.value.albums;
    expect(a.cover).toEqual({ data: jpeg, mimeType: 'image/jpeg' });
    expect(a.coverFrom).toBeUndefined();
    setCoverFor(a.id, undefined);
    expect(session.value.albums[0]).toMatchObject({ cover: undefined, noCover: true });
    await addSources([memSource('2.mp3', stereoMp3()), memSource('Noch ein Bild.png', png)]);
    expect(session.value.albums[0]).toMatchObject({ cover: undefined, noCover: true });
    expect(session.value.albums[0].tracks).toHaveLength(2);
    // A picture from the search says where it came from, for the credit line.
    setCoverFor(a.id, { data: png, mimeType: 'image/png' }, { source: 'iTunes', kind: 'cd' });
    expect(session.value.albums[0]).toMatchObject({ cover: { data: png }, coverFrom: { source: 'iTunes', kind: 'cd' }, noCover: false });
  });
});

describe('the progress of a transfer', () => {
  it('moves while an album is measured and while its files are made, and never back', () => {
    const bar = albumProgress(1000, 1000, PREPARE_SHARE);
    expect(bar.prepare(0)).toBe(1000);
    expect(bar.prepare(0.5)).toBe(1150);
    expect(bar.prepare(1)).toBe(1300);
    // The next step of the preparation starts at 0 again: the bar stays.
    expect(bar.prepare(0.2)).toBe(1300);
    expect(bar.files(0, 500)).toBe(1300);
    expect(bar.files(250, 500)).toBe(1650);
    expect(bar.files(500, 500)).toBe(2000);
    expect(bar.end).toBe(2000);
  });

  it('keeps a small part for the preparation when nothing is measured', () => {
    const short = { tracks: [{ source: memSource('a.mp3', new Uint8Array(1)), title: 'a', info: { durationSec: 60 } }], split: 'none' as const };
    const long = { tracks: [{ source: memSource('b.mp3', new Uint8Array(1)), title: 'b', info: { durationSec: 3600 } }], split: 'pauses' as const };
    expect(prepareShare(short, true)).toBe(PREPARE_SHARE);
    expect(prepareShare(short, false)).toBe(0.05);
    expect(prepareShare(long, false)).toBe(PREPARE_SHARE);
  });

  it('reaches every percent from start to end on the way through a converted album', SLOW, async () => {
    await useCard();
    await addSources([memSource('Lied.wav', wav(2)), memSource('Noch eins.wav', wav(2))]);
    const seen: number[] = [];
    const stop = session.subscribe((x) => {
      if (x.write) seen.push(x.write.bytesDone / x.write.bytesTotal);
    });
    await transfer();
    stop();
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1] - 1e-9)).toBe(true);
    // Not only 0 and then the end: steps in between, also while measuring.
    expect(seen.filter((v) => v > 0.01 && v < 0.99).length).toBeGreaterThan(2);
    expect(seen.some((v) => v > 0 && v <= PREPARE_SHARE + 1e-9)).toBe(true);
    expect(seen[seen.length - 1]).toBeCloseTo(1, 6);
  });
});

describe('transferring to the card', SLOW, () => {
  it('leaves out a file that cannot be converted and goes on with the other files and albums', async () => {
    const root = await useCard({}, backend({ broken: ['02 Kaputt.wav'] }));
    settings.value = { ...defaults, normalizeLoudness: false };
    await addSources([
      memSource('01.mp3', monoMp3(), 'A Erstes/01.mp3'),
      memSource('01.mp3', stereoMp3(), 'B Zweites/01.mp3'),
      memSource('02 Kaputt.wav', wav(1), 'B Zweites/02 Kaputt.wav'),
      memSource('03.mp3', monoMp3(), 'B Zweites/03.mp3'),
      memSource('01.mp3', stereoMp3(), 'C Drittes/01.mp3'),
    ]);
    expect(session.value.albums.map((a) => [a.title, a.target, a.tracks.length])).toEqual([
      ['A Erstes', 1, 1],
      ['B Zweites', 2, 3],
      ['C Drittes', 3, 1],
    ]);
    const r = await transfer();
    expect(r.error).toBeUndefined();
    expect(r.folders).toEqual([1, 2, 3]);
    // Named with its folder: every album has a "01".
    expect(r.skipped).toEqual([{ name: 'B Zweites/02 Kaputt.wav', reason: new AudioError('decode-failed').message }]);
    expect(r.rest).toEqual([]);
    expect(await filesIn(root, '02')).toEqual(['001.mp3', '002.mp3']);
    expect(titlesIn('02')).toEqual(['01', '03']);
    expect(await filesIn(root, '03')).toEqual(['001.mp3']);
  });

  it('removes a new folder again when its only file cannot be converted', async () => {
    const root = await useCard({}, backend({ broken: ['Buch.wav'] }));
    settings.value = { ...defaults, normalizeLoudness: false };
    await addSources([memSource('Buch.wav', wav(1))]);
    const r = await transfer();
    expect(await root.exists('01')).toBe(false);
    expect(r.folders).toEqual([]);
    expect(r.skipped.map((f) => f.name)).toEqual(['Buch.wav']);
  });

  it('removes a new folder again when the transfer is cancelled during its first file', async () => {
    const root = await useCard({}, backend({ slow: ['Buch.wav'] }));
    settings.value = { ...defaults, normalizeLoudness: false };
    await addSources([memSource('Buch.wav', wav(1))]);
    const stop = onWrite((w) => w.step === 'convert', () => queueMicrotask(cancelImport));
    const r = await transfer().finally(stop);
    expect(r.cancelled).toBe(true);
    expect(await root.exists('01')).toBe(false);
    expect(r.rest.map((a) => a.title)).toEqual(['Buch']);
  });

  it('keeps a file that could not be read out of the rest, also when nothing of its album arrived', async () => {
    await useCard({}, backend({ broken: ['01 Kaputt.wav'], slow: ['02 Lang.wav'] }));
    settings.value = { ...defaults, normalizeLoudness: false };
    await addSources([memSource('01 Kaputt.wav', wav(1), 'Album/01 Kaputt.wav'), memSource('02 Lang.wav', wav(1), 'Album/02 Lang.wav')]);
    const stop = onWrite((w) => w.track === 1 && w.step === 'convert', () => queueMicrotask(cancelImport));
    const r = await transfer().finally(stop);
    expect(r.cancelled).toBe(true);
    expect(r.skipped.map((f) => f.name)).toEqual(['Album/01 Kaputt.wav']);
    expect(r.rest.map((a) => [a.title, a.tracks.map((t) => t.title)])).toEqual([['Album', ['Lang']]]);
    expect(r.rest[0].durationSec).toBeCloseTo(1, 1);
  });

  // Earlier a stop took the parts of a long file off the card again, so that adding it again gave no title
  // twice. "Rest übertragen" now goes on after the parts on the card: the work stays, and still no title comes twice.
  it('goes on inside a long file after a stop, so the rest follows without titles twice', async () => {
    const book = longMp3();
    const durationSec = (await scanMp3(bufferSource(book))).durationSec;
    const root = await useCard({}, backend({ analyses: { '02 Buch.mp3': speech(durationSec, 270) } }));
    settings.value = { ...defaults, normalizeLoudness: false };
    await addSources([memSource('01 Vorwort.mp3', stereoMp3(), 'Hörbuch/01 Vorwort.mp3'), memSource('02 Buch.mp3', book, 'Hörbuch/02 Buch.mp3')]);
    expect(session.value.albums[0].split).toBe('pauses');

    // Cancelled while part 3 of the book is on its way: parts 1 and 2 stay on the card.
    const stop = onWrite((w) => w.track === 3, () => queueMicrotask(cancelImport));
    const r = await transfer().finally(stop);
    expect(r.cancelled).toBe(true);
    expect(await filesIn(root, '01')).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    expect(titlesIn('01')).toEqual(['Vorwort', 'Buch – Teil 1', 'Buch – Teil 2']);
    expect(r.partial).toEqual({ folder: 1, written: 3 });
    expect(r.rest.map((a) => [a.target, a.append, a.tracks.map((t) => t.title)])).toEqual([[1, true, ['Buch']]]);
    expect([...(r.rest[0].resume?.parts.values() ?? [])]).toEqual([{ done: 2, of: 5, files: ['002.mp3', '003.mp3'] }]);
    expect(resultNotes(r)).toEqual(['Kein Album ist ganz angekommen. In Ordner 01 sind 3 Titel angekommen.', 'Noch nicht auf der Karte: 1 Datei für Ordner 01. Mit „Rest übertragen“ holst du das nach.']);

    resumeImport();
    expect(session.value.phase).toBe('review');
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
    expect(trackCountOf(session.value.albums[0])).toEqual({ count: 3, exact: true });
    const again = await transfer();
    expect(again).toMatchObject({ folders: [1], refused: [], skipped: [], rest: [] });
    expect(again.error).toBeUndefined();
    expect(await filesIn(root, '01')).toEqual(['001.mp3', '002.mp3', '003.mp3', '004.mp3', '005.mp3', '006.mp3']);
    expect(titlesIn('01')).toEqual(['Vorwort', 'Buch – Teil 1', 'Buch – Teil 2', 'Buch – Teil 3', 'Buch – Teil 4', 'Buch – Teil 5']);
  });

  it('leaves out a long file that breaks between its parts, with all its parts', async () => {
    const book = longMp3();
    const durationSec = (await scanMp3(bufferSource(book))).durationSec;
    const root = await useCard({}, backend({ analyses: { '02 Buch.mp3': speech(durationSec, 270) } }));
    settings.value = { ...defaults, normalizeLoudness: false };
    let gone = false;
    const src = memSource('02 Buch.mp3', book, 'Hörbuch/02 Buch.mp3');
    const flaky: ByteSource = { ...src, read: (start, length) => (gone ? Promise.reject(new Error('Der USB-Stick ist weg.')) : src.read(start, length)) };
    await addSources([memSource('01 Vorwort.mp3', stereoMp3(), 'Hörbuch/01 Vorwort.mp3'), flaky, memSource('01.mp3', stereoMp3(), 'Lieder/01.mp3')]);
    expect(session.value.albums.map((a) => a.title)).toEqual(['Hörbuch', 'Lieder']);

    const stop = onWrite((w) => w.folder === 1 && w.track === 2, () => (gone = true));
    const r = await transfer().finally(stop);
    expect(r.error).toBeUndefined();
    expect(r.cancelled).toBeUndefined();
    expect(r.skipped.map((f) => f.name)).toEqual(['Hörbuch/02 Buch.mp3']);
    expect(await filesIn(root, '01')).toEqual(['001.mp3']);
    expect(titlesIn('01')).toEqual(['Vorwort']);
    expect(r.folders).toEqual([1, 2]);
    expect(await filesIn(root, '02')).toEqual(['001.mp3']);
  });

  it('refuses an album that gives more than 255 titles, goes on with the others and keeps it for another try', async () => {
    const root = await useCard({}, backend({ analyses: { 'Buch.flac': speech(72_000, 240) } }));
    settings.value = { ...defaults, normalizeLoudness: false };
    const book: DraftTrack = { source: memSource('Buch.flac', new Uint8Array(1000)), info: { codec: 'flac', durationSec: 72_000 }, title: 'Buch' };
    const song: DraftTrack = { source: memSource('Lied.mp3', monoMp3()), info: { codec: 'mp3', durationSec: 12 }, title: 'Lied' };
    session.value = {
      phase: 'review',
      rejected: [],
      albums: [
        { id: 'buch', title: 'Das lange Buch', kind: 'hoerbuch', tracks: [book], split: 'pauses', splitMinutes: 5, target: 1, append: false },
        { id: 'lieder', title: 'Lieder', kind: 'lieder', tracks: [song], split: 'none', splitMinutes: 5, target: 2, append: false },
      ],
    };
    // The review counts about 240 titles; the pauses only show when the book is measured.
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
    const tooMany = 'In Ordner 01 passen nur 255 Titel. Es wären 300. Wähle längere Titel beim Teilen.';
    const r = await transfer();
    expect(r.error).toBeUndefined();
    expect(r.refused).toEqual([{ title: 'Das lange Buch', reason: tooMany }]);
    expect(r.folders).toEqual([2]);
    expect(await root.exists('01')).toBe(false);
    expect(await filesIn(root, '02')).toEqual(['001.mp3']);
    expect(resultNotes(r)).toEqual([`„Das lange Buch“: ${tooMany}`, '1 Album ist angekommen.', 'Noch nicht auf der Karte: „Das lange Buch“. Mit „Rest übertragen“ holst du das nach.']);

    // Back in the review, the count is the real one until the length of the titles changes.
    resumeImport();
    expect(session.value.albums.map((a) => a.id)).toEqual(['buch']);
    expect(trackCountOf(session.value.albums[0])).toEqual({ count: 300, exact: true });
    expect(problems(session.value, card.value!.scan!).map((p) => p.text)).toEqual([tooMany]);
    updateAlbum('buch', { splitMinutes: 10 });
    expect(trackCountOf(session.value.albums[0])).toEqual({ count: 120, exact: false });
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
  });

  it('says what arrived in words that fit the numbers', () => {
    const r: ImportResult = { folders: [3], partial: { folder: 4, written: 1 }, cancelled: true, refused: [], skipped: [], rest: [], reordered: [] };
    expect(resultNotes(r)).toEqual(['1 Album ist angekommen. In Ordner 04 ist 1 Titel angekommen.']);
    expect(resultNotes({ ...r, folders: [3, 5], partial: { folder: 6, written: 3 } })).toEqual(['2 Alben sind angekommen. In Ordner 06 sind 3 Titel angekommen.']);
  });
});

describe('a folder whose files wait in the helper folder', SLOW, () => {
  // A change of folder 01 was interrupted: one title is still in the folder, the other waits in the helper folder.
  const interrupted = (): MemTree => ({ '01': { '001.mp3': monoMp3() }, [tempDirName(1)]: { umsortieren: {}, '002=002.mp3': monoMp3() } });
  const waiting = /^In Ordner 01 wurde eine frühere Änderung unterbrochen\. .*„Dateien zurücklegen“\. Danach kannst du das Album hinzufügen\.$/;

  it('takes no new titles before the files are back, and says what to do', async () => {
    const root = await useCard(interrupted());
    resetImport(1);
    await addSources([memSource('Neu.mp3', stereoMp3())]);
    const found = problems(session.value, card.value!.scan!);
    expect(found).toEqual([{ album: session.value.albums[0].id, text: expect.stringMatching(waiting), helper: true }]);
    // The button sits right below the text on the album card.
    expect(found[0].text).toContain('Tippe unten auf „Ansehen und reparieren“');

    // Also when the transfer starts anyway: nothing goes into the folder, and the album waits for another try.
    const r = await transfer();
    expect(r.refused).toEqual([{ title: 'Ordner 01', reason: expect.stringMatching(waiting) }]);
    // After the transfer there is no such button: the way goes through "Meine Box".
    expect(r.refused[0].reason).toContain('Tippe unter „Meine Box“ auf „Ansehen und reparieren“');
    expect(r.folders).toEqual([]);
    expect(await filesIn(root, '01')).toEqual(['001.mp3']);
    expect(await filesIn(root, tempDirName(1))).toEqual(['002=002.mp3', 'umsortieren']);
    expect(r.rest.map((a) => [a.target, a.append, a.tracks.map((t) => t.title)])).toEqual([[1, true, ['Neu']]]);
  });

  it('never gives a new album the number of such a folder', async () => {
    // The folder itself is gone for the moment: all of its files wait.
    await useCard({ [tempDirName(1)]: { umsortieren: {}, '001=001.mp3': monoMp3() } });
    await addSources([memSource('Lied.mp3', stereoMp3(), 'Lieder/Lied.mp3')]);
    expect(session.value.albums.map((a) => a.target)).toEqual([2]);
    expect(problems(session.value, card.value!.scan!)).toEqual([]);
  });
});
