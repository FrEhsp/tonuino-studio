import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AUDIO_EXTENSIONS, extensionOf } from '../../core/library/tags';
import { hasAlbumCuts, isCuttable, isLongTrack, isPlayableAsIs, isSplit, type DraftTrack, type SplitMode } from '../../core/library/grouping';
import { CONTENT_KINDS, type ContentKind } from '../../core/tonuino/catalog';
import { MODES } from '../../core/tonuino/modes';
import { buildFolderQuery } from '../../core/stickers/bulkcover';
import { folderName, freeFolderNumbers } from '../../core/tonuino/sd';
import type { ByteSource } from '../../platform/types';
import { Button, Callout, EmptyState, IconButton, Progress, Segmented, Spinner } from '../../ui/components/controls';
import { Cover } from '../../ui/components/Cover';
import { Dialog } from '../../ui/components/Dialog';
import { MenuButton } from '../../ui/components/Menu';
import { toast, toastError } from '../../ui/components/Toast';
import { WrapInput } from '../../ui/components/WrapInput';
import { albumWantsLookup, NameLookup } from './NameLookup';
import { AlbumCutNote, AlbumCutsButton } from './AlbumCut';
import { AudioSeekBar } from '../../ui/components/SeekBar';
import { after, useListen, type ListenNext } from '../../ui/useListen';
import { SdCardArt } from '../../ui/components/Art';
import { Bild, Haken, Hinweis, Hoch, Kreuz, Mehr, Pause, Play, Runter, SdAuswerfen, Winkel, WinkelHoch } from '../../ui/icons';
import { ArrowLeft, Compass, FileAudio, FolderOpen, FolderPlus, ListOrdered, ListPlus, Mic, Nfc, Plus, Printer, Scissors, Search, SlidersHorizontal, Upload, Wrench, X, type LucideIcon } from 'lucide-preact';
import { Bubble } from '../../ui/components/Sketch';
import { ShelfSticker } from '../covers/ShelfSticker';
import { useFileDrop } from '../../ui/useFileDrop';
import { navigate, routeToHash } from '../../app/router';
import { cardIntoDevice, handheldWord } from '../../app/device';
import { usePageShown } from '../../app/pageAlive';
import { card, catalog, coverUrlFor, ejectCard, openVolume, plat, platform, recordingOffered, selection, settings } from '../../app/state';
import { canChangeCard, chooseCardFolder, foldersNotOnCard, packageState, scratchAvailable } from '../../app/pending';
import { PackageWaitingPage } from '../box/PackageWaitingGate';
import { fixableLine, WriteFixButton } from '../box/WriteAccessNotice';
import { PendingChanges } from '../box/PendingChanges';
import { EpisodePlanner } from './EpisodePlanner';
import { PackOfferLine } from './PackOffer';
import { rangeName } from '../../core/tonuino/episodes';
import { formatBytes, formatDuration, plural } from '../../app/format';
import { HealthDialog } from '../box/HealthDialog';
import { FromSourcesLine, UnchangedNote } from '../sources/ReviewNotes';
import { sourcesAvailable } from '../sources/state';
import {
  addSources,
  albumBytesOf,
  cancelImport,
  cancelReading,
  cleanImportJunk,
  defaultModeFor,
  doneNotes,
  doubles,
  foldersWords,
  plannedRanges,
  rebuildNote,
  unorderedNote,
  problems,
  removeAlbum,
  resetImport,
  resultNotes,
  resumeImport,
  runImport,
  session,
  setCoverFor,
  shownTitle,
  totalBytes,
  trackCountOf,
  updateAlbum,
  updateTracks,
  waitingFolders,
  type ImportAlbum,
  type Problem,
  type WriteStep,
} from './session';
import { canRecord, RecordDialog } from './RecordDialog';
import { lookForVoice, voice, WEB_VOICE_TEXT } from '../box/voice';
import { DesktopAppLink } from '../help/DesktopAppLink';
import { PlaylistPanel } from '../playlist/PlaylistPanel';
import { CoverSearch } from '../box/CoverSearch';
import { playlist } from '../playlist/store';
import { ImportBarFlag } from '../../ui/rootFlag';

/** Formats named in the drop zone; the desktop app has no Opus decoder. */
const FORMATS = { web: 'MP3, M4A, M4B, AAC, FLAC, OGG, OPUS, WAV und mehr, auch als ZIP', desktop: 'MP3, M4A, M4B, AAC, FLAC, OGG, WAV und mehr, auch als ZIP' };

/** Opens the SD card from "Hinzufügen" without a card: read once in Firefox and Safari, otherwise chosen and opened. */
async function pickCard(reads: boolean) {
  if (reads) return chooseCardFolder('card');
  try {
    const v = await plat().volumes.pick();
    if (v) await openVolume(v);
  } catch (e) {
    toastError('Die Karte ließ sich nicht öffnen', e);
  }
}

export function AddPage({ folder }: { folder?: number }) {
  const s = card.value;
  const sess = session.value;
  // What a stopped transfer left waits like a selection.
  const rest = sess.phase === 'done' && !!sess.result?.rest?.length;

  // The page stays built while hidden: coming back to it counts like opening it.
  const shown = usePageShown();
  const wasShown = useRef(shown);

  // A fresh start when the target changed and nothing is in progress. A transfer
  // that went well is over: coming back starts afresh, also for the same folder.
  // One that went wrong stays, with the list of what is missing.
  useEffect(() => {
    const back = shown && !wasShown.current;
    wasShown.current = shown;
    const r = sess.result;
    // A review where none of the files could go: nothing in it is worth keeping.
    const empty = sess.phase === 'review' && !sess.albums.length;
    const over = back && (empty || (sess.phase === 'done' && !rest && !!r && !r.error && !r.cancelled && !r.refused.length && !r.skipped.length));
    if (sess.forFolder === folder && !over) return;
    if (sess.phase === 'pick' || empty || (sess.phase === 'done' && !rest)) resetImport(folder);
  }, [folder, shown]);

  if (!s || s.status !== 'ready' || !s.scan) {
    const reads = !platform.value?.capabilities.sd && platform.value?.capabilities.sdPackage;
    return (
      <div class="page narrow">
        <EmptyState
          art={<SdCardArt size={140} />}
          note="Ohne SD-Karte geht's nicht!"
          title="Zuerst die SD-Karte"
          actions={
            // The chooser right here, and the page stays (audit 0.4 #7): no detour over "Meine Box".
            <Button variant="primary" size="lg" onClick={() => void pickCard(!!reads)}>
              {reads ? 'SD-Karte einlesen' : 'SD-Karte auswählen'}
            </Button>
          }
        >
          {reads
            ? 'Lies zuerst die SD-Karte ein. Danach kannst du Hörspiele, Hörbücher und Musik hinzufügen.'
            : platform.value?.mobile
              ? `Stecke die SD-Karte der Box ${cardIntoDevice()} und wähle sie aus. Danach kannst du Hörspiele, Hörbücher und Musik hinzufügen.`
              : 'Stecke die SD-Karte der Box in den Computer und wähle sie aus. Danach kannst du Hörspiele, Hörbücher und Musik hinzufügen.'}
        </EmptyState>
      </div>
    );
  }

  // A downloaded Paket waits for the card: new folders have to wait for it.
  if (!canChangeCard() && (sess.phase === 'pick' || sess.phase === 'reading' || sess.phase === 'review')) return <PackageWaitingPage />;

  if (sess.forFolder !== folder && ((sess.phase === 'review' && sess.albums.length) || sess.phase === 'reading' || sess.phase === 'writing' || rest)) {
    return <OtherSession folder={folder} />;
  }

  switch (sess.phase) {
    case 'pick':
      return <PickStep folder={folder} />;
    case 'reading':
      // More files for albums in the review: the review stays, with what is typed in it.
      return sess.albums.length ? <ReviewStep /> : <ReadingStep />;
    case 'review':
      return <ReviewStep />;
    case 'writing':
      return <WritingStep />;
    case 'done':
      return <DoneStep />;
  }
}

function OtherSession({ folder }: { folder?: number }) {
  const sess = session.value;
  const back = () => navigate({ page: 'add', folder: sess.forFolder });
  const writing = sess.phase === 'writing';
  const rest = sess.phase === 'done';
  // Firefox, Safari: nothing is written to the card here, it is prepared for the Paket.
  const packaged = card.value?.volume.access === 'snapshot';
  // Several albums, changes made by hand, or what a transfer left: asked first, as in the review.
  const asks = !writing && (rest || sess.albums.length > 1 || !!sess.edited);
  const [discard, setDiscard] = useState(false);
  const first = sess.albums[0];
  const chosen = sess.forFolder
    ? `${plural(first?.tracks.length ?? 0, 'neuen Titel', 'neue Titel')} für Ordner ${folderName(sess.forFolder)}`
    : sess.albums.length > 1
      ? `„${shownTitle(first)}“ und ${plural(sess.albums.length - 1, 'weiteres Album', 'weitere Alben')}`
      : `„${first ? shownTitle(first) : ''}“`;
  const wanted = folder ? `Du wolltest Titel zu „${card.value?.catalog?.folders[folderName(folder)]?.title ?? `Ordner ${folderName(folder)}`}“ hinzufügen. ` : '';
  return (
    <div class="page narrow">
      {folder ? <BackToFolder folder={folder} /> : null}
      {discard ? <DiscardQuestion target={folder} onClose={() => setDiscard(false)} /> : null}
      <EmptyState
        title={
          writing
            ? packaged
              ? 'Gerade wird noch etwas vorbereitet'
              : 'Gerade wird noch etwas übertragen'
            : rest
              ? packaged
                ? 'Das letzte Vorbereiten ist nicht fertig'
                : 'Die letzte Übertragung ist nicht fertig'
              : 'Da liegt noch eine Auswahl bereit'
        }
        actions={
          <>
            <Button variant="primary" onClick={back}>
              {writing ? 'Zum Fortschritt' : rest ? (packaged ? 'Zum Vorbereiten' : 'Zur Übertragung') : 'Weiter mit der Auswahl'}
            </Button>
            {!writing ? <Button onClick={() => (asks ? setDiscard(true) : resetImport(folder))}>Verwerfen und neu beginnen</Button> : null}
          </>
        }
      >
        {wanted}
        {writing
          ? packaged
            ? 'Warte, bis alles fürs Paket vorbereitet ist. Danach kannst du weitere Titel hinzufügen.'
            : 'Warte, bis die Übertragung fertig ist. Danach kannst du weitere Titel hinzufügen.'
          : rest
            ? packaged
              ? 'Ein Teil ist noch nicht im Paket. Du kannst ihn jetzt vorbereiten oder verwerfen.'
              : 'Ein Teil ist noch nicht auf der Karte. Du kannst ihn jetzt übertragen oder verwerfen.'
            : sess.albums.length
              ? `Du hast vorhin ${chosen} ausgewählt und noch nicht ${packaged ? 'vorbereitet' : 'übertragen'}.`
              : 'Ich seh mir gerade Dateien für eine andere Auswahl an.'}
      </EmptyState>
    </div>
  );
}

/* ------------------------------------------------------------------ pick */

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

/** `main`: the purple button of the page; while the list panel is open, its own button is. */
function PickButtons({ size = 'lg', main = true }: { size?: 'md' | 'lg'; main?: boolean }) {
  const add = useAddFiles();
  // Firefox asks before it hands a whole folder to a page.
  const asks = !!platform.value?.capabilities.sdPackage;
  return (
    <div class="stack tight" style={{ alignItems: 'center' }}>
      <div class="row wrap" style={{ justifyContent: 'center' }}>
        <Button variant={main ? 'primary' : 'default'} size={size} icon={FileAudio} onClick={async () => add(await pick(false))}>
          Dateien auswählen
        </Button>
        <Button size={size} icon={FolderOpen} onClick={async () => add(await pick(true))}>
          Ordner auswählen
        </Button>
      </div>
      {asks ? <p class="small muted">Fragt der Browser nach „Hochladen“? Keine Sorge, die Dateien bleiben auf deinem Computer.</p> : null}
    </div>
  );
}

function BackToFolder({ folder }: { folder: number }) {
  return (
    <a class="back-link" href={`#/ordner/${folderName(folder)}`}>
      <ArrowLeft size={16} /> Zurück zum Ordner
    </a>
  );
}

function PickStep({ folder }: { folder?: number }) {
  const s = card.value!;
  const add = useAddFiles();
  // A track list dropped on the page (Spotify ZIP, CSV, …) goes to the playlist panel, not into the import.
  const { over, handlers } = useFileDrop((sources) => {
    void playlist.takeDrop(sources).then((taken) => taken || add(sources));
  });
  const entry = folder ? s.catalog?.folders[folderName(folder)] : undefined;
  const free = freeFolderNumbers(s.scan!).length;
  const [recording, setRecording] = useState(false);
  const listOpen = playlist.open.value;
  const discover = __SOURCES_ENABLED__ && !folder && sourcesAvailable.value;
  return (
    <div class="page narrow add-page" {...handlers}>
      {folder ? <BackToFolder folder={folder} /> : null}
      <header class="page-header">
        <div class="titles">
          <h1>{folder ? `Titel zu „${entry?.title ?? `Ordner ${folderName(folder)}`}“ hinzufügen` : 'Hinzufügen'}</h1>
          <p>{folder ? 'Die neuen Titel kommen hinten an den Ordner.' : `Hörspiele, Hörbücher und Musik von deinem ${platform.value?.mobile ? handheldWord() : 'Computer'} auf die SD-Karte.`}</p>
        </div>
      </header>
      {/* Nothing is dragged on a phone or tablet: there the field is for picking, without the tip about dragging. */}
      <div class={`dropzone ${over ? 'over' : ''}`}>
        {platform.value?.handheld ? null : (
          <Bubble tail="left" class="dropzone-bubble">
            {folder ? 'Tipp: Ziehe die neuen Folgen einfach hier rein!' : 'Tipp: Ziehe einfach den ganzen Album-Ordner rein!'}
          </Bubble>
        )}
        <div class="dropzone-icon">
          <Upload size={30} strokeWidth={2} />
        </div>
        <div class="stack tight" style={{ alignItems: 'center' }}>
          <h2>{platform.value?.handheld ? 'Suche die Dateien aus' : 'Dateien oder ganze Ordner hierher ziehen'}</h2>
          <p class="muted">
            {FORMATS[plat().kind]}
            {/* Parents often start with a CD in hand, and nothing here said how it becomes files (Prüfrunde 0.5-1). */}
            {' · '}
            <a href="#/hilfe/cd-und-streaming">Von einer CD?</a>
          </p>
        </div>
        <PickButtons main={!listOpen} />
      </div>
      {!folder && !free ? <Callout tone="warning">Alle 99 Ordner sind belegt. Lösche zuerst einen Ordner oder hänge Titel an einen vorhandenen an.</Callout> : null}
      <PlaylistPanel folder={folder} />
      <div class="feature-grid">
        {folder ? (
          <Tip icon={ListPlus} title="Alles kommt in diesen Ordner" text="Auch wenn du mehrere Alben oder Ordner wählst: Die Titel kommen der Reihe nach hinten an. Die Reihenfolge prüfst du gleich." />
        ) : (
          <Tip icon={FolderOpen} title="Ein Ordner pro Album" text="Ich erkenne Alben an den Infos in den Dateien und an deinen Ordnern. Jedes bekommt eine eigene Nummer." />
        )}
        <Tip icon={Scissors} title="Lange Hörbücher werden geteilt" text="Bei einer Datei mit drei Stunden merkt sich die Box sonst nicht, wo ihr wart. Ich teile an Kapiteln oder Sprechpausen." />
        <Tip icon={SlidersHorizontal} title="Alles wird passend gemacht" text="Andere Formate werden zu MP3, die Lautstärke wird angeglichen und die Titel kommen in der richtigen Reihenfolge auf die Karte." />
        {discover ? (
          <Tip
            icon={Compass}
            title="Freie Hörspiele entdecken"
            text="Kostenlose Hörspiele, Hörbücher und Lieder für Kinder, legal und von mir ausgesucht."
            action={{ label: 'Entdecken', onClick: () => navigate({ page: 'sources' }) }}
            wide
          />
        ) : null}
      </div>
      {/* The Android app records on its own page (a tab), else a dialog opens here. Almost every laptop has a
          microphone, so it stands here without the switch in the settings (audit 0.4 #9); that one is for the folder menu. */}
      {recordingOffered() || (canRecord() && !platform.value?.capabilities.sdPackage) ? (
        <section class="card pad stack add-more">
          <h2>Mehr</h2>
          <div class="row wrap" style={{ gap: 12 }}>
            <Button icon={Mic} onClick={() => (platform.value?.mobile && !folder ? navigate({ page: 'record' }) : setRecording(true))}>
              Aufnehmen …
            </Button>
            <span class="small muted grow" style={{ minWidth: 200 }}>
              Eine Geschichte vorlesen oder einen Gruß aufnehmen, mit dem Mikrofon {platform.value?.mobile ? `deines ${handheldWord()}s` : 'deines Computers'}.
            </span>
          </div>
        </section>
      ) : null}
      {recording ? <RecordDialog folder={folder} onClose={() => setRecording(false)} /> : null}
    </div>
  );
}

/** A tip under the drop zone; `wide` takes a whole row, with its button at the end. */
function Tip({ icon: Icon, title, text, action, wide }: { icon: LucideIcon; title: string; text: string; action?: { label: string; onClick: () => void }; wide?: boolean }) {
  const button = action ? (
    <Button size="sm" variant="soft" class="feature-action" onClick={action.onClick}>
      {action.label}
    </Button>
  ) : null;
  return (
    <div class={wide ? 'feature feature-wide' : 'feature'}>
      <span class="feature-icon">
        <Icon size={20} />
      </span>
      <div class="stack tight grow">
        <strong>{title}</strong>
        <span class="small muted">{text}</span>
        {wide ? null : button}
      </div>
      {wide ? button : null}
    </div>
  );
}

/* ------------------------------------------------------------------ reading */

function ReadingStep() {
  const r = session.value.reading;
  return (
    <div class="page narrow">
      <div class="card pad stack loose" style={{ alignItems: 'center', textAlign: 'center', padding: 48 }}>
        <Spinner size={36} />
        <div class="stack tight">
          <h2>Ich seh mir die Dateien an …</h2>
          <p class="muted">{r && r.total ? `${r.done} von ${plural(r.total, 'Datei', 'Dateien')}` : 'Einen Moment'}</p>
        </div>
        <div style={{ width: '100%', maxWidth: 420 }}>
          <Progress value={r?.done ?? 0} max={Math.max(1, r?.total ?? 1)} indeterminate={!r?.total} />
        </div>
        <Button variant="ghost" onClick={cancelReading}>
          Abbrechen
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ review */

function ReviewStep() {
  const s = card.value!;
  const sess = session.value;
  const add = useAddFiles();
  const { over, handlers } = useFileDrop(add);
  const found = problems(sess, s.scan!);
  // Only a hint, the transfer can go on.
  const twice = doubles(sess, s.catalog, foldersNotOnCard.value);
  const bytes = totalBytes(sess);
  const free = s.info.freeBytes;
  const tooBig = free !== undefined && bytes > free;
  // Firefox, Safari: new files wait in the browser's storage until the Paket.
  const packaged = s.volume.access === 'snapshot';
  const [room, setRoom] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!packaged) return;
    let live = true;
    scratchAvailable()
      .then((n) => live && setRoom(n))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [packaged, bytes]);
  const noRoom = packaged && room !== undefined && bytes > room;
  const trackCount = sess.albums.reduce((n, a) => n + trackCountOf(a).count, 0);
  const appendTo = sess.forFolder;
  // One album that goes onto a folder already there, chosen in its folder choice: the head says so too.
  const onto = appendTo ?? (sess.albums.length === 1 && sess.albums[0].append ? sess.albums[0].target : undefined);
  const entry = onto ? s.catalog?.folders[folderName(onto)] : undefined;
  // Albums that make a new folder, and those that go onto the end of one already there.
  const fresh = sess.albums.filter((a) => !a.append).length;
  const ontoCount = sess.albums.length - fresh;
  // Every file was refused: then the reasons are what there is to see.
  const nothing = !sess.albums.length;
  const [showRejected, setShowRejected] = useState(nothing);
  // Downloads that could not be loaded (from "Entdecken") are listed, but not counted as files.
  const filesRejected = sess.rejected.filter((r) => !r.web).length;
  const reading = sess.phase === 'reading' ? (sess.reading ?? { done: 0, total: 0 }) : undefined;
  // Going on with a transfer that stopped.
  const resuming = sess.albums.some((a) => a.resume);
  // Several albums, or changes made by hand: a slip of the mouse would cost them all.
  const asksFirst = sess.albums.length > 1 || (!!sess.edited && !nothing);
  const [discard, setDiscard] = useState(false);
  // A recording alone (from "Hinzufügen" or the phone's "Aufnehmen"): no album words, one question where it goes (audit 0.4 #10).
  const recording = !!sess.recording && !appendTo && sess.albums.length === 1 && !resuming;

  return (
    <div class={`page ${over ? 'drop-over' : ''}`} {...handlers}>
      {appendTo ? <BackToFolder folder={appendTo} /> : null}
      <header class="page-header">
        <div class="titles">
          <h1>
            {recording
              ? 'Deine Aufnahme'
              : onto
                ? `Neue Titel für „${entry?.title ?? `Ordner ${folderName(onto)}`}“`
                : nothing
                  ? packaged
                    ? 'Nichts fürs Paket'
                    : 'Nichts zum Übertragen'
                  : resuming
                    ? packaged
                      ? 'Rest vorbereiten'
                      : 'Rest übertragen'
                    : packaged
                      ? 'Prüfen und vorbereiten'
                      : 'Prüfen und übertragen'}
          </h1>
          <p>
            {recording
              ? onto
                ? `Sie kommt hinten an „${entry?.title ?? `Ordner ${folderName(onto)}`}“. Danach kann die Box sie abspielen.`
                : packaged
                  ? 'Gib ihr einen Namen und sage mir, wohin sie soll. Dann kommt sie ins Paket für die Karte.'
                  : 'Gib ihr einen Namen und sage mir, wohin sie soll. Dann kommt sie auf die Karte.'
              : nothing
                ? `${sess.rejected.length === 1 ? 'Die Datei kann' : 'Keine der Dateien kann'} so nicht auf die Karte. Unten steht, warum.`
                : resuming
                  ? packaged
                    ? 'Hier steht, was noch nicht im Paket ist. Ich mach dort weiter, wo ich aufgehört hab.'
                    : 'Hier steht, was noch nicht auf der Karte ist. Ich mach dort weiter, wo ich aufgehört hab.'
                  : onto
                    ? 'Prüfe die Reihenfolge. Die Titel kommen hinten an den Ordner.'
                    : sess.albums.length === 1
                      ? packaged
                        ? 'Ein Album gefunden. Prüfe Titel und Art, dann kommt es ins Paket für die Karte.'
                        : 'Ein Album gefunden. Prüfe Titel und Art, dann kommt es auf die Karte.'
                      : !ontoCount
                        ? `${sess.albums.length} Alben gefunden. Jedes kommt in einen eigenen Ordner.`
                        : fresh
                          ? `${sess.albums.length} Alben gefunden. Neue Titel kommen hinten an die gewählten Ordner, der Rest in neue Ordner.`
                          : `${sess.albums.length} Alben gefunden. Die Titel kommen hinten an die gewählten Ordner.`}
          </p>
        </div>
        {recording ? null : (
          <div class="row wrap">
            <Button icon={Plus} onClick={async () => add(await pick(false))}>
              {nothing ? 'Andere Dateien wählen' : 'Weitere Dateien'}
            </Button>
            <Button icon={FolderOpen} onClick={async () => add(await pick(true))}>
              {nothing ? 'Anderen Ordner wählen' : 'Weiterer Ordner'}
            </Button>
            <Button variant="ghost" icon={X} onClick={() => (asksFirst ? setDiscard(true) : resetImport(appendTo))}>
              {nothing ? 'Zurück' : 'Alles verwerfen'}
            </Button>
          </div>
        )}
      </header>
      {discard ? <DiscardQuestion target={appendTo} onClose={() => setDiscard(false)} /> : null}

      {reading ? (
        <div class="card import-reading" role="status">
          <Spinner size={18} />
          <div class="stack tight grow" style={{ minWidth: 0 }}>
            <strong>Ich seh mir die neuen Dateien an …</strong>
            <span class="small muted">{reading.total ? `${reading.done} von ${plural(reading.total, 'Datei', 'Dateien')}` : 'Einen Moment'}</span>
          </div>
          <Button variant="ghost" onClick={cancelReading}>
            Abbrechen
          </Button>
        </div>
      ) : null}

      {sess.rejected.length ? (
        <Callout tone="neutral">
          <div class="stack tight">
            <span>
              {filesRejected ? (packaged ? `${plural(filesRejected, 'Datei kommt', 'Dateien kommen')} nicht ins Paket. ` : `${plural(filesRejected, 'Datei wird', 'Dateien werden')} nicht übertragen. `) : ''}
              <button type="button" class="link-button" style={{ display: 'inline-flex', padding: 0 }} onClick={() => setShowRejected(!showRejected)}>
                {showRejected ? 'Ausblenden' : 'Anzeigen'}
              </button>
            </span>
            {showRejected ? (
              <ul class="small" style={{ margin: 0, paddingLeft: 18 }}>
                {[...sess.rejected].sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true })).slice(0, 50).map((r) => (
                  <li key={r.name}>
                    <span class={r.web ? undefined : 'mono'}>{r.name}</span>: {r.reason}
                  </li>
                ))}
                {sess.rejected.length > 50 ? <li>… und {sess.rejected.length - 50} weitere</li> : null}
              </ul>
            ) : null}
          </div>
        </Callout>
      ) : null}

      {!appendTo && !nothing && !recording ? <PackOfferLine /> : null}
      {settings.value.episodePlanner && !appendTo && !nothing ? <EpisodePlanner /> : null}

      <div class="stack">
        {sess.albums.map((a) => (
          <AlbumCard key={a.id} album={a} problems={found.filter((p) => p.album === a.id)} hints={twice.filter((p) => p.album === a.id)} single={sess.albums.length === 1} recording={recording} />
        ))}
      </div>

      {nothing ? null : (
        <div class="import-bar">
          <ImportBarFlag />
          <div class="stack tight grow">
            <strong>
              {recording
                ? 'Eine Aufnahme'
                : onto || !fresh
                  ? plural(trackCount, 'neuer Titel', 'neue Titel')
                  : ontoCount
                    ? `${plural(fresh, 'neuer Ordner', 'neue Ordner')} · ${plural(trackCount, 'Titel', 'Titel')}`
                    : `${plural(sess.albums.length, 'Ordner', 'Ordner')} · ${plural(trackCount, 'Titel', 'Titel')}`}{' '}
              · etwa {formatBytes(bytes)}
            </strong>
            <span class={`small ${tooBig || noRoom ? '' : 'muted'}`} style={tooBig || noRoom ? { color: 'var(--danger-text)' } : undefined}>
              {reading
                ? 'Warte, bis ich die neuen Dateien angesehen hab.'
                : noRoom
                  ? `Für so viel Musik auf einmal hat der Browser zu wenig Platz. Nimm weniger ${appendTo ? 'Titel' : 'Alben'} auf einmal.`
                  : packaged
                    ? 'Lasse die Karte stecken, bis das Paket heruntergeladen ist.'
                    : free !== undefined
                      ? tooBig
                        ? `Auf der Karte sind nur noch ${formatBytes(free)} frei.`
                        : `${formatBytes(free)} frei auf der Karte`
                      : 'Ziehe die Karte während der Übertragung nicht heraus.'}
            </span>
            {plat().os === 'macos' ? (
              // Said before anything is written: the app deletes these on its own.
              <span class="small muted">Danach räume ich versteckte Begleitdateien der neuen Titel auf, zum Beispiel ._001.mp3 vom Mac.</span>
            ) : null}
          </div>
          <Button
            variant="primary"
            size="lg"
            disabled={!!found.length || tooBig || noRoom || !sess.albums.length || !!reading}
            onClick={() => runImport().catch((e) => toastError(packaged ? 'Das Vorbereiten hat nicht geklappt' : 'Die Übertragung ist fehlgeschlagen', e))}
          >
            {packaged ? 'Ins Paket für die Karte' : 'Auf die SD-Karte übertragen'}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Asked before „Alles verwerfen“ throws away several albums or changes, and
 * before what a stopped transfer left goes. `target` is the folder to start
 * afresh with (none: a new folder).
 */
function DiscardQuestion({ target, onClose }: { target: number | undefined; onClose: () => void }) {
  const sess = session.value;
  const n = sess.albums.length;
  const rest = sess.phase === 'done';
  const packaged = card.value?.volume.access === 'snapshot';
  const what = rest ? 'Den Rest verwerfen?' : sess.forFolder ? 'Die neuen Titel verwerfen?' : n > 1 ? `${n} Alben verwerfen?` : 'Das Album verwerfen?';
  return (
    <Dialog
      title={what}
      onClose={onClose}
      footer={
        <>
          <Button autofocus onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onClose();
              resetImport(target);
            }}
          >
            Verwerfen
          </Button>
        </>
      }
    >
      <p>
        {rest
          ? `Was noch nicht ${packaged ? 'im Paket' : 'auf der Karte'} ist, musst du dann neu wählen.`
          : sess.edited
            ? 'Deine Auswahl und deine Änderungen gehen verloren.'
            : 'Deine Auswahl geht verloren. Du müsstest die Dateien neu wählen.'}
      </p>
    </Dialog>
  );
}

function AlbumCard({ album: a, problems, hints, single, recording = false }: { album: ImportAlbum; problems: Problem[]; hints: Problem[]; single: boolean; recording?: boolean }) {
  const sess = session.value;
  const [open, setOpen] = useState(single || a.append);
  const [health, setHealth] = useState(false);
  const { count, exact } = trackCountOf(a);
  const convert = a.tracks.filter((t) => !isPlayableAsIs(t)).length;
  const reasons = a.unchanged ? [] : a.tracks.map(rebuildOf);
  const damaged = reasons.filter((r) => r === 'damaged').length;
  const joined = reasons.filter((r) => r === 'joined').length;
  const rebuilt = damaged + joined;
  // Long files, and a whole album in one file cut at its tracks.
  const long = a.tracks.filter(isCuttable);
  const bytes = albumBytesOf(a, settings.value.bitrateKbps);
  const existingCover = a.append ? coverUrlFor(a.target) : undefined;
  // Onto a folder chosen in the folder choice (not from the folder's page): the choice stays, to go back to a new folder.
  const chosenAppend = a.append && !sess.forFolder;
  // Onto a folder: its name, not the album's from the files.
  const title = shownTitle(a);
  // A folder that has a cover keeps it; a new album, or a folder without one, gets the picture chosen here.
  const canChangeCover = !existingCover;
  // Adding to a folder without a cover: the picture came with the new files, and goes to the folder unless you say no.
  const fromNewFiles = a.append && canChangeCover && !!a.coverUrl && !a.coverFrom;
  // Extra "Mehr als 99 Hörspiele": an album onto a folder is an episode there, with a name of its own and the titles it takes.
  const episode = (settings.value.episodePlanner || !!sess.packed?.some((p) => p.folder === a.target)) && chosenAppend;
  const range = episode ? plannedRanges(sess, card.value!.scan!).get(a.id) : undefined;
  const [searching, setSearching] = useState(false);

  const pickCover = async () => {
    const [file] = await plat().pickFiles({ multiple: false, extensions: ['jpg', 'jpeg', 'png', 'webp'] });
    if (!file) return;
    const data = await file.read(0, file.size);
    const ext = file.name.toLowerCase().split('.').pop();
    setCoverFor(a.id, { data, mimeType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' }, { source: 'Datei' });
  };

  return (
    <section class={`card import-album ${problems.length ? 'has-problem' : ''}`} aria-label={`${recording ? 'Aufnahme' : 'Album'} ${a.title}`}>
      <div class="import-album-head">
        <div class="import-cover-col">
          <button type="button" class="import-cover" onClick={canChangeCover ? pickCover : undefined} title={canChangeCover ? 'Anderes Bild wählen' : undefined} disabled={!canChangeCover}>
            <Cover url={existingCover ?? a.coverUrl} title={title} seed={a.target || 1} number={a.target ? folderName(a.target) : undefined} />
            {canChangeCover ? (
              <span class="import-cover-edit">
                <Bild size={18} />
              </span>
            ) : null}
          </button>
          {/* The sticker in its colour stands in until there is a picture: say so, so it is not taken for the cover. */}
          {!a.coverUrl && !existingCover ? <span class="tiny muted import-cover-note">noch kein Cover</span> : null}
          {canChangeCover ? (
            <Button size="sm" variant="soft" icon={Search} title="Cover suchen" aria-label="Cover suchen" onClick={() => setSearching(true)}>
              Suchen
            </Button>
          ) : null}
          {fromNewFiles ? (
            <>
              <span class="tiny muted">Bild aus den neuen Titeln</span>
              <button type="button" class="link-button small" onClick={() => setCoverFor(a.id, undefined)}>
                Ohne Bild
              </button>
            </>
          ) : null}
        </div>
        <div class="stack grow import-album-info" style={{ gap: 6, minWidth: 0 }}>
          {episode ? (
            <WrapInput class="album-title" value={a.title} label="Name der Folge" placeholder="Name der Folge" onValue={(title) => updateAlbum(a.id, { title })} />
          ) : recording && !a.append ? (
            <WrapInput class="album-title" value={a.title} label="Name der Aufnahme" onValue={(title) => updateAlbum(a.id, { title })} />
          ) : a.append ? (
            <h2 class="import-album-title">{title}</h2>
          ) : (
            <>
              {/* Every keystroke counts at once: files that arrive meanwhile do not undo it. Long titles wrap, also on a phone. */}
              <WrapInput class="album-title" value={a.title} label="Titel des Albums" onValue={(title) => updateAlbum(a.id, { title })} />
              <WrapInput value={a.artist ?? ''} placeholder="Interpret oder Autor" label="Interpret oder Autor" onValue={(artist) => updateAlbum(a.id, { artist: artist || undefined })} />
            </>
          )}
          <div class="row wrap" style={{ gap: 10, marginTop: 2 }}>
            {recording ? (
              <RecordingTarget album={a} />
            ) : a.append && !chosenAppend ? (
              // The number only when the title does not say it already.
              title !== `Ordner ${folderName(a.target)}` ? <span class="badge brand">Ordner {folderName(a.target)}</span> : null
            ) : (
              <TargetSelect album={a} />
            )}
            {a.append ? null : (
              <label class="row small" style={{ gap: 8 }}>
                Art
                <select class="select compact" value={a.kind} aria-label="Art" onChange={(e) => updateAlbum(a.id, { kind: e.currentTarget.value as ContentKind })}>
                  {CONTENT_KINDS.map((k) => (
                    <option value={k.id}>{k.label}</option>
                  ))}
                </select>
              </label>
            )}
            <span class="small muted">
              {exact ? '' : 'etwa '}
              {plural(count, 'Titel', 'Titel')}
              {a.durationSec ? ` · ${formatDuration(a.durationSec, { long: true })}` : ''} · {formatBytes(bytes)}
            </span>
          </div>
          {chosenAppend ? (
            <span class="small muted">
              {count === 1 && exact ? 'Dieser Titel kommt' : `Diese ${exact ? '' : 'etwa '}${count} Titel kommen`} hinten an Ordner {folderName(a.target)}
              {range ? `, als ${range.exact ? '' : 'etwa '}${rangeName(range.first, range.last)}. Die Karte für diese Folge machst du danach auf der Seite des Ordners.` : '.'}
            </span>
          ) : a.append ? null : (
            <KindNote kind={a.kind} />
          )}
          <FromSourcesLine tracks={a.tracks} />
        </div>
        <div class="row import-album-actions" style={{ alignSelf: 'flex-start' }}>
          <IconButton label={open ? 'Titel ausblenden' : 'Titel anzeigen'} icon={open ? WinkelHoch : Winkel} onClick={() => setOpen(!open)} />
          {!a.append || chosenAppend || sess.albums.length > 1 ? <IconButton label="Weglassen" icon={Kreuz} onClick={() => removeAlbum(a.id)} /> : null}
        </div>
      </div>

      {problems.length ? (
        <div class="import-notes">
          {problems.map((p) => (
            <Callout tone="danger" key={p.text}>
              <div class="stack tight">
                <span>{p.text}</span>
                {p.helper && card.value?.report ? (
                  // Puts the files back right here; the review then checks again.
                  <Button size="sm" icon={Wrench} class="import-problem-action" onClick={() => setHealth(true)}>
                    Ansehen und reparieren
                  </Button>
                ) : null}
              </div>
            </Callout>
          ))}
        </div>
      ) : null}
      {health && card.value?.report ? <HealthDialog onClose={() => setHealth(false)} /> : null}
      {searching ? <CoverSearchDialog album={a} onClose={() => setSearching(false)} /> : null}
      {hints.length ? (
        <div class="import-notes">
          {hints.map((p) => (
            <Callout tone="warning" key={p.text}>
              <div class="stack tight">
                <span>{p.text}</span>
                {p.inside ? null : (
                  <Button size="sm" icon={X} class="import-problem-action" onClick={() => removeAlbum(a.id)}>
                    Weglassen
                  </Button>
                )}
              </div>
            </Callout>
          ))}
        </div>
      ) : null}

      {albumWantsLookup(a) ? (
        <div class="import-notes">
          <NameLookup album={a} />
        </div>
      ) : null}
      <AlbumCutNote album={a} />
      {settings.value.announceTitles && !a.unchanged ? (
        <div class="import-notes">
          <AnnounceChoice album={a} />
        </div>
      ) : null}
      {long.length || convert || rebuilt || a.part || a.resume || a.unchanged ? (
        <div class="import-notes">
          {a.resume ? (
            <div class="import-note">
              <span>Der Anfang ist schon in Ordner {folderName(a.target)}. Hier steht nur, was noch fehlt.</span>
            </div>
          ) : null}
          {a.unchanged ? <UnchangedNote tracks={a.tracks} /> : long.length ? <SplitBox album={a} long={long} /> : null}
          {convert ? (
            <div class="import-note">
              <span>
                {convert === a.tracks.length ? (a.tracks.length === 1 ? 'Die Datei wird' : 'Alle Dateien werden') : `${plural(convert, 'Datei wird', 'Dateien werden')}`} in MP3 umgewandelt.
              </span>
            </div>
          ) : null}
          {rebuilt ? (
            <div class="import-note">
              <span>
                {rebuildNote(damaged, joined)}
              </span>
            </div>
          ) : null}
          {a.part ? (
            <div class="import-note">
              <span>
                Teil {a.part.index} von {a.part.of}: Ein Ordner fasst höchstens 255 Titel, darum verteile ich das Album auf {a.part.of} Ordner.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {open ? <TrackTable album={a} /> : null}
    </section>
  );
}

/** The extra "Titelansagen" for an album: a tick in the desktop app, a word on where it works in the browser. */
function AnnounceChoice({ album: a }: { album: ImportAlbum }) {
  const v = voice.value;
  useEffect(() => void lookForVoice(), []);
  if (v?.kind === 'web') {
    return (
      <div class="import-note">
        <span>
          {WEB_VOICE_TEXT} <DesktopAppLink />
        </span>
      </div>
    );
  }
  const fromSources = a.tracks.some((t) => t.origin);
  return (
    <div class="import-note announce-choice">
      <div class="stack tight">
        <label class="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={!!a.announce && v?.kind === 'ready'} disabled={v?.kind !== 'ready'} onChange={(e) => updateAlbum(a.id, { announce: e.currentTarget.checked })} />
          <span>Titel ansagen. Vor jeden Titel kommt sein Name, gesprochen von der Stimme des Computers.</span>
        </label>
        {v?.kind === 'none' ? (
          <span>
            {v.text}{' '}
            <button type="button" class="link-button" onClick={() => void lookForVoice(true)}>
              Noch einmal suchen
            </button>
          </span>
        ) : null}
        {v?.kind === 'ready' && v.note && a.announce ? <span class="muted">{v.note}</span> : null}
        {fromSources && a.announce ? <span class="muted">Titel aus „Entdecken“ bleiben ohne Ansage, so wie sie veröffentlicht wurden.</span> : null}
      </div>
    </div>
  );
}

/**
 * What a card for the album does, as the kind sets it (the folder page can
 * change it later). Without the mode's name: a Hörspiel plays as "Hörbuch".
 */
function KindNote({ kind }: { kind: ContentKind }) {
  const tagline = MODES.find((m) => m.code === defaultModeFor(kind))?.tagline;
  return tagline ? <span class="small muted">Die Karte {tagline.charAt(0).toLowerCase() + tagline.slice(1)}</span> : null;
}

/** The online cover search for an album in the review: the picture waits with the album and goes to the card with it. */
function CoverSearchDialog({ album: a, onClose }: { album: ImportAlbum; onClose: () => void }) {
  // The artist only when the title does not say it already.
  const query = buildFolderQuery({ title: a.title, artist: a.artist }) || a.title;
  return (
    <Dialog title="Cover suchen" width="wide" bodyClass="cover-dialog-body" onClose={onClose} footer={<Button onClick={onClose}>Abbrechen</Button>}>
      <div class="stack cover-dialog">
        <div class="cover-dialog-main">
          <div class="cover-dialog-pick">
            <CoverSearch
              initialQuery={query}
              onPick={async (blob, source, kind, hit) => {
                try {
                  // The album of the cover also has a track list: a whole album in one file can be cut at it (TODO 0.5 #81).
                  setCoverFor(a.id, { data: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type || 'image/jpeg' }, { source, kind, hit: { id: hit.id, edition: hit.edition } });
                  onClose();
                } catch (e) {
                  toastError('Das Bild lässt sich nicht laden', e);
                }
              }}
            />
          </div>
        </div>
        <Callout tone="neutral">Cover sind urheberrechtlich geschützt. Nutze sie nur für deine eigenen Karten und gib sie nicht weiter.</Callout>
      </div>
    </Dialog>
  );
}

/**
 * Where a recording goes, as one question: a new folder, or onto a folder
 * that is there, by its name (the numbers alone mean little to someone who
 * just read a story aloud).
 */
function RecordingTarget({ album: a }: { album: ImportAlbum }) {
  const s = card.value!;
  const waiting = waitingFolders(s.scan!);
  const free = freeFolderNumbers(s.scan!).filter((n) => !waiting.has(n));
  // The next free number, or the one chosen before (also when going back from a folder).
  const fresh = !a.append && a.target ? a.target : (free[0] ?? 0);
  const existing = s.scan!.folders.filter((f) => !waiting.has(f.number));
  return (
    <label class="stack tight recording-target">
      <span>In einen neuen Ordner oder zu einem vorhandenen dazu?</span>
      <select
        class="select"
        value={a.append ? `a${a.target}` : String(fresh)}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (v.startsWith('a')) updateAlbum(a.id, { target: Number(v.slice(1)), append: true });
          else updateAlbum(a.id, { target: Number(v), append: false });
        }}
      >
        {fresh ? <option value={String(fresh)}>In einen neuen Ordner ({folderName(fresh)})</option> : <option value="0">Kein Ordner frei</option>}
        {existing.map((f) => (
          <option value={`a${f.number}`}>
            Zu „{shorten(s.catalog?.folders[f.name]?.title ?? `Ordner ${f.name}`, 40)}“ dazu ({f.name})
          </option>
        ))}
      </select>
    </label>
  );
}

function TargetSelect({ album: a }: { album: ImportAlbum }) {
  const s = card.value!;
  const sess = session.value;
  const used = new Set(sess.albums.filter((x) => x.id !== a.id && !x.append).map((x) => x.target));
  // Numbers whose files wait in the helper folder are not free.
  const waiting = waitingFolders(s.scan!);
  const free = freeFolderNumbers(s.scan!).filter((n) => (!used.has(n) && !waiting.has(n)) || n === a.target);
  const existing = s.scan!.folders;
  const value = a.append ? `a${a.target}` : String(a.target);
  // The next new folder first, then the folders already there by name, the other free numbers last:
  // 52 empty numbers before „01 · Konzert am Herd“ made appending a long scroll (audit 0.4 #8).
  const fresh = !a.append && a.target ? a.target : (free[0] ?? 0);
  const others = free.filter((n) => n !== fresh);
  return (
    <select
      class="select compact import-target"
      aria-label="Ordner auf der SD-Karte"
      value={value}
      onChange={(e) => {
        const v = e.currentTarget.value;
        if (v.startsWith('a')) updateAlbum(a.id, { target: Number(v.slice(1)), append: true });
        else updateAlbum(a.id, { target: Number(v), append: false });
      }}
    >
      {!a.target ? <option value="0">Kein Ordner frei</option> : null}
      {fresh ? <option value={String(fresh)}>Neuer Ordner ({folderName(fresh)})</option> : null}
      {a.append && !existing.some((f) => f.number === a.target) ? (
        // Onto a folder that an album before this one makes in the same transfer (extra "Mehr als 99 Hörspiele").
        <optgroup label="Hinten an einen neuen Ordner">
          <option value={`a${a.target}`}>Ordner {folderName(a.target)} (neu)</option>
        </optgroup>
      ) : null}
      {existing.length ? (
        <optgroup label="An vorhandenen Ordner anhängen">
          {existing.map((f) => {
            // Its files wait in the helper folder: it takes nothing until they are back (the album card says how).
            const blocked = waiting.has(f.number) && !(a.append && a.target === f.number);
            return (
              <option value={`a${f.number}`} disabled={blocked}>
                {f.name} · {shorten(s.catalog?.folders[f.name]?.title ?? `Ordner ${f.name}`)}
                {waiting.has(f.number) ? ' (erst reparieren)' : ''}
              </option>
            );
          })}
        </optgroup>
      ) : null}
      {others.length ? (
        <optgroup label="Andere freie Nummer">
          {others.map((n) => (
            <option value={String(n)}>Neuer Ordner {folderName(n)}</option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}

/** A folder's title in the folder choice: long ones end in "…", so the list stays narrow. */
function shorten(title: string, max = 28): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

/** Why an MP3 is made anew, as the review shows it. */
function rebuildOf(t: DraftTrack): 'damaged' | 'joined' | undefined {
  return isPlayableAsIs(t) ? t.info?.mp3Check?.rebuild : undefined;
}

/** The reason in a few words, under the file's name. */
const REBUILD_REASON = {
  damaged: 'Hat beschädigte Stellen',
  joined: 'Aus mehreren Dateien zusammengesetzt',
} as const;

const REBUILD_TITLE = {
  damaged: 'Die Datei hat beschädigte Stellen. Ich wandle sie neu um, damit die Box nicht hängen bleibt.',
  joined: 'Die Datei ist aus mehreren Dateien zusammengesetzt. Ich wandle sie neu um, damit die Box nicht aussetzt.',
} as const;

const SPLIT_MINUTES = [3, 5, 8, 10, 15, 20, 30];

function SplitBox({ album: a, long }: { album: ImportAlbum; long: DraftTrack[] }) {
  const { count, exact } = trackCountOf(a);
  const chapters = long.every((t) => (t.info?.chapters?.length ?? 0) > 1);
  const longest = Math.max(...long.map((t) => t.info?.durationSec ?? 0));
  // A whole album in one file whose tracks are known (AlbumCut.tsx).
  const whole = long.find(hasAlbumCuts);
  const options: { value: SplitMode; label: string }[] = [
    ...(whole ? [{ value: 'tracks' as const, label: 'An den Albumtiteln' }] : []),
    ...(chapters ? [{ value: 'chapters' as const, label: 'An den Kapiteln' }] : []),
    ...(long.some(isLongTrack) ? [{ value: 'pauses' as const, label: 'An Sprechpausen' }] : []),
    { value: 'none', label: 'Nicht teilen' },
  ];
  const atTracks = whole && a.split === 'tracks' ? whole.albumCuts : undefined;
  // Parts of a file are on the card already: the rest has to be cut the same way.
  const started = long.map((t) => a.resume?.parts.get(t.source)).find((p) => p !== undefined);
  return (
    <div class="split-box">
      <div class="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div class="stack tight grow">
          <strong>
            {whole && long.length === 1
              ? `Ein ganzes Album in einer Datei (${formatDuration(longest, { long: true })})`
              : long.length === 1
                ? `Eine lange Datei (${formatDuration(longest, { long: true })})`
                : `${long.length} lange Dateien (bis ${formatDuration(longest, { long: true })})`}
          </strong>
          <span class="small soft">
            {atTracks
              ? `Ich teile es in die ${atTracks.tracks.length} Titel, wie ${atTracks.from === 'Cue-Datei' ? 'die Cue-Datei' : atTracks.from} sie auflistet. Jeder Schnitt liegt in der Pause zwischen zwei Titeln.`
              : 'Die Box merkt sich nur, bei welchem Titel ihr wart, nicht die Minute. Kürzere Titel helfen beim Weiterhören.'}
          </span>
          {atTracks && whole && !a.resume?.parts.has(whole.source) ? <AlbumCutsButton album={a} track={whole} /> : null}
        </div>
      </div>
      {started ? (
        <span class="small">
          {started.done === 1 ? 'Der erste' : `Die ersten ${started.done}`} von {started.of} Teilen {started.done === 1 ? 'ist' : 'sind'} schon auf der Karte. Die übrigen werden genauso geteilt.
        </span>
      ) : (
        <div class="row wrap" style={{ gap: 16 }}>
          <Segmented<SplitMode> label="Teilen" value={a.split} options={options} onChange={(split) => updateAlbum(a.id, { split })} />
          {a.split === 'pauses' ? (
            <label class="row small" style={{ gap: 8 }}>
              Titel etwa
              <select class="select compact" value={a.splitMinutes} onChange={(e) => updateAlbum(a.id, { splitMinutes: Number(e.currentTarget.value) })}>
                {SPLIT_MINUTES.map((m) => (
                  <option value={m}>{m}</option>
                ))}
              </select>
              Minuten lang
            </label>
          ) : null}
          {a.split !== 'none' ? (
            <span class="small muted">
              ergibt {exact ? '' : 'etwa '}
              {plural(count, 'Titel', 'Titel')}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TrackTable({ album: a }: { album: ImportAlbum }) {
  const s = card.value!;
  const existing = a.append ? s.scan!.folders.find((f) => f.number === a.target) : undefined;
  const start = existing ? Math.max(0, ...existing.tracks.map((t) => t.number)) + 1 : 1;
  // Cut files have no number of their own yet.
  const anyCut = a.tracks.some((t) => isSplit(a, t));
  const { listen, toggle, stop, isPlaying } = useListen();
  const keyOf = (t: DraftTrack) => t.source.relativePath ?? t.source.name;
  // "Weglassen" on the track that plays takes its buttons away: the sound goes too.
  useEffect(() => {
    if (listen && !a.tracks.some((t) => keyOf(t) === listen.key)) stop();
  }, [a.tracks, listen?.key]);
  // The list plays on into the next track, as the album stands when a track ends.
  const tracks = useRef(a.tracks);
  tracks.current = a.tracks;
  const listenTo = (t: DraftTrack): ListenNext => ({
    key: keyOf(t),
    load: async () => t.source,
    opts: {
      name: t.source.name,
      durationSec: t.info?.durationSec,
      next: () => {
        const n = after(tracks.current, keyOf(t), keyOf);
        return n ? listenTo(n) : null;
      },
    },
  });
  const play = (t: DraftTrack) => {
    const l = listenTo(t);
    return toggle(l.key, l.load, l.opts);
  };
  const move = (from: number, to: number) =>
    updateTracks(a.id, (list) => {
      const [x] = list.splice(from, 1);
      list.splice(to, 0, x);
      return list;
    });
  return (
    <div class="list import-tracks">
      {a.tracks.map((t, i) => {
        // The kind of file as parents know it (WAV, FLAC, M4A), not the codec inside ("PCM"); an MP3 that is none tells its codec.
        const ext = extensionOf(t.source.name);
        const codec = isPlayableAsIs(t) ? undefined : (ext && ext !== 'mp3' ? ext : (t.info?.codec ?? ext)).toUpperCase();
        const cut = isSplit(a, t);
        const started = a.resume?.parts.get(t.source);
        const rebuild = a.unchanged ? undefined : rebuildOf(t);
        return (
          <div class="list-row" key={`${t.source.relativePath ?? t.source.name}-${i}`}>
            <span class="mono muted" style={{ width: 34 }}>
              {anyCut ? '' : String(start + i).padStart(3, '0')}
            </span>
            <IconButton label={isPlaying(keyOf(t)) ? 'Anhalten' : 'Anhören'} icon={isPlaying(keyOf(t)) ? Pause : Play} size="sm" onClick={() => play(t)} />
            <div class="grow stack" style={{ gap: 0, minWidth: 0 }}>
              <WrapInput
                class="track-title"
                value={t.title}
                label={`Titel ${i + 1}`}
                onValue={(title) => updateTracks(a.id, (list) => list.map((x, k) => (k === i ? { ...x, title, titleAuto: undefined } : x)))}
              />
              <span class="tiny muted ellipsis" style={{ paddingLeft: 8 }} title={t.source.relativePath ?? t.source.name}>
                {t.titleAuto ? <span class="auto-title">automatisch erkannt · </span> : null}
                {t.source.relativePath ?? t.source.name}
              </span>
              {rebuild ? (
                // Visible on phones too, where the badge's title never shows.
                <span class="tiny" style={{ paddingLeft: 8, color: 'var(--warning-text)' }}>
                  {REBUILD_REASON[rebuild]}
                </span>
              ) : null}
              {listen?.key === keyOf(t) ? <AudioSeekBar audio={listen.audio} label={t.title || t.source.name} durationSec={listen.durationSec} onSeek={listen.seek} /> : null}
            </div>
            {codec !== undefined || cut || started || rebuild ? (
              // On phones these go below the title, which keeps its width.
              <span class="import-track-badges">
                {codec !== undefined ? (
                  <span class="badge" title="Wird in MP3 umgewandelt">
                    {codec}
                  </span>
                ) : null}
                {rebuild ? (
                  <span class="badge warning" title={REBUILD_TITLE[rebuild]}>
                    Wird neu erstellt
                  </span>
                ) : null}
                {cut ? <span class="badge accent">wird geteilt</span> : null}
                {started ? <span class="badge">ab Teil {started.done + 1}</span> : null}
              </span>
            ) : null}
            <span class="muted small nowrap import-track-duration">
              {formatDuration(listen?.key === keyOf(t) ? (listen.durationSec ?? t.info?.durationSec) : t.info?.durationSec)}
            </span>
            <MenuButton
              trigger={(openMenu) => <IconButton label="Mehr" icon={Mehr} size="sm" onClick={openMenu} />}
              items={[
                // With one title there is nowhere to move it: no "Nach oben/unten" (Frank 2026-10-17).
                ...(a.tracks.length > 1
                  ? [
                      { label: 'Nach oben', icon: Hoch, disabled: i === 0, onSelect: () => move(i, i - 1) },
                      { label: 'Nach unten', icon: Runter, disabled: i === a.tracks.length - 1, onSelect: () => move(i, i + 1) },
                    ]
                  : []),
                { label: 'Weglassen', danger: true, separatorBefore: a.tracks.length > 1, onSelect: () => updateTracks(a.id, (list) => list.filter((_, k) => k !== i)) },
              ]}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ writing */

const STEP_TEXT: Record<WriteStep, string> = {
  prepare: 'Wird vorbereitet',
  adjust: 'Lautstärke wird angepasst',
  convert: 'Wird umgewandelt',
  cut: 'Wird geschnitten',
  copy: 'Wird kopiert',
  check: 'Reihenfolge auf der Karte wird geprüft',
};

function WritingStep() {
  const w = session.value.write;
  const [stopping, setStopping] = useState(false);
  if (!w) return null;
  const percent = w.bytesTotal ? Math.min(100, Math.round((w.bytesDone / w.bytesTotal) * 100)) : 0;
  const album = session.value.albums.find((a) => a.target === w.folder);
  const packaged = card.value?.volume.access === 'snapshot';
  return (
    <div class="page narrow">
      <div class="card pad stack loose writing-card">
        <div class="stack tight">
          <span class="section-title">{packaged ? 'Paket wird vorbereitet' : 'Übertragung läuft'}</span>
          <h1 style={{ fontSize: 'var(--text-2xl)' }}>{w.step === 'check' ? 'Fast fertig …' : `${percent} %`}</h1>
          <p class="soft">{packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}</p>
        </div>
        <Progress value={w.step === 'check' ? 1 : w.bytesDone} max={w.step === 'check' ? 1 : Math.max(1, w.bytesTotal)} indeterminate={w.step === 'check'} />
        {w.step !== 'check' ? (
          <div class="row" style={{ gap: 16, alignItems: 'center' }}>
            <div class="writing-cover">
              <Cover url={album?.append ? (coverUrlFor(w.folder) ?? album.coverUrl) : album?.coverUrl} title={w.title} seed={w.folder} number={String(w.folder).padStart(2, '0')} color={catalog.value?.folders[String(w.folder).padStart(2, '0')]?.color} small />
            </div>
            <div class="stack tight grow" style={{ minWidth: 0 }}>
              <strong class="ellipsis">
                {w.title === `Ordner ${folderName(w.folder)}` ? w.title : `Ordner ${folderName(w.folder)} · ${w.title}`}
              </strong>
              <span class="small muted ellipsis">
                {w.albums > 1 ? `Album ${w.album + 1} von ${w.albums} · ` : ''}
                {w.step === 'prepare' ? (w.detail ?? STEP_TEXT.prepare) : `Titel ${w.track + 1} von ${w.tracks}: ${STEP_TEXT[w.step]}`}
              </span>
              {w.fraction !== undefined && w.step !== 'copy' ? <Progress value={w.fraction} max={1} /> : null}
            </div>
          </div>
        ) : null}
        <div class="row">
          <Button
            variant="ghost"
            loading={stopping}
            disabled={w.step === 'check'}
            onClick={() => {
              setStopping(true);
              cancelImport();
            }}
          >
            {stopping ? 'Hält nach diesem Titel an …' : 'Abbrechen'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ done */

/** The folder page, scrolled to „Folgen in diesem Ordner“ (EpisodesSection) as soon as it is drawn. */
function openEpisodes(folder: number) {
  navigate({ page: 'folder', folder });
  let tries = 0;
  const look = () => {
    const section = document.querySelector('.page-slot:not(.page-slot-hidden) #folgen');
    if (section) section.scrollIntoView({ block: 'start' });
    else if (++tries < 60) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

function EpisodesLink({ folder, children }: { folder: number; children: ComponentChildren }) {
  return (
    <a
      href={routeToHash({ page: 'folder', folder })}
      onClick={(e) => {
        e.preventDefault();
        openEpisodes(folder);
      }}
    >
      {children}
    </a>
  );
}

function DoneStep() {
  const sess = session.value;
  const r = sess.result;
  const s = card.value;
  const folders = r?.folders ?? [];
  const all = useMemo(() => [...folders, ...(r?.partial && !folders.includes(r.partial.folder) ? [r.partial.folder] : [])], [r]);
  const [discard, setDiscard] = useState(false);
  if (!r || !s) return null;
  const go = (page: 'cards' | 'stickers') => {
    selection.value = new Set(all);
    navigate({ page });
  };
  const ok = !r.error && !r.cancelled && !r.refused.length && !r.skipped.length;
  const notes = doneNotes(r);
  const unordered = unorderedNote(r);
  // What did not get to the card is still there: the transfer can go on.
  const rest = r.rest;
  const titleOf = (n: number) => s.catalog?.folders[folderName(n)]?.title ?? `Ordner ${folderName(n)}`;
  // Firefox, Safari: what was added waits for the Paket (until the card was checked).
  const packaged = s.volume.access === 'snapshot';
  const pkg = packageState.value.kind;
  const waits = packaged && pkg !== 'clean';
  const where = waits ? 'bereit fürs Paket' : 'auf der Karte';
  // Only titles for folders already there: also when chosen in the folder choice of the review.
  const added = !!sess.forFolder || (!!sess.albums.length && sess.albums.every((a) => a.append));
  // Appended as episodes (extra „Mehr als 99 Hörspiele“): a card for the folder would play them all, each episode gets its own.
  // Or several albums of a series into a new folder, from the offer of the review (PackOffer.tsx).
  const episodes = !sess.forFolder ? (r.episodes ?? []).filter((n) => added || sess.packed?.some((p) => p.folder === n)) : [];
  return (
    <div class="page narrow">
      <div class="stack" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 24 }}>
        <span class={`done-icon ${ok ? '' : 'warn'}`}>{ok ? <Haken size={40} /> : <Hinweis size={38} />}</span>
        <h1>
          {ok
            ? added
              ? `Die neuen Titel sind ${where}`
              : folders.length === 1
                ? `„${titleOf(folders[0])}“ ist ${where}`
                : `${folders.length} Alben sind ${where}`
            : r.cancelled
              ? packaged
                ? 'Vorbereiten abgebrochen'
                : 'Übertragung abgebrochen'
              : packaged
                ? 'Das Vorbereiten hat nicht ganz geklappt'
                : 'Die Übertragung hat nicht ganz geklappt'}
        </h1>
        {ok ? (
          <p class="soft">
            {waits
              ? pkg === 'downloaded'
                ? 'Entpacke das Paket auf die Karte und prüfe sie. Danach spielt die Box alles ab.'
                : 'Lade das Paket herunter und entpacke es auf die Karte. Danach spielt die Box alles ab.'
              : episodes.length
                ? (
                    <>
                      Jede neue Folge bekommt eine eigene Karte. Die machst du auf der Seite des Ordners unter{' '}
                      {episodes.length === 1 ? (
                        <EpisodesLink folder={episodes[0]}>„Folgen in diesem Ordner“</EpisodesLink>
                      ) : (
                        <>
                          „Folgen in diesem Ordner“:{' '}
                          {episodes.map((n, i) => (
                            <span key={n}>
                              {i ? ', ' : ''}
                              <EpisodesLink folder={n}>Ordner {folderName(n)}</EpisodesLink>
                            </span>
                          ))}
                        </>
                      )}
                      .
                    </>
                  )
                : added
                  ? `Karten für ${folders.length > 1 ? 'diese Ordner' : 'diesen Ordner'} spielen die neuen Titel gleich mit.`
                  : folders.length > 1
                  ? 'Jetzt fehlen nur noch Karten zum Auflegen. Und schöne Sticker.'
                  : 'Jetzt fehlt nur noch eine Karte zum Auflegen. Und ein schöner Sticker.'}
          </p>
        ) : null}
      </div>

      {!ok ? (
        <Callout tone={r.cancelled ? 'neutral' : 'danger'}>
          <div class="stack tight">
            {resultNotes(r, { packaged }).map((note) => (
              <span key={note}>{fixableLine(note)}</span>
            ))}
            {/* The card refused the files for lack of rights: get them here, then go on with the rest. */}
            {r.error ? <WriteFixButton error={r.error} /> : null}
            {r.skipped.length ? (
              <>
                <span>{r.skipped.length === 1 ? 'Diese Datei ließ sich nicht lesen und fehlt:' : 'Diese Dateien ließen sich nicht lesen und fehlen:'}</span>
                <ul class="small" style={{ margin: 0, paddingLeft: 18, textAlign: 'left' }}>
                  {r.skipped.slice(0, 50).map((f) => (
                    <li key={f.name}>
                      <span class="mono">{f.name}</span>: {f.reason}
                    </li>
                  ))}
                  {r.skipped.length > 50 ? <li>… und {r.skipped.length - 50} weitere</li> : null}
                </ul>
              </>
            ) : null}
          </div>
        </Callout>
      ) : null}
      {r.reordered.length && !packaged ? (
        <Callout tone="info">
          Ich hab die Reihenfolge in {foldersWords(r.reordered)} auf der Karte korrigiert, damit die Box die Titel richtig abspielt.
        </Callout>
      ) : null}
      {unordered ? (
        <Callout tone="warning">
          {unordered.text}
          {unordered.health ? (
            <>
              {' '}
              <a href="#/">Meine Box öffnen</a>
            </>
          ) : null}
        </Callout>
      ) : null}
      {notes.length ? (
        <Callout tone="info">
          <div class="stack tight">
            {notes.map((n, i) => (
              <div class="stack tight" key={i}>
                <span>{n.text}</span>
                {n.settings || n.folder || n.help ? (
                  <span class="row wrap" style={{ gap: '4px 16px' }}>
                    {n.settings ? <a href={routeToHash({ page: 'settings' })}>Einstellungen</a> : null}
                    {n.folder ? <a href={routeToHash({ page: 'folder', folder: n.folder })}>Ordner {folderName(n.folder)}</a> : null}
                    {n.help ? <a href={routeToHash({ page: 'help', topic: n.help })}>Mehr erfahren</a> : null}
                  </span>
                ) : null}
                {n.files?.length ? (
                  <ul class="small" style={{ margin: 0, paddingLeft: 18, textAlign: 'left' }}>
                    {n.files.slice(0, 20).map((f) => (
                      <li key={f} class="mono">
                        {f}
                      </li>
                    ))}
                    {n.files.length > 20 ? <li>… und {n.files.length - 20} weitere</li> : null}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </Callout>
      ) : null}

      {all.length ? (
        // Long names may take more lines here: "… (Teil 1)" and "… (Teil 2)" must not end the same.
        <div class="shelf done-shelf" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 180px))", justifyContent: "center" }}>
          {all.map((n) => (
            <a class="tile" href={`#/ordner/${folderName(n)}`} key={n}>
              {/* The same card as on the shelf of „Meine Box“, with its own frame. */}
              <div class="tile-cover sticker" data-frame-seed={n}>
                <ShelfSticker folder={n} title={titleOf(n)} />
                <span class="tile-num">{folderName(n)}</span>
              </div>
              <span class="tile-title">{titleOf(n)}</span>
            </a>
          ))}
        </div>
      ) : null}

      {r.junk?.length ? <JunkLeft files={r.junk} /> : null}

      {packaged ? <PendingChanges /> : <SafeRemoval />}

      <div class="row wrap" style={{ justifyContent: 'center' }}>
        {rest.length ? (
          <Button variant="primary" size="lg" icon={Upload} onClick={resumeImport}>
            {packaged ? 'Rest vorbereiten' : 'Rest übertragen'}
          </Button>
        ) : null}
        {sess.forFolder && ok ? (
          <Button variant={waits ? 'default' : 'primary'} size="lg" icon={ArrowLeft} onClick={() => navigate({ page: 'folder', folder: sess.forFolder! })}>
            Zum Ordner
          </Button>
        ) : episodes.length && ok ? (
          // The cards of the new episodes are made there; "Karte beschreiben" here would be one for the whole folder.
          episodes.length === 1 ? (
            <Button variant={rest.length || waits ? 'default' : 'primary'} size="lg" icon={ListOrdered} onClick={() => openEpisodes(episodes[0])}>
              Zu den Folgen
            </Button>
          ) : null
        ) : all.length ? (
          <>
            <Button variant={rest.length || waits ? 'default' : 'primary'} size="lg" icon={Nfc} onClick={() => go('cards')}>
              {all.length === 1 ? 'Karte beschreiben' : 'Karten beschreiben'}
            </Button>
            <Button size="lg" icon={Printer} onClick={() => go('stickers')}>
              Sticker drucken
            </Button>
          </>
        ) : null}
        {/* Once the Paket is downloaded, new folders wait for the card: no way into that wall from here. */}
        {canChangeCard() || rest.length ? (
          <Button size="lg" variant="ghost" icon={rest.length ? X : FolderPlus} onClick={() => (rest.length ? setDiscard(true) : resetImport(sess.forFolder))}>
            {rest.length ? 'Rest verwerfen' : all.length ? 'Noch mehr hinzufügen' : 'Andere Dateien wählen'}
          </Button>
        ) : null}
      </div>
      {discard ? <DiscardQuestion target={sess.forFolder} onClose={() => setDiscard(false)} /> : null}
    </div>
  );
}

/**
 * Hidden files that are still in the folders the transfer wrote to (from a
 * Mac, say): the player may count them as titles. The button removes exactly
 * the files listed, nothing else.
 */
function JunkLeft({ files }: { files: string[] }) {
  const [busy, setBusy] = useState(false);
  const folders = [...new Set(files.map((f) => f.split('/')[0]))];
  const where = folders.length === 1 ? `Ordner ${folders[0]}` : `den Ordnern ${folders.slice(0, -1).join(', ')} und ${folders[folders.length - 1]}`;
  return (
    <Callout tone="warning">
      <div class="stack tight">
        <span>
          In {where} {files.length === 1 ? 'liegt noch eine versteckte Datei' : `liegen noch ${files.length} versteckte Dateien`}. Der MP3-Player der Box kann sie als Titel mitzählen und spielt dann Rauschen oder die falsche Datei.
        </span>
        <ul class="small" style={{ margin: 0, paddingLeft: 18, textAlign: 'left' }}>
          {files.slice(0, 20).map((f) => (
            <li key={f} class="mono">
              {f}
            </li>
          ))}
          {files.length > 20 ? <li>… und {files.length - 20} weitere</li> : null}
        </ul>
        <span class="small">Beim Aufräumen lösche ich nur diese {files.length === 1 ? 'Datei' : 'Dateien'}. Deine Titel bleiben, wie sie sind.</span>
        <div>
          <Button
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await cleanImportJunk();
                const left = session.value.result?.junk?.length ?? 0;
                if (left) toast.error('Nicht alles ließ sich löschen', 'Die übrigen Dateien findest du im Gesundheitscheck unter „Meine Box“.');
                else toast.success('Versteckte Dateien entfernt.');
              } catch (e) {
                toastError('Aufräumen hat nicht geklappt', e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Jetzt aufräumen
          </Button>
        </div>
      </div>
    </Callout>
  );
}

/** The forum's most common mistake: pulling the card before everything is written. */
function SafeRemoval() {
  const s = card.value;
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  if (s.volume.canEject) {
    // The button stands next to the text, or below it where the text would get too narrow (phones).
    return (
      <div class="feature safe-removal">
        <span class="feature-icon">
          <SdAuswerfen size={22} />
        </span>
        <div class="safe-removal-body">
          <div class="stack tight safe-removal-text">
            <strong>Fertig für heute?</strong>
            <span class="small muted">Wirf die SD-Karte vor dem Herausziehen aus. Dann ist sicher alles gespeichert.</span>
          </div>
          <Button
            icon={SdAuswerfen}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const note = await ejectCard();
                toast.success('Du kannst die SD-Karte jetzt herausnehmen.', note);
              } catch (e) {
                toastError('Auswerfen hat nicht geklappt', e);
                setBusy(false);
              }
            }}
          >
            SD-Karte auswerfen
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div class="feature">
      <span class="feature-icon">
        <SdAuswerfen size={22} />
      </span>
      <div class="stack tight">
        <strong>Bevor du die Karte herausziehst</strong>
        <span class="small muted">
          Wirf sie zuerst aus: im Dateimanager mit einem Rechtsklick auf die Karte und „Auswerfen“, am Mac mit dem Pfeil neben dem Namen. Sonst kann es sein, dass die letzten Titel noch nicht ganz gespeichert sind.
        </span>
      </div>
    </div>
  );
}
