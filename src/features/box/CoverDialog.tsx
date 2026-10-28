import { useEffect, useRef, useState } from 'preact/hooks';
import { FileAudio, ImagePlus, Search, Trash2 } from 'lucide-preact';
import { readTrackInfo } from '../../core/library/tags';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Spinner } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { bytesToObjectUrl, normalizeCover } from '../../ui/image';
import { card, coverUrlFor, plat } from '../../app/state';
import { setCoversAnywhere } from '../../app/waiting';
import { CoverSearch } from './CoverSearch';
import { PictogramCoverSearch } from '../stickers/PictogramCoverSearch';
import type { CoverKind } from '../../core/stickers/coversearch';

type Candidate = ReadyCover & { url: string; orientation?: 'portrait' };

/** A picture ready to store as a cover: decoded, at most 1200 px, with the name of where it came from. */
export interface ReadyCover {
  data: Uint8Array;
  mimeType: string;
  /** "iTunes", "MusicBrainz" or "Datei". */
  source: string;
  width?: number;
  height?: number;
}

/** Brings any picture into the form covers are stored in (see setCovers). */
export async function prepareCover(input: Blob | Uint8Array, mimeType: string, source: string): Promise<ReadyCover> {
  const img = await normalizeCover(input, mimeType);
  return { data: img.data, mimeType: img.mimeType, source, width: img.width, height: img.height };
}

/**
 * A cassette cover is taller than wide, like a card turned upright: its
 * sticker is turned that way too. A scan of the whole folded-out inlay is
 * wide and keeps the sticker as it is.
 */
export function uprightFor(kind: CoverKind, cover: Pick<ReadyCover, 'width' | 'height'>): 'portrait' | undefined {
  return kind === 'cassette' && cover.width && cover.height && cover.width < cover.height * 0.85 ? 'portrait' : undefined;
}

/** Asks for a picture on the computer ("Eigenes Bild"); null when none was chosen. */
export async function pickCoverFile(): Promise<Blob | Uint8Array | null> {
  const [file] = await plat().pickFiles({ multiple: false, extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] });
  if (!file) return null;
  return file.blob ?? (await file.read(0, file.size));
}

/** Change the cover of a folder: from the files, from the computer, or from an online search. */
export function CoverDialog({ folder, query, onClose }: { folder: number; query: string; onClose: () => void }) {
  // Without the card (the remembered box) the picture waits on this device until the card is open again.
  const s = card.value;
  const [tab, setTab] = useState<'search' | 'file' | 'tags'>('search');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const current = coverUrlFor(folder);
  // Counts the pictures handed in: only the latest one becomes the candidate, none after closing.
  const taken = useRef(0);

  useEffect(() => () => candidate && URL.revokeObjectURL(candidate.url), [candidate]);
  useEffect(
    () => () => {
      taken.current++;
    },
    [],
  );

  const take = async (input: Blob | Uint8Array, mime: string, source: string, kind: CoverKind = 'cd') => {
    const mine = ++taken.current;
    setBusy(true);
    try {
      const img = await prepareCover(input, mime, source);
      if (mine === taken.current) setCandidate({ ...img, url: bytesToObjectUrl(img.data, img.mimeType), orientation: uprightFor(kind, img) });
    } catch (e) {
      if (mine === taken.current) toastError('Das Bild passt nicht', e);
    } finally {
      if (mine === taken.current) setBusy(false);
    }
  };

  const fromFile = async () => {
    const picture = await pickCoverFile();
    if (picture) await take(picture, 'image/jpeg', 'Datei');
  };

  const fromTags = async () => {
    setBusy(true);
    try {
      if (!s) throw new Error('Dafür muss die SD-Karte stecken: die Bilder stecken in den Musikdateien auf der Karte.');
      const f = s.scan?.folders.find((x) => x.number === folder);
      if (!f?.tracks.length) throw new Error('Der Ordner hat keine Titel.');
      const dir = await s.volume.root.dir(f.name);
      for (const t of f.tracks.slice(0, 5)) {
        const info = await readTrackInfo(await dir.source(t.name));
        if (info.picture) {
          await take(info.picture.data, info.picture.mimeType, 'Datei');
          return;
        }
      }
      throw new Error('In den Dateien steckt kein Bild.');
    } catch (e) {
      toastError('Kein Bild gefunden', e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!candidate) return;
    setBusy(true);
    try {
      await setCoversAnywhere([{ folder, data: candidate.data, mimeType: candidate.mimeType, source: candidate.source, orientation: candidate.orientation }]);
      onClose();
    } catch (e) {
      toastError('Das Cover ließ sich nicht speichern', e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await setCoversAnywhere([{ folder, data: null }]).catch((e) => toastError('Entfernen hat nicht geklappt', e));
    onClose();
  };

  return (
    <Dialog
      title="Cover auswählen"
      width="wide"
      bodyClass="cover-dialog-body"
      onClose={onClose}
      footer={
        <>
          {current ? (
            <Button variant="ghost" icon={Trash2} onClick={remove} style={{ marginRight: 'auto' }}>
              Cover entfernen
            </Button>
          ) : null}
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!candidate} loading={busy && !!candidate} onClick={save}>
            Übernehmen
          </Button>
        </>
      }
    >
      <div class="stack cover-dialog">
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'search'} onClick={() => setTab('search')}>
            <Search size={16} /> Im Internet suchen
          </button>
          <button role="tab" aria-selected={tab === 'file'} onClick={() => setTab('file')}>
            <ImagePlus size={16} /> Eigenes Bild
          </button>
          {s ? (
            <button role="tab" aria-selected={tab === 'tags'} onClick={() => setTab('tags')}>
              <FileAudio size={16} /> Aus den Dateien
            </button>
          ) : null}
        </div>
        {/* On a phone the preview moves below the search. On a wider screen only the hits scroll (layout.css). */}
        <div class="cover-dialog-main">
          <div class="cover-dialog-pick">
            {tab === 'search' ? (
              <CoverSearch
                initialQuery={query}
                quiet
                onPick={(blob, source, kind) => take(blob, blob.type || 'image/jpeg', source, kind)}
                pictograms={() => <PictogramCoverSearch title={query} onPick={(blob, source) => take(blob, 'image/png', source)} />}
              />
            ) : null}
            {tab === 'file' ? (
              <div class="stack">
                <p class="soft">Nimm ein Foto vom CD-Cover, ein gemaltes Bild oder ein Bild aus dem Internet. Am besten quadratisch und mindestens 600 Pixel groß.</p>
                <div>
                  <Button icon={ImagePlus} onClick={fromFile}>
                    Bild auswählen …
                  </Button>
                </div>
              </div>
            ) : null}
            {tab === 'tags' ? (
              <div class="stack">
                <p class="soft">Viele MP3-Dateien enthalten das Cover des Albums. Ich seh in den ersten Titeln nach.</p>
                <div>
                  <Button icon={FileAudio} onClick={fromTags} loading={busy}>
                    Cover aus den Dateien holen
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
          <div class="stack tight cover-dialog-preview">
            <span class="section-title">Vorschau</span>
            <div style={{ width: 200, height: 200, borderRadius: 14, overflow: 'hidden', background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center', boxShadow: 'var(--shadow-sm)' }}>
              {busy && !candidate ? <Spinner /> : candidate ? <img class="cover-img whole" src={candidate.url} alt="" /> : current ? <img class="cover-img whole" src={current} alt="" /> : <span class="muted small">Noch kein Cover</span>}
            </div>
            {candidate ? <span class="tiny muted">Quelle: {candidate.source}</span> : null}
            {candidate?.orientation === 'portrait' ? <span class="tiny muted">Der Sticker dazu wird hochkant, so passt das Kassetten-Cover ganz drauf.</span> : null}
          </div>
        </div>
        <Callout tone="neutral">Cover sind urheberrechtlich geschützt. Nutze sie nur für deine eigenen Karten und gib sie nicht weiter.</Callout>
      </div>
    </Dialog>
  );
}
