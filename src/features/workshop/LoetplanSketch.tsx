/**
 * The soldering picture of the "Lötplan" for the Classic v1.7 board: the
 * board with its pads and print, the parts around it (card reader, buttons,
 * headphone board or socket, speaker, power) and a coloured wire for every
 * connection.
 *
 * The drawing started as the stand-alone "Lötbild" page
 * (bauassistent/loetbild): same pins, same wire colours. It is laid out
 * first (loetplanSzene) and drawn after, so the tests can check what the
 * screen shows: every pin name sits on a free spot, on a small plate, and no
 * wire or pad lies on top of it. The button wires reach their pads through
 * the gap between two ground pads instead of across the print.
 *
 * The wobble is in the shapes themselves (wobbly.ts, loetplanGeo.ts), not an
 * SVG filter: the desktop app on Linux drops filtered shapes once the
 * picture is large on the screen, and then the wires and parts were missing.
 *
 * No hooks: a plain function of the choice and the step (the tests call it).
 */
import type { JSX } from 'preact';
import { bezier, platziere, sKurve, strecke, treffer, wackeln, type Anker, type Draht, type Pt, type Rect, type Vorschlag } from './loetplanGeo';
import { body, DRAHT_BREITE, drahtSvg, etikettSvg, FLACH_BREITE, handBreite, look, neueSzene, padSvg, tapeBox, tapeSvg, type Szene } from './loetplanLook';
import { wobblyRect } from './wobbly';
import { aufbau, audio, AUDIO, B, dfp, F, H, linksGnd, LINKS_INNEN, linksInnen, LOCH_R, LOECHER, mm, nano, R7, RFID, rfid, stellePunkt, toSvg, W, wahlText, type LoetplanWahl, type Schritt, type Teil } from './loetplan';

/** What a screen reader hears instead of the picture. */
export function sketchLabel(w: LoetplanWahl): string {
  return `Lötplan: ${wahlText(w)}. Jede Farbe ist ein Kabel. Alle Kabel stehen auch in der Liste unter dem Bild.`;
}

const PAD_R = 8;
const SILK = '#f4f1ea';
const BOARD = '#141414';
/** Size of the print next to the pads. */
const PIN_GR = 11.5;

interface Gelegt {
  szene: Szene;
  svg: JSX.Element;
}

/** Lays out the whole picture: the tests use the returned scene. */
export function loetplanSzene(wahl: LoetplanWahl, schritt: Schritt = 0, markiere: readonly string[] = []): Gelegt {
  const l = look();
  const amp = l.wobble / 2;
  const s = neueSzene();
  const unten = wahl.ansicht === 'unten';
  const P = (p: Pt) => toSvg(p, wahl.ansicht);
  const A = aufbau(wahl);
  const blass = (n: number) => (schritt === 0 || schritt === n ? 1 : 0.18);
  const labels: JSX.Element[] = [];
  /** A label with its plate, placed at the first free spot. */
  const setze = (
    key: string,
    txt: string,
    size: number,
    orte: Vorschlag[],
    o: {
      fill: string;
      plate: string | 'papier' | null;
      hand?: boolean;
      op?: number;
      auf?: Rect;
    },
  ) => {
    const e = platziere(key, txt, size, orte, s, s.konflikte, o.hand ? handBreite(txt, size) : undefined, o.auf);
    labels.push(etikettSvg(e, o));
  };
  const rectBetween = (p1: Pt, p2: Pt) => {
    const a = P(p1);
    const b = P(p2);
    return {
      x: Math.min(a.x, b.x),
      y: a.y,
      width: Math.abs(b.x - a.x),
      height: b.y - a.y,
    };
  };

  /* ------------------------------------------------------------ the board */
  const board: JSX.Element[] = [];
  {
    const r = rectBetween({ x: B.x0, y: B.y0 }, { x: B.x1, y: B.y1 });
    board.push(body(l, 'board', 'rect', { ...r, fill: BOARD }, { stroke: '#000', 'stroke-width': 2 }));
  }
  // The mounting holes, to scale (3D data).
  LOECHER.forEach((h, i) => {
    const q = P(h);
    board.push(
      padSvg(s, { x: q.x, y: q.y, r: LOCH_R }, `hole${i}`, {
        fill: 'var(--surface)',
        stroke: '#b08d57',
        width: 2,
      }),
    );
  });
  const outline = (key: string, r: { x: number; y: number; width: number; height: number }, width: number, extra: Record<string, string | number> = {}) => <rect key={key} {...r} fill="none" stroke={SILK} stroke-width={width} {...extra} />;
  /** Print on the board, at a fixed place; the check still makes sure nothing covers it. */
  const silk = (key: string, p: Pt, txt: string, size: number, dx = 0, dy = 0, anchor: Anker = 'middle') => {
    const q = P(p);
    setze(key, txt, size, [{ x: q.x + dx, y: q.y + dy + size * 0.36, anchor }], { fill: SILK, plate: BOARD });
  };
  // White ground area beside A0 to A5
  board.push(<rect key="gnd-area" {...rectBetween(mm(6.6, 30.1), mm(22.2, 28.1))} fill={SILK} opacity={unten ? 0.15 : 0.9} />);
  if (!unten) {
    // Outline of the Nano, its USB socket, the MP3 player; small resistors already on the board
    // The Nano (18 × 45 mm) over its sockets, the MP3 player (20.7 mm square) over its rows.
    board.push(outline('o-nano', rectBetween(mm(0.8, 24.04), mm(45.8, 6.03)), 1.6));
    board.push(outline('o-usb', rectBetween({ x: 690, y: 55 }, { x: 870, y: 200 }), 1.4));
    board.push(outline('o-dfp', rectBetween(mm(45.45, 25.36), mm(66.15, 4.66)), 1.6));
    [
      [700, 260],
      [735, 260],
      [700, 340],
      [735, 340],
      [700, 430],
      [735, 430],
      [805, 430],
      [R7.x, R7.y],
    ].forEach((r, i) => {
      const q = P({ x: r[0], y: r[1] });
      board.push(<rect key={`r${i}`} x={q.x - 4} y={q.y - 7} width={8} height={14} fill="#555" stroke="#ddd" stroke-width={0.8} />);
    });
  } else {
    board.push(outline('o-dfp', rectBetween(mm(45.45, 25.36), mm(66.15, 4.66)), 1.2, { 'stroke-dasharray': '6 5', opacity: 0.7 }));
    const v5 = P(audio(0));
    board.push(<circle key="v5" cx={v5.x} cy={v5.y} r={14} fill="none" stroke="#ff4d4d" stroke-width={3} />);
  }

  /* ------------------------------------------------------------ pads */
  const hl1 = schritt === 1;
  const sockets: JSX.Element[] = [];
  const padLook = (hl = false) => ({
    fill: hl ? '#ffe066' : '#c8c2b6',
    stroke: hl ? '#ff9f1c' : '#8d877c',
    width: hl ? 3 : 1,
    hole: true,
  });
  const pad = (p: Pt, key: string, hl = false) => {
    const q = P(p);
    return padSvg(s, { x: q.x, y: q.y, r: PAD_R }, key, padLook(hl));
  };
  for (let i = 0; i < 15; i++) sockets.push(pad(nano(i, 0), `n0-${i}`, hl1), pad(nano(i, 1), `n1-${i}`, hl1));
  for (let i = 0; i < 8; i++) sockets.push(pad(dfp(i, 0), `d0-${i}`, hl1), pad(dfp(i, 1), `d1-${i}`, hl1));
  const pads: JSX.Element[] = [];
  for (let i = 0; i < 15; i++) pads.push(pad(linksInnen(i), `li${i}`));
  for (let i = 0; i < 6; i++) pads.push(pad(linksGnd(i), `lg${i}`));
  for (let i = 0; i < 8; i++) pads.push(pad(rfid(i), `rf${i}`));
  for (let i = 0; i < 7; i++) pads.push(pad(audio(i), `au${i}`));

  /* ------------------------------------------------------------ parts */
  const teileSv: JSX.Element[] = [];
  const partLabels: [number, () => void][] = [];
  const find = (id: string) => A.teile.find((t) => t.id === id);
  const flaeche = (r: Rect) => s.flaechen.push(r);
  /** A pin of a part; its print goes inside the part, away from the wire. */
  const partPin = (key: string, x: number, y: number, txt: string, L: boolean, plate: string, op: number, auf: Rect) => {
    teileSv.push(
      padSvg(s, { x, y, r: 6 }, key, {
        fill: '#d9d4c7',
        stroke: '#555',
        width: 1,
      }),
    );
    partLabels.push([op, () => setze(`${key}-t`, txt, 12, [{ x: L ? x - 13 : x + 13, y: y + 4.5, anchor: L ? 'end' : 'start' }], { fill: '#fff', plate, op, auf })]);
  };
  const partTitle = (key: string, x: number, y: number, txt: string, plate: string, op: number, auf: Rect, fill = '#fff', size = 14) =>
    partLabels.push([
      op,
      () =>
        setze(key, txt, size, [{ x, y, anchor: 'middle' }], {
          fill,
          plate,
          op,
          auf,
        }),
    ]);

  // RC522
  const rc = find('rc522')!;
  let rcPinX: number;
  {
    const L = rc.seite === 'L';
    const yTop = P(rfid(0)).y;
    const yBot = P(rfid(7)).y;
    const x = L ? 30 : 790;
    const w = 180;
    const pinX = L ? x + w - 14 : x + 14;
    const namen = ['3.3V', 'RST', 'GND', 'IRQ', 'MISO', 'MOSI', 'SCK', 'SDA'];
    const op = blass(2);
    const r = { x, y: yTop - 44, w, h: yBot - yTop + 84 };
    teileSv.push(
      <g key="rc522" opacity={op}>
        {body(l, 'rc-body', 'rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#1d5aa6' }, { stroke: '#0d3466', 'stroke-width': 2 })}
      </g>,
    );
    flaeche(r);
    partTitle('rc-name', x + w / 2, yTop - 20, 'Kartenleser RC522', '#1d5aa6', op, r);
    namen.forEach((n, i) => partPin(`rcp${i}`, pinX, P(rfid(i)).y, n, L, '#1d5aa6', op, r));
    rcPinX = pinX;
  }
  // Buttons
  interface Taste extends Teil {
    cx: number;
    cy: number;
    L: boolean;
    bein: [Pt, Pt];
  }
  const tn: Taste[] = A.teile
    .filter((t) => t.id.startsWith('taste'))
    .map((t, i) => {
      const L = t.seite === 'L';
      const cx = L ? 95 : 905;
      const cy = 210 + i * 112;
      const bx = L ? cx + 38 : cx - 38;
      const op = blass(3);
      teileSv.push(
        <g key={t.id} opacity={op}>
          {body(l, `${t.id}-ring`, 'circle', {
            cx,
            cy,
            r: 30,
            fill: '#3a3a3a',
          })}
          <circle cx={cx} cy={cy} r={23} fill={t.farbe} stroke="#0006" stroke-width={2} />
          <rect x={bx - 4} y={cy - 16} width={8} height={8} fill="#bbb" />
          <rect x={bx - 4} y={cy + 8} width={8} height={8} fill="#bbb" />
        </g>,
      );
      flaeche({ x: cx - 34, y: cy - 34, w: 68, h: 68 });
      partLabels.push([
        op,
        () =>
          setze(
            `${t.id}-name`,
            t.name ?? '',
            14,
            [
              { x: cx, y: cy + 52, anchor: 'middle' },
              { x: cx, y: cy + 60, anchor: 'middle' },
            ],
            { fill: 'var(--text)', plate: 'papier', hand: true, op },
          ),
      ]);
      return {
        ...t,
        cx,
        cy,
        L,
        bein: [
          { x: bx, y: cy - 12 },
          { x: bx, y: cy + 12 },
        ],
      };
    });
  // Headphone board or socket
  const kh = find('kh');
  const ls = find('ls')!;
  const lsL = ls.seite === 'L';
  let khPinX = 0;
  let khSp: Pt = { x: 0, y: 0 };
  if (kh?.typ === 'buchse') {
    const L = kh.seite === 'L';
    const x = L ? 30 : 780;
    const w = 190;
    const y0 = P(audio(2)).y;
    const y1 = P(audio(5)).y;
    const pinX = L ? x + w - 14 : x + 14;
    const kn = ['1  Masse', '4  rechts', '3  links', '5  Schalter'];
    const y7 = y1 + 34;
    const op = blass(4);
    const r = { x, y: y0 - 70, w, h: y1 - y0 + 124 };
    teileSv.push(
      <g key="kh" opacity={op}>
        {body(l, 'kh-body', 'rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#5d5d5d' }, { stroke: '#2b2b2b', 'stroke-width': 2 })}
      </g>,
    );
    flaeche(r);
    partTitle('kh-name', x + w / 2, y0 - 46, 'Klinkenbuchse FC68129', '#5d5d5d', op, r, '#fff', 13);
    kn.forEach((t, j) => partPin(`khp${j}`, pinX, P(audio(j + 2)).y, t, L, '#5d5d5d', op, r));
    partPin('khp7', pinX, y7, '7  zum Lautsprecher', L, '#5d5d5d', op, r);
    partTitle('kh-note', x + w / 2, y0 - 25, 'Vorher durchpiepen!', '#5d5d5d', op, r, '#ffe9a8', 12);
    khPinX = pinX;
    khSp = { x: pinX, y: y7 };
  } else if (kh) {
    const L = kh.seite === 'L';
    const x = L ? 30 : 780;
    const w = 190;
    const y0 = P(audio(2)).y;
    const y1 = P(audio(6)).y;
    const pinX = L ? x + w - 14 : x + 14;
    const kn = ['G', 'DR', 'DL', 'SK', 'SK'];
    const bxx = L ? x + 40 : x + w - 40;
    const spX = L ? x + w - 50 : x + 50;
    const op = blass(4);
    const r = { x, y: y0 - 50, w, h: y1 - y0 + 154 };
    teileSv.push(
      <g key="kh" opacity={op}>
        {body(l, 'kh-body', 'rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#2f7d3a' }, { stroke: '#1b4d22', 'stroke-width': 2 })}
        <path d={wobblyRect(bxx - 22, y1 + 30, 44, 46, amp, 'kh-socket')} fill="#222" />
        <circle cx={bxx} cy={y1 + 53} r={9} fill="#000" stroke="#888" stroke-width={2} />
        <rect x={spX - 18} y={y1 + 50} width={36} height={14} fill="#ddd" />
      </g>,
    );
    flaeche(r);
    partTitle('kh-name', x + w / 2, y0 - 26, 'Kopfhörerplatine', '#2f7d3a', op, r);
    kn.forEach((t, j) => partPin(`khp${j}`, pinX, P(audio(j + 2)).y, t, L, '#2f7d3a', op, r));
    partTitle('kh-buchse', bxx, y1 + 94, 'Buchse', '#2f7d3a', op, r, '#fff', 11);
    partTitle('kh-speaker', spX, y1 + 42, 'Speaker', '#2f7d3a', op, r, '#fff', 11);
    khPinX = pinX;
    khSp = { x: spX, y: y1 + 64 };
  }
  // Speaker
  const lsx = lsL ? 120 : 880;
  const lsy = 1000;
  {
    const op = blass(4);
    teileSv.push(
      <g key="ls" opacity={op}>
        {body(l, 'ls-body', 'circle', { cx: lsx, cy: lsy, r: 44, fill: '#2b2b2b' }, { stroke: '#000', 'stroke-width': 2 })}
        <circle cx={lsx} cy={lsy} r={26} fill="#4a4a4a" />
        <circle cx={lsx} cy={lsy} r={9} fill="#777" />
      </g>,
    );
    flaeche({ x: lsx - 46, y: lsy - 46, w: 92, h: 92 });
    partLabels.push([
      op,
      () =>
        setze(
          'ls-name',
          'Lautsprecher',
          15,
          [
            {
              x: lsx + (lsL ? 60 : -60),
              y: lsy + 5,
              anchor: lsL ? 'start' : 'end',
            },
            { x: lsx, y: lsy + 66, anchor: 'middle' },
          ],
          { fill: 'var(--text)', plate: 'papier', hand: true, op },
        ),
    ]);
  }
  const lsPins: [Pt, Pt] = [
    { x: lsx - 10, y: lsy - 44 },
    { x: lsx + 10, y: lsy - 44 },
  ];
  // Power: a mains adapter or power bank, its cable into the USB socket of the Nano.
  const strom = !unten && find('strom');
  let usbIn: Pt = { x: 0, y: 0 };
  let stromOut: Pt = { x: 0, y: 0 };
  if (strom) {
    const op = blass(5);
    const r = { x: 580, y: 24, w: 260, h: 54 };
    teileSv.push(
      <g key="strom" opacity={op}>
        {body(l, 'strom-body', 'rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#4a4a4a' }, { stroke: '#222', 'stroke-width': 2 })}
      </g>,
    );
    flaeche(r);
    partTitle('strom-name', r.x + r.w / 2, r.y + 23, 'Netzteil oder Powerbank', '#4a4a4a', op, r, '#fff', 14);
    partTitle('strom-5v', r.x + r.w / 2, r.y + 42, '5 Volt, USB', '#4a4a4a', op, r, '#ffe9a8', 11);
    const usb = rectBetween({ x: 690, y: 55 }, { x: 870, y: 200 });
    usbIn = { x: usb.x + usb.width / 2, y: usb.y + 20 };
    stromOut = { x: r.x, y: r.y + r.h / 2 };
  }

  /* ------------------------------------------------------------ wires */
  const kabelSv: JSX.Element[] = [];
  const lege = (key: string, pts: Pt[], farbe: string, op: number, flach = false) => {
    const d: Draht = {
      key,
      pts: wackeln(pts, flach ? amp / 2 : amp, key),
      breite: flach ? FLACH_BREITE : DRAHT_BREITE,
    };
    s.draehte.push(d);
    kabelSv.push(drahtSvg(d, farbe, op, flach));
  };
  const pitch = P(linksInnen(1)).y - P(linksInnen(0)).y;
  A.kabel.forEach((k, i) => {
    const op = blass(k.schritt);
    const key = `k${i}`;
    if (k.gruppe === 'rfid') {
      if (k.frei || !k.farbe || !k.von.p) return;
      const p1 = P(k.von.p);
      lege(key, sKurve(p1, { x: rcPinX, y: p1.y }), k.farbe, op);
    } else if (k.gruppe === 'taste') {
      const t = tn[k.taste ?? 0];
      const p1 = P(k.von.p!);
      const e = t.bein[k.beinchen ?? 0];
      const dir = t.L ? 1 : -1;
      if (k.beinchen === 0) {
        // Through the gap between two ground pads, then onto the A pad from the side of the column.
        const row = LINKS_INNEN.indexOf(k.von.txt as (typeof LINKS_INNEN)[number]);
        const gx = P(linksGnd(row)).x;
        const chY = p1.y - pitch / 2;
        const ein = { x: gx - dir * 24, y: chY };
        const mid = { x: (gx + p1.x) / 2, y: chY };
        const vor = bezier(e, { x: e.x + dir * 70, y: e.y }, { x: ein.x - dir * 70, y: chY }, ein);
        lege(key, [...vor, ...strecke([ein, mid, p1], 6).slice(1)], k.farbe!, op);
      } else {
        lege(key, bezier(e, { x: e.x + dir * 70, y: e.y }, { x: p1.x - dir * 80, y: p1.y }, p1), k.farbe!, op);
      }
    } else if (k.gruppe === 'kh') {
      const p1 = P(k.von.p!);
      lege(key, sKurve(p1, { x: khPinX, y: p1.y }), k.farbe!, op);
    } else if (k.gruppe === 'ls') {
      const down = (a: Pt, b: Pt) => bezier(a, { x: a.x, y: a.y + 60 }, { x: b.x, y: b.y - 70 }, b);
      if (kh?.typ === 'buchse') {
        if (k.von.p) {
          const a = P(k.von.p);
          lege(key, bezier(a, { x: a.x + (lsL ? -60 : 60), y: a.y }, { x: lsPins[0].x, y: lsPins[0].y - 90 }, lsPins[0]), F.minus, op);
        } else lege(key, down(khSp, lsPins[1]), F.plus, op);
      } else if (kh) {
        lege(`${key}a`, down({ x: khSp.x - 8, y: khSp.y }, lsPins[0]), F.minus, op);
        lege(`${key}b`, down({ x: khSp.x + 8, y: khSp.y }, lsPins[1]), F.plus, op);
      } else {
        const a = P(k.von.p!);
        const b = lsPins[k.nach.pin ?? 0];
        lege(key, bezier(a, { x: a.x + (lsL ? -50 : 50) + (k.nach.pin ?? 0) * 12, y: a.y }, { x: b.x, y: b.y - 80 }, b), k.farbe!, op);
      }
    } else if (k.gruppe === 'strom' && strom) {
      lege(key, strecke([stromOut, { x: usbIn.x, y: stromOut.y }, usbIn], 16), F.usb, op, true);
    }
  });
  const plug: JSX.Element[] = [];
  if (strom) plug.push(<rect key="plug" x={usbIn.x - 11} y={usbIn.y - 4} width={22} height={26} rx={3} fill="#3a3a3a" stroke="#999" stroke-width={1.2} opacity={blass(5)} />);

  /* ------------------------------------------------------------ print on the board, then the pin names */
  if (unten) {
    silk('s-unten', { x: 800, y: 1530 }, 'Unterseite (Lötseite)', 16);
    silk('s-verkehrt', { x: 800, y: 1530 }, 'alles seitenverkehrt', 13, 0, 24);
    silk('s-andere', { x: 755, y: 1455 }, 'auf der anderen Seite: MP3-Player', 11);
  } else {
    silk('s-usb', { x: 780, y: 165 }, 'USB', 11);
    silk('s-nano', { x: 780, y: 760 }, wahl.nano === 'every' ? 'Arduino Nano Every' : 'Arduino Nano', 15);
    silk('s-classic', { x: 780, y: 1150 }, 'TonUINO Classic v1.7', 12);
    silk('s-dfp', { x: 770, y: 1610 }, 'DFPlayer Mini', 14);
    silk('s-pin1', dfp(0, 0), '1', 12, 0, -22);
    silk('s-sd', { x: 366, y: 1600 }, 'SD', 11, 0, -10);
    silk('s-card', { x: 366, y: 1600 }, 'Card', 11, 0, 9);
    silk('s-mfrc', { x: 1120, y: 205 }, 'MFRC522', 10);
    silk('s-r7', R7, 'R7', 11, 8, 0, 'start');
  }
  /** Print beside a pad: towards the given point first, then the other side, then above or below. */
  const pinText = (key: string, p: Pt, txt: string, zu: Pt) => {
    const q = P(p);
    const r = P(zu).x > q.x;
    const off = PAD_R + 4.5;
    const y = q.y + PIN_GR * 0.36;
    setze(
      key,
      txt,
      PIN_GR,
      [
        { x: r ? q.x + off : q.x - off, y, anchor: r ? 'start' : 'end' },
        { x: r ? q.x - off : q.x + off, y, anchor: r ? 'end' : 'start' },
        { x: q.x, y: q.y - off - 3, anchor: 'middle' },
        { x: q.x, y: q.y + off + PIN_GR * 0.8 + 1, anchor: 'middle' },
      ],
      { fill: SILK, plate: BOARD },
    );
  };
  for (let i = 0; i < 15; i++) pinText(`lit${i}`, linksInnen(i), LINKS_INNEN[i], nano(i, 0));
  for (let i = 0; i < 8; i++) pinText(`rft${i}`, rfid(i), RFID[i], nano(i, 1));
  for (let i = 0; i < 7; i++) pinText(`aut${i}`, audio(i), AUDIO[i], dfp(0, unten));
  {
    // The ground column has its name above it, as on the board.
    const q = P(linksGnd(0));
    setze(
      'lg-name',
      'GND',
      PIN_GR,
      [0, 6, 12].map((d) => ({
        x: q.x,
        y: q.y - pitch / 2 - 13 - d,
        anchor: 'middle' as const,
      })),
      { fill: SILK, plate: BOARD },
    );
  }
  partLabels.forEach(([, f]) => f());

  /* ------------------------------------------------------------ notes */
  const notiz: JSX.Element[] = [];
  /** A note at the first free spot; it must not hide a pad, a wire or a label. */
  const tape = (key: string, orte: Pt[], txt: string, gr: number) => {
    const frei = orte.find((o) => !treffer(tapeBox(l, o.x, o.y, txt, gr), s).length);
    const o = frei ?? orte[0];
    const box = tapeBox(l, o.x, o.y, txt, gr);
    if (!frei) s.konflikte.push(`Notiz „${txt}“: ${treffer(box, s).join(', ')}`);
    s.flaechen.push(box);
    notiz.push(tapeSvg(l, o.x, o.y, txt, gr, key));
  };
  const um = (p: Pt, d: [number, number][]) => d.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy }));
  if (!unten) {
    if (schritt === 0 || schritt === 5) {
      tape(
        'usb',
        um({ x: 330, y: 92 }, [
          [0, 0],
          [-20, -10],
          [-40, 6],
        ]),
        'Nano so einstecken: USB-Buchse oben',
        15,
      );
      tape(
        'sd',
        um({ x: 180, y: 820 }, [
          [0, 0],
          [0, 40],
          [0, -40],
          [0, 80],
        ]),
        'DFPlayer: SD-Schlitz nach links',
        14,
      );
    }
    if (schritt === 2)
      tape(
        'v33',
        um(P(rfid(0)), [
          [90, -70],
          [100, -66],
          [0, -70],
          [150, -80],
          [120, -100],
          [60, -105],
        ]),
        '3,3 V – nie 5 V!',
        15,
      );
    if (schritt === 4)
      tape(
        'v5',
        um(P(audio(0)), [
          [0, -40],
          [-30, -40],
          [60, -42],
          [-60, -34],
          [120, -30],
          [150, -50],
          [110, -70],
        ]),
        '5V frei lassen',
        13,
      );
    if (schritt === 1) {
      tape(
        'l15',
        um(P({ x: 780, y: 620 }), [
          [0, 0],
          [0, 30],
          [0, -30],
        ]),
        '2× 15er-Leiste',
        15,
      );
      tape(
        'l8',
        um(P({ x: 770, y: 1480 }), [
          [0, 0],
          [0, -14],
          [0, 14],
        ]),
        '2× 8er-Leiste',
        15,
      );
    }
  } else {
    tape(
      'flip',
      um(P({ x: 775, y: 60 }), [
        [0, -30],
        [0, -40],
      ]),
      'Seitlich umdrehen wie eine Buchseite – MP3-Player bleibt unten',
      14,
    );
  }

  /* ------------------------------------------------------------ "prüf diese Stelle" (Box testen) */
  const marken: JSX.Element[] = [];
  const punkte = markiere.map((id) => stellePunkt(id)).filter((p): p is Pt => !!p);
  punkte.forEach((p, i) => {
    const q = P(p);
    marken.push(
      <g key={`mark${i}`} class="lp-mark">
        <circle cx={q.x} cy={q.y} r={17} fill="none" stroke="#fff" stroke-width={8} />
        <circle cx={q.x} cy={q.y} r={17} fill="none" stroke="#e0262f" stroke-width={4.5} />
      </g>,
    );
  });
  if (punkte.length) {
    // The label goes to the first free spot around the first joint, with a line to its ring.
    const q = P(punkte[0]);
    const orte: Vorschlag[] = [];
    for (const d of [56, 86, 120, 160, 210, 270])
      for (const deg of [-90, -135, -45, 180, 0, 135, 45, 90, -112, -68, 158, 22, 202, -22, 112, 68]) {
        const a = (deg * Math.PI) / 180;
        const c = Math.cos(a);
        orte.push({ x: q.x + d * c, y: q.y + d * Math.sin(a) + 6, anchor: c < -0.3 ? 'end' : c > 0.3 ? 'start' : 'middle' });
      }
    const e = platziere('mark-text', 'Prüfe diese Stelle', 17, orte, s, s.konflikte);
    const cx = e.box.x + e.box.w / 2;
    const cy = e.box.y + e.box.h / 2;
    const d = Math.hypot(cx - q.x, cy - q.y) || 1;
    marken.push(<line key="mark-line" x1={q.x + ((cx - q.x) / d) * 19} y1={q.y + ((cy - q.y) / d) * 19} x2={cx} y2={cy} stroke="#e0262f" stroke-width={3} />);
    labels.push(etikettSvg(e, { fill: '#fff', plate: '#e0262f' }));
  }

  const svg = (
    <svg class="lp-sketch lp-holz" viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg" role="img" aria-label={sketchLabel(wahl)}>
      {board}
      <g opacity={blass(1)}>{sockets}</g>
      {pads}
      <g>{kabelSv}</g>
      {plug}
      {teileSv}
      {marken}
      {labels}
      {notiz}
    </svg>
  );
  return { szene: s, svg };
}

export function LoetplanSketch({ wahl, schritt = 0, markiere }: { wahl: LoetplanWahl; schritt?: Schritt; markiere?: readonly string[] }) {
  return loetplanSzene(wahl, schritt, markiere).svg;
}
