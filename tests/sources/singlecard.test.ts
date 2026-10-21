import { describe, expect, it } from 'vitest';
import type { VNode } from 'preact';
import { search } from '../../src/core/sources/filter';
import { SingleCard } from '../../src/features/sources/SourcesPage';
import { titleWithoutReader } from '../../src/features/sources/labels';
import { buildSample } from './sample';

const { sample } = buildSample();

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

const text = (nodes: VNode[]) =>
  nodes
    .flatMap((n) => [(n.props as { children?: unknown }).children].flat())
    .filter((c): c is string => typeof c === 'string')
    .join(' | ');

describe('titles listed one by one (OHRKA, Hörspielklassiker)', () => {
  const ohrka = sample.entries.find((e) => e.id === 'ohrka')!;

  it('is marked in the list', () => {
    expect(ohrka.single).toBe(true);
    expect(sample.entries.filter((e) => e.single).map((e) => e.id)).toEqual(['ohrka']);
  });

  it('shows one title with its own cover, reader, age and length, and opens the source at that title', () => {
    const item = { ...ohrka.items[0], about: 'Alice folgt einem weißen Kaninchen in seinen Bau und erlebt dort die seltsamsten Dinge.' };
    const nodes = walk(SingleCard({ entry: ohrka, item }));
    const cover = nodes.find((n) => (n.props as { cover?: string }).cover !== undefined)!;
    expect((cover.props as { cover?: string }).cover).toBe(item.cover);
    const all = text(nodes);
    expect(all).toContain('Alice im Wunderland');
    expect(all).not.toContain('Alice im Wunderland, gelesen von');
    expect(all).toContain('Gelesen von Katharina Thalbach');
    expect(all).toContain('Alice folgt einem weißen Kaninchen');
    expect(all).toContain(ohrka.title);
    const links = nodes.filter((n) => n.type === 'a');
    expect(links).toHaveLength(1);
    expect((links[0].props as unknown as { href: string }).href).toContain('ohrka');
  });

  it('keeps titles whose reader is not named below', () => {
    expect(titleWithoutReader('Alice im Wunderland, gelesen von Katharina Thalbach', [{ name: 'Katharina Thalbach', role: 'reader' }])).toBe('Alice im Wunderland');
    expect(titleWithoutReader('Alice im Wunderland, gelesen von Katharina Thalbach', [{ name: 'Lewis Carroll', role: 'author' }])).toBe('Alice im Wunderland, gelesen von Katharina Thalbach');
    expect(titleWithoutReader('Der kleine Muck', [{ name: 'Anke Engelke', role: 'reader' }])).toBe('Der kleine Muck');
  });
});

describe('words from the source', () => {
  it('help the search: an episode is found by its description', () => {
    const hits = search(sample, { text: 'Säbelzahntiger' });
    expect(hits.map((h) => h.items.map((i) => i.title))).toEqual([['Das Mammut in der Grube']]);
  });
});
