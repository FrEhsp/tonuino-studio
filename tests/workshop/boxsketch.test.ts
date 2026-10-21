import { describe, expect, it } from 'vitest';
import type { VNode } from 'preact';
import { BoxSketch, LIT_MS, sketchButtons, sketchLabel, wobblyCircle } from '../../src/features/workshop/BoxSketch';
import { PartsTest } from '../../src/features/workshop/partstest';

interface El {
  type: string;
  props: Record<string, unknown>;
}

/** Renders a tree of function components into a flat list of elements, without a DOM. */
function flatten(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out);
    return out;
  }
  if (!node || typeof node !== 'object' || !('type' in node)) return out;
  const v = node as VNode<Record<string, unknown>>;
  if (typeof v.type === 'function') return flatten((v.type as (p: unknown) => unknown)(v.props), out);
  if (typeof v.type === 'string') out.push({ type: v.type, props: v.props });
  flatten(v.props.children, out);
  return out;
}

const START_5 = ['TonUINO Version 3.x - refactored by Boerge1', 'V3.3.3 17.09.26', 'A+ 5', 'IB:0', 'enter Idle'];
const CARD = ['Card Ins', 'CardData: 13 37 b3 47 02 05 02 00 00', 'play 5-1', 'enter Play'];

function run(lines: string[], start = 1_000_000): { t: PartsTest; now: number } {
  const t = new PartsTest();
  let now = start;
  for (const l of lines) t.observe(l, (now += 1000));
  return { t, now };
}

describe('BoxSketch', () => {
  it('draws 5 buttons for a 5-button box, lights the one just reported and rings the next one', () => {
    const { t, now } = run([...START_5, ...CARD, 'btn/cmd: up/next', 'btn/cmd: upLong/next10']);
    const buttons = sketchButtons(t, now);
    expect(buttons.map((b) => b.key)).toEqual(['five', 'down', 'pause', 'up', 'four']);
    expect(buttons.find((b) => b.key === 'up')).toMatchObject({ lit: true, done: true, want: false });
    expect(buttons.find((b) => b.key === 'down')).toMatchObject({ lit: false, want: true, done: false });

    const els = flatten(BoxSketch({ buttons }));
    const svg = els.find((e) => e.type === 'svg')!;
    expect(svg.props.role).toBe('img');
    expect(svg.props['aria-label']).toBe('Skizze der Box mit 5 Tasten. Gerade gemeldet: Vor. Jetzt dran: Zurück. Fertig: Vor.');
    const states = els.filter((e) => e.props['data-key']).map((e) => [e.props['data-key'], e.props['data-state']]);
    expect(states).toEqual([
      ['five', 'idle'],
      ['down', 'want'],
      ['pause', 'idle'],
      ['up', 'lit done'],
      ['four', 'idle'],
    ]);
    // The ring pulses, unless the system asks for less motion.
    expect(els.some((e) => e.type === 'animate')).toBe(true);
    expect(flatten(BoxSketch({ buttons, reducedMotion: true })).some((e) => e.type === 'animate')).toBe(false);
  });

  it('lets the light go out after about a second and draws 3 buttons for a 3-button box', () => {
    const { t, now } = run(['TonUINO Version 3.x - refactored by Boerge1', 'C 3', 'btn/cmd: pause/start']);
    expect(sketchButtons(t, now).map((b) => b.key)).toEqual(['down', 'pause', 'up']);
    expect(sketchButtons(t, now).find((b) => b.key === 'pause')?.lit).toBe(true);
    expect(sketchButtons(t, now + LIT_MS).some((b) => b.lit)).toBe(false);
    // No card yet: the guide asks for the card first, so no button is next.
    expect(sketchLabel(sketchButtons(t, now + LIT_MS))).toBe('Skizze der Box mit 3 Tasten.');
  });

  it('draws by hand: the same wobble every time, but no perfect circle', () => {
    expect(wobblyCircle(50, 50, 10, 3)).toBe(wobblyCircle(50, 50, 10, 3));
    expect(wobblyCircle(50, 50, 10, 3)).not.toBe(wobblyCircle(50, 50, 10, 4));
  });
  it('draws the box with lit, ringed and ticked buttons, in the hand-made look', () => {
    const { t, now } = run([...START_5, ...CARD, 'btn/cmd: up/next', 'btn/cmd: upLong/next10']);
    const buttons = sketchButtons(t, now);
    const els = flatten(BoxSketch({ buttons }));
    const svg = els.find((e) => e.type === 'svg')!;
    expect(svg.props.class).toBe('pt-sketch sketch-art');
    expect(svg.props['aria-label']).toBe('Skizze der Box mit 5 Tasten. Gerade gemeldet: Vor. Jetzt dran: Zurück. Fertig: Vor.');
    expect(els.filter((e) => e.props['data-key']).map((e) => e.props['data-state'])).toEqual(['idle', 'want', 'idle', 'lit done', 'idle']);
    expect(els.filter((e) => e.type === 'text').map((e) => e.props.children)).toEqual(expect.arrayContaining(['Leiser', 'Zurück', 'Play/Pause', 'Vor', 'Lauter']));
    expect(els.some((e) => e.type === 'animate')).toBe(true);
    expect(els.some((e) => e.props.filter === 'url(#ts-wobble-art)')).toBe(true);
  });
});
