/**
 * Planning cards and the automatic check (src/core/covers/plan.ts) on
 * generated test pictures.
 */
import { describe, expect, it } from 'vitest';
import { analyseCover } from '../../src/core/covers/analyse';
import { inARow, planCard, planExtended, type PlanInput } from '../../src/core/covers/plan';
import type { LayoutSpec } from '../../src/core/covers/recipe';
import { shelfCardText } from '../../src/core/covers/shelf';
import { blob, busy, clouds, night, stars } from './pictures';

const HOCH = { widthMm: 50.8, heightMm: 83.8, cutMm: 1.5 };
const QUER = { widthMm: 83.8, heightMm: 50.8, cutMm: 1.5 };

/** A night cover: title-like bar at the top, a round badge left, a moon right, a busy town at the bottom. */
function nightCover() {
  const p = stars(night(400, 400), 30, 4);
  for (let y = 20; y < 70; y++) for (let x = 70; x < 330; x++) if ((x >> 3) % 2 === 0) p.data.set([230, 90, 170, 255], (y * 400 + x) * 4);
  blob(p, 70, 160, 55, { r: 80, g: 95, b: 95 });
  blob(p, 320, 140, 22, { r: 250, g: 220, b: 20 });
  // A star to copy, with dark ground around it.
  for (let y = 176; y < 196; y++) for (let x = 176; x < 196; x++) p.data.set([8, 8, 10, 255], (y * 400 + x) * 4);
  blob(p, 182, 182, 1, { r: 250, g: 250, b: 240 });
  busy(p, 0, 290, 400, 110);
  return p;
}

function input(pixels = nightCover(), layout: LayoutSpec = {}, format: 'hoch' | 'quer' = 'hoch'): PlanInput {
  return {
    analysis: analyseCover(pixels),
    layout,
    format,
    geometry: format === 'hoch' ? HOCH : QUER,
    text: { title: 'Das kleine Testgespenst', folder: '42' },
    sourceSize: { width: 1200, height: 1200 },
    seed: 3,
  };
}

const PARTS: LayoutSpec = {
  form: 'verlaengern',
  anker: 1,
  teile: [
    { name: 'Titel', tun: 'versetzen', quelle: [0.15, 0.03, 0.7, 0.17], ziel: [0.06, 0.05, 0.88] },
    { name: 'Kreis', tun: 'versetzen', maske: 'ellipse', quelle: [0.04, 0.26, 0.28, 0.28], ziel: [0.08, 0.24, 0.34] },
    { name: 'Mond', tun: 'versetzen', quelle: [0.72, 0.27, 0.16, 0.16], ziel: [0.68, 0.26, 0.16] },
    { name: 'Stern', tun: 'kopieren', quelle: [0.44, 0.44, 0.03, 0.03], anzahl: 4 },
  ],
};

describe('planCard', () => {
  it('extends only a flat edge and fills the space with real parts', () => {
    const plan = planCard(input(undefined, PARTS));
    expect(plan.form).toBe('verlaengern');
    expect(plan.seams).toEqual(['top']);
    expect(plan.moves).toHaveLength(3);
    expect(plan.problems.filter((p) => p.blocking)).toEqual([]);
    // The cover sits at the bottom, the full width of the card.
    expect(plan.cover.w).toBeCloseTo(50.8);
    expect(plan.cover.y + plan.cover.h).toBeCloseTo(83.8);
  });

  it('never continues clouds: the safe form instead', () => {
    const plan = planCard(input(clouds(400, 400), { form: 'verlaengern' }));
    expect(plan.form).toBe('farbfeld');
    expect(plan.simplified?.[0].code).toBe('kopierspuren');
    expect(plan.panel).toBeDefined();
  });

  it('fails an extension that leaves a big empty area', () => {
    const plan = planExtended(input(undefined, { form: 'verlaengern', anker: 1 }))!;
    expect(plan.problems.some((p) => p.code === 'leer' && p.blocking)).toBe(true);
    expect(planCard(input(undefined, { form: 'verlaengern', anker: 1 })).form).toBe('farbfeld');
  });

  it('does not move a part that lies on a pattern', () => {
    const p = clouds(400, 400);
    for (let y = 0; y < 60; y++) for (let x = 0; x < 400; x++) p.data.set([8, 8, 10, 255], (y * 400 + x) * 4);
    const plan = planExtended(input(p, { form: 'verlaengern', anker: 1, teile: [{ tun: 'versetzen', quelle: [0.3, 0.4, 0.3, 0.3], ziel: [0.3, 0.1, 0.3] }] }))!;
    expect(plan.problems.some((x) => x.code === 'kopierspuren')).toBe(true);
  });

  it('refuses a part blown up beyond its resolution', () => {
    const i = input(undefined, { ...PARTS, teile: [{ name: 'Mond', tun: 'versetzen', quelle: [0.72, 0.27, 0.16, 0.16], ziel: [0.1, 0.02, 0.8] }] });
    i.sourceSize = { width: 300, height: 300 };
    expect(planExtended(i)!.problems.some((p) => p.code === 'aufloesung' && p.blocking)).toBe(true);
  });

  it('refuses copying a big part', () => {
    const plan = planExtended(input(undefined, { ...PARTS, teile: [{ tun: 'kopieren', quelle: [0.04, 0.26, 0.28, 0.28], anzahl: 3 }] }))!;
    expect(plan.problems.some((p) => p.code === 'kopierspuren')).toBe(true);
  });

  it('scatters copies apart and never in a row', () => {
    const plan = planCard(input(undefined, PARTS));
    const dsts = plan.copies.flatMap((c) => c.dsts);
    expect(dsts.length).toBeGreaterThan(1);
    expect(inARow(dsts)).toBe(false);
  });

  it('keeps the number off text and moved parts', () => {
    const plan = planCard(input(undefined, PARTS));
    const b = plan.badge!;
    for (const t of [...plan.texts, ...plan.moves.map((m) => m.dst)]) {
      const apart = b.cx + b.r < t.x || b.cx - b.r > t.x + t.w || b.cy + b.r < t.y || b.cy - b.r > t.y + t.h;
      expect(apart).toBe(true);
    }
  });

  it('puts title and number on the panel of the safe form', () => {
    const plan = planCard(input(clouds(400, 400)));
    expect(plan.form).toBe('farbfeld');
    expect(plan.title?.text).toBe('Das kleine Testgespenst');
    expect(plan.badge?.text).toBe('42');
    const panel = plan.panel!;
    expect(plan.badge!.cy).toBeGreaterThan(panel.y);
  });

  it('runs a flat edge into the panel without a seam', () => {
    const plan = planCard(input(stars(night(400, 400), 6, 2), {}, 'quer'));
    expect(plan.form).toBe('farbfeld');
    expect(plan.seams.length).toBe(1);
    expect(plan.ground.r).toBeLessThan(30);
  });

  it('shows no number of its own when the cover prints one', () => {
    expect(planCard(input(clouds(400, 400), { nummer: 'im-cover' })).badge).toBeUndefined();
    expect(planCard({ ...input(clouds(400, 400), { nummer: 'folge' }), text: { title: 'X', folder: '07', episode: 3 } }).badge?.text).toBe('3');
  });

  it('fills a cover of nearly the card’s shape', () => {
    const p = clouds(320, 520);
    expect(planCard(input(p)).form).toBe('fuellen');
  });
});

describe('a card on the shelf', () => {
  // The shelf writes the folder number in the card's margin: no second one on the card.
  it('has no folder number disc', () => {
    for (const layout of [{}, PARTS, { form: 'farbfeld' } as LayoutSpec]) {
      const plan = planCard({ ...input(undefined, layout), text: shelfCardText({ title: 'Das kleine Testgespenst' }, undefined) });
      expect(plan.badge).toBeUndefined();
    }
  });

  it('keeps the episode number of a series', () => {
    const plan = planCard({ ...input(undefined, { nummer: 'folge' }), text: shelfCardText({ title: 'Folge 12' }, 12) });
    expect(plan.badge?.text).toBe('12');
  });

  it('is the only place without it: a card given a folder number still gets its disc', () => {
    expect(planCard(input()).badge?.text).toBe('42');
  });
});

