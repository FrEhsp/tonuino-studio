/**
 * "Lötplan" (0.6): one big picture per board (Classic v1.7, AiO, AiO+) to lay
 * next to you while soldering, with every chosen extra drawn into it
 * (design/06-umbau/loetplan, entwurf-loetplan-*.png). Above it the board and
 * the extras as tick boxes; beside it the steps, the legend of the three
 * kinds of wire and what to check before soldering; "Schritt für Schritt"
 * lights up one step and zooms to it. On a phone the picture can be zoomed
 * and swiped, with a small map of the whole.
 * Below the first screen: all wires with their sources, the extras in
 * detail, and "Box testen".
 * The Classic without board and the view from below keep their pictures of
 * 0.5 (LoetplanSchema.tsx, LoetplanSketch.tsx).
 * Data: loetplanBild.ts (picture), loetplan.ts (choice), loetplanVerdrahtung.ts (extras).
 */
import '../../ui/styles/loetplan.css';
import { KastenJa } from './BaukastenBilder';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { route } from '../../app/router';
import { ArrowLeft, ArrowRight, ChevronDown, Minus, Plus, Printer, X } from 'lucide-preact';
import { Button, Callout, Segmented } from '../../ui/components/controls';
import { useMedia } from '../../ui/useMedia';
import { ExternalLink } from '../help/ExternalLink';
import {
  FARBNAMEN,
  loetplanWahl,
  mitAnsicht,
  mitArduino,
  mitKopfhoerer,
  schalteExtra,
  schalterArt,
  SCHRITTE,
  schrittText,
  waehle,
  waehleSchalter,
  wahlText,
  warnung,
  zuletztWeg,
  aufbau,
  KH_NAMEN,
  type Ansicht,
  type Arduino,
  type ExtraId,
  type Kopfhoerer,
  type ListenKabel,
  type LoetplanWahl,
  type Platine,
  type SchalterArt,
  type Schritt,
  type Tasten,
} from './loetplan';
import { bild, chipAn, chipsVon, CHIP_NAMEN, DEFS, drahtLagen, listeVon, markeAusruf, markeFrage, miniSvg, teilsOffen, zaehle, type Bild, type BildSchritt, type ListenZeile, type Rect } from './loetplanBild';
import { quelleVon, stufeVon, STUFE_TEXT, type Stufe } from './loetplanBelege';
import { a5Konflikt, d6Konflikt, extras, firmwareText, schema, schemaText, type ExtraPlan } from './loetplanVerdrahtung';
import { LoetplanSchema } from './LoetplanSchema';
import { LoetplanSketch, sketchLabel } from './LoetplanSketch';
import { keepsLogConnection, logSession } from './logsession';

const PHONE = '(max-width: 760px)';

function print() {
  try {
    window.print();
  } catch {
    // A window without printing: nothing to do, the picture is still on screen.
  }
}

export function LoetplanTool() {
  const wahl = loetplanWahl.value;
  const phone = useMedia(PHONE);
  // Box testen sends you here to look at a joint and keeps the box connected; any other page frees the port.
  useEffect(
    () => () => {
      if (logSession.connected && !keepsLogConnection(route.peek())) void logSession.disconnect();
    },
    [],
  );
  const b = useMemo(() => bild(wahl), [wahl]);
  const [schrittNr, setSchrittNr] = useState<number | null>(null);
  const aktiv = b && schrittNr !== null ? (b.schritte[Math.min(schrittNr, b.schritte.length - 1)] ?? null) : null;
  // The keys of a book: arrows turn the steps, Escape closes them.
  useEffect(() => {
    if (!b || schrittNr === null) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
      if (e.key === 'Escape') setSchrittNr(null);
      else if (e.key === 'ArrowRight') setSchrittNr((n) => Math.min((n ?? 0) + 1, b.schritte.length - 1));
      else if (e.key === 'ArrowLeft') setSchrittNr((n) => Math.max((n ?? 0) - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [b, schrittNr]);

  return (
    <div class={`schirm lp-neu lp-page${phone ? ' handy' : ''}${aktiv ? ' im-schritt' : ''}`}>
      <section class="lp-oben">
        {phone ? <HandyKopf aktiv={aktiv} b={b} onZu={() => setSchrittNr(null)} /> : null}
        <div class="lp-bildseite">
          {phone && aktiv ? null : <WahlLeiste wahl={wahl} b={b} phone={phone} />}
          {b ? <Blatt b={b} aktiv={aktiv} phone={phone} /> : <AltesBlatt wahl={wahl} />}
        </div>
        <aside class="lp-rechts">
          {!phone ? (
            <div class="lp-titel lp-noprint">
              {aktiv ? null : (
                <>
                  <h1>Lötplan</h1>
                  <p class="lp-unter">Zum Danebenlegen beim Löten.</p>
                </>
              )}
            </div>
          ) : null}
          {b && aktiv ? (
            <SchrittAnsicht b={b} s={aktiv} phone={phone} onNr={setSchrittNr} />
          ) : b ? (
            <Uebersicht b={b} phone={phone} onSchritt={setSchrittNr} />
          ) : (
            <AlteUebersicht wahl={wahl} />
          )}
        </aside>
      </section>
      {b ? <Druck b={b} wahl={wahl} /> : null}
      <section class="lp-mehr lp-noprint" aria-label="Mehr zum Lötplan">
        {b ? <Mehr b={b} wahl={wahl} /> : <AltesMehr wahl={wahl} />}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ board and extras */

const PLATINEN_WAHL: [Platine, string][] = [
  ['classic', 'Classic'],
  ['aio', 'AiO'],
  ['aioplus', 'AiO+'],
];

/** A small drawing of the board for its button (design werkstatt.js platinenBild). */
function PlatinenBild({ id }: { id: Platine }) {
  if (id === 'classic' || id === 'frei')
    return (
      <svg width="46" height="28" viewBox="0 0 54 32" aria-hidden="true">
        <rect x="1.5" y="1.5" width="51" height="29" rx="3" fill="#1d1d1f" stroke="#1f1a16" stroke-width="2" />
        <rect x="5" y="7" width="27" height="17" rx="1.5" fill="#20578f" />
        <rect x="2.5" y="12.5" width="5" height="6" fill="#b9bcc2" />
        <rect x="35" y="6" width="15" height="19" rx="1.5" fill="#b8322a" />
      </svg>
    );
  const plus = id === 'aioplus';
  return (
    <svg width="46" height="28" viewBox="0 0 54 32" aria-hidden="true">
      <rect x="1.5" y="1.5" width="51" height="29" rx="3" fill="#1d1d1f" stroke="#1f1a16" stroke-width="2" />
      <rect x="0.5" y="5" width="7" height="6" fill="#f2efe8" />
      <rect x="34" y="0.5" width="13" height="5" fill="#f2efe8" />
      <text x="27" y="21" text-anchor="middle" font-size={plus ? 10.5 : 11.5} font-weight="800" fill="#fff">
        {plus ? 'AiO+' : 'AiO'}
      </text>
    </svg>
  );
}

const GRUND: [ExtraId[], string][] = [
  [['drehgeber', 'poti'], 'beide brauchen A3'],
  [['ring', 'ledtasten'], 'beide brauchen D5'],
  [['ledtasten', 'akkumessung'], 'beide brauchen A5'],
  [['ledtasten', 'lsaus'], 'beide brauchen D6'],
];

/** Why switching one extra on switched another off, in one sentence. */
function wegText(an: ExtraId, weg: ExtraId[]): string {
  const namen = weg.map((x) => `„${CHIP_NAMEN[x]}“`).join(' und ');
  const pin = GRUND.find(([paar]) => paar.includes(an) && weg.some((x) => paar.includes(x)));
  const grund = pin ? pin[1] : 'die Box hat nur einen Weg für den Strom';
  return `${namen} ist jetzt aus: ${grund}.`;
}

function aufbauText(w: LoetplanWahl): string {
  const teile: string[] = [];
  if (w.platine === 'frei') teile.push('ohne Platine');
  teile.push(`${w.tasten} Tasten`);
  if (mitArduino(w.platine) && w.nano === 'every') teile.push('Nano Every');
  if (mitKopfhoerer(w.platine)) teile.push(KH_NAMEN[w.kh]);
  if (mitAnsicht(w.platine) && w.ansicht === 'unten') teile.push('von unten');
  return teile.join(' · ');
}

/** The rest of the build: buttons, Arduino, headphone socket, view from below, the Classic without board. Folded away. */
function Aufbau({ wahl, phone }: { wahl: LoetplanWahl; phone: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  // A click beside the panel closes it, like a menu.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const d = ref.current;
      if (d?.open && !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);
  const classic = wahl.platine === 'classic' || wahl.platine === 'frei';
  return (
    <details class={`lp-aufbau${phone ? ' als-platine' : ''}`} ref={ref}>
      <summary>
        {phone ? (
          <>
            <PlatinenBild id={wahl.platine} />
            <b>{wahl.platine === 'aio' ? 'AiO' : wahl.platine === 'aioplus' ? 'AiO+' : 'Classic'}</b>
          </>
        ) : (
          <span>{aufbauText(wahl)}</span>
        )}
        <ChevronDown size={18} strokeWidth={2.4} aria-hidden="true" />
      </summary>
      <div class="lp-aufbau-panel">
        {phone ? (
          <div class="lp-aufbau-zeile">
            <span>Platine</span>
            <Segmented<Platine>
              label="Platine"
              value={wahl.platine === 'frei' ? 'classic' : wahl.platine}
              options={PLATINEN_WAHL.map(([value, label]) => ({ value, label }))}
              onChange={(platine) => waehle({ platine })}
            />
          </div>
        ) : null}
        {classic ? (
          <div class="lp-aufbau-zeile">
            <span>Classic</span>
            <Segmented<Platine>
              label="Classic mit oder ohne Platine"
              value={wahl.platine}
              options={[
                { value: 'classic', label: 'Platine v1.7' },
                { value: 'frei', label: 'ohne Platine' },
              ]}
              onChange={(platine) => waehle({ platine })}
            />
          </div>
        ) : null}
        <div class="lp-aufbau-zeile">
          <span>Tasten</span>
          <Segmented<Tasten>
            label="Tasten"
            value={wahl.tasten}
            options={[
              { value: 3, label: '3 Tasten' },
              { value: 5, label: '5 Tasten' },
            ]}
            onChange={(tasten) => waehle({ tasten })}
          />
        </div>
        {mitArduino(wahl.platine) ? (
          <div class="lp-aufbau-zeile">
            <span>Arduino</span>
            <Segmented<Arduino>
              label="Arduino"
              value={wahl.nano}
              options={[
                { value: 'nano', label: 'Nano' },
                { value: 'every', label: 'Nano Every' },
              ]}
              onChange={(nano) => waehle({ nano })}
            />
          </div>
        ) : null}
        {mitKopfhoerer(wahl.platine) ? (
          <div class="lp-aufbau-zeile">
            <span>Kopfhörer</span>
            <Segmented<Kopfhoerer>
              label="Kopfhörerbuchse"
              value={wahl.kh}
              options={[
                { value: 'platine', label: 'Kopfhörerplatine' },
                { value: 'buchse', label: 'einzelne Buchse' },
                { value: 'keine', label: 'keine' },
              ]}
              onChange={(kh) => waehle({ kh })}
            />
          </div>
        ) : null}
        {mitAnsicht(wahl.platine) ? (
          <div class="lp-aufbau-zeile">
            <span>Ansicht</span>
            <Segmented<Ansicht>
              label="Ansicht"
              value={wahl.ansicht}
              options={[
                { value: 'oben', label: 'von oben' },
                { value: 'unten', label: 'von unten (Lötseite)' },
              ]}
              onChange={(ansicht) => waehle({ ansicht })}
            />
          </div>
        ) : null}
        {wahl.ansicht === 'unten' && wahl.platine === 'classic' ? <p class="lp-klein">Von unten zeigt das Bild nur die Grundverdrahtung, ohne Extras.</p> : null}
      </div>
    </details>
  );
}

/** Board, extras as tick boxes, and a line that says what just happened. */
function WahlLeiste({ wahl, b, phone }: { wahl: LoetplanWahl; b: Bild | null; phone: boolean }) {
  const [notiz, setNotiz] = useState<string | null>(null);
  const plaene = useMemo(() => extras(wahl), [wahl]);
  const weg = zuletztWeg.value;
  const ids = chipsVon(wahl.platine);
  const geordnet = phone ? [...ids.filter((id) => chipAn(wahl, id)), ...ids.filter((id) => !chipAn(wahl, id))] : ids;
  const art = schalterArt(wahl);
  const zeile = notiz ?? (weg ? wegText(weg.an, weg.weg) : wahl.platine === 'aio' || wahl.platine === 'aioplus' ? 'Kopfhörer-Erkennung, Verstärker und USB-C sind schon auf der Platine.' : null);
  const chips = geordnet.map((id) => {
    const plan = plaene.find((x) => x.id === id);
    const gesperrt = plan?.gesperrt;
    const an = chipAn(wahl, id) && !gesperrt;
    return (
      <button
        type="button"
        key={id}
        class={`lp-chip${an ? ' an' : ''}${gesperrt ? ' aus' : ''}`}
        aria-pressed={an}
        aria-disabled={gesperrt ? true : undefined}
        title={gesperrt}
        onClick={() => {
          setNotiz(gesperrt ?? null);
          zuletztWeg.value = null;
          if (gesperrt) return;
          if (id === 'schalter' && an) waehle({ extras: wahl.extras.filter((x) => x !== 'schalter' && x !== 'pololu') });
          else schalteExtra(id);
        }}
      >
        <KastenJa an={an} />
        <span class="lp-mini" dangerouslySetInnerHTML={{ __html: miniSvg(id) }} />
        <span>{CHIP_NAMEN[id]}</span>
        {teilsOffen(wahl, id) ? (
          <span class="lp-chip-frage" title="Noch nicht ganz belegt">
            ?
          </span>
        ) : null}
      </button>
    );
  });
  const frage =
    art !== undefined || wahl.extras.includes('schalter') ? (
      <div class="lp-frage-zeile">
        <span>Ein/Aus-Schalter: Wie viele Beinchen hat er?</span>
        <Segmented<SchalterArt>
          label="Wie viele Beinchen hat dein Schalter?"
          value={art ?? (0 as unknown as SchalterArt)}
          options={[
            { value: 2, label: '2 Beinchen' },
            { value: 3, label: '3 Beinchen' },
            { value: 4, label: '4 Beinchen' },
            { value: 'pololu', label: 'Pololu-Platine' },
          ]}
          onChange={waehleSchalter}
        />
      </div>
    ) : null;
  if (phone)
    return (
      <div class="lp-wahl lp-noprint">
        <div class="lp-wisch" role="group" aria-label="Platine und Extras">
          <Aufbau wahl={wahl} phone />
          {chips}
        </div>
        {frage}
        {zeile ? <p class="lp-notiz">{zeile}</p> : null}
      </div>
    );
  return (
    <div class="lp-wahl lp-noprint">
      <div class="lp-reihe">
        <span class="lp-wofuer">Platine</span>
        <div class="lp-platinen" role="radiogroup" aria-label="Platine">
          {PLATINEN_WAHL.map(([id, name]) => {
            const an = wahl.platine === id || (id === 'classic' && wahl.platine === 'frei');
            return (
              <button type="button" key={id} class={`choice lp-platine${an ? ' an' : ''}`} role="radio" aria-checked={an} onClick={() => waehle({ platine: id === 'classic' && wahl.platine === 'frei' ? 'frei' : id })}>
                <PlatinenBild id={id} />
                {name}
              </button>
            );
          })}
        </div>
        <Aufbau wahl={wahl} phone={false} />
      </div>
      <div class="lp-reihe">
        <span class="lp-wofuer">Extras</span>
        <div class="lp-chips" role="group" aria-label="Extras">
          {chips}
        </div>
      </div>
      {frage}
      {zeile ? <p class="lp-notiz">{zeile}</p> : b === null && wahl.extras.length ? <p class="lp-notiz">Die Extras stehen unten unter „Extras im Detail“.</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ the sheet with the picture */

/** The view box of a step, widened to the shape of the sheet so nothing is cut off. */
function passend(r: Rect, breite: number, hoehe: number): Rect {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const soll = breite / Math.max(hoehe, 1);
  if (w / h < soll) {
    const nw = h * soll;
    return { x0: r.x0 - (nw - w) / 2, y0: r.y0, x1: r.x1 + (nw - w) / 2, y1: r.y1 };
  }
  const nh = w / soll;
  return { x0: r.x0, y0: r.y0 - (nh - h) / 2, x1: r.x1, y1: r.y1 + (nh - h) / 2 };
}

const vbText = (r: Rect) => `${Math.round(r.x0)} ${Math.round(r.y0)} ${Math.round(r.x1 - r.x0)} ${Math.round(r.y1 - r.y0)}`;

function Inhalt({ b, aktiv, id }: { b: Bild; aktiv: BildSchritt | null; id?: string }) {
  const lagen = useMemo(() => drahtLagen(b, aktiv?.key ?? null), [b, aktiv?.key]);
  return (
    <g id={id}>
      <g dangerouslySetInnerHTML={{ __html: DEFS + b.teile }} />
      <g class="lp-blass" dangerouslySetInnerHTML={{ __html: lagen.blass }} />
      <g dangerouslySetInnerHTML={{ __html: lagen.kraeftig }} />
      <g dangerouslySetInnerHTML={{ __html: b.ueber }} />
    </g>
  );
}

function Blatt({ b, aktiv, phone }: { b: Bild; aktiv: BildSchritt | null; phone: boolean }) {
  return (
    <figure class="card lp-blatt" aria-label={`Lötplan: ${b.kopf}`}>
      {phone ? null : (
        <figcaption class="lp-blatt-kopf">
          <b>{b.kopf}</b>
          <span>{b.unter}</span>
        </figcaption>
      )}
      {phone ? (
        <>
          <ZoomBild b={b} aktiv={aktiv} />
          {/* Paper always gets the whole picture. */}
          <div class="lp-print-only lp-druck-bild">
            <FitBild b={b} aktiv={null} druck />
          </div>
        </>
      ) : (
        <FitBild b={b} aktiv={aktiv} />
      )}
    </figure>
  );
}

/** On a computer: the whole picture fits the sheet; a step zooms to its part. */
function FitBild({ b, aktiv, druck = false }: { b: Bild; aktiv: BildSchritt | null; druck?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mass, setMass] = useState<[number, number]>([1000, 700]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setMass([el.clientWidth || 1000, el.clientHeight || 700]));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const vb = aktiv ? passend(aktiv.bereich, mass[0], mass[1]) : b.box;
  return (
    <div class="lp-fit" ref={ref}>
      <svg class="lp-svg" viewBox={vbText(vb)} preserveAspectRatio="xMidYMid meet" role={druck ? undefined : 'img'} aria-label={druck ? undefined : b.kopf} aria-hidden={druck ? true : undefined}>
        <Inhalt b={b} aktiv={aktiv} id={druck ? undefined : 'lp-inhalt'} />
      </svg>
    </div>
  );
}

/** Room the + and − take at the right edge of the picture on a phone (loetplan.css, .lp-zoom-knoepfe). */
const ZOOM_KNOEPFE = 64;

/**
 * On a phone: the picture so big that its smallest text is 14 px, to swipe
 * with one finger and zoom with two or with + and −; a small map shows where
 * you are. A step zooms to its wires.
 */
function ZoomBild({ b, aktiv }: { b: Bild; aktiv: BildSchritt | null }) {
  const ref = useRef<HTMLDivElement>(null);
  // A step shows all of its pins, also when its text then is smaller than 14 px: a pin cut off (3.3 V!) is worse (Prüfrunde 1, bastler 8).
  const [stepZoom, setStepZoom] = useState<number | null>(null);
  const minZoom = Math.min(14 / b.minSchrift, stepZoom ?? Infinity);
  const [zoom, setZoom] = useState(minZoom);
  const [sicht, setSicht] = useState<Rect>(b.box);
  const bw = b.box.x1 - b.box.x0;
  const bh = b.box.y1 - b.box.y0;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  /** The part of the picture in view, for the small map. */
  const merke = () => {
    const el = ref.current;
    if (!el) return;
    const z = zoomRef.current;
    setSicht({ x0: b.box.x0 + el.scrollLeft / z, y0: b.box.y0 + el.scrollTop / z, x1: b.box.x0 + (el.scrollLeft + el.clientWidth) / z, y1: b.box.y0 + (el.scrollTop + el.clientHeight) / z });
  };
  /** Zooms and keeps the point of the picture at (px, py) of the view where it is. */
  const zoomeAuf = (z: number, px?: number, py?: number) => {
    const el = ref.current;
    const neu = Math.min(Math.max(z, minZoom), 3.2);
    if (!el) return setZoom(neu);
    const cx = px ?? el.clientWidth / 2;
    const cy = py ?? el.clientHeight / 2;
    const ux = (el.scrollLeft + cx) / zoomRef.current;
    const uy = (el.scrollTop + cy) / zoomRef.current;
    zoomRef.current = neu;
    setZoom(neu);
    requestAnimationFrame(() => {
      el.scrollLeft = ux * neu - cx;
      el.scrollTop = uy * neu - cy;
      merke();
    });
  };
  const zeige = (r: Rect, z: number, frei = 0) => {
    const el = ref.current;
    zoomRef.current = z;
    setZoom(z);
    requestAnimationFrame(() => {
      if (!el) return;
      el.scrollLeft = ((r.x0 + r.x1) / 2 - b.box.x0) * z - (el.clientWidth - frei) / 2;
      el.scrollTop = ((r.y0 + r.y1) / 2 - b.box.y0) * z - el.clientHeight / 2;
      merke();
    });
  };
  // A new picture or a new step: the overview starts at the board, a step shows its wires.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (aktiv) {
      // The + and − stand at the right edge: the step goes into the room beside them.
      const frei = ZOOM_KNOEPFE;
      const passt = (r: Rect) => Math.min((el.clientWidth - frei) / (r.x1 - r.x0), el.clientHeight / (r.y1 - r.y0));
      // The whole step at 14 px if it fits; else all its pins (kern), even when their names get smaller.
      // A step without wires (the headers) stays at 14 px and is swiped.
      const lesbar = 14 / b.minSchrift;
      const kern = passt(aktiv.bereich) < lesbar ? aktiv.kern : undefined;
      const r = kern ?? aktiv.bereich;
      // Near the picture's left or top edge the view cannot scroll further: the part then has to fit from that edge on,
      // or its far end lay under + and − or below the view (Prüfrunde 2, bastler 2).
      const amRand = (z: number) => {
        let out = z;
        if (((r.x0 + r.x1) / 2 - b.box.x0) * z < (el.clientWidth - frei) / 2) out = Math.min(out, (el.clientWidth - frei) / (r.x1 - b.box.x0));
        if (((r.y0 + r.y1) / 2 - b.box.y0) * z < el.clientHeight / 2) out = Math.min(out, el.clientHeight / (r.y1 - b.box.y0));
        return out;
      };
      const fit = amRand(passt(r));
      setStepZoom(kern ? fit : null);
      zeige(r, Math.min(kern ? fit : amRand(Math.max(fit, lesbar)), 2.4), frei);
    } else {
      setStepZoom(null);
      zoomRef.current = minZoom;
      setZoom(minZoom);
      requestAnimationFrame(() => {
        // Like the design: the card reader at the top left, the first thing to solder.
        const rf = b.schritte.find((x) => x.key === 'rfid')?.bereich;
        el.scrollLeft = rf ? (rf.x0 - b.box.x0) * minZoom - 16 : 0;
        el.scrollTop = rf ? (rf.y0 - b.box.y0) * minZoom - 16 : 0;
        merke();
      });
    }
  }, [b, aktiv?.key]);

  // Two fingers zoom (the page itself does not: touch-action lets the browser only swipe).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const finger = new Map<number, [number, number]>();
    let start: { abstand: number; zoom: number } | null = null;
    const abstand = () => {
      const [a, c] = [...finger.values()];
      return Math.hypot(a[0] - c[0], a[1] - c[1]);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      finger.set(e.pointerId, [e.clientX, e.clientY]);
      if (finger.size === 2) start = { abstand: abstand(), zoom: zoomRef.current };
    };
    const move = (e: PointerEvent) => {
      if (!finger.has(e.pointerId)) return;
      finger.set(e.pointerId, [e.clientX, e.clientY]);
      if (finger.size === 2 && start) {
        const box = el.getBoundingClientRect();
        const [a, c] = [...finger.values()];
        zoomeAuf((start.zoom * abstand()) / start.abstand, (a[0] + c[0]) / 2 - box.left, (a[1] + c[1]) / 2 - box.top);
      }
    };
    const up = (e: PointerEvent) => {
      finger.delete(e.pointerId);
      if (finger.size < 2) start = null;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, [b]);

  const karteW = 132;
  const k = karteW / bw;
  return (
    <div class="lp-zoombild">
      <div class="lp-zoom" ref={ref} onScroll={merke}>
        <svg class="lp-svg" viewBox={vbText(b.box)} width={Math.round(bw * zoom)} height={Math.round(bh * zoom)} role="img" aria-label={b.kopf}>
          <Inhalt b={b} aktiv={aktiv} id="lp-inhalt" />
        </svg>
      </div>
      <div class="lp-zoom-knoepfe">
        <Button aria-label="Vergrößern" title="Vergrößern" icon={Plus} onClick={() => zoomeAuf(zoom * 1.3)} />
        <Button aria-label="Verkleinern" title="Verkleinern" icon={Minus} disabled={zoom <= minZoom + 0.01} onClick={() => zoomeAuf(zoom / 1.3)} />
      </div>
      {aktiv ? null : (
        <>
          <button
            type="button"
            class="lp-minikarte"
            aria-label="Übersicht: Tippe, wohin das Bild springen soll"
            style={{ height: `${Math.round(bh * k)}px` }}
            onClick={(e) => {
              const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const x = b.box.x0 + (e.clientX - box.left) / k;
              const y = b.box.y0 + (e.clientY - box.top) / k;
              zeige({ x0: x, y0: y, x1: x, y1: y }, zoom);
            }}
          >
            <svg viewBox={vbText(b.box)} width={karteW} height={Math.round(bh * k)} aria-hidden="true">
              <use href="#lp-inhalt" />
            </svg>
            <span
              class="lp-minikarte-rahmen"
              style={{
                left: `${Math.max(0, (sicht.x0 - b.box.x0) * k)}px`,
                top: `${Math.max(0, (sicht.y0 - b.box.y0) * k)}px`,
                width: `${Math.min(karteW, (sicht.x1 - sicht.x0) * k)}px`,
                height: `${Math.min(bh * k, (sicht.y1 - sicht.y0) * k)}px`,
              }}
            />
          </button>
          <p class="lp-wisch-hinweis">Mit zwei Fingern vergrößern.</p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ beside the picture */

/** One piece of each kind of wire, for the legend. */
function LegendeDraht({ stufe }: { stufe: Stufe }) {
  const pfad = 'M4 12L50 12';
  return (
    <svg width="56" height="24" viewBox="0 0 56 24" aria-hidden="true" class="lp-legende-draht">
      {stufe === 'ungeprueft' ? (
        <path d={pfad} fill="none" stroke="#8a8174" stroke-width="3.4" stroke-linecap="round" stroke-dasharray="11 8" />
      ) : (
        <>
          <path class="rand" d={pfad} fill="none" stroke="#1f1a16" stroke-width="7.5" stroke-linecap="round" />
          <path d={pfad} fill="none" stroke="#d62828" stroke-width="4.6" stroke-linecap="round" />
        </>
      )}
      {stufe === 'geprueft' ? null : <g dangerouslySetInnerHTML={{ __html: stufe === 'nachsehen' ? markeAusruf(27, 12) : markeFrage(27, 12) }} />}
    </svg>
  );
}

function Legende() {
  return (
    <div class="lp-legende">
      <div>
        <LegendeDraht stufe="geprueft" />
        sicher: steht so in der Firmware
      </div>
      <div>
        <LegendeDraht stufe="nachsehen" />
        vor dem Löten nachsehen
      </div>
      <div>
        <LegendeDraht stufe="ungeprueft" />
        noch nicht belegt
      </div>
    </div>
  );
}

/** The note slip with what is not proven, or what to check before soldering: the first in full, the rest folded. */
function OffenBox({ b }: { b: Bild }) {
  const offen = b.offen.filter((o) => o.stufe === 'ungeprueft');
  const nach = b.offen.filter((o) => o.stufe === 'nachsehen');
  const liste = offen.length ? offen : nach;
  if (!liste.length) return null;
  const [erste, ...rest] = liste;
  const andere = offen.length ? rest.length + nach.length : rest.length;
  return (
    <div class={`lp-offen${offen.length ? ' ist-offen' : ''}`}>
      <h2>
        <span class="lp-offen-zeichen" dangerouslySetInnerHTML={{ __html: `<svg width="26" height="26" viewBox="-13 -13 26 26" aria-hidden="true">${offen.length ? markeFrage(0, 0) : markeAusruf(0, 0)}</svg>` }} />
        {offen.length ? `Noch nicht belegt: ${erste.titel}` : 'Vor dem Löten nachsehen'}
      </h2>
      <p>{offen.length ? erste.warum : `${erste.titel}: ${erste.warum}`}</p>
      {erste.bitte ? (
        <details>
          <summary>Wie du helfen kannst</summary>
          <p class="lp-bitte">{erste.bitte}</p>
        </details>
      ) : null}
      {andere ? (
        <details>
          <summary>
            und {andere} weitere {andere === 1 ? 'Stelle' : 'Stellen'}
          </summary>
          <ul>
            {[...rest, ...(offen.length ? nach : [])].map((o) => (
              <li key={o.titel}>
                <b>{o.stufe === 'ungeprueft' ? 'Noch nicht belegt' : 'Nachsehen'}: {o.titel}.</b> {o.warum}
                {o.bitte ? ` ${o.bitte}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Uebersicht({ b, phone, onSchritt }: { b: Bild; phone: boolean; onSchritt: (n: number) => void }) {
  const z = zaehle(b);
  if (phone)
    return (
      <div class="lp-fest lp-noprint">
        {z.nachsehen || z.offen ? (
          <p class="lp-info">
            {z.nachsehen ? (
              <span>
                <span class="lp-info-zeichen" dangerouslySetInnerHTML={{ __html: `<svg width="24" height="24" viewBox="-12 -12 24 24" aria-hidden="true">${markeAusruf(0, 0)}</svg>` }} />
                {z.nachsehen}× nachsehen
              </span>
            ) : null}
            {z.offen ? (
              <span>
                <span class="lp-info-zeichen" dangerouslySetInnerHTML={{ __html: `<svg width="24" height="24" viewBox="-12 -12 24 24" aria-hidden="true">${markeFrage(0, 0)}</svg>` }} />
                {z.offen}× noch nicht belegt
              </span>
            ) : null}
          </p>
        ) : null}
        <div class="lp-knoepfe">
          <Button icon={Printer} onClick={print}>
            Drucken
          </Button>
          <Button variant="primary" onClick={() => onSchritt(0)}>
            Schritt für Schritt
          </Button>
        </div>
      </div>
    );
  return (
    <>
      <div class="lp-rechts-inhalt">
        <Legende />
        <ol class="lp-schritte">
        {b.schritte.map((s, i) => (
          <li key={s.key} class={s.extra ? 'extra' : undefined}>
            <button type="button" onClick={() => onSchritt(i)}>
              <span class="lp-nr">{s.nr}</span>
              <span>
                <b>{s.titel}.</b> {s.kurz}
              </span>
            </button>
          </li>
        ))}
        </ol>
      </div>
      <OffenBox b={b} />
      <div class="lp-knoepfe lp-noprint">
        <Button onClick={() => onSchritt(0)}>Schritt für Schritt</Button>
        <Button variant="primary" icon={Printer} onClick={print}>
          Drucken
        </Button>
      </div>
    </>
  );
}

function Zeichen({ stufe }: { stufe: Stufe }) {
  if (stufe === 'geprueft') return null;
  return (
    <span
      class="lp-zeile-zeichen"
      title={STUFE_TEXT[stufe]}
      dangerouslySetInnerHTML={{ __html: `<svg width="22" height="22" viewBox="-12 -12 24 24" aria-label="${STUFE_TEXT[stufe]}">${stufe === 'nachsehen' ? markeAusruf(0, 0) : markeFrage(0, 0)}</svg>` }}
    />
  );
}

function DrahtListe({ zeilen }: { zeilen: ListenZeile[] }) {
  return (
    <ul class="lp-draehte">
      {zeilen.map((z, i) => (
        <li key={i} class={z.farbe ? undefined : 'frei'}>
          {z.farbe ? <span class={`lp-farbe${z.stufe === 'ungeprueft' ? ' blei' : ''}`} style={z.stufe === 'ungeprueft' ? undefined : { background: z.farbe }} title={FARBNAMEN[z.farbe] ?? ''} /> : <span class="lp-farbe leer" />}
          {z.nach ? (
            <>
              <b class="lp-von">{z.von}</b>
              <span class="lp-nach">→ {z.nach}</span>
            </>
          ) : (
            <span class="lp-nach">{z.von}</span>
          )}
          <Zeichen stufe={z.stufe} />
        </li>
      ))}
    </ul>
  );
}

/** One step: its wires in their colours, a hint, Zurück and Weiter. */
function SchrittAnsicht({ b, s, phone, onNr }: { b: Bild; s: BildSchritt; phone: boolean; onNr: (n: number | null) => void }) {
  const i = s.nr - 1;
  const n = b.schritte.length;
  const zeilen = listeVon(b, s.key);
  return (
    <div class="lp-schritt">
      {phone ? null : (
        <div class="lp-schritt-kopf">
          <button type="button" class="lp-zu" aria-label="Schritte schließen, ganzes Bild zeigen" title="Ganzes Bild" onClick={() => onNr(null)}>
            <X size={22} strokeWidth={2.4} />
          </button>
          <b>
            Schritt {s.nr} von {n}
          </b>
        </div>
      )}
      <div class="lp-schritt-text">
        <p class="lp-ort">{s.ort}</p>
        <h2>{s.titel}</h2>
        {/* First, right under the picture: a wrong pin here can ruin a part (Prüfrunde 1, bastler 8). */}
        {s.achtung ? (
          <p class="lp-achtung">
            <b>Achtung:</b> {s.achtung}
          </p>
        ) : null}
        {zeilen.length ? <DrahtListe zeilen={zeilen} /> : <p class="lp-klein">{s.kurz}.</p>}
        {s.hinweis ? <p class="lp-hinweis">{s.hinweis}</p> : null}
        {s.text.length ? (
          <details class="lp-mehr-schritt">
            <summary>Mehr zu diesem Schritt</summary>
            <ul>
              {s.text.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div class="lp-punkte" aria-hidden="true">
          {b.schritte.map((x, k) => (
            <i key={x.key} class={k < i ? 'da' : k === i ? 'jetzt' : undefined} />
          ))}
        </div>
      </div>
      <div class="lp-knoepfe lp-noprint">
        <Button icon={ArrowLeft} disabled={i === 0} onClick={() => onNr(Math.max(0, i - 1))}>
          Zurück
        </Button>
        {i < n - 1 ? (
          <Button variant="primary" iconRight={ArrowRight} onClick={() => onNr(i + 1)}>
            Weiter
          </Button>
        ) : (
          <Button variant="primary" onClick={() => onNr(null)}>
            Fertig
          </Button>
        )}
      </div>
    </div>
  );
}

/** The bar on top of a phone: back to the Werkstatt, or out of the steps. */
function HandyKopf({ aktiv, b, onZu }: { aktiv: BildSchritt | null; b: Bild | null; onZu: () => void }) {
  return (
    <div class="lp-handy-kopf lp-noprint">
      {aktiv ? (
        <button type="button" class="lp-rund" aria-label="Schritte schließen" onClick={onZu}>
          <X size={26} strokeWidth={2.4} />
        </button>
      ) : (
        <a class="lp-rund" href="#/werkstatt" aria-label="Zurück zur Werkstatt">
          <ArrowLeft size={26} strokeWidth={2.4} />
        </a>
      )}
      <h1>{aktiv && b ? `Schritt ${aktiv.nr} von ${b.schritte.length}` : 'Lötplan'}</h1>
    </div>
  );
}

/* ------------------------------------------------------------------ paper */

/** Only on paper: all steps with their wires under the picture. */
function Druck({ b, wahl }: { b: Bild; wahl: LoetplanWahl }) {
  return (
    <section class="lp-druck lp-print-only" aria-hidden="true">
      <p class="lp-druck-kopf">
        Durchgezogen: steht so in der Firmware. Mit „!“: vor dem Löten nachsehen. Gestrichelt mit „?“: noch nicht belegt.
      </p>
      <ol class="lp-druck-schritte">
        {b.schritte.map((s) => (
          <li key={s.key}>
            <b>
              {s.nr}. {s.titel}.
            </b>{' '}
            {s.kurz}
            {s.achtung ? <span class="lp-druck-achtung"> Achtung: {s.achtung}</span> : null}
            {listeVon(b, s.key).length ? <DrahtListe zeilen={listeVon(b, s.key)} /> : null}
          </li>
        ))}
      </ol>
      <p class="lp-klein">{firmwareText(wahl)}</p>
    </section>
  );
}

/* ------------------------------------------------------------------ below the first screen */

function Mehr({ b, wahl }: { b: Bild; wahl: LoetplanWahl }) {
  const doppelt = [d6Konflikt(wahl), a5Konflikt(wahl)].filter(Boolean);
  return (
    <>
      {doppelt.map((text) => (
        <Callout key={text} tone="danger">
          <span>
            <b>Achtung:</b> {text}
          </span>
        </Callout>
      ))}
      <details class="ws-later">
        <summary>Alle Kabel mit Quellen</summary>
        <div class="card pad stack lp-wires">
          <BildKabelTabelle b={b} />
          <p class="small soft">
            {wahl.platine === 'classic'
              ? 'Platinen-Aufdruck abgelesen von Fotos einer Classic-Platine v1.7 (Leiterkartenpiraten). Pins aus dem TonUINO-TNG-Quellcode (src/constants.hpp). Andere Platinen-Versionen können anders beschriftet sein: Vergleiche den Aufdruck auf deiner Platine mit dem Bild.'
              : 'Anschlüsse aus den geprüften Unterlagen des Bauassistenten und der Recherche vom 27.10.2026: TonUINO-TNG-Quellcode, Anleitungen der Leiterkartenpiraten, die Original-Firmware und das Forum discourse.voss.earth. Verbinde immer nach dem Aufdruck auf den Teilen: Die Lage im Bild ist nur eine Hilfe.'}
          </p>
          <p class="small soft">Gilt für: {wahlText(wahl)}.</p>
        </div>
      </details>
      {b.extras.length ? (
        <details class="ws-later" open>
          <summary>Extras im Detail ({b.extras.length})</summary>
          <div class="stack lp-extras">
            {b.extras.map((x) => (
              <Extra key={x.id} x={x} mitBild={false} />
            ))}
          </div>
        </details>
      ) : null}
      <p class="small soft lp-firmware">{firmwareText(wahl)}</p>
      {wahl.tasten === 3 ? (
        // Both firmwares ship with invertVolumeButtons on (settingsguide.ts FACTORY_SETTINGS), and it can be switched.
        <p class="small soft">
          Ab Werk ändert kurz drücken auf Vor und Zurück die Lautstärke, lang drücken wechselt den Titel. Umstellen: Werkstatt &gt; <a href="#/werkstatt/einstellen">Box einstellen</a> &gt; Tasten.
        </p>
      ) : null}
      <BoxTesten />
    </>
  );
}

function BoxTesten() {
  return (
    <section class="card pad lp-next" aria-labelledby="lp-next-title">
      <div class="stack tight">
        <h2 id="lp-next-title" class="ws-card-title">
          Fertig gelötet?
        </h2>
        <p>Dann teste deine Box Schritt für Schritt: Tasten, Kartenleser, Ton und ein Wackeltest. Bei einem Problem zeig ich dir die Lötstelle.</p>
      </div>
      <a class="link-button" href="#/werkstatt/testen">
        Box testen <ArrowRight size={15} strokeWidth={2.2} />
      </a>
    </section>
  );
}

function BildKabelTabelle({ b }: { b: Bild }) {
  const zeilen = b.schritte.flatMap((s) => listeVon(b, s.key).map((z) => ({ ...z, schritt: s })));
  return (
    <div class="lp-table-wrap">
      <table class="lp-table">
        <thead>
          <tr>
            <th>Farbe</th>
            <th>Kabel</th>
            <th>Quelle</th>
          </tr>
        </thead>
        <tbody>
          {zeilen.map((k, i) => (
            <tr key={i}>
              <td class="lp-color">
                {k.farbe ? (
                  <>
                    <span class="lp-swatch" style={{ background: k.farbe }} aria-hidden="true" />
                    <span class="small">{FARBNAMEN[k.farbe] ?? ''}</span>
                  </>
                ) : (
                  '–'
                )}
              </td>
              <td>
                {k.schritt.nr}. {k.nach ? `${k.von} → ${k.nach}` : k.von}
                {k.stufe !== 'geprueft' ? <span class="lp-check"> {STUFE_TEXT[k.stufe]}</span> : null}
              </td>
              <td class="small soft">{quelleVon(k.belege)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ the Classic without board and the view from below (0.5) */

function AltesBlatt({ wahl }: { wahl: LoetplanWahl }) {
  const plan = schema(wahl);
  return (
    <figure class="card lp-blatt lp-alt" aria-label={wahlText(wahl)}>
      <figcaption class="lp-blatt-kopf">
        <b>{wahlText(wahl)}</b>
      </figcaption>
      <div class="lp-scroll">{plan ? <LoetplanSchema plan={plan} label={sketchLabel(wahl)} /> : <LoetplanSketch wahl={wahl} />}</div>
    </figure>
  );
}

const STEP_OPTIONS = ([1, 2, 3, 4, 5] as const).map((n) => ({ value: n as Schritt, label: SCHRITTE[n].t }));

function AlteUebersicht({ wahl }: { wahl: LoetplanWahl }) {
  const plan = schema(wahl);
  const text = plan ? schemaText(wahl) : null;
  return (
    <div class="lp-alt-text">
      {text ? (
        <>
          <ul class="lp-hints">
            {text.li.map((li) => (
              <li key={li}>{li}</li>
            ))}
          </ul>
          <p class="lp-achtung">
            <b>Achtung:</b> {text.warnung}
          </p>
        </>
      ) : (
        <>
          <p>{SCHRITTE[0].li.join(' ')}</p>
          <p class="lp-achtung">
            <b>Achtung:</b> {warnung(0, wahl)}
          </p>
        </>
      )}
      <div class="lp-knoepfe lp-noprint">
        <Button variant="primary" icon={Printer} onClick={print}>
          Drucken
        </Button>
      </div>
    </div>
  );
}

function AltesMehr({ wahl }: { wahl: LoetplanWahl }) {
  const [schritt, setSchritt] = useState<Schritt>(1);
  const plan = schema(wahl);
  const liste: ListenKabel[] = plan ? [...plan.kabel, ...(plan.frei ?? [])] : aufbau(wahl).kabel;
  const gewaehlt = extras(wahl).filter((x) => wahl.extras.includes(x.id) && !x.gesperrt);
  const warn = warnung(schritt, wahl);
  return (
    <>
      {plan ? null : (
        <details class="ws-later">
          <summary>Schritt für Schritt: Was kommt zuerst?</summary>
          <div class="card pad stack lp-steps">
            <Segmented<Schritt> label="Schritt" value={schritt} options={STEP_OPTIONS} onChange={setSchritt} />
            <h3 class="lp-step-title">{SCHRITTE[schritt].h}</h3>
            <div class="lp-scroll">
              <LoetplanSketch wahl={wahl} schritt={schritt} />
            </div>
            <ol class="ws-numbered">
              {schrittText(schritt, wahl).map((li) => (
                <li key={li}>{li}</li>
              ))}
            </ol>
            {warn ? (
              <Callout tone="danger">
                <span>
                  <b>Achtung:</b> {warn}
                </span>
              </Callout>
            ) : null}
          </div>
        </details>
      )}
      <details class="ws-later">
        <summary>Alle Kabel mit Quellen</summary>
        <div class="card pad stack lp-wires">
          <KabelTabelle kabel={liste} />
          <p class="small soft">Gilt für: {wahlText(wahl)}.</p>
        </div>
      </details>
      {gewaehlt.length ? (
        <details class="ws-later" open>
          <summary>Extras im Detail ({gewaehlt.length})</summary>
          <div class="stack lp-extras">
            {gewaehlt.map((x) => (
              <Extra key={x.id} x={x} mitBild />
            ))}
          </div>
        </details>
      ) : null}
      <p class="small soft lp-firmware">{firmwareText(wahl)}</p>
      <BoxTesten />
    </>
  );
}

/** An extra in detail: what to do, what to buy, which firmware, links; with its own picture only for the Classic without board. */
function Extra({ x, mitBild }: { x: ExtraPlan; mitBild: boolean }) {
  const antwort = x.frage?.optionen.find((o) => o.wert === x.frage?.gewaehlt);
  return (
    <section class="card pad stack lp-extra" aria-label={x.titel}>
      <h3 class="lp-step-title">{x.titel}</h3>
      {x.frage && !mitBild ? null : x.frage ? (
        <div class="stack tight lp-frage">
          <b>{x.frage.text}</b>
          <Segmented<number> label={x.frage.text} value={x.frage.gewaehlt ?? 0} options={x.frage.optionen.map((o) => ({ value: o.wert, label: o.titel }))} onChange={(v) => waehleSchalter(v as SchalterArt)} />
          {antwort ? <span class="small soft">{antwort.text}</span> : null}
        </div>
      ) : null}
      {mitBild && x.plan ? (
        <div class="lp-scroll">
          <LoetplanSchema plan={x.plan} label={`Extra: ${x.titel}. Jede Farbe ist ein Kabel.`} />
        </div>
      ) : null}
      <ul class="lp-hints">
        {x.text.map((li) => (
          <li key={li}>{li}</li>
        ))}
      </ul>
      {x.fehlt ? (
        <Callout tone="info">
          <div class="stack tight">
            <span>
              <b>{mitBild && !x.plan ? 'Warum es dafür kein Bild gibt:' : 'Noch nicht belegt:'}</b> {x.fehlt.warum}
            </span>
            <span>
              <b>Was es beweisen würde:</b> {x.fehlt.beweis}
            </span>
          </div>
        </Callout>
      ) : null}
      {x.tabelle && (!x.frage || x.frage.gewaehlt) ? (
        <div class="lp-table-wrap">
          <table class="lp-table">
            <caption class="small">{x.tabelle.titel}</caption>
            <thead>
              <tr>
                <th>{x.tabelle.kopf[0]}</th>
                <th>{x.tabelle.kopf[1]}</th>
              </tr>
            </thead>
            <tbody>
              {x.tabelle.zeilen.map(([a, c]) => (
                <tr key={a}>
                  <td>{a}</td>
                  <td>{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {x.warnung ? (
        <Callout tone="danger">
          <span>
            <b>Achtung:</b> {x.warnung}
          </span>
        </Callout>
      ) : null}
      {x.teile.length ? (
        <p class="small">
          <b>Das brauchst du:</b> {x.teile.join(' · ')}
        </p>
      ) : null}
      <p class="small">
        <b>Firmware:</b> {x.firmware}
      </p>
      {x.hilfe ? (
        <p class="small">
          Mehr in der Hilfe: <a href={x.hilfe.href}>{x.hilfe.label}</a>
        </p>
      ) : null}
      {x.links?.length ? (
        <ul class="small lp-links">
          {x.links.map((l) => (
            <li key={l.href}>
              <ExternalLink href={l.href}>{l.label}</ExternalLink>
            </li>
          ))}
        </ul>
      ) : null}
      {mitBild && x.plan ? (
        <details class="lp-extra-kabel">
          <summary>Kabel und Quellen</summary>
          <KabelTabelle kabel={[...x.plan.kabel, ...(x.plan.frei ?? [])]} />
        </details>
      ) : null}
    </section>
  );
}

function KabelTabelle({ kabel }: { kabel: ListenKabel[] }) {
  return (
    <div class="lp-table-wrap">
      <table class="lp-table">
        <thead>
          <tr>
            <th>Farbe</th>
            <th>Kabel</th>
            <th>Quelle</th>
          </tr>
        </thead>
        <tbody>
          {kabel.map((k, i) => (
            <tr key={i}>
              <td class="lp-color">
                {k.farbe ? (
                  <>
                    <span class="lp-swatch" style={{ background: k.farbe }} aria-hidden="true" />
                    <span class="small">{FARBNAMEN[k.farbe] ?? ''}</span>
                  </>
                ) : (
                  '–'
                )}
              </td>
              <td>
                {k.text}
                {stufeVon(k.belege) === 'nachsehen' ? <span class="lp-check"> {STUFE_TEXT.nachsehen}</span> : null}
              </td>
              <td class="small soft">{quelleVon(k.belege)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
