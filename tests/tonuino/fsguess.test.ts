import { describe, expect, it } from 'vitest';
import { guessNotFat, onFatGrid, OFF_GRID_NEEDED } from '../../src/core/tonuino/fsguess';

/** A time on 6 October 2026, 12:mm:ss.ms (UTC). */
const at = (m: number, s: number, ms = 0) => Date.UTC(2026, 9, 6, 12, m, s, ms);

describe('guessNotFat', () => {
  it('says nothing about cards whose times are all on even seconds', () => {
    // FAT, or files copied from a ZIP or another FAT card: both look like this.
    const even = [at(0, 0), at(0, 2), at(0, 4), at(13, 58), at(59, 30)];
    expect(even.every(onFatGrid)).toBe(true);
    expect(guessNotFat(even)).toBe('unknown');
    expect(guessNotFat(even, at(1, 10))).toBe('unknown');
    expect(guessNotFat([])).toBe('unknown');
  });

  it('calls a card not FAT when three file times fall between the two-second steps', () => {
    const odd = [at(0, 1, 230), at(3, 7, 10), at(4, 4, 990)];
    expect(odd.some(onFatGrid)).toBe(false);
    expect(OFF_GRID_NEEDED).toBe(3);
    expect(guessNotFat(odd)).toBe('not-fat');
    // Mixed with even times it still counts; one or two could be a fluke of where the files came from.
    expect(guessNotFat([at(0, 0), ...odd, at(0, 2)])).toBe('not-fat');
    expect(guessNotFat(odd.slice(0, 2))).toBe('unknown');
    // A whole odd second is off the grid too (exFAT with one-second times).
    expect(guessNotFat([at(0, 1), at(0, 3), at(0, 5)])).toBe('not-fat');
  });

  it('trusts the time of the catalog alone, because the app wrote it just now', () => {
    expect(guessNotFat([], at(0, 1, 230))).toBe('not-fat');
    expect(guessNotFat([at(0, 0), at(0, 2)], at(10, 11))).toBe('not-fat');
    expect(guessNotFat([], at(0, 2))).toBe('unknown');
  });

  it('ignores times the platform does not know', () => {
    expect(guessNotFat([0, 0, 0, Number.NaN, -1])).toBe('unknown');
    expect(guessNotFat([], 0)).toBe('unknown');
    expect(guessNotFat([], undefined)).toBe('unknown');
  });
});
