/** "Nach einer Playlist zusammenstellen": from a track list and the user's own files to the import, with the platform and the import faked. */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { groupIntoAlbums } from '../../src/core/library/grouping';
import { applyHints } from '../../src/core/library/hints';
import { parseTrackListText } from '../../src/core/library/playlist/parse';
import { AUDIO_EXTENSIONS, type TrackInfo } from '../../src/core/library/tags';
import { memSource } from '../../src/platform/memory';
import type { ByteSource, PickFilesOptions } from '../../src/platform/types';
import type { AddOptions, AddResult } from '../../src/features/add/session';
import { createPlaylistImport, handOverPlan, missingFileName, missingListText, rowsOf, summaryText, VARIOUS_ARTISTS, type PlaylistDeps } from '../../src/features/playlist/state';

const enc = new TextEncoder();

function audio(name: string, relativePath?: string): ByteSource {
  return memSource(name, new Uint8Array(64), relativePath);
}

function textFile(name: string, text: string): ByteSource {
  return memSource(name, enc.encode(text));
}

/** Waits until `ready` holds (the matching takes a few turns of the event loop). */
async function until(ready: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}

const LIST = ['1. Rolf Zuckowski - Wie schön, dass du geboren bist', '2. Detlev Jöcker - 1, 2, 3 im Sauseschritt', '3. Die Ärzte - Zu spät', '4. Rolf Zuckowski - Wie schön, dass du geboren bist', '5. Nena - 99 Luftballons'].join('\n');

/** The user's music: tags for three of the songs, one with an unsure title, plus a picture. */
const TAGS: Record<string, TrackInfo> = {
  '07 Geburtstag.mp3': { title: 'Wie schön, dass du geboren bist', artist: 'Rolf Zuckowski', durationSec: 180 },
  'Sauseschritt.mp3': { title: '1, 2, 3 im Sauseschritt', artist: 'Detlev Jöcker', durationSec: 150 },
  'Zu spaet.flac': { title: 'Zu spät', artist: 'Die Ärzte', durationSec: 200 },
};

function setup(patch: Partial<PlaylistDeps> = {}) {
  const picks: PickFilesOptions[] = [];
  /** What the next pickFiles call returns. */
  const next: ByteSource[][] = [];
  const added: { sources: ByteSource[]; opts: AddOptions }[] = [];
  const read: string[] = [];
  const deps: PlaylistDeps = {
    pickFiles: async (opts) => {
      picks.push(opts);
      return next.shift() ?? [];
    },
    readTrackInfo: async (source) => {
      read.push(source.name);
      const info = TAGS[source.name];
      if (!info) throw new Error('no tags');
      return info;
    },
    addSources: async (sources, opts): Promise<AddResult> => {
      added.push({ sources, opts });
      return { accepted: sources.length, rejected: [] };
    },
    ...patch,
  };
  return { p: createPlaylistImport(deps), picks, next, added, read };
}

const MUSIC = () => [audio('07 Geburtstag.mp3', 'Musik/07 Geburtstag.mp3'), audio('Sauseschritt.mp3', 'Musik/Sauseschritt.mp3'), audio('Zu spaet.flac', 'Musik/Zu spaet.flac'), audio('cover.jpg', 'Musik/cover.jpg')];

/** A list and the music, matched. */
async function matched() {
  const t = setup();
  expect(t.p.readPasted(LIST)).toBeUndefined();
  t.next.push(MUSIC());
  await t.p.addLibrary(true);
  await until(() => !!t.p.matches.value && !t.p.matching.value);
  return t;
}

describe('the list', () => {
  it('reads pasted titles and goes on with the one list', () => {
    const { p } = setup();
    p.pasted.value = LIST;
    expect(p.readPasted()).toBeUndefined();
    expect(p.list.value?.name).toBe('Eingefügte Liste');
    expect(p.list.value?.entries.map((e) => e.title)).toEqual(['Wie schön, dass du geboren bist', '1, 2, 3 im Sauseschritt', 'Zu spät', 'Wie schön, dass du geboren bist', '99 Luftballons']);
    // The text stays: after "Andere Liste" a typo can be put right.
    expect(p.pasted.value).toBe(LIST);
    p.clearList();
    expect(p.pasted.value).toBe(LIST);
    expect(p.started.value).toBe(false);
    p.readPasted();
    expect(p.started.value).toBe(true);
    // Starting over empties it.
    p.reset();
    expect(p.pasted.value).toBe('');
  });

  it('says to wait when pasting while the music is read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { p, next } = setup({
      readTrackInfo: async () => {
        await gate;
        return {};
      },
    });
    next.push([audio('a.mp3')]);
    const reading = p.addLibrary(false);
    await until(() => !!p.reading.value);
    expect(p.readPasted(LIST)).toMatch(/Warte kurz/);
    expect(p.lists.value).toEqual([]);
    release();
    await reading;
  });

  it('says what to do with an empty field and keeps what was there', () => {
    const { p } = setup();
    p.pasted.value = '   \n';
    expect(p.readPasted()).toMatch(/Füge zuerst/);
    expect(p.lists.value).toEqual([]);
    expect(p.pasted.value).toBe('   \n');
  });

  it('reads a chosen file, offering only list formats', async () => {
    const { p, next, picks } = setup();
    next.push([textFile('Kindergeburtstag.csv', 'Titel;Interpret\nZu spät;Die Ärzte\n"99 Luftballons";Nena\n')]);
    await p.pickList();
    expect(picks[0]).toEqual({ multiple: false, extensions: ['zip', 'json', 'csv', 'tsv', 'm3u', 'm3u8', 'txt'] });
    expect(p.listLoad.value).toEqual({ status: 'idle' });
    expect(p.list.value?.name).toBe('Kindergeburtstag');
    expect(p.list.value?.entries.map((e) => [e.title, e.artists])).toEqual([
      ['Zu spät', ['Die Ärzte']],
      ['99 Luftballons', ['Nena']],
    ]);
  });

  it('lets the user choose among the playlists of a Spotify export', async () => {
    const { p, next } = setup();
    const playlist = (name: string, ...titles: string[]) => ({ name, items: titles.map((trackName) => ({ track: { trackName, artistName: 'Nena', albumName: 'Nena', trackUri: 'spotify:track:x' } })) });
    next.push([textFile('Playlist1.json', JSON.stringify({ playlists: [playlist('Autofahrt', '99 Luftballons', 'Irgendwie, irgendwo, irgendwann'), playlist('Einschlafen', 'Leuchtturm')] }))]);
    await p.pickList();
    expect(p.lists.value.map((l) => [l.name, l.entries.length])).toEqual([
      ['Autofahrt', 2],
      ['Einschlafen', 1],
    ]);
    expect(p.list.value).toBeUndefined();
    p.chooseList(p.lists.value[1].id);
    expect(p.list.value?.name).toBe('Einschlafen');
    // Back to the choice, the lists stay.
    p.chooseList(undefined);
    expect(p.list.value).toBeUndefined();
    expect(p.lists.value).toHaveLength(2);
  });

  it('keeps everything when the user cancels the file chooser', async () => {
    const { p, next } = setup();
    p.readPasted(LIST);
    next.push([]);
    await p.pickList();
    expect(p.list.value?.entries).toHaveLength(5);
    expect(p.listLoad.value.status).toBe('idle');
  });

  it('refuses files that are no list, in words for the user', async () => {
    const { p, next } = setup();
    next.push([textFile('leer.txt', '')]);
    await p.pickList();
    expect(p.listLoad.value).toEqual({ status: 'failed', message: expect.stringMatching(/leer/) });
    expect(p.lists.value).toEqual([]);
  });

  it('does not read a huge file at all', async () => {
    const { p, next } = setup();
    const huge: ByteSource = {
      name: 'Kontodaten.zip',
      size: 60 * 1024 * 1024,
      read: () => Promise.reject(new Error('must not be read')),
    };
    next.push([huge]);
    await p.pickList();
    expect(p.listLoad.value).toEqual({ status: 'failed', message: expect.stringMatching(/größer als 50 MB/) });
  });

  it('says so when choosing failed', async () => {
    const { p } = setup({ pickFiles: () => Promise.reject(new Error('kaputt')) });
    await p.pickList();
    expect(p.listLoad.value).toEqual({ status: 'failed', message: expect.stringMatching(/Auswählen hat nicht geklappt/) });
  });

  it('takes list files dropped on the page, and leaves audio to the import', async () => {
    const { p } = setup();
    expect(await p.takeDrop([audio('a.mp3'), textFile('liste.txt', 'Lalelu')])).toBe(false);
    expect(await p.takeDrop([audio('cover.jpg')])).toBe(false);
    expect(await p.takeDrop([])).toBe(false);
    expect(p.lists.value).toEqual([]);
    // The unpacked Spotify export: several JSON files and a PDF.
    const playlist = (name: string) => ({ playlists: [{ name, items: [{ track: { trackName: 'Lalelu', artistName: 'Heinz Rühmann' } }] }] });
    const folder = [
      memSource('Playlist1.json', enc.encode(JSON.stringify(playlist('Eins'))), 'Spotify Account Data/Playlist1.json'),
      memSource('Playlist2.json', enc.encode(JSON.stringify(playlist('Zwei'))), 'Spotify Account Data/Playlist2.json'),
      memSource('Userdata.json', enc.encode('{"username":"x"}'), 'Spotify Account Data/Userdata.json'),
      memSource('ReadMeFirst.pdf', enc.encode('%PDF'), 'Spotify Account Data/ReadMeFirst.pdf'),
    ];
    expect(await p.takeDrop(folder)).toBe(true);
    expect(p.open.value).toBe(true);
    expect(p.dropped.value).toBe(1);
    await until(() => p.listLoad.value.status === 'idle' && p.lists.value.length > 0);
    expect(p.lists.value.map((l) => l.name)).toEqual(['Eins', 'Zwei']);
    expect(new Set(p.lists.value.map((l) => l.id)).size).toBe(2);
  });
});

describe('a ZIP dropped on the page', () => {
  async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [path, text] of Object.entries(files)) zip.file(path, text);
    return zip.generateAsync({ type: 'uint8array' });
  }
  const playlist = JSON.stringify({ playlists: [{ name: 'Eins', items: [{ track: { trackName: 'Lalelu', artistName: 'Heinz Rühmann' } }] }] });

  it('goes to the lists when it is a Spotify export', async () => {
    const { p } = setup();
    const zip = memSource('my_spotify_data.zip', await zipOf({ 'Spotify Account Data/Playlist1.json': playlist, 'Spotify Account Data/ReadMeFirst.pdf': '%PDF' }));
    expect(await p.takeDrop([zip])).toBe(true);
    await until(() => p.listLoad.value.status === 'idle' && p.lists.value.length > 0);
    expect(p.lists.value.map((l) => l.name)).toEqual(['Eins']);
  });

  it('goes to the import when it holds an album, or is no ZIP at all', async () => {
    const { p } = setup();
    const album = memSource('Bibi Blocksberg 12.zip', await zipOf({ 'Bibi/01.mp3': 'x', 'Bibi/cover.jpg': 'y', 'Bibi/info.json': '{}' }));
    expect(await p.takeDrop([album])).toBe(false);
    expect(await p.takeDrop([memSource('kaputt.zip', new Uint8Array(100))])).toBe(false);
    expect(await p.takeDrop([memSource('Bilder.zip', await zipOf({ 'a.jpg': 'x' }))])).toBe(false);
    expect(p.open.value).toBe(false);
    expect(p.listLoad.value).toEqual({ status: 'idle' });
  });
});

describe('the music', () => {
  it('reads the tags of the audio files only, and adds to them when chosen again', async () => {
    const { p, next, picks, read } = setup();
    next.push(MUSIC());
    await p.addLibrary(true);
    // The desktop app then only collects (and counts) the audio files of the folder.
    expect(picks[0]).toEqual({ multiple: true, directory: true, extensions: AUDIO_EXTENSIONS });
    expect(read.sort()).toEqual(['07 Geburtstag.mp3', 'Sauseschritt.mp3', 'Zu spaet.flac']);
    expect(p.library.value).toHaveLength(3);
    expect(p.reading.value).toBeUndefined();
    // Again with one known and one new file (without tags: the name still counts).
    next.push([audio('Zu spaet.flac', 'Musik/Zu spaet.flac'), audio('Nena - 99 Luftballons.mp3')]);
    await p.addLibrary(false);
    expect(picks[1].directory).toBe(false);
    expect(p.library.value.map((f) => f.source.name)).toEqual(['07 Geburtstag.mp3', 'Sauseschritt.mp3', 'Zu spaet.flac', 'Nena - 99 Luftballons.mp3']);
    expect(p.library.value[3].info).toBeUndefined();
  });

  it('passes on what the desktop app says about a folder it refused, and nothing on cancel', async () => {
    const refused = Object.assign(new Error('Der Ordner enthält zu viele Dateien. Wähle einen kleineren Ordner.'), { code: 'dialog:too-many-files' });
    const { p } = setup({ pickFiles: () => Promise.reject(refused) });
    await p.addLibrary(true);
    expect(p.libraryNote.value).toEqual({ tone: 'danger', text: 'Der Ordner enthält zu viele Dateien. Wähle einen kleineren Ordner.' });
    const cancelled = setup({ pickFiles: () => Promise.reject(new DOMException('weg', 'AbortError')) });
    await cancelled.p.addLibrary(true);
    expect(cancelled.p.libraryNote.value).toBeUndefined();
  });

  it('says when there is no music in what was chosen, or nothing new', async () => {
    const { p, next } = setup();
    next.push([audio('cover.jpg'), audio('notes.txt')]);
    await p.addLibrary(true);
    expect(p.libraryNote.value?.text).toMatch(/keine Musikdatei/);
    next.push([audio('Zu spaet.flac')]);
    await p.addLibrary(false);
    next.push([audio('Zu spaet.flac')]);
    await p.addLibrary(false);
    expect(p.libraryNote.value?.text).toMatch(/hab ich schon/);
    expect(p.library.value).toHaveLength(1);
  });

  it('stops reading when cancelled and keeps what it read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { p, next } = setup({
      readTrackInfo: async (source, opts) => {
        // The first file comes right away, the others wait for the cancel.
        if (calls++ > 0) {
          await gate;
          opts.signal.throwIfAborted();
        }
        return TAGS[source.name] ?? {};
      },
    });
    next.push(Array.from({ length: 10 }, (_, i) => (i === 0 ? audio('Zu spaet.flac') : audio(`Lied ${i}.mp3`))));
    const run = p.addLibrary(true);
    await until(() => (p.reading.value?.done ?? 0) >= 1 || calls > 1);
    expect(p.busy.value).toBe(true);
    p.cancelReading();
    release();
    await run;
    expect(p.reading.value).toBeUndefined();
    expect(p.library.value.map((f) => f.source.name)).toEqual(['Zu spaet.flac']);
    expect(p.libraryNote.value?.text).toMatch(/Abgebrochen/);
  });
});

describe('the result', () => {
  it('shows every entry in list order, with the repeated song left out', async () => {
    const { p } = await matched();
    const rows = p.rows.value;
    expect(rows.map((r) => [r.match.entry.position, r.status, r.chosen?.source.name])).toEqual([
      [1, 'gefunden', '07 Geburtstag.mp3'],
      [2, 'gefunden', 'Sauseschritt.mp3'],
      [3, 'gefunden', 'Zu spaet.flac'],
      [4, 'doppelt', undefined],
      [5, 'fehlt', undefined],
    ]);
    expect(rows[3].match.duplicateOf).toBe(1);
    expect(p.summary.value).toMatchObject({ total: 4, found: 3, check: 0, missing: 1, doubles: 1, taken: 3 });
    expect(summaryText(p.summary.value)).toBe('3 von 4 Titeln gefunden, 1 fehlt');
  });

  it('matches again when more music comes', async () => {
    const { p, next } = await matched();
    next.push([audio('Nena - 99 Luftballons.mp3')]);
    await p.addLibrary(false);
    await until(() => !p.matching.value);
    expect(p.rows.value[4].chosen?.source.name).toBe('Nena - 99 Luftballons.mp3');
    expect(p.summary.value.missing).toBe(0);
  });

  it('lets the user leave out an entry, or move a file to another entry', async () => {
    const { p } = await matched();
    const [first, second] = p.rows.value;
    p.choose(1, null);
    expect(p.rows.value[0].status).toBe('weggelassen');
    // The file stays choosable.
    expect(p.rows.value[0].options.map((o) => o.source)).toContain(first.chosen!.source);
    expect(summaryText(p.summary.value)).toBe('2 von 4 Titeln gefunden, 1 fehlt, 1 weggelassen');

    // The file of entry 2 for entry 1: entry 2 has none then.
    p.choose(1, second.chosen!);
    expect(p.rows.value[0]).toMatchObject({ status: 'gefunden', chosen: second.chosen });
    expect(p.rows.value[1].status).toBe('fehlt');
    expect(p.rows.value[1].chosen).toBeUndefined();
    // And back: entry 1 lets go of it.
    p.choose(2, second.chosen!);
    expect(p.rows.value[1].chosen).toBe(second.chosen);
    expect(p.picks.value.has(1)).toBe(false);
    expect(p.rows.value[0].chosen).toBe(first.chosen);
  });

  it('a guess stays a guess until the user confirms it', () => {
    const file = { source: audio('Geburtstag (live).mp3') };
    const other = { source: audio('Geburtstag.mp3') };
    const match = {
      entry: { position: 1, title: 'Wie schön, dass du geboren bist', artists: ['Rolf Zuckowski'] },
      quality: 'unsicher' as const,
      chosen: file,
      candidates: [
        { file, score: 0.7, reason: 'tags' as const },
        { file: other, score: 0.65, reason: 'tags' as const },
      ],
    };
    expect(rowsOf([match], new Map())[0]).toMatchObject({ status: 'pruefen', chosen: file, options: [file, other] });
    expect(rowsOf([match], new Map([[1, file]]))[0].status).toBe('gefunden');
    expect(rowsOf([match], new Map([[1, other]]))[0]).toMatchObject({ status: 'gefunden', chosen: other });
    expect(rowsOf([match], new Map([[1, null]]))[0]).toMatchObject({ status: 'weggelassen', chosen: undefined, options: [file, other] });
  });

  it('a new list starts without the choices made for the old one', async () => {
    const { p } = await matched();
    p.choose(1, null);
    p.readPasted('Die Ärzte - Zu spät');
    await until(() => !!p.matches.value && !p.matching.value);
    expect(p.picks.value.size).toBe(0);
    expect(p.rows.value.map((r) => r.status)).toEqual(['gefunden']);
  });

  it('writes the missing titles so the app can read them again', async () => {
    const { p } = await matched();
    const text = missingListText('Eingefügte Liste', p.rows.value);
    expect(text).toBe('# Fehlende Titel aus „Eingefügte Liste“\n\n1. Nena - 99 Luftballons\n');
    const again = parseTrackListText(text);
    expect(again.lists[0].entries.map((e) => [e.title, e.artists])).toEqual([['99 Luftballons', ['Nena']]]);
    expect(missingFileName('Auto: Hin/Rück?')).toBe('Fehlende Titel – Auto Hin Rück.txt');
    expect(missingFileName('')).toBe('Fehlende Titel.txt');
  });

  it('says so when nothing in the music fits', async () => {
    const t = setup();
    t.p.readPasted('Nena - 99 Luftballons');
    t.next.push([audio('Zu spaet.flac')]);
    await t.p.addLibrary(false);
    await until(() => !!t.p.matches.value && !t.p.matching.value);
    expect(t.p.summary.value).toMatchObject({ found: 0, check: 0, missing: 1, taken: 0 });
    expect(await t.p.take()).toBeUndefined();
    expect(t.added).toEqual([]);
  });
});

describe('handing over', () => {
  it('adds the files in list order, as one album numbered over the files taken', async () => {
    const { p, added } = await matched();
    // Entry 2 left out: entry 3 becomes number 2.
    p.choose(2, null);
    const result = await p.take();
    expect(result?.accepted).toBe(2);
    expect(added).toHaveLength(1);
    const { sources, opts } = added[0];
    expect(sources.map((s) => s.name)).toEqual(['07 Geburtstag.mp3', 'Zu spaet.flac']);
    expect(sources.map((s) => opts.hints?.get(s))).toEqual([
      { album: 'Eingefügte Liste', albumArtist: VARIOUS_ARTISTS, trackNo: 1, trackOf: 2, discNo: 1, discOf: 1 },
      { album: 'Eingefügte Liste', albumArtist: VARIOUS_ARTISTS, trackNo: 2, trackOf: 2, discNo: 1, discOf: 1 },
    ]);
    // The files keep their own titles and artists.
    for (const h of opts.hints!.values()) {
      expect(h).not.toHaveProperty('title');
      expect(h).not.toHaveProperty('artist');
    }
    // Done: the panel starts over.
    expect(p.lists.value).toEqual([]);
    expect(p.library.value).toEqual([]);
    expect(p.rows.value).toEqual([]);
    expect(p.started.value).toBe(false);
  });

  it('follows the order of the list, not the order of the files', async () => {
    const t = setup();
    t.p.readPasted(['Die Ärzte - Zu spät', 'Rolf Zuckowski - Wie schön, dass du geboren bist', 'Detlev Jöcker - 1, 2, 3 im Sauseschritt'].join('\n'));
    t.next.push(MUSIC());
    await t.p.addLibrary(true);
    await until(() => !!t.p.matches.value && !t.p.matching.value);
    await t.p.take();
    const { sources, opts } = t.added[0];
    expect(sources.map((s) => [s.name, opts.hints?.get(s)?.trackNo])).toEqual([
      ['Zu spaet.flac', 1],
      ['07 Geburtstag.mp3', 2],
      ['Sauseschritt.mp3', 3],
    ]);
  });

  it('keeps everything when the import took nothing, and says so', async () => {
    const { p, added } = await (async () => {
      const t = setup({ addSources: async () => ({ accepted: 0, rejected: [] }) });
      t.p.readPasted(LIST);
      t.next.push(MUSIC());
      await t.p.addLibrary(true);
      await until(() => !!t.p.matches.value && !t.p.matching.value);
      return t;
    })();
    await p.take();
    expect(added).toEqual([]);
    expect(p.addError.value).toMatch(/keine der Dateien lesen/);
    expect(p.adding.value).toBe(false);
    expect(p.rows.value).toHaveLength(5);
  });

  it('keeps everything when the import was discarded meanwhile', async () => {
    const t = setup({ addSources: async () => ({ accepted: 0, rejected: [], cancelled: true }) });
    t.p.readPasted(LIST);
    t.next.push(MUSIC());
    await t.p.addLibrary(true);
    await until(() => !!t.p.matches.value && !t.p.matching.value);
    expect((await t.p.take())?.cancelled).toBe(true);
    expect(t.p.addError.value).toBeUndefined();
    expect(t.p.library.value).toHaveLength(3);
  });

  it('says so when the import failed', async () => {
    const t = setup({ addSources: () => Promise.reject(new Error('kaputt')) });
    t.p.readPasted(LIST);
    t.next.push(MUSIC());
    await t.p.addLibrary(true);
    await until(() => !!t.p.matches.value && !t.p.matching.value);
    await t.p.take();
    expect(t.p.addError.value).toMatch(/Übernehmen hat nicht geklappt/);
    expect(t.p.busy.value).toBe(false);
  });

  it('keeps the list together as one album in list order, with the files from several albums and folders', () => {
    // Files of three albums in three folders, picked in another order than the list.
    const files = [
      { source: audio('03 Zu spät.flac', 'CDs/Die Ärzte/Debil/03 Zu spät.flac'), info: { title: 'Zu spät', artist: 'Die Ärzte', album: 'Debil', trackNo: 3 } },
      { source: audio('01 Geburtstag.mp3', 'CDs/Zuckowski/01 Geburtstag.mp3'), info: { title: 'Wie schön, dass du geboren bist', artist: 'Rolf Zuckowski', album: 'Rolfs Hitliste', trackNo: 1 } },
      { source: audio('Sauseschritt.mp3', 'Downloads/Sauseschritt.mp3'), info: { title: '1, 2, 3 im Sauseschritt', artist: 'Detlev Jöcker' } },
    ];
    const order = [files[1], files[2], files[0]];
    const rows = order.map((file, i) => ({
      match: { entry: { position: i + 1, title: file.info.title, artists: [file.info.artist] }, quality: 'sicher' as const, chosen: file, candidates: [] },
      status: 'gefunden' as const,
      chosen: file,
      options: [file],
    }));
    const plan = handOverPlan(rows, 'Geburtstag');
    // What the import does with the hints (see readSources in session.ts).
    const inputs = files.map((f) => ({ source: f.source, info: applyHints(f.info, plan.hints.get(f.source)) }));
    const albums = groupIntoAlbums(inputs);
    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({ title: 'Geburtstag', artist: VARIOUS_ARTISTS });
    expect(albums[0].tracks.map((t) => [t.title, t.info?.artist])).toEqual([
      ['Wie schön, dass du geboren bist', 'Rolf Zuckowski'],
      ['1, 2, 3 im Sauseschritt', 'Detlev Jöcker'],
      ['Zu spät', 'Die Ärzte'],
    ]);
  });

  it('puts a file in only once, even when chosen twice', () => {
    const file = { source: audio('a.mp3') };
    const entry = (position: number) => ({ position, title: `T${position}`, artists: [] });
    const rows = [1, 2].map((position) => ({
      match: { entry: entry(position), quality: 'sicher' as const, chosen: file, candidates: [] },
      status: 'gefunden' as const,
      chosen: file,
      options: [file],
    }));
    const plan = handOverPlan(rows, 'Liste');
    expect(plan.sources).toEqual([file.source]);
    expect(plan.hints.get(file.source)).toMatchObject({ trackNo: 1, trackOf: 1 });
  });
});
