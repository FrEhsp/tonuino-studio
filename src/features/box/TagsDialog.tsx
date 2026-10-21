/**
 * "Titel-Infos bearbeiten" on the folder page (TODO 0.3 #46): title,
 * artist, album and number of each track as they stand in the MP3 files,
 * artist and album for the whole folder at once, the rare fields behind
 * "Mehr". The app fills in what it can tell ("automatisch erkannt"), every
 * field can be changed, and saving writes small ID3 tags into the files on
 * the card. File names and numbers stay as they are.
 */
import { memo } from '../../ui/memo';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ChevronDown, ChevronUp, Search } from 'lucide-preact';
import type { BasicTags } from '../../core/audio/id3';
import {
  changedFiles,
  draftProblem,
  folderNamesAfter,
  noteRetagged,
  setFolderField,
  setTrackField,
  settled,
  suggestTags,
  validTrackNumber,
  validYear,
  withLookup,
  type FolderTagField,
  type TagDraft,
  type TagField,
  type TrackTagDraft,
  type TrackTagField,
} from '../../core/library/tagedit';
import { tidyName } from '../../core/library/tidy';
import { lookupAlbumTracks } from '../../core/library/tracklookup';
import { lookupFailureMessage, OFFLINE_MESSAGE } from '../../core/stickers/bulkcover';
import { isAbortError } from '../../core/stickers/image';
import { folderFingerprint } from '../../core/tonuino/catalog';
import { folderName, isOutOfOrder, type SdFolder } from '../../core/tonuino/sd';
import { card, rescan, updateCatalog } from '../../app/state';
import { writeGuard } from '../../app/writeguard';
import { plural } from '../../app/format';
import { Button, Callout, Field, IconButton, Progress } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast } from '../../ui/components/Toast';
import { noteWrittenTags, type TrackRow } from '../cards/trackTitles';
import { fixOrder, removeTwins } from '../add/session';
import { coverFetch } from './CoverSearch';
import { emptyEntry } from './shownRows';
import { failedFileLine, isMp3, readFolderTags, writeTagChanges, type TagWriteResult } from './tagWrite';
import { fixableLine, WriteAccessNotice, WriteFixButton } from './WriteAccessNotice';
import '../../ui/styles/tags.css';

const AUTO = 'automatisch erkannt';

/** The first few names, quoted, and how many more there are. */
function someFiles(names: readonly string[]): string {
  const quoted = names.map((n) => `„${n}“`);
  if (quoted.length > 3) return `${quoted.slice(0, 3).join(', ')} und ${quoted.length - 3} weiteren`;
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} und ${quoted[quoted.length - 1]}` : (quoted[0] ?? '');
}

function messageOf(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).trim();
  return m && !/[.!?“]$/.test(m) ? `${m}.` : m;
}

interface RowActions {
  edit: (index: number, key: TrackTagField, value: string) => void;
  toggle: (file: string) => void;
}

export function TagsDialog({
  folder,
  rows,
  title,
  artist,
  focus,
  onClose,
  beforeSave,
}: {
  folder: number;
  rows: TrackRow[];
  title: string;
  artist?: string;
  /** Opened from a track's menu: that track shows all its fields and gets the cursor. */
  focus?: string;
  onClose: () => void;
  beforeSave?: () => void;
}) {
  const s = card.value!;
  const name = folderName(folder);
  const packaged = s.volume.access === 'snapshot';
  // The rows as the dialog opened: names found meanwhile do not move fields under the cursor.
  const [shown] = useState(rows);
  const [reading, setReading] = useState<number | null>(0);
  const [current, setCurrent] = useState<Map<string, BasicTags>>(new Map());
  const [start, setStart] = useState<TagDraft | null>(null);
  const [draft, setDraft] = useState<TagDraft | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(focus ? [focus] : []));
  const body = useRef<HTMLFieldSetElement>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const [problem, setProblem] = useState<{ text: string; error: unknown } | null>(null);
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lookupCtrl = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const dir = await s.volume.root.dir(name);
        const tags = await readFolderTags(
          dir,
          shown.map((r) => r.file),
          { signal: ctrl.signal, onProgress: (n) => setReading(n) },
        );
        if (ctrl.signal.aborted) return;
        const d = suggestTags(
          shown.map((r) => ({ file: r.file, number: r.number, mp3: isMp3(r.file), tags: tags.get(r.file), title: r.title, titleAuto: r.titleAuto, untitled: r.untitled })),
          { title, artist },
        );
        setCurrent(tags);
        setStart(d);
        setDraft(d);
        setReading(null);
      } catch (e) {
        if (ctrl.signal.aborted || isAbortError(e)) return;
        setReading(null);
        setProblem({ text: `Die Infos ließen sich nicht lesen. ${messageOf(e)}`, error: e });
      }
    })();
    return () => {
      ctrl.abort();
      lookupCtrl.current?.abort();
    };
    // Read once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What went wrong shows where the eye is, also after scrolling down the list.
  const problemRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (problem) problemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [problem]);

  // Opened for one track: that one in view, its title ready to type.
  const ready = !!draft;
  useEffect(() => {
    if (!ready || !focus) return;
    const row = [...(body.current?.querySelectorAll<HTMLElement>('[data-file]') ?? [])].find((el) => el.dataset.file === focus);
    row?.scrollIntoView({ block: 'center' });
    row?.querySelector<HTMLInputElement>('input[data-title]')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const changes = useMemo(() => (draft ? changedFiles(draft, current) : []), [draft, current]);
  const invalid = draft ? draftProblem(draft) : undefined;
  const valid = !!draft && !invalid;
  const dirty = !!draft && !!start && draft !== start;
  const busy = !!saving;

  const act = useRef<RowActions>({} as RowActions).current;
  act.edit = (index, key, value) => setDraft((d) => (d ? setTrackField(d, index, key, value) : d));
  act.toggle = (file) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  const setFolder = (key: FolderTagField, value: string) => setDraft((d) => (d ? setFolderField(d, key, value) : d));

  /** Like "Im Internet suchen" over the list (TitleLookup): only on a click, never by itself. */
  const lookup = async () => {
    if (!draft) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      toast.error('Suche geht gerade nicht', OFFLINE_MESSAGE);
      return;
    }
    lookupCtrl.current?.abort();
    const c = (lookupCtrl.current = new AbortController());
    setSearching(true);
    const album = draft.album.value.trim() || title;
    try {
      const found = await lookupAlbumTracks({ album, artist: draft.artist.value.trim() || artist, durations: shown.map((r) => r.durationSec) }, { fetchFn: coverFetch, signal: c.signal });
      if (c.signal.aborted) return;
      if (!found) {
        toast.info(
          'Nichts Passendes gefunden',
          `Bei iTunes und MusicBrainz gibt es kein Album „${tidyName(album) ?? album}“ mit ${shown.length} Titeln in passender Länge. Du kannst die Infos selbst eintippen.`,
        );
        return;
      }
      // On top of what was typed while the search ran.
      const now = draftRef.current;
      if (!now) return;
      const r = withLookup(now, found);
      setDraft(r.draft);
      const any = r.titles || r.album || r.artist;
      const what = r.titles ? `${r.titles === 1 ? 'Ein Titelname' : `${r.titles} Titelnamen`} gefunden` : any ? 'Album gefunden' : 'Album gefunden, die Infos passen schon';
      toast.success(what, `Von ${found.source}. ${any ? `Die Vorschläge stehen als „${AUTO}“ da. Prüfe sie, bevor du speicherst.` : 'Geändert hat sich nichts.'}`);
    } catch (e) {
      if (c.signal.aborted || isAbortError(e)) return;
      toast.error('Suche hat nicht geklappt', lookupFailureMessage(e));
    } finally {
      if (lookupCtrl.current === c) setSearching(false);
    }
  };

  const save = async () => {
    if (!draft || !start || !changes.length || !valid) return;
    const before = card.value?.scan?.folders.find((x) => x.number === folder);
    if (!before) return;
    // The files get new contents: a track playing now would stop in the middle.
    beforeSave?.();
    stopRef.current = false;
    setStopping(false);
    setProblem(null);
    setSaving({ done: 0, total: changes.length });
    let result: TagWriteResult;
    try {
      const dir = await s.volume.root.dir(name);
      result = await writeGuard.during('tags', async () => {
        const r = await writeTagChanges(dir, changes, { stop: () => stopRef.current, onProgress: (done, total) => setSaving({ done, total }) });
        if (r.written.length) {
          try {
            await afterWrite(dir, before, r, draft, start);
          } catch (e) {
            // The files have their new infos; only the app's own list is behind.
            toast.error('Die Liste der App ist nicht aktuell', `Die Dateien haben die neuen Infos, aber ich konnte meine Liste nicht speichern. ${messageOf(e)}`);
          }
        }
        return r;
      });
    } catch (e) {
      setSaving(null);
      setProblem({ text: `Gespeichert wurde nichts. ${messageOf(e)}`, error: e });
      return;
    }
    setSaving(null);
    report(result);
  };

  /** Hidden twins away, the order on the card as before, the catalog and the folder page up to date. */
  const afterWrite = async (dir: Awaited<ReturnType<typeof s.volume.root.dir>>, before: SdFolder, r: TagWriteResult, d: TagDraft, first: TagDraft) => {
    await removeTwins(
      dir,
      r.written.map((w) => w.file),
    ).catch(() => undefined);
    let scan = await rescan().catch(() => undefined);
    // Some players play in the order the files lie on the card: a replaced file must not change it.
    if (!packaged && !isOutOfOrder(before.tracks)) {
      const now = scan?.folders.find((x) => x.number === folder);
      if (now && isOutOfOrder(now.tracks)) scan = (await fixOrder(s.volume.root, scan, [folder]).catch(() => undefined))?.scan ?? scan;
    }
    const after = scan?.folders.find((x) => x.number === folder);
    const sizes = new Map(r.written.map((w) => [w.file.toLowerCase(), w.size]));
    const afterPrint = after ? folderFingerprint(after) : folderFingerprint({ ...before, tracks: before.tracks.map((t) => ({ ...t, size: sizes.get(t.name.toLowerCase()) ?? t.size })) });
    const known = !!card.value?.catalog?.folders[name];
    const names = folderNamesAfter(card.value?.catalog?.folders[name]?.title, first, d);
    await updateCatalog(
      (c) => {
        const e = c.folders[name] ?? (c.folders[name] = emptyEntry(folder));
        noteRetagged(e, r.written, { fingerprint: { before: folderFingerprint(before), after: afterPrint }, names });
      },
      { touchFolders: known ? [] : [folder] },
    );
    noteWrittenTags(
      s.volume.id,
      name,
      r.written.map((w) => ({ file: w.file, oldSize: w.oldSize, size: w.size, title: w.tags.title, artist: w.tags.artist, albumArtist: w.tags.albumArtist })),
    );
    // Written: no longer a suggestion.
    const done = new Set(r.written.map((w) => w.file));
    setDraft((x) => (x ? settled(x, done) : x));
    // A second try writes only what is still different.
    setCurrent((m) => {
      const next = new Map(m);
      for (const w of r.written)
        next.set(w.file, { ...w.tags, track: w.tags.track === undefined ? undefined : String(w.tags.track), disc: w.tags.disc === undefined ? undefined : String(w.tags.disc) });
      return next;
    });
  };

  /** Says what happened, in plain words; a failure keeps the dialog open to try again. */
  const report = (r: TagWriteResult) => {
    const total = r.written.length + r.failed.length + r.skipped.length;
    if (!r.failed.length && !r.skipped.length) {
      toast.success(
        'Titel-Infos gespeichert',
        packaged ? `${plural(r.written.length, 'Datei kommt', 'Dateien kommen')} mit dem nächsten Paket auf die Karte.` : `${plural(r.written.length, 'Datei hat', 'Dateien haben')} die neuen Infos.`,
      );
      onClose();
      return;
    }
    if (!r.failed.length) {
      toast.info('Angehalten', `${r.written.length} von ${total} Dateien haben die neuen Infos. Die übrigen sind unverändert.`);
      onClose();
      return;
    }
    const first = r.failed[0];
    const parts = [
      r.written.length ? `${r.written.length} von ${total} Dateien haben die neuen Infos.` : 'Keine Datei hat die neuen Infos bekommen.',
      `Nicht geklappt hat es bei ${someFiles(r.failed.map((f) => f.file))}. ${fixableLine(failedFileLine(messageOf(first.error), r.written.length > 0, first.file))}`,
      r.skipped.length ? `${plural(r.skipped.length, 'weitere Datei ist', 'weitere Dateien sind')} unverändert.` : '',
      'Mit „Speichern“ versuchst du es noch einmal.',
    ];
    setProblem({ text: parts.filter(Boolean).join(' '), error: first.error });
  };

  const close = () => {
    if (!busy) onClose();
  };
  /** The field that stops saving in view, with the cursor in it: the year (opening „Mehr“) or a track's number. */
  const more = useRef<HTMLDetailsElement>(null);
  const showProblem = (file?: string) => {
    let input: HTMLInputElement | null | undefined;
    if (file === undefined) {
      if (more.current) more.current.open = true;
      input = more.current?.querySelector<HTMLInputElement>('input[data-year]');
    } else {
      const row = [...(body.current?.querySelectorAll<HTMLElement>('[data-file]') ?? [])].find((el) => el.dataset.file === file);
      input = row?.querySelector<HTMLInputElement>('input.tags-no');
    }
    input?.scrollIntoView({ block: 'center' });
    input?.focus();
  };
  const writable = draft?.tracks.some((t) => t.writable);

  return (
    <Dialog
      title="Titel-Infos bearbeiten"
      width="wide"
      onClose={close}
      // Typed fields are not thrown away by a click next to the dialog or Escape: "Abbrechen" does that.
      dismissable={!busy && !dirty}
      footer={
        saving ? (
          // Stops after the file that is being written: no file is left half done.
          <Button
            disabled={stopping}
            onClick={() => {
              stopRef.current = true;
              setStopping(true);
            }}
          >
            {stopping ? 'Hält an …' : 'Anhalten'}
          </Button>
        ) : (
          <>
            {invalid ? (
              // Why "Speichern" is grey, also when the field hides behind a closed „Mehr“.
              <span class="grow small tags-foot-note tags-invalid">
                {invalid.field === 'year' ? 'Das Jahr unter „Mehr“ braucht vier Ziffern, z. B. 2024.' : `Die Titelnummer bei „${invalid.file}“ darf nur aus Ziffern bestehen, z. B. 3 oder 3/12.`}{' '}
                <button type="button" class="link-button" onClick={() => showProblem(invalid.field === 'year' ? undefined : invalid.file)}>
                  Zeigen
                </button>
              </span>
            ) : draft ? (
              <span class="grow small muted tags-foot-note">
                {changes.length ? `Beim Speichern ${changes.length === 1 ? 'ändert sich eine Datei' : `ändern sich ${changes.length} Dateien`}.` : 'Noch keine Änderung.'}
              </span>
            ) : null}
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" disabled={!changes.length || !valid} onClick={save}>
              Speichern
            </Button>
          </>
        )
      }
    >
      <div class="stack">
        <p class="small muted">Diese Infos stehen in den MP3-Dateien. Manche Boxen und andere Programme zeigen sie an. Dateinamen und Nummern auf der Karte bleiben, wie sie sind.</p>
        <WriteAccessNotice />
        {packaged ? <p class="small muted">Die geänderten Dateien kommen mit dem nächsten Paket auf die Karte.</p> : null}
        {problem ? (
          <div ref={problemRef}>
            <Callout tone="danger">
              <div class="stack tight">
                <span>{problem.text}</span>
                <WriteFixButton error={problem.error} />
              </div>
            </Callout>
          </div>
        ) : null}
        {saving ? (
          <div class="stack tight">
            <span class="small">
              Speichere die Titel-Infos{packaged ? ' fürs Paket' : ''} … {saving.done} von {saving.total}.{' '}
              {packaged ? 'Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}
            </span>
            <Progress value={saving.done} max={saving.total} label="Titel-Infos speichern" />
          </div>
        ) : null}
        {reading !== null ? (
          <div class="stack tight">
            <span class="small">
              Lese die Infos aus den Dateien … {reading} von {shown.length}
            </span>
            <Progress value={reading} max={shown.length} label="Infos lesen" />
          </div>
        ) : draft ? (
          <fieldset class="tags-body stack" disabled={busy} ref={body}>
            {writable ? (
              <>
                <section class="stack tight">
                  <h3>Für alle Titel</h3>
                  <div class="tags-fields">
                    <FolderField label="Interpret" field={draft.artist} onValue={(v) => setFolder('artist', v)} />
                    <FolderField label="Album" field={draft.album} onValue={(v) => setFolder('album', v)} />
                  </div>
                  <details class="health-more small tags-more" ref={more}>
                    <summary>Mehr</summary>
                    <div class="tags-fields three">
                      <FolderField label="Album-Interpret" field={draft.albumArtist} onValue={(v) => setFolder('albumArtist', v)} />
                      <FolderField label="Jahr" field={draft.year} numeric year invalid={!validYear(draft.year.value)} hint="Vier Ziffern, z. B. 2024" onValue={(v) => setFolder('year', v)} />
                      <FolderField label="Genre" field={draft.genre} onValue={(v) => setFolder('genre', v)} />
                    </div>
                  </details>
                </section>
                <div class="row wrap tags-lookup">
                  <span class="grow small muted">
                    Fehlen Namen, oder ist die Schreibweise kaputt? Ich suche das Album bei iTunes und MusicBrainz und schlage Namen vor, wenn Anzahl und Längen passen.
                  </span>
                  <Button size="sm" icon={Search} onClick={lookup} disabled={searching}>
                    {searching ? 'Sucht …' : 'Im Internet suchen'}
                  </Button>
                </div>
              </>
            ) : (
              <Callout tone="neutral">In diesem Ordner gibt es keine MP3-Datei, deren Infos ich ändern kann.</Callout>
            )}
            <section class="stack tight">
              <h3>Titel</h3>
              <div class="list tags-tracks">
                {draft.tracks.map((t, i) => (
                  <TagRow key={t.file} t={t} i={i} title={shown[i]?.title ?? t.file} mp3={isMp3(t.file)} artist={draft.artist.value} album={draft.album.value} open={open.has(t.file)} act={act} />
                ))}
              </div>
            </section>
          </fieldset>
        ) : null}
      </div>
    </Dialog>
  );
}

function FolderField({ label, field, onValue, numeric, year, invalid, hint }: { label: string; field: TagField; onValue: (v: string) => void; numeric?: boolean; year?: boolean; invalid?: boolean; hint?: string }) {
  return (
    <Field
      label={label}
      hint={invalid ? <span class="tags-invalid">{hint}</span> : field.auto ? AUTO : field.mixed && !field.edited ? 'Bei jedem Titel anders. Bleibt so, bis du etwas einträgst.' : undefined}
    >
      <input
        class="input"
        value={field.value}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        inputMode={numeric ? 'numeric' : undefined}
        data-year={year ? '' : undefined}
        placeholder={field.mixed && !field.edited ? 'unterschiedlich' : undefined}
        onInput={(e) => onValue(e.currentTarget.value)}
      />
    </Field>
  );
}

/** What of a track the app filled in, for the line under its title. */
function autoNote(t: TrackTagDraft): string {
  const parts = [t.title.auto ? 'Titel' : '', t.track.auto ? 'Nummer' : '', t.artist?.auto ? 'Interpret' : '', t.album?.auto ? 'Album' : ''].filter(Boolean);
  if (!parts.length) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}`;
  return ` · ${AUTO}: ${list}`;
}

/** One track. Drawn again only when its own fields change, not on every key typed elsewhere. */
const TagRow = memo(function TagRow({
  t,
  i,
  title,
  mp3,
  artist,
  album,
  open,
  act,
}: {
  t: TrackTagDraft;
  i: number;
  title: string;
  mp3: boolean;
  artist: string;
  album: string;
  open: boolean;
  act: RowActions;
}) {
  const number = String(t.number).padStart(3, '0');
  if (!t.writable) {
    return (
      <div class="list-row tags-row">
        <span class="mono muted tags-no tags-no-text">{number}</span>
        <div class="grow stack" style={{ gap: 0, minWidth: 0 }}>
          <span class="ellipsis">{title}</span>
          <span class="tiny muted">
            {t.file} · {mp3 ? 'Die Datei lässt sich gerade nicht lesen. Sie bleibt, wie sie ist.' : 'Keine MP3-Datei. Ihre Infos ändere ich nicht.'}
          </span>
        </div>
      </div>
    );
  }
  const badNumber = !validTrackNumber(t.track.value);
  const ownArtist = t.artist?.value ?? artist;
  const ownAlbum = t.album?.value ?? album;
  return (
    <div class="list-row tags-row" data-file={t.file}>
      <input
        class="input tags-no"
        value={t.track.value}
        inputMode="numeric"
        aria-label={`Titelnummer von ${t.file}`}
        title="Titelnummer"
        aria-invalid={badNumber ? true : undefined}
        onInput={(e) => act.edit(i, 'track', e.currentTarget.value)}
      />
      <div class="grow stack" style={{ gap: 2, minWidth: 0 }}>
        <input class="input" data-title value={t.title.value} placeholder="Titel" aria-label={`Titel von ${t.file}`} onInput={(e) => act.edit(i, 'title', e.currentTarget.value)} />
        <span class="tiny muted">
          {t.file}
          {autoNote(t)}
          {t.artist && !open ? ' · eigener Interpret' : ''}
          {t.album && !open ? ' · eigenes Album' : ''}
          {badNumber ? <span class="tags-invalid"> · Nummer nur aus Ziffern, z. B. 3 oder 3/12</span> : null}
        </span>
        {open ? (
          <div class="tags-fields">
            <Field label="Interpret">
              <input class="input" value={ownArtist} aria-label={`Interpret von ${t.file}`} onInput={(e) => act.edit(i, 'artist', e.currentTarget.value)} />
            </Field>
            <Field label="Album">
              <input class="input" value={ownAlbum} aria-label={`Album von ${t.file}`} onInput={(e) => act.edit(i, 'album', e.currentTarget.value)} />
            </Field>
          </div>
        ) : null}
      </div>
      <IconButton label={open ? 'Interpret und Album ausblenden' : 'Interpret und Album dieses Titels'} icon={open ? ChevronUp : ChevronDown} size="sm" onClick={() => act.toggle(t.file)} />
    </div>
  );
});
