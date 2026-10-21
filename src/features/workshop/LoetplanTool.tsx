/**
 * "Lötplan": one big, colourful picture of what goes where when soldering a
 * TonUINO, to lay next to you while soldering or to print. Above it the
 * board (Classic v1.7, Classic without board, AiO, AiO+), 3 or 5 buttons,
 * the headphone socket and the view from below; the steps, the list of all
 * wires and the extras are folded away below it.
 * Data and texts: loetplan.ts, loetplanVerdrahtung.ts; the pictures:
 * LoetplanSketch.tsx (Classic v1.7 board), LoetplanSchema.tsx (the rest).
 */
import '../../ui/styles/loetplan.css';
import { useEffect, useState } from 'preact/hooks';
import { route } from '../../app/router';
import { ArrowRight, Printer } from 'lucide-preact';
import { Button, Callout, Segmented } from '../../ui/components/controls';
import { ToolHeader } from './common';
import {
  aufbau,
  FARBNAMEN,
  loetplanWahl,
  mitAnsicht,
  mitArduino,
  mitKopfhoerer,
  schalteExtra,
  SCHRITTE,
  schrittText,
  waehle,
  wahlText,
  warnung,
  type Ansicht,
  type Arduino,
  type Kopfhoerer,
  type ListenKabel,
  type LoetplanWahl,
  type Platine,
  type Schritt,
  type Tasten,
} from './loetplan';
import { quelleVon, stufeVon, STUFE_TEXT } from './loetplanBelege';
import { a5Konflikt, d6Konflikt, extras, firmwareText, schema, schemaText, type ExtraPlan } from './loetplanVerdrahtung';
import { LoetplanSchema } from './LoetplanSchema';
import { LoetplanSketch, sketchLabel } from './LoetplanSketch';
import { keepsLogConnection, logSession } from './logsession';

function print() {
  try {
    window.print();
  } catch {
    // A window without printing: nothing to do, the picture is still on screen.
  }
}

export function LoetplanTool() {
  const wahl = loetplanWahl.value;
  // Box testen sends you here to look at a joint and keeps the box connected; any other page frees the port.
  useEffect(
    () => () => {
      if (logSession.connected && !keepsLogConnection(route.peek())) void logSession.disconnect();
    },
    [],
  );
  // The steps only light up their part of the picture while they are open.
  // Controlled, so the panel comes back open with the faded picture after
  // another board was shown (it is not rendered for those).
  const [stepsOpen, setStepsOpen] = useState(false);
  const [schritt, setSchritt] = useState<Schritt>(1);
  // Open from the start when extras are chosen, so they are not hidden away on the next visit.
  const [extrasOpen, setExtrasOpen] = useState(wahl.extras.length > 0);
  const shown: Schritt = stepsOpen ? schritt : 0;
  const plan = schema(wahl);
  const text = plan ? schemaText(wahl) : null;
  const liste: ListenKabel[] = plan ? [...plan.kabel, ...(plan.frei ?? [])] : aufbau(wahl).kabel;
  return (
    <div class="page ws-page lp-page">
      <ToolHeader title="Lötplan" intro="Zum Danebenlegen beim Löten. Jede Farbe ist ein Kabel. Gleiche Farbe = gleiches Kabel.">
        <div class="lp-noprint">
          <Button icon={Printer} onClick={print}>
            Drucken
          </Button>
        </div>
      </ToolHeader>

      <div class="lp-switches lp-noprint">
        <div class="lp-switch lp-switch-platine">
          <span class="lp-switch-label">Platine</span>
          <Segmented<Platine>
            label="Platine"
            value={wahl.platine}
            options={[
              { value: 'classic', label: 'Classic v1.7' },
              { value: 'frei', label: 'Classic ohne Platine' },
              { value: 'aio', label: 'AiO' },
              { value: 'aioplus', label: 'AiO+' },
            ]}
            onChange={(platine) => waehle({ platine })}
          />
        </div>
        {mitArduino(wahl.platine) ? (
          <div class="lp-switch">
            <span class="lp-switch-label">Arduino</span>
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
        <div class="lp-switch">
          <span class="lp-switch-label">Tasten</span>
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
        {mitKopfhoerer(wahl.platine) ? (
          <div class="lp-switch lp-switch-kh">
            <span class="lp-switch-label">Kopfhörer</span>
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
          <div class="lp-switch">
            <span class="lp-switch-label">Ansicht</span>
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
      </div>

      <figure class="card lp-bild">
        <figcaption class="lp-caption">{wahlText(wahl)}</figcaption>
        {/* The faded parts look broken from up here, and the panel that explains them is far below: say it at the picture. */}
        {shown ? (
          <p class="lp-step-note lp-noprint">
            Kräftig ist nur Schritt {shown} von 5 ({SCHRITTE[shown].h.replace(/^Schritt \d+: /, '')}), der Rest ist blass.{' '}
            <button type="button" class="link-button" onClick={() => setStepsOpen(false)}>
              Ganzes Bild zeigen
            </button>
          </p>
        ) : null}
        <p class="lp-swipe lp-noprint">Das Bild ist breiter als der Bildschirm: zur Seite wischen.</p>
        <div class="lp-scroll">
          {plan ? (
            <LoetplanSchema plan={plan} label={sketchLabel(wahl)} />
          ) : shown ? (
            // Paper always gets the whole picture: the faded one stays on screen, a plain copy goes to the printer.
            <>
              <div class="lp-noprint">
                <LoetplanSketch wahl={wahl} schritt={shown} />
              </div>
              <div class="lp-print-only">
                <LoetplanSketch wahl={wahl} />
              </div>
            </>
          ) : (
            <LoetplanSketch wahl={wahl} />
          )}
        </div>
        <p class="lp-compare">{plan ? 'Verbinde immer nach dem Aufdruck auf den Teilen. Die Lage im Bild ist nur eine Hilfe.' : 'Vergleiche den Aufdruck auf deiner Platine mit dem Bild. Andere Platinen-Versionen können anders beschriftet sein.'}</p>
        <p class="lp-compare lp-firmware">{firmwareText(wahl)}</p>
        {wahl.tasten === 3 ? (
          // Both firmwares ship with invertVolumeButtons on (settingsguide.ts FACTORY_SETTINGS), and it can be switched.
          <p class="lp-compare">
            Ab Werk ändert kurz drücken auf Vor und Zurück die Lautstärke, lang drücken wechselt den Titel. Umstellen: Werkstatt &gt; <a href="#/werkstatt/einstellen">Box einstellen</a> &gt; Tasten.
          </p>
        ) : null}
      </figure>

      {text ? (
        <Callout tone="warning">
          <div class="stack tight">
            <ul class="lp-hints">
              {text.li.map((li) => (
                <li key={li}>{li}</li>
              ))}
            </ul>
            <span>
              <b>Achtung:</b> {text.warnung}
            </span>
          </div>
        </Callout>
      ) : (
        <Callout tone="warning">
          <div class="stack tight">
            <span>{SCHRITTE[0].li.join(' ')}</span>
            <span>
              <b>Achtung:</b> {warnung(0, wahl)}
            </span>
          </div>
        </Callout>
      )}

      {plan ? null : (
        <details class="ws-later lp-noprint" open={stepsOpen} onToggle={(e) => setStepsOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>Schritt für Schritt: Was kommt zuerst?</summary>
          <Steps wahl={wahl} schritt={schritt} onSchritt={setSchritt} />
        </details>
      )}

      <details class="ws-later lp-noprint">
        <summary>Alle Kabel als Liste</summary>
        <WireList wahl={wahl} kabel={liste} />
      </details>

      <details class="ws-later lp-noprint" open={extrasOpen} onToggle={(e) => setExtrasOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>Mehr: Extras{wahl.extras.length ? ` (${wahl.extras.length} gewählt)` : ''}</summary>
        {extrasOpen ? <Extras wahl={wahl} /> : null}
      </details>

      <section class="card pad lp-next lp-noprint" aria-labelledby="lp-next-title">
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
    </div>
  );
}

const STEP_OPTIONS = ([1, 2, 3, 4, 5] as const).map((n) => ({
  value: n as Schritt,
  label: SCHRITTE[n].t,
}));

function Steps({ wahl, schritt, onSchritt }: { wahl: LoetplanWahl; schritt: Schritt; onSchritt: (s: Schritt) => void }) {
  const warn = warnung(schritt, wahl);
  return (
    <div class="card pad stack lp-steps">
      <p class="soft small">Im Bild oben ist jetzt nur dieser Schritt kräftig, der Rest blass.</p>
      <Segmented<Schritt> label="Schritt" value={schritt} options={STEP_OPTIONS} onChange={onSchritt} />
      <h3 class="lp-step-title">{SCHRITTE[schritt].h}</h3>
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
  );
}

function Extras({ wahl }: { wahl: LoetplanWahl }) {
  const alle = extras(wahl);
  const gewaehlt = alle.filter((x) => wahl.extras.includes(x.id) && !x.gesperrt);
  const doppelt = [d6Konflikt(wahl), a5Konflikt(wahl)].filter(Boolean);
  return (
    <div class="stack lp-extras">
      <p class="soft small">Wähle aus, was du einbauen willst. Jedes Extra bekommt sein eigenes Bild mit den Kabeln, die dazukommen.</p>
      <ul class="lp-extra-wahl" aria-label="Extras">
        {alle.map((x) => (
          <li key={x.id}>
            <label class={`lp-extra-chip${x.gesperrt ? ' is-off' : ''}`}>
              <input type="checkbox" checked={wahl.extras.includes(x.id) && !x.gesperrt} disabled={!!x.gesperrt} onChange={() => schalteExtra(x.id)} />
              <span class="lp-extra-chip-text">
                <b>{x.titel}</b>
                <span class="small soft">{x.gesperrt ?? x.kurz}</span>
              </span>
              {x.plan || x.gesperrt ? null : <span class="lp-extra-tag">nur Erklärung</span>}
            </label>
          </li>
        ))}
      </ul>
      {doppelt.map((text) => (
        <Callout key={text} tone="danger">
          <span>
            <b>Achtung:</b> {text}
          </span>
        </Callout>
      ))}
      {gewaehlt.map((x) => (
        <Extra key={x.id} x={x} />
      ))}
    </div>
  );
}

function Extra({ x }: { x: ExtraPlan }) {
  return (
    <section class="card pad stack lp-extra" aria-label={x.titel}>
      <h3 class="lp-step-title">{x.titel}</h3>
      {x.plan ? (
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
              <b>Warum es dafür kein Bild gibt:</b> {x.fehlt.warum}
            </span>
            <span>
              <b>Was es beweisen würde:</b> {x.fehlt.beweis}
            </span>
          </div>
        </Callout>
      ) : null}
      {x.plan && x.warnung ? (
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
      {x.plan ? (
        <details class="lp-extra-kabel">
          <summary>Kabel und Quellen</summary>
          <KabelTabelle kabel={[...x.plan.kabel, ...(x.plan.frei ?? [])]} />
        </details>
      ) : null}
    </section>
  );
}

function WireList({ wahl, kabel }: { wahl: LoetplanWahl; kabel: ListenKabel[] }) {
  return (
    <div class="card pad stack lp-wires">
      <KabelTabelle kabel={kabel} />
      <p class="small soft">
        {wahl.platine === 'classic'
          ? 'Platinen-Aufdruck abgelesen von Fotos einer Classic-Platine v1.7 (Leiterkartenpiraten). Pins aus dem TonUINO-TNG-Quellcode (src/constants.hpp). Kopfhörerplatine laut Forum discourse.voss.earth Thema 2463. Andere Platinen-Versionen können anders beschriftet sein: Vergleiche den Aufdruck auf deiner Platine mit dem Bild.'
          : 'Anschlüsse aus den geprüften Unterlagen des Bauassistenten: TonUINO-TNG-Quellcode und -Schaltplan, Datenblätter, Anleitungen der Leiterkartenpiraten und das Forum discourse.voss.earth. „Vor dem Löten nachsehen“ heißt: Die Quelle ist nicht ganz sicher, vergleiche vor dem Löten mit dem Aufdruck.'}
      </p>
      <p class="small soft">Gilt für: {wahlText(wahl)}.</p>
    </div>
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
