/**
 * Where a track from "Entdecken" came from, and how that credit travels:
 * into the file's tags (COMM, TCOP, WCOP, WOAS), into the folder in the
 * card's catalog, and into a plain list of sources for the whole box.
 */
import type { Catalog, CatalogFolder, CatalogTrack, ContentKind, FolderOrigin } from '../tonuino/catalog';
import { copyrightFrame, creditLine, linkUrl, rightsBadge, rightsUrl, type Change } from './licence';
import type { Category, IndexEntry, IndexItem } from './types';

/** Kept with each downloaded file on its way to the card. */
export interface TrackOrigin {
  entry: Pick<IndexEntry, 'id' | 'type' | 'title' | 'publisher' | 'pageUrl' | 'rights' | 'editPolicy'>;
  item: Pick<IndexItem, 'key' | 'title' | 'pageUrl' | 'creators' | 'tradition' | 'rights' | 'published' | 'category'>;
  retrievedAt: number;
}

export function trackOrigin(entry: IndexEntry, item: IndexItem, retrievedAt: number): TrackOrigin {
  const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> => {
    const out = {} as Pick<T, K>;
    for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
    return out;
  };
  return {
    entry: pick(entry, ['id', 'type', 'title', 'publisher', 'pageUrl', 'rights', 'editPolicy'] as const),
    item: pick(item, ['key', 'title', 'pageUrl', 'creators', 'tradition', 'rights', 'published', 'category'] as const),
    retrievedAt,
  };
}

/** Why a file from a publisher that allows no changes cannot be used. */
export const UNCHANGED_NOT_MP3 = 'Müsste umgewandelt werden. Der Anbieter erlaubt keine Änderungen.';

/** The folder kind for a category of the list. */
export function categoryToKind(c: Category): ContentKind {
  return c === 'lied' ? 'lieder' : c;
}

/** What happens to a file on its way to the card (the import's TrackWork). */
export type FileWork = 'copy' | 'adjust' | 'convert' | 'cut';

const CHANGE_ORDER: readonly Change[] = ['converted', 'split', 'loudness', 'tags'];

/**
 * What the app changed in a file, for the credit (CC licences ask for it):
 * copied files only got new title tags (when tags are replaced at all),
 * adjusted ones a different loudness, converted and cut ones are new files.
 */
export function changesFor(work: FileWork, o: { tagsWritten: boolean; gainApplied: boolean; split?: boolean }): Change[] {
  const set = new Set<Change>();
  if (work === 'convert') set.add('converted');
  if (work === 'cut' || (work === 'convert' && o.split)) set.add('split');
  if (work === 'adjust' || (o.gainApplied && work !== 'copy')) set.add('loudness');
  if (o.tagsWritten || work === 'convert' || work === 'cut') set.add('tags');
  return CHANGE_ORDER.filter((c) => set.has(c));
}

/** All changes of several files, in the usual order. */
export function unionChanges(lists: readonly (readonly string[])[]): Change[] {
  const set = new Set(lists.flat());
  return CHANGE_ORDER.filter((c) => set.has(c));
}

export interface OriginTags {
  /** COMM: the full credit line. */
  comment: string;
  /** TCOP: year and holder, or the usual CC wording. */
  copyright?: string;
  /** WCOP: licence or terms of use. */
  copyrightUrl?: string;
  /** WOAS: the item's page. */
  sourceUrl: string;
}

/** The tags that carry the credit inside the file. */
export function originTags(o: TrackOrigin, changes: readonly Change[], fallbackYear: number): OriginTags {
  const rights = o.item.rights ?? o.entry.rights;
  const url = rightsUrl(rights);
  const out: OriginTags = { comment: creditLine(o.entry, o.item, changes), sourceUrl: o.item.pageUrl ?? o.entry.pageUrl };
  const copyright = copyrightFrame(o.entry, o.item, fallbackYear);
  if (copyright) out.copyright = copyright;
  if (url) out.copyrightUrl = linkUrl(url);
  return out;
}

/** The catalog's record for one item, shared by its tracks in a folder. */
export function folderOrigin(o: TrackOrigin, changes: readonly Change[], id: string): FolderOrigin {
  const rights = o.item.rights ?? o.entry.rights;
  const url = rightsUrl(rights);
  const out: FolderOrigin = {
    id,
    entry: o.entry.id,
    item: o.item.key,
    title: o.item.title,
    publisher: o.entry.publisher,
    pageUrl: o.item.pageUrl ?? o.entry.pageUrl,
    licence: { kind: rights.kind, label: rightsBadge(rights), ...(url ? { url: linkUrl(url) } : {}) },
    credit: creditLine(o.entry, o.item, changes),
    changes: [...changes],
    retrievedAt: o.retrievedAt,
  };
  if (o.entry.title !== o.item.title) out.series = o.entry.title;
  return out;
}

/** Tracks on their way to a folder; only the origin matters here. */
type WithOrigin = { origin?: TrackOrigin };

/**
 * What the list says about an album of files from "Entdecken": the kind,
 * when all files are of one category, and whether the publisher allows no
 * changes. Nothing when none of the files came from there.
 */
export function albumFromSources(tracks: readonly WithOrigin[]): { kind?: ContentKind; unchanged: boolean } | undefined {
  const origins = tracks.map((t) => t.origin);
  if (!origins.some(Boolean)) return undefined;
  const categories = new Set(origins.map((o) => o?.item.category));
  const [category] = categories;
  return {
    kind: categories.size === 1 && category ? categoryToKind(category) : undefined,
    unchanged: origins.some((o) => o?.entry.editPolicy === 'unchanged'),
  };
}

/** The source's title for a folder named after one of its items: "Kakadu Kinderhörspiel" for an episode. */
export function seriesFor(album: { title: string; tracks: readonly WithOrigin[] }): string | undefined {
  const titles = new Set(album.tracks.map((t) => t.origin?.entry.title));
  if (titles.size !== 1) return undefined;
  const [series] = titles;
  return series && series !== album.title.trim() ? series : undefined;
}

/** Who made a cover found in the files: the publisher for files from "Entdecken", else the file. */
export function coverCredit(tracks: readonly WithOrigin[]): string {
  const publishers = new Set(tracks.map((t) => t.origin?.entry.publisher));
  const [publisher] = publishers;
  return publishers.size === 1 && publisher ? publisher : 'Datei';
}

/** Credit tags for a file from "Entdecken" whose tags are written; nothing for other files. */
export function creditTagsFor(track: WithOrigin, changes: Change[]): OriginTags | undefined {
  return track.origin ? originTags(track.origin, changes, new Date(track.origin.retrievedAt).getFullYear()) : undefined;
}

/** A track that was just written, with the origin of its file. */
export interface WrittenTrack {
  track: CatalogTrack;
  origin: TrackOrigin;
  changes: readonly string[];
}

/**
 * Notes the origins of freshly written tracks in their folder: one record per
 * item (an episode, a book), reused when the item is already there, and the
 * record's id on every track.
 */
export function recordOrigins(folder: CatalogFolder, written: readonly WrittenTrack[], newId: () => string): void {
  if (!written.length) return;
  const byItem = new Map<string, WrittenTrack[]>();
  for (const w of written) byItem.set(w.origin.item.key, [...(byItem.get(w.origin.item.key) ?? []), w]);
  const origins = [...(folder.origins ?? [])];
  for (const [key, group] of byItem) {
    const at = origins.findIndex((o) => o.item === key);
    const before = at >= 0 ? origins[at] : undefined;
    const changes = unionChanges([...(before ? [before.changes] : []), ...group.map((w) => w.changes)]);
    const record = folderOrigin(group[0].origin, changes, before?.id ?? newId());
    if (at >= 0) origins[at] = record;
    else origins.push(record);
    for (const w of group) w.track.origin = record.id;
  }
  folder.origins = origins;
}

/** True for licences that only allow use within the family. */
export function privateOnly(licence: FolderOrigin['licence']): boolean {
  return licence.kind === 'podcast' || licence.kind === 'private-use';
}

const DATE = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function formatDay(ms: number): string {
  return DATE.format(new Date(ms));
}

/**
 * A plain text list of everything on the box that came from "Entdecken",
 * with the credits: for passing on with the card, or for a kindergarten that
 * asks where the stories come from.
 */
export function sourcesListText(catalog: Pick<Catalog, 'folders'>, boxName: string, now: number): string {
  const lines = [`Quellen der Box „${boxName}“, erstellt mit TonUINO Studio am ${formatDay(now)}`];
  for (const key of Object.keys(catalog.folders).sort()) {
    const f = catalog.folders[key];
    if (!f.origins?.length) continue;
    lines.push('', `Ordner ${key} – ${f.title}`);
    for (const o of f.origins) {
      lines.push(`  ${o.credit}`);
      if (privateOnly(o.licence)) lines.push('    Nur für den privaten Gebrauch in der Familie.');
      lines.push(`    Geladen am ${formatDay(o.retrievedAt)}.`);
    }
  }
  if (lines.length === 1) lines.push('', 'Auf dieser Box ist nichts aus „Entdecken“.');
  return lines.join('\n') + '\n';
}
