import { computed, signal } from '@preact/signals';
import type { LucideIcon } from 'lucide-preact';
import { CircleHelp, KeyRound, RotateCcw } from 'lucide-preact';
import { ADMIN_MODE, type CardData } from '../../core/tonuino/card';
import { modeByCode, modifiersFor, type ModifierSymbol } from '../../core/tonuino/modes';
import type { Orientation } from '../../core/stickers/layout';
import { extractPalette, fromHex, panelColor, type Palette, type RGB } from '../../core/stickers/color';
import { LeaseCache, type Lease } from '../../core/stickers/cache';
import { createCanvas, drawContain, fitWithin, get2d, imageSize, loadImageBitmap, MAX_PICTURE_EDGE, readPictureSize, resizeImage, sniffImageType, usedPictureSize, type DrawableImage } from '../../core/stickers/image';
import type { ByteSource } from '../../platform/types';
import { COVER_COLORS, inkOn, KIND_ICONS } from '../../ui/components/Cover';
import { nextTask } from '../../ui/quiet';
import { boxScan, catalog, coverUrlFor, coverUrlForCard, profile } from '../../app/state';
import type { CatalogFolder } from '../../core/tonuino/catalog';
import { cardItems, isSelected, setSelected, type CardItem } from '../cards/items';
import { MODIFIER_ICONS } from '../cards/SpecialCardDialog';
import { iconImage } from './icons';
import { NO_RECIPE, SHIPPED_RECIPES, shelfChoice, shippedRecipeById } from '../../core/covers/shelf';
import type { Recipe } from '../../core/covers/recipe';
import { workColors, workColorsByTitle, type WorkColors } from '../../core/stickers/works';

/** Everything one sticker shows. */
export interface StickerItem {
  key: string;
  title: string;
  subtitle?: string;
  /** Series and episode, or the artist, for the head band of the style "Kassette" (portrait); else the subtitle goes there. */
  series?: string;
  /** Folder number, "05". */
  number?: string;
  /**
   * One of several cards of a folder: the tracks it plays ("13–15", "7") or
   * its mode. These stickers show their title also with "Titel zeigen" off,
   * and round ones this in place of the number, so each can be told apart.
   */
  part?: string;
  /** Short detail that is always shown, e.g. "15 Min." on a sleep card. */
  detail?: string;
  /** What the folder holds: tracks, their running time and kind, for the flap of "Kassette" ("14 Titel · 52 Min."). */
  length?: FolderLength;
  folder?: number;
  picture?: { kind: 'url'; url: string } | { kind: 'blob'; id: string; blob: Blob };
  /** Symbol for the generated picture when there is no image. */
  icon: LucideIcon;
  /** Chosen background colour (hex), else the work's (`work`), else taken from the picture. */
  color?: string;
  /**
   * The colours of a well-known work this sticker belongs to, recognised by
   * its title, series and artist (src/core/stickers/works.ts): the band of
   * "Kassette" and every colour panel, and the number plate.
   */
  work?: WorkColors;
  /** Flat colour of the generated picture when no colour is chosen. */
  flatColor: string;
  focusX?: number;
  focusY?: number;
  /** 0 = whole picture, 1 = filled, more = zoomed in; undefined follows the design. */
  zoom?: number;
  /** This sticker turned differently from the design. */
  orientation?: Orientation;
  /** Pictures dropped onto the page: not from the SD card. */
  loose?: boolean;
  /**
   * The folder's cover recipe (src/core/covers), the same as the shelf's
   * card: a square cover on a portrait Vollbild is built with it instead of
   * just running its edge on. `recipe` null: the safe form, no recipe.
   */
  recipe?: { id: string; recipe: Recipe | null; episode?: number };
  /**
   * Style "Bildkarte" without a picture: this ARASAAC pictogram in place of the own motif (StickerTweaks.pictogram).
   * On a sticker from an own picture (loose) it takes the picture's place: without an SD card that is the only way to one.
   */
  pictogram?: number;
}

/**
 * Colours of special cards, so a sleep card always looks like a sleep card:
 * flat colours of the forum and of the arcade buttons, the same as the
 * folder colours (COVER_COLORS) plus the red of the box's button.
 */
const SPECIAL_COLORS: Record<ModifierSymbol | 'admin' | 'again', string> = {
  moon: '#0e76bd',
  'music-pause': '#f7941d',
  'flame-water-wind': '#e5483b',
  baby: '#ef2f84',
  school: '#9eb83b',
  'repeat-1': '#12a89d',
  bluetooth: '#0e76bd',
  'list-music': '#fdd459',
  pause: '#8c6238',
  power: '#e5483b',
  infinity: '#12a89d',
  lock: '#e5483b',
  shield: '#9eb83b',
  admin: '#8c6238',
  again: '#f7941d',
};

const pad2 = (n: number) => String(n).padStart(2, '0');

function colorFor(seed: number): string {
  return COVER_COLORS[Math.abs(seed) % COVER_COLORS.length].bg;
}

/**
 * The sticker of a folder as it will be printed, e.g. for the card on the
 * shelf. `fallbackTitle` is used when the folder has no sticker title. The
 * key is the one of its card in the cards list (buildCardItems), so the shelf
 * and the print speak of the same sticker.
 */
export function folderSticker(folder: number, fallbackTitle: string, key = `f${folder}`): StickerItem {
  const f = catalog.value?.folders[pad2(folder)];
  const url = coverUrlFor(folder);
  return {
    key,
    title: f?.sticker?.title?.trim() || fallbackTitle,
    subtitle: folderSubtitle(f),
    series: folderSeries(f),
    number: pad2(folder),
    folder,
    picture: url ? { kind: 'url', url } : undefined,
    icon: KIND_ICONS[f?.kind ?? 'hoerspiel'],
    color: f?.color,
    work: workColors(f),
    flatColor: colorFor(folder),
    focusX: f?.sticker?.focusX,
    focusY: f?.sticker?.focusY,
    zoom: f?.sticker?.zoom,
    orientation: f?.sticker?.orientation,
    recipe: folderRecipe(f),
    length: folderLength(folder, f),
    pictogram: f?.sticker?.pictogram,
  };
}

export interface FolderLength {
  tracks: number;
  /** Missing when the length of a track is not known. */
  durationSec?: number;
  /** A story (Hörspiel, Hörbuch): its tracks are parts, not songs worth counting. */
  story: boolean;
}

/** Tracks and running time of a folder: the tracks on the card when it was read, their lengths from the catalog. */
export function folderLength(folder: number, f: Pick<CatalogFolder, 'tracks' | 'kind'> | undefined): FolderLength | undefined {
  const scanned = boxScan.value?.folders.find((x) => x.number === folder);
  const files = scanned ? [...new Map(scanned.tracks.map((t) => [t.number, t.name])).values()] : (f?.tracks.map((t) => t.file) ?? []);
  if (!files.length) return undefined;
  const byFile = new Map((f?.tracks ?? []).map((t) => [t.file.toLowerCase(), t.durationSec]));
  let sum = 0;
  for (const name of files) {
    const d = byFile.get(name.toLowerCase());
    if (d === undefined || !Number.isFinite(d)) {
      sum = NaN;
      break;
    }
    sum += d;
  }
  return { tracks: files.length, durationSec: Number.isFinite(sum) && sum > 0 ? sum : undefined, story: f?.kind === 'hoerspiel' || f?.kind === 'hoerbuch' };
}

/** Sticker contents for one card of the cards list. */
export function stickerFromCard(item: CardItem): StickerItem {
  const cat = catalog.value;
  const d = item.data;
  if (item.folder !== undefined) return folderSticker(item.folder, item.title, item.key);
  // Special cards: text and colour stay, so they are known at a glance; a Bildkarte may show a pictogram for the drawn motif.
  const pictogram = item.extra?.sticker?.pictogram;
  const special = (s: Omit<StickerItem, 'pictogram'>): StickerItem => (pictogram ? { ...s, pictogram } : s);
  if (d.folder === 0 && d.mode === ADMIN_MODE) {
    return special({ key: item.key, title: 'Admin-Karte', subtitle: 'Öffnet das Admin-Menü', icon: KeyRound, flatColor: SPECIAL_COLORS.admin });
  }
  if (d.folder === 0) {
    // A TNG card on a 2.1 box keeps its own symbol, as in the cards list; the key is the Admin-Karte's.
    const mod = modifiersFor(profile.value).find((m) => m.code === d.mode) ?? modifiersFor('tng').find((m) => m.code === d.mode);
    if (!mod) return special({ key: item.key, title: item.title, icon: CircleHelp, flatColor: '#8a7866' });
    const minutes = d.special & 0x7f;
    return special({
      key: item.key,
      title: mod.params === 'sleep' ? 'Schlummerkarte' : mod.name,
      subtitle: mod.params === 'sleep' ? `${minutes} Minuten${d.special & 0x80 ? ', bis zum Titelende' : ''}` : undefined,
      detail: mod.params === 'sleep' ? `${minutes} Min.` : undefined,
      icon: MODIFIER_ICONS[mod.symbol],
      flatColor: SPECIAL_COLORS[mod.symbol],
    });
  }
  if (d.folder === 0xff) {
    return special({ key: item.key, title: 'Nochmal', subtitle: 'Spielt, was zuletzt lief', icon: RotateCcw, flatColor: SPECIAL_COLORS.again });
  }
  // A second card for a folder, e.g. one part of an audiobook.
  const f = cat?.folders[pad2(d.folder)];
  // An episode of a packed series keeps the picture it had as a folder (ExtraCard.cover).
  const url = item.extra ? coverUrlForCard(item.extra) : coverUrlFor(d.folder);
  // Adjusted on its own ("Sticker anpassen"), else as the folder's sticker; the section of the folder's picture does not fit a picture of its own.
  const own = item.extra?.sticker;
  const look = { ...(item.extra?.cover ? {} : f?.sticker), ...definedOf(own) };
  return {
    key: item.key,
    // The card's own name big ("Das Hexenfest"), the folder under it: the list's title has both.
    title: own?.title?.trim() || (item.extra?.label ?? item.title),
    subtitle: f?.title,
    number: pad2(d.folder),
    part: folderPart(d),
    folder: d.folder,
    picture: url ? { kind: 'url', url } : undefined,
    icon: KIND_ICONS[f?.kind ?? 'hoerspiel'],
    color: item.extra?.color ?? f?.color,
    work: workColors(f),
    flatColor: colorFor(d.folder),
    focusX: look.focusX,
    focusY: look.focusY,
    zoom: look.zoom,
    orientation: look.orientation,
    recipe: folderRecipe(f),
    pictogram: look.pictogram,
  };
}

function definedOf<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** What sets a further card of a folder apart: its tracks ("13–15", "7"), else its mode. */
export function folderPart(d: Pick<CardData, 'mode' | 'special' | 'special2'>): string {
  const mode = modeByCode(d.mode);
  if (mode?.params === 'track') return String(d.special);
  if (mode?.params === 'range') return d.special === d.special2 ? String(d.special) : `${d.special}–${d.special2}`;
  return mode?.name ?? `Modus ${d.mode}`;
}

function folderRecipe(f: Parameters<typeof shelfChoice>[0]): StickerItem['recipe'] {
  const c = shelfChoice(f, SHIPPED_RECIPES, shippedRecipeById);
  return c.kind === 'karte' ? { id: c.recipe?.id ?? NO_RECIPE, recipe: c.recipe, episode: c.episode ?? f?.episode } : undefined;
}

/** Line under the title: series and episode, or the artist; nothing the title already says. */
export function folderSubtitle(f: { title: string; artist?: string; series?: string; episode?: number } | undefined): string | undefined {
  if (!f) return undefined;
  const has = (s: string) => f.title.toLowerCase().includes(s.toLowerCase());
  if (f.series) {
    const episode = f.episode && !has(`Folge ${f.episode}`) ? `Folge ${f.episode}` : undefined;
    // "Bibi & Tina – Das Pferd im Schnee" names the series already: then only "Folge 5".
    if (has(f.series)) return episode;
    return episode ? `${f.series}, ${episode}` : f.series;
  }
  return f.artist && !has(f.artist) ? f.artist : undefined;
}

/** Series and episode in full ("Bibi & Tina, Folge 5"), or the artist: what the head band of a cassette sticker names. */
export function folderSeries(f: { artist?: string; series?: string; episode?: number } | undefined): string | undefined {
  if (!f) return undefined;
  if (f.series) return f.episode ? `${f.series}, Folge ${f.episode}` : f.series;
  return f.artist || undefined;
}

/* ------------------------------------------------------------------ pictures without SD card */

export interface LooseSticker {
  id: string;
  title: string;
  number?: number;
  /** Name of the file it came from, to notice the same picture added twice. */
  file?: string;
  blob: Blob;
  url: string;
  /** Counts the pictures this sticker had ("Anderes Bild"), so each one is cached and measured on its own. */
  rev?: number;
  color?: string;
  focusX?: number;
  focusY?: number;
  zoom?: number;
  orientation?: Orientation;
  /** An ARASAAC pictogram (pictograms.ts) a Bildkarte shows in place of the picture. */
  pictogram?: number;
  /** Not chosen for printing: it stays in the list, but not on the sheet. */
  off?: boolean;
}

export const looseStickers = signal<LooseSticker[]>([]);

/** "05_Bibi Blocksberg.jpg" → number 5, title "Bibi Blocksberg". */
export function titleFromFileName(name: string): { title: string; number?: number } {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(\d{1,2})(?:\s*[-.)–]\s*|\s+)(.+)$/.exec(base);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 99) return { title: m[2].trim(), number: n };
  }
  return { title: base || 'Bild' };
}

/** Adds pictures as stickers; a picture that is there already (same file name and size) is left out. Returns how many were left out. */
export function addLooseStickers(files: { name: string; blob: Blob }[]): number {
  const sameFile = (name: string, size: number) => `${name}\n${size}`;
  const there = new Set(looseStickers.value.filter((l) => l.file).map((l) => sameFile(l.file!, l.blob.size)));
  const added: LooseSticker[] = [];
  files.forEach((f, i) => {
    const key = sameFile(f.name, f.blob.size);
    if (there.has(key)) return;
    there.add(key);
    added.push({ id: `l${Date.now().toString(36)}${i}`, ...titleFromFileName(f.name), file: f.name, blob: f.blob, url: URL.createObjectURL(f.blob) });
  });
  if (added.length) looseStickers.value = [...looseStickers.value, ...added];
  return files.length - added.length;
}

/**
 * A word card (TODO 0.3 #98): the word and an ARASAAC pictogram, without an SD card and without a
 * picture file. `cover` is the pictogram on its white plate (pictogramCover.ts), so the sticker
 * shows it in every style; a Bildkarte draws the pictogram itself (StickerItem.pictogram).
 * False when the same word with the same pictogram is on the sheet already.
 */
export function addWordSticker(word: string, pictogram: number, cover: Blob): boolean {
  const title = word.trim().replace(/\s+/g, ' ');
  if (!title) return false;
  const same = looseStickers.value.find((l) => l.pictogram === pictogram && l.title.toLowerCase() === title.toLowerCase());
  if (same) {
    // Left out earlier: back onto the sheet.
    if (same.off) setLooseSelected(true, same.id);
    return false;
  }
  const sticker: LooseSticker = { id: `w${Date.now().toString(36)}${looseStickers.value.length}`, title, blob: cover, url: URL.createObjectURL(cover), pictogram };
  looseStickers.value = [...looseStickers.value, sticker];
  return true;
}

/** Made with „Wort + Piktogramm“ (addWordSticker), not from a picture file or a cover. */
export function isWordSticker(l: Pick<LooseSticker, 'id'>): boolean {
  return l.id.startsWith('w');
}

/** Chooses own pictures for printing or leaves them out: one by its id, or all of them. */
export function setLooseSelected(on: boolean, id?: string) {
  looseStickers.value = looseStickers.value.map((x) => (id === undefined || x.id === id ? { ...x, off: on ? undefined : true } : x));
}

/** Removes all own pictures, e.g. before stickers for another box. */
export function removeAllLooseStickers() {
  for (const l of looseStickers.value) removeLooseSticker(l.id);
}

export function removeLooseSticker(id: string) {
  const s = looseStickers.value.find((x) => x.id === id);
  if (s) {
    URL.revokeObjectURL(s.url);
    pictures.drop(`b:${loosePictureId(s)}`);
  }
  looseStickers.value = looseStickers.value.filter((x) => x.id !== id);
}

/**
 * "Anderes Bild" for a sticker from an own picture: the new picture takes
 * its place, title and number stay. Colour, section and orientation were
 * chosen for the old picture and go, as for a new cover (see setCovers).
 */
export function replaceLoosePicture(id: string, blob: Blob) {
  const s = looseStickers.value.find((x) => x.id === id);
  if (!s) return;
  URL.revokeObjectURL(s.url);
  forgetPicture(stickerFromLoose(s, 0));
  const next: LooseSticker = { id: s.id, title: s.title, number: s.number, blob, url: URL.createObjectURL(blob), rev: (s.rev ?? 0) + 1, pictogram: s.pictogram, off: s.off };
  looseStickers.value = looseStickers.value.map((x) => (x.id === id ? next : x));
}

/** Id of the picture a sticker from an own picture shows now; a new one after every "Anderes Bild". */
export function loosePictureId(l: Pick<LooseSticker, 'id' | 'rev'>): string {
  return l.rev ? `${l.id}~${l.rev}` : l.id;
}

/** The LooseSticker id of a sticker from an own picture, else undefined. */
export function looseIdOf(item: Pick<StickerItem, 'key' | 'loose'>): string | undefined {
  return item.loose && item.key.startsWith('l:') ? item.key.slice(2) : undefined;
}

export function updateLooseSticker(id: string, patch: Partial<Pick<LooseSticker, 'title' | 'color' | 'focusX' | 'focusY' | 'zoom' | 'orientation' | 'pictogram'>>) {
  looseStickers.value = looseStickers.value.map((x) => (x.id === id ? { ...x, ...patch } : x));
}

function stickerFromLoose(l: LooseSticker, index: number): StickerItem {
  return {
    key: `l:${l.id}`,
    title: l.title,
    number: l.number ? pad2(l.number) : undefined,
    picture: { kind: 'blob', id: loosePictureId(l), blob: l.blob },
    icon: KIND_ICONS.sonstiges,
    color: l.color,
    work: workColorsByTitle(l.title),
    flatColor: colorFor(index),
    focusX: l.focusX,
    focusY: l.focusY,
    zoom: l.zoom,
    orientation: l.orientation,
    pictogram: l.pictogram,
    loose: true,
  };
}

/**
 * Takes a sticker off the sheet ("Vom Bogen nehmen"): the card is no longer
 * chosen for printing, an own picture stays in the list but unticked.
 * Nothing on the SD card changes.
 */
export function removeFromSheet(item: Pick<StickerItem, 'key' | 'loose'>) {
  const loose = looseIdOf(item);
  if (loose) {
    setLooseSelected(false, loose);
    return;
  }
  const card = cardItems.value.find((c) => c.key === item.key);
  if (card) setSelected(card, false);
}

/** The stickers to print: the cards chosen on the cards page, then the own pictures chosen. */
export const stickerItems = computed<StickerItem[]>(() => [
  ...cardItems.value.filter(isSelected).map(stickerFromCard),
  // The colour by place in the whole list, so it stays when others are left out.
  ...looseStickers.value.flatMap((l, i) => (l.off ? [] : [stickerFromLoose(l, i)])),
]);

/* ------------------------------------------------------------------ prepared pictures */

export interface PreparedPicture {
  image: DrawableImage;
  /** Background for the blurred styles; generated pictures use their plain colour, without the symbol. */
  backdrop?: DrawableImage;
  palette: Palette;
  /** Background colour for panels (chosen or from the palette). */
  base: RGB;
  /** True when the picture was drawn here, for a sticker without one of its own. */
  generated: boolean;
}

interface LoadedPicture {
  image: DrawableImage;
  backdrop?: DrawableImage;
  palette: Palette;
  generated: boolean;
}

/** Decoded pictures kept for reuse, in pixels (about 190 MB); the least recently used go first. */
const PICTURE_BUDGET_PX = 48_000_000;
/** Pictures decoded at the same time; each one briefly needs its full size in memory. */
const PARALLEL_DECODES = 3;

const pictures = new LeaseCache<LoadedPicture>(PICTURE_BUDGET_PX, pictureCost, freePicture);

/**
 * How the picture of a sticker without one is drawn. `strip` writes the title
 * on a strip of paper, as on the shelf (the sticker does so when it shows no
 * title of its own); `number` writes the folder number in marker (off when the
 * design hides numbers); `edge` is its size in pixels, small for previews.
 */
export interface GeneratedLook {
  strip: boolean;
  number: boolean;
  edge: number;
}

/** Size of a generated picture: sharp at 300 dpi for printing, a quarter of the pixels for previews and the shelf. */
export const GENERATED_EDGE = { print: 1024, preview: 512 } as const;

const DEFAULT_LOOK: GeneratedLook = { strip: false, number: true, edge: GENERATED_EDGE.print };

function pictureKey(item: StickerItem, look: GeneratedLook = DEFAULT_LOOK): string {
  if (item.picture?.kind === 'url') return `u:${item.picture.url}`;
  if (item.picture?.kind === 'blob') return `b:${item.picture.id}`;
  return generatedKey(item, look);
}

/** Cache key of a generated picture: everything that is drawn on it, nothing else, so equal stickers share one. */
export function generatedKey(item: StickerItem, look: GeneratedLook): string {
  const number = look.number && item.number ? item.number : '';
  // Only special cards (no number) carry their symbol; a folder never gets a made-up picture.
  const symbol = item.number ? '' : (item.icon.displayName ?? item.icon.name);
  const title = look.strip && item.title.trim() ? item.title.trim() : '';
  return `g:${look.edge}:${placeholderColor(item)}:${number}:${symbol}:${title}`;
}

/**
 * The flat colour of a sticker without a picture: the colour chosen for it
 * when there is one, else its colour by number. The shelf shows the same
 * (Cover with `color`), and picture and the area around it share it.
 */
export function placeholderColor(item: StickerItem): string {
  return item.color && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color.toLowerCase() : item.flatColor;
}

export interface PictureLease {
  picture: PreparedPicture;
  /** Call when done drawing: the picture may be freed afterwards. */
  release(): void;
}

/**
 * Loads the picture (or draws the placeholder, see GeneratedLook) and its
 * colours, cached per picture. The picture stays valid until `release` is
 * called.
 */
export async function leasePicture(item: StickerItem, look: Partial<GeneratedLook> = {}): Promise<PictureLease> {
  const full = { ...DEFAULT_LOOK, ...look };
  let lease: Lease<LoadedPicture>;
  try {
    lease = await pictures.lease(pictureKey(item, full), () => loadPicture(item, full));
  } catch {
    // A broken picture must not stop the sheet: fall back to the placeholder.
    lease = await pictures.lease(generatedKey(item, full), () => loadGenerated(item, full));
  }
  const pic = lease.value;
  // A colour chosen for the sticker, else the work's, else the picture's own.
  const chosen = item.color ? safeHex(item.color) : undefined;
  const known = item.work?.band ? safeHex(item.work.band) : undefined;
  const base = pic.generated ? fromHex(placeholderColor(item)) : (chosen ?? known ?? panelColor(pic.palette));
  return { picture: { ...pic, base }, release: lease.release };
}

/** The colours of the picture, e.g. for colour swatches. */
export async function picturePalette(item: StickerItem): Promise<Palette> {
  const lease = await leasePicture(item);
  lease.release();
  return lease.picture.palette;
}

function safeHex(hex: string): RGB | undefined {
  try {
    return fromHex(hex);
  } catch {
    return undefined;
  }
}

async function loadPicture(item: StickerItem, look: GeneratedLook): Promise<LoadedPicture> {
  if (!item.picture) return loadGenerated(item, look);
  const source = item.picture.kind === 'url' ? item.picture.url : item.picture.blob;
  const image = await withDecodeSlot(async () => shrink(await loadImageBitmap(source)));
  // Its colours in a task of their own (see renderItem).
  await nextTask();
  return { image, palette: paletteOf(image), generated: false };
}

/** The picture at most MAX_PICTURE_EDGE pixels long; the full-size decode is freed right away. */
async function shrink(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const size = fitWithin(bitmap.width, bitmap.height, MAX_PICTURE_EDGE);
  if (size.width === bitmap.width && size.height === bitmap.height) return bitmap;
  try {
    const small = resizeImage(bitmap, size.width, size.height);
    return 'transferToImageBitmap' in small ? small.transferToImageBitmap() : await createImageBitmap(small);
  } finally {
    bitmap.close();
  }
}

let decoding = 0;
const decodeQueue: (() => void)[] = [];

async function withDecodeSlot<T>(work: () => Promise<T>): Promise<T> {
  while (decoding >= PARALLEL_DECODES) await new Promise<void>((resolve) => decodeQueue.push(resolve));
  decoding++;
  try {
    return await work();
  } finally {
    decoding--;
    decodeQueue.shift()?.();
  }
}

function pictureCost(p: LoadedPicture): number {
  const area = (img: DrawableImage | undefined) => (img ? imageSize(img).width * imageSize(img).height : 0);
  return area(p.image) + area(p.backdrop);
}

/** Gives the memory of a picture back at once instead of waiting for the garbage collector. */
function freePicture(p: LoadedPicture): void {
  for (const img of [p.image, p.backdrop]) {
    if (!img) continue;
    if ('close' in img) img.close();
    else if (!('naturalWidth' in img)) {
      img.width = 0;
      img.height = 0;
    }
  }
}

/**
 * The picture of a sticker without one, drawn like the hand-made sticker on
 * the shelf in the Holz style (Cover). The printed sticker looks the
 * same whichever style the app shows: one flat colour, the folder number in
 * marker (unless the design hides numbers) and the title on a strip of paper
 * (with `strip`). With the strip the number sits at the top left, without it
 * big in the middle, so no corner stays empty. No picture is made up for a
 * folder: only special cards (no number) carry their symbol, since it says
 * what the card does.
 */
async function loadGenerated(item: StickerItem, look: GeneratedLook): Promise<LoadedPicture> {
  const size = look.edge;
  const bg = placeholderColor(item);
  const ink = inkOn(bg);
  const canvas = createCanvas(size, size);
  const ctx = get2d(canvas);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  // Klassisch puts the picture on a blurred copy of itself: here that is just the same colour.
  const backdrop = createCanvas(64, 64);
  const b = get2d(backdrop);
  b.fillStyle = bg;
  b.fillRect(0, 0, 64, 64);
  const title = item.title.trim();
  const strip = look.strip && !!title;
  if (strip || (item.number && look.number)) await handFontsReady();
  if (item.number && look.number) {
    // Not too big: the number is a hint, the card is still about the folder (Frank, 13.10.2026).
    const font = size * (strip ? 0.22 : 0.32);
    ctx.save();
    ctx.fillStyle = ink;
    ctx.font = `${Math.round(font)}px 'Permanent Marker', 'Gochi Hand', sans-serif`;
    ctx.textBaseline = 'alphabetic';
    if (strip) {
      ctx.translate(size * 0.08, size * 0.4);
    } else {
      ctx.textAlign = 'center';
      // Digits are about 0.7 of the font size high: their middle in the middle of the picture.
      ctx.translate(size * 0.5, size * 0.5 + font * 0.35);
    }
    ctx.rotate((-3 * Math.PI) / 180);
    ctx.fillText(item.number, 0, 0);
    ctx.restore();
  }
  const titleStrip = strip ? measureTitleStrip(ctx, title, size) : undefined;
  if (!item.number) {
    // The symbol a little smaller and higher when the title strip goes below it.
    const icon = await iconImage(item.icon, ink, 2.2);
    const box = symbolBox(size, titleStrip);
    ctx.globalAlpha = 0.95;
    drawContain(ctx, icon, box.x, box.y, box.side, box.side);
    ctx.globalAlpha = 1;
  }
  if (titleStrip) drawTitleStrip(ctx, titleStrip, size);
  return { image: canvas as DrawableImage, backdrop: backdrop as DrawableImage, palette: paletteOf(canvas), generated: true };
}

/** The marker and the handwriting of the app, loaded before they are drawn on a canvas (else the canvas falls back quietly). */
export async function handFontsReady(): Promise<void> {
  try {
    if (typeof document !== 'undefined' && document.fonts) await Promise.all([document.fonts.load("120px 'Permanent Marker'"), document.fonts.load("60px 'Gochi Hand'")]);
  } catch {
    // Without them the text is written in the fallback font; the sticker still works.
  }
}

/** The title strip of a generated picture, measured: lines, font size and the strip's size, in pixels. */
export interface TitleStrip {
  lines: string[];
  font: number;
  w: number;
  h: number;
}

type MeasureCtx = { font: string; measureText(text: string): { width: number } };

/** The title on a strip of paper at the bottom left, at most two lines: how big it gets. */
export function measureTitleStrip(ctx: MeasureCtx, title: string, size: number): TitleStrip {
  const maxW = size * 0.86;
  const pad = size * 0.035;
  let font = size * 0.13;
  let lines: string[] = [];
  for (; font >= size * 0.06; font *= 0.92) {
    ctx.font = stripFont(font);
    lines = wrapLines(ctx, title, maxW - 2 * pad);
    if (lines.length <= 2) break;
  }
  if (lines.length > 2) lines = [lines[0], `${lines[1]} …`];
  const w = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 2 * pad);
  return { lines, font, w, h: lines.length * font * 1.12 + pad * 1.3 };
}

const STRIP_TILT = (-2 * Math.PI) / 180;

/**
 * Where the symbol of a special card goes: in the middle, or with a title
 * strip above it, clear of the strip also where its slant lifts it (a
 * two-line name moves the symbol up and makes it a little smaller).
 */
export function symbolBox(size: number, strip?: Pick<TitleStrip, 'w' | 'h'>): { x: number; y: number; side: number } {
  if (!strip) return { x: size * 0.24, y: size * 0.24, side: size * 0.52 };
  const stripTop = size * 0.91 - strip.h + strip.w * Math.sin(STRIP_TILT);
  const bottom = stripTop - size * 0.04;
  const side = Math.max(size * 0.2, Math.min(size * 0.44, bottom - size * 0.08));
  const y = Math.max(size * 0.04, Math.min(size * 0.16, bottom - side));
  return { x: (size - side) / 2, y, side };
}

function stripFont(px: number): string {
  return `${Math.round(px)}px 'Gochi Hand', 'Comic Sans MS', sans-serif`;
}

/** The title on its strip of paper at the bottom left, slightly askew. */
function drawTitleStrip(ctx: ReturnType<typeof get2d>, strip: TitleStrip, size: number): void {
  const { lines, font, w, h } = strip;
  const pad = size * 0.035;
  const lineH = font * 1.12;
  ctx.font = stripFont(font);
  ctx.save();
  ctx.translate(size * 0.08, size * 0.91 - h);
  ctx.rotate(STRIP_TILT);
  ctx.fillStyle = 'rgb(42 31 22 / 0.25)';
  ctx.fillRect(size * 0.006, size * 0.01, w, h);
  ctx.fillStyle = '#fffcf5';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#2a1f16';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((l, i) => ctx.fillText(l, pad, pad * 0.5 + (i + 1) * lineH - font * 0.22, w - 2 * pad));
  ctx.restore();
}

function wrapLines(ctx: MeasureCtx, text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

function paletteOf(img: DrawableImage): Palette {
  const n = 64;
  const c = createCanvas(n, n);
  const ctx = get2d(c, { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, n, n);
  return extractPalette(ctx.getImageData(0, 0, n, n).data, n, n);
}

/* ------------------------------------------------------------------ picture sizes */

export interface PixelSize {
  width: number;
  height: number;
}

/** Pixel size of each picture measured so far (as shown), for the hint about pictures too small to print. */
export const pictureSizes = signal<ReadonlyMap<string, PixelSize>>(new Map());
const measuring = new Set<string>();

/**
 * Pixel size a sticker's own picture is drawn with, once it is measured: a
 * bigger picture is shrunk to MAX_PICTURE_EDGE on loading, so the print
 * gets no more than that. Nothing for generated pictures.
 */
export function pictureSizeOf(item: StickerItem): PixelSize | undefined {
  const size = item.picture ? pictureSizes.value.get(pictureKey(item)) : undefined;
  return size && usedPictureSize(size);
}

/**
 * Measures the pictures of these stickers that are not measured yet. Reads
 * only the file headers, so it stays quick for hundreds of photos.
 */
export async function measurePictures(items: readonly StickerItem[]): Promise<void> {
  const todo = new Map<string, Blob | string>();
  for (const item of items) {
    const key = pictureKey(item);
    if (!item.picture || pictureSizes.value.has(key) || measuring.has(key)) continue;
    todo.set(key, item.picture.kind === 'url' ? item.picture.url : item.picture.blob);
  }
  if (!todo.size) return;
  for (const key of todo.keys()) measuring.add(key);
  const found = new Map<string, PixelSize>();
  try {
    for (const [key, source] of todo) {
      try {
        found.set(key, await readPictureSize(source));
      } catch {
        // Not readable: the sheet shows the placeholder for it anyway.
      }
    }
  } finally {
    for (const key of todo.keys()) measuring.delete(key);
  }
  if (found.size) pictureSizes.value = new Map([...pictureSizes.value, ...found]);
}

/** Forgets a cached picture that no sticker shows any more, e.g. the old one after "Anderes Bild". */
function forgetPicture(item: StickerItem) {
  pictures.drop(pictureKey(item));
}

/** Pictures that can become stickers. */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];

/** A picture file as a Blob with its type, also when the system gives none. */
export async function imageBlobOf(s: ByteSource): Promise<Blob> {
  const blob = s.blob ?? new Blob([(await s.read(0, s.size)) as BlobPart]);
  if (blob.type) return blob;
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  return new Blob([blob], { type: sniffImageType(head) ?? 'image/jpeg' });
}
