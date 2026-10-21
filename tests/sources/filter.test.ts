import { describe, expect, it } from 'vitest';
import { AGE_BANDS, agesLabel, agesSentence, CATEGORY_CHOICES, filesInOrder, fitsBand, search, searchable, searchStem, searchWords, withoutBlocked } from '../../src/core/sources/filter';
import type { SourceIndex } from '../../src/core/sources/types';
import { buildSample } from './sample';

const { sample } = buildSample();
const ids = (q: Parameters<typeof search>[1], idx: SourceIndex = sample) => search(idx, q).map((h) => h.entry.id);

describe('search', () => {
  it('finds an episode by a word of its title and shows only that episode', () => {
    const hits = search(sample, { text: 'mammut' });
    expect(hits.map((h) => h.items.map((i) => i.title))).toEqual([['Das Mammut in der Grube']]);
    expect(hits[0].entryMatch).toBe(false);
  });

  it('folds umlauts: "Haensel Gretel" finds "Hänsel" in the description', () => {
    expect(ids({ text: 'Haensel Gretel' })).toEqual(['jamendo-139374-eckhardt']);
    expect(ids({ text: 'hansel' })).toEqual(['jamendo-139374-eckhardt']);
  });

  it('finds other forms of long words: "Weisheiten" finds "Weisheit", short words stay exact', () => {
    expect(ids({ text: 'Weisheiten' })).toEqual(['global-storybooks-de']);
    expect(searchStem('weihnachten')).toBe('weihnacht');
    expect(searchStem('piraten')).toBe('pirat');
    expect(searchStem('hexe')).toBe('hexe');
    expect(searchStem('folge10')).toBe('folge10');
  });

  it('needs every word, across source and item together', () => {
    expect(ids({ text: 'klops sonnencreme' })).toEqual(['radio-klops']);
    expect(search(sample, { text: 'klops sonnencreme' })[0].items).toHaveLength(1);
    expect(ids({ text: 'klops mammut' })).toEqual([]);
  });

  it('finds people: readers and authors', () => {
    expect(ids({ text: 'Katharina Thalbach' })).toEqual(['ohrka']);
    expect(search(sample, { text: 'Gulere' })[0].items.map((i) => i.key)).toContain('global-storybooks-de/0001');
  });

  it('lists sources that match as a whole first, then well described ones, then by German title order', () => {
    const hits = search(sample, { text: 'storybooks' });
    expect(hits[0].entry.id).toBe('global-storybooks-de');
    expect(hits[0].entryMatch).toBe(true);
    expect(hits[0].items).toHaveLength(37);
    const all = search(sample, {});
    const collator = new Intl.Collator('de');
    const byTier = (t: 0 | 1) => all.filter((h) => h.tier === t).map((h) => h.entry.title);
    expect(all.map((h) => h.entry.title)).toEqual([...byTier(0).sort(collator.compare), ...byTier(1).sort(collator.compare)]);
    // Stories mostly without length and Radio Klops without show notes come after the described sources.
    // OHRKA lists its titles with length now and counts as well described.
    expect(all.filter((h) => h.tier === 1).map((h) => h.entry.id).sort()).toEqual(['global-storybooks-de', 'radio-klops']);
  });

  it('filters by kind and age band', () => {
    // The OHRKA audiobooks are for children from 8 except the fairy tales from 5; its plays from 5 are Hörspiele.
    expect(ids({ category: 'hoerbuch', band: 'bis5' }).sort()).toEqual(['global-storybooks-de', 'ohrka']);
    expect(ids({ category: 'hoerspiel', band: 'bis5' })).toContain('ohrka');
    expect(ids({ band: 'ab12' }).sort()).toEqual(['kakadu-kinderhoerspiel', 'ohrka', 'srf-kids-hoerspiele']);
    expect(ids({ category: 'lied' })).toEqual(['jamendo-139374-eckhardt']);
    expect(ids({ category: 'alle', band: 'alle' })).toHaveLength(6);
  });

  it('never shows blocked sources or items, also from an older copy', () => {
    const blocked: SourceIndex = { ...sample, blocked: ['radio-klops', 'global-storybooks-de/0001'] };
    expect(ids({}, blocked)).not.toContain('radio-klops');
    expect(search(blocked, { text: 'Gulere' }).flatMap((h) => h.items.map((i) => i.key))).not.toContain('global-storybooks-de/0001');
    const cleaned = withoutBlocked(sample, ['ohrka']);
    expect(cleaned.entries.map((e) => e.id)).not.toContain('ohrka');
    expect(cleaned.blocked).toEqual([...sample.blocked, 'ohrka']);
  });

  it('finds songs by their title and names them for the card', () => {
    const hits = search(sample, { text: 'wieviel' });
    expect(hits.map((h) => h.entry.id)).toEqual(['jamendo-139374-eckhardt']);
    expect(hits[0].itemsMatched).toBe(true);
    expect(hits[0].chapters.map((c) => c.title)).toEqual(['Weisst Du wieviel Sternlein stehen', 'Weisst Du wieviel Sternlein stehen (Karaoke)']);
    // The key is the row on the source page: the item and the song's place in playing order.
    const album = hits[0].items[0];
    expect(hits[0].chapters[1].key).toBe(`${album.key}#${filesInOrder(album).findIndex((f) => f.title === 'Weisst Du wieviel Sternlein stehen (Karaoke)')}`);
    // Words from the source and a song together; "Karaoke" is in the description too, so it narrows nothing.
    expect(search(sample, { text: 'Eckhardt wieviel' })[0].chapters.map((c) => c.title)).toEqual(['Weisst Du wieviel Sternlein stehen', 'Weisst Du wieviel Sternlein stehen (Karaoke)']);
  });

  it('finds the editors\' reason for a pick', () => {
    const picked: SourceIndex = { ...sample, entries: sample.entries.map((e) => (e.id === 'radio-klops' ? { ...e, featured: { rank: 1, why: 'Zum Kringeln komisch.' } } : e)) };
    expect(ids({ text: 'kringeln' }, picked)).toEqual(['radio-klops']);
  });

  it('folds umlauts both ways: "Sandmann" finds "Sandmännchen", "maerchen" still finds "Märchen"', () => {
    const sand: SourceIndex = { ...sample, entries: sample.entries.map((e) => (e.id === 'radio-klops' ? { ...e, title: 'Unser Sandmännchen' } : e)) };
    expect(ids({ text: 'Sandmann' }, sand)).toEqual(['radio-klops']);
    expect(ids({ text: 'sandmaennchen' }, sand)).toEqual(['radio-klops']);
    expect(ids({ text: 'Märchen' })).toContain('ohrka');
    expect(ids({ text: 'Marchen' })).toContain('ohrka');
    expect(ids({ text: 'maerchen' })).toContain('ohrka');
    expect(searchable('Hänsel')).toBe('haensel hansel');
    expect(searchable('Pumuckl')).toBe('pumuckl');
  });

  it('ranks a word found at the start of a word before one found inside a word', () => {
    const muck: SourceIndex = {
      ...sample,
      entries: sample.entries.map((e) => (e.id === 'radio-klops' ? { ...e, title: 'Pumuckl', blurb: '' } : e.id === 'kakadu-kinderhoerspiel' ? { ...e, title: 'Der kleine Muck', blurb: '' } : e)),
    };
    const hits = search(muck, { text: 'muck' });
    expect(hits.map((h) => h.entry.title)).toEqual(['Der kleine Muck', 'Pumuckl']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('lists only the matching titles of a source that matches as a whole', () => {
    const klops = sample.entries.find((e) => e.id === 'radio-klops')!;
    const title = klops.items[1].title;
    const word = searchWords(title).find((w) => w.length > 4 && !klops.items.some((it, i) => i !== 1 && searchWords(it.title).includes(w)))!;
    const both: SourceIndex = { ...sample, entries: sample.entries.map((e) => (e === klops ? { ...e, blurb: `${e.blurb} Mit ${word}.` } : e)) };
    const hit = search(both, { text: word }).find((h) => h.entry.id === 'radio-klops')!;
    expect(hit.entryMatch).toBe(true);
    expect(hit.itemsMatched).toBe(true);
    expect(hit.items.map((i) => i.title)).toEqual([title]);
    // Nothing of its own: the whole source.
    const whole = search(sample, { text: 'storybooks' })[0];
    expect(whole.itemsMatched).toBe(false);
  });

  it('turns text into distinct search words', () => {
    expect(searchWords('  Märchen  märchen, Mond ')).toEqual(['maerchen', 'mond']);
    expect(searchWords(undefined)).toEqual([]);
  });
});

describe('age bands and labels', () => {
  it('overlap test with open ranges up to 17', () => {
    expect(fitsBand({ min: 4, max: 8 }, 'bis5')).toBe(true);
    expect(fitsBand({ min: 4, max: 8 }, '6bis11')).toBe(true);
    expect(fitsBand({ min: 4, max: 8 }, 'ab12')).toBe(false);
    expect(fitsBand({ min: 12 }, 'ab12')).toBe(true);
    expect(fitsBand({ min: 7 }, 'ab12')).toBe(true);
    expect(fitsBand({ min: 6, max: 6 }, 'bis5')).toBe(false);
  });

  it('labels the choices the way the page shows them', () => {
    expect(CATEGORY_CHOICES.map((c) => c.label)).toEqual(['Alles', 'Hörspiele', 'Hörbücher', 'Wissen', 'Lieder']);
    expect(AGE_BANDS.map((b) => b.label)).toEqual(['Jedes Alter', 'Bis 5', '6 bis 11', 'Ab 12']);
  });

  it('writes short age badges', () => {
    expect(agesLabel({ min: 7 })).toBe('ab 7 Jahren');
    expect(agesLabel({ min: 1 })).toBe('ab 1 Jahr');
    expect(agesLabel({ min: 0 })).toBe('jedes Alter');
    expect(agesLabel({ min: 4, max: 8 })).toBe('4 bis 8 Jahre');
    expect(agesLabel({ min: 6, max: 6 })).toBe('6 Jahre');
    expect(agesLabel({ min: 0, max: 5 })).toBe('bis 5 Jahre');
  });

  it('says whose recommendation an age is', () => {
    expect(agesSentence({ min: 7, source: 'publisher', text: 'Unsere Geschichten eignen sich meist für Hörer ab 7 Jahren.' })).toBe(
      'Empfohlen ab 7 Jahren. Der Anbieter schreibt: „Unsere Geschichten eignen sich meist für Hörer ab 7 Jahren.“',
    );
    expect(agesSentence({ min: 5, max: 10, source: 'editor' })).toBe('Empfohlen für 5 bis 10 Jahre (geschätzt, der Anbieter nennt kein Alter).');
    expect(agesSentence({ min: 12, source: 'editor' })).toBe('Empfohlen ab 12 Jahren (geschätzt, der Anbieter nennt kein Alter).');
    expect(agesSentence({ min: 4, max: 8, source: 'publisher' })).toBe('Empfohlen für 4 bis 8 Jahre (Angabe des Anbieters).');
  });
});
