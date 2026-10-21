/**
 * What the shelf of "Meine Box" shows for a folder: a card built from the
 * original cover with its recipe (recognised automatically or chosen), a
 * card without a recipe (the cover whole next to a panel), or the sticker
 * as it is printed. And what to search for when a recognised folder has no
 * cover yet. No canvas, no signals here.
 */
import { buildFolderQuery, namesOneAlbum } from '../stickers/bulkcover';
import type { CatalogFolder } from '../tonuino/catalog';
import { recognize, type Recognized } from './recognize';
import type { CardText } from './plan';
import type { Recipe } from './recipe';

/**
 * The cover recipes the app ships: none. They were switched off in 0.3.1
 * and dropped in 0.5 (Frank, 13.10.2026); every folder gets the card
 * without a recipe, and a recipe chosen with an older app counts as
 * unknown. The recipe machinery stays for the works' recognition.
 */
export const SHIPPED_RECIPES: readonly Recipe[] = [];

/** A shipped recipe by id: never one (see SHIPPED_RECIPES). */
export function shippedRecipeById(_id: string): Recipe | undefined {
  return undefined;
}

/** tweaks.recipe for "no recipe": the cover whole next to a panel. */
export const NO_RECIPE = '-';
/** tweaks.recipe for "the sticker as printed". */
export const AS_STICKER = 'sticker';

export interface ShelfChoice {
  kind: 'karte' | 'sticker';
  recipe: Recipe | null;
  episode?: number;
  /** Recognised by the app, not chosen: shown as "automatisch erkannt". */
  auto: boolean;
  via?: Recognized['via'];
}

const recognized = new WeakMap<object, Recognized | null>();

/** Recognition of a folder, kept per catalog entry (a changed entry is a new object). */
export function recognizeFolder(entry: CatalogFolder, recipes: readonly Recipe[]): Recognized | null {
  let r = recognized.get(entry);
  if (r === undefined) {
    r = recognize(entry, recipes);
    recognized.set(entry, r);
  }
  return r;
}

/**
 * The shelf card of a folder. A choice made on the folder page always wins;
 * without one the recognised recipe applies. Where the cover came from
 * does not tell an own picture from the original ("Datei" is also the
 * picture found in the folder on the card), so a recipe meets every cover:
 * its parts move only where the check finds them on plain ground, else the
 * card takes the safe form.
 */
export function shelfChoice(entry: CatalogFolder | undefined, recipes: readonly Recipe[], byId: (id: string) => Recipe | undefined): ShelfChoice {
  const chosen = entry?.sticker?.recipe;
  if (chosen === AS_STICKER) return { kind: 'sticker', recipe: null, auto: false };
  if (chosen === NO_RECIPE) return { kind: 'karte', recipe: null, auto: false };
  const found = entry ? recognizeFolder(entry, recipes) : null;
  if (chosen) {
    const recipe = byId(chosen);
    // A recipe of a newer app this one does not know: the card without one.
    if (!recipe) return { kind: 'karte', recipe: null, auto: false };
    return { kind: 'karte', recipe, episode: found?.recipe === recipe ? found.episode : entry?.episode, auto: false };
  }
  if (!found) return { kind: 'karte', recipe: null, auto: true };
  return { kind: 'karte', recipe: found.recipe, episode: found.episode, auto: true, via: found.via };
}

export interface CoverWanted {
  /** Search text for searchCovers. */
  query: string;
  /** Names one album, so a good hit may be taken without a look (isConfident). */
  specific: boolean;
}

/**
 * What to search for the original cover of a folder without one: the
 * recipe's search words (with the episode for series), else what the folder
 * page would search. Null when the name says too little.
 */
export function coverWanted(entry: CatalogFolder, choice: ShelfChoice): CoverWanted | null {
  const own = buildFolderQuery(entry);
  const s = choice.recipe?.suche;
  if (s && s.begriff) {
    if (s.folge && !choice.episode) return own ? { query: own, specific: namesOneAlbum(entry) } : null;
    const query = [s.kuenstler && choice.recipe?.art !== 'titel' ? s.kuenstler : '', s.begriff, s.folge && choice.episode ? `Folge ${choice.episode}` : ''].filter(Boolean).join(' ');
    // A title recipe names one book or album; a series with its episode too.
    return { query, specific: choice.recipe?.art === 'titel' || !!(s.folge && choice.episode) || namesOneAlbum(entry) };
  }
  return own ? { query: own, specific: namesOneAlbum(entry) } : null;
}

/**
 * What a shelf card says. On the shelf the folder number is written by hand
 * in the card's margin (.tile-num), so the card itself carries no folder
 * number disc: it would show the number twice. An episode number ("Folge
 * 12") is something else and stays. The printed sticker keeps its own number.
 */
export function shelfCardText(item: { title: string; subtitle?: string }, episode: number | undefined): CardText {
  return { title: item.title, subtitle: item.subtitle, episode };
}
