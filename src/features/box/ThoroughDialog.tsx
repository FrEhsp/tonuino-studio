/**
 * "Gründlich prüfen" from the check of the card (behind "Mehr"): reads every
 * MP3 once (core/tonuino/thorough.ts) and tells broken files and a card
 * that cannot read its files back. Writes nothing; can be stopped.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { CircleAlert, CircleCheck, FolderOpen, Square } from 'lucide-preact';
import { byFolder, thoroughCheck, thoroughTargets, thoroughVerdict, type ThoroughProgress, type ThoroughResult } from '../../core/tonuino/thorough';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Progress } from '../../ui/components/controls';
import { formatBytes, plural } from '../../app/format';
import { routeToHash } from '../../app/router';
import { card } from '../../app/state';
import { openRebuildDialog } from './RebuildDialog';
import { openPackageDialog } from './PackageDialog';
import '../../ui/styles/thorough.css';

type State = { step: 'ask' } | { step: 'running'; p: ThoroughProgress } | { step: 'done'; result: ThoroughResult };

export function ThoroughDialog({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const s = card.value!;
  const scan = s.scan!;
  const targets = thoroughTargets(scan);
  const bytes = targets.reduce((n, t) => n + t.size, 0);
  const [state, setState] = useState<State>({ step: 'ask' });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const packaged = s.volume.access === 'snapshot';

  const start = async () => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setState({ step: 'running', p: { done: 0, total: targets.length, bytesDone: 0, bytesTotal: bytes } });
    const result = await thoroughCheck(s.volume.root, scan, { signal: ctrl.signal, onProgress: (p) => setState({ step: 'running', p }) });
    if (abort.current === ctrl) setState({ step: 'done', result });
  };

  const rebuild = (move: boolean) => {
    onClose();
    if (packaged) openPackageDialog('choose');
    else openRebuildDialog(move ? 'move' : 'rebuild');
  };

  const running = state.step === 'running';
  return (
    <Dialog
      title="Gründlich prüfen"
      onClose={onClose}
      dismissable={!running}
      footer={
        running ? (
          <Button icon={Square} onClick={() => abort.current?.abort()}>
            Anhalten
          </Button>
        ) : state.step === 'ask' ? (
          <>
            <Button variant="ghost" onClick={onBack}>
              Zurück
            </Button>
            <Button variant="primary" onClick={start} disabled={!targets.length}>
              Prüfen
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onBack}>
              Zurück zur Prüfung
            </Button>
            <Button variant="primary" onClick={onClose}>
              Fertig
            </Button>
          </>
        )
      }
    >
      <div class="stack">
        {state.step === 'ask' ? (
          <>
            <p>Ich lese jede MP3 einmal von vorn bis hinten. So finde ich kaputte Dateien und merke, ob die SD-Karte selbst schwächelt.</p>
            <p class="soft small">
              {plural(targets.length, 'Datei', 'Dateien')}, {formatBytes(bytes)}. Das dauert eine Weile. Ich ändere nichts.
            </p>
          </>
        ) : null}
        {state.step === 'running' ? (
          <>
            <Progress value={state.p.bytesTotal ? state.p.bytesDone / state.p.bytesTotal : 0} />
            <p class="soft small">
              {state.p.done} von {state.p.total} Dateien{state.p.current ? ` · Ordner ${state.p.current.folderName}, ${state.p.current.file}` : ''}
            </p>
          </>
        ) : null}
        {state.step === 'done' ? <Result result={state.result} onRebuild={rebuild} onClose={onClose} /> : null}
      </div>
    </Dialog>
  );
}

function Result({ result, onRebuild, onClose }: { result: ThoroughResult; onRebuild: (move: boolean) => void; onClose: () => void }) {
  const verdict = thoroughVerdict(result);
  const read = `${plural(result.checked, 'Datei', 'Dateien')} gelesen${result.stopped ? ', dann angehalten' : ''}.`;
  return (
    <>
      {verdict === 'fine' ? (
        <Callout tone="success" icon={CircleCheck}>
          {result.stopped ? 'Bis hierher ist alles in Ordnung.' : 'Alle MP3s sind in Ordnung, und die Karte liest sie ohne Fehler.'} {read}
        </Callout>
      ) : null}
      {verdict === 'wearing' ? (
        <Callout tone="danger" icon={CircleAlert}>
          <div class="stack tight">
            <b>Die SD-Karte geht vermutlich kaputt.</b>
            <span>
              {plural(result.unreadable.length, 'Datei ließ', 'Dateien ließen')} sich nicht lesen. Das ist oft das erste Zeichen. Ziehe die Inhalte jetzt auf eine neue Karte um, solange es noch geht.
            </span>
            <div class="row wrap">
              <Button variant="primary" onClick={() => onRebuild(true)}>
                Auf eine neue Karte umziehen …
              </Button>
              <Button onClick={() => onRebuild(false)}>Karte neu aufbauen …</Button>
            </div>
          </div>
        </Callout>
      ) : null}
      {result.damaged.length ? (
        <Callout tone="warning" icon={CircleAlert}>
          {plural(result.damaged.length, 'MP3 ist', 'MP3s sind')} innen kaputt. Die Box stockt oder springt dort. Lösche sie auf der Seite des Ordners und spiele sie noch einmal von der Original-Datei oder CD auf.
        </Callout>
      ) : null}
      {verdict !== 'fine' ? <p class="soft small">{read}</p> : null}
      <FileList title="Kaputt" files={result.damaged} onClose={onClose} />
      <FileList title="Nicht lesbar" files={result.unreadable} onClose={onClose} />
    </>
  );
}

function FileList({ title, files, onClose }: { title: string; files: ThoroughResult['damaged']; onClose: () => void }) {
  if (!files.length) return null;
  return (
    <div class="stack tight">
      <h3 class="section-title">{title}</h3>
      <ul class="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {byFolder(files).map((g) => (
          <li key={g.folder}>
            <a class="link-button" href={routeToHash({ page: 'folder', folder: g.folder })} onClick={onClose}>
              <FolderOpen size={15} aria-hidden="true" /> Ordner {g.folderName}
            </a>
            <span class="small soft"> {g.files.slice(0, 6).join(', ')}{g.files.length > 6 ? ` und ${g.files.length - 6} weitere` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
