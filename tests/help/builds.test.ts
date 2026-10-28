/**
 * The help as each build has it. The tests see the desktop app with
 * "Entdecken"; these tests load the help again with the build constants of
 * the web app (`__DESKTOP_BUILD__` false) and of a build without "Entdecken"
 * (`__SOURCES_ENABLED__` false). tests/build/webBuild.test.ts checks the
 * built files themselves.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Topics = typeof import('../../src/features/help/topics');
type Search = typeof import('../../src/features/help/search');

async function helpOf(globals: Record<string, unknown>): Promise<{ topics: Topics; search: Search }> {
  vi.resetModules();
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  return { topics: await import('../../src/features/help/topics'), search: await import('../../src/features/help/search') };
}

const ids = (search: Search, query: string) => search.searchHelp(query).hits.map((h) => h.id);

/** Everything a person can read or find in the help: texts, titles, search words and aliases. */
const allOf = (t: Topics) => JSON.stringify([t.HELP_TOPICS, t.HELP_ALIASES]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the help of the desktop app', () => {
  it('has no word about audio from web pages, video sites or yt-dlp either', async () => {
    const { topics, search } = await helpOf({ __DESKTOP_BUILD__: true });
    expect(topics.findSection('von-einer-webseite')).toBeUndefined();
    expect(allOf(topics)).not.toMatch(/yt-dlp|youtube|von einer webseite/i);
    for (const q of ['YouTube', 'yt-dlp']) expect(search.searchHelp(q).total, q).toBe(0);
    expect(topics.resolveHelp('youtube').kind).toBe('missing');
    // A playlist is one put together from one's own files (cd-und-streaming).
    expect(ids(search, 'Playlist')[0]).toBe('cd-und-streaming');
  });

  it('names every menu item in the overview, "Entdecken" too', async () => {
    const { topics } = await helpOf({ __DESKTOP_BUILD__: true, __SOURCES_ENABLED__: true });
    const overview = topics.findSection('was-die-app-kann')!.section.blocks.flatMap(topics.blockTexts).join('\n');
    for (const item of ['Meine Box', 'Hinzufügen', 'Entdecken', 'Sticker drucken', 'Karten beschreiben', 'Werkstatt']) expect(overview, item).toContain(`**${item}**`);
    expect(overview).toContain('(#/hilfe/entdecken)');
  });
});

describe('the help of the web app', () => {
  it('has no word about audio from web pages, video sites or yt-dlp', async () => {
    const { topics, search } = await helpOf({ __DESKTOP_BUILD__: false });
    expect(topics.findSection('von-einer-webseite')).toBeUndefined();
    expect(allOf(topics)).not.toMatch(/yt-dlp|youtube|video|von einer webseite/i);
    // The notice of the web download; "urheberrechtlich geschützt" about covers is another text.
    expect(allOf(topics)).not.toContain('Urheberrecht');
    for (const q of ['YouTube', 'yt-dlp', 'Video']) expect(search.searchHelp(q).total, q).toBe(0);
    expect(topics.resolveHelp('youtube').kind).toBe('missing');
  });

  it('still says where music can come from: CDs, streaming and bought audiobooks', async () => {
    const { topics, search } = await helpOf({ __DESKTOP_BUILD__: false });
    expect(topics.findSection('cd-und-streaming')?.topic.id).toBe('musik');
    for (const q of ['Spotify', 'Streaming', 'CD', 'Audible', 'Hörbuch kaufen', 'Playlist', 'Titelliste']) expect(ids(search, q)[0], q).toBe('cd-und-streaming');
  });
});

describe('a build without "Entdecken"', () => {
  it('neither shows nor links the section, in the web app and in the desktop app', async () => {
    for (const desktop of [false, true]) {
      const { topics } = await helpOf({ __SOURCES_ENABLED__: false, __DESKTOP_BUILD__: desktop });
      expect(topics.findSection('entdecken'), String(desktop)).toBeUndefined();
      expect(allOf(topics), String(desktop)).not.toMatch(/Entdecken|#\/entdecken/);
      // The links that remain all lead somewhere.
      for (const l of topics.helpLinks().filter((x) => x.href.startsWith('#/hilfe/'))) {
        expect(topics.resolveHelp(l.href.slice('#/hilfe/'.length)).kind, l.href).toBe('topic');
      }
    }
  });
});

describe('the check for new versions in the privacy text', () => {
  const privacy = (t: Topics) => t.findSection('datenschutz')!.section.blocks.flatMap(t.blockTexts).join('\n');

  afterEach(() => vi.unstubAllEnvs());

  it('is named, with its server, only in a desktop build that has a release list', async () => {
    vi.stubEnv('VITE_RELEASES_URL', 'https://api.github.com/repos/beispiel/tonuino-studio/releases/latest');
    const desktop = (await helpOf({ __DESKTOP_BUILD__: true })).topics;
    expect(privacy(desktop)).toContain('fragt die App höchstens einmal am Tag bei api.github.com nach');
    expect(privacy(desktop)).toContain('Ab Werk ist das aus.');
    expect(privacy(desktop)).toContain('Die Desktop-App sucht nur dann nach neuen Versionen, wenn du es einschaltest.');
    expect(privacy(desktop)).not.toContain('sucht auch nicht von selbst');

    const web = (await helpOf({ __DESKTOP_BUILD__: false })).topics;
    expect(privacy(web)).not.toContain('Neue Versionen:');
  });

  it('without a release list the app never asks, and the text says so', async () => {
    vi.stubEnv('VITE_RELEASES_URL', '');
    const { topics } = await helpOf({ __DESKTOP_BUILD__: true });
    expect(privacy(topics)).not.toContain('Neue Versionen:');
    expect(privacy(topics)).toContain('Die Desktop-App sucht auch nicht von selbst nach neuen Versionen.');
  });
});
