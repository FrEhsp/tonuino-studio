/**
 * Link entries that keep themselves up to date: the builder reads the show
 * page of the series (ARD Sounds, OHRKA), takes new titles by the fixed
 * rules, refreshes known ones from their pages and drops what the source
 * says is gone, for good.
 */
import { describe, expect, it } from 'vitest';
import { buildIndex, linkKey } from '../../src/core/sources/build';
import { collectAndBuild, collectInputs, emptyState, MAX_REFRESH_PER_RUN, PAGE_REFRESH_DAYS, readState } from '../../src/core/sources/collect';
import { Net } from '../../src/core/sources/net';
import { validateCatalog, validateIndex } from '../../src/core/sources/validate';
import type { CatalogEntry, SourceCatalog } from '../../src/core/sources/types';
import { fxText } from './sample';

const NOW = new Date('2026-10-13T06:00:00Z');
const SHOW = 'https://www.ardsounds.de/sendung/hoerspielklassiker-fuer-kinder/urn:ard:show:a98eaa600a311568/';
const EP = (id: string) => `https://www.ardsounds.de/episode/urn:ard:episode:${id}/`;
const SCHATZ = EP('02e2c3207e8a1ab4');
const NEW = EP('d83b72a53074b5e7');
const GRUSEL = EP('95ca25da08aad148');

function entry(over: Partial<Extract<CatalogEntry, { type: 'link' }>> = {}): Extract<CatalogEntry, { type: 'link' }> {
  return {
    id: 'ard-hoerspielklassiker',
    type: 'link',
    status: 'active',
    title: 'Hörspielklassiker für Kinder',
    publisher: 'ARD',
    pageUrl: SHOW,
    category: 'hoerspiel',
    ages: { min: 5, max: 12, source: 'publisher', text: 'Für Kinder ab 5 Jahren.' },
    language: 'de',
    rights: { kind: 'private-use', holder: 'ARD Sounds', termsUrl: 'https://www.ardsounds.de/nutzungsbedingungen/' },
    delivery: 'browser',
    editPolicy: 'unchanged',
    review: { by: 'Test', at: '2026-10-01', next: '2027-04-01' },
    items: [{ title: 'Die Schatzinsel (1/3)', pageUrl: SCHATZ, ages: { min: 7, max: 12 }, durationSec: 3180, until: '2031-04-30' }],
    series: { reader: 'ardsounds', urls: [SHOW] },
    single: true,
    ...over,
  };
}

const catalog = (e = entry()): SourceCatalog => ({ format: 1, updatedAt: '2026-10-13', entries: [e], blocked: [], notUsed: [] });

/** A net that answers from the page fixtures; other episodes are plain pages without facts, `gone` ones answer 404. */
function pagesNet(opts: { gone?: string[]; failShow?: boolean } = {}) {
  const asked: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === SHOW) return opts.failShow ? new Response('', { status: 503 }) : new Response(fxText('pages/ard-show.html'));
    if (opts.gone?.includes(url)) return new Response('weg', { status: 404 });
    if (url === SCHATZ) return new Response(fxText('pages/ard-episode.html'));
    if (url === NEW) return new Response(fxText('pages/ard-episode-new.html'));
    if (url === GRUSEL) return new Response(fxText('pages/ard-episode-new.html').replace('in großer Gefahr (1/2)', 'in der Gruselburg (2/2)').replace('d83b72a53074b5e7', '95ca25da08aad148'));
    return new Response('<html lang="de"><head><meta property="og:title" content="Irgendeine Folge"></head></html>');
  }) as typeof fetch;
  let clock = NOW.getTime();
  const net = new Net({ fetch: fetchFn, userAgent: 'test', sleep: async (ms) => void (clock += ms), now: () => clock });
  return { net, asked };
}

async function run(e = entry(), opts: Parameters<typeof pagesNet>[0] = {}, state = emptyState()) {
  const { net, asked } = pagesNet(opts);
  const result = await collectAndBuild(catalog(e), { net, include: ['active'], state, released: [], now: NOW, origins: [] });
  return { ...result, asked, state };
}

describe('a series that keeps itself up to date', () => {
  it('the catalogue accepts series, single and the new fields', () => {
    const checked = validateCatalog({ ...catalog(), entries: [{ ...entry(), items: [{ ...entry().items[0], about: 'Ein Satz über die Folge, aus der Seite.', creators: [{ name: 'Otto Kurth', role: 'performer' }] }] }] }, NOW);
    expect(checked.errors).toEqual([]);
    const bad = validateCatalog({ ...catalog(), entries: [{ ...entry(), series: { reader: 'ardsounds', urls: ['https://evil.example/sendung/x'] } }] }, NOW);
    expect(bad.errors.join()).toMatch(/keine https-Seite auf www\.ardsounds\.de/);
    // A series that brings its titles itself may start without any; one that only refreshes may not.
    expect(validateCatalog({ ...catalog(), entries: [{ ...entry(), items: [] }] }, NOW).errors).toEqual([]);
    expect(validateCatalog({ ...catalog(), entries: [{ ...entry(), items: [], series: { reader: 'ardsounds', urls: [SHOW], noNew: true } }] }, NOW).errors.join()).toMatch(/items fehlt/);
  });

  it('takes new episodes by the rules, with their own picture, age, length, end date and words', async () => {
    const { index, report } = await run();
    const e = index.entries[0];
    expect(e.single).toBe(true);
    const added = e.items.find((it) => it.pageUrl === NEW)!;
    expect(added).toMatchObject({
      key: linkKey('ard-hoerspielklassiker', NEW),
      title: 'Die Gespensterjäger in großer Gefahr (1/2)',
      ages: { min: 8, max: 12 },
      durationSec: 62 * 60,
      until: '2028-09-30',
      cover: 'https://api.ardmediathek.de/image-service/images/urn:ard:image:1111111111111111?w=448&ch=2222222222222222',
      delivery: 'browser',
      files: [],
    });
    expect(added.about).toMatch(/^Tom und Hedwig Kümmelsaft bekommen einen neuen Auftrag/);
    expect(report.added.map((a) => a.title)).toEqual(['Die Gespensterjäger in großer Gefahr (1/2)']);
    // Warning words ("Grusel") hold a title; pages that say too little (no age, no length) leave it out.
    const held = new Map(report.holds.map((h) => [h.key, h.reasons.join(' ')]));
    expect(held.get(linkKey('ard-hoerspielklassiker', GRUSEL))).toMatch(/Grusel/i);
    expect(held.get(linkKey('ard-hoerspielklassiker', EP('65d9cb1574d2e388')))).toMatch(/kein Alter/);
    expect(validateIndex(JSON.parse(JSON.stringify(index)))).not.toBeNull();
  });

  it('leaves out the episode counter of a series that counts its episodes, in known and new titles, and keeps the order', async () => {
    const { index } = await run(entry({ dropCounter: true, items: [{ ...entry().items[0], title: 'Die verschwundene Münze (1/26)' }] }));
    const titles = index.entries[0].items.map((it) => it.title);
    expect(titles.slice(0, 2)).toEqual(['Die verschwundene Münze', 'Die Gespensterjäger in großer Gefahr']);
    expect(titles.some((t) => /\(\d+\/\d+\)$/.test(t))).toBe(false);
    expect(validateCatalog({ ...catalog(), entries: [entry({ dropCounter: true })] }, NOW).errors).toEqual([]);
    // Without it, the counter stays (parts of one story need it).
    expect((await run()).index.entries[0].items[0].title).toBe('Die Schatzinsel (1/3)');
  });

  it('refreshes a known title from its page and keeps the catalogue’s own words', async () => {
    const { index } = await run();
    const known = index.entries[0].items.find((it) => it.pageUrl === SCHATZ)!;
    expect(known.title).toBe('Die Schatzinsel (1/3)');
    expect(known.ages).toEqual({ min: 7, max: 12 });
    expect(known.cover).toBe('https://api.ardmediathek.de/image-service/images/urn:ard:image:0d88e0606cb1fdbc?w=448&ch=069892e33ee1a2ba');
    // "toten Seemanns" would hold a new title, but this one a person chose: its description comes along.
    expect(known.about).toMatch(/^Robert Louis Stevenson schrieb den Abenteuerroman Die Schatzinsel/);
  });

  it('keeps what a title is about when its page is not read, and lets the page’s words replace the catalogue’s', async () => {
    const own = 'Hörspiel des NDR von 1962 nach dem Abenteuerroman von Robert Louis Stevenson, für Kinder ab 7 Jahren.';
    const withOwn = entry({ items: [{ ...entry().items[0], about: own }] });
    // The page read: its description wins over the catalogue's stand-in.
    const online = await run(withOwn);
    expect(online.index.entries[0].items[0].about).toMatch(/^Robert Louis Stevenson schrieb/);
    // Nothing read (offline): the catalogue's sentence, else what the list said yesterday.
    const offline = (e: ReturnType<typeof entry>, previous?: typeof online.index) =>
      buildIndex(catalog(e), { now: NOW, feeds: {}, archive: {}, gsb: {}, hosts: {}, released: [], include: ['active'], previous }).index.entries[0].items[0].about;
    expect(offline(withOwn)).toBe(own);
    expect(offline(entry(), online.index)).toMatch(/^Robert Louis Stevenson schrieb/);
    expect(offline(entry())).toBeUndefined();
  });

  it('drops a title whose page answers 404, for good, and keeps the rest when the show page fails', async () => {
    const first = await run(entry(), { gone: [SCHATZ] });
    expect(first.index.entries[0].items.some((it) => it.pageUrl === SCHATZ)).toBe(false);
    expect(first.state.gone).toContain(linkKey('ard-hoerspielklassiker', SCHATZ));
    // Next run: the page answers again, the title stays out.
    const second = await run(entry(), {}, readState(JSON.parse(JSON.stringify(first.state))));
    expect(second.index.entries[0].items.some((it) => it.pageUrl === SCHATZ)).toBe(false);
    // The show page does not load: the catalogue's titles stand, nothing new comes.
    const down = await run(entry(), { failShow: true });
    expect(down.index.entries[0].items.map((it) => it.pageUrl)).toEqual([SCHATZ]);
    expect(down.report.notes.some((n) => /Seiten der Reihe nicht gelesen/.test(n.note))).toBe(true);
  });

  it('reads a known page again only after a week, and few at a time', async () => {
    const state = emptyState();
    const first = await run(entry(), {}, state);
    expect(first.asked).toContain(SCHATZ);
    const again = await run(entry(), {}, readState(JSON.parse(JSON.stringify(first.state))));
    expect(again.asked).not.toContain(SCHATZ);
    // The facts from last time still count.
    expect(again.index.entries[0].items.find((it) => it.pageUrl === SCHATZ)!.about).toBeTruthy();
    const late = readState(JSON.parse(JSON.stringify(first.state)));
    for (const p of Object.values(late.pages!)) p.at = new Date(NOW.getTime() - (PAGE_REFRESH_DAYS + 1) * 86_400_000).toISOString();
    expect((await run(entry(), {}, late)).asked).toContain(SCHATZ);
    expect(MAX_REFRESH_PER_RUN).toBeGreaterThan(0);
  });

  it('takes nothing new with noNew, and nothing at all from an entry that is not read', async () => {
    const { index } = await run(entry({ series: { reader: 'ardsounds', urls: [SHOW], noNew: true } }));
    expect(index.entries[0].items.map((it) => it.pageUrl)).toEqual([SCHATZ]);
    const { net, asked } = pagesNet();
    await collectInputs(catalog(entry({ series: undefined })), { net, include: ['active'], state: emptyState(), now: NOW });
    expect(asked).toEqual([]);
  });

  it('gives a new OHRKA title the age its topic page states for all titles', async () => {
    const TOPIC = 'https://www.ohrka.de/hoeren/tierisch-spannend';
    const ALICE = `${TOPIC}/alice-im-wunderland`;
    const SCHATZINSEL = `${TOPIC}/die-schatzinsel`;
    const ohrka = entry({
      id: 'ohrka',
      title: 'OHRKA',
      publisher: 'OHRKA e.V.',
      pageUrl: 'https://www.ohrka.de/',
      category: 'hoerbuch',
      ages: { min: 3, max: 12, source: 'publisher', text: 'ab 3 Jahre' },
      editPolicy: 'normal',
      items: [{ title: 'Alice im Wunderland, gelesen von Katharina Thalbach', pageUrl: ALICE, ages: { min: 8, max: 12 } }],
      series: { reader: 'ohrka', urls: [TOPIC], pageAges: { [TOPIC]: { min: 8, max: 12, text: 'Für alle Kinder ab 8' } } },
    });
    expect(validateCatalog(catalog(ohrka), NOW).errors).toEqual([]);
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === TOPIC) return new Response(fxText('pages/ohrka-topic.html'));
      if (url === ALICE) return new Response(fxText('pages/ohrka-title.html'));
      if (url === SCHATZINSEL)
        return new Response(
          fxText('pages/ohrka-title.html')
            .replace(/Alice im Wunderland/g, 'Die Schatzinsel')
            .replace('Katharina Thalbach liest Die Schatzinsel ganz neu', 'Stefan Kaminski liest Die Schatzinsel von Robert Louis Stevenson')
            .replace('03:10:09', '05:42:14')
            .replace('Alice/Alice_im_Wunderland_komplett.mp3', 'Schatzinsel/Die_Schatzinsel.mp3'),
        );
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const net = new Net({ fetch: fetchFn, userAgent: 'test', sleep: async () => undefined, now: () => NOW.getTime() });
    const { index } = await collectAndBuild(catalog(ohrka), { net, include: ['active'], state: emptyState(), released: [], now: NOW, origins: [] });
    const [alice, schatz] = index.entries[0].items;
    expect(alice).toMatchObject({ fileName: 'Alice_im_Wunderland_komplett.mp3', cover: 'https://www.ohrka.de/fileadmin/bilder/pl_wunderland.png', creators: [{ name: 'Katharina Thalbach', role: 'reader' }] });
    expect(alice.about).toMatch(/^Katharina Thalbach liest Alice im Wunderland ganz neu/);
    expect(schatz).toMatchObject({ title: 'Die Schatzinsel', ages: { min: 8, max: 12 }, durationSec: 5 * 3600 + 42 * 60 + 14, fileName: 'Die_Schatzinsel.mp3', creators: [{ name: 'Stefan Kaminski', role: 'reader' }] });
  });

  it('leaves out an entry the source said is gone', () => {
    const { index } = buildIndex(catalog(), { now: NOW, feeds: {}, archive: {}, gsb: {}, hosts: {}, released: [], include: ['active'], gone: new Set(['ard-hoerspielklassiker']) });
    expect(index.entries).toEqual([]);
  });
});
