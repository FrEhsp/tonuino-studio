/**
 * A whole album in one file on "Hinzufügen" (TODO 0.4 #52). The album card
 * offers to cut the file where its tracks begin: from a cue sheet beside
 * it, or from the same album at iTunes or MusicBrainz whose lengths add up
 * to the file's. With "Fehlende Cover selbst suchen" on, the shops are asked
 * on their own (that setting is the consent to ask them), else on a click.
 * Before anything is cut, a small list shows where each track begins; each
 * cut can be heard and moved a little. Without a match nothing changes:
 * long files are cut at pauses as before.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronLeft, ChevronRight, Pause, Play, Scissors, Search } from 'lucide-preact';
import { blobOfRange, frameAtTime, scanMp3, type Mp3Index } from '../../core/audio';
import { albumCutsOf, cutsForStarts, kindOfAlbum, NUDGE_SEC, nudgeCut, SEARCH_SEC, shopSearchSec, startsFromLengths, wholeAlbumCandidate, wholeAlbumQueries } from '../../core/library/albumcut';
import { cleanDownloadName } from '../../core/library/releasename';
import type { ContentKind } from '../../core/tonuino/catalog';
import { hasAlbumCuts, isPlayableAsIs, type DraftTrack } from '../../core/library/grouping';
import { mimeTypeOf } from '../../core/library/tags';
import { recase, tidyName } from '../../core/library/tidy';
import { lookupCoverAlbum, lookupWholeAlbum, tracksTotal } from '../../core/library/tracklookup';
import { lookupFailureMessage, OFFLINE_MESSAGE } from '../../core/stickers/bulkcover';
import { isAbortError } from '../../core/stickers/image';
import { plat, settings } from '../../app/state';
import { formatDuration } from '../../app/format';
import { Button, Callout, IconButton, Progress } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast } from '../../ui/components/Toast';
import { WrapInput } from '../../ui/components/WrapInput';
import { useListen } from '../../ui/useListen';
import { coverFetch } from '../box/CoverSearch';
import { session, updateAlbum, updateTracks, type ImportAlbum } from './session';
import { cueFor, measuredOf, rememberMeasured, setShopAnswer, shopAnswers } from './wholeAlbum';

/** What the dialog starts from: names and where the tracks begin (the first at 0). */
interface CutSource {
  from: string;
  /** The album's name as the list gives it, its artist, and its kind when the shop tells (Hörspiel, Kinderlieder …). */
  album?: string;
  artist?: string;
  kind?: ContentKind;
  titles: string[];
  starts: number[];
  /** True when the starts are cuts made before (looked at again): they stay as they are. */
  final?: boolean;
  searchSec: number;
}

/** The one file of an album that may be a whole album, when it is not cut at its tracks yet. */
function offerTrack(a: ImportAlbum): DraftTrack | undefined {
  if (a.unchanged || a.tracks.length !== 1) return undefined;
  const t = a.tracks[0];
  if (a.resume?.parts.has(t.source)) return undefined;
  if (a.split === 'tracks' && hasAlbumCuts(t)) return undefined;
  // An audiobook with chapters is cut at them already.
  if ((t.info?.chapters?.length ?? 0) > 1) return undefined;
  return cueFor(t.source) || wholeAlbumCandidate(a.tracks) ? t : undefined;
}

/** The note on the album card, in its own block: what was found, the question whether to look, or that nothing was found. */
export function AlbumCutNote({ album: a }: { album: ImportAlbum }) {
  const t = offerTrack(a);
  const answer = t ? shopAnswers.value.get(t.source) : undefined;
  const [dialog, setDialog] = useState<CutSource | null>(null);
  // The search field after nothing was found: what was looked for, until someone types.
  const [typed, setTyped] = useState<string | null>(null);
  const cue = t ? cueFor(t.source) : undefined;
  const auto = settings.value.findCovers;
  const hit = a.coverFrom?.hit;
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  /** Looks for the track list: the album of the chosen cover, then by name (or by `text` typed in the search field). */
  const search = async (byClick: boolean, text?: string) => {
    if (!t?.info?.durationSec) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (byClick) toast.error('Suche geht gerade nicht', OFFLINE_MESSAGE);
      return;
    }
    ctrl.current?.abort();
    const c = (ctrl.current = new AbortController());
    const total = t.info.durationSec;
    const opts = { fetchFn: coverFetch, signal: c.signal };
    setShopAnswer(t.source, { state: 'searching', query: text });
    try {
      const queries = text !== undefined ? [{ album: text }] : wholeAlbumQueries(a.title, t.title, a.artist);
      let found = null;
      // The cover found the album already (the search for pictures is less strict about names): its track list first.
      if (hit && text === undefined) found = await lookupCoverAlbum(hit, total, opts).catch((e: unknown) => (c.signal.aborted ? Promise.reject(e) : null));
      for (const q of found ? [] : queries) {
        found = await lookupWholeAlbum({ ...q, totalSec: total }, opts);
        if (found) break;
      }
      setShopAnswer(t.source, found ? { state: 'found', album: found } : { state: 'none', query: text ?? shownQuery(queries[0]), tried: hit?.id });
      if (!found) setTyped(null);
    } catch (e) {
      if (c.signal.aborted || isAbortError(e)) {
        setShopAnswer(t.source, undefined);
        return;
      }
      setShopAnswer(t.source, { state: 'failed', tried: hit?.id });
      if (byClick) toast.error('Suche hat nicht geklappt', lookupFailureMessage(e));
    }
  };

  // With the consent of "Fehlende Cover selbst suchen", one look per file, on its own. A cover chosen from the online
  // search names the album already (its shop was asked about it a moment ago): one look at its track list.
  useEffect(() => {
    if (!t || cue || answer?.state === 'searching' || answer?.state === 'found') return;
    const newHit = !!hit && (answer?.state === 'none' || answer?.state === 'failed') && answer.tried !== hit.id;
    if ((auto && !answer) || (hit && !answer) || newHit) void search(false);
  }, [t?.source, auto, hit?.id]);

  if (!t) return null;
  const total = t.info?.durationSec ?? 0;
  const open = (src: CutSource) => setDialog(src);
  let text: string;
  let action: { label: string; run: () => void; busy?: boolean; icon: typeof Scissors };
  if (cue) {
    const n = cue.tracks.length;
    text = `Neben der Datei liegt eine Cue-Datei mit ${n} Titeln. Ich kann die Datei genau dort teilen, wo die Titel anfangen.`;
    action = {
      label: 'An den Titeln teilen',
      icon: Scissors,
      run: () =>
        open({
          from: 'Cue-Datei',
          album: cue.sheet.title,
          artist: cue.sheet.performer,
          titles: cue.tracks.map((x, i) => x.title ?? `Titel ${i + 1}`),
          starts: [0, ...cue.tracks.slice(1).map((x) => x.startSec)],
          searchSec: SEARCH_SEC.cue,
        }),
    };
  } else if (answer?.state === 'found') {
    const found = answer.album;
    const off = Math.round(Math.abs(total - (tracksTotal(found.tracks) ?? total)));
    const name = `„${found.album}“${found.artist ? ` von ${found.artist}` : ''}`;
    const length = off <= 2 ? 'genau so lang sind' : `fast genau so lang sind (${formatDuration(off, { long: true })} Unterschied)`;
    text = `Das sieht nach ${name} in einer Datei aus. Bei ${found.source} hat es ${found.tracks.length} Titel, die zusammen ${length}. Ich kann die Datei an den Titeln teilen.`;
    action = {
      label: 'An den Titeln teilen',
      icon: Scissors,
      run: () =>
        open({
          from: found.source,
          album: found.album,
          artist: found.artist,
          kind: kindOfAlbum(found),
          titles: found.tracks.map((x) => x.title),
          starts: startsFromLengths(found.tracks, total),
          searchSec: shopSearchSec(found.tracks, total),
        }),
    };
  } else if (answer?.state === 'none' || (answer?.state === 'searching' && answer.query !== undefined)) {
    // The field stays while what was typed is looked for.
    return (
      <div class="import-notes">
        <NotFoundNote
          query={typed ?? answer.query ?? ''}
          busy={answer.state === 'searching'}
          length={total}
          onQuery={setTyped}
          onSearch={(q) => {
            if (q.trim()) void search(true, q.trim());
          }}
        />
      </div>
    );
  } else if ((auto || hit) && (answer?.state === 'searching' || !answer)) {
    // Still looking on its own: no word yet.
    return null;
  } else {
    text = 'Ist das ein ganzes Album in einer Datei? Dann kann ich bei iTunes und MusicBrainz nachsehen, wie lang die einzelnen Titel sind, und die Datei genau dazwischen teilen.';
    action = { label: answer?.state === 'searching' ? 'Sucht …' : 'Titel suchen', icon: Search, busy: answer?.state === 'searching', run: () => void search(true) };
  }
  return (
    <div class="import-notes">
      <div class="import-note" style={{ flexWrap: 'wrap' }}>
        <Scissors size={17} />
        <span style={{ flex: '1 1 260px' }}>{text}</span>
        <Button size="sm" icon={action.icon} onClick={action.run} disabled={action.busy}>
          {action.label}
        </Button>
      </div>
      {dialog ? <AlbumCutDialog album={a} track={t} source={dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

/** What was looked for, as the person would write it: "Bibi & Tina – Das Kürbisfest (Folge 50)". */
function shownQuery(q: { album: string; artist?: string } | undefined): string {
  return q ? [q.artist, q.album].filter(Boolean).join(' – ') : '';
}

/**
 * Nothing found for a long file (TODO 0.5 #81): says so in a line, and
 * offers a field to look again under another name. Without it, the file is
 * cut as the box below says (at pauses, or not at all).
 */
export function NotFoundNote({ query, length, busy, onQuery, onSearch }: { query: string; length: number; busy?: boolean; onQuery: (q: string) => void; onSearch: (q: string) => void }) {
  return (
    <div class="import-note album-search-note">
      <Search size={17} />
      <div class="stack tight grow" style={{ minWidth: 0 }}>
        <span>
          Keine Titelliste gefunden, die zusammen so lang ist wie die Datei ({formatDuration(length, { long: true })}). Heißt das Album im Laden anders? Dann suche hier danach:
        </span>
        <form
          class="row album-search-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSearch(query);
          }}
        >
          <input class="input grow" value={query} onInput={(e) => onQuery(e.currentTarget.value)} placeholder="z. B. Bibi und Tina Folge 50" aria-label="Name des Albums" />
          <Button size="sm" type="submit" icon={Search} loading={busy}>
            Suchen
          </Button>
        </form>
      </div>
    </div>
  );
}

/** "Schnitte ansehen" for an album cut at its tracks already. */
export function AlbumCutsButton({ album: a, track: t }: { album: ImportAlbum; track: DraftTrack }) {
  const [open, setOpen] = useState(false);
  const cuts = t.albumCuts;
  if (!cuts) return null;
  return (
    <>
      <Button size="sm" icon={Scissors} class="import-problem-action" onClick={() => setOpen(true)}>
        Schnitte ansehen
      </Button>
      {open ? (
        <AlbumCutDialog
          album={a}
          track={t}
          source={{ from: cuts.from, titles: cuts.tracks.map((x) => x.title), starts: cuts.tracks.map((x) => x.startSec), final: true, searchSec: 0 }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** "3:14,5": minutes, seconds and tenths, so a nudge of half a second shows. */
function cutTime(sec: number): string {
  const tenths = Math.round(sec * 10);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')},${tenths % 10}`;
}

/** Listening into a cut starts this long before it, and goes on this long after it. */
const LEAD_IN_SEC = 3;
const LISTEN_SEC = 6;

function AlbumCutDialog({ album: a, track: t, source, onClose }: { album: ImportAlbum; track: DraftTrack; source: CutSource; onClose: () => void }) {
  const total = t.info?.durationSec ?? 0;
  const [titles, setTitles] = useState(source.titles);
  /** Cut times, one fewer than titles; null while the file is measured. */
  const [times, setTimes] = useState<number[] | null>(source.final ? source.starts.slice(1) : null);
  const [missed, setMissed] = useState<boolean[]>([]);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const { toggle, stop, isPlaying } = useListen();
  const frames = useRef<Promise<Mp3Index> | null>(null);

  useEffect(() => {
    if (source.final) return;
    const c = new AbortController();
    (async () => {
      try {
        let analysis = measuredOf(t.source);
        if (!analysis) {
          analysis = await plat().audio.analyze(t.source, setProgress, c.signal);
          rememberMeasured(t.source, analysis);
        }
        if (c.signal.aborted) return;
        const cuts = cutsForStarts(source.starts, analysis, source.searchSec);
        if (cuts.length !== source.titles.length - 1) {
          setFailed('Die Titel passen nicht in die Datei. Sie wird geteilt wie bisher.');
          return;
        }
        setTimes(cuts.map((x) => x.timeSec));
        setMissed(cuts.map((x) => x.kind !== 'pause'));
      } catch (e) {
        if (c.signal.aborted || isAbortError(e)) return;
        setFailed(`Die Datei lässt sich nicht anhören. ${e instanceof Error ? e.message : ''}`.trim());
      }
    })();
    return () => c.abort();
  }, []);

  const whole = async () => t.source.blob ?? new Blob([(await t.source.read(0, t.source.size)) as BlobPart], { type: mimeTypeOf(t.source.name) ?? 'audio/mpeg' });
  /**
   * An MP3 plays from a few seconds of its frames around the cut: WebKitGTK
   * sometimes knows only a sliver of a long file when it starts and cannot
   * jump far into it. Other formats play whole from a little before the cut.
   */
  const listen = (i: number, at: number) => {
    const from = Math.max(0, at - LEAD_IN_SEC);
    if (!isPlayableAsIs(t)) return toggle(`cut-${i}-${at}`, whole, { name: t.source.name, durationSec: total, startSec: from });
    return toggle(
      `cut-${i}-${at}`,
      async () => {
        const index = await (frames.current ??= scanMp3(t.source).catch((e: unknown) => {
          frames.current = null;
          throw e;
        }));
        const f0 = frameAtTime(index, from);
        const f1 = frameAtTime(index, at + LISTEN_SEC);
        const end = f1 < index.frameCount ? index.frameOffsets[f1] : index.audioEnd;
        return new Blob([await blobOfRange(t.source, index.frameOffsets[Math.min(f0, index.frameCount - 1)], end)], { type: 'audio/mpeg' });
      },
      { name: 'Ausschnitt.mp3' },
    );
  };

  const apply = () => {
    if (!times) return;
    stop();
    const cuts = albumCutsOf(source.from, titles, times);
    updateTracks(a.id, (list) => list.map((x) => (x.source === t.source ? { ...x, albumCuts: cuts } : x)));
    const now = session.value.albums.find((x) => x.id === a.id);
    if (now && !source.final) {
      // The name the list gives the album, when it had only a folder or file name ("Apfelbaum",
      // "Die Apfelbaum-Band - Lieder vom Apfelbaum"); a name from the tags only gets the list's spelling.
      // A name with leftovers of a video site ("… | HÖRSPIEL DES MONATS OKTOBER [Xq7Lm2Pz9Rt]") gives way too.
      const named = tidyName(source.album);
      const leftovers = cleanDownloadName(now.title) !== now.title.trim();
      const title = named && (!tidyName(t.info?.album) || leftovers) ? named : recase(now.title, named);
      updateAlbum(a.id, { split: 'tracks', title, artist: now.artist ?? tidyName(source.artist), kind: source.kind ?? now.kind });
    } else {
      updateAlbum(a.id, { split: 'tracks' });
    }
    onClose();
  };

  const starts = times ? [0, ...times] : [];
  return (
    <Dialog
      title="An den Titeln teilen"
      width="wide"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" icon={Scissors} onClick={apply} disabled={!times}>
            So teilen
          </Button>
        </>
      }
    >
      <div class="stack">
        {failed ? (
          <Callout tone="warning">{failed}</Callout>
        ) : !times ? (
          <div class="stack tight">
            <span>Ich hör mir die Datei einmal ganz an und suche die Pausen zwischen den Titeln.</span>
            <Progress value={progress} label="Sucht die Pausen" />
          </div>
        ) : (
          <>
            <span class="small">
              Hier fängt jeder Titel an{source.final ? '' : '. Jeder Schnitt liegt in der Pause davor'}. Höre kurz rein und schiebe einen Schnitt ein Stück, wenn er nicht sitzt. Die Liste kommt von {source.from === 'Cue-Datei' ? 'der Cue-Datei' : source.from}.
            </span>
            <div class="list track-list">
              {titles.map((title, i) => {
                const at = starts[i];
                const end = i + 1 < starts.length ? starts[i + 1] : total;
                return (
                  <div class="list-row" key={i}>
                    <span class="mono muted" style={{ width: 26 }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <IconButton
                      label={isPlaying(`cut-${i}-${at}`) ? 'Anhalten' : i ? `In den Schnitt vor Titel ${i + 1} reinhören` : 'Den Anfang anhören'}
                      icon={isPlaying(`cut-${i}-${at}`) ? Pause : Play}
                      size="sm"
                      onClick={() => listen(i, at)}
                    />
                    <div class="grow stack" style={{ gap: 0, minWidth: 0 }}>
                      <WrapInput class="track-title" value={title} label={`Titel ${i + 1}`} onValue={(v) => setTitles(titles.map((x, k) => (k === i ? v : x)))} />
                      <span class="tiny muted" style={{ paddingLeft: 8 }}>
                        ab {cutTime(at)} · {formatDuration(end - at)}
                        {missed[i - 1] ? <span style={{ color: 'var(--warning-text)' }}> · keine Pause gefunden, höre lieber rein</span> : null}
                      </span>
                    </div>
                    {i > 0 ? (
                      <span class="row" style={{ gap: 2, flex: 'none' }}>
                        <IconButton label={`Schnitt vor Titel ${i + 1} früher`} icon={ChevronLeft} size="sm" onClick={() => setTimes(nudgeCut(times, i - 1, -NUDGE_SEC, total))} />
                        <IconButton label={`Schnitt vor Titel ${i + 1} später`} icon={ChevronRight} size="sm" onClick={() => setTimes(nudgeCut(times, i - 1, NUDGE_SEC, total))} />
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
