/**
 * No bundles: a show recommended as a whole shows each story as its own
 * pick and its own card, parts of one story ("(1/3)") stay together.
 */
import type { VNode } from 'preact';
import { describe, expect, it } from 'vitest';
import { PICK_STORIES, recommendations, storyGroups } from '../../src/core/sources/filter';
import type { IndexEntry, IndexItem, SourceIndex } from '../../src/core/sources/types';
import { pickLengthLabel, pickText, pickTitle } from '../../src/features/sources/labels';
import { SingleCard } from '../../src/features/sources/SourcesPage';

const item = (key: string, title: string, over: Partial<IndexItem> = {}): IndexItem => ({ key: `e/${key}`, title, category: 'hoerspiel', files: [], durationSec: 1800, about: `Über ${title}.`, ...over });

const show = (id: string, rank: number | undefined, items: IndexItem[], single = true): IndexEntry => ({
  id,
  type: 'link',
  title: `Sendung ${id}`,
  publisher: 'ARD',
  categories: ['hoerspiel'],
  ages: { min: 6, max: 12, source: 'publisher' },
  language: 'de',
  rights: { kind: 'private-use', holder: 'ARD Sounds', termsUrl: 'https://www.ardsounds.de/nutzungsbedingungen/' },
  delivery: 'browser',
  editPolicy: 'unchanged',
  pageUrl: 'https://www.ardsounds.de/',
  checkedAt: '2026-10-15T04:00:00.000Z',
  items: items.map((it) => ({ ...it, key: `${id}/${it.key}` })),
  ...(rank ? { featured: { rank, why: `Warum ${id}.` } } : {}),
  ...(single ? { single: true as const } : {}),
});

const CLASSICS = [
  item('s1', 'Die Schatzinsel (1/3)'),
  item('s2', 'Die Schatzinsel (2/3)'),
  item('k1', 'Kalle Blomquist (1/2)'),
  item('s3', 'Die Schatzinsel (3/3)'),
  item('k2', 'Kalle Blomquist (2/2)'),
  item('h', 'Der Sängerkrieg der Heidehasen', { ages: { min: 4, max: 8 } }),
  item('p', 'Peter Pan (1/2)'),
];

const index = (...entries: IndexEntry[]): SourceIndex => ({ format: 1, generatedAt: '2026-10-15T04:00:00.000Z', staleAfter: '2026-10-29T04:00:00.000Z', entries, blocked: [] });

describe('stories', () => {
  it('keeps the parts of one story together at the place of the first part', () => {
    const groups = storyGroups(CLASSICS);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.title)])).toEqual([
      ['Die Schatzinsel', ['Die Schatzinsel (1/3)', 'Die Schatzinsel (2/3)', 'Die Schatzinsel (3/3)']],
      ['Kalle Blomquist', ['Kalle Blomquist (1/2)', 'Kalle Blomquist (2/2)']],
      ['Der Sängerkrieg der Heidehasen', ['Der Sängerkrieg der Heidehasen']],
      // A part whose other part is missing is a title of its own.
      ['Peter Pan (1/2)', ['Peter Pan (1/2)']],
    ]);
  });

  it('never joins episodes that only share the name of the series', () => {
    const mucks = [item('1', 'Mucks Wüstenfuchs: Auf dem Bauernhof (1/10)'), item('2', 'Mucks Wüstenfuchs: Auf der Baustelle (2/10)')];
    expect(storyGroups(mucks)).toHaveLength(2);
    // Parts in the wrong order come out in order; a part named twice does not make a story.
    expect(storyGroups([item('b', 'Komet (2/2): Meer'), item('a', 'Komet (1/2): Gerücht')])[0].items.map((i) => i.key)).toEqual(['e/a', 'e/b']);
    expect(storyGroups([item('a', 'Komet (1/2)'), item('b', 'Komet (1/2)')])).toHaveLength(2);
  });
});

describe('recommendations without bundles', () => {
  it('offers the first stories of a recommended show one by one, the first of every show first', () => {
    const picks = recommendations(index(show('klassiker', 10, CLASSICS), show('mumins', 2, [item('m1', 'Komet im Mumintal (1/2): Gerücht'), item('m2', 'Komet im Mumintal (2/2): Berge'), item('m3', 'Mumins lange Reise')])));
    expect(picks.map((r) => pickTitle(r))).toEqual(['Komet im Mumintal', 'Die Schatzinsel', 'Mumins lange Reise', 'Kalle Blomquist', 'Der Sängerkrieg der Heidehasen']);
    expect(picks.filter((r) => r.entry.id === 'klassiker')).toHaveLength(PICK_STORIES);
    const schatz = picks[1];
    expect(schatz.item?.key).toBe('klassiker/e/s1');
    expect(schatz.items).toHaveLength(3);
    expect(pickLengthLabel(schatz)).toBe('3 Teile · 1 Std. 30 Min.');
    // The story speaks for itself; the show's reason stands in when it has no words of its own.
    expect(pickText(schatz)).toBe('Über Die Schatzinsel (1/3).');
    expect(pickText({ ...schatz, item: { ...schatz.item!, about: undefined } })).toBe('Warum klassiker.');
  });

  it('follows the choice of age for each story, and keeps a show that is no single list as one card', () => {
    const picks = recommendations(index(show('klassiker', 10, CLASSICS), show('bündel', 3, CLASSICS, false)), { band: 'bis5' });
    expect(picks.map((r) => [r.entry.id, pickTitle(r)])).toEqual([
      ['bündel', 'Sendung bündel'],
      ['klassiker', 'Der Sängerkrieg der Heidehasen'],
    ]);
  });
});

describe('the card of a story', () => {
  /** Every element below a node, without drawing components. */
  function walk(node: unknown, out: VNode[] = []): VNode[] {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, out);
      return out;
    }
    if (!node || typeof node !== 'object' || !('type' in node)) return out;
    const v = node as VNode<{ children?: unknown }>;
    out.push(v);
    walk(v.props.children, out);
    return out;
  }

  it('names the story, counts its parts and adds up their length', () => {
    const entry = show('klassiker', undefined, CLASSICS);
    const [story] = storyGroups(entry.items);
    const nodes = walk(SingleCard({ entry, item: story.items[0], story }));
    const link = nodes.find((n) => n.type === 'a')!;
    expect((link.props as { children?: unknown }).children).toBe('Die Schatzinsel');
    const words = nodes
      .flatMap((n) => [(n.props as { children?: unknown }).children].flat())
      .filter((c) => typeof c === 'string' || typeof c === 'number')
      .join(' | ');
    expect(words).toContain('3 Teile');
    expect(words).toContain('1 Std. 30 Min.');
  });
});
