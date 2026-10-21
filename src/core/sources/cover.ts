/**
 * Cover pictures of "Entdecken": the picture a source publishes itself
 * (feed image, a cover file of an archive.org album, the picture of a
 * title page), as an
 * optional `cover` URL at an entry or an item of the index.
 *
 * The same rule holds for the builder, the publishing gates, the catalogue
 * check and the app: https only, no measurement service, and the host is one
 * the entry already uses (its page, a title's page, a file) or a host the
 * sources are known to serve their pictures from.
 */
import { isMeasurementHost } from './cors';
import type { IndexEntry } from './types';

/**
 * Hosts the sources serve their pictures from, besides the hosts an entry
 * uses anyway. Each also covers its subdomains (ia800300.us.archive.org).
 */
export const COVER_HOSTS: readonly string[] = [
  'archive.org',
  'bilder.deutschlandfunk.de',
  'images.podigee-cdn.net',
  'main.podigee-cdn.net',
  'img.br.de',
  'www1.wdr.de',
  'api.ardmediathek.de',
  'upload.wikimedia.org',
];

function knownCoverHost(host: string): boolean {
  return COVER_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

/**
 * The cover exactly as written when it may be shown: an https URL without
 * user name or password, not on a measurement service, on one of `ownHosts`
 * or a known cover host. Undefined otherwise.
 */
export function coverUrl(raw: unknown, ownHosts: readonly string[]): string | undefined {
  if (typeof raw !== 'string' || raw.trim() !== raw || raw === '') return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return undefined;
  const host = u.hostname.toLowerCase();
  if (isMeasurementHost(host)) return undefined;
  return ownHosts.includes(host) || knownCoverHost(host) ? raw : undefined;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Hosts an index entry uses anyway: its page, the pages of its titles, its files. */
export function entryHosts(entry: Pick<IndexEntry, 'pageUrl' | 'items'>): string[] {
  const hosts = new Set<string>();
  const add = (url: string | undefined) => {
    const h = hostOf(url);
    if (h) hosts.add(h);
  };
  add(entry.pageUrl);
  for (const it of entry.items) {
    add(it.pageUrl);
    for (const f of it.files) add(f.url);
  }
  return [...hosts];
}

/** Width the ARD image service is asked for when a picture goes onto a card (og:image of ARD Sounds uses it). */
export const ARD_COVER_WIDTH = 1280;

/**
 * The same picture in the best size its source offers, for the cover file
 * that goes onto the card and its stickers. The list keeps the small size
 * (448 pixels, enough for the page). Only sources whose address names the
 * size change: the ARD image service (api.ardmediathek.de, `w=`). Every
 * other address stays as it is. The caller falls back to `url` when the
 * larger picture does not load.
 */
export function largestCover(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.hostname !== 'api.ardmediathek.de' || !u.pathname.startsWith('/image-service/images/')) return url;
  const w = Number(u.searchParams.get('w'));
  if (!Number.isInteger(w) || w <= 0 || w >= ARD_COVER_WIDTH) return url;
  u.searchParams.set('w', String(ARD_COVER_WIDTH));
  return u.toString();
}
