/**
 * "Cover auswählen" › "Piktogramm" (TODO #113): an ARASAAC pictogram as the card's picture, searched for
 * by a word of its title. The chosen one comes back as a cover (pictogramCover.ts) and is then taken
 * like any other cover, so it goes with every sticker style. Nothing goes online until "Suchen".
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Search } from 'lucide-preact';
import { ARASAAC_LICENSE_URL, PICTOGRAM_CREDIT, PICTOGRAM_NET_ERROR, PictogramError, type PictogramHit } from '../../core/stickers/arasaac';
import { isAbortError } from '../../core/stickers/image';
import { plat } from '../../app/state';
import { Button, Callout } from '../../ui/components/controls';
import { ExternalLink } from '../help/ExternalLink';
import { pictogramCover } from './pictogramCover';
import { findPictograms } from './pictograms';

const fetchFn = (url: string, init?: RequestInit) => plat().fetch(url, init);

/** The first words of a title, the way people search for a pictogram ("Die kleine Hexe" for the witch). */
export function pictogramQuery(title: string): string {
  return title
    .replace(/\b(?:Folge|Teil|Nr\.?)\s*\d+\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
}

export function PictogramCoverSearch({ title, onPick }: { title: string; onPick: (blob: Blob, source: string) => void }) {
  const [query, setQuery] = useState(() => pictogramQuery(title));
  const [hits, setHits] = useState<PictogramHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState<number | null>(null);
  const run = useRef<AbortController | null>(null);

  useEffect(() => () => run.current?.abort(), []);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    run.current?.abort();
    const ctl = new AbortController();
    run.current = ctl;
    setBusy(true);
    setError(null);
    try {
      const found = await findPictograms(q, fetchFn, ctl.signal);
      if (!ctl.signal.aborted) setHits(found);
    } catch (e) {
      if (!isAbortError(e)) setError(e instanceof PictogramError ? e.message : PICTOGRAM_NET_ERROR);
    } finally {
      if (run.current === ctl) setBusy(false);
    }
  };

  const choose = async (hit: PictogramHit) => {
    setLoading(hit.id);
    setError(null);
    try {
      onPick(await pictogramCover(hit.id, fetchFn, run.current?.signal), 'ARASAAC');
    } catch (e) {
      if (!isAbortError(e)) setError(e instanceof PictogramError ? e.message : 'Das Piktogramm ließ sich nicht laden.');
    } finally {
      setLoading(null);
    }
  };

  return (
    <div class="stack pictogram-search">
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div class="input-group grow">
          <Search size={17} />
          <input class="input" type="search" value={query} aria-label="Wort für das Piktogramm" placeholder="zum Beispiel Katze" onInput={(e) => setQuery(e.currentTarget.value)} />
        </div>
        <Button type="submit" loading={busy}>
          Suchen
        </Button>
      </form>
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {hits && !hits.length ? <p class="soft">Zu „{query.trim()}“ gibt es kein Piktogramm. Versuche ein einfaches Wort, etwa „Hund“ statt „Hundegeschichten“.</p> : null}
      {hits?.length ? (
        <div class="pictogram-grid">
          {hits.map((h) => (
            <button type="button" key={h.id} class="pictogram-hit" disabled={loading !== null} aria-busy={loading === h.id} onClick={() => void choose(h)} title={h.label}>
              <img src={h.thumbUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
              <span class="tiny">{loading === h.id ? 'Lädt …' : h.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <p class="hint">
        Piktogramme von <ExternalLink href="https://arasaac.org">ARASAAC</ExternalLink>. Die Suche sieht dein Suchwort und deine IP-Adresse. Auf dem Bild steht klein „{PICTOGRAM_CREDIT}“. Für deine Karten frei, aber nicht zum Verkaufen (
        <ExternalLink href={ARASAAC_LICENSE_URL}>Lizenz</ExternalLink>).
      </p>
    </div>
  );
}
