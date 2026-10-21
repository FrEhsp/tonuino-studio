import { useEffect, useRef, useState } from 'preact/hooks';
import { Search } from 'lucide-preact';
import { ARASAAC_LICENSE_URL, PICTOGRAM_CREDIT, PictogramError, type PictogramHit } from '../../core/stickers/arasaac';
import { isAbortError } from '../../core/stickers/image';
import { plat } from '../../app/state';
import { Button, Callout, Field } from '../../ui/components/controls';
import { ExternalLink } from '../help/ExternalLink';
import { findPictograms, hasPictogram, keepPictogram } from './pictograms';

const fetchFn = (url: string, init?: RequestInit) => plat().fetch(url, init);

/** What the Bildkarte shows without a pictogram: the app's motif for the name, only the word, or the own picture of a sticker without a card. */
export type PictogramFallback = 'motif' | 'word' | 'picture';

const FALLBACK: Record<PictogramFallback, { choice: string; hint: string; missing: string }> = {
  motif: { choice: 'Gemaltes Bild', hint: 'Gerade das gemalte Bild, das zum Namen passt.', missing: 'das gemalte Bild' },
  word: { choice: 'Nur das Wort', hint: 'Zu diesem Namen male ich kein Bild. Dann steht das Wort groß da, oder du nimmst ein Piktogramm.', missing: 'nur das Wort' },
  picture: { choice: 'Dein Bild', hint: 'Gerade dein Bild. Statt des Bildes kann auch ein Piktogramm auf der Bildkarte stehen.', missing: 'dein Bild' },
};

/**
 * "Sticker anpassen", style "Bildkarte": a card without a cover shows the
 * app's own motif, a sticker from an own picture that picture; either can
 * take an ARASAAC pictogram searched for by word (core/stickers/arasaac.ts).
 * Nothing goes online until "Suchen" is pressed.
 */
export function PictogramPicker({ word, value, own, onChange }: { word: string; value: number | undefined; own: PictogramFallback; onChange: (id: number | undefined) => void }) {
  const fallback = FALLBACK[own];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(word);
  const [hits, setHits] = useState<PictogramHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const run = useRef<AbortController | null>(null);

  useEffect(() => () => run.current?.abort(), []);
  // Chosen on another device, or the browser's data cleared: the card shows the own motif until it is loaded again.
  useEffect(() => {
    let alive = true;
    setMissing(false);
    if (value) void hasPictogram(value).then((has) => alive && setMissing(!has));
    return () => {
      alive = false;
    };
  }, [value]);

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
      if (!isAbortError(e)) setError(e instanceof PictogramError ? e.message : 'Die Suche hat nicht geklappt.');
    } finally {
      if (run.current === ctl) setBusy(false);
    }
  };

  const choose = async (hit: PictogramHit) => {
    setLoading(hit.id);
    setError(null);
    try {
      await keepPictogram(hit.id, fetchFn, run.current?.signal);
      onChange(hit.id);
      setMissing(false);
    } catch (e) {
      if (!isAbortError(e)) setError(e instanceof PictogramError ? e.message : 'Das Piktogramm ließ sich nicht laden.');
    } finally {
      setLoading(null);
    }
  };

  return (
    // The hint speaks of the choice above the search; under the open search it would read as being about the hits.
    <Field label="Bild der Bildkarte" hint={value || open ? undefined : fallback.hint}>
      <div class="stack tight">
        <div class="swatches" role="radiogroup" aria-label="Bild der Bildkarte">
          <button type="button" role="radio" aria-checked={!value} class="swatch auto" onClick={() => onChange(undefined)}>
            {fallback.choice}
          </button>
          {value ? (
            <button type="button" role="radio" aria-checked class="swatch auto">
              Piktogramm
            </button>
          ) : null}
          {!open ? (
            <Button size="sm" variant="ghost" icon={Search} onClick={() => setOpen(true)}>
              Piktogramm suchen
            </Button>
          ) : null}
        </div>
        {value && missing ? (
          <Callout tone="warning">Das Piktogramm ist nicht auf diesem Gerät. Bis du es noch einmal suchst und wählst, zeigt die Karte {fallback.missing}.</Callout>
        ) : null}
        {open ? (
          <div class="pictogram-search stack tight">
            <p class="small soft">
              Ich suche bei <ExternalLink href="https://arasaac.org">ARASAAC</ExternalLink>, einer freien Sammlung von Piktogrammen. ARASAAC sieht dabei das Suchwort und deine IP-Adresse. Das gewählte Bild bleibt danach auf diesem Gerät.
            </p>
            <form
              class="row"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <input class="input" type="search" value={query} aria-label="Wort für das Piktogramm" placeholder="zum Beispiel Katze" onInput={(e) => setQuery(e.currentTarget.value)} />
              <Button type="submit" loading={busy}>
                Suchen
              </Button>
            </form>
            {error ? <Callout tone="danger">{error}</Callout> : null}
            {hits && !hits.length ? <p class="small soft">Zu „{query.trim()}“ hat ARASAAC nichts. Versuche ein einfacheres Wort, etwa „Hund“ statt „Hundegeschichten“.</p> : null}
            {hits?.length ? (
              <div class="pictogram-grid">
                {hits.map((h) => (
                  <button type="button" key={h.id} class={`pictogram-hit${value === h.id ? ' chosen' : ''}`} aria-pressed={value === h.id} disabled={loading !== null} onClick={() => void choose(h)} title={h.label}>
                    <img src={h.thumbUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
                    <span class="tiny">{loading === h.id ? 'Lädt …' : h.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {value ? (
          <p class="tiny soft">
            {PICTOGRAM_CREDIT}. Das steht klein auf der Karte{own === 'picture' ? '' : ', mit Rückseite dort'}. Für deine Karten frei, aber nicht zum Verkaufen (<ExternalLink href={ARASAAC_LICENSE_URL}>Lizenz</ExternalLink>).
          </p>
        ) : null}
      </div>
    </Field>
  );
}
