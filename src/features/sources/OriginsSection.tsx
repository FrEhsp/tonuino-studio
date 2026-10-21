/** "Herkunft und Lizenz" on a folder page: where files from "Entdecken" came from and under which terms. */
import './sources.css';
import { FileText } from 'lucide-preact';
import { formatDay, privateOnly, sourcesListText } from '../../core/sources/origin';
import type { CatalogFolder } from '../../core/tonuino/catalog';
import { card, plat } from '../../app/state';
import { Badge, Button } from '../../ui/components/controls';
import { toast, toastError } from '../../ui/components/Toast';
import { originsIntro } from './labels';
import { ExternalLink } from './links';

/** A file name from the box name: no characters that file systems refuse. */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Box';
}

export function OriginsSection({ folder }: { folder: CatalogFolder | undefined }) {
  const origins = folder?.origins ?? [];
  if (!origins.length) return null;
  // Some files came unchanged (no credit inside), some with the credit written into them.
  const mixed = origins.some((o) => o.changes.includes('tags')) && origins.some((o) => !o.changes.includes('tags'));
  const save = async () => {
    const s = card.value;
    if (!s?.catalog) return;
    const boxName = s.catalog.name ?? s.volume.label;
    const text = sourcesListText(s.catalog, boxName, Date.now());
    try {
      if (await plat().files.save(`Quellen ${safeFileName(boxName)}.txt`, new Blob([text], { type: 'text/plain;charset=utf-8' }))) toast.success('Quellenliste gespeichert');
    } catch (e) {
      toastError('Speichern hat nicht geklappt', e);
    }
  };
  return (
    <section class="card pad stack source-origins" aria-labelledby="source-origins-h">
      <div class="row wrap">
        <div class="stack tight grow">
          <h2 id="source-origins-h">Herkunft und Lizenz</h2>
          <p class="muted small">{originsIntro(origins)}</p>
        </div>
        <Button variant="ghost" icon={FileText} onClick={save}>
          Quellenliste speichern
        </Button>
      </div>
      <ul class="source-origin-list">
        {origins.map((o) => (
          <li key={o.id}>
            <strong>
              „{o.title}“{o.series ? ` – ${o.series}` : ''}
            </strong>
            <p class="small soft">{o.credit}</p>
            <div class="source-origin-meta">
              {o.licence.url ? (
                <ExternalLink class="badge source-licence-link" href={o.licence.url}>
                  {o.licence.label}
                </ExternalLink>
              ) : (
                <Badge>{o.licence.label}</Badge>
              )}
              <ExternalLink href={o.pageUrl}>Zur Seite des Anbieters</ExternalLink>
              <span class="muted">Geladen am {formatDay(o.retrievedAt)}</span>
            </div>
            {privateOnly(o.licence) ? <p class="small muted">Nur für den privaten Gebrauch in deiner Familie, nicht zum öffentlichen Abspielen, zum Beispiel in der Kita.</p> : null}
            {mixed && !o.changes.includes('tags') ? <p class="small muted">Unverändert auf der Karte: In der Datei selbst stehen diese Angaben nicht.</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
