import type { FirmwareProfile } from './card';

/**
 * Which keys open the admin menu and which erase the settings at power-on,
 * in words for every text of the app. The keys are named, never counted:
 * a box with five keys has more than three (tests/tonuino/keytexts.test.ts).
 *
 * - TonUINO-TNG src/buttons.cpp, getCommandRaw(): allLong is Play/Pause, Vor
 *   and Zurück held together for a second; with FIVEBUTTONS Play/Pause,
 *   Lauter and Leiser as well. The box speaks while the keys are still held.
 * - TNG Buttons::isReset() (called by Tonuino::setup()): Play/Pause, Vor and
 *   Zurück pressed at power-on erase the settings, also with five keys;
 *   Lauter and Leiser play no part.
 * - TonUINO 2.1 Tonuino.ino: loop() opens the menu with Pause, Up and Down
 *   held and only after they are let go, with three keys and with five;
 *   setup() erases the settings with the same three at power-on.
 *
 * So "Play/Pause, Vor und Zurück" is right on every box; only TNG with five
 * keys has a second way in.
 */

/** Number of keys; a 3×3 keypad box counts as 3 (the pad does not take part). Undefined: not known. */
export type KeyCount = 3 | 5;

export type KeyName = 'Play/Pause' | 'Vor' | 'Zurück' | 'Lauter' | 'Leiser';

/** The keys of the admin menu on every box, as a list. */
export const ADMIN_KEYS = 'Play/Pause, Vor und Zurück';
/** TNG with five keys only: the second combination. */
export const ADMIN_KEYS_FIVE = 'Play/Pause, Lauter und Leiser';
/** The keys that erase the settings when held at power-on: the same on every box. */
export const RESET_KEYS = ADMIN_KEYS;

/** "3", "5" or "3x3" as the box reports it, as a count. */
export function keyCount(buttons: string | number | undefined): KeyCount | undefined {
  if (buttons === 5 || buttons === '5') return 5;
  if (buttons === 3 || buttons === '3' || buttons === '3x3') return 3;
  return undefined;
}

/** Each combination that opens the admin menu by keys. */
export function adminKeyCombos(profile: FirmwareProfile, buttons?: KeyCount): KeyName[][] {
  const combos: KeyName[][] = [['Play/Pause', 'Vor', 'Zurück']];
  if (profile === 'tng' && buttons === 5) combos.push(['Play/Pause', 'Lauter', 'Leiser']);
  return combos;
}

/** "Play/Pause, Vor und Zurück", with five TNG keys "… oder Play/Pause, Lauter und Leiser". */
export function adminKeys(profile: FirmwareProfile, buttons?: KeyCount): string {
  return adminKeyCombos(profile, buttons).map(listKeys).join(' oder ');
}

/** "Play/Pause, Vor und Zurück" */
export function listKeys(keys: readonly string[]): string {
  return keys.length < 2 ? (keys[0] ?? '') : `${keys.slice(0, -1).join(', ')} und ${keys[keys.length - 1]}`;
}

/** How to open the admin menu with the keys, one or two sentences. */
export function adminOpenText(profile: FirmwareProfile, buttons?: KeyCount): string {
  if (profile === 'classic21') {
    return `Halte ${ADMIN_KEYS} gleichzeitig etwa eine Sekunde gedrückt und lasse sie dann los. Die Box spricht, sobald du loslässt.`;
  }
  const five = buttons === 5 ? ` Mit ${ADMIN_KEYS_FIVE} zusammen geht es auch.` : '';
  return `Halte ${ADMIN_KEYS} gleichzeitig gedrückt, bis die Box spricht, und lasse dann los.${five}`;
}

/** Erasing all settings by keys: the first half of a sentence, "Halte beim Einschalten … gedrückt". */
export const RESET_AT_START = `Halte beim Einschalten ${RESET_KEYS} gedrückt`;
