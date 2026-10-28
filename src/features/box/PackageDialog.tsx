import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CircleCheck, Download } from 'lucide-preact';
import { formatBytes } from '../../app/format';
import {
  acceptCheckedCard,
  BUSY_TEXT,
  cardChangedElsewhere,
  copyBusy,
  discardedPackages,
  copyOfCard,
  makePackage,
  packageState,
  plan,
  previewPackage,
  snapshotOfCard,
  startPackageDownload,
  type DownloadedPackage,
} from '../../app/pending';
import { card, catalog, platform } from '../../app/state';
import { holdForPackage } from '../../app/packageHold';
import { needsPackageCheck } from '../../core/tonuino/guide';
import { fat32Limits, knownFoldersMissing, type PackageContent, type PackageManifest, type PackageMode } from '../../core/tonuino/package';
import type { WritePlan } from '../../core/tonuino/writeplan';
import { Badge, Button, Callout, Progress } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { errorText } from '../../ui/components/Hints';
import { arrowKeyHandler } from '../../ui/arrowKeys';
import { ChangedElsewhereNotice } from './ChangedElsewhere';
import { useCardCheck } from './CheckCard';
import { PackageGuide } from './PackageGuide';
import { changeLines, firstLines, foldersText, hiddenFilesText, REASON_TEXT, SAY_SPACE_FROM, spaceText, fromText, OVER_CARD_TEXT, tooBigText, unreadText } from './packageTexts';
import '../../ui/styles/package.css';

/**
 * The Paket for the card (Firefox, Safari): choose what goes in, pack it,
 * download it, follow the guide, check the card. One dialog for the whole
 * way, opened from wherever the user is.
 */

export type PackageStep = 'choose' | 'guide' | 'check';

const dialog = signal<{ step: PackageStep; seq: number } | null>(null);
let seq = 0;

/** Opens the dialog. Without a step: the guide while a Paket waits, else the choice. */
export function openPackageDialog(step?: PackageStep): void {
  const waiting = packageState.peek().kind === 'downloaded';
  dialog.value = { step: step ?? (waiting ? 'guide' : 'choose'), seq: ++seq };
}

export function closePackageDialog(): void {
  dialog.value = null;
}

export function PackageDialogHost() {
  const d = dialog.value;
  if (!d || card.value?.volume.access !== 'snapshot') return null;
  return <PackageDialog key={d.seq} initial={d.step} onClose={closePackageDialog} />;
}

type View =
  | { kind: 'choose' }
  | { kind: 'build'; mode: PackageMode; done: number; total: number }
  | { kind: 'ready'; blob: Blob; manifest: PackageManifest }
  | { kind: 'guide' }
  | { kind: 'remove-only'; manifest: PackageManifest }
  | { kind: 'check'; manifest: PackageManifest };

const SAFARI_NOTE =
  'Mit Safari: Schalte vorher unter Safari > Einstellungen > Allgemein „Sichere Dateien nach dem Laden öffnen“ aus. Sonst packt Safari das Paket selbst aus, und so klappt es auf der Karte nicht.';

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

function initialView(step: PackageStep): View {
  const st = packageState.peek();
  if (st.kind === 'downloaded') {
    if (step === 'guide') return { kind: 'guide' };
    if (step === 'check') return { kind: 'check', manifest: st.manifest };
  }
  return { kind: 'choose' };
}

/** The card's name in the Finder: a formatted card is called TONUINO, one without a name NO NAME. */
export function finderName(mode: PackageMode, label: string | undefined): string {
  if (mode === 'full') return 'TONUINO';
  return !label || label === 'SD-Karte' ? 'NO NAME' : label;
}

function PackageDialog({ initial, onClose }: { initial: PackageStep; onClose: () => void }) {
  const [view, setView] = useState<View>(() => initialView(initial));
  const [error, setError] = useState<string | null>(null);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  // "Karte prüfen" waits in the footer until the guide shows the steps after "Paket prüfen".
  // Until the guide said so for this Paket, the Paket alone tells whether there is such a gate.
  const [stepsOpen, setStepsOpen] = useState<{ name: string; open: boolean } | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const st = packageState.value;
  const label = snapshotOfCard.value?.label;
  // While packing and until „Paket speichern“: nothing else may change the copy, or the Paket would be stale.
  const inHand = view.kind === 'build' || view.kind === 'ready';
  useEffect(() => (inHand ? holdForPackage() : undefined), [inHand]);

  const download = (blob: Blob, manifest: PackageManifest) => {
    try {
      startPackageDownload(blob, manifest);
      setView({ kind: 'guide' });
    } catch (e) {
      setError(errorText(e));
      setView({ kind: 'choose' });
    }
  };

  const build = async (mode: PackageMode, removeOnly: boolean) => {
    setError(null);
    const c = new AbortController();
    ctrl.current = c;
    if (!removeOnly) setView({ kind: 'build', mode, done: 0, total: 0 });
    try {
      const built = await makePackage(mode, { signal: c.signal, onProgress: (done, total) => setView({ kind: 'build', mode, done, total }) });
      if (removeOnly) setView({ kind: 'remove-only', manifest: built.manifest });
      else if (built.needsClick) setView({ kind: 'ready', blob: built.blob, manifest: built.manifest });
      // Nothing had to be read: the download starts within this click (Safari downloads only right after one).
      else download(built.blob, built.manifest);
    } catch (e) {
      if (!isAbort(e)) setError(errorText(e));
      setView({ kind: 'choose' });
    } finally {
      ctrl.current = null;
    }
  };

  // A Paket from elsewhere changed the card: no Paket from the old reading.
  if (cardChangedElsewhere.value && (view.kind === 'choose' || view.kind === 'ready')) {
    return (
      <Dialog title="Erst die Karte neu übernehmen" onClose={onClose} footer={<Button onClick={onClose}>Schließen</Button>}>
        <ChangedElsewhereNotice onDone={onClose} />
      </Dialog>
    );
  }

  switch (view.kind) {
    case 'choose':
      return <ChooseView error={error} onStart={build} onClose={onClose} waiting={st.kind === 'downloaded' ? st : null} />;
    case 'build':
      return <BuildView view={view} onCancel={() => ctrl.current?.abort()} />;
    case 'ready':
      return (
        <Dialog
          title="Paket für die Karte"
          onClose={onClose}
          footer={
            <>
              <Button onClick={onClose}>Abbrechen</Button>
              <Button variant="primary" icon={Download} onClick={() => download(view.blob, view.manifest)}>
                Paket speichern
              </Button>
            </>
          }
        >
          <Callout tone="success" icon={CircleCheck}>
            Das Paket ist fertig ({formatBytes(view.manifest.size)}).
          </Callout>
        </Dialog>
      );
    case 'guide': {
      if (st.kind !== 'downloaded') return <ChooseView error={error} onStart={build} onClose={onClose} waiting={null} />;
      const name = nameEdit ?? finderName(st.manifest.mode, label);
      const manifest = st.manifest;
      const open = stepsOpen?.name === manifest.name ? stepsOpen.open : !needsPackageCheck(manifest);
      return (
        <Dialog
          title="Paket auf die Karte bringen"
          width="wide"
          onClose={onClose}
          footer={
            <>
              <Button onClick={onClose}>Später</Button>
              {open ? (
                <Button variant="primary" icon={CircleCheck} onClick={() => setView({ kind: 'check', manifest: st.manifest })}>
                  Karte prüfen
                </Button>
              ) : null}
            </>
          }
        >
          <PackageGuide
            manifest={st.manifest}
            download={st.download}
            fresh={plan.value?.fresh ?? false}
            cardName={name}
            onCardName={setNameEdit}
            replacesOlder={discardedPackages.value > 0}
            onCheck={() => setView({ kind: 'check', manifest: st.manifest })}
            onStepsOpen={(o) => setStepsOpen({ name: manifest.name, open: o })}
          />
        </Dialog>
      );
    }
    case 'remove-only': {
      const name = nameEdit ?? finderName('changes', label);
      return (
        <Dialog
          title={view.manifest.deleteFirst.length || view.manifest.removeOnly.length ? 'Ordner auf der Karte löschen' : 'Versteckte Dateien auf der Karte löschen'}
          width="wide"
          onClose={onClose}
          footer={
            <>
              <Button onClick={onClose}>Später</Button>
              <Button variant="primary" icon={CircleCheck} onClick={() => setView({ kind: 'check', manifest: view.manifest })}>
                Karte prüfen
              </Button>
            </>
          }
        >
          <PackageGuide
            manifest={view.manifest}
            fresh={false}
            cardName={name}
            onCardName={setNameEdit}
            removeOnly
            onCheck={() => setView({ kind: 'check', manifest: view.manifest })}
          />
        </Dialog>
      );
    }
    case 'check':
      return <CheckView manifest={view.manifest} cardName={nameEdit ?? finderName(view.manifest.mode, label)} onClose={onClose} />;
  }
}

function Choice({ checked, title, badge, onSelect, children }: { checked: boolean; title: string; badge?: string; onSelect: () => void; children: ComponentChildren }) {
  // Only the chosen one is reached with Tab; the arrow keys move between them (see the radiogroup).
  return (
    <button type="button" role="radio" class="choice package-mode" aria-checked={checked} tabIndex={checked ? 0 : -1} onClick={onSelect}>
      <span class="choice-title">
        {title} {badge ? <Badge tone="brand">{badge}</Badge> : null}
      </span>
      <span class="choice-text stack tight">{children}</span>
    </button>
  );
}

function ChooseView({
  error,
  onStart,
  onClose,
  waiting,
}: {
  error: string | null;
  onStart: (mode: PackageMode, removeOnly: boolean) => void;
  onClose: () => void;
  waiting: DownloadedPackage | null;
}) {
  const p = plan.value;
  const cat = catalog.value;
  const [picked, setPicked] = useState<PackageMode | null>(null);
  const sizes = useMemo(() => {
    const changes = previewPackage('changes');
    const full = previewPackage('full');
    return { changes, full };
  }, [p]);
  if (!p || !sizes.changes || !sizes.full) {
    return (
      <Dialog title="Paket für die Karte" onClose={onClose} footer={<Button onClick={onClose}>Schließen</Button>}>
        <p>Lies zuerst die SD-Karte ein.</p>
      </Dialog>
    );
  }
  const changesOffered = p.count > 0 && !p.fresh;
  const nothing = p.count === 0 && sizes.full.files === 0;
  const mode: PackageMode = p.count === 0 ? 'full' : p.fresh ? 'changes' : (picked ?? p.recommend);
  const removeOnly = mode === 'changes' && sizes.changes.files === 0 && (sizes.changes.deleteFirst.length > 0 || sizes.changes.deleteJunk.length > 0);
  const bytes = mode === 'full' ? sizes.full.bytes : sizes.changes.bytes;
  const limits = fat32Limits(mode === 'full' ? sizes.full : sizes.changes);
  // Folders the app knows but did not find when it read the card: a whole-card Paket would miss them.
  const tree = copyOfCard();
  const unread = mode === 'full' && cat && tree ? knownFoldersMissing(Object.keys(cat.folders), tree) : [];
  const lines = firstLines(changeLines(p, cat, true), 8, true);
  // The add flow, a repair or the announcements are still writing into the copy: a Paket now would hold only part of it.
  const busy = copyBusy.value;
  return (
    <Dialog
      title="Paket für die Karte"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" icon={removeOnly ? undefined : Download} disabled={busy || nothing || limits.tooBig.length > 0} onClick={() => onStart(mode, removeOnly)}>
            {removeOnly ? 'Weiter' : 'Paket herunterladen'}
          </Button>
        </>
      }
    >
      <div class="stack package-choose">
        {busy ? (
          <Callout tone="info">{BUSY_TEXT}</Callout>
        ) : null}
        {waiting ? (
          <Callout tone={waiting.manifest.deleteFirst.length || waiting.manifest.mode === 'full' ? 'warning' : 'info'}>
            {waiting.manifest.deleteFirst.length || waiting.manifest.mode === 'full'
              ? `Das neue Paket ersetzt das Paket ${fromText(waiting.at)}. Hast du dafür auf der Karte schon etwas gelöscht oder sie formatiert? Dann entpacke erst das Paket ${fromText(waiting.at)}: Nur darin ist das noch.`
              : `Das neue Paket ersetzt das Paket ${fromText(waiting.at)}. Nimm danach nur das neue.`}
          </Callout>
        ) : null}
        {p.count > 0 ? (
          <div class="stack tight">
            <b>Das kommt auf die Karte:</b>
            <ul class="package-lines">
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {nothing ? (
          <p>Auf der Karte ist noch nichts, und es wartet auch nichts auf sie. Füge zuerst Hörspiele, Hörbücher oder Musik hinzu.</p>
        ) : p.fresh && p.count > 0 ? (
          <p>Alles für die neue Karte kommt in ein Paket ({formatBytes(sizes.changes.bytes)}).</p>
        ) : !changesOffered ? (
          <p>
            Alles, was ich auf der Karte lesen konnte, kommt sauber sortiert in ein Paket ({formatBytes(sizes.full.bytes)}). Damit kannst du die Karte neu aufbauen oder sichern.
          </p>
        ) : (
          <div
            class="choices package-modes"
            role="radiogroup"
            aria-label="Was kommt ins Paket?"
            onKeyDown={arrowKeyHandler(mode === 'full' ? 1 : 0, (i) => setPicked(i === 1 ? 'full' : 'changes'))}
          >
            <Choice checked={mode === 'changes'} title="Nur die Änderungen" onSelect={() => setPicked('changes')}>
              {removeOnlyText(sizes.changes) ? (
                <span>Dafür brauchst du kein Paket. Du löschst nur auf der Karte: {removeOnlyText(sizes.changes)}.</span>
              ) : (
                <>
                  <span>Ein Paket mit dem Neuen ({formatBytes(sizes.changes.bytes)}). Du entpackst es auf die Karte.</span>
                  {sizes.changes.deleteFirst.length ? <span>Vorher löschst du auf der Karte: {foldersText(sizes.changes.deleteFirst)}.</span> : null}
                  {sizes.changes.deleteJunk.length ? <span>Dazu löschst du von Hand {hiddenFilesText(sizes.changes.deleteJunk.length)}.</span> : null}
                </>
              )}
            </Choice>
            <Choice checked={mode === 'full'} title="Karte komplett neu aufbauen" badge={p.recommend === 'full' ? 'Empfohlen' : undefined} onSelect={() => setPicked('full')}>
              <span>
                Alles, was auf die Karte gehört ({formatBytes(sizes.full.bytes)}). Du formatierst die Karte und entpackst dann das Paket. Das ist am gründlichsten, und das Paket ist zugleich eine
                Sicherung von allem, was ich auf der Karte lesen konnte.
              </span>
              {p.recommend === 'full' ? <Reasons reasons={p.reasons} /> : null}
            </Choice>
          </div>
        )}
        {limits.tooBig.length ? <Callout tone="danger">{tooBigText(limits.tooBig)}</Callout> : null}
        {mode === 'full' && limits.overCard ? <Callout tone="warning">{OVER_CARD_TEXT}</Callout> : null}
        {unread.length ? <Callout tone="warning">{unreadText(unread)}</Callout> : null}
        {!nothing && !removeOnly && bytes > SAY_SPACE_FROM ? <p class="small muted">{spaceText(bytes)}</p> : null}
        {!nothing && !removeOnly && platform.value?.os === 'macos' ? <Callout tone="warning">{SAFARI_NOTE}</Callout> : null}
        {error ? <Callout tone="danger">{error}</Callout> : null}
      </div>
    </Dialog>
  );
}

/** What is deleted on the card when nothing has to be unpacked; empty when there is something to unpack. */
function removeOnlyText(c: PackageContent): string {
  if (c.files > 0) return '';
  return [c.deleteFirst.length ? foldersText(c.deleteFirst) : '', c.deleteJunk.length ? hiddenFilesText(c.deleteJunk.length) : ''].filter(Boolean).join(' und ');
}

function Reasons({ reasons }: { reasons: WritePlan['reasons'] }) {
  return (
    <ul class="package-reasons">
      {reasons.map((r) => (
        <li key={r}>{REASON_TEXT[r]}</li>
      ))}
    </ul>
  );
}

function BuildView({ view, onCancel }: { view: Extract<View, { kind: 'build' }>; onCancel: () => void }) {
  return (
    <Dialog title="Paket für die Karte" onClose={onCancel} dismissable={false} footer={<Button onClick={onCancel}>Abbrechen</Button>}>
      <div class="stack" role="status">
        <p>
          <b>Packt das Paket …</b> {view.total ? `${formatBytes(view.done)} von ${formatBytes(view.total)}` : ''}
        </p>
        <Progress value={view.done} max={view.total || 1} indeterminate={!view.total} label="Paket packen" />
        <p class="small muted">
          {view.mode === 'full'
            ? 'Ich lese dafür einmal alle Dateien der Karte. Lasse die Karte stecken.'
            : 'Ich lese dafür die Dateien der geänderten Ordner noch einmal von der Karte. Lasse die Karte stecken.'}
        </p>
      </div>
    </Dialog>
  );
}

function CheckView({ manifest, cardName, onClose }: { manifest: PackageManifest; cardName: string; onClose: () => void }) {
  const check = useCardCheck({ manifest, cardName, onAccept: acceptCheckedCard, onClose });
  return (
    <Dialog title="Karte prüfen" onClose={onClose} dismissable={!check.busy} footer={check.footer}>
      {check.body}
    </Dialog>
  );
}
