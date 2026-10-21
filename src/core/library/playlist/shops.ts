/**
 * Where a missing song can be bought as a file: searches at shops that sell
 * downloads without copy protection. Plain search addresses, no tracking or
 * partner codes; the app itself never calls them.
 */
import { stripVersionInfo } from './match';
import type { ListEntry, ShopLink } from './types';

/** What to look out for when buying. */
export const SHOP_NOTE =
  'Achte beim Kauf darauf, dass du das Lied als „MP3-Download“ oder „DRM-frei“ bekommst – nur solche Dateien lassen sich auf die SD-Karte bringen.';

/** Search links for one entry, by "Artist Title" (version notes like "Remastered 2011" left out). */
export function shopLinks(entry: ListEntry): ShopLink[] {
  const query = [entry.artists[0], stripVersionInfo(entry.title)]
    .filter((s): s is string => !!s?.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A lone half of a surrogate pair (broken text in a list) would make encodeURIComponent throw.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  let q: string;
  try {
    q = encodeURIComponent(query);
  } catch {
    return [];
  }
  return [
    { shop: 'Qobuz', url: `https://www.qobuz.com/de-de/search?q=${q}` },
    { shop: 'Bandcamp', url: `https://bandcamp.com/search?q=${q}&item_type=t` },
    { shop: '7digital', url: `https://de.7digital.com/search?q=${q}` },
    { shop: 'Amazon', url: `https://www.amazon.de/s?k=${q}&i=digital-music` },
  ];
}
