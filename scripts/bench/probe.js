/*
 * The in-page half of the speed comparison (scripts/bench/README.md). Runs
 * before the app's own scripts, in Chromium (Playwright) and in WebKitGTK
 * (webkit.py), and works with any version of the app since 0.2:
 *
 * - a made-up SD card: the app's web platform asks for folders through the
 *   File System Access API and remembers the card in IndexedDB. Here those
 *   folders come from IndexedDB of this test origin (filled once by
 *   __bench.setup()), and the remembered card is handed back as such a
 *   folder, so the app finds the card at start like the desktop app does.
 *   What the app writes stays in memory for this page load only.
 * - watches the start from the very first frame: when something shows,
 *   which elements move or appear late, when everything stands still.
 * - __bench.run(name) runs one measurement inside the page and returns
 *   plain JSON: 'start', 'shelf', 'folder', 'player', 'import'.
 *
 * Plain script, no modules: it is injected as it is.
 */
(function () {
  'use strict';
  if (window.__bench) return;
  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const round = (n) => Math.round(n * 10) / 10;
  // The made-up card is FAT32, which keeps file times in steps of two seconds. With the exact time a
  // written file looked like exFAT and the health check warned about the format (src/core/tonuino/fsguess.ts).
  const fatNow = () => Math.floor(Date.now() / 2000) * 2000;

  /* ================================================================ background work */

  // The app's work after the measurements: pictures it encodes and keeps on this computer.
  let lastWork = 0;
  const spyOn = (proto, name) => {
    const orig = proto && proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function () {
      lastWork = now();
      return orig.apply(this, arguments);
    };
  };
  spyOn(window.HTMLCanvasElement && HTMLCanvasElement.prototype, 'toBlob');
  spyOn(window.OffscreenCanvas && OffscreenCanvas.prototype, 'convertToBlob');
  spyOn(window.IDBObjectStore && IDBObjectStore.prototype, 'put');

  /**
   * Waits until the app has done its background work (nothing encoded or
   * stored for 2.5 s; at most 45 s), as when it stays open a while: the next
   * start then finds what this one kept. Not a measurement.
   */
  async function runSettle() {
    const t0 = now();
    while (now() - t0 < 45000) {
      await sleep(500);
      if (now() - lastWork > 2500) break;
    }
    return { settledMs: round(now() - t0) };
  }

  /* ================================================================ the card */

  const DB = 'tonuino-bench';
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('files');
          r.result.createObjectStore('meta');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  function idb(store, mode, fn) {
    return db().then(
      (d) =>
        new Promise((res, rej) => {
          const tx = d.transaction(store, mode);
          const req = fn(tx.objectStore(store));
          tx.oncomplete = () => res(req && req.result);
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error);
        }),
    );
  }

  const notFound = (name) => new DOMException(`${name} not found`, 'NotFoundError');
  const mismatch = (name) => new DOMException(`${name} is of the wrong kind`, 'TypeMismatchError');

  /** A node of the made-up file tree. */
  function makeNode(kind, name, parent) {
    return { kind, name, parent, children: kind === 'directory' ? new Map() : null, size: 0, mtime: Date.parse('2025-11-02T10:00:00Z'), key: null, blob: null };
  }

  let trees = null;
  const stored = new Map();
  /** The card and the import folder as trees, from the index the setup stored. */
  function loadTrees() {
    if (!trees) {
      trees = Promise.all([idb('meta', 'readonly', (s) => s.get('index')), idb('files', 'readonly', (s) => s.getAllKeys()), idb('files', 'readonly', (s) => s.getAll())]).then(([index, keys, blobs]) => {
        if (!index) return null;
        // All files at hand (blobs read lazily by the browser): listing the card costs what the desktop app's listing costs.
        keys.forEach((k, i) => stored.set(k, blobs[i]));
        const out = {};
        for (const [rootName, entries] of Object.entries(index)) {
          const root = makeNode('directory', rootName === 'card' ? 'MESSKARTE' : 'Messalbum', null);
          for (const e of entries) {
            const parts = e.path.split('/');
            let at = root;
            for (let i = 0; i < parts.length - 1; i++) at = at.children.get(parts[i]);
            const n = makeNode(e.dir ? 'directory' : 'file', parts[parts.length - 1], at);
            if (!e.dir) {
              n.size = e.size;
              n.mtime = e.mtime;
              n.key = `${rootName}/${e.path}`;
            }
            at.children.set(n.name, n);
          }
          out[rootName] = root;
        }
        return out;
      });
    }
    return trees;
  }

  const stats = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 };

  async function fileOf(node) {
    if (node.blob) return new File([node.blob], node.name, { lastModified: node.mtime, type: node.name.endsWith('.mp3') ? 'audio/mpeg' : '' });
    if (!node.key) return new File([], node.name, { lastModified: node.mtime });
    const blob = stored.get(node.key) ?? (await idb('files', 'readonly', (s) => s.get(node.key)));
    if (!blob) throw notFound(node.name);
    stats.reads++;
    // Stored as File already (setup): handing it out costs nothing, like the desktop app's listing.
    if (blob instanceof File && blob.name === node.name) return blob;
    return new File([blob], node.name, { lastModified: node.mtime, type: blob.type || (node.name.endsWith('.mp3') ? 'audio/mpeg' : '') });
  }

  function pathOf(node) {
    const out = [];
    for (let n = node; n && n.parent; n = n.parent) out.unshift(n.name);
    return out;
  }

  class BenchHandle {
    constructor(node) {
      // Own data only: the app stores the card's handle in IndexedDB; this marks it.
      this.__benchCard = node.parent === null ? 'root' : 'child';
      Object.defineProperty(this, 'node', { value: node, enumerable: false });
    }
    get kind() {
      return this.node.kind;
    }
    get name() {
      return this.node.name;
    }
    async isSameEntry(other) {
      return !!other && other.node === this.node;
    }
    async queryPermission() {
      return 'granted';
    }
    async requestPermission() {
      return 'granted';
    }
    async move(a, b) {
      const target = typeof a === 'string' ? this.node.parent : a.node;
      const name = typeof a === 'string' ? a : (b ?? this.node.name);
      if (!target || target.kind !== 'directory') throw new DOMException('bad target', 'InvalidModificationError');
      this.node.parent.children.delete(this.node.name);
      this.node.name = name;
      this.node.parent = target;
      target.children.set(name, this.node);
    }
  }

  class BenchFile extends BenchHandle {
    async getFile() {
      return fileOf(this.node);
    }
    async createWritable(opts) {
      const node = this.node;
      let data = opts && opts.keepExistingData ? await fileOf(node) : new Blob([]);
      let pos = 0;
      const put = (chunk, at) => {
        const b = chunk instanceof Blob ? chunk : new Blob([chunk]);
        const pad = at > data.size ? new Uint8Array(at - data.size) : new Uint8Array(0);
        data = new Blob([data.slice(0, Math.min(at, data.size)), pad, b, data.slice(at + b.size)]);
        stats.writeBytes += b.size;
        return at + b.size;
      };
      return {
        async write(arg) {
          if (arg && typeof arg === 'object' && 'type' in arg && !(arg instanceof Blob) && !ArrayBuffer.isView(arg) && !(arg instanceof ArrayBuffer)) {
            if (arg.type === 'seek') pos = arg.position;
            else if (arg.type === 'truncate') data = data.slice(0, arg.size);
            else pos = put(arg.data, arg.position ?? pos);
            return;
          }
          pos = put(arg, pos);
        },
        async seek(p) {
          pos = p;
        },
        async truncate(size) {
          data = data.slice(0, size);
        },
        async close() {
          node.blob = data;
          node.key = null;
          node.size = data.size;
          node.mtime = fatNow();
          stats.writes++;
        },
        async abort() {},
      };
    }
  }

  class BenchDir extends BenchHandle {
    async *entries() {
      for (const n of [...this.node.children.values()]) yield [n.name, wrap(n)];
    }
    async *values() {
      for (const n of [...this.node.children.values()]) yield wrap(n);
    }
    async *keys() {
      for (const n of [...this.node.children.keys()]) yield n;
    }
    [Symbol.asyncIterator]() {
      return this.entries();
    }
    async getDirectoryHandle(name, opts) {
      let n = this.node.children.get(name);
      if (!n) {
        if (!(opts && opts.create)) throw notFound(name);
        n = makeNode('directory', name, this.node);
        this.node.children.set(name, n);
      } else if (n.kind !== 'directory') throw mismatch(name);
      return wrap(n);
    }
    async getFileHandle(name, opts) {
      let n = this.node.children.get(name);
      if (!n) {
        if (!(opts && opts.create)) throw notFound(name);
        n = makeNode('file', name, this.node);
        n.blob = new Blob([]);
        n.mtime = fatNow();
        this.node.children.set(name, n);
      } else if (n.kind !== 'file') throw mismatch(name);
      return wrap(n);
    }
    async removeEntry(name, opts) {
      const n = this.node.children.get(name);
      if (!n) throw notFound(name);
      if (n.kind === 'directory' && n.children.size && !(opts && opts.recursive)) throw new DOMException('not empty', 'InvalidModificationError');
      this.node.children.delete(name);
    }
    async resolve(other) {
      const mine = pathOf(this.node);
      const theirs = pathOf(other.node);
      return mine.every((p, i) => theirs[i] === p) ? theirs.slice(mine.length) : null;
    }
  }

  const handles = new WeakMap();
  function wrap(node) {
    let h = handles.get(node);
    if (!h) {
      h = node.kind === 'directory' ? new BenchDir(node) : new BenchFile(node);
      handles.set(node, h);
    }
    return h;
  }

  let cardRoot = null;
  const ready = loadTrees()
    .then((t) => {
      if (t) cardRoot = t;
    })
    .catch(() => undefined);

  /** A handle the app stored (cloned without its methods) comes back as the live one. */
  function revive(v) {
    if (!cardRoot || !v || typeof v !== 'object') return v;
    if (v.handle && v.handle.__benchCard === 'root' && !(v.handle instanceof BenchHandle)) return Object.assign({}, v, { handle: wrap(cardRoot.card) });
    if (Array.isArray(v)) return v.map(revive);
    return v;
  }
  const resultGet = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result').get;
  Object.defineProperty(IDBRequest.prototype, 'result', {
    configurable: true,
    get() {
      return revive(resultGet.call(this));
    },
  });

  /** The folder pickers: the card, or the album for the import. */
  window.showDirectoryPicker = async function (opts) {
    await ready;
    if (!cardRoot) throw new DOMException('no card', 'AbortError');
    return wrap(opts && opts.id === 'tonuino-import' ? cardRoot.import : cardRoot.card);
  };
  window.showOpenFilePicker = async function () {
    await ready;
    if (!cardRoot) throw new DOMException('no card', 'AbortError');
    return [...cardRoot.import.children.values()].filter((n) => n.kind === 'file').map(wrap);
  };

  /** Once per test origin: the card and the album from the bench server into IndexedDB, and the card remembered by the app. */
  async function setup() {
    const index = {};
    for (const root of ['card', 'import']) {
      const list = await (await fetch(`/__bench/${root}-index.json`)).json();
      index[root] = list;
      const files = list.filter((e) => !e.dir);
      for (let i = 0; i < files.length; i += 40) {
        const batch = await Promise.all(
          files.slice(i, i + 40).map(async (e) => {
            const blob = await (await fetch(`/__bench/${root}/${e.path.split('/').map(encodeURIComponent).join('/')}`)).blob();
            const name = e.path.split('/').pop();
            return [e, new File([blob], name, { lastModified: e.mtime, type: name.endsWith('.mp3') ? 'audio/mpeg' : blob.type })];
          }),
        );
        await idb('files', 'readwrite', (s) => {
          let last = null;
          for (const [e, blob] of batch) last = s.put(blob, `${root}/${e.path}`);
          return last;
        });
      }
    }
    await idb('meta', 'readwrite', (s) => s.put(index, 'index'));
    // The app's own store (src/platform/web/idb.ts, volumes.ts): the card as one picked earlier.
    await new Promise((res, rej) => {
      const r = indexedDB.open('tonuino-studio', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => {
        const tx = r.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ id: 'web-bench', handle: { __benchCard: 'root' }, label: 'MESSKARTE', lastUsed: Date.now() }, 'volume:web-bench');
        tx.oncomplete = () => {
          r.result.close();
          res();
        };
        tx.onerror = () => rej(tx.error);
      };
      r.onerror = () => rej(r.error);
    });
    return { files: index.card.length + index.import.length };
  }

  /* ================================================================ watching the start */

  const start = {
    frames: [],
    moves: [],
    late: [],
    longTasks: [],
    shifts: [],
    fonts: [],
    firstPaint: null,
    firstContent: null,
    appShown: null,
    headingShown: null,
    shelfShown: null,
    lastChange: 0,
    watching: true,
  };
  const longTasks = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longTasks.push({ t: e.startTime, d: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* WebKit has none */
  }
  let shiftScore = 0;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        shiftScore += e.value;
        if (start.watching) start.shifts.push({ t: round(e.startTime), v: e.value, what: (e.sources || []).slice(0, 3).map((s) => describe(s.node)) });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    /* WebKit has none */
  }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.name === 'first-paint') start.firstPaint = e.startTime;
        if (e.name === 'first-contentful-paint') start.firstContent = e.startTime;
      }
    }).observe({ type: 'paint', buffered: true });
  } catch {
    /* none */
  }
  if (document.fonts) {
    document.fonts.addEventListener('loadingdone', (e) => start.watching && start.fonts.push({ t: round(now()), faces: (e.fontfaces || []).map((f) => `${f.family} ${f.weight}`) }));
  }

  function describe(el) {
    if (!el || !el.tagName) return String(el && el.nodeName);
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${cls}${text ? ` „${text}“` : ''}`;
  }

  /** What one sees: the sidebar and the page shown (kept pages hide in .page-slot-hidden). */
  // Enough to see anything move (a tile's parts move with the tile), few enough to look at in every frame.
  const WATCHED = ['h1', 'h2', 'h3', 'p', 'a', 'button:not(.tile *)', 'img:not(.tile *)', 'input', '.tile', '.badge', '.sd-status', '.shelf', '.card', '.callout', '.app-brand', '.progress', '.capacity'];
  // Not the page as a whole: it grows when something comes in below the visible part, which moves nothing one sees.
  const SEL = [`.app > :not(main) :is(${WATCHED.join(',')})`, `.main > .page-slot:not(.page-slot-hidden) :is(${WATCHED.join(',')})`].join(',');
  const seen = new WeakMap();
  let firstAppFrame = null;

  function sample(t) {
    const app = document.querySelector('.app');
    if (!app) return;
    const vw = innerWidth;
    const vh = innerHeight;
    const els = document.querySelectorAll(SEL);
    const limit = Math.min(els.length, 900);
    if (firstAppFrame === null && document.querySelector('.sidebar a')) {
      firstAppFrame = t;
      start.appShown = t;
    }
    if (start.headingShown === null) {
      // The first page as drawn: its main heading has a place on screen.
      const h = document.querySelector('.main > .page-slot:not(.page-slot-hidden) h1');
      const r = h && h.getBoundingClientRect();
      if (r && r.width >= 1 && r.height >= 1) start.headingShown = t;
    }
    if (start.shelfShown === null && document.querySelector('.main > .page-slot:not(.page-slot-hidden) .shelf .tile')) start.shelfShown = t;
    for (let i = 0; i < limit; i++) {
      const el = els[i];
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
      const box = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      const prev = seen.get(el);
      if (!prev) {
        seen.set(el, box);
        if (firstAppFrame !== null && t > firstAppFrame) {
          start.late.push({ t: round(t), what: describe(el) });
          start.lastChange = t;
        }
        continue;
      }
      const dx = box[0] - prev[0];
      const dy = box[1] - prev[1];
      const dw = box[2] - prev[2];
      const dh = box[3] - prev[3];
      if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1 || Math.abs(dw) >= 1 || Math.abs(dh) >= 1) {
        start.moves.push({ t: round(t), what: describe(el), dx, dy, dw, dh });
        seen.set(el, box);
        start.lastChange = t;
      }
    }
  }

  /** Frames and what changed from the very first one until watching stops. */
  function watchStart() {
    const loop = (t) => {
      if (!start.watching) return;
      start.frames.push(t);
      try {
        sample(t);
      } catch {
        /* the page is being built */
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    // Drawn frames and pictures that change after they showed count as a change too.
    const mo = new MutationObserver((records) => {
      if (!firstAppFrame) return;
      for (const r of records) {
        const el = r.target;
        if (!(el instanceof Element) || el.closest('.page-slot-hidden')) continue;
        const name = r.attributeName || '';
        if (name.startsWith('data-fc-') || name === 'src' || (name === 'class' && /baked|pictured/.test(el.className))) {
          const b = el.getBoundingClientRect();
          if (b.bottom < 0 || b.top > innerHeight) continue;
          start.lastChange = now();
          start.late.push({ t: round(now()), what: `${describe(el)} [${name}]` });
        }
      }
    });
    const begin = () => mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-fc-before', 'data-fc-after', 'src', 'class'] });
    if (document.documentElement) begin();
    start.stopMo = () => mo.disconnect();
  }
  // tempo.mjs measures from outside: without the watching in every frame, which costs time itself.
  if (!window.__benchNoWatch) watchStart();

  async function runStart(opts) {
    const quiet = (opts && opts.quietMs) || 2500;
    const maxMs = (opts && opts.maxMs) || 20000;
    // Without a card (BENCH_NOCARD) there is no shelf: the start is done once the page stands still.
    const noCard = !(await ready.then(() => cardRoot).catch(() => null));
    for (;;) {
      await sleep(100);
      const t = now();
      const shown = noCard ? start.headingShown : start.shelfShown;
      if (shown !== null && t - Math.max(start.lastChange, shown) >= quiet) break;
      if (t > maxMs) break;
    }
    start.watching = false;
    start.stopMo && start.stopMo();
    const nav = performance.getEntriesByType('navigation')[0];
    const frames = start.frames;
    const gaps = [];
    for (let i = 1; i < frames.length; i++) if (frames[i] <= (start.shelfShown ?? 0) + 3000) gaps.push(frames[i] - frames[i - 1]);
    const firstVisible = start.firstContent ?? start.appShown;
    const stableAt = Math.max(start.lastChange || 0, start.shelfShown || 0, noCard ? start.headingShown || 0 : 0);
    const movers = new Map();
    for (const m of start.moves) {
      const k = m.what;
      const e = movers.get(k) || { what: k, times: 0, firstT: m.t, lastT: m.t, maxPx: 0 };
      e.times++;
      e.lastT = m.t;
      e.maxPx = Math.max(e.maxPx, Math.abs(m.dx) + Math.abs(m.dy) + Math.abs(m.dw) + Math.abs(m.dh));
      movers.set(k, e);
    }
    const afterFirst = start.moves.filter((m) => firstAppFrame !== null && m.t > firstAppFrame);
    return {
      scriptsReadyMs: nav ? round(nav.domContentLoadedEventEnd) : null,
      firstPaintMs: start.firstPaint !== null ? round(start.firstPaint) : null,
      firstContentMs: firstVisible !== null ? round(firstVisible) : null,
      appShownMs: start.appShown !== null ? round(start.appShown) : null,
      firstFrameMs: start.frames.length ? round(start.frames[0]) : null,
      headingShownMs: start.headingShown !== null ? round(start.headingShown) : null,
      shelfShownMs: start.shelfShown !== null ? round(start.shelfShown) : null,
      stableMs: round(stableAt),
      movesAfterFirstFrame: afterFirst.length,
      elementsMoved: new Set(afterFirst.map((m) => m.what)).size,
      lateArrivals: start.late.length,
      layoutShiftScore: longTaskSupported() || shiftScore ? round(shiftScore * 1000) / 1000 : null,
      layoutShifts: start.shifts.length,
      fontLoads: start.fonts,
      // A fixed window (until three seconds after the shelf showed), so a calmer start is not charged for waiting longer.
      longTasksMs: longTaskSupported() ? round(longTasks.filter((l) => l.t <= (start.shelfShown ?? stableAt) + 3000).reduce((a, l) => a + l.d, 0)) : null,
      longestFrameMs: round(Math.max(0, ...gaps)),
      topMovers: [...movers.values()].sort((a, b) => b.times - a.times || b.maxPx - a.maxPx).slice(0, 12),
      lateExamples: start.late.slice(0, 12),
    };
  }

  function longTaskSupported() {
    return typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes || []).includes('longtask');
  }

  /* ================================================================ frames while something happens */

  async function recordFrames(run) {
    const times = [];
    let on = true;
    const loop = (t) => {
      times.push(t);
      if (on) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const lt0 = longTasks.length;
    const t0 = now();
    const result = await run();
    on = false;
    const t1 = now();
    return { result, times, longTasks: longTasks.slice(lt0).filter((l) => l.t >= t0 && l.t <= t1) };
  }

  function frameStats(times, tasks) {
    const d = [];
    for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
    const total = times.length > 1 ? times[times.length - 1] - times[0] : 0;
    const sorted = [...d].sort((a, b) => a - b);
    const q = (p) => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
    return {
      fps: total ? round((d.length * 1000) / total) : 0,
      medianFrameMs: q(0.5),
      p95FrameMs: q(0.95),
      worstFrameMs: round(sorted[sorted.length - 1] ?? 0),
      framesOver33ms: d.filter((x) => x > 33.4).length,
      framesOver50ms: d.filter((x) => x > 50).length,
      // Time lost: everything above one 60 Hz frame, added up.
      jankMs: round(d.reduce((a, x) => a + Math.max(0, x - 16.7), 0)),
      longTasks: tasks ? tasks.length : null,
      longTasksMs: tasks ? round(tasks.reduce((a, l) => a + l.d, 0)) : null,
      durationMs: round(total),
    };
  }

  function main() {
    return document.querySelector('.main');
  }

  async function waitFor(fn, maxMs = 20000, step = 50) {
    const t0 = now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (now() - t0 > maxMs) return null;
      await sleep(step);
    }
  }

  /** Scrolls .main down and back up at an even speed, like a hand on the wheel. */
  async function scrollMain(pxPerSecond, maxMs, countEmpty) {
    const m = main();
    m.scrollTop = 0;
    await frame();
    await frame();
    let empty = 0;
    let samples = 0;
    const wallStart = Date.now();
    const { times, longTasks: tasks } = await recordFrames(async () => {
      const max = m.scrollHeight - m.clientHeight;
      let pos = 0;
      let dir = 1;
      let last = await frame();
      const t0 = last;
      while (last - t0 < maxMs) {
        const t = await frame();
        pos += (dir * pxPerSecond * (t - last)) / 1000;
        if (pos >= max) {
          pos = max;
          dir = -1;
        } else if (pos <= 0 && dir < 0) break;
        m.scrollTop = pos;
        last = t;
        if (countEmpty && ++samples % 6 === 0) empty += emptyStickersInSight(m);
      }
    });
    // Wall clock of the scrolling, for the CPU time the WebKitGTK runner adds (webkit.py).
    return { ...frameStats(times, longTaskSupported() ? tasks : null), scrollHeight: m.scrollHeight, emptyStickersSeen: countEmpty ? empty : undefined, wall: [wallStart, Date.now()] };
  }

  /** Shelf stickers in sight that are not drawn yet (as src/app/measure.ts counts them). */
  function emptyStickersInSight(m) {
    const view = m.getBoundingClientRect();
    let n = 0;
    for (const s of m.querySelectorAll('.page-slot:not(.page-slot-hidden) .shelf .folder-sticker')) {
      const r = s.getBoundingClientRect();
      if (r.bottom < view.top || r.top > view.bottom) continue;
      // A sticker is in when the card says so (FolderSticker.tsx); a picture of the empty place does not count.
      if (s.parentElement && s.parentElement.hasAttribute('data-sticker-in')) continue;
      n++;
    }
    return n;
  }

  function go(hash) {
    if (location.hash === hash) return;
    location.hash = hash;
  }

  async function runShelf(opts) {
    go('#/');
    await waitFor(() => document.querySelector('.page-slot:not(.page-slot-hidden) .shelf .tile'));
    await sleep((opts && opts.settleMs) ?? 1500);
    const speed = (opts && opts.speed) || 1400;
    return scrollMain(speed, 12000, !(opts && opts.countEmpty === false));
  }

  function shownPage() {
    return document.querySelector('.main > .page-slot:not(.page-slot-hidden)');
  }

  function buttonsByText(root, texts) {
    const all = [...(root || document).querySelectorAll('button, a')];
    for (const t of texts) {
      const b = all.find((el) => (el.getAttribute('aria-label') || el.textContent || '').trim().startsWith(t) && !el.disabled);
      if (b) return b;
    }
    return null;
  }

  /** The play button of a track row: "Anhören" until 0.2.2, "„Titel“ anhören" since 0.3. */
  function playButton(row) {
    return buttonsByText(row, ['Anhören', 'Abspielen']) || [...row.querySelectorAll('button')].find((el) => /anhören$/.test((el.getAttribute('aria-label') || '').trim()) && !el.disabled) || null;
  }

  // The player that started last. Since 0.3.1 the app may swap a player whose
  // clock stands still for a fresh one, so all of them are kept for pausing.
  let media = null;
  const players = new Set();
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    media = this;
    players.add(this);
    return origPlay.apply(this, arguments);
  };
  function pauseAll() {
    for (const p of players) p.pause();
  }

  async function openLongFolder(folder) {
    const hash = `#/ordner/${String(folder).padStart(2, '0')}`;
    const t0 = now();
    go(hash);
    const rows = await waitFor(() => {
      const r = shownPage() && shownPage().querySelectorAll('.track-list .list-row');
      return r && r.length > 20 ? r : null;
    });
    await frame();
    const shownMs = now() - t0;
    return { rows: rows ? rows.length : 0, shownMs };
  }

  async function runFolder(opts) {
    const folder = (opts && opts.folder) || 14;
    const open = await openLongFolder(folder);
    await sleep(1200);
    // Something plays, as when one listens in while scrolling.
    const row = shownPage().querySelector('.track-list .list-row');
    const play = row && playButton(row);
    let playing = false;
    if (play && !(opts && opts.play === false)) {
      play.click();
      playing = !!(await waitFor(() => media && !media.paused && media.currentTime > 0, 8000));
    }
    await sleep(500);
    const scroll = await scrollMain((opts && opts.speed) || 1400, 12000, false);
    const swapped = players.size > 1;
    pauseAll();
    return { folder, rows: open.rows, openMs: round(open.shownMs), playingWhileScrolling: playing, playerSwapped: swapped, ...scroll };
  }

  /** Plays the long title and jumps in it: how quickly sound starts, how quickly a jump lands and shows. */
  async function runPlayer(opts) {
    const folder = (opts && opts.folder) || 14;
    await openLongFolder(folder);
    await sleep(800);
    const row = shownPage().querySelector('.track-list .list-row');
    const play = row && playButton(row);
    if (!play) return { error: 'kein Abspielknopf' };
    pauseAll();
    media = null;
    const t0 = now();
    play.click();
    const started = await waitFor(() => media && !media.paused && media.currentTime > 0, 10000, 5);
    const startMs = started ? now() - t0 : null;
    const seeks = [];
    const targets = [0.5, 0.2, 0.85, 0.35, 0.65];
    const { times } = await recordFrames(async () => {
      for (const f of targets) {
        const input = row.parentElement && shownPage().querySelector('.track-list .seekbar input[type=range]');
        if (!input || !media) break;
        const dur = Number(input.max) || media.duration;
        const to = dur * f;
        const knob = shownPage().querySelector('.track-list .seekbar-knob');
        const before = knob ? knob.style.left : '';
        const s0 = now();
        let seeked = null;
        const onSeeked = () => (seeked = now());
        media.addEventListener('seeked', onSeeked, { once: true });
        input.value = String(to);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // The bar shows the new place: the knob moved (next painted frame).
        const shownAt = await waitFor(() => (knob && knob.style.left !== before ? now() : null), 3000, 1);
        await frame();
        const painted = now();
        await waitFor(() => seeked, 3000, 2);
        const playingAgain = await waitFor(() => (!media.paused && Math.abs(media.currentTime - to) < 5 && seeked ? now() : null), 3000, 2);
        seeks.push({ target: round(to), barMs: shownAt ? round(painted - s0) : null, seekedMs: seeked ? round(seeked - s0) : null, playingMs: playingAgain ? round(playingAgain - s0) : null });
        await sleep(400);
      }
    });
    if (media) media.pause();
    const med = (k) => {
      const v = seeks.map((s) => s[k]).filter((x) => x !== null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    return { startMs: startMs !== null ? round(startMs) : null, seekBarMedianMs: med('barMs'), seekLandMedianMs: med('seekedMs'), seekPlayingMedianMs: med('playingMs'), seeks, frames: frameStats(times, null) };
  }

  /** Hinzufügen: the album from the import folder onto the card, as a new folder; time and megabytes per second. */
  async function runImport() {
    go('#/hinzufuegen');
    const page = await waitFor(() => (shownPage() && shownPage().querySelector('.dropzone') ? shownPage() : null));
    if (!page) return { error: 'Hinzufügen nicht gefunden' };
    await sleep(500);
    const w0 = stats.writeBytes;
    const pick = buttonsByText(page, ['Ordner auswählen']);
    if (!pick) return { error: 'kein Knopf „Ordner auswählen“' };
    const t0 = now();
    pick.click();
    // The app reads the files, then offers to put them on the card.
    const putLabels = ['Auf die Karte', 'Auf die SD-Karte', 'Alles auf die Karte', 'Auf die Karte kopieren', 'Kopieren'];
    const put = await waitFor(() => buttonsByText(shownPage(), putLabels), 120000, 50);
    const readMs = now() - t0;
    if (!put) return { error: 'kein Knopf zum Aufspielen', readMs: round(readMs), seen: [...shownPage().querySelectorAll('button')].map((b) => b.textContent.trim()).slice(0, 20) };
    const t1 = now();
    put.click();
    const done = await waitFor(() => (shownPage() && shownPage().querySelector('.done-icon') ? true : null), 300000, 50);
    const ok = done && !shownPage().querySelector('.done-icon.warn');
    const writeMs = now() - t1;
    const mb = (stats.writeBytes - w0) / 1e6;
    return { readMs: round(readMs), writeMs: round(writeMs), totalMs: round(now() - t0), writtenMB: round(mb), mbPerSecond: writeMs ? round(mb / (writeMs / 1000)) : null, finished: !!done, ok: !!ok, button: put.textContent.trim() };
  }

  /**
   * Opens the pages of the menu one after the other, as by a click on them:
   * from the change of the address until the new page's heading is drawn.
   */
  async function runPages(opts) {
    const hashes = (opts && opts.pages) || ['#/sticker', '#/karten', '#/hinzufuegen', '#/werkstatt', '#/hilfe', '#/einstellungen', '#/'];
    const heading = () => {
      const h = document.querySelector('.main > .page-slot:not(.page-slot-hidden) h1');
      const r = h && h.getBoundingClientRect();
      return r && r.width >= 1 && r.height >= 1 ? h : null;
    };
    const out = {};
    let total = 0;
    for (const hash of hashes) {
      const before = heading();
      const t0 = now();
      location.hash = hash;
      // Looked at in every frame; drawn is the frame after the heading is in place.
      let h = null;
      while (!h && now() - t0 < 15000) {
        await frame();
        const x = heading();
        if (x && x !== before) h = x;
      }
      const ms = h ? round(Math.max(0, (await frame()) - t0)) : null;
      out[hash.replace(/^#\/?/, '') || 'box'] = ms;
      if (ms !== null) total += ms;
      await sleep(300);
    }
    return { pages: out, totalMs: round(total) };
  }

  async function run(name, opts) {
    await ready;
    if (name === 'pages') return runPages(opts);
    if (name === 'start') return runStart(opts);
    if (name === 'shelf') return runShelf(opts);
    if (name === 'folder') return runFolder(opts);
    if (name === 'player') return runPlayer(opts);
    if (name === 'import') return runImport(opts);
    if (name === 'settle') return runSettle(opts);
    throw new Error(`unknown measurement ${name}`);
  }

  window.__bench = {
    setup,
    run,
    stats,
    hasCard: () => ready.then(() => !!cardRoot),
    // For WebKitGTK (webkit.py): runs and leaves the result where it can be fetched.
    runInto(name, opts) {
      window.__benchResult = null;
      run(name, opts).then(
        (r) => (window.__benchResult = JSON.stringify({ ok: r })),
        (e) => (window.__benchResult = JSON.stringify({ error: String((e && e.stack) || e) })),
      );
      return true;
    },
    setupInto() {
      window.__benchResult = null;
      setup().then(
        (r) => (window.__benchResult = JSON.stringify({ ok: r })),
        (e) => (window.__benchResult = JSON.stringify({ error: String((e && (e.stack || e.message || e.name)) || e) })),
      );
      return true;
    },
  };
})();
