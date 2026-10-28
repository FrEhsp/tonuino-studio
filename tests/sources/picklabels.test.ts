import { describe, expect, it } from 'vitest';
import { agesLabel } from '../../src/core/sources/filter';
import type { IndexEntry, IndexItem } from '../../src/core/sources/types';
import { pickAges, pickAgesLabel, pickLengthLabel, pickTitle } from '../../src/features/sources/labels';

const item = (n: number, over: Partial<IndexItem> = {}): IndexItem => ({ key: `e/${n}`, title: `Folge ${n}`, category: 'hoerspiel', files: [], durationSec: 1200, ...over });
const entry = (type: IndexEntry['type'], items: IndexItem[]): IndexEntry => ({
  id: 'e',
  type,
  title: 'Die Sendung',
  publisher: 'Sender',
  categories: ['hoerspiel'],
  ages: { min: 6, max: 10, source: 'editor' },
  language: 'de',
  rights: { kind: 'podcast', holder: 'Sender' },
  delivery: 'direct',
  editPolicy: 'normal',
  pageUrl: 'https://example.org/',
  checkedAt: '2026-10-05T04:00:00.000Z',
  items,
});

describe('labels of a recommendation', () => {
  it('says the same ages as the badge of the source, without "Empfohlen"', () => {
    expect(pickAgesLabel({ min: 6, max: 10 })).toBe('Für 6 bis 10 Jahre');
    expect(pickAgesLabel({ min: 6, max: 10 })).toBe(`Für ${agesLabel({ min: 6, max: 10 })}`);
    expect(pickAgesLabel({ min: 5, max: 5 })).toBe('Für 5 Jahre');
    expect(pickAgesLabel({ min: 1 })).toBe('Ab 1 Jahr');
    expect(pickAgesLabel({ min: 7 })).toBe('Ab 7 Jahren');
    expect(pickAgesLabel({ min: 0, max: 5 })).toBe('Bis 5 Jahre');
    expect(pickAgesLabel({ min: 0 })).toBe('Für jedes Alter');
    for (const a of [{ min: 3, max: 7 }, { min: 6 }, { min: 0, max: 4 }]) expect(pickAgesLabel(a)).not.toMatch(/Empfohlen/);
  });

  it('a title’s own ages win over its source', () => {
    const e = entry('podcast', [item(1, { ages: { min: 8 } })]);
    expect(pickAges({ entry: e, item: e.items[0] })).toEqual({ min: 8 });
    expect(pickAges({ entry: e })).toEqual({ min: 6, max: 10, source: 'editor' });
  });

  it('gives the length of a book and the count of a show', () => {
    const book = entry('archive-album', [item(1, { durationSec: 12000 })]);
    expect(pickLengthLabel({ entry: book, items: book.items })).toBe('3 Std. 20 Min.');
    const show = entry('podcast', Array.from({ length: 12 }, (_, i) => item(i)));
    expect(pickLengthLabel({ entry: show, items: show.items })).toBe('12 Folgen');
    expect(pickLengthLabel({ entry: show, item: show.items[0], items: [show.items[0]] })).toBe('20 Min.');
    const chapters = entry('archive-album', [
      item(1, {
        durationSec: undefined,
        files: [
          { url: 'https://x.test/1', name: '1', durationSec: 600 },
          { url: 'https://x.test/2', name: '2', durationSec: 900 },
        ],
      }),
    ]);
    expect(pickLengthLabel({ entry: chapters, items: chapters.items })).toBe('25 Min.');
  });

  it('shows the title of a single title, else the source', () => {
    const e = entry('podcast', [item(1)]);
    expect(pickTitle({ entry: e, item: e.items[0] })).toBe('Folge 1');
    expect(pickTitle({ entry: e })).toBe('Die Sendung');
  });
});
