import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Kopf, Leiste } from './Kopf';
import { parseHash, route, type Route } from './router';
import { PageShown } from './pageAlive';
import { setErrorAction, Toasts } from '../ui/components/Toast';
import { SketchDefs } from '../ui/components/Sketch';
import { CloseQuestion } from './CloseQuestion';
import { ComputerOnly, HandheldNotice, isComputerOnly, needsComputer, useHandheldNotice } from './HandheldNotice';
import { platform } from './state';
import { useAutoRefresh } from './autoRefresh';
import { MusikScreen } from '../features/add/MusikScreen';
import { KarteScreen } from '../features/cards/KarteScreen';
import { PackageDialogHost } from '../features/box/PackageDialog';
import { copyToCardDialog, rebuildDialog } from '../features/box/openDialogs';
import { SystemPrintDialogHost } from '../features/stickers/SystemPrintDialog';
import { writeErrorAction } from '../features/box/writeAccess';
import { lastActivity, pageComingUp } from '../ui/quiet';
import { lazyPage, type LazyPage } from './lazyPage';
// The style sheets of the pages below stay in the app's one style sheet, in the order they had
// before those pages came as their own files: the style of main.tsx comes after them and must win.
// Meine Box's and the card ways' own come first, where they were while those were part of the start.
import '../ui/styles/thorough.css';
import '../ui/styles/contentlist.css';
import '../ui/styles/bulkcover.css';
import '../features/sources/sources.css';
import '../ui/styles/packseries.css';
import '../ui/styles/trim.css';
import '../ui/styles/freecard.css';
import '../ui/styles/tags.css';
import '../features/playlist/playlist.css';
import '../ui/styles/stickers.css';
import '../ui/styles/workshop.css';
import '../ui/styles/readertest.css';
import '../ui/styles/loetplan.css';
import '../ui/styles/baukasten.css';
import '../ui/styles/aftercheck.css';
import '../ui/styles/manual.css';
import '../ui/styles/settings.css';

// A write the app may not do on the card: its toast offers "Schreibrechte holen" where that helps.
setErrorAction(writeErrorAction);

// Every page but the first ones (Musik on a computer, Karte on a phone) comes as its own file: the start loads only what it shows (TODO #70).
// Meine Box too (0.6, #121): it is no longer the first page, and with it came „Entdecken“ and the big dialogs of the box.
const BoxPage = lazyPage(() => import('../features/box/BoxPage').then((m) => m.BoxPage));
const FolderPage = lazyPage(() => import('../features/box/FolderPage').then((m) => m.FolderPage));
const AddPage = lazyPage(() => import('../features/add/AddPage').then((m) => m.AddPage));
const SourcesPage = lazyPage(() => import('../features/sources/SourcesPage').then((m) => m.SourcesPage));
const StickerPage = lazyPage(() => import('../features/stickers/StickerPage').then((m) => m.StickerPage));
const StickerScreen = lazyPage(() => import('../features/stickers/StickerScreen').then((m) => m.StickerScreen));
const CardsPage = lazyPage(() => import('../features/cards/CardsPage').then((m) => m.CardsPage));
const RecordPage = lazyPage(() => import('../features/add/RecordPage').then((m) => m.RecordPage));
const WorkshopPage = lazyPage(() => import('../features/workshop/WorkshopPage').then((m) => m.WorkshopPage));
const HelpPage = lazyPage(() => import('../features/help/HelpPage').then((m) => m.HelpPage));
const SettingsPage = lazyPage(() => import('../features/settings/SettingsPage').then((m) => m.SettingsPage));
// The big dialogs of Meine Box: their code comes when one opens (0.6, #121).
const RebuildDialogHost = lazyPage(() => import('../features/box/RebuildDialog').then((m) => m.RebuildDialogHost));
const CopyToCardDialogHost = lazyPage(() => import('../features/box/CopyToCardDialog').then((m) => m.CopyToCardDialogHost));

const LAZY: Partial<Record<Route['page'], LazyPage<never>>> = {
  box: BoxPage,
  folder: FolderPage,
  add: AddPage,
  sources: __SOURCES_ENABLED__ ? SourcesPage : undefined,
  sticker: StickerScreen,
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
const PRELOAD: Route['page'][] = ['sticker', 'box', 'workshop', 'folder', 'add', 'stickers', 'cards', 'settings', 'help', 'record', 'sources'];

function Page({ r }: { r: Route }) {
  // The Android app without its bridges: the SD card and the box over USB need a computer.
  if (isComputerOnly(r.page) && needsComputer(r.page, platform.value)) return <ComputerOnly page={r.page} />;
  switch (r.page) {
    case 'musik':
      return <MusikScreen />;
    case 'karte':
      return <KarteScreen folder={r.folder} />;
    case 'sticker':
      return <StickerScreen />;
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
 * opened, and stays quiet afterwards), the cards ("Karte beschreiben" and
 * "Viele Karten auf einmal") and the tools of the Werkstatt, which talk to
 * the box and the card reader and must stop when one leaves them. The
 * Werkstatt's overview is kept (keptPage): a list of links, it talks to
 * nothing. "Aufnehmen" is kept for its take, but never built ahead: it is
 * only there once opened.
 */
const KEPT = ['musik', 'sticker', 'box', 'workshop', 'add', 'stickers', 'help', 'settings', 'record'] as const;
type Kept = (typeof KEPT)[number];
const isKept = (page: Route['page']): page is Kept => (KEPT as readonly string[]).includes(page);
/** The kept page that shows `r`, or null: a tool of the Werkstatt is not kept, its overview is. */
export function keptPage(r: Route): Kept | null {
  if (r.page === 'workshop' && r.tool) return null;
  return isKept(r.page) ? r.page : null;
}

/** Built ahead, hidden, in quiet moments after the start: the heavy ones first. */
// „Sticker mit allen Einstellungen“ too, as in 0.5.1 (its „Sticker drucken“): drawn on its first visit, its sheet held
// the app for a second and more (Prüfrunde 2, webkit W1). The Werkstatt's overview, three columns of text with drawn
// lists, took 250–600 ms on its first visit with a screen factor of 2 in WebKitGTK, 0.5.1's tiles 130–190 (Prüfrunde 2, Speicher).
const AHEAD: Kept[] = ['musik', 'sticker', 'box', 'add', 'stickers', 'workshop', 'settings', 'help'];

/**
 * When the page shown last changed. A page coming to the front has work of its own in the frames
 * after; building or painting another one then held it back. A click on a link counts as activity
 * anyway, a change of page made otherwise (the browser's back button, the app after an import, the
 * measuring mode) did not: the work ahead landed right on its first frames (Prüfrunde 2, webkit W1).
 */
let lastPageChange = 0;

/** Waits for a quiet moment: no scrolling, clicking, playing about or change of page for a while, the browser idle. */
function whenQuiet(run: () => void): () => void {
  const since = performance.now();
  let timer = 0;
  let idle = 0;
  const check = () => {
    const wait = Math.max(since, lastActivity(), lastPageChange) + 600 - performance.now();
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

/**
 * Paints a page built ahead once, while the app is quiet, under the page shown and all but
 * transparent, for two frames: its pictures are decoded and its parts drawn then, not on its
 * first visit. WebKitGTK paid all that in the frame that first showed it: „Meine Box“ stood
 * almost half a second on its first visit, three times as long as in 0.5.1, where it was the
 * start page and had been painted at the start (Prüfrunde 2, webkit W1).
 */
function paintAhead(page: Kept): Promise<void> {
  const main = document.querySelector<HTMLElement>('.main');
  return new Promise((resolve) => {
    if (!main || typeof requestAnimationFrame !== 'function') return resolve();
    // A rule of its own in <head>, not attributes on the page: nothing in the page changes, nothing
    // watching it (the drawn frames, the measuring mode) sees a change. The part of the page that
    // will show first: its top, in the window. Under the page shown, all but transparent.
    const style = (paintStyle ??= document.head.appendChild(document.createElement('style')));
    style.textContent = `.main > .page-slot-hidden[data-seite="${page}"] { visibility: visible; opacity: 0.004; z-index: -1; top: ${main.scrollTop}px; height: ${main.clientHeight}px; }
      .main > .page-slot-hidden[data-seite="${page}"] canvas { display: block; }`;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        style.textContent = '';
        resolve();
      }),
    );
  });
}
let paintStyle: HTMLStyleElement | undefined;

/** Until the pictures of a page built ahead are loaded, at most `maxMs`: painted before, they are decoded on its first visit after all. */
function picturesLoaded(page: Kept, maxMs: number): Promise<void> {
  const imgs = [...document.querySelectorAll<HTMLImageElement>(`.main > .page-slot[data-seite="${page}"] img`)].filter((i) => !i.complete);
  if (!imgs.length) return Promise.resolve();
  const loaded = imgs.map(
    (i) =>
      new Promise<void>((resolve) => {
        i.addEventListener('load', () => resolve(), { once: true });
        i.addEventListener('error', () => resolve(), { once: true });
      }),
  );
  return Promise.race([Promise.all(loaded).then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, maxMs))]);
}

function Slot({ shown, busy, seite, children }: { shown: boolean; busy?: boolean; seite?: string; children: ComponentChildren }) {
  // Coming to the front: its stickers are drawn once it is painted (quiet.ts). Here, while rendering,
  // so it is known before the page's own effects run.
  const was = useRef(false);
  if (shown && !was.current) pageComingUp();
  was.current = shown;
  // busy: the page before, still on screen while the next one loads (Pages).
  return (
    <div class={shown ? 'page-slot' : 'page-slot page-slot-hidden'} data-seite={seite} inert={!shown} aria-hidden={shown ? undefined : 'true'} aria-busy={shown && busy ? 'true' : undefined}>
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
  const lastWant = useRef(want);
  if (lastWant.current !== want) {
    lastWant.current = want;
    lastPageChange = performance.now();
  }
  const shown = keptPage(r);
  // The last address of each kept page, so a hidden page keeps what it showed.
  const last = useRef(new Map<Kept, Route>());
  if (shown) last.current.set(shown, r);
  const [built, setBuilt] = useState<ReadonlySet<Kept>>(() => new Set());
  const all = new Set(built);
  if (shown) all.add(shown);
  if (shown && !built.has(shown)) setBuilt(all);

  // Build the next page ahead while the app is quiet, and paint it once right after (paintAhead): in the
  // same quiet moment, once its pictures are there. In a quiet moment of its own, the paint doubled the
  // steps ahead, and more of them landed on a page someone had just opened.
  const painted = useRef(new Set<Kept>());
  if (shown) painted.current.add(shown);
  const [, paintedOne] = useState(0);
  const unpainted = AHEAD.find((k) => all.has(k) && !painted.current.has(k));
  const next = unpainted ? undefined : AHEAD.find((k) => !all.has(k));
  const builtAt = useRef(0);
  useEffect(
    () =>
      next
        ? whenQuiet(() => {
            builtAt.current = performance.now();
            setBuilt((b) => new Set(b).add(next));
          })
        : undefined,
    [next],
  );
  useEffect(() => {
    if (!unpainted) return undefined;
    let on = true;
    let stop = () => {};
    const paint = () =>
      void paintAhead(unpainted).then(() => {
        painted.current.add(unpainted);
        if (on) paintedOne((n) => n + 1);
      });
    void picturesLoaded(unpainted, 1000).then(() => {
      if (!on) return;
      // Somebody did something meanwhile, or another page came up: the next quiet moment.
      if (Math.max(lastActivity(), lastPageChange) > builtAt.current) stop = whenQuiet(paint);
      else paint();
    });
    return () => {
      on = false;
      stop();
    };
  }, [unpainted]);

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
  // .main stands at the top, as last set, and nothing scrolled since.
  const atTop = useRef(true);
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
    const top = (shown || overview) && !own ? (scroll.current.get(key) ?? 0) : 0;
    // Setting it makes the browser lay out the whole page here, once more before the new page is painted
    // (a good part of a switch to „Karte“ on a slow laptop, 0.6 #121): not when it stands there already.
    if (!(top === 0 && atTop.current)) main.scrollTop = top;
    atTop.current = top === 0;
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
      atTop.current = false;
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
        <Slot key={k} seite={k} shown={k === shown} busy={waiting}>
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
    <div class="app schlank">
      <SketchDefs />
      <Kopf />
      <main class="main">
        <Pages />
      </main>
      <Leiste />
      <PackageDialogHost />
      {rebuildDialog.value ? <RebuildDialogHost /> : null}
      {copyToCardDialog.value !== null ? <CopyToCardDialogHost /> : null}
      <SystemPrintDialogHost />
      <Toasts />
      <CloseQuestion />
    </div>
  );
}
