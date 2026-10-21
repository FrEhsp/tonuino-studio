/**
 * "Neue Version da" (updatecheck.ts): the one line in the sidebar of the
 * desktop app, and the switch with its privacy line in the settings. Neither
 * shows in a build without a release list, nor in the web app.
 */
import { useEffect } from 'preact/hooks';
import { Gift, X } from 'lucide-preact';
import { Switch } from '../ui/components/controls';
import { ExternalLink } from '../features/help/ExternalLink';
import { APP_VERSION } from './version';
import { platform } from './state';
import { checkForUpdate, dismissUpdate, pendingUpdate, releasesHost, setUpdateCheck, updateCheck, updateCheckOffered } from './updatecheck';
import '../ui/styles/updatenotice.css';

/** In the sidebar: asks once a day while the app runs (if switched on) and shows a newer version. */
export function UpdateNotice() {
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
      <ExternalLink href={next.url} class="update-notice-link">
        <Gift size={16} aria-hidden="true" /> Neue Version {next.version} da
      </ExternalLink>
      <button type="button" class="update-notice-close" aria-label="Hinweis schließen" title="Hinweis schließen" onClick={() => dismissUpdate(next.version)}>
        <X size={14} />
      </button>
    </div>
  );
}

/** In the settings, above "Über TonUINO Studio". */
export function UpdateCheckSetting() {
  const p = platform.value;
  if (!updateCheckOffered(p?.kind)) return null;
  const s = updateCheck.value;
  const next = pendingUpdate({ ...s, dismissed: undefined }, APP_VERSION);
  return (
    <section class="card pad stack tight" aria-label="Neue Versionen">
      <Switch
        checked={s.on}
        onChange={setUpdateCheck}
        label="Auf neue Versionen hinweisen"
        hint={`Dafür frage ich höchstens einmal am Tag bei ${releasesHost()} nach. Der Server sieht dabei nur deine IP-Adresse, wie bei jeder Webseite, mehr schicke ich nicht. Aktualisieren musst du selbst.`}
      />
      {s.on && next ? (
        <p class="small">
          <ExternalLink href={next.url}>Version {next.version} ist da</ExternalLink>
        </p>
      ) : null}
    </section>
  );
}
