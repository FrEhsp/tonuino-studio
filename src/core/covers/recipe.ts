/**
 * Cover recipes: how the original cover of a title or series becomes a card
 * that fills the sticker, upright (hoch) or across (quer). The app ships
 * only these recipes, never a cover; the cover is the original one, on the
 * user's computer (from the SD card, or fetched from iTunes/MusicBrainz).
 *
 * A series recipe sets the layout all its episodes share. Ranges of episodes
 * ("folgen") change it where the series changed its covers over the years,
 * and a range of one episode is a fine recipe for that episode alone.
 */
import type { Frac } from './pixels';

export type CardFormat = 'hoch' | 'quer';

/**
 * verlaengern: the cover fills the card, a flat edge colour (night sky,
 * black) runs on, and real parts of the cover fill the new space.
 * farbfeld: the safe form, the whole cover next to a flat colour panel.
 * auto: verlaengern where the edge is flat and parts are given, else farbfeld.
 */
export type CardForm = 'auto' | 'verlaengern' | 'farbfeld';

/** A real part of the cover put somewhere else on the card. */
export interface PartSpec {
  /** versetzen: moved (big things: moon, the "Hörspiel" circle, a title on plain ground); kopieren: small things copied (stars). */
  tun: 'versetzen' | 'kopieren';
  /** Box on the cover without its frame: x, y, width, height (0…1). */
  quelle: Frac;
  /** versetzen: its new place on the card: left, top, width (0…1 of the card); the height follows. */
  ziel?: [x: number, y: number, w: number];
  /** kopieren: how many copies (at most 8); the app scatters them on empty ground. */
  anzahl?: number;
  /** For people reading the recipe, e.g. "Mond". */
  name?: string;
  /** ellipse: only the round shape in the box is the part (a round badge with other things near its corners). */
  maske?: 'rect' | 'ellipse';
}

export type FontChoice = 'round' | 'detective' | 'comic' | 'storybook' | 'clear' | 'book' | 'hand';

/**
 * Which number the card shows: the folder number, the episode number,
 * none because the cover prints its own (im-cover), or none at all.
 */
export type NumberChoice = 'ordner' | 'folge' | 'im-cover' | 'keine';

export interface LayoutSpec {
  form?: CardForm;
  /** Where the cover sits along the long side of the card: 0 top/left … 1 bottom/right, or 'auto'. */
  anker?: number | 'auto';
  /** Colour of the panel: 'auto' (printed frame, flat edge, else from the cover), 'rahmen' or '#rrggbb'. */
  farbe?: string;
  teile?: PartSpec[];
  /** Text and logos printed in the cover (boxes on the cover without frame): never cut, never covered. */
  texte?: Frac[];
  /** The title once more on the panel, in the app's font; false when the cover's own title is enough. */
  titel?: boolean;
  schrift?: FontChoice;
  nummer?: NumberChoice;
  /** Centre of the number on the card (0…1), when the quietest place is known better than the app finds it. */
  nummerOrt?: [x: number, y: number];
}

/** A change for some episodes: from `von` to `bis` (inclusive; open when missing). */
export interface EpisodeRange {
  von: number;
  bis?: number;
  beide?: LayoutSpec;
  hoch?: LayoutSpec;
  quer?: LayoutSpec;
}

/** What identifies a title on the card. Words are compared normalised (normalizeForMatch). */
export interface Recognition {
  /** Phrases of the title or series; one is enough. */
  titel?: string[];
  /** Artists; for artist recipes, and to tell titles apart. */
  kuenstler?: string[];
  /** Phrases that rule the recipe out (e.g. "kids" for the main series). */
  nicht?: string[];
  /** Ids of "Entdecken" entries (origin.entry) that are this title. */
  entdecken?: string[];
}

export interface Recipe {
  id: string;
  /** Shown to the user: "Der Räuber Hotzenplotz". */
  name: string;
  /** serie: numbered episodes; titel: one title (or a few); kuenstler: all albums of an artist. */
  art: 'serie' | 'titel' | 'kuenstler';
  erkennen: Recognition;
  /** Search for the original cover when the card has none. `folge`: the episode number is added. */
  suche?: { begriff: string; kuenstler?: string; folge?: boolean };
  /** Shared by both formats; `hoch` and `quer` add to it. */
  basis?: LayoutSpec;
  hoch?: LayoutSpec;
  quer?: LayoutSpec;
  folgen?: EpisodeRange[];
  /** Checked with these real covers ("Folge 1, 7, 23", "Ordner 45"); empty: only by the automatic check. */
  geprueft?: string[];
}

/** The layout for one card: series, then format, then the episode's ranges (later ones win). */
export function resolveLayout(recipe: Recipe | null, format: CardFormat, episode?: number): LayoutSpec {
  const parts: (LayoutSpec | undefined)[] = [recipe?.basis, recipe?.[format]];
  if (recipe && episode !== undefined) {
    for (const r of recipe.folgen ?? []) {
      if (episode < r.von || (r.bis !== undefined && episode > r.bis)) continue;
      parts.push(r.beide, r[format]);
    }
  }
  const out: LayoutSpec = {};
  for (const p of parts) if (p) Object.assign(out, p);
  return out;
}
