/** The drawn box of Box testen: every part of the box, green or red as the test says. */
import { describe, expect, it } from 'vitest';
import type { VNode } from 'preact';
import { TEIL_NAMEN } from '../../src/features/workshop/boxbefund';
import { BoxTest } from '../../src/features/workshop/boxtest';
import { BoxTestSketch, boxTestLabel } from '../../src/features/workshop/BoxTestSketch';

interface El {
  type: string;
  props: Record<string, unknown>;
}

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

function draw(t: BoxTest) {
  const bild = { teile: t.teile(), tasten: t.tasten(), jetzt: t.teilJetzt(), wantTaste: t.wantTaste()?.key };
  return flatten(BoxTestSketch({ ...bild, label: boxTestLabel(bild, TEIL_NAMEN) }));
}

describe('Box testen: the drawing', () => {
  it('ticks what works, crosses what does not, rings what is next', () => {
    const t = new BoxTest({ platine: 'classic', tasten: 3, kopfhoerer: false, ring: true, knopf: false, akku: true });
    t.verbindet(0);
    t.weiter();
    t.zeile('btn/cmd: pause/pause', 10);
    t.passiertNichts(20);
    const els = draw(t);
    const marks = els.filter((e) => e.props['data-mark']).map((e) => e.props['data-mark']);
    expect(marks.filter((m) => m === 'ok').length).toBe(2); // USB, Play/Pause
    expect(marks.filter((m) => m === 'fehler').length).toBe(1); // Vor
    const keys = els.filter((e) => e.props['data-key']).map((e) => `${e.props['data-key']}:${e.props['data-state']}`);
    expect(keys).toEqual(['down:offen', 'pause:ok', 'up:fehler']);
    // 16 LEDs of the ring, the battery; no headphone socket.
    expect(els.filter((e) => e.type === 'circle' && e.props.r === 4.2)).toHaveLength(16);
    expect(els.some((e) => e.type === 'text' && e.props.children === 'Akku')).toBe(true);
    expect(els.some((e) => e.type === 'text' && e.props.children === 'Kopfhörer')).toBe(false);
  });

  it('says it in words for screen readers', () => {
    const t = new BoxTest({ platine: 'classic', tasten: 3, kopfhoerer: true, ring: false, knopf: false, akku: false });
    t.verbindet(0);
    t.antwort('lautsprecher', false, 5);
    expect(boxTestLabel({ teile: t.teile(), tasten: t.tasten(), jetzt: t.teilJetzt() }, TEIL_NAMEN)).toBe('Skizze deiner Box. Jetzt dran: USB-Verbindung. Geht: USB-Verbindung. Problem: Lautsprecher.');
  });
});
