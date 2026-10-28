import { describe, expect, it, vi } from 'vitest';
import { parseHash, previousPage, route, routeToHash, startsBare, type Route } from '../../src/app/router';
import { resolveHelp } from '../../src/features/help/topics';

describe('parseHash', () => {
  it('reads every page and goes back to the same hash', () => {
    for (const hash of ['#/', '#/ordner/07', '#/hinzufuegen', '#/hinzufuegen/12', '#/musik', '#/karte', '#/karte/14', '#/sticker', '#/sticker/alle', '#/karten', '#/aufnehmen', '#/werkstatt', '#/werkstatt/logbuch', '#/hilfe', '#/hilfe/lautstaerke', '#/einstellungen']) {
      expect(routeToHash(parseHash(hash)), hash).toBe(hash);
    }
  });

  it('only an address without a hash opens the start page; "#/" stays Meine Box', () => {
    expect(startsBare('')).toBe(true);
    expect(startsBare('#')).toBe(true);
    expect(startsBare('#/')).toBe(false);
    expect(parseHash('#/')).toEqual({ page: 'box' });
  });

  it('decodes escaped umlauts', () => {
    expect(parseHash('#/hilfe/Lautst%C3%A4rke')).toEqual({ page: 'help', topic: 'Lautstärke' });
  });

  it('a broken escape does not stop the app: Latin-1 umlauts are read, anything else stays as typed', () => {
    expect(parseHash('#/hilfe/lautst%E4rke')).toEqual({ page: 'help', topic: 'lautstärke' });
    expect(parseHash('#/hilfe/100%')).toEqual({ page: 'help', topic: '100%' });
    expect(parseHash('#/hilfe/%ZZ%C3')).toEqual({ page: 'help', topic: '%ZZÃ' });
    expect(parseHash('#/ordner/0%')).toEqual({ page: 'box' });
  });

  it('the help shows the right page or its "not found" note for such links', () => {
    const latin1 = parseHash('#/hilfe/lautst%E4rke');
    const r = resolveHelp(latin1.page === 'help' ? latin1.topic : undefined);
    expect(r.kind === 'topic' && r.section?.id).toBe('lautstaerke');
    const broken = parseHash('#/hilfe/100%');
    expect(resolveHelp(broken.page === 'help' ? broken.topic : undefined)).toEqual({ kind: 'missing', id: '100%' });
  });
});

describe('router', () => {
  it('opens "Entdecken" and a source by its id', () => {
    expect(parseHash('#/entdecken')).toEqual({ page: 'sources' });
    expect(parseHash('#/entdecken/')).toEqual({ page: 'sources' });
    expect(parseHash('#/entdecken/srf-kids-hoerspiele')).toEqual({ page: 'sources', entry: 'srf-kids-hoerspiele' });
    expect(routeToHash({ page: 'sources' })).toBe('#/entdecken');
    expect(routeToHash({ page: 'sources', entry: 'srf-kids-hoerspiele' })).toBe('#/entdecken/srf-kids-hoerspiele');
  });

  it('round-trips every page', () => {
    const routes: Route[] = [
      { page: 'box' },
      { page: 'folder', folder: 5 },
      { page: 'add' },
      { page: 'add', folder: 12 },
      { page: 'sources' },
      { page: 'sources', entry: 'global-storybooks-de' },
      { page: 'musik' },
      { page: 'karte' },
      { page: 'karte', folder: 14 },
      { page: 'sticker' },
      { page: 'stickers' },
      { page: 'cards' },
      { page: 'record' },
      { page: 'workshop' },
      { page: 'help', topic: 'musik' },
      { page: 'settings' },
    ];
    for (const r of routes) expect(parseHash(routeToHash(r))).toEqual(r);
  });

  it('keeps the sticker page with all its settings under #/sticker/alle, the front task at #/sticker (0.6)', () => {
    expect(parseHash('#/sticker')).toEqual({ page: 'sticker' });
    expect(parseHash('#/sticker/alle')).toEqual({ page: 'stickers' });
    expect(parseHash('#/karte/100')).toEqual({ page: 'karte' });
  });

  it('survives odd addresses', () => {
    // A broken escape is read like in the help links above (Latin-1 where it can, the rest as typed).
    expect(parseHash('#/entdecken/%E0%A4%A')).toEqual({ page: 'sources', entry: 'à¤%A' });
    expect(parseHash('#/entdecken/a%2Fb')).toEqual({ page: 'sources', entry: 'a/b' });
    expect(routeToHash({ page: 'sources', entry: 'a/b' })).toBe('#/entdecken/a%2Fb');
    expect(parseHash('#/gibtsnicht')).toEqual({ page: 'box' });
  });

  it('opens the start page for "Entdecken" in a build without it, like for any unknown address', () => {
    vi.stubGlobal('__SOURCES_ENABLED__', false);
    try {
      expect(parseHash('#/entdecken')).toEqual({ page: 'box' });
      expect(parseHash('#/entdecken/srf-kids-hoerspiele')).toEqual({ page: 'box' });
      expect(parseHash('#/hinzufuegen')).toEqual({ page: 'add', folder: undefined });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(parseHash('#/entdecken')).toEqual({ page: 'sources' });
  });
});

describe('previousPage', () => {
  it('remembers the page shown before, so the help leads back to the Werkstatt only from there (WebKit W5)', () => {
    route.value = { page: 'musik' };
    route.value = { page: 'help' };
    expect(previousPage.value).toBe('musik');
    route.value = { page: 'workshop' };
    route.value = { page: 'help', topic: 'lautstaerke' };
    expect(previousPage.value).toBe('workshop');
    // Within the help, the page before stays the Werkstatt.
    route.value = { page: 'help' };
    expect(previousPage.value).toBe('workshop');
  });
});
