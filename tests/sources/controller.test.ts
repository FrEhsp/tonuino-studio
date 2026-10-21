import { signal, type Signal } from '@preact/signals';
import { afterEach, describe, expect, it } from 'vitest';
import { savedAs } from '../../src/core/sources/handoff';
import { INDEX_KEY, type LoadResult, type SmallStore } from '../../src/core/sources/load';
import { REACH_KEY } from '../../src/core/sources/reach';
import type { IndexEntry, IndexItem, SourceIndex } from '../../src/core/sources/types';
import type { AddOptions, ImportAlbum, ImportResult, ImportSession } from '../../src/features/add/session';
import type { Route } from '../../src/app/router';
import type { ByteSource } from '../../src/platform/types';
import { createSourcesState, type LocalListSource, type SourcesState } from '../../src/features/sources/controller';
import { fxBytes, loadSample } from './sample';

const LIST_URL = 'https://studio.example.de/quellen/index-v1.json';
const MP3 = fxBytes('gitlab/gsb_de-0001_tall.mp3');
const EMPTY = { format: 1, generatedAt: '2026-10-05T04:00:00.000Z', staleAfter: '2026-10-19T04:00:00.000Z', entries: [], blocked: [] };

class MemoryStore implements SmallStore {
  readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const item = (n: number): IndexItem => ({
  key: `test-stories/${n}`,
  title: `Geschichte ${n}`,
  category: 'hoerspiel',
  files: [{ url: `https://media.example.org/${n}.mp3`, name: `geschichte-${n}.mp3` }],
});

const STORIES: IndexEntry = {
  id: 'test-stories',
  type: 'gitlab-gsb',
  title: 'Geschichten zum Testen',
  publisher: 'Test',
  categories: ['hoerspiel'],
  ages: { min: 4, max: 8, source: 'editor' },
  language: 'de',
  rights: { kind: 'cc', id: 'by', version: '4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  delivery: 'direct',
  editPolicy: 'normal',
  pageUrl: 'https://example.org/geschichten',
  checkedAt: '2026-10-05T04:00:00.000Z',
  items: [item(1), item(2), item(3)],
};

const LIST: SourceIndex = { ...EMPTY, format: 1, entries: [STORIES] };

const audio = () => new Response(MP3.slice(), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
const hang = (init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Abgebrochen', 'AbortError')));
  });

/** Polls until the check holds; the controller works with real timers and promises. */
async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Nicht eingetreten: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));

/** File answers that wait until the test opens the gate; the list answers at once. */
function gated() {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((r) => (open = r));
  const fetch = (url: string) => (url === LIST_URL ? Promise.resolve(json(LIST)) : gate.then(audio));
  return { fetch, open: () => open() };
}

/** Starts a download, then a transfer of another selection while the files still load; the files arrive during the transfer. */
async function loadedDuringTransfer(t: Setup, g: ReturnType<typeof gated>): Promise<void> {
  expect(t.state.addFromSources(STORIES, [STORIES.items[0]], 'each')).toBe(true);
  t.session.value = { phase: 'writing', albums: [], rejected: [] };
  g.open();
  await until(() => t.state.run.value?.phase === 'waiting', 'waiting for the transfer');
}

const DONE_WITH_ERROR: ImportResult = { folders: [], partial: { folder: 5, written: 1 }, error: 'Auf der Karte ist kein Platz mehr.', refused: [], skipped: [], rest: [], reordered: [] };

/** A transfer that stopped in folder 05: the rest of the album waits for "Weiter übertragen". */
const REST_ALBUM = { title: 'Geschichten', tracks: [], target: 5, append: true } as unknown as ImportAlbum;
const DONE_WITH_REST: ImportResult = { ...DONE_WITH_ERROR, rest: [REST_ALBUM] };

interface Setup {
  state: SourcesState;
  session: Signal<ImportSession>;
  route: Signal<Route>;
  cardIn: Signal<boolean>;
  added: { names: string[]; paths: (string | undefined)[]; opts: AddOptions }[];
  toasts: { kind: string; title: string; text?: string; action?: { label: string; run: () => void } }[];
  calls: { url: string; init: RequestInit }[];
  resets: number;
}

let current: Setup | undefined;

afterEach(() => {
  current?.state.dispose();
  current = undefined;
});

function setup(
  o: {
    fetch?: (url: string, init: RequestInit, n: number) => Promise<Response>;
    kept?: SourceIndex;
    session?: ImportSession;
    route?: Route;
    localList?: () => LocalListSource | undefined;
    checkReach?: boolean;
    stored?: Record<string, string>;
    packaged?: boolean;
    coverBlob?: (url: string) => Promise<Blob | undefined>;
  } = {},
): Setup {
  const session = signal<ImportSession>(o.session ?? { phase: 'pick', albums: [], rejected: [] });
  const route = signal<Route>(o.route ?? { page: 'sources', entry: STORIES.id });
  const cardIn = signal(true);
  const storage = new MemoryStore();
  if (o.kept) storage.setItem(INDEX_KEY, JSON.stringify(o.kept));
  for (const [k, v] of Object.entries(o.stored ?? {})) storage.setItem(k, v);
  const s: Setup = { state: undefined as unknown as SourcesState, session, route, cardIn, added: [], toasts: [], calls: [], resets: 0 };
  const perUrl = new Map<string, number>();
  s.state = createSourcesState({
    fetch: (url, init) => {
      s.calls.push({ url, init });
      const n = (perUrl.get(url) ?? 0) + 1;
      perUrl.set(url, n);
      if (o.fetch) return o.fetch(url, init, n);
      return url === LIST_URL ? Promise.resolve(json(LIST)) : Promise.resolve(audio());
    },
    storage: () => storage,
    listUrl: () => LIST_URL,
    snapshot: async () => EMPTY,
    now: () => Date.now(),
    isOnline: () => true,
    cardReady: () => cardIn.value,
    packaged: () => !!o.packaged,
    session,
    addSources: async (sources: ByteSource[], opts: AddOptions) => {
      s.added.push({ names: sources.map((x) => x.name), paths: sources.map((x) => x.relativePath), opts });
      session.value = { phase: 'review', albums: [], rejected: opts.rejected ?? [] };
      return { accepted: sources.length, rejected: [] };
    },
    resetImport: (forFolder?: number) => {
      s.resets++;
      session.value = { phase: 'pick', albums: [], rejected: [], forFolder };
    },
    route,
    navigate: (r) => (route.value = r),
    toast: {
      success: (title, text, action) => s.toasts.push({ kind: 'success', title, text, ...(action ? { action } : {}) }),
      error: (title, text) => s.toasts.push({ kind: 'error', title, text }),
      info: (title, text) => s.toasts.push({ kind: 'info', title, text }),
    },
    download: { wait: async () => undefined, idleMs: 200 },
    keptAfterMs: 20,
    indexTimeoutMs: 150,
    ...(o.localList ? { localList: o.localList } : {}),
    ...(o.checkReach ? { checkReach: true } : {}),
    ...(o.coverBlob ? { coverBlob: o.coverBlob } : {}),
  });
  current = s;
  return s;
}

describe('the list on the "Entdecken" pages', () => {
  it('shows the kept copy while a hung request waits, and gives up on the request', async () => {
    const t = setup({ kept: loadSample(), fetch: (_url, init) => hang(init) });
    // Noted the moment the kept copy shows: a busy machine may poll only after the request was given up.
    let shown: { status: string; from?: string } | undefined;
    const stop = t.state.currentIndex.subscribe((c) => {
      if (c && !shown) shown = { status: t.state.indexState.value.status, from: c.from };
    });
    t.state.ensureIndex();
    expect(t.state.indexState.value.status).toBe('loading');
    // After a moment the page shows the kept copy instead of placeholders …
    await until(() => !!shown, 'kept copy shown');
    stop();
    expect(shown).toEqual({ status: 'loading', from: 'cache' });
    // … and after the timeout the request counts as failed.
    await until(() => t.state.indexState.value.status === 'ready', 'request given up');
    expect(t.state.indexState.value).toMatchObject({ status: 'ready', from: 'cache' });
    expect(t.calls[0].init.signal?.aborted).toBe(true);
  });

  it('replaces the kept copy with the current list when it arrives', async () => {
    let answer: (r: Response) => void = () => undefined;
    const t = setup({ kept: loadSample(), fetch: () => new Promise<Response>((r) => (answer = r)) });
    t.state.ensureIndex();
    await until(() => !!t.state.currentIndex.value, 'kept copy shown');
    answer(json(LIST));
    await until(() => t.state.indexState.value.status === 'ready', 'list loaded');
    expect(t.state.indexState.value).toMatchObject({ status: 'ready', from: 'network' });
    expect(t.state.currentIndex.value?.index.entries.map((e) => e.id)).toEqual([STORIES.id]);
  });

  it('"Erneut laden" cancels a request that hangs and asks again', async () => {
    const t = setup({ fetch: (_url, init, n) => (n === 1 ? hang(init) : Promise.resolve(json(LIST))) });
    t.state.ensureIndex();
    t.state.ensureIndex(); // a second visit while it loads: nothing new
    expect(t.calls).toHaveLength(1);
    t.state.ensureIndex(true);
    await until(() => t.state.indexState.value.status === 'ready', 'list loaded');
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0].init.signal?.aborted).toBe(true);
    expect(t.state.indexState.value).toMatchObject({ from: 'network' });
  });

  it('loads the current list when the browser is back online', async () => {
    const t = setup({ kept: loadSample(), fetch: (_url, _init, n) => (n === 1 ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(json(LIST))) });
    t.state.ensureIndex();
    await until(() => t.state.indexState.value.status === 'ready', 'kept copy');
    expect(t.state.indexState.value).toMatchObject({ from: 'cache' });
    t.state.setOnline(false);
    t.state.setOnline(true);
    await until(() => t.state.indexState.value.status === 'ready' && (t.state.indexState.value as { from: string }).from === 'network', 'current list');
  });

  it('stops a download when the newer list blocks what is loading', async () => {
    let blocked = false;
    const t = setup({
      fetch: (url, init) => (url === LIST_URL ? Promise.resolve(json(blocked ? { ...LIST, blocked: [STORIES.id] } : LIST)) : hang(init)),
    });
    t.state.ensureIndex();
    await until(() => t.state.indexState.value.status === 'ready', 'list');
    expect(t.state.addFromSources(STORIES, [STORIES.items[0]], 'each')).toBe(true);
    expect(t.state.run.value?.phase).toBe('loading');
    blocked = true;
    t.state.ensureIndex(true);
    await until(() => t.state.run.value === null, 'run stopped');
    expect(t.toasts.at(-1)).toMatchObject({ kind: 'info', title: 'Laden abgebrochen' });
    expect(t.added).toHaveLength(0);
    expect(t.state.currentIndex.value?.index.entries).toEqual([]);
  });
});

describe('the list built on this computer (internal desktop edition)', () => {
  it('loads it instead of the published list, and shows the last one while it is built', async () => {
    let finish: (r: LoadResult) => void = () => undefined;
    const loads: AbortSignal[] = [];
    let keptAsked = 0;
    const kept = { status: 'ready' as const, index: loadSample(), from: 'cache' as const, stale: false, offline: false };
    const t = setup({
      kept: LIST,
      localList: () => ({
        load: (signal) => {
          loads.push(signal);
          return new Promise<LoadResult>((r) => (finish = r));
        },
        kept: async () => {
          keptAsked++;
          return kept;
        },
      }),
    });
    // The start page's teaser reads the last list, never the network.
    t.state.peekKept();
    await until(() => t.state.teaserIndex.value === kept.index, 'teaser');
    expect(keptAsked).toBe(1);

    t.state.ensureIndex();
    await until(() => !!t.state.currentIndex.value, 'last list shown');
    // The last built list, not the published list's kept copy.
    expect(t.state.currentIndex.value?.index).toBe(kept.index);
    expect(t.state.indexState.value.status).toBe('loading');
    finish({ status: 'ready', index: LIST, from: 'network', stale: false, offline: false });
    await until(() => t.state.indexState.value.status === 'ready', 'built list shown');
    expect(t.state.currentIndex.value?.index).toBe(LIST);
    expect(loads).toHaveLength(1);
    expect(t.calls).toEqual([]);
    expect(keptAsked).toBe(2);
    expect(t.state.teaserIndex.value).toBe(LIST);
  });

  it('shows why when there is no list and none could be built', async () => {
    const t = setup({ localList: () => ({ load: async () => ({ status: 'error', reason: 'unavailable', offline: true, answered: false }), kept: async () => undefined }) });
    t.state.ensureIndex();
    await until(() => t.state.indexState.value.status === 'error', 'error shown');
    expect(t.state.indexState.value).toMatchObject({ status: 'error', offline: true });
    expect(t.calls).toEqual([]);
  });
});

describe('the choice of kind', () => {
  it('offers only kinds the list has, and falls back to "Alles" for a stored kind it has nothing of', async () => {
    const t = setup({ stored: { 'tonuino-studio:sources': JSON.stringify({ kind: 'lied', band: 'alle' }) } });
    expect(t.state.prefs.value.kind).toBe('lied');
    t.state.ensureIndex();
    await until(() => t.state.indexState.value.status === 'ready', 'list loaded');
    expect(t.state.offeredKinds.value).toEqual(['alle', 'hoerspiel']);
    expect(t.state.kindChoice.value).toBe('alle');
    // The stored choice stays for a list that has songs again.
    expect(t.state.prefs.value.kind).toBe('lied');
    t.state.updatePrefs({ kind: 'hoerspiel' });
    expect(t.state.kindChoice.value).toBe('hoerspiel');
  });
});

describe('handing loaded files to the add flow', () => {
  it('opens the add page with the files, their order and their origin', async () => {
    const t = setup();
    expect(t.state.addFromSources(STORIES, STORIES.items, 'all')).toBe(true);
    await until(() => t.added.length === 1, 'files added');
    expect(t.added[0].names).toEqual(['geschichte-1.mp3', 'geschichte-2.mp3', 'geschichte-3.mp3']);
    expect([...(t.added[0].opts.origins?.values() ?? [])].map((o) => o.item.key)).toEqual(STORIES.items.map((i) => i.key));
    expect(t.state.run.value).toBeNull();
    expect(t.route.value).toEqual({ page: 'add' });
    expect(t.toasts.at(-1)?.title).toBe('Geladen. Prüfe die Auswahl und übertrage sie dann auf die SD-Karte.');
  });

  it('stays on the page the family reads and leads to the files from the message', async () => {
    const t = setup({ route: { page: 'sources' } });
    t.state.addFromSources(STORIES, STORIES.items, 'all');
    await until(() => t.added.length === 1, 'files added');
    // The overview (or another source) stays; the toast offers the way.
    expect(t.route.value).toEqual({ page: 'sources' });
    const last = t.toasts.at(-1)!;
    expect(last.title).toContain('unter „Hinzufügen“');
    expect(last.action?.label).toBe('Jetzt prüfen');
    last.action!.run();
    expect(t.route.value).toEqual({ page: 'add' });
  });

  it('names the chapter that loads, not the book again', async () => {
    const g = gated();
    const t = setup({ fetch: g.fetch });
    const book: IndexEntry = { ...STORIES, items: [{ ...STORIES.items[0], files: [{ ...STORIES.items[0].files[0], title: 'Erstes Kapitel' }] }] };
    t.state.addFromSources(book, book.items, 'each');
    expect(t.state.run.value).toMatchObject({ phase: 'loading', current: 'Erstes Kapitel' });
    g.open();
    await until(() => t.added.length === 1, 'files added');
  });

  it('speaks of the Paket where the browser cannot write to the card', async () => {
    const t = setup({ packaged: true });
    t.state.addFromSources(STORIES, STORIES.items, 'all');
    await until(() => t.added.length === 1, 'files added');
    expect(t.toasts.at(-1)?.title).toBe('Geladen. Prüfe die Auswahl und lege sie dann ins Paket für die Karte.');
  });

  it('keeps the result of a transfer that ends while the files wait for it', async () => {
    const g = gated();
    const t = setup({ fetch: g.fetch });
    await loadedDuringTransfer(t, g);
    expect(t.state.handOffBlocker.value).toEqual({ kind: 'writing' });

    // The transfer ends with an error: the result must stay on screen.
    t.session.value = { phase: 'done', albums: [], rejected: [], result: DONE_WITH_ERROR };
    await settle();
    expect(t.session.value.phase).toBe('done');
    expect(t.session.value.result).toBe(DONE_WITH_ERROR);
    expect(t.resets).toBe(0);
    expect(t.added).toHaveLength(0);
    expect(t.state.run.value?.phase).toBe('waiting');
    expect(t.state.handOffBlocker.value).toEqual({ kind: 'result', folder: undefined });
    // Downloads may still start; only the hand-off waits.
    expect(t.state.blocker.value).toBeNull();

    // The family looks at the result on the add page …
    t.route.value = { page: 'add' };
    await settle();
    expect(t.added).toHaveLength(0);
    // … and goes on to another page: now the files go to the add flow, without pulling them back.
    t.route.value = { page: 'box' };
    await until(() => t.added.length === 1, 'files added after the result was seen');
    expect(t.route.value).toEqual({ page: 'box' });
    expect(t.toasts.at(-1)?.title).toContain('unter „Hinzufügen“');
  });

  it('waits on the result screen until the family starts something new', async () => {
    const t = setup({ session: { phase: 'done', albums: [], rejected: [], result: DONE_WITH_ERROR }, route: { page: 'add' } });
    expect(t.state.addFromSources(STORIES, [STORIES.items[1]], 'each')).toBe(true);
    await until(() => t.state.run.value?.phase === 'waiting', 'waiting for the result to be seen');
    await settle();
    expect(t.session.value.result).toBe(DONE_WITH_ERROR);
    expect(t.added).toHaveLength(0);
    // "Noch mehr hinzufügen"
    t.session.value = { phase: 'pick', albums: [], rejected: [] };
    await until(() => t.added.length === 1, 'files added');
    expect(t.added[0].names).toEqual(['geschichte-2.mp3']);
    expect(t.route.value).toEqual({ page: 'add' });
  });

  it('does not wait for a result the family has already seen', async () => {
    const t = setup({ session: { phase: 'done', albums: [], rejected: [], result: DONE_WITH_ERROR }, route: { page: 'add' } });
    t.route.value = { page: 'sources', entry: STORIES.id };
    await settle();
    expect(t.state.handOffBlocker.value).toBeNull();
    t.state.addFromSources(STORIES, [STORIES.items[0]], 'each');
    await until(() => t.added.length === 1, 'files added');
    expect(t.resets).toBe(1);
  });

  it('drops the files when the family cancels while they wait, and adds nothing later', async () => {
    const g = gated();
    const t = setup({ fetch: g.fetch });
    await loadedDuringTransfer(t, g);
    t.state.cancelRun();
    expect(t.state.run.value).toBeNull();
    t.session.value = { phase: 'pick', albums: [], rejected: [] };
    await settle();
    expect(t.added).toHaveLength(0);
    expect(t.state.keepPageOpen.value).toBe(false);
  });

  it('needs "Weiter" after the SD card was pulled while waiting', async () => {
    const g = gated();
    const t = setup({ fetch: g.fetch });
    await loadedDuringTransfer(t, g);
    t.cardIn.value = false;
    t.session.value = { phase: 'pick', albums: [], rejected: [] };
    await settle();
    expect(t.state.handOffBlocker.value).toEqual({ kind: 'card' });
    t.cardIn.value = true;
    await settle();
    expect(t.added).toHaveLength(0);
    t.state.resumeHandOff();
    await until(() => t.added.length === 1, 'files added after "Weiter"');
  });

  it('loads only the missing files again and keeps the playing order', async () => {
    const t = setup({
      fetch: (url, _init, n) => Promise.resolve(url.endsWith('/2.mp3') && n === 1 ? new Response('weg', { status: 404, headers: { 'content-type': 'text/html' } }) : audio()),
    });
    t.state.addFromSources(STORIES, STORIES.items, 'all');
    await until(() => t.state.run.value?.phase === 'failed', 'one file missing');
    const failed = t.state.run.value;
    if (failed?.phase !== 'failed') throw new Error('expected failed');
    expect(failed.loaded.map((l) => l.pick.item.key)).toEqual(['test-stories/1', 'test-stories/3']);
    expect(failed.missing.map((m) => m.pick.item.key)).toEqual(['test-stories/2']);
    expect(t.state.dropFallback.value).toContain(STORIES.id);
    expect(t.state.keepPageOpen.value).toBe(true);
    t.state.retryMissing();
    await until(() => t.added.length === 1, 'files added');
    expect(t.calls.filter((c) => c.url.endsWith('/1.mp3'))).toHaveLength(1);
    expect(t.added[0].names).toEqual(['geschichte-1.mp3', 'geschichte-2.mp3', 'geschichte-3.mp3']);
  });

  it('passes the source\'s own cover along as the cover file of each folder', async () => {
    const asked: string[] = [];
    const t = setup({
      coverBlob: async (url) => {
        asked.push(url);
        return url.includes('nocors') ? undefined : new Blob([new Uint8Array(4)], { type: 'image/png' });
      },
    });
    const withCover: IndexEntry = { ...STORIES, cover: 'https://img.example.org/quelle.png', items: [{ ...STORIES.items[0], cover: 'https://img.example.org/eins.png' }, STORIES.items[1]] };
    t.state.addFromSources(withCover, withCover.items, 'each');
    await until(() => t.added.length === 1, 'files added');
    // One card each: the item's own picture, else the source's; beside the files of its folder.
    expect(asked.sort()).toEqual(['https://img.example.org/eins.png', 'https://img.example.org/quelle.png']);
    const at = (name: string) => t.added[0].paths.filter((_, i) => t.added[0].names[i] === name);
    expect(at('cover.png')).toEqual(['Entdecken/Geschichten zum Testen/Geschichte 1/cover.png', 'Entdecken/Geschichten zum Testen/Geschichte 2/cover.png']);
    expect(at('geschichte-1.mp3')).toEqual(['Entdecken/Geschichten zum Testen/Geschichte 1/geschichte-1.mp3']);
    // No copy allowed: no picture at all, never one drawn instead.
    const t2 = setup({ coverBlob: async () => undefined });
    t2.state.addFromSources({ ...STORIES, cover: 'https://nocors.example.org/c.jpg' }, [STORIES.items[0]], 'each');
    await until(() => t2.added.length === 1, 'files added');
    expect(t2.added[0].names).toEqual(['geschichte-1.mp3']);
  });

  it('asks for the largest picture the source offers for the card, else takes the one the page shows', async () => {
    const small = 'https://api.ardmediathek.de/image-service/images/urn:ard:image:abc?w=448&ch=123';
    const big = 'https://api.ardmediathek.de/image-service/images/urn:ard:image:abc?w=1280&ch=123';
    for (const bigLoads of [true, false]) {
      const asked: string[] = [];
      const t = setup({
        coverBlob: async (url) => {
          asked.push(url);
          if (url === big && !bigLoads) return undefined;
          return new Blob([new Uint8Array(url === big ? 8 : 4)], { type: 'image/jpeg' });
        },
      });
      t.state.addFromSources({ ...STORIES, cover: small }, [STORIES.items[0]], 'each');
      await until(() => t.added.length === 1, 'files added');
      expect(asked).toEqual(bigLoads ? [big] : [big, small]);
      expect(t.added[0].names).toEqual(['geschichte-1.mp3', 'cover.jpg']);
    }
  });

  it('continues without the missing files and lists them as not loaded', async () => {
    const t = setup({ fetch: (url) => Promise.resolve(url.endsWith('/2.mp3') ? new Response('weg', { status: 404, headers: { 'content-type': 'text/html' } }) : audio()) });
    t.state.addFromSources(STORIES, STORIES.items, 'each');
    await until(() => t.state.run.value?.phase === 'failed', 'one file missing');
    t.state.continueWithout();
    await until(() => t.added.length === 1, 'files added');
    expect(t.added[0].names).toEqual(['geschichte-1.mp3', 'geschichte-3.mp3']);
    expect(t.added[0].opts.rejected).toEqual([expect.objectContaining({ name: 'Geschichte 2', web: true })]);
  });

  it('keeps the rest of a stopped transfer, also after its result was seen', async () => {
    const t = setup({ session: { phase: 'done', albums: [], rejected: [], result: DONE_WITH_REST, forFolder: 5 }, route: { page: 'add', folder: 5 } });
    // The family saw the result and went on to "Entdecken".
    t.route.value = { page: 'sources', entry: STORIES.id };
    await settle();
    expect(t.state.handOffBlocker.value).toEqual({ kind: 'rest', folder: 5 });
    expect(t.state.blocker.value).toBeNull();
    expect(t.state.addFromSources(STORIES, [STORIES.items[0]], 'each')).toBe(true);
    await until(() => t.state.run.value?.phase === 'waiting', 'waiting for the rest');
    await settle();
    expect(t.resets).toBe(0);
    expect(t.added).toHaveLength(0);
    expect(t.session.value.result?.rest).toEqual([REST_ALBUM]);
    // "Verwerfen" on the add page: now the files go on by themselves.
    t.session.value = { phase: 'pick', albums: [], rejected: [], forFolder: 5 };
    await until(() => t.added.length === 1, 'files added after the rest was discarded');
    expect(t.added[0].names).toEqual(['geschichte-1.mp3']);
  });

  it('goes on when every file picked for a folder was refused: there is nothing to finish', async () => {
    const refused = { name: 'Notiz.txt', reason: 'Das ist keine Audiodatei.' };
    const t = setup({ session: { phase: 'review', albums: [], rejected: [refused], forFolder: 7 } });
    expect(t.state.blocker.value).toBeNull();
    expect(t.state.addFromSources(STORIES, [STORIES.items[0]], 'each')).toBe(true);
    await until(() => t.added.length === 1, 'files added');
    // A new selection, not one for folder 07.
    expect(t.resets).toBe(1);
    expect(t.added[0].names).toEqual(['geschichte-1.mp3']);
  });
});

describe('files saved from the publisher\'s page', () => {
  const unchanged: IndexEntry = { ...STORIES, id: 'test-unchanged', type: 'podcast', delivery: 'browser', editPolicy: 'unchanged', rights: { kind: 'podcast', holder: 'SRF' } };
  const file = (name: string): ByteSource => ({ name, size: 3, read: async () => new Uint8Array(0) });
  const ALBUM: IndexEntry = {
    ...STORIES,
    id: 'test-album',
    type: 'archive-album',
    title: 'Lieder',
    items: [
      {
        key: 'test-album/1',
        title: 'Lieder',
        category: 'lied',
        files: [
          { url: 'https://media.example.org/k1.mp3', name: 'k1.mp3', title: 'Der Kuckuck und der Esel', track: 1 },
          { url: 'https://media.example.org/k2.mp3', name: 'k2.mp3', title: 'Alle meine Entchen', track: 2 },
        ],
      },
    ],
  };
  const song = (n: number) => ({ item: ALBUM.items[0], file: ALBUM.items[0].files[n - 1] });
  /** Both songs fail the first time, then load. */
  const failingOnce = () => setup({ route: { page: 'sources', entry: ALBUM.id }, fetch: (url, _init, n) => Promise.resolve(url === LIST_URL ? json(LIST) : n === 1 ? new Response('weg', { status: 404 }) : audio()) });

  it('fills a gap of the failed download with a song saved by hand: one folder, and only the rest loads again', async () => {
    const t = failingOnce();
    t.state.addFromSources(ALBUM, ALBUM.items, 'each');
    await until(() => t.state.run.value?.phase === 'failed', 'both songs missing');
    const failed = t.state.run.value;
    if (failed?.phase !== 'failed') throw new Error('expected failed');
    expect(failed.partial).toBe('2 von 2 Liedern ließen sich nicht laden.');
    // All are missing: the line above says so, the reasons do not list them again.
    expect(failed.message).not.toMatch(/Es fehlen/);
    await t.state.addSaved(ALBUM, [{ source: file('k1.mp3'), pick: song(1) }]);
    // Not added on its own: the bar now says what is still missing.
    expect(t.added).toHaveLength(0);
    const after = t.state.run.value;
    if (after?.phase !== 'failed') throw new Error('expected failed');
    expect(after.partial).toBe('1 von 2 Liedern ließ sich nicht laden.');
    expect(after.missing.map((m) => m.pick.file.name)).toEqual(['k2.mp3']);
    expect(after.message).toMatch(/„Alle meine Entchen“/);
    t.state.retryMissing();
    await until(() => t.added.length === 1, 'files added');
    expect(t.calls.filter((c) => c.url.endsWith('/k1.mp3'))).toHaveLength(1);
    expect(t.added[0].names).toEqual(['k1.mp3', 'k2.mp3']);
    expect(new Set(t.added[0].paths.map((p) => p?.slice(0, p.lastIndexOf('/'))))).toEqual(new Set(['Entdecken/Lieder']));
    expect(t.added[0].opts.hints?.size).toBe(2);
  });

  it('goes on to the add flow once the last missing song was saved by hand', async () => {
    const t = failingOnce();
    t.state.addFromSources(ALBUM, ALBUM.items, 'each');
    await until(() => t.state.run.value?.phase === 'failed', 'both songs missing');
    await t.state.addSaved(ALBUM, [
      { source: file('k2.mp3'), pick: song(2) },
      { source: file('k1.mp3'), pick: song(1) },
    ]);
    expect(t.added).toHaveLength(1);
    expect(t.added[0].names).toEqual(['k1.mp3', 'k2.mp3']);
    expect(t.state.run.value).toBeNull();
  });

  it('stays on the page after saved files were added, so more can follow, and takes the choice of cards', async () => {
    const t = setup();
    await t.state.addSaved(
      STORIES,
      [
        { source: file('geschichte-1.mp3'), pick: { item: STORIES.items[0], file: STORIES.items[0].files[0] } },
        { source: file('geschichte-2.mp3'), pick: { item: STORIES.items[1], file: STORIES.items[1].files[0] } },
      ],
      'all',
    );
    expect(t.route.value).toEqual({ page: 'sources', entry: STORIES.id });
    const last = t.toasts.at(-1)!;
    expect(last.title).toContain('unter „Hinzufügen“');
    expect(last.action?.label).toBe('Jetzt prüfen');
    // One card for all: the source is the album.
    expect([...(t.added[0].opts.hints?.values() ?? [])].map((h) => h.album)).toEqual([STORIES.title, STORIES.title]);
  });

  it('never takes an unknown file for a publisher that allows no changes', async () => {
    const t = setup();
    await t.state.addSaved(unchanged, [{ source: file('irgendwas.mp3') }]);
    expect(t.added).toHaveLength(0);
    const known = file('geschichte-1.mp3');
    await t.state.addSaved(unchanged, [{ source: file('irgendwas.mp3') }, { source: known, pick: { item: unchanged.items[0], file: unchanged.items[0].files[0] } }]);
    expect(t.added).toHaveLength(1);
    expect(t.added[0].names).toEqual(['geschichte-1.mp3']);
    expect([...(t.added[0].opts.origins?.values() ?? [])][0].entry.editPolicy).toBe('unchanged');
  });

  it('takes a file from the publisher\'s page once the family said which episode it is', async () => {
    const t = setup();
    // ARD Sounds names its downloads its own way: the list has no file name, the family chose the episode.
    const ard: IndexEntry = { ...unchanged, items: unchanged.items.map((it) => ({ ...it, files: [], durationSec: 600 })) };
    const saved = file('a3f9c2e1.mp3');
    await t.state.addSaved(ard, [{ source: saved, pick: savedAs(ard.items[1], saved) }]);
    expect(t.added).toHaveLength(1);
    expect(t.added[0].names).toEqual(['a3f9c2e1.mp3']);
    const origin = [...(t.added[0].opts.origins?.values() ?? [])][0];
    expect(origin.item.key).toBe(ard.items[1].key);
    expect(origin.entry.editPolicy).toBe('unchanged');
  });

  it('takes unknown files for other sources, without origin', async () => {
    const t = setup();
    await t.state.addSaved(STORIES, [{ source: file('irgendwas.mp3') }]);
    expect(t.added).toHaveLength(1);
    expect(t.added[0].opts.origins?.size).toBe(0);
  });

  it('waits for an unseen transfer result instead of replacing it', async () => {
    const t = setup({ session: { phase: 'done', albums: [], rejected: [], result: DONE_WITH_ERROR } });
    await t.state.addSaved(STORIES, [{ source: file('geschichte-1.mp3'), pick: { item: STORIES.items[0], file: STORIES.items[0].files[0] } }]);
    expect(t.added).toHaveLength(0);
    expect(t.session.value.result).toBe(DONE_WITH_ERROR);
  });

  it('keeps the rest of a stopped transfer', async () => {
    const t = setup({ session: { phase: 'done', albums: [], rejected: [], result: DONE_WITH_REST, forFolder: 5 }, route: { page: 'add', folder: 5 } });
    t.route.value = { page: 'sources', entry: STORIES.id };
    await settle();
    await t.state.addSaved(STORIES, [{ source: file('geschichte-1.mp3'), pick: { item: STORIES.items[0], file: STORIES.items[0].files[0] } }]);
    expect(t.resets).toBe(0);
    expect(t.added).toHaveLength(0);
    expect(t.session.value.result?.rest).toEqual([REST_ALBUM]);
  });
});

describe('the list for the teaser on the start page', () => {
  it('reads the kept copy without asking the network', async () => {
    const kept: SourceIndex = { ...LIST, entries: [{ ...STORIES, featured: { rank: 1, why: 'Kurz und lustig.' } }] };
    const t = setup({ kept });
    expect(t.state.teaserIndex.value).toBeUndefined();
    t.state.peekKept();
    await until(() => !!t.state.teaserIndex.value, 'kept copy read');
    expect(t.state.teaserIndex.value?.entries[0].featured?.rank).toBe(1);
    expect(t.calls).toEqual([]);
  });

  it('stays empty with the shipped empty list and nothing kept', async () => {
    const t = setup();
    t.state.peekKept();
    await settle();
    expect(t.state.teaserIndex.value).toBeUndefined();
    expect(t.calls).toEqual([]);
  });

  it('leaves out titles an earlier visit found gone, without asking again', async () => {
    const kept: SourceIndex = { ...LIST, entries: [{ ...STORIES, featured: { rank: 1, why: 'Kurz und lustig.' } }] };
    const at = Date.now();
    const reach = { format: 1, results: { 'file:test-stories/1': { v: 'gone', at }, 'file:test-stories/2': { v: 'ok', at } } };
    const t = setup({ kept, checkReach: true, stored: { [REACH_KEY]: JSON.stringify(reach) } });
    t.state.peekKept();
    await until(() => !!t.state.teaserIndex.value, 'kept copy read');
    expect(t.state.teaserIndex.value?.entries[0].items.map((i) => i.key)).toEqual(['test-stories/2', 'test-stories/3']);
    expect(t.calls).toEqual([]);
  });

  it('leaves out titles whose time at the publisher is over, and a source left without titles', async () => {
    const past = '2020-01-01';
    const kept: SourceIndex = {
      ...LIST,
      entries: [
        { ...STORIES, items: [{ ...item(1), until: past }, item(2), { ...item(3), until: '2999-12-31' }] },
        { ...STORIES, id: 'over', items: [{ ...item(4), key: 'over/4', until: past }] },
      ],
    };
    const t = setup({ kept, fetch: (_url, init) => hang(init) });
    t.state.peekKept();
    await until(() => !!t.state.teaserIndex.value, 'kept copy read');
    expect(t.state.teaserIndex.value?.entries.map((e) => [e.id, e.items.map((i) => i.key)])).toEqual([[STORIES.id, ['test-stories/2', 'test-stories/3']]]);
    // On "Entdecken" as well, also without the check of the network.
    t.state.ensureIndex();
    await until(() => !!t.state.currentIndex.value, 'kept copy shown');
    expect(t.state.currentIndex.value?.index.entries.map((e) => e.id)).toEqual([STORIES.id]);
    expect(t.calls.map((c) => c.url)).toEqual([LIST_URL]);
  });

  it('uses the list from "Entdecken" once it was loaded', async () => {
    const t = setup();
    t.state.ensureIndex();
    await until(() => t.state.indexState.value.status === 'ready', 'list loaded');
    expect(t.state.teaserIndex.value?.entries[0].id).toBe(STORIES.id);
  });
});

describe('titles that are no longer online', () => {
  it('asks only after the list loaded, hides a title its server no longer has, keeps titles on network errors', async () => {
    const t = setup({
      checkReach: true,
      fetch: (url, init) => {
        if (url === LIST_URL) return Promise.resolve(json(LIST));
        expect(init.method).toBe('HEAD');
        if (url.endsWith('/2.mp3')) return Promise.resolve(new Response(null, { status: 404 }));
        if (url.endsWith('/3.mp3')) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    });
    expect(t.calls).toEqual([]);
    t.state.ensureIndex();
    await until(() => t.state.currentIndex.value?.index.entries[0]?.items.length === 2, 'gone title hidden');
    expect(t.state.currentIndex.value!.index.entries[0].items.map((it) => it.key)).toEqual(['test-stories/1', 'test-stories/3']);
    expect(t.calls.filter((c) => c.url !== LIST_URL)).toHaveLength(3);
  });

  it('does not ask without the setting', async () => {
    const t = setup();
    t.state.ensureIndex();
    await until(() => t.state.indexState.value.status === 'ready', 'list loaded');
    await settle();
    expect(t.calls.map((c) => c.url)).toEqual([LIST_URL]);
  });
});
