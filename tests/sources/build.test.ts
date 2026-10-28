import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildIndex, itemAges, overdueDays, publishGates, type BuildInputs } from '../../src/core/sources/build';
import { copyrightFrame, creditLine, rightsBadge } from '../../src/core/sources/licence';
import type { CatalogEntry, SourceCatalog, SourceIndex } from '../../src/core/sources/types';
import { ARD_EMBED } from '../../src/core/sources/providers';
import { validateIndex } from '../../src/core/sources/validate';
import { ARD_LINKS, buildSample, fxPath, fxText, NOW, PREVIOUS, radioKlopsReleased, realCatalog, sampleCatalog, sampleInputs } from './sample';

const { index, report, sample } = buildSample();
const byId = (id: string, idx: SourceIndex = index) => idx.entries.find((e) => e.id === id);

describe('buildIndex on the fixtures', () => {
  it('Kakadu: titles without prefix, mm:ss durations, URL with ?refId kept, offered as a link until Deutschlandradio agrees', () => {
    const k = byId('kakadu-kinderhoerspiel')!;
    expect(k.items).toHaveLength(3);
    expect(k.items[0].title).toBe('Das Mammut in der Grube');
    expect(k.items[0].originalTitle).toBe('Kinderhörspiel - Das Mammut in der Grube');
    expect(k.items[2].title).toBe('Ein Fellknäuel namens Heimweh');
    expect(k.items.map((i) => i.durationSec)).toEqual([3179, 3222, 1344]);
    expect(k.items[0].files[0].url.endsWith('?refId=kinderhoerspiel-118')).toBe(true);
    expect(k.items[0].files[0].name).toBe('kinderhoerspiel_mammut_in_der_grube_drk_20261004_0805_1bd0ec95.mp3');
    expect(k.delivery).toBe('browser');
    // The catalogue offers it as a link (0.3): no file check decides that.
    expect(report.downgraded.some((d) => d.entry === 'kakadu-kinderhoerspiel')).toBe(false);
    expect(k.about).toMatch(/^Im Kinderhörspiel von Deutschlandfunk Kultur werden Geschichten lebendig/);
  });

  it('SRF: seconds, "(Ab 8 Jahren)" inside an 8 to 12 show changes nothing, unchanged, Swiss German, browser', () => {
    const srf = byId('srf-kids-hoerspiele')!;
    expect(srf.items).toHaveLength(3);
    expect(srf.items.map((i) => i.durationSec)).toEqual([2653, 4151, 4232]);
    expect(srf.items.every((i) => i.ages === undefined)).toBe(true);
    expect(srf.editPolicy).toBe('unchanged');
    expect(srf.language).toBe('gsw');
    expect(srf.delivery).toBe('browser');
  });

  it('Radio Klops: 7 released episodes, newest first, direct', () => {
    const rk = byId('radio-klops')!;
    expect(rk.items).toHaveLength(7);
    expect(rk.items[0].title).toBe('Folge 7: Der Sonnencreme-Roboter');
    const dates = rk.items.map((i) => i.published!);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(rk.delivery).toBe('direct');
  });

  it('rejects enclosures behind measurement redirects', () => {
    expect(byId('test-tracking')).toBeUndefined();
    expect(report.rejected.some((r) => r.key.startsWith('test-tracking/') && r.reason.includes('www.podtrac.com'))).toBe(true);
  });

  it('keeps yesterday’s episodes with yesterday’s date when a feed breaks', () => {
    const broken = report.failures.find((f) => f.entry === 'test-broken');
    expect(broken?.keptPrevious).toBe(true);
    expect(broken?.error).toMatch(/^Feed nicht lesbar/);
    const e = byId('test-broken')!;
    expect(e.items[0].title).toBe('Folge von gestern');
    expect(e.checkedAt).toBe('2026-10-04T04:00:00.000Z');
  });

  it('Jamendo mirror: 4 songs, licence checked against the item, names URL-encoded', () => {
    const jam = byId('jamendo-139374-eckhardt')!;
    expect(jam.items[0].files).toHaveLength(4);
    expect(jam.items[0].files[0].url).toBe('https://archive.org/download/jamendo-139374/01-1160540-Stefan%20Eckhardt-Hansel%20und%20Gretel.mp3');
    expect(jam.items[0].rights).toEqual({ kind: 'cc', id: 'by-sa', version: '2.0', port: 'de', url: 'http://creativecommons.org/licenses/by-sa/2.0/de/' });
    expect(jam.items[0].durationSec).toBe(779);
    expect(jam.items[0].size).toBe(18258754);
    expect(jam.categories).toEqual(['lied']);
  });

  it('archive album: a changed licence stops the entry', () => {
    const archive = { ...sampleInputs().archive };
    const meta = archive['jamendo-139374'] as { metadata: Record<string, string> };
    archive['jamendo-139374'] = { ...meta, metadata: { ...meta.metadata, licenseurl: 'https://creativecommons.org/licenses/by-nc-nd/4.0/' } };
    const r = buildIndex(sampleCatalog(), sampleInputs({ archive, previous: undefined }));
    expect(r.report.failures.find((f) => f.entry === 'jamendo-139374-eckhardt')?.error).toMatch(/^Lizenz geändert/);
    expect(byId('jamendo-139374-eckhardt', r.index)).toBeUndefined();
  });

  it('Global Storybooks: 37 of 40, licence per story, 3 held, GitLab API file URLs, year and Xing duration', () => {
    const gsb = byId('global-storybooks-de')!;
    expect(gsb.items).toHaveLength(37);
    expect(gsb.items[0].title).toBe('Ein sehr großer Mann');
    // Pinned to the commit a person checked, not to a branch that can change under the list.
    expect(gsb.items[0].files[0].url).toBe('https://gitlab.com/api/v4/projects/6909116/repository/files/de%2F0001%2Fde-0001_tall.mp3/raw?ref=a2f9f1d20b3225d8bfa654e5b37fb68cc6b19656');
    expect(gsb.items[1].rights).toEqual({ kind: 'cc', id: 'by-nc', version: '3.0', url: 'https://creativecommons.org/licenses/by-nc/3.0/' });
    expect(gsb.items[0].published).toBe('2017');
    expect(gsb.items[0].durationSec).toBe(49);
    expect(gsb.items[1].durationSec).toBe(28);
    expect(gsb.items[2].durationSec).toBeUndefined();
    const held = report.holds.filter((h) => h.entry === 'global-storybooks-de').map((h) => h.key);
    expect(held.sort()).toEqual(['global-storybooks-de/0262', 'global-storybooks-de/0337', 'global-storybooks-de/0342']);
    expect(gsb.delivery).toBe('direct');
  });

  it('OHRKA: link entry, browser only, a file to save only where its page names one, file name kept for dragging in', () => {
    const oh = byId('ohrka')!;
    expect(oh.delivery).toBe('browser');
    // OHRKA allows saving for private use (providers.ts); the address is the one its page links.
    expect(oh.items[0].files).toEqual([{ url: 'https://www.ohrka.de/fileadmin/audio/Alice/Alice_im_Wunderland_komplett.mp3', name: 'Alice_im_Wunderland_komplett.mp3' }]);
    expect(oh.items.filter((it) => it.files.length).map((it) => it.fileName)).toEqual(['Alice_im_Wunderland_komplett.mp3', 'Der_Zauberer_von_Oz-cut.mp3']);
    expect(oh.items.every((it) => it.files.every((f) => f.url.startsWith('https://www.ohrka.de/fileadmin/')))).toBe(true);
    expect(oh.items[0].key).toBe('ohrka/hoeren/tierisch-spannend/alice-im-wunderland');
    expect(oh.items[0].fileName).toBe('Alice_im_Wunderland_komplett.mp3');
    expect(oh.items.every((it) => it.ages && it.durationSec && it.fileName)).toBe(true);
  });

  it('never publishes uploader e-mails or editor-only fields', () => {
    const all = JSON.stringify(index);
    expect(all).not.toContain('@example.invalid');
    expect(all).not.toContain('uploader');
    for (const k of ['internal', 'openChecks', 'review', 'holdNew', 'feedUrl', 'mediaHosts']) expect(all).not.toContain(`"${k}"`);
  });

  it('includes only the statuses asked for', () => {
    const prod = buildIndex(realCatalog(), sampleInputs({ include: ['active'], previous: undefined }));
    // Active: the entries the owner released and the 0.2, 0.3 and 0.4 additions. The fixtures have answers only for
    // Kakadu; OHRKA and the ARD links need none (links written in the catalogue); the knowledge shows of 0.3 get
    // their titles only from their show pages.
    expect(prod.index.entries.map((e) => e.id).sort()).toEqual(['kakadu-kinderhoerspiel', 'ohrka', ...ARD_LINKS].sort());
    // Skipped: every entry that is not active, Krümelgeschichten (27.10.2026, 'check') among them.
    expect(prod.report.skipped).toHaveLength(17);
    expect(prod.report.failures).toEqual([]);
    // br-geschichten-fuer-kinder waits for the broadcaster: 'off' in the catalogue, the editors' notes say why.
    expect(report.skipped.map((s) => s.status).sort()).toEqual(['off', 'off', 'off']);
  });

  it('marks the index stale after 14 days and applies the kill switch', () => {
    expect(index.staleAfter).toBe('2026-10-19T04:00:00.000Z');
    const catalog: SourceCatalog = { ...sampleCatalog(), blocked: ['radio-klops', 'global-storybooks-de/0001'] };
    const r = buildIndex(catalog, sampleInputs());
    expect(byId('radio-klops', r.index)).toBeUndefined();
    expect(byId('global-storybooks-de', r.index)!.items.some((i) => i.key === 'global-storybooks-de/0001')).toBe(false);
    expect(r.index.blocked).toEqual(['radio-klops', 'global-storybooks-de/0001']);
  });
});

describe('holds and releases', () => {
  it('holds every new Radio Klops episode until a person released it', () => {
    const r = buildIndex(sampleCatalog(), sampleInputs({ released: [] }));
    expect(byId('radio-klops', r.index)).toBeUndefined();
    const holds = r.report.holds.filter((h) => h.entry === 'radio-klops');
    expect(holds).toHaveLength(7);
    expect(holds[0].reasons).toContain('Neue Folge: wird vor der Aufnahme angehört');
  });

  it('episodes already in the published list stay; only new ones wait', () => {
    const keys = radioKlopsReleased().map((r) => r.key);
    const previous: SourceIndex = {
      ...PREVIOUS,
      entries: [...PREVIOUS.entries, { ...byId('radio-klops')!, items: byId('radio-klops')!.items.filter((i) => keys.slice(2).includes(i.key)) }],
    };
    const r = buildIndex(sampleCatalog(), sampleInputs({ released: [], previous }));
    expect(byId('radio-klops', r.index)!.items).toHaveLength(5);
    expect(r.report.holds.filter((h) => h.entry === 'radio-klops').map((h) => h.key)).toEqual(keys.slice(0, 2));
  });

  it('a released story gets the ages the person set', () => {
    const r = buildIndex(sampleCatalog(), sampleInputs({ released: [...radioKlopsReleased(), { key: 'global-storybooks-de/0262', by: 'Redaktion', at: '2026-10-12', note: 'angehört, ab 6', ages: { min: 6, max: 9 } }] }));
    const story = byId('global-storybooks-de', r.index)!.items.find((i) => i.key === 'global-storybooks-de/0262')!;
    expect(story.ages).toEqual({ min: 6, max: 9 });
    expect(byId('global-storybooks-de', r.index)!.items).toHaveLength(38);
  });

  it('holds episodes with warning words or an age above the show, rejects 16 and up', () => {
    const feed = (title: string, description: string, guid: string) =>
      `<item><title>${title}</title><description>${description}</description><guid>${guid}</guid><pubDate>Sun, 04 Oct 2026 06:00:00 GMT</pubDate><enclosure url="https://audio.podigee-cdn.net/${guid}.mp3" length="1000" type="audio/mpeg"/></item>`;
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${[
      feed('Der Gruselturm', 'Eine Geschichte', 'a'),
      feed('Ganz normal', 'Für Kinder ab 10 Jahren', 'b'),
      feed('Für Große', 'Ab 16 Jahren', 'c'),
      feed('Ruhig', 'Eine ruhige Geschichte über Wolken', 'd'),
      feed('Teens', 'FSK 12', 'e'),
    ].join('')}</channel></rss>`;
    const entry: CatalogEntry = { ...(realCatalog().entries.find((e) => e.id === 'radio-klops') as CatalogEntry), holdNew: false };
    const catalog: SourceCatalog = { ...realCatalog(), entries: [entry] };
    const r = buildIndex(catalog, sampleInputs({ feeds: { 'radio-klops': xml }, previous: undefined, released: [] }));
    expect(r.index.entries[0].items.map((i) => i.key)).toEqual(['radio-klops/d']);
    expect(r.report.holds.find((h) => h.key === 'radio-klops/a')?.reasons).toEqual(['Grusel']);
    expect(r.report.holds.find((h) => h.key === 'radio-klops/b')?.reasons).toEqual(['Altersangabe der Folge (ab 10) passt nicht zur Reihe']);
    expect(r.report.holds.find((h) => h.key === 'radio-klops/e')?.reasons).toEqual(['Altersangabe der Folge (ab 12) passt nicht zur Reihe']);
    expect(r.report.rejected).toContainEqual({ entry: 'radio-klops', key: 'radio-klops/c', reason: 'Altersangabe ab 16' });
  });

  it('narrows episode ages by the show and keeps them only when they differ', () => {
    expect(itemAges({ min: 8, max: 12 }, { min: 8 })).toBeUndefined();
    expect(itemAges({ min: 7, max: 12 }, { min: 10 })).toEqual({ min: 10, max: 12 });
    expect(itemAges({ min: 7, max: 12 }, { min: 4, max: 8 })).toEqual({ min: 7, max: 8 });
    expect(itemAges({ min: 7, max: 12 }, { min: 14 })).toEqual({ min: 14 });
    expect(itemAges({ min: 7, max: 12 }, undefined)).toBeUndefined();
  });
});

describe('what the publisher wrote about an episode', () => {
  type Ep = { title: string; guid: string; extra?: string; link?: string };
  const feed = (eps: Ep[], channel = '') =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title><link>https://radioklops.podigee.io/</link>${channel}${eps
      .map(
        (e, i) =>
          `<item><title>${e.title}</title><guid>${e.guid}</guid>${e.link ? `<link>${e.link}</link>` : ''}<pubDate>${new Date(Date.UTC(2026, 9, 4 - i)).toUTCString()}</pubDate><enclosure url="https://audio.podigee-cdn.net/${e.guid}.mp3" length="1000" type="audio/mpeg"/>${e.extra ?? ''}</item>`,
      )
      .join('')}</channel></rss>`;
  const klops = (patch: Partial<CatalogEntry> = {}): SourceCatalog => {
    const c = realCatalog();
    const entry = { ...(c.entries.find((e) => e.id === 'radio-klops') as CatalogEntry), holdNew: false, ...patch } as CatalogEntry;
    return { ...c, entries: [entry] };
  };
  const run = (xml: string, catalog = klops(), released: BuildInputs['released'] = []) =>
    buildIndex(catalog, sampleInputs({ feeds: { 'radio-klops': xml }, previous: undefined, released }));
  const reasonsOf = (r: ReturnType<typeof run>, guid: string) => r.report.holds.find((h) => h.key === `radio-klops/${guid}`)?.reasons;
  const rejectedFor = (r: ReturnType<typeof run>, guid: string) => r.report.rejected.find((x) => x.key === `radio-klops/${guid}`)?.reason;

  it('never lists an episode or a feed the publisher marks explicit, released or not', () => {
    const r = run(
      feed([
        { title: 'Ein ganz normaler Tag', guid: 'g1', extra: '<itunes:explicit>true</itunes:explicit><description>Eine Geschichte.</description>' },
        { title: 'Ruhig', guid: 'g2', extra: '<itunes:explicit>no</itunes:explicit>' },
      ]),
      klops(),
      [{ key: 'radio-klops/g1', by: 'Redaktion', at: '2026-10-05' }],
    );
    expect(rejectedFor(r, 'g1')).toBe('Der Anbieter markiert die Folge als „explicit“');
    expect(r.index.entries[0].items.map((i) => i.key)).toEqual(['radio-klops/g2']);
    const all = run(feed([{ title: 'Ruhig', guid: 'g2' }], '<itunes:explicit>yes</itunes:explicit>'));
    expect(all.index.entries).toHaveLength(0);
    expect(rejectedFor(all, 'g2')).toBe('Der Anbieter markiert den ganzen Feed als „explicit“');
  });

  it('reads title, description, itunes:summary and content:encoded as plain text, words inside compound words too', () => {
    const r = run(
      feed([
        { title: 'Der Mörder im Zug', guid: 'g2' },
        { title: 'Kinder im Zweiten Weltkrieg', guid: 'g3' },
        { title: 'Nachts im Moor', guid: 'g4', extra: '<description><![CDATA[<p>Eine G&auml;nsehaut-Geschichte, nicht f&uuml;r Kinder unter 6.</p>]]></description>' },
        { title: 'Der Sonnencreme-Test', guid: 'g6', extra: '<description>Ein Hörspiel.</description><content:encoded><![CDATA[<p>Werbung: Mit dem Rabattcode KIDS10 gibt es 10 % im Shop.</p>]]></content:encoded>' },
        { title: 'Drogenhandel am Hafen', guid: 'g9' },
        { title: 'Ronja und der Wolf', guid: 'g10', extra: '<description>&lt;p&gt;Ein H&amp;ouml;rspiel &amp;uuml;ber G&amp;auml;nsehaut&lt;/p&gt;</description>' },
        { title: 'Die Wiese', guid: 'g11', extra: '<itunes:summary>CN: Tod eines Haustiers</itunes:summary>' },
        { title: 'Wir kriegen das hin', guid: 'g12', extra: '<description>Ein gewaltiger Spaß mit Waffeln.</description>' },
      ]),
    );
    expect(reasonsOf(r, 'g2')).toEqual(['Gewalt oder Tod']);
    expect(reasonsOf(r, 'g3')).toEqual(['Gewalt oder Tod']);
    expect(reasonsOf(r, 'g4')).toEqual(['Grusel', 'Warnhinweis']);
    expect(reasonsOf(r, 'g6')).toEqual(['Werbung']);
    expect(reasonsOf(r, 'g9')).toEqual(['Drogen oder Alkohol']);
    expect(reasonsOf(r, 'g10')).toEqual(['Grusel']);
    expect(reasonsOf(r, 'g11')).toEqual(['Gewalt oder Tod', 'Warnhinweis']);
    expect(r.index.entries[0].items.map((i) => i.key)).toEqual(['radio-klops/g12']);
  });

  it('takes the highest of all age statements and rejects from 16, also when a person released the episode without ages', () => {
    const r = run(
      feed([
        { title: 'Wer hat Angst? (16+)', guid: 'g8', extra: '<description>Hörspiel für Erwachsene.</description>' },
        { title: 'Die lange Nacht', guid: 'g5', extra: '<description>Für Kinder ab 6 Jahren. Die Langfassung erst ab 16.</description>' },
        { title: 'Spätabends', guid: 'g13', extra: '<description>Nur für Erwachsene.</description>' },
        { title: 'Party Ü18', guid: 'g14' },
        { title: 'Die Insel', guid: 'g15', extra: '<description>Altersempfehlung: 14 Jahre</description>' },
        { title: 'Der Film', guid: 'g16', extra: '<description>FSK 16</description>' },
        { title: 'Ab Montag', guid: 'g17', extra: '<description>Neue Folgen ab 16. Oktober, für Kinder ab 4 Jahren.</description>' },
      ]),
      klops(),
      [{ key: 'radio-klops/g16', by: 'Redaktion', at: '2026-10-05' }],
    );
    expect(rejectedFor(r, 'g8')).toBe('Altersangabe ab 18');
    expect(rejectedFor(r, 'g5')).toBe('Altersangabe ab 16');
    expect(rejectedFor(r, 'g13')).toBe('Altersangabe ab 18');
    expect(rejectedFor(r, 'g14')).toBe('Altersangabe ab 18');
    expect(rejectedFor(r, 'g16')).toBe('Altersangabe ab 16');
    expect(reasonsOf(r, 'g15')).toEqual(['Altersangabe der Folge (ab 14) passt nicht zur Reihe']);
    expect(r.index.entries[0].items.map((i) => i.key)).toEqual(['radio-klops/g17']);
  });

  it('leaves a show’s standing sentences out of the scan', () => {
    const xml = feed([{ title: 'Ruhig', guid: 'g2', extra: '<description>Eine ruhige Geschichte. Bei uns gibt es keine Werbung und keine Sponsoren.</description>' }]);
    expect(reasonsOf(run(xml), 'g2')).toEqual(['Werbung']);
    const r = run(xml, klops({ ignorePhrases: ['Bei uns gibt es keine Werbung und keine Sponsoren.'] }));
    expect(r.index.entries[0].items.map((i) => i.key)).toEqual(['radio-klops/g2']);
  });

  it('cleans every way a series writes its prefix and asks for an override where no pattern helps', () => {
    const c = realCatalog();
    const kakadu = c.entries.find((e) => e.id === 'kakadu-kinderhoerspiel') as Extract<CatalogEntry, { type: 'podcast' }>;
    const ep = (title: string, guid: string) =>
      `<item><title>${title}</title><guid>${guid}</guid><pubDate>Sun, 04 Oct 2026 06:00:00 GMT</pubDate><enclosure url="https://podcast-mp3.dradio.de/${guid}.mp3" length="1000" type="audio/mpeg"/></item>`;
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Kakadu</title>${[
      ep('Kakadu - Ich bin ein echtes Sommerkind', 'k1'),
      ep('Kinderhörspiel Ursendung - Jetzt probier doch wenigstens mal', 'k2'),
      ep('Kinderhörspiel - Ursendung - Der Wald steht schwarz und schweiget', 'k3'),
      ep('Kinderhörspiel "Räuberessen" gewinnt MDR-Kinderhörspielpreis 2026 - Räuberessen', 'k4'),
      ep('Kinderhörspiel und Geschichten - Das Mammut', 'k5'),
    ].join('')}</channel></rss>`;
    const build = (entry: CatalogEntry) => buildIndex({ ...c, entries: [entry] }, sampleInputs({ feeds: { 'kakadu-kinderhoerspiel': xml }, previous: undefined, released: [] }));
    const r = build(kakadu);
    expect(r.index.entries[0].items.map((i) => i.title)).toEqual([
      'Ich bin ein echtes Sommerkind',
      'Jetzt probier doch wenigstens mal',
      'Der Wald steht schwarz und schweiget',
      'Kinderhörspiel "Räuberessen" gewinnt MDR-Kinderhörspielpreis 2026 - Räuberessen',
      'Das Mammut',
    ]);
    expect(r.report.notes).toContainEqual({
      entry: 'kakadu-kinderhoerspiel',
      key: 'kakadu-kinderhoerspiel/k4',
      note: 'Titel beginnt noch mit „Kinderhörspiel“: Kinderhörspiel "Räuberessen" gewinnt MDR-Kinderhörspielpreis 2026 - Räuberessen (titleOverrides setzen)',
    });
    const fixed = build({ ...kakadu, titleOverrides: { 'kakadu-kinderhoerspiel/k4': 'Räuberessen' } });
    expect(fixed.index.entries[0].items[3]).toMatchObject({ title: 'Räuberessen', originalTitle: 'Kinderhörspiel "Räuberessen" gewinnt MDR-Kinderhörspielpreis 2026 - Räuberessen' });
    expect(fixed.report.notes).toEqual([]);
  });

  it('links an episode only to the publisher’s own pages; without a link of its own, to the show page from the feed', () => {
    const r = run(
      feed([
        { title: 'Ausflug', guid: 'g7', link: 'https://example-casino.test/landing?ref=podcast' },
        { title: 'Ruhig', guid: 'g2', link: 'https://radioklops.podigee.io/2-ruhig' },
        { title: 'Wolken', guid: 'g3' },
      ]),
    );
    expect(r.index.entries[0].items.map((i) => i.pageUrl)).toEqual(['https://radioklops.podigee.io/', 'https://radioklops.podigee.io/2-ruhig', 'https://radioklops.podigee.io/']);
    expect(r.report.notes).toContainEqual({ entry: 'radio-klops', key: 'radio-klops/g7', note: 'Link der Folge nicht übernommen (Host nicht in linkHosts): https://example-casino.test/landing?ref=podcast' });
    const srf = byId('srf-kids-hoerspiele')!;
    expect(srf.items.every((i) => i.pageUrl === 'https://www.srf.ch/audio/srf-kids-hoerspiele-geschichten-fuer-kinder')).toBe(true);
  });

  it('lists nothing from a media host that redirects through a measurement service or a foreign host', () => {
    const r = buildIndex(klops(), sampleInputs({ previous: undefined, hosts: { ...sampleInputs().hosts, 'audio.podigee-cdn.net': 'blocked' } }));
    expect(r.index.entries).toHaveLength(0);
    expect(r.report.rejected.filter((x) => x.entry === 'radio-klops' && x.reason === 'audio.podigee-cdn.net leitet über einen nicht erlaubten Host weiter')).toHaveLength(7);
  });
});

describe('Global Storybooks folktales', () => {
  it('names where a traditional tale comes from instead of crediting "Ghanaian folktale" as its author', () => {
    const gsb = byId('global-storybooks-de')!;
    const anansi = gsb.items.find((i) => i.key === 'global-storybooks-de/0006')!;
    const honey = gsb.items.find((i) => i.key === 'global-storybooks-de/0072')!;
    expect(anansi.tradition).toBe('Volksmärchen aus Ghana');
    expect(anansi.creators).toEqual([
      { name: 'Anna Westpfahl', role: 'translator' },
      { name: 'Jula Eberth', role: 'reader' },
    ]);
    expect(honey.tradition).toBe('Volksmärchen der Zulu');
    expect(creditLine(gsb, anansi, [])).toBe(
      '„Anansi und die Weisheit“. Global Storybooks – Geschichten zum Vorlesen. Volksmärchen aus Ghana, Übersetzung Anna Westpfahl, gelesen von Jula Eberth. Quelle: Global Storybooks / African Storybook, https://gitlab.com/global-asp/gsn-audio. Lizenz: CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/).',
    );
    expect(gsb.items[0].tradition).toBeUndefined();
  });
});

describe('items saved on the publisher\'s page', () => {
  it('needs no note when the app can open the file or the item\'s own page', () => {
    expect(report.notes.filter((n) => n.note.includes('weder eine Datei noch'))).toEqual([]);
  });

  it('tells the editors about items that would only lead to the source\'s general page', () => {
    const c = sampleCatalog();
    const catalog: SourceCatalog = {
      ...c,
      entries: c.entries.map((e) =>
        e.type === 'link' ? ({ ...e, items: [...e.items, { title: 'Nur die Startseite', pageUrl: e.pageUrl, category: 'hoerbuch' }] } as CatalogEntry) : e,
      ),
    };
    const r = buildIndex(catalog, sampleInputs());
    expect(r.report.notes).toContainEqual({
      entry: 'ohrka',
      note: '1 von 12 Titeln hat weder eine Datei noch eine eigene Seite: „Auf der Webseite öffnen“ führt nur zur Seite der Quelle (Nur die Startseite).',
    });
  });
});

describe('ARD titles kept unchanged', () => {
  it('tells the editors about titles the app cannot suggest when their file is dragged in', () => {
    const c = sampleCatalog();
    const catalog: SourceCatalog = {
      ...c,
      entries: c.entries.map((e) =>
        e.type === 'link'
          ? ({ ...e, editPolicy: 'unchanged', items: [...e.items.map((it) => ({ ...it, durationSec: it.durationSec ?? 600 })), { title: 'Ohne alles', pageUrl: `${e.pageUrl}ohne-alles`, category: 'hoerbuch' }] } as CatalogEntry)
          : e,
      ),
    };
    const r = buildIndex(catalog, sampleInputs());
    const notes = r.report.notes.filter((n) => n.note.includes('ohne Dateiname, Größe und Länge'));
    // The ARD shows read their pages, which do not know the made-up title; Krümelgeschichten waits for a check, so nobody reads its page yet.
    expect(notes).toEqual([
      { entry: 'ohrka', note: expect.stringMatching(/^1 von 12 Titeln ohne Dateiname.*\(Ohne alles\)\.$/) },
      { entry: 'mdr-kruemelgeschichten', note: expect.stringMatching(/^1 von 1 Titeln ohne Dateiname.*\(Ohne alles\)\.$/) },
    ]);
    // A source that may be changed takes the file without asking which title it is.
    expect(report.notes.filter((n) => n.note.includes('ohne Dateiname, Größe und Länge'))).toEqual([]);
  });
});

describe('titles whose time at the publisher is over', () => {
  it('carries the day from the catalogue and leaves the title out from that day on, also when kept from yesterday', () => {
    const c = sampleCatalog();
    const dated = (catalog: SourceCatalog, days: string[]): SourceCatalog => ({
      ...catalog,
      entries: catalog.entries.map((e) => (e.type === 'link' ? ({ ...e, items: e.items.map((it, i) => (days[i] ? { ...it, until: days[i] } : it)) } as CatalogEntry) : e)),
    });
    const r = buildIndex(dated(c, ['2026-10-04', '2026-10-06']), sampleInputs());
    const ohrka = r.index.entries.find((e) => e.id === 'ohrka')!;
    const source = c.entries.find((e) => e.id === 'ohrka') as Extract<CatalogEntry, { type: 'link' }>;
    expect(ohrka.items).toHaveLength(source.items.length - 1);
    expect(ohrka.items[0]).toMatchObject({ title: source.items[1].title, until: '2026-10-06' });
    expect(r.report.rejected).toContainEqual({ entry: 'ohrka', key: expect.stringMatching(/^ohrka\//), reason: 'beim Anbieter nur bis 2026-10-04' });
    // A feed that breaks keeps yesterday's titles, but not those whose time is over.
    const previous = structuredClone(PREVIOUS);
    previous.entries.find((e) => e.id === 'test-broken')!.items[0].until = '2026-10-01';
    const kept = buildIndex(c, { ...sampleInputs(), previous });
    expect(kept.index.entries.find((e) => e.id === 'test-broken')).toBeUndefined();
  });
});

describe('archive.org albums after the review', () => {
  const withSha = (change?: (files: { name: string; sha1?: string }[]) => void) => {
    const archive = { ...sampleInputs().archive };
    const meta = JSON.parse(JSON.stringify(archive['jamendo-139374'])) as { files: { name: string; format?: string; sha1?: string }[] };
    meta.files.forEach((f, i) => (f.sha1 = i.toString(16).padStart(40, '0')));
    change?.(meta.files);
    archive['jamendo-139374'] = meta as never;
    return archive;
  };
  const reviewedCatalog = (): SourceCatalog => {
    const c = sampleCatalog();
    const meta = withSha()['jamendo-139374'] as { files: { name: string; format?: string; source?: string; sha1: string }[] };
    const files = meta.files.filter((f) => f.source === 'original' && /\.mp3$/i.test(f.name)).map((f) => ({ name: f.name, sha1: f.sha1 }));
    return { ...c, entries: c.entries.map((e) => (e.id === 'jamendo-139374-eckhardt' ? ({ ...e, files } as CatalogEntry) : e)) };
  };

  it('lists the album while its files are the ones a person listened to', () => {
    const r = buildIndex(reviewedCatalog(), sampleInputs({ archive: withSha(), previous: undefined }));
    expect(byId('jamendo-139374-eckhardt', r.index)!.items[0].files).toHaveLength(4);
  });

  it('holds the album when a file is replaced or added', () => {
    const replaced = buildIndex(reviewedCatalog(), sampleInputs({ archive: withSha((f) => (f[0].sha1 = 'f'.repeat(40))), previous: undefined }));
    expect(byId('jamendo-139374-eckhardt', replaced.index)).toBeUndefined();
    expect(replaced.report.holds.find((h) => h.entry === 'jamendo-139374-eckhardt')?.reasons[0]).toMatch(/^Dateien seit der Prüfung geändert: anderer Inhalt: 01-1160540-Stefan Eckhardt-Hansel und Gretel\.mp3/);
    const added = buildIndex(
      reviewedCatalog(),
      sampleInputs({
        archive: withSha((f) => f.push({ name: '99-neu.mp3', sha1: 'e'.repeat(40), format: 'VBR MP3', source: 'original' } as never)),
        previous: undefined,
      }),
    );
    expect(added.report.holds.find((h) => h.entry === 'jamendo-139374-eckhardt')?.reasons[0]).toContain('neu: 99-neu.mp3');
  });
});

describe('reviews', () => {
  const active = (next: string): SourceCatalog => {
    const c = realCatalog();
    const e = { ...(c.entries.find((x) => x.id === 'radio-klops') as CatalogEntry), status: 'active' as const, review: { by: 'Redaktion', at: '2026-04-01', next } };
    return { ...c, entries: [e] };
  };
  const inputs = (): BuildInputs => sampleInputs({ include: ['active'], previous: undefined });

  it('publishes when a person last checked the source, apart from the date of the list', () => {
    const r = buildIndex(active('2027-04-01'), inputs());
    expect(r.index.entries[0].reviewedAt).toBe('2026-04-01');
    expect(r.index.entries[0].checkedAt).toBe(NOW.toISOString());
  });

  it('warns while a review is overdue and drops the entry after 60 days', () => {
    expect(overdueDays({ review: { by: 'x', at: '2026-01-01', next: '2026-10-01' } }, NOW)).toBe(4);
    const warned = buildIndex(active('2026-09-01'), inputs());
    expect(warned.report.overdue).toEqual([{ entry: 'radio-klops', next: '2026-09-01', days: 34, dropped: false }]);
    expect(warned.index.entries).toHaveLength(1);
    const dropped = buildIndex(active('2026-07-01'), inputs());
    expect(dropped.report.overdue[0].dropped).toBe(true);
    expect(dropped.index.entries).toHaveLength(0);
  });
});

describe('credits from the built index', () => {
  it('writes the credit line, the copyright frame and the badges', () => {
    const gsb = byId('global-storybooks-de')!;
    expect(creditLine(gsb, gsb.items[0], ['loudness'])).toBe(
      '„Ein sehr großer Mann“. Global Storybooks – Geschichten zum Vorlesen. Text Cornelius Gulere, Übersetzung Lisa Birkner, gelesen von Jula Eberth. Quelle: Global Storybooks / African Storybook, https://gitlab.com/global-asp/gsn-audio. Lizenz: CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). Geändert: Lautstärke angeglichen.',
    );
    const k = byId('kakadu-kinderhoerspiel')!;
    expect(copyrightFrame(k, k.items[0], 2026)).toBe('2026 Deutschlandradio');
    expect(copyrightFrame(gsb, gsb.items[0], 2026)).toBe('2017 Global Storybooks / African Storybook. Licensed to the public under https://creativecommons.org/licenses/by/3.0/ verify at https://gitlab.com/global-asp/gsn-audio');
    expect(rightsBadge(byId('srf-kids-hoerspiele')!.rights)).toBe('Podcast · nur privat');
  });
});

describe('publishing gates', () => {
  const gates = (idx: SourceIndex, opts: { catalog?: SourceCatalog; previous?: SourceIndex } = {}) => {
    const serialized = JSON.stringify(idx);
    return publishGates(idx, { catalog: opts.catalog ?? sampleCatalog(), previous: opts.previous, serialized, parsed: validateIndex(JSON.parse(serialized)) });
  };

  it('pass for the sample', () => {
    expect(gates(index)).toEqual([]);
  });

  it('stop an empty list, a big drop, ages from 16, foreign hosts, measurement hosts and editor fields', () => {
    expect(gates({ ...index, entries: [] })).toContain('Liste ohne Einträge.');
    const half: SourceIndex = { ...index, entries: index.entries.filter((e) => e.id !== 'global-storybooks-de') };
    expect(gates(half, { previous: index }).some((e) => e.startsWith('Zu viele Titel verschwunden'))).toBe(true);
    expect(gates(half, { previous: index, catalog: { ...sampleCatalog(), allowShrink: true } })).toEqual([]);
    const tweak = (fn: (e: SourceIndex) => void) => {
      const copy = JSON.parse(JSON.stringify(index)) as SourceIndex;
      fn(copy);
      return gates(copy);
    };
    expect(tweak((c) => (c.entries.find((e) => e.id === 'radio-klops')!.items[0].ages = { min: 16 }))).toContain('radio-klops/placeholder-guid-7: Altersangabe ab 16.');
    expect(tweak((c) => (c.entries.find((e) => e.id === 'radio-klops')!.items[0].files[0].url = 'https://evil.example/x.mp3')).some((e) => e.includes('evil.example ist für diesen Eintrag nicht erlaubt'))).toBe(true);
    expect(tweak((c) => (c.entries.find((e) => e.id === 'radio-klops')!.items[0].files[0].url = 'https://www.podtrac.com/x.mp3')).some((e) => e.includes('Messdienst'))).toBe(true);
    expect(tweak((c) => Object.assign(c.entries[0], { internal: 'nur für uns' })).some((e) => e.includes('„internal“'))).toBe(true);
    expect(tweak((c) => (c.entries[0].items[0].title = 'Schreibe an jemand@example.org'))).toContain('Die Liste enthält eine E-Mail-Adresse.');
    expect(tweak((c) => (c.entries.find((e) => e.id === 'radio-klops')!.items[0].pageUrl = 'https://example-casino.test/landing'))).toContain(
      'radio-klops/placeholder-guid-7: Link auf example-casino.test ist für diesen Eintrag nicht erlaubt.',
    );
  });
});

describe('sample index file', () => {
  it('is what the builder makes from the fixtures', () => {
    const text = JSON.stringify(sample, null, 1) + '\n';
    const file = fxPath('index/index-v1.sample.json');
    if (process.env.UPDATE_SOURCES_SAMPLE) writeFileSync(file, text);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(sample.entries.map((e) => e.id)).toEqual([
      'kakadu-kinderhoerspiel',
      'srf-kids-hoerspiele',
      'radio-klops',
      'global-storybooks-de',
      'ohrka',
      'jamendo-139374-eckhardt',
    ]);
    expect(fxText('index/README.txt')).toContain('6 entries, 62 items');
  });
});

/** A picture of the ARD image service at a fixed width (no {width} placeholder). */
const ARD_IMAGE = /^https:\/\/api\.ardmediathek\.de\/image-service\/images\/urn:ard:image:[0-9a-f]{16}\?w=448&ch=[0-9a-f]{16}$/;
/** ARD Sounds names no day the episodes go away for these shows (no unavailable_after on their pages, 2026-10-15 and 2026-10-27). */
const NO_UNTIL = ['rbb-dr-brumm', 'rbb-mimi-sandmaedchen'];

describe('the list that ships with the app', () => {
  const text = readFileSync(new URL('../../sources/snapshot/index-v1.json', import.meta.url), 'utf8');
  const shipped = JSON.parse(text) as SourceIndex;

  it('passes the publishing gates against the catalogue in the repository', () => {
    expect(publishGates(shipped, { catalog: realCatalog(), serialized: text.trimEnd(), parsed: validateIndex(JSON.parse(text)) })).toEqual([]);
  });

  it('offers the ARD plays as links to their pages on ARD Sounds, each with ARD’s player and its own age, story by story', () => {
    const catalog = realCatalog();
    for (const id of ARD_LINKS) {
      const e = byId(id, shipped)!;
      const source = catalog.entries.find((x) => x.id === id)!;
      expect([e.type, e.delivery, e.editPolicy, e.rights.kind, e.single], id).toEqual(['link', 'browser', 'unchanged', 'private-use', true]);
      // The pictures ARD Sounds shows for the show and each episode, at the width it uses for its tiles.
      expect([e.cover, e.coverFrom], id).toEqual([source.cover, source.coverFrom]);
      expect(e.cover, id).toMatch(ARD_IMAGE);
      expect(e.featured, id).toEqual(source.featured);
      expect(e.items.length, id).toBe(source.type === 'link' ? source.items.length : -1);
      for (const it of e.items) {
        expect(it.files, it.key).toEqual([]);
        expect(it.key, it.key).toBe(`${id}/${it.pageUrl!.replace('https://www.ardsounds.de/', '')}`);
        expect(it.pageUrl, it.key).toMatch(/^https:\/\/www\.ardsounds\.de\/episode\/urn:ard:episode:[0-9a-f]{16}\/$/);
        // Played in ARD's own player (its terms offer it for embedding); saved on ARD's page.
        expect(it.embed, it.key).toMatch(ARD_EMBED);
        expect(it.ages ?? e.ages, it.key).toBeDefined();
        expect(it.durationSec, it.key).toBeGreaterThan(180);
        expect(it.cover ?? e.cover, it.key).toMatch(ARD_IMAGE);
        // ARD takes every episode down at some point: the day comes along, so the app hides it from then on.
        if (!NO_UNTIL.includes(id)) expect(Date.parse(it.until ?? ''), it.key).toBeGreaterThan(Date.parse(shipped.generatedAt));
      }
    }
    expect(shipped.entries.filter((e) => e.featured).map((e) => e.featured!.rank).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('offers OHRKA’s files to save where its pages name them, and no player', () => {
    const ohrka = byId('ohrka', shipped)!;
    expect(ohrka.items.filter((it) => it.files.length).map((it) => it.files[0].url)).toEqual([
      'https://www.ohrka.de/fileadmin/audio/Alice/Alice_im_Wunderland_komplett.mp3',
      'https://www.ohrka.de/fileadmin/audio/eBooks/Der_Zauberer_von_Oz-cut.mp3',
    ]);
    expect(ohrka.items.some((it) => it.embed)).toBe(false);
  });

  it('shows an original picture for every source', () => {
    expect(shipped.entries.filter((e) => !e.cover).map((e) => e.id)).toEqual([]);
  });
});
