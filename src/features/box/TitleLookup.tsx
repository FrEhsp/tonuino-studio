/**
 * Names for a folder whose files carry none (TODO 0.3 #35): a button that
 * looks for the album's track list at iTunes and MusicBrainz, and a quiet
 * note in the catalog of what the files told, so the folder opens with its
 * titles next time.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Search } from 'lucide-preact';
import { Button } from '../../ui/components/controls';
import { toast } from '../../ui/components/Toast';
import { card, updateCatalog } from '../../app/state';
import { canChangeCard } from '../../app/pending';
import { looksBrokenTitleCase, recase, tidyName } from '../../core/library/tidy';
import { lookupAlbumTracks, titlesFromMatch } from '../../core/library/tracklookup';
import { lookupFailureMessage, OFFLINE_MESSAGE } from '../../core/stickers/bulkcover';
import { isAbortError } from '../../core/stickers/image';
import type { CatalogFolder } from '../../core/tonuino/catalog';
import { helperFolders, type SdFolder } from '../../core/tonuino/sd';
import type { TrackRow } from '../cards/trackTitles';
import { coverFetch } from './CoverSearch';

/** True when the folder could use names from the internet: tracks without one, or an album name in broken Title Case. */
export function wantsLookup(title: string, rows: readonly TrackRow[]): boolean {
  return rows.length > 0 && (rows.some((r) => r.untitled) || looksBrokenTitleCase(title));
}

/** The button above the track list, with what it found. */
export function TitleLookup({ folder, title, artist, rows }: { folder: string; title: string; artist?: string; rows: TrackRow[] }) {
  const [busy, setBusy] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  const missing = rows.filter((r) => r.untitled).length;

  const run = async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      toast.error('Suche geht gerade nicht', OFFLINE_MESSAGE);
      return;
    }
    ctrl.current?.abort();
    const c = (ctrl.current = new AbortController());
    setBusy(true);
    try {
      const found = await lookupAlbumTracks({ album: title, artist, durations: rows.map((r) => r.durationSec) }, { fetchFn: coverFetch, signal: c.signal });
      if (c.signal.aborted) return;
      if (!found) {
        toast.info(
          'Nichts Passendes gefunden',
          `Bei iTunes und MusicBrainz gibt es kein Album „${tidyName(title) ?? title}“ mit ${rows.length} Titeln in passender Länge. Du kannst die Namen selbst eintippen: Klicke auf einen Titel.`,
        );
        return;
      }
      const names = titlesFromMatch(rows, found);
      const album = recase(tidyName(title) ?? title, found.album);
      await updateCatalog((cat) => {
        const e: CatalogFolder | undefined = cat.folders[folder];
        if (!e) return;
        for (const n of names) {
          const row = rows.find((r) => r.file === n.file);
          const t = e.tracks.find((x) => x.file.toLowerCase() === n.file.toLowerCase());
          if (t) {
            t.title = n.title;
            t.titleAuto = true;
          } else e.tracks.push({ file: n.file, title: n.title, titleAuto: true, durationSec: row?.durationSec });
        }
        if (album !== e.title) e.title = album;
        if (!e.artist && found.artist) e.artist = tidyName(found.artist);
        e.updatedAt = Date.now();
      });
      const fixed = album !== title;
      toast.success(
        names.length ? `${names.length === 1 ? 'Ein Titelname' : `${names.length} Titelnamen`} gefunden` : fixed ? 'Schreibweise korrigiert' : 'Album gefunden',
        `Von ${found.source}. ${names.length ? 'Sie stehen als „automatisch erkannt“ in der Liste. Stimmt einer nicht, klicke darauf und ändere ihn.' : fixed ? `Der Ordner heißt jetzt „${album}“.` : 'Die Namen in der Liste passen schon.'}`,
      );
    } catch (e) {
      if (c.signal.aborted || isAbortError(e)) return;
      toast.error('Suche hat nicht geklappt', lookupFailureMessage(e));
    } finally {
      if (ctrl.current === c) setBusy(false);
    }
  };

  return (
    <div class="row wrap" style={{ padding: '10px 24px', borderBottom: '1px solid var(--border)', gap: 'var(--space-3)' }}>
      <span class="grow small muted">
        {missing
          ? `${missing === rows.length ? 'Die Titel haben' : missing === 1 ? 'Ein Titel hat' : `${missing} Titel haben`} keinen Namen. Ich kann bei iTunes und MusicBrainz nach dem Album suchen und die Namen übernehmen, wenn Anzahl und Längen passen.`
          : 'Der Name des Ordners sieht aus, als hätte ein Programm jedes Wort großgeschrieben. Ich kann bei iTunes und MusicBrainz nachsehen, wie das Album richtig heißt.'}
      </span>
      <Button size="sm" icon={Search} onClick={run} disabled={busy}>
        {busy ? 'Sucht …' : 'Im Internet suchen'}
      </Button>
    </div>
  );
}

/**
 * Notes in the catalog what the files told about a folder the catalog knows:
 * titles it lacks, lengths from the frames where it had a guess, an artist
 * that was only track 1's. Once per folder visit, only when the app writes
 * straight onto the card (not into a Paket), never for swapped files or new
 * tracks (those wait for "Neuen Stand übernehmen").
 */
export function useNoteFindings(folder: string, f: SdFolder, entry: CatalogFolder | undefined, rows: TrackRow[], done: boolean, artist: string | undefined) {
  const noted = useRef<string | null>(null);
  useEffect(() => {
    const s = card.value;
    if (!done || !entry || !s || s.volume.access === 'snapshot' || !canChangeCard()) return;
    if (s.scan?.tempDirs.some((t) => helperFolders(t).includes(f.number))) return;
    const titles = new Map<string, { title?: string; titleAuto?: boolean; durationSec?: number; exact?: boolean }>();
    for (const r of rows) {
      const c = entry.tracks.find((x) => x.file.toLowerCase() === r.file.toLowerCase());
      if (!c || (c.size !== undefined && c.size !== r.size)) continue;
      const change: { title?: string; titleAuto?: boolean; durationSec?: number; exact?: boolean } = {};
      if ((!c.title || c.title !== r.title) && !r.untitled && r.title) {
        change.title = r.title;
        if (r.titleAuto) change.titleAuto = true;
      }
      if (r.durationSec !== undefined && (c.durationSec === undefined || Math.abs(c.durationSec - r.durationSec) >= 0.5)) change.durationSec = r.durationSec;
      // Checked against the frames: next time the folder opens without reading the file.
      if (r.durationExact && !c.durationExact) change.exact = true;
      if (Object.keys(change).length) titles.set(c.file, change);
    }
    const newArtist = artist !== (entry.artist || undefined) ? artist : undefined;
    const dropArtist = !artist && !!entry.artist;
    const key = `${folder}|${[...titles.keys()].join(',')}|${newArtist ?? ''}|${dropArtist}`;
    if ((!titles.size && !newArtist && !dropArtist) || noted.current === key) return;
    noted.current = key;
    void updateCatalog((c) => {
      const e = c.folders[folder];
      if (!e) return;
      for (const t of e.tracks) {
        const change = titles.get(t.file);
        if (!change) continue;
        if (change.title !== undefined) {
          t.title = change.title;
          if (change.titleAuto) t.titleAuto = true;
          else delete t.titleAuto;
        }
        if (change.durationSec !== undefined) t.durationSec = change.durationSec;
        if (change.exact && t.durationSec !== undefined) t.durationExact = true;
      }
      if (newArtist) e.artist = newArtist;
      if (dropArtist) delete e.artist;
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, rows, artist]);
}
