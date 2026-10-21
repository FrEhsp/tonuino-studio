/** Facts from elsewhere (the web page of a download) merged into a track's tags. */
import { describe, expect, it } from 'vitest';
import { applyHints } from '../../src/core/library/hints';

describe('applyHints', () => {
  it('lets names and numbers from the web page win; a playing time only fills a gap', () => {
    const info = { title: 'NA', album: 'Alt', durationSec: 59.5, codec: 'aac' };
    expect(applyHints(info, { title: 'Neu', album: 'Album', trackNo: 2, durationSec: 61 })).toEqual({ title: 'Neu', album: 'Album', trackNo: 2, durationSec: 59.5, codec: 'aac' });
    expect(applyHints({ codec: 'aac' }, { durationSec: 61 })).toEqual({ codec: 'aac', durationSec: 61 });
    expect(applyHints(undefined, { title: 'Nur Hinweis' })).toEqual({ title: 'Nur Hinweis' });
    expect(applyHints(info, undefined)).toBe(info);
    expect(applyHints(undefined, undefined)).toBeUndefined();
  });
});
