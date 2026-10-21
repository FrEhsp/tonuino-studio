/**
 * Every pin name in every Lötplan picture is free to read: no wire, pad or
 * other label lies on its box, and no wire runs across a part it does not
 * belong to. Checked for every board, every choice and every step, in the
 * look of the Holzwerkstatt (the only style; the layout is the same in light
 * and dark mode, only the sheet around it and the edge of black wires change).
 */
import { describe, expect, it } from 'vitest';
import { pruefe, textBox } from '../../src/features/workshop/loetplanGeo';
import { DEFAULT_WAHL, PLATINEN, type LoetplanWahl, type Schritt } from '../../src/features/workshop/loetplan';
import { extras, schema } from '../../src/features/workshop/loetplanVerdrahtung';
import { schemaSzene } from '../../src/features/workshop/LoetplanSchema';
import { loetplanSzene } from '../../src/features/workshop/LoetplanSketch';

function alleWahlen(): LoetplanWahl[] {
  const out: LoetplanWahl[] = [];
  for (const platine of PLATINEN)
    for (const tasten of [3, 5] as const)
      for (const kh of ['platine', 'buchse', 'keine'] as const)
        for (const ansicht of ['oben', 'unten'] as const) {
          if (platine !== 'classic' && ansicht === 'unten') continue;
          if ((platine === 'aio' || platine === 'aioplus') && kh !== 'platine') continue;
          out.push({ ...DEFAULT_WAHL, platine, tasten, kh, ansicht });
        }
  return out;
}

const name = (w: LoetplanWahl) => `${w.platine} ${w.tasten} Tasten ${w.kh} ${w.ansicht}`;

// One test per choice, not one loop over all: together they take seconds, and on a busy computer (the
// whole suite beside other work) one big test ran past the time limit and failed without a finding.
describe('Lötplan: every label free to read, Classic v1.7 board, all steps', () => {
  for (const w of alleWahlen().filter((x) => x.platine === 'classic'))
    it(name(w), () => {
      const fehler: string[] = [];
      for (const schritt of [0, 1, 2, 3, 4, 5] as Schritt[]) {
        const { szene } = loetplanSzene(w, schritt);
        const all = [...szene.konflikte, ...pruefe(szene.etiketten, szene)];
        if (all.length) fehler.push(`Schritt ${schritt}: ${all.join(' | ')}`);
        if (schritt === 0) expect(szene.etiketten.length).toBeGreaterThan(40);
      }
      expect(fehler).toEqual([]);
    });
});

describe('Lötplan: every label free to read, wiring pictures of the other boards and all extras', () => {
  for (const w of alleWahlen())
    it(name(w), () => {
      const fehler: string[] = [];
      const plans = [schema(w), ...extras(w).map((e) => e.plan)].filter((p) => p !== null);
      for (const plan of plans) {
        const { szene } = schemaSzene(plan);
        const all = [...szene.konflikte, ...pruefe(szene.etiketten, szene)];
        if (all.length) fehler.push(`${plan.id}: ${all.join(' | ')}`);
        // Everything stays inside the picture.
        for (const e of szene.etiketten) {
          if (e.box.x < 0 || e.box.y < 0 || e.box.x + e.box.w > plan.breite || e.box.y + e.box.h > plan.hoehe) fehler.push(`${plan.id}: ${e.txt} ragt aus dem Bild`);
        }
      }
      expect(fehler).toEqual([]);
    });
});

describe('Lötplan labels', () => {
  it('measures a label with its plate around the letters', () => {
    const b = textBox(100, 50, 'GND', 12, 'start');
    expect(b.x).toBeLessThan(100);
    expect(b.w).toBeGreaterThan(30);
    expect(b.y + b.h).toBeGreaterThan(50);
  });
});
