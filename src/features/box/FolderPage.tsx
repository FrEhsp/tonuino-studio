import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Combine,
  FolderInput,
  Ellipsis,
  GripVertical,
  ImagePlus,
  Megaphone,
  MegaphoneOff,
  Mic,
  Minimize2,
  Nfc,
  Pause,
  Play,
  Plus,
  Printer,
  Scissors,
  Tags,
  Trash2,
  Undo2,
  Volume2,
} from 'lucide-preact';
import { CONTENT_KINDS, folderChanges, folderFingerprint, forgetFolder, type Catalog, type CatalogFolder, type CatalogTrack, type ContentKind, type FolderCard } from '../../core/tonuino/catalog';
import { modeByCode } from '../../core/tonuino/modes';
import { planFix, planReorder } from '../../core/tonuino/repair';
import type { Issue } from '../../core/tonuino/health';
import { folderName, helperFolders } from '../../core/tonuino/sd';
import { Badge, Button, Callout, EmptyState, Field, IconButton, Progress, Segmented } from '../../ui/components/controls';
import { WrapInput } from '../../ui/components/WrapInput';
import { Cover, KIND_ICONS } from '../../ui/components/Cover';
import { Dialog } from '../../ui/components/Dialog';
import { AudioSeekBar } from '../../ui/components/SeekBar';
import { after, useListen, type Listening, type ListenNext } from '../../ui/useListen';
import { memo } from '../../ui/memo';
import { dragTarget } from '../../ui/dragTarget';
import { MenuButton } from '../../ui/components/Menu';
import { toast, toastError } from '../../ui/components/Toast';
import { navigate } from '../../app/router';
import { card, changeCovers, coverUrlFor, healthContext, platform, profile, recordingOffered, rescan, runRepair, selection, settings, stickerToEdit, updateCatalog, type RepairRun } from '../../app/state';
import { formatBytes, formatDuration, plural } from '../../app/format';
import { applyFolderCard, extraSelection, keepsFolderCard } from '../cards/items';
import { ModePicker } from '../cards/ModePicker';
import { useTrackInfo, type TrackRow } from '../cards/trackTitles';
import { TitleLookup, useNoteFindings, wantsLookup } from './TitleLookup';
import { OriginsSection } from '../sources/OriginsSection';
import { CoverDialog } from './CoverDialog';
import { ShelfCardSection } from '../covers/ShelfCardSection';
import { canChangeCard } from '../../app/pending';
import { PackageWaitingDialog } from './PackageWaitingGate';
import { buildFolderQuery } from '../../core/stickers/bulkcover';
import { applyShownRows, emptyEntry } from './shownRows';
import { TagsDialog } from './TagsDialog';
import { JoinDialog } from './JoinDialog';
import { TrimDialog } from './TrimDialog';
import { planJoin } from './trackEdit';
import { EpisodesSection } from './EpisodesSection';
import { AnnounceDialog } from './AnnounceDialog';
import { SoundDialog } from './SoundDialog';
import { formatOffset, levelNote, levelOffsetOf } from './levelOffset';
import { isMp3 } from './tagWrite';
import type { SoundJob } from './folderSound';
import { RecordDialog } from '../add/RecordDialog';
import { RenumberDialog, RenumberedNote, renumbering } from './RenumberDialog';


/** "Spielt der Reihe nach …" in the middle of a sentence. */
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** Firefox, Safari: on the card itself it happens when the user unpacks the Paket. */
const PACKAGE_NOTE = 'Bis dahin bleibt er auf der Karte. Willst du es dir anders überlegen, lies die Karte neu ein, bevor du das Paket herunterlädst.';

/** The first few names, quoted, and how many more there are. */
function someNames(names: string[]): string {
  const first = names
    .slice(0, 3)
    .map((n) => `„${n}“`)
    .join(', ');
  return names.length > 3 ? `${first} und ${names.length - 3} weitere` : first;
}

/** Before the files get new names: titles shown now stay with their tracks, even when they only came from the file name. */
function keepShownTitles(c: Catalog, folder: number, rows: Row[], replaced?: readonly string[]): void {
  applyShownRows(c, folder, rows, { replaced, fill: true });
}

export function FolderPage({ folder }: { folder: number }) {
  const s = card.value;
  if (!s || s.status !== 'ready' || !s.scan) {
    const reads = !platform.value?.capabilities.sd && platform.value?.capabilities.sdPackage;
    return (
      <div class="page narrow">
        {reads ? (
          <EmptyState title="Keine Karte eingelesen" actions={<Button onClick={() => navigate({ page: 'box' })}>Zu „Meine Box“</Button>}>
            Lies die Karte unter „Meine Box“ ein.
          </EmptyState>
        ) : (
          <EmptyState title="Keine SD-Karte ausgewählt" actions={<Button onClick={() => navigate({ page: 'box' })}>Zu „Meine Box“</Button>}>
            Wähle die SD-Karte unter „Meine Box“ aus, dann siehst du hier den Ordner.
          </EmptyState>
        )}
      </div>
    );
  }
  const name = folderName(folder);
  const f = s.scan.folders.find((x) => x.number === folder);
  const entry = s.catalog?.folders[name];
  // Given another number this moment: the app goes to the new one right away.
  if (!f && renumbering.value === folder) return <div class="page narrow" />;
  if (!f) {
    return (
      <div class="page narrow">
        <BackLink />
        <EmptyState
          title={entry ? `„${entry.title}“ fehlt auf der Karte` : `Ordner ${name} gibt es nicht`}
          actions={
            entry ? (
              <Button
                variant="danger"
                icon={Trash2}
                onClick={async () => {
                  await updateCatalog((c) => {
                    delete c.folders[name];
                  });
                  navigate({ page: 'box' });
                }}
              >
                Aus der Übersicht entfernen
              </Button>
            ) : null
          }
        >
          {entry ? 'Der Ordner wurde mit einem anderen Programm gelöscht oder umbenannt. Karten für diesen Ordner spielen nichts mehr ab.' : null}
        </EmptyState>
      </div>
    );
  }
  return <FolderView key={folder} folder={folder} />;
}

function BackLink() {
  return (
    <a class="back-link" href="#/">
      <ArrowLeft size={16} /> Meine Box
    </a>
  );
}

function FolderView({ folder }: { folder: number }) {
  const s = card.value!;
  const name = folderName(folder);
  const f = s.scan!.folders.find((x) => x.number === folder)!;
  const entry = s.catalog?.folders[name];
  const [coverOpen, setCoverOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renumber, setRenumber] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [closeGaps, setCloseGaps] = useState(false);
  /** Extras of the settings page: "Titelansagen" asked for in the menu (the list opens it), and "Aufnehmen". */
  const [announceAsk, setAnnounceAsk] = useState<'add' | 'remove' | null>(null);
  /** "Lautstärke anpassen" or "Kleiner machen" asked for in the menu (the list opens it, as the extras). */
  const [soundAsk, setSoundAsk] = useState<SoundJob | null>(null);
  /** Made quieter or louder on purpose (levelOffset.ts). */
  const offset = levelOffsetOf(entry);
  const [recording, setRecording] = useState(false);
  const title = entry?.title ?? `Ordner ${name}`;
  const { rows, done: tagsRead, artist } = useTrackInfo(f, entry);
  useNoteFindings(name, f, entry, rows, tagsRead, artist);
  const total = rows.every((r) => r.durationSec !== undefined) ? rows.reduce((a, r) => a + (r.durationSec ?? 0), 0) : undefined;
  const cardValue: FolderCard = entry?.card ?? { mode: CONTENT_KINDS.find((k) => k.id === (entry?.kind ?? 'hoerspiel'))?.defaultMode ?? 5 };
  // Same test as the "Geändert" badge on the overview.
  const changedElsewhere = !!entry?.fingerprint && entry.fingerprint !== folderFingerprint(f);
  // Files of an interrupted change wait in the helper folder: taking over now would drop their titles.
  const waiting = !!s.scan?.tempDirs.some((t) => helperFolders(t).includes(folder));
  const changes = useMemo(() => (changedElsewhere && !waiting && entry ? folderChanges(f, entry) : null), [changedElsewhere, waiting, f, entry]);
  const withTracks = useMemo(() => new Set(s.scan!.folders.filter((x) => x.tracks.length).map((x) => x.number)), [s.scan]);
  const mode = modeByCode(cardValue.mode);
  // Same check as the health report: a missing number stops the box with "Fehler 6".
  const gap = s.report?.issues.find((i) => i.id === `gap:${name}`);
  const titleOf = (file: string) => rows.find((r) => r.file === file)?.title ?? file;
  /** The name the catalog had for a track, before it was swapped elsewhere. */
  const oldTitleOf = (file: string) => entry?.tracks.find((t) => t.file.toLowerCase() === file.toLowerCase())?.title || file;
  // Taking over notes the new tracks too, so the next change elsewhere shows only what is new then.
  // New and swapped tracks keep the title and length shown now.
  const acceptChanges = () =>
    updateCatalog(
      (c) => {
        if (c.folders[name]?.tracks.length) applyShownRows(c, folder, rows, { replaced: changes?.replaced });
      },
      { touchFolders: [folder] },
    ).then(
      () => toast.success('Änderungen übernommen'),
      (e) => toastError('Speichern hat nicht geklappt', e),
    );

  const save = (mutate: (e: CatalogFolder) => void) =>
    updateCatalog(
      (c) => {
        const e = c.folders[name] ?? (c.folders[name] = emptyEntry(folder));
        mutate(e);
        e.updatedAt = Date.now();
      },
      { touchFolders: entry ? [] : [folder] },
    ).catch((e) => toastError('Speichern hat nicht geklappt', e));

  const select = (page: 'cards' | 'stickers') => {
    selection.value = new Set([folder]);
    // "Karte beschreiben" means this folder's card only: special cards picked before stay in the list, unticked.
    if (page === 'cards') extraSelection.value = new Set();
    navigate({ page });
  };

  return (
    <div class="page folder-page">
      <BackLink />
      <div class="folder-head">
        <div class="folder-cover">
          <button class="tile" style={{ width: '100%' }} onClick={() => setCoverOpen(true)} title={coverUrlFor(folder) ? 'Cover ändern' : 'Cover hinzufügen'}>
            <div class="tile-cover">
              <Cover url={coverUrlFor(folder)} title={title} seed={folder} number={name} color={entry?.color} />
              <span class="tile-num">{name}</span>
            </div>
          </button>
          <button type="button" class="link-button" style={{ alignSelf: 'center' }} onClick={() => setCoverOpen(true)}>
            <ImagePlus size={16} /> {coverUrlFor(folder) ? 'Cover ändern' : 'Cover hinzufügen'}
          </button>
        </div>
        <div class="folder-info">
          <InlineText value={title} placeholder="Titel" label="Titel des Ordners" big onSave={(v) => save((e) => (e.title = v || `Ordner ${name}`))} />
          <InlineText value={artist ?? ''} placeholder="Interpret oder Autor hinzufügen" label="Interpret oder Autor" onSave={(v) => save((e) => (e.artist = v || undefined))} />
          {/* Each value stays whole: on a phone "MB" or "Min." used to land alone on the next line. */}
          <p class="muted folder-meta">
            <span class="nowrap">Ordner {name}</span> · <span class="nowrap">{plural(rows.length, 'Titel', 'Titel')}</span>
            {total ? (
              <>
                {' · '}
                <span class="nowrap">{formatDuration(total)}</span>
              </>
            ) : null}{' '}
            · <span class="nowrap">{formatBytes(f.totalBytes)}</span>
            {/* Made quieter or louder on purpose: a small note, which opens where it was set. */}
            {levelNote(offset) ? (
              <>
                {' · '}
                {rows.some((r) => isMp3(r.file)) ? (
                  <button type="button" class="link-button nowrap folder-level-note" title={`${formatOffset(offset)} gegenüber deinen anderen Titeln`} onClick={() => setSoundAsk('level')}>
                    {levelNote(offset)}
                  </button>
                ) : (
                  <span class="nowrap folder-level-note">{levelNote(offset)}</span>
                )}
              </>
            ) : null}
          </p>
          <Field label="Was ist drin?">
            {/* Lays out its six choices by its own width (stil-holz.css). */}
            <div class="folder-kind">
              <Segmented<ContentKind>
                label="Was ist drin?"
                value={entry?.kind ?? 'hoerspiel'}
                options={CONTENT_KINDS.map((k) => ({ value: k.id, label: k.label, icon: KIND_ICONS[k.id] }))}
                onChange={(kind) =>
                  save((e) => {
                    e.kind = kind;
                  })
                }
              />
            </div>
          </Field>
          {/* Right under what is in it, which sets it (audit 0.4 #5): not under the list of titles, 120 rows further down. */}
          <p class="folder-mode-line small">
            So spielt die Karte: <b>{mode?.name ?? 'Unbekannt'}</b>
            {mode ? <span class="soft">, {lowerFirst(mode.tagline.replace(/\.$/, ''))}</span> : null}
            {' · '}
            <button type="button" class="link-button" aria-expanded={modeOpen} onClick={() => setModeOpen(!modeOpen)}>
              {modeOpen ? 'fertig' : 'ändern'}
            </button>
          </p>
          {modeOpen ? (
            <div class="folder-mode-picker stack tight">
              <p class="muted small">Gilt für Karten, die du ab jetzt beschreibst. Schon beschriebene Karten bleiben, wie sie sind.</p>
              <ModePicker
                profile={profile.value}
                value={cardValue}
                trackCount={rows.length}
                folder={folder}
                advanced={settings.value.advancedModes}
                withTracks={withTracks}
                trackTitle={(n) => rows.find((r) => r.number === n)?.title}
                onChange={(v) => {
                  if (!keepsFolderCard(entry, v)) save((e) => applyFolderCard(e, v));
                }}
              />
            </div>
          ) : null}
          <ShelfCardSection folder={folder} title={title} />
          <div class="folder-actions row wrap">
            <Button variant="primary" icon={Nfc} onClick={() => select('cards')}>
              Karte beschreiben
            </Button>
            <Button icon={Printer} onClick={() => select('stickers')}>
              Sticker drucken
            </Button>
            <Button icon={Plus} onClick={() => navigate({ page: 'add', folder })}>
              Titel hinzufügen
            </Button>
            {/* "Aufnehmen …" sits in the menu: as a fifth button the row took two lines at 1280 px. */}
            <MenuButton
              trigger={(open) => <IconButton label="Mehr" icon={Ellipsis} class="page-more" onClick={open} />}
              items={[
                ...(recordingOffered() ? [{ label: 'Aufnehmen …', icon: Mic, onSelect: () => setRecording(true) }] : []),
                { label: coverUrlFor(folder) ? 'Cover ändern' : 'Cover hinzufügen', icon: ImagePlus, separatorBefore: recordingOffered(), onSelect: () => setCoverOpen(true) },
                {
                  label: 'Sticker anpassen',
                  icon: Printer,
                  onSelect: () => {
                    stickerToEdit.value = folder;
                    select('stickers');
                  },
                },
                ...(rows.some((r) => isMp3(r.file))
                  ? [
                      { label: 'Lautstärke anpassen …', icon: Volume2, separatorBefore: true, onSelect: () => setSoundAsk('level') },
                      { label: 'Kleiner machen …', icon: Minimize2, onSelect: () => setSoundAsk('shrink') },
                    ]
                  : []),
                ...(settings.value.announceTitles && rows.length
                  ? [
                      { label: 'Titelansagen hinzufügen …', icon: Megaphone, separatorBefore: true, onSelect: () => setAnnounceAsk('add') },
                      { label: 'Titelansagen entfernen …', icon: MegaphoneOff, onSelect: () => setAnnounceAsk('remove') },
                    ]
                  : []),
                // The number is what the cards of the box point to: next to deleting, not among the everyday entries (audit 0.4 #6).
                { label: 'Nummer ändern oder tauschen …', icon: FolderInput, separatorBefore: true, onSelect: () => setRenumber(true) },
                { label: 'Ordner löschen', icon: Trash2, danger: true, onSelect: () => setConfirmDelete(true) },
              ]}
            />
          </div>
        </div>
      </div>

      {/* A tablet shows the card of the folder on the left and all this beside it (handy.css); elsewhere this wrapper adds nothing. */}
      <div class="folder-body">
        <RenumberedNote folder={folder} />
        {waiting ? (
          <Callout tone="warning">
            <b>Eine Änderung an diesem Ordner wurde unterbrochen.</b> Ein Teil der Dateien wartet im Hilfsordner der App. Tippe unter „Meine Box“ auf „Ansehen und reparieren“ und dann auf „Dateien zurücklegen“.
          </Callout>
        ) : changedElsewhere ? (
          <Callout tone="warning">
            <div class="row wrap" style={{ gap: 12 }}>
              <div class="grow" style={{ minWidth: 240 }}>
                <b>Dieser Ordner wurde außerhalb der App geändert.</b>{' '}
                {changes && (changes.added.length || changes.missing.length || changes.replaced.length) ? (
                  <>
                    {changes.added.length ? `Neu dazugekommen: ${someNames(changes.added.map(titleOf))}. ` : ''}
                    {changes.missing.length ? `Weggefallen: ${someNames(changes.missing.map((t) => t.title || t.file))}. ` : ''}
                    {changes.replaced.length ? `Ausgetauscht: ${someNames(changes.replaced.map(oldTitleOf))}. ` : ''}
                  </>
                ) : (
                  'Seit ich ihn zuletzt gespeichert hab, sind Titel dazugekommen, weggefallen oder ausgetauscht worden. '
                )}
                {gap ? (
                  <>
                    {gap.detail} Beim Schließen der Lücke wird der neue Stand gleich übernommen.
                  </>
                ) : (
                  'Prüfe die Titel. Stimmt alles, übernimm den neuen Stand.'
                )}{' '}
                <button type="button" class="link-button" onClick={() => document.getElementById('titelliste')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  Zur Titelliste
                </button>
              </div>
              {/* With a gap one button does both: "Übernehmen" first would leave the box stopping at the gap. */}
              {gap ? (
                <Button size="sm" variant="primary" onClick={() => setCloseGaps(true)}>
                  Lücken schließen
                </Button>
              ) : (
                <Button size="sm" variant="primary" onClick={acceptChanges}>
                  Übernehmen
                </Button>
              )}
            </div>
          </Callout>
        ) : null}

        {gap && !waiting && !changedElsewhere ? (
          <Callout tone="warning">
            <div class="row wrap" style={{ gap: 12 }}>
              <div class="grow" style={{ minWidth: 240 }}>
                <b>Titelnummern fehlen.</b> {gap.detail}
              </div>
              <Button size="sm" variant="primary" onClick={() => setCloseGaps(true)}>
                Lücken schließen
              </Button>
            </div>
          </Callout>
        ) : null}

        <TrackList
          folder={folder}
          rows={rows}
          changes={changes}
          title={title}
          artist={artist}
          lookup={tagsRead && !!entry && wantsLookup(title, rows)}
          announceAsk={announceAsk}
          onAnnounceAsked={() => setAnnounceAsk(null)}
          soundAsk={soundAsk}
          onSoundAsked={() => setSoundAsk(null)}
        />
        {recording ? <RecordDialog folder={folder} onClose={() => setRecording(false)} /> : null}

        {/* A series packed into this folder shows its episodes also with the extra "Mehr als 99 Hörspiele" off. */}
        {settings.value.episodePlanner || new Set(entry?.tracks.map((t) => t.episode).filter(Boolean)).size > 1 ? <EpisodesSection folder={folder} rows={rows} entry={entry} /> : null}

        <OriginsSection folder={entry} />
      </div>

      {closeGaps && gap ? (
        canChangeCard() ? (
          <CloseGapsDialog folder={folder} rows={rows} issue={gap} replaced={changes?.replaced} onClose={() => setCloseGaps(false)} />
        ) : (
          <PackageWaitingDialog onClose={() => setCloseGaps(false)} />
        )
      ) : null}
      {coverOpen ? <CoverDialog folder={folder} query={buildFolderQuery({ title, artist }) || title} onClose={() => setCoverOpen(false)} /> : null}
      {renumber ? (
        canChangeCard() ? (
          <RenumberDialog folder={folder} title={title} onClose={() => setRenumber(false)} />
        ) : (
          <PackageWaitingDialog onClose={() => setRenumber(false)} />
        )
      ) : null}
      {confirmDelete ? (
        canChangeCard() ? (
          <DeleteFolder folder={folder} title={title} onClose={() => setConfirmDelete(false)} />
        ) : (
          <PackageWaitingDialog onClose={() => setConfirmDelete(false)} />
        )
      ) : null}
    </div>
  );
}

/**
 * A field that saves when it is left. Escape gives up what was typed: the
 * blur right after it must not save it after all. The folder's name wraps
 * (WrapInput), so a long one is not cut off in the middle of a word.
 */
function InlineText({ value, placeholder, label, big, onSave }: { value: string; placeholder: string; label: string; big?: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setV(value), [value]);
  const commit = (text: string) => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const t = text.trim();
    if (t !== value) onSave(t);
  };
  const cancel = () => {
    cancelled.current = true;
    setV(value);
  };
  if (big) return <WrapInput class="headline" value={v} label={label} placeholder={placeholder} onValue={setV} onBlur={commit} onCancel={cancel} />;
  return (
    <input
      class="input inline-edit"
      value={v}
      placeholder={placeholder}
      aria-label={label}
      onInput={(e) => setV(e.currentTarget.value)}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancel();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

type Row = TrackRow;

/** What changed elsewhere since the app last noted the folder (see folderChanges). */
type Changes = { added: string[]; missing: CatalogTrack[]; replaced: string[] };

function TrackList({
  folder,
  rows,
  changes,
  title,
  artist,
  lookup,
  announceAsk,
  onAnnounceAsked,
  soundAsk,
  onSoundAsked,
}: {
  folder: number;
  rows: Row[];
  changes: Changes | null;
  title: string;
  artist?: string;
  lookup: boolean;
  /** "Titelansagen" picked in the folder's menu: opens here, under the same rules as the other extras. */
  announceAsk: 'add' | 'remove' | null;
  onAnnounceAsked: () => void;
  /** "Lautstärke anpassen" or "Kleiner machen" picked in the folder's menu: opens here, under the same rules. */
  soundAsk: SoundJob | null;
  onSoundAsked: () => void;
}) {
  const s = card.value!;
  const name = folderName(folder);
  const [order, setOrder] = useState<string[] | null>(null);
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [waiting, setWaiting] = useState(false);
  /** "Titel-Infos bearbeiten" is open; with a file: opened from that track's menu. */
  const [tags, setTags] = useState<{ file?: string } | null>(null);
  /** Extra "Titel zusammenfügen": the tracks picked so far (null: not picking), and whether the dialog asks. */
  const [joinPick, setJoinPick] = useState<Set<string> | null>(null);
  const [joinAsk, setJoinAsk] = useState(false);
  /** Extra "Anfang/Ende abschneiden": the track whose dialog is open. */
  const [trim, setTrim] = useState<string | null>(null);
  /** Extra "Titelansagen": the dialog that is open. */
  const [announce, setAnnounce] = useState<'add' | 'remove' | null>(null);
  /** "Lautstärke anpassen" / "Kleiner machen": the dialog that is open. */
  const [sound, setSound] = useState<SoundJob | null>(null);
  const extras = settings.value;
  const [drag, setDrag] = useState<number | null>(null);
  // Whether the bar above the list showed when the drag began: it keeps that while dragging, so the rows stay put under the pointer.
  const [barAtDrag, setBarAtDrag] = useState(false);
  const { listen, toggle, stop, isPlaying } = useListen();
  const listRef = useRef<HTMLDivElement>(null);

  const byFile = new Map(rows.map((r) => [r.file, r]));
  // Files renamed meanwhile (gaps closed): an order of the old names would delete them all on saving.
  useEffect(() => {
    const files = new Set(rows.map((r) => r.file));
    setOrder((o) => (o?.some((f) => !files.has(f)) ? null : o));
  }, [rows]);
  const shown = order ? order.map((f) => byFile.get(f)!).filter(Boolean) : rows;
  const dirty = !!order && (order.length !== rows.length || order.some((f, i) => f !== rows[i]?.file));
  const removed = order ? rows.filter((r) => !order.includes(r.file)) : [];
  /** Cards the app knows of that play single tracks or ranges of this folder. */
  const numberedCards = !!healthContext(s).foldersWithRangeCards?.has(folder);
  const added = new Set(changes?.added.map((x) => x.toLowerCase()));
  const replaced = new Set(changes?.replaced.map((x) => x.toLowerCase()));

  const move = (from: number, to: number) => {
    const list = shown.map((r) => r.file);
    const [x] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, to)), 0, x);
    setOrder(list);
  };
  const remove = (file: string) => setOrder(shown.map((r) => r.file).filter((f) => f !== file));

  const onPointerDown = (i: number, e: PointerEvent) => {
    e.preventDefault();
    setBarAtDrag(dirty);
    setDrag(i);
    let current = i;
    const onMove = (ev: PointerEvent) => {
      const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])];
      // The row lands where it lies under the pointer, dragged up or down.
      const target = dragTarget(ev.clientY, items.map((el) => el.getBoundingClientRect()), current);
      if (target !== current) {
        const cur = shownRef.current.map((r) => r.file);
        const [x] = cur.splice(current, 1);
        cur.splice(target, 0, x);
        setOrder(cur);
        shownRef.current = cur.map((f) => byFile.get(f)!);
        current = target;
        setDrag(target);
      }
    };
    const onUp = () => {
      setDrag(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // One object for all rows, always with the latest handlers: a row draws again only when its own data changes.
  const act = useRef<RowActions>({} as RowActions).current;

  // The list plays on into the next track, in the order it shows when a track ends.
  const listenTo = (r: Row): ListenNext => ({
    key: r.file,
    load: async () => {
      const dir = await s.volume.root.dir(name);
      return dir.source(r.file);
    },
    opts: {
      name: r.file,
      durationSec: r.durationSec,
      next: () => {
        const n = after(shownRef.current, r.file, (x) => x.file);
        return n ? listenTo(n) : null;
      },
    },
  });
  const play = (r: Row) => {
    const t = listenTo(r);
    return toggle(t.key, t.load, t.opts);
  };

  // Deleting is final and new numbers can break cards for single tracks: ask first.
  // A downloaded Paket waits for the card (Firefox, Safari): the folder stays as it is until then.
  const askOrSave = () => (!canChangeCard() ? setWaiting(true) : removed.length || numberedCards ? setConfirm(true) : void saveOrder());

  /**
   * Saves `list` as the folder's new order; tracks left out are deleted.
   * "Titel zusammenfügen" comes here too, once the joined file is on the
   * card (`joined`: how many tracks became one).
   */
  const saveOrder = async (list: string[] | null = order, joined?: { count: number; lossless: boolean }) => {
    setConfirm(false);
    if (!list) return;
    // A join has just written a file: the card as scanned after it.
    const now = card.value?.scan ?? s.scan!;
    const f = now.folders.find((x) => x.number === folder);
    if (!f) return;
    const gone = rows.filter((r) => !list.includes(r.file));
    const kept = list.map((x) => byFile.get(x)).filter((r): r is Row => !!r);
    const plan = planReorder(f, list, { pureNumbers: settings.value.pureNumbers, tempDirs: now.tempDirs });
    if (plan.leftovers.length) {
      toast.error('Speichern geht gerade nicht', plan.leftovers[0]);
      return;
    }
    // The files get new names: what plays now would lose its place in the list.
    stop();
    setSaving({ done: 0, total: plan.steps.length });
    // The tracks wait in a helper folder on the way: closing the app now would hide them from the box.
    let run: RepairRun;
    try {
      run = await runRepair(plan, {
        kind: 'order',
        onProgress: (p) => setSaving({ done: p.done, total: p.total }),
        prepare: (c) => keepShownTitles(c, folder, kept),
        folders: () => [folder],
      });
    } catch (e) {
      setSaving(null);
      toastError('Speichern hat nicht geklappt', e);
      return;
    }
    const { result, done, scan } = run;
    setSaving(null);
    setOrder(null);
    const packaged = s.volume.access === 'snapshot';
    if (!result.error && joined) {
      toast.success(
        `${plural(joined.count, 'Titel', 'Titel')} zusammengefügt`,
        `${joined.lossless ? 'Ohne Umwandeln, am Ton hat sich nichts geändert.' : 'Die Titel wurden zusammen neu umgewandelt.'}${packaged ? ' Kommt mit dem nächsten Paket auf die Karte.' : ''}`,
      );
      return;
    }
    if (!result.error) {
      // Say what happened: deleting is more than a new order, and a Paket card changes only later.
      const names = gone.map((r) => r.title || r.file);
      if (names.length) toast.success(packaged ? `${someNames(names)} ${names.length === 1 ? 'kommt' : 'kommen'} mit dem nächsten Paket weg` : `${someNames(names)} gelöscht`);
      else toast.success(packaged ? 'Neue Reihenfolge kommt mit dem nächsten Paket' : 'Neue Reihenfolge gespeichert');
      return;
    }
    // Say what really happened: deleted titles are gone, others may wait in the helper folder.
    const deleted = done.filter((x) => x.op === 'delete').length;
    const lines = [result.error.message];
    // The joined track is in place already; only deleting the others and closing the gap is left.
    if (joined) lines.push(`Der zusammengefügte Titel steht schon an der Stelle des ersten.${deleted ? '' : ' Die anderen Titel sind noch da, lösche sie im Menü „…“.'}`);
    else if (!result.completed) lines.push('Auf der Karte hat sich nichts geändert.');
    if (deleted) lines.push(`${plural(deleted, 'Titel ist', 'Titel sind')} schon gelöscht.`);
    if (scan?.tempDirs.some((t) => t.folder === folder)) lines.push('Tippe unter „Meine Box“ auf „Ansehen und reparieren“ und dann auf „Dateien zurücklegen“, dann sind alle übrigen Titel wieder im Ordner.');
    toast.error('Nicht alles wurde gespeichert', lines.join(' '));
  };

  const setTitle = (file: string, title: string) =>
    updateCatalog(
      (c) => {
        const e = c.folders[name] ?? (c.folders[name] = emptyEntry(folder));
        const t = e.tracks.find((x) => x.file.toLowerCase() === file.toLowerCase());
        // Typed by someone: no longer a guess.
        if (t) {
          t.title = title || undefined;
          delete t.titleAuto;
        } else e.tracks.push({ file, title: title || undefined });
      },
      { touchFolders: [folder] },
    ).catch((e) => toastError('Speichern hat nicht geklappt', e));

  // Not while a new order waits or is saved: the files are about to get new names.
  const editTags = (file?: string) => {
    if (saving) return;
    if (dirty) toast.info('Erst die Reihenfolge speichern', 'Speichere oder verwirf zuerst die neue Reihenfolge, dann kannst du die Titel-Infos bearbeiten.');
    else if (!canChangeCard()) setWaiting(true);
    else setTags({ file });
  };

  // The same rules for the extras: they change files, so not while a new order waits or is saved.
  const mayChange = () => {
    if (saving) return false;
    if (dirty) toast.info('Erst die Reihenfolge speichern', 'Speichere oder verwirf zuerst die neue Reihenfolge.');
    else if (!canChangeCard()) setWaiting(true);
    else return true;
    return false;
  };
  const trimTrack = (file: string) => {
    if (mayChange()) setTrim(file);
  };
  useEffect(() => {
    if (!announceAsk) return;
    onAnnounceAsked();
    if (mayChange()) setAnnounce(announceAsk);
  }, [announceAsk]);
  useEffect(() => {
    if (!soundAsk) return;
    onSoundAsked();
    if (mayChange()) setSound(soundAsk);
  }, [soundAsk]);
  const pick = (file: string, on: boolean) =>
    setJoinPick((p) => {
      const next = new Set(p);
      if (on) next.add(file);
      else next.delete(file);
      return next;
    });
  const joinPlan = joinPick ? planJoin(shown, joinPick) : null;

  Object.assign(act, { onPointerDown, play, setTitle, move, remove, editTags, trim: trimTrack, pick });

  return (
    <section class="card track-list" id="titelliste">
      <div class="card-header">
        <h2 class="grow">Titel</h2>
        <span class="muted small">{platform.value?.handheld ? 'Ziehe am Griff zum Sortieren, tippe zum Umbenennen auf den Namen' : 'Ziehe zum Sortieren, klicke zum Umbenennen auf den Namen'}</span>
        {extras.joinTracks && shown.length > 1 && !joinPick ? (
          <Button size="sm" icon={Combine} disabled={dirty || !!saving} onClick={() => mayChange() && setJoinPick(new Set())}>
            Zusammenfügen …
          </Button>
        ) : null}
        {shown.length ? (
          <Button size="sm" icon={Tags} disabled={dirty || !!saving || !!joinPick} onClick={() => editTags()}>
            Titel-Infos bearbeiten
          </Button>
        ) : null}
      </div>
      {joinPick && !saving && extras.joinTracks ? (
        <div class="join-bar" style={{ padding: '12px 24px', background: 'var(--primary-soft)', borderBottom: '1px solid var(--border)' }}>
          <div class="row wrap">
            <span class="grow small" style={{ color: 'var(--primary-soft-text)', fontWeight: 600 }}>
              Hake die Titel an, die ein Titel werden sollen. Sie kommen in der Reihenfolge der Liste zusammen.{joinPick.size ? ` ${joinPick.size} gewählt.` : ''}
            </span>
            {/* The two buttons wrap together, never one without the other. */}
            <div class="row" style={{ marginLeft: 'auto' }}>
              <Button size="sm" variant="ghost" icon={Undo2} onClick={() => setJoinPick(null)}>
                Abbrechen
              </Button>
              <Button size="sm" variant="primary" icon={Combine} disabled={joinPick.size < 2} onClick={() => setJoinAsk(true)}>
                Zusammenfügen …
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {(drag === null ? dirty : barAtDrag) ? (
        <div style={{ padding: '12px 24px', background: 'var(--primary-soft)', borderBottom: '1px solid var(--border)' }}>
          {saving ? (
            <div class="stack tight">
              <span class="small">
                {s.volume.access === 'snapshot'
                  ? 'Speichere die neue Reihenfolge fürs Paket … Schließe TonUINO Studio nicht, bis alles fertig ist.'
                  : 'Speichere die neue Reihenfolge … Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}
              </span>
              <Progress value={saving.done} max={saving.total} />
            </div>
          ) : (
            <div class="row wrap">
              <span class="grow small" style={{ color: 'var(--primary-soft-text)', fontWeight: 600 }}>
                {removed.length
                  ? `${plural(removed.length, 'Titel wird', 'Titel werden')} beim Speichern von der Karte gelöscht. Die übrigen bekommen neue Nummern.`
                  : 'Geänderte Reihenfolge. Die Titel bekommen beim Speichern neue Nummern. Karten für einzelne Titel zeigen danach eventuell auf andere.'}
              </span>
              {/* The two buttons wrap together, never one without the other. */}
              <div class="row" style={{ marginLeft: 'auto' }}>
                <Button size="sm" variant="ghost" icon={Undo2} onClick={() => setOrder(null)}>
                  Verwerfen
                </Button>
                <Button size="sm" variant="primary" onClick={askOrSave}>
                  Speichern
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
      {lookup && !dirty && !saving ? <TitleLookup folder={name} title={title} artist={artist} rows={rows} /> : null}
      {!shown.length ? (
        <div class="empty" style={{ padding: 32 }}>
          <p>Keine Titel. Füge welche hinzu.</p>
        </div>
      ) : (
        <div class="list" ref={listRef}>
          {shown.map((r, i) => (
            <TrackListRow
              key={r.file}
              r={r}
              i={i}
              last={i === shown.length - 1}
              number={String(dirty ? i + 1 : r.number).padStart(3, '0')}
              dragging={drag === i}
              playing={isPlaying(r.file)}
              listening={listen?.key === r.file ? listen : null}
              badge={added.has(r.file.toLowerCase()) ? 'neu' : replaced.has(r.file.toLowerCase()) ? 'ausgetauscht' : null}
              locked={!!saving}
              picked={joinPick && !saving && extras.joinTracks ? joinPick.has(r.file) : null}
              trim={extras.trimTracks}
              act={act}
            />
          ))}
        </div>
      )}
      {changes?.missing.length ? (
        <div class="list">
          {changes.missing.map((t) => (
            <div class="list-row" key={`fehlt-${t.file}`}>
              <div class="grow stack" style={{ gap: 0 }}>
                <s class="muted">{t.title || t.file}</s>
                <span class="tiny muted ellipsis">{t.file}</span>
              </div>
              <Badge tone="danger">fehlt</Badge>
            </div>
          ))}
        </div>
      ) : null}
      {confirm ? (
        <SaveOrderDialog
          removed={removed}
          count={shown.length}
          numberedCards={numberedCards}
          packaged={s.volume.access === 'snapshot'}
          onCancel={() => setConfirm(false)}
          onSave={() => void saveOrder()}
        />
      ) : null}
      {waiting ? <PackageWaitingDialog onClose={() => setWaiting(false)} /> : null}
      {tags ? <TagsDialog folder={folder} rows={rows} title={title} artist={artist} focus={tags.file} beforeSave={stop} onClose={() => setTags(null)} /> : null}
      {joinAsk && joinPlan ? (
        <JoinDialog
          folder={folder}
          rows={shown}
          plan={joinPlan}
          folderTitle={title}
          artist={artist}
          numberedCards={numberedCards}
          beforeSave={stop}
          onCancel={() => setJoinAsk(false)}
          onJoined={(lossless) => {
            setJoinAsk(false);
            setJoinPick(null);
            void saveOrder(joinPlan.order, { count: joinPlan.files.length, lossless });
          }}
        />
      ) : null}
      {trim ? <TrimDialog folder={folder} rows={rows} file={trim} beforeSave={stop} onClose={() => setTrim(null)} /> : null}
      {announce ? <AnnounceDialog folder={folder} rows={rows} mode={announce} beforeSave={stop} onClose={() => setAnnounce(null)} /> : null}
      {sound ? <SoundDialog folder={folder} rows={rows} job={sound} kind={s.catalog?.folders[name]?.kind} beforeSave={stop} onClose={() => setSound(null)} /> : null}
    </section>
  );
}

interface RowActions {
  onPointerDown: (i: number, e: PointerEvent) => void;
  play: (r: Row) => void;
  setTitle: (file: string, title: string) => void;
  move: (from: number, to: number) => void;
  remove: (file: string) => void;
  editTags: (file?: string) => void;
  /** Extras of the settings page. */
  trim: (file: string) => void;
  pick: (file: string, on: boolean) => void;
}

interface RowProps {
  r: Row;
  i: number;
  last: boolean;
  /** The number on the card, gaps and all; while sorting the number the track gets on saving. */
  number: string;
  dragging: boolean;
  playing: boolean;
  /** Only for the row that plays: a jump or a pause draws that row again, not all hundred. */
  listening: Listening | null;
  badge: 'neu' | 'ausgetauscht' | null;
  locked: boolean;
  /** Picking tracks to join: whether this one is picked; null when not picking. */
  picked: boolean | null;
  /** "Anfang/Ende abschneiden" in the menu (an extra). */
  trim: boolean;
  act: RowActions;
}

/** One title of the list. Drawn again only when its own props change (playing and pausing touched every row before). */
const TrackListRow = memo(function TrackListRow({ r, i, last, number, dragging, playing, listening, badge, locked, picked, trim, act }: RowProps) {
  return (
    <div class="list-row" data-row style={dragging || picked ? { background: 'var(--primary-soft)' } : undefined}>
      {picked === null ? (
        <span style={{ cursor: 'grab', color: 'var(--text-muted)', touchAction: 'none' }} onPointerDown={(e) => act.onPointerDown(i, e as PointerEvent)} title="Ziehen zum Sortieren">
          <GripVertical size={18} />
        </span>
      ) : (
        <input type="checkbox" class="join-pick" checked={picked} aria-label={`„${r.title}“ zum Zusammenfügen wählen`} onChange={(e) => act.pick(r.file, e.currentTarget.checked)} />
      )}
      <span class="mono muted" style={{ width: 34 }}>
        {number}
      </span>
      {/* The track in the names: a screen reader would hear "Anhören" a hundred times otherwise. */}
      <IconButton label={`„${r.title || r.file}“ ${playing ? 'anhalten' : 'anhören'}`} icon={playing ? Pause : Play} size="sm" onClick={() => act.play(r)} />
      <div class="grow stack" style={{ gap: 0 }}>
        {/* Locked while the new order is saved: the files change names then, and a title would land on another track. */}
        <TrackTitle value={r.title} locked={locked} onSave={(t) => act.setTitle(r.file, t)} />
        <span class="tiny muted ellipsis">
          {badge === 'neu' ? <Badge tone="accent">neu</Badge> : badge === 'ausgetauscht' ? <Badge tone="warning">ausgetauscht</Badge> : null} {r.file}
          {r.titleAuto ? ' · automatisch erkannt' : ''}
        </span>
        {listening ? <AudioSeekBar audio={listening.audio} label={r.title || r.file} durationSec={listening.durationSec} onSeek={listening.seek} /> : null}
      </div>
      <span class="muted small nowrap">{formatDuration(listening ? (listening.durationSec ?? r.durationSec) : r.durationSec)}</span>
      <MenuButton
        trigger={(open) => <IconButton label={`Mehr zu „${r.title || r.file}“`} icon={Ellipsis} size="sm" onClick={open} />}
        items={[
          ...(i === 0 && last
            ? []
            : [
                { label: 'Nach oben', icon: ArrowUp, disabled: i === 0, onSelect: () => act.move(i, i - 1) },
                { label: 'Nach unten', icon: ArrowDown, disabled: last, onSelect: () => act.move(i, i + 1) },
              ]),
          { label: 'Titel-Infos bearbeiten', icon: Tags, disabled: locked, onSelect: () => act.editTags(r.file) },
          ...(trim ? [{ label: 'Anfang/Ende abschneiden …', icon: Scissors, disabled: locked, onSelect: () => act.trim(r.file) }] : []),
          { label: 'Löschen', icon: Trash2, danger: true, separatorBefore: true, onSelect: () => act.remove(r.file) },
        ]}
      />
    </div>
  );
});

function SaveOrderDialog({
  removed,
  count,
  numberedCards,
  packaged,
  onCancel,
  onSave,
}: {
  removed: Row[];
  count: number;
  numberedCards: boolean;
  packaged: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const deleting = removed.length > 0;
  const last = String(count).padStart(3, '0');
  const numbers =
    count === 0
      ? 'Danach ist der Ordner leer.'
      : count === 1
        ? `${deleting ? 'Der übrige Titel' : 'Der Titel'} bekommt die Nummer 001.`
        : `${deleting ? 'Die übrigen' : 'Die'} ${count} Titel bekommen die Nummern 001 bis ${last} in der neuen Reihenfolge.`;
  return (
    <Dialog
      title={deleting ? (removed.length === 1 ? `„${removed[0].title}“ löschen?` : `${removed.length} Titel löschen?`) : 'Neue Reihenfolge speichern?'}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Abbrechen</Button>
          {deleting ? (
            <Button variant="danger" icon={Trash2} onClick={onSave}>
              {packaged ? 'Löschen' : 'Endgültig löschen'}
            </Button>
          ) : (
            <Button variant="primary" onClick={onSave}>
              Speichern
            </Button>
          )}
        </>
      }
    >
      <div class="stack">
        {deleting ? (
          <>
            {packaged ? (
              <>
                <p>{removed.length === 1 ? 'Dieser Titel kommt' : 'Diese Titel kommen'} mit dem nächsten Paket von der Karte. Auf der Karte änderst du das, wenn du das Paket entpackst.</p>
                <p class="small muted">Willst du es dir anders überlegen, lies die Karte neu ein, bevor du das Paket herunterlädst.</p>
              </>
            ) : (
              <p>{removed.length === 1 ? 'Dieser Titel wird' : 'Diese Titel werden'} von der SD-Karte gelöscht. Das lässt sich nicht rückgängig machen.</p>
            )}
            <ul class="stack tight" style={{ paddingLeft: 18 }}>
              {removed.slice(0, 12).map((r) => (
                <li key={r.file}>
                  {r.title} <span class="muted small">({r.file})</span>
                </li>
              ))}
              {removed.length > 12 ? <li>… und {removed.length - 12} weitere</li> : null}
            </ul>
          </>
        ) : null}
        <p>{numbers}</p>
        <Callout tone="warning">
          {numberedCards
            ? 'Für diesen Ordner gibt es Karten, die bestimmte Titelnummern abspielen (Einzeltitel oder von … bis …). Diese Karten musst du danach neu beschreiben.'
            : 'Karten, die einen bestimmten Titel oder einen Bereich von … bis … abspielen, zeigen danach eventuell auf andere Titel.'}
        </Callout>
      </div>
    </Dialog>
  );
}

function CloseGapsDialog({ folder, rows, issue, replaced, onClose }: { folder: number; rows: Row[]; issue: Issue; replaced?: readonly string[]; onClose: () => void }) {
  const s = card.value!;
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const packaged = s.volume.access === 'snapshot';
  const plan = useMemo(() => planFix(s.scan!, { kind: 'close-gaps', folder }, { pureNumbers: settings.value.pureNumbers, catalog: s.catalog }), [s.scan, s.catalog, folder]);
  const run = async () => {
    setBusy({ done: 0, total: plan.steps.length });
    try {
      const { result, scan } = await runRepair(plan, {
        kind: 'repair',
        onProgress: (p) => setBusy({ done: p.done, total: p.total }),
        prepare: (c) => keepShownTitles(c, folder, rows, replaced),
        folders: () => [folder],
      });
      if (result.error) {
        const lines = [result.error.message];
        if (scan?.tempDirs.some((t) => t.folder === folder)) lines.push('Tippe unter „Meine Box“ auf „Ansehen und reparieren“ und dann auf „Dateien zurücklegen“.');
        toast.error('Die Lücken sind noch nicht geschlossen', lines.join(' '));
      } else toast.success('Lücken geschlossen', packaged ? 'Kommt ins Paket für die Karte.' : undefined);
      onClose();
    } catch (e) {
      setBusy(null);
      toastError('Das hat nicht geklappt', e);
    }
  };
  return (
    <Dialog
      title={plan.title}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={!!busy}>
            Abbrechen
          </Button>
          <Button variant="primary" loading={!!busy} disabled={!plan.steps.length} onClick={run}>
            Lücken schließen
          </Button>
        </>
      }
    >
      <div class="stack">
        {busy ? (
          <>
            <p class="small">{packaged ? 'Die Titel rücken nach vorn … Schließe TonUINO Studio nicht, bis alles fertig ist.' : 'Die Titel rücken nach vorn … Ziehe die SD-Karte nicht heraus und schließe TonUINO Studio nicht, bis alles fertig ist.'}</p>
            <Progress value={busy.done} max={busy.total} />
          </>
        ) : plan.leftovers.length ? (
          <Callout tone="neutral">{plan.leftovers.join(' ')} Das geht unter „Meine Box“ mit „Ansehen und reparieren“.</Callout>
        ) : (
          <>
            <p>{plan.summary[0]}</p>
            {issue.fixWarning ? <Callout tone="warning">{issue.fixWarning}</Callout> : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

function TrackTitle({ value, locked, onSave }: { value: string; locked?: boolean; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  // Escape gives up what was typed: the blur right after it must not save it.
  const cancelled = useRef(false);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  if (locked) {
    return (
      <span class="ellipsis track-name" style={{ fontWeight: 600 }}>
        {value}
      </span>
    );
  }
  if (!editing) {
    return (
      <span class="ellipsis track-name" style={{ fontWeight: 600, cursor: 'text' }} onClick={() => setEditing(true)} title="Klicken zum Umbenennen">
        {value}
      </span>
    );
  }
  return (
    <input
      class="input"
      style={{ height: 30 }}
      ref={input}
      value={v}
      onInput={(e) => setV(e.currentTarget.value)}
      onBlur={(e) => {
        setEditing(false);
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        const t = e.currentTarget.value.trim();
        if (t !== value) onSave(t);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setV(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function DeleteFolder({ folder, title, onClose }: { folder: number; title: string; onClose: () => void }) {
  const s = card.value!;
  const [busy, setBusy] = useState(false);
  const name = folderName(folder);
  const run = async () => {
    setBusy(true);
    try {
      await s.volume.root.remove(name, { recursive: true });
      let pictures: string[] = [];
      await updateCatalog((c) => {
        pictures = forgetFolder(c, folder, card.value?.covers.keys());
      });
      // Its pictures leave the cover zip too (forgetFolder keeps those another folder or card still shows).
      if (pictures.length) {
        await changeCovers((covers) => {
          for (const e of pictures) covers.delete(e);
        }).catch(() => undefined);
      }
      await rescan();
      if (s.volume.access === 'snapshot') toast.success(`„${title}“ kommt mit dem nächsten Paket weg`, 'Auf der Karte löschst du den Ordner beim Entpacken. Ich sag dir, wann.');
      else toast.success(`„${title}“ gelöscht`);
      navigate({ page: 'box' });
    } catch (e) {
      toastError('Löschen hat nicht geklappt', e);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`„${title}“ löschen?`}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button variant="danger" icon={Trash2} loading={busy} onClick={run}>
            {s.volume.access === 'snapshot' ? 'Löschen' : 'Endgültig löschen'}
          </Button>
        </>
      }
    >
      <div class="stack">
        {s.volume.access === 'snapshot' ? (
          <>
            <p>Ordner {name} mit allen Titeln kommt mit dem nächsten Paket von der Karte. Beim Entpacken löschst du ihn, ich sag dir, wann.</p>
            <p class="small muted">{PACKAGE_NOTE}</p>
          </>
        ) : (
          <p>Ordner {name} mit allen Titeln wird von der SD-Karte gelöscht. Das lässt sich nicht rückgängig machen.</p>
        )}
        <Callout tone="warning">
          Karten, die auf diesen Ordner zeigen, spielen danach nichts mehr ab. Kommt später ein neues Album in Ordner {name}, spielen sie das neue Album. Die anderen Ordner behalten ihre Nummern.
        </Callout>
      </div>
    </Dialog>
  );
}
