/**
 * State of the "Entdecken" pages, connected to the app: the loaded list, the
 * choices people made, the selection on a source page and a download that
 * runs on while people look around. The logic lives in controller.ts.
 */
import { computed } from '@preact/signals';
import { indexUrl } from '../../core/sources/load';
import { navigate, route } from '../../app/router';
import { card, plat, platform } from '../../app/state';
import { holdWhile, writeGuard } from '../../app/writeguard';
import { toast } from '../../ui/components/Toast';
import { addSources, resetImport, session } from '../add/session';
import type { SourcesListAccess } from '../../platform/types';
import { createSourcesState, type LocalListSource } from './controller';
import { coverBlob } from './coverCache';
import { setOwnLoading } from './labels';
import { appLoadHost } from '../../core/sources/providers';
import { rangedFetch } from '../../core/sources/download';

export type { Blocker } from './labels';
export type { IndexState, Prefs, ReadyState, RunState } from './controller';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine);

/** Where the list comes from in this build, or nothing (a desktop app built without a web address). */
export function listUrl(): string | undefined {
  const p = platform.value;
  if (!p || typeof location === 'undefined') return undefined;
  const env = import.meta.env;
  return indexUrl({ kind: p.kind, pageUrl: location.href, base: env.BASE_URL, webOrigin: env.VITE_WEB_ORIGIN, override: env.VITE_SOURCES_INDEX_URL });
}

/**
 * The desktop app builds the list itself on this computer, at most once a
 * day (src/core/sources/local.ts), instead of loading a published one: the
 * platform offers `sourcesList` only there. The web app has neither the
 * platform member nor the code: `__DESKTOP_BUILD__ && __LOCAL_SOURCES__` is
 * false there, so localList below and everything it imports go away.
 */
function localAccess(): SourcesListAccess | undefined {
  if (!__DESKTOP_BUILD__ || !__LOCAL_SOURCES__) return undefined;
  const p = platform.value;
  return p?.kind === 'desktop' ? p.sourcesList : undefined;
}

/** Whether this app builds the list of "Entdecken" itself (the desktop app). */
export const localListMode = computed(() => !!localAccess());

/** The list that comes with the app. */
const snapshot = () => import('../../../sources/snapshot/index-v1.json').then((m) => m.default as unknown);

function localList(): LocalListSource | undefined {
  const access = localAccess();
  if (!access) return undefined;
  const store = { read: () => access.readCache(), write: (text: string) => access.writeCache(text) };
  const builder = () => import('../../core/sources/local');
  return {
    // The build runs to its end, also when the page asks again meanwhile; it then gets the same result.
    load: async () => {
      const [{ loadLocalList }, catalog, released] = await Promise.all([builder(), import('../../../sources/catalog.json'), import('../../../sources/released.json')]);
      return loadLocalList({
        catalog: catalog.default as unknown,
        released: released.default as unknown,
        // The list that came with the app stands in for sources that do not answer on the first day.
        snapshot,
        fetch: access.fetch,
        store,
        now: () => Date.now(),
        isOnline,
        log: (m) => console.info(`Entdecken: ${m}`),
      });
    },
    kept: async () => (await builder()).loadLocalKept({ store, now: () => Date.now(), snapshot }),
  };
}

/**
 * Whether the app can ask for a newer list than the one it came with: it has
 * an address for the list, or (desktop app) builds it itself.
 * Without one it shows the list that came with the app, and only checks
 * which of its titles are still online (reach.ts).
 */
export const canUpdateList = computed(() => localListMode.value || listUrl() !== undefined);

/**
 * Whether the app shows "Entdecken". Only a build with a list to show offers
 * it (`__SOURCES_ENABLED__`): a list that comes with the app
 * (`__SOURCES_BUNDLED__`, then also in a desktop app built without a web
 * address), a list address, or the desktop app, which builds its own list
 * from the catalogue that came with it.
 */
export const sourcesAvailable = computed(() => __SOURCES_ENABLED__ && (__SOURCES_BUNDLED__ || canUpdateList.value));

/**
 * Paket mode: a card read in a browser that cannot write to it (the changes
 * go into a Paket), or, before a card is read, a browser that only offers
 * that. Words follow it: "Lies die SD-Karte ein", "ins Paket für die Karte".
 */
export const packageMode = computed(() => {
  const c = card.value;
  if (c) return c.volume.access === 'snapshot';
  const caps = platform.value?.capabilities;
  return !!caps && !caps.sd && !!caps.sdPackage;
});

/**
 * The desktop app loads the files of providers that allow saving but send
 * no CORS header (Provider.appLoads, OHRKA) through its own https helper, in
 * pieces. The web app and the Android app have no such helper: there these
 * titles stay with the publisher's page and the drop zone.
 */
setOwnLoading(() => !!localAccess());
let ranged: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
function fileFetch(url: string, init: RequestInit): Promise<Response> {
  const access = localAccess();
  if (!access || !appLoadHost(url)) return plat().fetch(url, init);
  ranged ??= rangedFetch((u, i) => access.fetch(u, i), { allowed: appLoadHost });
  return ranged(url, init);
}

const state = createSourcesState({
  fetch: (url, init) => plat().fetch(url, init),
  fileFetch,
  storage,
  listUrl,
  snapshot,
  ...(__DESKTOP_BUILD__ && __LOCAL_SOURCES__ ? { localList } : {}),
  now: () => Date.now(),
  isOnline,
  // Titles no longer online disappear; asked only after "Entdecken" loaded its list.
  checkReach: true,
  cardReady: () => {
    const c = card.value;
    return !!c && c.status === 'ready' && !!c.scan;
  },
  packaged: () => packageMode.value,
  session,
  addSources,
  resetImport,
  // The source's own picture goes along to the add flow.
  coverBlob,
  route,
  navigate,
  toast,
});

export const {
  indexState,
  currentIndex,
  online,
  ensureIndex,
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
  addFromSources,
  confirmBig,
  cancelRun,
  retryMissing,
  continueWithout,
  resumeHandOff,
  addSaved,
} = state;

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => state.setOnline(true));
  window.addEventListener('offline', () => state.setOnline(false));
}

// Closing would lose a running download or files that wait for the card: the browser tab and the desktop window ask first.
holdWhile(writeGuard, 'downloads', () => state.keepPageOpen.value);
