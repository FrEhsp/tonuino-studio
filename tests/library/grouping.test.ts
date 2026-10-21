import { describe, expect, it } from 'vitest';
import { planSplits, type Pause } from '../../src/core/audio/silence';
import { memSource } from '../../src/platform/memory';
import { estimateTrackCount, groupIntoAlbums, guessKind, isPlayableAsIs, isSplit, SPLIT_TOLERANCE, titleFromFileName, type DraftTrack, type InputFile } from '../../src/core/library/grouping';
import type { TrackInfo } from '../../src/core/library/tags';

const file = (relativePath: string, info?: TrackInfo): InputFile => ({ source: memSource(relativePath.split('/').pop()!, new Uint8Array(1), relativePath), info });

describe('titleFromFileName', () => {
  it('drops numbers, separators and underscores', () => {
    expect(titleFromFileName('01 - Intro.mp3')).toBe('Intro');
    expect(titleFromFileName('Track 07.mp3')).toBe('Track 07');
    expect(titleFromFileName('03_Der_Hexenbesen.mp3')).toBe('Der Hexenbesen');
    expect(titleFromFileName('CD1-12 Finale.flac')).toBe('Finale');
    expect(titleFromFileName('2024.mp3')).toBe('2024');
  });
});

describe('groupIntoAlbums', () => {
  it('cleans what downloaders leave: their name in the album, song titles in the artist field', () => {
    const drafts = groupIntoAlbums([
      file('dl/1.mp3', { album: 'Somedownloader.Com - Igel Sucht Den Mond', artist: 'Igel sucht den Mond - Intro', trackNo: 1 }),
      file('dl/2.mp3', { album: 'SomeDownloader.com - Igel Sucht Den Mond', artist: 'Der Mond im Wald', trackNo: 2 }),
      file('dl/3.mp3', { album: 'Igel Sucht Den Mond', artist: 'Hip-Hop-Hase', trackNo: 3 }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toBe('Igel Sucht Den Mond');
    // Not the "artist" of track 1, which is its title.
    expect(drafts[0].artist).toBeUndefined();
    expect(drafts[0].tracks.map((t) => [t.title, t.titleAuto])).toEqual([
      ['Igel sucht den Mond - Intro', true],
      ['Der Mond im Wald', true],
      ['Hip-Hop-Hase', true],
    ]);
  });

  it('names one file from a video site without its leftovers, and keeps the file\'s title (TODO 0.5 #81)', () => {
    const name = 'Lotta & Lu - Das Kürbisfest (Folge 50) | HÖRSPIEL DES MONATS OKTOBER [Xq7Lm2Pz9Rt]';
    const [a] = groupIntoAlbums([file(`${name}.mp3`, { title: name, durationSec: 2464 })]);
    expect(a.title).toBe('Lotta & Lu - Das Kürbisfest (Folge 50)');
    expect(a.tracks[0].title).toBe(name);
    // The kind still sees the whole name: "HÖRSPIEL" says what it is.
    expect(a.kind).toBe('hoerspiel');
    // A file named by its album tag keeps that name.
    expect(groupIntoAlbums([file('x.mp3', { title: 'Lied', album: 'Lieder | Live' })])[0].title).toBe('Lieder | Live');
  });

  it('takes the album artist, else what most tracks name, and real titles as they are', () => {
    const [a] = groupIntoAlbums([
      file('z/1.mp3', { album: 'Weihnachten', artist: 'Kling, Glöckchen!', albumArtist: 'Rolf Zuckowski', title: 'Kling, Glöckchen!' }),
      file('z/2.mp3', { album: 'Weihnachten', artist: 'Rolf Zuckowski', albumArtist: 'Rolf Zuckowski', title: 'SomeDownloader.com - Schneemann' }),
    ]);
    expect(a.artist).toBe('Rolf Zuckowski');
    expect(a.tracks.map((t) => [t.title, t.titleAuto])).toEqual([
      ['Kling, Glöckchen!', undefined],
      ['Schneemann', undefined],
    ]);
  });

  it('groups by album tag and merges discs in order', () => {
    const drafts = groupIntoAlbums([
      file('Bibi/CD 2/01.mp3', { album: 'Bibi 1', albumArtist: 'Bibi', discNo: 2, trackNo: 1, title: 'Drei' }),
      file('Bibi/CD 1/02.mp3', { album: 'Bibi 1', albumArtist: 'Bibi', discNo: 1, trackNo: 2, title: 'Zwei' }),
      file('Bibi/CD 1/01.mp3', { album: 'Bibi 1', albumArtist: 'Bibi', discNo: 1, trackNo: 1, title: 'Eins' }),
      file('Lieder/b.mp3', { album: 'Lieder', artist: 'Rolf', durationSec: 120 }),
    ]);
    expect(drafts.map((d) => [d.title, d.artist, d.tracks.map((t) => t.title)])).toEqual([
      ['Bibi 1', 'Bibi', ['Eins', 'Zwei', 'Drei']],
      ['Lieder', 'Rolf', ['b']],
    ]);
  });

  it('falls back to folders and natural file order without tags', () => {
    const drafts = groupIntoAlbums([
      file('Der Räuber Hotzenplotz/CD1/10 Ende.mp3'),
      file('Der Räuber Hotzenplotz/CD1/2 Mitte.mp3'),
      file('Der Räuber Hotzenplotz/CD1/1 Anfang.mp3'),
      file('Der Räuber Hotzenplotz/CD2/1 Weiter.mp3'),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toBe('Der Räuber Hotzenplotz');
    expect(drafts[0].tracks.map((t) => t.title)).toEqual(['Anfang', 'Mitte', 'Ende', 'Weiter']);
  });

  it('suggests splitting a single long file, at chapters when it has them', () => {
    const [plain] = groupIntoAlbums([file('buch.mp3', { durationSec: 3 * 3600, title: 'Das Buch' })]);
    expect(plain).toMatchObject({ title: 'Das Buch', split: 'pauses', splitMinutes: 5, kind: 'hoerbuch' });
    const [chaptered] = groupIntoAlbums([file('buch.m4b', { durationSec: 3600, codec: 'aac', chapters: [{ startSec: 0 }, { startSec: 600 }] })], { splitMinutes: 8 });
    expect(chaptered).toMatchObject({ split: 'chapters', splitMinutes: 8 });
    expect(isPlayableAsIs(chaptered.tracks[0])).toBe(false);
    const [short] = groupIntoAlbums([file('lied.mp3', { durationSec: 180 })]);
    expect(short.split).toBe('none');
    expect(isPlayableAsIs(short.tracks[0])).toBe(true);
  });

  it('spreads more than 255 tracks over several folders', () => {
    const many = Array.from({ length: 300 }, (_, i) => file(`Sammlung/${i + 1}.mp3`));
    const drafts = groupIntoAlbums(many);
    expect(drafts.map((d) => [d.title, d.tracks.length, d.part])).toEqual([
      ['Sammlung (Teil 1)', 255, { index: 1, of: 2 }],
      ['Sammlung (Teil 2)', 45, { index: 2, of: 2 }],
    ]);
  });

  it('keeps albums of the same name apart when their artists differ', () => {
    const drafts = groupIntoAlbums([
      file('Bibi Blocksberg/Folge 1/01.mp3', { album: 'Folge 1', artist: 'Bibi Blocksberg', trackNo: 1, title: 'Bibi 1' }),
      file('Bibi Blocksberg/Folge 1/02.mp3', { album: 'Folge 1', artist: 'Bibi Blocksberg', trackNo: 2, title: 'Bibi 2' }),
      file('Benjamin Blümchen/Folge 1/01.mp3', { album: 'Folge 1', artist: 'Benjamin Blümchen', trackNo: 1, title: 'Benjamin 1' }),
      file('Benjamin Blümchen/Folge 1/02.mp3', { album: 'Folge 1', artist: 'Benjamin Blümchen', trackNo: 2, title: 'Benjamin 2' }),
    ]);
    expect(drafts.map((d) => [d.title, d.artist, d.tracks.map((t) => t.title)])).toEqual([
      ['Folge 1', 'Bibi Blocksberg', ['Bibi 1', 'Bibi 2']],
      ['Folge 1', 'Benjamin Blümchen', ['Benjamin 1', 'Benjamin 2']],
    ]);
  });

  it('keeps a compilation and an album spread over disc folders together', () => {
    const drafts = groupIntoAlbums([
      file('Kuschelrock/01.mp3', { album: 'Kuschelrock', artist: 'Anna', trackNo: 1 }),
      file('Kuschelrock/02.mp3', { album: 'Kuschelrock', artist: 'Ben', trackNo: 2 }),
      file('HP1 (CD1)/01.mp3', { album: 'Harry Potter 1', artist: 'Rufus Beck', discNo: 1, trackNo: 1 }),
      file('HP1 (CD2)/01.mp3', { album: 'Harry Potter 1', artist: 'Rufus Beck', discNo: 2, trackNo: 1 }),
    ]);
    expect(drafts.map((d) => [d.title, d.tracks.length])).toEqual([
      ['Harry Potter 1', 2],
      ['Kuschelrock', 2],
    ]);
  });

  it('skips files whose tags could not be read', () => {
    const drafts = groupIntoAlbums([{ ...file('x/kaputt.mp3'), error: 'kaputt' }, file('x/gut.mp3')]);
    expect(drafts[0].tracks.map((t) => t.title)).toEqual(['gut']);
  });

  it('keeps the origin of downloaded files with their tracks', () => {
    const origin = {
      entry: { id: 'radio-klops', type: 'podcast', title: 'Radio Klops', publisher: 'Domenik Schuster', pageUrl: 'https://radioklops.podigee.io/', rights: { kind: 'podcast', holder: 'Domenik Schuster' }, editPolicy: 'normal' },
      item: { key: 'radio-klops/7', title: 'Folge 7', category: 'hoerspiel' },
      retrievedAt: 0,
    } as const;
    const drafts = groupIntoAlbums([
      { ...file('Entdecken/Radio Klops/Folge 7/a.mp3', { album: 'Radio Klops', albumArtist: 'Domenik Schuster', trackNo: 2, title: 'Folge 7' }), origin },
      file('Entdecken/Radio Klops/Folge 6/b.mp3', { album: 'Radio Klops', albumArtist: 'Domenik Schuster', trackNo: 1, title: 'Folge 6' }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].tracks.map((t) => [t.title, t.origin?.item.key])).toEqual([
      ['Folge 6', undefined],
      ['Folge 7', 'radio-klops/7'],
    ]);
    expect('origin' in drafts[0].tracks[0]).toBe(false);
  });
});

describe('guessKind', () => {
  const t = (info: TrackInfo) => ({ source: memSource('a.mp3', new Uint8Array(1)), info, title: 'a' });
  it('uses the genre, then track lengths', () => {
    expect(guessKind([t({ genre: 'Hörspiel' })])).toBe('hoerspiel');
    expect(guessKind([t({ genre: 'Audiobook' })])).toBe('hoerbuch');
    expect(guessKind(Array.from({ length: 6 }, () => t({ durationSec: 200 })))).toBe('musik');
    expect(guessKind([t({ durationSec: 30 * 60 })])).toBe('hoerbuch');
    expect(guessKind([t({ genre: 'Pop', durationSec: 200 })])).toBe('musik');
  });

  it('reads hints in the album or folder name', () => {
    expect(guessKind([t({ durationSec: 30 })], 'Musik/Lieblingssongs')).toBe('musik');
    expect(guessKind([t({ durationSec: 150 })], 'Kinderlieder zum Mitsingen')).toBe('lieder');
    expect(guessKind([t({ durationSec: 150 })], 'Hörspiele/Folge 3')).toBe('hoerspiel');
    // "Musikschule" is a word of its own, not a hint
    expect(guessKind([t({ durationSec: 150 })], 'Die Musikschule')).toBe('hoerspiel');
  });

  it('knows plurals and spellings without umlauts', () => {
    const short = [t({ durationSec: 150 })];
    expect(guessKind(short, 'Hörbücher')).toBe('hoerbuch');
    expect(guessKind(short, 'Hoerbuecher')).toBe('hoerbuch');
    expect(guessKind(short, 'Audio Books')).toBe('hoerbuch');
    expect(guessKind(short, 'Hörspiele')).toBe('hoerspiel');
    expect(guessKind(short, 'Schlaflieder')).toBe('lieder');
    expect(guessKind([t({ durationSec: 3 * 3600 })], 'Der Flieder')).toBe('hoerbuch');
  });

  it('trusts long tracks and chapters more than the folders around the album', () => {
    const chapters = [{ startSec: 0 }, { startSec: 600 }];
    const kinds = (paths: string[], info: TrackInfo) => groupIntoAlbums(paths.map((p) => file(p, info))).map((d) => [d.title, d.kind]);
    expect(kinds(['Musik/Hörbücher/Harry Potter 1.m4b'], { durationSec: 3 * 3600, codec: 'aac', chapters })).toEqual([['Hörbücher', 'hoerbuch']]);
    expect(kinds(['Musik/Harry Potter 1/HP1.mp3'], { durationSec: 6 * 3600 })).toEqual([['Harry Potter 1', 'hoerbuch']]);
    // Short tracks: then the folders around it tell, the nearest first.
    const ten = (dir: string) => Array.from({ length: 10 }, (_, i) => `${dir}/${i + 1}.mp3`);
    expect(kinds(ten('Lieder und Hörspiele/Bibi Blocksberg 1'), { durationSec: 300 })).toEqual([['Bibi Blocksberg 1', 'hoerspiel']]);
    expect(kinds(ten('Musik/Hörspiele/Die drei Fragezeichen 1'), { durationSec: 240 })).toEqual([['Die drei Fragezeichen 1', 'hoerspiel']]);
    expect(kinds(ten('Musik/Rolf Zuckowski'), { durationSec: 180 })).toEqual([['Rolf Zuckowski', 'musik']]);
  });

  it('takes no hint from a collecting folder "Musik" around the album', () => {
    const kinds = (paths: string[], info: TrackInfo) => groupIntoAlbums(paths.map((p) => file(p, info))).map((d) => [d.title, d.kind]);
    const four = (dir: string) => Array.from({ length: 4 }, (_, i) => `${dir}/${i + 1}.mp3`);
    expect(kinds(four('Musik/Benjamin Blümchen 12'), { durationSec: 9 * 60 })).toEqual([['Benjamin Blümchen 12', 'hoerspiel']]);
    expect(kinds(four('Downloads/Music/Bibi 3'), { durationSec: 10 * 60 })).toEqual([['Bibi 3', 'hoerspiel']]);
    // Its own name still counts.
    expect(guessKind([t({ durationSec: 150 })], 'Musik/Lieblingssongs', ['Musik'])).toBe('musik');
  });
});

describe('splitting long files', () => {
  it('marks every long file of an album and estimates the parts', () => {
    const [album] = groupIntoAlbums(
      [
        file('Buch/CD 1.mp3', { album: 'Buch', durationSec: 70 * 60 }),
        file('Buch/CD 2.mp3', { album: 'Buch', durationSec: 65 * 60 }),
        file('Buch/Bonus.mp3', { album: 'Buch', durationSec: 3 * 60 }),
      ],
      { splitMinutes: 10 },
    );
    expect(album.split).toBe('pauses');
    expect(estimateTrackCount(album)).toBe(7 + 7 + 1);
    expect(estimateTrackCount({ ...album, split: 'none' })).toBe(3);
  });

  it('counts chapters when cutting at chapters', () => {
    const chapters = Array.from({ length: 12 }, (_, i) => ({ startSec: i * 300 }));
    const [album] = groupIntoAlbums([file('hoerbuch.m4b', { durationSec: 3600, codec: 'aac', chapters })]);
    expect(album.split).toBe('chapters');
    expect(estimateTrackCount(album)).toBe(12);
  });

  it('marks a file as cut, and counts it as at least two titles, only when the cutter cuts it', () => {
    const long = (sec: number): DraftTrack => ({ source: memSource('Buch.mp3', new Uint8Array(1)), info: { durationSec: sec }, title: 'Buch' });
    const cases: [minutes: number, splitMinutes: number][] = [[20.2, 15], [25, 20], [26, 20], [27, 20], [28, 20], [38, 30], [40, 30], [42, 30], [21, 5], [90, 10]];
    for (const [minutes, splitMinutes] of cases) {
      const sec = minutes * 60;
      // Speech with a pause every 30 s.
      const pauses: Pause[] = Array.from({ length: Math.floor((sec - 1) / 30) }, (_, i) => ({ startSec: 30 * i + 29, endSec: 30 * i + 31, meanDb: -90, score: 1, cutSec: 30 * i + 30 }));
      const parts = planSplits({ durationSec: sec, pauses, targetSec: splitMinutes * 60, toleranceRatio: SPLIT_TOLERANCE }).parts.length;
      const album = { tracks: [long(sec)], split: 'pauses' as const, splitMinutes };
      expect(isSplit(album, album.tracks[0]), `${minutes} min in titles of ${splitMinutes}`).toBe(parts > 1);
      expect(estimateTrackCount(album) > 1, `${minutes} min in titles of ${splitMinutes}`).toBe(parts > 1);
    }
    expect(isSplit({ split: 'none', splitMinutes: 5 }, long(90 * 60))).toBe(false);
    expect(isSplit({ split: 'pauses', splitMinutes: 5 }, long(19 * 60))).toBe(false); // not long
  });
});
