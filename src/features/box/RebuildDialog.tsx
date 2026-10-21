import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { CircleCheck, FolderOpen, HardDrive, LogOut, RefreshCw, Trash2, TriangleAlert } from 'lucide-preact';
import { formatBytes, plural } from '../../app/format';
import { card, ejectCard, ejectVolume, healthContext, openVolume, plat, platform, settings, updateCatalog, volumes } from '../../app/state';
import { writeGuard } from '../../app/writeguard';
import { defaultGuideOs, formatStep, type FormatOs } from '../../core/tonuino/guide';
import type { HealthReport } from '../../core/tonuino/health';
import {
  backupBlocker,
  bytesOnCard,
  copyEntries,
  findBackups,
  leftOut,
  markRestoreStarted,
  restoreOrder,
  totalBytes,
  type BackupEntry,
  type BackupManifest,
  type CopyProgress,
  type FoundBackup,
} from '../../core/tonuino/rebuild';
import type { Dir, Volume, VolumeInfo } from '../../platform/types';
import { fixTarget } from './writeAccess';
import { WriteFixButton } from './WriteAccessNotice';
import { isWriteDenied } from './writeDenied';
import { arrowKeyHandler } from '../../ui/arrowKeys';
import { Button, Callout, Progress, Spinner, Steps } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { errorText } from '../../ui/components/Hints';
import { toast } from '../../ui/components/Toast';
import { checkTargetAgain, DOCUMENTS_HINT, PlaceError, prepareBackupPlace, readCardForBackup, runBackup, targetCandidates, tidyAfterRestore, type BackupPlace, type TargetCheck, type TargetMemo } from './rebuildFlow';
import {
  backupErrorText,
  canRestoreTo,
  CARD_UNCHANGED,
  KEEPS_NUMBERS,
  MOVE_TEXT,
  namesText,
  notInBackupText,
  restoreErrorText,
  sizeAndTime,
  verdictText,
  WHY_TEXT,
  type RebuildStart,
} from './rebuildTexts';
import { playDoneSound } from '../../ui/sound';
import '../../ui/styles/package.css';

/**
 * "Karte neu aufbauen": back up the card to the computer, format it with
 * the system's tool, write everything back in the order the box needs.
 * "Auf eine neue Karte umziehen" is the same with a new card in step 3,
 * "Sicherung zurückspielen" only the last part, for a backup made before.
 * The dialog lives in the app, not on a page: it outlasts the card going
 * away while it is formatted.
 */

export type { RebuildStart };

const dialog = signal<{ start: RebuildStart; seq: number } | null>(null);
let seq = 0;

export function openRebuildDialog(start: RebuildStart = 'rebuild'): void {
  dialog.value = { start, seq: ++seq };
}

export function RebuildDialogHost() {
  const d = dialog.value;
  if (!d) return null;
  return <RebuildDialog key={d.seq} start={d.start} onClose={() => (dialog.value = null)} />;
}

/** What the card holds for the backup, read when the dialog opens. */
interface Source {
  volume: Volume;
  boxName: string;
  catalogId: string;
  entries: BackupEntry[];
  bytes: number;
  left: string[];
  blocked: boolean;
}

/** A finished backup and where it is. */
interface Saved {
  place: BackupPlace;
  manifest: BackupManifest;
}

type View =
  | { kind: 'why' }
  | { kind: 'save' }
  | { kind: 'saving'; progress: CopyProgress | null }
  | { kind: 'pick-backup'; found?: { parent: Dir; list: FoundBackup[] } }
  | { kind: 'target' }
  | { kind: 'restoring'; target: Volume; progress: CopyProgress | null }
  | { kind: 'done'; target: Volume; report: HealthReport | null }
  | { kind: 'confirm-close'; back: View }
  | { kind: 'confirm-delete'; back: View };

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

const TITLES: Record<RebuildStart, string> = {
  rebuild: 'Karte neu aufbauen',
  move: 'Auf eine neue Karte umziehen',
  restore: 'Sicherung zurückspielen',
};

function stepLabels(start: RebuildStart): string[] {
  if (start === 'restore') return ['Sicherung', 'Karte', 'Zurückspielen'];
  return ['Warum', 'Sichern', start === 'move' ? 'Neue Karte' : 'Formatieren', 'Zurückspielen'];
}

function stepIndex(start: RebuildStart, v: View): number {
  const k = v.kind === 'confirm-close' || v.kind === 'confirm-delete' ? v.back.kind : v.kind;
  const off = start === 'restore' ? -1 : 0;
  switch (k) {
    case 'why':
    case 'pick-backup':
      return 0;
    case 'save':
    case 'saving':
      return 1;
    case 'target':
      return 2 + off;
    case 'restoring':
      return 3 + off;
    default:
      return 4 + off;
  }
}

function RebuildDialog({ start, onClose }: { start: RebuildStart; onClose: () => void }) {
  const [view, setView] = useState<View>(start === 'restore' ? { kind: 'pick-backup' } : { kind: 'why' });
  const [source, setSource] = useState<Source | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [error, setError] = useState<string[] | null>(null);
  /** Writing back was refused for lack of rights: the card to get them for, right in the error. */
  const [denied, setDenied] = useState<{ volume: Volume; info: VolumeInfo } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const title = TITLES[start];

  // The card as it is now, read once: what goes into the backup.
  useEffect(() => {
    if (start === 'restore') return;
    const s = card.peek();
    if (!s || s.status !== 'ready' || !s.catalog) return;
    let live = true;
    readCardForBackup(s.volume.root)
      .then(({ scan, entries }) => {
        if (!live) return;
        setSource({
          volume: s.volume,
          boxName: s.catalog?.name ?? s.volume.label,
          catalogId: s.catalog!.id,
          entries,
          bytes: totalBytes(entries),
          left: leftOut(scan),
          blocked: backupBlocker(scan) === 'temp',
        });
      })
      .catch((e) => live && setError(['Die Karte ließ sich nicht lesen.', errorText(e), 'Stecke sie neu ein und öffne „Karte neu aufbauen“ noch einmal.']));
    return () => {
      live = false;
    };
  }, []);

  const steps = <Steps steps={stepLabels(start)} active={stepIndex(start, view)} />;
  const frame = (body: ComponentChildren, footer: ComponentChildren, o: { dismissable?: boolean; onClose?: () => void } = {}) => (
    <Dialog title={title} width="wide" onClose={o.onClose ?? askClose} dismissable={o.dismissable ?? true} footer={footer}>
      <div class="stack rebuild">
        <div class="rebuild-steps">{steps}</div>
        {body}
      </div>
    </Dialog>
  );

  /** Closing after the backup, before it is back on a card: say where it waits. */
  function askClose() {
    if (saved && (view.kind === 'target' || view.kind === 'pick-backup')) setView({ kind: 'confirm-close', back: view });
    else onClose();
  }

  const chooseFolder = async () => {
    if (!source) return;
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const p = plat();
      const parent = await p.pickBackupFolder({ purpose: 'backup' });
      if (!parent) return;
      // A catalog that lives only in the app goes onto the card first, so the backup has it.
      if (card.peek()?.volume.id === source.volume.id && !card.peek()?.catalogOnCard) await updateCatalog(() => undefined);
      const fresh = await readCardForBackup(source.volume.root);
      const entries = fresh.entries;
      const place = await prepareBackupPlace(p, parent, source.volume.root, { boxName: source.boxName, catalogId: source.catalogId, bytes: totalBytes(entries) });
      setSource({ ...source, entries, bytes: totalBytes(entries), left: leftOut(fresh.scan) });
      await backup(place, entries);
    } catch (e) {
      setError(e instanceof PlaceError ? [e.message] : ['Der Ordner ließ sich nicht verwenden.', errorText(e)]);
    } finally {
      setBusy(false);
    }
  };

  const backup = async (place: BackupPlace, entries: BackupEntry[]) => {
    if (!source) return;
    const c = new AbortController();
    ctrl.current = c;
    setView({ kind: 'saving', progress: null });
    try {
      const manifest = await runBackup(source.volume.root, place, entries, {
        boxName: source.boxName,
        catalogId: source.catalogId,
        signal: c.signal,
        onProgress: (progress) => setView({ kind: 'saving', progress }),
      });
      setSaved({ place, manifest });
      setView({ kind: 'target' });
    } catch (e) {
      if (isAbort(e)) setNote(`Angehalten. ${CARD_UNCHANGED} Wählst du denselben Ordner noch einmal, mach ich dort weiter.`);
      else setError(backupErrorText(e));
      setView({ kind: 'save' });
    } finally {
      ctrl.current = null;
    }
  };

  const chooseBackup = async () => {
    setError(null);
    setBusy(true);
    try {
      const parent = await plat().pickBackupFolder({ purpose: 'backup' });
      if (!parent) return;
      const all = await findBackups(parent);
      const list = all.filter((b) => b.manifest.complete);
      if (!list.length) {
        setError([
          all.length
            ? 'Die Sicherung in diesem Ordner ist nicht fertig geworden. Zurückspielen geht damit nicht. Ist die alte Karte noch da, mache mit ihr eine neue Sicherung.'
            : 'In diesem Ordner hab ich keine Sicherung gefunden. Wähle den Ordner „TonUINO-Sicherung …“ oder den Ordner, in dem er liegt.',
        ]);
        return;
      }
      if (list.length === 1) takeBackup(parent, list[0]);
      else setView({ kind: 'pick-backup', found: { parent, list } });
    } catch (e) {
      setError(['Der Ordner ließ sich nicht lesen.', errorText(e)]);
    } finally {
      setBusy(false);
    }
  };

  const takeBackup = async (parent: Dir, b: FoundBackup) => {
    const dir = b.name ? await parent.dir(b.name) : parent;
    setSaved({ place: { parent, dir, name: b.name, resumed: false }, manifest: b.manifest });
    setError(null);
    setView({ kind: 'target' });
  };

  const restore = async (check: TargetCheck) => {
    if (!saved || !check.plan) return;
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setDenied(null);
    setNote(null);
    const target = check.volume;
    setView({ kind: 'restoring', target, progress: null });
    try {
      const report = await writeGuard.during('tracks', async () => {
        let manifest = saved.manifest;
        // Noted in the backup: a card holding part of it is a restore to go on with from now on.
        manifest = await markRestoreStarted(saved.place.dir, manifest).catch(() => ({ ...manifest, restoreStartedAt: Date.now() }));
        setSaved({ ...saved, manifest });
        await copyEntries(saved.place.dir, target.root, check.plan!.entries, {
          expected: manifest.files,
          signal: c.signal,
          onProgress: (progress) => setView({ kind: 'restoring', target, progress }),
        });
        return tidyAfterRestore(target, (cat) => healthContext({ catalog: cat, info: check.info, volume: target }), settings.peek().pureNumbers).catch(() => null);
      });
      await openVolume(target);
      setView({ kind: 'done', target, report });
      void playDoneSound('rebuild');
    } catch (e) {
      if (isAbort(e)) setNote('Angehalten. Die Karte ist noch nicht fertig. Spielst du die Sicherung wieder auf diese Karte, mach ich dort weiter.');
      else {
        const refused = isWriteDenied(e);
        setDenied(refused ? { volume: target, info: check.info } : null);
        setError(restoreErrorText(e, { need: check.plan ? bytesOnCard(check.plan.entries) : undefined, canFix: refused && !!fixTarget(target, check.info) }));
      }
      setView({ kind: 'target' });
    } finally {
      ctrl.current = null;
    }
  };

  const deleteBackup = async (back: View) => {
    if (!saved?.place.name) return;
    setBusy(true);
    try {
      await saved.place.parent.remove(saved.place.name, { recursive: true });
      toast.success('Sicherung gelöscht');
      onClose();
    } catch (e) {
      setError(['Die Sicherung ließ sich nicht löschen.', errorText(e), 'Lösche den Ordner selbst, wenn du ihn nicht mehr brauchst.']);
      setView(back);
    } finally {
      setBusy(false);
    }
  };

  const errorBox = error ? (
    <Callout tone="danger">
      <div class="stack tight">
        {error.map((l) => (
          <span key={l}>{l}</span>
        ))}
        {denied ? (
          <WriteFixButton
            error={error.join(' ')}
            volume={denied.volume}
            info={denied.info}
            onFixed={() => {
              // The card shows up again under its new mount, with "Zurückspielen": go on from there.
              setDenied(null);
              setError(null);
              setNote('Jetzt darf ich auf die Karte schreiben. Tippe noch einmal auf „Zurückspielen“, ich mach dort weiter, wo ich aufgehört hab.');
            }}
          />
        ) : null}
      </div>
    </Callout>
  ) : null;
  const noteBox = note ? <Callout tone="info">{note}</Callout> : null;

  switch (view.kind) {
    case 'why': {
      const loading = !source && !error;
      return frame(
        <>
          <p>{start === 'move' ? MOVE_TEXT : WHY_TEXT}</p>
          <p>{KEEPS_NUMBERS}</p>
          {source ? (
            <div class="rebuild-facts">
              <b>{sizeAndTime(source.bytes)}</b>
              <span class="small muted">
                Sichern und Zurückspielen zusammen, dazu kommt das Formatieren. {plural(source.entries.length, 'Datei', 'Dateien')}.
              </span>
            </div>
          ) : loading ? (
            <p class="row soft" role="status">
              <Spinner size={16} /> Liest die Karte …
            </p>
          ) : null}
          <p class="small muted">
            {start === 'move'
              ? `Du brauchst: Platz auf deinem Computer für die Sicherung und eine neue SD-Karte mit höchstens 32 GB.${source ? ` Auf sie müssen ${formatBytes(bytesOnCard(source.entries))} passen.` : ''}`
              : 'Du brauchst: Platz auf deinem Computer für die Sicherung. Die Karte bleibt dieselbe.'}
          </p>
          {source?.blocked ? (
            <Callout tone="warning">
              Auf der Karte wartet noch eine unterbrochene Änderung. Mache sie zuerst fertig: Öffne den Gesundheitscheck auf „Meine Box“ und lasse ihn reparieren.
            </Callout>
          ) : null}
          {source?.left.length ? <LeftOut items={source.left} move={start === 'move'} /> : null}
          {errorBox}
        </>,
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!source || source.blocked || !source.entries.length} onClick={() => setView({ kind: 'save' })}>
            Weiter
          </Button>
        </>,
      );
    }

    case 'save':
      return frame(
        <>
          <p>
            Wähle einen Ordner auf deinem Computer mit mindestens <b>{formatBytes(source?.bytes ?? 0)}</b> freiem Platz, {DOCUMENTS_HINT}. Ich lege darin den Ordner „TonUINO-Sicherung{' '}
            {source?.boxName} …“ mit dem heutigen Datum an.
          </p>
          <p class="small muted">
            {card.peek()?.catalogOnCard === false
              ? 'An deinen Ordnern auf der Karte ändere ich nichts. Ich lege dort nur die Liste mit deinen Titeln ab, damit die Sicherung sie hat.'
              : 'Die Karte lese ich nur.'}{' '}
            Ich prüfe jede Datei, nachdem sie kopiert ist. Erst wenn alles da ist, geht es weiter zum {start === 'move' ? 'Kartenwechsel' : 'Formatieren'}.
          </p>
          {noteBox}
          {errorBox}
        </>,
        <>
          <Button onClick={() => setView({ kind: 'why' })} disabled={busy}>
            Zurück
          </Button>
          <Button variant="primary" icon={FolderOpen} loading={busy} onClick={chooseFolder}>
            Ordner auswählen und sichern
          </Button>
        </>,
      );

    case 'saving': {
      const p = view.progress;
      return frame(
        <div class="stack" role="status">
          <p>
            <b>Sichert die Karte …</b> {p ? `${plural(p.files, 'Datei', 'Dateien')} von ${p.totalFiles}` : ''}
          </p>
          <Progress value={p?.done ?? 0} max={p?.total || 1} indeterminate={!p} label="Sichern" />
          {p?.current ? <p class="small muted break">{p.current}</p> : null}
          <Callout tone="warning">Lasse die Karte stecken, bis die Sicherung fertig ist.</Callout>
        </div>,
        <Button onClick={() => ctrl.current?.abort()}>Anhalten</Button>,
        { dismissable: false, onClose: () => undefined },
      );
    }

    case 'pick-backup':
      return frame(
        <>
          <p>Wähle den Ordner mit der Sicherung („TonUINO-Sicherung …“) oder den Ordner, in dem er liegt.</p>
          {view.found ? (
            <div class="stack tight">
              <b>Welche Sicherung?</b>
              <ul class="rebuild-list">
                {view.found.list.map((b) => (
                  <li key={b.name}>
                    <span class="grow">
                      <b class="break">{b.name || b.manifest.boxName}</b>
                      <span class="small muted"> · {formatBytes(b.manifest.planned.bytes)}</span>
                    </span>
                    <Button size="sm" onClick={() => takeBackup(view.found!.parent, b)}>
                      Diese nehmen
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {errorBox}
        </>,
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" icon={FolderOpen} loading={busy} onClick={chooseBackup}>
            Ordner auswählen
          </Button>
        </>,
      );

    case 'target':
      return frame(
        <TargetStep start={start} saved={saved!} left={source?.left ?? []} onRestore={restore} note={noteBox} error={errorBox} />,
        <Button onClick={askClose}>{saved ? 'Später' : 'Abbrechen'}</Button>,
      );

    case 'restoring': {
      const p = view.progress;
      return frame(
        <div class="stack" role="status">
          <p>
            <b>Spielt die Sicherung zurück …</b> {p ? `${plural(p.files, 'Datei', 'Dateien')} von ${p.totalFiles}` : ''}
          </p>
          <Progress value={p?.done ?? 0} max={p?.total || 1} indeterminate={!p} label="Zurückspielen" />
          {p?.current ? <p class="small muted break">{p.current}</p> : null}
          <Callout tone="warning">Ziehe die Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.</Callout>
        </div>,
        <Button onClick={() => ctrl.current?.abort()}>Anhalten</Button>,
        { dismissable: false, onClose: () => undefined },
      );
    }

    case 'done':
      return frame(
        <DoneStep start={start} report={view.report} saved={saved!} />,
        <>
          {saved?.place.name ? (
            <Button variant="ghost" icon={Trash2} onClick={() => setView({ kind: 'confirm-delete', back: view })}>
              Sicherung löschen …
            </Button>
          ) : null}
          <span class="grow" />
          {view.target.canEject && platform.value?.capabilities.eject ? (
            <Button
              icon={LogOut}
              onClick={async () => {
                try {
                  const note = card.peek()?.volume.id === view.target.id ? await ejectCard() : await ejectVolume(view.target);
                  toast.success('Karte ausgeworfen', `Du kannst sie jetzt herausnehmen und in die Box stecken.${note ? ` ${note}` : ''}`);
                  onClose();
                } catch (e) {
                  setError(['Die Karte ließ sich nicht auswerfen.', errorText(e), 'Schließe Fenster, die etwas von der Karte zeigen, und versuche es noch einmal.']);
                }
              }}
            >
              Auswerfen
            </Button>
          ) : null}
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        </>,
        { onClose },
      );

    case 'confirm-close':
      return (
        <Dialog
          title="Später weitermachen?"
          onClose={() => setView(view.back)}
          closeButton={false}
          footer={
            <>
              <Button onClick={onClose}>Schließen</Button>
              <Button variant="primary" onClick={() => setView(view.back)}>
                Weiter aufbauen
              </Button>
            </>
          }
        >
          <div class="stack">
            <p>
              Deine Sicherung bleibt in „<b class="break">{where(saved!.place)}</b>“.
            </p>
            <p>So spielst du sie später zurück: Stecke die leere, mit FAT32 formatierte Karte ein und wähle auf „Meine Box“ „Sicherung zurückspielen“.</p>
          </div>
        </Dialog>
      );

    case 'confirm-delete':
      return (
        <Dialog
          title="Sicherung löschen?"
          onClose={() => setView(view.back)}
          closeButton={false}
          dismissable={!busy}
          footer={
            <>
              <Button onClick={() => setView(view.back)} disabled={busy}>
                Behalten
              </Button>
              <Button variant="danger" icon={Trash2} loading={busy} onClick={() => deleteBackup(view.back)}>
                Löschen
              </Button>
            </>
          }
        >
          <div class="stack">
            <p>
              Ich lösche den Ordner „<b class="break">{where(saved!.place)}</b>“ ({formatBytes(saved!.manifest.planned.bytes)}) auf deinem Computer.
            </p>
            <p class="small muted">Behältst du ihn, kannst du die Karte jederzeit wieder so herstellen, falls sie verloren geht oder kaputtgeht.</p>
          </div>
        </Dialog>
      );
  }
}

/** The backup folder as the user finds it: the full path on the desktop, else its name. */
function where(place: BackupPlace): string {
  return place.dir.path ?? (place.name || place.dir.name);
}

/** What the backup leaves out, said plainly before anything happens; the full list folds out. */
function LeftOut({ items, move }: { items: string[]; move: boolean }) {
  return (
    <Callout tone="warning">
      <div class="stack tight">
        <span>
          {move
            ? `Nicht in der Sicherung: ${namesText(items)}. Die Box spielt das nicht ab, auf die neue Karte kommt es nicht. Es bleibt auf der alten Karte.`
            : notInBackupText(items)}
        </span>
        {items.length > 4 ? (
          <details class="rebuild-left">
            <summary class="small">Alle {plural(items.length, 'Datei oder Ordner', 'Dateien und Ordner')} zeigen</summary>
            <div class="issue-items">
              {items.slice(0, 50).map((x) => (
                <div key={x}>{x}</div>
              ))}
              {items.length > 50 ? <div>… und {items.length - 50} mehr</div> : null}
            </div>
          </details>
        ) : null}
      </div>
    </Callout>
  );
}

const OS_TABS: { os: FormatOs; label: string }[] = [
  { os: 'windows', label: 'Windows' },
  { os: 'macos', label: 'Mac' },
  { os: 'linux', label: 'Linux' },
];

/** Windows and Mac: the SD Association's own tool gives FAT32 with 32 KB clusters and can overwrite the whole card (forum 6249). */
const SD_FORMATTER =
  'Am gründlichsten geht es mit dem kostenlosen Programm „SD Card Formatter“ der SD Association. Wähle dort „Overwrite format“. Das dauert länger, beschreibt die ganze Karte neu und stellt FAT32 mit 32 KB von selbst ein. Bei Karten über 32 GB macht es exFAT daraus, das liest die Box nicht.';

/** What the system's own tool gives where it does not let you choose (forum 6249#1: the Mac formats with 16 KB). */
const SYSTEM_NOTES: Record<FormatOs, string[]> = {
  windows: [],
  macos: ['Der Mac wählt dabei kleinere Zuordnungseinheiten als 32 KB. Das geht. Mit „SD Card Formatter“ findet die Box ihre Titel etwas schneller.'],
  linux: [
    'Bietet „Laufwerke“ an, die alten Daten zu überschreiben („Löschen“), schalte das ein. Das dauert länger, beschreibt die Karte aber neu.',
    '„Laufwerke“ wählt die Größe der Zuordnungseinheit selbst, oft kleiner als 32 KB. Das geht.',
  ],
};

/** How to format the card: SD Card Formatter where there is one, else (and also) the system's own tool. */
function FormatHelp({ backupAt, left = [] }: { backupAt: string; left?: string[] }) {
  const first = defaultGuideOs(platform.peek()?.os ?? 'other');
  const [os, setOs] = useState<FormatOs>(first === 'chromebook' ? 'windows' : first);
  const id = useId();
  const step = formatStep(os, [
    `Formatieren löscht alles auf der Karte. Deine Sicherung liegt sicher in „${backupAt}“.`,
    ...(left.length ? [notInBackupText(left)] : []),
    ...SYSTEM_NOTES[os],
  ]);
  return (
    <div class="stack package-guide">
      <div
        class="tabs guide-tabs"
        role="tablist"
        aria-label="Dein Computer"
        onKeyDown={arrowKeyHandler(
          OS_TABS.findIndex((t) => t.os === os),
          (i) => setOs(OS_TABS[i].os),
        )}
      >
        {OS_TABS.map((t) => (
          <button
            type="button"
            role="tab"
            key={t.os}
            id={`${id}-${t.os}`}
            aria-selected={os === t.os}
            aria-controls={`${id}-panel`}
            tabIndex={os === t.os ? 0 : -1}
            onClick={() => setOs(t.os)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${os}`} class="stack tight">
        {os === 'linux' ? null : (
          <>
            <p>{SD_FORMATTER}</p>
            <p class="small soft">Ohne das Programm geht es auch mit deinem Computer:</p>
          </>
        )}
        <ol class="guide-steps os-steps">
          <li class="guide-step format">
            <div class="guide-text">{step.text}</div>
            {step.warnings?.map((w) => (
              <p class="guide-warning" key={w}>
                <TriangleAlert size={16} aria-hidden="true" />
                <span>{w}</span>
              </p>
            ))}
          </li>
        </ol>
      </div>
    </div>
  );
}

type Checked = { volume: Volume; check?: TargetCheck; error?: string };

/**
 * Step 3: the card to write back to. On the desktop the app watches the
 * drives and checks each one that turns up; in the browser the user picks
 * the card. A card is only offered when it is empty and FAT (or its format
 * cannot be known) and has room.
 */
function TargetStep({
  start,
  saved,
  left,
  onRestore,
  note,
  error,
}: {
  start: RebuildStart;
  saved: Saved;
  /** What the backup left out of the card being formatted. */
  left: string[];
  onRestore: (c: TargetCheck) => void;
  note: ComponentChildren;
  error: ComponentChildren;
}) {
  const p = platform.value!;
  const auto = p.capabilities.sdAutoDetect;
  const browser = !auto;
  const [picked, setPicked] = useState<Volume[]>([]);
  const [rows, setRows] = useState<Checked[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  /** The last full look at each drive: only a changed card is read through again. */
  const looked = useRef(new Map<string, TargetMemo>());
  const forced = useRef(true);
  const list = volumes.value;
  const open = card.value?.volume;

  // Each drive that might be the card, looked at again every few seconds: formatting does not always change the drive list.
  useEffect(() => {
    const candidates = new Map<string, Volume>();
    for (const v of targetCandidates(list)) candidates.set(v.id, v);
    if (open && open.access !== 'snapshot') candidates.set(open.id, open);
    for (const v of picked) candidates.set(v.id, v);
    if (running.current) return;
    running.current = true;
    // Back at the window: the user may have done anything to the card meanwhile.
    const force = forced.current;
    forced.current = false;
    let live = true;
    void (async () => {
      const out: Checked[] = [];
      for (const v of candidates.values()) {
        try {
          const info = await plat().volumes.info(v).catch(() => v.info);
          out.push({ volume: v, check: await checkTargetAgain(v, saved.manifest, info, looked.current, { force }) });
        } catch (e) {
          // A remembered card that is not there: nothing to show.
          if (picked.includes(v)) out.push({ volume: v, error: errorText(e) });
        }
      }
      running.current = false;
      if (!live) return;
      setRows(out);
    })();
    return () => {
      live = false;
    };
  }, [list, picked, tick, open?.id, saved.manifest]);

  useEffect(() => {
    const t = window.setInterval(() => document.visibilityState === 'visible' && setTick((n) => n + 1), 4000);
    const focus = () => {
      forced.current = true;
      setTick((n) => n + 1);
    };
    window.addEventListener('focus', focus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', focus);
    };
  }, []);

  const pick = async () => {
    try {
      const v = await p.volumes.pick();
      if (v) setPicked((all) => [...all.filter((x) => x.id !== v.id), v]);
    } catch (e) {
      toast.error('Die Karte ließ sich nicht öffnen', errorText(e));
    }
  };

  const backupAt = where(saved.place);
  const ready = rows.filter((r) => r.check && canRestoreTo(r.check.judgement));
  // The browser does not know a card's free space: say what has to fit.
  const fits = `Auf die Karte müssen ${formatBytes(bytesOnCard(restoreOrder(saved.manifest.files)))} passen.`;
  return (
    <>
      {start === 'rebuild' ? (
        <>
          <Callout tone="success" icon={CircleCheck}>
            Die Sicherung ist fertig und geprüft ({formatBytes(saved.manifest.planned.bytes)}).
          </Callout>
          <p>Jetzt formatierst du die Karte. Das kann ich nicht selbst, dein Computer hat dafür ein Werkzeug:</p>
          <FormatHelp backupAt={backupAt} left={left} />
        </>
      ) : start === 'move' ? (
        <>
          <Callout tone="success" icon={CircleCheck}>
            Die Sicherung ist fertig und geprüft ({formatBytes(saved.manifest.planned.bytes)}).
          </Callout>
          <p>
            Nimm die alte Karte heraus und stecke die neue ein. Sie muss leer und mit FAT32 formatiert sein. Neue Karten bis 32 GB sind das meist schon. {fits}
          </p>
          <details class="guide-more">
            <summary>So formatierst du die neue Karte</summary>
            <FormatHelp backupAt={backupAt} />
          </details>
        </>
      ) : (
        <>
          <p>
            Die Sicherung „<b class="break">{saved.place.name || saved.manifest.boxName}</b>“ ({formatBytes(saved.manifest.planned.bytes)}) ist bereit.
          </p>
          <p>Stecke die Karte ein, auf die sie soll. Sie muss leer und mit FAT32 formatiert sein. {fits}</p>
          <details class="guide-more">
            <summary>So formatierst du eine Karte</summary>
            <FormatHelp backupAt={backupAt} />
          </details>
        </>
      )}

      <div class="stack tight">
        <span class="section-title">{start === 'rebuild' ? 'Danach: die Karte wieder einstecken' : 'Die Karte'}</span>
        {rows.length ? (
          <ul class="rebuild-list" aria-live="polite">
            {rows.map((r) => (
              <TargetRow key={r.volume.id} row={r} browser={browser} start={start} onRestore={onRestore} />
            ))}
          </ul>
        ) : null}
        {!ready.length ? (
          <p class="row soft small" role="status">
            {auto ? (
              <>
                <Spinner size={16} /> {rows.length ? 'Wartet auf eine leere Karte …' : 'Wartet auf die Karte …'} Ich erkenne sie von selbst.
              </>
            ) : (
              'Wähle die Karte aus, wenn sie formatiert ist. Nimm das Laufwerk der Karte selbst, nicht einen Ordner darauf.'
            )}
          </p>
        ) : null}
        <div class="row wrap">
          <Button size="sm" variant={auto ? 'ghost' : ready.length ? 'default' : 'primary'} icon={HardDrive} onClick={pick}>
            {auto ? 'Karte selbst wählen' : 'Karte auswählen'}
          </Button>
          {auto ? (
            <Button size="sm" variant="ghost" icon={RefreshCw} loading={refreshing}
              onClick={() => {
                setRefreshing(true);
                void p.volumes
                  .refresh()
                  .catch(() => undefined)
                  .finally(() => {
                    setRefreshing(false);
                    setTick((n) => n + 1);
                  });
              }}>
              Erneut suchen
            </Button>
          ) : null}
        </div>
      </div>
      {note}
      {error}
    </>
  );
}

function TargetRow({ row, browser, start, onRestore }: { row: Checked; browser: boolean; start: RebuildStart; onRestore: (c: TargetCheck) => void }) {
  const c = row.check;
  const ok = !!c && canRestoreTo(c.judgement);
  const text = c ? verdictText(c.judgement, { browser, start, oldCard: c.sameBox }) : row.error;
  return (
    <li class={ok ? 'ready' : ''}>
      {ok ? <CircleCheck size={20} class="rebuild-ok" aria-hidden="true" /> : <TriangleAlert size={20} class="rebuild-warn" aria-hidden="true" />}
      <span class="grow stack tight">
        <b class="break">{row.volume.label}</b>
        <span class="small soft">{text}</span>
      </span>
      {ok && c ? (
        <Button variant="primary" size="sm" onClick={() => onRestore(c)}>
          {c.judgement.verdict === 'resume' ? 'Weiter zurückspielen' : 'Zurückspielen'}
        </Button>
      ) : null}
    </li>
  );
}

function DoneStep({ start, report, saved }: { start: RebuildStart; report: HealthReport | null; saved: Saved }) {
  const problems = report ? report.issues.filter((i) => i.severity !== 'info') : [];
  return (
    <div class="stack">
      <Callout tone="success" icon={CircleCheck}>
        <b>{start === 'rebuild' ? 'Fertig. Die Karte ist frisch aufgebaut.' : start === 'move' ? 'Fertig. Die neue Karte ist bereit.' : 'Fertig. Die Sicherung ist zurück auf der Karte.'}</b>
      </Callout>
      <p>{KEEPS_NUMBERS}</p>
      {problems.length ? (
        <Callout tone="warning">
          Der Gesundheitscheck meldet noch etwas: {problems[0].title}
          {problems.length > 1 ? ' und mehr' : ''}. Sieh es dir auf „Meine Box“ an.
        </Callout>
      ) : null}
      <p class="small muted">
        Die Sicherung bleibt in „<span class="break">{where(saved.place)}</span>“. Behalte sie, falls die Karte einmal verloren geht. Fügst du später etwas hinzu, ist das nicht in dieser Sicherung.
      </p>
    </div>
  );
}
