import { describe, expect, it } from 'vitest';
import { SHOP_NOTE, shopLinks } from '../../src/core/library/playlist/shops';

describe('shopLinks', () => {
  it('searches shops for artist and title, over https and without partner codes', () => {
    const links = shopLinks({ position: 1, title: 'Schneeflöckchen & Co (Remastered 2011)', artists: ['Rolf Zuckowski', 'Chor'] });
    const q = encodeURIComponent('Rolf Zuckowski Schneeflöckchen & Co');
    expect(links).toEqual([
      { shop: 'Qobuz', url: `https://www.qobuz.com/de-de/search?q=${q}` },
      { shop: 'Bandcamp', url: `https://bandcamp.com/search?q=${q}&item_type=t` },
      { shop: '7digital', url: `https://de.7digital.com/search?q=${q}` },
      { shop: 'Amazon', url: `https://www.amazon.de/s?k=${q}&i=digital-music` },
    ]);
    for (const l of links) {
      const url = new URL(l.url);
      expect(url.protocol).toBe('https:');
      expect([...url.searchParams.keys()].some((k) => /tag|ref|affil|partner/i.test(k))).toBe(false);
    }
  });

  it('works with a title alone', () => {
    expect(shopLinks({ position: 1, title: 'Lalelu', artists: [] })[0].url).toBe('https://www.qobuz.com/de-de/search?q=Lalelu');
  });

  it('copes with broken characters in a list', () => {
    const links = shopLinks({ position: 1, title: 'Lied \ud83c', artists: ['A\udc00'] });
    expect(links).toHaveLength(4);
    expect(links[0].url).toBe('https://www.qobuz.com/de-de/search?q=A%EF%BF%BD%20Lied%20%EF%BF%BD');
  });

  it('tells what to buy', () => {
    expect(SHOP_NOTE).toMatch(/MP3-Download/);
    expect(SHOP_NOTE).toMatch(/DRM-frei/);
  });
});
