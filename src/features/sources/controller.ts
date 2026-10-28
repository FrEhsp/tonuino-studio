/**
 * What happens on the "Entdecken" pages, with everything it touches passed
 * in: the network, the browser storage, the add flow, the router and the
 * messages. state.ts connects it to the app; the tests connect it to fakes.
 *
 * - The list: a slow server does not leave the page empty. After a moment
 *   the kept copy shows, and the current list replaces it when it arrives.
 * - A download runs on while people look around. It ends in the normal add
 *   flow (addSources) with titles, album, order and the origin of every file.
 * - Loaded files wait while the SD card is missing, while something is read
 *   or written, and while the result of the last transfer is still unseen:
 *   a download never replaces that result.
 */
import { computed, effect, signal, type ReadonlySignal } from '@preact/signals';
import { fileSource } from '../../core/audio/source';
import { DownloadError, downloadFiles, messageFor, type DownloadOptions, type DownloadProgress } from '../../core/sources/download';
import type { AgeBandId, CategoryChoice } from '../../core/sources/filter';
import {
  BIG_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_BYTES,
  defaultCardMode,
  isWholeWork,
  picksOf,
  plannedBytes,
  planFiles,
  type CardMode,
  type PickedFile,
  type PlannedFile,
} from '../../core/sources/handoff';
import { loadIndex, loadKept, type LoadResult, type SmallStore } from '../../core/sources/load';
import { checkReach, expiredItems, goneItems, readReachCache, withoutGone, type ReachCache } from '../../core/sources/reach';
import { trackOrigin, type TrackOrigin } from '../../core/sources/origin';
import type { IndexEntry, IndexItem, SourceIndex } from '../../core/sources/types';
import { largestCover } from '../../core/sources/cover';
import type { TrackInfo } from '../../core/library/tags';
import type { ByteSource } from '../../platform/types';
import type { Route } from '../../app/router';
import { formatBytes } from '../../app/format';
import type { AddOptions, AddResult, ImportResult, ImportSession, RejectedEntry } from '../add/session';
import { failedMessage, missingLine, missingName, partWord, type Blocker } from './labels';

/* ------------------------------------------------------------------ types */

export type ReadyState = Extract<LoadResult, { status: 'ready' }> & { loadedAt: number };

export type IndexState =
  | { status: 'idle' }
  | { status: 'loading'; previous?: ReadyState }
  | ReadyState
  | (Extract<LoadResult, { status: 'error' }> & { loadedAt: number });

export interface Prefs {
  kind: CategoryChoice;
  band: AgeBandId;
  infoDismissed: boolean;
}

interface Loaded {
  pick: PickedFile;
  /** Position in the playing order, to keep it after loading missing files again. */
  order: number;
  /** What was loaded, or the file the family saved by hand for a missing one. */
  data: Blob | ByteSource;
}

interface Missing {
  pick: PickedFile;
  order: number;
  error?: DownloadError;
}

interface RunBase {
  entry: IndexEntry;
  items: IndexItem[];
  mode: CardMode;
}

export type RunState =
  | (RunBase & { phase: 'confirm'; bytes: number })
  | (RunBase & { phase: 'loading'; progress?: DownloadProgress; current?: string })
  | (RunBase & { phase: 'failed'; loaded: Loaded[]; missing: Missing[]; message: string; partial: string; total: number })
  | (RunBase & { phase: 'waiting'; loaded: Loaded[]; rejected: RejectedEntry[] })
  | (RunBase & { phase: 'adding' });

export interface Toasts {
  success(title: string, text?: string, action?: { label: string; run: () => void }): void;
  error(title: string, text?: string): void;
  info(title: string, text?: string): void;
}

export interface SourcesDeps {
  /** plat().fetch: the list and the files. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The files of a download, when some of them take another way than `fetch` (the desktop app's own loading, rangedFetch). */
  fileFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** localStorage, when the browser allows it. */
  storage: () => SmallStore | null;
  /** Where the list comes from in this build, or nothing. */
  listUrl: () => string | undefined;
  /** The list that came with the app. */
  snapshot: () => Promise<unknown>;
  /**
   * Desktop app: the list built on this computer replaces the
   * published one (and the kept copy). Undefined, or a call that returns
   * undefined: the published list.
   */
  localList?: () => LocalListSource | undefined;
  now: () => number;
  /** navigator.onLine */
  isOnline: () => boolean;
  /** An SD card is open and read. Called inside computed values, so it may read signals. */
  cardReady: () => boolean;
  /**
   * Paket mode: the browser cannot write to the card, the changes go into a
   * Paket. Changes the words ("ins Paket für die Karte"). May read signals.
   */
  packaged?: () => boolean;
  /** The add flow. */
  session: ReadonlySignal<ImportSession>;
  addSources: (sources: ByteSource[], opts: AddOptions) => Promise<AddResult>;
  resetImport: (forFolder?: number) => void;
  route: ReadonlySignal<Route>;
  navigate: (r: Route) => void;
  toast: Toasts;
  /**
   * The source's own cover picture, from the stored copy or fetched once
   * (coverCache.ts); undefined when there is none or its host allows no copy.
   * Without it, files go to the add flow without a picture.
   */
  coverBlob?: (url: string) => Promise<Blob | undefined>;
  /** Download settings that tests shorten: waits and the idle time. */
  download?: Pick<DownloadOptions, 'wait' | 'idleMs' | 'now'>;
  /** How long the page waits for the current list before it shows the kept copy. */
  keptAfterMs?: number;
  /** How long the list request may take (INDEX_TIMEOUT_MS). */
  indexTimeoutMs?: number;
  /**
   * Ask whether the titles are still online after the list loaded on
   * "Entdecken", and hide the ones that are gone (src/core/sources/reach.ts).
   */
  checkReach?: boolean;
}

/** The list built on this computer (src/core/sources/local.ts). */
export interface LocalListSource {
  /** The current list: today's, else a new build, else the last one. */
  load(signal: AbortSignal): Promise<LoadResult>;
  /** The last list without building. */
  kept(): Promise<Extract<LoadResult, { status: 'ready' }> | undefined>;
}

/** A list from the network is loaded again after an hour, a kept copy after a minute. */
export const RELOAD_AFTER_MS = 60 * 60 * 1000;
export const RETRY_AFTER_MS = 60 * 1000;
/** Without the current list after this long, the page shows the kept copy meanwhile. */
export const KEPT_AFTER_MS = 1500;

const PREFS_KEY = 'tonuino-studio:sources';
const ALL_KINDS: readonly CategoryChoice[] = ['alle', 'hoerspiel', 'hoerbuch', 'wissen', 'lied'];
const DEFAULT_PREFS: Prefs = { kind: 'alle', band: 'alle', infoDismissed: false };

/** Picture types the add flow takes as a folder's cover file. */
const COVER_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Waits that end by themselves: the run goes on without "Weiter". */
const AUTOMATIC: ReadonlySet<Blocker['kind']> = new Set(['writing', 'reading', 'result', 'rest']);

/* ------------------------------------------------------------------ the state */

/** A result the family should see before new files replace it: something went wrong or was left out. */
export function worthALook(r: ImportResult): boolean {
  return !!r.error || !!r.cancelled || r.refused.length > 0 || r.skipped.length > 0 || !!r.unordered?.length;
}

export function createSourcesState(deps: SourcesDeps) {
  /* ---------------------------------------------------------------- the list */

  const indexState = signal<IndexState>({ status: 'idle' });

  /** What the app found out about titles still being online (reach.ts); read once, then kept up to date. */
  const reach = signal<ReachCache>(deps.checkReach ? readReachCache(deps.storage()) : { format: 1, results: {} });

  /**
   * A list without the titles that are no longer online: those whose time at
   * the publisher is over (until), and those a stored answer found gone.
   * Sources left without titles go as well. Asks nothing.
   */
  function withoutMissing(index: SourceIndex): SourceIndex {
    const now = deps.now();
    const missing = expiredItems(index, now);
    if (deps.checkReach) for (const k of goneItems(index, reach.value, now)) missing.add(k);
    return withoutGone(index, missing);
  }

  /** The list shown right now, also while a newer one loads, without titles that are no longer online. */
  const currentIndex = computed(() => {
    const s = indexState.value;
    const shown = s.status === 'ready' ? s : s.status === 'loading' ? s.previous : undefined;
    if (!shown) return shown;
    const index = withoutMissing(shown.index);
    return index === shown.index ? shown : { ...shown, index };
  });

  let reachCtrl: AbortController | null = null;

  /** Asks about titles without a recent answer; only when "Entdecken" loaded its list, never at start. */
  function checkStillOnline(index: SourceIndex): void {
    if (!deps.checkReach || !deps.isOnline()) return;
    reachCtrl?.abort();
    const ctrl = new AbortController();
    reachCtrl = ctrl;
    checkReach(index, { fetch: deps.fetch, storage: deps.storage(), now: deps.now, signal: ctrl.signal })
      .then((cache) => {
        if (reachCtrl === ctrl) reach.value = cache;
      })
      .catch(() => undefined)
      .finally(() => {
        if (reachCtrl === ctrl) reachCtrl = null;
      });
  }

  /** Whether the browser has a connection; previews and downloads need one. */
  const online = signal(deps.isOnline());

  let listCtrl: AbortController | null = null;

  /** Loads the list when the page opens unless a fresh one is there; `force` for "Erneut laden", also while one loads. */
  function ensureIndex(force = false): void {
    const s = indexState.value;
    if (s.status === 'loading' && !force) return;
    if (!force && s.status === 'ready' && deps.now() - s.loadedAt < (s.from === 'network' ? RELOAD_AFTER_MS : RETRY_AFTER_MS)) return;
    void reload();
  }

  function shownList(): ReadyState | undefined {
    const s = indexState.value;
    return s.status === 'ready' ? s : s.status === 'loading' ? s.previous : undefined;
  }

  async function reload(): Promise<void> {
    listCtrl?.abort();
    const ctrl = new AbortController();
    listCtrl = ctrl;
    const previous = shownList();
    const local = deps.localList?.();
    const kept = () => (local ? local.kept() : loadKept({ storage: deps.storage(), snapshot: deps.snapshot, now: deps.now() }));
    indexState.value = { status: 'loading', previous };
    // A slow server: show the kept copy after a moment instead of placeholders.
    const keptTimer = previous
      ? undefined
      : setTimeout(() => {
          kept()
            .then((kept) => {
              const s = indexState.value;
              if (listCtrl === ctrl && kept && s.status === 'loading' && !s.previous) indexState.value = { status: 'loading', previous: { ...kept, loadedAt: deps.now() } };
            })
            .catch(() => undefined);
        }, deps.keptAfterMs ?? KEPT_AFTER_MS);
    try {
      const r = local
        ? await local.load(ctrl.signal)
        : await loadIndex({
            url: deps.listUrl(),
            fetch: deps.fetch,
            storage: deps.storage(),
            snapshot: deps.snapshot,
            now: deps.now(),
            isOnline: deps.isOnline,
            signal: ctrl.signal,
            timeoutMs: deps.indexTimeoutMs,
          });
      if (listCtrl !== ctrl) return;
      listCtrl = null;
      const shown = shownList();
      // A list from the network wins over the copy shown before; a failed reload keeps what is shown.
      indexState.value = r.status === 'error' && shown ? { ...shown, offline: r.offline } : { ...r, loadedAt: deps.now() };
      if (r.status === 'ready' && r.from === 'network') stopBlockedRun(r.index);
      if (r.status === 'ready') checkStillOnline(r.index);
    } catch {
      if (listCtrl !== ctrl) return;
      listCtrl = null;
      indexState.value = shownList() ?? { status: 'error', reason: 'unavailable', offline: !deps.isOnline(), loadedAt: deps.now() };
    } finally {
      clearTimeout(keptTimer);
    }
  }

  /**
   * The kept copy or the list that came with the app, for the teaser on the
   * start page. Read once, without the network: the app goes online for the
   * list only when someone opens "Entdecken".
   */
  const keptIndex = signal<SourceIndex | undefined>(undefined);
  let peeked = false;

  function peekKept(): void {
    if (peeked || currentIndex.value) return;
    peeked = true;
    const local = deps.localList?.();
    (local ? local.kept() : loadKept({ storage: deps.storage(), snapshot: deps.snapshot, now: deps.now() }))
      .then((kept) => {
        if (kept) keptIndex.value = kept.index;
      })
      .catch(() => {
        peeked = false;
      });
  }

  /**
   * The list for the teaser: the one on "Entdecken" when it was opened, else
   * the kept copy, also without the titles that are no longer online (only
   * what is known already; nothing is asked here).
   */
  const teaserIndex = computed<SourceIndex | undefined>(() => {
    if (currentIndex.value) return currentIndex.value.index;
    const kept = keptIndex.value;
    return kept ? withoutMissing(kept) : kept;
  });

  /** The browser's "online" and "offline" events. Back online, a kept copy or an error is replaced by the current list. */
  function setOnline(on: boolean): void {
    online.value = on;
    if (!on) return;
    const s = indexState.value;
    if (s.status === 'error' || (s.status === 'ready' && s.from !== 'network')) ensureIndex(true);
  }

  /* ---------------------------------------------------------------- choices */

  function loadPrefs(): Prefs {
    try {
      const raw = deps.storage()?.getItem(PREFS_KEY);
      if (!raw) return { ...DEFAULT_PREFS };
      const v = JSON.parse(raw) as Partial<Prefs>;
      return {
        kind: ALL_KINDS.find((k) => k === v.kind) ?? 'alle',
        band: (['alle', 'bis5', '6bis11', 'ab12'] as const).find((b) => b === v.band) ?? 'alle',
        infoDismissed: v.infoDismissed === true,
      };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  const prefs = signal<Prefs>(loadPrefs());

  function updatePrefs(patch: Partial<Prefs>): void {
    prefs.value = { ...prefs.value, ...patch };
    try {
      deps.storage()?.setItem(PREFS_KEY, JSON.stringify(prefs.value));
    } catch {
      // Not kept; still applies until the page is closed.
    }
  }

  /** The kinds the list has titles of, with "Alles": no "Lieder" while there are no songs. Before any list, every kind. */
  const offeredKinds = computed<readonly CategoryChoice[]>(() => {
    const index = teaserIndex.value;
    if (!index) return ALL_KINDS;
    const has = new Set(index.entries.flatMap((e) => e.items.map((it) => it.category)));
    return ALL_KINDS.filter((k) => k === 'alle' || has.has(k));
  });

  /** The kind that applies: the chosen one, or "Alles" when the list has nothing of it (the choice stays for later). */
  const kindChoice = computed<CategoryChoice>(() => (offeredKinds.value.includes(prefs.value.kind) ? prefs.value.kind : 'alle'));

  /** The search text, for this visit only. */
  const searchText = signal('');

  /**
   * An item to scroll to when its source page opens (a click on a search
   * result). From a pick: all parts of its story, which stay marked there.
   */
  const focusItem = signal<{ entry: string; key: string; keys?: string[]; story?: string } | null>(null);

  /* ---------------------------------------------------------------- selection */

  /** The picked items: they always belong to one source. */
  const picked = signal<{ entry: string; keys: string[] }>({ entry: '', keys: [] });
  /** The card switch, when the user changed it; else the default for the selection. */
  const cardModeChoice = signal<{ entry: string; mode: CardMode } | null>(null);

  function pickedKeys(entryId: string): Set<string> {
    const p = picked.value;
    return new Set(p.entry === entryId ? p.keys : []);
  }

  function setPicked(entryId: string, keys: string[]): void {
    picked.value = { entry: entryId, keys };
    if (cardModeChoice.value?.entry !== entryId) cardModeChoice.value = null;
  }

  function togglePicked(entryId: string, key: string): void {
    const keys = pickedKeys(entryId);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    setPicked(entryId, [...keys]);
  }

  /** Opening another source clears the selection of the last one. */
  function enterSource(entryId: string): void {
    if (picked.value.entry !== entryId) setPicked(entryId, []);
  }

  /** "Eine Karte für alle" or one card each: the user's choice, else what suits the picked items. */
  function cardModeFor(entryId: string, items: readonly IndexItem[]): CardMode {
    const c = cardModeChoice.value;
    return c?.entry === entryId ? c.mode : defaultCardMode(items);
  }

  /* ---------------------------------------------------------------- what holds files back */

  /** Why a download cannot start now: no card, or the add flow is busy with something else. */
  const blocker = computed<Blocker | null>(() => {
    if (!deps.cardReady()) return { kind: 'card' };
    const s = deps.session.value;
    if (s.phase === 'writing') return { kind: 'writing' };
    if (s.phase === 'reading') return { kind: 'reading' };
    // Only a selection with files waits: when all of them were refused, there is nothing to finish.
    if (s.phase === 'review' && s.forFolder && s.albums.length) return { kind: 'folder', folder: s.forFolder };
    return null;
  });

  /**
   * The transfer result the family has seen: they looked at it on the add
   * page and went on, or put it aside. A newer result waits to be seen.
   */
  const seenResult = signal<object | null>(null);
  let viewing: object | null = null;
  const stopTracking = effect(() => {
    const s = deps.session.value;
    // „Musik auf die SD-Karte“ shows the result as well as the add page.
    const onAddPage = deps.route.value.page === 'add' || deps.route.value.page === 'musik';
    const result = s.phase === 'done' ? (s.result ?? null) : null;
    if (!result) {
      viewing = null;
      return;
    }
    if (onAddPage) viewing = result;
    else if (viewing === result) {
      viewing = null;
      seenResult.value = result;
    }
  });

  /** Why loaded or saved files cannot go to the add flow now: also while the last transfer's result is unseen. */
  const handOffBlocker = computed<Blocker | null>(() => {
    const b = blocker.value;
    if (b) return b;
    const s = deps.session.value;
    // What a stopped transfer left waits like a selection, also after its result was seen.
    if (s.phase === 'done' && s.result?.rest?.length) return { kind: 'rest', folder: s.forFolder };
    // Only a result with something to look at holds files back; a clean copy does not (Prüfrunde 1 B7).
    if (s.phase === 'done' && s.result && seenResult.value !== s.result && worthALook(s.result)) return { kind: 'result', folder: s.forFolder };
    return null;
  });

  /* ---------------------------------------------------------------- downloads */

  /** The download in progress, kept while people move between pages. */
  const run = signal<RunState | null>(null);

  /**
   * Sources whose download failed in this visit. Their page then also offers
   * the drop zone, so a family can save the file on the publisher's page
   * and drag it in ("Auf der Webseite öffnen").
   */
  const dropFallback = signal<readonly string[]>([]);

  function offerDropZone(entryId: string): void {
    if (!dropFallback.value.includes(entryId)) dropFallback.value = [...dropFallback.value, entryId];
  }

  let runCtrl: AbortController | null = null;
  let waitingFor: (() => void) | null = null;

  function stopWaiting(): void {
    const stop = waitingFor;
    waitingFor = null;
    stop?.();
  }

  /** "42 %" for the sidebar while files load; a dot when a download waits for the user. */
  const navBadge = computed<{ text?: string; label: string } | null>(() => {
    const r = run.value;
    if (!r || r.phase === 'adding' || r.phase === 'confirm') return null;
    if (r.phase !== 'loading') return { label: r.phase === 'failed' ? 'Laden unterbrochen' : 'Wartet auf dich' };
    const p = r.progress;
    const f = !p ? 0 : p.totalBytes ? p.bytes / p.totalBytes : p.fileIndex / Math.max(1, p.files);
    const percent = Math.max(0, Math.min(99, Math.floor(f * 100)));
    return { text: `${percent} %`, label: `Lädt, ${percent} Prozent` };
  });

  /** Loaded files or a running download would be lost when the tab closes. */
  const keepPageOpen = computed(() => {
    const r = run.value;
    return !!r && r.phase !== 'confirm';
  });

  /** Refuses more than 3 GB at once; asks from 1 GB on. Returns false when nothing started. */
  function addFromSources(entry: IndexEntry, items: IndexItem[], mode: CardMode): boolean {
    if (blocker.value || !online.value || (run.value && run.value.phase !== 'confirm')) return false;
    const picks = picksOf(entry, items);
    if (!picks.length) return false;
    const bytes = plannedBytes(picks);
    if (bytes > MAX_DOWNLOAD_BYTES) {
      deps.toast.error(`Das ist zu viel auf einmal (${formatBytes(bytes)}). Wähle weniger aus.`);
      return false;
    }
    if (bytes > BIG_DOWNLOAD_BYTES && run.value?.phase !== 'confirm') {
      run.value = { phase: 'confirm', entry, items, mode, bytes };
      return true;
    }
    void download({ entry, items, mode }, picks.map((pick, order) => ({ pick, order })), []);
    return true;
  }

  /** "Laden" in the dialog "Großer Download". */
  function confirmBig(): void {
    const r = run.value;
    if (r?.phase !== 'confirm') return;
    void download(r, picksOf(r.entry, r.items).map((pick, order) => ({ pick, order })), []);
  }

  /** Ends the run without a word: loading stops, loaded files are dropped, nothing goes to the card. */
  function stopRun(): void {
    const ctrl = runCtrl;
    runCtrl = null;
    ctrl?.abort();
    stopWaiting();
    run.value = null;
  }

  /** "Abbrechen" and "Verwerfen": stops loading, or drops what was loaded. Nothing is written to the card. */
  function cancelRun(): void {
    const wasLoading = run.value?.phase === 'loading';
    stopRun();
    if (wasLoading) deps.toast.info(messageFor(new DownloadError('aborted', ''), ''));
  }

  /** The kill switch of a newer list also stops a download of what it hides. */
  function stopBlockedRun(index: SourceIndex): void {
    const r = run.value;
    if (!r || r.phase === 'adding') return;
    const blocked = new Set(index.blocked);
    if (!blocked.has(r.entry.id) && !r.items.some((it) => blocked.has(it.key))) return;
    stopRun();
    deps.toast.info('Laden abgebrochen', 'Was du ausgewählt hast, steht nicht mehr in der Liste.');
  }

  /** What loads right now: the song of an album, else the episode (an album's own title is the source's). */
  function partTitle(pick: PickedFile): string {
    return pick.file.title ?? pick.item.title;
  }

  async function download(base: RunBase, todo: { pick: PickedFile; order: number }[], loaded: Loaded[]): Promise<void> {
    runCtrl?.abort();
    stopWaiting();
    const ctrl = new AbortController();
    runCtrl = ctrl;
    const total = loaded.length + todo.length;
    const runBase: RunBase = { entry: base.entry, items: base.items, mode: base.mode };
    run.value = { ...runBase, phase: 'loading', current: todo[0] && partTitle(todo[0].pick) };
    const specs = todo.map((t) => ({ url: t.pick.file.url, name: t.pick.file.name, size: t.pick.file.size, t }));
    try {
      const result = await downloadFiles(specs, {
        ...deps.download,
        fetch: deps.fileFetch ?? deps.fetch,
        signal: ctrl.signal,
        isOnline: deps.isOnline,
        onProgress: (progress) => {
          if (runCtrl !== ctrl) return;
          const at = specs[progress.fileIndex];
          run.value = { ...runBase, phase: 'loading', progress, current: at && partTitle(at.t.pick) };
        },
      });
      if (runCtrl !== ctrl) return;
      runCtrl = null;
      const now = [...loaded, ...result.ok.map((o) => ({ pick: o.file.t.pick, order: o.file.t.order, data: o.blob }))].sort((a, b) => a.order - b.order);
      const missing: Missing[] = [
        ...result.failed.map((f) => ({ pick: f.file.t.pick, order: f.file.t.order, error: f.error })),
        ...result.skipped.map((s) => ({ pick: s.t.pick, order: s.t.order })),
      ].sort((a, b) => a.order - b.order);
      if (missing.length) {
        offerDropZone(base.entry.id);
        run.value = { ...runBase, phase: 'failed', loaded: now, missing, total, message: failedMessage(base.entry, missing, total), partial: missingLine(missing.length, total, base.entry) };
        return;
      }
      await handOff(runBase, now, []);
    } catch (e) {
      if (runCtrl !== ctrl) return;
      runCtrl = null;
      if (e instanceof DownloadError && e.code === 'aborted') {
        run.value = null;
        deps.toast.info(messageFor(e, ''));
        return;
      }
      const missing = todo.map((t) => ({ ...t }));
      offerDropZone(base.entry.id);
      run.value = {
        ...runBase,
        phase: 'failed',
        loaded,
        missing,
        total,
        message: e instanceof Error ? e.message : String(e),
        partial: missingLine(missing.length, total, base.entry),
      };
    }
  }

  /** "Fehlende erneut laden": loads only what is missing and keeps the playing order. */
  function retryMissing(): void {
    const r = run.value;
    if (r?.phase !== 'failed' || !online.value) return;
    void download(r, r.missing.map(({ pick, order }) => ({ pick, order })), r.loaded);
  }

  /** "Ohne die fehlenden weiter": the missing files are listed with the files that are not transferred. */
  function continueWithout(): void {
    const r = run.value;
    if (r?.phase !== 'failed' || !r.loaded.length) return;
    const rejected: RejectedEntry[] = r.missing.map((m) => {
      const title = m.pick.file.title ?? m.pick.item.title;
      return {
        name: missingName(r.entry, m.pick.item, m.pick.file),
        reason: m.error ? messageFor(m.error, title, { podcast: r.entry.type === 'podcast', part: partWord(r.entry) }) : 'Wurde nicht geladen, weil vorher ein Fehler auftrat.',
        web: true,
      };
    });
    void handOff(r, r.loaded, rejected);
  }

  /** "Weiter" after the SD card came back or the other selection is done. */
  function resumeHandOff(): void {
    const r = run.value;
    if (r?.phase !== 'waiting') return;
    void handOff(r, r.loaded, r.rejected);
  }

  /**
   * Waits until a transfer, a reading or an unseen result is out of the way,
   * then goes on by itself. Gives up watching when the wait turns into one
   * that needs the family (the card was pulled): then "Weiter" goes on.
   */
  function resumeWhenFree(): void {
    stopWaiting();
    const stop = effect(() => {
      const b = handOffBlocker.value;
      if (b && AUTOMATIC.has(b.kind)) return;
      queueMicrotask(() => {
        if (waitingFor !== stop) return;
        stopWaiting();
        if (!b && run.value?.phase === 'waiting') void handOff(run.value, run.value.loaded, run.value.rejected, { follow: false });
      });
    });
    waitingFor = stop;
  }

  /**
   * Clears a seen result or an empty start for a folder (also one whose
   * files were all refused), so the files form a new selection. Never what a
   * stopped transfer left (its rest): handOffBlocker holds the files back
   * then.
   */
  function startFresh(): void {
    const s = deps.session.value;
    const emptyFolder = !!s.forFolder && (s.phase === 'pick' || (s.phase === 'review' && !s.albums.length));
    if ((s.phase === 'done' && !s.result?.rest?.length) || emptyFolder) deps.resetImport();
  }

  /** The last step after the review, in the words of the add page's button. */
  function thenToCard(): string {
    return deps.packaged?.() ? 'lege sie dann ins Paket für die Karte' : 'übertrage sie dann auf die SD-Karte';
  }

  /**
   * What the family reads where the files went: on the add page they stay
   * there, anywhere else they wait on „Musik auf die SD-Karte“, and the
   * toast leads there when the family stays on the page it reads.
   */
  function toastAdded(first: string, follow: boolean): void {
    const r = deps.route.value;
    if (r.page === 'add') {
      deps.toast.success(`${first} Prüfe die Auswahl und ${thenToCard()}.`);
      return;
    }
    const copy = deps.packaged?.() ? 'Lege sie jetzt ins Paket für die Karte.' : 'Kopiere sie jetzt auf die SD-Karte.';
    if (follow || r.page === 'musik') {
      if (r.page !== 'musik') deps.navigate({ page: 'musik' });
      deps.toast.success(`${first} ${copy}`);
      return;
    }
    deps.toast.success(`${first} Liegt bereit unter „Musik auf die SD-Karte“.`, undefined, {
      label: deps.packaged?.() ? 'Jetzt ins Paket' : 'Jetzt kopieren',
      run: () => deps.navigate({ page: 'musik' }),
    });
  }

  /**
   * Hands loaded files to the add flow once the card is there, nothing else
   * is read or written and the last result was seen. `follow`: open the add
   * page when the family is on "Entdecken" (not after they just left it).
   */
  async function handOff(base: RunBase, loaded: Loaded[], rejected: RejectedEntry[], o: { follow?: boolean } = {}): Promise<void> {
    stopWaiting();
    const runBase: RunBase = { entry: base.entry, items: base.items, mode: base.mode };
    const blocked = handOffBlocker.value;
    if (blocked) {
      run.value = { ...runBase, phase: 'waiting', loaded, rejected };
      if (AUTOMATIC.has(blocked.kind)) resumeWhenFree();
      return;
    }
    run.value = { ...runBase, phase: 'adding' };
    startFresh();
    const plan = planFiles(
      base.entry,
      loaded.map((l) => l.pick),
      base.mode,
    );
    const sources: ByteSource[] = [];
    const hints = new Map<ByteSource, Partial<TrackInfo>>();
    const origins = new Map<ByteSource, TrackOrigin>();
    const at = deps.now();
    plan.forEach((p, i) => {
      const data = loaded[i].data;
      const source = data instanceof Blob ? fileSource(data, p.file.name, p.relativePath) : inFolder(data, p.relativePath);
      sources.push(source);
      hints.set(source, p.hint);
      origins.set(source, trackOrigin(base.entry, p.item, at));
    });
    try {
      sources.push(...(await coverFiles(base.entry, plan, base.mode)));
      const result = await deps.addSources(sources, { hints, origins, rejected });
      if (result.cancelled) {
        run.value = null;
        return;
      }
      if (!result.accepted) {
        run.value = null;
        deps.toast.error('Die Dateien ließen sich nicht übernehmen', result.rejected[0]?.reason);
        return;
      }
      run.value = null;
      if (picked.value.entry === base.entry.id) setPicked(base.entry.id, []);
      // Follow to the music only from the source that was loaded; elsewhere the family reads on, the toast leads there.
      const r = deps.route.value;
      toastAdded('Geladen.', o.follow !== false && r.page === 'sources' && r.entry === base.entry.id);
    } catch (e) {
      run.value = { ...runBase, phase: 'waiting', loaded, rejected };
      deps.toast.error('Die Dateien ließen sich nicht übernehmen', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * The source's own picture as "cover.jpg" beside the files of each folder,
   * so the add flow shows the real cover and not its placeholder. Only a
   * picture the cover cache has or may fetch; nothing is drawn here.
   * One card for all: the source's picture, else the item's. In the largest
   * size the source offers (largestCover).
   */
  async function coverFiles(entry: IndexEntry, plan: readonly PlannedFile[], mode: CardMode): Promise<ByteSource[]> {
    const get = deps.coverBlob;
    if (!get) return [];
    const byFolder = new Map<string, string>();
    for (const p of plan) {
      const folder = p.relativePath.slice(0, p.relativePath.lastIndexOf('/'));
      const url = mode === 'all' && !isWholeWork(entry) ? (entry.cover ?? p.item.cover) : (p.item.cover ?? entry.cover);
      if (url && !byFolder.has(folder)) byFolder.set(folder, url);
    }
    const covers = await Promise.all(
      [...byFolder].map(async ([folder, url]) => {
        // The largest size the source offers, for the card and its stickers; else the one the page shows.
        const big = largestCover(url);
        const blob = (big !== url ? await get(big).catch(() => undefined) : undefined) ?? (await get(url).catch(() => undefined));
        const ext = blob && blob.size > 0 ? COVER_EXT[blob.type.split(';')[0].trim().toLowerCase()] : undefined;
        return blob && ext ? [fileSource(blob, `cover.${ext}`, `${folder}/cover.${ext}`)] : [];
      }),
    );
    return covers.flat();
  }

  /* ---------------------------------------------------------------- files saved from a publisher's page */

  /** A saved file, shown in the folder of its source like a loaded one (and next to its cover file). */
  function inFolder(source: ByteSource, relativePath: string): ByteSource {
    return { name: source.name, size: source.size, path: source.path, blob: source.blob, relativePath, read: (start, length) => source.read(start, length) };
  }

  /**
   * Saved files that the failed download of this source misses: they fill
   * its gaps, so an album stays one folder and "Fehlende erneut laden" loads
   * only the rest. With nothing missing any more the download goes on to the
   * add flow. Returns the files that were not missing.
   */
  async function fillMissing(entry: IndexEntry, files: { source: ByteSource; pick?: PickedFile }[]): Promise<{ source: ByteSource; pick?: PickedFile }[]> {
    const r = run.value;
    if (r?.phase !== 'failed' || r.entry.id !== entry.id) return files;
    const same = (a: PickedFile, b: PickedFile) =>
      a.item.key === b.item.key && (a.item.files.length <= 1 || (!!a.file.url && a.file.url === b.file.url) || a.file.name === b.file.name);
    let missing = r.missing;
    const loaded = [...r.loaded];
    const rest: { source: ByteSource; pick?: PickedFile }[] = [];
    for (const f of files) {
      const m = f.pick && missing.find((x) => same(x.pick, f.pick!));
      if (!m) {
        rest.push(f);
        continue;
      }
      loaded.push({ pick: m.pick, order: m.order, data: f.source });
      missing = missing.filter((x) => x !== m);
    }
    if (missing.length === r.missing.length) return files;
    loaded.sort((a, b) => a.order - b.order);
    if (missing.length) run.value = { ...r, loaded, missing, message: failedMessage(r.entry, missing, r.total), partial: missingLine(missing.length, r.total, r.entry) };
    else await handOff(r, loaded, []);
    return rest;
  }

  /**
   * Adds files the family saved from the publisher's page; `pick` from
   * matchDropped or from the answer to "Welche Folge ist das?", else no
   * origin. A publisher that allows no changes only gets files with a title
   * from the list: any other file would be changed on its way. `mode`: the
   * family's choice of cards, else what suits the episodes. Stays on the
   * page, so more files can follow; they join the same selection.
   */
  async function addSaved(entry: IndexEntry, files: { source: ByteSource; pick?: PickedFile }[], mode?: CardMode): Promise<void> {
    const allowed = entry.editPolicy === 'unchanged' ? files.filter((f) => f.pick) : files;
    if (handOffBlocker.value || !allowed.length) return;
    const usable = await fillMissing(entry, allowed);
    if (!usable.length || handOffBlocker.value) return;
    startFresh();
    const known = usable.filter((f): f is { source: ByteSource; pick: PickedFile } => !!f.pick);
    const items = [...new Set(known.map((f) => f.pick.item))];
    const cards = items.length > 1 ? (mode ?? defaultCardMode(items)) : 'each';
    const plan = planFiles(
      entry,
      known.map((f) => f.pick),
      cards,
    );
    const hints = new Map<ByteSource, Partial<TrackInfo>>();
    const origins = new Map<ByteSource, TrackOrigin>();
    const at = deps.now();
    const placed = new Map<ByteSource, ByteSource>();
    plan.forEach((p, i) => {
      const source = inFolder(known[i].source, p.relativePath);
      placed.set(known[i].source, source);
      hints.set(source, p.hint);
      origins.set(source, trackOrigin(entry, p.item, at));
    });
    const result = await deps.addSources([...usable.map((f) => placed.get(f.source) ?? f.source), ...(await coverFiles(entry, plan, cards))], { hints, origins });
    if (result.cancelled) return;
    if (!result.accepted) {
      deps.toast.error('Die Datei ließ sich nicht übernehmen', result.rejected[0]?.reason);
      return;
    }
    toastAdded('Hinzugefügt.', false);
  }

  /** Lets go of the watchers; for tests. */
  function dispose(): void {
    stopTracking();
    stopRun();
    listCtrl?.abort();
    listCtrl = null;
    reachCtrl?.abort();
    reachCtrl = null;
  }

  return {
    indexState,
    currentIndex,
    online,
    ensureIndex,
    setOnline,
    peekKept,
    teaserIndex,
    prefs,
    updatePrefs,
    offeredKinds,
    kindChoice,
    searchText,
    focusItem,
    picked,
    cardModeChoice,
    pickedKeys,
    setPicked,
    togglePicked,
    enterSource,
    cardModeFor,
    blocker,
    handOffBlocker,
    run,
    dropFallback,
    navBadge,
    keepPageOpen,
    addFromSources,
    confirmBig,
    cancelRun,
    retryMissing,
    continueWithout,
    resumeHandOff,
    addSaved,
    dispose,
  };
}

export type SourcesState = ReturnType<typeof createSourcesState>;
