import { describe, expect, it } from 'vitest';
import {
  albumFromSources,
  categoryToKind,
  changesFor,
  coverCredit,
  creditTagsFor,
  folderOrigin,
  originTags,
  recordOrigins,
  seriesFor,
  sourcesListText,
  trackOrigin,
  unionChanges,
  type TrackOrigin,
} from '../../src/core/sources/origin';
import type { IndexEntry } from '../../src/core/sources/types';
import type { CatalogFolder, CatalogTrack } from '../../src/core/tonuino/catalog';
import { loadSample } from './sample';

const RETRIEVED = Date.parse('2026-10-05T12:00:00Z');
const entry = (id: string): IndexEntry => loadSample().entries.find((e) => e.id === id)!;
const originOf = (id: string, index = 0, at = RETRIEVED): TrackOrigin => {
  const e = entry(id);
  return trackOrigin(e, e.items[index], at);
};

describe('changesFor', () => {
  it('names what the app did to a file', () => {
    expect(changesFor('copy', { tagsWritten: false, gainApplied: false })).toEqual([]);
    expect(changesFor('copy', { tagsWritten: true, gainApplied: false })).toEqual(['tags']);
    expect(changesFor('adjust', { tagsWritten: false, gainApplied: true })).toEqual(['loudness']);
    expect(changesFor('adjust', { tagsWritten: true, gainApplied: true })).toEqual(['loudness', 'tags']);
    expect(changesFor('convert', { tagsWritten: true, gainApplied: false })).toEqual(['converted', 'tags']);
    expect(changesFor('convert', { tagsWritten: true, gainApplied: true, split: true })).toEqual(['converted', 'split', 'loudness', 'tags']);
    expect(changesFor('cut', { tagsWritten: true, gainApplied: false })).toEqual(['split', 'tags']);
    expect(unionChanges([['tags'], ['loudness', 'tags'], ['split']])).toEqual(['split', 'loudness', 'tags']);
  });
});

describe('origin of a track', () => {
  it('keeps only what the credit needs', () => {
    const o = originOf('global-storybooks-de');
    expect(Object.keys(o.entry).sort()).toEqual(['editPolicy', 'id', 'pageUrl', 'publisher', 'rights', 'title', 'type']);
    expect(Object.keys(o.item).sort()).toEqual(['category', 'creators', 'key', 'pageUrl', 'published', 'rights', 'title']);
    expect(o.retrievedAt).toBe(RETRIEVED);
  });

  it('writes the credit, the licence and the source into the tags', () => {
    const gsb = originTags(originOf('global-storybooks-de'), ['tags'], 2026);
    expect(gsb).toEqual({
      comment:
        '„Ein sehr großer Mann“. Global Storybooks – Geschichten zum Vorlesen. Text Cornelius Gulere, Übersetzung Lisa Birkner, gelesen von Jula Eberth. Quelle: Global Storybooks / African Storybook, https://gitlab.com/global-asp/gsn-audio. Lizenz: CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). Geändert: Titelangaben ersetzt.',
      copyright:
        '2017 Global Storybooks / African Storybook. Licensed to the public under https://creativecommons.org/licenses/by/3.0/ verify at https://gitlab.com/global-asp/gsn-audio',
      copyrightUrl: 'https://creativecommons.org/licenses/by/3.0/',
      sourceUrl: 'https://gitlab.com/global-asp/gsn-audio',
    });
    // A podcast: holder and year in TCOP, terms of use in WCOP, the episode page in WOAS.
    const kakadu = originTags(originOf('kakadu-kinderhoerspiel'), [], 2026);
    expect(kakadu.copyright).toBe('2026 Deutschlandradio');
    expect(kakadu.copyrightUrl).toBe('https://www.kakadu.de/nutzungsbedingungen-106.html');
    expect(kakadu.sourceUrl).toBe('https://www.kakadu.de/kinderhoerspiel-das-mammut-in-der-grube-102.html');
    // Public domain: no copyright frame, no licence link.
    const songs = entry('jamendo-139374-eckhardt');
    const free = { ...songs, rights: { kind: 'public-domain' as const, basis: 'commons' as const } };
    const old = originTags(trackOrigin(free, { ...songs.items[0], rights: undefined }, RETRIEVED), ['loudness'], 2026);
    expect(old.copyright).toBeUndefined();
    expect(old.copyrightUrl).toBeUndefined();
    // Licence links over https, also where the source wrote http.
    expect(originTags(originOf('jamendo-139374-eckhardt'), [], 2026).copyrightUrl).toBe('https://creativecommons.org/licenses/by-sa/2.0/de/');
    expect(creditTagsFor({}, ['tags'])).toBeUndefined();
    expect(creditTagsFor({ origin: originOf('radio-klops') }, [])?.copyright).toBe('2026 Domenik Schuster');
  });

  it('records one entry per item in the folder', () => {
    const o = folderOrigin(originOf('kakadu-kinderhoerspiel'), ['tags'], 'o1');
    expect(o).toEqual({
      id: 'o1',
      entry: 'kakadu-kinderhoerspiel',
      item: 'kakadu-kinderhoerspiel/83531235-b48a-551a-9400-33f0e43e9f77',
      title: 'Das Mammut in der Grube',
      series: 'Kakadu – Das Kinderhörspiel',
      publisher: 'Deutschlandfunk Kultur',
      pageUrl: 'https://www.kakadu.de/kinderhoerspiel-das-mammut-in-der-grube-102.html',
      licence: { kind: 'podcast', label: 'Podcast · nur privat', url: 'https://www.kakadu.de/nutzungsbedingungen-106.html' },
      credit:
        '„Das Mammut in der Grube“. Kakadu – Das Kinderhörspiel. Quelle: Deutschlandfunk Kultur, https://www.kakadu.de/kinderhoerspiel-das-mammut-in-der-grube-102.html. Podcast, nur privat (https://www.kakadu.de/nutzungsbedingungen-106.html). Geändert: Titelangaben ersetzt.',
      changes: ['tags'],
      retrievedAt: RETRIEVED,
    });
    expect(folderOrigin(originOf('jamendo-139374-eckhardt'), [], 'x').series).toBeUndefined();
  });

  it('shares one record between the tracks of an item and reuses it later', () => {
    const folder: CatalogFolder = { title: 'Kleine ganz groß', tracks: [], addedAt: 0, updatedAt: 0 };
    const t1: CatalogTrack = { file: '001.mp3' };
    const t2: CatalogTrack = { file: '002.mp3' };
    const book = originOf('jamendo-139374-eckhardt');
    let n = 0;
    const id = () => `id${++n}`;
    recordOrigins(
      folder,
      [
        { track: t1, origin: book, changes: ['tags'] },
        { track: t2, origin: book, changes: ['loudness', 'tags'] },
      ],
      id,
    );
    expect(folder.origins).toHaveLength(1);
    expect(folder.origins![0]).toMatchObject({ id: 'id1', changes: ['loudness', 'tags'] });
    expect([t1.origin, t2.origin]).toEqual(['id1', 'id1']);
    const t3: CatalogTrack = { file: '003.mp3' };
    recordOrigins(folder, [{ track: t3, origin: book, changes: ['split', 'tags'] }], id);
    expect(folder.origins).toHaveLength(1);
    expect(folder.origins![0]).toMatchObject({ id: 'id1', changes: ['split', 'loudness', 'tags'] });
    expect(t3.origin).toBe('id1');
    recordOrigins(folder, [], id);
    expect(folder.origins).toHaveLength(1);
  });
});

describe('albums of files from the list', () => {
  it('takes the kind from the list and notices publishers that allow no changes', () => {
    expect(categoryToKind('lied')).toBe('lieder');
    expect(categoryToKind('hoerbuch')).toBe('hoerbuch');
    expect(albumFromSources([{}, {}])).toBeUndefined();
    expect(albumFromSources([{ origin: originOf('jamendo-139374-eckhardt') }])).toEqual({ kind: 'lieder', unchanged: false });
    expect(albumFromSources([{ origin: originOf('srf-kids-hoerspiele') }, { origin: originOf('srf-kids-hoerspiele', 1) }])).toEqual({ kind: 'hoerspiel', unchanged: true });
    expect(albumFromSources([{ origin: originOf('jamendo-139374-eckhardt') }, { origin: originOf('radio-klops') }])).toEqual({ kind: undefined, unchanged: false });
  });

  it('names the series and the maker of the cover', () => {
    const tracks = [{ origin: originOf('kakadu-kinderhoerspiel') }];
    expect(seriesFor({ title: 'Das Mammut in der Grube', tracks })).toBe('Kakadu – Das Kinderhörspiel');
    expect(seriesFor({ title: 'Kakadu – Das Kinderhörspiel', tracks })).toBeUndefined();
    expect(seriesFor({ title: 'Mix', tracks: [...tracks, {}] })).toBeUndefined();
    expect(coverCredit(tracks)).toBe('Deutschlandfunk Kultur');
    expect(coverCredit([{}])).toBe('Datei');
  });
});

describe('sourcesListText', () => {
  it('lists the credits of every folder with sources', () => {
    const folder = (title: string, origins?: ReturnType<typeof folderOrigin>[]): CatalogFolder => ({ title, tracks: [], origins, addedAt: 0, updatedAt: 0 });
    const text = sourcesListText(
      {
        folders: {
          '01': folder('Eigene CD'),
          '05': folder('Das Mammut in der Grube', [folderOrigin(originOf('kakadu-kinderhoerspiel'), ['tags'], 'a')]),
          '03': folder('Geschichten', [folderOrigin(originOf('global-storybooks-de'), [], 'b'), folderOrigin(originOf('global-storybooks-de', 1), [], 'c')]),
        },
      },
      'Emmas Box',
      Date.parse('2026-10-06T12:00:00Z'),
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('Quellen der Box „Emmas Box“, erstellt mit TonUINO Studio am 06.10.2026');
    expect(lines.filter((l) => l.startsWith('Ordner '))).toEqual(['Ordner 03 – Geschichten', 'Ordner 05 – Das Mammut in der Grube']);
    expect(text).toContain('  „Ein sehr großer Mann“. Global Storybooks');
    expect(text).toContain('    Nur für den privaten Gebrauch in der Familie.');
    expect(text).toContain('    Geladen am 05.10.2026.');
    expect(text).not.toContain('Eigene CD');
    expect(text.endsWith('\n')).toBe(true);
    expect(sourcesListText({ folders: {} }, 'Box', RETRIEVED)).toContain('Auf dieser Box ist nichts aus „Entdecken“.');
  });
});
