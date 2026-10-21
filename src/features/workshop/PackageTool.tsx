/**
 * Werkstatt > Paket auf die Karte bringen (Firefox, Safari): a Paket that
 * was downloaded earlier, or one someone else made, goes onto the card with
 * the same guide, and the card is checked against it afterwards.
 */
import { useState } from 'preact/hooks';
import { ArrowLeft, ArrowRight, CircleCheck, FileArchive, TriangleAlert } from 'lucide-preact';
import { acceptCheckedCard, foreignPackageChecked, packageState, snapshotOfCard } from '../../app/pending';
import { navigate } from '../../app/router';
import { catalog, plat } from '../../app/state';
import type { PackageManifest } from '../../core/tonuino/package';
import { parseFolderNumber } from '../../core/tonuino/sd';
import { checkDownloadedPackage, replacedByPackage } from '../../core/tonuino/verify';
import type { SnapshotResult } from '../../platform/snapshot';
import { Button, Callout } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { ChangedElsewhereNotice } from '../box/ChangedElsewhere';
import { useCardCheck } from '../box/CheckCard';
import { finderName } from '../box/PackageDialog';
import { PackageGuide } from '../box/PackageGuide';
import { PendingChanges } from '../box/PendingChanges';
import { ToolHeader } from './common';

const INTRO = 'Ein Paket entpacken, das du heruntergeladen oder bekommen hast, und die Karte damit vergleichen.';

type Step =
  | { kind: 'pick' }
  /** `own`: the Paket this app made for the card that is open. */
  | { kind: 'guide'; manifest: PackageManifest; own: boolean }
  | { kind: 'check'; manifest: PackageManifest; own: boolean };

export function PackageTool() {
  if (!plat().cardSnapshot) {
    return (
      <div class="page narrow ws-page">
        <ToolHeader title="Paket auf die Karte bringen" intro={INTRO} />
        <Callout tone="info">
          <div class="stack tight">
            <span>Hier schreibe ich direkt auf die SD-Karte. Ein Paket brauchst du nur in Firefox und Safari.</span>
            <span>Hast du ein Paket bekommen? Entpacke es wie jede ZIP-Datei auf die Karte.</span>
          </div>
        </Callout>
      </div>
    );
  }
  return <PackageToolSteps />;
}

function PackageToolSteps() {
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  // A Paket from elsewhere that replaces something on the card: the user said go ahead.
  const [replaceOk, setReplaceOk] = useState(false);
  const reading = snapshotOfCard.value;
  const label = reading?.label;

  const pick = async () => {
    setProblem(null);
    try {
      const [file] = await plat().pickFiles({ extensions: ['zip'] });
      if (!file) return;
      setBusy(true);
      setReplaceOk(false);
      // The Paket that waits for the open card: then the check takes the card as the new start.
      const st = packageState.peek();
      if (st.kind === 'downloaded') {
        const mine = await checkDownloadedPackage(file, st.manifest);
        if (mine.ok) {
          setNameEdit(null);
          setStep({ kind: 'guide', manifest: mine.manifest, own: true });
          return;
        }
      }
      const r = await checkDownloadedPackage(file);
      if (r.ok) {
        setNameEdit(null);
        setStep({ kind: 'guide', manifest: r.manifest, own: false });
      } else if (r.reason === 'not-finished') setProblem('Das Paket ist nicht vollständig heruntergeladen. Lade es noch einmal herunter.');
      else setProblem('Das ist kein TonUINO-Paket.');
    } catch (e) {
      toastError('Das Paket ließ sich nicht lesen', e);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setProblem(null);
    setStep({ kind: 'pick' });
  };

  let body;
  switch (step.kind) {
    case 'pick':
      body = (
        <section class="card pad stack" aria-labelledby="ws-package-pick">
          <h2 id="ws-package-pick">Welches Paket?</h2>
          <p class="soft">
            Wähle die ZIP-Datei aus, meist liegt sie in deinem Download-Ordner. Ich zeig dir dann, wie du sie auf die Karte bringst, und prüfe die Karte danach.
          </p>
          {problem ? <Callout tone="warning">{problem}</Callout> : null}
          <div class="row wrap">
            <Button variant="primary" icon={FileArchive} loading={busy} onClick={pick}>
              Paket auswählen
            </Button>
          </div>
        </section>
      );
      break;
    case 'guide': {
      const name = nameEdit ?? finderName(step.manifest.mode, label);
      const toCheck = () => setStep({ kind: 'check', manifest: step.manifest, own: step.own });
      const replaced = !step.own && reading ? replacedByPackage(reading.root, step.manifest) : null;
      if (replaced && (replaced.folders.length || replaced.appFiles) && !replaceOk) {
        body = <ReplaceWarning replaced={replaced} onBack={restart} onGo={() => setReplaceOk(true)} />;
        break;
      }
      body = (
        <section class="card pad stack" aria-labelledby="ws-package-guide">
          <h2 id="ws-package-guide">So kommt das Paket auf die Karte</h2>
          {!step.own && !reading ? (
            <Callout tone="info">
              <div class="stack tight">
                <span>Lies zuerst die SD-Karte ein. Dann sag ich dir, ob das Paket etwas auf deiner Karte ersetzt.</span>
                <div>
                  <Button size="sm" onClick={() => navigate({ page: 'box' })}>
                    Zur SD-Karte
                  </Button>
                </div>
              </div>
            </Callout>
          ) : null}
          <PackageGuide manifest={step.manifest} fresh={false} cardName={name} onCardName={setNameEdit} foreign={!step.own} verified onCheck={toCheck} />
          <div class="row wrap ws-package-actions">
            <Button variant="ghost" icon={ArrowLeft} onClick={restart}>
              Anderes Paket
            </Button>
            <div class="spacer" />
            <Button variant="primary" icon={CircleCheck} onClick={toCheck}>
              Karte prüfen
            </Button>
          </div>
        </section>
      );
      break;
    }
    case 'check':
      body = <CheckStep key={step.manifest.name} manifest={step.manifest} own={step.own} cardName={nameEdit ?? finderName(step.manifest.mode, label)} onDone={restart} />;
      break;
  }

  return (
    <div class="page narrow ws-page">
      <ToolHeader title="Paket auf die Karte bringen" intro={INTRO} />
      {step.kind === 'pick' ? <PendingChanges /> : null}
      {body}
    </div>
  );
}

/**
 * A Paket from elsewhere brings whole folders and perhaps its own names and
 * pictures. Unpacked, it replaces what the card has under the same numbers:
 * say so before the guide, in the family's own words for those folders.
 */
function ReplaceWarning({ replaced, onBack, onGo }: { replaced: { folders: string[]; appFiles: boolean }; onBack: () => void; onGo: () => void }) {
  const cat = catalog.value;
  const folderLine = (name: string) => {
    const n = parseFolderNumber(name);
    const title = n !== null ? cat?.folders[name]?.title : undefined;
    const own = title && title !== `Ordner ${name}` ? ` („${title}“)` : '';
    if (n !== null) return `Ordner ${name}${own}`;
    return /^(mp3|advert)$/i.test(name) ? `Ordner ${name} (Systemansagen)` : `Ordner „${name}“`;
  };
  return (
    <section class="card pad stack" aria-labelledby="ws-package-replace">
      <h2 id="ws-package-replace" class="row">
        <TriangleAlert size={20} aria-hidden="true" /> Das Paket ersetzt etwas auf deiner Karte
      </h2>
      <ul class="stack tight" style={{ paddingLeft: 18 }}>
        {replaced.folders.map((f) => (
          <li key={f}>{folderLine(f)}. Er wird gelöscht, und das aus dem Paket kommt an seine Stelle.</li>
        ))}
        {replaced.appFiles ? (
          <li>
            Die Namen und Bilder deiner Box{cat?.name ? ` („${cat.name}“)` : ''}. Danach hat die Box die Namen und Bilder aus dem Paket, auch für deine anderen Ordner.
          </li>
        ) : null}
      </ul>
      <p class="soft">Was ersetzt wird, ist danach weg. Willst du das nicht, frage nach einem Paket mit anderen Ordnernummern.</p>
      <div class="row wrap ws-package-actions">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
          Anderes Paket
        </Button>
        <div class="spacer" />
        <Button variant="danger" icon={ArrowRight} onClick={onGo}>
          Verstanden, weiter
        </Button>
      </div>
    </section>
  );
}

function CheckStep({ manifest, own, cardName, onDone }: { manifest: PackageManifest; own: boolean; cardName: string; onDone: () => void }) {
  // A Paket from elsewhere: when nothing waits in the app, the checked card is opened as read.
  // When own changes wait, they were planned for the card as it was: the notice below says so.
  const onAccept = async (r: SnapshotResult) => {
    if (own) return acceptCheckedCard(r);
    await foreignPackageChecked(r, manifest.name);
  };
  const check = useCardCheck({ manifest, cardName, onAccept, manualAccept: own, onClose: onDone });
  return (
    <section class="card pad stack" aria-labelledby="ws-package-check">
      <h2 id="ws-package-check">Karte prüfen</h2>
      {check.body}
      {own ? null : <ChangedElsewhereNotice onDone={onDone} />}
      <div class="row wrap ws-package-actions">
        <div class="spacer" />
        {check.footer}
      </div>
    </section>
  );
}
