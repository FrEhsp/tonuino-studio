import { describe, expect, it } from 'vitest';
import { freeAfter, insertAt, minutesLeft, minutesLeftText, placedRows } from '../../src/features/add/musik';

describe('new titles at a place of their own (#126)', () => {
  const old = ['001.mp3', '002.mp3', '003.mp3'];
  const fresh = ['004.mp3', '005.mp3'];

  it('puts them in front, after a title, or leaves them at the end', () => {
    expect(insertAt(old, fresh, 0)).toEqual(['004.mp3', '005.mp3', '001.mp3', '002.mp3', '003.mp3']);
    expect(insertAt(old, fresh, 2)).toEqual(['001.mp3', '002.mp3', '004.mp3', '005.mp3', '003.mp3']);
    expect(insertAt(old, fresh, 3)).toBeNull();
    expect(insertAt(old, fresh, 9)).toBeNull();
    expect(insertAt(old, [], 0)).toBeNull();
    expect(insertAt(old, fresh, -4)?.[0]).toBe('004.mp3');
  });

  it('shows the old numbers of the titles that move', () => {
    expect(placedRows(3, 1, 1)).toEqual([
      { kind: 'old', index: 0, was: 1, moved: false },
      { kind: 'new', index: 0 },
      { kind: 'old', index: 1, was: 2, moved: true },
      { kind: 'old', index: 2, was: 3, moved: true },
    ]);
    expect(placedRows(2, 1, 2).map((r) => r.kind)).toEqual(['old', 'old', 'new']);
    expect(placedRows(2, 0, 0).every((r) => r.kind === 'old' && !r.moved)).toBe(true);
  });
});

describe('time left of a transfer', () => {
  it('says nothing in the first seconds', () => {
    expect(minutesLeft(3000, 50, 100)).toBeNull();
    expect(minutesLeft(60000, 1, 100)).toBeNull();
    expect(minutesLeft(60000, 0, 100)).toBeNull();
  });

  it('goes by the speed so far', () => {
    expect(minutesLeft(60000, 25, 100)).toBe(3);
    expect(minutesLeft(60000, 99, 100)).toBe(1);
    expect(minutesLeft(60000, 100, 100)).toBe(0);
  });

  it('says it in words', () => {
    expect(minutesLeftText(3)).toBe('Noch etwa 3 Minuten');
    expect(minutesLeftText(1)).toBe('Noch etwa eine Minute');
    expect(minutesLeftText(0)).toBe('Noch etwa eine Minute');
    expect(minutesLeftText(150)).toBe('Noch etwa 3 Stunden');
    expect(minutesLeftText(null)).toMatch(/schätze/);
  });
});

it('counts the folders still free after one is taken', () => {
  expect(freeAfter([53, 54, 60], 53)).toBe(2);
  expect(freeAfter([53, 54, 60], 14)).toBe(3);
});
