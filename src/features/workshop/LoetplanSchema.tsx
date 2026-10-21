/**
 * A wiring picture of the Lötplan for the boards without their own board
 * drawing (Classic without board, AiO, AiO+) and for the extras: the parts
 * of loetplanVerdrahtung.ts as boxes with their pins, one coloured wire per
 * connection, the pin names on small plates inside the parts.
 *
 * Laid out first (schemaSzene), then drawn; the tests check the layout:
 * no label under a wire or pin, no wire across a part it does not belong to.
 * No hooks: a plain function of the plan (the tests call it).
 */
import type { JSX } from 'preact';
import { bezier, drahtTrifft, platziere, strecke, wackeln, type Pt, type Rect, type Vorschlag } from './loetplanGeo';
import { body, DRAHT_BREITE, drahtSvg, etikettSvg, FLACH_BREITE, handBreite, look, neueSzene, padSvg, type Szene } from './loetplanLook';
import { pinPunkt, type SchemaPlan, type STeil } from './loetplanVerdrahtung';
import { wobblyCircle, wobblyRect } from './wobbly';

const PIN_R = 6;

/** The area of a part that no foreign wire may cross. */
function kern(t: STeil): Rect {
  const e = 4;
  return { x: t.x + e, y: t.y + e, w: t.w - 2 * e, h: t.h - 2 * e };
}

interface Gelegt {
  szene: Szene;
  svg: JSX.Element[];
}

export function schemaSzene(plan: SchemaPlan): Gelegt {
  const l = look();
  const amp = l.wobble / 2;
  const s = neueSzene();
  const teil = (id: string) => plan.teile.find((t) => t.id === id)!;
  const bodies: JSX.Element[] = [];
  const wires: JSX.Element[] = [];
  const pinsSvg: JSX.Element[] = [];
  const labels: JSX.Element[] = [];

  // Parts are areas a label from outside must keep clear of.
  const flaeche = new Map<string, Rect>();
  for (const t of plan.teile) {
    const r = { x: t.x, y: t.y, w: t.w, h: t.h };
    flaeche.set(t.id, r);
    s.flaechen.push(r);
  }

  /* ------------------------------------------------------------ wires first, labels keep off them */
  plan.kabel.forEach((k, i) => {
    const ta = teil(k.von[0]);
    const tb = teil(k.nach[0]);
    const a = pinPunkt(ta, ta.pins.find((p) => p.id === k.von[1])!);
    const b = pinPunkt(tb, tb.pins.find((p) => p.id === k.nach[1])!);
    let pts: Pt[];
    if (k.via) {
      pts = strecke([a, ...k.via, b]);
    } else {
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const c = Math.max(24, Math.min(140, dist * 0.42));
      pts = bezier(a, { x: a.x + a.dx * c, y: a.y + a.dy * c }, { x: b.x + b.dx * c, y: b.y + b.dy * c }, b);
    }
    const d = {
      key: `${plan.id}-k${i}`,
      pts: wackeln(pts, k.flach ? amp / 2 : amp, `${plan.id}-k${i}`),
      breite: k.flach ? FLACH_BREITE : DRAHT_BREITE,
    };
    s.draehte.push(d);
    wires.push(drahtSvg(d, k.farbe, 1, k.flach));
    // A wire must not run across a part it does not connect.
    for (const t of plan.teile) {
      if (t.id === ta.id || t.id === tb.id) continue;
      if (drahtTrifft(d, kern(t), -1)) s.konflikte.push(`Kabel „${k.text}“ läuft über ${t.name}`);
    }
  });

  /* ------------------------------------------------------------ parts, pins, labels */
  for (const t of plan.teile) {
    const schrift = t.schrift ?? '#fff';
    // Labels inside a part may sit on the part's own area.
    const setze = (key: string, txt: string, size: number, orte: Vorschlag[], o: { fill: string; plate: string | 'papier' | null; hand?: boolean }, drin = true) => {
      const e = platziere(`${plan.id}-${t.id}-${key}`, txt, size, orte, s, s.konflikte, o.hand ? handBreite(txt, size) : undefined, drin ? flaeche.get(t.id) : undefined);
      labels.push(etikettSvg(e, o));
    };
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    const form = t.form ?? 'kasten';
    if (form === 'kasten' || form === 'drehknopf') {
      bodies.push(body(l, `${plan.id}-${t.id}`, 'rect', { x: t.x, y: t.y, width: t.w, height: t.h, fill: t.farbe }, { stroke: '#0008', 'stroke-width': 2 }));
      if (form === 'drehknopf') {
        bodies.push(<path key={`${t.id}-knob`} d={wobblyCircle(t.x + t.w - 62, cy + 20, 38, amp, `${t.id}-knob`)} fill="#9aa3ad" stroke="#333" stroke-width={2} />);
        bodies.push(<circle key={`${t.id}-axis`} cx={t.x + t.w - 62} cy={cy + 20} r={12} fill="#555" />);
      }
    } else if (form === 'taste') {
      bodies.push(
        body(l, `${plan.id}-${t.id}-ring`, 'circle', {
          cx,
          cy,
          r: t.w / 2,
          fill: '#3a3a3a',
        }),
      );
      bodies.push(<circle key={`${t.id}-cap`} cx={cx} cy={cy} r={t.w / 2 - 7} fill={t.farbe} stroke="#0006" stroke-width={2} />);
    } else if (form === 'lautsprecher') {
      bodies.push(body(l, `${plan.id}-${t.id}`, 'circle', { cx, cy, r: t.w / 2, fill: t.farbe }, { stroke: '#000', 'stroke-width': 2 }));
      bodies.push(<circle key={`${t.id}-cone`} cx={cx} cy={cy} r={t.w * 0.3} fill="#4a4a4a" />);
      bodies.push(<circle key={`${t.id}-dome`} cx={cx} cy={cy} r={t.w * 0.1} fill="#777" />);
    } else if (form === 'ring') {
      const r = t.w / 2;
      // A tab with the solder pads, under the ring.
      bodies.push(
        body(l, `${plan.id}-${t.id}-tab`, 'rect', {
          x: t.x,
          y: t.y + 60,
          width: 90,
          height: 150,
          fill: '#1b1b1b',
        }),
      );
      bodies.push(<path key={`${t.id}-ring`} d={`${wobblyCircle(cx, cy, r, amp, `${t.id}-o`)} ${wobblyCircle(cx, cy, r - 34, amp, `${t.id}-i`)}`} fill="#1b1b1b" fill-rule="evenodd" stroke={l.ink?.color ?? '#000'} stroke-width={2} />);
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * 2 * Math.PI;
        const x = cx + (r - 17) * Math.cos(a);
        const y = cy + (r - 17) * Math.sin(a);
        bodies.push(<rect key={`${t.id}-led${k}`} x={x - 6} y={y - 6} width={12} height={12} rx={2} fill={['#ff4d6d', '#ffd23f', '#3bceac', '#4d9de0'][k % 4]} transform={`rotate(${(k / 24) * 360} ${x} ${y})`} />);
      }
    } else if (form === 'widerstand') {
      bodies.push(<rect key={`${t.id}-r`} x={t.x} y={t.y} width={t.w} height={t.h} rx={5} fill={t.farbe} stroke="#6b5a3a" stroke-width={1.5} />);
      // Colour bands across the body, standing or lying.
      const liegend = t.w > t.h;
      ['#6b3e1f', '#111', '#d62828'].forEach((c, k) =>
        bodies.push(liegend ? <rect key={`${t.id}-b${k}`} x={t.x + 12 + k * 10} y={t.y} width={5} height={t.h} fill={c} /> : <rect key={`${t.id}-b${k}`} x={t.x} y={t.y + 12 + k * 10} width={t.w} height={5} fill={c} />),
      );
    } else if (form === 'led') {
      // A 5 mm LED: round dome, a rim at the bottom, flat on the minus side.
      const r = t.w / 2;
      const rand = t.y + t.h - 16;
      bodies.push(<path key={`${t.id}-dome`} d={`M ${t.x} ${rand} L ${t.x} ${t.y + r} A ${r} ${r} 0 0 1 ${t.x + t.w} ${t.y + r} L ${t.x + t.w} ${rand} Z`} fill={t.farbe} stroke="#0007" stroke-width={2} />);
      bodies.push(<rect key={`${t.id}-rim`} x={t.x - 4} y={rand} width={t.w + 8} height={10} rx={2} fill={t.farbe} stroke="#0007" stroke-width={2} />);
      bodies.push(<circle key={`${t.id}-glow`} cx={t.x + r} cy={t.y + r} r={r * 0.45} fill="#fffbe0" opacity={0.9} />);
    } else if (form === 'elko') {
      bodies.push(<path key={`${t.id}-e`} d={wobblyRect(t.x, t.y, t.w, t.h, amp / 2, `${t.id}-e`)} fill={t.farbe} stroke="#0008" stroke-width={2} />);
      // The minus stripe on the side of the minus leg.
      const minusLinks = (t.pins.find((p) => p.id === '−')?.at ?? 0) < t.w / 2;
      bodies.push(<rect key={`${t.id}-stripe`} x={minusLinks ? t.x + 3 : t.x + t.w - 17} y={t.y + 4} width={14} height={t.h - 8} fill="#c9cfe8" />);
    }

    // Pins and their print
    for (const p of t.pins) {
      const q = pinPunkt(t, p);
      const leg = form === 'taste' || form === 'lautsprecher';
      pinsSvg.push(
        padSvg(s, { x: q.x, y: q.y, r: leg ? 5 : PIN_R }, `${plan.id}-${t.id}-${p.id}`, {
          fill: leg ? '#bbb' : '#d9d4c7',
          stroke: '#444',
          width: 1,
          eckig: p.eckig || leg,
        }),
      );
      if (!p.txt && !p.nr) continue;
      const size = 12;
      const o = { fill: schrift, plate: t.farbe };
      if (p.seite === 'L' || p.seite === 'R') {
        const x = p.seite === 'L' ? q.x + 13 : q.x - 13;
        setze(
          p.id,
          p.txt,
          size,
          [
            {
              x,
              y: q.y + size * 0.36,
              anchor: p.seite === 'L' ? 'start' : 'end',
            },
          ],
          o,
        );
      } else {
        const inward = p.seite === 'O' ? 1 : -1;
        const first = q.y + inward * 15;
        const second = q.y + inward * 33;
        const base = (y: number, sz: number) => (inward > 0 ? y + sz * 0.8 : y);
        if (p.nr) setze(`${p.id}-nr`, p.nr, 10, [{ x: q.x, y: base(first, 10), anchor: 'middle' }], { fill: '#c8c2b6', plate: t.farbe });
        if (p.txt) setze(p.id, p.txt, 11, [{ x: q.x, y: base(p.nr ? second : first, 11), anchor: 'middle' }], o);
      }
    }

    // The name of the part
    if (form === 'taste' || form === 'lautsprecher' || form === 'ring' || form === 'elko' || form === 'led') {
      const below = t.y + t.h + 22;
      const hand = form !== 'elko';
      const gr = form === 'taste' && t.w < 60 ? 13 : hand ? 15 : 12;
      setze(
        'name',
        t.name,
        gr,
        [
          { x: cx, y: below, anchor: 'middle' },
          { x: cx, y: t.y - 12, anchor: 'middle' },
          { x: t.x - 10, y: cy + 5, anchor: 'end' },
          { x: t.x + t.w + 10, y: cy + 5, anchor: 'start' },
        ],
        { fill: 'var(--text)', plate: 'papier', hand },
        false,
      );
    } else if (form === 'widerstand') {
      setze(
        'name',
        t.name,
        13,
        t.w > t.h
          ? [
              { x: cx, y: t.y - 8, anchor: 'middle' },
              { x: cx, y: t.y + t.h + 18, anchor: 'middle' },
            ]
          : [
              { x: t.x + t.w + 8, y: cy + 5, anchor: 'start' },
              { x: t.x - 8, y: cy + 5, anchor: 'end' },
            ],
        { fill: 'var(--text)', plate: 'papier' },
        false,
      );
    } else if (t.nameAussen) {
      setze('name', t.name, 15, [{ x: cx, y: t.y - 12, anchor: 'middle' }], { fill: 'var(--text)', plate: 'papier' }, false);
    } else {
      // Inside: at the top, unless pins are there; then in the middle.
      const obenFrei = !t.pins.some((p) => p.seite === 'O');
      const orte: Vorschlag[] = [];
      if (obenFrei) orte.push({ x: cx, y: t.y + 24, anchor: 'middle' });
      for (let dy = 0; dy < t.h / 2 - 20; dy += 8) orte.push({ x: cx, y: cy + 5 - dy, anchor: 'middle' }, { x: cx, y: cy + 5 + dy, anchor: 'middle' });
      setze('name', t.name, 15, orte, { fill: schrift, plate: t.farbe });
    }
    // Notes go under the name, one below the other.
    let unter = s.etiketten[s.etiketten.length - 1]?.y ?? cy;
    (t.notiz ?? []).forEach((n, k) => {
      const orte: Vorschlag[] = [];
      for (let dy = 0; dy < t.h / 2; dy += 6) orte.push({ x: cx, y: unter + (k ? 17 : 21) + dy, anchor: 'middle' });
      for (let dy = 6; dy < t.h / 2; dy += 6) orte.push({ x: cx, y: unter + 21 - dy, anchor: 'middle' });
      setze(`notiz${k}`, n, 11, orte, {
        fill: form === 'kasten' ? '#ffe9a8' : schrift,
        plate: t.farbe,
      });
      unter = s.etiketten[s.etiketten.length - 1].y;
    });
  }

  return {
    szene: s,
    svg: [<g key="b">{bodies}</g>, <g key="w">{wires}</g>, <g key="p">{pinsSvg}</g>, <g key="l">{labels}</g>],
  };
}

export function LoetplanSchema({ plan, label }: { plan: SchemaPlan; label: string }) {
  const { svg } = schemaSzene(plan);
  return (
    <svg class="lp-sketch lp-schema lp-holz" viewBox={`0 0 ${plan.breite} ${plan.hoehe}`} xmlns="http://www.w3.org/2000/svg" role="img" aria-label={label}>
      {svg}
    </svg>
  );
}
