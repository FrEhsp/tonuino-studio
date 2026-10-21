/**
 * Names from tags and catalogs without the mess downloaders leave
 * (src/core/library/tidy.ts), as families' cards have them: "SomeDownloader.com - "
 * in front of albums, song titles in the artist field, Title Case on every word.
 */
import { describe, expect, it } from 'vitest';
import { checkedArtist, isNamelessTitle, looksBrokenTitleCase, pickArtist, recase, stripDownloaderNoise, tidyFolder, titlesFromArtistField } from '../../src/core/library/tidy';

describe('downloader names', () => {
  it('come off the front of albums and titles, in any spelling', () => {
    expect(stripDownloaderNoise('SomeDownloader.com - Igel sucht den Mond')).toBe('Igel sucht den Mond');
    expect(stripDownloaderNoise('Somedownloader.Com - Igel Sucht Den Mond (Musik-Hörspiel)')).toBe('Igel Sucht Den Mond (Musik-Hörspiel)');
    expect(stripDownloaderNoise('[SOME-DOWNLOADER.COM] Lotta & Lu')).toBe('Lotta & Lu');
    expect(stripDownloaderNoise('www.y2mate.is – Lola Blau - Mon chant')).toBe('Lola Blau - Mon chant');
    expect(stripDownloaderNoise('SpotifyDown - Hinter dem Schrank 3')).toBe('Hinter dem Schrank 3');
  });

  it('come off the end too', () => {
    expect(stripDownloaderNoise('Tanz am Teich (somedownloader.com)')).toBe('Tanz am Teich');
    expect(stripDownloaderNoise('Sommerträume - SomeDownloader.com')).toBe('Sommerträume');
    expect(stripDownloaderNoise('Plätzchenzeit [mp3juices.cc]')).toBe('Plätzchenzeit');
  });

  it('leave real names alone', () => {
    for (const name of ['Die drei ??? - Folge 125', 'Rolf Zuckowski - Sommerträume', 'Igel sucht den Mond (Musik-Hörspiel)', 'Hits.de für Kinder', 'Tanz am Teich: Teil 2', 'Kalle Klang']) {
      expect(stripDownloaderNoise(name)).toBe(name);
    }
    // Nothing else left: the name stays.
    expect(stripDownloaderNoise('SomeDownloader.com')).toBe('SomeDownloader.com');
  });
});

describe('broken Title Case', () => {
  it('is every word capitalised, small German words in the middle too', () => {
    expect(looksBrokenTitleCase('Igel Sucht Den Mond')).toBe(true);
    expect(looksBrokenTitleCase('Tanz Am Teich')).toBe(true);
    expect(looksBrokenTitleCase('Die Sonne Geht Auf')).toBe(true);
    expect(looksBrokenTitleCase('Igel sucht den Mond')).toBe(false);
    expect(looksBrokenTitleCase('Hinter dem Schrank')).toBe(false);
    // English titles may capitalise every word; shouting is no Title Case.
    expect(looksBrokenTitleCase('The Sound Of Music')).toBe(false);
    expect(looksBrokenTitleCase('UNTER DEM MEER')).toBe(false);
    expect(looksBrokenTitleCase('Bibi Blocksberg')).toBe(false);
  });

  it('is repaired only with the spelling of the same name from a shop', () => {
    expect(recase('Igel Sucht Den Mond', 'Igel sucht den Mond')).toBe('Igel sucht den Mond');
    expect(recase('TANZ AM TEICH', 'Tanz am Teich')).toBe('Tanz am Teich');
    // Another name, or a name that was fine: unchanged.
    expect(recase('Igel Sucht Den Mond', 'Igel sucht den Mond 2')).toBe('Igel Sucht Den Mond');
    expect(recase('Hinter dem Schrank', 'Hinter Dem Schrank')).toBe('Hinter dem Schrank');
    expect(recase('Igel Sucht Den Mond', undefined)).toBe('Igel Sucht Den Mond');
  });
});

describe('the artist of an album', () => {
  it('is the album artist, when the tracks have one', () => {
    expect(pickArtist([{ artist: 'Die Sonne Geht Auf', albumArtist: 'Hinter dem Schrank' }, { artist: 'Schnee', albumArtist: 'Hinter dem Schrank' }])).toBe('Hinter dem Schrank');
  });

  it('is never the title of track 1 that a downloader put into the artist field', () => {
    const tracks = [
      { title: 'Kling, Glöckchen!', artist: 'Kling, Glöckchen!' },
      { title: 'Schneeflöckchen', artist: 'Schneeflöckchen' },
      { title: 'Lasst uns froh', artist: 'Lasst uns froh' },
    ];
    expect(pickArtist(tracks)).toBeUndefined();
    // Every track names someone else: no majority, no artist.
    expect(pickArtist([{ artist: 'Die Sonne Geht Auf' }, { artist: 'Tschu, tschu, die kleine Bahn' }, { artist: 'Rolf Zuckowski' }])).toBeUndefined();
  });

  it('is the artist more than half of the tracks name', () => {
    expect(pickArtist([{ artist: 'Rolf Zuckowski' }, { artist: 'Rolf Zuckowski und seine Freunde' }, { artist: 'Rolf Zuckowski' }])).toBe('Rolf Zuckowski');
    expect(pickArtist([{ artist: 'SomeDownloader.com - Lola Blau' }])).toBe('Lola Blau');
    expect(pickArtist([{ artist: 'Various Artists' }, { artist: 'Various Artists' }])).toBeUndefined();
    // A sampler says so in its album artist: that stays.
    expect(pickArtist([{ artist: 'A', albumArtist: 'Verschiedene Interpreten' }, { artist: 'B', albumArtist: 'Verschiedene Interpreten' }])).toBe('Verschiedene Interpreten');
    expect(pickArtist([{ artist: 'A', albumArtist: 'Unknown Artist' }, { artist: 'A', albumArtist: 'Unknown Artist' }])).toBe('A');
    expect(pickArtist([])).toBeUndefined();
  });

  it('of a folder on the card gives way when only one track names it', () => {
    const tags = [
      { artist: 'Die Sonne Geht Auf' },
      { artist: 'Schlaf, Kindlein' },
      { artist: 'Gute Nacht' },
    ];
    expect(checkedArtist('Die Sonne Geht Auf', tags)).toBeUndefined();
    expect(checkedArtist('Die Sonne Geht Auf', tags.map((t) => ({ ...t, albumArtist: 'Hinter dem Schrank' })))).toBe('Hinter dem Schrank');
    // Typed by hand and named by no track: stays.
    expect(checkedArtist('Oma Erna', [{ artist: 'Oma Erna' }, { artist: 'Oma Erna' }])).toBe('Oma Erna');
    expect(checkedArtist('Oma Erna', [{ artist: 'Rolf' }, { artist: 'Rolf' }])).toBe('Oma Erna');
    // A compilation where the artist sings only some songs: stays.
    expect(checkedArtist('Rolf Zuckowski', ['Rolf Zuckowski', 'Rolf Zuckowski', 'Rolf Zuckowski', 'Anne', 'Bert', 'Carl', 'Dora', 'Emil'].map((artist) => ({ artist })))).toBe('Rolf Zuckowski');
    // Nothing in the catalog: what the tracks agree on.
    expect(checkedArtist(undefined, [{ artist: 'Lola Blau' }, { artist: 'Lola Blau' }])).toBe('Lola Blau');
    expect(checkedArtist('Rolf Zuckowski', [{ artist: 'Rolf Zuckowski' }, { artist: 'Rolf Zuckowski' }, { artist: 'Anne' }])).toBe('Rolf Zuckowski');
  });
});

describe('titles from the artist field', () => {
  it('are taken when the tracks have no titles and each names another artist', () => {
    const tracks = [{ artist: 'Die Sonne Geht Auf' }, { artist: 'Der Mond' }, { artist: 'Kleiner Stern' }, { artist: 'Gute Nacht' }];
    expect(titlesFromArtistField(tracks)).toEqual(['Die Sonne Geht Auf', 'Der Mond', 'Kleiner Stern', 'Gute Nacht']);
  });

  it('are not taken when the artists agree or the tracks have titles', () => {
    expect(titlesFromArtistField([{ artist: 'Lola Blau' }, { artist: 'Lola Blau' }, { artist: 'Lola Blau' }])).toBeUndefined();
    expect(titlesFromArtistField([{ title: 'A', artist: 'X' }, { title: 'B', artist: 'Y' }, { title: 'C', artist: 'Z' }])).toBeUndefined();
    expect(titlesFromArtistField([{ artist: 'X' }, { artist: 'Y' }])).toBeUndefined();
  });
});

describe('folders in the catalog', () => {
  it('lose downloader names and an artist that is one of their track titles', () => {
    const entry = { title: 'Somedownloader.Com - Igel Sucht Den Mond', artist: 'Igel sucht den Mond - Intro', tracks: [{ title: 'Igel sucht den Mond - Intro' }, { title: 'SomeDownloader.com - Der Mond' }] };
    expect(tidyFolder(entry)).toEqual({ title: 'Igel Sucht Den Mond', artist: undefined, tracks: [{ title: 'Igel sucht den Mond - Intro' }, { title: 'Der Mond' }] });
  });

  it('stay the same object when there is nothing to tidy', () => {
    const entry = { title: 'Sommerträume', artist: 'Rolf Zuckowski', tracks: [{ title: 'Schneemann' }, {}] };
    expect(tidyFolder(entry)).toBe(entry);
  });
});

describe('titles without a name', () => {
  it('are numbers or "Track 7"', () => {
    for (const t of ['01', '003', 'Track 7', 'Titel 3', 'kapitel_12', '', undefined]) expect(isNamelessTitle(t)).toBe(true);
    for (const t of ['Intro', '1, 2, 3 im Sauseschritt', 'Teil 2 der Reise', '99 Luftballons']) expect(isNamelessTitle(t)).toBe(false);
  });
});
