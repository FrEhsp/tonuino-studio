import { describe, expect, it } from 'vitest';
import { memSource } from '../../src/platform/memory';
import { libraryNameInfo, matchTrackList, matchTrackListAsync, normalizeArtist, normalizeTitle } from '../../src/core/library/playlist/match';
import type { LibraryFile, ListEntry, TrackList } from '../../src/core/library/playlist/types';
import type { TrackInfo } from '../../src/core/library/tags';

const lib = (name: string, info?: TrackInfo, relativePath?: string): LibraryFile => ({ source: memSource(name, new Uint8Array(1), relativePath), info });

const listOf = (entries: Omit<ListEntry, 'position'>[]): TrackList => ({
  id: 't',
  name: 'Test',
  origin: 'Text',
  entries: entries.map((e, i) => ({ ...e, position: i + 1 })),
  skipped: 0,
});

const names = (files: LibraryFile[] = []) => files.map((f) => f.source.name);

describe('normalizing', () => {
  it('puts titles into a plain spelling without version notes', () => {
    expect(normalizeTitle('Hey Jude - Remastered 2015')).toBe('hey jude');
    expect(normalizeTitle('Yesterday (Remastered 2009)')).toBe('yesterday');
    expect(normalizeTitle('Song [Live] - Radio Edit')).toBe('song');
    expect(normalizeTitle('Mein Lied - Re-recorded - 2019 Remaster')).toBe('mein lied');
    expect(normalizeTitle('Hänsel und Gretel - Teil 1')).toBe('hansel und gretel teil 1');
    expect(normalizeTitle('Lose Yourself feat. Someone')).toBe('lose yourself');
    expect(normalizeTitle('Für Elise')).toBe('fur elise');
    expect(normalizeTitle('Weiße Weihnacht')).toBe('weisse weihnacht');
    expect(normalizeTitle("Don't Stop Me Now")).toBe('dont stop me now');
    expect(normalizeTitle('Rock & Roll')).toBe(normalizeTitle('Rock and Roll'));
    expect(normalizeTitle('Folge 12 (Die Mumie)')).toBe('folge 12 die mumie');
    expect(normalizeTitle('(I Can’t Get No) Satisfaction')).toBe('i cant get no satisfaction');
    expect(normalizeTitle('Let It Go - From "Frozen"')).toBe('let it go');
    expect(normalizeTitle('Song - Live at Wembley 1986')).toBe('song');
    expect(normalizeTitle('In Da Club (feat. 50 Cent)')).toBe('in da club');
  });

  it('keeps parts after a dash that belong to the name', () => {
    expect(normalizeTitle('Heidi - Folge 3: Heidi und das Original')).toBe('heidi folge 3 heidi und das original');
    expect(normalizeTitle('Heidi - Folge 7: Heidi hört Radio')).toBe('heidi folge 7 heidi hort radio');
    expect(normalizeTitle('Kapitel 2 - Ein Brief aus dem Zoo')).toBe('kapitel 2 ein brief aus dem zoo');
    expect(normalizeTitle('Live Forever - Live Forever')).toBe('live forever live forever');
    // Numbers in a bracket stay: "(Teil 2 - Live)" is another part than "(Teil 3 - Live)".
    expect(normalizeTitle('Hörspiel (Teil 2 - Live)')).toBe('horspiel teil 2');
  });

  it('stays quick with odd long titles', () => {
    const start = performance.now();
    normalizeTitle(`a${' '.repeat(40000)}b`);
    normalizeTitle(`${'x - '.repeat(10000)}Remastered`);
    libraryNameInfo(lib(`${'a '.repeat(20000)}b.mp3`));
    expect(performance.now() - start).toBeLessThan(300);
  });

  it('puts artists into a plain spelling', () => {
    expect(normalizeArtist('The Beatles')).toBe('beatles');
    expect(normalizeArtist('Simon & Garfunkel')).toBe(normalizeArtist('Simon and Garfunkel'));
    expect(normalizeArtist('Motörhead')).toBe('motorhead');
  });

  it('takes title and artist from tags or the file name', () => {
    expect(libraryNameInfo(lib('x.mp3', { title: 'Lied', artist: 'Band' }))).toEqual({ artist: 'Band', title: 'Lied' });
    expect(libraryNameInfo(lib('Nena - 99 Luftballons.mp3'))).toEqual({ artist: 'Nena', title: '99 Luftballons' });
    expect(libraryNameInfo(lib('01 - Intro.mp3'))).toEqual({ title: 'Intro' });
    expect(libraryNameInfo(lib('07 Queen - Under Pressure.mp3', { title: 'Track 07', albumArtist: 'Various Artists' }))).toEqual({ artist: 'Queen', title: 'Under Pressure' });
  });
});

describe('matchTrackList', () => {
  it('trusts the same recording code (ISRC) above all', () => {
    const files = [lib('a.mp3', { title: 'Ganz anders', artist: 'X', isrc: 'GB-UM7-10-29604' }), lib('b.mp3', { title: 'Under Pressure', artist: 'Queen' })];
    const [m] = matchTrackList(listOf([{ title: 'Under Pressure', artists: ['Queen', 'David Bowie'], isrc: 'GBUM71029604' }]), files);
    expect(m.quality).toBe('sicher');
    expect(m.chosen?.source.name).toBe('a.mp3');
    expect(m.candidates[0]).toMatchObject({ score: 1, reason: 'isrc' });
  });

  it('finds songs despite remaster notes, feat., accents and spelling', () => {
    const files = [
      lib('1.mp3', { title: 'Hey Jude', artist: 'The Beatles', durationSec: 431 }),
      lib('2.mp3', { title: 'Lose Yourself (feat. Someone)', artist: 'Eminem' }),
      lib('3.flac', { title: 'Schneeflöckchen, Weißröckchen', artist: 'Rolf Zuckowski' }),
      lib('4.mp3', { title: 'Mrs. Robinson', artist: 'Simon and Garfunkel' }),
    ];
    const matches = matchTrackList(
      listOf([
        { title: 'Hey Jude - Remastered 2015', artists: ['The Beatles'], durationSec: 425 },
        { title: 'Lose Yourself', artists: ['Eminem'] },
        { title: 'Schneeflockchen Weissrockchen', artists: ['Rolf Zuckowski'] },
        { title: 'Mrs Robinson', artists: ['Simon & Garfunkel'] },
      ]),
      files,
    );
    expect(matches.map((m) => [m.quality, m.chosen?.source.name])).toEqual([
      ['sicher', '1.mp3'],
      ['sicher', '2.mp3'],
      ['sicher', '3.flac'],
      ['sicher', '4.mp3'],
    ]);
  });

  it('matches one of several listed artists', () => {
    const files = [lib('a.mp3', { title: 'Under Pressure', artist: 'David Bowie' })];
    const [m] = matchTrackList(listOf([{ title: 'Under Pressure', artists: ['Queen', 'David Bowie'] }]), files);
    expect(m.quality).toBe('sicher');
  });

  it('asks about a live version when the list means the studio one', () => {
    const files = [lib('live.mp3', { title: 'Song (Live)', artist: 'Band' })];
    const [m] = matchTrackList(listOf([{ title: 'Song', artists: ['Band'] }]), files);
    expect(m.quality).toBe('unsicher');
    expect(m.chosen?.source.name).toBe('live.mp3');
  });

  it('prefers the studio version when both are there', () => {
    const files = [lib('live.mp3', { title: 'Song - Live', artist: 'Band' }), lib('studio.mp3', { title: 'Song', artist: 'Band' })];
    const [m] = matchTrackList(listOf([{ title: 'Song', artists: ['Band'] }]), files);
    expect(m.chosen?.source.name).toBe('studio.mp3');
    expect(names(m.candidates.map((c) => c.file))).toEqual(['studio.mp3', 'live.mp3']);
  });

  it('never mixes up episode numbers', () => {
    const files = [lib('a.mp3', { title: 'Folge 21: Die Mumie', artist: 'Bibi Blocksberg' }), lib('b.mp3', { title: 'Folge 12: Der Hexenbesen', artist: 'Bibi Blocksberg' })];
    const matches = matchTrackList(
      listOf([
        { title: 'Folge 12: Der Hexenbesen', artists: ['Bibi Blocksberg'] },
        { title: 'Folge 13: Der Hexenbesen', artists: ['Bibi Blocksberg'] },
        { title: 'Folge 21: Der Hexenbesen', artists: ['Bibi Blocksberg'] },
      ]),
      files,
    );
    expect(matches[0]).toMatchObject({ quality: 'sicher' });
    expect(matches[0].chosen?.source.name).toBe('b.mp3');
    expect(matches[1].quality).toBe('fehlt');
    expect(matches[1].chosen).toBeUndefined();
    // Same number, other subtitle: offered, not taken for sure.
    expect(matches[2].quality).not.toBe('sicher');
  });

  it('does not mix up episodes whose titles only differ after a dash', () => {
    const files = [lib('a.mp3', { title: 'Heidi - Folge 7: Heidi hört Radio', artist: 'Heidi' }), lib('b.mp3', { title: 'Heidi - Folge 3: Heidi und das Original', artist: 'Heidi' })];
    const matches = matchTrackList(
      listOf([
        { title: 'Heidi - Folge 3: Heidi und das Original', artists: ['Heidi'] },
        { title: 'Heidi - Folge 7: Heidi hört Radio', artists: ['Heidi'] },
      ]),
      files,
    );
    expect(matches.map((m) => [m.quality, m.chosen?.source.name, m.duplicateOf])).toEqual([
      ['sicher', 'b.mp3', undefined],
      ['sicher', 'a.mp3', undefined],
    ]);
  });

  it('tells chapters of different volumes apart by their album', () => {
    const files = [1, 2].flatMap((band) => [1, 2, 3].map((k) => lib(`${band}-${k}.mp3`, { title: `Kapitel ${k}`, artist: 'Sprecherin', album: `Band ${band}` })));
    const matches = matchTrackList(listOf([1, 2, 3].map((k) => ({ title: `Kapitel ${k}`, artists: ['Sprecherin'], album: 'Band 2' }))), files);
    expect(matches.map((m) => [m.quality, m.chosen?.source.name])).toEqual([
      ['sicher', '2-1.mp3'],
      ['sicher', '2-2.mp3'],
      ['sicher', '2-3.mp3'],
    ]);
  });

  it('still finds a song that the file has from another album', () => {
    const files = [lib('a.mp3', { title: 'Hey Jude', artist: 'The Beatles', album: '1' })];
    const [m] = matchTrackList(listOf([{ title: 'Hey Jude', artists: ['The Beatles'], album: 'Hey Jude (Single)' }]), files);
    expect(m.quality).toBe('sicher');
    // Two compilations with numbers are no series.
    const [c] = matchTrackList(listOf([{ title: 'Hey Jude', artists: ['The Beatles'], album: 'Bravo Hits 30' }]), [lib('b.mp3', { title: 'Hey Jude', artist: 'The Beatles', album: 'Now 45' })]);
    expect(c.quality).toBe('sicher');
  });

  it('settles a file name only when one file fits the path the list names', () => {
    const files = [
      lib('01.mp3', { title: 'Der Zoo brennt', artist: 'Benjamin Blümchen', durationSec: 900 }, 'Benjamin/Folge 3/01.mp3'),
      lib('01.mp3', { title: 'Kapitel 1', artist: 'Bibi Blocksberg', durationSec: 300 }, 'Bibi/Folge 12/01.mp3'),
    ];
    const [byPath] = matchTrackList(listOf([{ title: 'Kapitel 1', artists: ['Bibi Blocksberg'], durationSec: 300, fileHint: '01.mp3', filePath: 'Bibi/Folge 12/01.mp3' }]), files);
    expect(byPath).toMatchObject({ quality: 'sicher' });
    expect(byPath.chosen?.source.relativePath).toBe('Bibi/Folge 12/01.mp3');
    // Only "01.mp3": the tags decide.
    const [byTags] = matchTrackList(listOf([{ title: 'Kapitel 1', artists: ['Bibi Blocksberg'], durationSec: 300, fileHint: '01.mp3' }]), files);
    expect(byTags.chosen?.source.relativePath).toBe('Bibi/Folge 12/01.mp3');
    // Only "01.mp3" and nothing else to go by: the user checks.
    const [unsure] = matchTrackList(listOf([{ title: '01', artists: [], fileHint: '01.mp3' }]), files);
    expect(unsure.quality).toBe('unsicher');
    expect(unsure.candidates).toHaveLength(2);
  });

  it('gives each file to one entry only, the best pair first', () => {
    const files = [lib('one.mp3', { title: 'Intro', artist: 'Band A', durationSec: 60 })];
    const matches = matchTrackList(
      listOf([
        { title: 'Intro', artists: ['Band B'], durationSec: 200 },
        { title: 'Intro', artists: ['Band A'], durationSec: 60 },
      ]),
      files,
    );
    expect(matches[0].chosen).toBeUndefined();
    expect(matches[0].quality).toBe('fehlt');
    expect(matches[1].chosen?.source.name).toBe('one.mp3');
  });

  it('leaves out songs the list repeats, without counting them as missing', () => {
    const files = [lib('a.mp3', { title: 'Lalelu', artist: 'Heinz Rühmann' })];
    const matches = matchTrackList(
      listOf([
        { title: 'Lalelu', artists: ['Heinz Rühmann'] },
        { title: 'Was anderes', artists: ['X'] },
        { title: 'LaLeLu', artists: ['Heinz Ruhmann'] },
        { title: 'Lalelu (Live)', artists: ['Heinz Rühmann'] },
        { title: 'Anders', artists: ['Y'], isrc: 'DEAA11111111' },
        { title: 'Ganz anders', artists: ['Y'], isrc: 'DEAA11111111' },
      ]),
      files,
    );
    expect(matches.map((m) => m.duplicateOf)).toEqual([undefined, undefined, 1, undefined, undefined, 5]);
    expect(matches[2]).toMatchObject({ quality: 'fehlt', candidates: [] });
    expect(matches[2].chosen).toBeUndefined();
    expect(matches[0].chosen?.source.name).toBe('a.mp3');
  });

  it('does not take entries with the same title from other albums or files for repeats', () => {
    const files = [
      lib('BB012-01.mp3', undefined, 'BB/BB012-01.mp3'),
      lib('BB013-01.mp3', undefined, 'BB/BB013-01.mp3'),
      lib('01.mp3', undefined, 'Hörbuch/CD1/01.mp3'),
      lib('01.mp3', undefined, 'Hörbuch/CD2/01.mp3'),
    ];
    const matches = matchTrackList(
      listOf([
        { title: 'Teil 1', artists: ['Benjamin Blümchen'], fileHint: 'BB012-01.mp3' },
        { title: 'Teil 1', artists: ['Benjamin Blümchen'], fileHint: 'BB013-01.mp3' },
        { title: '01', artists: [], fileHint: '01.mp3', filePath: 'CD1/01.mp3' },
        { title: '01', artists: [], fileHint: '01.mp3', filePath: 'CD2/01.mp3' },
        { title: 'Kapitel 1', artists: ['Sprecherin'], album: 'Band 1' },
        { title: 'Kapitel 1', artists: ['Sprecherin'], album: 'Band 2' },
        { title: 'Kapitel 1', artists: ['Sprecherin'], album: 'Band 2' },
      ]),
      files,
    );
    expect(matches.map((m) => m.duplicateOf)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, 6]);
    expect(matches.slice(0, 4).map((m) => [m.quality, m.chosen?.source.relativePath])).toEqual([
      ['sicher', 'BB/BB012-01.mp3'],
      ['sicher', 'BB/BB013-01.mp3'],
      ['sicher', 'Hörbuch/CD1/01.mp3'],
      ['sicher', 'Hörbuch/CD2/01.mp3'],
    ]);
  });

  it('uses the file name the list names, and file names without tags', () => {
    const files = [lib('01 Bohemian Rhapsody.mp3'), lib('Nena - 99 Luftballons.mp3'), lib('02 - Lalelu.mp3')];
    const matches = matchTrackList(
      listOf([
        { title: 'Etwas ganz anderes', artists: [], fileHint: '01 bohemian rhapsody.MP3' },
        { title: '99 Luftballons', artists: ['Nena'] },
        { title: 'Lalelu', artists: [] },
      ]),
      files,
    );
    expect(matches.map((m) => [m.quality, m.chosen?.source.name, m.candidates[0]?.reason])).toEqual([
      ['sicher', '01 Bohemian Rhapsody.mp3', 'name'],
      ['sicher', 'Nena - 99 Luftballons.mp3', 'tags'],
      ['sicher', '02 - Lalelu.mp3', 'tags'],
    ]);
  });

  it('asks when only a title is listed and two artists have that song', () => {
    const files = [lib('a.mp3', { title: 'Hallelujah', artist: 'Leonard Cohen' }), lib('b.mp3', { title: 'Hallelujah', artist: 'Jeff Buckley' })];
    const [m] = matchTrackList(listOf([{ title: 'Hallelujah', artists: [] }]), files);
    expect(m.quality).toBe('unsicher');
    expect(m.candidates).toHaveLength(2);
  });

  it('reports missing songs with no or weak candidates', () => {
    const files = [lib('a.mp3', { title: 'Etwas', artist: 'Jemand' })];
    const [m] = matchTrackList(listOf([{ title: 'Bohemian Rhapsody', artists: ['Queen'] }]), files);
    expect(m).toMatchObject({ quality: 'fehlt', candidates: [] });
    expect(matchTrackList(listOf([{ title: 'Lied', artists: [] }]), [])[0].quality).toBe('fehlt');
  });

  it('weighs the length of a song', () => {
    const files = [lib('short.mp3', { title: 'Song', artist: 'Band', durationSec: 120 }), lib('right.mp3', { title: 'Song', artist: 'Band', durationSec: 241 })];
    const [m] = matchTrackList(listOf([{ title: 'Song', artists: ['Band'], durationSec: 240 }]), files);
    expect(m.chosen?.source.name).toBe('right.mp3');
  });

  it('is quick with large libraries', () => {
    const words = ['sonne', 'mond', 'sterne', 'regen', 'wind', 'meer', 'wald', 'berg', 'fluss', 'stadt', 'licht', 'nacht', 'traum', 'herz', 'feuer', 'eis'];
    const word = (n: number) => words[n % words.length] + (n % 97);
    const files = Array.from({ length: 5000 }, (_, i) =>
      lib(`${i}.mp3`, { title: `${word(i)} ${word(i * 7 + 3)} ${word(i * 13 + 5)}`, artist: `Band ${i % 300}`, durationSec: 120 + (i % 200) }),
    );
    const list = listOf(Array.from({ length: 500 }, (_, k) => {
      const i = k * 10;
      return { title: `${word(i)} ${word(i * 7 + 3)} ${word(i * 13 + 5)}`, artists: [`Band ${i % 300}`], durationSec: 120 + (i % 200) };
    }));
    const start = performance.now();
    const matches = matchTrackList(list, files);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(matches.filter((m) => m.quality === 'sicher').length).toBeGreaterThan(450);
    expect(matches[3].chosen?.source.name).toBe('30.mp3');
  });
});

describe('matchTrackListAsync', () => {
  it('gives the same result, reports progress and can be cancelled', async () => {
    const files = Array.from({ length: 50 }, (_, i) => lib(`${i}.mp3`, { title: `Lied Nummer ${i}`, artist: 'Chor' }));
    const list = listOf(Array.from({ length: 450 }, (_, i) => ({ title: `Lied Nummer ${i % 60}`, artists: ['Chor'] })));
    const progress: number[] = [];
    const result = await matchTrackListAsync(list, files, { onProgress: (done, total) => progress.push(done / total) });
    expect(result.map((m) => m.chosen?.source.name)).toEqual(matchTrackList(list, files).map((m) => m.chosen?.source.name));
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toBe(1);

    const ctl = new AbortController();
    ctl.abort();
    await expect(matchTrackListAsync(list, files, { signal: ctl.signal })).rejects.toThrow();
  });
});
