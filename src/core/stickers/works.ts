/**
 * Colours of well-known children's audio plays, audiobooks and albums, so a
 * sticker of the style "Kassette" (band, title field, number plate) and the
 * shelf's card (the panel next to the cover) look like the work they belong
 * to (Frank, 13. and 14.10.2026, TODO #53 and #60).
 *
 * Only colours, never a picture: each scheme is read off the well-known
 * covers of the work (the dominant colour of its covers or its logo for the
 * band, a light colour of the cover for the plate, a strong one for the
 * digits). The cover itself always stays the original, whole. Series whose
 * covers change colour from episode to episode keep the band of each cover
 * (band "cover") and only bring their plate.
 *
 * A work is recognised as the cover recipes were (src/core/covers/recognize):
 * by its title and series, the artist, the names of its tracks and where it
 * came from in "Entdecken", all normalised (umlauts, "???", "&" and "und",
 * punctuation, "Folge 12"). A work nobody knows here gets its colours from
 * its cover, as before. A colour chosen for a sticker always wins.
 *
 * These are the "recipes" of 0.5 (Frank, 17. and 20.10.2026, TODO #91):
 * fixed colours and type for the folders of a typical family card and every
 * recommendation in "Entdecken" (tests/stickers/works-recipes.test.ts).
 * The type follows the research in design/hoerspiel-layouts-schriften.md
 * and the type of the 0.3 cover recipes: narrow and black for detective
 * series, the loud poster type for TV heroes, the soft picture-book serif
 * for the old picture-book and Thienemann classics, a book serif for
 * novels, a hand for diaries, and the plain grotesque of the ARD/WDR radio
 * plays and of grown-up albums. Round, the default, needs no entry.
 */
import { recognize, type FolderFacts } from '../covers/recognize';
import type { FontChoice, Recipe, Recognition } from '../covers/recipe';

/** The colours of one work. Hex colours as "#rrggbb". */
export interface WorkScheme {
  id: string;
  /** Shown to the user: "Die drei ???". */
  name: string;
  /** serie: numbered episodes; titel: one title (or a few); kuenstler: all albums of an artist. */
  art: Recipe['art'];
  erkennen: Recognition;
  /** Band and title field of "Kassette", panel of the shelf's card; "cover": taken from each cover. */
  band: string;
  /** The number plate: always light, like the number of Vollbild. */
  plate: string;
  /** The digits on the plate. */
  digits: string;
  /** The sticker font of the series where it has a type of its own (narrow and black on the EUROPA detective series). */
  font?: FontChoice;
}

/** What a sticker carries of a recognised work (StickerItem.work). */
export interface WorkColors {
  id: string;
  name: string;
  /** Missing: the band comes from the cover. */
  band?: string;
  plate: string;
  digits: string;
  font?: FontChoice;
}

type Colors = [band: string, plate: string, digits: string];

function scheme(art: WorkScheme['art'], id: string, name: string, erkennen: Recognition, [band, plate, digits]: Colors): WorkScheme {
  return { id, name, art, erkennen, band, plate, digits };
}

const serie = (id: string, name: string, titel: string[], colors: Colors, x: Omit<Recognition, 'titel'> = {}) => scheme('serie', id, name, { titel, ...x }, colors);
const titel = (id: string, name: string, titel: string[], colors: Colors, x: Omit<Recognition, 'titel'> = {}) => scheme('titel', id, name, { titel, ...x }, colors);
const kuenstler = (id: string, name: string, kuenstler: string[], colors: Colors, titel?: string[]) => scheme('kuenstler', id, name, { kuenstler, titel }, colors);
/** A work with a type of its own. */
const typed = (font: FontChoice, s: WorkScheme): WorkScheme => ({ ...s, font });

/** Band "cover": the band follows each cover, the work only brings plate and digits. */
const COVER = 'cover';

export const WORKS: readonly WorkScheme[] = [
  /* ---------------------------------------------------------------- detective and adventure series */
  // Black covers, the logo's question marks in white, red and blue.
  { ...serie('die-drei-fragezeichen', 'Die drei ???', ['Die drei ???', 'Die drei Fragezeichen'], ['#141414', '#ffffff', '#d7141a'], { nicht: ['kids'] }), font: 'detective' },
  // Bright covers with the red "Kids" logo on yellow.
  serie('die-drei-fragezeichen-kids', 'Die drei ??? Kids', ['Die drei ??? Kids', 'Die drei Fragezeichen Kids'], ['#d9141c', '#ffd500', '#1a1a1a']),
  // Pink logo with three exclamation marks.
  typed('comic', serie('die-drei-ausrufezeichen', 'Die drei !!!', ['Die drei !!!', 'Die drei Ausrufezeichen'], ['#e4007c', '#ffffff', '#c4006b'])),
  // Red "TKKG" with yellow edges over the picture.
  { ...serie('tkkg', 'TKKG', ['TKKG'], ['#c4161c', '#ffd200', '#1a1a1a'], { nicht: ['junior'] }), font: 'detective' },
  serie('tkkg-junior', 'TKKG Junior', ['TKKG Junior'], ['#0a8fd1', '#ffd200', '#c4161c']),
  // Yellow-orange title band, red lettering.
  { ...serie('fuenf-freunde', 'Fünf Freunde', ['Fünf Freunde', '5 Freunde'], ['#f39c00', '#ffffff', '#c4161c']), font: 'detective' },
  serie('hanni-und-nanni', 'Hanni und Nanni', ['Hanni und Nanni', 'Hanni & Nanni'], ['#d1477a', '#ffffff', '#1f5a9c']),
  typed('comic', serie('die-wilden-kerle', 'Die Wilden Kerle', ['Die Wilden Kerle'], ['#161616', '#ffffff', '#e2001a'])),
  typed('comic', serie('die-wilden-huehner', 'Die Wilden Hühner', ['Die Wilden Hühner'], ['#b8202a', '#fff3c4', '#2a2a2a'])),
  serie('emil-und-die-detektive', 'Emil und die Detektive', ['Emil und die Detektive'], ['#1e1e1e', '#ffd400', '#c8102e']),
  // Haunted castle at night, the ghost pale green.
  typed('comic', serie('hui-buh', 'Hui Buh', ['Hui Buh'], ['#2c2459', '#e0f3a6', '#2c2459'])),
  typed('storybook', serie('der-kleine-vampir', 'Der kleine Vampir', ['Der kleine Vampir'], ['#2a1f3d', '#f0e6c8', '#9e1b32'])),
  serie('das-magische-baumhaus', 'Das magische Baumhaus', ['Das magische Baumhaus'], ['#2f6f3e', '#fff1c2', '#7a3b12']),

  /* ---------------------------------------------------------------- KIDDINX, Europa and friends */
  // Light-blue elephant, the logo yellow with a red edge, blue sky.
  serie('benjamin-bluemchen', 'Benjamin Blümchen', ['Benjamin Blümchen'], ['#2f8ad3', '#ffe100', '#d6001c']),
  // Violet night sky, the logo in yellow.
  serie('bibi-blocksberg', 'Bibi Blocksberg', ['Bibi Blocksberg'], ['#7d3a96', '#fff1a8', '#7d3a96']),
  // The pink "Bibi & Tina" logo, also on the film soundtracks.
  serie('bibi-und-tina', 'Bibi & Tina', ['Bibi und Tina', 'Bibi & Tina'], ['#e2007a', '#ffffff', '#c4006b']),
  // Red hair, yellow shirt, green trousers.
  typed('storybook', serie('pumuckl', 'Pumuckl', ['Pumuckl', 'Meister Eder'], ['#e3051b', '#ffe500', '#00843d'], { entdecken: ['br-pumuckl-folgen'] })),
  serie('die-playmos', 'Die Playmos', ['Die Playmos'], ['#0b5ea8', '#ffd200', '#e2001a']),
  serie('wieso-weshalb-warum', 'Wieso? Weshalb? Warum?', ['Wieso Weshalb Warum'], ['#0f5ea8', '#ffd400', '#e2001a']),
  // Yellow letters on the red band.
  typed('clear', serie('was-ist-was', 'Was ist was', ['Was ist was'], ['#d1001f', '#ffd500', '#b0001a'])),
  typed('clear', serie('loewenzahn', 'Löwenzahn', ['Löwenzahn'], ['#2f6db4', '#ffd400', '#2a6a2a'])),
  typed('clear', serie('die-sendung-mit-der-maus', 'Die Sendung mit der Maus', ['Sendung mit der Maus'], ['#f07d14', '#ffffff', '#1c6db6'])),
  // Night blue, red pointed hat.
  serie('sandmaennchen', 'Unser Sandmännchen', ['Sandmännchen'], ['#1f3a6e', '#ffffff', '#d2232a'], { entdecken: ['rbb-unser-sandmaennchen'] }),

  /* ---------------------------------------------------------------- picture book and TV heroes */
  // Little orange dragon, the jungle green.
  serie('drache-kokosnuss', 'Der kleine Drache Kokosnuss', ['Drache Kokosnuss', 'kleine Drache Kokosnuss'], ['#e9661b', '#fff6cc', '#2e7d32']),
  // Red spiky hair and blue wish dots.
  typed('storybook', serie('das-sams', 'Das Sams', ['Das Sams', 'Sams', 'Eine Woche voller Samstage'], ['#1c6fb5', '#ffffff', '#e2001a'])),
  // The sky blue of the printed frame (Silberfisch audio play, Frank's folder 45), brown of the robber.
  typed('storybook', serie('raeuber-hotzenplotz', 'Der Räuber Hotzenplotz', ['Räuber Hotzenplotz', 'Hotzenplotz'], ['#30a7df', '#fff3d6', '#8b1e1e'])),
  serie('sternenschweif', 'Sternenschweif', ['Sternenschweif'], ['#5a2a82', '#fde4f2', '#c2186b']),
  // Teal covers with the orange title.
  serie('schule-der-magischen-tiere', 'Die Schule der magischen Tiere', ['Schule der magischen Tiere'], ['#0f7c8c', '#ffd84d', '#c0392b']),
  // The police badge: blue and red.
  typed('comic', serie('paw-patrol', 'Paw Patrol', ['Paw Patrol'], ['#1b4f9c', '#ffffff', '#e30613'])),
  serie('conni', 'Conni', ['Conni', 'Meine Freundin Conni'], ['#e30613', '#ffffff', '#c8102e']),
  // Findus's green trousers, warm light covers.
  typed('storybook', serie('pettersson-und-findus', 'Pettersson und Findus', ['Pettersson und Findus', 'Petterson und Findus', 'Findus'], ['#4f9a3a', '#fff7da', '#c0392b'])),
  // Green creatures, yellow title.
  typed('comic', serie('die-olchis', 'Die Olchis', ['Olchis', 'Olchi'], ['#5f8f1e', '#f9e04b', '#5a3714'])),
  // Dark blue night, the yellow star.
  serie('lauras-stern', 'Lauras Stern', ['Lauras Stern', 'Laura s Stern'], ['#1c3b80', '#ffd84a', '#1c3b80']),
  // Forest green, the Grüffelo orange and brown.
  serie('grueffelo', 'Der Grüffelo', ['Grüffelo', 'Grüffelokind'], ['#2f6b2a', '#ffcf6e', '#7a3510']),
  typed('comic', serie('peppa-wutz', 'Peppa Wutz', ['Peppa Wutz', 'Peppa Pig'], ['#e8649d', '#ffffff', '#b3175a'])),
  // Red fire engine, yellow and blue.
  typed('comic', serie('feuerwehrmann-sam', 'Feuerwehrmann Sam', ['Feuerwehrmann Sam'], ['#d7141a', '#ffd200', '#003c8f'])),
  typed('comic', serie('yakari', 'Yakari', ['Yakari'], ['#c25a1c', '#ffe7a8', '#1f4f8f'])),
  typed('comic', serie('biene-maja', 'Die Biene Maja', ['Biene Maja'], ['#3f8c2c', '#ffd400', '#1a1a1a'])),
  typed('storybook', serie('heidi', 'Heidi', ['Heidi'], ['#3d8b37', '#ffffff', '#c8102e'])),
  typed('comic', serie('wickie', 'Wickie', ['Wickie'], ['#1f5fa8', '#ffd200', '#c8102e'])),
  serie('bobo-siebenschlaefer', 'Bobo Siebenschläfer', ['Bobo Siebenschläfer'], ['#2f78c4', '#ffffff', '#e2001a']),
  serie('leo-lausemaus', 'Leo Lausemaus', ['Leo Lausemaus'], ['#e2381b', '#ffffff', '#c22d14']),
  serie('rabe-socke', 'Der kleine Rabe Socke', ['Rabe Socke'], ['#3b8c2e', '#ffffff', '#d0202a']),
  serie('der-kleine-eisbaer', 'Der kleine Eisbär', ['Der kleine Eisbär', 'kleine Eisbär'], ['#2a78bf', '#ffffff', '#2a78bf']),
  typed('comic', serie('die-schluempfe', 'Die Schlümpfe', ['Schlümpfe', 'Schlumpf'], ['#2a8fd6', '#ffffff', '#e2001a'])),
  serie('der-kleine-maulwurf', 'Der kleine Maulwurf', ['kleine Maulwurf'], ['#3b8f3a', '#ffffff', '#1a1a1a']),
  serie('barbapapa', 'Barbapapa', ['Barbapapa'], ['#e57fae', '#ffffff', '#1a1a1a']),
  typed('comic', serie('bluey', 'Bluey', ['Bluey'], ['#4f87c7', '#fff3b0', '#1d3f7a'])),
  serie('mama-muh', 'Mama Muh', ['Mama Muh'], ['#6aaa3a', '#ffffff', '#1a1a1a']),
  serie('lieselotte', 'Lieselotte', ['Lieselotte'], ['#c0392b', '#fff3c4', '#1a1a1a']),
  serie('monika-haeuschen', 'Die kleine Schnecke Monika Häuschen', ['Monika Häuschen'], ['#79b83a', '#fff4b8', '#7a3b12']),
  typed('hand', serie('lotta-leben', 'Mein Lotta-Leben', ['Lotta Leben'], ['#2bb3c0', '#ffffff', '#e5007d'])),
  serie('liliane-susewind', 'Liliane Susewind', ['Liliane Susewind'], ['#00a19a', '#ffffff', '#d6336c']),
  serie('ostwind', 'Ostwind', ['Ostwind'], ['#1f3f6e', '#ffffff', '#8b4a1c']),
  serie('prinzessin-lillifee', 'Prinzessin Lillifee', ['Lillifee'], ['#d6338a', '#fde3ef', '#6a1b5a']),
  serie('hexe-lilli', 'Hexe Lilli', ['Hexe Lilli'], ['#6a2c8e', '#ffffff', '#e94e1b']),
  serie('drachenzaehmen', 'Drachenzähmen leicht gemacht', ['Drachenzähmen leicht gemacht', 'Drachenzähmen'], ['#2a3d4f', '#ffcf5a', '#8b1a1a']),
  serie('nils-holgersson', 'Nils Holgersson', ['Nils Holgersson'], ['#2a7fc0', '#ffffff', '#a0522d']),
  // Each book its own colour, the title handwritten on lined paper.
  typed('hand', serie('gregs-tagebuch', 'Gregs Tagebuch', ['Gregs Tagebuch', 'Greg s Tagebuch'], [COVER, '#ffffff', '#1a1a1a'])),
  // Each book its own picture; the lettering gold, the house red.
  serie('harry-potter', 'Harry Potter', ['Harry Potter'], [COVER, '#f3dc9b', '#5a1a1a']),

  /* ---------------------------------------------------------------- classics */
  // Blue cap, red scarf.
  typed('storybook', serie('michel-aus-loenneberga', 'Michel aus Lönneberga', ['Michel aus Lönneberga', 'Michel in der Suppenschüssel'], ['#2265ad', '#ffffff', '#d22630'])),
  typed('storybook', serie('pippi-langstrumpf', 'Pippi Langstrumpf', ['Pippi Langstrumpf'], ['#e8511d', '#fff3c8', '#1f5aa8'])),
  typed('storybook', titel('ronja-raeubertochter', 'Ronja Räubertochter', ['Ronja Räubertochter'], ['#2e5b2a', '#f2e2b6', '#8b2a1a'])),
  typed('storybook', titel('karlsson-vom-dach', 'Karlsson vom Dach', ['Karlsson vom Dach'], ['#2a6fb4', '#ffffff', '#d2232a'])),
  // Emma the locomotive, black and red.
  typed('storybook', serie('jim-knopf', 'Jim Knopf', ['Jim Knopf'], ['#c62828', '#ffd54f', '#1a1a1a'])),
  // The copper red book with the gold Auryn.
  typed('book', titel('die-unendliche-geschichte', 'Die unendliche Geschichte', ['Die unendliche Geschichte', 'unendliche Geschichte'], ['#8b1e2b', '#ecc66a', '#5a0f18'])),
  typed('book', titel('momo', 'Momo', ['Momo'], ['#a4472a', '#f5e1b0', '#3a2a1a'], { kuenstler: ['Michael Ende'] })),
  // The black night sky (see the recipe), the moon.
  typed('storybook', titel('das-kleine-gespenst', 'Das kleine Gespenst', ['Das kleine Gespenst', 'kleine Gespenst'], ['#121826', '#fff3a8', '#121826'])),
  typed('storybook', titel('die-kleine-hexe', 'Die kleine Hexe', ['Die kleine Hexe'], [COVER, '#fff6e0', '#2a2a2a'], { kuenstler: ['Otfried Preußler'] })),
  typed('storybook', titel('der-kleine-wassermann', 'Der kleine Wassermann', ['Der kleine Wassermann', 'kleine Wassermann'], ['#1a7fa8', '#ffffff', '#156a8d'])),
  typed('book', titel('krabat', 'Krabat', ['Krabat'], ['#2a2a2a', '#e9d9a6', '#5a1a1a'])),
  typed('book', titel('der-hobbit', 'Der Hobbit', ['Der Hobbit', 'Hobbit'], [COVER, '#e8c872', '#2f3f1f'], { kuenstler: ['Tolkien', 'J R R Tolkien'] })),
  // The three books: Tintenherz red, Tintenblut blue, Tintentod green, each with gold.
  typed('book', titel('tintenherz', 'Tintenherz', ['Tintenherz'], ['#a51f24', '#f1d27a', '#5a1014'])),
  typed('book', titel('tintenblut', 'Tintenblut', ['Tintenblut'], ['#1d3f7a', '#f1d27a', '#14294f'])),
  typed('book', titel('tintentod', 'Tintentod', ['Tintentod'], ['#2e6b3a', '#f1d27a', '#1b3f22'])),
  // Blue sky with stars, the yellow scarf.
  typed('book', titel('der-kleine-prinz', 'Der kleine Prinz', ['Der kleine Prinz'], ['#1f4e8c', '#ffd54a', '#1f4e8c'], { entdecken: ['wdr-kleiner-prinz'] })),
  // Green caterpillar with the red head on white.
  titel('raupe-nimmersatt', 'Die kleine Raupe Nimmersatt', ['Raupe Nimmersatt'], ['#6aab2d', '#ffffff', '#d7261e']),
  titel('regenbogenfisch', 'Der Regenbogenfisch', ['Regenbogenfisch'], ['#1c74b8', '#dff3fb', '#6b2f99']),
  typed('comic', titel('das-neinhorn', 'Das NEINhorn', ['Neinhorn'], ['#e2558f', '#ffffff', '#2e2a6b'])),
  titel('das-dschungelbuch', 'Das Dschungelbuch', ['Dschungelbuch'], ['#2f7a2f', '#ffd27a', '#7a3510']),
  typed('comic', titel('die-eiskoenigin', 'Die Eiskönigin', ['Die Eiskönigin', 'Eiskönigin', 'Frozen'], ['#2a7fc4', '#e8f6ff', '#5b3a9a'])),
  typed('comic', titel('der-koenig-der-loewen', 'Der König der Löwen', ['König der Löwen'], ['#e07a1f', '#fff1cc', '#7a2e0e'])),
  // The tiger duck and the banana crate "Panama": yellow, orange and black.
  typed('storybook', titel('oh-wie-schoen-ist-panama', 'Oh, wie schön ist Panama', ['Oh wie schön ist Panama', 'wie schön ist Panama'], ['#ee9a00', '#fff8dc', '#1a1a1a'])),
  typed('storybook', kuenstler('janosch', 'Janosch', ['Janosch'], ['#ee9a00', '#fff8dc', '#1a1a1a'], ['Tigerente'])),

  /* ---------------------------------------------------------------- music */
  // Every album its own picture: the band from each cover, a warm plate with Rolf's red.
  // His Christmas albums often carry a song title in the artist field, so they are named too.
  kuenstler('rolf-zuckowski', 'Rolf Zuckowski', ['Rolf Zuckowski', 'Rolf und seine Freunde'], [COVER, '#fff4c2', '#c62f24'], [
    'Rolf und seine Freunde',
    'Rolfs Vogelhochzeit',
    'Radio Lollipop',
    'Winterkinder',
    'Dezemberträume',
  ]),
  // Every volume its own picture; a cream plate with the night blue of the series.
  serie('unter-meinem-bett', 'Unter meinem Bett', ['Unter meinem Bett'], [COVER, '#fff7e6', '#1d2f5e']),
  typed('comic', kuenstler('deine-freunde', 'Deine Freunde', ['Deine Freunde'], ['#1d1d1b', '#ffe500', '#1d1d1b'])),
  // The frogs of the Kita-Frösche: green, with red.
  kuenstler('simone-sommerland', 'Simone Sommerland', ['Simone Sommerland', 'Karsten Glück', 'Kita-Frösche'], ['#4f9e2d', '#ffffff', '#d92f2a'], ['Die 30 besten']),

  /* ---------------------------------------------------------------- on a typical family card */
  // Photos of the two cooks on white, the title in yellow with a red edge. "Party am Herd" has another photo; both are named, the artist field is often short or empty.
  typed('comic', kuenstler('zaches-und-zinnober', 'Zaches & Zinnober', ['Zaches & Zinnober', 'Zaches'], [COVER, '#fff3a6', '#c8202a'], ['Konzert am Herd', 'Party am Herd'])),
  // Bright yellow, the hands' nails pink and blue, the title in pink-red: the spine takes the pink.
  titel('zehn-kleine-zappelmaenner', 'Zehn kleine Zappelmänner', ['Zehn kleine Zappelmänner'], ['#d61b76', '#ffee00', '#1a1a1a'], { kuenstler: ['Schnabi Schnabel'] }),
  // Drawn animals under a turquoise sky; "Spuckepack" in red-orange. Its albums are named, as a song often stands in the artist field.
  typed('comic', kuenstler('sven-van-thom', 'Sven van Thom', ['Sven van Thom'], [COVER, '#fff4c2', '#b04a20'], ['Spuckepack', 'Tanz den Spatz'])),
  // Light sky, a blue shark reading; the letters of "LiBaTiBa" red, orange and blue.
  kuenstler('libatiba', 'LiBaTiBa', ['LiBaTiBa'], [COVER, '#ffffff', '#c8402a']),
  kuenstler('philipp-und-die-heldenbande', 'Philipp und die Heldenbande', ['Philipp und die Heldenbande'], [COVER, '#fff4c2', '#1a1a1a']),
  // Lullabies: a night blue.
  kuenstler('ena-kinderlieder', 'Ena Kinderlieder', ['Ena Kinderlieder'], [COVER, '#fff7e6', '#1d2f5e']),
  kuenstler('rolltreppenmax', 'Rolltreppenmax', ['Rolltreppenmax'], [COVER, '#fff4c2', '#1a1a1a']),
  kuenstler('reggaewurm', 'Reggaewurm', ['Reggaewurm'], [COVER, '#fff4c2', '#1a1a1a'], ['Radio Auweia']),
  titel('mucksmaeuschenlaut', 'Mucksmäuschenlaut', ['Mucksmäuschenlaut'], [COVER, '#fff4c2', '#1a1a1a']),
  // Each album its own picture (Christmas: "Nenas Weihnachtsreise").
  kuenstler('nena', 'Nena', ['Nena'], [COVER, '#ffffff', '#1a1a1a'], ['Nenas Weihnachtsreise']),
  // The film's pink, the soundtrack's cover too.
  serie('barbie', 'Barbie', ['Barbie'], ['#e0218a', '#ffffff', '#b0105f']),
  // Every album its own picture; the comic type of the music audio plays.
  typed('comic', serie('eule-findet-den-beat', 'Eule findet den Beat', ['Eule findet den Beat'], [COVER, '#fff6cc', '#1a1a1a'])),
  typed('storybook', titel('entlein-in-der-grossen-stadt', 'Entlein in der großen Stadt', ['Entlein in der großen Stadt'], [COVER, '#fff7e0', '#1a1a1a'], { kuenstler: ['klangentdecker'] })),
  // Grown-up albums: every album its own picture, a plain plate and the grotesque of record sleeves.
  typed('clear', kuenstler('the-beatles', 'The Beatles', ['The Beatles'], [COVER, '#ffffff', '#1a1a1a'])),
  typed('clear', kuenstler('the-doors', 'The Doors', ['The Doors'], [COVER, '#f2efe6', '#1a1a1a'])),
  // The red of the band's target sign.
  typed('clear', kuenstler('the-who', 'The Who', ['The Who'], [COVER, '#ffffff', '#c8102e'])),
  // The sepia photo of "Bridge Over Troubled Water".
  typed('clear', kuenstler('simon-und-garfunkel', 'Simon & Garfunkel', ['Simon & Garfunkel', 'Simon and Garfunkel'], [COVER, '#f6efe2', '#5a3a22'])),
  typed('clear', kuenstler('the-kooks', 'The Kooks', ['The Kooks'], [COVER, '#ffffff', '#1a1a1a'])),
  typed('clear', kuenstler('fleet-foxes', 'Fleet Foxes', ['Fleet Foxes'], [COVER, '#fbf6ea', '#2f4a3a'])),
  typed('clear', kuenstler('zaz', 'Zaz', ['Zaz'], [COVER, '#ffffff', '#1a1a1a'])),

  /* ---------------------------------------------------------------- recommended in "Entdecken" (sources/catalog.json, featured) */
  // Radio plays of ARD and WDR: every story its own picture, the plain grotesque of the radio tiles.
  // The Maus's orange.
  typed('clear', serie('maushoerspiel', 'MausHörspiel', ['MausHörspiel', 'Maus Hörspiel'], [COVER, '#ffffff', '#c45a0c'], { entdecken: ['wdr-maushoerspiel-kurz', 'wdr-maushoerspiel-lang'] })),
  typed('clear', serie('ohrenbaer', 'Ohrenbär', ['Ohrenbär'], [COVER, '#ffffff', '#1f3a6e'], { entdecken: ['rbb-ohrenbaer'] })),
  typed('clear', serie('ard-hoerspielklassiker', 'Hörspielklassiker für Kinder', ['Hörspielklassiker für Kinder'], [COVER, '#ffffff', '#00305e'], { entdecken: ['ard-hoerspielklassiker'] })),
  // The little desert fox: sand and its reddish brown.
  serie('mucks-wuestenfuchs', 'Mucks Wüstenfuchs', ['Mucks Wüstenfuchs'], [COVER, '#fff4dc', '#9a4a1a'], { entdecken: ['hr-mucks-wuestenfuchs'] }),
  typed('clear', serie('die-mumins', 'Die Mumins', ['Mumins', 'Mumintal', 'Mumin'], [COVER, '#ffffff', '#1f5a9c'], { entdecken: ['wdr-mumins'] })),
  // A detective gang: the narrow type of the detective series.
  typed('detective', serie('die-pfefferkoerner', 'Die Pfefferkörner', ['Pfefferkörner'], [COVER, '#ffffff', '#1a1a1a'], { entdecken: ['ndr-pfefferkoerner'] })),
  // The brown bear.
  serie('dr-brumm', 'Dr. Brumm', ['Dr Brumm', 'Doktor Brumm'], [COVER, '#fff4dc', '#7a3b12'], { entdecken: ['rbb-dr-brumm'] }),
];

/** The scheme of a folder or a picture, or null when it is no work the app knows. */
export function recognizeWork(f: FolderFacts): WorkScheme | null {
  return recognize(f, WORKS)?.recipe ?? null;
}

const byEntry = new WeakMap<object, WorkColors | null>();
const byTitle = new Map<string, WorkColors | null>();

/** The colours a sticker of this work carries. */
export function colorsOf(s: WorkScheme): WorkColors {
  return { id: s.id, name: s.name, band: s.band === COVER ? undefined : s.band, plate: s.plate, digits: s.digits, ...(s.font ? { font: s.font } : {}) };
}

/** The colours of a folder's work, kept per catalog entry (a changed entry is a new object). */
export function workColors(entry: FolderFacts | undefined): WorkColors | undefined {
  if (!entry) return undefined;
  let c = byEntry.get(entry);
  if (c === undefined) {
    const s = recognizeWork(entry);
    c = s ? colorsOf(s) : null;
    byEntry.set(entry, c);
  }
  return c ?? undefined;
}

/** The colours of the work a picture shows, by its title alone (own pictures: "05_Bibi Blocksberg.jpg"). */
export function workColorsByTitle(title: string): WorkColors | undefined {
  let c = byTitle.get(title);
  if (c === undefined) {
    const s = recognizeWork({ title });
    c = s ? colorsOf(s) : null;
    // A long list of own pictures stays cheap; the cache never grows without end.
    if (byTitle.size >= 500) byTitle.clear();
    byTitle.set(title, c);
  }
  return c ?? undefined;
}
