/**
 * Series without a feed (ARD Sounds shows, OHRKA topics): the page readers,
 * the short descriptions taken from the sources' own texts, and the fixed
 * rules for new titles that no person listens to first.
 */
import { describe, expect, it } from 'vitest';
import { looksGerman, sentences, shortAbout } from '../../src/core/sources/about';
import {
  ardEpisodePage,
  ardEpisodeUrl,
  ardShowEpisodes,
  isoDuration,
  jsonLd,
  metaTags,
  ohrkaTitlePage,
  ohrkaTitleUrl,
  ohrkaTopicTitles,
  readerOf,
  unavailableAfter,
  type PageFacts,
} from '../../src/core/sources/pages';
import { admitNewTitle, admitReleased, AVAILABLE_DAYS, type SeriesRules } from '../../src/core/sources/rules';
import { fxText } from './sample';

const NOW = new Date('2026-10-13T06:00:00Z');
const SHOW = 'https://www.ardsounds.de/sendung/hoerspielklassiker-fuer-kinder/urn:ard:show:a98eaa600a311568/';
const EP = (id: string) => `https://www.ardsounds.de/episode/urn:ard:episode:${id}/`;

describe('ARD Sounds pages', () => {
  it('lists the episodes of a show page once each, in page order, without extras and other shows', () => {
    const links = ardShowEpisodes(fxText('pages/ard-show.html'));
    expect(links).toHaveLength(12);
    expect(links[0]).toBe(EP('65d9cb1574d2e388'));
    expect(links[7]).toBe(EP('02e2c3207e8a1ab4'));
    expect(links.every((l) => /^https:\/\/www\.ardsounds\.de\/episode\/urn:ard:episode:[0-9a-f]+\/$/.test(l))).toBe(true);
    expect(links.some((l) => l.includes('extra'))).toBe(false);
  });

  it('writes every episode address the way the catalogue does', () => {
    expect(ardEpisodeUrl('https://www.ardsounds.de/episode/die-schatzinsel-1-3/urn:ard:episode:02E2C3207E8A1AB4')).toBe(EP('02e2c3207e8a1ab4'));
    expect(ardEpisodeUrl('/episode/urn:ard:extra:560fee8cd8a7cbd4/')).toBe('https://www.ardsounds.de/episode/urn:ard:extra:560fee8cd8a7cbd4/');
    expect(ardEpisodeUrl('https://www.ardsounds.de/sendung/x/urn:ard:show:a98eaa600a311568/')).toBeUndefined();
  });

  it('reads an episode page: title, description, picture, age, length, end date', () => {
    const f = ardEpisodePage(fxText('pages/ard-episode.html'), EP('02e2c3207e8a1ab4'));
    expect(f).toMatchObject({
      url: EP('02e2c3207e8a1ab4'),
      kind: 'episode',
      title: 'Die Schatzinsel (1/3)',
      image: 'https://api.ardmediathek.de/image-service/images/urn:ard:image:0d88e0606cb1fdbc?w=448&ch=069892e33ee1a2ba',
      until: '2031-04-30',
      ages: { min: 7 },
      agesStated: true,
      durationSec: 53 * 60,
      language: 'de',
    });
    expect(f.description).toMatch(/^Robert Louis Stevenson schrieb den Abenteuerroman Die Schatzinsel/);
  });

  it('reads hours and minutes, and an end date with a time', () => {
    const f = ardEpisodePage(fxText('pages/ard-episode-new.html'), EP('d83b72a53074b5e7'));
    expect(f).toMatchObject({ durationSec: 62 * 60, until: '2028-09-30', ages: { min: 8 } });
  });

  it('knows an extra and does not guess labels that disagree', () => {
    expect(ardEpisodePage(fxText('pages/ard-extra.html'), 'https://www.ardsounds.de/episode/urn:ard:extra:560fee8cd8a7cbd4/').kind).toBe('extra');
    // The show page names two ages and two lengths (other episodes): neither is a fact about the page.
    const show = ardEpisodePage(fxText('pages/ard-show.html'), SHOW);
    expect(show.durationSec).toBeUndefined();
    expect(show.ages).toEqual({ min: 5 });
  });

  it('reads the end date in the forms robots tags use', () => {
    expect(unavailableAfter('noindex, unavailable_after: 2027-01-07')).toBe('2027-01-07');
    expect(unavailableAfter('unavailable_after: Friday, 25-Jun-27 15:00:00 GMT, noarchive')).toBe('2027-06-25');
    expect(unavailableAfter('index, follow')).toBeUndefined();
    expect(unavailableAfter('unavailable_after: bald')).toBeUndefined();
  });

  it('reads meta tags, schema.org data and ISO lengths', () => {
    const html = `<meta content="Hallo &amp; Tschüss" property="og:title"><meta name="description" content='Ein Text'>
      <script type="application/ld+json">{"@graph":[{"@type":"PodcastEpisode","name":"Folge","duration":"PT1H2M3S"}]}</script>
      <script type="application/ld+json">{kaputt</script>`;
    expect(metaTags(html).get('og:title')).toBe('Hallo & Tschüss');
    expect(metaTags(html).get('description')).toBe('Ein Text');
    expect(jsonLd(html).map((o) => o['@type'])).toContain('PodcastEpisode');
    expect(isoDuration('PT53M')).toBe(3180);
    expect(isoDuration('PT1H2M3S')).toBe(3723);
    expect(isoDuration('P1D')).toBeUndefined();
    expect(ardEpisodePage(html, EP('aaaaaaaa')).durationSec).toBe(3723);
  });
});

describe('OHRKA pages', () => {
  const TOPIC = 'https://www.ohrka.de/hoeren/tierisch-spannend';

  it('lists the titles of a topic page, only of that topic', () => {
    expect(ohrkaTopicTitles(fxText('pages/ohrka-topic.html'), TOPIC)).toEqual([
      'https://www.ohrka.de/hoeren/tierisch-spannend/alice-im-wunderland',
      'https://www.ohrka.de/hoeren/tierisch-spannend/die-schatzinsel',
    ]);
    expect(ohrkaTitleUrl('https://www.ohrka.de/hoeren/tierisch-spannend')).toBeUndefined();
    expect(ohrkaTitleUrl('https://evil.example/hoeren/a/b')).toBeUndefined();
  });

  it('reads a title page: title, reader, length, file and its own picture (not the logo)', () => {
    const f = ohrkaTitlePage(fxText('pages/ohrka-title.html'), `${TOPIC}/alice-im-wunderland`);
    expect(f).toMatchObject({
      url: `${TOPIC}/alice-im-wunderland`,
      title: 'Alice im Wunderland',
      durationSec: 3 * 3600 + 10 * 60 + 9,
      fileUrl: 'https://www.ohrka.de/fileadmin/audio/Alice/Alice_im_Wunderland_komplett.mp3',
      image: 'https://www.ohrka.de/fileadmin/bilder/pl_wunderland.png',
      creators: [{ name: 'Katharina Thalbach', role: 'reader' }],
      agesStated: false,
    });
  });

  it('finds the reader in the ways OHRKA writes it', () => {
    expect(readerOf('Anke Engelke liest das Dschungelbuch.')).toBe('Anke Engelke');
    expect(readerOf('Das Dschungelbuch, gelesen von Anke Engelke')).toBe('Anke Engelke');
    expect(readerOf('Ein Hörbuch für alle.')).toBeUndefined();
  });
});

describe('short descriptions from the source', () => {
  it('takes the first one or two describing sentences, word for word', () => {
    expect(shortAbout('<p>Fine ist mit ihrer Mutter umgezogen, weil sie sich die alte Wohnung nicht mehr leisten konnten. Dann klingelt es.</p>')).toBe(
      'Fine ist mit ihrer Mutter umgezogen, weil sie sich die alte Wohnung nicht mehr leisten konnten.',
    );
    const two = 'Ein Wombat reist um die halbe Welt zum heiligen Berg. Dort trifft er einen alten Freund wieder.';
    expect(shortAbout(two)).toBe(two);
  });

  it('leaves out credits, links, English and a repeated title', () => {
    expect(shortAbout('Anna-Luise Böhm www.kakadu.de, Kakadu')).toBeUndefined();
    expect(shortAbout('Peter flies to the moon with the help of the sandman and his friends.')).toBeUndefined();
    expect(shortAbout('Die Schatzinsel', { title: 'Die Schatzinsel' })).toBeUndefined();
    expect(shortAbout(undefined)).toBeUndefined();
  });

  it('cuts a very long first sentence at a word', () => {
    const long = `Die Geschichte ${'von dem kleinen Drachen und '.repeat(20)}seinem Freund ist lang.`;
    const s = shortAbout(long)!;
    expect(s.length).toBeLessThanOrEqual(240);
    expect(s.endsWith('…')).toBe(true);
    expect(long.startsWith(s.slice(0, -1))).toBe(true);
  });

  it('splits sentences and tells German from English', () => {
    expect(sentences('Eins ist hier. Zwei kommt dann! „Drei“ endet?')).toEqual(['Eins ist hier.', 'Zwei kommt dann!', '„Drei“ endet?']);
    expect(looksGerman('Die Kinder gehen mit dem Hund in den Wald und finden einen Schatz.')).toBe(true);
    expect(looksGerman('The children go into the forest with the dog and find a treasure.')).toBe(false);
  });
});

describe('fixed rules for new titles', () => {
  const series: SeriesRules = { ages: { min: 5, max: 12, source: 'publisher', text: 'Für Kinder ab 5 Jahren.' }, category: 'hoerspiel' };
  const good: PageFacts = {
    url: EP('d83b72a53074b5e7'),
    kind: 'episode',
    title: 'Die Gespensterjäger in großer Gefahr (1/2)',
    description: 'Tom und Hedwig bekommen einen neuen Auftrag in einem alten Hotel.',
    ages: { min: 8 },
    agesStated: true,
    durationSec: 3720,
    until: '2028-09-30',
  };
  const reasons = (f: Partial<PageFacts>, s = series) => {
    const v = admitNewTitle({ ...good, ...f }, s, 'hoerspiel', NOW);
    return v.ok ? [] : v.reasons;
  };

  it('admits a real episode with its own age, a known length and time left', () => {
    expect(admitNewTitle(good, series, 'hoerspiel', NOW)).toEqual({ ok: true, ages: { min: 8 } });
    expect(admitNewTitle(ardEpisodePage(fxText('pages/ard-episode-new.html'), good.url), series, 'hoerspiel', NOW).ok).toBe(true);
  });

  it('leaves out what it cannot decide or what does not fit', () => {
    expect(reasons({ kind: 'extra' })[0]).toMatch(/Extra/);
    expect(reasons({ title: undefined })).toContain('Die Seite nennt keinen Titel');
    expect(reasons({ language: 'en' })).toContain('Sprache der Seite: en');
    expect(reasons({ ages: undefined, agesStated: false })).toContain('Die Seite nennt kein Alter');
    expect(reasons({ ages: { min: 16 } })).toContain('Altersangabe ab 16');
    expect(reasons({ ages: { min: 14 } })[0]).toMatch(/passt nicht zur Reihe/);
    expect(reasons({ durationSec: undefined })).toContain('Die Seite nennt keine Länge');
    expect(reasons({ durationSec: 90 }).join()).toMatch(/kurz/i);
    expect(reasons({ title: 'Trailer: Neue Folgen' }).length).toBeGreaterThan(0);
    expect(reasons({ until: '2026-10-20' })).toContain('Beim Anbieter nur noch bis 2026-10-20');
    expect(reasons({ title: 'Die Gespensterjäger in der Gruselburg (2/2)' }).length).toBeGreaterThan(0);
    expect(reasons({ description: 'Ein Hörspiel über Tod und Verlust in einer kleinen Stadt.' }).length).toBeGreaterThan(0);
  });

  it('keeps the time limit as written', () => {
    const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10);
    expect(reasons({ until: day(AVAILABLE_DAYS + 1) })).toEqual([]);
    expect(reasons({ until: day(AVAILABLE_DAYS - 2) }).length).toBe(1);
  });

  it('takes the series age only when the catalogue says it holds for every title', () => {
    const noAge = { ages: undefined, agesStated: false };
    expect(reasons(noAge, { ...series })).toContain('Die Seite nennt kein Alter');
    expect(admitNewTitle({ ...good, ...noAge }, { ...series, agesFromSeries: true }, 'hoerspiel', NOW)).toEqual({ ok: true, ages: { min: 5, max: 12 } });
    // A title's own age still wins and still has to fit.
    expect(reasons({ ages: { min: 14 } }, { ...series, agesFromSeries: true })[0]).toMatch(/passt nicht zur Reihe/);
  });

  it('lets a released title through when it is still there', () => {
    expect(admitReleased({ ...good, ages: undefined, agesStated: false, durationSec: undefined }, NOW).ok).toBe(true);
    expect(admitReleased({ ...good, until: '2026-10-01' }, NOW).ok).toBe(false);
  });
});
