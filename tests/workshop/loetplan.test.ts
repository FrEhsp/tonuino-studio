import { describe, expect, it } from 'vitest';
import type { VNode } from 'preact';
import { parseHash, routeToHash } from '../../src/app/router';
import { aufbau, DEFAULT_WAHL, F, FARBNAMEN, loetplanWahl, PLATINEN, toWahl, waehle, warnung, type LoetplanWahl } from '../../src/features/workshop/loetplan';
import { LoetplanSketch } from '../../src/features/workshop/LoetplanSketch';
import { LoetplanSchema } from '../../src/features/workshop/LoetplanSchema';
import { extras, schema, type SchemaPlan } from '../../src/features/workshop/loetplanVerdrahtung';
import { LoetplanTool } from '../../src/features/workshop/LoetplanTool';
import { WorkshopPage } from '../../src/features/workshop/WorkshopPage';

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

const texts = (els: El[]) => els.filter((e) => e.type === 'text').map((e) => [e.props.children].flat().join(''));
/** The coloured caps of the buttons in the picture. */
const caps = (els: El[]) => els.filter((e) => e.type === 'circle' && e.props.r === 23).map((e) => e.props.fill);
const draw = (w: LoetplanWahl) => flatten(LoetplanSketch({ wahl: w }));

describe('Lötplan route', () => {
  it('opens at #/werkstatt/loetplan and goes back to the same address', () => {
    expect(parseHash('#/werkstatt/loetplan')).toEqual({ page: 'workshop', tool: 'loetplan' });
    expect(routeToHash({ page: 'workshop', tool: 'loetplan' })).toBe('#/werkstatt/loetplan');
  });

  it('is the tool the Werkstatt shows there', () => {
    const page = WorkshopPage({ tool: 'loetplan' }) as VNode;
    expect(page.type).toBe(LoetplanTool);
  });
});

describe('Lötplan variant switch', () => {
  it('draws 3 or 5 buttons on A0 to A2 or A4, each with its ground wire', () => {
    const three = aufbau({ ...DEFAULT_WAHL, tasten: 3 });
    expect(three.tasten.map((t) => t[0])).toEqual(['A0', 'A1', 'A2']);
    expect(three.kabel.filter((k) => k.gruppe === 'taste')).toHaveLength(6);
    expect(caps(draw({ ...DEFAULT_WAHL, tasten: 3 }))).toEqual([F.play, F.vor, F.zur]);

    const five = aufbau({ ...DEFAULT_WAHL, tasten: 5 });
    expect(five.tasten.map((t) => `${t[0]} ${t[1]}`)).toEqual(['A0 Play/Pause', 'A1 Lauter', 'A2 Leiser', 'A3 Vor', 'A4 Zurück']);
    expect(five.kabel.filter((k) => k.gruppe === 'taste' && k.beinchen === 1).every((k) => k.farbe === F.gnd)).toBe(true);
    expect(caps(draw({ ...DEFAULT_WAHL, tasten: 5 }))).toEqual([F.play, F.laut, F.leis, F.vor, F.zur]);
    expect(warnung(3, { ...DEFAULT_WAHL, tasten: 5 })).toMatch(/Firmware-Variante für 5 Tasten/);
  });

  it('wires the headphone board, a single socket or only the speaker, as in the source page', () => {
    const board = aufbau({ ...DEFAULT_WAHL, kh: 'platine' }).kabel.filter((k) => k.gruppe === 'kh');
    expect(board.map((k) => `${k.von.txt}→${k.nach.txt}`)).toEqual(['GND→G', 'R→DR', 'L→DL', '+→SK', '−→SK']);
    const socket = aufbau({ ...DEFAULT_WAHL, kh: 'buchse' }).kabel.filter((k) => k.gruppe === 'kh' || k.gruppe === 'ls');
    expect(socket.map((k) => `${k.von.txt}→${k.nach.txt ?? k.nach.teil}`)).toEqual(['GND→1', 'R→4', 'L→3', '+→5', '7→ls', '−→−']);
    const none = aufbau({ ...DEFAULT_WAHL, kh: 'keine' }).kabel.filter((k) => k.gruppe === 'ls' || k.gruppe === 'kh');
    expect(none.map((k) => k.von.txt)).toEqual(['+', '−']);
    expect(texts(draw({ ...DEFAULT_WAHL, kh: 'buchse' }))).toContain('Klinkenbuchse FC68129');
    expect(texts(draw({ ...DEFAULT_WAHL, kh: 'keine' }))).not.toContain('Kopfhörerplatine');
  });

  it('keeps the card reader 1:1 on 3.3 V with IRQ free', () => {
    const rf = aufbau(DEFAULT_WAHL).kabel.filter((k) => k.gruppe === 'rfid');
    expect(rf.find((k) => k.von.txt === '3V3')?.farbe).toBe(F.v33);
    expect(rf.find((k) => k.von.txt === 'IRQ')).toMatchObject({ frei: true, farbe: null });
  });

  it('mirrors the picture from below and says so', () => {
    const below = texts(draw({ ...DEFAULT_WAHL, ansicht: 'unten' }));
    expect(below).toContain('Unterseite (Lötseite)');
    expect(aufbau({ ...DEFAULT_WAHL, ansicht: 'unten' }).teile.find((t) => t.id === 'rc522')?.seite).toBe('L');
    expect(aufbau(DEFAULT_WAHL).teile.find((t) => t.id === 'rc522')?.seite).toBe('R');
  });

  it('remembers a choice and reads anything odd as the default', () => {
    waehle({ tasten: 5, kh: 'keine' });
    expect(loetplanWahl.value).toEqual({ platine: 'classic', tasten: 5, kh: 'keine', ansicht: 'oben', nano: 'nano', extras: [] });
    waehle({ ...DEFAULT_WAHL });
    expect(toWahl({ tasten: 4, kh: 'x', ansicht: 'seitlich' })).toEqual(DEFAULT_WAHL);
    expect(toWahl({ kh: false })).toMatchObject({ kh: 'keine' });
    expect(toWahl(null)).toEqual(DEFAULT_WAHL);
    expect(toWahl({ platine: 'aioplus' })).toMatchObject({ platine: 'aioplus' });
    expect(toWahl({ platine: 'esp32' })).toMatchObject({ platine: 'classic' });
  });

  it('powers the Classic over the USB socket of the Nano and names R7 on the board', () => {
    const strom = aufbau(DEFAULT_WAHL).kabel.filter((k) => k.gruppe === 'strom');
    expect(strom).toHaveLength(1);
    expect(strom[0].text).toMatch(/Netzteil oder Powerbank/);
    expect(texts(draw(DEFAULT_WAHL))).toEqual(expect.arrayContaining(['Netzteil oder Powerbank', 'R7']));
  });
});

describe('Lötplan for the other boards', () => {
  const ids = (plan: SchemaPlan | null) => (plan?.kabel ?? []).map((k) => `${k.von.join('.')}→${k.nach.join('.')}`);

  it('wires the Classic without board with the 1 kΩ resistor, BUSY and power', () => {
    const plan = schema({ ...DEFAULT_WAHL, platine: 'frei' });
    expect(ids(plan)).toEqual(
      expect.arrayContaining(['strom.USB→nano.USB', 'nano.D2→dfp.p3', 'nano.D3→r1k.a', 'r1k.b→dfp.p2', 'nano.D4→dfp.p16', 'nano.5V→dfp.p1', 'nano.GNDu→dfp.p10', 'nano.3V3→rc522.3.3V', 'nano.D10→rc522.SDA', 'dfp.p8→kh.SK2', 'kh.S2→ls.1']),
    );
    expect(plan?.teile.find((t) => t.id === 'r1k')?.name).toBe('1 kΩ');
    // The card reader never gets 5 V.
    expect(plan?.kabel.filter((k) => k.nach[0] === 'rc522' && k.farbe === F.v5)).toEqual([]);
  });

  it('draws the MP3 player of the Classic without board from above, as in its data sheet', () => {
    for (const kh of ['platine', 'buchse', 'keine'] as const) {
      const dfp = schema({ ...DEFAULT_WAHL, platine: 'frei', kh })!.teile.find((t) => t.id === 'dfp')!;
      const pin = (n: number) => dfp.pins.find((p) => p.id === `p${n}`)!;
      // Pin 1 (square pad) bottom left, 1 … 8 left to right, 16 … 9 above them:
      // counter-clockwise like every part seen from above, never mirrored.
      expect(pin(1)).toMatchObject({ seite: 'U', txt: 'VCC', eckig: true });
      for (let n = 1; n < 8; n++) expect(pin(n + 1).at).toBeGreaterThan(pin(n).at);
      for (let n = 1; n <= 8; n++) expect(pin(17 - n)).toMatchObject({ seite: 'O', at: pin(n).at });
      expect(pin(16).txt).toBe('BUSY');
      expect(dfp.pins.filter((p) => p.eckig)).toHaveLength(1);
      expect(dfp.notiz?.join(' ')).toMatch(/von oben/);
    }
  });

  it('names the colour of every wire in the lists', () => {
    const fehlt: string[] = [];
    for (const platine of PLATINEN)
      for (const tasten of [3, 5] as const)
        for (const kh of ['platine', 'buchse', 'keine'] as const) {
          const w = { ...DEFAULT_WAHL, platine, tasten, kh };
          const plans = [schema(w), ...extras(w).map((x) => x.plan)].filter((p) => p !== null);
          const kabel = [...(platine === 'classic' ? aufbau(w).kabel : []), ...plans.flatMap((p) => p.kabel)];
          for (const k of kabel) if (k.farbe && !FARBNAMEN[k.farbe]) fehlt.push(`${k.farbe}: ${k.text}`);
        }
    expect(fehlt).toEqual([]);
  });

  it('puts Play/Pause of the AiO and AiO+ on PBP and PBN, never on GND', () => {
    for (const platine of ['aio', 'aioplus'] as const) {
      for (const tasten of [3, 5] as const) {
        const plan = schema({ ...DEFAULT_WAHL, platine, tasten });
        const play = plan!.kabel.filter((k) => k.text.includes('Play/Pause'));
        expect(play.map((k) => k.nach[1])).toEqual(['s2', 'g2']);
        expect(plan!.teile.find((t) => t.id === 'adapter')!.pins.find((p) => p.id === 'g2')!.txt).toBe('PBN');
        expect(plan!.teile.filter((t) => t.form === 'taste')).toHaveLength(tasten);
      }
    }
  });

  it('offers the extras that fit, the rotary knob only with 3 buttons', () => {
    expect(extras({ ...DEFAULT_WAHL, platine: 'classic' }).map((x) => x.id)).toEqual(['drehgeber', 'poti', 'ring', 'ledtasten', 'schalter', 'pololu', 'dauerled', 'akku', 'lsaus', 'hperkennung', 'wecker', 'akkumessung', 'usbc']);
    expect(extras({ ...DEFAULT_WAHL, platine: 'classic', tasten: 5 }).find((x) => x.id === 'drehgeber')?.plan).toBeNull();
    expect(extras({ ...DEFAULT_WAHL, platine: 'aio' }).map((x) => x.id)).toEqual(['drehgeber', 'poti', 'ring', 'akku']);
    const pololu = extras({ ...DEFAULT_WAHL, platine: 'frei' }).find((x) => x.id === 'pololu')!.plan!;
    expect(ids(pololu)).toEqual(expect.arrayContaining(['nano.D7→pololu.OFF', 'nano.5V→pololu.VOUT', 'pb.+ rot→pololu.VINr']));
    expect(pololu.teile[0].pins.map((p) => p.txt)).not.toContain('VIN');
    // On the board the extras go to the left row and the audio row, drawn whole with their print.
    const brett = extras(DEFAULT_WAHL).find((x) => x.id === 'pololu')!.plan!;
    expect(ids(brett)).toEqual(expect.arrayContaining(['leiste.D7→pololu.OFF', 'audio.5V→pololu.VOUT']));
    expect(brett.teile.find((t) => t.id === 'leiste')!.pins.map((p) => p.txt)).toEqual(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'GND', 'GND', 'D8', 'D7', 'D6', 'D5', 'GND']);
  });

  it('draws the wiring picture with every pin name', () => {
    const plan = schema({ ...DEFAULT_WAHL, platine: 'aioplus' })!;
    const t = texts(flatten(LoetplanSchema({ plan, label: 'x' })));
    expect(t).toEqual(expect.arrayContaining(['AiO+-Platine', 'PBP', 'PBN', 'V+', 'SPEAKER (8)', 'NFC (13)', 'MISO']));
  });
});

describe('Lötplan: on/off switch', () => {
  const schalter = (w: Partial<LoetplanWahl>) => extras({ ...DEFAULT_WAHL, extras: ['schalter'], ...w }).find((x) => x.id === 'schalter')!;

  it('asks for the legs of the switch first and draws nothing before', () => {
    const x = schalter({});
    expect(x.frage?.text).toBe('Wie viele Beinchen hat dein Schalter?');
    expect(x.frage?.optionen.map((o) => o.wert)).toEqual([2, 3, 4]);
    expect(x.frage?.gewaehlt).toBeUndefined();
    expect(x.plan).toBeNull();
    expect(toWahl({ ...DEFAULT_WAHL, schalter: 3 }).schalter).toBe(3);
    expect(toWahl({ ...DEFAULT_WAHL, schalter: 7 })).not.toHaveProperty('schalter');
  });

  it('runs only the red wire through the switch, and keeps the data wires', () => {
    const zwei = schalter({ schalter: 2 }).plan!;
    expect(zwei.kabel.map((k) => `${k.von.join('.')}→${k.nach.join('.')}`)).toEqual(['pb.rot→sw.1', 'sw.2→box.rot']);
    expect(zwei.kabel.every((k) => /rote Ader/i.test(k.text))).toBe(true);
    expect(zwei.frei?.[0].text).toContain('Grün und Weiß');
    const drei = schalter({ schalter: 3 }).plan!;
    expect(drei.kabel.map((k) => `${k.von.join('.')}→${k.nach.join('.')}`)).toEqual(['pb.rot→sw.M', 'sw.A→box.rot']);
    expect(drei.frei?.map((f) => f.text)).toContain('Das andere äußere Beinchen bleibt frei');
    const x = schalter({ schalter: 2 });
    expect(x.tabelle?.zeilen.map((z) => z[0])).toEqual(['Rot', 'Schwarz', 'Grün und Weiß']);
    expect(x.warnung).toContain('Stecker am Nano');
    expect(x.links?.map((l) => l.href)).toEqual(['https://bluetchen.de/FSU/TonUINO_FSU.html', 'https://discourse.voss.earth/t/usb-kabel-aufdroesseln-um-schalter-einzubauen/952/9']);
  });

  it('does not draw a switch with 4 legs, and warns about 12-V battery shields', () => {
    const vier = schalter({ schalter: 4 });
    expect(vier.plan).toBeNull();
    expect(vier.fehlt?.beweis).toContain('Beschriftung der Beinchen');
    for (const n of [2, 3, 4] as const) expect(schalter({ schalter: n }).text.join(' ')).toMatch(/nur ein Shield mit 5-V-Ausgang.*12 V.*zerstört Nano und MP3-Player/);
  });

  it('is only for boxes without their own power switch', () => {
    expect(extras({ ...DEFAULT_WAHL, platine: 'aio' }).map((x) => x.id)).not.toContain('schalter');
    expect(extras({ ...DEFAULT_WAHL, platine: 'frei', nano: 'every' }).map((x) => x.id)).toContain('schalter');
  });
});
