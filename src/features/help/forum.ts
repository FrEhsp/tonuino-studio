/**
 * The threads of the TonUINO forum the help links to, one per page at most
 * ("Im Forum nachlesen"). The list lives in forumLinks.json, so a script can
 * check the titles each round (scripts/check-forum-links.mjs); a page names
 * its thread by number (HelpSection.forum).
 */
import data from './forumLinks.json';

export const FORUM_ORIGIN = 'https://discourse.voss.earth';

export interface ForumLink {
  id: number;
  /** The title of the thread, as the forum shows it. */
  title: string;
  /** The day the title was last compared with the forum. */
  checked: string;
  url: string;
}

export const FORUM_LINKS: readonly ForumLink[] = data.links.map((l) => ({ ...l, url: `${FORUM_ORIGIN}/t/${l.id}` }));

const BY_ID = new Map(FORUM_LINKS.map((l) => [l.id, l]));

export function forumLink(id: number): ForumLink | undefined {
  return BY_ID.get(id);
}
