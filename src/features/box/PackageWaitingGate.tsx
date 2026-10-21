import { useState } from 'preact/hooks';
import { BookOpen, CircleCheck, PackageOpen } from 'lucide-preact';
import { canChangeCard, cardChangedElsewhere, discardPackage, packageState } from '../../app/pending';
import { Button } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { openPackageDialog } from './PackageDialog';
import { namesList } from '../../core/tonuino/guide';
import type { PackageManifest } from '../../core/tonuino/package';
import { atText } from './packageTexts';
import { ChangedElsewhereNotice } from './ChangedElsewhere';

/**
 * Stands in for what changes the card's folders while a downloaded Paket
 * waits to be unpacked: the next Paket has to fit the card as it will be
 * then. Names and pictures stay open.
 */

type Confirm = 'none' | 'ask-deleted' | 'keep' | 'discard';

/** What the user may have done on the card for this Paket already, asked before it is thrown away. */
function deletedQuestion(m: PackageManifest): string | null {
  if (m.mode === 'full') return 'Hast du die Karte für dieses Paket schon formatiert?';
  if (!m.deleteFirst.length) return null;
  if (m.deleteFirst.length === 1) return `Hast du auf der Karte schon den Ordner ${m.deleteFirst[0]} gelöscht?`;
  return `Hast du auf der Karte schon Ordner gelöscht (${namesList(m.deleteFirst)})?`;
}

function GateBody({ onDone, inDialog }: { onDone?: () => void; inDialog?: boolean }) {
  const st = packageState.value;
  const [confirm, setConfirm] = useState<Confirm>('none');
  if (cardChangedElsewhere.value) return <ChangedElsewhereNotice onDone={onDone} compact={inDialog} />;
  if (st.kind !== 'downloaded') return null;
  const heading = (text: string) => (inDialog ? <b>{text}</b> : <h2>{text}</h2>);
  const go = (step: 'guide' | 'check') => {
    onDone?.();
    openPackageDialog(step);
  };
  const question = deletedQuestion(st.manifest);
  if (confirm === 'ask-deleted' && question) {
    return (
      <div class="stack package-gate">
        {heading('Paket verwerfen?')}
        <p>{question}</p>
        <div class="row wrap">
          <Button onClick={() => setConfirm('none')}>Abbrechen</Button>
          <Button onClick={() => setConfirm('keep')}>Ja, schon {st.manifest.mode === 'full' ? 'formatiert' : 'gelöscht'}</Button>
          <Button variant="danger" onClick={() => setConfirm('discard')}>
            Nein, noch nicht
          </Button>
        </div>
      </div>
    );
  }
  if (confirm === 'keep') {
    return (
      <div class="stack package-gate">
        {heading('Dann brauchst du das Paket noch')}
        <p>
          {st.manifest.mode === 'full'
            ? 'Was auf der Karte war, ist jetzt nur noch im Paket. Entpacke es auf die Karte und prüfe sie danach.'
            : 'Was in diesen Ordnern war, ist jetzt nur noch im Paket. Entpacke es auf die Karte und prüfe sie danach.'}
        </p>
        <div class="row wrap">
          <Button variant="primary" icon={BookOpen} onClick={() => go('guide')}>
            So geht’s
          </Button>
        </div>
      </div>
    );
  }
  if (confirm === 'discard') {
    return (
      <div class="stack package-gate">
        {heading('Paket verwerfen?')}
        <p>
          {st.restored
            ? 'Was im Paket ist, kommt dann nicht auf die Karte. Das Paket im Download-Ordner brauchst du dann nicht mehr.'
            : 'Deine Änderungen bleiben und kommen ins nächste Paket. Das Paket im Download-Ordner brauchst du dann nicht mehr.'}
        </p>
        <div class="row wrap">
          <Button onClick={() => setConfirm('none')}>Abbrechen</Button>
          <Button
            variant="danger"
            onClick={() => {
              discardPackage();
              onDone?.();
            }}
          >
            Paket verwerfen
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div class="stack package-gate">
      {inDialog ? null : (
        <>
          <div class="package-gate-icon" aria-hidden="true">
            <PackageOpen size={28} />
          </div>
          <h2>Erst das Paket auf die Karte bringen</h2>
        </>
      )}
      <p>
        Du hast {atText(st.at)} ein Paket heruntergeladen{st.restored ? `: „${st.manifest.name}“` : ''}. Entpacke es auf die Karte und prüfe sie. Danach kannst du hier weitermachen.
      </p>
      <div class="row wrap">
        <Button variant="primary" icon={CircleCheck} onClick={() => go('check')}>
          Karte prüfen
        </Button>
        <Button icon={BookOpen} onClick={() => go('guide')}>
          So geht’s
        </Button>
      </div>
      <button type="button" class="link-button" onClick={() => setConfirm(question ? 'ask-deleted' : 'discard')}>
        Noch nicht entpackt? Paket verwerfen
      </button>
    </div>
  );
}

/** In place of a page whose work changes the card. */
export function PackageWaitingPage() {
  return (
    <div class="page narrow">
      <GateBody />
    </div>
  );
}

/** In place of an action that changes the card, as a dialog. */
export function PackageWaitingDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title={cardChangedElsewhere.value ? 'Erst die Karte neu übernehmen' : 'Erst das Paket auf die Karte bringen'} onClose={onClose}>
      <GateBody onDone={onClose} inDialog />
    </Dialog>
  );
}

/**
 * For buttons that change the card's folders: runs `action` when that is
 * possible, else shows why not. Render `gate` somewhere in the component.
 */
export function useWaitingGate() {
  const [open, setOpen] = useState(false);
  return {
    guard:
      <A extends unknown[]>(action: (...args: A) => void) =>
      (...args: A) => {
        if (canChangeCard()) action(...args);
        else setOpen(true);
      },
    gate: open ? <PackageWaitingDialog onClose={() => setOpen(false)} /> : null,
  };
}
