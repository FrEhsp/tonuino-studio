import { describe, expect, it } from 'vitest';
import type { Catalog } from '../../src/core/tonuino/catalog';
import { applyShownRows } from '../../src/features/box/shownRows';

function catalog(): Catalog {
  return {
    folders: {
      '02': {
        title: 'Lieder',
        addedAt: 1,
        updatedAt: 1,
        tracks: [
          { file: '001.mp3', title: 'Alt eins', durationSec: 10 },
          { file: '002.mp3', title: '', durationSec: undefined },
          { file: '004.mp3', title: 'Altes Lied', durationSec: 99 },
        ],
      },
    },
  } as unknown as Catalog;
}

const rows = [
  { file: '001.mp3', title: 'Alt eins', durationSec: 10 },
  { file: '002.mp3', title: 'Aus dem Dateinamen', durationSec: 20 },
  { file: '004.mp3', title: 'Neues Lied', durationSec: 30 },
  { file: '005.mp3', title: 'Dazugekommen', durationSec: 40 },
];

describe('applyShownRows', () => {
  it('takes over swapped and new tracks like "Übernehmen"', () => {
    const c = catalog();
    applyShownRows(c, 2, rows, { replaced: ['004.MP3'] });
    const t = c.folders['02'].tracks;
    expect(t.find((x) => x.file === '004.mp3')).toMatchObject({ title: 'Neues Lied', durationSec: 30 });
    expect(t.find((x) => x.file === '005.mp3')).toMatchObject({ title: 'Dazugekommen', durationSec: 40 });
    // Without fill an empty title stays empty.
    expect(t.find((x) => x.file === '002.mp3')?.title).toBe('');
  });

  it('closing a gap keeps shown titles and takes over swapped ones too', () => {
    const c = catalog();
    applyShownRows(c, 2, rows, { replaced: ['004.mp3'], fill: true });
    const t = c.folders['02'].tracks;
    expect(t.find((x) => x.file === '002.mp3')).toMatchObject({ title: 'Aus dem Dateinamen', durationSec: 20 });
    expect(t.find((x) => x.file === '004.mp3')).toMatchObject({ title: 'Neues Lied', durationSec: 30 });
    expect(t.find((x) => x.file === '001.mp3')?.title).toBe('Alt eins');
  });

  it('without replaced a filled title is never overwritten', () => {
    const c = catalog();
    applyShownRows(c, 2, rows, { fill: true });
    expect(c.folders['02'].tracks.find((x) => x.file === '004.mp3')?.title).toBe('Altes Lied');
  });

  it('makes an entry for a folder without one', () => {
    const c = { folders: {} } as unknown as Catalog;
    applyShownRows(c, 7, rows.slice(0, 1), { fill: true });
    expect(c.folders['07'].title).toBe('Ordner 07');
    expect(c.folders['07'].tracks).toHaveLength(1);
  });
});
