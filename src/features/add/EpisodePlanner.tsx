/**
 * Extra "Mehr als 99 Hörspiele" on the add page: the albums go onto the end
 * of one folder, one after the other, instead of a folder each. Each album
 * is an episode there; the folder page then makes a card "von … bis …" for
 * every episode. The tracks in the folder keep their numbers, so cards
 * written before stay right. Says how full the folder gets: it holds 255
 * titles at most.
 */
import { useState } from 'preact/hooks';
import { Library, Undo2 } from 'lucide-preact';
import { folderRoom, rangeName } from '../../core/tonuino/episodes';
import { folderName, freeFolderNumbers, MAX_TRACKS } from '../../core/tonuino/sd';
import { Button, Callout } from '../../ui/components/controls';
import { card } from '../../app/state';
import { plural } from '../../app/format';
import { gatherInto, plannedRanges, session, shownTitle, spreadOut, trackCountOf, waitingFolders, type ImportAlbum } from './session';

/** A folder's title in the choice: long ones end in "…". */
function shorten(title: string, max = 30): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

export function EpisodePlanner() {
  const s = card.value;
  const sess = session.value;
  const scan = s?.scan;
  const [choice, setChoice] = useState<number | null>(null);
  if (!scan) return null;
  const albums = sess.albums;
  // Folders that get more than one album, or albums onto what is there: the episodes of this transfer.
  const byFolder = new Map<number, ImportAlbum[]>();
  for (const a of albums) if (a.target) byFolder.set(a.target, [...(byFolder.get(a.target) ?? []), a]);
  const gathered = [...byFolder].filter(([, list]) => list.length > 1 || list.some((a) => a.append));
  const waiting = waitingFolders(scan);
  const existing = scan.folders.filter((f) => !waiting.has(f.number));
  // Albums that would make a folder of their own: these go onto the chosen folder.
  const loose = albums.filter((a) => !a.append && !a.resume && (byFolder.get(a.target)?.length ?? 0) === 1);
  // A new folder: the one the first of them would make anyway, else the first free number; and new folders chosen before.
  const used = new Set(albums.filter((a) => !a.append).map((a) => a.target));
  const free = freeFolderNumbers(scan).find((n) => !waiting.has(n) && !used.has(n));
  const fresh = [...new Set([...gathered.map(([n]) => n).filter((n) => !scan.folders.some((f) => f.number === n)), ...(loose[0]?.target ? [loose[0].target] : free ? [free] : [])])];
  const target = choice ?? gathered[0]?.[0] ?? existing[existing.length - 1]?.number ?? fresh[0] ?? 0;
  const ranges = plannedRanges(sess, scan);
  const titleOf = (n: number) => s?.catalog?.folders[folderName(n)]?.title ?? `Ordner ${folderName(n)}`;

  return (
    <section class="card pad stack episode-planner" aria-labelledby="episode-planner-title">
      <div class="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <span class="split-icon" aria-hidden="true">
          <Library size={18} />
        </span>
        <div class="stack tight grow">
          <h2 id="episode-planner-title" class="episode-planner-title">
            Mehr als 99 Hörspiele
          </h2>
          <span class="small soft">Lege die Alben als Folgen hintereinander in einen Ordner. Jede Folge bekommt danach ihre eigene Karte „von Titel … bis …“. Was schon im Ordner ist, behält seine Nummern.</span>
        </div>
      </div>
      <div class="row wrap" style={{ gap: 10 }}>
        <label class="row small" style={{ gap: 8 }} for="episode-planner-folder">
          In einen vorhandenen Ordner hinten anhängen:
        </label>
        <select id="episode-planner-folder" class="select compact" value={String(target)} onChange={(e) => setChoice(Number(e.currentTarget.value))}>
          {existing.length ? (
            <optgroup label="Vorhandener Ordner">
              {existing.map((f) => (
                <option value={String(f.number)} key={f.number}>
                  {f.name} · {shorten(titleOf(f.number))} ({plural(f.tracks.length, 'Titel', 'Titel')})
                </option>
              ))}
            </optgroup>
          ) : null}
          {fresh.length ? (
            <optgroup label="Oder alle in einen neuen Ordner">
              {fresh.map((n) => (
                <option value={String(n)} key={n}>
                  Ordner {folderName(n)} (neu)
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <Button size="sm" variant="primary" disabled={!target || !loose.length} onClick={() => gatherInto(target)}>
          {loose.length > 1 ? `${loose.length} Alben anhängen` : 'Album anhängen'}
        </Button>
      </div>
      {gathered.map(([folder, list]) => {
        const there = scan.folders.find((f) => f.number === folder);
        const last = there ? Math.max(0, ...there.tracks.map((t) => t.number)) : 0;
        const adding = list.reduce((n, a) => n + trackCountOf(a).count, 0);
        const exact = list.every((a) => trackCountOf(a).exact);
        const room = folderRoom(last, adding);
        return (
          <div class="stack tight episode-plan" key={folder}>
            <div class="row wrap" style={{ gap: 10 }}>
              <strong class="grow">
                Ordner {folderName(folder)}
                {there ? ` „${shorten(titleOf(folder), 40)}“` : ' (neu)'}: {exact ? '' : 'etwa '}
                {room.total} von {MAX_TRACKS} Titeln
              </strong>
              {list.every((a) => !a.resume) ? (
                <Button size="sm" variant="ghost" icon={Undo2} onClick={() => spreadOut(folder)}>
                  Doch eigene Ordner
                </Button>
              ) : null}
            </div>
            <ol class="episode-plan-list small">
              {last ? <li class="muted">Titel 1 bis {last}: schon im Ordner, bleibt so</li> : null}
              {list.map((a) => {
                const r = ranges.get(a.id);
                return r ? (
                  <li key={a.id}>
                    {r.exact ? '' : 'etwa '}
                    {rangeName(r.first, r.last)}: „{a.title.trim() || shownTitle(a)}“
                  </li>
                ) : null;
              })}
            </ol>
            {room.state === 'over' ? (
              <Callout tone="danger">
                So viele Titel passen nicht in einen Ordner: Die Box spielt höchstens {MAX_TRACKS}, und keine Karte kann eine höhere Nummer nennen. Nimm ein Album heraus oder hänge es an einen anderen Ordner.
              </Callout>
            ) : room.state === 'near' || room.state === 'full' ? (
              <Callout tone="warning">
                Ordner {folderName(folder)} ist danach {room.state === 'full' ? 'voll' : 'fast voll'}: {room.free ? `Es passen nur noch ${plural(room.free, 'Titel', 'Titel')} hinein.` : 'Es passt kein Titel mehr hinein.'} Für die nächsten Folgen nimm einen anderen Ordner.
              </Callout>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
