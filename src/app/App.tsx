import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { PhoneTabs, Sidebar } from './Sidebar';
import { parseHash, route, type Route } from './router';
import { PageShown } from './pageAlive';
import { setErrorAction, Toasts } from '../ui/components/Toast';
import { SketchDefs } from '../ui/components/Sketch';
import { CloseQuestion } from './CloseQuestion';
import { ComputerOnly, HandheldNotice, isComputerOnly, needsComputer, useHandheldNotice } from './HandheldNotice';
import { platform } from './state';
import { BoxPage, useAutoRefresh } from '../features/box/BoxPage';
import { PackageDialogHost } from '../features/box/PackageDialog';
import { RebuildDialogHost } from '../features/box/RebuildDialog';
import { CopyToCardDialogHost } from '../features/box/CopyToCardDialog';
import { SystemPrintDialogHost } from '../features/stickers/SystemPrintDialog';
import { writeErrorAction } from '../features/box/writeAccess';
import { lastActivity } from '../ui/quiet';
import { lazyPage, type LazyPage } from './lazyPage';
// The style sheets of the pages below stay in the app's one style sheet, in the order they had
// before those pages came as their own files: the style of main.tsx comes after them and must win.
import '../ui/styles/tags.css';
import '../features/playlist/playlist.css';
import '../ui/styles/stickers.css';
import '../ui/styles/freecard.css';
import '../ui/styles/workshop.css';
import '../ui/styles/readertest.css';
import '../ui/styles/loetplan.css';
import '../ui/styles/aftercheck.css';
import '../ui/styles/manual.css';
import '../ui/styles/settings.css';

// A write the app may not do on the card: its toast offers "Schreibrechte holen" where that helps.
setErrorAction(writeErrorAction);

// Every page but the first one ("Meine Box") comes as its own file: the start loads only what it shows (TODO #70).
const FolderPage = lazyPage(() => import('../features/box/FolderPage').then((m) => m.FolderPage));
const AddPage = lazyPage(() => import('../features/add/AddPage').then((m) => m.AddPage));
const SourcesPage = lazyPage(() => import('../features/sources/SourcesPage').then((m) => m.SourcesPage));
const StickerPage = lazyPage(() => import('../features/stickers/StickerPage').then((m) => m.StickerPage));
const CardsPage = lazyPage(() => import('../features/cards/CardsPage').then((m) => m.CardsPage));
const RecordPage = lazyPage(() => import('../features/add/RecordPage').then((m) => m.RecordPage));
const WorkshopPage = lazyPage(() => import('../features/workshop/WorkshopPage').then((m) => m.WorkshopPage));
const HelpPage = lazyPage(() => import('../features/help/HelpPage').then((m) => m.HelpPage));
const SettingsPage = lazyPage(() => import('../features/settings/SettingsPage').then((m) => m.SettingsPage));

const LAZY: Partial<Record<Route['page'], LazyPage<never>>> = {
  folder: FolderPage,
  add: AddPage,
  sources: __SOURCES_ENABLED__ ? SourcesPage : undefined,
  stickers: StickerPage,
  cards: CardsPage,
  record: RecordPage,
  workshop: WorkshopPage,
  help: HelpPage,
  settings: SettingsPage,
};

/** The code of a page, fetched before the app draws it first (a link to a page, the Android app's cards). */
export function preloadPage(page: Route['page']): Promise<unknown> {
  return LAZY[page]?.preload() ?? Promise.resolve();
}

/** The pages fetched in quiet moments after the start, the likely next ones first: then opening one is as quick as before. */
const PRELOAD: Route['page'][] = ['folder', 'stickers', 'add', 'cards', 'settings', 'help', 'workshop', 'record', 'sources'];

function Page({ r }: { r: Route }) {
  // The Android app without its bridges: the SD card and the box over USB need a computer.
  if (isComputerOnly(r.page) && needsComputer(r.page, platform.value)) return <ComputerOnly page={r.page} />;
  switch (r.page) {
    case 'box':
      return <BoxPage />;
    case 'folder':
      return <FolderPage folder={r.folder} />;
    case 'add':
      return <AddPage folder={r.folder} />;
    case 'sources':
      // parseHash never leads here in a build without "Entdecken"; the check keeps the page out of that build.
      return __SOURCES_ENABLED__ ? <SourcesPage entry={r.entry} /> : <BoxPage />;
    case 'stickers':
      return <StickerPage />;
    case 'cards':
      return <CardsPage />;
    case 'record':
      return <RecordPage />;
    case 'workshop':
      return <WorkshopPage tool={r.tool} />;
    case 'help':
      return <HelpPage topic={r.topic} />;
    case 'settings':
      return <SettingsPage />;
  }
}

/**
 * Pages that stay mounted once opened, hidden while another one shows, so
 * going back shows them finished at once, where one left them. Not kept:
 * the folder page (one per folder), "Entdecken" (goes online only when
 * opened, and stays quiet afterwards), "Karten beschreiben" and the
 * Werkstatt, whose tools talk to the box and the card reader and must stop
 * when one leaves them. "Aufnehmen" is kept for its take, but never built
 * ahead: it is only there once opened.
 */
const KEPT = ['box', 'add', 'stickers', 'help', 'settings', 'record'] as const;
type Kept = (typeof KEPT)[number];
const isKept = (page: Route['page']): page is Kept => (KEPT as readonly string[]).includes(page);

/** Built ahead, hidden, in quiet moments after the start: the heavy ones first. */
const AHEAD: Kept[] = ['box', 'stickers', 'add', 'settings', 'help'];

/** Waits for a quiet moment: no scrolling, clicking or playing about for a while, the browser idle. */
function whenQuiet(run: () => void): () => void {
  const since = performance.now();
  let timer = 0;
  let idle = 0;
  const check = () => {
    const wait = Math.max(since, lastActivity()) + 600 - performance.now();
    if (wait > 0) {
      timer = window.setTimeout(check, wait);
      return;
    }
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run, { timeout: 2000 });
    else timer = window.setTimeout(run, 0);
  };
  timer = window.setTimeout(check, 700);
  return () => {
    clearTimeout(timer);
    if (idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
  };
}

function Slot({ shown, busy, children }: { shown: boolean; busy?: boolean; children: ComponentChildren }) {
  // busy: the page before, still on screen while the next one loads (Pages).
  return (
    <div class={shown ? 'page-slot' : 'page-slot page-slot-hidden'} inert={!shown} aria-hidden={shown ? undefined : 'true'} aria-busy={shown && busy ? 'true' : undefined}>
      <PageShown.Provider value={shown}>{children}</PageShown.Provider>
    </div>
  );
}

function Pages() {
  // A page whose code is not there yet: the page before stays until it is (a few dozen milliseconds),
  // instead of an empty, flashing page (clicked right after the start). Failed to load: shown anyway, with its message.
  const want = route.value;
  const held = useRef<Route | null>(null);
  const gaveUp = useRef<Route | null>(null);
  const [, redraw] = useState(0);
  const code = LAZY[want.page];
  const waiting = !!code && !code.ready() && held.current !== null && gaveUp.current !== want;
  if (!waiting) held.current = want;
  useEffect(() => {
    if (!waiting || !code) return undefined;
    let on = true;
    void code.preload().then(() => {
      if (!on) return;
      if (!code.ready()) gaveUp.current = want;
      redraw((n) => n + 1);
    });
    return () => {
      on = false;
    };
  }, [waiting, want]);
  const r = held.current ?? want;
  const shown = isKept(r.page) ? r.page : null;
  // The last address of each kept page, so a hidden page keeps what it showed.
  const last = useRef(new Map<Kept, Route>());
  if (shown) last.current.set(shown, r);
  const [built, setBuilt] = useState<ReadonlySet<Kept>>(() => new Set());
  const all = new Set(built);
  if (shown) all.add(shown);
  if (shown && !built.has(shown)) setBuilt(all);

  // Build the next page ahead while the app is quiet.
  const next = AHEAD.find((k) => !all.has(k));
  useEffect(() => (next ? whenQuiet(() => setBuilt((b) => new Set(b).add(next))) : undefined), [next]);

  // Fetch the code of the other pages from the first quiet moment on, one after the other whenever
  // the browser is idle, so they are there before one goes to them (no state: the pages shown stay as they are).
  useEffect(() => {
    let on = true;
    let cancel = () => {};
    const step = (i: number) => {
      const page = PRELOAD[i];
      if (!on || !page) return;
      const next = () => void preloadPage(page).then(() => step(i + 1));
      if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(next, { timeout: 1000 });
        cancel = () => cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(next, 0);
        cancel = () => clearTimeout(id);
      }
    };
    const stop = whenQuiet(() => step(0));
    return () => {
      on = false;
      stop();
      cancel();
    };
  }, []);

  // A link to a page under the pointer, pressed or in focus: its code comes now, before the click
  // (the menu right after the start, before the quiet moment above has fetched it).
  useEffect(() => {
    const ahead = (e: Event) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="#/"]');
      if (a) void preloadPage(parseHash(a.getAttribute('href') ?? '').page);
    };
    const kinds = ['pointerover', 'pointerdown', 'focusin'] as const;
    for (const k of kinds) document.addEventListener(k, ahead, { passive: true });
    return () => {
      for (const k of kinds) document.removeEventListener(k, ahead);
    };
  }, []);

  // Each kept page keeps its scroll position; any other page starts at the top.
  // Each help topic counts on its own: the next topic starts at its top, and
  // the overview keeps its own place. So does the overview of "Entdecken"
  // (not kept, but its list is in memory and shows at once).
  const overview = r.page === 'sources' && !r.entry;
  const key = r.page === 'help' ? `help:${r.topic ?? ''}` : overview ? 'sources:overview' : (shown ?? `${r.page}:${JSON.stringify(r)}`);
  const scroll = useRef(new Map<string, number>());
  const keyRef = useRef(key);
  // The place of the page that goes, read once while it still shows (here, before the new page is in),
  // not on every scroll step: reading it there made the browser lay out the page again during scrolling.
  const scrolled = useRef(false);
  if (keyRef.current !== key && scrolled.current) {
    const main = document.querySelector<HTMLElement>('.main');
    if (main) scroll.current.set(keyRef.current, main.scrollTop);
    scrolled.current = false;
  }
  useLayoutEffect(() => {
    const main = document.querySelector<HTMLElement>('.main');
    if (!main) return;
    // A help topic or a tool scrolls to itself.
    const own = (r.page === 'help' && r.topic) || (r.page === 'add' && r.folder);
    main.scrollTop = (shown || overview) && !own ? (scroll.current.get(key) ?? 0) : 0;
    keyRef.current = key;
  }, [key]);
  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.main');
    if (!main) return undefined;
    // While it scrolls, the cards passing under a resting pointer do not lift one after the other (data-scrolling in stil-holz.css):
    // in WebKitGTK each lift painted its turned card again, the shelf flickered and dropped to a few frames a second.
    // Marked on the shelves only, and not as a class: the pen frames are drawn again on every class change (drawnFrames.ts).
    let calm = 0;
    let shelves: HTMLElement[] = [];
    const onScroll = () => {
      scrolled.current = true;
      if (calm) clearTimeout(calm);
      else {
        shelves = [...main.querySelectorAll<HTMLElement>('.shelf')];
        for (const s of shelves) s.setAttribute('data-scrolling', '');
      }
      calm = window.setTimeout(() => {
        calm = 0;
        for (const s of shelves) s.removeAttribute('data-scrolling');
        shelves = [];
      }, 150);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      main.removeEventListener('scroll', onScroll);
      clearTimeout(calm);
    };
  }, []);

  return (
    <>
      {KEPT.filter((k) => all.has(k)).map((k) => (
        <Slot key={k} shown={k === shown} busy={waiting}>
          <Page r={last.current.get(k) ?? ({ page: k } as Route)} />
        </Slot>
      ))}
      {shown ? null : (
        <Slot key={key} shown busy={waiting}>
          <Page r={r} />
        </Slot>
      )}
    </>
  );
}

export function App() {
  useAutoRefresh();
  // The Android app is made for the phone: no "open it on a computer" there.
  const handheld = useHandheldNotice(!!platform.value?.handheld && !platform.value.mobile);
  if (handheld.show) return <HandheldNotice onLookAround={handheld.lookAround} />;
  return (
    <div class="app">
      <SketchDefs />
      <Sidebar />
      <main class="main">
        <Pages />
      </main>
      <PhoneTabs />
      <PackageDialogHost />
      <RebuildDialogHost />
      <CopyToCardDialogHost />
      <SystemPrintDialogHost />
      <Toasts />
      <CloseQuestion />
    </div>
  );
}
