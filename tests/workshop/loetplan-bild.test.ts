/**
 * The big picture of the Lötplan 0.6 (loetplanBild.ts) against the firmware
 * the app flashes (TNG d527ca5, pin table tngPins.ts, itself read line by
 * line from constants.hpp in tngpins.test.ts) and against the proofs
 * (loetplanBelege.ts):
 * - every wire at a pin of the microcontroller sits on the pin TNG uses for
 *   its function, on the board's own table, and its list line names the pin;
 * - every wire starts and ends on a pad or part of the picture;
 * - no pin carries two functions in one picture;
 * - a wire is drawn as sure, "check first" or dashed "?" exactly as its
 *   proofs say, and every "?" is explained in the note beside the picture;
 * - every chosen extra that fits gets its step.
 * For every board, both Arduinos, 3 and 5 buttons, every headphone choice,
 * every extra alone and every set of extras that fits together.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_WAHL, EXTRAS, SCHLIESST_AUS, type ExtraId, type LoetplanWahl } from '../../src/features/workshop/loetplan';
import { BELEGE, stufeVon } from '../../src/features/workshop/loetplanBelege';
import { bild, chipsVon, drahtSvg, listeVon, teilsOffen, type Bild } from '../../src/features/workshop/loetplanBild';
import { extras } from '../../src/features/workshop/loetplanVerdrahtung';
import { TNG_PINS } from '../../src/features/workshop/tngPins';

/** All extras of a board that fit together, greedily, in two orders, so every pair of neighbours is drawn once. */
function passendeSaetze(ids: ExtraId[]): ExtraId[][] {
  const out: ExtraId[][] = [];
  for (const reihe of [ids, [...ids].reverse()]) {
    const satz: ExtraId[] = [];
    for (const id of reihe) if (!satz.some((x) => SCHLIESST_AUS[x]?.includes(id))) satz.push(id);
    out.push(satz);
  }
  return out;
}

function alleWahlen(): LoetplanWahl[] {
  const out: LoetplanWahl[] = [];
  for (const platine of ['classic', 'aio', 'aioplus'] as const)
    for (const nano of ['nano', 'every'] as const)
      for (const tasten of [3, 5] as const)
        for (const kh of ['platine', 'buchse', 'keine'] as const) {
          if (platine !== 'classic' && (kh !== 'platine' || nano !== 'nano')) continue;
          const ids = chipsVon(platine).filter((x) => x !== 'pololu');
          const basis = { ...DEFAULT_WAHL, platine, nano, tasten, kh };
          out.push({ ...basis, extras: [] });
          for (const id of [...ids, 'pololu' as const]) out.push({ ...basis, extras: [id] });
          for (const satz of passendeSaetze(ids)) out.push({ ...basis, extras: satz });
          for (const schalter of [2, 3, 4] as const) out.push({ ...basis, extras: ['schalter'], schalter });
        }
  return out;
}

const WAHLEN = alleWahlen();
const BILDER: [LoetplanWahl, Bild][] = WAHLEN.map((w) => [w, bild(w)!]);
const name = (w: LoetplanWahl) => `${w.platine} ${w.nano} ${w.tasten} Tasten ${w.kh} [${w.extras.join(', ')}]`;
const MCU_PIN = /^(A\d|D\d{1,2}|P[A-F]\d)$/;
const nah = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;

describe('Lötplan 0.6: the picture', () => {
  it('has a picture for every board and every choice, the Classic without board keeps its old one', () => {
    for (const [w, b] of BILDER) expect(b, name(w)).toBeTruthy();
    expect(bild({ ...DEFAULT_WAHL, platine: 'frei' })).toBeNull();
    expect(bild({ ...DEFAULT_WAHL, ansicht: 'unten' })).toBeNull();
    expect(WAHLEN.length).toBeGreaterThan(150);
  });

  it('puts every wire at a pin of the microcontroller on the pin TNG uses, and names it', () => {
    const fehler: string[] = [];
    let geprueft = 0;
    for (const [w, b] of BILDER)
      for (const d of b.drahte) {
        if (!d.tng) continue;
        geprueft++;
        if (d.tng.platine !== b.platine) fehler.push(`${name(w)}: ${d.von}→${d.nach} nach der Tabelle von ${d.tng.platine}`);
        const e = TNG_PINS[b.platine][d.tng.funktion];
        if (!e) fehler.push(`${name(w)}: TNG kennt ${d.tng.funktion} auf ${b.platine} nicht`);
        else if (e.pin !== d.tng.pin) fehler.push(`${name(w)}: ${d.von}→${d.nach} an ${d.tng.pin}, TNG sagt ${e.pin} (${e.name})`);
        if (!new RegExp(`\\b${d.tng.pin}\\b`).test(d.von)) fehler.push(`${name(w)}: „${d.von}“ nennt den Pin ${d.tng.pin} nicht`);
        // The pad it starts at carries the same pin.
        const pad = d.a ? b.anker[d.a] : undefined;
        if (pad?.pin && pad.pin !== d.tng.pin) fehler.push(`${name(w)}: ${d.von}→${d.nach} beginnt an ${d.a} (${pad.pin}), TNG-Pin ${d.tng.pin}`);
      }
    expect(fehler).toEqual([]);
    expect(geprueft).toBeGreaterThan(1000);
  });

  it('marks every wire at a pin of the microcontroller with its TNG function', () => {
    const fehler: string[] = [];
    for (const [w, b] of BILDER)
      for (const d of b.drahte)
        for (const ende of [d.a, d.b]) {
          const pin = ende ? b.anker[ende]?.pin : undefined;
          if (pin && MCU_PIN.test(pin) && d.tng?.pin !== pin) fehler.push(`${name(w)}: ${d.von}→${d.nach} endet an ${ende} (${pin}) ohne TNG-Pin`);
        }
    expect(fehler).toEqual([]);
  });

  it('lets every wire start and end on a pad or part of the picture', () => {
    const fehler: string[] = [];
    for (const [w, b] of BILDER)
      for (const d of b.drahte) {
        if (d.a && !b.anker[d.a]) fehler.push(`${name(w)}: Anker ${d.a} fehlt`);
        if (d.b && !b.anker[d.b]) fehler.push(`${name(w)}: Anker ${d.b} fehlt`);
        const enden = [d.pts[0], d.pts[d.pts.length - 1]];
        if (d.a && b.anker[d.a] && !enden.some((p) => nah(p, b.anker[d.a!].p))) fehler.push(`${name(w)}: ${d.von}→${d.nach} liegt nicht auf ${d.a}`);
        if (d.b && b.anker[d.b] && !enden.some((p) => nah(p, b.anker[d.b!].p))) fehler.push(`${name(w)}: ${d.von}→${d.nach} liegt nicht auf ${d.b}`);
      }
    expect(fehler).toEqual([]);
  });

  it('never gives one pin two functions', () => {
    const fehler: string[] = [];
    for (const [w, b] of BILDER) {
      const belegt = new Map<string, string>();
      for (const d of b.drahte) {
        if (!d.tng) continue;
        const vorher = belegt.get(d.tng.pin);
        if (vorher && vorher !== d.tng.funktion) fehler.push(`${name(w)}: ${d.tng.pin} für ${vorher} und ${d.tng.funktion}`);
        belegt.set(d.tng.pin, d.tng.funktion);
      }
    }
    expect(fehler).toEqual([]);
  });

  it('draws each wire as its proofs say: sure, check first, or dashed with "?"', () => {
    const fehler: string[] = [];
    for (const [w, b] of BILDER)
      for (const d of b.drahte) {
        if (!d.belege.length) fehler.push(`${name(w)}: ${d.von}→${d.nach} ohne Beleg`);
        for (const id of d.belege) if (!(id in BELEGE)) fehler.push(`${name(w)}: unbekannter Beleg ${id}`);
        if (d.stufe !== stufeVon(d.belege)) fehler.push(`${name(w)}: ${d.von}→${d.nach} ist ${d.stufe}, die Belege sagen ${stufeVon(d.belege)}`);
        const svg = drahtSvg(d);
        const gestrichelt = svg.includes('stroke-dasharray="11 8"');
        if (gestrichelt !== (d.stufe === 'ungeprueft')) fehler.push(`${name(w)}: ${d.von}→${d.nach} ${d.stufe}, gestrichelt: ${gestrichelt}`);
        if (d.stufe === 'ungeprueft' && !svg.includes('>?</text>')) fehler.push(`${name(w)}: ${d.von}→${d.nach} ohne „?“`);
        if (d.stufe === 'geprueft' && (svg.includes('>?</text>') || svg.includes('rotate(-6)'))) fehler.push(`${name(w)}: ${d.von}→${d.nach} sicher, aber mit Zeichen`);
        if (d.stufe === 'nachsehen' && !svg.includes('rotate(-6)')) fehler.push(`${name(w)}: ${d.von}→${d.nach} ohne „!“`);
      }
    expect(fehler).toEqual([]);
  });

  it('explains every "?" in the note beside the picture, and puts "?" on the chip of an extra that has one', () => {
    const fehler: string[] = [];
    for (const [w, b] of BILDER) {
      for (const d of b.drahte.filter((x) => x.stufe === 'ungeprueft')) {
        const extra = b.schritte.find((s) => s.key === d.schritt)?.extra;
        if (!b.offen.some((o) => o.stufe === 'ungeprueft' && o.extra === extra)) fehler.push(`${name(w)}: „?“ an ${d.von}→${d.nach} ohne Erklärung`);
        if (extra && !teilsOffen(w, extra)) fehler.push(`${name(w)}: ${extra} hat ein „?“ im Bild, aber nicht am Kästchen`);
      }
      for (const o of b.offen) if (o.warum.length < 20) fehler.push(`${name(w)}: ${o.titel} ohne Grund`);
    }
    expect(fehler).toEqual([]);
  });

  it('gives every chosen extra that fits a step, and every wire a step', () => {
    const fehler: string[] = [];
    for (const [w, b] of BILDER) {
      const passt = extras(w).filter((x) => w.extras.includes(x.id) && !x.gesperrt);
      for (const x of passt) if (!b.schritte.some((s) => s.extra === x.id)) fehler.push(`${name(w)}: ${x.id} ohne Schritt`);
      for (const s of b.schritte.filter((s) => s.extra)) if (!passt.some((x) => x.id === s.extra)) fehler.push(`${name(w)}: Schritt ${s.extra} nicht gewählt`);
      expect(b.schritte.map((s) => s.nr), name(w)).toEqual(b.schritte.map((_, i) => i + 1));
      for (const d of b.drahte) if (!b.schritte.some((s) => s.key === d.schritt)) fehler.push(`${name(w)}: ${d.von} im Schritt ${d.schritt}, den es nicht gibt`);
      for (const s of b.schritte) {
        const r = s.bereich;
        if (!(r.x1 > r.x0 && r.y1 > r.y0)) fehler.push(`${name(w)}: Schritt ${s.key} ohne Bereich`);
        const [mx, my] = [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
        if (mx < b.box.x0 || my < b.box.y0 || mx > b.box.x1 || my > b.box.y1) fehler.push(`${name(w)}: Schritt ${s.key} außerhalb des Bilds`);
      }
    }
    expect(fehler).toEqual([]);
  });

  it('keeps the smallest text big enough for 14 px on a phone without zooming beyond 1.6', () => {
    for (const [w, b] of BILDER) expect(14 / b.minSchrift, name(w)).toBeLessThanOrEqual(1.6);
  });
});

describe('Lötplan 0.6: the pins of each board', () => {
  const pins = (w: Partial<LoetplanWahl>, schritt: string) =>
    bild({ ...DEFAULT_WAHL, ...w })!
      .drahte.filter((d) => d.schritt === schritt && d.tng)
      .map((d) => `${d.tng!.pin}:${d.tng!.funktion}`);

  it('Classic: buttons, knob, poti, ring, LED buttons, alarm start, battery, headphones, speaker off, Pololu', () => {
    expect(pins({ tasten: 3 }, 'tasten')).toEqual(['A0:pause', 'A1:up3', 'A2:down3']);
    expect(pins({ tasten: 5 }, 'tasten').sort()).toEqual(['A0:pause', 'A1:four5', 'A2:five5', 'A3:up5', 'A4:down5']);
    expect(pins({ extras: ['drehgeber'] }, 'drehgeber')).toEqual(['A3:encClk', 'A4:encDt']);
    expect(pins({ extras: ['poti'] }, 'poti')).toEqual(['A3:poti']);
    expect(pins({ extras: ['ring'] }, 'ring')).toEqual(['D5:ring']);
    expect(new Set(pins({ extras: ['ledtasten'] }, 'ledtasten'))).toEqual(new Set(['A5:ledPlay', 'D6:ledUp', 'D5:ledDown']));
    expect(new Set(pins({ extras: ['wecker'] }, 'wecker'))).toEqual(new Set(['A6:specialStart']));
    expect(pins({ extras: ['akkumessung'] }, 'akkumessung')).toEqual(['A5:batVoltage']);
    expect(pins({ extras: ['hperkennung'] }, 'hperkennung')).toEqual(['D8:hpDetect']);
    expect(pins({ extras: ['lsaus'] }, 'lsaus')).toEqual(['D6:spkOnOff']);
    expect(pins({ extras: ['pololu'] }, 'pololu')).toEqual(['D7:shutdown']);
  });

  it('AiO: buttons at the Button-Adapter, knob at V− (A3) and V+ (A4), ring at D5', () => {
    expect(pins({ platine: 'aio' }, 'tasten').sort()).toEqual(['A0:pause', 'A1:down3', 'A2:up3']);
    expect(pins({ platine: 'aio', extras: ['drehgeber'] }, 'drehgeber')).toEqual(['A3:encClk', 'A4:encDt']);
    expect(pins({ platine: 'aio', extras: ['poti'] }, 'poti')).toEqual(['A3:poti']);
    expect(pins({ platine: 'aio', extras: ['ring'] }, 'ring')).toEqual(['D5:ring']);
    // Proven by the research of 27.10.2026: no "?" on the knob of the AiO.
    const b = bild({ ...DEFAULT_WAHL, platine: 'aio', extras: ['drehgeber'] })!;
    expect(b.drahte.filter((d) => d.schritt === 'drehgeber').every((d) => d.stufe !== 'ungeprueft')).toBe(true);
  });

  it('AiO+: knob at PF2/PF3, poti at PF4, ring at PB2', () => {
    expect(pins({ platine: 'aioplus', extras: ['drehgeber'] }, 'drehgeber')).toEqual(['PF2:encClk', 'PF3:encDt']);
    expect(pins({ platine: 'aioplus', extras: ['poti'] }, 'poti')).toEqual(['PF4:poti']);
    expect(pins({ platine: 'aioplus', extras: ['ring'] }, 'ring')).toEqual(['PB2:ring']);
  });

  it('lists each step with its wires in their colours, a shared GND last', () => {
    const b = bild({ ...DEFAULT_WAHL, tasten: 3 })!;
    const zeilen = listeVon(b, 'tasten');
    expect(zeilen.map((z) => z.von)).toEqual(['A0', 'A1', 'A2', 'GND']);
    expect(zeilen.every((z) => z.farbe)).toBe(true);
  });

  it('says on the AiO+ what firmware there is, instead of only „Firmware fehlt“', () => {
    // The app cannot build or check firmware for the ATmega4809 (docs/FIRMWARE-BAUKASTEN.md): it says so, and what works.
    const drei = bild({ ...DEFAULT_WAHL, platine: 'aioplus', tasten: 3, extras: ['drehgeber', 'ring'] })!;
    expect(drei.teile).not.toContain('Firmware fehlt');
    expect(drei.teile).toContain('Firmware: selbst bauen');
    expect(drei.teile).toContain('Fertig nur mit 5 Tasten');
    expect(drei.schritte.find((x) => x.key === 'drehgeber')?.kurz).toMatch(/baust du selbst/);
    const fuenf = bild({ ...DEFAULT_WAHL, platine: 'aioplus', tasten: 5, extras: ['ring'] })!;
    expect(fuenf.teile).not.toContain('Fertig nur mit 5 Tasten');
    expect(fuenf.schritte.find((x) => x.key === 'ring')?.kurz).toMatch(/„5 Tasten mit allen Extras“/);
    const plan = (w: LoetplanWahl, id: ExtraId) => extras(w).find((x) => x.id === id)!.firmware;
    expect(plan({ ...DEFAULT_WAHL, platine: 'aioplus' }, 'drehgeber')).toMatch(/„Eigene Datei“.*ATmega4809.*prüfen/);
    expect(plan({ ...DEFAULT_WAHL, platine: 'aioplus', tasten: 3 }, 'ring')).toMatch(/nur mit 5 Tasten.*NEO_RING.*„Eigene Datei“/);
    expect(plan({ ...DEFAULT_WAHL, platine: 'aioplus', tasten: 5 }, 'ring')).toMatch(/„5 Tasten mit allen Extras“/);
  });

  it('offers on each board only the extras it has', () => {
    expect(chipsVon('aio')).toEqual(['drehgeber', 'poti', 'ring', 'akku']);
    expect(chipsVon('classic').every((x) => EXTRAS.includes(x))).toBe(true);
  });
});
