import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { MAX_LIST_ENTRIES, MAX_LIST_FILE_BYTES, MAX_LISTS, parseTrackListFile, parseTrackListText } from '../../src/core/library/playlist/parse';

const utf8 = (s: string) => new TextEncoder().encode(s);

const item = (trackName: string, artistName: string, albumName = 'Album') => ({
  track: { trackName, artistName, albumName, trackUri: `spotify:track:${trackName.length}` },
  episode: null,
  audiobook: null,
  localTrack: null,
  addedDate: '2024-01-01',
});

async function zipOf(files: Record<string, unknown>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, typeof content === 'string' ? content : JSON.stringify(content));
  return zip.generateAsync({ type: 'uint8array' });
}

describe('Spotify data export', () => {
  it('reads every playlist of the ZIP, leaves out episodes and empty lists', async () => {
    const bytes = await zipOf({
      'Spotify Account Data/Playlist1.json': {
        playlists: [
          {
            name: 'Autofahrt',
            lastModifiedDate: '2024-05-01',
            items: [
              item('Yesterday', 'The Beatles'),
              { track: null, episode: { episodeName: 'Folge 1', showName: 'Podcast' }, audiobook: null, localTrack: null },
              { track: null, episode: null, audiobook: null, localTrack: null },
              item('Hey Jude', 'The Beatles'),
              { track: null, episode: null, audiobook: null, localTrack: { uri: 'spotify:local:Rolf+Zuckowski:Winterkinder:Schneefl%C3%B6ckchen:185' } },
            ],
          },
          { name: 'Leer', items: [] },
        ],
      },
      'Spotify Account Data/Playlist2.json': { playlists: [{ name: 'Schlafen', items: [item('Weißt du, wieviel Sternlein stehen', 'Kinderchor')] }] },
      'Spotify Account Data/YourLibrary.json': { tracks: [{ artist: 'Nena', album: '99 Luftballons', track: '99 Luftballons', uri: 'spotify:track:x' }], albums: [], shows: [] },
      'Spotify Account Data/Userdata.json': { username: 'x' },
      'Spotify Account Data/ReadMeFirst_AccountData.pdf': 'pdf',
    });
    const result = await parseTrackListFile('my_spotify_data.zip', bytes);
    expect(result.problem).toBeUndefined();
    expect(result.lists.map((l) => [l.name, l.origin, l.entries.length, l.skipped])).toEqual([
      ['Autofahrt', 'Spotify-Export', 3, 2],
      ['Schlafen', 'Spotify-Export', 1, 0],
      ['Lieblingssongs', 'Spotify-Export', 1, 0],
    ]);
    const [auto] = result.lists;
    expect(auto.id).toBe('Spotify Account Data/Playlist1.json#1');
    expect(auto.entries).toEqual([
      { position: 1, title: 'Yesterday', artists: ['The Beatles'], album: 'Album' },
      { position: 2, title: 'Hey Jude', artists: ['The Beatles'], album: 'Album' },
      { position: 3, title: 'Schneeflöckchen', artists: ['Rolf Zuckowski'], album: 'Winterkinder', durationSec: 185 },
    ]);
    expect(result.lists[2].entries[0]).toMatchObject({ title: '99 Luftballons', artists: ['Nena'], album: '99 Luftballons' });
  });

  it('reads a single JSON file of the export and tolerates other field names', async () => {
    const json = { playlists: [{ name: 'Mix', items: [{ track: { name: 'Lied', artist: 'Band', album: 'Platte', uri: 'spotify:track:1' } }] }] };
    const result = await parseTrackListFile('Playlist1.json', utf8(JSON.stringify(json)));
    expect(result.lists).toHaveLength(1);
    expect(result.lists[0].entries[0]).toEqual({ position: 1, title: 'Lied', artists: ['Band'], album: 'Platte' });
  });

  it('says why a ZIP without playlists is of no use', async () => {
    const history = await zipOf({ 'Spotify Extended Streaming History/Streaming_History_Audio_2023.json': [{ ts: '2023' }] });
    expect((await parseTrackListFile('history.zip', history)).problem).toMatch(/Kontodaten/);
    const other = await zipOf({ 'readme.txt': 'hallo' });
    expect((await parseTrackListFile('foo.zip', other)).problem).toMatch(/keine Playlist/);
    const onlyEpisodes = await zipOf({ 'Playlist1.json': { playlists: [{ name: 'Pods', items: [{ track: null, episode: { episodeName: 'x' } }] }] } });
    expect((await parseTrackListFile('e.zip', onlyEpisodes)).problem).toMatch(/keine Lieder/);
    expect((await parseTrackListFile('kaputt.zip', utf8('PK\u0003\u0004 kaputt'))).problem).toMatch(/ZIP-Datei lässt sich nicht öffnen/);
  });

  it('keeps lists of files with the same name in different folders apart', async () => {
    const bytes = await zipOf({
      'a/Playlist1.json': { playlists: [{ name: 'X', items: [item('Eins', 'A')] }] },
      'b/Playlist1.json': { playlists: [{ name: 'Y', items: [item('Zwei', 'B')] }] },
    });
    const ids = (await parseTrackListFile('zwei.zip', bytes)).lists.map((l) => l.id);
    expect(ids).toEqual(['a/Playlist1.json#1', 'b/Playlist1.json#1']);
  });

  it('does not trust the size a ZIP states, and stops unpacking at the limit', async () => {
    const zip = new JSZip();
    // Compresses to almost nothing, unpacks to more than the limit.
    zip.file('Spotify Account Data/Playlist1.json', new Uint8Array(MAX_LIST_FILE_BYTES + 1024 * 1024).fill(0x20));
    zip.file('Spotify Account Data/Playlist2.json', JSON.stringify({ playlists: [{ name: 'Echt', items: [item('Lied', 'Band')] }] }));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    // Write a false size (100 bytes) into the headers, as a trap would.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i + 4 < bytes.length; i++) {
      const sig = view.getUint32(i, true);
      if (sig === 0x04034b50 && view.getUint32(i + 22, true) > 1e6) view.setUint32(i + 22, 100, true);
      if (sig === 0x02014b50 && view.getUint32(i + 24, true) > 1e6) view.setUint32(i + 24, 100, true);
    }
    const result = await parseTrackListFile('falle.zip', bytes);
    expect(result.lists.map((l) => l.name)).toEqual(['Echt']);
  });

  it('refuses a ZIP with thousands of files', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5001; i++) files[`x/${i}.json`] = '{}';
    expect((await parseTrackListFile('viele.zip', await zipOf(files))).problem).toMatch(/sehr viele Dateien/);
  });

  it('keeps at most a thousand lists', async () => {
    const json = { playlists: Array.from({ length: MAX_LISTS + 3 }, (_, i) => ({ name: `L${i}`, items: [item('Lied', 'Band')] })) };
    const result = await parseTrackListFile('Playlist1.json', utf8(JSON.stringify(json)));
    expect(result.lists).toHaveLength(MAX_LISTS);
    expect(result.omittedLists).toBe(3);
  });
});

describe('CSV', () => {
  it('reads an Exportify file: quoted cells, several artists in one cell, milliseconds', async () => {
    const csv = [
      '\uFEFF"Track URI","Track Name","Artist Name(s)","Album Name","Duration (ms)","ISRC"',
      '"spotify:track:1","Under Pressure","Queen,David Bowie","Hot Space","248440","GBUM71029604"',
      '"spotify:track:2","Hello, Goodbye","The Beatles","Magical Mystery Tour","210000",""',
      '"spotify:track:3","Say ""Hi""","Crosby\\, Stills & Nash","Album","200000",""',
      '',
    ].join('\r\n');
    const result = await parseTrackListFile('Meine Playlist.csv', utf8(csv));
    expect(result.lists).toHaveLength(1);
    const list = result.lists[0];
    expect(list).toMatchObject({ name: 'Meine Playlist', origin: 'CSV-Datei', skipped: 0 });
    expect(list.entries).toEqual([
      { position: 1, title: 'Under Pressure', artists: ['Queen', 'David Bowie'], album: 'Hot Space', durationSec: 248.44, isrc: 'GBUM71029604' },
      { position: 2, title: 'Hello, Goodbye', artists: ['The Beatles'], album: 'Magical Mystery Tour', durationSec: 210 },
      { position: 3, title: 'Say "Hi"', artists: ['Crosby, Stills & Nash'], album: 'Album', durationSec: 200 },
    ]);
  });

  it('reads a German table with semicolons and m:ss', async () => {
    const csv = 'Nr;Titel;Interpret;Länge\n1;Schneeflöckchen;Rolf Zuckowski;3:05\n2;;Niemand;1:00\n3;Lalelu;Heinz Rühmann;150\n';
    const result = await parseTrackListFile('lieder.csv', utf8(csv));
    expect(result.lists[0].entries).toEqual([
      { position: 1, title: 'Schneeflöckchen', artists: ['Rolf Zuckowski'], durationSec: 185 },
      { position: 2, title: 'Lalelu', artists: ['Heinz Rühmann'], durationSec: 150 },
    ]);
    expect(result.lists[0].skipped).toBe(1);
  });

  it('reads Windows text and tab-separated files', async () => {
    const latin1 = Uint8Array.from('Titel,Künstler\nGrüße,Band\n', (c) => c.charCodeAt(0));
    expect((await parseTrackListFile('alt.csv', latin1)).lists[0].entries[0]).toMatchObject({ title: 'Grüße', artists: ['Band'] });
    const tsv = 'Title\tArtist\nSong\tBand\n';
    expect((await parseTrackListFile('x.tsv', utf8(tsv))).lists[0].entries[0]).toMatchObject({ title: 'Song', artists: ['Band'] });
  });

  it('reads a table of one column without cutting titles at a comma', async () => {
    expect((await parseTrackListFile('a.csv', utf8('Titel\nHello, Goodbye\n'))).lists[0].entries[0]).toMatchObject({ title: 'Hello, Goodbye', artists: [] });
  });

  it('follows the separator Excel names in its first line', () => {
    const result = parseTrackListText('sep=;\nTitel;Künstler\nA, B;C\n', 'x.csv');
    expect(result.lists[0].entries).toEqual([{ position: 1, title: 'A, B', artists: ['C'] }]);
  });

  it('reads UTF-16 text as iTunes and Excel save it', async () => {
    const text = '\uFEFFName\tArtist\tTime\r\nHey Jude\tThe Beatles\t431\r\n';
    const le = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) [le[2 * i], le[2 * i + 1]] = [text.charCodeAt(i) & 0xff, text.charCodeAt(i) >> 8];
    const result = await parseTrackListFile('liste.txt', le);
    expect(result.lists[0].entries).toEqual([{ position: 1, title: 'Hey Jude', artists: ['The Beatles'], durationSec: 431 }]);
    const be = le.map((_, i) => le[i % 2 ? i - 1 : i + 1]);
    expect((await parseTrackListFile('liste.txt', be)).lists[0].entries[0].title).toBe('Hey Jude');
    // Without the mark, too.
    expect((await parseTrackListFile('liste.txt', le.subarray(2))).lists[0].entries[0].title).toBe('Hey Jude');
  });

  it('needs a title column', async () => {
    const result = await parseTrackListFile('zahlen.csv', utf8('a,b\n1,2\n'));
    expect(result.lists).toEqual([]);
    expect(result.problem).toMatch(/Spalte mit den Liedtiteln/);
  });
});

describe('M3U', () => {
  it('reads #EXTINF, the playlist name and file names', async () => {
    const m3u = [
      '#EXTM3U',
      '#PLAYLIST:Party',
      '#EXTINF:215,Queen - Bohemian Rhapsody',
      'C:\\Musik\\Queen\\01 Bohemian Rhapsody.mp3',
      '#EXTINF:-1 tvg-name="a, b",Radio Eins',
      'http://stream.example.org/live',
      'http://stream.example.org/other',
      '../Musik/Nena - 99 Luftballons.mp3',
      '/home/kind/Lieder/03_Der_Hexenbesen.flac',
    ].join('\n');
    const result = await parseTrackListFile('party.m3u8', utf8(m3u));
    const list = result.lists[0];
    expect(list).toMatchObject({ name: 'Party', origin: 'M3U-Playlist', skipped: 1 });
    expect(list.entries).toEqual([
      { position: 1, title: 'Bohemian Rhapsody', artists: ['Queen'], durationSec: 215, fileHint: '01 Bohemian Rhapsody.mp3', filePath: 'C:/Musik/Queen/01 Bohemian Rhapsody.mp3' },
      { position: 2, title: 'Radio Eins', artists: [] },
      { position: 3, title: '99 Luftballons', artists: ['Nena'], fileHint: 'Nena - 99 Luftballons.mp3', filePath: '../Musik/Nena - 99 Luftballons.mp3' },
      { position: 4, title: 'Der Hexenbesen', artists: [], fileHint: '03_Der_Hexenbesen.flac', filePath: '/home/kind/Lieder/03_Der_Hexenbesen.flac' },
    ]);
  });

  it('names a list without #PLAYLIST after the file', async () => {
    const result = await parseTrackListFile('Gute Nacht.m3u', utf8('a.mp3\r\nb.mp3\r\n'));
    expect(result.lists[0].name).toBe('Gute Nacht');
    expect(result.lists[0].entries.map((e) => e.title)).toEqual(['a', 'b']);
  });
});

describe('text', () => {
  it('reads "Artist - Title" lines and drops numbers, comments and blank lines', () => {
    const result = parseTrackListText('# Für die Fahrt\n1. Queen – Bohemian Rhapsody\n\n2) Nena — 99 Luftballons\n03 Lalelu\n  Rolf Zuckowski - Schneeflöckchen  \n');
    expect(result.lists).toHaveLength(1);
    expect(result.lists[0]).toMatchObject({ name: 'Eingefügte Liste', origin: 'Text', skipped: 0 });
    expect(result.lists[0].entries).toEqual([
      { position: 1, title: 'Bohemian Rhapsody', artists: ['Queen'] },
      { position: 2, title: '99 Luftballons', artists: ['Nena'] },
      { position: 3, title: 'Lalelu', artists: [] },
      { position: 4, title: 'Schneeflöckchen', artists: ['Rolf Zuckowski'] },
    ]);
  });

  it('keeps a number that belongs to the title', () => {
    expect(parseTrackListText('99 Luftballons').lists[0].entries[0].title).toBe('99 Luftballons');
    const numbered = parseTrackListText('1 Eins\n2 Zwei\n3 99 Luftballons');
    expect(numbered.lists[0].entries.map((e) => e.title)).toEqual(['Eins', 'Zwei', '99 Luftballons']);
    // Numbers that do not count up are part of the titles.
    expect(parseTrackListText('99 Luftballons\n3 Chinesen mit dem Kontrabass').lists[0].entries.map((e) => e.title)).toEqual([
      '99 Luftballons',
      '3 Chinesen mit dem Kontrabass',
    ]);
    expect(parseTrackListText('4 - Eins\n9 - Zwei').lists[0].entries.map((e) => e.title)).toEqual(['Eins', 'Zwei']);
  });

  it('stays quick with odd long lines', async () => {
    const start = performance.now();
    parseTrackListText(`a${' '.repeat(40000)}b\n${'x - '.repeat(5000)}y`);
    await parseTrackListFile('x.m3u', utf8(`#EXTM3U\n#EXTINF:${'1'.repeat(40000)}\nlied.mp3\n`));
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('repairs broken characters', () => {
    expect(parseTrackListText('Lied \ud83c').lists[0].entries[0].title).toBe('Lied \uFFFD');
  });

  it('takes a pasted table with a header as a table', () => {
    const result = parseTrackListText('Titel\tKünstler\nLalelu\tHeinz Rühmann');
    expect(result.lists[0]).toMatchObject({ origin: 'CSV-Datei', name: 'Eingefügte Liste' });
    expect(result.lists[0].entries[0]).toMatchObject({ title: 'Lalelu', artists: ['Heinz Rühmann'] });
  });

  it('names a .txt list after the file', async () => {
    const result = await parseTrackListFile('Lieder für Oma.txt', utf8('Lalelu\n'));
    expect(result.lists[0].name).toBe('Lieder für Oma');
  });

  it('explains what is wrong', async () => {
    expect(parseTrackListText('   \n ').problem).toMatch(/Füge zuerst/);
    expect(parseTrackListText('# nur ein Kommentar').problem).toMatch(/keine Titel/);
    expect(parseTrackListText('https://open.spotify.com/track/abc\nhttps://open.spotify.com/track/def').problem).toMatch(/Links/);
    expect((await parseTrackListFile('lied.mp3', utf8('ID3'))).problem).toMatch(/Lied, keine Titelliste/);
    expect((await parseTrackListFile('leer.txt', new Uint8Array(0))).problem).toMatch(/leer/);
    expect((await parseTrackListFile('kaputt.json', utf8('{"playlists": ['))).problem).toMatch(/beschädigt/);
  });
});

describe('limits', () => {
  it('refuses files over 50 MB', async () => {
    const big = new Uint8Array(MAX_LIST_FILE_BYTES + 1);
    const result = await parseTrackListFile('riesig.csv', big);
    expect(result.lists).toEqual([]);
    expect(result.problem).toMatch(/50 MB/);
  });

  it('keeps at most 10000 entries per list and counts the rest as skipped', () => {
    const lines = Array.from({ length: MAX_LIST_ENTRIES + 5 }, (_, i) => `Lied ${i + 1}`).join('\n');
    const list = parseTrackListText(lines).lists[0];
    expect(list.entries).toHaveLength(MAX_LIST_ENTRIES);
    expect(list.entries[MAX_LIST_ENTRIES - 1]).toMatchObject({ position: MAX_LIST_ENTRIES, title: `Lied ${MAX_LIST_ENTRIES}` });
    expect(list.skipped).toBe(5);
    expect(list.truncated).toBe(5);
  });
});
