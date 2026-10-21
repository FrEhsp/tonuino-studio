import { describe, expect, it } from 'vitest';
import { buildIndex, publishGates } from '../../src/core/sources/build';
import type { CatalogEntry, SourceCatalog } from '../../src/core/sources/types';
import { MAX_PICKS, MAX_WHY_CHARS, moreThanOneSentence, parseIndex, pickProblems, validateCatalog, validateIndex, validateReleased } from '../../src/core/sources/validate';
import { ADDED_04, buildSample, LINKS_02, NOW, realCatalog, sampleCatalog, sampleInputs } from './sample';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const WHY = 'Ein warmherziges Märchen, ruhig und deutlich gelesen.';

/**
 * The catalogue with Global Storybooks released (active), so it may carry a pick.
 * The picks of the ARD links of 0.2 and 0.4 (ranks 5, 6, 8 to 12) are taken off: the
 * owner's four stay (ranks 2, 3, 4 and 7), and the tests place picks of their own on the free ranks.
 */
function activeCatalog(): SourceCatalog & { entries: (CatalogEntry & Record<string, unknown>)[] } {
  const c = clone(realCatalog()) as SourceCatalog & { entries: (CatalogEntry & Record<string, unknown>)[] };
  for (const x of c.entries) if (LINKS_02.includes(x.id) || ADDED_04.includes(x.id)) delete x.featured;
  const e = c.entries.find((x) => x.id === 'global-storybooks-de')!;
  e.status = 'active';
  e.openChecks = [];
  e.review = { by: 'Redaktion', at: '2026-10-01', next: '2027-04-01' };
  return c;
}

const entry = (c: { entries: Record<string, unknown>[] }, id: string) => c.entries.find((x) => x.id === id)!;

describe('editors’ picks in the catalogue', () => {
  it('accepts a pick on an active entry', () => {
    const c = activeCatalog();
    // Ranks 2, 3, 4 and 7 are the owner's picks in the repository.
    entry(c, 'global-storybooks-de').featured = { rank: 11, why: WHY };
    expect(validateCatalog(c, NOW).errors).toEqual([]);
  });

  it('rejects picks on entries that are not active', () => {
    const c = activeCatalog();
    entry(c, 'jamendo-116839-bommel-abc').featured = { rank: 1, why: WHY };
    expect(validateCatalog(c, NOW).errors).toContain('jamendo-116839-bommel-abc: Empfehlungen (featured) nur für aktive Einträge');
  });

  it('rejects a missing, overlong or multi-sentence why and a bad rank', () => {
    expect(pickProblems({ rank: 1 })).toEqual(['featured.why fehlt (ein kurzer Satz, warum es sich lohnt)']);
    expect(pickProblems({ rank: 1, why: '   ' })).toHaveLength(1);
    expect(pickProblems({ rank: 1, why: 'x'.repeat(MAX_WHY_CHARS) })).toEqual([]);
    expect(pickProblems({ rank: 1, why: 'x'.repeat(MAX_WHY_CHARS + 1) })[0]).toMatch(/zu lang/);
    expect(pickProblems({ rank: 1, why: 'Schön gelesen. Und spannend.' })).toEqual(['featured.why ist mehr als ein Satz']);
    expect(pickProblems({ rank: 1, why: 'Wer kennt ihn nicht? Ein Klassiker.' })).toEqual(['featured.why ist mehr als ein Satz']);
    expect(pickProblems({ rank: 1, why: 'Schön gelesen.\nUnd spannend' })).toEqual(['featured.why ist mehr als ein Satz']);
    expect(pickProblems({ rank: 0, why: WHY })).toEqual(['featured.rank ist keine Zahl ab 1']);
    expect(pickProblems({ rank: 1.5, why: WHY })).toEqual(['featured.rank ist keine Zahl ab 1']);
    expect(pickProblems('ja')).toEqual(['featured braucht rank und why']);
  });

  it('rejects duplicate ranks and more than twelve picks', () => {
    const c = activeCatalog();
    for (const e of c.entries) delete e.featured;
    entry(c, 'global-storybooks-de').featured = { rank: 1, why: WHY };
    // Twelve more active entries with picks: thirteen in all.
    for (let i = 0; i < MAX_PICKS; i++) {
      const copy = clone(entry(c, 'global-storybooks-de'));
      copy.id = `gsb-kopie-${i}`;
      copy.featured = { rank: i === 0 ? 1 : i + 2, why: WHY };
      c.entries.push(copy as CatalogEntry & Record<string, unknown>);
    }
    const errors = validateCatalog(c, NOW).errors;
    expect(errors).toContain('gsb-kopie-0: Rang 1 der Empfehlung hat schon global-storybooks-de');
    expect(errors).toContain(`Zu viele Empfehlungen (13, höchstens ${MAX_PICKS})`);
  });

  it('counts the owner’s picks against the limit of twelve', () => {
    const c = activeCatalog();
    // The owner's four, Global Storybooks and seven copies: twelve.
    const free = [1, 5, 6, 8, 9, 10, 11, 12];
    entry(c, 'global-storybooks-de').featured = { rank: free[0], why: WHY };
    for (const [i, rank] of free.slice(1).entries()) {
      const copy = clone(entry(c, 'global-storybooks-de'));
      copy.id = `gsb-kopie-${i}`;
      copy.featured = { rank, why: WHY };
      c.entries.push(copy as CatalogEntry & Record<string, unknown>);
    }
    expect(validateCatalog(c, NOW).errors).toEqual([]);
    const third = clone(entry(c, 'global-storybooks-de'));
    third.id = 'gsb-kopie-13';
    third.featured = { rank: 13, why: WHY };
    c.entries.push(third as CatalogEntry & Record<string, unknown>);
    expect(validateCatalog(c, NOW).errors).toEqual([`Zu viele Empfehlungen (13, höchstens ${MAX_PICKS})`]);
  });

  it('checks minSeconds', () => {
    const c = clone(realCatalog()) as unknown as { entries: Record<string, unknown>[] };
    entry(c, 'radio-klops').minSeconds = -1;
    expect(validateCatalog(c, NOW).errors).toContain('radio-klops: minSeconds ist keine ganze Zahl von 0 bis 600');
    entry(c, 'radio-klops').minSeconds = 60;
    expect(validateCatalog(c, NOW).errors).toEqual([]);
  });
});

describe('editors’ picks for single titles (released.json)', () => {
  const released = (featured: unknown, key = 'global-storybooks-de/0001') => ({
    format: 1,
    released: [{ key, by: 'Redaktion', at: '2026-10-05', featured }],
  });

  it('accepts a pick for a title of an active entry', () => {
    const r = validateReleased(released({ rank: 11, why: WHY }), activeCatalog());
    expect(r.errors).toEqual([]);
    expect(r.released[0].featured).toEqual({ rank: 11, why: WHY });
  });

  it('rejects picks for titles of entries that are not active', () => {
    const r = validateReleased(released({ rank: 2, why: WHY }, 'radio-klops/folge-1'), realCatalog());
    expect(r.errors).toContain('released.json: radio-klops/folge-1: Empfehlungen (featured) nur für Titel aktiver Einträge');
  });

  it('shares the ranks and the limit with the picks in the catalogue', () => {
    const c = activeCatalog();
    entry(c, 'global-storybooks-de').featured = { rank: 1, why: WHY };
    const r = validateReleased(released({ rank: 1, why: WHY }), c);
    expect(r.errors).toContain('released.json: global-storybooks-de/0001: global-storybooks-de ist schon als Ganzes empfohlen');
    expect(r.errors).toContain('released.json: global-storybooks-de/0001: Rang 1 der Empfehlung hat schon global-storybooks-de');
  });

  it('rejects a missing why', () => {
    expect(validateReleased(released({ rank: 3 }), activeCatalog()).errors[0]).toMatch(/featured\.why fehlt/);
  });
});

describe('picks in the build and in the app', () => {
  const catalog = (): SourceCatalog => {
    const c = sampleCatalog() as SourceCatalog & { entries: (CatalogEntry & Record<string, unknown>)[] };
    entry(c, 'radio-klops').featured = { rank: 2, why: ` ${WHY} ` };
    return c;
  };

  it('carries entry picks and title picks into the index; the gates accept them', () => {
    const inputs = sampleInputs();
    const key = 'global-storybooks-de/0001';
    const { index, report } = buildIndex(catalog(), { ...inputs, released: [...inputs.released, { key, by: 'Redaktion', at: '2026-10-05', featured: { rank: 1, why: 'Kurz und lustig.' } }] });
    const klops = index.entries.find((e) => e.id === 'radio-klops')!;
    expect(klops.featured).toEqual({ rank: 2, why: WHY });
    const gsb = index.entries.find((e) => e.id === 'global-storybooks-de')!;
    expect(gsb.items.find((it) => it.key === key)?.featured).toEqual({ rank: 1, why: 'Kurz und lustig.' });
    expect(gsb.items.filter((it) => it.featured)).toHaveLength(1);
    const serialized = JSON.stringify(index);
    const gates = publishGates(index, { catalog: catalog(), serialized, parsed: validateIndex(JSON.parse(serialized)) });
    expect(gates.filter((g) => g.includes('featured') || g.includes('sparse'))).toEqual([]);
    expect(report.notes.some((n) => n.note.startsWith('Empfohlener Titel'))).toBe(false);
  });

  it('notes a recommended title that did not make it into the list', () => {
    const inputs = sampleInputs();
    const { report } = buildIndex(catalog(), { ...inputs, released: [...inputs.released, { key: 'global-storybooks-de/9999', by: 'R', at: '2026-10-05', featured: { rank: 1, why: WHY } }] });
    expect(report.notes).toContainEqual({ entry: 'global-storybooks-de', key: 'global-storybooks-de/9999', note: 'Empfohlener Titel steht nicht in der Liste (gehalten, abgelehnt oder nicht mehr beim Anbieter)' });
  });

  it('a list with picks still reads in the app; a broken pick is left out, not the source', () => {
    const { sample } = buildSample();
    const raw = clone(sample) as unknown as { entries: Record<string, unknown>[] };
    raw.entries[0].featured = { rank: 1, why: WHY, future: 'ignored' };
    raw.entries[1].featured = { rank: 'eins', why: WHY };
    (raw.entries[2].items as Record<string, unknown>[])[0].featured = { rank: 3, why: '' };
    const parsed = parseIndex(raw);
    if (!parsed || parsed === 'needs-update') throw new Error('unreadable');
    expect(parsed.index.entries).toHaveLength(sample.entries.length);
    expect(parsed.index.entries[0].featured).toEqual({ rank: 1, why: WHY });
    expect(parsed.index.entries[1].featured).toBeUndefined();
    expect(parsed.index.entries[2].items[0].featured).toBeUndefined();
    expect(parsed.dropped).toEqual([]);
  });

  it('the sample index without picks reads exactly as before (older lists stay valid)', () => {
    const { sample } = buildSample();
    const parsed = parseIndex(clone(sample));
    if (!parsed || parsed === 'needs-update') throw new Error('unreadable');
    expect(parsed.index.entries.some((e) => e.featured)).toBe(false);
  });
});

describe('one sentence in "why"', () => {
  it('lets abbreviations, ordinals and series names through', () => {
    for (const why of [
      'Über 3 Std. Abenteuer mit den Wildgänsen.',
      'Märchen wie z. B. Rotkäppchen, ruhig gelesen.',
      'Wie Die drei !!! nur kostenlos.',
      'Spannend wie Die drei ??? Folge für Folge.',
      'Der 2. Teil der Reise, ca. 5 Min. pro Kapitel.',
      'Kurz und lustig!',
    ]) {
      expect(moreThanOneSentence(why), why).toBe(false);
      expect(pickProblems({ rank: 1, why })).toEqual([]);
    }
  });

  it('finds a second sentence', () => {
    for (const why of ['Schön gelesen. Und spannend.', 'Wer kennt ihn nicht? Ein Klassiker.', 'Toll! Für alle.', 'Zwei Zeilen\nim Text']) {
      expect(moreThanOneSentence(why), why).toBe(true);
    }
  });
});
