import { describe, expect, it } from 'vitest';
import { BUY_HELP_ID, COMMERCIAL_SERIES, commercialHint, commercialSeriesIn, missingSeries } from '../../src/core/sources/commercial';
import { resolveHelp } from '../../src/features/help/topics';
import { itemSeconds, qualityTier, recommendations, search, WELL_DESCRIBED_SHARE } from '../../src/core/sources/filter';
import type { IndexEntry, IndexItem, SourceIndex } from '../../src/core/sources/types';
import { buildSample, realCatalog } from './sample';

const { sample } = buildSample();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const WHY = 'Ein Klassiker zum Vorlesen, ruhig gelesen.';

/** The sample with Radio Klops as pick 2 and one story as pick 1. */
function withPicks(): SourceIndex {
  const idx = clone(sample);
  idx.entries.find((e) => e.id === 'radio-klops')!.featured = { rank: 2, why: WHY };
  const gsb = idx.entries.find((e) => e.id === 'global-storybooks-de')!;
  gsb.items.find((i) => i.key === 'global-storybooks-de/0001')!.featured = { rank: 1, why: 'Kurz und lustig.' };
  return idx;
}

describe('ranking in the list and in search', () => {
  it('puts picks first by rank, then well described sources, then the rest', () => {
    const hits = search(withPicks(), {});
    expect(hits.slice(0, 2).map((h) => h.entry.id)).toEqual(['global-storybooks-de', 'radio-klops']);
    expect(hits[0].pick).toEqual({ rank: 1, why: 'Kurz und lustig.' });
    const rest = hits.slice(2);
    const firstRest = rest.findIndex((h) => h.tier === 1);
    expect(firstRest === -1 || rest.slice(firstRest).every((h) => h.tier === 1)).toBe(true);
  });

  it('keeps episode order inside a source', () => {
    const hits = search(withPicks(), {});
    const rk = hits.find((h) => h.entry.id === 'radio-klops')!;
    expect(rk.items.map((i) => i.key)).toEqual(sample.entries.find((e) => e.id === 'radio-klops')!.items.map((i) => i.key));
  });

  it('a pick also comes first in a search, when it matches', () => {
    const hits = search(withPicks(), { text: 'folge' });
    expect(hits[0].pick?.rank).toBe(2);
    expect(hits[0].entry.id).toBe('radio-klops');
  });

  it('a title pick that is filtered out does not lift its source', () => {
    const hits = search(withPicks(), { text: 'schulkleidung' });
    expect(hits[0].entry.id).toBe('global-storybooks-de');
    expect(hits[0].pick).toBeUndefined();
  });

  it('quality tier: our description plus titles with text and known length', () => {
    const item = (over: Partial<IndexItem> = {}): IndexItem => ({ key: 'a/1', title: 'Folge', category: 'hoerspiel', files: [], durationSec: 600, ...over });
    expect(WELL_DESCRIBED_SHARE).toBe(0.8);
    expect(qualityTier({ blurb: 'Gute Sendung.' }, [item(), item(), item(), item(), item({ sparse: true })])).toBe(0);
    expect(qualityTier({ blurb: 'Gute Sendung.' }, [item(), item(), item(), item({ durationSec: undefined }), item({ sparse: true })])).toBe(1);
    expect(qualityTier({}, [item()])).toBe(1);
    expect(itemSeconds(item({ durationSec: undefined, files: [{ url: 'https://x.test/a', name: 'a', durationSec: 60 }, { url: 'https://x.test/b', name: 'b', durationSec: 30 }] }))).toBe(90);
    expect(itemSeconds(item({ durationSec: undefined, files: [{ url: 'https://x.test/a', name: 'a', durationSec: 60 }, { url: 'https://x.test/b', name: 'b' }] }))).toBeUndefined();
  });
});

describe('recommendations', () => {
  it('lists the picks by rank: a single title and a whole source', () => {
    const r = recommendations(withPicks());
    expect(r.map((x) => [x.entry.id, x.item?.key, x.pick.rank])).toEqual([
      ['global-storybooks-de', 'global-storybooks-de/0001', 1],
      ['radio-klops', undefined, 2],
    ]);
    expect(r[1].items).toHaveLength(7);
  });

  it('respects the choices for kind and age', () => {
    const idx = withPicks();
    expect(recommendations(idx, { category: 'lied' })).toEqual([]);
    expect(recommendations(idx, { category: 'hoerspiel' }).map((x) => x.entry.id)).toEqual(['radio-klops']);
    // Radio Klops is for 4 to 8; the story for 3 to 7.
    expect(recommendations(idx, { band: 'ab12' })).toEqual([]);
    expect(recommendations(idx, { band: 'bis5' })).toHaveLength(2);
  });

  it('never shows blocked picks', () => {
    const idx = { ...withPicks(), blocked: ['radio-klops', 'global-storybooks-de/0001'] };
    expect(recommendations(idx)).toEqual([]);
  });

  it('is empty for the shipped list without picks', () => {
    expect(recommendations(sample)).toEqual([]);
    const empty: SourceIndex = { format: 1, generatedAt: '2026-10-05T04:00:00.000Z', staleAfter: '2026-10-19T04:00:00.000Z', entries: [], blocked: [] };
    expect(recommendations(empty)).toEqual([]);
  });

  it('an entry pick wins over picks of its titles', () => {
    const idx = withPicks();
    const gsb = idx.entries.find((e) => e.id === 'global-storybooks-de') as IndexEntry;
    gsb.featured = { rank: 5, why: WHY };
    expect(recommendations(idx).map((x) => [x.entry.id, x.item?.key])).toEqual([
      ['radio-klops', undefined],
      ['global-storybooks-de', undefined],
    ]);
  });
});

describe('commercial series', () => {
  it('keeps the list small and named the way families write it', () => {
    const names = COMMERCIAL_SERIES.map((s) => s.name);
    for (const n of ['Die drei ???', 'Die drei !!!', 'TKKG', 'Bibi Blocksberg', 'Benjamin Blümchen', 'Bibi & Tina', 'Fünf Freunde', 'Conni', 'Paw Patrol', 'Yakari', 'Sternenschweif', 'Was ist was', 'Tonies']) {
      expect(names).toContain(n);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(COMMERCIAL_SERIES.length).toBeLessThanOrEqual(30);
    // Every spelling is folded already: lower case, no umlauts.
    for (const s of COMMERCIAL_SERIES) for (const m of [...s.match, ...(s.alone ?? [])]) expect(m).toBe(m.toLowerCase().replace(/[äöüß]/g, '?'));
  });

  it('never names a series that has a source in the catalogue, released or still in review', () => {
    // A free source in the pipeline (the BR's Pumuckl podcast, say) must never be called "not free".
    const entries = realCatalog().entries.filter((e) => e.status !== 'off');
    expect(entries.some((e) => e.id === 'br-pumuckl')).toBe(true);
    for (const e of entries) expect(commercialSeriesIn(`${e.title} ${e.blurb ?? ''}`)?.name, e.id).toBeUndefined();
    expect(commercialSeriesIn('pumuckl')).toBeUndefined();
    expect(commercialSeriesIn('Meister Eder und sein Pumuckl')).toBeUndefined();
  });

  it('recognises the names in a search, also with umlauts, without them and with question marks', () => {
    const name = (q: string) => commercialSeriesIn(q)?.name;
    expect(name('Die drei ???')).toBe('Die drei ???');
    expect(name('drei ? ? ?')).toBe('Die drei ???');
    expect(name('Drei Fragezeichen Folge 1')).toBe('Die drei ???');
    expect(name('die drei !!!')).toBe('Die drei !!!');
    expect(name('tkkg')).toBe('TKKG');
    expect(name('Benjamin Blümchen')).toBe('Benjamin Blümchen');
    expect(name('benjamin bluemchen')).toBe('Benjamin Blümchen');
    expect(name('Fünf Freunde')).toBe('Fünf Freunde');
    expect(name('Toniebox')).toBe('Tonies');
    expect(name('Peppa')).toBe('Peppa Wutz');
    expect(name('Kokosnuss')).toBe('Der kleine Drache Kokosnuss');
    expect(name('Bibi und Tina')).toBe('Bibi & Tina');
    expect(name('Die drei kleinen Schweinchen')).toBeUndefined();
    expect(name('Benjamin Franklin')).toBeUndefined();
    expect(name('Sam')).toBeUndefined();
    expect(name('Connie')).toBeUndefined();
    expect(name('was')).toBeUndefined();
    expect(name('')).toBeUndefined();
  });

  it('short forms count only as the whole search, and the longer name wins', () => {
    const name = (q: string) => commercialSeriesIn(q)?.name;
    expect(name('Bibi')).toBe('Bibi Blocksberg');
    expect(name('benjamin')).toBe('Benjamin Blümchen');
    expect(name('Die drei')).toBe('Die drei ???');
    expect(name('die drei !!!')).toBe('Die drei !!!');
    expect(name('Die drei Federn')).toBeUndefined();
    expect(name('Bibi Folge 3')).toBeUndefined();
  });

  it('a Kreativ-Tonie gets its own text: own recordings, not paid plays', () => {
    const k = commercialSeriesIn('Kreativ-Tonie')!;
    expect(k.kind).toBe('kreativ');
    expect(commercialSeriesIn('kreativtonie')).toBe(k);
    const h = commercialHint(k);
    expect(h.text).toContain('Aufnahmen');
    expect(h.text).not.toMatch(/kostenlos|kaufen/);
  });

  it('says honestly that they may not be downloaded freely, how to buy them without copy protection, without shops', () => {
    const h = commercialHint(commercialSeriesIn('TKKG')!);
    expect(h.title).toBe('„TKKG“ gibt es hier nicht');
    expect(h.text).toContain('kostenlos und legal herunterladen');
    expect(h.text).toContain('ohne Kopierschutz');
    expect(h.text).toContain('„Hinzufügen“');
    expect(h.help).toBe(BUY_HELP_ID);
    const t = commercialHint(commercialSeriesIn('tonies')!);
    expect(t.title).toBe('Inhalte von Tonies gibt es hier nicht');
    expect(t.help).toBe(BUY_HELP_ID);
    for (const x of [h, t]) expect(`${x.title} ${x.text}`).not.toMatch(/https?:|amazon|thalia|shop|gibt es nicht kostenlos/i);
  });

  it('the help section it links to exists', () => {
    const target = resolveHelp(BUY_HELP_ID);
    expect(target.kind === 'topic' && target.section?.id).toBe(BUY_HELP_ID);
  });

  it('shows the hint only when the list does not have the series, also when other titles share its words', () => {
    // "Die drei ???" searches for "die drei": unrelated stories may match, the hint still shows.
    expect(missingSeries(sample, 'Die drei ???')?.name).toBe('Die drei ???');
    expect(missingSeries(sample, 'Peterchens Mondfahrt')).toBeUndefined();
    // A free Yakari podcast in the list: no hint.
    const idx = clone(sample);
    idx.entries[0].title = 'Yakari – Hörspiele zum Hören';
    expect(missingSeries(idx, 'yakari')).toBeUndefined();
    expect(missingSeries(sample, 'yakari')?.name).toBe('Yakari');
    // A title of that name counts too, unless it is blocked.
    const one = clone(sample);
    one.entries[1].items[0].title = 'TKKG und das Rätsel';
    expect(missingSeries(one, 'tkkg')).toBeUndefined();
    expect(missingSeries({ ...one, blocked: [one.entries[1].items[0].key] }, 'tkkg')?.name).toBe('TKKG');
  });
});
