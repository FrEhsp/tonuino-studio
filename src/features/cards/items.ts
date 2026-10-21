import { computed, effect, signal } from '@preact/signals';
import { singleTrackRuns, type TngRelease } from '../../core/tonuino/boxguide';
import { ADMIN_MODE, type CardData, type FirmwareProfile } from '../../core/tonuino/card';
import { asFormat20, format20, FORMAT20_NOTE } from './format20';
import { buildShelf, CONTENT_KINDS, newId, type Catalog, type CatalogFolder, type ContentKind, type ExtraCard, type FolderCard, type StickerTweaks } from '../../core/tonuino/catalog';
import { checkCardAgainstSd, describeCard, modeByCode, modifierNeeds, modifiersFor, modifierUnsupportedFor, QUIZ_VARIANTS, sleepMinutesOf, specialSummary, TNG_SEPTEMBER_2026 } from '../../core/tonuino/modes';
import { folderName, MAX_FOLDER, type SdScan } from '../../core/tonuino/sd';
import { toastError } from '../../ui/components/Toast';
import { boxScan, cardCatalog, catalog, profile, selection, settings, shownMemory, updateCatalog } from '../../app/state';

/** One card the page can write: a folder's card or a special card. */
export interface CardItem {
  key: string;
  /** Folder cards: the folder, for the cover and the selection. */
  folder?: number;
  extra?: ExtraCard;
  title: string;
  /** One sentence, e.g. "Hörbuch: Ordner 05." */
  description: string;
  /** Short line for lists that already show the folder, e.g. "Hörbuch · 6 Titel". */
  summary: string;
  data: CardData;
  /** Mismatches with the SD card (missing folder, track out of range). */
  problems: string[];
  /** The box's firmware cannot play this card. */
  unsupported?: string;
  /** Only boxes with a certain firmware can use this card. */
  needs?: string;
  /** An extra card that does exactly what one higher up in the list does. */
  duplicate?: boolean;
}

/** Special cards picked on this page, by id. Folder cards use the shared `selection`. */
export const extraSelection = signal<Set<string>>(new Set());

/** Special cards while no SD card is open: kept for this session only. */
export const looseExtras = signal<ExtraCard[]>([]);

/** The open card's cards; without one, those of the remembered box (shownMemory) and the ones made here. */
export const extras = computed<ExtraCard[]>(() => cardCatalog.value?.extraCards ?? [...(catalog.value?.extraCards ?? []), ...looseExtras.value]);

/** The remembered box's own cards stay as they are; the ones made without a card can go. */
export function canRemoveExtra(item: CardItem): boolean {
  return !!cardCatalog.value || looseExtras.value.some((x) => x.id === item.extra?.id);
}

export function folderCardData(folder: number, folderCard: FolderCard | undefined, kind?: ContentKind): CardData {
  const mode = folderCard?.mode ?? CONTENT_KINDS.find((k) => k.id === (kind ?? 'hoerspiel'))?.defaultMode ?? 5;
  return { folder, mode, special: folderCard?.special ?? 0, special2: folderCard?.special2 ?? 0 };
}

/** Whether `value` plays the folder just as its own card does now (set, or the default of its kind). */
export function keepsFolderCard(entry: Pick<CatalogFolder, 'card' | 'kind'> | undefined, value: FolderCard): boolean {
  return sameCard(folderCardData(0, value, entry?.kind), folderCardData(0, entry?.card, entry?.kind));
}

/**
 * Sets how a folder's own card plays. The default of the folder's kind is
 * not stored, so the card keeps following the kind until the family picks
 * something else.
 */
export function applyFolderCard(e: Pick<CatalogFolder, 'card' | 'kind'>, value: FolderCard): void {
  if (keepsFolderCard({ kind: e.kind }, value)) delete e.card;
  else e.card = value;
}

/** Why the box cannot use this card, in plain German; undefined when it can. `release`: TNG only. */
export function supportProblem(data: CardData, prof: FirmwareProfile, release: TngRelease = 'unknown'): string | undefined {
  const box = prof === 'tng' ? 'Die Box' : 'TonUINO 2.1';
  if (data.folder === 0) {
    if (data.mode === ADMIN_MODE) return undefined;
    const mod = modifiersFor(prof).find((m) => m.code === data.mode);
    if (!mod) return `${box} kennt diese Spezialkarte nicht.`;
    return prof === 'tng' ? modifierUnsupportedFor(mod, release) : undefined;
  }
  const mode = modeByCode(data.mode);
  if (!mode) return `${box} kennt diesen Modus nicht.`;
  if (!mode.profiles.includes(prof)) return `${box} kennt den Modus „${mode.name}“ nicht.`;
  if (prof === 'classic21' && data.mode === 5 && data.special2 > 0) return 'Einen zufälligen Ordner aus mehreren kennt TonUINO 2.1 nicht.';
  if (prof === 'tng' && release === 'older' && randomFolder(data)) return `Deine Box ist älter als TNG ${TNG_SEPTEMBER_2026} und spielt mit dieser Karte nur Ordner ${folderName(data.folder)}.`;
  return undefined;
}

/** A Hörbuch card that picks one of several folders (Überraschungsordner): TNG only from TNG_SEPTEMBER_2026 on. */
function randomFolder(data: CardData): boolean {
  return data.folder !== 0 && (data.mode === 5 || data.mode === 10) && data.special2 > 0;
}

/** What a box needs for this card beyond its firmware family, in plain German. */
export function firmwareNeeds(data: CardData, prof: FirmwareProfile, release: TngRelease = 'unknown'): string | undefined {
  // Whether the box knows it yet, only the box itself shows: it asks for the last folder.
  if (prof === 'tng' && release === 'unknown' && randomFolder(data)) {
    return `Einen zufälligen Ordner aus mehreren gibt es erst ab TNG ${TNG_SEPTEMBER_2026}. Ältere Boxen spielen mit dieser Karte nur Ordner ${folderName(data.folder)}.`;
  }
  if (data.folder !== 0 || data.mode === ADMIN_MODE) return undefined;
  const mod = modifiersFor(prof).find((m) => m.code === data.mode);
  return mod ? modifierNeeds(mod, release) : undefined;
}

/**
 * A special card named under the other firmware, whose code means another
 * card on this one: code 3 is "Feuer, Wasser, Luft" on TNG, "Alles
 * gesperrt" on TonUINO 2.1.
 */
export function otherMeaning(x: ExtraCard, prof: FirmwareProfile): string | undefined {
  if (x.folder !== 0 || x.mode === ADMIN_MODE) return undefined;
  const mod = modifiersFor(prof).find((m) => m.code === x.mode);
  const other = modifiersFor(prof === 'tng' ? 'classic21' : 'tng').find((m) => m.code === x.mode);
  if (!mod || !other || other.name === mod.name || !x.label.startsWith(other.name)) return undefined;
  return `Mit ${prof === 'tng' ? 'TonUINO TNG' : 'TonUINO 2.1'} ist das die Karte „${mod.name}“: ${mod.tagline}`;
}

/**
 * Why a special card cannot be added again: it is in the list already. Under
 * another name (made for the other firmware, or named by hand) the note says
 * which, so it can be found there.
 */
export function alreadyListedNote(existing: ExtraCard, prof: FirmwareProfile): string {
  const there = 'Du kannst sie dort beschreiben, auch mehrmals.';
  const name = extraLabel(existing, prof);
  if (existing.label === name) return `Genau diese Karte ist schon in der Liste. ${there}`;
  const firmware = otherMeaning(existing, prof) ? ` Mit ${prof === 'tng' ? 'TonUINO TNG' : 'TonUINO 2.1'} ist das die Karte „${name}“.` : '';
  return `Diese Karte steht schon in der Liste, als „${existing.label}“.${firmware} ${there}`;
}

/** Names a choice of cards: changes whenever other cards are chosen, also the same number of different ones. */
export function choiceKey(items: readonly Pick<CardItem, 'key'>[]): string {
  return items.map((i) => i.key).join('|');
}

/** Two cards the box treats the same: same folder, mode and settings, in the same card format. */
export function sameCard(a: CardData, b: CardData): boolean {
  return a.folder === b.folder && a.mode === b.mode && a.special === b.special && a.special2 === b.special2 && (a.version ?? 2) === (b.version ?? 2);
}

/** The new cards that are not in the list yet, in their order; a card twice in `added` counts once. */
export function newCards<T extends { data: CardData }>(existing: readonly CardData[], added: readonly T[]): T[] {
  const seen = [...existing];
  const out: T[] = [];
  for (const c of added) {
    if (seen.some((e) => sameCard(e, c.data))) continue;
    seen.push(c.data);
    out.push(c);
  }
  return out;
}

/** Another card for an SD folder, besides the folder's own card (e.g. one per track). */
export function isFolderExtra(data: CardData): boolean {
  return data.folder >= 1 && data.folder <= MAX_FOLDER;
}

/**
 * Short name for a special card, e.g. "Schlummerkarte, 15 Minuten". Further
 * cards for a folder are named after their track or part of the folder.
 */
export function extraLabel(data: CardData, prof: FirmwareProfile, trackTitle?: (track: number) => string | undefined): string {
  if (data.folder === 0 && data.mode === ADMIN_MODE) return 'Admin-Karte';
  if (data.folder === 0) {
    const mod = modifiersFor(prof).find((m) => m.code === data.mode);
    if (!mod) return `Spezialkarte ${data.mode}`;
    if (mod.params === 'sleep') return `${mod.name}, ${sleepMinutesOf(data, prof)} Minuten${prof === 'tng' && data.special & 0x80 ? ' (bis Titelende)' : ''}`;
    return mod.name;
  }
  const mode = modeByCode(data.mode);
  if (isFolderExtra(data) && mode?.params === 'track') return trackTitle?.(data.special) || `Titel ${data.special}`;
  if (isFolderExtra(data) && mode?.params === 'range') return `Titel ${data.special} bis ${data.special2}`;
  return mode?.name ?? `Karte ${data.mode}`;
}

/** What a folder card does, without repeating the folder. */
export function cardSummary(data: CardData, tracks?: number): string {
  const mode = modeByCode(data.mode);
  if (!mode) return `Unbekannter Modus ${data.mode}`;
  const parts = [mode.name];
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (mode.params) {
    case 'track':
      parts.push(`Titel ${data.special}`);
      break;
    case 'range':
      parts.push(`Titel ${data.special} bis ${data.special2}`);
      break;
    case 'folderRangeTracks':
    case 'folderRange':
      if (mode.params === 'folderRangeTracks') parts.push(`${data.special + 1} Titel pro Auflegen`);
      if (data.special2 > 0) parts.push(`zufällig aus Ordner ${pad(data.folder)} bis ${pad(data.folder + data.special2)}`);
      else if (tracks) parts.push(`${tracks} Titel`);
      break;
    case 'quiz': {
      const v = QUIZ_VARIANTS.find((q) => q.special === data.special && q.special2 === data.special2);
      if (v) parts.push(v.label);
      break;
    }
    default:
      if (tracks && data.mode !== 11 && data.mode !== 14) parts.push(`${tracks} Titel`);
  }
  return parts.join(' · ');
}

/** What a further card for a folder does, without what its name says already, e.g. "Titel 1 bis 12". */
export function folderExtraSummary(data: CardData, label: string, tracks?: number): string {
  const rest = cardSummary(data, tracks)
    .split(' · ')
    .filter((part) => part !== label);
  return rest.length ? rest.join(' · ') : (modeByCode(data.mode)?.tagline ?? '');
}

/**
 * The name of a further card of a folder in the list: the folder, then the
 * card ("Die Olchis · Titel 1"). An episode of a packed series names the
 * series itself ("Unter meinem Bett 2" in "Unter meinem Bett"): then the
 * episode alone, the folder number stands next to it anyway.
 */
export function folderExtraTitle(folder: string, label: string): string {
  const f = folder.trim().toLocaleLowerCase('de');
  return f && label.trim().toLocaleLowerCase('de').startsWith(f) ? label : `${folder} · ${label}`;
}

export function trackCounts(scan: SdScan | undefined): Map<number, number> {
  const counts = new Map<number, number>();
  for (const f of scan?.folders ?? []) counts.set(f.number, new Set(f.tracks.map((t) => t.number)).size);
  return counts;
}

export function buildCardItems(scan: SdScan | undefined, cat: Catalog | null, extraCards: ExtraCard[], prof: FirmwareProfile, release: TngRelease = 'unknown'): CardItem[] {
  const counts = trackCounts(scan);
  const check = (data: CardData) => (scan ? checkCardAgainstSd(data, (n) => counts.get(n)) : []);
  const out: CardItem[] = [];
  if (scan) {
    for (const s of buildShelf(scan, cat)) {
      if (s.state === 'missing') continue;
      const data = folderCardData(s.number, s.entry?.card, s.entry?.kind);
      out.push({
        key: `f${s.number}`,
        folder: s.number,
        title: s.title,
        description: describeCard(data, prof),
        summary: cardSummary(data, counts.get(s.number)),
        data,
        problems: check(data),
        unsupported: supportProblem(data, prof, release),
        needs: firmwareNeeds(data, prof, release),
      });
    }
  }
  // Further cards for folders come right after the folder cards, by folder and track; then the special cards.
  const byFolder = (a: ExtraCard, b: ExtraCard) => a.folder - b.folder || a.mode - b.mode || a.special - b.special || a.special2 - b.special2;
  const forFolders = extraCards.filter(isFolderExtra).sort(byFolder);
  const listed: CardData[] = [];
  for (const x of [...forFolders, ...extraCards.filter((x) => !isFolderExtra(x))]) {
    const data: CardData = { folder: x.folder, mode: x.mode, special: x.special, special2: x.special2 };
    if (x.version === 1) data.version = 1;
    const duplicate = listed.some((d) => sameCard(d, data));
    listed.push(data);
    const description = describeCard(data, prof);
    const forFolder = isFolderExtra(data);
    out.push({
      key: `x:${x.id}`,
      extra: x,
      // A further card for a folder names the folder too: on the phone and on paper it stands without the list's groups.
      // Taken from the folder at hand, so a new folder name comes along.
      title: forFolder ? folderExtraTitle(cat?.folders[folderName(data.folder)]?.title || `Ordner ${folderName(data.folder)}`, x.label) : x.label,
      description,
      // The title names the special card already.
      summary: (data.version === 1 ? `${FORMAT20_NOTE} · ` : '') + (forFolder ? folderExtraSummary(data, x.label, counts.get(data.folder)) : specialSummary(data, prof)),
      data,
      problems: check(data),
      unsupported: supportProblem(data, prof, release),
      needs: firmwareNeeds(data, prof, release) ?? otherMeaning(x, prof),
      ...(duplicate ? { duplicate } : {}),
    });
  }
  return out;
}

export const cardItems = computed(() => {
  const items = buildCardItems(boxScan.value, catalog.value, extras.value, profile.value, settings.value.tngRelease);
  return format20.value ? asFormat20(items) : items;
});

/**
 * The walk-throughs at the box for these cards, as index ranges into `items`:
 * one per card, except single-track cards of a folder with tracks in a row,
 * which the box writes in one go.
 */
export function guideEntries(items: CardItem[]): { first: number; last: number }[] {
  const runs = singleTrackRuns(items.map((i) => i.data));
  const out: { first: number; last: number }[] = [];
  for (let i = 0, r = 0; i < items.length; ) {
    if (r < runs.length && runs[r][0] === i) {
      out.push({ first: i, last: runs[r][1] });
      i = runs[r][1] + 1;
      r++;
    } else {
      out.push({ first: i, last: i });
      i++;
    }
  }
  return out;
}

export function isSelected(item: CardItem): boolean {
  return item.folder !== undefined ? selection.value.has(item.folder) : extraSelection.value.has(item.extra!.id);
}

export function setSelected(item: CardItem, on: boolean) {
  if (item.folder !== undefined) {
    const next = new Set(selection.value);
    if (on) next.add(item.folder);
    else next.delete(item.folder);
    selection.value = next;
  } else {
    const next = new Set(extraSelection.value);
    if (on) next.add(item.extra!.id);
    else next.delete(item.extra!.id);
    extraSelection.value = next;
  }
}

export function selectAll(items: CardItem[], on: boolean) {
  const folders = new Set(selection.value);
  const ids = new Set(extraSelection.value);
  for (const i of items) {
    if (i.folder !== undefined) on ? folders.add(i.folder) : folders.delete(i.folder);
    else on ? ids.add(i.extra!.id) : ids.delete(i.extra!.id);
  }
  selection.value = folders;
  extraSelection.value = ids;
}

/** Adds a special card (saved with the SD card when one is open) and selects it. */
export async function addExtraCard(data: CardData, label: string) {
  await addExtraCards([{ data, label }]);
}

/** Adds several cards in one go, e.g. one per track of a folder, and selects them. */
export async function addExtraCards(cards: { data: CardData; label: string }[]) {
  const added: ExtraCard[] = cards.map(({ data, label }) => {
    const x: ExtraCard = { id: newId(), label, folder: data.folder, mode: data.mode, special: data.special, special2: data.special2 };
    if (data.version === 1) x.version = 1;
    return x;
  });
  if (cardCatalog.value) {
    await updateCatalog((c) => {
      c.extraCards.push(...added);
    });
  } else {
    looseExtras.value = [...looseExtras.value, ...added];
  }
  extraSelection.value = new Set([...extraSelection.value, ...added.map((x) => x.id)]);
}

/** Its own sticker for a further card of a folder ("Sticker anpassen"): text, section, colour; undefined follows the folder. */
export async function updateExtraSticker(id: string, sticker: StickerTweaks | undefined, color: string | undefined) {
  const apply = (x: ExtraCard): ExtraCard => {
    const next: ExtraCard = { ...x, sticker, color };
    if (!sticker) delete next.sticker;
    if (!color) delete next.color;
    return next;
  };
  if (cardCatalog.value) {
    await updateCatalog((c) => {
      c.extraCards = c.extraCards.map((x) => (x.id === id ? apply(x) : x));
    });
  } else if (shownMemory.value?.catalog.extraCards.some((x) => x.id === id)) {
    // A card of the remembered box: onto the SD card when it is open again.
    // Loaded only here: waiting.ts watches the card, which pages without stickers need not start.
    const { changeLookWithoutCard } = await import('../../app/waiting');
    await changeLookWithoutCard({ extra: id }, { sticker, color });
  } else {
    looseExtras.value = looseExtras.value.map((x) => (x.id === id ? apply(x) : x));
  }
}

export async function removeExtraCard(id: string) {
  if (cardCatalog.value) {
    await updateCatalog((c) => {
      c.extraCards = c.extraCards.filter((x) => x.id !== id);
    });
  } else {
    looseExtras.value = looseExtras.value.filter((x) => x.id !== id);
  }
  const next = new Set(extraSelection.value);
  next.delete(id);
  extraSelection.value = next;
}

function newExtras(existing: readonly ExtraCard[], added: readonly ExtraCard[]): ExtraCard[] {
  return newCards(
    existing,
    added.map((x) => ({ data: x, x })),
  ).map((c) => c.x);
}

/**
 * Special cards made before the SD card was read, taken into its list: the
 * ones it lacks are added, and for each one it has already, the card in its
 * list stands in (`same`: id of the loose card → id of that card).
 */
export function adoptLooseExtras(existing: readonly ExtraCard[], loose: readonly ExtraCard[]): { add: ExtraCard[]; same: Map<string, string> } {
  const add = newExtras(existing, loose);
  const same = new Map<string, string>();
  for (const x of loose) {
    if (add.includes(x)) continue;
    const twin = [...existing, ...add].find((e) => sameCard(e, x));
    if (twin) same.set(x.id, twin.id);
  }
  return { add, same };
}

// Once an SD card is open, the special cards made without it go into its list, with their selection.
effect(() => {
  const cat = cardCatalog.value;
  const loose = looseExtras.value;
  if (!cat || !loose.length) return;
  looseExtras.value = [];
  const { add, same } = adoptLooseExtras(cat.extraCards, loose);
  if (same.size) {
    extraSelection.value = new Set([...extraSelection.peek()].map((id) => same.get(id) ?? id));
  }
  if (add.length) {
    updateCatalog((c) => {
      c.extraCards.push(...newExtras(c.extraCards, add));
    }).catch((e) => toastError('Die Spezialkarten ließen sich nicht übernehmen', e));
  }
});

/** Note when some of the cards a dialog would add are in the list already. */
export function partialDuplicateNote(already: number): string {
  return already === 1
    ? 'Eine dieser Karten ist schon in der Liste. Sie kommt nicht doppelt dazu.'
    : `${already} dieser Karten sind schon in der Liste. Sie kommen nicht doppelt dazu.`;
}
