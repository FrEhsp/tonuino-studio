import { describe, expect, it } from 'vitest';
import { search, storyGroups } from '../../src/core/sources/filter';
import type { IndexEntry, IndexItem, SourceIndex } from '../../src/core/sources/types';
import { browseShelves, coverOf, seriesName, shelfKind, shortTitle, storyMeta } from '../../src/features/sources/rows';
import snapshot from '../../sources/snapshot/index-v1.json';

const index = snapshot as unknown as SourceIndex;
const byId = (id: string) => index.entries.find((e) => e.id === id)!;

const item = (n: number, over: Partial<IndexItem> = {}): IndexItem => ({ key: `e/${n}`, title: `Folge ${n}`, category: 'hoerspiel', files: [], durationSec: 600, ...over });
const show = (items: IndexItem[], over: Partial<IndexEntry> = {}): IndexEntry => ({
  id: 'e',
  type: 'link',
  single: true,
  title: 'Die Sendung – Hörspiele für Kinder',
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
  ...over,
});

describe('titles in a row of "Entdecken"', () => {
  it('leave out the name of the show, which the row already says', () => {
    expect(seriesName('Mucks Wüstenfuchs – Mini-Hörspiele zum Mitraten')).toBe('Mucks Wüstenfuchs');
    expect(seriesName('Dr. Brumm')).toBe('Dr. Brumm');
    expect(shortTitle('Mucks Wüstenfuchs: Auf dem Bauernhof', 'Mucks Wüstenfuchs – Mini-Hörspiele zum Mitraten')).toBe('Auf dem Bauernhof');
    expect(shortTitle('Die Sendung – neue Folge', 'Die Sendung – Hörspiele')).toBe('Neue Folge');
  });

  it('keep a title that only begins like the show', () => {
    expect(shortTitle('Dr. Brumm lädt ein', 'Dr. Brumm')).toBe('Dr. Brumm lädt ein');
    expect(shortTitle('Raketenflieger Timmi: Der Sportplanet', 'Unser Sandmännchen – Geschichten und Lieder')).toBe('Raketenflieger Timmi: Der Sportplanet');
    expect(shortTitle('Mucks Wüstenfuchs', 'Mucks Wüstenfuchs – Mini-Hörspiele')).toBe('Mucks Wüstenfuchs');
  });

  it('say parts and length under a story, nothing when nothing is known', () => {
    const parts = [item(1, { title: 'Schatz (1/2)' }), item(2, { title: 'Schatz (2/2)', durationSec: 1200 })];
    expect(storyMeta(storyGroups(parts)[0])).toBe('2 Teile · 30 Min.');
    expect(storyMeta({ title: 'x', items: [item(3, { durationSec: undefined })] })).toBe('');
  });
});

describe('the kind of a row', () => {
  it('shows covers side by side only when the stories have their own', () => {
    expect(shelfKind(byId('ndr-pfefferkoerner'), storyGroups(byId('ndr-pfefferkoerner').items))).toBe('covers');
    expect(shelfKind(byId('hr-mucks-wuestenfuchs'), storyGroups(byId('hr-mucks-wuestenfuchs').items))).toBe('covers');
  });

  it('shows a picture shared by the stories once, with the titles as a list (no row of equal pictures)', () => {
    for (const id of ['br-pumuckl-folgen', 'wdr-mumins']) {
      const e = byId(id);
      expect(shelfKind(e, storyGroups(e.items))).toBe('list');
    }
    // No picture at all: a list too, nothing drawn in its place.
    const bare = show([item(1), item(2), item(3)]);
    expect(shelfKind(bare, storyGroups(bare.items))).toBe('list');
    expect(coverOf({ cover: 'https://example.org/a.jpg' }, {})).toBe('https://example.org/a.jpg');
  });
});

describe('the rows while browsing', () => {
  it('has one row per show, in the order of the hits, and whole sources together at the end', () => {
    const { single: _, ...many } = show([item(9)], { id: 'album', type: 'archive-album', title: 'Lieder' });
    const whole: IndexEntry = many;
    const idx: SourceIndex = { ...index, entries: [whole, ...index.entries] };
    const hits = search(idx, {});
    const shelves = browseShelves(hits);
    expect(shelves.map((s) => s.key)).toEqual([...hits.filter((h) => h.entry.single).map((h) => h.entry.id), 'quellen']);
    const last = shelves[shelves.length - 1];
    expect(last.kind === 'sources' && last.hits.map((h) => h.entry.id)).toEqual(['album']);
    // Every story is in its row once.
    const mumins = shelves.find((s) => s.key === 'wdr-mumins')!;
    expect(mumins.kind !== 'sources' && mumins.stories.map((s) => s.title)).toEqual(storyGroups(byId('wdr-mumins').items).map((s) => s.title));
  });
});
