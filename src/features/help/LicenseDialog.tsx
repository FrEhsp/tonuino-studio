import { useEffect, useState } from 'preact/hooks';
import { platform } from '../../app/state';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Spinner } from '../../ui/components/controls';
import { ExternalLink } from './ExternalLink';
import { LicenseLinks } from './LicenseLinks';
import { filterNotices, LICENSE_FILE_NAME, loadLicenseFile, type LicenseFile, type LicenseFileResult, type NoticeEntry } from './licensefile';
import { licenseLabel } from './notices';

/** Every package in the app with its full licence texts, from the file the build put next to it. */
export function LicenseDialog({ onClose }: { onClose: () => void }) {
  const [result, setResult] = useState<LicenseFileResult | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let alive = true;
    void loadLicenseFile((url, init) => fetch(url, init), new URL(LICENSE_FILE_NAME, document.baseURI).href).then((r) => {
      if (alive) setResult(r);
    });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Dialog title="Alle Lizenztexte" width="wide" onClose={onClose} footer={<Button onClick={onClose}>Schließen</Button>}>
      {result === null ? (
        <p class="help-licenses-loading soft" role="status">
          <Spinner size={18} /> Lade die Lizenztexte …
        </p>
      ) : result.kind === 'missing' ? (
        <Callout>In dieser Vorschau fehlen die Lizenztexte. Sie kommen erst dazu, wenn die App gebaut wird.</Callout>
      ) : result.kind === 'error' ? (
        <Callout tone="danger">{result.message}</Callout>
      ) : (
        <LicenseLists file={result.file} query={query} onQuery={setQuery} />
      )}
    </Dialog>
  );
}

function LicenseLists({ file, query, onQuery }: { file: LicenseFile; query: string; onQuery: (q: string) => void }) {
  // The Rust crates are only in the desktop app; the file of a web build may list them too.
  const desktop = platform.value?.kind === 'desktop';
  const npm = filterNotices(file.npm, query);
  const rust = desktop ? filterNotices(file.rust, query) : [];
  return (
    <div class="stack">
      <p class="small soft">In TonUINO Studio stecken diese Pakete anderer Projekte. Klicke auf ein Paket, um seine Lizenz zu lesen.</p>
      <div class="field">
        <label for="help-license-search">Paket suchen</label>
        <input
          id="help-license-search"
          class="input"
          type="search"
          value={query}
          placeholder="zum Beispiel preact"
          autocomplete="off"
          onInput={(e) => onQuery(e.currentTarget.value)}
        />
      </div>
      <LicenseGroup title="Programmteile und Schriften" entries={npm} total={file.npm.length} texts={file.texts} />
      {desktop ? <LicenseGroup title="Rust-Pakete der Desktop-App" entries={rust} total={file.rust.length} texts={file.texts} /> : null}
      {!npm.length && !rust.length ? <p class="soft">Kein Paket passt zu „{query.trim()}“.</p> : null}
    </div>
  );
}

function LicenseGroup({ title, entries, total, texts }: { title: string; entries: NoticeEntry[]; total: number; texts: string[] }) {
  if (!entries.length) return null;
  return (
    <section class="stack help-license-group">
      <h3>
        {title} <span class="small muted">({entries.length === total ? total : `${entries.length} von ${total}`})</span>
      </h3>
      <ul class="help-notice-list help-license-list">
        {entries.map((e) => (
          <LicenseItem entry={e} texts={texts} key={`${e.name}@${e.version}`} />
        ))}
      </ul>
    </section>
  );
}

/** The texts are only put on the page while the entry is open; all of them together are several megabytes. */
function LicenseItem({ entry: e, texts }: { entry: NoticeEntry; texts: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details onToggle={(ev) => setOpen((ev.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <strong>{e.name}</strong> <span class="tiny muted">{e.version}</span>
          <span class="small soft"> · {e.license ? licenseLabel(e.license) : 'Lizenz nicht angegeben'}</span>
        </summary>
        {open ? (
          <div class="help-license-body">
            {e.authors ? <span class="tiny muted">Von {e.authors}</span> : null}
            {e.url ? (
              <span class="tiny">
                <ExternalLink href={e.url}>{e.url}</ExternalLink>
              </span>
            ) : null}
            {e.texts.length ? (
              e.texts.map((i) => (
                <pre class="help-license-text" key={i}>
                  {texts[i]}
                </pre>
              ))
            ) : (
              <p class="small soft">
                Das Paket bringt keinen eigenen Lizenztext mit.
                {e.license ? (
                  <>
                    {' '}
                    Es steht unter <LicenseLinks expression={e.license} />.
                  </>
                ) : null}
              </p>
            )}
          </div>
        ) : null}
      </details>
    </li>
  );
}
