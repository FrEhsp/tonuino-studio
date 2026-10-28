/**
 * The shelves of "Entdecken" (TODO #119): one row per show, its stories side
 * by side with their own covers, the title without the show's name. A show
 * whose stories share one picture is no row of equal pictures: its cover
 * stands once, the stories are a list beside it (number and title, nothing
 * drawn in place of a missing picture). Sources that are one work as a whole
 * (an album, a book) share one row. Pure, so the choices are tested.
 */
import { itemSeconds, storyGroups, type Hit, type Story } from '../../core/sources/filter';
import type { IndexEntry, IndexItem } from '../../core/sources/types';
import { lengthLabel } from './labels';

/** Stories in one row before "Alle … Folgen" leads to the show's page. */
export const SHELF_MAX = 12;

/** The show's own name: "Mucks Wüstenfuchs – Mini-Hörspiele zum Mitraten" → "Mucks Wüstenfuchs". */
export function seriesName(entryTitle: string): string {
  return entryTitle.split(/\s+[–—-]\s+/)[0].trim();
}

/**
 * A title without the show's name in front, which the row already names:
 * "Mucks Wüstenfuchs: Auf dem Bauernhof" → "Auf dem Bauernhof". Only when a
 * colon or dash follows the name, so "Dr. Brumm lädt ein" stays whole.
 */
export function shortTitle(title: string, entryTitle: string): string {
  const name = seriesName(entryTitle);
  if (!name || name.length >= title.length) return title;
  if (title.slice(0, name.length).toLocaleLowerCase('de') !== name.toLocaleLowerCase('de')) return title;
  const rest = /^\s*(?::|[–—-]\s)\s*(.+)$/.exec(title.slice(name.length))?.[1]?.trim();
  return rest ? rest.charAt(0).toLocaleUpperCase('de') + rest.slice(1) : title;
}

/** The picture of a title: its own, else the source's. */
export function coverOf(entry: Pick<IndexEntry, 'cover'>, item: Pick<IndexItem, 'cover'>): string | undefined {
  return item.cover ?? entry.cover;
}

/** "3 Teile · 1 Std. 30 Min." for a story in parts, "25 Min." for one title; '' when nothing is known. */
export function storyMeta(story: Story): string {
  const parts = story.items.length;
  const secs = story.items.map(itemSeconds);
  const length = lengthLabel(secs.every((s) => s !== undefined) ? secs.reduce<number>((a, b) => a + (b ?? 0), 0) : undefined);
  return [parts > 1 ? `${parts} Teile` : '', length].filter(Boolean).join(' · ');
}

/**
 * covers: the stories have their own pictures, side by side. list: most of
 * them share one picture (or have none); the picture stands once.
 */
export function shelfKind(entry: Pick<IndexEntry, 'cover'>, stories: readonly Story[]): 'covers' | 'list' {
  const covers = stories.map((s) => coverOf(entry, s.items[0]));
  const own = new Set(covers.filter((c) => c && covers.indexOf(c) === covers.lastIndexOf(c)));
  return stories.length > 1 && own.size >= Math.max(2, Math.ceil(stories.length * 0.6)) ? 'covers' : 'list';
}

export type Shelf =
  | { kind: 'covers' | 'list'; key: string; entry: IndexEntry; stories: Story[] }
  /** Sources that are one work or one collection each, side by side. */
  | { kind: 'sources'; key: string; hits: Hit[] };

/** The rows for browsing, in the order of the hits (picks first); whole sources share the last row. */
export function browseShelves(hits: readonly Hit[]): Shelf[] {
  const out: Shelf[] = [];
  const whole: Hit[] = [];
  for (const h of hits) {
    if (!h.entry.single) {
      whole.push(h);
      continue;
    }
    const stories = storyGroups(h.items);
    if (!stories.length) continue;
    out.push({ kind: shelfKind(h.entry, stories), key: h.entry.id, entry: h.entry, stories });
  }
  if (whole.length) out.push({ kind: 'sources', key: 'quellen', hits: whole });
  return out;
}
