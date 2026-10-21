import { decodeCard, encodeCard, type CardData } from '../../core/tonuino/card';
import type { NfcAccess, NfcCardInfo, NfcReadResult } from '../../platform/types';

/** The card reader as one run of writing sees it. */
export interface ReaderPort {
  /** Resolves with the card on the reader; null when the run was stopped. */
  waitForCard(signal: AbortSignal): Promise<NfcCardInfo | null>;
  /** Resolves true once the card is off the reader; false when the run was stopped. */
  waitForRemoval(uid: string, signal: AbortSignal): Promise<boolean>;
  read(): Promise<{ data: Uint8Array; uid?: string }>;
  /** Writes the card `uid`; the phone refuses when another card came meanwhile (code 'wrong-card'). */
  write(data: Uint8Array, uid: string): Promise<void>;
}

/** What a run remembers across "Anhalten" and "Weiter beschreiben". */
export interface RunMemory {
  /** Card number → key of the item written onto that card. */
  writtenTo: Map<string, string>;
  /** Items that have their card. */
  done: Set<string>;
  /** The user chose to overwrite cards that hold something else without asking again ("Immer überschreiben"). */
  overwriteAll?: boolean;
  /**
   * Card number → item whose write onto that card broke off (card taken
   * away too early). What is on it now came from this run: writing the same
   * item again needs no question.
   */
  begun?: Map<string, string>;
}

export interface RunEvents {
  /** Waiting for the card of items[index]. */
  waiting(index: number): void;
  /** The card on the reader holds the item `key` from earlier in this run. */
  clash(uid: string, key: string): void;
  /**
   * The card on the reader holds something else from before this run (a
   * TonUINO card or other data, `data` as read): it is not overwritten
   * unless the parent asks for exactly this card (`overwrite`), as with a clash.
   */
  occupied(uid: string, data: Uint8Array): void;
  writing(): void;
  /** Written. `replaced` is the item the card held before, which has no card now. */
  written(key: string, before: CardData | undefined, replaced: string | undefined): void;
  /** Waiting for the card to be taken off. */
  remove(): void;
}

export type RunEnd = { kind: 'done' } | { kind: 'stopped' } | { kind: 'failed'; key: string; error: unknown };

export function newRunMemory(): RunMemory {
  return { writtenTo: new Map(), done: new Set() };
}

/**
 * Writes the items from `start` on that have no card yet, one card each.
 * A card written earlier in this run for another item is not overwritten:
 * it was put back by mistake or never taken off before "Anhalten". Neither
 * is a card that holds something else from before (forum 14978#67: cards
 * overwritten by mistake), unless it holds exactly this item already. The
 * run waits until such a card is off, unless the parent chose to overwrite
 * exactly that card (`overwrite`, its number).
 */
export async function writeCards(items: { key: string; data: CardData }[], start: number, port: ReaderPort, memory: RunMemory, events: RunEvents, signal: AbortSignal, overwrite?: string): Promise<RunEnd> {
  let allowed = overwrite;
  let lostReads = 0;
  let swaps = 0;
  for (let i = start; i < items.length; i++) {
    const item = items[i];
    if (memory.done.has(item.key)) continue;
    events.waiting(i);
    const info = await port.waitForCard(signal);
    if (!info) return { kind: 'stopped' };
    const earlier = memory.writtenTo.get(info.uid);
    const replaced = earlier !== undefined && earlier !== item.key ? earlier : undefined;
    if (replaced !== undefined && info.uid !== allowed) {
      events.clash(info.uid, replaced);
      if (!(await port.waitForRemoval(info.uid, signal))) return { kind: 'stopped' };
      i--;
      continue;
    }
    const permitted = info.uid === allowed || memory.overwriteAll || memory.begun?.get(info.uid) === item.key;
    allowed = undefined;
    events.writing();
    let before: CardData | undefined;
    let raw: Uint8Array | undefined;
    // The card whose content was judged here is the one to write, not one that came since.
    let uid = info.uid;
    try {
      const got = await port.read();
      raw = got.data;
      uid = got.uid ?? uid;
      const old = decodeCard(raw);
      if (old.kind === 'tonuino') before = old.data;
      lostReads = 0;
    } catch (e) {
      // The card left while it was read: the write would go to whatever card comes next, unread (Testlabor #69).
      // A card that keeps answering and losing itself gets its write after a few tries, which then tells why.
      if (isCardGone(e) && ++lostReads < 3) {
        i--;
        continue;
      }
      // Unreadable content is fine, the write tells whether the card works.
    }
    if (raw && !permitted && replaced === undefined && holdsOther(raw, item.data)) {
      events.occupied(info.uid, raw);
      if (!(await port.waitForRemoval(info.uid, signal))) return { kind: 'stopped' };
      i--;
      continue;
    }
    try {
      await port.write(encodeCard(item.data), uid);
    } catch (error) {
      if (signal.aborted) return { kind: 'stopped' };
      // Another card came between reading and writing: nothing was written, look at the card that is there now (Testlabor #69).
      if ((error as { code?: unknown } | null)?.code === 'wrong-card' && ++swaps < 3) {
        i--;
        continue;
      }
      (memory.begun ??= new Map()).set(info.uid, item.key);
      return { kind: 'failed', key: item.key, error };
    }
    memory.begun?.delete(info.uid);
    memory.writtenTo.set(info.uid, item.key);
    memory.done.add(item.key);
    if (replaced !== undefined) memory.done.delete(replaced);
    events.written(item.key, before, replaced);
    events.remove();
    if (!(await port.waitForRemoval(info.uid, signal))) return { kind: 'stopped' };
  }
  return { kind: 'done' };
}

/** The card left the reader or the phone (not: it answered with an error). */
function isCardGone(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'tag-lost' || code === 'no-card';
}

/** Whether a card holds something other than `want`: a TonUINO card for something else, or other data. Empty cards hold nothing. */
export function holdsOther(raw: Uint8Array, want: CardData): boolean {
  const old = decodeCard(raw);
  if (old.kind === 'empty') return false;
  if (old.kind !== 'tonuino') return true;
  const d = old.data;
  return d.folder !== want.folder || d.mode !== want.mode || d.special !== want.special || d.special2 !== want.special2;
}

/** How long "Karte prüfen" and "Karte löschen" wait on the phone for a card to come. */
export const PHONE_CARD_WAIT_MS = 20_000;

/**
 * Reads the card on the reader. A phone has no card lying on it: there the
 * read waits until a card comes to the phone (or the last one still answers),
 * and resolves null when none came in time.
 */
export async function readCardNow(nfc: NfcAccess, reader: string, waitMs = PHONE_CARD_WAIT_MS): Promise<NfcReadResult | null> {
  if (nfc.phone && !(await nfc.waitForCard(reader, waitMs))) return null;
  return nfc.read(reader);
}
