/**
 * What each provider allows (src/core/sources/providers.ts): playing in the
 * app, saving through the app or only on the provider's page, and which
 * player and file addresses the list may carry.
 */
import { describe, expect, it } from 'vitest';
import { buildIndex, publishGates } from '../../src/core/sources/build';
import { ardEpisodePage } from '../../src/core/sources/pages';
import { appLoadHost, appLoadsFile, ARD_EMBED, embedAllowed, embedOf, fileAllowed, PROVIDERS, providerOf, providerProblems, saveWay } from '../../src/core/sources/providers';
import { readFileSync } from 'node:fs';
import type { CatalogEntry, Rights, SourceCatalog } from '../../src/core/sources/types';
import { parseIndex, validateCatalog, validateIndex } from '../../src/core/sources/validate';
import { fxText, realCatalog } from './sample';

const NOW = new Date('2026-10-15T06:00:00Z');
const ARD: Rights = { kind: 'private-use', holder: 'ARD Sounds', termsUrl: 'https://www.ardsounds.de/nutzungsbedingungen/' };
const OHRKA: Rights = { kind: 'private-use', holder: 'OHRKA e.V.', termsUrl: 'https://www.ohrka.de/impressum' };
const DLF: Rights = { kind: 'podcast', holder: 'Deutschlandradio', termsUrl: 'https://www.kakadu.de/nutzungsbedingungen-106.html' };
const PLAYER = 'https://www.ardsounds.de/embed/episode/16329591/';
const EP = 'https://www.ardsounds.de/episode/urn:ard:episode:02e2c3207e8a1ab4/';
const ALICE = 'https://www.ohrka.de/fileadmin/audio/Alice/Alice_im_Wunderland_komplett.mp3';

type LinkEntry = Extract<CatalogEntry, { type: 'link' }>;

function link(over: Partial<LinkEntry> = {}): LinkEntry {
  return {
    id: 'ard-test',
    type: 'link',
    status: 'active',
    title: 'Test',
    publisher: 'ARD',
    pageUrl: 'https://www.ardsounds.de/sendung/test/urn:ard:show:a98eaa600a311568/',
    category: 'hoerspiel',
    ages: { min: 5, max: 12, source: 'publisher', text: 'Ab 5 Jahren' },
    language: 'de',
    rights: ARD,
    delivery: 'browser',
    editPolicy: 'unchanged',
    review: { by: 'Test', at: '2026-10-15', next: '2027-04-15' },
    items: [{ title: 'Die Schatzinsel (1/3)', pageUrl: EP, ages: { min: 7, max: 12 }, durationSec: 3180, until: '2031-04-30', embed: PLAYER }],
    ...over,
  };
}

const catalog = (...entries: CatalogEntry[]): SourceCatalog => ({ format: 1, updatedAt: '2026-10-15', entries, blocked: [], notUsed: [] });
const build = (c: SourceCatalog) => buildIndex(c, { now: NOW, feeds: {}, archive: {}, gsb: {}, hosts: {}, released: [], include: ['active'] });

describe('the provider table', () => {
  it('has a row for the terms of every active entry without a free licence', () => {
    for (const e of realCatalog().entries.filter((x) => x.status === 'active')) {
      if (e.rights.kind === 'cc' || e.rights.kind === 'public-domain' || e.permission?.granted) continue;
      expect(providerOf(e.rights)?.termsUrl, e.id).toBe(e.rights.termsUrl);
      expect(providerProblems(e), e.id).toEqual([]);
    }
  });

  it('records for each row the terms, the day they were read and their own words', () => {
    const used = new Set(realCatalog().entries.map((e) => ('termsUrl' in e.rights ? e.rights.termsUrl : undefined)));
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
    for (const p of PROVIDERS) {
      expect(p.termsUrl, p.id).toMatch(/^https:\/\//);
      expect(p.checkedAt, p.id).toMatch(/^2026-\d\d-\d\d$/);
      expect(p.quote, p.id).toMatch(/„.+“/);
      expect(used.has(p.termsUrl), p.id).toBe(true);
      // A player only with a fixed pattern, a file only on named hosts.
      if (p.play.includes('embed')) expect(p.embed, p.id).toBeInstanceOf(RegExp);
      if (p.save === 'app') expect(p.fileHosts.length, p.id).toBeGreaterThan(0);
    }
  });

  it('lets ARD Sounds play in its own player and save only on its page', () => {
    expect(saveWay({ rights: ARD })).toBe('page');
    expect(embedAllowed(ARD, PLAYER)).toBe(true);
    for (const bad of [
      'https://www.ardsounds.de/embed/episode/16329591',
      'http://www.ardsounds.de/embed/episode/16329591/',
      'https://www.ardsounds.de/embed/episode/16329591/?autoplay=1',
      'https://evil.example/embed/episode/16329591/',
      'https://www.ardsounds.de/episode/urn:ard:episode:02e2c3207e8a1ab4/',
      'https://www.ardsounds.de.evil.example/embed/episode/1/',
    ]) {
      expect(embedAllowed(ARD, bad), bad).toBe(false);
    }
    expect(ARD_EMBED.test(PLAYER)).toBe(true);
    // No file of ARD Sounds is offered to save, wherever it lies.
    expect(fileAllowed({ rights: ARD }, 'https://www.ardsounds.de/x.mp3')).toBe(false);
  });

  it('lets OHRKA files be saved, only from ohrka.de, and never plays a player there', () => {
    expect(saveWay({ rights: OHRKA })).toBe('app');
    expect(fileAllowed({ rights: OHRKA }, ALICE)).toBe(true);
    expect(fileAllowed({ rights: OHRKA }, 'https://cdn.example/Alice.mp3')).toBe(false);
    expect(fileAllowed({ rights: OHRKA }, 'http://www.ohrka.de/fileadmin/a.mp3')).toBe(false);
    expect(embedAllowed(OHRKA, PLAYER)).toBe(false);
  });

  it('lets the desktop app load OHRKA files itself, only from their own host, and nothing of the others', () => {
    expect(appLoadsFile(OHRKA, ALICE)).toBe(true);
    expect(appLoadsFile(OHRKA, 'https://cdn.example/Alice.mp3')).toBe(false);
    expect(appLoadsFile(OHRKA, 'http://www.ohrka.de/fileadmin/a.mp3')).toBe(false);
    expect(appLoadsFile(OHRKA, undefined)).toBe(false);
    expect(appLoadsFile(ARD, 'https://www.ardsounds.de/x.mp3')).toBe(false);
    expect(appLoadsFile(DLF, 'https://podcast-mp3.dradio.de/a.mp3')).toBe(false);
    expect(appLoadHost(ALICE)).toBe(true);
    expect(appLoadHost('https://evil.www.ohrka.de/a.mp3')).toBe(false);
    expect(appLoadHost('https://podcast-mp3.dradio.de/a.mp3')).toBe(false);
  });

  it('names only hosts the desktop helper allows for the files the app loads itself', () => {
    // src-tauri/src/sources_net.rs ALLOWED_HOSTS: the helper refuses every other host before any network.
    const rust = readFileSync(new URL('../../src-tauri/src/sources_net.rs', import.meta.url), 'utf8');
    const block = /pub const ALLOWED_HOSTS: &\[\(&str, bool\)\] = &\[([\s\S]*?)\n\];/.exec(rust)?.[1] ?? '';
    const allowed = new Set([...block.matchAll(/\("([^"]+)", (?:true|false)\)/g)].map((m) => m[1]));
    expect(allowed.size).toBeGreaterThan(0);
    const own = PROVIDERS.filter((p) => p.appLoads);
    expect(own.map((p) => p.id)).toEqual(['ohrka']);
    for (const p of own) {
      expect(p.save).toBe('app');
      for (const h of p.fileHosts) expect(allowed.has(h), h).toBe(true);
    }
  });

  it('keeps Deutschlandradio to its page for saving, also for its feed files', () => {
    expect(saveWay({ rights: DLF })).toBe('page');
    expect(fileAllowed({ rights: DLF }, 'https://podcast-mp3.dradio.de/a.mp3')).toBe(false);
    // Kakadu shows on ARD Sounds play in ARD's player.
    expect(embedAllowed(DLF, PLAYER)).toBe(true);
  });

  it('lets free licences and a written permission save through the app, and unknown terms nothing', () => {
    expect(saveWay({ rights: { kind: 'cc', id: 'by', version: '4.0', url: 'https://creativecommons.org/licenses/by/4.0/' } })).toBe('app');
    expect(saveWay({ rights: ARD, permission: { needed: 'x', granted: { by: 'NDR', at: '2026-11-01', filed: 'Ordner' } } })).toBe('app');
    const unknown: Rights = { kind: 'podcast', holder: 'X', termsUrl: 'https://x.example/agb' };
    expect(saveWay({ rights: unknown })).toBe('none');
    expect(providerOf(unknown)).toBeUndefined();
  });
});

describe('the catalogue against the table', () => {
  it('refuses saving through the app where the terms allow it only on the page', () => {
    const errors = validateCatalog(catalog({ ...link(), type: 'podcast', feedUrl: 'https://www.ardsounds.de/feed.xml', mediaHosts: ['media.example.de'], delivery: 'direct' } as CatalogEntry), NOW).errors;
    expect(errors).toContain('ard-test: ARD Sounds erlaubt das Speichern über die App nicht (delivery "browser" oder permission.granted)');
  });

  it('refuses a player the provider does not offer and an entry whose terms have no row', () => {
    const wrong = link({ items: [{ ...link().items[0], embed: 'https://www.youtube.com/embed/abc' }] });
    expect(validateCatalog(catalog(wrong), NOW).errors).toContain(`ard-test: ${EP}: Player https://www.youtube.com/embed/abc ist für ARD Sounds nicht erlaubt`);
    const ohne = link({ rights: { kind: 'private-use', holder: 'X', termsUrl: 'https://x.example/agb' } });
    expect(validateCatalog(catalog(ohne), NOW).errors.some((m) => m.includes('Anbieter fehlt in providers.ts'))).toBe(true);
  });
});

describe('players and files in the list', () => {
  it('reads the player of an ARD episode page', () => {
    expect(ardEpisodePage(fxText('pages/ard-episode.html'), EP).embed).toBe(PLAYER);
  });

  it('carries the ARD player, no file; OHRKA the file to save, no player', () => {
    const ohrka = link({
      id: 'ohrka',
      publisher: 'OHRKA e.V.',
      pageUrl: 'https://www.ohrka.de/',
      rights: OHRKA,
      editPolicy: 'normal',
      items: [{ title: 'Alice im Wunderland', pageUrl: 'https://www.ohrka.de/hoeren/tierisch-spannend/alice-im-wunderland', ages: { min: 8, max: 12 }, durationSec: 11409, fileUrl: ALICE, embed: PLAYER }],
    });
    const ard = link({ items: [{ ...link().items[0], fileUrl: 'https://www.ardsounds.de/x.mp3' }] });
    const c = catalog(ard, ohrka);
    const { index } = build(c);
    const [a, o] = index.entries;
    expect(a.items[0]).toMatchObject({ embed: PLAYER, files: [], delivery: 'browser' });
    expect(o.items[0].embed).toBeUndefined();
    expect(o.items[0].files).toEqual([{ url: ALICE, name: 'Alice_im_Wunderland_komplett.mp3' }]);
    expect(o.delivery).toBe('browser');
    const serialized = JSON.stringify(index);
    expect(publishGates(index, { catalog: c, serialized, parsed: validateIndex(JSON.parse(serialized)) })).toEqual([]);
  });

  it('stops a list with a player the table does not allow, and the app leaves such a player out', () => {
    const c = catalog(link());
    const { index } = build(c);
    const bad = { ...index, entries: index.entries.map((e) => ({ ...e, items: e.items.map((it) => ({ ...it, embed: 'https://evil.example/embed/episode/1/' })) })) };
    const serialized = JSON.stringify(bad);
    expect(publishGates(bad, { catalog: c, serialized, parsed: validateIndex(JSON.parse(serialized)) })).toContain(`${bad.entries[0].items[0].key}: Player https://evil.example/embed/episode/1/ ist für diesen Anbieter nicht erlaubt.`);
    const read = parseIndex(JSON.parse(serialized));
    if (!read || read === 'needs-update') throw new Error('unreadable');
    expect(read.index.entries[0].items[0].embed).toBeUndefined();
    expect(read.index.entries[0].items).toHaveLength(1);
    expect(embedOf(read.index.entries[0], { embed: PLAYER })).toBe(PLAYER);
    expect(embedOf(read.index.entries[0], { embed: 'https://evil.example/embed/episode/1/' })).toBeUndefined();
  });
});
