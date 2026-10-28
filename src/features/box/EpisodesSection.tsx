/**
 * "Folgen in diesem Ordner" on the folder page (extra "Mehr als 99
 * Hörspiele", see core/tonuino/episodes.ts): which tracks belong to which
 * episode, with names and limits to change, and one card "von … bis …" per
 * episode for the list of cards to write, each with a sticker of its own.
 * The episodes come from the names the catalog notes on the tracks, from
 * "Entdecken", or from the album in the files' tags.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ListPlus, Merge, Nfc, Printer, ScanSearch, Split } from 'lucide-preact';
import type { CatalogFolder } from '../../core/tonuino/catalog';
import {
  detectEpisodes,
  episodeCards,
  episodeLabels,
  episodeModeFor,
  episodeModesFor,
  episodeProblems,
  folderRoom,
  mergeWithPrevious,
  moveStart,
  rangeName,
  renameEpisode,
  sameEpisodes,
  splitEpisode,
  splitPoint,
  type Episode,
  type EpisodeTrack,
} from '../../core/tonuino/episodes';
import { modeByCode } from '../../core/tonuino/modes';
import { folderName, MAX_TRACKS } from '../../core/tonuino/sd';
import { Button, Callout, IconButton, Progress } from '../../ui/components/controls';
import { toast, toastError } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { card, profile, revealPicked, selection, updateCatalog } from '../../app/state';
import { plural } from '../../app/format';
import { addExtraCards, extraSelection, extras, newCards, partialDuplicateNote, sameCard } from '../cards/items';
import type { TrackRow } from '../cards/trackTitles';
import { emptyEntry } from './shownRows';
import { readFolderTags } from './tagWrite';

/** The episodes as the catalog knows them: noted names, else the items of "Entdecken". */
function savedTracks(rows: readonly TrackRow[], entry: CatalogFolder | undefined, albums?: Map<string, string>): EpisodeTrack[] {
  const byFile = new Map((entry?.tracks ?? []).map((t) => [t.file.toLowerCase(), t]));
  const origins = new Map((entry?.origins ?? []).map((o) => [o.id, o.title]));
  return rows.map((r) => {
    const t = byFile.get(r.file.toLowerCase());
    return { number: r.number, episode: albums ? undefined : t?.episode, origin: t?.origin ? origins.get(t.origin) : undefined, album: albums?.get(r.file.toLowerCase()) };
  });
}

export function EpisodesSection({ folder, rows, entry }: { folder: number; rows: TrackRow[]; entry: CatalogFolder | undefined }) {
  const name = folderName(folder);
  const title = entry?.title ?? `Ordner ${name}`;
  const saved = useMemo(() => detectEpisodes(savedTracks(rows, entry), title), [rows, entry, title]);
  const [draft, setDraft] = useState<Episode[]>(saved);
  const dirty = !sameEpisodes(draft, saved);
  // A change on the card or in the catalog shows at once, unless something is being edited here.
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setDraft((d) => (dirty && d.length ? d : saved));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const modes = episodeModesFor(profile.value);
  const [mode, setMode] = useState(() => episodeModeFor(entry?.card?.mode ?? 5));
  const last = rows.length ? Math.max(...rows.map((r) => r.number)) : 0;
  const room = folderRoom(last);
  const problems = episodeProblems(draft);
  const cards = episodeCards(folder, draft, mode);
  const fresh = newCards(extras.value, cards);
  const listed = extras.value.filter((x) => x.folder === folder && cards.some((c) => sameCard(c.data, x)));
  const titleAt = (n: number) => rows.find((r) => r.number === n)?.title;

  /** Reads the album of every MP3 on the card and finds the episodes from it. */
  const recognise = async () => {
    const root = card.value?.volume.root;
    if (!root) return;
    setReading({ done: 0, total: rows.length });
    try {
      const dir = await root.dir(name);
      const tags = await readFolderTags(
        dir,
        rows.map((r) => r.file),
        { onProgress: (done) => setReading({ done, total: rows.length }) },
      );
      const albums = new Map([...tags].flatMap(([file, t]) => (t.album?.trim() ? [[file.toLowerCase(), t.album.trim()] as const] : [])));
      if (!albums.size) {
        toast.info('In den Titel-Infos steht kein Album', 'Die Folgen bleiben, wie sie sind. Du kannst sie unten selbst teilen.');
        return;
      }
      const found = detectEpisodes(savedTracks(rows, entry, albums), title);
      setDraft(found);
      toast.success(`${plural(found.length, 'Folge', 'Folgen')} erkannt`, 'Prüfe Namen und Grenzen, dann speichere.');
    } catch (e) {
      toastError('Die Titel-Infos ließen sich nicht lesen', e);
    } finally {
      setReading(null);
    }
  };

  /** Notes the episodes in the catalog, on each of their tracks. */
  const save = async (): Promise<boolean> => {
    const labels = episodeLabels(draft, rows.map((r) => r.number));
    try {
      await updateCatalog(
        (c) => {
          const e = c.folders[name] ?? (c.folders[name] = emptyEntry(folder));
          for (const r of rows) {
            let t = e.tracks.find((x) => x.file.toLowerCase() === r.file.toLowerCase());
            if (!t) e.tracks.push((t = { file: r.file, title: r.title, durationSec: r.durationSec }));
            const label = labels.get(r.number);
            if (label) t.episode = label;
            else delete t.episode;
          }
          e.updatedAt = Date.now();
        },
        { touchFolders: entry ? [] : [folder] },
      );
      // As the catalog has them now: spaces typed twice are gone.
      setDraft(draft.map((e) => ({ ...e, title: e.title.trim().replace(/\s+/g, ' ') })));
      return true;
    } catch (e) {
      toastError('Speichern hat nicht geklappt', e);
      return false;
    }
  };

  const addCards = async () => {
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      await addExtraCards(fresh);
      toast.success(
        fresh.length === 1 ? 'Eine Karte steht jetzt in der Liste' : `${fresh.length} Karten stehen jetzt in der Liste`,
        cards.length > fresh.length ? partialDuplicateNote(cards.length - fresh.length) : 'Beschreibe sie wie die anderen Karten. Jede bekommt ihren eigenen Sticker.',
      );
    } catch (e) {
      toastError('Die Karten ließen sich nicht hinzufügen', e);
    } finally {
      setBusy(false);
    }
  };

  /** Only the cards of the episodes chosen, on the cards page or the sticker page. */
  const open = (page: 'cards' | 'stickers') => {
    selection.value = new Set();
    extraSelection.value = new Set(listed.map((x) => x.id));
    revealPicked.value = page === 'cards';
    navigate({ page });
  };

  return (
    <section class="card pad stack" id="folgen" aria-labelledby="folgen-title">
      <div class="row wrap" style={{ gap: 12 }}>
        <div class="grow stack tight" style={{ minWidth: 220 }}>
          <h2 id="folgen-title">Folgen in diesem Ordner</h2>
          <p class="muted small">
            {plural(draft.length, 'Folge', 'Folgen')} · {room.total} von {MAX_TRACKS} Titeln belegt. Jede Folge bekommt eine Karte, die nur ihre Titel spielt.
          </p>
        </div>
        <Button size="sm" icon={ScanSearch} loading={!!reading} disabled={!rows.length} onClick={() => void recognise()}>
          Aus den Titel-Infos erkennen
        </Button>
      </div>

      {reading ? <Progress value={reading.done} max={Math.max(1, reading.total)} label="Titel-Infos lesen" /> : null}

      {room.state === 'full' || room.state === 'near' ? (
        <Callout tone="warning">
          {room.state === 'full'
            ? `Der Ordner ist voll: ${MAX_TRACKS} Titel sind das Höchste, was die Box in einem Ordner abspielt. Neue Folgen kommen in einen anderen Ordner.`
            : `Der Ordner ist fast voll: Es passen nur noch ${plural(room.free, 'Titel', 'Titel')} hinein. Mehr als ${MAX_TRACKS} spielt die Box nicht ab.`}
        </Callout>
      ) : room.state === 'over' ? (
        <Callout tone="danger">Im Ordner sind mehr als {MAX_TRACKS} Titel. Die Box spielt nur die ersten {MAX_TRACKS}, und keine Karte kann eine höhere Nummer nennen.</Callout>
      ) : null}

      {!rows.length ? (
        <p class="soft small">Im Ordner sind noch keine Titel.</p>
      ) : (
        <ol class="episodes-list">
          {draft.map((e, i) => {
            const before = draft[i - 1];
            const at = splitPoint(e);
            const starts = before ? Array.from({ length: e.last - before.first }, (_, k) => before.first + 1 + k) : [];
            const firstTitle = titleAt(e.first);
            return (
              <li class="episode-row" key={`${i}:${e.first}`}>
                <span class="episode-num" aria-hidden="true">
                  {i + 1}.
                </span>
                <div class="stack tight" style={{ minWidth: 0 }}>
                  <input class="input" value={e.title} aria-label={`Name der Folge ${i + 1}`} placeholder="Name der Folge" onInput={(ev) => setDraft(renameEpisode(draft, i, ev.currentTarget.value))} />
                  {firstTitle ? <span class="tiny muted">beginnt mit „{firstTitle}“</span> : null}
                </div>
                <span class="episode-range small">
                  {before ? (
                    <>
                      Titel
                      <select class="select compact" aria-label={`Folge ${i + 1} beginnt bei Titel`} value={String(e.first)} onChange={(ev) => setDraft(moveStart(draft, i, Number(ev.currentTarget.value)))}>
                        {starts.map((n) => (
                          <option value={String(n)} key={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      bis {e.last}
                    </>
                  ) : (
                    rangeName(e.first, e.last)
                  )}
                </span>
                <span class="episode-actions">
                  <IconButton label={at ? `Folge ${i + 1} bei Titel ${at} teilen` : 'Eine Folge aus einem Titel lässt sich nicht teilen'} icon={Split} size="sm" disabled={!at} onClick={() => at && setDraft(splitEpisode(draft, i, at))} />
                  <IconButton label={before ? `Mit Folge ${i} zusammenlegen` : 'Die erste Folge hat keine davor'} icon={Merge} size="sm" disabled={!before} onClick={() => setDraft(mergeWithPrevious(draft, i))} />
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {problems.length ? (
        <Callout tone="danger">
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </Callout>
      ) : null}

      {dirty ? (
        <div class="row wrap" style={{ gap: 8 }}>
          <Button size="sm" variant="primary" disabled={!!problems.length} onClick={() => void save().then((ok) => ok && toast.success('Folgen gespeichert'))}>
            Folgen speichern
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
            Verwerfen
          </Button>
        </div>
      ) : null}

      {rows.length ? (
        <div class="stack tight">
          <label class="row wrap small" style={{ gap: 8 }}>
            Die Karten spielen ihre Folge als
            <select class="select compact" value={String(mode)} onChange={(e) => setMode(Number(e.currentTarget.value))}>
              {modes.map((m) => (
                <option value={String(m.code)} key={m.code}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <span class="small soft">{modeByCode(mode)?.goodFor}</span>
          <div class="row wrap" style={{ gap: 8, marginTop: 6 }}>
            <Button variant="primary" icon={ListPlus} loading={busy} disabled={!!problems.length || !fresh.length} onClick={() => void addCards()}>
              {fresh.length ? `Karten für alle Folgen (${fresh.length})` : 'Alle Karten stehen in der Liste'}
            </Button>
            {listed.length ? (
              <>
                <Button icon={Nfc} onClick={() => open('cards')}>
                  Karten beschreiben
                </Button>
                <Button icon={Printer} onClick={() => open('stickers')}>
                  Sticker drucken
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
