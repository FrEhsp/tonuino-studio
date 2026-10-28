/**
 * "Wort + Piktogramm" (TODO 0.3 #98): a sticker of a word and an ARASAAC pictogram, made here
 * without an SD card and without a picture file. Every pictogram picked comes onto the sheet as
 * its own sticker (content.ts addWordSticker); the Bildkarte style shows it best, the others show
 * the pictogram as the sticker's picture. Nothing goes online until "Suchen" is pressed.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Search } from 'lucide-preact';
import { ARASAAC_LICENSE_URL, PICTOGRAM_CREDIT, PICTOGRAM_NET_ERROR, PictogramError, type PictogramHit } from '../../core/stickers/arasaac';
import { isAbortError } from '../../core/stickers/image';
import { plat } from '../../app/state';
import { Button, Callout } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast } from '../../ui/components/Toast';
import { ExternalLink } from '../help/ExternalLink';
import { addWordSticker, stickerItems } from './content';
import { design, updateDesign } from './design';
import { pictogramCover } from './pictogramCover';
import { findPictograms } from './pictograms';

const fetchFn = (url: string, init?: RequestInit) => plat().fetch(url, init);

export function WordCardDialog({ onClose }: { onClose: () => void }) {
  const [word, setWord] = useState('');
  // The word the hits belong to: what goes on the sticker, even if the field was changed since.
  const [searched, setSearched] = useState('');
  const [hits, setHits] = useState<PictogramHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState<number | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  // The sheet was empty at the first word: it went to „Bildkarte“ by itself (Prüfrunde 1, eltern B10).
  const [switched, setSwitched] = useState(false);
  const run = useRef<AbortController | null>(null);
  const bild = design.value.style === 'bild';

  useEffect(() => () => run.current?.abort(), []);

  const search = async () => {
    const q = word.trim();
    if (!q) return;
    run.current?.abort();
    const ctl = new AbortController();
    run.current = ctl;
    setBusy(true);
    setError(null);
    try {
      const found = await findPictograms(q, fetchFn, ctl.signal);
      if (!ctl.signal.aborted) {
        setHits(found);
        setSearched(q);
      }
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
      const cover = await pictogramCover(hit.id, fetchFn, run.current?.signal);
      const empty = !stickerItems.value.length;
      if (addWordSticker(searched, hit.id, cover)) {
        setAdded((a) => [...a, searched]);
        if (empty && design.value.style !== 'bild') {
          updateDesign({ style: 'bild' });
          setSwitched(true);
        }
      } else toast.info('Diese Karte ist schon da', `„${searched}“ mit diesem Bild steht schon auf dem Bogen.`);
    } catch (e) {
      if (!isAbortError(e)) setError(e instanceof PictogramError ? e.message : 'Das Piktogramm ließ sich nicht laden.');
    } finally {
      setLoading(null);
    }
  };

  return (
    <Dialog title="Wort + Piktogramm" width="wide" onClose={onClose} footer={<Button onClick={onClose}>{added.length ? 'Fertig' : 'Schließen'}</Button>}>
      <div class="stack pictogram-search">
        <p class="soft">
          {added.length
            ? `Auf dem Bogen: ${added.map((t) => `„${t}“`).join(', ')}. Noch eine? Schreibe einfach das nächste Wort.`
            : 'Schreibe ein Wort, zum Beispiel „Schlafen“ oder „Auto“. Dann suche ein Bild dazu aus. Wort und Bild kommen zusammen als Sticker auf den Bogen. Dafür brauchst du keine SD-Karte.'}
        </p>
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <div class="input-group grow">
            <Search size={17} />
            <input class="input" type="search" value={word} aria-label="Wort für den Sticker" placeholder="zum Beispiel Katze" onInput={(e) => setWord(e.currentTarget.value)} />
          </div>
          <Button type="submit" variant="primary" loading={busy}>
            Suchen
          </Button>
        </form>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {hits && !hits.length ? <p class="soft">Zu „{searched}“ gibt es kein Piktogramm. Versuche ein einfaches Wort, etwa „Hund“ statt „Hundegeschichten“.</p> : null}
        {hits?.length ? (
          <div class="pictogram-grid">
            {hits.map((h) => (
              <button type="button" key={h.id} class="pictogram-hit" disabled={loading !== null} aria-busy={loading === h.id} onClick={() => void choose(h)} title={`„${searched}“ mit diesem Bild auf den Bogen`}>
                <img src={h.thumbUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
                <span class="tiny">{loading === h.id ? 'Lädt …' : h.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        {added.length && bild && switched ? <p class="small">Der Bogen steht jetzt auf „Bildkarte“: So ist die Karte am deutlichsten.</p> : null}
        {added.length && !bild ? (
          <div class="row wrap tight">
            <span class="small">Am deutlichsten sind Wortkarten im Stil „Bildkarte“.</span>
            <Button size="sm" onClick={() => updateDesign({ style: 'bild' })}>
              Bogen auf „Bildkarte“ stellen
            </Button>
          </div>
        ) : null}
        <p class="hint">
          Piktogramme von <ExternalLink href="https://arasaac.org">ARASAAC</ExternalLink>. Die Suche sieht dein Wort und deine IP-Adresse. Auf dem Sticker steht klein „{PICTOGRAM_CREDIT}“. Für deine Karten frei, aber nicht zum Verkaufen (
          <ExternalLink href={ARASAAC_LICENSE_URL}>Lizenz</ExternalLink>).
        </p>
      </div>
    </Dialog>
  );
}
