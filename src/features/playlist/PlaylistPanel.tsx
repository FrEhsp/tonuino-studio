import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ChevronDown,
  CircleCheck,
  CircleMinus,
  CircleQuestionMark,
  CircleX,
  ClipboardPaste,
  Download,
  FileAudio,
  FileText,
  FolderOpen,
  Info,
  ListMusic,
  ListOrdered,
  Repeat2,
  ShoppingBag,
  type LucideIcon,
} from 'lucide-preact';
import { libraryNameInfo } from '../../core/library/playlist/match';
import { SHOP_NOTE, shopLinks } from '../../core/library/playlist/shops';
import type { LibraryFile, TrackList } from '../../core/library/playlist/types';
import { MAX_LIST_ENTRIES } from '../../core/library/playlist/parse';
import { MAX_TRACKS } from '../../core/tonuino/sd';
import { session, trackCountOf } from '../add/session';
import { Button, Callout, Progress, Segmented, Spinner } from '../../ui/components/controls';
import { toastError, toastSaved } from '../../ui/components/Toast';
import { card, plat, platform } from '../../app/state';
import { plural } from '../../app/format';
import { ExternalLink } from '../sources/links';
import { missingFileName, missingListText, summaryText, type Row, type RowStatus } from './state';
import { playlist as p } from './store';
import './playlist.css';

const STATUS: Record<RowStatus, { icon: LucideIcon; text: string }> = {
  gefunden: { icon: CircleCheck, text: 'Gefunden' },
  pruefen: { icon: CircleQuestionMark, text: 'Bitte prüfen' },
  fehlt: { icon: CircleX, text: 'Fehlt' },
  weggelassen: { icon: CircleMinus, text: 'Weggelassen' },
  doppelt: { icon: Repeat2, text: 'Doppelt' },
};

/** True when the focus fell back to the page because the control that had it went away. */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body;
}

/** Moves the focus to an element of the panel, but only when the user's last control went away. */
function refocus(id: string) {
  if (focusLost()) document.getElementById(id)?.focus();
}

/**
 * "Nach einer Playlist zusammenstellen" on the add page: a track list (a
 * Spotify data export, CSV, M3U or text) gives the order, the user's own
 * files give the sound. Missing titles get searches at shops that sell
 * downloads without copy protection.
 */
export function PlaylistPanel({ folder }: { folder?: number }) {
  const open = p.open.value;
  const list = p.list.value;
  const hasLibrary = p.library.value.length > 0 || !!p.reading.value;
  const dropped = p.dropped.value;
  const section = useRef<HTMLElement>(null);
  const seen = useRef(dropped);
  // A list dropped on the page: the panel shows where it went (not again when the page is opened later).
  useEffect(() => {
    if (dropped === seen.current) return;
    seen.current = dropped;
    section.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    document.getElementById('playlist-toggle')?.focus({ preventScroll: true });
  }, [dropped]);
  return (
    <section ref={section} class="card web-import playlist-import" aria-labelledby="playlist-import-title">
      <div class="web-import-head playlist-head">
        <span class="web-import-icon" aria-hidden="true">
          <ListOrdered size={20} />
        </span>
        <div class="stack tight grow">
          <h2 id="playlist-import-title">
            <button type="button" id="playlist-toggle" class="playlist-toggle" aria-expanded={open} aria-controls="playlist-import-body" onClick={() => (p.open.value = !open)}>
              Nach einer Playlist zusammenstellen
            </button>
          </h2>
          <p class="small muted">Die Lieder liegen schon als Dateien auf deinem Computer? Dann nimm die Reihenfolge aus Spotify oder einer anderen Liste.</p>
        </div>
        <ChevronDown class="playlist-chevron" size={20} strokeWidth={2.2} aria-hidden="true" />
      </div>
      {open ? (
        <div id="playlist-import-body" class="stack loose">
          <ListStep />
          {list || hasLibrary ? <LibraryStep /> : null}
          {list && p.library.value.length ? <ResultStep list={list} folder={folder} /> : null}
          <p class="web-import-notice small muted">
            <Info size={15} aria-hidden="true" />
            <span>Aus der Liste lese ich nur Namen und Reihenfolge. Den Ton lade ich nicht von Spotify, Titel von dort sind kopiergeschützt und kommen nicht auf die Box.</span>
          </p>
        </div>
      ) : null}
    </section>
  );
}

function StepTitle({ n, children }: { n: number; children: string }) {
  return (
    <h3 class="playlist-step">
      <span class="playlist-step-num" aria-hidden="true">
        {n}
      </span>
      {children}
    </h3>
  );
}

/* ------------------------------------------------------------------ the list */

function ListStep() {
  const list = p.list.value;
  const lists = p.lists.value;
  const busy = p.busy.value;
  if (list) {
    return (
      <div class="stack tight">
        <StepTitle n={1}>Die Liste</StepTitle>
        <div class="web-import-summary">
          <span class="web-import-icon" aria-hidden="true">
            <ListMusic size={20} />
          </span>
          <div class="stack tight grow" style={{ minWidth: 0 }}>
            <strong class="web-import-clamp">{list.name}</strong>
            <span class="small muted">
              {plural(list.entries.length, 'Titel', 'Titel')} · {list.origin}
            </span>
          </div>
          <button type="button" class="link-button" disabled={busy} onClick={lists.length > 1 ? () => p.chooseList(undefined) : p.clearList}>
            Andere Liste
          </button>
        </div>
        <SkippedNote skipped={list.skipped - (list.truncated ?? 0)} truncated={list.truncated ?? 0} />
      </div>
    );
  }
  if (lists.length > 1) return <ChooseList lists={lists} />;
  return <PickList />;
}

/** Entries the app left out: no songs (podcast episodes, links, lines without a title), or more than it takes. */
function SkippedNote({ skipped, truncated }: { skipped: number; truncated: number }) {
  if (!skipped && !truncated) return null;
  return (
    <p class="small muted">
      {skipped
        ? skipped === 1
          ? 'Ein Eintrag bleibt weg, weil er kein Lied ist oder keinen Titel hat, zum Beispiel eine Podcast-Folge.'
          : `${skipped.toLocaleString('de-DE')} Einträge bleiben weg, weil sie keine Lieder sind oder keinen Titel haben, zum Beispiel Podcast-Folgen.`
        : null}
      {skipped && truncated ? ' ' : null}
      {truncated ? `Die Liste ist sehr lang. Ich nehme die ersten ${MAX_LIST_ENTRIES.toLocaleString('de-DE')} Titel.` : null}
    </p>
  );
}

function PickList() {
  const load = p.listLoad.value;
  const busy = p.busy.value;
  // Text pasted before ("Andere Liste" after a typo): the field shows it again.
  const [pasting, setPasting] = useState(() => !!p.pasted.peek().trim());
  const [error, setError] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // Back from a list: the focus goes to the start of the step; later, to the field when it opens.
    if (first.current) {
      first.current = false;
      refocus(pasting ? 'playlist-paste-text' : 'playlist-pick');
      return;
    }
    if (pasting) field.current?.focus();
  }, [pasting]);
  // The spinner took the place of the button: after a failed load, back to it.
  useEffect(() => {
    if (load.status === 'failed') refocus('playlist-pick');
  }, [load.status]);
  const submit = (e: Event) => {
    e.preventDefault();
    const message = p.readPasted();
    setError(message);
    if (message) field.current?.focus();
  };
  return (
    <div class="stack">
      <StepTitle n={1}>Die Liste</StepTitle>
      {load.status === 'failed' ? <Callout tone="danger">{load.message}</Callout> : null}
      {load.status === 'loading' ? (
        <div class="web-import-working">
          <Spinner size={18} />
          <span role="status">Liest die Liste …</span>
        </div>
      ) : (
        <div class="row wrap">
          <Button id="playlist-pick" variant="primary" icon={FileText} disabled={busy} onClick={() => void p.pickList()}>
            Titelliste auswählen
          </Button>
          <Button icon={ClipboardPaste} aria-expanded={pasting} aria-controls="playlist-paste" onClick={() => setPasting(!pasting)}>
            Titel einfügen
          </Button>
        </div>
      )}
      <p class="small muted">Die ZIP-Datei von Spotify, eine CSV- oder M3U-Datei oder einfach Text mit einem Titel pro Zeile.</p>
      {pasting ? (
        <form id="playlist-paste" class="stack tight" onSubmit={submit} noValidate>
          <label for="playlist-paste-text" class="small" style={{ fontWeight: 600 }}>
            Ein Titel pro Zeile, am besten „Künstler - Titel“
          </label>
          <textarea
            ref={field}
            id="playlist-paste-text"
            class="textarea playlist-paste"
            rows={6}
            spellcheck={false}
            placeholder={'Rolf Zuckowski - Wie schön, dass du geboren bist\nDetlev Jöcker - 1, 2, 3 im Sauseschritt'}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'playlist-paste-error' : undefined}
            value={p.pasted.value}
            onInput={(e) => {
              p.pasted.value = e.currentTarget.value;
              if (error) setError(undefined);
            }}
          />
          {error ? (
            <p id="playlist-paste-error" class="web-import-error" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" disabled={busy}>
              Übernehmen
            </Button>
          </div>
        </form>
      ) : null}
      <SpotifyHelp />
    </div>
  );
}

/** How to get the list out of Spotify: the data export of the account. */
function SpotifyHelp() {
  return (
    <details class="trouble playlist-help">
      <summary>
        <ListMusic size={18} strokeWidth={2.2} aria-hidden="true" />
        So bekommst du deine Spotify-Playlist
        <ChevronDown class="trouble-chevron" size={18} strokeWidth={2.2} aria-hidden="true" />
      </summary>
      <div class="playlist-help-body stack">
        <ol class="playlist-help-steps">
          <li>Öffne Spotify im Browser und melde dich an.</li>
          <li>Gehe zu „Konto“ und dann zu „Datenschutz“. Fordere dort deine „Kontodaten“ zum Herunterladen an.</li>
          <li>Spotify schickt dir gleich eine E-Mail. Bestätige darin die Anfrage, sonst passiert nichts.</li>
          <li>Nach einigen Tagen kommt eine zweite E-Mail mit einem Link. Lade darüber die ZIP-Datei herunter. Der Link gilt nur ein paar Tage.</li>
          <li>Wähle die ZIP-Datei hier mit „Titelliste auswählen“. Entpacken musst du sie nicht. Ich zeig dir alle Playlists darin.</li>
        </ol>
        <p class="small muted">Ist die ZIP-Datei schon entpackt (das macht Safari am Mac von selbst), wähle im Ordner die Datei „Playlist1.json“, für deine Lieblingssongs „YourLibrary.json“.</p>
        <p class="small muted">Andere Listen gehen auch: eine CSV-Datei aus einem Export-Programm, eine M3U-Playlist, oder du tippst die Titel einfach ab.</p>
      </div>
    </details>
  );
}

/** A Spotify export holds several lists: which one. */
function ChooseList({ lists }: { lists: TrackList[] }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) first.current?.focus();
  }, []);
  return (
    <div class="stack tight">
      <StepTitle n={1}>Die Liste</StepTitle>
      <p id="playlist-lists-question">In der Datei {lists.length === 2 ? 'stehen zwei Listen' : `stehen ${lists.length} Listen`}. Welche soll es sein?</p>
      {p.omittedLists.value ? <p class="small muted">Es sind noch mehr. Ich zeig die ersten {lists.length.toLocaleString('de-DE')}.</p> : null}
      <ul class="playlist-lists" aria-labelledby="playlist-lists-question">
        {lists.map((l, i) => (
          <li key={l.id}>
            <button type="button" class="playlist-list" ref={i ? undefined : first} onClick={() => p.chooseList(l.id)}>
              <ListMusic size={18} aria-hidden="true" />
              <span class="grow playlist-list-name">{l.name}</span>
              <span class="small muted nowrap">{plural(l.entries.length, 'Titel', 'Titel')}</span>
            </button>
          </li>
        ))}
      </ul>
      <div>
        <button type="button" class="link-button" onClick={p.clearList}>
          Andere Datei wählen
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the music */

function LibraryStep() {
  const count = p.library.value.length;
  const reading = p.reading.value;
  const note = p.libraryNote.value;
  const busy = p.busy.value;
  // Firefox asks before it hands a whole folder to a page.
  const asks = !!platform.value?.capabilities.sdPackage;
  // The list was just chosen, or the music read: on with the music, unless the result takes the focus.
  useEffect(() => {
    if (!reading && !p.matching.peek()) refocus('playlist-folder');
  }, [!!reading]);
  return (
    <div class="stack">
      <StepTitle n={2}>Deine Musik dazu</StepTitle>
      {reading ? (
        <div class="stack tight">
          <div class="web-import-working">
            <Spinner size={18} />
            <span class="grow" role="status">
              Sieht sich deine Musik an … {reading.done.toLocaleString('de-DE')} von {reading.total.toLocaleString('de-DE')} {reading.total === 1 ? 'Datei' : 'Dateien'}
            </span>
            <Button variant="ghost" onClick={p.cancelReading}>
              Abbrechen
            </Button>
          </div>
          <Progress value={reading.done} max={Math.max(1, reading.total)} label="Fortschritt beim Ansehen der Musik" />
        </div>
      ) : (
        <>
          <p class="small muted">
            {count
              ? `Ich kenne ${count === 1 ? 'eine Datei' : `${count.toLocaleString('de-DE')} Dateien`} von dir. Du kannst weitere dazunehmen.`
              : 'Wähle den Ordner, in dem deine Lieder liegen, zum Beispiel deine kopierten CDs. Ich lese Titel, Künstler und Länge aus den Dateien. Alles bleibt auf deinem Computer.'}
          </p>
          <div class="row wrap">
            <Button id="playlist-folder" variant={count ? 'default' : 'primary'} icon={FolderOpen} disabled={busy} onClick={() => void p.addLibrary(true)}>
              {count ? 'Weiteren Ordner' : 'Ordner auswählen'}
            </Button>
            <Button icon={FileAudio} disabled={busy} onClick={() => void p.addLibrary(false)}>
              {count ? 'Weitere Dateien' : 'Dateien auswählen'}
            </Button>
            {count ? (
              <button type="button" class="link-button" disabled={busy} onClick={p.clearLibrary}>
                Auswahl vergessen
              </button>
            ) : null}
          </div>
          {asks ? <p class="small muted">Fragt der Browser nach „Hochladen“? Keine Sorge, die Dateien bleiben auf deinem Computer.</p> : null}
          <p class="small muted">Wähle die Musik für die Liste über diese Knöpfe. Was du auf die Seite ziehst, kommt ohne die Reihenfolge der Liste dazu.</p>
        </>
      )}
      {/* Always there, so screen readers announce a note when it appears. */}
      <div role="status" aria-live="polite">
        {note ? <Callout tone={note.tone}>{note.text}</Callout> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the result */

type Filter = 'alle' | 'pruefen' | 'fehlt';

function ResultStep({ list, folder }: { list: TrackList; folder?: number }) {
  const matching = p.matching.value;
  const rows = p.rows.value;
  const s = p.summary.value;
  const [filter, setFilter] = useState<Filter>('alle');
  // The result replaces the spinner (or a control the user used): the summary takes the focus.
  useEffect(() => {
    if (p.matches.value) refocus('playlist-summary');
  }, [p.matches.value]);
  // Matching failed: the note under the music says so.
  if (!matching && !p.matches.value) return null;
  if (matching) {
    return (
      <div class="stack tight">
        <StepTitle n={3}>Abgleichen und übernehmen</StepTitle>
        <div class="web-import-working">
          <Spinner size={18} />
          <span role="status">Sucht die Titel der Liste in deiner Musik …</span>
        </div>
      </div>
    );
  }
  // The filters go by what the app found, not by the user's choices since: a row stays where it is while the user picks a file.
  const unsure = rows.filter((r) => r.status !== 'doppelt' && r.match.quality === 'unsicher');
  const none = rows.filter((r) => r.status !== 'doppelt' && r.match.quality === 'fehlt');
  const filters: { value: Filter; label: string }[] = [
    { value: 'alle', label: `Alle (${rows.length})` },
    ...(unsure.length ? [{ value: 'pruefen' as const, label: `Bitte prüfen (${unsure.length})` }] : []),
    ...(none.length ? [{ value: 'fehlt' as const, label: `Fehlt (${none.length})` }] : []),
  ];
  const active = filters.some((f) => f.value === filter) ? filter : 'alle';
  const shown = active === 'pruefen' ? unsure : active === 'fehlt' ? none : rows;
  return (
    <div class="stack">
      <StepTitle n={3}>Abgleichen und übernehmen</StepTitle>
      <p id="playlist-summary" class="playlist-summary" role="status" tabIndex={-1}>
        {summaryText(s)}.
      </p>
      {!s.found && !s.check ? (
        <Callout tone="warning">
          Zu keinem Titel der Liste passt eine deiner Dateien. Hast du den richtigen Ordner gewählt? Ich vergleiche Titel und Künstler in den Dateien mit der Liste.
        </Callout>
      ) : null}
      {s.doubles ? (
        <p class="small muted">
          {s.doubles === 1 ? 'Ein Titel steht doppelt in der Liste. Er kommt' : `${s.doubles} Titel stehen doppelt in der Liste. Sie kommen`} nur einmal in den Ordner.
        </p>
      ) : null}
      {s.missing ? (
        <Callout tone="neutral" icon={ShoppingBag}>
          {SHOP_NOTE}
        </Callout>
      ) : null}
      {filters.length > 1 ? <Segmented label="Welche Titel zeigen" value={active} options={filters} onChange={setFilter} /> : null}
      <ol class="playlist-rows" aria-label={`Titel aus „${list.name}“`}>
        {shown.map((r) => (
          <ResultRow key={r.match.entry.position} row={r} />
        ))}
      </ol>
      <TakeBar list={list} folder={folder} />
    </div>
  );
}

function StatusChip({ status }: { status: RowStatus }) {
  const { icon: Icon, text } = STATUS[status];
  return (
    <span class={`playlist-status is-${status}`}>
      <Icon size={15} strokeWidth={2.2} aria-hidden="true" />
      {text}
    </span>
  );
}

/** A file as the choice shows it: its title and artist, and its name. */
function optionLabel(f: LibraryFile): string {
  // Without tags the name says it all.
  if (!f.info?.title) return f.source.name;
  const named = libraryNameInfo(f);
  return `${named.artist ? `${named.title} – ${named.artist}` : named.title} (${f.source.name})`;
}

function ResultRow({ row }: { row: Row }) {
  const e = row.match.entry;
  const id = `playlist-file-${e.position}`;
  const value = row.chosen ? String(row.options.findIndex((o) => o.source === row.chosen!.source)) : 'none';
  return (
    <li class={`playlist-row is-${row.status}`}>
      <span class="playlist-pos">{e.position}</span>
      <div class="playlist-row-main">
        <div class="playlist-row-head">
          <span class="playlist-row-title">
            <strong>{e.title}</strong>
            {e.artists.length ? <span class="muted"> – {e.artists.join(', ')}</span> : null}
          </span>
          <StatusChip status={row.status} />
        </div>
        {row.status === 'doppelt' ? (
          <span class="small muted">Steht schon als Nr. {row.match.duplicateOf} in der Liste.</span>
        ) : row.options.length ? (
          <div class="playlist-file">
            <label for={id} class="small muted">
              Datei
            </label>
            <select
              id={id}
              aria-label={`Datei für Nr. ${e.position}: ${e.title}`}
              class="select compact playlist-select"
              value={value}
              onChange={(ev) => {
                const v = ev.currentTarget.value;
                p.choose(e.position, v === 'none' ? null : row.options[Number(v)]);
              }}
            >
              {row.options.map((o, i) => (
                <option key={i} value={String(i)}>
                  {optionLabel(o)}
                </option>
              ))}
              <option value="none">{row.status === 'fehlt' ? 'Keine Datei' : 'Nicht verwenden'}</option>
            </select>
          </div>
        ) : null}
        {row.status === 'pruefen' ? (
          <span class="small muted">Ich bin mir nicht ganz sicher, Name, Fassung oder Länge weichen etwas ab. Stimmt die Datei? Sonst wähle eine andere oder „Nicht verwenden“.</span>
        ) : null}
        {row.status === 'fehlt' ? <ShopLinks row={row} /> : null}
      </div>
    </li>
  );
}

function ShopLinks({ row }: { row: Row }) {
  const links = shopLinks(row.match.entry);
  if (!links.length) return null;
  return (
    <div class="playlist-shops small">
      <span class="muted">Als Download suchen:</span>
      {links.map((l) => (
        <ExternalLink key={l.shop} href={l.url} class="playlist-shop">
          {l.shop}
        </ExternalLink>
      ))}
    </div>
  );
}

function TakeBar({ list, folder }: { list: TrackList; folder?: number }) {
  const s = p.summary.value;
  const adding = p.adding.value;
  const error = p.addError.value;
  const save = async () => {
    try {
      const text = missingListText(list.name, p.rows.peek());
      // A plain type: the browser's save dialog refuses one with parameters.
      if (await plat().files.save(missingFileName(list.name), new Blob([text], { type: 'text/plain' }))) {
        toastSaved('Liste gespeichert', 'Du kannst sie später hier wieder wählen.');
      }
    } catch (e) {
      toastError('Speichern hat nicht geklappt', e);
    }
  };
  // Appending: the folder's tracks so far, and those already waiting to be added to it, count against the limit.
  const existing = folder ? card.value?.scan?.folders.find((f) => f.number === folder) : undefined;
  const sess = session.value;
  const waiting = folder && sess.forFolder === folder ? sess.albums.reduce((n, a) => n + trackCountOf(a).count, 0) : 0;
  const room = folder ? MAX_TRACKS - Math.max(0, ...(existing?.tracks.map((t) => t.number) ?? [])) - waiting : MAX_TRACKS;
  const tooMany = !!folder && s.taken > room;
  return (
    <div class="stack tight playlist-take">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {tooMany ? (
        <Callout tone="warning">
          {room > 0
            ? `In den Ordner passen noch ${plural(room, 'Titel', 'Titel')}, gewählt sind ${s.taken}. Lasse ${s.taken - room} weg („Nicht verwenden“) oder füge die Liste unter „Hinzufügen“ als neuen Ordner hinzu.`
            : 'In den Ordner passt kein Titel mehr. Füge die Liste unter „Hinzufügen“ als neuen Ordner hinzu.'}
        </Callout>
      ) : null}
      <p class="small muted">
        {folder
          ? 'Die Titel kommen hinten an den Ordner, in der Reihenfolge der Liste.'
          : s.taken > MAX_TRACKS
            ? `In einen Ordner passen ${MAX_TRACKS} Titel. Ich verteile die Liste auf mehrere Ordner.`
            : `Die Titel kommen in einen neuen Ordner „${list.name}“, in der Reihenfolge der Liste.`}{' '}
        {s.check ? 'Titel mit „Bitte prüfen“ kommen mit, wenn du nichts änderst. ' : null}
        Danach prüfst du alles wie gewohnt.
      </p>
      <div class="row wrap">
        <Button variant="primary" icon={CircleCheck} loading={adding} disabled={!s.taken || p.busy.value} onClick={() => void p.take()}>
          Übernehmen ({plural(s.taken, 'Titel', 'Titel')})
        </Button>
        {s.missing ? (
          <Button icon={Download} disabled={adding} onClick={() => void save()}>
            Liste der fehlenden Titel speichern
          </Button>
        ) : null}
        <Button variant="ghost" disabled={p.busy.value} onClick={p.reset}>
          Neu beginnen
        </Button>
      </div>
    </div>
  );
}
