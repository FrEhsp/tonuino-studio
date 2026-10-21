import { describe, expect, it } from 'vitest';
import { albumCover, buildIndex, isGone, publishGates } from '../../src/core/sources/build';
import { coverUrl, entryHosts, largestCover } from '../../src/core/sources/cover';
import { parseRss } from '../../src/core/sources/rss';
import type { CatalogEntry, SourceCatalog, SourceIndex } from '../../src/core/sources/types';
import { parseIndex, validateCatalog, validateIndex } from '../../src/core/sources/validate';
import { buildSample, realCatalog, sampleCatalog, sampleInputs } from './sample';

const { index, report } = buildSample();
const byId = (id: string, idx: SourceIndex = index) => idx.entries.find((e) => e.id === id);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const NOW = new Date('2026-10-05T04:00:00Z');

describe('coverUrl', () => {
  it('takes https on a host the entry uses or a known cover host, subdomains of known hosts included', () => {
    const own = ['www.srf.ch', 'download-media.srf.ch'];
    expect(coverUrl('https://download-media.srf.ch/world/image/a.png', own)).toBe('https://download-media.srf.ch/world/image/a.png');
    expect(coverUrl('https://ia800300.us.archive.org/1/items/x/x.jpg', [])).toBe('https://ia800300.us.archive.org/1/items/x/x.jpg');
    expect(coverUrl('https://bilder.deutschlandfunk.de/a.jpg', [])).toBe('https://bilder.deutschlandfunk.de/a.jpg');
  });

  it('refuses http, other hosts, measurement services, user names, blanks and non-strings', () => {
    expect(coverUrl('http://archive.org/download/x/x.jpg', [])).toBeUndefined();
    expect(coverUrl('https://evil.example/x.jpg', ['www.srf.ch'])).toBeUndefined();
    expect(coverUrl('https://img.srf.ch/x.jpg', ['www.srf.ch'])).toBeUndefined();
    expect(coverUrl('https://www.podtrac.com/x.jpg', ['www.podtrac.com'])).toBeUndefined();
    expect(coverUrl('https://user:pw@archive.org/x.jpg', [])).toBeUndefined();
    expect(coverUrl(' https://archive.org/x.jpg', [])).toBeUndefined();
    expect(coverUrl('javascript:alert(1)', [])).toBeUndefined();
    expect(coverUrl(42, [])).toBeUndefined();
  });

  it('collects the hosts of the page, the titles’ pages and the files', () => {
    const e = byId('kakadu-kinderhoerspiel')!;
    expect(entryHosts(e).sort()).toEqual(['podcast-mp3.dradio.de', 'www.kakadu.de']);
  });
});

describe('feed pictures', () => {
  it('reads itunes:image of the channel and of an episode, else <image><url>', () => {
    const feed = parseRss(
      '<rss xmlns:itunes="x"><channel><title>S</title><image><url>https://a.example/klein.png</url><link>https://a.example/</link></image><itunes:image href="https://a.example/gross.jpg"/><item><title>F</title><itunes:image href=" https://a.example/folge.jpg "/></item><item><title>G</title></item></channel></rss>',
    );
    expect(feed.image).toBe('https://a.example/gross.jpg');
    expect(feed.items.map((i) => i.image)).toEqual(['https://a.example/folge.jpg', undefined]);
    const plain = parseRss('<rss><channel><title>S</title><image><url>https://a.example/klein.png</url></image><item><title>F</title></item></channel></rss>');
    expect(plain.image).toBe('https://a.example/klein.png');
    expect(parseRss('<rss><channel><title>S</title></channel></rss>').image).toBeUndefined();
  });
});

describe('covers in the build', () => {
  it('takes the feed image and nothing for sources without one', () => {
    expect(byId('kakadu-kinderhoerspiel')!.cover).toBe('https://bilder.deutschlandfunk.de/FI/LE/_9/ac/FILE_9ac926df16c242d33aa4876fd8be2676/kakadu-kinderhoerspiel-104-1920x1920.jpg');
    expect(byId('srf-kids-hoerspiele')!.cover).toBe('https://download-media.srf.ch/world/image/audio/2023/04/987a01e371154a5d8f5e0afda6736d01.png');
    for (const id of ['radio-klops', 'global-storybooks-de', 'jamendo-139374-eckhardt']) expect(byId(id)!.cover).toBeUndefined();
    // Only the link entry carries pictures per title (set in the catalogue, see below).
    expect(index.entries.filter((e) => e.items.some((it) => it.cover)).map((e) => e.id)).toEqual(['ohrka']);
    expect(report.notes.some((n) => n.note.startsWith('Cover'))).toBe(false);
  });

  const klops = (patch: Partial<CatalogEntry> = {}): SourceCatalog => {
    const c = realCatalog();
    const e = c.entries.find((x) => x.id === 'radio-klops')!;
    return { ...c, entries: [{ ...e, ...patch } as CatalogEntry] };
  };
  const ep = (guid: string, image?: string) =>
    `<item><title>Folge ${guid}: Eine lange Geschichte</title><guid>${guid}</guid><description>Eine Geschichte über einen Roboter und seine Freunde am Meer.</description><pubDate>Sun, 0${guid} Oct 2026 06:00:00 GMT</pubDate><itunes:duration>900</itunes:duration><enclosure url="https://audio.podigee-cdn.net/${guid}.mp3" length="9000000" type="audio/mpeg"/>${image ? `<itunes:image href="${image}"/>` : ''}</item>`;
  const feed = (channelImage: string, items: string[]) =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Radio Klops</title><itunes:image href="${channelImage}"/>${items.join('')}</channel></rss>`;
  const released = ['1', '2', '3', '4'].map((g) => ({ key: `radio-klops/${g}`, by: 'Redaktion', at: '2026-10-05' }));

  it('keeps an episode’s own picture, drops one equal to the show’s, notes one on a foreign host', () => {
    const xml = feed('https://images.podigee-cdn.net/show.jpg', [
      ep('1', 'https://images.podigee-cdn.net/eins.jpg'),
      ep('2', 'https://images.podigee-cdn.net/show.jpg'),
      ep('3', 'https://tracker.example/pixel.jpg'),
      ep('4'),
    ]);
    const r = buildIndex(klops(), sampleInputs({ feeds: { 'radio-klops': xml }, previous: undefined, released }));
    const e = r.index.entries[0];
    expect(e.cover).toBe('https://images.podigee-cdn.net/show.jpg');
    expect(Object.fromEntries(e.items.map((it) => [it.key, it.cover]))).toEqual({
      'radio-klops/1': 'https://images.podigee-cdn.net/eins.jpg',
      'radio-klops/2': undefined,
      'radio-klops/3': undefined,
      'radio-klops/4': undefined,
    });
    expect(e.items.find((it) => it.key === 'radio-klops/2')).not.toHaveProperty('cover');
    expect(r.report.notes).toContainEqual(expect.objectContaining({ entry: 'radio-klops', key: 'radio-klops/3', note: expect.stringContaining('https://tracker.example/pixel.jpg') }));
  });

  it('takes the pictures of a link entry and its titles from the catalogue, without repeating the entry’s own', () => {
    const ohrka = byId('ohrka')!;
    expect([ohrka.cover, ohrka.coverFrom]).toEqual(['https://www.ohrka.de/fileadmin/bilder/pl_verzaubert_insel.png', 'Bild von ohrka.de (OHRKA e.V.)']);
    const covers = Object.fromEntries(ohrka.items.map((it) => [it.key.split('/').pop(), it.cover]));
    expect(covers['alice-im-wunderland']).toBe('https://www.ohrka.de/fileadmin/bilder/pl_wunderland.png');
    // The fairy tales show the same picture as the entry: not repeated at the title.
    expect(covers['bekannte-maerchen']).toBeUndefined();
    expect(ohrka.items.filter((it) => !it.cover).map((it) => it.title)).toEqual(['14 besonders bekannte Märchen, gelesen von Katharina Thalbach, Oliver Rohrbeck und anderen']);
    // A title's picture on a host the entry does not use is left out and noted, never the title.
    const c = clone(sampleCatalog());
    const link = c.entries.find((e) => e.id === 'ohrka') as Extract<CatalogEntry, { type: 'link' }>;
    link.items[0].cover = 'https://bilder.example/alice.png';
    const r = buildIndex(c, sampleInputs());
    const first = r.index.entries.find((e) => e.id === 'ohrka')!.items[0];
    expect([first.title, first.cover]).toEqual([link.items[0].title, undefined]);
    expect(r.report.notes.some((n) => n.entry === 'ohrka' && n.note.includes('https://bilder.example/alice.png'))).toBe(true);
  });

  it('prefers a cover set by hand in the catalogue and drops a show picture on a foreign host', () => {
    const xml = feed('https://cdn.example/show.jpg', [ep('1')]);
    const hand = buildIndex(klops({ cover: 'https://radioklops.podigee.io/cover.png' }), sampleInputs({ feeds: { 'radio-klops': xml }, previous: undefined, released }));
    expect(hand.index.entries[0].cover).toBe('https://radioklops.podigee.io/cover.png');
    const foreign = buildIndex(klops(), sampleInputs({ feeds: { 'radio-klops': xml }, previous: undefined, released }));
    expect(foreign.index.entries[0]).not.toHaveProperty('cover');
    expect(foreign.report.notes.some((n) => n.entry === 'radio-klops' && n.key === undefined && n.note.includes('https://cdn.example/show.jpg'))).toBe(true);
  });

  it('keeps yesterday’s cover when a source cannot be read', () => {
    const previous = clone(index);
    previous.entries.find((e) => e.id === 'radio-klops')!.cover = 'https://images.podigee-cdn.net/gestern.jpg';
    const r = buildIndex(klops(), sampleInputs({ feeds: { 'radio-klops': new Error('Zeitüberschreitung') }, previous, released }));
    expect(r.index.entries[0].cover).toBe('https://images.podigee-cdn.net/gestern.jpg');
  });

  it('drops a source that says it no longer has it, but keeps one that is only not reachable', () => {
    const previous = clone(index);
    const gone = Object.assign(new Error('HTTP 404: https://radioklops.podigee.io/feed/mp3'), { status: 404 });
    const r = buildIndex(klops(), sampleInputs({ feeds: { 'radio-klops': gone }, previous, released }));
    expect(r.index.entries).toEqual([]);
    expect(r.report.failures).toEqual([expect.objectContaining({ entry: 'radio-klops', keptPrevious: false, gone: true })]);
    for (const err of [Object.assign(new Error('HTTP 503'), { status: 503 }), new Error('Zeitüberschreitung')]) {
      const kept = buildIndex(klops(), sampleInputs({ feeds: { 'radio-klops': err }, previous, released }));
      expect(kept.index.entries).toHaveLength(1);
      expect(kept.report.failures[0]).toEqual(expect.objectContaining({ keptPrevious: true }));
      expect(kept.report.failures[0]).not.toHaveProperty('gone');
    }
    expect(isGone(new Error('archive.org kennt diese Kennung nicht'))).toBe(true);
  });

  it('says where a cover comes from, and nothing without a cover', () => {
    const xml = feed('https://images.podigee-cdn.net/show.jpg', [ep('1')]);
    const r = buildIndex(klops(), sampleInputs({ feeds: { 'radio-klops': xml }, previous: undefined, released }));
    expect(r.index.entries[0].coverFrom).toBe('Bild aus dem Podcast von Domenik Schuster');
    const hand = buildIndex(klops({ cover: 'https://radioklops.podigee.io/cover.png', coverFrom: 'Bild von der Webseite von Radio Klops' }), sampleInputs({ feeds: { 'radio-klops': xml }, previous: undefined, released }));
    expect(hand.index.entries[0].coverFrom).toBe('Bild von der Webseite von Radio Klops');
    const none = buildIndex(klops(), sampleInputs({ feeds: { 'radio-klops': xml.replace(/<itunes:image[^>]*>/g, '') }, previous: undefined, released }));
    expect(none.index.entries[0]).not.toHaveProperty('coverFrom');
  });

  it('archive.org albums: only a picture the uploader put in, a cover by name first', () => {
    const files = [
      { name: '__ia_thumb.jpg', format: 'Item Tile', source: 'original' },
      { name: 'booklet.jpg', format: 'JPEG', source: 'original' },
      { name: 'Cover Front.png', format: 'PNG', source: 'original' },
      { name: 'cover_thumb.jpg', format: 'JPEG Thumb', source: 'derivative' },
    ];
    expect(albumCover('jamendo-1', files)).toBe('https://archive.org/download/jamendo-1/Cover%20Front.png');
    expect(albumCover('jamendo-1', files.slice(0, 2))).toBe('https://archive.org/download/jamendo-1/booklet.jpg');
    expect(albumCover('jamendo-1', [files[0], files[3]])).toBeUndefined();
    // A small copy next to the cover, also as an original JPEG: the full picture wins.
    const pair = [
      { name: 'album_thumb.jpg', format: 'JPEG', source: 'original' },
      { name: 'album.jpg', format: 'JPEG', source: 'original' },
    ];
    expect(albumCover('jamendo-1', pair)).toBe('https://archive.org/download/jamendo-1/album.jpg');
    expect(albumCover('jamendo-1', pair.slice(0, 1))).toBe('https://archive.org/download/jamendo-1/album_thumb.jpg');
  });
});

describe('covers in the gates and the app', () => {
  const gates = (idx: SourceIndex) => {
    const serialized = JSON.stringify(idx);
    return publishGates(idx, { catalog: sampleCatalog(), serialized, parsed: validateIndex(JSON.parse(serialized)) });
  };

  it('the gates pass covers the app shows and stop others', () => {
    expect(gates(index)).toEqual([]);
    const bad = clone(index);
    bad.entries.find((e) => e.id === 'radio-klops')!.items[0].cover = 'https://evil.example/x.jpg';
    expect(gates(bad)).toContain('radio-klops: Cover https://evil.example/x.jpg würde die App nicht zeigen.');
  });

  it('parseIndex keeps good covers and leaves out bad ones, never the entry or the title', () => {
    const raw = clone(index) as unknown as { entries: Record<string, unknown>[] };
    const rk = raw.entries.find((e) => e.id === 'radio-klops')! as { cover?: unknown; items: Record<string, unknown>[] };
    rk.cover = 'https://radioklops.podigee.io/bild.png';
    rk.items[0].cover = 'https://images.podigee-cdn.net/eins.jpg';
    rk.items[1].cover = 'http://images.podigee-cdn.net/zwei.jpg';
    rk.items[2].cover = 'https://evil.example/drei.jpg';
    rk.items[3].cover = { url: 'https://images.podigee-cdn.net/vier.jpg' };
    const album = raw.entries.find((e) => e.id === 'jamendo-139374-eckhardt')!;
    album.cover = 'https://www.podtrac.com/x.jpg';
    const r = parseIndex(raw);
    if (!r || r === 'needs-update') throw new Error('unlesbar');
    expect(r.dropped).toEqual([]);
    const got = byId('radio-klops', r.index)!;
    expect(got.cover).toBe('https://radioklops.podigee.io/bild.png');
    expect(got.items.slice(0, 4).map((it) => it.cover)).toEqual(['https://images.podigee-cdn.net/eins.jpg', undefined, undefined, undefined]);
    expect(got.items).toHaveLength(7);
    expect(byId('jamendo-139374-eckhardt', r.index)).not.toHaveProperty('cover');
    expect(byId('kakadu-kinderhoerspiel', r.index)!.cover).toBe(byId('kakadu-kinderhoerspiel')!.cover);
  });

  it('the catalogue takes a cover by hand only as https on the source’s hosts or a known cover host', () => {
    const withCover = (cover: unknown) => {
      const c = clone(realCatalog()) as unknown as { entries: Record<string, unknown>[] };
      const e = c.entries.find((e) => e.id === 'radio-klops')!;
      e.cover = cover;
      e.coverFrom = 'Bild von der Webseite von Radio Klops';
      return validateCatalog(c, NOW).errors.filter((e) => e.includes('cover'));
    };
    expect(withCover('https://radioklops.podigee.io/bild.png')).toEqual([]);
    expect(withCover('https://audio.podigee-cdn.net/bild.png')).toEqual([]);
    expect(withCover('https://archive.org/download/x/x.jpg')).toEqual([]);
    expect(withCover('http://radioklops.podigee.io/bild.png')).toHaveLength(1);
    expect(withCover('https://evil.example/bild.png')).toHaveLength(1);
    expect(withCover(7)).toHaveLength(1);
    // Where the picture comes from belongs to it.
    const c = clone(realCatalog()) as unknown as { entries: Record<string, unknown>[] };
    c.entries.find((e) => e.id === 'radio-klops')!.cover = 'https://radioklops.podigee.io/bild.png';
    expect(validateCatalog(c, NOW).errors.filter((e) => e.includes('coverFrom'))).toHaveLength(1);
  });
});

describe('the cover for the card', () => {
  it('asks the ARD image service for the large size and leaves every other address alone', () => {
    const ard = 'https://api.ardmediathek.de/image-service/images/urn:ard:image:fb1d006f6eacdcf4?w=448&ch=befc77926763882a';
    expect(largestCover(ard)).toBe('https://api.ardmediathek.de/image-service/images/urn:ard:image:fb1d006f6eacdcf4?w=1280&ch=befc77926763882a');
    // Already large, or no size in the address: as it is.
    const large = ard.replace('w=448', 'w=1920');
    expect(largestCover(large)).toBe(large);
    expect(largestCover('https://api.ardmediathek.de/image-service/images/urn:ard:image:fb1d006f6eacdcf4')).toBe('https://api.ardmediathek.de/image-service/images/urn:ard:image:fb1d006f6eacdcf4');
    for (const other of ['https://www.ohrka.de/fileadmin/bilder/pl_wunderland.png', 'https://archive.org/download/heidi/heidi_2.jpg', 'https://img.example.org/x.jpg?w=100', 'kein Link']) {
      expect(largestCover(other)).toBe(other);
    }
  });
});
