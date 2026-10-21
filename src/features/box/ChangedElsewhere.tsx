import { useState } from 'preact/hooks';
import { RefreshCw, TriangleAlert } from 'lucide-preact';
import { cardChangedElsewhere, packageState, plan, rereadChangedCard, takeChangedCard } from '../../app/pending';
import { catalog } from '../../app/state';
import { Button, Callout } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { changedElsewhereText, changeLines, firstLines } from './packageTexts';

/**
 * A Paket from elsewhere is on the card now, while the app's own changes
 * (or an own Paket) were planned for the card as it was: say so plainly and
 * let the user take the card as it is now. Until then nothing new goes into
 * a Paket (see cardChangedElsewhere in app/pending.ts). Renders nothing
 * when the card did not change elsewhere.
 */
export function ChangedElsewhereNotice({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const c = cardChangedElsewhere.value;
  const st = packageState.value;
  const p = plan.value;
  const [busy, setBusy] = useState(false);
  if (!c) return null;
  const own = st.kind === 'downloaded' ? st.at : undefined;
  const lines = changedElsewhereText({ packageName: c.packageName, pending: p?.count ?? 0, ownPackageAt: own });
  // What the user may want to do again afterwards.
  const redo = own === undefined && p ? firstLines(changeLines(p, catalog.value, true), 4, true) : [];
  const take = async () => {
    setBusy(true);
    try {
      await takeChangedCard();
      onDone?.();
    } catch (e) {
      toastError('Die Karte ließ sich nicht übernehmen', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Callout tone="warning" icon={TriangleAlert}>
      <div class="stack tight changed-elsewhere" role="status">
        <b>Die Karte hat sich geändert</b>
        {lines.map((l) => (
          <span key={l}>{l}</span>
        ))}
        {redo.length && !compact ? (
          <>
            <span>Das hattest du geplant:</span>
            <ul class="small" style={{ margin: 0, paddingLeft: 18 }}>
              {redo.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </>
        ) : null}
        <div class="row wrap">
          <Button variant="primary" loading={busy} onClick={take}>
            Neuen Stand übernehmen
          </Button>
          <Button
            icon={RefreshCw}
            disabled={busy}
            onClick={() => {
              rereadChangedCard();
              onDone?.();
            }}
          >
            Karte neu einlesen
          </Button>
        </div>
      </div>
    </Callout>
  );
}
