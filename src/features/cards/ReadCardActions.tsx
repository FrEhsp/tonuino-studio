/**
 * What "Karte prüfen" offers for the card on the reader, as in TonUINO NFC
 * Tools: "Nachmachen" (the same card once more, on the list of cards to
 * write), "Ändern …", the raw numbers and bytes folded away, and "Karte
 * löschen", which asks first and shows what is on the card.
 */
import { useEffect, useState } from 'preact/hooks';
import { CircleCheck, CopyPlus, Eraser, PenLine } from 'lucide-preact';
import { decodeCard } from '../../core/tonuino/card';
import { RAW_FIELDS, RAW_LABELS, cardFromBytes, emptyCardBytes, type FullCard } from '../../core/tonuino/cardedit';
import { describeCard } from '../../core/tonuino/modes';
import { folderName } from '../../core/tonuino/sd';
import type { NfcAccess, NfcReadResult } from '../../platform/types';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Spinner } from '../../ui/components/controls';
import { errorText } from '../../ui/components/Hints';
import { toastError } from '../../ui/components/Toast';
import { playCue } from '../../ui/sound';
import { catalog, profile } from '../../app/state';
import { addToList, FreeCardDialog } from './FreeCardDialog';
import { readCardNow } from './readerRun';
import { holdTaps } from './nfcTap';
import '../../ui/styles/freecard.css';

/** What a card read from the reader holds, in one sentence. */
export function readCardText(data: Uint8Array): string {
  const d = decodeCard(data);
  if (d.kind === 'empty') return 'Die Karte ist leer.';
  if (d.kind === 'foreign') return 'Auf der Karte steht etwas, das keine TonUINO-Karte ist.';
  if (d.kind === 'bad-version') return `Eine TonUINO-Karte mit unbekannter Version ${d.version}.`;
  const title = d.data.folder ? catalog.value?.folders[folderName(d.data.folder)]?.title : undefined;
  const text = describeCard(d.data, profile.value);
  // The folder's name inside the sentence: "Hörbuch: Ordner 04 („Die Olchis“)." (not "Ordner 04. (Die Olchis)").
  const named = title ? `${text.replace(/\.$/, '')} („${title}“).` : text;
  return named + (d.data.version === 1 ? ' Im Kartenformat für TonUINO 2.0.' : '');
}

/** Under the result of "Karte prüfen": copy or change a TonUINO card, and its numbers and bytes. */
export function ReadCardActions({ data }: { data: Uint8Array }) {
  const card = cardFromBytes(data);
  const [edit, setEdit] = useState<FullCard | null>(null);
  const [busy, setBusy] = useState(false);
  const known = card && (card.version === 1 || card.version === 2);
  const copy = async () => {
    if (!card) return;
    setBusy(true);
    try {
      await addToList(card, profile.value, 'Lege eine leere Karte auf und schreibe sie wie die anderen.');
    } catch (e) {
      toastError('Die Karte ließ sich nicht hinzufügen', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack tight">
      {card ? (
        <div class="read-card-actions">
          {known ? (
            <Button size="sm" icon={CopyPlus} onClick={copy} loading={busy}>
              Nachmachen
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon={PenLine} onClick={() => setEdit(card)}>
            Ändern …
          </Button>
        </div>
      ) : null}
      <details class="free-card-raw">
        <summary>Zahlen und Bytes</summary>
        <div class="stack tight">
          {card ? (
            <p class="small mono">
              {RAW_FIELDS.map((f) => `${RAW_LABELS[f]} ${card[f]}`).join(' · ')}
            </p>
          ) : null}
          <p class="small mono free-card-bytes">{[...data].map((b) => b.toString(16).padStart(2, '0')).join(' ')}</p>
        </div>
      </details>
      {edit ? <FreeCardDialog start={edit} onClose={() => setEdit(null)} /> : null}
    </div>
  );
}

type DeleteState =
  | { step: 'reading' }
  | { step: 'seen'; card: NfcReadResult; text: string }
  | { step: 'deleting'; card: NfcReadResult; text: string }
  | { step: 'done' }
  | { step: 'error'; message: string };

/**
 * "Karte löschen": reads the card first and says what is on it, then writes
 * sixteen zeros on the asking. The box then greets the card as new. Another
 * card put on the reader in between is not deleted: it is shown first.
 */
export function DeleteCardDialog({ nfc, reader, onClose }: { nfc: NfcAccess; reader: string; onClose: () => void }) {
  const [state, setState] = useState<DeleteState>({ step: 'reading' });
  // The Android app: the card is held to the phone, not laid on a reader.
  const phone = !!nfc.phone;
  // A card held to the phone meanwhile is this dialog's, not news for the cards page (nfcTap.ts).
  useEffect(() => holdTaps(), []);
  const read = async () => {
    setState({ step: 'reading' });
    try {
      const card = await readCardNow(nfc, reader);
      if (!card) {
        setState({ step: 'error', message: 'Keine Karte erkannt. Halte die Karte an die Rückseite deines Handys und tippe auf „Noch einmal lesen“.' });
        return;
      }
      setState({ step: 'seen', card, text: readCardText(card.data) });
    } catch (e) {
      setState({ step: 'error', message: errorText(e) });
    }
  };
  useEffect(() => {
    void read();
  }, []);

  const erase = async () => {
    if (state.step !== 'seen') return;
    setState({ ...state, step: 'deleting' });
    try {
      const now = await nfc.read(reader);
      if (now.uid !== state.card.uid) {
        // Another card lies there now: show it, and ask again.
        setState({ step: 'seen', card: now, text: readCardText(now.data) });
        return;
      }
      await nfc.write(reader, emptyCardBytes(), now.uid);
      void playCue('cardWritten');
      setState({ step: 'done' });
    } catch (e) {
      setState({ step: 'error', message: errorText(e) });
    }
  };

  const seen = state.step === 'seen' || state.step === 'deleting' ? state : undefined;
  const empty = seen ? decodeCard(seen.card.data).kind === 'empty' : false;
  const foreign = seen ? decodeCard(seen.card.data).kind === 'foreign' : false;
  return (
    <Dialog
      title="Karte löschen"
      onClose={onClose}
      dismissable={state.step !== 'deleting'}
      footer={
        state.step === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={state.step === 'deleting'}>
              Abbrechen
            </Button>
            {state.step === 'error' ? <Button onClick={read}>Noch einmal lesen</Button> : null}
            {seen && !empty ? (
              <Button variant="danger" icon={Eraser} onClick={erase} loading={state.step === 'deleting'}>
                Karte löschen
              </Button>
            ) : null}
          </>
        )
      }
    >
      <div class="stack">
        {state.step === 'reading' ? (
          <p class="row tight">
            <Spinner size={16} /> {phone ? 'Halte die Karte an die Rückseite deines Handys …' : 'Lese die Karte auf dem Leser …'}
          </p>
        ) : null}
        {seen ? (
          <>
            {empty ? (
              <p>
                Die Karte ist schon leer. Da gibt es nichts zu löschen. <span class="soft small">Nummer {seen.card.uid}.</span>
              </p>
            ) : (
              <p>
                <b>Auf der Karte steht:</b> {seen.text} <span class="soft small">Nummer {seen.card.uid}.</span>
              </p>
            )}
            {empty ? null : (
              <Callout tone="warning">
                Nach dem Löschen ist die Karte leer. Die Box sagt dann „Oh, eine neue Karte!“ und du kannst sie neu belegen.
                {foreign ? ' Ich überschreibe nur die 16 Bytes, die TonUINO nutzt. Was sonst darauf steht, bleibt.' : ''}
              </Callout>
            )}
          </>
        ) : null}
        {state.step === 'done' ? (
          <Callout tone="success" icon={CircleCheck}>
            Die Karte ist jetzt leer.
          </Callout>
        ) : null}
        {state.step === 'error' ? (
          <Callout tone="warning">
            {state.message}
            {phone ? null : ' Liegt die Karte mittig auf dem Leser?'}
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}
