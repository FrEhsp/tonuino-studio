import { describe, expect, it } from 'vitest';
import { cleanArtist, cleanForSearch, isDoubtfulVersion, isVariousArtists, prepareQuery, variantOf, variantsFit } from '../../src/core/covers/names';

describe('names fit for a search', () => {
  it('drops what downloads, shops and rips add', () => {
    expect(cleanForSearch('SpotiDownloader.com - Unter meinem Bett 5')).toBe('Unter meinem Bett 5');
    expect(cleanForSearch('(2000-09-05) Die Weihnachtsbäckerei')).toBe('Die Weihnachtsbäckerei');
    expect(cleanForSearch('Abbey Road (Remastered 2009)')).toBe('Abbey Road');
    expect(cleanForSearch('Help! [Bonus Tracks]')).toBe('Help!');
    expect(cleanForSearch('Kinderlieder - EP')).toBe('Kinderlieder');
    expect(cleanForSearch('Tabaluga Disc 1')).toBe('Tabaluga');
    expect(cleanForSearch('Pippi Langstrumpf (CD 2 von 3)')).toBe('Pippi Langstrumpf');
    expect(cleanForSearch('Die drei ??? Folge 12.mp3')).toBe('Die drei ??? Folge 12');
  });

  it('keeps brackets with a name in them, and "???" as it is', () => {
    expect(cleanForSearch('Feuermond (Teil 1 - Das Rätsel der Meister)')).toBe('Feuermond (Teil 1 - Das Rätsel der Meister)');
    expect(cleanForSearch('Die drei ??? Folge 12')).toBe('Die drei ??? Folge 12');
    expect(cleanForSearch('Bibi Blocksberg (Folge 50)')).toBe('Bibi Blocksberg (Folge 50)');
  });

  it('drops notes about the kind, but remembers the kind', () => {
    expect(cleanForSearch('Voll verhext! (Der Original-Soundtrack zum Kinofilm)')).toBe('Voll verhext!');
    expect(variantOf('Voll verhext! (Der Original-Soundtrack zum Kinofilm)')).toBe('soundtrack');
    expect(variantOf('Das Original-Hörspiel zum Kinofilm')).toBe('hoerspiel');
    expect(variantOf('Harry Potter (Ungekürzte Lesung)')).toBe('lesung');
    expect(variantOf('Kinderlieder Karaoke')).toBe('karaoke');
    expect(variantOf('Der seltsame Wecker')).toBe('');
    expect(cleanForSearch('Die Eule mit der Beule - Die Mini Hörspielserie für ganz Kleine')).toBe('Die Eule mit der Beule');
    // A name that is only a note stays as it is.
    expect(cleanForSearch('Live')).toBe('Live');
  });

  it('lets kinds fit when they are the same or one does not say', () => {
    expect(variantsFit('', 'soundtrack')).toBe(true);
    expect(variantsFit('hoerspiel', 'hoerspiel')).toBe(true);
    expect(variantsFit('hoerspiel', 'soundtrack')).toBe(false);
  });

  it('leaves out artist tags that name no one', () => {
    expect(cleanArtist('Various Artists')).toBeUndefined();
    expect(cleanArtist('Verschiedene Interpreten')).toBeUndefined();
    expect(cleanArtist('  Rolf   Zuckowski ')).toBe('Rolf Zuckowski');
    expect(isVariousArtists('VA')).toBe(true);
    expect(isVariousArtists('')).toBe(true);
    expect(isVariousArtists('Simone Sommerland')).toBe(false);
  });

  it('knows karaoke, tribute and remix versions the name did not ask for', () => {
    expect(isDoubtfulVersion('Die Weihnachtsbäckerei (Karaoke Version)', 'Die Weihnachtsbäckerei')).toBe(true);
    expect(isDoubtfulVersion('A Tribute to the Beatles', 'Abbey Road')).toBe(true);
    expect(isDoubtfulVersion('Kinderlieder Karaoke', 'Kinderlieder Karaoke')).toBe(false);
    expect(isDoubtfulVersion('Abbey Road', 'Abbey Road')).toBe(false);
  });

  it('prepares a query: artist in front unless the name has it, the album cleaned', () => {
    expect(prepareQuery({ artist: 'Rolf Zuckowski', album: 'Die Weihnachtsbäckerei (Remastered)' })).toEqual({
      text: 'Rolf Zuckowski Die Weihnachtsbäckerei',
      album: 'Die Weihnachtsbäckerei',
      artist: 'Rolf Zuckowski',
      variant: '',
      episodes: [],
      raw: 'Rolf Zuckowski Die Weihnachtsbäckerei (Remastered)',
    });
    const ddf = prepareQuery({ artist: 'Die drei ???', album: 'Die drei ??? Folge 12' });
    expect(ddf.text).toBe('Die drei ??? Folge 12');
    expect(ddf.episodes).toEqual([12]);
    expect(prepareQuery({ artist: 'Various Artists', album: 'Kinderlieder' }).artist).toBeUndefined();
    expect(prepareQuery({ query: '  ' }).text).toBe('');
  });
});
