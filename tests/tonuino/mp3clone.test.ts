import { describe, expect, it } from 'vitest';
import { chipEvidence, cloneAdvice, detectClonePlayer } from '../../src/core/tonuino/mp3clone';

const sd = new Map([
  [1, 12],
  [2, 30],
  [3, 2],
  [4, 8],
]);

describe('copied MP3 players', () => {
  it('finds nothing when the box counts like the SD card, or played nothing', () => {
    expect(detectClonePlayer({ 1: 12, 2: 30 }, sd)).toBeUndefined();
    expect(detectClonePlayer({}, sd)).toBeUndefined();
    // A folder that is not on the open card says nothing.
    expect(detectClonePlayer({ 9: 4 }, sd)).toBeUndefined();
  });

  it('knows the TD5580A by its 2 tracks everywhere', () => {
    const f = detectClonePlayer({ 2: 2, 3: 2, 4: 2 }, sd)!;
    expect(f.pattern).toBe('always-two');
    expect(f.differ.map((c) => c.folder)).toEqual([2, 4]);
    expect(cloneAdvice(f).text).toContain('TD5580A');
    // No chip firmware helps here: a new player does.
    expect(chipEvidence(f)).toEqual({});
    expect(cloneAdvice(f).chip).toBeUndefined();
    expect(cloneAdvice(f).remedy).toContain('ein anderer MP3-Player');
  });

  it('knows the GD3200B by the count of folder 01 everywhere', () => {
    const f = detectClonePlayer({ 1: 12, 2: 12, 4: 12 }, sd)!;
    expect(f.pattern).toBe('folder-one');
    expect(chipEvidence(f)).toEqual({ sameCountEveryFolder: true });
    const a = cloneAdvice(f);
    // The chip and its reason come from suggestChip, not from here.
    expect(a.chip).toMatchObject({ chip: 'gd3200b', sure: false });
    expect(a.text).toContain('GD3200B');
    expect(a.chip?.look).toContain('GD3200D');
    expect(a.remedy).toBeUndefined();
    expect(a.example).toBe('Ordner 02: Die Box zählt 12 Titel, auf der SD-Karte sind 30.');
  });

  it('suggests no chip firmware the box already has', () => {
    const f = detectClonePlayer({ 1: 12, 2: 12, 4: 12 }, sd)!;
    const a = cloneAdvice(f, 'gd3200b');
    expect(a.chip).toBeUndefined();
    expect(a.title).toBe('Die Box zählt anders als die SD-Karte');
  });

  it('says a single difference may be another SD card', () => {
    const f = detectClonePlayer({ 2: 29 }, sd)!;
    expect(f.pattern).toBe('mismatch');
    expect(cloneAdvice(f).title).toBe('Die Box zählt anders als die SD-Karte');
    expect(cloneAdvice(f).text).toContain('Steckt diese SD-Karte gerade in der Box?');
    expect(cloneAdvice(f).chip).toBeUndefined();
    // One folder with 2 is not yet the pattern.
    expect(detectClonePlayer({ 2: 2 }, sd)!.pattern).toBe('mismatch');
  });
});
