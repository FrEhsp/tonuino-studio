import { signal } from '@preact/signals';

export type Route =
  | { page: 'box' }
  | { page: 'folder'; folder: number }
  | { page: 'add'; folder?: number }
  | { page: 'sources'; entry?: string }
  | { page: 'stickers' }
  | { page: 'cards' }
  | { page: 'record' }
  | { page: 'workshop'; tool?: string }
  | { page: 'help'; topic?: string }
  | { page: 'settings' };

/**
 * One part of the hash in plain text. decodeURIComponent throws on a broken
 * escape, and parseHash runs while the app starts, so a link with a stray
 * "%" must not stop it. Older tools write umlauts as Latin-1 ("%E4" for
 * "ä"); those are read as such, anything else stays as typed.
 */
function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodePart);
  switch (parts[0]) {
    case 'ordner': {
      const n = Number(parts[1]);
      return Number.isInteger(n) && n >= 1 && n <= 99 ? { page: 'folder', folder: n } : { page: 'box' };
    }
    case 'hinzufuegen': {
      const n = Number(parts[1]);
      return { page: 'add', folder: Number.isInteger(n) && n >= 1 && n <= 99 ? n : undefined };
    }
    case 'entdecken':
      // A build without "Entdecken" treats the address like any unknown one.
      if (!__SOURCES_ENABLED__) return { page: 'box' };
      return parts[1] ? { page: 'sources', entry: parts[1] } : { page: 'sources' };
    case 'sticker':
      return { page: 'stickers' };
    case 'karten':
      return { page: 'cards' };
    case 'aufnehmen':
      return { page: 'record' };
    case 'werkstatt':
      return { page: 'workshop', tool: parts[1] };
    case 'hilfe':
      return { page: 'help', topic: parts[1] };
    case 'einstellungen':
      return { page: 'settings' };
    default:
      return { page: 'box' };
  }
}

export function routeToHash(r: Route): string {
  switch (r.page) {
    case 'box':
      return '#/';
    case 'folder':
      return `#/ordner/${String(r.folder).padStart(2, '0')}`;
    case 'add':
      return r.folder ? `#/hinzufuegen/${String(r.folder).padStart(2, '0')}` : '#/hinzufuegen';
    case 'sources':
      return r.entry ? `#/entdecken/${encodeURIComponent(r.entry)}` : '#/entdecken';
    case 'stickers':
      return '#/sticker';
    case 'cards':
      return '#/karten';
    case 'record':
      return '#/aufnehmen';
    case 'workshop':
      return r.tool ? `#/werkstatt/${r.tool}` : '#/werkstatt';
    case 'help':
      return r.topic ? `#/hilfe/${r.topic}` : '#/hilfe';
    case 'settings':
      return '#/einstellungen';
  }
}

export const route = signal<Route>(typeof location !== 'undefined' ? parseHash(location.hash) : { page: 'box' });

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    // Where the page shows (scroll position) is up to App.tsx: kept pages keep theirs.
    route.value = parseHash(location.hash);
  });
}

/**
 * Opens `r` when the address names no page yet: the Android app starts at
 * the cards, since there is no SD card on the phone. A link to a page wins.
 */
export function startAt(r: Route) {
  if (typeof location === 'undefined' || location.hash.replace(/^#\/?/, '')) return;
  history.replaceState(history.state, '', routeToHash(r));
  route.value = r;
}

export function navigate(r: Route) {
  const h = routeToHash(r);
  if (location.hash !== h) location.hash = h;
  else route.value = r;
}
