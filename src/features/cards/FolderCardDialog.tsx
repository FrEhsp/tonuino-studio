import { useMemo, useState } from 'preact/hooks';
import { CopyPlus, ListMusic } from 'lucide-preact';
import type { CardData } from '../../core/tonuino/card';
import { buildShelf, type FolderCard, type ShelfItem } from '../../core/tonuino/catalog';
import { folderName } from '../../core/tonuino/sd';
import { Dialog } from '../../ui/components/Dialog';
import { Button, Callout, Field, Segmented } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { boxScan, catalog, profile, settings } from '../../app/state';
import { addExtraCards, extras, extraLabel, folderCardData, newCards, partialDuplicateNote, sameCard } from './items';
import { ModePicker } from './ModePicker';
import { useTrackRows } from './trackTitles';

type Kind = 'tracks' | 'one';

function trackNumbers(s: ShelfItem | undefined): number[] {
  return [...new Set((s?.folder?.tracks ?? []).map((t) => t.number))].sort((a, b) => a - b);
}

/** How the folder's own card plays it: the start for one more card. */
function ownCard(s: ShelfItem | undefined): FolderCard {
  const d = folderCardData(s?.number ?? 1, s?.entry?.card, s?.entry?.kind);
  return { mode: d.mode, special: d.special, special2: d.special2 };
}

/**
 * Further cards for a folder besides its own: one card per track, or one
 * more card that plays the folder another way (a part of it, a second copy).
 */
export function FolderCardDialog({ onClose }: { onClose: () => void }) {
  const prof = profile.value;
  const scan = boxScan.value;
  const cat = catalog.value;
  const folders = useMemo(() => (scan ? buildShelf(scan, cat).filter((s) => s.folder && s.trackCount > 0) : []), [scan, cat]);
  const withTracks = useMemo(() => new Set(folders.map((f) => f.number)), [folders]);
  const [folder, setFolder] = useState(folders[0]?.number ?? 0);
  const shelf = folders.find((s) => s.number === folder);
  // Titles from the catalog, else from the files' own tags, so the choices name the songs.
  const rows = useTrackRows(shelf?.folder, shelf?.entry);
  const tracks = trackNumbers(shelf);
  const [kind, setKind] = useState<Kind>('tracks');
  const [from, setFrom] = useState(tracks[0] ?? 1);
  const [to, setTo] = useState(tracks[tracks.length - 1] ?? 1);
  const [value, setValue] = useState<FolderCard>(() => ownCard(shelf));
  const [busy, setBusy] = useState(false);

  const titleOf = (n: number) => rows.find((r) => r.number === n)?.title;
  const choose = (n: number) => {
    const s = folders.find((f) => f.number === n);
    const numbers = trackNumbers(s);
    setFolder(n);
    setFrom(numbers[0] ?? 1);
    setTo(numbers[numbers.length - 1] ?? 1);
    setValue(ownCard(s));
  };

  const one: CardData = { folder, mode: value.mode, special: value.special ?? 0, special2: value.special2 ?? 0 };
  const cards: CardData[] = !shelf ? [] : kind === 'tracks' ? tracks.filter((n) => n >= from && n <= to).map((n) => ({ folder, mode: 4, special: n, special2: 0 })) : [one];

  // A card that is in the list already does not come in twice: it would only be written twice.
  const fresh = newCards(
    extras.value,
    cards.map((data) => ({ data })),
  ).map((c) => c.data);
  const already = cards.length - fresh.length;
  const asOwn = kind === 'one' && shelf ? sameCard(one, folderCardData(folder, shelf.entry?.card, shelf.entry?.kind)) : false;

  const add = async () => {
    setBusy(true);
    try {
      await addExtraCards(fresh.map((data) => ({ data, label: extraLabel(data, prof, titleOf) })));
      onClose();
    } catch (e) {
      toastError('Die Karten ließen sich nicht hinzufügen', e);
      setBusy(false);
    }
  };

  const trackOption = (n: number) => (
    <option value={n} key={n}>
      {n} · {titleOf(n) ?? `Titel ${n}`}
    </option>
  );

  return (
    <Dialog
      title="Weitere Karten für einen Ordner"
      width="wide"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={add} loading={busy} disabled={!fresh.length}>
            {fresh.length > 1 ? `${fresh.length} Karten hinzufügen` : 'Karte hinzufügen'}
          </Button>
        </>
      }
    >
      <div class="stack">
        <p class="soft">Jeder Ordner hat schon seine eigene Karte. Hier kommen weitere dazu, zum Beispiel eine Karte für jedes Lied.</p>
        <Field label="Ordner" id="fc-folder">
          <select id="fc-folder" class="select" style={{ width: 420, maxWidth: '100%' }} value={folder} onChange={(e) => choose(Number(e.currentTarget.value))}>
            {folders.map((f) => (
              <option value={f.number} key={f.number}>
                {folderName(f.number)} · {f.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Welche Karten?">
          <Segmented<Kind>
            label="Welche Karten"
            value={kind}
            options={[
              { value: 'tracks', label: 'Eine Karte pro Titel', icon: ListMusic },
              { value: 'one', label: 'Eine weitere Karte', icon: CopyPlus },
            ]}
            onChange={setKind}
          />
        </Field>
        {kind === 'tracks' ? (
          <>
            <div class="row wrap" style={{ gap: 16 }}>
              <Field label="Von Titel" id="fc-from">
                <select
                  id="fc-from"
                  class="select"
                  style={{ width: 280, maxWidth: '100%' }}
                  value={from}
                  onChange={(e) => {
                    const n = Number(e.currentTarget.value);
                    setFrom(n);
                    setTo(Math.max(n, to));
                  }}
                >
                  {tracks.map(trackOption)}
                </select>
              </Field>
              <Field label="Bis Titel" id="fc-to">
                <select id="fc-to" class="select" style={{ width: 280, maxWidth: '100%' }} value={to} onChange={(e) => setTo(Number(e.currentTarget.value))}>
                  {tracks.filter((n) => n >= from).map(trackOption)}
                </select>
              </Field>
            </div>
            <p class="soft small">Jede Karte spielt genau einen Titel. An der Box beschreibst du sie alle in einem Durchgang.</p>
          </>
        ) : (
          <ModePicker key={folder} profile={prof} value={value} onChange={setValue} trackCount={rows.length} folder={folder} advanced={settings.value.advancedModes} withTracks={withTracks} trackTitle={titleOf} onLeave={onClose} />
        )}
        {already ? (
          <Callout tone="warning">
            {!fresh.length
              ? cards.length > 1
                ? 'Diese Karten sind schon alle in der Liste. Wähle andere Titel.'
                : 'Genau diese Karte ist schon in der Liste. Wähle etwas anderes.'
              : partialDuplicateNote(already)}
          </Callout>
        ) : asOwn ? (
          <Callout tone="info">So spielt auch die eigene Karte des Ordners. Füge sie nur hinzu, wenn du eine zweite gleiche Karte brauchst.</Callout>
        ) : null}
      </div>
    </Dialog>
  );
}
