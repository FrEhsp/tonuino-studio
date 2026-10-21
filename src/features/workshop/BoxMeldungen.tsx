/**
 * The banner at the top of the Werkstatt pages: problems the connected box
 * reported in the background (boxwatch.ts), each with the joint to check. It
 * folds open; "Ausblenden" hides it until the next new problem.
 */
import { AlertTriangle, ArrowRight, TriangleAlert } from 'lucide-preact';
import { Button } from '../../ui/components/controls';
import { stellenText, TEIL_NAMEN } from './boxbefund';
import { boxMeldungen, boxMeldungenAus } from './boxwatch';
import { loetplanWahl } from './loetplan';

export function BoxMeldungen() {
  const list = boxMeldungen.value;
  const neueste = list.reduce((m, b) => Math.max(m, b.zuletzt), 0);
  if (!list.length || boxMeldungenAus.value >= neueste) return null;
  const fehler = list.some((b) => b.ton === 'fehler');
  const Icon = fehler ? AlertTriangle : TriangleAlert;
  const platine = loetplanWahl.value.platine;
  return (
    <div class={`health-banner box-meldungen ${fehler ? 'error' : 'warning'}`} role="status">
      <div class="health-icon">
        <Icon size={24} />
      </div>
      <div class="grow stack tight">
        <b>{list.length === 1 ? 'Die Box meldet ein Problem' : `Die Box meldet ${list.length} Probleme`}</b>
        <details class="box-meldungen-mehr">
          <summary class="small">
            {list[0].titel}
            {list.length > 1 ? ' und mehr' : ''}
          </summary>
          <ul class="stack tight">
            {list.map((b) => (
              <li key={b.id} class="small">
                <b>{b.titel}</b>
                {b.anzahl > 1 ? ` (${b.anzahl}-mal)` : ''} <span class="soft">· {TEIL_NAMEN[b.teil]}</span>
                <div class="soft">{b.text}</div>
                {b.stellen.length ? <div>Prüfe diese Stelle: {stellenText(b.stellen, platine)}</div> : null}
              </li>
            ))}
          </ul>
        </details>
      </div>
      <div class="row wrap">
        <a class="link-button" href="#/werkstatt/testen">
          Box testen <ArrowRight size={15} strokeWidth={2.2} />
        </a>
        <Button size="sm" variant="ghost" onClick={() => (boxMeldungenAus.value = neueste)}>
          Ausblenden
        </Button>
      </div>
    </div>
  );
}
