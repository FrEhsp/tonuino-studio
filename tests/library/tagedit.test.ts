import { describe, expect, it } from 'vitest';
import { buildSmallId3, parseId3v2, type BasicTags } from '../../src/core/audio/id3';
import {
  changedFiles,
  draftProblem,
  draftValid,
  folderNamesAfter,
  noteRetagged,
  recaseStart,
  settled,
  setFolderField,
  setTrackField,
  suggestTags,
  tagsFor,
  validTrackNumber,
  validYear,
  withLookup,
  type TagSource,
} from '../../src/core/library/tagedit';
import type { CatalogFolder } from '../../src/core/tonuino/catalog';

const src = (n: number, tags: BasicTags | undefined, extra: Partial<TagSource> = {}): TagSource => ({
  file: `${String(n).padStart(3, '0')}.mp3`,
  number: n,
  mp3: true,
  tags,
  title: tags?.title ?? `Titel ${n}`,
  untitled: !tags?.title,
  ...extra,
});

const tagsMap = (sources: TagSource[]) => new Map(sources.filter((s) => s.tags).map((s) => [s.file, s.tags!]));

describe('suggestTags', () => {
  it('takes downloader names off and marks what it filled in', () => {
    const sources = [1, 2, 3].map((n) =>
      src(n, { title: `SomeDownloader.com - Lied ${n}`, artist: 'Rolf Zuckowski', album: 'SomeDownloader.com - Igel sucht den Mond', track: String(n) }, { title: `Lied ${n}`, untitled: false }),
    );
    const d = suggestTags(sources, { title: 'Igel sucht den Mond', artist: 'Rolf Zuckowski' });
    expect(d.album).toEqual({ value: 'Igel sucht den Mond', auto: true });
    expect(d.artist).toEqual({ value: 'Rolf Zuckowski' });
    expect(d.tracks[0].title).toEqual({ value: 'Lied 1', auto: true });
    expect(d.tracks[0].track).toEqual({ value: '1' });
    expect(d.tracks.every((t) => t.artist === null && t.album === null && t.writable)).toBe(true);
  });

  it('takes the artist the folder page found, never a title from the artist field', () => {
    // A downloader put each song's title into its artist field.
    const sources = [1, 2, 3].map((n) => src(n, { title: `Song ${n}`, artist: `Song ${n}`, albumArtist: 'Die Eulen', album: 'Eulenlieder' }, { untitled: false }));
    const d = suggestTags(sources, { title: 'Eulenlieder', artist: 'Die Eulen' });
    expect(d.artist).toEqual({ value: 'Die Eulen', auto: true });
    expect(d.tracks.map((t) => t.artist)).toEqual([null, null, null]);
    const changes = changedFiles(d, tagsMap(sources));
    expect(changes.map((c) => c.tags.artist)).toEqual(['Die Eulen', 'Die Eulen', 'Die Eulen']);
  });

  it('keeps an own artist where a track really names another one', () => {
    const sources = [
      src(1, { title: 'A', artist: 'Rolf Zuckowski', album: 'X' }),
      src(2, { title: 'B', artist: 'Rolf Zuckowski und seine Freunde', album: 'X' }),
      src(3, { title: 'C', artist: 'Rolf Zuckowski', album: 'X' }),
    ];
    const d = suggestTags(sources, { title: 'X', artist: 'Rolf Zuckowski' });
    expect(d.tracks[1].artist).toEqual({ value: 'Rolf Zuckowski und seine Freunde' });
    expect(changedFiles(d, tagsMap(sources))).toEqual([
      // Only the missing track numbers are new.
      expect.objectContaining({ file: '001.mp3' }),
      expect.objectContaining({ file: '002.mp3' }),
      expect.objectContaining({ file: '003.mp3' }),
    ]);
    expect(tagsFor(d, 1, sources[1].tags).artist).toBe('Rolf Zuckowski und seine Freunde');
  });

  it('fills in missing numbers from the file, and the album from the folder name', () => {
    const sources = [src(1, {}), src(2, {})];
    const d = suggestTags(sources, { title: 'Sommerträume' });
    expect(d.album).toEqual({ value: 'Sommerträume', auto: true });
    expect(d.tracks.map((t) => t.track)).toEqual([
      { value: '1', auto: true },
      { value: '2', auto: true },
    ]);
    // A number is no name: nothing goes into the title.
    expect(d.tracks[0].title.value).toBe('');
    expect(d.tracks[0].guessed).toBe(true);
    expect(suggestTags(sources, { title: 'Ordner 05' }).album.value).toBe('');
  });

  it("uses the catalog's spelling of the same album", () => {
    const sources = [1, 2, 3].map((n) => src(n, { title: `T${n}`, album: 'Igel Sucht Den Mond', track: String(n) }));
    expect(suggestTags(sources, { title: 'Igel sucht den Mond' }).album).toEqual({ value: 'Igel sucht den Mond', auto: true });
  });

  it('also when the album says more than the folder name', () => {
    const sources = [1, 2].map((n) => src(n, { title: `T${n}`, album: 'SomeDownloader.com - Igel Sucht Den Mond (Musik-Hörspiel)', track: String(n) }));
    expect(suggestTags(sources, { title: 'Igel sucht den Mond' }).album.value).toBe('Igel sucht den Mond (Musik-Hörspiel)');
    expect(recaseStart('Igel Sucht Den Mond (Musik-Hörspiel)', 'Igel sucht den Mond')).toBe('Igel sucht den Mond (Musik-Hörspiel)');
    // Not in the middle of a word, and never a name that is not broken.
    expect(recaseStart('Igel Sucht Den Mondbox', 'Igel sucht den Mond')).toBe('Igel Sucht Den Mondbox');
    expect(recaseStart('The Sound Of Music', 'The sound')).toBe('The Sound Of Music');
  });

  it('leaves rare fields of each track alone when the tracks disagree', () => {
    const sources = [src(1, { title: 'A', year: '1999', genre: 'Hörspiel', track: '1' }), src(2, { title: 'B', year: '2001', genre: 'Hörspiel', track: '2' })];
    const d = suggestTags(sources, { title: 'X' });
    expect(d.year).toEqual({ value: '', mixed: true });
    expect(d.genre).toEqual({ value: 'Hörspiel' });
    expect(tagsFor(d, 0, sources[0].tags).year).toBe('1999');
    expect(tagsFor(d, 1, sources[1].tags).year).toBe('2001');
    const typed = setFolderField(d, 'year', '2005');
    expect(tagsFor(typed, 0, sources[0].tags).year).toBe('2005');
    expect(tagsFor(typed, 1, sources[1].tags).year).toBe('2005');
  });

  it('shows files it cannot change, without writing them', () => {
    const sources = [src(1, { title: 'A' }), { file: '002.wav', number: 2, mp3: false, title: 'B' }, src(3, undefined, { title: 'C', untitled: false })];
    const d = suggestTags(sources, { title: 'X' });
    expect(d.tracks.map((t) => t.writable)).toEqual([true, false, false]);
    expect(changedFiles(d, tagsMap(sources)).map((c) => c.file)).toEqual(['001.mp3']);
  });
});

describe('typing', () => {
  const sources = [src(1, { title: 'A', artist: 'X', album: 'Alb', track: '1' }), src(2, { title: 'B', artist: 'X', album: 'Alb', track: '2' })];
  const d = suggestTags(sources, { title: 'Alb', artist: 'X' });

  it('changes nothing until someone types', () => {
    expect(changedFiles(d, tagsMap(sources))).toEqual([]);
  });

  it('writes only the files whose infos change', () => {
    const t = setTrackField(d, 1, 'title', 'Bee');
    expect(t.tracks[1].title).toEqual({ value: 'Bee', edited: true });
    expect(changedFiles(t, tagsMap(sources))).toEqual([{ file: '002.mp3', tags: { title: 'Bee', artist: 'X', album: 'Alb', track: '2' } }]);
  });

  it('gives the artist of the folder to every track that has no own one', () => {
    const t = setFolderField(d, 'artist', 'Y');
    expect(changedFiles(t, tagsMap(sources)).map((c) => c.tags.artist)).toEqual(['Y', 'Y']);
    // An own artist, then the same as the folder's again: follows the folder.
    const own = setTrackField(t, 0, 'artist', 'Z');
    expect(own.tracks[0].artist).toEqual({ value: 'Z', edited: true });
    expect(setTrackField(own, 0, 'artist', 'Y').tracks[0].artist).toBeNull();
  });

  it('checks numbers and years', () => {
    expect(validTrackNumber('3')).toBe(true);
    expect(validTrackNumber('3/12')).toBe(true);
    expect(validTrackNumber('')).toBe(true);
    expect(validTrackNumber('drei')).toBe(false);
    expect(validYear('2024')).toBe(true);
    expect(validYear('24')).toBe(false);
    expect(draftValid(setTrackField(d, 0, 'track', 'x'))).toBe(false);
    expect(draftValid(setFolderField(d, 'year', '1990'))).toBe(true);
  });

  it('names what keeps it from saving: the year behind „Mehr“ first, then the first bad number', () => {
    expect(draftProblem(d)).toBeUndefined();
    const badNumber = setTrackField(d, 1, 'track', 'x');
    expect(draftProblem(badNumber)).toEqual({ field: 'track', file: d.tracks[1].file });
    expect(draftProblem(setFolderField(badNumber, 'year', '20x5'))).toEqual({ field: 'year' });
  });
});

describe('tagsFor', () => {
  it('keeps the CD number and the credit the file had', () => {
    const current: BasicTags = {
      title: 'A',
      disc: '2',
      comment: 'Gelesen von Eva',
      copyright: '2026 Deutschlandradio',
      copyrightUrl: 'https://example.org/lizenz',
      sourceUrl: 'https://example.org/folge',
    };
    const d = suggestTags([src(1, current)], { title: 'X' });
    expect(tagsFor(d, 0, current)).toEqual({
      title: 'A',
      album: 'X',
      track: '1',
      disc: '2',
      comment: 'Gelesen von Eva',
      copyright: '2026 Deutschlandradio',
      copyrightUrl: 'https://example.org/lizenz',
      sourceUrl: 'https://example.org/folge',
    });
  });

  it('drops numbers iTunes keeps in the comment', () => {
    const current: BasicTags = { title: 'A', comment: ' 00000A2B 00000C1D 0000F3E2' };
    expect(tagsFor(suggestTags([src(1, current)], {}), 0, current).comment).toBeUndefined();
  });

  it('round-trips through the small ID3 writer, with the new frames', () => {
    const current: BasicTags = {
      title: 'Gute Nacht',
      artist: 'Eva',
      albumArtist: 'Verschiedene',
      album: 'Schlaflieder',
      track: '3/12',
      year: '2019',
      genre: 'Hörspiel',
      copyright: '2026 Radio',
      copyrightUrl: 'https://example.org/l',
      sourceUrl: 'https://example.org/s',
    };
    const tags = tagsFor(suggestTags([src(3, current)], { title: 'Schlaflieder', artist: 'Eva' }), 0, current);
    const parsed = parseId3v2(buildSmallId3(tags))!;
    expect(parsed.version).toBe(3);
    expect(parsed.tags).toEqual(current);
  });
});

describe('settled', () => {
  it('drops the marks of files just written, and only theirs', () => {
    const d = suggestTags([src(1, {}), src(2, {})], { title: 'X' });
    const s = settled(d, new Set(['001.mp3']));
    expect(s.tracks[0].track.auto).toBe(false);
    expect(s.tracks[1].track.auto).toBe(true);
  });
});

describe('withLookup', () => {
  const sources = [src(1, {}), src(2, { title: 'Igel Sucht Den Mond' }, { untitled: false }), src(3, { title: 'Eigener Name' }, { untitled: false })];
  const found = { album: 'Igel sucht den Mond', artist: 'Igel', tracks: [{ title: 'Intro' }, { title: 'Igel sucht den Mond' }, { title: 'Der Mond' }] };

  it('names tracks without a name, fixes broken spelling, keeps real names', () => {
    const d = suggestTags(sources, { title: 'Igel Sucht Den Mond' });
    const r = withLookup(d, found);
    expect(r.draft.tracks.map((t) => t.title.value)).toEqual(['Intro', 'Igel sucht den Mond', 'Eigener Name']);
    expect(r.titles).toBe(2);
    expect(r.draft.album).toEqual({ value: 'Igel sucht den Mond', auto: true });
    expect(r.draft.artist).toEqual({ value: 'Igel', auto: true });
  });

  it('leaves typed fields and a list of another length alone', () => {
    const d = setTrackField(suggestTags(sources, { title: 'Igel Sucht Den Mond' }), 0, 'title', 'Mein Intro');
    expect(withLookup(d, found).draft.tracks[0].title.value).toBe('Mein Intro');
    expect(withLookup(d, { ...found, tracks: found.tracks.slice(1) }).titles).toBe(0);
  });
});

describe('the catalog after saving', () => {
  const entry = (): CatalogFolder => ({
    title: 'Igel',
    artist: 'Alt',
    tracks: [
      { file: '001.mp3', title: 'Titel 1', titleAuto: true, size: 100 },
      { file: '002.mp3', title: 'B', size: 200 },
    ],
    fingerprint: '2:300',
    addedAt: 0,
    updatedAt: 0,
  });

  it('notes titles, sizes and the fingerprint, so nothing looks changed elsewhere', () => {
    const e = entry();
    noteRetagged(e, [{ file: '001.mp3', oldSize: 100, size: 140, title: 'Intro' }], { fingerprint: { before: '2:300', after: '2:340' } });
    expect(e.tracks[0]).toEqual({ file: '001.mp3', title: 'Intro', size: 140 });
    expect(e.fingerprint).toBe('2:340');
    expect(e.title).toBe('Igel');
    expect(e.artist).toBe('Alt');
  });

  it('keeps a folder marked that was changed elsewhere before', () => {
    const e = entry();
    noteRetagged(e, [{ file: '002.mp3', oldSize: 200, size: 210, title: '' }], { fingerprint: { before: '3:900', after: '3:910' } });
    expect(e.fingerprint).toBe('2:300');
    expect(e.tracks[1].title).toBeUndefined();
    expect(e.tracks[1].size).toBe(210);
  });

  it('names the folder after a typed album only when it was named after the album', () => {
    const sources = [src(1, { title: 'A', album: 'Igel', artist: 'Alt' })];
    const start = suggestTags(sources, { title: 'Igel', artist: 'Alt' });
    expect(folderNamesAfter('Igel', start, start)).toEqual({});
    const typed = setFolderField(setFolderField(start, 'album', 'Igel sucht den Mond'), 'artist', 'Neu');
    expect(folderNamesAfter('Igel', start, typed)).toEqual({ title: 'Igel sucht den Mond', artist: 'Neu' });
    expect(folderNamesAfter('Mein Lieblingsalbum', start, typed)).toEqual({ artist: 'Neu' });
    expect(folderNamesAfter('Ordner 07', start, typed).title).toBe('Igel sucht den Mond');
    expect(folderNamesAfter('Igel', start, setFolderField(start, 'artist', ''))).toEqual({ artist: null });
  });
});
