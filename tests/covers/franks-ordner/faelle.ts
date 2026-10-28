/**
 * Folder names as they are on Frank's box (TODO #110, #115, #125, #133,
 * #134; design/06-entwuerfe/LIESMICH.md; recherche/cover-quellen-test), as
 * the catalog keeps them: the album tag tidied, the artist tag, series and
 * episode where the import found them. Each case says which picture is the
 * right one (`want`, ids of dienste.ts); several ids where more than one
 * edition is right as far as the name tells.
 *
 * `own`: Frank chose this cover himself; nothing may ever replace it.
 * `embedded`: the MP3s on the card carry the cover (downloads from
 * SpotiDownloader and shops do). `folderImage`: a cover.jpg lies in the
 * folder.
 */
import type { CatalogFolder } from '../../../src/core/tonuino/catalog';

export interface Fall {
  id: string;
  folder: number;
  entry: Pick<CatalogFolder, 'title' | 'artist' | 'series' | 'episode'>;
  /** Right pictures; empty: nothing fits (no service has it). */
  want: string[];
  own?: boolean;
  embedded?: boolean;
  folderImage?: string;
  /** Where the name comes from. */
  src: string;
}

let n = 0;
const f = (id: string, entry: Fall['entry'], want: string[] | string, more: Partial<Fall> & { src: string }): Fall => ({
  id,
  folder: ++n,
  entry,
  want: Array.isArray(want) ? want : [want],
  ...more,
});

export const FAELLE: Fall[] = [
  // --- seen on 25.10. (Meine Box, Frank's screenshots)
  f('zaches', { title: 'Konzert am Herd', artist: 'Zaches & Zinnober' }, 'zaches-herd', { own: true, src: 'LIESMICH 01' }),
  f('umb8', { title: 'Unter meinem Bett 8', artist: 'Alex Mayr' }, 'umb-8', { own: true, src: 'LIESMICH 02' }),
  f('beatles', { title: "A Hard Day's Night (Remastered 2009)", artist: 'The Beatles' }, 'beatles-hdn-rm', { embedded: true, src: '25.10.' }),
  f('zappel', { title: 'Zehn kleine Zappelmänner', artist: 'Schnabi Schnabel' }, 'zappel', { own: true, src: 'LIESMICH 04' }),
  f('spucke', { title: 'Spuckepack' }, 'spuckepack', { src: '25.10.' }),
  f('libatiba', { title: 'Tierisch coole Kinderlieder - EP', artist: 'Libatiba' }, 'libatiba', { src: '25.10.' }),
  f('doors', { title: '(2000-09-05) The Best Of The Doors - Digitally Remastered', artist: 'The Doors' }, 'doors-best', { src: '25.10.' }),
  f('who', { title: 'The Ultimate Collection Disc 1', artist: 'The Who' }, 'who-ultimate', { src: '#133 Bild' }),
  f('simon', { title: 'Bridge Over Troubled Water [Bonus Tracks]', artist: 'Simon & Garfunkel' }, 'sg-bridge', { src: '#133 Bild' }),
  f('helden', { title: 'Der perfekte Tag', artist: 'Philipp und die Heldenbande' }, 'helden-tag', { src: '25.10.' }),
  f('hobbit', { title: 'Der Hobbit', artist: 'J. R. R. Tolkien' }, ['hobbit-hsp'], { src: 'LIESMICH 14, #133 Bild' }),
  f('kooks', { title: 'Inside In Inside Out', artist: 'The Kooks' }, 'kooks-inside', { folderImage: 'folder.jpg', src: '25.10.' }),
  f('fleet', { title: 'Helplessness Blues', artist: 'Fleet Foxes' }, 'fleet-blues', { src: '25.10.' }),
  f('zuckkiga', { title: 'Im Kindergarten', artist: 'Rolf Zuckowski' }, 'zuck-kiga', { src: 'LIESMICH 15' }),
  f('schlaf123', { title: '1, 2, 3 (Schlaf gleich ein...)' }, 'schlaf123', { src: '25.10.' }),
  f('bb87', { title: 'Benjamin Blümchen Folge 87 Das Laternenfest' }, 'bb-87', { src: '25.10.' }),
  f('bbmini', { title: 'Geburtstag im Zoo', series: 'Benjamin Blümchen' }, 'bb-zoo', { own: true, src: 'LIESMICH 52' }),
  // --- from the group list of the card (10.10.), with the tag faults described there
  f('umb1', { title: 'Unter meinem Bett', artist: 'Unter meinem Bett' }, 'umb-1', { src: 'SD 37' }),
  f('umb2', { title: 'Unter meinem Bett 2' }, 'umb-2', { src: '#133 Bild' }),
  f('umb3', { title: 'Unter meinem Bett 3' }, 'umb-3', { src: '#133 Bild, SD 39' }),
  f('umb4', { title: 'Unter meinem Bett 4' }, 'umb-4', { src: '#110' }),
  f('umb5', { title: 'SpotiDownloader.com - Unter meinem Bett 5', artist: 'Die Welt Dreht Sich' }, 'umb-5', { embedded: true, src: '#110, SD 20' }),
  f('umb6', { title: 'Unter meinem Bett 6' }, 'umb-6', { src: '#110' }),
  f('umb7', { title: 'Unter meinem Bett 7' }, 'umb-7', { src: '#110' }),
  f('umbxmas', { title: 'Unter meinem Bett - Das Weihnachtsalbum', artist: 'O je, Tannenbaum!' }, 'umb-xmas', { src: 'SD 30' }),
  f('bibi1', { title: 'Bibi & Tina - Voll Verhext! (Der Original-Soundtrack zum Kinofilm)', artist: 'Bibi & Tina' }, 'bibi-vv-ost', { src: 'SD 19' }),
  f('bibi2', { title: 'Bibi und Tina - Mädchen gegen Jungs', artist: 'Bibi und Tina' }, ['bibi-mgj-ost', 'bibi-mgj-hsp'], { src: 'SD 25' }),
  f('bibi50', { title: 'Das Kürbisfest', series: 'Bibi & Tina', episode: 50 }, 'bibi-50', { own: true, src: 'LIESMICH 50' }),
  f('zuckvogel', { title: 'Rolfs Vogelhochzeit', artist: 'Rolf Zuckowski' }, 'zuck-vogel', { src: 'SD' }),
  f('zuckwinter', { title: 'Winterkinder', artist: 'Rolf Zuckowski und seine Freunde' }, 'zuck-winter', { src: 'SD' }),
  f('zuckschul', { title: 'Rolfs Schulweg-Hitparade', artist: 'Rolf Zuckowski' }, 'zuck-schul', { src: 'SD' }),
  f('svt', { title: 'Tanz den Spatz', artist: 'Sven van Thom' }, 'svt-spatz', { src: 'SD 05' }),
  f('zaz1', { title: 'Zaz', artist: 'ZAZ' }, 'zaz-zaz', { src: '#110, SD 17' }),
  f('zaz2', { title: 'Spotidownloader.Com - Paris', artist: 'ZAZ' }, 'zaz-paris', { embedded: true, src: 'SD 18' }),
  f('gespenst', { title: 'Das kleine Gespenst', artist: 'Otfried Preußler' }, ['gespenst-hsp', 'gespenst-film'], { src: 'SD 42' }),
  f('panama', { title: 'Oh, wie schön ist Panama', artist: 'Janosch' }, 'panama', { src: 'SD 43' }),
  f('unendlich', { title: 'Die unendliche Geschichte', artist: 'Michael Ende' }, 'ende-geschichte', { src: 'SD 44' }),
  f('hotzen', { title: 'Der Räuber Hotzenplotz - Hörspiel', artist: 'Otfried Preußler' }, 'hotzen', { src: 'SD 45' }),
  f('hexe', { title: 'Die kleine Hexe (Ungekürzte Lesung)', artist: 'Otfried Preußler' }, 'hexe-lesung', { src: 'SD 46' }),
  f('eule', { title: 'SpotiDownloader.com - Die Eule findet den Beat', artist: 'Eule' }, 'eule-beat', { embedded: true, src: 'SD 22' }),
  f('entlein', { title: 'Das hässliche Entlein' }, ['entlein-a', 'entlein-b'], { src: 'SD 47' }),
  f('toeff', { title: 'Die 30 besten Spiel- und Bewegungslieder', artist: 'Töff, töff, töff, die Eisenbahn' }, 'toeff-30', { src: 'SD 34' }),
  f('deinefr', { title: 'Ausm Häuschen', artist: 'Deine Freunde' }, 'deinefr', { src: 'Kindermusik' }),
  f('joecker', { title: '1, 2, 3 im Sauseschritt', artist: 'Detlev Jöcker' }, 'joecker', { src: 'Kindermusik' }),
  f('rosin', { title: 'Das singende Känguru', artist: 'Volker Rosin' }, 'rosin', { src: 'Kindermusik' }),
  f('sains', { title: 'Sains et saufs' }, [], { src: '#110' }),
  // --- audio plays as the import names them
  f('ddf125', { title: 'Feuermond', series: 'Die drei ???', episode: 125 }, 'ddf-125', { src: 'Hörspielserie' }),
  f('tkkg7', { title: 'TKKG Folge 7' }, 'tkkg-7', { src: 'Hörspielserie' }),
  f('bibibl3', { title: 'Hexen gibt es doch', series: 'Bibi Blocksberg', episode: 3 }, 'bibibl-3', { src: 'Hörspielserie' }),
];
