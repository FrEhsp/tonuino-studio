/**
 * Which recipe fits a folder: by its title and series, the artist, the
 * names of its tracks and files, and where it came from in "Entdecken".
 * Real cards are messy (titles in the artist field, "SpotiDownloader.com - "
 * in front of albums, series spelled three ways), so all of it is compared
 * cleaned and normalised, and a recipe has to be named, not guessed.
 */
import { episodeNumbers, normalizeForMatch } from '../stickers/coversearch';
import { stripDownloaderNoise } from '../library/tidy';
import type { Recipe } from './recipe';

/** What the app knows about a folder (a CatalogFolder fits). */
export interface FolderFacts {
  title: string;
  artist?: string;
  series?: string;
  episode?: number;
  tracks?: readonly { title?: string; file?: string; artist?: string }[];
  origins?: readonly { entry?: string; series?: string; title?: string }[];
}

/**
 * What recognition needs: the kind and the words. A recipe has them, and so
 * has a work's colour scheme (src/core/stickers/works.ts), which uses the
 * same matching since the recipes rest.
 */
export type Recognizable = Pick<Recipe, 'art' | 'erkennen'>;

export interface Recognized<R extends Recognizable = Recipe> {
  recipe: R;
  episode?: number;
  /** What it was recognised by, for "automatisch erkannt (am Titel)". */
  via: 'titel' | 'kuenstler' | 'dateien' | 'entdecken';
  score: number;
}

const norm = (s: string | undefined) => (s ? normalizeForMatch(stripDownloaderNoise(s)) : '');

/**
 * A normalised text or phrase with a space on each side: a padded phrase is in a padded text exactly
 * when it is there as whole words. Padded once, each look is one `includes` without building strings.
 */
const pad = (s: string) => ` ${s} `;

interface Prepared {
  recipe: Recognizable;
  /** The phrases normalised and padded (" die drei fragezeichen "). */
  titel: string[];
  kuenstler: string[];
  nicht: string[];
}

const preparedCache = new WeakMap<readonly Recognizable[], Prepared[]>();

function prepare(recipes: readonly Recognizable[]): Prepared[] {
  let p = preparedCache.get(recipes);
  if (!p) {
    const phrases = (list: readonly string[] | undefined) => (list ?? []).map(norm).filter(Boolean).map(pad);
    p = recipes.map((recipe) => ({
      recipe,
      titel: phrases(recipe.erkennen.titel),
      kuenstler: phrases(recipe.erkennen.kuenstler),
      nicht: phrases(recipe.erkennen.nicht),
    }));
    preparedCache.set(recipes, p);
  }
  return p;
}

/** The longest of the padded `phrases` found in the padded `text`, by its length; 0 when none. */
function longestHit(text: string, phrases: readonly string[]): number {
  let best = 0;
  for (const ph of phrases) if (ph.length - 2 > best && text.includes(ph)) best = ph.length - 2;
  return best;
}

/** The episode number of a folder: its own, else the first number in its title that is not part of the series name. */
export function episodeOf(f: FolderFacts, recipe: Recognizable): number | undefined {
  if (f.episode !== undefined) return f.episode;
  if (recipe.art !== 'serie') return undefined;
  let title = norm(f.title);
  for (const ph of (recipe.erkennen.titel ?? []).map(norm)) title = title.replace(ph, ' ');
  const n = episodeNumbers(title).filter((x) => x > 0 && x < 1000);
  return n[0];
}

/**
 * The recipe for a folder, or null. The title and series count most, then
 * the artist (also when it is only in the tracks' artist fields, or the
 * title is in the artist field), then the track and file names, which must
 * name it in most tracks. Of two recipes the more specific one (longer
 * phrase: "die drei fragezeichen kids" over "die drei fragezeichen") wins.
 */
export function recognize<R extends Recognizable = Recipe>(f: FolderFacts, recipes: readonly R[]): Recognized<R> | null {
  // No recipes (the shelf ships none since 0.5): nothing to clean up and compare.
  if (!recipes.length) return null;
  const title = norm(f.title);
  const series = norm(f.series);
  const artist = norm(f.artist);
  const head = `${title} ${series}`.trim();
  const tracks = f.tracks ?? [];
  const trackTexts = tracks.map((t) => `${norm(t.title)} ${norm(t.file?.replace(/\.[a-z0-9]{2,4}$/i, ''))}`);
  const trackArtists = tracks.map((t) => norm(t.artist)).filter(Boolean).map(pad);
  // All track names in one text: most recipes are named in none of them, one look tells.
  const allTracks = ` ${trackTexts.join(' | ')} `;
  const origins = f.origins ?? [];
  const originTexts = origins.map((o) => pad(`${norm(o.series)} ${norm(o.title)}`));
  const [titleP, headP, artistP] = [pad(title), pad(head), pad(artist)];
  const everything = pad(`${head} ${artist}`);
  let trackTextsP: string[] | undefined;
  let best: Recognized<R> | null = null;
  let bestLen = 0;
  for (const p of prepare(recipes)) {
    const r = p.recipe;
    if (p.nicht.some((n) => everything.includes(n))) continue;
    let score = 0;
    let via: Recognized<R>['via'] = 'titel';
    let len = 0;
    if (r.erkennen.entdecken?.length && origins.some((o) => o.entry && r.erkennen.entdecken!.includes(o.entry))) {
      score = 5;
      via = 'entdecken';
      len = 999;
    }
    if (!score && p.titel.length) {
      const inHead = longestHit(headP, p.titel);
      // A title written into the artist field ("Die Welt dreht sich" by "Unter meinem Bett 3").
      const inArtist = longestHit(artistP, p.titel);
      const inOrigin = originTexts.length ? Math.max(0, ...originTexts.map((o) => longestHit(o, p.titel))) : 0;
      const hit = Math.max(inHead, inArtist, inOrigin);
      if (hit) {
        // A title recipe that also names its artist must have it, so "Panama" by someone else stays unknown.
        const needsArtist = r.art === 'titel' && p.kuenstler.length > 0 && hit < 12;
        const artistOk = !needsArtist || p.kuenstler.some((k) => everything.includes(k) || trackArtists.some((t) => t.includes(k)));
        if (artistOk) {
          score = inHead || inOrigin ? 4 : 3;
          len = hit;
        }
      }
    }
    if (!score && r.art === 'kuenstler' && p.kuenstler.length) {
      const own = longestHit(artistP, p.kuenstler);
      const fromTracks = trackArtists.length ? trackArtists.filter((t) => longestHit(t, p.kuenstler)).length / trackArtists.length : 0;
      const inTitle = longestHit(titleP, p.kuenstler);
      if (own || fromTracks >= 0.5 || inTitle) {
        score = 2;
        via = 'kuenstler';
        len = Math.max(own, inTitle, fromTracks >= 0.5 ? 1 : 0);
      }
    }
    if (!score && p.titel.length && trackTexts.length >= 2 && p.titel.some((ph) => allTracks.includes(ph))) {
      trackTextsP ??= trackTexts.map(pad);
      const named = trackTextsP.filter((t) => longestHit(t, p.titel)).length;
      if (named / trackTexts.length >= 0.6) {
        score = 1;
        via = 'dateien';
        len = longestHit(pad(trackTexts.join(' ')), p.titel);
      }
    }
    if (!score) continue;
    if (!best || score > best.score || (score === best.score && len > bestLen)) {
      best = { recipe: r as R, via, score, episode: undefined };
      bestLen = len;
    }
  }
  if (best) best.episode = episodeOf(f, best.recipe);
  return best;
}

/**
 * Everything recognition looks at, as one text: equal for folders with the same names, also after
 * the catalog was copied for a change (state.ts changeCatalog), so a kept result still counts.
 */
export function factsKey(f: FolderFacts): string {
  const tracks = (f.tracks ?? []).map((t) => `${t.title ?? ''}\u0001${t.file ?? ''}\u0001${t.artist ?? ''}`).join('\u0002');
  const origins = (f.origins ?? []).map((o) => `${o.entry ?? ''}\u0001${o.series ?? ''}\u0001${o.title ?? ''}`).join('\u0002');
  return [f.title, f.artist ?? '', f.series ?? '', f.episode ?? '', tracks, origins].join('\u0003');
}
