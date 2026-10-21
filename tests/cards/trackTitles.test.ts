/**
 * Titles on the folder page: from the catalog, the files' tags or the file
 * name, and the new file's own after a track was swapped elsewhere.
 */
import { describe, expect, it } from 'vitest';
import { newCatalog, touchFolder } from '../../src/core/tonuino/catalog';
import { scanSd } from '../../src/core/tonuino/sd';
import { memDir } from '../../src/platform/memory';
import { knownTags, noteWrittenTags, rowsWithTags, type TagInfo } from '../../src/features/cards/trackTitles';

async function folder(files: Record<string, number>) {
  return (await scanSd(memDir({ '01': files }))).folders[0];
}

describe('rowsWithTags', () => {
  it('prefers the catalog title and fills gaps from the tags', async () => {
    const f = await folder({ '001.mp3': 10, '002.mp3': 20 });
    const entry = { title: 'Lieder', tracks: [{ file: '001.mp3', title: 'Eins', durationSec: 4 }], addedAt: 0, updatedAt: 0 };
    const tags = new Map<string, TagInfo>([
      ['001.mp3', { title: 'Tag eins', durationSec: 9 }],
      ['002.mp3', { title: 'Tag zwei', durationSec: 5 }],
    ]);
    expect(rowsWithTags(f, entry, tags).map((r) => [r.title, r.durationSec])).toEqual([
      ['Eins', 4],
      ['Tag zwei', 5],
    ]);
  });

  it('takes title and length of a file swapped elsewhere', async () => {
    const c = newCatalog();
    c.folders['01'] = { title: 'Lieder', tracks: [{ file: '001.mp3', title: 'Eins', durationSec: 4 }, { file: '002.mp3', title: 'Lied Nummer 2', durationSec: 4 }], addedAt: 0, updatedAt: 0 };
    touchFolder(c, await folder({ '001.mp3': 10, '002.mp3': 20 }));
    const after = await folder({ '001.mp3': 10, '002.mp3': 30 });
    const entry = c.folders['01'];
    // Not read yet: the old name stays, the old length is gone.
    expect(rowsWithTags(after, entry, new Map()).map((r) => [r.title, r.durationSec])).toEqual([
      ['Eins', 4],
      ['Lied Nummer 2', undefined],
    ]);
    expect(rowsWithTags(after, entry, new Map([['002.mp3', { title: 'Neues Lied', durationSec: 3 }]]))[1]).toMatchObject({ title: 'Neues Lied', durationSec: 3 });
    // Without a title in the new file the name chosen in the app stays.
    expect(rowsWithTags(after, entry, new Map([['002.mp3', { durationSec: 3 }]]))[1]).toMatchObject({ title: 'Lied Nummer 2', durationSec: 3 });
  });

  it('takes the length from the frames, the one the player shows', async () => {
    const f = await folder({ '001.mp3': 10, '002.mp3': 20 });
    const entry = { title: 'Lieder', tracks: [{ file: '001.mp3', title: 'Eins', durationSec: 185 }], addedAt: 0, updatedAt: 0 };
    const tags = new Map<string, TagInfo>([
      ['001.mp3', { exactSec: 181 }],
      ['002.mp3', { durationSec: 417, exactSec: 120 }],
    ]);
    expect(rowsWithTags(f, entry, tags).map((r) => [r.durationSec, r.durationExact])).toEqual([
      [181, true],
      [120, true],
    ]);
  });

  it('cleans downloader names, guesses titles from the artist field and marks what is a guess', async () => {
    const f = await folder({ '001.mp3': 10, '002.mp3': 20, '003.mp3': 30 });
    const tags = new Map<string, TagInfo>([
      ['001.mp3', { artist: 'Die Sonne Geht Auf' }],
      ['002.mp3', { artist: 'Der Mond' }],
      ['003.mp3', { artist: 'Kleiner Stern' }],
    ]);
    expect(rowsWithTags(f, undefined, new Map()).map((r) => [r.title, r.untitled])).toEqual([
      ['Titel 1', true],
      ['Titel 2', true],
      ['Titel 3', true],
    ]);
    expect(rowsWithTags(f, undefined, tags).map((r) => [r.title, r.titleAuto, r.untitled])).toEqual([
      ['Die Sonne Geht Auf', true, false],
      ['Der Mond', true, false],
      ['Kleiner Stern', true, false],
    ]);
    const entry = {
      title: 'Lieder',
      tracks: [
        { file: '001.mp3', title: 'SomeDownloader.com - Intro' },
        { file: '002.mp3', title: 'Aus dem Laden', titleAuto: true as const },
      ],
      addedAt: 0,
      updatedAt: 0,
    };
    // A number is no name: worth a look in the internet.
    expect(rowsWithTags(f, { ...entry, tracks: [{ file: '001.mp3', title: '01' }] }, new Map())[0]).toMatchObject({ title: '01', untitled: true });
    expect(rowsWithTags(f, entry, new Map([['003.mp3', { title: 'Somedownloader.Com - Schluss' }]])).map((r) => [r.title, r.titleAuto])).toEqual([
      ['Intro', false],
      ['Aus dem Laden', true],
      ['Schluss', false],
    ]);
  });
});


describe('noteWrittenTags', () => {
  it('keeps what was written under the new size', () => {
    noteWrittenTags('vol', '01', [{ file: '001.mp3', oldSize: 10, size: 12, title: 'Neu', artist: 'Eva' }]);
    expect(knownTags('vol', '01', '001.mp3', 12)).toEqual({ title: 'Neu', artist: 'Eva', albumArtist: undefined });
    expect(knownTags('vol', '01', '001.mp3', 10)).toBeUndefined();
    // Same size again (only a letter changed): the new names replace the old ones.
    noteWrittenTags('vol', '01', [{ file: '001.mp3', oldSize: 12, size: 12, title: 'Neuer', artist: '' }]);
    expect(knownTags('vol', '01', '001.mp3', 12)).toEqual({ title: 'Neuer', artist: undefined, albumArtist: undefined });
  });
});
