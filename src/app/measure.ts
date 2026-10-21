/**
 * Measuring mode: how smooth the app runs on this computer.
 *
 * Started only on purpose: the desktop app with TONUINO_MESSEN=1 in its
 * environment (the backend says so through `measure_mode`), or the web app
 * with "?messen" in its address. It shows a made-up box with 52 folders
 * (in memory, the real card and the stored settings stay untouched), opens
 * every main page twice, scrolls the shelf and times each frame with
 * requestAnimationFrame. Then it opens the long folder (LONG_FOLDER, 120
 * titles, the first one ten minutes of silence), plays it, scrolls its title
 * list and jumps in the title. Last, when a real TonUINO card is plugged in,
 * the same once more on that card ("echteKarte": opened read only, see
 * scripts/bench/PC-MESSEN.md). The desktop app then writes the result as a
 * small JSON file and quits (`measure_done`); the web app leaves it in
 * `window.__messung` and in the console.
 */
import { memDir } from '../platform/memory';
import type { Platform, Volume, VolumeInfo, VolumeWatcher } from '../platform/types';
import { newCatalog, serializeCatalog, type Catalog } from '../core/tonuino/catalog';
import { saveCovers, type CoverMap } from '../core/tonuino/covers';
import { card } from './state';
import { holdMemories } from './remembered';
import { navigate, route, type Route } from './router';
import { lastNativeAudio, type MediaLike, type NativeAudio } from '../ui/nativeAudio';


const FOLDERS = 52;
/** The folder with a long title list, as in an audio book (the shelf counts it like any other). */
const LONG_FOLDER = 14;
const LONG_TRACKS = 120;
const LONG_SECONDS = 600;
const TITLES = ['Die Biene Maja', 'Der kleine Drache Kokosnuss', 'Pippi Langstrumpf', 'Das Sams', 'Räuber Hotzenplotz', 'Bibi Blocksberg', 'Die Olchis', 'Pettersson und Findus', 'Conni', 'Der Grüffelo', 'Benjamin Blümchen', 'Lieselotte'];
const ARTISTS = ['Kinderlieder', 'Hörspiel', 'Gute-Nacht-Geschichten', 'Musik zum Tanzen'];

/** A cover picture: a few coloured shapes on a coloured ground, like a real one. */
async function coverJpeg(i: number): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = c.height = 600;
  const g = c.getContext('2d')!;
  const hue = (i * 47) % 360;
  const grad = g.createLinearGradient(0, 0, 600, 600);
  grad.addColorStop(0, `hsl(${hue} 70% 60%)`);
  grad.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 35%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 600, 600);
  for (let k = 0; k < 14; k++) {
    g.fillStyle = `hsl(${(hue + k * 29) % 360} 80% ${40 + ((k * 13) % 40)}% / 0.8)`;
    g.beginPath();
    g.arc((k * 173 + i * 31) % 600, (k * 97 + i * 59) % 600, 30 + ((k * 23 + i) % 90), 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#fff';
  g.font = 'bold 90px sans-serif';
  g.fillText(String(i + 1), 40, 520);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.85));
  return new Uint8Array(await blob!.arrayBuffer());
}

/**
 * `seconds` of silence as MP3 (MPEG-1 Layer III, 32 kbit/s, 32 kHz, mono):
 * frames of 144 bytes whose side information is all zero, which every
 * decoder plays as silence. Enough to play, scroll along and jump in.
 */
export function silentMp3(seconds: number): Uint8Array {
  const FRAME = 144;
  const frames = Math.ceil((seconds * 32000) / 1152);
  const out = new Uint8Array(frames * FRAME);
  for (let i = 0; i < frames; i++) out.set([0xff, 0xfb, 0x18, 0xc0], i * FRAME);
  return out;
}

/** A box with FOLDERS folders, titles and covers, in memory. */
async function demoVolume(): Promise<Volume> {
  const tree: Record<string, Record<string, Uint8Array>> = {};
  const catalog: Catalog = newCatalog('Messbox', 'tng');
  const covers: CoverMap = new Map();
  const at = Date.now();
  for (let i = 0; i < FOLDERS; i++) {
    const name = String(i + 1).padStart(2, '0');
    const long = i + 1 === LONG_FOLDER;
    const tracks = long ? LONG_TRACKS : 3 + (i % 9);
    tree[name] = {};
    for (let t = 1; t <= tracks; t++) tree[name][`${String(t).padStart(3, '0')}.mp3`] = long && t === 1 ? silentMp3(LONG_SECONDS) : new Uint8Array(2000 + t);
    const cover = `${name}.jpg`;
    covers.set(cover, await coverJpeg(i));
    catalog.folders[name] = {
      title: `${TITLES[i % TITLES.length]} ${Math.floor(i / TITLES.length) + 1}`,
      artist: ARTISTS[i % ARTISTS.length],
      tracks: Array.from({ length: tracks }, (_, t) => ({ file: `${String(t + 1).padStart(3, '0')}.mp3`, title: `Kapitel ${t + 1}`, durationSec: long && t === 0 ? LONG_SECONDS : 180 + t * 7 })),
      cover,
      addedAt: at,
      updatedAt: at,
    };
  }
  // The system announcements, as on every working card.
  tree.mp3 = { '0001.mp3': new Uint8Array(1500), '0002.mp3': new Uint8Array(1500) };
  tree.advert = { '0001.mp3': new Uint8Array(1500) };
  const root = memDir(tree, 'MESSBOX');
  await root.write('tonuino-studio.json', new TextEncoder().encode(serializeCatalog(catalog)));
  await saveCovers(root, covers);
  const info: VolumeInfo = { fsType: 'vfat', clusterSize: 32768, totalBytes: 16e9, freeBytes: 12e9, removable: true };
  return { id: 'messbox', label: 'MESSBOX', root, info, canEject: false };
}

/** Switches the measured app from the made-up box to the real cards (set by measurePlatform). */
let toRealCards: (() => void) | null = null;

/**
 * The platform with the made-up box as its only card; everything else as it
 * is. For the last part the real cards come in instead (toRealCards). A card
 * is never ejected while measuring.
 */
export async function measurePlatform(p: Platform): Promise<Platform> {
  // The made-up box is neither offered for „Box merken“ nor remembered.
  holdMemories();
  const volume = await demoVolume();
  const real = p.volumes;
  const listeners = new Set<(v: Volume[]) => void>();
  let realOn = false;
  let realList: Volume[] = [];
  const volumes: VolumeWatcher = {
    subscribe(cb: (v: Volume[]) => void) {
      listeners.add(cb);
      cb(realOn ? realList : [volume]);
      return () => listeners.delete(cb);
    },
    pick: async () => (realOn ? real.pick() : volume),
    refresh: async () => (realOn ? real.refresh() : undefined),
    eject: async () => undefined,
    info: async (v: Volume) => (v === volume ? volume.info : real.info(v)),
  };
  toRealCards = () => {
    if (realOn) return;
    realOn = true;
    real.subscribe((list) => {
      realList = list;
      for (const cb of listeners) cb(list);
    });
  };
  const fake = Object.create(p) as Platform;
  Object.defineProperty(fake, 'volumes', { value: volumes });
  Object.defineProperty(fake, 'capabilities', { value: { ...p.capabilities, sd: true, sdPackage: false } });
  return fake;
}

/* ------------------------------------------------------------------ timing */

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const round = (n: number) => Math.round(n * 10) / 10;

/** The desktop app prints each step (`measure_step`), so a run that hangs shows where. */
let stepsOn = false;
function step(text: string) {
  if (!stepsOn) return;
  void import('@tauri-apps/api/core').then(({ invoke }) => invoke('measure_step', { text: `${Math.round(performance.now())} ${text}` })).catch(() => {});
}

/** The next frame; says so when the page draws nothing for 2 s. */
const frame = () =>
  new Promise<number>((res) => {
    const t0 = performance.now();
    const stuck = setTimeout(() => step('kein Bild seit 2 s'), 2000);
    requestAnimationFrame((t) => {
      clearTimeout(stuck);
      const waited = performance.now() - t0;
      if (waited > 2000) step(`Bild wieder da nach ${Math.round(waited)} ms`);
      res(t);
    });
  });

/** Frame times while `run` goes on. */
async function frames<T>(run: (times: number[]) => Promise<T>): Promise<{ result: T; times: number[] }> {
  const times: number[] = [];
  let on = true;
  const loop = (t: number) => {
    times.push(t);
    if (on) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const result = await run(times);
  on = false;
  return { result, times };
}

function frameStats(times: number[]) {
  const d: number[] = [];
  for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
  const total = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const sorted = [...d].sort((a, b) => a - b);
  return {
    bilderProSekunde: total ? round((d.length * 1000) / total) : 0,
    laengsterHaengerMs: round(sorted[sorted.length - 1] ?? 0),
    p95Ms: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    haengerUeber50ms: d.filter((x) => x > 50).length,
  };
}

/**
 * Everything that changes the picture: elements and attributes (the frame
 * pictures, stickers coming in), pictures that finish loading, and, where
 * the browser reports them, layout shifts.
 */
class ChangeWatch {
  last = 0;
  count = 0;
  shifts = 0;
  shiftScore = 0;
  private mo = new MutationObserver(() => this.note());
  private po: PerformanceObserver | null = null;
  private onLoad = () => this.note();
  constructor() {
    this.mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    document.addEventListener('load', this.onLoad, true);
    try {
      this.po = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
          if (e.hadRecentInput) continue;
          this.shifts++;
          this.shiftScore += e.value;
        }
      });
      this.po.observe({ type: 'layout-shift', buffered: false });
    } catch {
      this.po = null;
    }
  }
  note() {
    this.last = performance.now();
    this.count++;
  }
  reset() {
    this.mo.takeRecords();
    this.last = performance.now();
    this.count = this.shifts = this.shiftScore = 0;
  }
  stop() {
    this.mo.disconnect();
    this.po?.disconnect();
    document.removeEventListener('load', this.onLoad, true);
  }
}

/** Waits until nothing changed for `quietMs`, at most `maxMs`; returns when the last change was. */
async function settle(watch: ChangeWatch, since: number, quietMs = 1200, maxMs = 6000): Promise<number> {
  for (;;) {
    await sleep(100);
    const now = performance.now();
    if (now - watch.last >= quietMs || now - since >= maxMs) return Math.max(0, watch.last - since);
  }
}

const PAGES: { name: string; route: Route }[] = [
  { name: 'Meine Box', route: { page: 'box' } },
  { name: 'Hinzufügen', route: { page: 'add' } },
  { name: 'Sticker drucken', route: { page: 'stickers' } },
  { name: 'Karten beschreiben', route: { page: 'cards' } },
  { name: 'Werkstatt', route: { page: 'workshop' } },
  { name: 'Hilfe', route: { page: 'help' } },
  { name: 'Einstellungen', route: { page: 'settings' } },
];

function navLink(r: Route): HTMLElement | null {
  const hash = r.page === 'box' ? '#/' : r.page === 'add' ? '#/hinzufuegen' : r.page === 'stickers' ? '#/sticker' : r.page === 'cards' ? '#/karten' : r.page === 'workshop' ? '#/werkstatt' : r.page === 'help' ? '#/hilfe' : '#/einstellungen';
  return document.querySelector<HTMLElement>(`.sidebar a[href="${hash}"]`);
}

async function openPage(watch: ChangeWatch, page: (typeof PAGES)[number]) {
  watch.reset();
  const { result, times } = await frames(async () => {
    const t0 = performance.now();
    const link = navLink(page.route);
    if (link) link.click();
    else navigate(page.route);
    // The frame that first shows the page: the one after the route changed.
    let shown = 0;
    void (async () => {
      while (route.value.page !== page.route.page && performance.now() - t0 < 5000) await frame();
      await frame();
      shown = performance.now() - t0;
    })();
    const settled = await settle(watch, t0);
    return { t0, settled, shown, changes: watch.count, shifts: watch.shifts };
  });
  // Frames from the click until the page stood still.
  const until = result.t0 + result.settled + 50;
  const during = times.filter((t) => t >= result.t0 - 20 && t <= until);
  return {
    seite: page.name,
    sichtbarMs: round(result.shown),
    fertigMs: round(result.settled),
    aenderungenDanach: result.changes,
    layoutSpruenge: result.shifts,
    laengsterHaengerMs: frameStats(during).laengsterHaengerMs,
  };
}

/** Stickers in sight that are not drawn yet (empty place or blank canvas). */
function emptyStickersInSight(main: Element): number {
  const view = main.getBoundingClientRect();
  let n = 0;
  for (const s of main.querySelectorAll<HTMLElement>('.shelf .folder-sticker')) {
    const r = s.getBoundingClientRect();
    if (r.bottom < view.top || r.top > view.bottom) continue;
    if (s.parentElement?.hasAttribute('data-sticker-in')) continue;
    const img = s.querySelector('img');
    if (img && img.complete && img.naturalWidth) continue;
    const canvas = s.querySelector<HTMLCanvasElement>('canvas');
    if (canvas && canvas.width > 300) continue;
    n++;
  }
  return n;
}

/**
 * How often the window draws when the page has almost nothing to do: a small
 * square moves for 3 s. Next to the shelf numbers it shows whether the page
 * or the way to the screen sets the limit.
 */
async function idleFrames() {
  const dot = document.createElement('div');
  dot.style.cssText = 'position:fixed;left:0;bottom:0;width:4px;height:4px;background:#000;opacity:0.02;pointer-events:none;will-change:transform';
  document.body.append(dot);
  const { times } = await frames(async () => {
    const start = await frame();
    for (let now = start; now - start < 3000; now = await frame()) dot.style.transform = `translateX(${Math.round(now - start) % 200}px)`;
  });
  dot.remove();
  return frameStats(times);
}

/** Scrolls the page down and up again at an even speed, like a hand on the wheel. */
async function scrollShelf(watch: ChangeWatch, pxPerSecond = 1400) {
  const main = document.querySelector<HTMLElement>('.main')!;
  main.scrollTop = 0;
  await sleep(300);
  watch.reset();
  let empty = 0;
  let samples = 0;
  const { times } = await frames(async () => {
    const max = main.scrollHeight - main.clientHeight;
    let pos = 0;
    let dir = 1;
    let last = await frame();
    const start = last;
    while (last - start < 9000) {
      const now = await frame();
      pos += (dir * pxPerSecond * (now - last)) / 1000;
      if (pos >= max) {
        pos = max;
        dir = -1;
      } else if (pos <= 0 && dir < 0) break;
      main.scrollTop = pos;
      last = now;
      if (++samples % 6 === 0) empty += emptyStickersInSight(main);
    }
  });
  return { ...frameStats(times), leereStickerGesehen: empty, aenderungenImRegal: watch.count, layoutSpruenge: watch.shifts };
}

/* ------------------------------------------------------------------ long folder and player */

const shownPage = () => document.querySelector<HTMLElement>('.main > .page-slot:not(.page-slot-hidden)');
const trackRows = () => shownPage()?.querySelectorAll<HTMLElement>('.track-list .list-row') ?? [];

async function waitFor<T>(test: () => T | null | undefined | false, maxMs: number): Promise<T | null> {
  const t0 = performance.now();
  for (;;) {
    const v = test();
    if (v) return v;
    if (performance.now() - t0 > maxMs) return null;
    await frame();
  }
}

/** The audio element the app plays (the player makes its own; caught when it starts). */
let playing: HTMLMediaElement | null = null;
/** The desktop app's own player that started before the click (a newer one is the one measured). */
let nativeBefore: NativeAudio | null = null;
/** The player that plays now: the desktop app's own, or the browser's <audio>. Read through a call: TypeScript cannot see that a click set it. */
const player = (): MediaLike | null => {
  const native = lastNativeAudio();
  return native && native !== nativeBefore ? native : playing;
};
function catchPlayer() {
  const realPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    playing = this;
    return realPlay.call(this);
  };
}

function playButton(row: Element): HTMLButtonElement | null {
  for (const b of row.querySelectorAll<HTMLButtonElement>('button')) {
    const t = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    // "„Titel“ anhören" (FolderPage), or a plain "Anhören" / "Abspielen".
    if (/(^|\s)(anhören|abspielen)$/i.test(t) && !b.disabled) return b;
  }
  return null;
}

/**
 * The folder with the longest title list: open it (until its titles show),
 * play its first title, scroll its list while it plays, and jump in it.
 */
async function measureFolder(watch: ChangeWatch, folder: number) {
  const t0 = performance.now();
  navigate({ page: 'folder', folder });
  const rows = await waitFor(() => (trackRows().length >= Math.max(1, Math.min(20, catalogTracks(folder))) ? trackRows() : null), 10000);
  await frame();
  const openMs = round(performance.now() - t0);
  if (!rows?.length) return { ordner: folder, fehler: 'Titelliste nicht gesehen' };
  await settle(watch, t0, 800, 4000);
  // Play the first title, as when listening in while scrolling.
  const main = document.querySelector<HTMLElement>('.main')!;
  main.scrollTop = 0;
  await sleep(300);
  const button = playButton(rows[0]);
  step('Ordner offen, spiele ersten Titel');
  playing = null;
  nativeBefore = lastNativeAudio();
  const p0 = performance.now();
  button?.click();
  const sounding = await waitFor(() => {
    const m = player();
    return m && !m.paused && m.currentTime > 0;
  }, 10000);
  const startMs = sounding ? round(performance.now() - p0) : null;
  const native = lastNativeAudio() !== nativeBefore ? lastNativeAudio() : null;
  await sleep(500);
  step(sounding ? 'Ton läuft, scrolle Titelliste' : 'kein Ton, scrolle Titelliste');
  const list = await scrollShelf(watch);
  step('springe im Titel');
  // Jumps in the title: how soon the bar shows the place, how soon the sound is there.
  main.scrollTop = 0;
  await sleep(500);
  const jumps: { balkenMs: number | null; stelleMs: number | null }[] = [];
  for (const f of [0.5, 0.2, 0.85, 0.35, 0.65]) {
    const input = shownPage()?.querySelector<HTMLInputElement>('.track-list input[type=range]');
    const media = player();
    if (!input || !media) break;
    const to = (Number(input.max) || media.duration || 0) * f;
    step(`springe auf ${round(to)} s`);
    let seeked = 0;
    media.addEventListener('seeked', () => (seeked = performance.now()), { once: true });
    const s0 = performance.now();
    input.value = String(to);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await frame();
    const bar = round(performance.now() - s0);
    await waitFor(() => seeked, 3000);
    jumps.push({ balkenMs: bar, stelleMs: seeked ? round(seeked - s0) : null });
    await sleep(400);
  }
  player()?.pause();
  const med = (k: 'balkenMs' | 'stelleMs') => {
    const v = jumps.map((j) => j[k]).filter((x): x is number => x !== null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  return {
    ordner: folder,
    titel: rows.length,
    oeffnenMs: openMs,
    tonNachKlickMs: startMs,
    // What the player did: the desktop app's own (Rust) or the browser's <audio>.
    spieler: native
      ? {
          art: 'eigener Spieler (Rust)',
          quelle: native.stats.source ?? null,
          ladenMs: native.stats.loadMs ?? null,
          ersterTonImSpielerMs: native.stats.firstSoundMs ?? null,
          spieltMeldungMs: native.stats.playingMs ?? null,
          lueckenMs: native.stats.gapMs ?? 0,
          springenMs: native.stats.seekMs,
        }
      : { art: 'Browser (<audio>)' },
    titellisteScrollen: { ...list, spieltDabei: !!sounding },
    springenBalkenMs: med('balkenMs'),
    springenStelleMs: med('stelleMs'),
    spruenge: jumps,
  };
}

function catalogTracks(folder: number): number {
  return card.value?.catalog?.folders[String(folder).padStart(2, '0')]?.tracks.length ?? 0;
}

/** The folder with the most titles on the open card. */
function longestFolder(): number | null {
  const folders = card.value?.catalog?.folders ?? {};
  let best: number | null = null;
  for (const [k, f] of Object.entries(folders)) if (best === null || f.tracks.length > catalogTracks(best)) best = Number(k);
  return best;
}

/** Waits until a card is open and its shelf shows; how long that took. */
async function boxReady(maxMs: number): Promise<number | null> {
  const t0 = performance.now();
  while (card.value?.status !== 'ready' || !document.querySelector('.page-slot:not(.page-slot-hidden) .shelf .tile')) {
    if (performance.now() - t0 > maxMs) return null;
    await sleep(50);
  }
  return round(performance.now() - t0);
}

/**
 * The real card, when one is plugged in: the box, the shelf at once and
 * later, and its longest folder. Only reads; the card should be mounted
 * read only all the same (scripts/bench/PC-MESSEN.md).
 */
async function measureRealCard(watch: ChangeWatch) {
  if (!toRealCards) return { fehler: 'nicht möglich' };
  navigate({ page: 'box' });
  toRealCards();
  const t0 = performance.now();
  // The made-up box goes first; then the real card has to be found (it opens by itself) and read.
  const found = await waitFor(() => card.value && card.value.volume.id !== 'messbox', 10000);
  if (!found) return { fehler: 'keine TonUINO-Karte gefunden' };
  const ready = await boxReady(120000);
  if (ready === null) return { fehler: 'Karte nicht fertig gelesen' };
  const s = card.value!;
  const facts = { laufwerk: s.volume.label, ordner: Object.keys(s.catalog?.folders ?? {}).length, boxFertigMs: round(performance.now() - t0) };
  watch.reset();
  await sleep(800);
  const shelfAtOnce = await scrollShelf(watch);
  await sleep(3000);
  const shelfLater = await scrollShelf(watch);
  const long = longestFolder();
  const folder = long === null ? { fehler: 'kein Ordner' } : await measureFolder(watch, long);
  return { ...facts, regalSofort: shelfAtOnce, regalSpaeter: shelfLater, langerOrdner: folder };
}

/** Runs the whole measurement once the made-up box is open; returns the report. */
export async function runMeasurement(short = false): Promise<unknown> {
  catchPlayer();
  const t0 = performance.now();
  while (card.value?.status !== 'ready' || !document.querySelector('.shelf .tile')) {
    if (performance.now() - t0 > 30000) break;
    await sleep(50);
  }
  const boxReadyMs = round(performance.now() - t0);
  step('Box fertig');
  const watch = new ChangeWatch();
  // Right after the start: what someone sees who scrolls at once.
  await sleep(800);
  const shelfAtOnce = await scrollShelf(watch);
  step('Regal sofort gemessen');
  if (short) {
    // The short run (TONUINO_MESSEN=kurz, "?messen=kurz"): the shelf twice and the idle page, for comparing settings quickly.
    const idleShort = await idleFrames();
    step('Leerlauf gemessen');
    const shelfAgain = await scrollShelf(watch);
    step('Regal später gemessen');
    watch.stop();
    return { app: 'TonUINO Studio', kurz: true, zeit: new Date().toISOString(), fenster: `${innerWidth}x${innerHeight}`, bildschirmFaktor: devicePixelRatio, boxFertigMs: boxReadyMs, regalSofort: shelfAtOnce, leerlauf: idleShort, regalSpaeter: shelfAgain };
  }
  const firstRound = [];
  for (const p of [...PAGES.slice(1), PAGES[0]]) {
    step(`Seite ${p.name}`);
    firstRound.push(await openPage(watch, p));
  }
  const secondRound = [];
  for (const p of [...PAGES.slice(1), PAGES[0]]) {
    step(`Seite ${p.name}, zweites Mal`);
    secondRound.push(await openPage(watch, p));
  }
  await sleep(1500);
  const shelfLater = await scrollShelf(watch);
  step('Regal später gemessen');
  const idle = await idleFrames();
  step('Leerlauf gemessen');
  const longFolder = await measureFolder(watch, LONG_FOLDER);
  step('langer Ordner gemessen');
  const realCard = await measureRealCard(watch);
  step('echte Karte fertig');
  watch.stop();
  return {
    app: 'TonUINO Studio',
    zeit: new Date().toISOString(),
    browser: navigator.userAgent,
    fenster: `${innerWidth}x${innerHeight}`,
    bildschirmFaktor: devicePixelRatio,
    boxFertigMs: boxReadyMs,
    regalSofort: shelfAtOnce,
    regalSpaeter: shelfLater,
    leerlauf: idle,
    seitenErsterBesuch: firstRound,
    seitenZweiterBesuch: secondRound,
    langerOrdner: longFolder,
    echteKarte: realCard,
    route: route.value.page,
  };
}

async function shortRun(target: string): Promise<boolean> {
  if (__DESKTOP_BUILD__ && target) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('measure_short').catch(() => false);
  }
  return new URLSearchParams(location.search).get('messen') === 'kurz';
}

/**
 * Measures and hands the result on: the desktop app writes it to `target`
 * and quits (`measure_done`), the web app (target "") keeps it in
 * window.__messung and logs it.
 */
export async function measureAndReport(target: string): Promise<void> {
  stepsOn = __DESKTOP_BUILD__ && !!target;
  let report: unknown;
  try {
    report = await runMeasurement(await shortRun(target));
  } catch (e) {
    report = { fehler: String(e) };
  }
  const text = JSON.stringify(report, null, 1);
  (window as unknown as { __messung?: unknown }).__messung = report;
  console.log(`MESSUNG ${text}`);
  if (__DESKTOP_BUILD__ && target) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('measure_done', { report: text });
  }
}
