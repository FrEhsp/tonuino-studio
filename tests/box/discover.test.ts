import { describe, expect, it } from 'vitest';
import { entryFromTags } from '../../src/features/box/discover';
import { CONTENT_KINDS } from '../../src/core/tonuino/catalog';
import type { SdFolder } from '../../src/core/tonuino/sd';
import type { TrackInfo } from '../../src/core/library/tags';

function folder(count: number): SdFolder {
  const tracks = Array.from({ length: count }, (_, i) => {
    const name = `${String(i + 1).padStart(3, '0')}.mp3`;
    return { number: i + 1, name, suffix: '', size: 1000 };
  });
  return { number: 4, name: '04', tracks, wrongDigits: [], unnumbered: [], others: [], junk: [], subfolders: [], empty: [], totalBytes: 0 } as unknown as SdFolder;
}

function infos(count: number, extra: Partial<TrackInfo> = {}): TrackInfo[] {
  return Array.from({ length: count }, (_, i) => ({ title: `Lied ${i + 1}`, album: 'Kinderlieder', durationSec: 150, ...extra }));
}

const lieder = CONTENT_KINDS.find((k) => k.id === 'lieder')!.defaultMode;

describe('entryFromTags', () => {
  it.each([4, 6])('an album "Kinderlieder" with %i short tracks becomes Kinderlieder', (n) => {
    const e = entryFromTags(folder(n), infos(n));
    expect(e.kind).toBe('lieder');
    expect(e.card?.mode).toBe(lieder);
    expect(e.title).toBe('Kinderlieder');
  });

  it('a genre tag still comes first', () => {
    const e = entryFromTags(folder(4), infos(4, { genre: 'Hörspiel' }));
    expect(e.kind).toBe('hoerspiel');
  });

  it('takes the folder name given in Tonuino-Manager before the album, from the first track', () => {
    const tracks = infos(4);
    tracks[0] = { ...tracks[0], folderName: ' Lieder  zum Einschlafen ' };
    expect(entryFromTags(folder(4), tracks).title).toBe('Lieder zum Einschlafen');
    // Only the first track counts, as in Tonuino-Manager.
    const later = infos(4);
    later[2] = { ...later[2], folderName: 'Anderer Name' };
    expect(entryFromTags(folder(4), later).title).toBe('Kinderlieder');
  });

  it('without an album the folder number names it', () => {
    const e = entryFromTags(folder(2), [{}, {}]);
    expect(e.title).toBe('Ordner 04');
  });
});
