/**
 * „Zuschneiden …“ for a title not on the card yet (0.6, #131): what the
 * title knows about its own time moves with the cut.
 */
import { describe, expect, it } from 'vitest';
import { timeAfterEdit, timeBeforeEdit, type TrimEdit } from '../../src/core/audio/trimedit';
import { albumCutsAfterTrim, infoAfterTrim, startsAfterTrim, trimmedTrack, untrimmedTrack } from '../../src/core/library/trimmed';
import type { DraftTrack } from '../../src/core/library/grouping';
import { memSource } from '../../src/platform/memory';

/** 10 s off the start, 20–30 s cut out, the end at 100 s: 70 s left. */
const EDIT: TrimEdit = { startSec: 10, endSec: 100, cuts: [{ fromSec: 20, toSec: 30 }] };

describe('times through a cut', () => {
  it('finds where a second of the whole title lands in the cut one', () => {
    expect(timeAfterEdit(EDIT, 0)).toBe(0);
    expect(timeAfterEdit(EDIT, 15)).toBe(5);
    // Inside the piece cut out: where the piece was.
    expect(timeAfterEdit(EDIT, 25)).toBe(10);
    expect(timeAfterEdit(EDIT, 40)).toBe(20);
    expect(timeAfterEdit(EDIT, 120)).toBe(80);
  });
  it('and back: where a second of the cut title was in the whole one', () => {
    expect(timeBeforeEdit(EDIT, 0)).toBe(10);
    expect(timeBeforeEdit(EDIT, 5)).toBe(15);
    expect(timeBeforeEdit(EDIT, 10)).toBe(20);
    expect(timeBeforeEdit(EDIT, 20)).toBe(40);
    expect(timeBeforeEdit(EDIT, 500)).toBe(100);
    for (const t of [12, 35, 64, 99]) expect(timeBeforeEdit(EDIT, timeAfterEdit(EDIT, t))).toBeCloseTo(t, 9);
  });
});

describe('starts of tracks and chapters after a cut', () => {
  it('moves each start with its sound and lets the first begin at 0', () => {
    const starts = [
      { title: 'Intro', startSec: 0 },
      { title: 'Eins', startSec: 12 },
      { title: 'Zwei', startSec: 40 },
    ];
    expect(startsAfterTrim(starts, EDIT)).toEqual([
      { title: 'Intro', startSec: 0 },
      { title: 'Eins', startSec: 2 },
      { title: 'Zwei', startSec: 20 },
    ]);
  });
  it('drops a title cut away entirely, and one that begins where nothing is left', () => {
    const starts = [
      { title: 'Intro', startSec: 0 },
      { title: 'Weg', startSec: 21 },
      { title: 'Danach', startSec: 30 },
      { title: 'Abspann', startSec: 100 },
    ];
    const got = startsAfterTrim(starts, EDIT);
    expect(got.map((s) => s.title)).toEqual(['Intro', 'Danach']);
    expect(got[1].startSec).toBe(10);
  });
  it('keeps album cuts only while two tracks are left', () => {
    const cuts = { from: 'iTunes', tracks: [{ title: 'A', startSec: 0 }, { title: 'B', startSec: 50 }] };
    expect(albumCutsAfterTrim(cuts, EDIT)?.tracks).toEqual([{ title: 'A', startSec: 0 }, { title: 'B', startSec: 30 }]);
    expect(albumCutsAfterTrim(cuts, { startSec: 0, endSec: 45, cuts: [] })).toBeUndefined();
    expect(albumCutsAfterTrim(undefined, EDIT)).toBeUndefined();
  });
  it('gives the info the new playing time and moves the chapters', () => {
    const info = infoAfterTrim({ title: 'Buch', durationSec: 120, chapters: [{ startSec: 0, title: 'K1' }, { startSec: 60, title: 'K2' }] }, EDIT, 70);
    expect(info).toMatchObject({ title: 'Buch', durationSec: 70, chapters: [{ startSec: 0, title: 'K1' }, { startSec: 40, title: 'K2' }] });
  });
});

describe('a title with its cut file', () => {
  const picked: DraftTrack = { source: memSource('Lied.mp3', new Uint8Array(10)), info: { durationSec: 120 }, title: 'Lied' };
  const cutFile = memSource('Lied.mp3', new Uint8Array(4));
  it('keeps the picked file to cut again from the whole, and gives it back', () => {
    const cut = trimmedTrack(picked, EDIT, { source: cutFile, info: { durationSec: 70 } });
    expect(cut.source).toBe(cutFile);
    expect(cut.info?.durationSec).toBe(70);
    expect(cut.trimmed).toEqual({ source: picked.source, info: picked.info, albumCuts: undefined, edit: EDIT });
    // Cut again: still from the picked file.
    const again = trimmedTrack(cut, { startSec: 0, endSec: 50, cuts: [] }, { source: cutFile, info: { durationSec: 50 } });
    expect(again.trimmed?.source).toBe(picked.source);
    expect(again.trimmed?.edit.endSec).toBe(50);
    const back = untrimmedTrack(again);
    expect(back.source).toBe(picked.source);
    expect(back.info).toBe(picked.info);
    expect(back.trimmed).toBeUndefined();
  });
});
