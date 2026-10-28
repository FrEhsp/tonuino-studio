/** A download from "Entdecken": the question before a big one, progress, errors and waiting for the card. */
import { RefreshCw } from 'lucide-preact';
import { Button, Progress, Spinner } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { navigate, route, routeToHash } from '../../app/router';
import { formatBytes } from '../../app/format';
import { progressLine, waitingText } from './labels';
import { ExternalLink } from './links';
import { cancelRun, confirmBig, continueWithout, handOffBlocker, online, packageMode, resumeHandOff, retryMissing, run } from './state';
import { ImportBarFlag } from '../../ui/rootFlag';

/** "Großer Download": asked from 1 GB on. */
export function BigDownloadDialog() {
  const r = run.value;
  if (r?.phase !== 'confirm') return null;
  return (
    <Dialog
      title="Großer Download"
      onClose={cancelRun}
      footer={
        <>
          <Button onClick={cancelRun}>Abbrechen</Button>
          <Button variant="primary" onClick={confirmBig}>
            Laden
          </Button>
        </>
      }
    >
      <p>Das sind {formatBytes(r.bytes)}. Das Laden dauert eine Weile, und auf der SD-Karte muss genug Platz sein. Trotzdem laden?</p>
    </Dialog>
  );
}

/** "Datei selbst hinzufügen": opens the folded drop zone on the source page and goes there. */
function showDropZone(): void {
  const box = document.querySelector<HTMLElement>('.source-save');
  if (!box) return;
  const more = box.querySelector('details');
  if (more) more.open = true;
  box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  box.querySelector<HTMLElement>('.source-drop button')?.focus({ preventScroll: true });
}

/** Takes the place of the selection bar while a download runs or waits. */
export function RunPanel() {
  const r = run.value;
  if (!r || r.phase === 'confirm') return null;
  const rt = route.value;
  const here = rt.page === 'sources' && rt.entry === r.entry.id;
  const source = here ? null : (
    <a class="source-run-source" href={routeToHash({ page: 'sources', entry: r.entry.id })}>
      {r.entry.title}
    </a>
  );

  if (r.phase === 'loading') {
    const p = r.progress;
    return (
      <div class="import-bar source-run" role="status" aria-live="polite">
        <ImportBarFlag />
        <div class="source-run-text">
          {source}
          <strong>{p ? progressLine(p) : 'Wird vorbereitet …'}</strong>
          {r.current ? <span class="small muted ellipsis">{r.current}</span> : null}
          <Progress value={p?.bytes ?? 0} max={p?.totalBytes || 1} indeterminate={!p?.totalBytes} label="Fortschritt beim Laden" />
        </div>
        <div class="source-run-actions">
          <Button onClick={cancelRun}>Abbrechen</Button>
        </div>
      </div>
    );
  }

  if (r.phase === 'adding') {
    return (
      <div class="import-bar source-run" role="status">
        <ImportBarFlag />
        <Spinner size={18} />
        <div class="source-run-text">
          {source}
          <strong>Geladen. Ich seh mir die Dateien an …</strong>
        </div>
      </div>
    );
  }

  if (r.phase === 'failed') {
    const first = r.missing[0]?.pick.item;
    return (
      <div class="import-bar source-run failed" role="alert">
        <ImportBarFlag />
        <div class="source-run-text">
          {source}
          <strong>{r.partial}</strong>
          <span class="small">{r.message}</span>
        </div>
        <div class="source-run-actions">
          <Button variant="primary" icon={RefreshCw} disabled={!online.value} onClick={retryMissing}>
            Fehlende erneut laden
          </Button>
          {r.loaded.length ? <Button onClick={continueWithout}>Ohne die fehlenden weiter</Button> : null}
          <ExternalLink class="btn ghost" href={first?.pageUrl ?? r.entry.pageUrl}>
            Auf der Webseite öffnen
          </ExternalLink>
          {here ? (
            <Button variant="ghost" onClick={showDropZone}>
              Datei selbst hinzufügen …
            </Button>
          ) : null}
          <Button variant="ghost" onClick={cancelRun}>
            Verwerfen
          </Button>
        </div>
      </div>
    );
  }

  const b = handOffBlocker.value;
  const automatic = b?.kind === 'writing' || b?.kind === 'reading' || b?.kind === 'result' || b?.kind === 'rest';
  return (
    <div class="import-bar source-run" role="status">
      <ImportBarFlag />
      <div class="source-run-text">
        {source}
        <strong>{waitingText(b, packageMode.value)}</strong>
      </div>
      <div class="source-run-actions">
        {b?.kind === 'card' ? (
          <a class="btn" href="#/">
            Zur SD-Karte
          </a>
        ) : null}
        {b?.kind === 'folder' ? <Button onClick={() => navigate({ page: 'add', folder: b.folder })}>Zur Auswahl</Button> : null}
        {b?.kind === 'result' ? (
          <Button variant="primary" onClick={() => navigate({ page: 'musik' })}>
            Ansehen
          </Button>
        ) : null}
        {b?.kind === 'rest' ? (
          <Button variant="primary" onClick={() => navigate({ page: 'add', folder: b.folder })}>
            Zur Übertragung
          </Button>
        ) : null}
        {automatic ? null : (
          <Button variant="primary" disabled={!!b} onClick={resumeHandOff}>
            Weiter
          </Button>
        )}
        <Button variant="ghost" onClick={cancelRun}>
          Verwerfen
        </Button>
      </div>
    </div>
  );
}
