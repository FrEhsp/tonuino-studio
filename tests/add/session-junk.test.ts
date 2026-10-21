/**
 * What the import cleans up and tells on its own: a Mac keeps a hidden twin
 * ("._001.mp3", AppleDouble) next to every file it writes to a FAT card, and
 * the box's MP3 player counts it as a title. The import removes the twins of
 * the files it wrote, lists the hidden files still in its folders and
 * removes exactly those on request. The done screen also says which files
 * the app made anew and which album stayed quieter.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { card, platform, settings } from '../../src/app/state';
import { bufferSource, createBrowserAudioBackend, scanMp3 } from '../../src/core/audio';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { scanSd } from '../../src/core/tonuino/sd';
import { addSources, albumBytesOf, cancelImport, cleanImportJunk, doneNotes, foldersWords, levelNote, rebuildNote, resetImport, unorderedNote, resumeImport, runImport, session, updateAlbum, type ImportResult } from '../../src/features/add/session';
import { memDir, memSource, type MemTree } from '../../src/platform/memory';
import type { ByteSource, Dir, DirEntry, Platform, VolumeInfo, WriteOptions } from '../../src/platform/types';
import { fakeWebCodecs } from '../audio/containers';
import { workers } from '../audio/fakeWorkers';
import { monoMp3, SR, stereoMp3 } from '../audio/fixtures';
import { concat, encodeMp3, synth } from '../audio/helpers';

const audio = createBrowserAudioBackend({ createWorker: workers({ webCodecs: fakeWebCodecs() }).create });
const defaults = settings.value;

/** A folder on a FAT card as a Mac writes to it: every file gets a hidden 4 KB twin. */
class MacDir implements Dir {
  constructor(readonly inner: Dir) {}
  get name(): string {
    return this.inner.name;
  }
  list(): Promise<DirEntry[]> {
    return this.inner.list();
  }
  async dir(name: string, opts?: { create?: boolean }): Promise<Dir> {
    return new MacDir(await this.inner.dir(name, opts));
  }
  exists(name: string): Promise<boolean> {
    return this.inner.exists(name);
  }
  read(name: string): Promise<Uint8Array> {
    return this.inner.read(name);
  }
  readRange(name: string, start: number, length: number): Promise<Uint8Array> {
    return this.inner.readRange(name, start, length);
  }
  source(name: string): Promise<ByteSource> {
    return this.inner.source(name);
  }
  async write(name: string, data: Uint8Array | Blob, opts?: WriteOptions): Promise<void> {
    await this.inner.write(name, data, opts);
    if (!name.startsWith('._')) await this.inner.write(`._${name}`, new Uint8Array(4096));
  }
  remove(name: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.inner.remove(name, opts);
  }
  async rename(from: string, to: string): Promise<void> {
    await this.inner.rename(from, to);
    if (await this.inner.exists(`._${from}`)) await this.inner.rename(`._${from}`, `._${to}`);
  }
  move(name: string, target: Dir, newName?: string): Promise<void> {
    return this.inner.move(name, target instanceof MacDir ? target.inner : target, newName);
  }
}

async function useCard(tree: MemTree = {}, info: VolumeInfo = {}): Promise<Dir> {
  const root = new MacDir(memDir(tree));
  platform.value = { kind: 'web', os: 'macos', audio, volumes: { info: async () => info } } as unknown as Platform;
  card.value = {
    volume: { id: 'sd', label: 'SD', root, info, canEject: false },
    status: 'ready',
    scan: await scanSd(root),
    catalog: newCatalog(),
    catalogOnCard: true,
    covers: new Map(),
    coverUrls: new Map(),
    info,
  };
  resetImport();
  return root;
}

async function namesIn(root: Dir, folder: string): Promise<string[]> {
  return (await (await root.dir(folder)).list()).map((e) => e.name).sort();
}

async function transfer(): Promise<ImportResult> {
  await runImport();
  expect(session.value.phase).toBe('done');
  return session.value.result!;
}

/** Bytes that never form a chain of frame headers. */
function garbage(n: number): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i % 89 === 0 ? 0xff : (i * 37 + 11) & 0x7f));
}

async function damagedMp3(): Promise<Uint8Array> {
  const mp3 = monoMp3();
  const at = (await scanMp3(bufferSource(mp3))).frameOffsets[200];
  return concat([mp3.subarray(0, at), garbage(5000), mp3.subarray(at)]);
}

afterEach(() => {
  settings.value = defaults;
});

const SLOW = { timeout: 30_000 };

describe('hidden twins of the written files', SLOW, () => {
  it('removes the twins of its own files and lists the hidden files it did not write', async () => {
    const root = await useCard({ '01': { '001.mp3': monoMp3(), '._notes.txt': 'vom Mac' } });
    resetImport(1);
    await addSources([memSource('Zwei.mp3', stereoMp3()), memSource('Drei.mp3', stereoMp3())]);
    const r = await transfer();
    expect(r.folders).toEqual([1]);
    expect(await namesIn(root, '01')).toEqual(['._notes.txt', '001.mp3', '002.mp3', '003.mp3']);
    // The catalog knows the titles, not the twins.
    expect(card.value!.catalog!.folders['01'].tracks.map((t) => t.file)).toEqual(['002.mp3', '003.mp3']);
    expect(card.value!.scan!.folders[0].tracks.map((t) => t.name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    // The file the app did not write stays until someone asks.
    expect(r.junk).toEqual(['01/._notes.txt']);
  });

  it('removes exactly the listed hidden files when asked', async () => {
    const root = await useCard({ '01': { '001.mp3': monoMp3(), '._notes.txt': 'vom Mac' }, '05': { '001.mp3': monoMp3(), '._001.mp3': 'alt' } });
    resetImport(1);
    await addSources([memSource('Zwei.mp3', stereoMp3())]);
    await transfer();
    expect(session.value.result!.junk).toEqual(['01/._notes.txt']);
    await cleanImportJunk();
    expect(session.value.result!.junk).toEqual([]);
    expect(await namesIn(root, '01')).toEqual(['001.mp3', '002.mp3']);
    // Another folder is not this transfer's business: the health check offers it.
    expect(await namesIn(root, '05')).toEqual(['._001.mp3', '001.mp3']);
  });
});

describe('order of the files in a folder with hidden files', SLOW, () => {
  it('leaves the titles where they are, says so, and puts them in order once the hidden files are gone', async () => {
    // Out of order on the card, and a hidden file the app did not write.
    const root = await useCard({ '01': { '002.mp3': monoMp3(), '001.mp3': monoMp3(), '._notes.txt': 'vom Mac' } });
    resetImport(1);
    await addSources([memSource('Drei.mp3', stereoMp3())]);
    const r = await transfer();
    expect(r.folders).toEqual([1]);
    expect(r.reordered).toEqual([]);
    expect(r.unordered).toEqual([1]);
    // Nothing went into a helper folder.
    const helpers = async () => (await root.list()).map((e) => e.name).filter((n) => n.includes('temp'));
    expect(await helpers()).toEqual([]);
    expect(await namesIn(root, '01')).toEqual(['._notes.txt', '001.mp3', '002.mp3', '003.mp3']);
    expect(unorderedNote(r)).toEqual({
      text: 'In Ordner 01 liegen die Titel auf der Karte nicht in der Reihenfolge ihrer Nummern. Die Box spielt sie dann durcheinander. Räume unten zuerst die versteckten Dateien auf. Dann ordne ich die Titel neu.',
      health: false,
    });
    await cleanImportJunk();
    const after = session.value.result!;
    expect(after.junk).toEqual([]);
    expect(after.reordered).toEqual([1]);
    expect(after.unordered).toEqual([]);
    expect(unorderedNote(after)).toBeUndefined();
    expect((await (await root.dir('01')).list()).map((e) => e.name)).toEqual(['001.mp3', '002.mp3', '003.mp3']);
    expect(await helpers()).toEqual([]);
  });

  it('sends the user to the health check when the order could not be fixed for another reason', () => {
    const r: ImportResult = { folders: [2, 7], refused: [], skipped: [], rest: [], reordered: [], unordered: [2, 7] };
    expect(unorderedNote(r)).toEqual({
      text: 'In den Ordnern 02 und 07 liegen die Titel auf der Karte nicht in der Reihenfolge ihrer Nummern. Die Box spielt sie dann durcheinander. Öffne „Meine Box“ und tippe auf „Ansehen und reparieren“. Dort bringe ich das in Ordnung.',
      health: true,
    });
  });

  it('names the folders it put in order as German lists them (done screen)', () => {
    expect(foldersWords([5])).toBe('Ordner 05');
    expect(foldersWords([48, 49])).toBe('den Ordnern 48 und 49');
    expect(foldersWords([3, 4, 7])).toBe('den Ordnern 03, 04 und 07');
  });
});

describe('notes after the transfer', SLOW, () => {
  it('tells which files the app made anew, and keeps that after „Rest übertragen“', async () => {
    await useCard();
    await addSources([
      memSource('01 Kaputt.mp3', await damagedMp3(), 'Erstes/01 Kaputt.mp3'),
      memSource('02 Gut.mp3', stereoMp3(), 'Erstes/02 Gut.mp3'),
      memSource('01 Lied.mp3', stereoMp3(), 'Zweites/01 Lied.mp3'),
    ]);
    const albums = session.value.albums;
    expect(albums).toHaveLength(2);
    const first = albums.find((a) => a.tracks.some((t) => t.title.includes('Kaputt')))!;
    expect(first.tracks.map((t) => t.info?.mp3Check?.rebuild)).toEqual(['damaged', undefined]);
    // Stop when the second album starts.
    const stop = session.subscribe((s) => {
      if (s.write && s.write.album === 1) cancelImport();
    });
    let r: ImportResult;
    try {
      r = await transfer();
    } finally {
      stop();
    }
    expect(r.cancelled).toBe(true);
    // „Gleiche Lautstärke“ is on by default: what it did to the album comes last.
    const level = { kind: 'level', title: first.title, folder: first.target, db: expect.any(Number) };
    expect(r.notes).toEqual([{ kind: 'rebuilt', reason: 'damaged', file: 'Erstes/01 Kaputt.mp3', folder: first.target }, level]);
    const texts = doneNotes(r).map((n) => n.text);
    expect(texts[0]).toBe('Eine beschädigte Datei hab ich neu erstellt. An kaputten Stellen kann die Box sonst hängen bleiben.');
    expect(texts[1]).toMatch(new RegExp(`^Gleiche Lautstärke: „${first.title}“ (passte schon|[\\d,]+\u00a0dB (leiser|lauter))\\.$`));
    expect(texts).toHaveLength(2);
    resumeImport();
    const after = await transfer();
    expect(after.cancelled).toBeFalsy();
    // The notes of the run before stay; the second album adds its loudness.
    expect(after.notes).toEqual([...r.notes!, expect.objectContaining({ kind: 'level', folder: albums.find((a) => a !== first)!.target })]);
  });

  it('says which album stayed quieter, and by how much', async () => {
    await useCard();
    settings.value = { ...defaults, normalizeLoudness: true, boostQuietMp3: false };
    const clicky = encodeMp3([synth(SR, [{ sec: 3, freq: 440, amp: 0.03 }, { sec: 0.05, freq: 1000, amp: 0.98 }])], SR, 64);
    await addSources([memSource('Leise.mp3', clicky)]);
    updateAlbum(session.value.albums[0].id, { title: 'Gute Nacht' });
    const r = await transfer();
    expect(r.notes).toHaveLength(2);
    // Louder by the whole steps it could take; the rest is the note about staying quieter.
    expect(r.notes![0]).toMatchObject({ kind: 'level', title: 'Gute Nacht', folder: 1 });
    expect(r.notes![1]).toMatchObject({ kind: 'quiet', title: 'Gute Nacht', folder: 1 });
    const [note, level] = doneNotes(r);
    expect(level.text).toMatch(/^Gleiche Lautstärke: „Gute Nacht“ /);
    expect(note.text).toMatch(/^„Gute Nacht“ ist etwa \d+\s?dB leiser geblieben als deine anderen Alben\. Ohne Umwandeln ging es nicht lauter, weil einzelne Stellen sonst übersteuern würden\. /);
    // What to do next, with the way there.
    expect(note.text).toContain('Mit „Leise MP3s lauter machen“ in den Einstellungen mache ich solche Alben lauter. Dafür löschst du auf der Seite von Ordner 01 die Titel');
    // This one lies further below than the largest boost: said honestly.
    const lack = r.notes![1].kind === 'quiet' ? r.notes![1] : undefined;
    expect(lack?.boostLeft).toBe(lack!.db - 12);
    expect(note.text).toMatch(new RegExp(`Es wird dann lauter, aber nicht ganz so laut wie die anderen: Es bliebe etwa ${lack!.db - 12}\u00a0dB leiser\.$`));
    expect(note).toMatchObject({ help: 'lautstaerke', settings: true, folder: 1 });
    // With the switch on, the album gets louder instead, and the done screen says so.
    resetImport();
    settings.value = { ...defaults, normalizeLoudness: true, boostQuietMp3: true };
    await addSources([memSource('Leise.mp3', clicky)]);
    updateAlbum(session.value.albums[0].id, { title: 'Gute Nacht' });
    const boosted = await transfer();
    expect(boosted.notes).toEqual([
      { kind: 'level', title: 'Gute Nacht', folder: 2, db: 12 },
      { kind: 'boosted', title: 'Gute Nacht', folder: 2, db: lack!.db - 12 },
    ]);
    expect(doneNotes(boosted)).toEqual([
      {
        text: `„Gute Nacht“ war sehr leise. Ich hab die MP3-Dateien lauter gemacht und dafür neu umgewandelt. Ganz so laut wie deine anderen Alben ist es trotzdem nicht: Es bleibt etwa ${lack!.db - 12}\u00a0dB leiser, weil ich höchstens um 12\u00a0dB anhebe.`,
        help: 'lautstaerke',
      },
      { text: 'Gleiche Lautstärke: „Gute Nacht“ 12\u00a0dB lauter.', help: 'lautstaerke' },
    ]);
  });

  it('gives the whole distance to the other albums, also beyond the largest boost', () => {
    const r: ImportResult = { folders: [4], refused: [], skipped: [], rest: [], reordered: [], notes: [{ kind: 'quiet', title: 'Flüstern', folder: 4, db: 22, boostLeft: 10 }] };
    expect(doneNotes(r)[0].text).toMatch(/^„Flüstern“ ist etwa 22\u00a0dB leiser geblieben/);
    expect(doneNotes(r)[0].text).toMatch(/ Es wird dann lauter, aber nicht ganz so laut wie die anderen: Es bliebe etwa 10\u00a0dB leiser\.$/);
    // No largest boost to subtract from the distance left after the lossless steps: the numbers would not add up.
    expect(doneNotes(r)[0].text).not.toContain('12\u00a0dB');
    // Within reach of the boost: no word about staying quieter.
    const near: ImportResult = { ...r, notes: [{ kind: 'quiet', title: 'Flüstern', folder: 4, db: 6 }] };
    expect(doneNotes(near)[0].text).toMatch(/neu hinzu\.$/);
    const boosted: ImportResult = { ...r, notes: [{ kind: 'boosted', title: 'Flüstern', folder: 4 }] };
    expect(doneNotes(boosted)[0].text).toBe('„Flüstern“ war sehr leise. Ich hab die MP3-Dateien lauter gemacht und dafür neu umgewandelt.');
  });

  it('says plainly which files were clipped before they came, and that a better source helps', () => {
    const base: ImportResult = { folders: [3], refused: [], skipped: [], rest: [], reordered: [] };
    const one = doneNotes({ ...base, notes: [{ kind: 'clipped', file: 'Download/Lied.wav', folder: 3 }] });
    expect(one).toEqual([
      {
        text: '„Download/Lied.wav“ ist schon übersteuert. Die lautesten Stellen sind darin abgeschnitten. Das kratzt auch am PC, und leiser machen hilft nicht. Eine bessere Quelle hilft, zum Beispiel die CD.',
        files: undefined,
        help: 'uebersteuert',
      },
    ]);
    const two = doneNotes({ ...base, notes: [{ kind: 'clipped', file: 'a.flac', folder: 3 }, { kind: 'clipped', file: 'b.flac', folder: 4 }] });
    expect(two[0].text).toMatch(/^2 Dateien sind schon übersteuert\. /);
    expect(two[0].files).toEqual(['a.flac', 'b.flac']);
  });

  it('tells in one line what „Gleiche Lautstärke“ did to each album', () => {
    expect(levelNote([])).toBeUndefined();
    expect(levelNote([{ title: 'Bibi', db: -3.1 }, { title: 'Conni', db: 1.5 }, { title: 'Pumuckl', db: 0.2 }])).toBe(
      'Gleiche Lautstärke: „Bibi“ 3\u00a0dB leiser, „Conni“ 1,5\u00a0dB lauter, „Pumuckl“ passte schon.',
    );
    // Many albums: counted instead of named.
    const many = [...Array(5).fill({ title: 'x', db: -4 }), ...Array(2).fill({ title: 'y', db: 3 }), { title: 'z', db: 0 }];
    expect(levelNote(many)).toBe('Gleiche Lautstärke: 5 Alben leiser gemacht, 2 lauter, 1 passte schon.');
    expect(levelNote(Array(7).fill({ title: 'y', db: 3 }))).toBe('Gleiche Lautstärke: 7 Alben lauter.');
  });

  it('names files joined from several files', () => {
    const r: ImportResult = {
      folders: [3],
      refused: [],
      skipped: [],
      rest: [],
      reordered: [],
      notes: [
        { kind: 'rebuilt', reason: 'joined', file: 'CD 1/Alles.mp3', folder: 3 },
        { kind: 'rebuilt', reason: 'joined', file: 'CD 2/Alles.mp3', folder: 3 },
        { kind: 'rebuilt', reason: 'damaged', file: 'a.mp3', folder: 3 },
        { kind: 'rebuilt', reason: 'damaged', file: 'b.mp3', folder: 3 },
      ],
    };
    expect(doneNotes(r)).toEqual([
      { text: '2 beschädigte Dateien hab ich neu erstellt. An kaputten Stellen kann die Box sonst hängen bleiben.', files: ['a.mp3', 'b.mp3'] },
      { text: 'Neu umgewandelt, weil aus mehreren Dateien zusammengesetzt: „CD 1/Alles.mp3“ und „CD 2/Alles.mp3“. Sonst kann die Box an den Nahtstellen aussetzen.', files: undefined },
    ]);
  });
});

describe('space on the card', SLOW, () => {
  it('stops an album that grows past the free space before writing it, and keeps it for „Rest übertragen“', async () => {
    const clicky = encodeMp3([synth(SR, [{ sec: 6, freq: 440, amp: 0.03 }, { sec: 0.05, freq: 1000, amp: 0.98 }])], SR, 64);
    settings.value = { ...defaults, normalizeLoudness: true, boostQuietMp3: true };
    // The review counts the MP3 at its size; made louder, it is converted and grows.
    const info: VolumeInfo = { totalBytes: 1 << 30 };
    const root = await useCard({}, info);
    await addSources([memSource('Leise.mp3', clicky)]);
    updateAlbum(session.value.albums[0].id, { title: 'Gute Nacht' });
    info.freeBytes = albumBytesOf(session.value.albums[0], settings.value.bitrateKbps) + 1000;
    card.value = { ...card.value!, info: { ...info } };
    const r = await transfer();
    expect(r.folders).toEqual([]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0].title).toBe('Gute Nacht');
    expect(r.refused[0].reason).toMatch(/^Auf der Karte ist nicht genug Platz\. Das Album braucht etwa .+, frei sind noch .+\. Ich mache die leisen MP3-Dateien lauter/);
    expect(r.rest.map((a) => a.title)).toEqual(['Gute Nacht']);
    expect((await root.list()).map((e) => e.name)).not.toContain('01');
    // With room enough it goes.
    info.freeBytes = 1 << 28;
    card.value = { ...card.value!, info: { ...info } };
    resumeImport();
    expect((await transfer()).folders).toEqual([1]);
  });
});

describe('the review before the transfer', () => {
  it('names the reason for each kind of file made anew', () => {
    const tail = ' Ich wandle sie neu um, damit die Box nicht hängen bleibt oder aussetzt.';
    expect(rebuildNote(1, 0)).toBe('Eine MP3-Datei ist beschädigt.' + tail);
    expect(rebuildNote(0, 2)).toBe('2 MP3-Dateien sind aus mehreren Dateien zusammengesetzt.' + tail);
    expect(rebuildNote(1, 1)).toBe('Eine MP3-Datei ist beschädigt, eine ist aus mehreren Dateien zusammengesetzt.' + tail);
    expect(rebuildNote(3, 2)).toBe('3 MP3-Dateien sind beschädigt, 2 sind aus mehreren Dateien zusammengesetzt.' + tail);
  });
});
