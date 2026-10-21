/**
 * Names of episodes and albums from downloads against the names shops give
 * them (src/core/library/releasename.ts, TODO 0.5 #81): the same release in
 * any order and spelling of series, number and title, without what video
 * sites and downloaders add.
 */
import { describe, expect, it } from 'vitest';
import { cleanDownloadName, compareRelease, parseReleaseName, releaseSearchText } from '../../src/core/library/releasename';
import { wholeAlbumQuery } from '../../src/core/library/albumcut';

const BIBI_TINA = 'Bibi & Tina - Das Kürbisfest (Folge 50) | HÖRSPIEL DES MONATS OKTOBER [Xq7Lm2Pz9Rt]';

describe('names of downloads', () => {
  it('lose what video sites and downloaders add', () => {
    expect(cleanDownloadName(BIBI_TINA)).toBe('Bibi & Tina - Das Kürbisfest (Folge 50)');
    expect(cleanDownloadName('TKKG - Folge 200 - Die Rache des Bombenlegers [Full Album]')).toBe('TKKG - Folge 200 - Die Rache des Bombenlegers');
    expect(cleanDownloadName('Die drei ??? - Der Ameisenmensch (Folge 29) | Hörspiel komplett')).toBe('Die drei ??? - Der Ameisenmensch (Folge 29)');
    expect(cleanDownloadName('5 Freunde - Folge 1 - Fünf Freunde beim Wanderzirkus [Hörspiel] #fünffreunde #hörspiel')).toBe('5 Freunde - Folge 1 - Fünf Freunde beim Wanderzirkus');
    expect(cleanDownloadName('HUI BUH - Folge 1 - Das Schlossgespenst (Hörspiel)-aB3dE6gH9jK')).toBe('HUI BUH - Folge 1 - Das Schlossgespenst');
    expect(cleanDownloadName('Bibi Blocksberg - Hexen gibt es doch - Hörspiel - Folge 1 [Full Episode] 🧹✨')).toBe('Bibi Blocksberg - Hexen gibt es doch - Folge 1');
    expect(cleanDownloadName('Meine Freundin Conni - Conni geht zum Zahnarzt (Hörbuch komplett)')).toBe('Meine Freundin Conni - Conni geht zum Zahnarzt');
    expect(cleanDownloadName('Rolf Zuckowski | Rolfs Vogelhochzeit | Full Album')).toBe('Rolf Zuckowski - Rolfs Vogelhochzeit');
    expect(cleanDownloadName('y2mate.com - Simone Sommerland - Die 30 besten Kinderlieder (Official Audio)')).toBe('Simone Sommerland - Die 30 besten Kinderlieder');
    // Real names stay: a word of eleven letters is no video id, a name in brackets no leftover.
    expect(cleanDownloadName('Lieder vom Apfelbaum - Weihnachten')).toBe('Lieder vom Apfelbaum - Weihnachten');
    expect(cleanDownloadName('Igel sucht den Mond (Musik-Hörspiel)')).toBe('Igel sucht den Mond (Musik-Hörspiel)');
    // Nothing but leftovers: the name stays as it was.
    expect(cleanDownloadName('Hörspiel')).toBe('Hörspiel');
  });

  it('give series, number and title in any order', () => {
    expect(parseReleaseName(BIBI_TINA)).toMatchObject({ series: 'Bibi & Tina', episode: 50, title: 'Das Kürbisfest' });
    expect(parseReleaseName('Folge 50: Das Kürbisfest', 'Bibi und Tina')).toMatchObject({ series: 'Bibi und Tina', episode: 50, title: 'Das Kürbisfest' });
    expect(parseReleaseName('050/Das Kürbisfest')).toMatchObject({ episode: 50, title: 'Das Kürbisfest' });
    expect(parseReleaseName('Das Kürbisfest (Folge 50)', 'Bibi & Tina')).toMatchObject({ episode: 50, title: 'Das Kürbisfest' });
    expect(parseReleaseName('TKKG - 200 - Die Rache des Bombenlegers')).toMatchObject({ series: 'TKKG', episode: 200, title: 'Die Rache des Bombenlegers' });
    expect(parseReleaseName('Die drei ??? 125: Feuermond')).toMatchObject({ series: 'Die drei ???', episode: 125, title: 'Feuermond' });
    expect(parseReleaseName('Bibi Blocksberg Folge 3 - Die Zauberhexe')).toMatchObject({ series: 'Bibi Blocksberg', episode: 3, title: 'Die Zauberhexe' });
    expect(parseReleaseName('Die 30 besten Kinderlieder')).toMatchObject({ episode: undefined, title: 'Die 30 besten Kinderlieder' });
  });

  it('are searched for by series and title, without number and leftovers', () => {
    expect(releaseSearchText(BIBI_TINA)).toBe('Bibi Tina Das Kürbisfest');
    expect(releaseSearchText('Die drei ??? Folge 125')).toBe('Die drei ??? Folge 125');
    // What the add page searches for: the file's name split into artist and album.
    expect(wholeAlbumQuery(BIBI_TINA)).toEqual({ album: 'Das Kürbisfest (Folge 50)', artist: 'Bibi & Tina' });
  });
});

/**
 * Typical names of downloads (video sites, rips) and what shops call the
 * same album: Europa, Kiddinx, Karussell and children's songs.
 */
const SAME: [ours: string, theirs: { album: string; artist?: string }][] = [
  [BIBI_TINA, { album: 'Folge 50: Das Kürbisfest', artist: 'Bibi und Tina' }],
  [BIBI_TINA, { album: '050/Das Kürbisfest', artist: 'Bibi & Tina' }],
  [BIBI_TINA, { album: 'Bibi & Tina 50: Das Kürbisfest', artist: 'Kiddinx' }],
  ['Das Kürbisfest - Bibi und Tina', { album: 'Folge 50: Das Kürbisfest', artist: 'Bibi und Tina' }],
  ['Die drei ??? - Der Ameisenmensch (Folge 29) | Hörspiel komplett', { album: 'Folge 29: Der Ameisenmensch', artist: 'Die drei ???' }],
  ['Die drei Fragezeichen 29 Der Ameisenmensch', { album: 'Folge 29: Der Ameisenmensch', artist: 'Die drei ???' }],
  ['Die drei ??? Folge 125', { album: 'Folge 125: Feuermond', artist: 'Die drei ???' }],
  ['TKKG - Folge 200 - Die Rache des Bombenlegers [Full Album]', { album: 'Folge 200: Die Rache des Bombenlegers', artist: 'TKKG' }],
  ['T K K G 200 Die Rache des Bombenlegers', { album: 'Folge 200: Die Rache des Bombenlegers', artist: 'TKKG' }],
  ['5 Freunde - Folge 1 - Fünf Freunde beim Wanderzirkus [Hörspiel] #fünffreunde #hörspiel', { album: 'Folge 1: Fünf Freunde beim Wanderzirkus', artist: 'Fünf Freunde' }],
  ['Fünf Freunde beim Wanderzirkus', { album: 'Folge 1: Fünf Freunde beim Wanderzirkus', artist: 'Fünf Freunde' }],
  ['HUI BUH - Folge 1 - Das Schlossgespenst (Hörspiel)-aB3dE6gH9jK', { album: 'Folge 1: Hui Buh, das Schloßgespenst', artist: 'Hui Buh' }],
  ['Benjamin Bluemchen 001 als Wetterelefant (Hörspiel)', { album: '001/als Wetterelefant', artist: 'Benjamin Blümchen' }],
  ['Benjamin Blümchen - als Wetterelefant (Folge 1) | HÖRSPIEL', { album: 'Folge 1: Als Wetterelefant', artist: 'Benjamin Blümchen' }],
  ['Bibi Blocksberg - Hexen gibt es doch - Hörspiel - Folge 1 [Full Episode] 🧹✨', { album: '001/Hexen gibt es doch', artist: 'Bibi Blocksberg' }],
  ['Meine Freundin Conni - Conni geht zum Zahnarzt (Hörbuch komplett)', { album: 'Conni geht zum Zahnarzt (Neu)', artist: 'Conni' }],
  ['Conni geht zum Zahnarzt', { album: 'Meine Freundin Conni - Conni geht zum Zahnarzt', artist: 'Conni' }],
  ['Simone Sommerland, Karsten Glück & die Kita-Frösche - Die 30 besten Kinderlieder (Full Album)', { album: 'Die 30 besten Kinderlieder', artist: 'Simone Sommerland, Karsten Glück & die Kita-Frösche' }],
  ['y2mate.com - Simone Sommerland - Die 30 besten Kinderlieder (Official Audio)', { album: 'Die 30 besten Kinderlieder', artist: 'Simone Sommerland, Karsten Glück & die Kita-Frösche' }],
  ['Rolf Zuckowski | Rolfs Vogelhochzeit | Full Album', { album: 'Rolfs Vogelhochzeit', artist: 'Rolf Zuckowski und seine Freunde' }],
  ['Igel sucht den Mond', { album: 'Igel sucht den Mond (Musik-Hörspiel)', artist: 'Igel' }],
];

/** Close, but another release: another episode, another series, another album. */
const OTHER: [ours: string, theirs: { album: string; artist?: string }][] = [
  [BIBI_TINA, { album: 'Folge 51: Der Pferdedieb', artist: 'Bibi und Tina' }],
  [BIBI_TINA, { album: 'Folge 49: Das Kürbisfest-Turnier', artist: 'Bibi und Tina' }],
  ['Bibi & Tina - Das Kürbisfest', { album: 'Folge 51: Der Pferdedieb', artist: 'Bibi und Tina' }],
  [BIBI_TINA, { album: 'Folge 50: Das Kürbisfest', artist: 'Bibi Blocksberg' }],
  ['Die drei ??? - Der Ameisenmensch (Folge 29)', { album: 'Folge 29: Tatort Kletterwand', artist: 'Die drei !!!' }],
  ['Die drei ??? Kids - Folge 1: Panik im Paradies', { album: 'Folge 1: und der Super-Papagei', artist: 'Die drei ???' }],
  ['Benjamin Bluemchen 001 als Wetterelefant', { album: '002/Der Zoo', artist: 'Benjamin Blümchen' }],
  ['TKKG - Folge 200 - Die Rache des Bombenlegers', { album: 'Folge 201: Gefährliche Diamanten', artist: 'TKKG' }],
  ['Die 30 besten Kinderlieder', { album: 'Die 30 besten Weihnachtslieder', artist: 'Simone Sommerland' }],
  ['Die 30 besten Kinderlieder', { album: 'Die 50 besten Kinderlieder', artist: 'Simone Sommerland' }],
  ['Igel', { album: 'Igel sucht den Mond', artist: 'Igel' }],
  ['Sommerträume', { album: 'Winterträume' }],
];

describe('a download and a shop album', () => {
  it.each(SAME)('are the same: %s', (ours, theirs) => {
    // As the add page asks: the file's name split into artist and album.
    expect(compareRelease(wholeAlbumQuery(ours), theirs).same).toBe(true);
    // And the whole name as typed into the search field.
    expect(compareRelease({ album: ours }, theirs).same).toBe(true);
  });

  it.each(OTHER)('are not the same: %s', (ours, theirs) => {
    expect(compareRelease(wholeAlbumQuery(ours), theirs).same).toBe(false);
    expect(compareRelease({ album: ours }, theirs).same).toBe(false);
  });

  it('are sure of it when the number agrees or the title word for word', () => {
    expect(compareRelease(wholeAlbumQuery(BIBI_TINA), { album: 'Folge 50: Das Kürbisfest', artist: 'Bibi und Tina' }).strong).toBe(true);
    expect(compareRelease({ album: 'Rolfs Vogelhochzeit' }, { album: 'Rolfs Vogelhochzeit', artist: 'Rolf Zuckowski' }).strong).toBe(true);
    // Most words, not all: the same, but not sure enough for a file of another length.
    expect(compareRelease({ album: 'Igel sucht den Mond Remix' }, { album: 'Igel sucht den Mond', artist: 'Igel' })).toEqual({ same: true, strong: false });
  });
});
