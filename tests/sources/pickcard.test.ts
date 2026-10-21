import { describe, expect, it } from 'vitest';
import type { VNode } from 'preact';
import { recommendations } from '../../src/core/sources/filter';
import { PickCard } from '../../src/features/sources/Picks';
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

describe('a pick on "Entdecken"', () => {
  it('opens from the whole card through one link: the title, with "Ansehen" only as a sign', () => {
    const idx = JSON.parse(JSON.stringify(sample)) as typeof sample;
    idx.entries[0].featured = { rank: 1, why: 'Schön.' };
    const [r] = recommendations(idx, {});
    const nodes = walk(PickCard({ r }));
    const links = nodes.filter((n) => n.type === 'a' || (n.props as { href?: string }).href !== undefined);
    expect(links).toHaveLength(1);
    expect((links[0].props as { class?: string }).class).toBe('source-pick-link');
    const sign = nodes.find((n) => String((n.props as { class?: string }).class ?? '').includes('source-pick-action'))!;
    expect(sign.type).toBe('span');
    expect((sign.props as Record<string, unknown>)['aria-hidden']).toBe('true');
    // No button or other target inside the card that the link would cover.
    expect(nodes.some((n) => n.type === 'button')).toBe(false);
  });
});
