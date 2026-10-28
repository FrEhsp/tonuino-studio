/**
 * "Entdecken": free Hörspiele, Hörbücher and Lieder for children and teens
 * from a list kept by hand. Search and filters run on this computer; the
 * list comes with the app, from its web server or, on the desktop, from the
 * app itself (local.ts).
 */
import './sources.css';
import { useEffect, useMemo } from 'preact/hooks';
import { Plus, Search, X } from 'lucide-preact';
import { commercialHint, missingSeries, type CommercialHint } from '../../core/sources/commercial';
import { AGE_BANDS, agesLabel, CATEGORY_CHOICES, itemSeconds, search, searchWords, storyGroups, type AgeBandId, type CategoryChoice, type Hit, type Story } from '../../core/sources/filter';
import { isWholeWork, safeName } from '../../core/sources/handoff';
import type { IndexEntry, IndexItem } from '../../core/sources/types';
import { navigate, routeToHash } from '../../app/router';
import { Badge, Button, Callout, EmptyState, IconButton, Segmented } from '../../ui/components/controls';
import { EntryView } from './EntryView';
import { countLabel, creatorsLine, dayLabel, hitsSummary, lengthLabel, titleWithoutReader } from './labels';
import { reportHref, ReportLink } from './links';
import { EntryBadges, IndexGate, ListNotes, SourceCover } from './parts';
import { LeadPick, usePicks } from './Picks';
import { Shelves } from './Shelves';
import { browseShelves } from './rows';
import { BigDownloadDialog, RunPanel } from './RunPanel';
import { pruneCovers, warmCovers } from './coverCache';
import { currentIndex, ensureIndex, focusItem, kindChoice, offeredKinds, prefs, run, searchText, sourcesAvailable, updatePrefs, type ReadyState } from './state';
import { BackToWorkshop } from '../../ui/components/BackToWorkshop';

const LEAD = 'Kostenlose Hörspiele, Hörbücher und Lieder für Kinder und Jugendliche, von Radiosendern, Vereinen und mit freier Lizenz. Viele kannst du gleich hier anhören.';
const INFO =
  'Hier steht nur, was du legal und kostenlos anhören und herunterladen darfst. Ich hab die Quellen für Kinder und Jugendliche ausgesucht und schau regelmäßig wieder rein. Die Altersangaben sind nur Richtwerte. Höre am besten selbst kurz rein, bevor du etwas auf die Box lädst.';
const SONGS_NOTE = 'Freie Kinderlieder zum Herunterladen gibt es bisher nur wenige. Neue nehme ich auf, sobald ich sie mir angehört habe.';
const TEENS_NOTE = 'Für Jugendliche ist die Auswahl noch klein. Viele Hörspiele für Jugendliche gibt es nicht kostenlos zum Herunterladen.';

export function SourcesPage({ entry }: { entry?: string }) {
  const available = sourcesAvailable.value;
  const index = currentIndex.value?.index;
  useEffect(() => {
    if (!index) return;
    // Covers of all sources in the background, so a source page shows its picture at once.
    const all = index.entries.flatMap((e) => [e.cover, ...e.items.map((it) => it.cover)]).filter((u): u is string => !!u);
    void pruneCovers(all).then(() => warmCovers(index.entries.map((e) => e.cover).filter((u): u is string => !!u)));
  }, [index]);
  useEffect(() => {
    if (available) ensureIndex();
    // The question "Großer Download" belongs to this page; leaving it means no.
    return () => {
      if (run.value?.phase === 'confirm') run.value = null;
    };
  }, [available]);
  if (!available) {
    // Without the current list there is no kill switch: a build that cannot load it does not show old lists.
    return (
      <div class="page sources-page">
        <EmptyState title="Entdecken gibt es in dieser Version nicht">Diese Version der App kann die Liste von „Entdecken“ nicht laden. Mit der neuesten Version ist sie wieder da.</EmptyState>
      </div>
    );
  }
  return (
    <>
      {entry ? <EntryView key={entry} id={entry} /> : <Overview />}
      <BigDownloadDialog />
    </>
  );
}

function Overview() {
  return (
    <div class="page sources-page sources-overview">
      <header class="page-header">
        <div class="titles">
          <BackToWorkshop />
          <h1>Entdecken</h1>
          <p>{LEAD}</p>
        </div>
      </header>
      <IndexGate>{(ready) => <OverviewBody ready={ready} />}</IndexGate>
      <RunPanel />
    </div>
  );
}

function OverviewBody({ ready }: { ready: ReadyState }) {
  const p = prefs.value;
  const kind = kindChoice.value;
  const text = searchText.value;
  const hits = useMemo(() => search(ready.index, { text, category: kind, band: p.band }), [ready.index, text, kind, p.band]);
  const searching = searchWords(text).length > 0;
  // Browsing: one tip on top, then a row per show (TODO #119). Searching: the titles found, as a list.
  const picks = usePicks(ready.index, searching);
  const lead = picks[0];
  const shelves = useMemo(() => (searching ? [] : browseShelves(hits)), [searching, hits]);
  // A well-known paid series is not in the list: say why, instead of "Nichts gefunden" or unrelated titles alone.
  const series = useMemo(() => (searching ? missingSeries(ready.index, text) : undefined), [searching, text, ready.index]);
  const hint = series ? commercialHint(series) : undefined;
  const reset = () => {
    searchText.value = '';
    updatePrefs({ kind: 'alle', band: 'alle' });
  };
  return (
    <>
      <ListNotes ready={ready} />
      {!ready.index.entries.length ? (
        <EmptyState title="Noch keine Quellen">Ich nehme Quellen erst auf, wenn ich sie geprüft habe. Schau bald wieder vorbei.</EmptyState>
      ) : (
        <>
          <Filters count={hits.length ? hitsSummary(hits) : ''} />
          {kind === 'lied' ? <Callout tone="neutral">{SONGS_NOTE}</Callout> : null}
          {p.band === 'ab12' ? <Callout tone="neutral">{TEENS_NOTE}</Callout> : null}
          {lead ? <LeadPick r={lead} /> : null}
          {!p.infoDismissed ? (
            <Callout tone="info">
              <div class="sources-note">
                <span>{INFO}</span>
                <Button size="sm" onClick={() => updatePrefs({ infoDismissed: true })}>
                  Verstanden
                </Button>
              </div>
            </Callout>
          ) : null}
          {hint && hits.length ? (
            <Callout tone="neutral">
              <strong>{hint.title}.</strong> {hint.text} <HintHelp hint={hint} />
            </Callout>
          ) : null}
          {!hits.length ? null : searching ? (
            <div class="sources-grid">
              {hits.flatMap((h) =>
                h.entry.single ? storyGroups(h.items).map((st) => <SingleCard key={st.items[0].key} entry={h.entry} item={st.items[0]} story={st} />) : [<SourceCard key={h.entry.id} hit={h} />],
              )}
            </div>
          ) : (
            <Shelves shelves={shelves} />
          )}
          {hits.length ? null : hint ? (
            <EmptyState
              title={hint.title}
              actions={
                <>
                  <Button variant="primary" icon={Plus} onClick={() => navigate({ page: 'add' })}>
                    Eigene Dateien hinzufügen
                  </Button>
                  <Button onClick={() => (searchText.value = '')}>Suche leeren</Button>
                </>
              }
            >
              {hint.text} <HintHelp hint={hint} />
            </EmptyState>
          ) : (
            <EmptyState
              title={searching ? 'Nichts gefunden' : 'Für diese Auswahl gibt es noch nichts'}
              actions={
                <Button variant="primary" onClick={reset}>
                  Filter zurücksetzen
                </Button>
              }
            >
              {searching ? 'Versuche ein anderes Wort oder setze die Filter für Art und Alter zurück.' : 'Setze die Filter für Art und Alter zurück, dann siehst du wieder alles.'}
            </EmptyState>
          )}
        </>
      )}
      <Footer ready={ready} />
    </>
  );
}

/** "Was du kaufen kannst": copy protection and streaming, so nobody buys what the app cannot open. */
function HintHelp({ hint }: { hint: CommercialHint }) {
  return hint.help ? <a href={routeToHash({ page: 'help', topic: hint.help })}>Was beim Kaufen wichtig ist</a> : null;
}

/** Search, kind and age on the paper, no box around them; how much fits, quietly beside. */
function Filters({ count }: { count: string }) {
  const p = prefs.value;
  // "Lieder" only once the list has songs.
  const kinds = CATEGORY_CHOICES.filter((c) => offeredKinds.value.includes(c.id));
  return (
    <section class="sources-filters" aria-label="Suche und Auswahl">
      <div class="input-group sources-search">
        <Search size={18} aria-hidden="true" />
        <label for="sources-q" class="visually-hidden">
          Suchen
        </label>
        <input
          id="sources-q"
          class="input"
          type="search"
          autocomplete="off"
          spellcheck={false}
          placeholder="Titel oder Name suchen"
          value={searchText.value}
          onInput={(e) => (searchText.value = e.currentTarget.value)}
        />
        {searchText.value ? <IconButton class="sources-search-clear" label="Suche leeren" icon={X} size="sm" onClick={() => (searchText.value = '')} /> : null}
      </div>
      <div class="sources-choices">
        <div class="sources-choice">
          <span class="sources-choice-label" aria-hidden="true">
            Art
          </span>
          <Segmented<CategoryChoice> label="Art" value={kindChoice.value} options={kinds.map((c) => ({ value: c.id, label: c.label }))} onChange={(kind) => updatePrefs({ kind })} />
        </div>
        <div class="sources-choice">
          <span class="sources-choice-label" aria-hidden="true">
            Alter
          </span>
          <Segmented<AgeBandId> label="Alter" value={p.band} options={AGE_BANDS.map((b) => ({ value: b.id, label: b.label }))} onChange={(band) => updatePrefs({ band })} />
        </div>
        <p class="sources-count" role="status">
          {count}
        </p>
      </div>
    </section>
  );
}

/** What a found chapter or song is called under a source card. */
const PART_WORD: Partial<Record<IndexEntry['type'], string>> = { 'archive-album': 'Lied' };

/** One source found by the search: the titles found, and whether the editors recommend it (no tip shows above then). */
function SourceCard({ hit }: { hit: Hit }) {
  const { entry, items } = hit;
  const showItems = hit.itemsMatched;
  const href = routeToHash({ page: 'sources', entry: entry.id });
  // A found song stands in for its album: "Lied: Alle meine Entchen" under the album.
  // An album named like its source is no news under its own card.
  const rows = items.flatMap((it) => {
    const chapters = hit.chapters.filter((c) => c.item === it);
    if (chapters.length) return chapters.map((c) => ({ key: c.key, title: `${PART_WORD[entry.type] ?? 'Teil'}: ${c.title}`, sec: undefined }));
    return safeName(it.title) === safeName(entry.title) ? [] : [{ key: it.key, title: it.title, sec: it.durationSec }];
  });
  const more = rows.length - 3;
  // Found titles do not make the source smaller: "21 Folgen · 1 passt zur Suche".
  const count =
    showItems && items.length < entry.items.length && !isWholeWork(entry)
      ? `${countLabel(entry, entry.items)} · ${items.length.toLocaleString('de-DE')} ${items.length === 1 ? 'passt' : 'passen'} zur Suche`
      : countLabel(entry, items);
  return (
    <article class="source-hit">
      <SourceCover entry={entry} cover={entry.cover} title={entry.title} />
      <div class="source-card-body">
        <h2 class="source-card-title">
          <a class="source-card-link" href={href}>
            {entry.title}
          </a>
        </h2>
        <p class="source-card-publisher">{entry.publisher}</p>
        {entry.featured ? (
          <span class="source-badges">
            <Badge tone="success">Empfehlung</Badge>
          </span>
        ) : null}
        {entry.blurb ?? entry.about ? <p class="source-card-about">{entry.blurb ?? entry.about}</p> : null}
        <EntryBadges entry={entry} />
        <p class="source-card-count">{count}</p>
        {showItems && rows.length ? (
          <ul class="source-card-items">
            {rows.slice(0, 3).map((r) => (
              <li key={r.key}>
                <a href={href} onClick={() => (focusItem.value = { entry: entry.id, key: r.key })}>
                  {r.title}
                </a>
                {r.sec ? <span class="muted"> · {lengthLabel(r.sec)}</span> : null}
              </li>
            ))}
            {more > 0 ? <li class="muted">und {more.toLocaleString('de-DE')} weitere</li> : null}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

/**
 * A title found by the search, of a source that lists its titles one by one
 * (OHRKA, the ARD shows): its own cover, speaker, age and words from the
 * source, on the paper without a box. A story
 * told in parts has one card with its name and all parts together. The card
 * opens the source page at that title (or the story's first part).
 */
export function SingleCard({ entry, item, story }: { entry: IndexEntry; item: IndexItem; story?: Story }) {
  const href = routeToHash({ page: 'sources', entry: entry.id });
  const people = creatorsLine(item.creators, item.tradition);
  const parts = story && story.items.length > 1 ? story.items : undefined;
  const secs = parts?.map(itemSeconds);
  const length = lengthLabel(secs ? (secs.every((x) => x !== undefined) ? secs.reduce<number>((a, b) => a + (b ?? 0), 0) : undefined) : item.durationSec);
  const name = parts ? story!.title : item.title;
  const title = people ? titleWithoutReader(name, item.creators) : name;
  return (
    <article class="source-hit">
      <SourceCover entry={entry} cover={item.cover ?? entry.cover} title={item.title} />
      <div class="source-card-body">
        <h2 class="source-card-title">
          <a class="source-card-link" href={href} onClick={() => (focusItem.value = { entry: entry.id, key: item.key })}>
            {title}
          </a>
        </h2>
        <p class="source-card-publisher">{entry.title}</p>
        {people ? <p class="source-card-people">{people}</p> : null}
        {item.about ? <p class="source-card-about">{item.about}</p> : null}
        <p class="source-card-meta">{[agesLabel(item.ages ?? entry.ages), parts ? `${parts.length} Teile` : '', length].filter(Boolean).join(' · ')}</p>
      </div>
    </article>
  );
}

function Footer({ ready }: { ready: ReadyState }) {
  const report = reportHref();
  return (
    <footer class="sources-footer">
      <span>Stand der Liste: {dayLabel(ready.index.generatedAt)}</span>
      <span>
        <a href={routeToHash({ page: 'help', topic: 'entdecken' })}>Woher kommen die Inhalte?</a>
      </span>
      {report ? (
        <span>
          Etwas stimmt nicht? <ReportLink href={report}>Melden</ReportLink>
        </span>
      ) : null}
    </footer>
  );
}
