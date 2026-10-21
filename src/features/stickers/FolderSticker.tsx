import { computed } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { usePageShown } from '../../app/pageAlive';
import { orientGeometry, type Orientation, type StickerGeometry } from '../../core/stickers/layout';
import { card, catalog } from '../../app/state';
import { kv } from '../../platform/web/idb';
import { FRAME_PAD, frameShape, hash } from '../../ui/drawnFrames';
import { folderSticker, type StickerItem } from './content';
import { design, loadLogoImage, logoImage, template } from './design';
import { labelGeometry, renderKey, renderThumb, type RenderSetup } from './pipeline';
import { STICKER_LOOK } from './render';
import { watchNear } from '../../ui/nearScreen';
import { lastActivity } from '../../ui/quiet';
import { canvasEpoch, onCanvasesLost } from '../../ui/repaint';

/**
 * The sticker design and paper of "Sticker drucken", for stickers shown
 * elsewhere. Without the white margin: it is a help for the printer, and the
 * shelf shows the sticker as it is meant to look (nor is it drawn anew).
 */
const savedSetup = computed<RenderSetup>(() => ({ design: design.value, template: template.value, bleedMm: template.value.defaultBleedMm, logo: logoImage.value }));

/* ------------------------------------------------------------------ finished stickers */

/** A finished shelf sticker: the cut label (no bleed), as pixels. */
export interface Finished {
  image: CanvasImageSource & { width: number; height: number };
  orientation: Orientation;
}

/**
 * A card built for the shelf from the original cover (src/features/covers),
 * shown instead of the sticker once it is there. Until then the sticker
 * shows, in the card's orientation, so nothing moves when it comes in.
 */
export interface BuiltCardSource {
  /** Changes when the card would look different. */
  key: string;
  /** The card when it is ready in memory. */
  peek(): Finished | undefined;
  request(): BuiltCardRequest;
}

export interface BuiltCardRequest {
  /** Whether the card is kept on this computer (then `done` follows at once) or still has to be built. */
  kept: Promise<boolean>;
  /** The card, or null when none can be built (the sticker stays). */
  done: Promise<Finished | null>;
  /** Near the screen: built first. */
  near(near: boolean): void;
  /** Not shown any more. */
  release(): void;
}

/**
 * Finished stickers by id (shelfStickerId), kept in memory (bounded by pixels; the
 * longest unused go first) and on this computer (IndexedDB), so the shelf
 * shows them at once, also after the next start of the app. Painting a
 * sticker takes long enough to make scrolling stutter, above all in the
 * Linux app.
 */
const finished = new Map<string, Finished>();
const MEMORY_PIXELS = 24_000_000;
let memoryPixels = 0;

// Finished stickers in memory are canvases: after WebKitGTK's print dialog they may be white (TODO #84).
// The cards draw again from what is kept on this computer (see canvasEpoch in FolderSticker).
onCanvasesLost(() => {
  finished.clear();
  memoryPixels = 0;
});

function keep(id: string, f: Finished) {
  const old = finished.get(id);
  if (old) memoryPixels -= old.image.width * old.image.height;
  finished.delete(id);
  finished.set(id, f);
  memoryPixels += f.image.width * f.image.height;
  for (const [k, p] of finished) {
    if (memoryPixels <= MEMORY_PIXELS || k === id) break;
    finished.delete(k);
    memoryPixels -= p.image.width * p.image.height;
  }
}

function recall(id: string): Finished | undefined {
  const f = finished.get(id);
  if (f) {
    finished.delete(id);
    finished.set(id, f);
  }
  return f;
}

/* Kept on this computer: PNG bytes by id, and when each was last used. */
const STORE_PREFIX = 'shelf-sticker:';
const STORE_INDEX = 'shelf-sticker-index';
const STORE_MAX = 300;
let storeIndex: Promise<Record<string, number>> | null = null;
let indexDirty = 0;

function loadIndex(): Promise<Record<string, number>> {
  storeIndex ??= kv.get<Record<string, number>>(STORE_INDEX).then((i) => i ?? {});
  return storeIndex;
}

function touch(id: string) {
  void loadIndex().then((index) => {
    index[id] = Date.now();
    if (indexDirty) return;
    indexDirty = window.setTimeout(() => {
      indexDirty = 0;
      // The longest unused go when there are many: stickers of other cards and older designs.
      const ids = Object.keys(index).sort((a, b) => index[b] - index[a]);
      for (const old of ids.slice(STORE_MAX)) {
        delete index[old];
        void kv.delete(STORE_PREFIX + old).catch(() => undefined);
      }
      void kv.set(STORE_INDEX, index).catch(() => undefined);
    }, 2000);
  });
}

async function fromStore(id: string): Promise<Finished | null> {
  const stored = await kv.get<{ png: ArrayBuffer; orientation: Orientation }>(STORE_PREFIX + id);
  if (!stored?.png) return null;
  try {
    const image = await createImageBitmap(new Blob([stored.png], { type: 'image/png' }));
    touch(id);
    return { image, orientation: stored.orientation };
  } catch {
    return null;
  }
}

function toStore(id: string, canvas: HTMLCanvasElement, orientation: Orientation) {
  const save = () =>
    canvas.toBlob((blob) => {
      if (!blob) return;
      void blob.arrayBuffer().then((png) => kv.set(STORE_PREFIX + id, { png, orientation }).then(() => touch(id), () => undefined));
    }, 'image/png');
  if (typeof requestIdleCallback === 'function') requestIdleCallback(save, { timeout: 5000 });
  else setTimeout(save, 500);
}

/* ------------------------------------------------------------------ finished cards */

/**
 * The finished picture of a card (sticker and pen frame, as bake() draws it)
 * as PNG, by everything it is drawn from. Making the PNG takes long, and in
 * the Linux app the page waits meanwhile (WebKitGTK encodes on the main
 * thread): 47 cards at every start made the shelf stutter right after the
 * start. Kept in memory and on this computer, so a card drawn once before
 * only has its picture looked up.
 */
const baked = new Map<string, Blob>();
/**
 * Part of every key: 2 since built cards and stickers no longer share a picture (kept ones of 1 may show the wrong one);
 * 3 since a built card's key leaves out its picture's size (its key says it), so it is found before the card is loaded;
 * 4 since a sticker's key leaves it out too (its id says it), so it is found before the sticker is loaded.
 */
const BAKED_LOOK = 4;
const BAKED_IN_MEMORY = 160;
const BAKED_PREFIX = 'shelf-card:';
const BAKED_INDEX = 'shelf-card-index';
const BAKED_MAX = 300;
let bakedIndex: Promise<Record<string, number>> | null = null;
let bakedDirty = 0;

function rememberBaked(key: string, blob: Blob) {
  baked.delete(key);
  baked.set(key, blob);
  for (const k of baked.keys()) {
    if (baked.size <= BAKED_IN_MEMORY) break;
    baked.delete(k);
  }
}

function loadBakedIndex(): Promise<Record<string, number>> {
  bakedIndex ??= kv.get<Record<string, number>>(BAKED_INDEX).then((i) => i ?? {});
  return bakedIndex;
}

function touchBaked(key: string) {
  void loadBakedIndex().then((index) => {
    index[key] = Date.now();
    if (bakedDirty) return;
    bakedDirty = window.setTimeout(() => {
      bakedDirty = 0;
      // The longest unused go: cards of other boxes, sizes and designs of earlier days.
      const keys = Object.keys(index).sort((a, b) => index[b] - index[a]);
      for (const old of keys.slice(BAKED_MAX)) {
        delete index[old];
        void kv.delete(BAKED_PREFIX + old).catch(() => undefined);
      }
      void kv.set(BAKED_INDEX, index).catch(() => undefined);
    }, 2000);
  });
}

/** The PNG of a finished card, from memory or this computer; null when it was never made. */
async function findBaked(key: string): Promise<Blob | null> {
  const mem = baked.get(key);
  if (mem) {
    rememberBaked(key, mem);
    return mem;
  }
  // Not in the list of kept cards: not looked for (the first start asks for all of them).
  const index = await loadBakedIndex().catch(() => null);
  if (index && !(key in index)) return null;
  const stored = await kv.get<{ blob?: Blob; png?: ArrayBuffer }>(BAKED_PREFIX + key).catch(() => undefined);
  // Kept by 0.3 as a Blob, before as bytes.
  const blob = stored?.blob instanceof Blob ? stored.blob : stored?.png ? new Blob([stored.png], { type: 'image/png' }) : null;
  if (!blob) return null;
  rememberBaked(key, blob);
  touchBaked(key);
  return blob;
}

/**
 * Cards to keep on this computer: written together as soon as nobody
 * scrolls (copying pictures into the store takes the page a moment). Not
 * later: an app closed soon after the start made all its pictures again at
 * the next start, and the shelf stuttered meanwhile.
 */
const toSave: [string, Blob][] = [];
let saving = 0;
const SAVE_QUIET_MS = 400;
const SAVE_BATCH = 12;

function keepBaked(key: string, blob: Blob) {
  rememberBaked(key, blob);
  toSave.push([key, blob]);
  if (!saving) saving = window.setTimeout(saveNext, SAVE_QUIET_MS);
}

function saveNext() {
  saving = 0;
  const wait = lastActivity() + SAVE_QUIET_MS - performance.now();
  if (wait > 0) {
    saving = window.setTimeout(saveNext, wait);
    return;
  }
  const batch = toSave.splice(0, SAVE_BATCH);
  if (!batch.length) return;
  const save = () =>
    // As the Blob itself: bytes copied into a new Blob when read back took the shelf a moment for each card.
    void kv
      .setMany(batch.map(([key, blob]) => [BAKED_PREFIX + key, { blob }] as const))
      .then(
        () => batch.forEach(([key]) => touchBaked(key)),
        () => undefined,
      )
      .finally(() => {
        if (toSave.length && !saving) saving = window.setTimeout(saveNext, 50);
      });
  if (typeof requestIdleCallback === 'function') requestIdleCallback(save, { timeout: 1000 });
  else save();
}

/* ------------------------------------------------------------------ drawing in turn */

interface Job {
  id: string;
  item: StickerItem;
  setup: RenderSetup;
  k: number;
  near: boolean;
  started: boolean;
  wanted: number;
  done: Promise<Finished | null>;
  resolve: (f: Finished | null) => void;
}

const jobs = new Map<string, Job>();
/** Stickers drawn at the same time (renderThumb draws at most two at once anyway). */
const WORKERS = 2;
let working = 0;
const QUIET_MS = 300;


/** The next job: one near the screen first; others only while nobody scrolls. */
function nextJob(): { job: Job | null; wait: number } {
  let other: Job | null = null;
  for (const j of jobs.values()) {
    if (j.started || j.wanted <= 0) continue;
    if (j.near) return { job: j, wait: 0 };
    other ??= j;
  }
  if (!other) return { job: null, wait: 0 };
  const wait = lastActivity() + QUIET_MS - performance.now();
  return wait > 0 ? { job: null, wait } : { job: other, wait: 0 };
}

async function work() {
  if (working >= WORKERS) return;
  working++;
  try {
    for (;;) {
      const { job, wait } = nextJob();
      if (!job) {
        if (!wait) break;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      job.started = true;
      const item = job.item;
      const f = await draw(job);
      // Its picture got a new address while it was drawn (the covers were read again): once more with that.
      if (!f && job.item !== item) {
        job.started = false;
        continue;
      }
      jobs.delete(job.id);
      job.resolve(f);
      // Room for a frame between two stickers.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    working--;
  }
  // Jobs dropped while all were unwanted are gone; new ones start work() again.
}

async function draw(job: Job): Promise<Finished | null> {
  try {
    const c = await renderThumb(job.item, job.setup, job.k);
    const plain = labelGeometry(job.setup.template, job.setup.bleedMm);
    const { geometry: art, orientation } = shelfGeometry(plain, c.width >= c.height ? 'landscape' : 'portrait');
    const out = document.createElement('canvas');
    out.width = Math.round(art.widthMm * job.k);
    out.height = Math.round(art.heightMm * job.k);
    const b = job.setup.bleedMm * job.k;
    out.getContext('2d')?.drawImage(c as CanvasImageSource, b, b, out.width, out.height, 0, 0, out.width, out.height);
    // Nobody else holds this rendering: give its memory back now.
    c.width = 0;
    c.height = 0;
    const f: Finished = { image: out, orientation };
    keep(job.id, f);
    toStore(job.id, out, orientation);
    return f;
  } catch {
    return null;
  }
}

/** The finished sticker `id`, drawn in turn. `near` puts it first. */
function request(id: string, item: StickerItem, setup: RenderSetup, k: number): Job {
  let job = jobs.get(id);
  if (!job) {
    let resolve!: (f: Finished | null) => void;
    const done = new Promise<Finished | null>((r) => (resolve = r));
    // Looked up on this computer at once (quick); drawn in turn only when it is not there.
    const j: Job = { id, item, setup, k, near: false, started: true, wanted: 0, done, resolve };
    jobs.set(id, j);
    job = j;
    void fromStore(id)
      .catch(() => null)
      .then((stored) => {
        if (stored) {
          keep(id, stored);
          jobs.delete(id);
          resolve(stored);
          return;
        }
        j.started = false;
        void work();
      });
  }
  job.wanted++;
  return job;
}

/* ------------------------------------------------------------------ the card */

/**
 * Where the cover of a folder comes from, the same in every session (the
 * picture's address in the app changes each time the card is read).
 */
function coverId(folder: number): string {
  const s = card.value;
  const entry = catalog.value?.folders[String(folder).padStart(2, '0')]?.cover;
  const bytes = entry ? s?.covers.get(entry) : undefined;
  if (!entry || !bytes) return '';
  let h = bytes.length;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) h = Math.imul(h ^ bytes[i], 16777619);
  return `${entry}:${bytes.length}:${h >>> 0}`;
}

/**
 * The id of a finished shelf sticker: its render key with the cover as it is
 * stored instead of its address in this session (that changes each time the
 * covers are read, e.g. after saving one), and the version of the drawing,
 * so stickers kept from an older app are drawn again.
 */
export function shelfStickerId(key: string, item: StickerItem, cover: string): string {
  const own = key.replace(item.picture?.kind === 'url' ? JSON.stringify(item.picture.url) : '\u0000', JSON.stringify(cover));
  return String(hash(`${STICKER_LOOK}|${own}`));
}

/**
 * How the sticker stands on its card, from the orientation it is drawn in:
 * round and square labels are never turned, so they always stand as cut.
 */
export function shelfGeometry(plain: StickerGeometry, orientation: Orientation): { geometry: StickerGeometry; orientation: Orientation } {
  const geometry = orientGeometry(plain, orientation);
  return { geometry, orientation: geometry.widthMm >= geometry.heightMm ? 'landscape' : 'portrait' };
}

/** Rounded rectangle path (radius r, at most half the sides). */
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const q = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + q, y);
  g.arcTo(x + w, y, x + w, y + h, q);
  g.arcTo(x + w, y + h, x, y + h, q);
  g.arcTo(x, y + h, x, y, q);
  g.arcTo(x, y, x + w, y, q);
  g.closePath();
}

interface Look {
  /** Corner radius of the sticker in px per px of its width, or 'round'. */
  corner: number | 'round';
}

/**
 * Draws the card's pen frame and the sticker on it into one picture, which
 * the CSS shows instead of the frame layer and the sticker (.baked in
 * stil-holz.css): one picture per card scrolls by much more lightly than
 * a filled frame shape, a rounded clip and a picture, each turned with the
 * card. Runs in the ResizeObserver callback and when the sticker arrives,
 * so the card never shows half done. The paper and its shadow stay CSS.
 */
/** Where everything sits on the card: read before anything is drawn, so the browser lays the page out once. */
interface CardPlace {
  shape: string | null;
  dpr: number;
  cw: number;
  ch: number;
  x: number;
  y: number;
  sw: number;
  sh: number;
  slotRadius: number;
  frameColor: string;
}

function measureCard(cover: HTMLElement, slot: HTMLElement): CardPlace | null {
  const w = cover.offsetWidth;
  const h = cover.offsetHeight;
  if (!w || !h) return null;
  const cs = getComputedStyle(cover);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const P = FRAME_PAD;
  return {
    shape: frameShape(cover),
    dpr,
    cw: Math.round((w + 2 * P) * dpr),
    ch: Math.round((h + 2 * P) * dpr),
    x: P + (parseFloat(cs.borderLeftWidth) || 0) + slot.offsetLeft,
    y: P + (parseFloat(cs.borderTopWidth) || 0) + slot.offsetTop,
    sw: slot.offsetWidth,
    sh: slot.offsetHeight,
    slotRadius: parseFloat(getComputedStyle(slot).borderTopLeftRadius) || 0,
    frameColor: cs.getPropertyValue('--frame-color').trim() || '#2a1f16',
  };
}

/**
 * Everything the pixels depend on: equal keys draw equal pictures. The id of
 * the picture (a built card's `karte:…` key, a sticker's id) already says
 * how it looks and how big it is, so its finished picture is found without
 * loading the card or the sticker.
 */
function bakedKey(m: CardPlace, pictureId: string, look: Look): string {
  return String(hash([BAKED_LOOK, pictureId, m.cw, m.ch, m.dpr, m.x, m.y, m.sw, m.sh, m.slotRadius, look.corner, m.frameColor, m.shape ?? ''].join('|')));
}

/**
 * Draws the card's pen frame and the sticker on it into one picture, which
 * the CSS shows instead of the frame layer and the sticker (.baked in
 * stil-holz.css): one picture per card scrolls by much more lightly than
 * a filled frame shape, a rounded clip and a picture, each turned with the
 * card. Runs in the ResizeObserver callback and when the sticker arrives,
 * so the card never shows half done. The paper and its shadow stay CSS.
 */
function bake(cover: HTMLElement, slot: HTMLElement, canvas: HTMLCanvasElement, img: HTMLImageElement, sticker: Finished | null, pictureId: string, look: Look, resized = false, stopgap = false): CardPlace | null {
  const m = measureCard(cover, slot);
  if (!m) return null;
  const { shape, dpr, cw, ch, x, y, sw, sh, slotRadius, frameColor } = m;
  const P = FRAME_PAD;
  const w = cw / dpr - 2 * P;
  const h = ch / dpr - 2 * P;
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
  // A canvas drawn by the CPU: an accelerated one would be a layer of its own, heavy to scroll in WebKitGTK.
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w + 2 * P, h + 2 * P);

  // The sticker in its place on the card, cut to its corners.
  g.save();
  roundRect(g, x, y, sw, sh, slotRadius);
  g.clip();
  if (sticker) {
    const ih = (sw * sticker.image.height) / sticker.image.width;
    g.beginPath();
    if (look.corner === 'round') g.ellipse(x + sw / 2, y + ih / 2, sw / 2, ih / 2, 0, 0, Math.PI * 2);
    else roundRect(g, x, y, sw, ih, Math.max(slotRadius, look.corner * sw));
    g.clip();
    g.imageSmoothingQuality = 'high';
    g.drawImage(sticker.image, x, y, sw, ih);
  } else {
    // Its place, quietly, until it is drawn.
    g.fillStyle = 'rgb(42 31 22 / 0.07)';
    g.fillRect(x, y, sw, sh);
  }
  g.restore();

  if (shape) {
    g.fillStyle = frameColor;
    g.fill(new Path2D(shape));
  }
  cover.classList.toggle('baked', !!shape);
  // For the measuring mode (src/app/measure.ts): the sticker is in.
  cover.toggleAttribute('data-sticker-in', !!sticker);
  cover.classList.remove('pictured');
  // A sticker standing in for a card still being built gets no key: its picture would be made (and kept) for a moment only.
  const key = sticker && !stopgap ? bakedKey(m, pictureId, look) : null;
  asPicture(cover, canvas, img, resized, key);
  return m;
}

const turns = new WeakMap<HTMLImageElement, number>();
const waits = new WeakMap<HTMLImageElement, number>();
/** After a change of size the picture waits this long for the next one (a window being dragged); the canvas shows meanwhile. */
const RESIZE_QUIET_MS = 150;

function showPicture(cover: HTMLElement, img: HTMLImageElement, turn: number, blob: Blob) {
  if (turns.get(img) !== turn) return;
  const url = URL.createObjectURL(blob);
  const old = img.src;
  img.src = url;
  // The picture no longer shows the old pixels (the canvas does until the new ones are decoded).
  if (old.startsWith('blob:')) URL.revokeObjectURL(old);
  img.decode().then(
    () => {
      if (turns.get(img) === turn) cover.classList.add('pictured');
    },
    () => undefined,
  );
}

/**
 * The finished picture of a built card drawn before, shown without loading
 * the card: on later starts the shelf only looks pictures up. `missing`
 * when there is none (another size, never drawn here).
 */
function findPicture(cover: HTMLElement, img: HTMLImageElement, key: string, missing: () => void) {
  const turn = turns.get(img) ?? 0;
  void findBaked(key).then((blob) => {
    if (turns.get(img) !== turn) return;
    if (!blob) return missing();
    cover.setAttribute('data-card-in', '');
    cover.setAttribute('data-sticker-in', '');
    showPicture(cover, img, turn, blob);
  });
}

/**
 * The same pixels as a picture, shown instead of the canvas once it is
 * decoded, so no frame shows it half: browsers give each canvas a layer of
 * its own, and many turned layers scroll heavily (Chromium: 35 instead of
 * 60 frames a second on the shelf); a picture is painted with the page.
 */
function asPicture(cover: HTMLElement, canvas: HTMLCanvasElement, img: HTMLImageElement, later: boolean, key: string | null) {
  const turn = (turns.get(img) ?? 0) + 1;
  turns.set(img, turn);
  clearTimeout(waits.get(img));
  waits.delete(img);
  const show = (blob: Blob) => showPicture(cover, img, turn, blob);
  const encode = () => {
    waits.delete(img);
    if (turns.get(img) !== turn) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      if (key) keepBaked(key, blob);
      show(blob);
    }, 'image/png');
  };
  const run = () => {
    // The calm place of a sticker still to come: the canvas shows it; a picture of it would be made for a moment only.
    if (!key) return;
    // Drawn before (this session or an earlier one): its picture is looked up, not made again.
    void findBaked(key).then((blob) => {
      if (turns.get(img) !== turn) return;
      if (blob) show(blob);
      else if (later) waits.set(img, window.setTimeout(encode, RESIZE_QUIET_MS));
      else encode();
    });
  };
  run();
}

/** Cards that draw themselves again when light and dark mode change. */
const onTheme = new Set<() => void>();
let themeWatch: MutationObserver | null = null;

function watchTheme(redraw: () => void): () => void {
  onTheme.add(redraw);
  if (!themeWatch && typeof MutationObserver !== 'undefined') {
    themeWatch = new MutationObserver(() => requestAnimationFrame(() => onTheme.forEach((f) => f())));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-stil'] });
  }
  return () => onTheme.delete(redraw);
}

/**
 * The sticker of a folder exactly as "Sticker drucken" prints it, with the
 * design and paper chosen there, on its card (`.tile-cover`, the parent).
 * As wide as its box. Stickers near the screen are drawn first, the others
 * right after while nobody scrolls; finished ones are kept (also on this
 * computer), so they are there at once next time. Until then the place
 * shows empty and calm, at its final size: nothing moves when it comes in.
 */
export function FolderSticker({ folder, title, size = 260, orientation: standing, card: built }: { folder: number; title: string; size?: number; orientation?: Orientation; card?: BuiltCardSource }) {
  const slot = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  // "auto" turns a sticker like its picture: known once it is drawn.
  const [, setTurned] = useState(0);
  useEffect(() => {
    void loadLogoImage();
  }, []);
  // Whether the page with this card shows (pages stay mounted, App.tsx), and what to do when it shows again.
  const shown = usePageShown();
  const visible = useRef(shown);
  visible.current = shown;
  const onShown = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (shown) onShown.current?.();
  }, [shown]);
  const setup = savedSetup.value;
  const own = folderSticker(folder, title);
  // Standing as the shelf's cards do: the sticker is drawn turned that way too.
  const item = standing ? { ...own, orientation: standing } : own;
  const plain = labelGeometry(setup.template, setup.bleedMm);
  const longMm = Math.max(plain.widthMm, plain.heightMm);
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const k = Math.max(1, Math.round(((size * dpr) / longMm) * 4) / 4);
  const key = renderKey(item, setup, k);
  const id = shelfStickerId(key, item, coverId(folder));
  const kept = built?.peek() ?? recall(id);
  // The canvases may have lost their pixels (print dialog): the card is set up again, from its kept picture.
  const epoch = canvasEpoch.value;
  const { geometry: g, orientation } = shelfGeometry(plain, standing ?? kept?.orientation ?? item.orientation ?? (setup.design.orientation === 'portrait' ? 'portrait' : 'landscape'));
  // The address of a cover changes when the covers are read again (the id does not): a sticker still waiting draws with the new one.
  useEffect(() => {
    const waiting = jobs.get(id);
    if (waiting) {
      waiting.item = item;
      waiting.setup = setup;
    }
  });

  useEffect(() => {
    const s = slot.current;
    const c = canvas.current;
    const img = picture.current;
    const cover = s?.parentElement;
    if (!s || !c || !img || !cover) return undefined;
    const ready = built?.peek();
    let sticker: Finished | null = ready ?? recall(id) ?? null;
    // The built card is in: the sticker no longer replaces it.
    let cardIn = !!ready;
    // The card could not be built: the sticker stays, as on the shelf without cards.
    let cardFailed = false;
    // A built card not in memory: its finished picture is looked for first (redraw), the card loaded only without one.
    let lookup = !!built && !cardIn;
    // The same for a sticker not in memory: drawn on its card before (an earlier start), it is only looked up.
    let lookupSticker = !built && !sticker;
    let alive = true;
    // The corners as the sticker stands: turned, a long side is the width.
    const lookOf = (o: Orientation): Look => {
      const turned = orientGeometry(plain, o);
      return { corner: turned.shape === 'round' ? 'round' : setup.template.label.cornerRadiusMm / turned.widthMm };
    };
    let drawn = false;
    let stale = false;
    /**
     * Draws the card. A kept page out of sight only notes that its cards
     * changed (their size changes with another page's scroll bar there, the
     * theme with the settings) and draws them when it shows again: drawing
     * all of them behind another page made that page stutter while it was
     * scrolled. A sticker that arrives (`force`) is drawn at once.
     */
    const redraw = (resized = false, force = false) => {
      if (!alive) return;
      if (drawn && !force && !visible.current) {
        stale = true;
        return;
      }
      stale = false;
      // What is drawn: the built card or the sticker. Of the same size, they must not share a finished picture.
      const what = cardIn && built ? `karte:${built.key}` : id;
      if (lookup && built) {
        // Its calm place, then the finished picture of the card when there is one; else the card is loaded.
        const look = lookOf(orientation);
        const m = bake(cover, s, c, img, null, `karte:${built.key}`, look, resized, true);
        if (m) {
          drawn = true;
          findPicture(cover, img, bakedKey(m, `karte:${built.key}`, look), ask);
        }
        return;
      }
      if (lookupSticker && !sticker) {
        const look = lookOf(orientation);
        const m = bake(cover, s, c, img, null, id, look, resized, true);
        if (m) {
          drawn = true;
          findPicture(cover, img, bakedKey(m, id, look), stickerMissing);
        }
        return;
      }
      if (bake(cover, s, c, img, sticker, what, lookOf(sticker?.orientation ?? orientation), resized, !!built && !cardIn && !cardFailed)) drawn = true;
    };
    // A sticker of a page built ahead, hidden: drawn when the page shows (drawn behind the shelf, it made the shelf stutter).
    let drawLater: (() => void) | null = null;
    onShown.current = () => {
      if (stale) redraw(true);
      const draw = drawLater;
      drawLater = null;
      draw?.();
    };
    // The first call comes after layout, before the card is painted; later ones when the card changes size.
    let sized = false;
    const ro = new ResizeObserver(() => {
      redraw(sized);
      sized = true;
    });
    ro.observe(cover);
    const stopTheme = watchTheme(() => redraw());
    let job: Job | null = null;
    let near = false;
    const drawSticker = () => {
      if (!alive || job || sticker) return;
      job = request(id, item, setup, k);
      const j = job;
      j.near = near;
      if (near) void work();
      void j.done.then((f) => {
        if (!f || !alive || cardIn) return;
        sticker = f;
        // Drawn: whether it is near the screen no longer matters (one observer less to ask on every scroll).
        stopNear?.();
        // Turned: the card takes the sticker's shape on the next render, and is drawn again at once in it.
        if (f.orientation !== orientation) {
          sized = false;
          setTurned((n) => n + 1);
        }
        redraw(false, true);
      });
    };
    const drawWhenShown = () => {
      if (visible.current) drawSticker();
      else
        drawLater = () => {
          drawSticker();
          startNear();
        };
    };
    let wanted: BuiltCardRequest | null = null;
    // The card itself is loaded (or built) only when no finished picture of it is kept.
    const ask = () => {
      if (!lookup || !built || !alive) return;
      lookup = false;
      const r = built.request();
      wanted = r;
      startNear();
      // The sticker only while the card still has to be built.
      void r.kept.then((stored) => {
        if (!stored) drawWhenShown();
      });
      void r.done.then((f) => {
        if (!alive) return;
        if (!f) {
          cardFailed = true;
          cover.removeAttribute('data-card-in');
          if (sticker) redraw(false, true);
          return;
        }
        cardIn = true;
        sticker = f;
        cover.setAttribute('data-card-in', '');
        redraw();
      });
    };
    // No finished picture of the sticker on its card: the sticker is loaded or drawn.
    const stickerMissing = () => {
      if (!alive || !lookupSticker) return;
      lookupSticker = false;
      drawWhenShown();
      if (job) startNear();
    };
    if (cardIn) cover.setAttribute('data-card-in', '');
    let stopNear: (() => void) | null = null;
    const startNear = () => {
      if (stopNear) return;
      stopNear = watchNear(cover, (n) => {
        near = n;
        wanted?.near(n);
        if (job) {
          job.near = n;
          if (n) void work();
        }
      });
    };
    if (job) startNear();
    return () => {
      alive = false;
      onShown.current = null;
      ro.disconnect();
      stopTheme();
      stopNear?.();
      wanted?.release();
      if (job) job.wanted--;
      cover.classList.remove('baked', 'pictured');
      turns.set(img, (turns.get(img) ?? 0) + 1);
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      cover.removeAttribute('data-sticker-in');
      cover.removeAttribute('data-card-in');
    };
  }, [id, built?.key, epoch]);

  return (
    <>
      <span ref={slot} class="folder-sticker" role="img" aria-label={`Sticker für Ordner ${item.number}`} style={{ aspectRatio: `${g.widthMm} / ${g.heightMm}` }} />
      <canvas ref={canvas} class="shelf-card" aria-hidden="true" />
      <img ref={picture} class="shelf-card" alt="" aria-hidden="true" draggable={false} />
    </>
  );
}
