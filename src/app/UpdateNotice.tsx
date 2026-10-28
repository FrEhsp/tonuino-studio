/**
 * "Neue Version da": the one line in the bar of the app, the switch with
 * its privacy line in the settings, and the steps for this system
 * (updatesteps.ts). The desktop and the Android app learn of new versions
 * from the release list of their build (updatecheck.ts), the web app from
 * its service worker (pwa.ts): there one click loads the new version.
 */
import { render } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { Download, Gift, RefreshCw, X } from 'lucide-preact';
import { Button, Switch } from '../ui/components/controls';
import { Dialog } from '../ui/components/Dialog';
import { ExternalLink } from '../features/help/ExternalLink';
import { APP_VERSION } from './version';
import { platform } from './state';
import { checkForUpdate, dismissUpdate, pendingUpdate, releasesHost, setUpdateCheck, updateCheck, updateCheckOffered, type Release } from './updatecheck';
import { canSelfUpdate, installKind, updateSteps, type InstallKind } from './updatesteps';
import { newVersionWaiting, reloadToNewest } from './pwa';
import '../ui/styles/updatenotice.css';

/** In the bar: the desktop app asks once a day while it runs (if switched on); the web app hears it from its service worker. */
export function UpdateNotice() {
  const p = platform.value;
  if (p?.kind !== 'desktop') return <WebUpdateNotice />;
  return <AppUpdateNotice />;
}

function WebUpdateNotice() {
  if (!newVersionWaiting.value) return null;
  return (
    <div class="update-notice" role="status">
      <button type="button" class="update-notice-link" onClick={() => void reloadToNewest()} title="Lädt die Seite mit der neuen Version neu">
        <RefreshCw size={16} aria-hidden="true" /> Neue Version da · neu laden
      </button>
    </div>
  );
}

function AppUpdateNotice() {
  const p = platform.value;
  const offered = updateCheckOffered(p?.kind);
  const on = updateCheck.value.on;
  useEffect(() => {
    if (!offered || !on || !p) return;
    void checkForUpdate({ fetch: (u, i) => p.fetch(u, i) });
    const t = setInterval(() => void checkForUpdate({ fetch: (u, i) => p.fetch(u, i) }), 60 * 60 * 1000);
    return () => clearInterval(t);
  }, [offered, on, p]);
  const next = offered ? pendingUpdate(updateCheck.value, APP_VERSION) : null;
  if (!next) return null;
  return (
    <div class="update-notice" role="status">
      <button type="button" class="update-notice-link" onClick={() => openUpdateDialog(next)}>
        <Gift size={16} aria-hidden="true" /> Neue Version {next.version} da
      </button>
      <button type="button" class="update-notice-close" aria-label="Hinweis schließen" title="Hinweis schließen" onClick={() => dismissUpdate(next.version)}>
        <X size={14} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ how this app was installed */

/** Known once asked (Tauri's bundle type); until then the system alone decides. */
const bundle = signal<string | null | undefined>(undefined);

function askBundle(): void {
  // The web build has no Tauri code at all.
  if (__DESKTOP_BUILD__ && bundle.peek() === undefined) {
    bundle.value = null;
    void import('../platform/tauri/bundletype').then(async (m) => (bundle.value = await m.bundleType()));
  }
}

function kindHere(): InstallKind {
  const p = platform.value;
  return installKind({ os: p?.os ?? 'other', mobile: p?.mobile, bundle: bundle.value });
}

/* ------------------------------------------------------------ the steps */

/**
 * Opens the steps for this system above everything else. The notice sits
 * in a bar that may be hidden on a phone, so the dialog gets its own place
 * at the end of the page instead of living inside it.
 */
export function openUpdateDialog(release: Release): void {
  askBundle();
  const host = document.createElement('div');
  document.body.append(host);
  const close = () => {
    render(null, host);
    host.remove();
  };
  render(<UpdateDialog release={release} onClose={close} />, host);
}

type Run = { phase: 'idle' } | { phase: 'loading'; done: number; total?: number } | { phase: 'done' } | { phase: 'none' } | { phase: 'error' };

function UpdateDialog({ release, onClose }: { release: Release; onClose: () => void }) {
  const kind = kindHere();
  const s = updateSteps(kind, release, __SELF_UPDATE__);
  const [run, setRun] = useState<Run>({ phase: 'idle' });
  const p = platform.value;
  const install = async () => {
    // Only a build with the updater has this code (and the button).
    if (__SELF_UPDATE__) {
      setRun({ phase: 'loading', done: 0 });
      try {
        const m = await import('../platform/tauri/updater');
        const got = await m.installNewest((done, total) => setRun({ phase: 'loading', done, total }));
        setRun({ phase: got ? 'done' : 'none' });
      } catch {
        setRun({ phase: 'error' });
      }
    }
  };
  const busy = run.phase === 'loading';
  const download = (
    <ExternalLink href={s.download.url} class={`btn ${s.self ? '' : 'primary'}`}>
      <Download size={18} strokeWidth={2.2} aria-hidden="true" /> {s.download.label}
    </ExternalLink>
  );
  return (
    <Dialog
      title={`Version ${release.version} ist da`}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {run.phase === 'done' ? 'Schließen' : 'Später'}
          </Button>
          {run.phase === 'done' && p?.closeWindow && kind !== 'windows' ? (
            <Button variant="primary" onClick={() => void p.closeWindow?.()}>
              App schließen
            </Button>
          ) : s.self && run.phase !== 'error' && run.phase !== 'done' ? (
            <Button variant="primary" icon={Download} loading={busy} onClick={() => void install()}>
              Jetzt aktualisieren
            </Button>
          ) : run.phase !== 'done' ? (
            download
          ) : null}
        </>
      }
    >
      <div class="stack update-steps">
        {run.phase === 'done' ? (
          <p>{kind === 'windows' ? 'Fertig. Die neue Version startet gleich von selbst.' : 'Fertig. Schließe TonUINO Studio und öffne es wieder, dann läuft die neue Version.'}</p>
        ) : run.phase === 'none' ? (
          <p>Ich habe die neue Version gerade nicht gefunden. Versuche es später noch einmal.</p>
        ) : run.phase === 'error' ? (
          <p>Das Aktualisieren hat nicht geklappt. Lade die neue Version selbst herunter und installiere sie über die alte.</p>
        ) : (
          <>
            <ol class="update-steps-list">
              {s.steps.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
            {s.command ? <code class="update-steps-command">{s.command}</code> : null}
            {busy ? (
              <p class="small muted" aria-live="polite">
                {run.total ? `Lade … ${Math.min(100, Math.round((run.done / run.total) * 100))} %` : 'Lade …'}
              </p>
            ) : null}
          </>
        )}
        {run.phase === 'error' || run.phase === 'none' ? <p>{download}</p> : null}
        {s.download.url !== release.url ? (
          <p class="small">
            <ExternalLink href={release.url}>Was ist neu in {release.version}?</ExternalLink>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------ settings */

/** In the settings, above "Über TonUINO Studio". */
export function UpdateCheckSetting() {
  const p = platform.value;
  useEffect(askBundle, []);
  if (!updateCheckOffered(p?.kind)) return null;
  const s = updateCheck.value;
  const next = pendingUpdate({ ...s, dismissed: undefined }, APP_VERSION);
  const self = __SELF_UPDATE__ && canSelfUpdate(kindHere());
  return (
    <section class="card pad stack tight" aria-label="Neue Versionen">
      <Switch
        checked={s.on}
        onChange={setUpdateCheck}
        label="Auf neue Versionen hinweisen"
        hint={`Dafür frage ich höchstens einmal am Tag bei ${releasesHost()} nach. Der Server sieht dabei nur deine IP-Adresse, wie bei jeder Webseite, mehr schicke ich nicht. ${self ? 'Aktualisieren geht dann mit einem Klick.' : 'Ist eine neue Version da, sage ich dir, wie du sie bekommst.'}`}
      />
      {s.on && next ? (
        <p class="small">
          <button type="button" class="link-button" onClick={() => openUpdateDialog(next)}>
            Version {next.version} ist da
          </button>
        </p>
      ) : null}
    </section>
  );
}
