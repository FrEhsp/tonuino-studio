import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { indexUrl } from '../../src/core/sources/load';
import { entryCount, isContactAddress, listAddressSet, releaseProblems, sourcesEnabled } from '../../src/features/sources/release';

const CONTACT = 'quellen@tonuino-studio.example';

describe('what a release with "Entdecken" needs', () => {
  it('stops every release without an address for „Melden“', () => {
    expect(releaseProblems({ VITE_WEB_ORIGIN: 'https://studio.example.de' }, 'web')).toEqual([expect.stringContaining('VITE_SOURCES_CONTACT')]);
    expect(releaseProblems({ VITE_SOURCES_CONTACT: 'kein-mail' }, 'web')).toHaveLength(1);
    expect(releaseProblems({ VITE_SOURCES_CONTACT: CONTACT }, 'web')).toEqual([]);
    expect(isContactAddress(` ${CONTACT} `)).toBe(true);
    expect(isContactAddress('a@b')).toBe(false);
    expect(isContactAddress('mailto:a@b.de')).toBe(false);
  });

  it('stops a desktop release that could never load the list and its kill switch', () => {
    expect(releaseProblems({ VITE_SOURCES_CONTACT: CONTACT }, 'desktop')).toEqual([expect.stringContaining('VITE_WEB_ORIGIN')]);
    expect(releaseProblems({ VITE_SOURCES_CONTACT: CONTACT, VITE_WEB_ORIGIN: 'http://studio.example.de' }, 'desktop')).toHaveLength(1);
    expect(releaseProblems({ VITE_SOURCES_CONTACT: CONTACT, VITE_WEB_ORIGIN: 'https://studio.example.de/' }, 'desktop')).toEqual([]);
    expect(releaseProblems({ VITE_SOURCES_CONTACT: CONTACT, VITE_SOURCES_INDEX_URL: '/quellen/index-preview.json' }, 'desktop')).toEqual([expect.stringContaining('VITE_SOURCES_INDEX_URL')]);
    expect(releaseProblems({ VITE_SOURCES_CONTACT: CONTACT, VITE_SOURCES_INDEX_URL: 'https://studio.example.de/quellen/index-preview.json' }, 'desktop')).toEqual([]);
    // The Android app shows the list that comes with it: no address needed, but one it names must work.
    expect(releaseProblems({ VITE_SOURCES_CONTACT: CONTACT }, 'desktop', false, true)).toEqual([]);
    expect(releaseProblems({}, 'desktop', false, true)).toEqual([expect.stringContaining('VITE_SOURCES_CONTACT')]);
    expect(releaseProblems({ VITE_SOURCES_CONTACT: CONTACT, VITE_WEB_ORIGIN: 'http://studio.example.de' }, 'desktop', false, true)).toHaveLength(1);
  });

  it('agrees with the app about which desktop settings give a list address', () => {
    const cases = [
      { VITE_WEB_ORIGIN: 'https://studio.example.de' },
      { VITE_WEB_ORIGIN: 'http://studio.example.de' },
      { VITE_WEB_ORIGIN: '' },
      { VITE_SOURCES_INDEX_URL: 'https://preview.example.de/x.json' },
      { VITE_SOURCES_INDEX_URL: '/relativ.json' },
    ];
    for (const env of cases) {
      const url = indexUrl({ kind: 'desktop', pageUrl: 'tauri://localhost/', webOrigin: env.VITE_WEB_ORIGIN, override: env.VITE_SOURCES_INDEX_URL });
      const ok = releaseProblems({ VITE_SOURCES_CONTACT: CONTACT, ...env }, 'desktop').length === 0;
      expect(ok, JSON.stringify(env)).toBe(!!url);
    }
  });

  it('refuses a list address the web app cannot use', () => {
    expect(releaseProblems({ VITE_SOURCES_CONTACT: CONTACT, VITE_SOURCES_INDEX_URL: 'javascript:alert(1)' }, 'web')).toEqual([expect.stringContaining('VITE_SOURCES_INDEX_URL')]);
    expect(releaseProblems({ VITE_SOURCES_CONTACT: CONTACT, VITE_SOURCES_INDEX_URL: '/quellen/index-preview.json' }, 'web')).toEqual([]);
  });
});

describe('which builds offer "Entdecken"', () => {
  it('only a build with a list to show: one that comes with the app, or an address set for the build', () => {
    expect(sourcesEnabled({}, 'web', 0)).toBe(false);
    expect(sourcesEnabled({}, 'desktop', 0)).toBe(false);
    expect(sourcesEnabled({}, 'web', 12)).toBe(true);
    expect(sourcesEnabled({}, 'desktop', 12)).toBe(true);
    expect(sourcesEnabled({ VITE_SOURCES_INDEX_URL: '/quellen/index-preview.json' }, 'web', 0)).toBe(true);
    expect(sourcesEnabled({ VITE_SOURCES_INDEX_URL: 'https://studio.example.de/quellen/index-v1.json' }, 'desktop', 0)).toBe(true);
    expect(sourcesEnabled({ VITE_SOURCES_INDEX_URL: '  ' }, 'web', 0)).toBe(false);
    // The web app's own address is no list address: every web build has one.
    expect(sourcesEnabled({ VITE_WEB_ORIGIN: 'https://studio.example.de' }, 'web', 0)).toBe(false);
    expect(sourcesEnabled({ VITE_WEB_ORIGIN: 'https://studio.example.de' }, 'desktop', 0)).toBe(true);
    // The contact address alone turns nothing on.
    expect(sourcesEnabled({ VITE_SOURCES_CONTACT: CONTACT }, 'web', 0)).toBe(false);
    expect(listAddressSet({ VITE_WEB_ORIGIN: '' }, 'desktop')).toBe(false);
  });

  it('a build without "Entdecken" needs none of its settings, one with it is checked', () => {
    // vite.config.ts asks releaseProblems only for builds that offer "Entdecken".
    const check = (env: Parameters<typeof releaseProblems>[0], target: 'web' | 'desktop', entries: number) =>
      sourcesEnabled(env, target, entries) ? releaseProblems(env, target) : [];
    expect(check({}, 'web', 0)).toEqual([]);
    expect(check({}, 'desktop', 0)).toEqual([]);
    expect(check({}, 'web', 12)).toEqual([expect.stringContaining('VITE_SOURCES_CONTACT')]);
    expect(check({}, 'desktop', 12)).toEqual([expect.stringContaining('VITE_SOURCES_CONTACT'), expect.stringContaining('VITE_WEB_ORIGIN')]);
    expect(check({ VITE_WEB_ORIGIN: 'https://studio.example.de' }, 'desktop', 0)).toEqual([expect.stringContaining('VITE_SOURCES_CONTACT')]);
    expect(check({ VITE_SOURCES_INDEX_URL: '/quellen/index-preview.json', VITE_SOURCES_CONTACT: CONTACT }, 'web', 0)).toEqual([]);
  });

  it('counts the entries of the list that comes with the app', () => {
    const text = readFileSync(new URL('../../sources/snapshot/index-v1.json', import.meta.url), 'utf8');
    expect(entryCount(text)).toBe((JSON.parse(text) as { entries: unknown[] }).entries.length);
    expect(entryCount(JSON.stringify({ format: 1, entries: [{ id: 'a' }, { id: 'b' }] }))).toBe(2);
    expect(entryCount(JSON.stringify({ format: 1, entries: [] }))).toBe(0);
    for (const broken of ['', 'kaputt', 'null', '{"entries": {}}']) expect(entryCount(broken), broken).toBe(0);
  });
});
