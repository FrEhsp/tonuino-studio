/**
 * „Musik auf die SD-Karte“ (0.6, 06-entwuerfe 2-musik-*): the field to drop
 * music into, which becomes the list of its titles, the folder it goes to
 * as a big number with − and +, and one button that copies. It runs the same
 * import as „Musik genauer hinzufügen“ (session.ts): what is set there (kind,
 * title, cutting, cover) and every case this screen does not show (several
 * albums, problems, the details after a transfer) is one link away and finds
 * the same selection. New titles for a folder that has some go to the place
 * picked here (#126); the list shows the new numbers and the old ones.
 */
import type { ComponentChildren } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Scissors } from 'lucide-preact';
import { AUDIO_EXTENSIONS } from '../../core/library/tags';
import type { DraftTrack } from '../../core/library/grouping';
import { planReorder } from '../../core/tonuino/repair';
import { folderName, freeFolderNumbers, REORDER_DONE_MARKER, type SdFolder } from '../../core/tonuino/sd';
import type { ByteSource } from '../../platform/types';
import { Button, Spinner } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { KisteArt } from '../../ui/components/Art';
import { MenuButton, type MenuItem } from '../../ui/components/Menu';
import { ChoiceList, NumberField, Screen } from '../../ui/components/Schlank';
import { toast, toastError } from '../../ui/components/Toast';
import { useFileDrop } from '../../ui/useFileDrop';
import { PHONE_QUERY, useMedia } from '../../ui/useMedia';
import { formatBytes, formatDuration, plural } from '../../app/format';
import { usePageShown } from '../../app/pageAlive';
import { canChangeCard, chooseCardFolder, packageState, systemSoundsPending } from '../../app/pending';
import { routeToHash } from '../../app/router';
import { card, catalog, plat, platform, runRepair, settings, updateCatalog } from '../../app/state';
import { pickSdCard, SdZeile } from '../../app/Kopf';
import { openPackageDialog } from '../box/PackageDialog';
import { PackageWaitingPage } from '../box/PackageWaitingGate';
import { lazyPage } from '../../app/lazyPage';
import { useTrackRows, type TrackRow } from '../cards/trackTitles';
import { Haken } from '../cards/KarteScreen';
import { freeAfter, insertAt, minutesLeft, minutesLeftText, placedRows } from './musik';
import {
  addSources,
  cancelImport,
  cancelReading,
  foldersWords,
  problems,
  resetImport,
  resultNotes,
  runImport,
  session,
  shownTitle,
  totalBytes,
  trimPendingProblem,
  trackCountOf,
  untrimTrack,
  updateAlbum,
  updateTracks,
  type ImportAlbum,
} from './session';

// The trim editor comes when it is opened, not with the start of the app.
const TrimDialog = lazyPage(() => import('../box/TrimDialog').then((m) => m.TrimDialog));
const TrimPendingDialog = lazyPage(() => import('./TrimPendingDialog').then((m) => m.TrimPendingDialog));
const SoundsDialog = lazyPage(() => import('../box/SoundsDialog').then((m) => m.SoundsDialog));

/** The folder asked for before any file is in (the field shows the next free one until then). */
const wanted = signal<number | null>(null);
/** Where new titles for a folder that has some go: after the first `at` old ones; null at the end (as always). */
const placeAt = signal<number | null>(null);
/** The new titles being put into their place after the transfer, and how that went. */
const placing = signal<{ folder: number; state: 'running' | 'done' | 'failed'; text?: string } | null>(null);

/* ------------------------------------------------------------------ picking files */

function useAddFiles() {
  return (sources: ByteSource[]) => {
    if (!sources.length) return;
    addSources(sources)
      .then((r) => {
        if (r.doubled) toast.info(r.doubled === 1 ? 'Eine Datei war schon ausgewählt' : `${r.doubled} Dateien waren schon ausgewählt`, 'Doppelt nehme ich sie nicht.');
      })
      .catch((e) => toastError('Die Dateien ließen sich nicht lesen', e));
  };
}

async function pick(directory: boolean): Promise<ByteSource[]> {
  try {
    return await plat().pickFiles({ multiple: true, directory, extensions: directory ? undefined : [...AUDIO_EXTENSIONS, 'jpg', 'jpeg', 'png', 'zip', 'cue'] });
  } catch (e) {
    toastError('Auswählen hat nicht geklappt', e);
    return [];
  }
}

/* ------------------------------------------------------------------ the new titles into their place (#126) */

/**
 * After the transfer: the new titles are at the end of the folder, as the
 * import puts them; they move to their place the way the folder page saves
 * a new order. Cards for single titles follow their titles.
 */
async function placeNewTitles(folder: number, oldMax: number, at: number) {
  const r = session.value.result;
  const later = 'Die neuen Titel stehen jetzt hinten. Die Stelle kannst du auf der Seite des Ordners ändern.';
  if (!r || !r.folders.includes(folder) || r.cancelled || r.partial?.folder === folder) {
    if (r?.folders.includes(folder)) placing.value = { folder, state: 'failed', text: later };
    return;
  }
  const scan = card.value?.scan;
  const f = scan?.folders.find((x) => x.number === folder);
  if (!scan || !f) return;
  const sorted = [...f.tracks].sort((a, b) => a.number - b.number);
  const list = insertAt(
    sorted.filter((t) => t.number <= oldMax).map((t) => t.name),
    sorted.filter((t) => t.number > oldMax).map((t) => t.name),
    at,
  );
  if (!list) return;
  const plan = planReorder(f, list, { pureNumbers: settings.value.pureNumbers, tempDirs: scan.tempDirs });
  if (plan.leftovers.length) {
    placing.value = { folder, state: 'failed', text: `${later} ${plan.leftovers[0]}` };
    return;
  }
  placing.value = { folder, state: 'running' };
  try {
    const run = await runRepair(plan, { kind: 'order', folders: () => [folder] });
    let moved: string[] = [];
    // The new numbers count once the folder was made again (planReorder): from then on the cards follow.
    if (run.done.some((x) => x.op === 'mkdir' && x.path[1] === REORDER_DONE_MARKER)) {
      // Loaded here: the packing code (pack.ts) is not needed for the start.
      const { remapCards } = await import('../../core/tonuino/pack');
      await updateCatalog((c) => {
        moved = remapCards(c, folder, list);
      });
    }
    if (run.result.error) placing.value = { folder, state: 'failed', text: `${later} ${run.result.error.message}` };
    else placing.value = { folder, state: 'done', text: moved.length ? `${plural(moved.length, 'Karte für einen einzelnen Titel spielt', 'Karten für einzelne Titel spielen')} jetzt eine andere Nummer. Schreibe sie neu.` : undefined };
  } catch (e) {
    placing.value = { folder, state: 'failed', text: `${later} ${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ------------------------------------------------------------------ the screen */

export function MusikScreen() {
  const s = card.value;
  const sess = session.value;
  const phone = useMedia(PHONE_QUERY);
  const shown = usePageShown();
  const wasShown = useRef(shown);
  // Back on the screen after a transfer that went well: a fresh start, as on „Musik genauer hinzufügen“.
  useEffect(() => {
    const back = shown && !wasShown.current;
    wasShown.current = shown;
    const r = sess.result;
    if (back && sess.phase === 'done' && r && !r.rest.length && !r.error && placing.value?.state !== 'running') {
      resetImport();
      placing.value = null;
    }
  }, [shown]);

  const top = phone ? <SdZeile /> : undefined;
  if (!s || s.status !== 'ready' || !s.scan) return <NoCard top={top} />;
  if (!canChangeCard() && (sess.phase === 'pick' || sess.phase === 'reading' || sess.phase === 'review')) return <PackageWaitingPage />;
  return <Working top={top} />;
}

/** Without a card: where it goes, and the button to pick or read it. */
function NoCard({ top }: { top?: ComponentChildren }) {
  const caps = platform.value?.capabilities;
  const reads = !caps?.sd && caps?.sdPackage;
  const auto = caps?.sdAutoDetect;
  // A phone, a tablet or a browser without any way to the card: say where it works (as Meine Box does).
  const never = !!caps && !caps.sd && !caps.sdPackage;
  return (
    <Screen
      name="musik"
      title="Musik auf die SD-Karte"
      help={routeToHash({ page: 'help', topic: 'musik' })}
      top={top}
      big={
        <div class="ablage leer">
          {/* The Android app reads the card through a card reader; the browser on a phone cannot (Prüfrunde 1, eltern B13). */}
          <p class="gross-satz">{never ? (platform.value?.handheld ? 'Im Browser am Handy geht die SD-Karte nicht.' : 'Dieser Browser kann keine SD-Karte lesen.') : 'Zuerst die SD-Karte.'}</p>
          <p>
            {never
              ? platform.value?.handheld
                ? 'Nimm am Computer Firefox, Chrome, Edge oder Safari. Am Android-Handy geht es mit der Android-App und einem SD-Kartenleser.'
                : 'Nimm am Computer Firefox, Chrome, Edge oder Safari. Mit der Desktop-App für Windows und Linux geht es auch.'
              : reads
                ? 'Lies die SD-Karte der Box ein. Danach ziehst du Hörspiele und Musik hier hinein.'
                : auto
                  ? 'Stecke die SD-Karte der Box ein. Ich finde sie von selbst.'
                  : 'Stecke die SD-Karte der Box ein und wähle sie aus.'}
          </p>
          {never ? (
            <div class="knopfzeile">
              <a class="btn lg" href={routeToHash({ page: 'help', topic: 'browser' })}>
                Welche Möglichkeiten habe ich?
              </a>
            </div>
          ) : auto && !reads ? null : (
            <div class="knopfzeile">
              <Button size="lg" onClick={() => void (reads ? chooseCardFolder('card') : pickSdCard())}>
                {reads ? 'SD-Karte einlesen …' : 'SD-Karte auswählen …'}
              </Button>
            </div>
          )}
          <div class="kiste nur-rechner">
            <KisteArt width={300} />
          </div>
        </div>
      }
      foot={
        never ? undefined : (
          <Button variant="primary" class="xl wide" disabled>
            Auf die SD-Karte kopieren
          </Button>
        )
      }
    />
  );
}

function Working({ top }: { top?: ComponentChildren }) {
  const s = card.value!;
  const scan = s.scan!;
  const sess = session.value;
  const add = useAddFiles();
  const { over, handlers } = useFileDrop(add);
  const packaged = s.volume.access === 'snapshot';
  const albums = sess.albums;
  const single = albums.length === 1 ? albums[0] : undefined;
  const free = freeFolderNumbers(scan);
  const target = single?.target || wanted.value || free[0] || 1;
  const existing = scan.folders.find((f) => f.number === target);
  const entry = catalog.value?.folders[folderName(target)];
  const appending = !!existing && (!single || single.append);
  const oldRows = useTrackRows(appending && sess.phase !== 'done' ? existing : undefined, entry);
  const reading = sess.phase === 'reading' ? (sess.reading ?? { done: 0, total: 0 }) : undefined;
  const found = sess.phase === 'review' || sess.phase === 'reading' ? problems(sess, scan) : [];
  const bytes = totalBytes(sess);
  const room = s.info.freeBytes;
  const tooBig = room !== undefined && bytes > room;
  const [trim, setTrim] = useState<{ folder: number; rows: TrackRow[]; file: string } | null>(null);
  /** „Zuschneiden …“ of a title still to be copied. */
  const [trimNew, setTrimNew] = useState<{ albumId: string; source: ByteSource } | null>(null);

  // A number picked before the files came in counts for them.
  useEffect(() => {
    const w = wanted.value;
    if (single && w && single.target !== w && !sess.forFolder && sess.phase === 'review') updateAlbum(single.id, { target: w, append: scan.folders.some((f) => f.number === w) });
  }, [single?.id]);

  const setFolder = (n: number) => {
    wanted.value = n;
    placeAt.value = null;
    if (single && sess.phase === 'review') updateAlbum(single.id, { target: n, append: scan.folders.some((f) => f.number === n) });
  };

  const copy = async () => {
    // Where the new titles go, fixed now: the list may change while they are copied.
    const place = single && single.append && existing && placeAt.value !== null ? { folder: target, oldMax: Math.max(0, ...existing.tracks.map((t) => t.number)), at: placeAt.value } : null;
    placing.value = null;
    try {
      await runImport();
    } catch (e) {
      toastError(packaged ? 'Das Vorbereiten hat nicht geklappt' : 'Die Übertragung ist fehlgeschlagen', e);
      return;
    }
    if (place) await placeNewTitles(place.folder, place.oldMax, place.at);
  };

  const writing = sess.phase === 'writing';
  const done = sess.phase === 'done';
  const nothingYet = !albums.length;

  let big;
  if (done) big = <DoneList onTrim={setTrim} />;
  else if (nothingYet && reading) big = <Reading done={reading.done} total={reading.total} />;
  else if (nothingYet) big = <Empty over={over} add={add} />;
  else if (single) big = <Titles album={single} oldRows={appending ? oldRows : []} at={appending ? placeAt.value : null} add={add} over={over} onTrim={(file) => existing && setTrim({ folder: target, rows: oldRows, file })} onTrimNew={(t) => setTrimNew({ albumId: single.id, source: t.source })} />;
  else big = <Albums albums={albums} add={add} over={over} />;

  return (
    <>
      <Screen
        name="musik"
        title="Musik auf die SD-Karte"
        help={routeToHash({ page: 'help', topic: 'musik' })}
        top={top}
        big={big}
        handlers={handlers}
        foot={
          done ? (
            <DoneFoot />
          ) : writing ? (
            <Progressing />
          ) : (
            <>
              {found.length ? (
                <p class="zeile-warn">
                  {found[0].text}{' '}
                  <a href={routeToHash({ page: 'add' })}>Genauer einstellen …</a>
                </p>
              ) : tooBig ? (
                <p class="zeile-warn">Auf der Karte sind nur noch {formatBytes(room ?? 0)} frei.</p>
              ) : !nothingYet ? (
                <p class="zeile-klein">{needLine(albums, appending, bytes, room)}</p>
              ) : null}
              <Button variant="primary" class="xl wide" disabled={nothingYet || !!found.length || tooBig || !!reading || sess.phase !== 'review'} onClick={() => void copy()}>
                {packaged ? 'Ins Paket für die Karte' : 'Auf die SD-Karte kopieren'}
              </Button>
            </>
          )
        }
      >
        {done ? <DoneQuestions /> : single || nothingYet ? <FolderQuestion target={target} existing={existing} title={entry?.title} free={free} files={!nothingYet} disabled={writing} onChange={setFolder} /> : <ManyQuestion albums={albums} />}
        {!done && !writing && appending && (single || nothingYet) && existing ? <PlaceQuestion rows={oldRows} /> : null}
        {!done && !nothingYet && !writing ? (
          <a class="link-button mehr-link" href={routeToHash({ page: 'add' })}>
            Genauer einstellen …
          </a>
        ) : null}
        {writing ? null : <SoundsMissing />}
        {!done && sess.rejected.length && !writing ? (
          <p class="zeile-klein">
            {plural(sess.rejected.filter((r) => !r.web).length || sess.rejected.length, 'Datei kommt', 'Dateien kommen')} nicht mit. Warum, steht unter „Genauer einstellen …“.
          </p>
        ) : null}
      </Screen>
      {trim ? <TrimDialog folder={trim.folder} rows={trim.rows} file={trim.file} beforeSave={() => undefined} onClose={() => setTrim(null)} /> : null}
      {trimNew ? <TrimPendingDialog albumId={trimNew.albumId} source={trimNew.source} onClose={() => setTrimNew(null)} /> : null}
    </>
  );
}

/** „Braucht etwa 260 MB, frei sind 21,2 GB.“, or for new titles of a folder „1 neuer Titel, 0:48“. */
function needLine(albums: ImportAlbum[], appending: boolean, bytes: number, room: number | undefined): string {
  if (appending && albums.length === 1) {
    const a = albums[0];
    const sec = a.tracks.reduce((n, t) => n + (t.info?.durationSec ?? 0), 0);
    return `${plural(trackCountOf(a).count, 'neuer Titel', 'neue Titel')}${sec ? `, ${formatDuration(sec)}` : ''}`;
  }
  return room !== undefined ? `Braucht etwa ${formatBytes(bytes)}, frei sind ${formatBytes(room)}.` : `Braucht etwa ${formatBytes(bytes)}.`;
}

/* ------------------------------------------------------------------ the questions on the right */

function FolderQuestion({ target, existing, title, free, files, disabled, onChange }: { target: number; existing?: SdFolder; title?: string; free: number[]; files: boolean; disabled: boolean; onChange: (n: number) => void }) {
  const left = freeAfter(free, target);
  return (
    <div class="frage">
      <h2>Kommt in Ordner</h2>
      <NumberField value={target} onChange={onChange} label="Kommt in Ordner" disabled={disabled} />
      <p class="satz">
        {existing ? (
          <>Ordner {target} ist „{title || `Ordner ${folderName(target)}`}“ mit {plural(existing.tracks.length, 'Titel', 'Titeln')}.</>
        ) : !free.length ? (
          'Alle 99 Ordner sind belegt.'
        ) : (
          <>
            Ordner {target} ist noch frei. {files ? <span class="muted">{left ? `Danach sind noch ${left} frei.` : 'Danach ist keiner mehr frei.'}</span> : null}
          </>
        )}
      </p>
    </div>
  );
}

/** „An welcher Stelle?“ for a folder that has titles already (#126). */
function PlaceQuestion({ rows }: { rows: TrackRow[] }) {
  const at = placeAt.value;
  const n = rows.length;
  const phone = useMedia(PHONE_QUERY);
  const [open, setOpen] = useState(false);
  if (!n) return null;
  const middle = at !== null && at > 0 && at < n ? at : Math.min(n - 1, Math.max(1, Math.ceil(n / 2)));
  const value = at === null || at >= n ? 'hinten' : at === 0 ? 'vorne' : 'nach';
  const list = (
    <ChoiceList
      label="An welcher Stelle?"
      value={value}
      onChange={(v) => (placeAt.value = v === 'vorne' ? 0 : v === 'nach' ? middle : null)}
      choices={[
        { value: 'vorne', name: 'Ganz vorne' },
        ...(n > 1
          ? [
              {
                value: 'nach' as const,
                name: 'Nach',
                extra: (
                  <select class="stelle-wahl" aria-label="Nach welchem Titel" value={String(middle)} onChange={(e) => (placeAt.value = Number((e.target as HTMLSelectElement).value))}>
                    {rows.slice(0, -1).map((r, i) => (
                      <option key={r.file} value={String(i + 1)}>
                        {String(i + 1).padStart(3, '0')} {r.title}
                      </option>
                    ))}
                  </select>
                ),
              },
            ]
          : []),
        { value: 'hinten', name: 'Ganz hinten' },
      ]}
    />
  );
  const note = <p class="ruhig">Nichts wird überschrieben. Die anderen rücken eins nach.</p>;
  // On a phone one line, like the summary of „Sticker drucken“: the list of titles stays the big thing (Prüfrunde 1 Aussehen 10).
  if (phone) {
    const where = value === 'vorne' ? 'Kommt ganz vorne hin' : value === 'nach' ? `Kommt nach Titel ${String(middle).padStart(3, '0')}` : 'Kommt ganz hinten dran';
    return (
      <div class="frage">
        <p class="wert-zeile">
          <b>{where}</b>
          <button type="button" class="link-button" onClick={() => setOpen(true)}>
            ändern
          </button>
        </p>
        {open ? (
          <Dialog
            title="An welcher Stelle?"
            onClose={() => setOpen(false)}
            footer={
              <Button variant="primary" onClick={() => setOpen(false)}>
                Fertig
              </Button>
            }
          >
            <div class="schirm-fragen">
              {list}
              {note}
            </div>
          </Dialog>
        ) : null}
      </div>
    );
  }
  return (
    <div class="frage">
      <h2>An welcher Stelle?</h2>
      {list}
      {note}
    </div>
  );
}

/** Several albums: each gets a folder of its own; the details are on „Musik genauer hinzufügen“. */
function ManyQuestion({ albums }: { albums: ImportAlbum[] }) {
  const targets = [...new Set(albums.map((a) => a.target).filter(Boolean))].sort((a, b) => a - b);
  return (
    <div class="frage">
      <h2>Kommt in Ordner</h2>
      <p class="satz">
        {plural(albums.length, 'Album', 'Alben')}, jedes in einen eigenen Ordner: {foldersWords(targets)}.
      </p>
    </div>
  );
}

/**
 * A new card without the folders mp3 and advert: the box would stay silent,
 * also when a card is put on (Prüfrunde 1 B1). Said here, where a new card
 * gets its first music, with the button that puts the announcements on.
 */
function SoundsMissing() {
  const [open, setOpen] = useState(false);
  const missing = !!card.value?.report?.issues.some((i) => i.id === 'system-missing') && !systemSoundsPending.value;
  if (!missing && !open) return null;
  return (
    <div class="frage ansagen-fehlen">
      <h2>Die Box braucht noch ihre Ansagen</h2>
      <p class="satz">Auf der Karte fehlen die Ansagen. Ohne sie sagt die Box nichts, auch nicht „Oh, eine neue Karte!“.</p>
      <div class="knopfzeile">
        <Button onClick={() => setOpen(true)}>Ansagen mit draufkopieren …</Button>
      </div>
      {open && card.value ? <SoundsDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ the field on the left */

function Empty({ over, add }: { over: boolean; add: (s: ByteSource[]) => void }) {
  const handheld = !!platform.value?.handheld;
  const wide = useMedia('(min-width: 1800px)');
  return (
    <div class={`ablage leer ${over ? 'over' : ''}`}>
      <p class="gross-satz">{handheld ? 'Suche ein Hörspiel oder Musik aus.' : 'Ziehe ein Hörspiel oder Musik hier hinein.'}</p>
      <p>Einzelne Dateien oder ganze Ordner, MP3, M4A, FLAC, WAV. Was nicht MP3 ist, wandle ich um.</p>
      <div class="knopfzeile">
        <Button size="lg" onClick={async () => add(await pick(false))}>
          Dateien auswählen …
        </Button>
        <button type="button" class="link-button" onClick={async () => add(await pick(true))}>
          Ganzen Ordner auswählen …
        </button>
      </div>
      <div class="kiste nur-rechner">
        <KisteArt width={wide ? 420 : 300} />
      </div>
    </div>
  );
}

function Reading({ done, total }: { done: number; total: number }) {
  return (
    <div class="ablage leer" role="status">
      <p class="gross-satz">Ich seh mir die Dateien an …</p>
      <p class="row" style={{ gap: 10 }}>
        <Spinner size={18} /> {total ? `${done} von ${plural(total, 'Datei', 'Dateien')}` : 'Einen Moment'}
      </p>
      <div class="knopfzeile">
        <Button size="lg" onClick={cancelReading}>
          Abbrechen
        </Button>
      </div>
    </div>
  );
}

/** One row of a list of titles, as 06-entwuerfe draws it. */
function Row({
  n,
  name,
  sec,
  extra,
  ok,
  cls,
  menu,
  drag,
}: {
  n: number;
  name: string;
  sec?: number;
  extra?: ComponentChildren;
  ok?: boolean;
  cls?: string;
  menu?: MenuItem[];
  drag?: { index: number; onMove: (from: number, to: number) => void };
}) {
  return (
    <li
      class={`tz ${cls ?? ''}`}
      draggable={!!drag}
      onDragStart={drag ? (e) => e.dataTransfer?.setData('text/x-tonuino-titel', String(drag.index)) : undefined}
      onDragOver={drag ? (e) => e.dataTransfer?.types.includes('text/x-tonuino-titel') && e.preventDefault() : undefined}
      onDrop={
        drag
          ? (e) => {
              const from = Number(e.dataTransfer?.getData('text/x-tonuino-titel'));
              if (!Number.isFinite(from) || e.dataTransfer?.getData('text/x-tonuino-titel') === '') return;
              e.preventDefault();
              e.stopPropagation();
              if (from !== drag.index) drag.onMove(from, drag.index);
            }
          : undefined
      }
    >
      {drag ? (
        <span class="griff" aria-hidden="true">
          =
        </span>
      ) : (
        <span class="griff leer" aria-hidden="true" />
      )}
      <span class="tn num">{String(n).padStart(3, '0')}</span>
      <span class="tname" title={name}>
        {name}
      </span>
      {extra}
      {ok ? (
        <span class="ok">
          <Haken size={18} />
        </span>
      ) : null}
      <span class="td num">{formatDuration(sec)}</span>
      {menu?.length ? <MenuButton trigger={(open) => <button type="button" class="mehr" aria-label={`Mehr zu „${name}“`} onClick={open}>…</button>} items={menu} /> : <span class="mehr leer" />}
    </li>
  );
}

const titleOf = (t: DraftTrack) => t.title || t.source.name;

/** The album's titles; onto a folder with titles, mixed in at their place with the numbers they get. */
function Titles({
  album: a,
  oldRows,
  at,
  add,
  over,
  onTrim,
  onTrimNew,
}: {
  album: ImportAlbum;
  oldRows: TrackRow[];
  at: number | null;
  add: (s: ByteSource[]) => void;
  over: boolean;
  onTrim: (file: string) => void;
  onTrimNew: (t: DraftTrack) => void;
}) {
  const w = session.value.write;
  const writing = session.value.phase === 'writing' && !!w;
  const sec = a.tracks.reduce((n, t) => n + (t.info?.durationSec ?? 0), 0);
  const move = (from: number, to: number) =>
    updateTracks(a.id, (list) => {
      const [x] = list.splice(from, 1);
      list.splice(to, 0, x);
      return list;
    });
  const newMenu = (i: number): MenuItem[] => [
    ...(a.tracks.length > 1 && !writing
      ? [
          { label: 'Nach oben', disabled: i === 0, onSelect: () => move(i, i - 1) },
          { label: 'Nach unten', disabled: i === a.tracks.length - 1, onSelect: () => move(i, i + 1) },
        ]
      : []),
    ...(writing
      ? []
      : [
          {
            label: 'Zuschneiden …',
            separatorBefore: a.tracks.length > 1,
            onSelect: () => {
              const t = a.tracks[i];
              const problem = trimPendingProblem(a, t);
              if (problem) toast.info(problem.title, problem.text);
              else onTrimNew(t);
            },
          },
          ...(a.tracks[i].trimmed ? [{ label: 'Schnitt zurücknehmen', onSelect: () => untrimTrack(a.id, a.tracks[i].source) }] : []),
          { label: 'Weglassen', danger: true, onSelect: () => updateTracks(a.id, (list) => list.filter((_, k) => k !== i)) },
        ]),
  ];
  // A title cut here (not on the card yet): a pair of scissors in its row.
  const cutMark = (t: DraftTrack) =>
    t.trimmed ? (
      <span class="geschnitten" title="Zugeschnitten" aria-label="zugeschnitten">
        <Scissors size={15} strokeWidth={2.2} aria-hidden="true" />
      </span>
    ) : null;
  // Ticks for the titles that are on the card already (06-entwuerfe, at the phone while copying).
  const copied = (i: number) => writing && (w!.step === 'check' || i < w!.track);
  const head = a.append ? `Ordner ${folderName(a.target)} · ${shownTitle(a)}` : a.title || shownTitle(a);
  const rows =
    oldRows.length && a.append
      ? placedRows(oldRows.length, a.tracks.length, at ?? oldRows.length).map((r, i) => {
          if (r.kind === 'new') {
            const t = a.tracks[r.index];
            return (
              <Row
                key={`n${r.index}`}
                n={i + 1}
                name={titleOf(t)}
                sec={t.info?.durationSec}
                cls="neu"
                extra={
                  <>
                    {cutMark(t)}
                    <span class="neu-mark">neu</span>
                  </>
                }
                ok={copied(r.index)}
                menu={newMenu(r.index)}
              />
            );
          }
          const o = oldRows[r.index];
          return (
            <Row
              key={o.file}
              n={i + 1}
              name={o.title}
              sec={o.durationSec}
              extra={r.moved ? <span class="war num">war {String(r.was).padStart(3, '0')}</span> : null}
              menu={writing ? [] : [{ label: 'Zuschneiden …', onSelect: () => onTrim(o.file) }]}
            />
          );
        })
      : a.tracks.map((t, i) => (
          <Row key={`${t.source.relativePath ?? t.source.name}-${i}`} n={i + 1} name={titleOf(t)} sec={t.info?.durationSec} extra={cutMark(t)} ok={copied(i)} menu={newMenu(i)} drag={writing || a.tracks.length < 2 ? undefined : { index: i, onMove: move }} />
        ));
  return (
    <div class={`ablage titel-liste ${over ? 'over' : ''}`}>
      <div class="liste-kopf">
        <span class="name ellipsis">{head}</span>
        <span class="muted num">
          {a.append && oldRows.length
            ? `${plural(oldRows.length + a.tracks.length, 'Titel', 'Titel')}, ${a.tracks.length} davon neu`
            : `${plural(trackCountOf(a).count, 'Titel', 'Titel')}${sec ? ` · ${formatDuration(sec)}` : ''}`}
        </span>
        <span class="rest" />
        {writing ? null : (
          <button type="button" class="link-button" onClick={async () => add(await pick(false))}>
            Weitere Dateien …
          </button>
        )}
      </div>
      <ol class="titel">{rows}</ol>
    </div>
  );
}

/** Several albums: one row each, with its folder. */
function Albums({ albums, add, over }: { albums: ImportAlbum[]; add: (s: ByteSource[]) => void; over: boolean }) {
  const w = session.value.write;
  return (
    <div class={`ablage titel-liste ${over ? 'over' : ''}`}>
      <div class="liste-kopf">
        <span class="name">{plural(albums.length, 'Album', 'Alben')}</span>
        <span class="muted num">{plural(albums.reduce((n, a) => n + trackCountOf(a).count, 0), 'Titel', 'Titel')}</span>
        <span class="rest" />
        {w ? null : (
          <button type="button" class="link-button" onClick={async () => add(await pick(false))}>
            Weitere Dateien …
          </button>
        )}
      </div>
      <ol class="titel">
        {albums.map((a, i) => (
          <Row key={a.id} n={a.target || i + 1} name={shownTitle(a)} sec={a.tracks.reduce((n, t) => n + (t.info?.durationSec ?? 0), 0)} extra={<span class="war num">{plural(trackCountOf(a).count, 'Titel', 'Titel')}</span>} ok={!!w && (w.album > i || w.step === 'check')} />
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ copying */

/** The progress runs in the button (Etcher, hörbert), under it the time left and „Abbrechen“. */
function Progressing() {
  const w = session.value.write;
  const started = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  if (!w) return null;
  const share = w.bytesTotal ? Math.min(1, w.bytesDone / w.bytesTotal) : 0;
  const label =
    w.step === 'check' ? 'Fast fertig …' : w.step === 'prepare' ? 'Bereite vor …' : `${w.albums > 1 ? `Album ${w.album + 1} von ${w.albums} · ` : ''}Kopiere … ${Math.min(w.track + 1, w.tracks)} von ${w.tracks}`;
  return (
    <>
      <Button variant="primary" class="xl wide laeuft" aria-disabled="true" onClick={() => undefined}>
        <span class="done" style={{ width: `${Math.round(share * 100)}%` }} />
        <span class="lbl" aria-live="polite">
          {label}
        </span>
      </Button>
      <div class="unter">
        <span class="soft">{w.step === 'check' ? 'Ich prüfe die Reihenfolge auf der Karte.' : minutesLeftText(minutesLeft(now - started.current, w.bytesDone, w.bytesTotal))}</span>
        <button
          type="button"
          class="link-button"
          disabled={stopping || w.step === 'check'}
          onClick={() => {
            setStopping(true);
            cancelImport();
          }}
        >
          {stopping ? 'Hält nach diesem Titel an …' : 'Abbrechen'}
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ done */

function useDone() {
  const r = session.value.result;
  const folders = r?.folders ?? [];
  const first = folders[0] ?? r?.partial?.folder;
  const scan = card.value?.scan;
  const f = first ? scan?.folders.find((x) => x.number === first) : undefined;
  const entry = first ? catalog.value?.folders[folderName(first)] : undefined;
  // Firefox, Safari: what was added waits for the Paket until the card was checked.
  const waits = card.value?.volume.access === 'snapshot' && packageState.value.kind !== 'clean';
  return { r, folders, first, f, entry, waits };
}

function DoneList({ onTrim }: { onTrim: (t: { folder: number; rows: TrackRow[]; file: string }) => void }) {
  const { r, folders, first, f, entry, waits } = useDone();
  const rows = useTrackRows(f, entry);
  const scan = card.value?.scan;
  const name = first ? `„${entry?.title ?? `Ordner ${folderName(first)}`}“` : '';
  const p = placing.value;
  const well = !!r && !r.error && !r.cancelled && !r.refused.length && !r.rest.length;
  return (
    <div class="ablage titel-liste">
      <div class="liste-kopf fertig-kopf">
        {well ? <Haken size={32} /> : null}
        {/* In the Paket way nothing is on the card yet: „Fertig.“ was not true there (Prüfrunde 1 B3). */}
        <span class="name ellipsis">{well ? (waits ? 'Bereit fürs Paket.' : 'Fertig.') : r?.cancelled ? 'Angehalten.' : 'Nicht alles kam an.'}</span>
        <span class="muted">
          {!first
            ? 'Auf der Karte hat sich nichts geändert.'
            : waits
              ? folders.length > 1
                ? `Bereit fürs Paket: ${foldersWords(folders)}.`
                : `${name} kommt mit dem Paket in Ordner ${first}.`
              : folders.length > 1
                ? `Jetzt auf der Karte: ${foldersWords(folders)}.`
                : `${name} ist jetzt in Ordner ${first}.`}
        </span>
      </div>
      {p && p.folder === first && p.state === 'running' ? (
        <p class="zeile-klein ablage-zeile" role="status">
          <Spinner size={16} /> Ich sortiere die neuen Titel an ihre Stelle …
        </p>
      ) : null}
      {folders.length > 1 ? (
        // Several albums: one row for each folder, as the head names them all (Prüfrunde 1, aussehen 15).
        <ol class="titel alben">
          {folders.map((n) => {
            const sf = scan?.folders.find((x) => x.number === n);
            const title = catalog.value?.folders[folderName(n)]?.title ?? `Ordner ${folderName(n)}`;
            return (
              <li class="tz" key={n}>
                <span class="griff leer" aria-hidden="true" />
                <span class="tn num">{folderName(n)}</span>
                <span class="tname" title={title}>
                  {title}
                </span>
                <span class="td anzahl">{sf ? plural(sf.tracks.length, 'Titel', 'Titel') : ''}</span>
                <span class="mehr leer" />
              </li>
            );
          })}
        </ol>
      ) : f ? (
        <ol class="titel">
          {rows.map((t) => (
            <Row key={t.file} n={t.number} name={t.title} sec={t.durationSec} menu={p?.state === 'running' ? [] : [{ label: 'Zuschneiden …', onSelect: () => onTrim({ folder: first!, rows, file: t.file }) }]} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function DoneQuestions() {
  const { r, folders, first, f, waits } = useDone();
  const p = placing.value;
  const packaged = card.value?.volume.access === 'snapshot';
  const notes = r ? resultNotes(r, { packaged }) : [];
  const well = !!r && !r.error && !r.cancelled && !r.refused.length && !r.skipped.length && !r.rest.length;
  return (
    <div class="frage">
      <h2>{!well ? 'Fast' : waits ? 'Bereit fürs Paket' : 'Ist drauf'}</h2>
      {first && f && folders.length < 2 ? <p class="satz">Ordner {first} hat {waits ? 'dann' : 'jetzt'} {plural(f.tracks.length, 'Titel', 'Titel')}.</p> : null}
      {waits ? (
        <p class="satz muted">
          {/* After „Später“ in the guide the download button is gone: the sentence says what is left (Prüfrunde 2, eltern 4). */}
          {packageState.value.kind === 'downloaded' ? 'Das Paket liegt in deinem Download-Ordner. Entpacke es noch auf die SD-Karte.' : 'Lade das Paket herunter und entpacke es auf die SD-Karte. Ich zeige dir, wie.'}
        </p>
      ) : null}
      {p?.text && p.folder === first ? <p class={p.state === 'failed' ? 'zeile-warn' : 'satz'}>{p.text}</p> : null}
      {notes.slice(0, 2).map((n) => (
        <p class={well ? 'satz muted' : 'zeile-warn'} key={n}>
          {n}
        </p>
      ))}
      {!well || notes.length > 2 ? (
        <a class="link-button mehr-link" href={routeToHash({ page: 'add' })}>
          {r?.rest.length ? (packaged ? 'Rest vorbereiten …' : 'Rest übertragen …') : 'Genauer ansehen …'}
        </a>
      ) : null}
    </div>
  );
}

function DoneFoot() {
  const { folders, first, waits } = useDone();
  // The Paket way: until it is downloaded, that is the next step; the card and the stickers come after (Prüfrunde 1 B3).
  const download = waits && packageState.value.kind === 'pending';
  // Downloaded but not yet on the card: the guide stays the next step until „Karte prüfen“ finds it there (Prüfrunde 2, eltern 4).
  const unpack = waits && packageState.value.kind === 'downloaded';
  return (
    <>
      {download ? (
        <Button variant="primary" class="xl wide" onClick={() => openPackageDialog('choose')}>
          Paket herunterladen …
        </Button>
      ) : unpack ? (
        <Button variant="primary" class="xl wide" onClick={() => openPackageDialog('guide')}>
          Anleitung zeigen …
        </Button>
      ) : first ? (
        <a class="btn primary xl wide" href={routeToHash({ page: 'karte', folder: first })}>
          {folders.length > 1 ? `Karte für Ordner ${first} beschreiben` : 'Karte dafür beschreiben'}
        </a>
      ) : null}
      <div class="knopf-paar">
        {(download || unpack) && first ? (
          <a class="btn lg" href={routeToHash({ page: 'karte', folder: first })}>
            Karte beschreiben
          </a>
        ) : (
          <a class="btn lg" href={routeToHash({ page: 'sticker' })}>
            Sticker drucken
          </a>
        )}
        <Button
          size="lg"
          onClick={() => {
            resetImport();
            placing.value = null;
            placeAt.value = null;
            wanted.value = null;
          }}
        >
          Noch mehr Musik
        </Button>
      </div>
    </>
  );
}
