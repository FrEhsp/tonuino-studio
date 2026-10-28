import { describe, expect, it } from 'vitest';
import type { VNode } from 'preact';
import { recommendations } from '../../src/core/sources/filter';
import { LeadPick } from '../../src/features/sources/Picks';
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

describe('the tip on top of "Entdecken"', () => {
  it('is the one big thing: its cover large, why it is recommended, and the one filled button', () => {
    const idx = JSON.parse(JSON.stringify(sample)) as typeof sample;
    idx.entries[0].featured = { rank: 1, why: 'Schön.' };
    const [r] = recommendations(idx, {});
    const nodes = walk(LeadPick({ r }));
    const cover = nodes.find((n) => (n.props as { size?: string }).size !== undefined)!;
    expect((cover.props as { size?: string }).size).toBe('xl');
    const links = nodes.filter((n) => n.type === 'a');
    // The button is the one stop for the keyboard; the picture opens it for the mouse only.
    const focusable = links.filter((n) => (n.props as { tabIndex?: number }).tabIndex !== -1);
    expect(focusable).toHaveLength(1);
    expect((focusable[0].props as { class?: string }).class).toContain('btn primary');
    expect(links.every((n) => (n.props as { href?: string }).href === (links[0].props as { href?: string }).href)).toBe(true);
    expect(JSON.stringify(nodes.map((n) => (n.props as { children?: unknown }).children).filter((c) => typeof c === 'string'))).toContain('Schön.');
  });
});
