/** Pieces shared by the overview and the source pages of "Entdecken". */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { RefreshCw, WifiOff } from 'lucide-preact';
import { Badge, Button, Callout, EmptyState } from '../../ui/components/controls';
import { agesLabel, CATEGORY_LABEL } from '../../core/sources/filter';
import type { IndexEntry } from '../../core/sources/types';
import { navigate } from '../../app/router';
import { platform } from '../../app/state';
import { cardReading, chooseCardFolder } from '../../app/pending';
import { blockerText, BUSY_HINT, dayLabel, deliveryOf, entryRightsBadge, OFFLINE_HINT, type Blocker } from './labels';
import { coverFailed, coverRev, coverSrc } from './coverCache';
import { canUpdateList, currentIndex, ensureIndex, indexState, localListMode, online, packageMode, type ReadyState } from './state';

/**
 * The cover of a source or title: only the picture the source itself publishes
 * (the owner wants originals only, nothing drawn). The square keeps its place
 * from the start, empty and calm, and the picture fades in once it is loaded:
 * nothing jumps or pops while people scroll. Without a picture, or when it does
 * not load, the square stays empty (the small one on the start page goes away).
 * Pass `cover` only on "Entdecken": the picture comes from the source's server
 * (no referrer) once and is kept on this computer (coverCache.ts). The start
 * page passes none, it stays offline.
 */
export function SourceCover({ cover, title, size = 'md' }: { entry?: Pick<IndexEntry, 'id' | 'categories'>; cover?: string; title?: string; size?: 'sm' | 'md' | 'lg' }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  void coverRev.value;
  void online.value;
  // Stored covers show at once (also offline); the others load from the source.
  const src = cover ? coverSrc(cover) : undefined;
  const picture = src || undefined;
  const waiting = !!cover && src === undefined;
  if (!picture && !waiting && size === 'sm') return null;
  return (
    <div class={`source-cover ${size}${picture || waiting ? ' has-picture' : ' no-picture'}${picture && loaded === picture ? ' is-loaded' : ''}`} aria-hidden={picture ? undefined : 'true'}>
      {picture ? (
        <img
          key={picture}
          class="source-cover-img"
          src={picture}
          alt={title ?? ''}
          width={COVER_PX[size]}
          height={COVER_PX[size]}
          decoding="async"
          referrerpolicy="no-referrer"
          onLoad={() => setLoaded(picture)}
          onError={() => cover && coverFailed(cover, picture)}
        />
      ) : null}
    </div>
  );
}

/** Where the cover of a source comes from, small under its picture on the source page; only while there is a picture to credit. */
export function CoverCredit({ entry }: { entry: Pick<IndexEntry, 'cover' | 'coverFrom'> }) {
  void coverRev.value;
  if (!entry.cover || !entry.coverFrom || !coverSrc(entry.cover)) return null;
  return <p class="source-cover-credit">{entry.coverFrom}</p>;
}

/** Edge of the square cover in CSS pixels per size (sources.css; phones show it smaller). */
const COVER_PX = { sm: 40, md: 96, lg: 136 } as const;

/** Kinds, age, licence, language and how the files are loaded. */
export function EntryBadges({ entry }: { entry: IndexEntry }) {
  const browserOnly = entry.items.length > 0 && entry.items.every((it) => deliveryOf(entry, it) === 'browser');
  return (
    <div class="source-badges">
      {entry.categories.map((c) => (
        <Badge key={c}>{CATEGORY_LABEL[c]}</Badge>
      ))}
      <Badge tone="brand">{agesLabel(entry.ages)}</Badge>
      <Badge>{entryRightsBadge(entry)}</Badge>
      {entry.language === 'gsw' ? <Badge>Schweizerdeutsch</Badge> : null}
      {browserOnly ? <Badge tone="accent">Laden über die Webseite</Badge> : null}
    </div>
  );
}

/** Old list, kept copy, offline. */
export function ListNotes({ ready }: { ready: ReadyState }) {
  const date = dayLabel(ready.index.generatedAt);
  const loading = indexState.value.status === 'loading';
  const reload = (
    <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={() => ensureIndex(true)}>
      Erneut laden
    </Button>
  );
  const kept = ready.from !== 'network';
  if (!canUpdateList.value) {
    // No address for a newer list: the one that came with the app is all there is, and that is fine.
    return (
      <>
        {!online.value ? (
          <Callout tone="neutral" icon={WifiOff}>
            Du bist offline. Reinhören und Laden gehen erst wieder mit Internet.
          </Callout>
        ) : null}
        <p class="sources-list-date small muted">
          Die Liste kam mit dieser Version von TonUINO Studio (Stand {date}). Folgen der Sender verschwinden von selbst, sobald ihre Zeit dort abläuft.
        </p>
      </>
    );
  }
  return (
    <>
      {!online.value ? (
        <Callout tone="neutral" icon={WifiOff}>
          Du bist offline und siehst die zuletzt geladene Liste. Reinhören und Laden gehen erst wieder mit Internet.
        </Callout>
      ) : null}
      {kept && loading && online.value ? (
        <Callout tone="neutral">
          <div class="sources-note">
            <span>Die aktuelle Liste wird noch geladen. Bis dahin siehst du die Liste vom {date}.</span>
            {reload}
          </div>
        </Callout>
      ) : ready.stale ? (
        <Callout tone="warning">
          <div class="sources-note">
            <span>Du siehst die Liste vom {date}. Manche Folgen sind beim Anbieter vielleicht nicht mehr online.</span>
            {kept && online.value ? reload : null}
          </div>
        </Callout>
      ) : kept && online.value ? (
        <Callout tone="neutral">
          <div class="sources-note">
            <span>Die aktuelle Liste ließ sich gerade nicht laden. Du siehst die Liste vom {date}.</span>
            {reload}
          </div>
        </Callout>
      ) : null}
    </>
  );
}

/** Shows the list once it is there; while it loads a placeholder; when it cannot be loaded, why. */
export function IndexGate({ children }: { children: (ready: ReadyState) => ComponentChildren }) {
  const s = indexState.value;
  const ready = currentIndex.value;
  if (ready) return <>{children(ready)}</>;
  if (s.status === 'error' && s.reason === 'needs-update') {
    const web = platform.value?.kind !== 'desktop';
    return (
      <EmptyState
        title="Neue Version nötig"
        actions={
          web ? (
            <Button variant="primary" icon={RefreshCw} onClick={() => location.reload()}>
              Seite neu laden
            </Button>
          ) : null
        }
      >
        Für die aktuelle Liste brauchst du eine neuere Version von TonUINO Studio.{' '}
        {web ? 'Lade die Seite neu, dann bekommst du sie.' : 'Installiere die neueste Version, dann siehst du die Liste wieder.'}
      </EmptyState>
    );
  }
  if (s.status === 'error' && localListMode.value) {
    // The desktop app builds the list itself, from the sources' own servers.
    return (
      <EmptyState
        title={s.offline ? 'Keine Verbindung zum Internet' : 'Die Liste ließ sich nicht laden'}
        actions={
          <Button variant="primary" icon={RefreshCw} onClick={() => ensureIndex(true)}>
            Erneut laden
          </Button>
        }
      >
        {s.offline
          ? 'Für die Liste frage ich einmal am Tag bei den Sendern und bei OHRKA nach. Verbinde den Computer mit dem Internet und versuche es noch einmal.'
          : 'Die Quellen haben gerade nicht geantwortet. Versuche es später noch einmal.'}
      </EmptyState>
    );
  }
  if (s.status === 'error') {
    return (
      <EmptyState
        title="Die Liste ist gerade nicht erreichbar"
        actions={
          <Button variant="primary" icon={RefreshCw} onClick={() => ensureIndex(true)}>
            Erneut laden
          </Button>
        }
      >
        {s.answered && !s.offline
          ? 'Das liegt nicht an deiner Internetverbindung. Versuche es später noch einmal.'
          : 'Prüfe deine Internetverbindung und versuche es gleich noch einmal.'}
      </EmptyState>
    );
  }
  if (localListMode.value) {
    return (
      <p class="sources-loading-text" role="status">
        Liste wird geladen …
      </p>
    );
  }
  return (
    <div class="sources-loading" role="status" aria-label="Die Liste wird geladen">
      {[0, 1, 2, 3].map((i) => (
        <div class="source-card skeleton-card" key={i}>
          <div class="source-cover skeleton" />
          <div class="source-card-body">
            <div class="skeleton" style={{ height: 18, width: '70%' }} />
            <div class="skeleton" style={{ height: 14, width: '45%' }} />
            <div class="skeleton" style={{ height: 22, width: '85%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Why "Zur Box hinzufügen" cannot be used right now, with the way out. */
export function Hold({ blocker, offline, busy }: { blocker: Blocker | null; offline?: boolean; busy?: boolean }) {
  if (offline) return <p class="source-hold">{OFFLINE_HINT}</p>;
  if (blocker) {
    return (
      <p class="source-hold">
        {blockerText(blocker, packageMode.value)}{' '}
        {blocker.kind === 'card' ? (
          packageMode.value ? (
            // The same button as on "Meine Box": the browser's folder chooser for the card.
            cardReading.value ? (
              <span class="soft">Liest die Karte ein …</span>
            ) : (
              <button type="button" class="link-button source-hold-link" onClick={() => chooseCardFolder('card')}>
                SD-Karte einlesen
              </button>
            )
          ) : (
            <a href="#/" class="source-hold-link">
              Zu „Meine Box“
            </a>
          )
        ) : blocker.kind === 'folder' ? (
          <button type="button" class="link-button source-hold-link" onClick={() => navigate({ page: 'add', folder: blocker.folder })}>
            Zur Auswahl
          </button>
        ) : blocker.kind === 'result' ? (
          <button type="button" class="link-button source-hold-link" onClick={() => navigate({ page: 'add', folder: blocker.folder })}>
            Zum Ergebnis
          </button>
        ) : blocker.kind === 'rest' ? (
          <button type="button" class="link-button source-hold-link" onClick={() => navigate({ page: 'add', folder: blocker.folder })}>
            Zur Übertragung
          </button>
        ) : null}
      </p>
    );
  }
  if (busy) return <p class="source-hold">{BUSY_HINT}</p>;
  return null;
}
