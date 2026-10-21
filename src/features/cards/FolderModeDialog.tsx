import { useMemo, useState } from 'preact/hooks';
import { buildShelf, type CatalogFolder, type FolderCard } from '../../core/tonuino/catalog';
import { folderName } from '../../core/tonuino/sd';
import { Dialog } from '../../ui/components/Dialog';
import { Button } from '../../ui/components/controls';
import { toastError } from '../../ui/components/Toast';
import { card, catalog, profile, settings, updateCatalog } from '../../app/state';
import { applyFolderCard, folderCardData, keepsFolderCard } from './items';
import { ModePicker } from './ModePicker';
import { useTrackRows } from './trackTitles';

/** How a folder's own card plays it, changed right on the cards page, as on the folder's page. */
export function FolderModeDialog({ folder, onClose }: { folder: number; onClose: () => void }) {
  const name = folderName(folder);
  const scan = card.value?.scan;
  const cat = catalog.value;
  const entry = cat?.folders[name];
  const f = scan?.folders.find((x) => x.number === folder);
  const withTracks = useMemo(() => new Set(scan ? buildShelf(scan, cat).filter((s) => s.folder && s.trackCount > 0).map((s) => s.number) : []), [scan, cat]);
  const rows = useTrackRows(f, entry);
  const [value, setValue] = useState<FolderCard>(() => {
    const d = folderCardData(folder, entry?.card, entry?.kind);
    return { mode: d.mode, special: d.special, special2: d.special2 };
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    // Nothing changed: no Paket waits for it, and the card keeps following the folder's kind.
    if (keepsFolderCard(entry, value)) return onClose();
    setBusy(true);
    try {
      await updateCatalog(
        (c) => {
          const now = Date.now();
          const e: CatalogFolder = c.folders[name] ?? (c.folders[name] = { title: `Ordner ${name}`, tracks: [], addedAt: now, updatedAt: now });
          applyFolderCard(e, value);
          e.updatedAt = now;
        },
        { touchFolders: entry ? [] : [folder] },
      );
      onClose();
    } catch (e) {
      toastError('Speichern hat nicht geklappt', e);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`So spielt die Karte: ${entry?.title ?? `Ordner ${name}`}`}
      width="wide"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Speichern
          </Button>
        </>
      }
    >
      <div class="stack">
        <p class="soft small">Gilt für Karten, die du ab jetzt beschreibst. Schon beschriebene Karten bleiben, wie sie sind.</p>
        <ModePicker
          profile={profile.value}
          value={value}
          onChange={setValue}
          trackCount={rows.length}
          folder={folder}
          advanced={settings.value.advancedModes}
          withTracks={withTracks}
          trackTitle={(n) => rows.find((r) => r.number === n)?.title}
        />
      </div>
    </Dialog>
  );
}
