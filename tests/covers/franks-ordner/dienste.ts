/**
 * iTunes, Deezer, MusicBrainz and the Cover Art Archive as a model, for
 * measuring the cover search without the internet (this environment blocks
 * these services; tests never need the network). The answers have the
 * services' real JSON formats; what each service has, and how it spells it,
 * follows what the services show for these albums (spellings, editions,
 * soundtrack next to the audio play, karaoke and other artists' albums of
 * the same name as distractors). How they search is modelled too: iTunes
 * and Deezer want every word of the search text in the album or artist
 * (so "Disc 1" or "[Bonus Tracks]" find nothing), MusicBrainz ranks by the
 * share of words that match.
 *
 * Each album has a picture id (`pic`); its picture URLs carry that id, so a
 * test can tell which picture was chosen. Real answers recorded on Frank's
 * computer can replace this model: see the README of the measurement in
 * design/06-umbau/cover/.
 */
import { normalizeForMatch } from '../../../src/core/stickers/coversearch';

export interface Album {
  pic: string;
  title: string;
  artist: string;
  year?: number;
  /** In the service, maybe spelled differently; false: not there. */
  it?: boolean | { title?: string; artist?: string };
  dz?: boolean | { title?: string; artist?: string };
  mb?: boolean | { title?: string; artist?: string; cassette?: boolean; noArt?: boolean };
}

const all = { it: true, dz: true, mb: true };

export const ALBEN: Album[] = [
  { pic: 'zaches-herd', title: 'Konzert am Herd', artist: 'Zaches & Zinnober', ...all },
  { pic: 'zaches-other', title: 'Hilfe, die Zwerge kommen', artist: 'Zaches & Zinnober', ...all },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(
    (k): Album => ({
      pic: `umb-${k}`,
      title: k === 1 ? 'Unter meinem Bett' : `Unter meinem Bett ${k}`,
      artist: 'Various Artists',
      it: true,
      dz: k !== 6,
      mb: k <= 3,
    }),
  ),
  { pic: 'umb-xmas', title: 'Unter meinem Bett - Das Weihnachtsalbum', artist: 'Various Artists', it: true, dz: true },
  { pic: 'beatles-hdn-rm', title: "A Hard Day's Night (Remastered)", artist: 'The Beatles', it: true, dz: true, mb: { title: 'A Hard Day’s Night' } },
  { pic: 'beatles-hdn-live', title: "A Hard Day's Night (Live at the BBC)", artist: 'Beatles Tribute Band', it: true },
  { pic: 'zappel', title: 'Zehn kleine Zappelmänner', artist: 'Schnabi Schnabel', it: true, dz: true },
  { pic: 'spuckepack', title: 'Spuckepack', artist: 'Spuckepack', it: true, dz: true },
  { pic: 'libatiba', title: 'Tierisch coole Kinderlieder - EP', artist: 'Libatiba', it: true, dz: { title: 'Tierisch coole Kinderlieder' } },
  { pic: 'doors-best', title: 'The Best of the Doors', artist: 'The Doors', ...all },
  { pic: 'doors-verybest', title: 'The Very Best of the Doors', artist: 'The Doors', it: true, dz: true },
  { pic: 'who-ultimate', title: 'The Ultimate Collection', artist: 'The Who', ...all },
  { pic: 'elvis-ultimate', title: 'The Ultimate Collection', artist: 'Elvis Presley', it: true, dz: true },
  { pic: 'sg-bridge', title: 'Bridge Over Troubled Water', artist: 'Simon & Garfunkel', it: { title: 'Bridge Over Troubled Water (40th Anniversary Edition)' }, dz: true, mb: true },
  { pic: 'aretha-bridge', title: 'Bridge Over Troubled Water', artist: 'Aretha Franklin', it: true },
  { pic: 'helden-tag', title: 'Der perfekte Tag', artist: 'Philipp und die Heldenbande', it: true, dz: true },
  { pic: 'juli-tag', title: 'Perfekte Welle', artist: 'Juli', it: true, dz: true },
  { pic: 'hobbit-hsp', title: 'Der Hobbit (Hörspiel)', artist: 'J.R.R. Tolkien', it: true, dz: { title: 'Der Hobbit' }, mb: { title: 'Der kleine Hobbit' } },
  { pic: 'hobbit-shore', title: 'Der Hobbit: Smaugs Einöde (Original Motion Picture Soundtrack)', artist: 'Howard Shore', it: true, dz: true },
  { pic: 'kooks-inside', title: 'Inside In / Inside Out', artist: 'The Kooks', ...all },
  { pic: 'fleet-blues', title: 'Helplessness Blues', artist: 'Fleet Foxes', ...all },
  { pic: 'zuck-kiga', title: 'Im Kindergarten', artist: 'Rolf Zuckowski und seine Freunde', it: true, dz: true },
  { pic: 'kiga-karaoke', title: 'Im Kindergarten (Karaoke Version)', artist: 'Karaoke Kids', it: true, dz: true },
  { pic: 'kiga-sommerland', title: 'Im Kindergarten - 30 Lieder', artist: 'Simone Sommerland', it: true },
  { pic: 'schlaf123', title: '1, 2, 3 (Schlaf gleich ein...)', artist: 'Sandmännchen-Chor', dz: true },
  ...[85, 86, 87, 88].map((k): Album => ({ pic: `bb-${k}`, title: `Folge ${k}: ${['Der Zirkusdirektor', 'Der Lottogewinn', 'Das Laternenfest', 'Die Seifenkiste'][k - 85]}`, artist: 'Benjamin Blümchen', ...all })),
  { pic: 'bb-87-mc', title: 'Das Laternenfest', artist: 'Benjamin Blümchen', mb: { cassette: true } },
  { pic: 'bb-zoo', title: 'Geburtstag im Zoo', artist: 'Benjamin Blümchen', it: true, dz: true },
  { pic: 'bibi-vv-ost', title: 'Voll verhext! (Der Original-Soundtrack zum Kinofilm)', artist: 'Bibi & Tina', it: true, dz: { title: 'Voll verhext! (Original Soundtrack)' } },
  { pic: 'bibi-vv-hsp', title: 'Voll verhext! (Das Original-Hörspiel zum Kinofilm)', artist: 'Bibi & Tina', it: true, dz: true },
  { pic: 'bibi-mgj-ost', title: 'Mädchen gegen Jungs (Der Original-Soundtrack zum Kinofilm)', artist: 'Bibi & Tina', it: true, dz: true },
  { pic: 'bibi-mgj-hsp', title: 'Mädchen gegen Jungs (Das Original-Hörspiel zum Kinofilm)', artist: 'Bibi & Tina', it: true, dz: true },
  { pic: 'bibi-50', title: 'Folge 50: Das Kürbisfest', artist: 'Bibi und Tina', it: true, dz: { title: '050/Das Kürbisfest' } },
  { pic: 'zuck-vogel', title: 'Rolfs Vogelhochzeit', artist: 'Rolf Zuckowski', ...all },
  { pic: 'vahle-vogel', title: 'Die Vogelhochzeit', artist: 'Fredrik Vahle', it: true },
  { pic: 'zuck-winter', title: 'Winterkinder', artist: 'Rolf Zuckowski', ...all },
  { pic: 'zuck-schul', title: "Rolfs Schulweg-Hitparade", artist: 'Rolf Zuckowski', it: true, dz: true },
  { pic: 'svt-spatz', title: 'Tanz den Spatz', artist: 'Sven van Thom', it: true, dz: true },
  { pic: 'zaz-zaz', title: 'ZAZ', artist: 'ZAZ', ...all },
  { pic: 'zaz-paris', title: 'Paris', artist: 'ZAZ', ...all },
  { pic: 'zaz-recto', title: 'Recto Verso', artist: 'ZAZ', it: true, dz: true },
  { pic: 'paris-other', title: 'Paris', artist: 'Malcolm McLaren', it: true, dz: true },
  { pic: 'gespenst-hsp', title: 'Das kleine Gespenst (Hörspiel)', artist: 'Otfried Preußler', it: true, dz: true, mb: { title: 'Das kleine Gespenst' } },
  { pic: 'gespenst-film', title: 'Das kleine Gespenst - Das Original-Hörspiel zum Kinofilm', artist: 'Otfried Preußler', it: true, dz: true },
  { pic: 'panama', title: 'Oh, wie schön ist Panama', artist: 'Janosch', ...all },
  { pic: 'ende-geschichte', title: 'Die unendliche Geschichte', artist: 'Michael Ende', it: true, dz: true },
  { pic: 'ende-ost', title: 'Die unendliche Geschichte (Original Soundtrack)', artist: 'Klaus Doldinger', it: true, dz: true },
  { pic: 'hotzen', title: 'Der Räuber Hotzenplotz', artist: 'Otfried Preußler', ...all },
  { pic: 'hexe-lesung', title: 'Die kleine Hexe (Ungekürzte Lesung)', artist: 'Otfried Preußler', it: true, dz: true },
  { pic: 'hexe-hsp', title: 'Die kleine Hexe (Hörspiel)', artist: 'Otfried Preußler', it: true, dz: true, mb: { title: 'Die kleine Hexe' } },
  { pic: 'eule-beat', title: 'Die Eule findet den Beat', artist: 'Eule findet den Beat', it: true, dz: true },
  { pic: 'entlein-a', title: 'Das hässliche Entlein', artist: 'Hans Christian Andersen', it: true, dz: true },
  { pic: 'entlein-b', title: 'Das hässliche Entlein und andere Märchen', artist: 'Märchenerzähler', it: true },
  { pic: 'toeff-30', title: 'Die 30 besten Spiel- und Bewegungslieder', artist: 'Simone Sommerland, Karsten Glück & die Kita-Frösche', it: true, dz: true },
  { pic: 'deinefr', title: 'Ausm Häuschen', artist: 'Deine Freunde', it: true, dz: true },
  { pic: 'joecker', title: '1, 2, 3 im Sauseschritt', artist: 'Detlev Jöcker', it: true, dz: true },
  { pic: 'rosin', title: 'Das singende Känguru', artist: 'Volker Rosin', it: true, dz: true },
  { pic: 'ddf-125', title: 'Folge 125: Feuermond', artist: 'Die drei ???', it: true, dz: { title: '125/Feuermond' }, mb: true },
  { pic: 'ddf-124', title: 'Folge 124: Geisterbucht', artist: 'Die drei ???', it: true, dz: true },
  { pic: 'dda-25', title: 'Folge 25: Feuermond', artist: 'Die drei !!!', it: true },
  { pic: 'tkkg-7', title: 'Folge 7: Das Paket mit dem Totenkopf', artist: 'TKKG', ...all },
  { pic: 'tkkg-7-mc', title: 'Das Paket mit dem Totenkopf', artist: 'TKKG', mb: { cassette: true } },
  { pic: 'tkkg-8', title: 'Folge 8: Das Phantom auf dem Feuerstuhl', artist: 'TKKG', it: true, dz: true },
  { pic: 'bibibl-3', title: 'Folge 3: Hexen gibt es doch', artist: 'Bibi Blocksberg', it: true, dz: true },
  { pic: 'bibibl-3-mc', title: 'Hexen gibt es doch', artist: 'Bibi Blocksberg', mb: { cassette: true, noArt: true } },
];

type Svc = 'it' | 'dz' | 'mb';

function inService(a: Album, s: Svc): { title: string; artist: string; extra: Record<string, unknown> } | null {
  const v = a[s];
  if (!v) return null;
  const o = typeof v === 'object' ? v : {};
  return { title: o.title ?? a.title, artist: o.artist ?? a.artist, extra: o };
}

const words = (s: string) => normalizeForMatch(s).split(' ').filter(Boolean);

/** Every word of the search somewhere in album or artist (a word or the start of one, from 3 letters). */
function allWords(q: string[], have: string[]): boolean {
  return q.every((w) => have.includes(w) || (w.length >= 3 && have.some((h) => h.startsWith(w))));
}

function share(q: string[], have: string[]): number {
  return q.length ? q.filter((w) => have.includes(w)).length / q.length : 0;
}

const MB_SYNTAX = new Set(['artist', 'release', 'format', 'cassette', 'and', 'or', 'not', 'tracks', 'rgid', 'reid']);

export const pictureOf = (url: string): string | undefined => /(?:^|[/-])pic-([a-z0-9-]+?)(?=\/|$)/.exec(url)?.[1];

export interface Counts {
  itunes: number;
  deezer: number;
  musicbrainz: number;
  caa: number;
  images: number;
}

export interface ModelOptions {
  /** ms per answer, by service. */
  latency?: Partial<Record<keyof Counts, number>>;
  /** Services that do not answer (a web filter, TODO #110): the request fails like a blocked connection. */
  blocked?: readonly (keyof Counts)[];
  /** Answers 503 to the first n MusicBrainz requests (#130). */
  busyMusicBrainz?: number;
}

/** A fetch that answers like the services would. */
export function modelFetch(opts: ModelOptions = {}) {
  const counts: Counts = { itunes: 0, deezer: 0, musicbrainz: 0, caa: 0, images: 0 };
  let busy = opts.busyMusicBrainz ?? 0;
  const lat = { itunes: 350, deezer: 250, musicbrainz: 700, caa: 400, images: 300, ...opts.latency };
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const svc: keyof Counts =
      u.hostname === 'itunes.apple.com'
        ? 'itunes'
        : u.hostname === 'api.deezer.com'
          ? 'deezer'
          : u.hostname === 'musicbrainz.org'
            ? 'musicbrainz'
            : u.hostname === 'coverartarchive.org'
              ? 'caa'
              : 'images';
    counts[svc]++;
    await new Promise((r) => setTimeout(r, lat[svc]));
    if (init?.signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    if (opts.blocked?.includes(svc)) throw new TypeError('Failed to fetch');
    if (svc === 'itunes') {
      const q = words(u.searchParams.get('term') ?? '');
      const hits = ALBEN.flatMap((a) => {
        const s = inService(a, 'it');
        return s && q.length && allWords(q, words(`${s.title} ${s.artist}`)) ? [{ a, s }] : [];
      }).slice(0, Number(u.searchParams.get('limit') ?? 50));
      return json({
        resultCount: hits.length,
        results: hits.map(({ a, s }, i) => ({
          wrapperType: 'collection',
          collectionType: 'Album',
          collectionId: 100 + ALBEN.indexOf(a),
          artistName: s.artist,
          collectionName: s.title,
          artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/Music/pic-${a.pic}/source/100x100bb.jpg`,
          releaseDate: `${a.year ?? 2010 + (i % 10)}-01-01T08:00:00Z`,
          primaryGenreName: 'Kinder',
        })),
      });
    }
    if (svc === 'deezer') {
      const q = words(u.searchParams.get('q') ?? '');
      const hits = ALBEN.flatMap((a) => {
        const s = inService(a, 'dz');
        if (!s || !q.length) return [];
        const have = words(`${s.title} ${s.artist}`);
        // Deezer forgives one missing word in a longer search.
        const missing = q.filter((w) => !allWords([w], have)).length;
        return missing === 0 || (q.length >= 4 && missing === 1) ? [{ a, s }] : [];
      }).slice(0, Number(u.searchParams.get('limit') ?? 25));
      const pic = (a: Album, size: number) => `https://e-cdns-images.dzcdn.net/images/cover/pic-${a.pic}/${size}x${size}-000000-80-0-0.jpg`;
      return json({
        data: hits.map(({ a, s }) => ({
          id: 5000 + ALBEN.indexOf(a),
          title: s.title,
          link: `https://www.deezer.com/album/${5000 + ALBEN.indexOf(a)}`,
          cover: `https://api.deezer.com/album/${5000 + ALBEN.indexOf(a)}/image`,
          cover_small: pic(a, 56),
          cover_medium: pic(a, 250),
          cover_big: pic(a, 500),
          cover_xl: pic(a, 1000),
          md5_image: `pic-${a.pic}`,
          genre_id: 95,
          nb_tracks: 12,
          record_type: 'album',
          explicit_lyrics: false,
          artist: { id: 77, name: s.artist, type: 'artist' },
          type: 'album',
        })),
        total: hits.length,
      });
    }
    if (svc === 'musicbrainz') {
      if (busy > 0) {
        busy--;
        return new Response('busy', { status: 503, headers: { 'Retry-After': '1' } });
      }
      const query = u.searchParams.get('query') ?? '';
      const cassette = /format:cassette/i.test(query);
      const q = [...new Set(words(query).filter((w) => !MB_SYNTAX.has(w)))];
      const hits = ALBEN.flatMap((a) => {
        const s = inService(a, 'mb');
        if (!s || !!s.extra.cassette !== cassette) return [];
        const sc = share(q, words(`${s.title} ${s.artist}`));
        return sc >= 0.34 ? [{ a, s, sc }] : [];
      })
        .sort((x, y) => y.sc - x.sc)
        .slice(0, Number(u.searchParams.get('limit') ?? 25));
      return json({
        created: '2026-10-27T08:00:00.000Z',
        count: hits.length,
        offset: 0,
        releases: hits.map(({ a, s, sc }) => ({
          id: `rel-pic-${a.pic}${s.extra.noArt ? '-noart' : ''}`,
          score: Math.round(sc * 100),
          title: s.title,
          status: 'Official',
          date: '1990',
          'artist-credit': [{ name: s.artist, artist: { id: 'x', name: s.artist } }],
          'release-group': { id: `rg-pic-${a.pic}${s.extra.noArt ? '-noart' : ''}`, 'primary-type': 'Album' },
          media: [{ format: s.extra.cassette ? 'Cassette' : 'CD', 'track-count': 10 }],
        })),
      });
    }
    // Pictures: the Cover Art Archive has none for releases marked noArt.
    if (/-noart/.test(url)) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  };
  return { fetchFn, counts };
}
