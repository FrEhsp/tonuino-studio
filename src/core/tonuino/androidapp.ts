import type { CardData } from './card';

/**
 * How the Android app „TonUINO NFC Tools“ (marc136, version 1.0.3, the
 * newest, on F-Droid) copes with a card that reaches it through a QR code.
 * Checked against its source:
 *
 * - Writing from the list („Liste eingeben“) never looks at the mode: the
 *   app turns the hex of each line into bytes and writes them as they are
 *   (BulkEditViewModel.kt TagWithComment.of, BulkWriteFragment.kt
 *   writeTag). So every card of the codes gets written.
 * - Reading does look at it. Held to the phone on the app's start screen, a
 *   card opens ReadActivity, which names the mode from a list of 14 entries
 *   without checking the bounds (ReadActivity.kt, `edit_mode[mode - 1]`).
 *   Any mode from 15 up crashes the app there, whatever the folder:
 *   Teekesselchen (15), Hörbuch, Teil eines Ordners (16) and the admin card
 *   of the box (folder 0, mode 255). That is the crash of forum 2151#208.
 * - The app knows the card formats up to TNG 3.1 (its README): modes 1 to 14
 *   and modifier cards 1 to 7. It shows modifier cards under the names of
 *   the playback modes.
 *
 * - 'readCrash': written fine, but the app crashes when it reads the card.
 * - 'unknown': newer than the app, written as it is; worth a check at the box.
 * - 'ok': a card the app knows.
 *
 * To check before a release, with NFC Tools 1.0.3 from F-Droid on a real
 * phone: list-writing cards with mode 15, 16 and 255, and reading them back.
 */
export type PhoneAppSupport = 'ok' | 'unknown' | 'readCrash';

/** The app's list of playback modes has 14 entries; a higher mode is read past its end. */
const LAST_NAMED_MODE = 14;
/** Modifier cards up to Bluetooth (7) are in the app; Jukebox and later are not. */
const LAST_KNOWN_MODIFIER = 7;
/** Hörbuch and Hörbuch Stück für Stück: special2 > 0 is the surprise folder of TNG 3.3.3. */
const FOLDER_RANGE_MODES = [5, 10];

export function androidAppSupport(card: CardData): PhoneAppSupport {
  if (card.mode > LAST_NAMED_MODE) return 'readCrash';
  // Mode 0 is shown as „unbekannt“, without a crash.
  if (card.mode === 0) return 'unknown';
  if (card.folder === 0) {
    // Jukebox (8) to Endlos (11) and the Memory cards the box writes (folder 0, mode 13) are newer than the app.
    return card.mode <= LAST_KNOWN_MODIFIER ? 'ok' : 'unknown';
  }
  if (FOLDER_RANGE_MODES.includes(card.mode) && card.special2 > 0) return 'unknown';
  return 'ok';
}

export interface PhoneAppSplit<T> {
  /** Cards the app writes but crashes on when it reads them back. */
  readCrash: T[];
  /** Cards newer than the app: worth a check at the box. */
  unknown: T[];
}

/** Titles in quotes, joined the German way; a long list ends with how many are left out. */
function quoted(titles: string[]): string {
  const max = 6;
  const shown = titles.slice(0, titles.length > max ? max - 1 : max).map((t) => `„${t}“`);
  const rest = titles.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} und ${rest} weitere`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} und ${shown[shown.length - 1]}`;
}

/** Cards in the codes that the phone app cannot read back without crashing. */
export function readCrashNotice(titles: string[]): string {
  if (titles.length === 1) {
    return `Die Handy-App kann „${titles[0]}“ schreiben, aber nicht auslesen. Halte die Karte danach nicht zum Prüfen ans Handy, sonst stürzt die App ab. Prüfe sie lieber an der Box.`;
  }
  return `Die Handy-App kann diese Karten schreiben, aber nicht auslesen: ${quoted(titles)}. Halte sie danach nicht zum Prüfen ans Handy, sonst stürzt die App ab. Prüfe sie lieber an der Box.`;
}

/**
 * Writing the cards of the codes with the app, step by step: on the screen
 * and on the printed sheet. `several`: more than one code; `paper`: for the
 * sheet, where the codes are not "below".
 */
export function phoneAppSteps(several: boolean, paper = false): string[] {
  return [
    'Öffne in der App „Liste eingeben“ und tippe auf „QRCode einlesen“.',
    `Scanne ${several ? 'den ersten Code' : 'den Code'}${paper ? '' : ' unten'}. Die Karten erscheinen als Liste. Tippe auf „Abarbeiten starten“.`,
    'Halte die erste Karte an die Rückseite des Handys. Sobald die App sie erkennt, tippe auf „Daten auf Tag … schreiben“.',
    'Meldet die App „Erfolg“, tippe auf „Nächste Zeile“ und halte die nächste Karte ans Handy. Nach der letzten Karte tippst du auf „OK“.',
    ...(several ? ['Für den nächsten Code gehst du in der App zurück zum Startbildschirm und öffnest „Liste eingeben“ neu. Sonst fängt die App nicht bei der ersten Karte an.'] : []),
  ];
}

/** One line for the printed sheet, under the marked titles. */
export const READ_CRASH_SHEET_NOTE = '* Diese Karten kann die App schreiben, aber nicht auslesen. Nicht zum Prüfen ans Handy halten, sonst stürzt die App ab.';

/** Cards in the codes that the phone app may not know. */
export function unknownNotice(titles: string[]): string {
  if (titles.length === 1) return `„${titles[0]}“ ist neuer als die Handy-App. Prüfe die Karte nach dem Schreiben an der Box.`;
  return `Diese Karten sind neuer als die Handy-App: ${quoted(titles)}. Prüfe sie nach dem Schreiben an der Box.`;
}

/** Picks out the cards the notices name, keeping their order. Every card stays in the codes. */
export function splitForPhoneApp<T>(items: T[], cardOf: (item: T) => CardData): PhoneAppSplit<T> {
  const out: PhoneAppSplit<T> = { readCrash: [], unknown: [] };
  for (const item of items) {
    const support = androidAppSupport(cardOf(item));
    if (support === 'readCrash') out.readCrash.push(item);
    else if (support === 'unknown') out.unknown.push(item);
  }
  return out;
}
