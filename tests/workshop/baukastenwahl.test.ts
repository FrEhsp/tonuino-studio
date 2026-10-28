import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeChoice, type BaukastenManifest } from '../../src/core/firmware/baukasten';
import { baukasten, firmwareName, firmwareTeile, knopfPins, lichtPins, loetplanFuer, pinsOf, TOO_BIG } from '../../src/features/workshop/baukastenWahl';
import { DEFAULT_WAHL } from '../../src/features/workshop/loetplan';
import { TNG_PINS } from '../../src/features/workshop/tngPins';

const manifest = JSON.parse(readFileSync(join(__dirname, '../../public/firmware/baukasten/manifest.json'), 'utf8')) as BaukastenManifest;

describe('Firmware-Baukasten as tiles', () => {
  it('offers knob and light with pictures on the Classic with 3 buttons, nothing greyed with nothing chosen', () => {
    const bk = baukasten(manifest, 'classic', '3', {}, false);
    expect(bk.knopf?.map((k) => k.name)).toEqual(['Kein Knopf', 'Drehregler', 'Drehregler mit Vor/Zurück', 'Knopf ohne Raster']);
    expect(bk.licht?.map((k) => k.name)).toEqual(['Kein Licht', 'Leuchtring', 'Ring zeigt Lautstärke', 'Leuchtende Tasten']);
    expect(bk.knopf!.every((k) => !k.sperre)).toBe(true);
    expect(bk.licht!.every((k) => !k.sperre)).toBe(true);
    expect(bk.teile.map((t) => [t.name, t.pin])).toEqual([
      ['Lautsprecher stumm', 'D6'],
      ['Kopfhörer-Erkennung', 'D8'],
    ]);
    expect(bk.chips?.length).toBe(3);
    expect(bk.gehtNicht).toEqual([]);
  });

  it('greys out what clashes with the choice and says why, and lists it under „Geht gerade nicht“', () => {
    const choice = { knob: 'encoder' as const, light: 'ring' as const, headphones: true };
    const bk = baukasten(manifest, 'classic', '3', choice, false);
    // The design's example: alarm start, another chip and writing cards go only without light and headphones.
    const names = bk.gehtNicht.map((g) => g.name);
    expect(names).toContain('Wecker-Start');
    expect(names).toContain('Anderer MP3-Player-Chip');
    expect(bk.chips).toBeUndefined();
    expect(bk.mehr.find((m) => m.id === 'alarm')).toBeUndefined();
    for (const g of bk.gehtNicht) expect(g.warum.length).toBeGreaterThan(10);
    // A tile that does not fit into the flash any more is grey with the reason.
    for (const k of [...bk.knopf!, ...bk.licht!]) if (k.sperre) expect(k.sperre === TOO_BIG || /Geht nicht zusammen/.test(k.sperre)).toBe(true);
  });

  it('LED buttons and the speaker switch-off both need D6', () => {
    const bk = baukasten(manifest, 'classic', '3', { light: 'ledButtons' }, false);
    expect(bk.teile.find((t) => t.id === 'speakerOff')?.sperre).toMatch(/D6/);
    const bk2 = baukasten(manifest, 'classic', '3', { speakerOff: true }, false);
    expect(bk2.licht!.find((k) => k.id === 'ledButtons')?.sperre).toMatch(/D6/);
  });

  it('shows no knob with 5 buttons and says why', () => {
    const bk = baukasten(manifest, 'classic', '5', {}, false);
    expect(bk.knopf).toBeUndefined();
    expect(bk.gehtNicht.find((g) => g.name === 'Drehregler')?.warum).toMatch(/Geht nur mit 3 Tasten/);
  });

  it('shows on the AiO only what it can have: a knob, no light, no parts to tick', () => {
    const bk = baukasten(manifest, 'aio', '3', {}, false);
    expect(bk.knopf?.length).toBe(4);
    expect(bk.licht).toBeUndefined();
    expect(bk.teile).toEqual([]);
    const names = bk.gehtNicht.map((g) => g.name);
    for (const n of ['Leuchtring', 'Leuchtende Tasten', 'Lautsprecher stumm', 'Kopfhörer-Erkennung', 'Wecker-Start']) expect(names).toContain(n);
  });

  it('never offers a tile whose build is missing from the app', () => {
    for (const board of ['classic', 'aio'] as const) {
      for (const buttons of ['3', '5', '3x3'] as const) {
        const bk = baukasten(manifest, board, buttons, {}, false);
        for (const k of bk.knopf ?? []) {
          if (k.sperre || !k.id) continue;
          const id = [board, buttons, k.id].join('-');
          expect(manifest.builds.some((b) => b.id === id)).toBe(true);
        }
        for (const l of bk.licht ?? []) {
          if (l.sperre || !l.id) continue;
          expect(manifest.builds.some((b) => b.id === [board, buttons, l.id].join('-'))).toBe(true);
        }
      }
    }
  });
});

describe('the pins of „Deine Auswahl“', () => {
  // Each pin is the one TNG d527ca5 has for the function on that board (tngPins.ts).
  it('takes the knob, light and parts from TNG', () => {
    expect(knopfPins('classic', 'encoder')).toBe('A3, A4');
    expect(knopfPins('classic', 'poti')).toBe('A3');
    expect(knopfPins('aio', 'encoderSkip')).toBe('A3, A4');
    expect(lichtPins('classic', 'ring')).toBe('D5');
    expect(lichtPins('classic', 'ringVolume')).toBe('D5');
    expect(lichtPins('classic', 'ledButtons')).toBe('A5, D6, D5');
    expect(pinsOf('classic', ['spkOnOff', 'hpDetect', 'specialStart'])).toBe('D6, D8, A6');
    expect(lichtPins('classic', 'ledButtons')).toBe([TNG_PINS.classic.ledPlay!.pin, TNG_PINS.classic.ledUp!.pin, TNG_PINS.classic.ledDown!.pin].join(', '));
  });

  it('has no headphone pin on the AiO and does not invent one', () => {
    const bk = baukasten(manifest, 'aio', '3', {}, false);
    expect(bk.teile.some((t) => t.id === 'headphones')).toBe(false);
    expect(TNG_PINS.aio.hpDetect).toBeUndefined();
  });
});

describe('names of the build', () => {
  it('says the build in one line, as in the design', () => {
    expect(firmwareName('3.3.3', 'classic', '3', { knob: 'encoder', light: 'ring', headphones: true })).toBe('TNG 3.3.3 · Classic · 3 Tasten · Drehregler · Leuchtring · Kopfhörer');
    expect(firmwareName('3.3.3', 'aio', '5', { preset: 'weiter' })).toBe('TNG 3.3.3 · AiO · 5 Tasten · Weitermachen');
  });

  it('lists the parts for „Was dafür passiert“ without „Weitermachen“, which comes from „Verhalten“', () => {
    expect(firmwareTeile({ knob: 'encoder', light: 'ring', headphones: true, preset: 'weiter' })).toEqual(['Drehregler', 'Leuchtring', 'Kopfhörer-Erkennung']);
  });
});

describe('the Lötplan with the same extras', () => {
  it('ticks the extras of the build and keeps the rest of the plan', () => {
    const w = loetplanFuer({ ...DEFAULT_WAHL, kh: 'buchse', extras: ['akku'] }, 'classic', '3', { knob: 'encoderSkip', light: 'ringVolume', speakerOff: true, headphones: true }, 'pololu');
    expect(w.platine).toBe('classic');
    expect(w.tasten).toBe(3);
    expect(w.kh).toBe('buchse');
    expect(w.extras).toEqual(['drehgeber', 'ring', 'pololu', 'lsaus', 'hperkennung']);
  });

  it('keeps the Classic without board, and takes the AiO and 5 buttons', () => {
    expect(loetplanFuer({ ...DEFAULT_WAHL, platine: 'frei' }, 'classic', '3', {}).platine).toBe('frei');
    const aio = loetplanFuer(DEFAULT_WAHL, 'aio', '5', normalizeChoice('aio', '5', { knob: 'poti' }));
    expect(aio.platine).toBe('aio');
    expect(aio.tasten).toBe(5);
    expect(aio.extras).toEqual([]);
    expect(loetplanFuer(DEFAULT_WAHL, 'classic', '3', { light: 'ledButtons', alarm: true }).extras).toEqual(['ledtasten', 'wecker']);
  });
});
