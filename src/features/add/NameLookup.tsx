/**
 * "Im Internet suchen" on "Hinzufügen" (TODO 0.3 #35): for an album whose
 * files carry no track names, or whose name has a capital letter on every
 * word, the track list of the same album at iTunes or MusicBrainz. Taken
 * only with as many tracks and fitting lengths; the names are marked
 * "automatisch erkannt" and stay editable.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Search } from 'lucide-preact';
import { Button } from '../../ui/components/controls';
import { toast } from '../../ui/components/Toast';
import { isNamelessTitle, looksBrokenTitleCase, recase, tidyName } from '../../core/library/tidy';
import { lookupAlbumTracks, titlesFromMatch } from '../../core/library/tracklookup';
import { lookupFailureMessage, OFFLINE_MESSAGE } from '../../core/stickers/bulkcover';
import { isAbortError } from '../../core/stickers/image';
import { coverFetch } from '../box/CoverSearch';
import { updateAlbum, updateTracks, type ImportAlbum } from './session';

/** True when the album could use names from the internet. */
export function albumWantsLookup(a: ImportAlbum): boolean {
  if (a.append || a.unchanged || !a.tracks.length) return false;
  return a.tracks.some((t) => isNamelessTitle(t.title)) || looksBrokenTitleCase(a.title);
}

export function NameLookup({ album: a }: { album: ImportAlbum }) {
  const [busy, setBusy] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  const nameless = a.tracks.filter((t) => isNamelessTitle(t.title)).length;

  const run = async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      toast.error('Suche geht gerade nicht', OFFLINE_MESSAGE);
      return;
    }
    ctrl.current?.abort();
    const c = (ctrl.current = new AbortController());
    setBusy(true);
    try {
      const found = await lookupAlbumTracks({ album: a.title, artist: a.artist, durations: a.tracks.map((t) => t.info?.durationSec) }, { fetchFn: coverFetch, signal: c.signal });
      if (c.signal.aborted) return;
      if (!found) {
        toast.info('Nichts Passendes gefunden', `Bei iTunes und MusicBrainz gibt es kein Album „${tidyName(a.title) ?? a.title}“ mit ${a.tracks.length} Titeln in passender Länge. Du kannst die Namen selbst eintippen.`);
        return;
      }
      const rows = a.tracks.map((t) => ({ file: t.source.relativePath ?? t.source.name, title: t.title, untitled: isNamelessTitle(t.title), titleAuto: t.titleAuto }));
      const names = new Map(titlesFromMatch(rows, found).map((n) => [n.file, n.title]));
      if (names.size) updateTracks(a.id, (list) => list.map((t) => (names.has(t.source.relativePath ?? t.source.name) ? { ...t, title: names.get(t.source.relativePath ?? t.source.name)!, titleAuto: true } : t)));
      const title = recase(a.title, found.album);
      if (title !== a.title || (!a.artist && found.artist)) updateAlbum(a.id, { title, artist: a.artist ?? tidyName(found.artist) });
      toast.success(
        names.size ? `${names.size === 1 ? 'Ein Titelname' : `${names.size} Titelnamen`} gefunden` : title !== a.title ? 'Schreibweise korrigiert' : 'Album gefunden',
        `Von ${found.source}. ${names.size ? 'Sie stehen als „automatisch erkannt“ in der Liste. Stimmt einer nicht, ändere ihn einfach.' : title !== a.title ? `Das Album heißt jetzt „${title}“.` : 'Die Namen passen schon.'}`,
      );
    } catch (e) {
      if (c.signal.aborted || isAbortError(e)) return;
      toast.error('Suche hat nicht geklappt', lookupFailureMessage(e));
    } finally {
      if (ctrl.current === c) setBusy(false);
    }
  };

  return (
    <div class="import-note" style={{ flexWrap: 'wrap' }}>
      <Search size={17} />
      <span style={{ flex: '1 1 260px' }}>
        {nameless
          ? `${nameless === a.tracks.length ? 'Die Titel haben' : nameless === 1 ? 'Ein Titel hat' : `${nameless} Titel haben`} keinen Namen. Ich kann bei iTunes und MusicBrainz nach dem Album suchen und die Namen übernehmen, wenn Anzahl und Längen passen.`
          : 'Der Name sieht aus, als hätte ein Programm jedes Wort großgeschrieben. Ich kann bei iTunes und MusicBrainz nachsehen, wie das Album richtig heißt.'}
      </span>
      <Button size="sm" icon={Search} onClick={run} disabled={busy}>
        {busy ? 'Sucht …' : 'Im Internet suchen'}
      </Button>
    </div>
  );
}
