/**
 * Every wire the Lötplan draws is proven, and the proof holds:
 * - it names at least one proof, every proof exists, and none is "ungeprüft";
 * - a wire that ends at a pin of the microcontroller names the TNG function
 *   of that pin, the pin is the one of the pin table (tngPins.ts, itself
 *   checked line by line against TNG's constants.hpp in tngpins.test.ts),
 *   and the wire list names it;
 * - no proof is stronger than the checked notes of the build assistant it
 *   stands for (fixture: tests/fixtures/bauassistent/geprueft-stufen.json);
 * - an extra without a picture says why and what would prove it.
 * For every board, both Arduinos, 3 and 5 buttons, every headphone choice.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aufbau, DEFAULT_WAHL, EXTRAS, loetplanWahl, PLATINEN, schalteExtra, toWahl, waehle, type ListenKabel, type LoetplanWahl } from '../../src/features/workshop/loetplan';
import { BELEGE, stufeVon, type BelegId, type Stufe } from '../../src/features/workshop/loetplanBelege';
import { a5Konflikt, d6Konflikt, extras, gewaehlteExtras, schema, type SchemaPlan, type SKabel } from '../../src/features/workshop/loetplanVerdrahtung';
import { D6_WARNING } from '../../src/core/firmware/baukasten';
import { NANO_SPI, TNG_PINS } from '../../src/features/workshop/tngPins';

const NOTIZEN = JSON.parse(readFileSync(new URL('../fixtures/bauassistent/geprueft-stufen.json', import.meta.url), 'utf8')) as Record<string, { confidence: 'belegt' | 'wahrscheinlich' | 'unsicher' }>;

function alleWahlen(): LoetplanWahl[] {
  const out: LoetplanWahl[] = [];
  for (const platine of PLATINEN)
    for (const nano of ['nano', 'every'] as const)
      for (const tasten of [3, 5] as const)
        for (const kh of ['platine', 'buchse', 'keine'] as const) {
          if ((platine === 'aio' || platine === 'aioplus') && (kh !== 'platine' || nano !== 'nano')) continue;
          out.push({ ...DEFAULT_WAHL, platine, nano, tasten, kh, extras: [...EXTRAS] });
        }
  return out;
}

const name = (w: LoetplanWahl) => `${w.platine} ${w.nano} ${w.tasten} Tasten ${w.kh}`;

/** Every wire of a choice, with the picture it is in. */
function alleKabel(w: LoetplanWahl): [string, ListenKabel][] {
  const out: [string, ListenKabel][] = [];
  if (w.platine === 'classic') for (const k of aufbau(w).kabel) out.push(['Classic v1.7', k]);
  const plans: SchemaPlan[] = [schema(w), ...extras(w).map((x) => x.plan)].filter((p): p is SchemaPlan => p !== null);
  for (const p of plans) for (const k of [...p.kabel, ...(p.frei ?? [])]) out.push([p.id, k]);
  return out;
}

describe('Lötplan: every wire is proven', () => {
  it('names proofs that exist, none of them unproven', () => {
    const fehler: string[] = [];
    for (const w of alleWahlen())
      for (const [bild, k] of alleKabel(w)) {
        if (!k.belege.length) fehler.push(`${name(w)} / ${bild}: „${k.text}“ ohne Beleg`);
        for (const b of k.belege) if (!(b in BELEGE)) fehler.push(`${name(w)} / ${bild}: unbekannter Beleg ${b}`);
        if (k.belege.length && stufeVon(k.belege) === 'ungeprueft') fehler.push(`${name(w)} / ${bild}: „${k.text}“ ist ungeprüft`);
      }
    expect(fehler).toEqual([]);
  });

  it('puts every wire at a pin of the microcontroller on the pin of TNG, and names it', () => {
    const fehler: string[] = [];
    const spi: string[] = Object.values(NANO_SPI);
    let geprueft = 0;
    for (const w of alleWahlen())
      for (const [bild, k] of alleKabel(w)) {
        if (k.tng) {
          geprueft++;
          const e = TNG_PINS[k.tng.platine][k.tng.funktion];
          if (!e) fehler.push(`${name(w)} / ${bild}: TNG kennt ${k.tng.funktion} auf ${k.tng.platine} nicht`);
          else if (e.pin !== k.tng.pin) fehler.push(`${name(w)} / ${bild}: „${k.text}“ an ${k.tng.pin}, TNG sagt ${e.pin} (${e.name})`);
          if (!new RegExp(`\\b${k.tng.pin}\\b`).test(k.text)) fehler.push(`${name(w)} / ${bild}: „${k.text}“ nennt den Pin ${k.tng.pin} nicht`);
          // The Classic, the Every and the Classic without board share one block of TNG.
          const soll = w.platine === 'aio' ? 'aio' : w.platine === 'aioplus' ? 'aioplus' : 'classic';
          if (k.tng.platine !== soll) fehler.push(`${name(w)} / ${bild}: „${k.text}“ nach der Tabelle von ${k.tng.platine}`);
        }
        // A wire that leaves a pin of the Nano or of a board row with A…/D… print must name its TNG function.
        const s = k as Partial<SKabel>;
        for (const end of [s.von, s.nach]) {
          if (!end || !['nano', 'leiste', 'diverse'].includes(end[0])) continue;
          const pin = end[1];
          if (/^(A\d|D\d+|PB2)$/.test(pin) && !spi.includes(pin) && k.tng?.pin !== pin) fehler.push(`${name(w)} / ${bild}: „${k.text}“ endet an ${pin} ohne TNG-Pin`);
        }
      }
    expect(fehler).toEqual([]);
    expect(geprueft).toBeGreaterThan(100);
  });

  it('never claims more than the checked notes', () => {
    const rang: Record<Stufe, number> = { geprueft: 0, nachsehen: 1, ungeprueft: 2 };
    const ausNotiz = { belegt: 'geprueft', wahrscheinlich: 'nachsehen', unsicher: 'ungeprueft' } as const;
    const fehler: string[] = [];
    for (const [id, b] of Object.entries(BELEGE) as [BelegId, (typeof BELEGE)[BelegId]][]) {
      const ids: readonly string[] = 'json' in b && b.json ? b.json : [id];
      for (const j of ids) {
        const n = NOTIZEN[j];
        if (!n) {
          fehler.push(`${id}: Notiz ${j} gibt es nicht`);
          continue;
        }
        if (rang[b.stufe] < rang[ausNotiz[n.confidence]]) fehler.push(`${id}: ${b.stufe}, die Notiz ${j} sagt ${n.confidence}`);
      }
      // Our own proofs (photo, physics) say so in their check.
      if (!ids.length) expect(b.gegenprobe.length, id).toBeGreaterThan(20);
    }
    expect(fehler).toEqual([]);
  });

  it('draws nothing that rests on an unsure note alone', () => {
    // The ones the notes call "unsicher": the knob on the AiO, + and GND of the knob on the AiO+, the speaker switch-off and
    // headphone detection circuits on the Classic, the battery on the Classic, the poti supply on the Every.
    for (const unsicher of ['aio-encoder-clk', 'ap-drehgeber-plus', 'oas-v29', 'oas-v24', 'oas-v40', 'ev-poti-vcc']) expect(NOTIZEN[unsicher].confidence).toBe('unsicher');
    const every = { ...DEFAULT_WAHL, nano: 'every' as const };
    expect(extras(every).find((x) => x.id === 'poti')?.plan).toBeNull();
    for (const platine of ['aio', 'aioplus'] as const)
      for (const id of ['drehgeber', 'poti'] as const) {
        const x = extras({ ...DEFAULT_WAHL, platine }).find((e) => e.id === id)!;
        expect(x.plan, `${platine} ${id}`).toBeNull();
        expect(x.fehlt?.beweis, `${platine} ${id}`).toBeTruthy();
      }
    for (const id of ['lsaus', 'hperkennung', 'wecker', 'akkumessung', 'usbc'] as const) expect(extras(DEFAULT_WAHL).find((x) => x.id === id)?.plan).toBeNull();
  });
});

describe('Lötplan extras', () => {
  it('say for every extra without a picture why, and what would prove it', () => {
    for (const w of alleWahlen())
      for (const x of extras(w)) {
        if (x.plan) {
          expect(x.fehlt, `${name(w)} ${x.id}`).toBeUndefined();
          expect(x.teile.length, `${name(w)} ${x.id}`).toBeGreaterThan(0);
        } else expect(x.fehlt ?? x.gesperrt, `${name(w)} ${x.id}`).toBeTruthy();
        expect(x.firmware.length, `${name(w)} ${x.id}`).toBeGreaterThan(10);
      }
  });

  it('keep the knob to 3 buttons and to A3/A4, the ring with its resistor at D5', () => {
    const fuenf = extras({ ...DEFAULT_WAHL, tasten: 5 });
    expect(fuenf.find((x) => x.id === 'drehgeber')?.gesperrt).toMatch(/3 Tasten/);
    expect(fuenf.find((x) => x.id === 'poti')?.gesperrt).toMatch(/3 Tasten/);
    const dreh = extras(DEFAULT_WAHL).find((x) => x.id === 'drehgeber')!.plan!;
    expect(dreh.kabel.filter((k) => k.tng).map((k) => `${k.tng!.pin}→${k.nach[1]}`)).toEqual(['A3→CLK', 'A4→DT']);
    const ring = extras(DEFAULT_WAHL).find((x) => x.id === 'ring')!.plan!;
    expect(ring.kabel.map((k) => `${k.von.join('.')}→${k.nach.join('.')}`)).toEqual(expect.arrayContaining(['leiste.D5→r470.a', 'r470.b→ring.DIN', 'audio.5V→ring.5V', 'elko.+→ring.5V', 'elko.−→ring.GND']));
    const aioPlus = extras({ ...DEFAULT_WAHL, platine: 'aioplus' }).find((x) => x.id === 'ring')!;
    expect(aioPlus.plan!.kabel.find((k) => k.tng)?.tng?.pin).toBe('PB2');
    expect(aioPlus.firmware).toMatch(/ALLinONE_Plus_5f/);
  });

  it('switch off what shares a pin, and remember the choice', () => {
    waehle({ ...DEFAULT_WAHL, extras: [] });
    schalteExtra('drehgeber');
    schalteExtra('ring');
    expect(loetplanWahl.value.extras).toEqual(['drehgeber', 'ring']);
    schalteExtra('poti');
    expect(loetplanWahl.value.extras).toEqual(['poti', 'ring']);
    schalteExtra('ledtasten');
    expect(loetplanWahl.value.extras).toEqual(['poti', 'ledtasten']);
    schalteExtra('poti');
    expect(loetplanWahl.value.extras).toEqual(['ledtasten']);
    expect(toWahl({ extras: ['ring', 'esp32', 'drehgeber'] }).extras).toEqual(['drehgeber', 'ring']);
    expect(toWahl({ nano: 'every' }).nano).toBe('every');
    waehle({ ...DEFAULT_WAHL });
  });

  it('send the Nano to the Firmware-Baukasten of the app, the Nano Every and the AiO+ elsewhere', () => {
    const fw = (w: Partial<LoetplanWahl>, id: string) => extras({ ...DEFAULT_WAHL, ...w }).find((x) => x.id === id)!.firmware;
    for (const id of ['drehgeber', 'poti', 'ring', 'ledtasten', 'lsaus', 'hperkennung']) {
      expect(fw({}, id), id).toMatch(/„Firmware aufspielen“/);
      expect(fw({ nano: 'every' }, id), id).not.toMatch(/„Firmware aufspielen“/);
    }
    expect(fw({ platine: 'aio' }, 'drehgeber')).toMatch(/„Firmware aufspielen“/);
    expect(fw({ platine: 'aioplus' }, 'drehgeber')).not.toMatch(/„Firmware aufspielen“/);
    expect(fw({ platine: 'aio' }, 'ring')).toMatch(/passt nicht/);
  });

  it('warns about D6 wherever SPKONOFF or the LED of „Vor“ use it, and loudly when both are chosen', () => {
    for (const nano of ['nano', 'every'] as const) {
      const alle = extras({ ...DEFAULT_WAHL, nano });
      for (const id of ['lsaus', 'ledtasten']) expect(alle.find((x) => x.id === id)!.text, `${nano} ${id}`).toContain(D6_WARNING);
    }
    expect(D6_WARNING).toMatch(/SPKONOFF/);
    expect(D6_WARNING).toMatch(/Bluetooth/);
    const beide = { ...DEFAULT_WAHL, extras: ['ledtasten', 'lsaus'] as LoetplanWahl['extras'] };
    expect(d6Konflikt(beide)).toMatch(/brauchen beide D6/);
    expect(d6Konflikt({ ...beide, extras: ['lsaus'] })).toBeUndefined();
    expect(d6Konflikt({ ...beide, extras: ['ledtasten', 'ring'] })).toBeUndefined();
    // On the AiO neither extra exists.
    expect(d6Konflikt({ ...beide, platine: 'aio' })).toBeUndefined();
  });

  it('warns loudly when the LED buttons and the battery measurement both want A5', () => {
    // TNG constants.hpp:405 (voltageMeasurementPin) and 508 (led_play_pin).
    const beide = { ...DEFAULT_WAHL, extras: ['ledtasten', 'akkumessung'] as LoetplanWahl['extras'] };
    expect(a5Konflikt(beide)).toMatch(/brauchen beide A5/);
    expect(a5Konflikt({ ...beide, nano: 'every' })).toMatch(/brauchen beide A5/);
    expect(a5Konflikt({ ...beide, extras: ['akkumessung'] })).toBeUndefined();
    expect(a5Konflikt({ ...beide, platine: 'aio' })).toBeUndefined();
    for (const id of ['ledtasten', 'akkumessung']) expect(extras(DEFAULT_WAHL).find((x) => x.id === id)!.text.join(' '), id).toMatch(/A5/);
  });

  it('explains the alarm start at A6 with the facts of the firmware, without a picture', () => {
    for (const nano of ['nano', 'every'] as const) {
      const x = extras({ ...DEFAULT_WAHL, nano }).find((e) => e.id === 'wecker')!;
      expect(x.plan, nano).toBeNull();
      expect(x.text.join(' '), nano).toMatch(/A6/);
      expect(x.text.join(' '), nano).toMatch(/Titel 1 aus Ordner 01/);
      expect(x.fehlt?.beweis, nano).toBeTruthy();
    }
    expect(extras(DEFAULT_WAHL).find((e) => e.id === 'wecker')!.text.join(' ')).toMatch(/512 von 1023/);
    expect(extras({ ...DEFAULT_WAHL, nano: 'every' }).find((e) => e.id === 'wecker')!.firmware).toMatch(/SPECIAL_START_SHORTCUT/);
    // The pin and its level as TNG has them (tests/fixtures/tng/constants.hpp).
    const constants = readFileSync(new URL('../fixtures/tng/constants.hpp', import.meta.url), 'utf8');
    expect(constants).toMatch(/specialStartShortcutPin\s+= A6;/);
    expect(constants).toMatch(/specialStartShortcutPinType = levelType::activeHigh;/);
    // Not on the AiO boards.
    expect(extras({ ...DEFAULT_WAHL, platine: 'aio' }).some((e) => e.id === 'wecker')).toBe(false);
  });

  it('shows only the chosen extras that fit', () => {
    const w = { ...DEFAULT_WAHL, tasten: 5 as const, extras: ['drehgeber', 'pololu'] as LoetplanWahl['extras'] };
    expect(gewaehlteExtras(w).map((x) => x.id)).toEqual(['pololu']);
  });
});
