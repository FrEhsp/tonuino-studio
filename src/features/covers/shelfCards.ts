/**
 * The cards on the shelf of "Meine Box", built from the original covers
 * with their recipes (src/core/covers): hochkant by default, quer to choose.
 *
 * Built ahead: right after the SD card is read or something was added, one
 * card after the other while the computer is idle and nobody scrolls, cards
 * near the screen first. Finished cards are kept in memory and on this
 * computer (IndexedDB), so the shelf shows them at once next time. A folder
 * without a cover that the app recognises gets its original cover from the
 * cover search (iTunes, MusicBrainz) when the hit is sure; it is kept on this
 * computer only and goes on the SD card when someone takes it on the folder
 * page.
 */
import { effect, signal, untracked } from '@preact/signals';
import { card, catalog, plat, settings } from '../../app/state';
import { analyseImage } from '../../core/covers/build';
import { paintCard, type FaceFor } from '../../core/covers/paint';
import { planCard, type CardGeometry, type CardPlan, type CardText } from '../../core/covers/plan';
import { resolveLayout, type CardFormat, type FontChoice, type Recipe } from '../../core/covers/recipe';
import { coverWanted, SHIPPED_RECIPES, shelfCardText, shelfChoice, shippedRecipeById, type ShelfChoice } from '../../core/covers/shelf';
import { isConfident, isUnreachable, searchSpacing } from '../../core/stickers/bulkcover';
import { downloadCoverImage, searchCovers } from '../../core/stickers/coversearch';
import { canvasToBlob, imageSize, loadImageBitmap, type CanvasLike } from '../../core/stickers/image';
import { orientGeometry, type Orientation } from '../../core/stickers/layout';
import { workColors, type WorkColors } from '../../core/stickers/works';
import { buildShelf, type CatalogFolder } from '../../core/tonuino/catalog';
import { folderName } from '../../core/tonuino/sd';
import { kv } from '../../platform/web/idb';
import { hash } from '../../ui/drawnFrames';
import { coverFetch } from '../box/CoverSearch';
import { folderSticker } from '../stickers/content';
import { design, template } from '../stickers/design';
import type { BuiltCardRequest, BuiltCardSource, Finished } from '../stickers/FolderSticker';
import { loadStickerFont, stickerFont } from '../stickers/fonts';
import { labelGeometry } from '../stickers/pipeline';
import { lastActivity } from '../../ui/quiet';
import { onCanvasesLost } from '../../ui/repaint';

/** Changes when cards are built differently, so cards kept from an older app are built again. */
const CARD_LOOK = 2;
/** Was the version of the cover recipes (dropped in 0.5); stays in the key so cards kept from 0.4 are not built again. */
const RECIPE_VERSION = 1;

/* ------------------------------------------------------------------ format and look */

export type ShelfFormat = CardFormat;

/**
 * The card built from the whole original cover next to a panel in its
 * colour ("karte", quer or hochkant) no longer shows on the shelf (#80,
 * regal audit 20.10.2026): Frank took "Cover" for the square cover, which
 * the shelf's "Cover" view (src/features/box/shelfView.ts) now shows. The
 * shelf shows every folder's sticker as "Sticker drucken" sets it up
 * ("druck"). The building stays for the cards' place in "Sticker drucken";
 * a choice saved by an older app is not read any more.
 */
export type ShelfLook = 'druck' | 'karte';
export const shelfFormat = signal<ShelfFormat>('quer');
export const shelfLook = signal<ShelfLook>('druck');

/* ------------------------------------------------------------------ found covers */

export interface FoundCover {
  /** Same picture, same id (also once it is on the card). */
  id: string;
  blob: Blob;
  /** "iTunes" or "MusicBrainz", for the credit line. */
  source: string;
  title: string;
  artist: string;
  query: string;
}

/** Covers found for folders without one, by folder name ("05"); on this computer only. */
export const foundCovers = signal<ReadonlyMap<string, FoundCover>>(new Map());

/** The id of a picture from its bytes: the same for a found cover and the one taken onto the card. */
function pictureId(bytes: Uint8Array): string {
  let h = bytes.length;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) h = Math.imul(h ^ bytes[i], 16777619);
  return `${bytes.length}:${h >>> 0}`;
}

const cardPictureIds = new WeakMap<Uint8Array, string>();

function cardPictureId(bytes: Uint8Array): string {
  let id = cardPictureIds.get(bytes);
  if (!id) {
    id = pictureId(bytes);
    cardPictureIds.set(bytes, id);
  }
  return id;
}

/* ------------------------------------------------------------------ what a folder shows */

/** Everything a card depends on. */
interface Spec {
  key: string;
  folder: number;
  recipe: Recipe | null;
  episode?: number;
  format: CardFormat;
  orientation: Orientation;
  geometry: CardGeometry;
  text: CardText;
  font: FontChoice;
  /** The panel's colour: chosen for the folder, or its work's (works.ts); missing: from the cover. */
  color?: string;
  k: number;
  cover: () => Blob;
}

export interface ShelfSource {
  /** How the folder's card stands; undefined: as the sticker is printed. */
  orientation?: Orientation;
  card?: BuiltCardSource;
  choice: ShelfChoice | null;
  /** The cover the card is built from was found by the app (not on the card yet). */
  found?: FoundCover;
  /** The well-known work the folder was recognised as, whose colour the panel takes. */
  work?: WorkColors;
}

/** The shelf card's pixels per mm, the same as the sticker's (FolderSticker). */
function shelfPxPerMm(longMm: number, size = 260): number {
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  return Math.max(1, Math.round(((size * dpr) / longMm) * 4) / 4);
}

export function choiceFor(entry: CatalogFolder | undefined): ShelfChoice {
  return shelfChoice(entry, SHIPPED_RECIPES, shippedRecipeById);
}

/** Cards asked for, by key: what they are built from, and their source for FolderSticker. */
const known = new Map<string, { spec: Spec; src: BuiltCardSource }>();

/**
 * What the shelf shows for a folder (reads the card, the catalog, the
 * format and the found covers, so a component using it follows them).
 */
export function shelfSource(folder: number, title: string): ShelfSource {
  const t = template.value;
  const entry = catalog.value?.folders[folderName(folder)];
  const choice = choiceFor(entry);
  if (shelfLook.value === 'druck' || choice.kind === 'sticker' || t.label.shape === 'round') return { choice };
  const format = shelfFormat.value;
  const orientation: Orientation = format === 'hoch' ? 'portrait' : 'landscape';
  const s = card.value;
  const bytes = entry?.cover ? s?.covers.get(entry.cover) : undefined;
  const found = bytes ? undefined : foundCovers.value.get(folderName(folder));
  if (!bytes && !found) return { orientation, choice };
  const coverId = bytes ? cardPictureId(bytes) : found!.id;
  const type = entry?.cover?.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const plain = labelGeometry(t, 0);
  const g = orientGeometry(plain, orientation);
  const geometry: CardGeometry = { widthMm: g.widthMm, heightMm: g.heightMm, cutMm: Math.max(1, plain.safeMm) };
  const k = shelfPxPerMm(Math.max(plain.widthMm, plain.heightMm));
  const item = folderSticker(folder, title);
  const episode = choice.episode ?? entry?.episode;
  const text = shelfCardText(item, episode);
  const font = resolveLayout(choice.recipe, format, episode).schrift ?? design.value.font;
  // The panel in the folder's chosen colour, else in its work's; the cover stays whole either way.
  const work = workColors(entry);
  const color = entry?.color && /^#[0-9a-f]{6}$/i.test(entry.color) ? entry.color.toLowerCase() : work?.band;
  const what = JSON.stringify([CARD_LOOK, RECIPE_VERSION, choice.recipe?.id ?? '', episode ?? 0, format, geometry, k, coverId, text, font, color ?? '']);
  const key = `${hash(what).toString(36)}${hash([...what].reverse().join('')).toString(36)}`;
  let src = known.get(key)?.src;
  if (!src) {
    const spec: Spec = {
      key,
      folder,
      recipe: choice.recipe,
      episode,
      format,
      orientation,
      geometry,
      text,
      font,
      color,
      k,
      cover: bytes ? () => new Blob([bytes as Uint8Array<ArrayBuffer>], { type }) : () => found!.blob,
    };
    src = sourceOf(spec);
    known.set(key, { spec, src });
    // Cards nobody shows any more (another format, an old title) go.
    if (known.size > 400) for (const old of [...known.keys()].slice(0, 100)) known.delete(old);
  }
  return { orientation, card: src, choice, found, work };
}

function sourceOf(spec: Spec): BuiltCardSource {
  return {
    key: spec.key,
    peek: () => recall(spec.key),
    request: (): BuiltCardRequest => {
      const ready = recall(spec.key);
      if (ready) return { kept: Promise.resolve(true), done: Promise.resolve(ready), near: () => undefined, release: () => undefined };
      const t = ensure(spec);
      t.wanted++;
      let gone = false;
      return {
        kept: t.kept,
        done: t.done,
        near: (n) => {
          t.near = n;
          if (n) void pump();
        },
        release: () => {
          if (gone) return;
          gone = true;
          t.wanted--;
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ what a card turned out as */

export interface CardInfo {
  form: CardPlan['form'];
  /** The recipe's own layout did not pass the check: the safe form instead. */
  simplified: string[];
  /** Notes of the check that did not change anything. */
  notes: string[];
}

/** By card key: for the folder page. */
export const cardInfos = signal<ReadonlyMap<string, CardInfo>>(new Map());

function noteInfo(key: string, info: CardInfo) {
  const m = new Map(cardInfos.value);
  m.set(key, info);
  cardInfos.value = m;
}

function infoOf(plan: CardPlan): CardInfo {
  return {
    form: plan.form,
    simplified: (plan.simplified ?? []).filter((p) => p.blocking).map((p) => p.text),
    notes: plan.problems.filter((p) => !p.blocking).map((p) => p.text),
  };
}

/* ------------------------------------------------------------------ kept cards */

interface Built extends Finished {
  info: CardInfo;
}

const memory = new Map<string, Built>();
const MEMORY_PIXELS = 16_000_000;
let memoryPixels = 0;

// Cards in memory are canvases: after WebKitGTK's print dialog they may be white. Kept ones come back from this computer.
onCanvasesLost(() => {
  memory.clear();
  memoryPixels = 0;
});

function keep(key: string, b: Built) {
  const old = memory.get(key);
  if (old) memoryPixels -= old.image.width * old.image.height;
  memory.delete(key);
  memory.set(key, b);
  memoryPixels += b.image.width * b.image.height;
  for (const [k, p] of memory) {
    if (memoryPixels <= MEMORY_PIXELS || k === key) break;
    memory.delete(k);
    memoryPixels -= p.image.width * p.image.height;
  }
}

function recall(key: string): Built | undefined {
  const b = memory.get(key);
  if (b) {
    memory.delete(key);
    memory.set(key, b);
  }
  return b;
}

/** A store on this computer with an index of when each entry was last used; the longest unused go. */
function store<T>(prefix: string, max: number) {
  const indexKey = `${prefix}index`;
  let index: Promise<Record<string, number>> | null = null;
  let dirty = 0;
  const load = () => (index ??= kv.get<Record<string, number>>(indexKey).then((i) => i ?? {}));
  const touch = (id: string) =>
    void load().then((i) => {
      i[id] = Date.now();
      if (dirty) return;
      dirty = window.setTimeout(() => {
        dirty = 0;
        const ids = Object.keys(i).sort((a, b) => i[b] - i[a]);
        for (const old of ids.slice(max)) {
          delete i[old];
          void kv.delete(prefix + old).catch(() => undefined);
        }
        void kv.set(indexKey, i).catch(() => undefined);
      }, 2000);
    });
  return {
    /** Kept, by the index (nothing read). */
    async has(id: string): Promise<boolean> {
      return id in (await load().catch(() => ({}) as Record<string, number>));
    },
    async get(id: string): Promise<T | undefined> {
      const v = await kv.get<T>(prefix + id);
      if (v !== undefined) touch(id);
      return v;
    },
    async set(id: string, v: T): Promise<void> {
      await kv.set(prefix + id, v);
      touch(id);
    },
  };
}

// Not 'shelf-card:': that is the finished pictures' store in FolderSticker.tsx.
const cardStore = store<{ png: ArrayBuffer; orientation: Orientation; info: CardInfo }>('shelf-built:', 300);
const foundStore = store<{ bytes?: ArrayBuffer; type?: string; source?: string; title?: string; artist?: string; at: number }>('shelf-found:', 200);

async function fromStore(key: string): Promise<Built | null> {
  const v = await cardStore.get(key).catch(() => undefined);
  if (!v?.png) return null;
  try {
    const image = await createImageBitmap(new Blob([v.png], { type: 'image/png' }));
    return { image, orientation: v.orientation, info: v.info };
  } catch {
    return null;
  }
}

function toStore(key: string, canvas: CanvasLike, b: Built) {
  void whenIdle().then(async () => {
    try {
      const png = await (await canvasToBlob(canvas, 'image/png')).arrayBuffer();
      await cardStore.set(key, { png, orientation: b.orientation, info: b.info });
    } catch {
      // Built again next time.
    }
  });
}

/* ------------------------------------------------------------------ building in turn */

interface Task {
  spec: Spec;
  near: boolean;
  wanted: number;
  /** Built ahead, also when no shelf shows it. */
  ahead: boolean;
  state: 'looking' | 'waiting' | 'building';
  kept: Promise<boolean>;
  done: Promise<Built | null>;
  resolve: (b: Built | null) => void;
}

const tasks = new Map<string, Task>();

/** Nothing is built before this time: the shelf comes first. */
let notBefore = 0;
const START_DELAY_MS = 1500;
const QUIET_MS = 400;


/** Resolves when the computer is idle, nobody scrolls and the start is over. */
function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const go = () => {
      const now = performance.now();
      const wait = Math.max(lastActivity() + QUIET_MS - now, notBefore - now);
      if (wait > 0) {
        setTimeout(go, wait);
        return;
      }
      // WebKit (the Linux and Mac apps) has no requestIdleCallback.
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 2000 });
      else setTimeout(resolve, 40);
    };
    go();
  });
}

function ensure(spec: Spec, ahead = false): Task {
  let t = tasks.get(spec.key);
  if (t) {
    t.ahead ||= ahead;
    return t;
  }
  let resolve!: (b: Built | null) => void;
  let found!: (kept: boolean) => void;
  const done = new Promise<Built | null>((r) => (resolve = r));
  const kept = new Promise<boolean>((r) => (found = r));
  const task: Task = { spec, near: false, wanted: 0, ahead, state: 'looking', kept, done, resolve };
  tasks.set(spec.key, task);
  // Looked up on this computer at once (quick); built in turn only when it is not there.
  void fromStore(spec.key).then((b) => {
    if (b) {
      keep(spec.key, b);
      noteInfo(spec.key, b.info);
      tasks.delete(spec.key);
      found(true);
      resolve(b);
      return;
    }
    found(false);
    task.state = 'waiting';
    void pump();
  });
  return task;
}

/** Near the screen first, then shown ones, then those built ahead; the rest is dropped. */
function nextTask(): Task | null {
  let best: Task | null = null;
  let rank = 0;
  for (const t of tasks.values()) {
    if (t.state !== 'waiting') continue;
    const r = t.near && t.wanted > 0 ? 3 : t.wanted > 0 ? 2 : t.ahead ? 1 : 0;
    if (!r) {
      tasks.delete(t.spec.key);
      t.resolve(null);
      continue;
    }
    if (r > rank) {
      best = t;
      rank = r;
    }
  }
  return best;
}

let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      await whenIdle();
      const t = nextTask();
      if (!t) break;
      t.state = 'building';
      const b = await build(t.spec).catch(() => null);
      tasks.delete(t.spec.key);
      if (b) noteInfo(t.spec.key, b.info);
      t.resolve(b);
    }
  } finally {
    pumping = false;
  }
}

const faces: FaceFor = (choice) => {
  const f = stickerFont(choice);
  return { title: f.title, text: f.text };
};

/** One card, in steps with a pause for the page between them. */
async function build(spec: Spec): Promise<Built | null> {
  await loadStickerFont(spec.font);
  const image = await loadImageBitmap(spec.cover());
  try {
    await whenIdle();
    const analysis = analyseImage(image);
    await whenIdle();
    const layout = { ...resolveLayout(spec.recipe, spec.format, spec.episode) };
    layout.schrift ??= spec.font;
    if (spec.color && (!layout.farbe || layout.farbe === 'auto')) layout.farbe = spec.color;
    const seed = hash(`${spec.folder}`) || 1;
    const plan = planCard({ analysis, layout, format: spec.format, geometry: spec.geometry, text: spec.text, sourceSize: imageSize(image), seed });
    await whenIdle();
    const canvas = paintCard(plan, image, { pxPerMm: spec.k, faces, seed });
    const b: Built = { image: canvas as CanvasLike & CanvasImageSource, orientation: spec.orientation, info: infoOf(plan) };
    keep(spec.key, b);
    toStore(spec.key, canvas, b);
    return b;
  } finally {
    image.close();
  }
}

/* ------------------------------------------------------------------ ahead of time */

let aheadTimer = 0;
let lastVolume: unknown = null;

/** All cards of the card, built ahead; then the covers of recognised folders without one. */
function buildAhead() {
  const s = card.value;
  const c = catalog.value;
  if (!s?.scan || !c || s.status !== 'ready') return;
  const wanted = new Set<string>();
  const shelf = buildShelf(s.scan, c);
  for (const item of shelf) {
    if (item.state === 'missing') continue;
    const src = shelfSource(item.number, item.title);
    if (!src.card || recall(src.card.key)) continue;
    wanted.add(src.card.key);
    const spec = known.get(src.card.key)?.spec;
    // Built on an earlier day: kept, not loaded (the shelf only looks up its finished picture).
    if (spec && !tasks.has(spec.key)) void cardStore.has(spec.key).then((kept) => kept || ensure(spec, true));
    else if (spec) ensure(spec, true);
  }
  // Built ahead for a shelf that is gone (other card, other format): not any more.
  for (const t of tasks.values()) if (t.ahead && !wanted.has(t.spec.key)) t.ahead = false;
  void findCovers(shelf.flatMap((i) => (i.entry && i.state !== 'missing' ? [{ folder: i.number, entry: i.entry }] : [])));
}

if (typeof window !== 'undefined') {
  effect(() => {
    const s = card.value;
    // What the cards depend on: built again (ahead) when one of them changes.
    void [catalog.value, shelfFormat.value, shelfLook.value, template.value, design.value.font, foundCovers.value];
    if (!s || s.status !== 'ready') return;
    untracked(() => {
      if (s.volume !== lastVolume) {
        lastVolume = s.volume;
        notBefore = performance.now() + START_DELAY_MS;
      }
      clearTimeout(aheadTimer);
      aheadTimer = window.setTimeout(buildAhead, Math.max(300, notBefore - performance.now()));
    });
  });
}

/* ------------------------------------------------------------------ finding covers */

const RETRY_NOTHING_MS = 7 * 24 * 3600 * 1000;
let finding = false;
let findAgain: { folder: number; entry: CatalogFolder }[] | null = null;
/** Searches already done in this session, by query. */
const searched = new Set<string>();
let unreachable = 0;
let answered = 0;

async function findCovers(folders: { folder: number; entry: CatalogFolder }[]) {
  // Switched off in the settings: only a click on „Cover suchen“ asks the internet.
  if (!settings.value.findCovers) return;
  if (finding) {
    findAgain = folders;
    return;
  }
  finding = true;
  try {
    for (const { folder, entry } of folders) {
      const s = card.value;
      if (!s || (entry.cover && s.covers.has(entry.cover))) continue;
      const choice = choiceFor(entry);
      if (choice.kind === 'sticker') continue;
      const want = coverWanted(entry, choice);
      if (!want?.specific) continue;
      const name = folderName(folder);
      if (foundCovers.value.get(name)?.query === want.query || searched.has(want.query)) continue;
      searched.add(want.query);
      const id = hash(want.query).toString(36);
      const kept = await foundStore.get(id).catch(() => undefined);
      if (kept?.bytes) {
        addFound(name, { id: pictureId(new Uint8Array(kept.bytes)), blob: new Blob([kept.bytes], { type: kept.type }), source: kept.source ?? '', title: kept.title ?? '', artist: kept.artist ?? '', query: want.query });
        continue;
      }
      if (kept && Date.now() - kept.at < RETRY_NOTHING_MS) continue;
      if ((typeof navigator !== 'undefined' && navigator.onLine === false) || (unreachable >= 2 && !answered)) continue;
      await whenIdle();
      await searchSpacing.wait();
      const result = await searchCovers({ query: want.query }, { fetchFn: coverFetch, limit: 5 }).catch(() => null);
      if (!result || isUnreachable(result)) {
        unreachable++;
        // Asked again in the next session.
        searched.delete(want.query);
        continue;
      }
      answered++;
      const best = result.candidates[0];
      if (!isConfident(want, best)) {
        void foundStore.set(id, { at: Date.now() }).catch(() => undefined);
        continue;
      }
      try {
        const blob = await downloadCoverImage(best, { fetchFn: (url, init) => plat().fetch(url, init) });
        const bytes = await blob.arrayBuffer();
        const source = best.source === 'itunes' ? 'iTunes' : 'MusicBrainz';
        void foundStore.set(id, { bytes, type: blob.type, source, title: best.title, artist: best.artist, at: Date.now() }).catch(() => undefined);
        addFound(name, { id: pictureId(new Uint8Array(bytes)), blob, source, title: best.title, artist: best.artist, query: want.query });
      } catch {
        searched.delete(want.query);
      }
    }
  } finally {
    finding = false;
  }
  if (findAgain) {
    const next = findAgain;
    findAgain = null;
    void findCovers(next);
  }
}

function addFound(name: string, f: FoundCover) {
  const m = new Map(foundCovers.value);
  m.set(name, f);
  foundCovers.value = m;
}

/** The found cover of a folder, for "Übernehmen" on the folder page. */
export async function foundCoverBytes(f: FoundCover): Promise<Uint8Array> {
  return new Uint8Array(await f.blob.arrayBuffer());
}
