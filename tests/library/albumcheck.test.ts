import { describe, expect, it } from 'vitest';
import { listing, numberGaps, tooShort } from '../../src/core/library/albumcheck';
import type { DraftTrack } from '../../src/core/library/grouping';
import type { TrackInfo } from '../../src/core/library/tags';
import { memSource } from '../../src/platform/memory';

const track = (name: string, info?: TrackInfo): DraftTrack => ({ source: memSource(name, new Uint8Array(1)), title: name, info });

describe('numberGaps', () => {
  it('finds titles missing between the numbers in the file names', () => {
    const tracks = ['01 A.mp3', '02 B.mp3', '04 D.mp3', '05 E.mp3', '06 F.mp3', '07 G.mp3'].map((n) => track(n));
    expect(numberGaps(tracks)).toEqual([{ disc: undefined, missing: [3] }]);
  });

  it('takes the count from the tags, so missing titles at the end show too', () => {
    const tracks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => track(`x${n}.mp3`, { trackNo: n, trackOf: 12 }));
    expect(numberGaps(tracks)).toEqual([{ disc: undefined, missing: [11, 12] }]);
  });

  it('looks at each CD on its own', () => {
    const tracks = [
      ...[1, 2, 3].map((n) => track(`a${n}.mp3`, { trackNo: n, discNo: 1 })),
      ...[1, 3, 4].map((n) => track(`b${n}.mp3`, { trackNo: n, discNo: 2 })),
    ];
    expect(numberGaps(tracks)).toEqual([{ disc: 2, missing: [2] }]);
  });

  it('says nothing for a few songs picked from an album, double numbers or files without numbers', () => {
    expect(numberGaps([3, 7, 12].map((n) => track(`s${n}.mp3`, { trackNo: n })))).toEqual([]);
    expect(numberGaps(['01 A.mp3', '01 B.mp3', '03 C.mp3'].map((n) => track(n)))).toEqual([]);
    expect(numberGaps(['Anfang.mp3', 'Ende.mp3'].map((n) => track(n)))).toEqual([]);
    expect(numberGaps(['01 A.mp3', '02 B.mp3', '03 C.mp3'].map((n) => track(n)))).toEqual([]);
  });
});

describe('tooShort', () => {
  it('finds a title of a second among long ones, not among jingles', () => {
    const broken = track('b.mp3', { durationSec: 0.4 });
    expect(tooShort([track('a.mp3', { durationSec: 300 }), broken, track('c.mp3')])).toEqual([broken]);
    expect(tooShort([track('a.mp3', { durationSec: 5 }), track('b.mp3', { durationSec: 1 })])).toEqual([]);
  });
});

describe('listing', () => {
  it('joins with „und“ and cuts long lists', () => {
    expect(listing(['4'])).toBe('4');
    expect(listing(['4', '7', '9'])).toBe('4, 7 und 9');
    expect(listing(['1', '2', '3', '4', '5', '6', '7'])).toBe('1, 2, 3, 4, 5 und 2 weitere');
  });
});
