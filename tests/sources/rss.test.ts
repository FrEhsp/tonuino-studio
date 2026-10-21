import { describe, expect, it } from 'vitest';
import { decodeEntities, FeedError, parseRss } from '../../src/core/sources/rss';
import { fxText } from './sample';

describe('parseRss', () => {
  it('reads the Kakadu feed: items, enclosure length and type, durations', () => {
    const feed = parseRss(fxText('feeds/kakadu-kinderhoerspiel-118.xml'));
    expect(feed.items).toHaveLength(3);
    expect(feed.items[0].enclosure?.length).toBe(50913468);
    expect(feed.items[0].enclosure?.type).toBe('audio/mpeg');
    expect(feed.items[0].enclosure?.url).toContain('?refId=kinderhoerspiel-118');
    expect(feed.items[0].duration).toBe('52:59');
    expect(feed.items[0].guid).toBe('83531235-b48a-551a-9400-33f0e43e9f77');
    expect(feed.language).toBeDefined();
  });

  it('reads SRF and Radio Klops', () => {
    expect(parseRss(fxText('feeds/srf-kids-hoerspiele.xml')).items.map((i) => i.duration)).toEqual(['2653', '4151', '4232']);
    const rk = parseRss(fxText('feeds/radioklops.xml'));
    expect(rk.items).toHaveLength(7);
    expect(rk.items[0].title).toBe('Folge 7: Der Sonnencreme-Roboter');
  });

  it('reports a truncated feed', () => {
    expect(() => parseRss(fxText('feeds/broken.xml'))).toThrow(FeedError);
    try {
      parseRss(fxText('feeds/broken.xml'));
    } catch (e) {
      expect((e as FeedError).code).toBe('truncated');
    }
  });

  it('refuses something that is not RSS', () => {
    expect(() => parseRss('<html><body>Fehler</body></html>')).toThrow(/kein RSS/);
  });

  it('keeps CDATA, decodes entities and ignores comments', () => {
    const feed = parseRss(
      '<rss><channel><title>A &amp; B</title><!-- <item><title>alt</title></item> --><item><title><![CDATA[Fuchs & Hase]]></title><enclosure url="https://x.example/a.mp3?x=1&amp;y=2" length="0" type="audio/mpeg"/></item></channel></rss>',
    );
    expect(feed.title).toBe('A & B');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].title).toBe('Fuchs & Hase');
    expect(feed.items[0].enclosure).toEqual({ url: 'https://x.example/a.mp3?x=1&y=2', length: undefined, type: 'audio/mpeg' });
  });

  it('decodes numeric entities', () => {
    expect(decodeEntities('M&#228;rchen &#x2013; &quot;neu&quot;')).toBe('Märchen – "neu"');
  });

  it('decodes the named entities of HTML show notes', () => {
    expect(decodeEntities('G&auml;nsehaut f&uuml;r &Ouml;dland, Stra&szlig;e &ndash; &bdquo;Caf&eacute;&ldquo; &hellip; &AMP; &unknown;')).toBe('Gänsehaut für Ödland, Straße – „Café“ … & &unknown;');
  });

  it('reads the channel link, summary, subtitle and the full show notes', () => {
    const feed = parseRss(
      '<rss xmlns:itunes="x" xmlns:content="y"><channel><title>Sendung</title><image><url>https://a.example/i.png</url><link>https://a.example/bild</link></image><link>https://a.example/sendung</link><item><title>Folge</title><itunes:subtitle>Kurz</itunes:subtitle><itunes:summary>Lang</itunes:summary><content:encoded><![CDATA[<p>Mehr</p>]]></content:encoded></item></channel></rss>',
    );
    expect(feed.link).toBe('https://a.example/sendung');
    expect(feed.items[0]).toMatchObject({ description: 'Lang', summary: 'Lang', subtitle: 'Kurz', content: '<p>Mehr</p>' });
  });
});
