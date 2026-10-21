/**
 * The browser does not say how a card is formatted, but the times of its
 * files give a hint: FAT keeps modification times in steps of two seconds,
 * exFAT in steps of 10 ms and NTFS in steps of 100 ns. A time between two
 * full even seconds can therefore not come from FAT.
 *
 * Even times prove nothing: copied files keep the time of their source, and
 * files unpacked from a ZIP carry its two-second times on any card. So the
 * guess only ever says "not FAT" or "unknown", never "FAT".
 */

export type FsGuess = 'not-fat' | 'unknown';

/** How many file times off the two-second grid it takes; one could be a fluke of the source. */
export const OFF_GRID_NEEDED = 3;

const FAT_STEP_MS = 2000;

/** True for a time FAT can store: a whole number of two-second steps. */
export function onFatGrid(ms: number): boolean {
  return Math.round(ms) % FAT_STEP_MS === 0;
}

/** Times the platform did not really know come as 0 or not at all. */
function known(ms: number | undefined): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0;
}

/**
 * `times`: modification times of files on the card (ms since 1970).
 * `catalogTime`: the time of tonuino-studio.json. The app writes it with the
 * current time, so on exFAT or NTFS that time is off the grid by itself.
 */
export function guessNotFat(times: readonly number[], catalogTime?: number): FsGuess {
  if (known(catalogTime) && !onFatGrid(catalogTime)) return 'not-fat';
  let off = 0;
  for (const t of times) {
    if (known(t) && !onFatGrid(t) && ++off >= OFF_GRID_NEEDED) return 'not-fat';
  }
  return 'unknown';
}
