/**
 * Builds the sample index from the saved fixtures, the way the daily job
 * would from live answers (no network). Shared by the builder, filter and
 * loader tests; tests/fixtures/sources/index/index-v1.sample.json is its output.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { buildIndex, type ArchiveMetadata, type BuildInputs, type GsbStoryData } from '../../src/core/sources/build';
import { appOrigins, deliveryFromChain, type Hop, type HostVerdict } from '../../src/core/sources/cors';
import { GSB_HEAD_BYTES, parseGsbHead } from '../../src/core/sources/gsb';
import { parseRss } from '../../src/core/sources/rss';
import type { CatalogEntry, ReleasedItem, SourceCatalog, SourceIndex } from '../../src/core/sources/types';

export const FX = new URL('../fixtures/sources/', import.meta.url);
export const fxPath = (p: string) => new URL(p, FX);
export const fxText = (p: string) => readFileSync(fxPath(p), 'utf8');
export const fxJson = <T>(p: string): T => JSON.parse(fxText(p)) as T;
export const fxBytes = (p: string) => new Uint8Array(readFileSync(fxPath(p)));

export const WEB_ORIGIN = 'https://studio.example.de';
export const ORIGINS = appOrigins(WEB_ORIGIN);
export const NOW = new Date('2026-10-05T04:00:00Z');

/**
 * The entries the owner released on 2026-10-06 as his picks, in the order of their ranks (the LibriVox books left in 0.4).
 * Podcasts until 0.4, now links to their episodes on ARD Sounds like the others.
 */
export const OWNER_PICKS: readonly string[] = ['wdr-mumins', 'ndr-pfefferkoerner', 'wdr-maushoerspiel-lang', 'rbb-unser-sandmaennchen'];

/**
 * Public broadcasters' plays added in 0.2 as links to their pages on ARD Sounds
 * (no free licence: the family downloads there), with picks 10 to 12.
 */
export const LINKS_02: readonly string[] = ['ard-hoerspielklassiker', 'hr-mucks-wuestenfuchs', 'br-pumuckl-folgen'];

/** Entries added in 0.2 after a check of rights, readers and how well known they are, without listening (review.by says so). */
export const ADDED_02: readonly string[] = ['ohrka', ...LINKS_02];

/** Knowledge shows added in 0.3: link entries whose titles come only from their show pages (none in the fixtures). */
export const SHOWS_03: readonly string[] = ['kakadu-kinderpodcast', 'br-checkpod', 'br-anna-wilde-tiere'];

/** Added in 0.3 on the owner's wish #2 (children's podcasts and knowledge shows), as links, without listening. */
export const ADDED_03: readonly string[] = ['kakadu-kinderhoerspiel', ...SHOWS_03];

/** Shows on ARD Sounds added (or made active) in 0.4 on the owner's wish for more picks, as links, without listening. */
export const ADDED_04: readonly string[] = ['wdr-kleiner-prinz', 'rbb-ohrenbaer', 'rbb-dr-brumm', 'wdr-maushoerspiel-kurz'];

/**
 * Shows on ARD Sounds added in 0.6 from the weekly round of 27.10.2026, as links, without listening.
 * Krümelgeschichten (MDR) came in the same round but waits as 'check': its age group is unclear.
 */
export const ADDED_06: readonly string[] = ['rbb-mimi-sandmaedchen'];

/** Every entry that lists episodes on ARD Sounds: links with ARD's player, the family saves on the page. */
export const ARD_LINKS: readonly string[] = [...OWNER_PICKS, ...LINKS_02, ...ADDED_04, ...ADDED_06];

export function realCatalog(): SourceCatalog {
  return JSON.parse(readFileSync(new URL('../../sources/catalog.json', import.meta.url), 'utf8')) as SourceCatalog;
}

export interface CorsFixture {
  name: string;
  kind: 'observed' | 'partial' | 'synthetic';
  expect: 'direct' | 'browser' | 'unverified' | 'unstable' | 'rejected';
  hops?: Hop[];
  request?: { url: string };
}

export function corsFixtures(): { file: string; fx: CorsFixture }[] {
  return readdirSync(fxPath('cors/'))
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((file) => ({ file, fx: fxJson<CorsFixture>(`cors/${file}`) }));
}

/** Host verdicts as the builder's check would record them from the observed media chains. */
export function sampleHosts(): Record<string, HostVerdict> {
  const hosts: Record<string, HostVerdict> = {};
  for (const { file, fx } of corsFixtures()) {
    if (!fx.request) continue;
    const host = new URL(fx.request.url).hostname;
    if (fx.expect === 'unverified' || fx.expect === 'unstable') {
      hosts[host] = fx.expect;
      continue;
    }
    if (fx.kind !== 'observed' || !fx.hops || file.startsWith('gitlab-web') || file.includes('feed')) continue;
    const { delivery } = deliveryFromChain(fx.hops, ORIGINS);
    hosts[host] = hosts[host] === 'browser' ? 'browser' : delivery;
  }
  return hosts;
}

/** All 40 stories as read from the repository, with the playing time of the two files we have. */
export function gsbStories(): GsbStoryData[] {
  const stories = fxJson<{ stories: (GsbStoryData & Record<string, unknown>)[] }>('gitlab/gsb_de_stories.json').stories;
  const heads: Record<string, string> = { '0001': 'gitlab/gsb_de-0001_tall.mp3', '0002': 'gitlab/gsb_de-0002_animals.mp3' };
  return stories.map((s) => {
    const d: GsbStoryData = { id: s.id, path: s.path, name: s.name, size: s.size, title: s.title, reader: s.reader, year: s.year, comment: s.comment };
    const file = heads[s.id];
    if (file) d.durationSec = parseGsbHead(fxBytes(file).subarray(0, GSB_HEAD_BYTES)).durationSec;
    return d;
  });
}

export const TEST_ENTRIES: CatalogEntry[] = [
  {
    id: 'test-tracking',
    type: 'podcast',
    status: 'active',
    title: 'Beispiel mit Messweiterleitung',
    publisher: 'Test',
    pageUrl: 'https://example.org/',
    feedUrl: 'https://example.org/feed.xml',
    mediaHosts: ['traffic.megaphone.fm'],
    category: 'hoerspiel',
    ages: { min: 6, source: 'editor' },
    language: 'de',
    rights: { kind: 'podcast', holder: 'Test' },
    delivery: 'direct',
    editPolicy: 'normal',
    review: { by: 'Test', at: '2026-10-01', next: '2027-04-01' },
  },
  {
    id: 'test-broken',
    type: 'podcast',
    status: 'active',
    title: 'Kaputter Feed',
    publisher: 'Test',
    pageUrl: 'https://example.org/',
    feedUrl: 'https://example.org/broken.xml',
    mediaHosts: ['example.org'],
    category: 'hoerspiel',
    ages: { min: 6, source: 'editor' },
    language: 'de',
    rights: { kind: 'podcast', holder: 'Test' },
    delivery: 'direct',
    editPolicy: 'normal',
    review: { by: 'Test', at: '2026-10-01', next: '2027-04-01' },
  },
];

export const PREVIOUS: SourceIndex = {
  format: 1,
  generatedAt: '2026-10-04T04:00:00.000Z',
  staleAfter: '2026-10-18T04:00:00.000Z',
  blocked: [],
  entries: [
    {
      id: 'test-broken',
      type: 'podcast',
      title: 'Kaputter Feed',
      publisher: 'Test',
      categories: ['hoerspiel'],
      ages: { min: 6, source: 'editor' },
      language: 'de',
      rights: { kind: 'podcast', holder: 'Test' },
      delivery: 'direct',
      editPolicy: 'normal',
      pageUrl: 'https://example.org/',
      checkedAt: '2026-10-04T04:00:00.000Z',
      items: [{ key: 'test-broken/1', title: 'Folge von gestern', category: 'hoerspiel', files: [{ url: 'https://example.org/a.mp3', name: 'a.mp3' }] }],
    },
  ],
};

/** Radio Klops holds every new episode; in the sample a person listened to all seven. */
export function radioKlopsReleased(): ReleasedItem[] {
  return parseRss(fxText('feeds/radioklops.xml')).items.map((i) => ({ key: `radio-klops/${i.guid}`, by: 'Redaktion', at: '2026-10-05' }));
}

export function sampleInputs(overrides: Partial<BuildInputs> = {}): BuildInputs {
  return {
    now: NOW,
    feeds: {
      'kakadu-kinderhoerspiel': fxText('feeds/kakadu-kinderhoerspiel-118.xml'),
      'srf-kids-hoerspiele': fxText('feeds/srf-kids-hoerspiele.xml'),
      'radio-klops': fxText('feeds/radioklops.xml'),
      'test-tracking': fxText('feeds/tracking-redirect.xml'),
      'test-broken': fxText('feeds/broken.xml'),
    },
    archive: {
      'jamendo-139374': fxJson<ArchiveMetadata>('archive/jamendo-139374.metadata.json'),
    },
    gsb: { 'global-storybooks-de': gsbStories() },
    hosts: sampleHosts(),
    previous: PREVIOUS,
    released: radioKlopsReleased(),
    include: ['active', 'review', 'check'],
    ...overrides,
  };
}

/**
 * The catalogue the sample is built from. The links to ARD Sounds stay out:
 * they need no fixtures, and the sample keeps the sources and picks the
 * builder, filter and loader tests were written for.
 */
export function sampleCatalog(): SourceCatalog {
  const c = realCatalog();
  return { ...c, entries: [...c.entries.filter((e) => !ARD_LINKS.includes(e.id) && !SHOWS_03.includes(e.id)), ...TEST_ENTRIES] };
}

/** The sample index (test entries removed), as written to tests/fixtures/sources/index/index-v1.sample.json. */
export function buildSample() {
  const { index, report } = buildIndex(sampleCatalog(), sampleInputs());
  const sample: SourceIndex = { ...index, entries: index.entries.filter((e) => !e.id.startsWith('test-')) };
  return { index, report, sample };
}

/** The committed sample index. */
export function loadSample(): SourceIndex {
  return fxJson<SourceIndex>('index/index-v1.sample.json');
}
