/**
 * The Android app answers a card held to the phone at once, like the
 * TonUINO app and "NFC Tools": the cards page shows what is on it, with
 * "Nachmachen", "Ändern …" and, when cards are chosen, writing right onto
 * it. The phone's reader mode is on as long as the app is in the front, so
 * Android neither beeps for another app nor offers one.
 *
 * A card that a running write, "Karte prüfen" or "Karte löschen" waits for
 * never comes here (AndroidNfc hands it to them); `holdTaps` covers the
 * moments in between, for example while a written card is taken away.
 */
import { signal } from '@preact/signals';
import type { NfcAccess, NfcCardInfo, NfcCardType } from '../../platform/types';
import { navigate, route, type Route } from '../../app/router';

/** The card held to the phone last, as the cards page shows it. */
export interface TappedCard {
  uid: string;
  type: NfcCardType;
  /** Counts the cards, so the page notices the same card held once more. */
  seq: number;
  /** True while the card is read. */
  busy: boolean;
  data?: Uint8Array;
  error?: string;
}

export const tappedCard = signal<TappedCard | null>(null);

let holds = 0;

/** While the returned function is not called, cards held to the phone are left alone here. */
export function holdTaps(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

export function tapsHeld(): boolean {
  return holds > 0;
}

/**
 * What a card held to the phone does. On the cards page it shows there.
 * Elsewhere the app goes to the cards page, unless a dialog is open or the
 * workshop is shown (a box being flashed or tested there keeps the screen);
 * then a short note offers the way.
 */
export type TapPlan = 'ignore' | 'show' | 'open' | 'note';

export function tapPlan(s: { held: boolean; page: Route['page']; dialogOpen: boolean }): TapPlan {
  if (s.held) return 'ignore';
  if (s.page === 'cards') return 'show';
  if (s.dialogOpen || s.page === 'workshop') return 'note';
  return 'open';
}

export interface TapDeps {
  page(): Route['page'];
  dialogOpen(): boolean;
  open(): void;
  /** The short note with a button to the cards page; `text` says what is on the card. */
  note(text: string): void;
  /** One sentence on what the card holds (ReadCardActions.readCardText). */
  describe(data: Uint8Array): string;
  /** The reader name of the phone for nfc.read. */
  reader: string;
}

let seq = 0;

/** Reads the card that came and shows it the way tapPlan says. Resolves once it is read. */
export async function handleTap(nfc: NfcAccess, card: NfcCardInfo, deps: TapDeps): Promise<void> {
  const plan = tapPlan({ held: tapsHeld(), page: deps.page(), dialogOpen: deps.dialogOpen() });
  if (plan === 'ignore') return;
  const mine = ++seq;
  const base = { uid: card.uid, type: card.type, seq: mine };
  if (plan === 'show' || plan === 'open') tappedCard.value = { ...base, busy: true };
  if (plan === 'open') deps.open();
  let shown: TappedCard;
  try {
    const r = await nfc.read(deps.reader);
    shown = { ...base, uid: r.uid, type: r.type, busy: false, data: r.data };
  } catch (e) {
    shown = { ...base, busy: false, error: e instanceof Error ? e.message : String(e) };
  }
  // A newer card came while this one was read: that one counts.
  if (mine !== seq) return;
  if (plan === 'note') {
    // The page is not left: only a card read well is worth the note.
    if (!shown.data) return;
    tappedCard.value = shown;
    deps.note(deps.describe(shown.data));
    return;
  }
  tappedCard.value = shown;
}

/** The default ways of the app; tests pass their own. */
function appDeps(reader: string, describe: (data: Uint8Array) => string, note: (text: string) => void): TapDeps {
  return {
    page: () => route.value.page,
    dialogOpen: () => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-dialog'),
    open: () => navigate({ page: 'cards' }),
    note,
    describe,
    reader,
  };
}

/**
 * Turns the phone's reader mode on for good and answers every card. Only
 * for the phone (`nfc.phone` with `onTap`); returns how to stop it again.
 */
export function startNfcTaps(nfc: NfcAccess, reader: string, describe: (data: Uint8Array) => string, note: (text: string) => void, deps?: TapDeps): () => void {
  if (!nfc.phone || !nfc.onTap) return () => undefined;
  const d = deps ?? appDeps(reader, describe, note);
  return nfc.onTap((card) => void handleTap(nfc, card, d));
}
