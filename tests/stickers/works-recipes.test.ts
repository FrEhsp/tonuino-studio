/**
 * The 0.5 sticker recipes (TODO #91): every folder of a typical family card
 * and every recommendation in "Entdecken" finds its work in
 * src/core/stickers/works.ts, so its sticker gets fixed colours and type
 * instead of guessed ones.
 *
 * The sample card below is made up (album names, volume numbers, songs),
 * but it carries the traps such cards have: song titles in the artist
 * field (05, 16, 20, 26, 28), a downloader's name before the album
 * (17, 22, 23), the reader or no one as artist, audio plays marked as
 * music and the other way round (the kind is not part of the recognition,
 * so it cannot mislead it).
 */
import { describe, expect, it } from 'vitest';
import { recognizeWork, WORKS } from '../../src/core/stickers/works';
import type { FolderFacts } from '../../src/core/covers/recognize';
import { recommendations } from '../../src/core/sources/filter';
import type { SourceIndex } from '../../src/core/sources/types';
import snapshot from '../../sources/snapshot/index-v1.json';
import catalog from '../../sources/catalog.json';

type Folder = FolderFacts & { nr: string; work: string };

/** Track artists of a folder: mostly the album's artist, one guest or song title in between. */
const by = (artist: string, n = 4) => Array.from({ length: n }, (_, i) => ({ title: `Titel ${i + 1}`, artist: i === 2 ? 'feat. Gäste' : artist }));

const SAMPLE_CARD: readonly Folder[] = [
  { nr: '01', work: 'zaches-und-zinnober', title: 'Kochlöffel-Konzert', artist: 'Zaches' },
  { nr: '02', work: 'unter-meinem-bett', title: 'Unter meinem Bett 3', artist: 'Diverse Interpreten' },
  { nr: '03', work: 'the-beatles', title: 'Greatest Songs (Remastered)', artist: 'The Beatles' },
  { nr: '04', work: 'zehn-kleine-zappelmaenner', title: 'Zehn kleine Zappelmänner', artist: 'Schnabi Schnabel' },
  // The artist field holds the first song; the tracks name the artist.
  { nr: '05', work: 'sven-van-thom', title: 'Lieder vom Dachboden', artist: 'Guten Morgen, Sonne', tracks: by('Sven van Thom') },
  { nr: '06', work: 'libatiba', title: 'Lieder zum Mitsingen - EP', artist: 'Libatiba' },
  { nr: '07', work: 'the-doors', title: '(1999-01-01) The Very Best Of The Doors' },
  { nr: '08', work: 'the-who', title: 'Greatest Hits Disc 2', artist: 'The Who' },
  // No cover on the card; the app fetches one.
  { nr: '09', work: 'simon-und-garfunkel', title: 'The Concert [Bonus Tracks]', artist: 'Simon & Garfunkel' },
  { nr: '10', work: 'philipp-und-die-heldenbande', title: 'Ein Tag am Meer', artist: 'Philipp und die Heldenbande' },
  { nr: '11', work: 'ena-kinderlieder', title: 'Schlaflieder für die Nacht', artist: 'Ena Kinderlieder' },
  { nr: '12', work: 'the-kooks', title: 'Live In Concert', artist: 'The Kooks' },
  { nr: '13', work: 'fleet-foxes', title: 'Songs From The Forest', artist: 'Fleet Foxes' },
  // An audiobook without album artist: the author is in the tracks.
  { nr: '14', work: 'der-hobbit', title: 'Der Hobbit', tracks: by('J.R.R. Tolkien', 6).map((t, i) => ({ ...t, artist: 'J.R.R. Tolkien', title: `Kapitel ${i + 1}` })) },
  { nr: '15', work: 'rolf-zuckowski', title: 'Lieder für den Sommer', artist: 'Rolf Zuckowski' },
  // The album is named in the work, the artist field holds a song.
  { nr: '16', work: 'sven-van-thom', title: 'Tanz den Spatz', artist: 'Der Hüpfekäfer' },
  { nr: '17', work: 'zaz', title: 'SomeDownloader.com - Zaz – Chansons du soir' },
  { nr: '18', work: 'bibi-und-tina', title: 'Bibi und Tina: Ferien auf dem Hof (Soundtrack)' },
  { nr: '19', work: 'eule-findet-den-beat', title: 'Eule findet den Beat – Im Winter' },
  { nr: '20', work: 'unter-meinem-bett', title: 'Unter meinem Bett 2', artist: 'Der Mond Schläft Nie' },
  { nr: '21', work: 'unter-meinem-bett', title: 'Unter meinem Bett' },
  { nr: '22', work: 'eule-findet-den-beat', title: 'Somedownloader.Com - Eule Findet Den Beat (Musik-Hörspiel)' },
  { nr: '23', work: 'unter-meinem-bett', title: 'SomeDownloader.com - Unter meinem Bett 4' },
  { nr: '24', work: 'nena', title: 'Nenas Weihnachtsreise', artist: 'Nena' },
  { nr: '25', work: 'bibi-blocksberg', title: 'Bibi Blocksberg – Der Hexenbesen (Soundtrack)' },
  { nr: '26', work: 'rolf-zuckowski', title: 'Winterkinder', artist: 'Schnee auf dem Dach' },
  { nr: '27', work: 'rolltreppenmax', title: 'Neue Lieder', artist: 'Rolltreppenmax' },
  { nr: '28', work: 'simone-sommerland', title: 'Die 30 besten Bewegungslieder', artist: 'Hopp, hopp, das Pferdchen' },
  { nr: '29', work: 'mucksmaeuschenlaut', title: 'Mucksmäuschenlaut' },
  { nr: '30', work: 'zaches-und-zinnober', title: 'Konzert am Herd – Party am Herd' },
  { nr: '31', work: 'reggaewurm', title: 'Sonne im Garten', artist: 'Reggaewurm' },
  { nr: '32', work: 'barbie', title: 'Barbie The Album' },
  // 33–37 audio plays marked as music; the reader or the author's last name as artist.
  { nr: '33', work: 'das-kleine-gespenst', title: 'Das kleine Gespenst – Hörspiel', artist: 'Eine Sprecherin' },
  { nr: '34', work: 'oh-wie-schoen-ist-panama', title: 'Oh, wie schön ist Panama', artist: 'Janosch' },
  { nr: '35', work: 'die-unendliche-geschichte', title: 'Die unendliche Geschichte (Hörspiel)', artist: 'Michael Ende' },
  { nr: '36', work: 'raeuber-hotzenplotz', title: 'Der Räuber Hotzenplotz – Das Hörspiel', artist: 'Preußler' },
  { nr: '37', work: 'die-kleine-hexe', title: 'Die kleine Hexe – Hörspiel', artist: 'Preußler' },
  { nr: '38', work: 'entlein-in-der-grossen-stadt', title: 'Entlein in der großen Stadt', artist: 'klangentdecker' },
];

describe('the recipes for a sample card', () => {
  it('lists all 38 folders once', () => {
    expect(SAMPLE_CARD.map((f) => f.nr)).toEqual(Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')));
    const ids = new Set(WORKS.map((w) => w.id));
    for (const f of SAMPLE_CARD) expect(ids.has(f.work), f.work).toBe(true);
  });

  it('finds the right work for every folder, traps and all', () => {
    const wrong = SAMPLE_CARD.filter((f) => recognizeWork(f)?.id !== f.work).map((f) => `${f.nr} ${f.title}: ${recognizeWork(f)?.id ?? 'nichts'}`);
    expect(wrong).toEqual([]);
  });

  it('finds them also from the cleaned names the app shows (album artist, no downloader noise)', () => {
    const clean: [FolderFacts, string][] = [
      [{ title: 'Lieder vom Dachboden', artist: 'Sven van Thom' }, 'sven-van-thom'],
      [{ title: 'Tanz den Spatz', artist: 'Sven van Thom' }, 'sven-van-thom'],
      [{ title: 'Chansons du soir', artist: 'Zaz' }, 'zaz'],
      [{ title: 'Eule findet den Beat (Musik-Hörspiel)', artist: 'Eule findet den Beat' }, 'eule-findet-den-beat'],
      [{ title: 'Unter meinem Bett 2', artist: 'Diverse Interpreten' }, 'unter-meinem-bett'],
      [{ title: 'Party am Herd', artist: 'Zaches & Zinnober' }, 'zaches-und-zinnober'],
      [{ title: 'Winterkinder', artist: 'Rolf Zuckowski' }, 'rolf-zuckowski'],
      [{ title: 'The Concert', artist: 'Simon and Garfunkel' }, 'simon-und-garfunkel'],
      [{ title: 'Der Hobbit', artist: 'J. R. R. Tolkien' }, 'der-hobbit'],
    ];
    for (const [f, work] of clean) expect(recognizeWork(f)?.id, f.title).toBe(work);
  });

  it('leaves a band to the cover where the albums of a work look different, and fixes it where one cover is the work', () => {
    const band = (nr: string) => recognizeWork(SAMPLE_CARD.find((f) => f.nr === nr)!)!.band;
    expect(band('03')).toBe('cover');
    expect(band('15')).toBe('cover');
    expect(band('04')).toBe('#d61b76');
    expect(band('32')).toBe('#e0218a');
    // The sky blue of the Silberfisch frame.
    expect(band('36')).toBe('#30a7df');
  });
});

const index = snapshot as unknown as SourceIndex;
const featured = index.entries.filter((e) => e.featured);

describe('the recipes for the recommendations in "Entdecken"', () => {
  it('cover every recommended source and every story in it', () => {
    expect(featured.length).toBeGreaterThanOrEqual(11);
    const missing: string[] = [];
    for (const e of featured) {
      for (const it of e.items) {
        // A folder added from "Entdecken" carries the story's title and where it came from.
        const f: FolderFacts = { title: it.title, origins: [{ entry: e.id, series: e.title, title: it.title }] };
        if (!recognizeWork(f)) missing.push(`${e.id}: ${it.title}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('cover every pick the page shows, for every kind', () => {
    const picks = recommendations(index);
    expect(picks.length).toBeGreaterThan(20);
    for (const category of ['hoerspiel', 'hoerbuch', 'lied'] as const) picks.push(...recommendations(index, { category }));
    for (const r of picks) {
      const it = r.item ?? r.items[0];
      expect(recognizeWork({ title: r.story ?? it.title, origins: [{ entry: r.entry.id, series: r.entry.title, title: it.title }] }), `${r.entry.id}: ${it.title}`).not.toBeNull();
    }
  });

  it('knows the recommended shows by name too, as when the files come without their origin', () => {
    const named: [string, string][] = [
      ['MausHörspiel kurz: Flattervogelfest', 'maushoerspiel'],
      ['Ohrenbär: Geistchen und Eule im Nachtwald', 'ohrenbaer'],
      ['Mucks Wüstenfuchs: Auf dem Bauernhof', 'mucks-wuestenfuchs'],
      ['Die Mumins: Komet im Mumintal (1/4)', 'die-mumins'],
      ['Die Pfefferkörner – Die Kakao-Krake', 'die-pfefferkoerner'],
      ['Dr. Brumm geht tanzen', 'dr-brumm'],
      ['Meister Eder und sein Pumuckl: Pumuckl im Zoo', 'pumuckl'],
      ['Unser Sandmännchen: Der einsame Hausschuh', 'sandmaennchen'],
      ['Der kleine Prinz und seine Freunde: Pfeifstern', 'der-kleine-prinz'],
    ];
    for (const [title, work] of named) expect(recognizeWork({ title })?.id, title).toBe(work);
  });

  it('names every recommended source of the editors’ list by its id, so a story finds its show whatever its title', () => {
    const ids = new Set(WORKS.flatMap((w) => w.erkennen.entdecken ?? []));
    const picked = catalog.entries.filter((e) => 'featured' in e && e.featured).map((e) => e.id);
    expect(picked.length).toBe(featured.length);
    expect(picked.filter((id) => !ids.has(id))).toEqual([]);
  });
});
