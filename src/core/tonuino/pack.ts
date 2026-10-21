/**
 * "Reihe in einen Ordner packen": a series spread over several folders goes
 * into one of them, every old folder an episode (Folge) there, so the box
 * needs one of its 99 numbers instead of many (Frank 16.10.2026: "das muss
 * sehr leicht sein, weil es viele beschäftigt").
 *
 * The folder with the lowest number of the ones chosen keeps its tracks
 * and number; the others follow, each under the next free track numbers,
 * and their numbers become free. No other folder ever gets another number.
 * The episodes go in the order of the numbers in their titles ("… 2"
 * before "… 7", see series.ts episodeOrder) or one chosen in the dialog.
 * When the target's own episode is not the first, the folder is put into
 * that order afterwards with the app's own reorder (repair.ts planReorder,
 * reorderList below), which an interruption can always undo, and the cards
 * follow their tracks (remapCards). A folder holds 255 tracks at most (see
 * episodes.ts): what does not fit goes into a further one of the chosen
 * folders, so the series ends up in as few folders as it needs.
 *
 * Nothing is lost when the run stops (closed app, pulled card, power cut):
 * one folder after the other is copied into the target under names the box
 * does not play ("019.mp3.tonuino-tmp", junk to the health check), each copy
 * is checked against its original by size and CRC, then all of them get
 * their real names at once, the catalog notes them, and only then the old
 * folder is deleted. A run that stops leaves every folder either as it was
 * or packed, never half of it in two places without a note in the catalog.
 * Snapshots of the web app (Paket) move the files instead: nothing is
 * written to the card there before the Paket, so there is nothing to copy.
 *
 * Every card written for one of the folders plays the wrong thing
 * afterwards: the box finds a folder by its number only. Each old folder
 * gets a card "von … bis …" of its own instead (an ExtraCard), with the
 * folder's name, cover, sticker settings and colour.
 */
import type { Dir, WriteOptions, ByteSource } from '../../platform/types';
import type { FirmwareProfile } from './card';
import { CONTENT_KINDS, newId, trackRows, type Catalog, type CatalogFolder, type CatalogTrack, type ExtraCard, type StickerTweaks } from './catalog';
import { coverMimeType } from './covers';
import { detectEpisodes, episodeLabels, episodeModeFor, episodeModesFor, type Episode } from './episodes';
import { modeByCode } from './modes';
import { crcOfSource } from './rebuild';
import { duplicateTracks, folderName, isJunk, MAX_TRACKS, type SdFolder, type SdScan } from './sd';
import { episodeOrder } from './series';

/** Copies wait under this ending until all of a folder arrived and were checked (sd.ts isPartialFile: junk). */
export const PACK_STAGE_SUFFIX = '.tonuino-tmp';

export interface PackTrack {
  /** File name in the old folder. */
  from: string;
  /** File name in the target folder. */
  to: string;
  /** Track number in the target folder. */
  number: number;
  size: number;
  /** Title as the folder page shows it (catalog, else the file name). */
  title: string;
}

export interface PackEpisode {
  /** Id of the card "von … bis …" the episode gets (ExtraCard.id). */
  id: string;
  title: string;
  /** Tracks in the target folder. */
  first: number;
  last: number;
  mode: number;
}

export interface PackMember {
  number: number;
  /** "07". */
  name: string;
  /** Catalog title, else "Ordner 07". */
  title: string;
  /** Tracks that move into the target; none for the target itself (its tracks stay as they are). */
  tracks: PackTrack[];
  /** The target's own tracks (for the episode names noted on them); empty for the others. */
  own: { file: string; number: number; title: string }[];
  bytes: number;
  /** Tracks of the folder in the target afterwards. */
  first: number;
  last: number;
  episodes: PackEpisode[];
  /** The folder's cover in the cover zip, and the entry its episode cards get. */
  cover?: { from: string; to: string };
}

export interface PackGroup {
  target: number;
  /** "02". */
  name: string;
  /** Name of the folder afterwards. */
  title: string;
  /** The target first, then the folders that go into it, in the order of the episodes. */
  members: PackMember[];
  /** Tracks in the target afterwards (its highest number). */
  total: number;
  /** The folders in the order of their episodes. */
  order: number[];
  /** The target's own episode is not the first: the folder is put into order after packing. */
  reorder: boolean;
}

export interface PackPlan {
  /** The series' name, as the folders get it. */
  name: string;
  groups: PackGroup[];
  /** Chosen folders that stay as they are: alone in their part after splitting. */
  alone: number[];
  /** What keeps the folders from being packed, in plain German. */
  problems: string[];
  /** Numbers that become free. */
  freed: number[];
  /** Bytes copied in all. */
  bytes: number;
  /** The largest folder copied: at least this much must be free on the card (one folder is copied at a time). */
  largest: number;
  /** Cards "von … bis …" afterwards, one per episode: the ones to write. */
  episodes: number;
}

export interface PackInput {
  scan: SdScan;
  catalog: Pick<Catalog, 'folders' | 'extraCards'> | null;
  /** The chosen folders. */
  numbers: readonly number[];
  /** The order of the episodes, as folder numbers; by default episodeOrder of their titles. */
  order?: readonly number[];
  /** Name of the folder afterwards (the series). */
  name: string;
  profile: FirmwareProfile;
  pureNumbers?: boolean;
  /** Entries of the cover zip, to tell a cover that is really there. */
  covers?: ReadonlySet<string>;
  /** Ids for the new cards (tests). */
  makeId?: () => string;
}

const pad3 = (n: number) => String(n).padStart(3, '0');

/** Key of a name as the catalog compares episodes (episodes.ts). */
const nameKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');

/** Why a folder cannot be packed, in plain German; undefined when it can. */
export function packBlocker(scan: SdScan, folder: SdFolder, entry?: CatalogFolder): string | undefined {
  const name = folder.name;
  const tidy = 'Räume ihn erst unter „Meine Box“ mit „Ansehen und reparieren“ auf.';
  if (scan.tempDirs.some((t) => t.folder === folder.number || t.folder === null) || entry?.renumbered) {
    return `Eine frühere Änderung an Ordner ${name} wurde unterbrochen. Lege erst die Dateien zurück, unter „Meine Box“ mit „Ansehen und reparieren“.`;
  }
  if (scan.readOnly?.some((p) => p === name || p.startsWith(`${name}/`))) return `Ordner ${name} ist schreibgeschützt. Hebe den Schutz erst unter „Meine Box“ mit „Ansehen und reparieren“ auf.`;
  if (!folder.tracks.length) return `Ordner ${name} ist leer.`;
  if (folder.subfolders.length) return `In Ordner ${name} liegen Unterordner. ${tidy}`;
  if (folder.wrongDigits.length || folder.unnumbered.length) return `In Ordner ${name} liegen Titel ohne passende Nummer. ${tidy}`;
  if (folder.others.length) return `In Ordner ${name} liegen noch andere Dateien (${folder.others[0].name}${folder.others.length > 1 ? ' …' : ''}). ${tidy}`;
  if (duplicateTracks(folder).length) return `In Ordner ${name} sind Nummern doppelt vergeben. ${tidy}`;
  if (folder.empty.length) return `In Ordner ${name} sind leere Titel. ${tidy}`;
  return undefined;
}

/** The mode a folder's card plays it with: set, else the default of its kind. */
function folderMode(entry: CatalogFolder | undefined): number {
  return entry?.card?.mode ?? CONTENT_KINDS.find((k) => k.id === (entry?.kind ?? 'hoerspiel'))?.defaultMode ?? 5;
}

/**
 * The episodes of a folder before packing: names noted on its tracks (it
 * was packed before, or filled with the extra "Mehr als 99 Hörspiele"),
 * else the whole folder is one episode named like the folder. Where the
 * tracks came from in "Entdecken" does not count here: each old folder is
 * one card, as it was.
 */
function episodesOf(folder: SdFolder, entry: CatalogFolder | undefined, title: string): Episode[] {
  const byFile = new Map((entry?.tracks ?? []).map((t) => [t.file.toLowerCase(), t.episode]));
  return detectEpisodes(
    folder.tracks.map((t) => ({ number: t.number, episode: byFile.get(t.name.toLowerCase()) })),
    title,
  );
}

/** The order of the episodes for the chosen folders: the one given (others after it), else episodeOrder of their titles. */
export function packOrder(numbers: readonly number[], titleOf: (n: number) => string, given?: readonly number[]): number[] {
  const chosen = new Set(numbers);
  const fromGiven = (given ?? []).filter((n) => chosen.has(n));
  const rest = episodeOrder([...chosen].filter((n) => !fromGiven.includes(n)).map((number) => ({ number, title: titleOf(number) })));
  return [...new Set([...fromGiven, ...rest])];
}

/**
 * Plans packing the chosen folders. Splits them, in the order of the
 * episodes, into as few parts as the 255 tracks of a folder allow, each
 * part into the lowest number in it.
 */
export function planPack(i: PackInput): PackPlan {
  const makeId = i.makeId ?? newId;
  const titleOf = (n: number) => i.catalog?.folders[folderName(n)]?.title?.trim() || `Ordner ${folderName(n)}`;
  const numbers = packOrder(i.numbers, titleOf, i.order);
  const problems: string[] = [];
  const name = i.name.trim().replace(/\s+/g, ' ');
  const folders: SdFolder[] = [];
  for (const n of numbers) {
    const f = i.scan.folders.find((x) => x.number === n);
    if (!f) {
      problems.push(`Ordner ${folderName(n)} ist nicht mehr auf der Karte. Lies die Karte neu ein.`);
      continue;
    }
    const why = packBlocker(i.scan, f, i.catalog?.folders[f.name]);
    if (why) problems.push(why);
    folders.push(f);
  }
  const modes = episodeModesFor(i.profile);
  if (!modes.length) problems.push('Deine Box kennt keine Karten, die nur einen Teil eines Ordners spielen. Ohne sie geht Packen nicht.');
  if (folders.length < 2) problems.push('Wähle mindestens zwei Ordner.');
  else if (!name) problems.push('Gib dem Ordner einen Namen.');

  // Into parts of at most MAX_TRACKS tracks, in order. The lowest number of a part keeps its tracks where they
  // are while the others arrive behind them (gaps included), so it counts with its highest track number.
  const count = (f: SdFolder) => new Set(f.tracks.map((t) => t.number)).size;
  const highest = (f: SdFolder) => Math.max(0, ...f.tracks.map((t) => t.number));
  const fits = (part: SdFolder[]) => {
    const low = part.reduce((a, b) => (b.number < a.number ? b : a));
    return highest(low) + part.filter((f) => f !== low).reduce((n, f) => n + count(f), 0) <= MAX_TRACKS;
  };
  const parts: SdFolder[][] = [];
  for (const f of folders) {
    const part = parts[parts.length - 1];
    if (part && fits([...part, f])) part.push(f);
    else parts.push([f]);
  }
  const real = parts.filter((p) => p.length > 1);
  const alone = parts.filter((p) => p.length === 1).map((p) => p[0].number);
  if (folders.length >= 2 && !real.length) problems.push(`Die Ordner sind zu voll: Zusammen hätten sie mehr als ${MAX_TRACKS} Titel.`);

  const groups: PackGroup[] = real.map((ordered, gi) => {
    const target = ordered.reduce((a, b) => (b.number < a.number ? b : a));
    const part = [target, ...ordered.filter((f) => f !== target)];
    const title = real.length > 1 ? `${name} (Teil ${gi + 1})` : name;
    let next = highest(target) + 1;
    const members: PackMember[] = part.map((f, mi) => {
      const entry = i.catalog?.folders[f.name];
      const own = entry?.title?.trim() || `Ordner ${f.name}`;
      const rows = trackRows(f, entry).sort((a, b) => a.number - b.number);
      const mode = modes.some((m) => m.code === episodeModeFor(folderMode(entry))) ? episodeModeFor(folderMode(entry)) : (modes[0]?.code ?? 8);
      const map = new Map<number, number>();
      const tracks: PackTrack[] = [];
      if (mi === 0) {
        for (const r of rows) map.set(r.number, r.number);
      } else {
        for (const r of rows) {
          const n = next++;
          map.set(r.number, n);
          const t = f.tracks.find((x) => x.name === r.file)!;
          tracks.push({ from: r.file, to: `${pad3(n)}${i.pureNumbers ? '' : t.suffix}.${t.ext}`, number: n, size: r.size, title: r.title });
        }
      }
      const episodes: PackEpisode[] = episodesOf(f, entry, own).map((e) => ({ id: makeId(), title: e.title, first: map.get(e.first) ?? e.first, last: map.get(e.last) ?? e.last, mode }));
      const coverEntry = entry?.cover && (!i.covers || i.covers.has(entry.cover)) ? entry.cover : undefined;
      return {
        number: f.number,
        name: f.name,
        title: own,
        tracks,
        own: mi === 0 ? rows.map((r) => ({ file: r.file, number: r.number, title: r.title })) : [],
        bytes: tracks.reduce((s, t) => s + t.size, 0),
        first: Math.min(...map.values()),
        last: Math.max(...map.values()),
        episodes,
        cover: coverEntry && episodes.length ? { from: coverEntry, to: `folge-${episodes[0].id}.${coverEntryExt(coverEntry)}` } : undefined,
      };
    });
    const order = ordered.map((f) => f.number);
    const inOrder = order.map((n) => members.find((m) => m.number === n)!);
    // Two episodes in a row with the same name would be one in the catalog (episodes.ts): the later one gets a number.
    let before = '';
    for (const e of inOrder.flatMap((m) => m.episodes)) {
      let k = 2;
      const base = e.title;
      while (nameKey(e.title) === before) e.title = `${base} (${k++})`;
      before = nameKey(e.title);
    }
    return { target: target.number, name: target.name, title, members, total: Math.max(...members.map((m) => m.last)), order, reorder: order[0] !== target.number };
  });

  const copied = groups.flatMap((g) => g.members.slice(1));
  return {
    name,
    groups,
    alone,
    problems,
    freed: copied.map((m) => m.number),
    bytes: copied.reduce((s, m) => s + m.bytes, 0),
    largest: Math.max(0, ...copied.map((m) => m.bytes)),
    episodes: groups.reduce((s, g) => s + g.members.reduce((n, m) => n + m.episodes.length, 0), 0),
  };
}

function coverEntryExt(entry: string): string {
  const mime = coverMimeType(entry);
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

/* ------------------------------------------------------------------ catalog */

/** Sticker settings that go from a folder to the card of its episode: the shelf card's recipe stays with folders. */
function episodeSticker(t: StickerTweaks | undefined): StickerTweaks | undefined {
  if (!t) return undefined;
  const { recipe: _recipe, ...rest } = t;
  return Object.values(rest).some((v) => v !== undefined) ? rest : undefined;
}

function episodeCard(target: number, e: PackEpisode, from: CatalogFolder | undefined, cover: string | undefined): ExtraCard {
  const x: ExtraCard = { id: e.id, label: e.title, folder: target, mode: e.mode, special: e.first, special2: e.last };
  const sticker = episodeSticker(from?.sticker);
  if (sticker) x.sticker = sticker;
  if (from?.color) x.color = from.color;
  if (cover) x.cover = cover;
  return x;
}

/**
 * Notes in the catalog that `member` arrived in the target of `group`: its
 * tracks with their titles, lengths, origins and episode names, a card
 * "von … bis …" for each of its episodes, and the further cards it had,
 * moved along with its tracks. With `first` the target itself is noted as
 * well (its name, its own episodes and their cards): done together with
 * the first folder that arrives, so a run that stops before leaves the
 * target as it was. Returns the ids of the cards to write anew.
 * `coverReady`: the episode covers are in the cover zip already.
 */
export function applyArrival(c: Catalog, group: PackGroup, member: PackMember, opts: { first: boolean; coverReady?: boolean; now?: number }): string[] {
  const now = opts.now ?? Date.now();
  const tgtMember = group.members[0];
  const T = (c.folders[group.name] ??= { title: tgtMember.title, tracks: [], addedAt: now, updatedAt: now });
  const ids: string[] = [];
  const cover = (m: PackMember) => (opts.coverReady ? m.cover?.to : undefined);
  // A card for the same tracks is there already (a run that stopped, packed again): it stays, with its sticker.
  const add = (x: ExtraCard) => {
    const same = c.extraCards.find((y) => y.folder === x.folder && y.special === x.special && y.special2 === x.special2 && modeByCode(y.mode)?.params === 'range');
    if (!same) c.extraCards.push(x);
    ids.push(same?.id ?? x.id);
  };
  if (opts.first) {
    const labels = episodeLabels(tgtMember.episodes, tgtMember.own.map((t) => t.number));
    for (const o of tgtMember.own) {
      let t = T.tracks.find((x) => x.file.toLowerCase() === o.file.toLowerCase());
      if (!t) T.tracks.push((t = { file: o.file, title: o.title }));
      const label = labels.get(o.number);
      if (label) t.episode = label;
    }
    for (const e of tgtMember.episodes) add(episodeCard(group.target, e, T, cover(tgtMember)));
    T.title = group.title;
    T.series = group.title.replace(/ \(Teil \d+\)$/, '');
    delete T.episode;
    // A shorter title for the sticker was the old folder's: its episode card has it now.
    if (T.sticker?.title !== undefined) {
      const { title: _title, ...rest } = T.sticker;
      T.sticker = Object.values(rest).some((v) => v !== undefined) ? rest : undefined;
    }
  }

  const F = c.folders[member.name];
  const byFile = new Map((F?.tracks ?? []).map((t) => [t.file.toLowerCase(), t]));
  const labels = episodeLabels(member.episodes, member.tracks.map((t) => t.number));
  const arrived: CatalogTrack[] = member.tracks.map((p) => {
    const was = byFile.get(p.from.toLowerCase());
    const t: CatalogTrack = { file: p.to, title: was?.title ?? p.title, size: p.size };
    if (was?.titleAuto) t.titleAuto = true;
    if (was?.durationSec !== undefined) t.durationSec = was.durationSec;
    if (was?.durationExact) t.durationExact = true;
    if (was?.origin) t.origin = was.origin;
    const label = labels.get(p.number);
    if (label) t.episode = label;
    return t;
  });
  const names = new Set(arrived.map((t) => t.file.toLowerCase()));
  T.tracks = [...T.tracks.filter((t) => !names.has(t.file.toLowerCase())), ...arrived].sort((a, b) => trackNo(a.file) - trackNo(b.file));
  if (F?.origins?.length) {
    const have = new Set((T.origins ?? []).map((o) => o.id));
    T.origins = [...(T.origins ?? []), ...F.origins.filter((o) => !have.has(o.id))];
  }

  for (const e of member.episodes) add(episodeCard(group.target, e, F, cover(member)));
  // The further cards of the folder (a track, a part of it) go along with its tracks.
  const shift = new Map<number, number>();
  const oldNumbers = member.tracks.map((t) => ({ old: trackNo(t.from), now: t.number }));
  for (const o of oldNumbers) shift.set(o.old, o.now);
  const kept: ExtraCard[] = [];
  for (const x of c.extraCards) {
    if (x.folder !== member.number) {
      kept.push(x);
      continue;
    }
    const params = modeByCode(x.mode)?.params;
    if (params === 'track' && shift.has(x.special)) {
      kept.push({ ...x, folder: group.target, special: shift.get(x.special)! });
      ids.push(x.id);
    } else if (params === 'range' && shift.has(x.special) && shift.has(x.special2)) {
      kept.push({ ...x, folder: group.target, special: shift.get(x.special)!, special2: shift.get(x.special2)! });
      ids.push(x.id);
    }
    // Any other card of the folder played all of it: the episode's own card does that now.
  }
  c.extraCards = kept;
  T.updatedAt = now;
  return ids;
}

/** The old folder is gone from the card: so is its entry. */
export function applyRemoval(c: Catalog, member: PackMember): void {
  delete c.folders[member.name];
}

/** The number in a track's file name ("019 Intro.mp3" → 19). */
function trackNo(file: string): number {
  return Number(/^(\d{1,4})/.exec(file)?.[1] ?? 0);
}

/**
 * The target's tracks in the order of the episodes, for planReorder; null
 * when they are in that order already. Members that did not arrive (a run
 * that stopped) are left out, a track the plan does not know stays at the end.
 */
export function reorderList(group: PackGroup, folder: SdFolder): string[] | null {
  const there = new Map(folder.tracks.map((t) => [t.name.toLowerCase(), t]));
  const byNumber = [...folder.tracks].sort((a, b) => a.number - b.number).map((t) => t.name);
  const list: string[] = [];
  for (const n of group.order) {
    const m = group.members.find((x) => x.number === n);
    const files = m ? (n === group.target ? m.own.map((o) => o.file) : m.tracks.map((t) => t.to)) : [];
    for (const f of files) {
      const t = there.get(f.toLowerCase());
      if (t && !list.includes(t.name)) list.push(t.name);
    }
  }
  for (const f of byNumber) if (!list.includes(f)) list.push(f);
  return list.every((f, i) => f === byNumber[i] && there.get(f.toLowerCase())?.number === i + 1) ? null : list;
}

/**
 * The cards for single tracks or a part of `folder` follow their tracks to
 * the numbers of a new order (`list`: the files, track 1 first). Returns
 * the ids of the cards that play other numbers now: they are to be written anew.
 */
export function remapCards(c: Pick<Catalog, 'extraCards'>, folder: number, list: readonly string[]): string[] {
  const to = new Map(list.map((f, i) => [trackNo(f), i + 1]));
  const ids: string[] = [];
  for (const x of c.extraCards) {
    if (x.folder !== folder) continue;
    const params = modeByCode(x.mode)?.params;
    if (params !== 'track' && params !== 'range') continue;
    const a = to.get(x.special);
    const b = params === 'range' ? to.get(x.special2) : undefined;
    if (a === undefined || (params === 'range' && b === undefined)) continue;
    if (a === x.special && (params !== 'range' || b === x.special2)) continue;
    x.special = a;
    if (params === 'range') x.special2 = b!;
    ids.push(x.id);
  }
  return ids;
}

/* ------------------------------------------------------------------ run */

export interface PackProgress {
  /** Bytes copied and checked so far, of `total`. */
  done: number;
  total: number;
  /** The folder being packed. */
  folder: number;
  title: string;
}

export interface PackRunOptions {
  /** 'copy': copy, check, then delete (a card written directly). 'move': move the files (a snapshot, see above). */
  how: 'copy' | 'move';
  signal?: AbortSignal;
  onProgress?: (p: PackProgress) => void;
  /**
   * The tracks of `member` are in the target under their real names: note
   * them (catalog). When this throws, the copies go again and the run stops
   * with the old folder as it was.
   */
  arrived: (group: PackGroup, member: PackMember, first: boolean) => Promise<void>;
  /** The old folder is gone from the card. */
  removed: (group: PackGroup, member: PackMember) => Promise<void>;
}

export interface PackRunResult {
  /** Folders that went into their target, in order. */
  packed: { group: PackGroup; member: PackMember }[];
  /** Folders whose tracks arrived but whose old folder could not be deleted completely. */
  stuck: number[];
  /** Why the run stopped early, in plain German; undefined when everything went through or it was stopped on purpose. */
  error?: string;
  cancelled?: boolean;
}

/** A Dir that copies a file natively, without the bytes passing through the page (desktop, see rebuild.ts). */
interface NativeCopyDir extends Dir {
  copyFrom(name: string, source: ByteSource, opts?: WriteOptions): Promise<void>;
}

const nativeCopy = (d: Dir): d is NativeCopyDir => typeof (d as Partial<NativeCopyDir>).copyFrom === 'function';
const isAbort = (e: unknown) => (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Copies a file and checks the copy against the original by size and CRC; a second try when the check fails. */
async function copyChecked(src: Dir, from: string, dst: Dir, to: string, signal: AbortSignal | undefined, onBytes: (n: number) => void): Promise<void> {
  const source = await src.source(from);
  let want: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (nativeCopy(dst) && source.path) await dst.copyFrom(to, source, { signal, onProgress: (n) => onBytes(n / 2) });
    else await dst.write(to, source.blob ?? (await src.read(from)), { signal, onProgress: (n) => onBytes(n / 2) });
    const copy = await dst.source(to);
    if (copy.size === source.size) {
      want ??= await crcOfSource(source, { signal });
      if ((await crcOfSource(copy, { signal, onProgress: (n) => onBytes(source.size / 2 + n / 2) })) === want) return;
    }
  }
  throw new Error(`„${from}“ kam nicht heil an: Die Kopie weicht vom Original ab.`);
}

/**
 * Packs the folders of a plan, one after the other (see the top of the
 * file). Stops at the first folder that does not go through; what went
 * through before stays packed.
 */
export async function runPack(root: Dir, plan: PackPlan, opts: PackRunOptions): Promise<PackRunResult> {
  const packed: PackRunResult['packed'] = [];
  const stuck: number[] = [];
  const total = plan.bytes;
  let done = 0;
  let first = true;
  try {
    for (const group of plan.groups) {
      const target = await root.dir(group.name);
      first = true;
      for (const member of group.members.slice(1)) {
        opts.signal?.throwIfAborted();
        const report = (extra = 0) => opts.onProgress?.({ done: Math.min(total, done + extra), total, folder: member.number, title: member.title });
        report();
        const dir = await root.dir(member.name);
        // The card as planned: every track still there, with its size; no name in the target taken.
        const now = new Map((await dir.list()).map((e) => [e.name.toLowerCase(), e.size]));
        for (const t of member.tracks) {
          if (now.get(t.from.toLowerCase()) !== t.size) throw new Error(`In Ordner ${member.name} hat sich etwas geändert. Lies die Karte neu ein.`);
        }
        const there = new Set((await target.list()).map((e) => e.name.toLowerCase()));
        const taken = member.tracks.find((t) => there.has(t.to.toLowerCase()));
        if (taken) throw new Error(`In Ordner ${group.name} gibt es ${taken.to} schon. Lies die Karte neu ein.`);

        if (opts.how === 'move') {
          for (const t of member.tracks) await dir.move(t.from, target, t.to);
          done += member.bytes;
        } else {
          const staged: string[] = [];
          try {
            for (const t of member.tracks) {
              opts.signal?.throwIfAborted();
              const name = t.to + PACK_STAGE_SUFFIX;
              staged.push(name);
              await copyChecked(dir, t.from, target, name, opts.signal, (n) => report(n));
              done += t.size;
            }
          } catch (e) {
            // Nothing of this folder stays behind half-done: the copies go, the original is untouched.
            for (const name of staged) await target.remove(name).catch(() => undefined);
            throw e;
          }
          // All of the folder is there and checked: now the copies get their real names, quickly one after the other.
          for (const t of member.tracks) await target.rename(t.to + PACK_STAGE_SUFFIX, t.to);
          const sizes = new Map((await target.list()).map((e) => [e.name.toLowerCase(), e.size]));
          const lost = member.tracks.find((t) => sizes.get(t.to.toLowerCase()) !== t.size);
          if (lost) {
            for (const t of member.tracks) await target.remove(t.to).catch(() => undefined);
            throw new Error(`${lost.to} in Ordner ${group.name} ist nach dem Umbenennen nicht mehr da. Ordner ${member.name} bleibt, wie er war.`);
          }
        }
        report();

        try {
          await opts.arrived(group, member, first);
        } catch (e) {
          // Without the note in the catalog the copies would be strangers in the target: they go, the old folder stays.
          if (opts.how === 'copy') for (const t of member.tracks) await target.remove(t.to).catch(() => undefined);
          else for (const t of member.tracks) await target.move(t.to, dir, t.from).catch(() => undefined);
          throw e;
        }
        first = false;
        packed.push({ group, member });

        // The old folder goes only now. What is left in it besides junk stays, and so does the folder then.
        let gone = true;
        try {
          if (opts.how === 'copy') for (const t of member.tracks) await dir.remove(t.from);
          const rest = await dir.list();
          if (rest.every((e) => isJunk(e.name))) {
            for (const e of rest) await dir.remove(e.name, { recursive: true });
            await root.remove(member.name);
          } else gone = false;
        } catch {
          gone = false;
        }
        if (gone) await opts.removed(group, member);
        else stuck.push(member.number);
      }
    }
  } catch (e) {
    if (isAbort(e) || opts.signal?.aborted) return { packed, stuck, cancelled: true };
    return { packed, stuck, error: message(e) };
  }
  return { packed, stuck };
}

/** Old folders' cover entries that can go once their folders are gone (their episode cards have a copy). */
export function coversToDrop(packedMembers: readonly PackMember[]): string[] {
  return packedMembers.flatMap((m) => (m.cover ? [m.cover.from] : []));
}

/** How many cards are written for the folders of a plan today, as far as the catalog knows: their own and the further ones. */
export function cardsBefore(plan: PackPlan, c: Pick<Catalog, 'extraCards'> | null): number {
  const numbers = new Set(plan.groups.flatMap((g) => g.members.map((m) => m.number)));
  return numbers.size + (c?.extraCards.filter((x) => numbers.has(x.folder)).length ?? 0);
}
