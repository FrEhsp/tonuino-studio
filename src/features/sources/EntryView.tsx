/**
 * One source of "Entdecken": what it is, its rights, its items with
 * "Reinhören", the selection and "Zur Box hinzufügen". Sources that only
 * allow downloads on their own page get the guided save-and-drag flow.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, ChevronDown, ChevronUp, Download, Ellipsis, ExternalLink as ExternalIcon, FileAudio, Flag, Plus } from 'lucide-preact';
import { agesLabel, agesSentence, filesInOrder, fitsBand } from '../../core/sources/filter';
import { defaultCardMode, guessSavedChoice, sharedStories, isWholeWork, matchDropped, pickOfChoice, picksOf, plannedBytes, plannedSeconds, safeName, savedChoices, type CardMode, type PickedFile, type SavedFacts } from '../../core/sources/handoff';
import { rightsBadge } from '../../core/sources/licence';
import type { IndexEntry, IndexItem } from '../../core/sources/types';
import { AUDIO_EXTENSIONS, isAudioFile, readTrackInfo } from '../../core/library/tags';
import type { ByteSource } from '../../platform/types';
import { navigate } from '../../app/router';
import { plat } from '../../app/state';
import { formatBytes, plural } from '../../app/format';
import { Badge, Button, Callout, EmptyState, Field, IconButton, Segmented } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { MenuButton, type MenuItem } from '../../ui/components/Menu';
import { toast, toastError } from '../../ui/components/Toast';
import { useFileDrop } from '../../ui/useFileDrop';
import {
  blockerText,
  canAddUnmatched,
  checkedLine,
  creatorsLine,
  titleWithoutReader,
  deliveryOf,
  loadsInPage,
  eachLabel,
  hiddenText,
  itemMeta,
  lengthLabel,
  listHeading,
  opensFile,
  partWord,
  previewFailedText,
  rightsBox,
  saveHeading,
  saveSteps,
  selectionLine,
  noneLabel,
  notAudioText,
  nothingToAddText,
  whichQuestion,
  whichText,
  type RightsBox,
} from './labels';
import { ExternalLink, openLink, reportHref, ReportLink } from './links';
import { CoverCredit, EntryBadges, Hold, IndexGate, ListNotes, SourceCover } from './parts';
import { PreviewButton, stopPreview } from './Preview';
import { EmbedButton, EmbedFrame, openEmbed } from './Embed';
import { embedOf, playerName } from '../../core/sources/providers';
import { RunPanel } from './RunPanel';
import { canWatchDownloads, downloadWatch, startWatch, stopWatch, useDownloadWatch } from './downloadsWatch';
import {
  addFromSources,
  addSaved,
  blocker,
  cardModeChoice,
  cardModeFor,
  dropFallback,
  enterSource,
  focusItem,
  handOffBlocker,
  kindChoice,
  online,
  packageMode,
  pickedKeys,
  prefs,
  run,
  setPicked,
  togglePicked,
  type ReadyState,
} from './state';
import { ImportBarFlag } from '../../ui/rootFlag';

export function EntryView({ id }: { id: string }) {
  useEffect(() => {
    enterSource(id);
    // Playback stops when the page is left; a provider's player never opens again by itself.
    return () => {
      stopPreview();
      openEmbed.value = null;
    };
  }, [id]);
  return (
    <div class="page sources-page source-page">
      <a class="back-link" href="#/entdecken">
        <ArrowLeft size={16} /> Alle Quellen
      </a>
      <IndexGate>
        {(ready) => {
          const entry = ready.index.entries.find((e) => e.id === id);
          if (!entry) {
            return (
              <EmptyState
                title="Diese Quelle gibt es hier nicht mehr"
                actions={
                  <Button variant="primary" onClick={() => navigate({ page: 'sources' })}>
                    Zur Übersicht
                  </Button>
                }
              />
            );
          }
          return <EntryBody entry={entry} ready={ready} />;
        }}
      </IndexGate>
    </div>
  );
}

function fits(entry: IndexEntry, item: IndexItem): boolean {
  const p = prefs.value;
  const kind = kindChoice.value;
  return (kind === 'alle' || item.category === kind) && (p.band === 'alle' || fitsBand(item.ages ?? entry.ages, p.band));
}

function EntryBody({ entry, ready }: { entry: IndexEntry; ready: ReadyState }) {
  const [showAll, setShowAll] = useState(false);
  // Came from a pick: the parts of that story stay marked in the list (audit 0.4 #24).
  const [chosen, setChosen] = useState<{ keys: Set<string>; story?: string } | null>(null);
  const fitting = entry.items.filter((it) => fits(entry, it));
  const items = showAll ? entry.items : fitting;
  const hidden = entry.items.length - fitting.length;
  const box = rightsBox(entry);
  const whole = isWholeWork(entry);
  const dropZone = entry.items.some((it) => deliveryOf(entry, it) === 'browser') || dropFallback.value.includes(entry.id);
  // Nothing loads in the app here: the drop zone also sits at the bottom of the window, where the selection bar would be.
  const dropBar = dropZone && !whole && !entry.items.some((it) => deliveryOf(entry, it) === 'direct');
  // The note on saving opens the steps beside the drop zone; elsewhere it stands above the list.
  const noteInSteps = !!entry.note && dropZone && !whole;
  const report = reportHref(entry);
  const r = run.value;
  const after = (
    <>
      <RightsSection entry={entry} box={box} />
      {report ? (
        <p class="sources-footer">
          <span>
            Etwas stimmt nicht? <ReportLink href={report}>Melden</ReportLink>
          </span>
        </p>
      ) : null}
    </>
  );

  // A click on a search result: scroll to that item and mark it for a moment.
  useEffect(() => {
    const f = focusItem.value;
    if (!f || f.entry !== entry.id) return;
    focusItem.value = null;
    if (f.keys?.length) setChosen({ keys: new Set(f.keys), story: f.story });
    const el = document.querySelector<HTMLElement>(`[data-key="${CSS.escape(f.key)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    el.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
    const t = setTimeout(() => el.classList.remove('flash'), 1800);
    return () => clearTimeout(t);
  }, [entry.id]);

  return (
    <>
      <header class="source-head">
        <div class="source-head-cover">
          <SourceCover entry={entry} cover={entry.cover} title={entry.title} size="lg" />
          <CoverCredit entry={entry} />
        </div>
        <div class="source-head-text">
          <h1>{entry.title}</h1>
          <p class="source-head-publisher">
            <span>{entry.publisher}</span>
            <ExternalLink href={entry.pageUrl}>Zur Webseite</ExternalLink>
          </p>
          {entry.blurb ?? entry.about ? <p class="source-head-blurb">{entry.blurb ?? entry.about}</p> : null}
          <p class="source-head-ages">{agesSentence(entry.ages)}</p>
          <EntryBadges entry={entry} />
        </div>
      </header>

      <ListNotes ready={ready} />
      {entry.note && !noteInSteps ? <Callout tone="neutral">{entry.note}</Callout> : null}
      {/* How a file from the publisher's page gets here, before the list, not under all of it (audit 0.4 #24). */}
      {dropZone && !whole ? <SaveSteps entry={entry} note={noteInSteps ? entry.note : undefined} /> : null}
      {chosen && !whole ? <ChosenNote entry={entry} keys={chosen.keys} story={chosen.story} /> : null}

      {hidden > 0 && !showAll ? (
        <Callout tone="neutral">
          <div class="sources-note">
            <span>{hiddenText(entry, hidden, fitting.length)}</span>
            <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
              Alle anzeigen
            </Button>
          </div>
        </Callout>
      ) : null}

      {whole ? items.map((it) => <WorkCard key={it.key} entry={entry} item={it} />) : items.length ? <ItemList entry={entry} items={items} perItem={box.perItem} chosen={chosen?.keys} /> : null}

      {dropZone ? (
        <SaveAndDrop entry={entry} bar={dropBar && !r}>
          {after}
        </SaveAndDrop>
      ) : (
        after
      )}

      {r ? <RunPanel /> : whole ? null : <SelectionBar entry={entry} />}
    </>
  );
}

function RightsSection({ entry, box }: { entry: IndexEntry; box: RightsBox }) {
  return (
    <section class="card source-rights" aria-labelledby="source-rights-h">
      <h2 id="source-rights-h">Herkunft und Lizenz</h2>
      <p>{box.sentence}</p>
      {box.links.length ? (
        <p class="source-rights-links">
          {box.links.map((l) => (
            <ExternalLink key={l.href} href={l.href}>
              {l.label}
            </ExternalLink>
          ))}
        </p>
      ) : null}
      <p class="small muted">{checkedLine(entry)}</p>
    </section>
  );
}

/* ------------------------------------------------------------------ items */

/** "Du hast „Mumins lange Reise“ gewählt": which rows of the list the pick meant. */
function ChosenNote({ entry, keys, story }: { entry: IndexEntry; keys: Set<string>; story?: string }) {
  const n = entry.items.filter((it) => keys.has(it.key)).length;
  if (!n || !story) return null;
  return <p class="source-chosen-note">{n > 1 ? `Du hast „${story}“ gewählt. Die ${n} Teile sind unten markiert.` : `Du hast „${story}“ gewählt. Es ist unten markiert.`}</p>;
}

function ItemList({ entry, items, perItem, chosen }: { entry: IndexEntry; items: IndexItem[]; perItem: boolean; chosen?: Set<string> }) {
  const keys = pickedKeys(entry.id);
  const selectable = items.filter((it) => deliveryOf(entry, it) === 'direct');
  const thumbs = rowThumbs(entry);
  return (
    <section class="card source-list" aria-labelledby="source-list-h">
      <div class="source-list-head">
        <h2 id="source-list-h">{listHeading(entry)}</h2>
        <span class="muted small">{items.length.toLocaleString('de-DE')}</span>
        <span class="spacer" />
        {selectable.length > 1 ? (
          <>
            <button type="button" class="link-button" onClick={() => setPicked(entry.id, [...new Set([...keys, ...selectable.map((it) => it.key)])])}>
              Alle auswählen
            </button>
            <button type="button" class="link-button" disabled={!keys.size} onClick={() => setPicked(entry.id, [])}>
              Keine auswählen
            </button>
          </>
        ) : null}
      </div>
      <div class="source-items">
        {items.map((it) => (
          <ItemRow key={it.key} entry={entry} item={it} picked={keys.has(it.key)} chosen={!!chosen?.has(it.key)} perItem={perItem} thumbs={thumbs} />
        ))}
      </div>
    </section>
  );
}

function moreItems(entry: IndexEntry, item: IndexItem): MenuItem[] {
  const page = item.pageUrl ?? entry.pageUrl;
  const report = reportHref(entry, item);
  const list: MenuItem[] = [];
  // Where the row's own button is not the page already.
  if ((deliveryOf(entry, item) === 'direct' || opensFile(entry, item)) && page) list.push({ label: 'Auf der Webseite öffnen', icon: ExternalIcon, onSelect: () => openLink(page) });
  if (report) list.push({ label: 'Melden', icon: Flag, separatorBefore: list.length > 0, onSelect: () => openLink(report) });
  return list;
}

/** Whether the rows show a small cover: only when some title has a picture of its own, then every row (its own or the source's). */
function rowThumbs(entry: IndexEntry): boolean {
  return entry.items.some((it) => it.cover && it.cover !== entry.cover);
}

function ItemRow({ entry, item, picked, chosen, perItem, thumbs }: { entry: IndexEntry; item: IndexItem; picked: boolean; chosen: boolean; perItem: boolean; thumbs: boolean }) {
  const direct = deliveryOf(entry, item) === 'direct';
  const file = item.files[0];
  // The provider's own player where the app may not play a file (ARD Sounds).
  const embed = file?.url ? undefined : embedOf(entry, item);
  const meta = itemMeta(entry, item);
  const people = creatorsLine(item.creators, item.tradition);
  const menu = moreItems(entry, item);
  // The reader stands in the line below: not twice (as on the overview, SingleCard).
  const shown = people ? titleWithoutReader(item.title, item.creators) : item.title;
  const text = (
    <span class="source-item-text">
      <span class="source-item-title">{shown}</span>
      {meta ? <span class="source-item-meta">{meta}</span> : null}
      {people ? <span class="source-item-meta">{people}</span> : null}
      {item.about ? <span class="source-item-about">{item.about}</span> : null}
      {item.ages || perItem || chosen ? (
        <span class="source-item-badges">
          {chosen ? <Badge tone="accent">Empfohlen</Badge> : null}
          {item.ages ? <Badge tone="brand">{agesLabel(item.ages)}</Badge> : null}
          {perItem ? <Badge>{rightsBadge(item.rights ?? entry.rights)}</Badge> : null}
        </span>
      ) : null}
    </span>
  );
  return (
    <>
    <div class={`source-item ${picked ? 'picked' : ''} ${chosen ? 'chosen' : ''}`} data-key={item.key}>
      {direct ? (
        <label class="source-item-main">
          <input type="checkbox" checked={picked} aria-label={`Auswählen: ${item.title}`} onChange={() => togglePicked(entry.id, item.key)} />
          {thumbs ? <SourceCover cover={item.cover ?? entry.cover} title={item.title} size="sm" /> : null}
          {text}
        </label>
      ) : (
        <div class="source-item-main">
          {thumbs ? <SourceCover cover={item.cover ?? entry.cover} title={item.title} size="sm" /> : null}
          {text}
        </div>
      )}
      <div class="source-item-actions">
        {file?.url ? <PreviewButton itemKey={item.key} url={file.url} title={item.title} durationSec={item.durationSec ?? file.durationSec} disabled={!online.value} cors={loadsInPage(entry, item)} failText={previewFailedText(partWord(entry), entry.publisher)} /> : null}
        {embed ? <EmbedButton itemKey={item.key} title={item.title} disabled={!online.value} /> : null}
        {direct ? null : file && opensFile(entry, item) ? (
          <ExternalLink class="btn sm" href={file.url} onOpen={() => startWatch(entry.id)}>
            Datei öffnen
          </ExternalLink>
        ) : (
          <ExternalLink class="btn sm" href={item.pageUrl ?? entry.pageUrl} onOpen={() => startWatch(entry.id)}>
            Auf der Webseite öffnen
          </ExternalLink>
        )}
        {menu.length ? <MenuButton trigger={(open) => <IconButton label={`Mehr zu ${item.title}`} icon={Ellipsis} size="sm" onClick={open} />} items={menu} /> : null}
      </div>
    </div>
    {embed ? <EmbedFrame itemKey={item.key} url={embed} title={item.title} publisher={playerName(embed)} /> : null}
    </>
  );
}

/** An album: always added as a whole, songs to listen into. */
function WorkCard({ entry, item }: { entry: IndexEntry; item: IndexItem }) {
  // A click on a found song ("Lied: Alle meine Entchen") opens the list, EntryBody scrolls to it.
  const [open, setOpen] = useState(() => !!focusItem.value?.key.startsWith(`${item.key}#`));
  const files = filesInOrder(item);
  const seconds = item.durationSec ?? (files.every((f) => f.durationSec) ? files.reduce((s, f) => s + (f.durationSec ?? 0), 0) : undefined);
  const bytes = plannedBytes(picksOf(entry, [item]));
  const meta = [plural(files.length, 'Lied', 'Lieder'), lengthLabel(seconds), bytes ? formatBytes(bytes) : ''].filter(Boolean).join(' · ');
  const people = creatorsLine(item.creators, item.tradition);
  const b = blocker.value;
  const offline = !online.value;
  const busy = !!run.value;
  const direct = deliveryOf(entry, item) === 'direct';
  const menu = moreItems(entry, item);
  // An album named like its source has its title in the page heading already: here only for screen readers.
  const sameTitle = safeName(item.title) === safeName(entry.title);
  return (
    <section class="card source-work" data-key={item.key} aria-label={item.title}>
      <div class="source-work-head">
        <div class="source-work-text">
          <h2 class={sameTitle ? 'visually-hidden' : undefined}>{item.title}</h2>
          {people ? <span class="soft">{people}</span> : null}
          <span class="small muted">{meta}</span>
          {item.about ? <span class="source-item-about">{item.about}</span> : null}
          {item.ages ? (
            <span class="source-item-badges">
              <Badge tone="brand">{agesLabel(item.ages)}</Badge>
            </span>
          ) : null}
        </div>
        <div class="source-work-actions">
          {direct ? (
            <Button variant="primary" icon={Plus} disabled={!!b || offline || busy} onClick={() => addFromSources(entry, [item], 'each')}>
              Album hinzufügen
            </Button>
          ) : (
            <ExternalLink class="btn" href={item.pageUrl ?? entry.pageUrl}>
              Auf der Webseite öffnen
            </ExternalLink>
          )}
          {menu.length ? <MenuButton trigger={(o) => <IconButton label={`Mehr zu ${item.title}`} icon={Ellipsis} onClick={o} />} items={menu} /> : null}
        </div>
      </div>
      {direct ? <Hold blocker={b} offline={offline} busy={busy && run.value?.entry.id !== entry.id} /> : null}
      <button type="button" class="link-button source-disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        {open ? 'Lieder ausblenden' : 'Lieder anzeigen'}
      </button>
      {open ? (
        <ol class="source-chapters">
          {files.map((f, i) => (
            <li key={f.url || f.name} data-key={`${item.key}#${i}`}>
              <span class="source-chapter-num">{f.track ?? i + 1}</span>
              <span class="source-chapter-title">{f.title ?? `Teil ${i + 1}`}</span>
              <span class="small muted nowrap">{lengthLabel(f.durationSec)}</span>
              {f.url ? <PreviewButton itemKey={`${item.key}#${i}`} url={f.url} title={f.title ?? item.title} durationSec={f.durationSec} disabled={offline} cors={loadsInPage(entry, item)} failText={previewFailedText(partWord(entry), entry.publisher)} /> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ selection */

/** Under the card switch when picked episodes are parts of one story ("Die Schatzinsel (1/3)" to "(3/3)"). */
const STORY_NOTE = 'Die Teile einer Geschichte kommen zusammen auf eine Karte, der Reihe nach.';

function SelectionBar({ entry }: { entry: IndexEntry }) {
  const keys = pickedKeys(entry.id);
  const items = entry.items.filter((it) => keys.has(it.key) && deliveryOf(entry, it) === 'direct');
  if (!items.length) return null;
  const mode = cardModeFor(entry.id, items);
  const bytes = plannedBytes(picksOf(entry, items));
  const b = blocker.value;
  const offline = !online.value;
  return (
    <div class="import-bar source-bar" role="region" aria-label="Auswahl">
      <ImportBarFlag />
      <div class="source-bar-text">
        <strong>{selectionLine(items.length, plannedSeconds(items), bytes)}</strong>
        {items.length > 1 && mode === 'each' && sharedStories(items).length ? <span class="small muted">{STORY_NOTE}</span> : null}
        <Hold blocker={b} offline={offline} />
      </div>
      {items.length > 1 ? (
        <Segmented<CardMode>
          label="Karten"
          value={mode}
          options={[
            { value: 'all', label: 'Eine Karte für alle' },
            { value: 'each', label: eachLabel(entry) },
          ]}
          onChange={(m) => (cardModeChoice.value = { entry: entry.id, mode: m })}
        />
      ) : null}
      <Button variant="primary" icon={Plus} disabled={!!b || offline} onClick={() => addFromSources(entry, items, items.length > 1 ? mode : 'each')}>
        Zur Box hinzufügen
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ saved on the publisher's page */

interface Dropped {
  source: ByteSource;
  pick?: PickedFile;
}

/** A saved file the list does not know by name or size, with what the app read from it. */
interface Unknown {
  source: ByteSource;
  facts: SavedFacts;
  /** A choice's value (an item key, for an album `${key}#${song}`), NONE, or '' while nothing is chosen. */
  choice: string;
}

/** "Keine davon" in the question which title a file is. */
const NONE = '-';

/** Name, title tag and length of a saved file; only the name when it cannot be read. */
async function factsOf(source: ByteSource): Promise<SavedFacts> {
  try {
    const info = await readTrackInfo(source, { cover: false });
    return { name: source.name, title: info.title, durationSec: info.durationSec };
  } catch {
    return { name: source.name };
  }
}

/**
 * The steps and the drop zone below the list. `children` follow them; `bar`
 * adds a small drop zone that stays at the bottom of the window, for sources
 * whose list has nothing to select.
 */
/**
 * The steps to save a file on the publisher's page and bring it here, with
 * the note that the app is looking in the download folder. Above the list;
 * for an album that loads in the app, folded away with the drop zone.
 */
function SaveSteps({ entry, note }: { entry: IndexEntry; note?: string }) {
  const watchable = canWatchDownloads() && !isWholeWork(entry);
  const watching = downloadWatch.value?.entry === entry.id;
  return (
    <Callout tone="info">
      <div class="stack tight">
        <strong>{saveHeading(entry)}</strong>
        {note ? <p>{note}</p> : null}
        <ol class="source-steps">
          {saveSteps(entry, { watch: watchable }).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {watching ? (
          <div class="sources-note source-watch" role="status">
            <span>Ich schau gerade in deinem Download-Ordner nach.</span>
            <Button size="sm" variant="ghost" onClick={stopWatch}>
              Nicht mehr nachschauen
            </Button>
          </div>
        ) : null}
      </div>
    </Callout>
  );
}

function SaveAndDrop({ entry, bar, children }: { entry: IndexEntry; bar: boolean; children?: ComponentChildren }) {
  const [ask, setAsk] = useState<{ known: Dropped[]; unknown: Unknown[] } | null>(null);
  const [reading, setReading] = useState(false);
  // Saved files go to the add flow at once, so they also wait for an unseen transfer result.
  const b = handOffBlocker.value;
  const add = (files: Dropped[], mode?: CardMode) => {
    addSaved(entry, files, mode).catch((e) => toastError('Die Datei ließ sich nicht übernehmen', e));
  };
  const take = async (dropped: ByteSource[]) => {
    // A picture or a text file is no episode: left out with a word, never asked about.
    const sources = dropped.filter((s) => isAudioFile(s.name));
    const others = dropped.filter((s) => !isAudioFile(s.name) && !s.name.startsWith('.'));
    if (others.length) toast.info(notAudioText(others.map((s) => s.name)));
    if (!sources.length) return;
    const hold = handOffBlocker.value;
    if (hold) {
      toast.error(blockerText(hold, packageMode.value));
      return;
    }
    const files = sources.map((source) => ({ source, pick: matchDropped(entry, { name: source.name, size: source.size }) }));
    const unknown = files.filter((f) => !f.pick);
    if (!unknown.length) {
      add(files);
      return;
    }
    // Not known by name or size (ARD Sounds names its downloads its own way): ask, with a guess by length and name.
    setReading(true);
    const facts = await Promise.all(unknown.map((f) => factsOf(f.source)));
    setReading(false);
    setAsk({
      known: files.filter((f) => f.pick),
      unknown: unknown.map((f, i) => ({ source: f.source, facts: facts[i], choice: guessSavedChoice(entry, facts[i]) ?? '' })),
    });
  };
  const { over, handlers } = useFileDrop((sources) => void take(sources));
  // While the big drop zone is in view, the small one at the bottom of the window would only repeat it.
  const bigDrop = useRef<HTMLDivElement>(null);
  const [bigShown, setBigShown] = useState(false);
  useEffect(() => {
    const el = bigDrop.current;
    if (!bar || !el || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver(([e]) => setBigShown(e.isIntersecting), { threshold: 0.25 });
    watch.observe(el);
    return () => {
      watch.disconnect();
      setBigShown(false);
    };
  }, [bar]);
  // Files saved on the publisher's page arrive by themselves, like a drop (desktop app).
  useDownloadWatch(entry.id, (sources) => void take(sources), !!ask || reading || !!handOffBlocker.value);
  const pick = async () => {
    try {
      await take(await plat().pickFiles({ multiple: true, extensions: [...AUDIO_EXTENSIONS] }));
    } catch (e) {
      setReading(false);
      toastError('Auswählen hat nicht geklappt', e);
    }
  };
  // Albums load in the app; this is only the way out after a failed download, folded away with its steps.
  // Elsewhere the steps stand above the list (EntryBody) and only the drop zone is here.
  const folded = isWholeWork(entry);
  const steps = (
    <>
      {folded ? <SaveSteps entry={entry} /> : null}
      <div ref={bigDrop} class={`dropzone source-drop ${over ? 'over' : ''}`} {...handlers}>
        <div class="dropzone-icon">
          <Download size={26} strokeWidth={2} />
        </div>
        <h2>Heruntergeladene Datei hierher ziehen</h2>
        <Button icon={FileAudio} disabled={!!b} loading={reading} onClick={pick}>
          Datei auswählen
        </Button>
        <Hold blocker={b} />
      </div>
    </>
  );
  return (
    <>
      <section class="source-save" aria-label="Datei von der Webseite des Anbieters">
        {folded ? (
          <details class="trouble source-save-more">
            <summary>
              <Download size={18} strokeWidth={2.2} aria-hidden="true" />
              Lieder selbst herunterladen
              <ChevronDown class="trouble-chevron" size={18} strokeWidth={2.2} aria-hidden="true" />
            </summary>
            <div class="source-save-body">{steps}</div>
          </details>
        ) : (
          steps
        )}
        {ask ? (
          <WhichDialog
            entry={entry}
            known={ask.known}
            unknown={ask.unknown}
            onClose={() => setAsk(null)}
            onAdd={(files, mode) => {
              setAsk(null);
              add(files, mode);
            }}
          />
        ) : null}
      </section>
      {children}
      {bar ? (
        <div class={`import-bar source-bar source-drop-bar ${over ? 'over' : ''} ${bigShown ? 'behind' : ''}`} role="region" aria-label="Datei ablegen" inert={bigShown} {...handlers}>
          <ImportBarFlag />
          <div class="source-bar-text">
            <strong>Heruntergeladene Datei hierher ziehen</strong>
            <Hold blocker={b} />
          </div>
          <Button icon={FileAudio} disabled={!!b} loading={reading} onClick={pick}>
            Datei auswählen
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * "Welche Folge ist das?": for saved files the list does not know by name
 * or size. Every file gets a choice of the source's titles, chosen ahead
 * when length or name point to one. The chosen title is the file's origin;
 * a publisher that allows no changes then gets the file byte for byte.
 */
function WhichDialog({
  entry,
  known,
  unknown,
  onClose,
  onAdd,
}: {
  entry: IndexEntry;
  known: Dropped[];
  unknown: Unknown[];
  onClose: () => void;
  onAdd: (files: Dropped[], mode?: CardMode) => void;
}) {
  const [choices, setChoices] = useState(() => unknown.map((u) => u.choice));
  const [mode, setMode] = useState<CardMode | null>(null);
  const anyway = canAddUnmatched(entry);
  // For an album its songs: one of them fills the gap a failed download left.
  const options = useMemo(() => savedChoices(entry), [entry]);
  const severalWorks = isWholeWork(entry) && entry.items.length > 1;
  const chosen: Dropped[] = unknown.flatMap((u, i) => {
    const option = options.find((o) => o.value === choices[i]);
    if (option) return [{ source: u.source, pick: pickOfChoice(option, u.source) }];
    return choices[i] === NONE && anyway ? [{ source: u.source }] : [];
  });
  const ready = choices.every(Boolean) && known.length + chosen.length > 0;
  // Every file is "Keine davon" where nothing may be added without its title: say so instead of a grey button.
  const nothing = !anyway && !known.length && choices.every((c) => c === NONE);
  // Several episodes: one card for all or one each, like the selection bar.
  const picked = [...known, ...chosen].flatMap((f) => (f.pick ? [f.pick.item] : []));
  const several = !isWholeWork(entry) && new Set(picked.map((it) => it.key)).size > 1;
  const cardMode = mode ?? defaultCardMode([...new Set(picked)]);
  return (
    <Dialog
      title={whichQuestion(entry, unknown.length)}
      onClose={onClose}
      footer={
        nothing ? (
          <Button variant="primary" onClick={onClose}>
            Schließen
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" disabled={!ready} onClick={() => onAdd([...known, ...chosen], several ? cardMode : undefined)}>
              Hinzufügen
            </Button>
          </>
        )
      }
    >
      <div class="stack">
        <p>{whichText(entry, { files: unknown.length, known: known.length, guessed: unknown.filter((u) => u.choice).length })}</p>
        {unknown.map((u, i) => {
          const id = `source-which-${i}`;
          const length = lengthLabel(u.facts.durationSec);
          return (
            <Field key={id} id={id} label={`„${u.source.name}“${length ? ` · ${length}` : ''}`} hint={choices[i] ? undefined : 'Noch offen'}>
              <select
                class="select"
                id={id}
                value={choices[i]}
                aria-invalid={choices[i] ? undefined : true}
                onChange={(e) => setChoices(choices.map((c, k) => (k === i ? e.currentTarget.value : c)))}
              >
                <option value="" disabled>
                  Bitte auswählen
                </option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {[severalWorks ? `${o.item.title}: ${o.title}` : o.title, lengthLabel(o.durationSec)].filter(Boolean).join(' · ')}
                  </option>
                ))}
                <option value={NONE}>{noneLabel(entry)}</option>
              </select>
            </Field>
          );
        })}
        {nothing ? <Callout tone="neutral">{nothingToAddText(entry)}</Callout> : null}
        {several && !nothing ? (
          <Segmented<CardMode>
            label="Karten"
            value={cardMode}
            options={[
              { value: 'all', label: 'Eine Karte für alle' },
              { value: 'each', label: eachLabel(entry) },
            ]}
            onChange={setMode}
          />
        ) : null}
        {several && !nothing && cardMode === 'each' && sharedStories([...new Set(picked)]).length ? <p class="small muted">{STORY_NOTE}</p> : null}
      </div>
    </Dialog>
  );
}
