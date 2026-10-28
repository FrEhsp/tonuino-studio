/**
 * One card at a time („Karte beschreiben“, 0.6): the folder, how the card
 * plays, and the one item the ways of writing take (ReaderPanel, BoxPanel,
 * QrPanel, UsbPanel, WifiPanel all take a list of CardItems).
 */
import type { TngRelease } from '../../core/tonuino/boxguide';
import type { CardData, FirmwareProfile } from '../../core/tonuino/card';
import { checkCardAgainstSd, describeCard, modeByCode } from '../../core/tonuino/modes';
import { folderName } from '../../core/tonuino/sd';
import { cardSummary, firmwareNeeds, supportProblem, type CardItem } from './items';

/**
 * The four ways a card plays that most cards need, each with one short
 * sentence (TonUINO NFC Tools: one sentence per mode). Everything else is
 * behind „Andere Arten …“. Mode 1 is the „Hörspiel“ of the box's own menu.
 */
export const FRONT_MODES: readonly { mode: number; name: string; text: string }[] = [
  { mode: 1, name: 'Hörspiel', text: 'ein Titel per Zufall' },
  { mode: 2, name: 'Album', text: 'alles der Reihe nach' },
  { mode: 3, name: 'Party', text: 'alles durcheinander' },
  { mode: 5, name: 'Hörbuch', text: 'merkt sich, wo ihr wart' },
];

/** The name of how a card plays, as the screen calls it. */
export function modeName(mode: number): string {
  const front = FRONT_MODES.find((m) => m.mode === mode)?.name;
  if (front) return front;
  const name = modeByCode(mode)?.name;
  // Mode 7 is mode 1 for a part of the folder, so it carries the same name here (Prüfrunde 1, bastler 19).
  return name?.replace(/^Zufällige Folge/, 'Hörspiel') ?? `Modus ${mode}`;
}

/** Whether a card is one of the four in front: one whole folder, nothing more to set. */
export function isFrontCard(d: Pick<CardData, 'mode' | 'special' | 'special2'>): boolean {
  return FRONT_MODES.some((m) => m.mode === d.mode) && d.special === 0 && d.special2 === 0;
}

/** What is on the card, in one line: „Ordner 14 · Hörbuch“, „Ordner 03 · Einzeltitel · Titel 4“. */
export function cardLine(d: CardData): string {
  const head = `Ordner ${folderName(d.folder)} · ${modeName(d.mode)}`;
  if (isFrontCard(d)) return head;
  const rest = cardSummary(d)
    .split(' · ')
    .slice(1)
    .filter((p) => !/^\d+ Titel$/.test(p));
  return [head, ...rest].join(' · ');
}

/** The folder after `n`, for „Nächste Karte“; none after 99. */
export function nextFolder(n: number): number | null {
  return n < 99 ? n + 1 : null;
}

/** The first free folder number from `from` on (not on the card and not waiting in the app), or null when all 99 are taken. */
export function firstFreeFolder(taken: ReadonlySet<number>, from = 1): number | null {
  for (let n = Math.max(1, from); n <= 99; n++) if (!taken.has(n)) return n;
  return null;
}

export interface SingleContext {
  /** The folder's name on the box, if the box is known. */
  title?: string;
  /** Tracks per folder on the open SD card; undefined without a card (nothing to check then). */
  trackCount?: (folder: number) => number | undefined;
  profile: FirmwareProfile;
  release?: TngRelease;
  /** Counts up for each card of a run, so the same card can be written twice (writeCards skips items it did). */
  copy?: number;
}

/** The one card to write, as the ways of writing take it. */
export function singleItem(data: CardData, ctx: SingleContext): CardItem {
  const tracks = ctx.trackCount?.(data.folder);
  return {
    key: `k${data.folder}-${data.mode}-${data.special}-${data.special2}#${ctx.copy ?? 0}`,
    folder: data.folder,
    title: ctx.title || `Ordner ${folderName(data.folder)}`,
    description: describeCard(data, ctx.profile),
    summary: cardSummary(data, tracks),
    data,
    problems: ctx.trackCount ? checkCardAgainstSd(data, ctx.trackCount) : [],
    unsupported: supportProblem(data, ctx.profile, ctx.release),
    needs: firmwareNeeds(data, ctx.profile, ctx.release),
  };
}

/** „Bei dir: …“ after „Spielt Ordner 3.“: its name, else what the card holds in it (Prüfrunde 1, bastler 16). */
export function folderWords(title: string | undefined, tracks: number | undefined): string {
  if (title) return `Bei dir: ${title}`;
  if (tracks === undefined) return '';
  if (!tracks) return 'Bei dir ist der Ordner noch leer.';
  return `Bei dir: ${tracks === 1 ? '1 Titel' : `${tracks} Titel`}, noch ohne Namen.`;
}
