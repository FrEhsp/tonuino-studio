import { CardSim, RotateCcw, X } from 'lucide-preact';
import { cardNote, cardReading, chooseCardFolder, openSnapshot } from '../../app/pending';
import { pickedSubfolder } from '../../platform/snapshot';
import type { SnapshotPurpose } from '../../platform/types';
import { Button, Callout } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { useChooserHint } from '../../ui/useCardDrop';
import { pickedSubfolderText, problemText } from './packageTexts';

/**
 * Reading the SD card in browsers that cannot write to it (Firefox,
 * Safari): the button for the folder chooser, the line about dropping the
 * card, what is happening and what went wrong.
 */

export const UPLOAD_HINT =
  'Dein Browser fragt vielleicht, ob du alle Dateien „hochladen“ willst. Das heißt hier nur, dass ich sie lesen darf. Alles bleibt auf deinem Computer, nichts geht ins Internet.';

export const CHOOSER_HINT = 'Nichts passiert? Klicke noch einmal auf „SD-Karte einlesen“ und bestätige im Fenster des Browsers mit „Hochladen“.';

/** The button, the drop line, the progress of a dropped card and the hint when nothing came back. */
export function CardReader({ purpose, over, size = 'lg', label = 'SD-Karte einlesen' }: { purpose: SnapshotPurpose; over: boolean; size?: 'md' | 'lg'; label?: string }) {
  const reading = cardReading.value?.purpose === purpose ? cardReading.value : null;
  const hint = useChooserHint(purpose);
  return (
    <div class="stack">
      <div class="row wrap">
        <Button variant="primary" size={size} icon={CardSim} loading={!!reading} onClick={() => chooseCardFolder(purpose)}>
          {label}
        </Button>
        <span class={`card-drop-line ${over ? 'over' : ''}`}>{over ? 'Loslassen, dann lese ich die Karte ein.' : 'Oder ziehe die Karte hierher.'}</span>
      </div>
      <div role="status" class="card-reading">
        {reading ? (
          <span class="row soft">
            <span class="spinner" aria-hidden="true" />
            Liest die Karte ein … {reading.files ? `${reading.files.toLocaleString('de-DE')} Dateien` : ''}
          </span>
        ) : null}
      </div>
      {hint && !reading ? <Callout tone="warning">{CHOOSER_HINT}</Callout> : null}
    </div>
  );
}

/** What the last reading of the card brought instead of the card. Empty cards are told about on the setup page. */
export function CardNoteCallout() {
  const n = cardNote.value;
  if (!n || n.kind === 'looks-empty') return null;
  const dismiss = (
    <Button size="sm" variant="ghost" icon={X} aria-label="Hinweis schließen" title="Hinweis schließen" onClick={() => (cardNote.value = null)} />
  );
  if (n.kind === 'problem') {
    return (
      <Callout tone="danger">
        <div class="row wrap card-note">
          <span class="grow">{problemText(n.problem, n.source)}</span>
          <Button size="sm" icon={RotateCcw} onClick={() => chooseCardFolder('card')}>
            Noch einmal einlesen
          </Button>
          {dismiss}
        </div>
      </Callout>
    );
  }
  const take = () => {
    openSnapshot(n.result).catch((e) => toastError('Die Karte ließ sich nicht öffnen', e));
  };
  return (
    <Callout tone="warning">
      <div class="row wrap card-note">
        <span class="grow">{pickedSubfolderText(pickedSubfolder(n.result) ?? n.result.label)}</span>
        <Button size="sm" variant="primary" icon={RotateCcw} onClick={() => chooseCardFolder('card')}>
          Noch einmal einlesen
        </Button>
        <button type="button" class="link-button" onClick={take}>
          Trotzdem so nehmen
        </button>
        {dismiss}
      </div>
    </Callout>
  );
}
