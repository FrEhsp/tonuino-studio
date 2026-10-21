/**
 * The pin table of the Lötplan (tngPins.ts) against the firmware itself:
 * every entry is read again from TonUINO TNG's src/constants.hpp (copy in
 * tests/fixtures/tng), at its line, with its value, inside the #if branch it
 * claims. A pin that moves in a new TNG version fails here first.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TNG_PINS, tngQuelle, type TngPlatine } from '../../src/features/workshop/tngPins';

const LINES = readFileSync(new URL('../fixtures/tng/constants.hpp', import.meta.url), 'utf8').split('\n');

/** For every line, the #if branches it sits in, as "head" or "head → #else" or the #elif text. */
function branches(): string[][] {
  const out: string[][] = [];
  const stack: { head: string; branch: string }[] = [];
  for (const raw of LINES) {
    const line = raw.trim();
    if (/^#if/.test(line)) stack.push({ head: line, branch: line });
    else if (/^#elif/.test(line)) stack[stack.length - 1].branch = line;
    else if (/^#else/.test(line)) stack[stack.length - 1].branch = `${stack[stack.length - 1].head} → #else`;
    else if (/^#endif/.test(line)) stack.pop();
    out.push(stack.map((f) => f.branch));
  }
  return out;
}

const BRANCHES = branches();

describe('TNG pin table against src/constants.hpp', () => {
  for (const platine of Object.keys(TNG_PINS) as TngPlatine[]) {
    it(`${platine}: every pin at its line, with its value, in its branch`, () => {
      const fehler: string[] = [];
      for (const [funktion, e] of Object.entries(TNG_PINS[platine])) {
        const line = LINES[e.zeile - 1] ?? '';
        const m = line.match(/^\s*(?:\/\/)?\s*inline constexpr \w+\s+&?(\w+)\s*=\s*([A-Z]?\d+)\s*;/);
        if (!m) {
          fehler.push(`${funktion}: Zeile ${e.zeile} ist keine Pin-Zeile: ${line}`);
          continue;
        }
        if (line.trim().startsWith('//')) fehler.push(`${funktion}: Zeile ${e.zeile} ist auskommentiert`);
        if (m[1] !== e.name) fehler.push(`${funktion}: ${m[1]} statt ${e.name}`);
        if (m[2] !== e.wert) fehler.push(`${funktion}: ${m[2]} statt ${e.wert}`);
        for (const b of e.in) if (!BRANCHES[e.zeile - 1].includes(b)) fehler.push(`${funktion}: Zeile ${e.zeile} steht nicht in „${b}“, sondern in ${JSON.stringify(BRANCHES[e.zeile - 1])}`);
      }
      expect(fehler).toEqual([]);
    });
  }

  it('the Classic and Every share one block, the AiO+ needs its own', () => {
    expect(TNG_PINS.classic.pause?.in[0]).toMatch(/TonUINO_Every/);
    expect(TNG_PINS.aioplus.ring?.pin).toBe('PB2');
    // The pin-table comment of the AiO+ names PB2 for pin 10 (constants.hpp:35-36, 44).
    expect(LINES[35]).toMatch(/PB2/);
  });

  it('cites the line for the wire list', () => {
    expect(tngQuelle('classic', 'ring')).toBe('TNG src/constants.hpp:255 (neoPixelRingPin = D5)');
  });
});
