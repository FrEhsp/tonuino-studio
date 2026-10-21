/**
 * A series spread over several folders, as "Meine Box" names it under
 * "Platz auf der Karte" (Frank 16.10.2026): a common beginning before an
 * episode number, in at least three folders.
 */
import { describe, expect, it } from 'vitest';
import { episodeNumber, episodeOrder, findSeries, seriesKey, seriesOfTitle } from '../../src/core/tonuino/series';

describe('the series of a title', () => {
  it('is the text before the episode number', () => {
    expect(seriesOfTitle('Die drei ??? 012 – Der Super-Papagei')).toBe('Die drei ???');
    expect(seriesOfTitle('Bibi Blocksberg – Folge 3')).toBe('Bibi Blocksberg');
    expect(seriesOfTitle('Bibi Blocksberg - Folge 3 - Hexen gibt es doch')).toBe('Bibi Blocksberg');
    expect(seriesOfTitle('Paw Patrol 1')).toBe('Paw Patrol');
    expect(seriesOfTitle('TKKG - 200 - Gefährliche Diamanten')).toBe('TKKG');
    expect(seriesOfTitle('Benjamin Blümchen: Folge 145, Das Zoo-Fest')).toBe('Benjamin Blümchen');
    expect(seriesOfTitle('Der Räuber Hotzenplotz 1–3')).toBe('Der Räuber Hotzenplotz');
  });

  it('skips a number that is part of the name', () => {
    expect(seriesOfTitle('5 Freunde 120 – Die Schatzinsel')).toBe('5 Freunde');
    expect(seriesOfTitle('Die 3 ??? 012')).toBe('Die 3 ???');
  });

  it('is nothing without a number, or without a name before it', () => {
    expect(seriesOfTitle('Rolf Zuckowski – Starke Kinder')).toBeUndefined();
    expect(seriesOfTitle('Unter meinem Bett')).toBeUndefined();
    expect(seriesOfTitle('012 – Der Super-Papagei')).toBeUndefined();
    expect(seriesOfTitle('CD 2')).toBeUndefined();
  });

  it('compares names without case and punctuation', () => {
    expect(seriesKey('Bibi & Tina')).toBe(seriesKey('bibi und  tina'));
    expect(seriesKey('Die drei ???')).toBe('die drei ???');
    expect(seriesKey('Die drei ???')).not.toBe(seriesKey('Die drei ??? Kids'));
  });
});

describe('series on a card', () => {
  const folders = [
    { number: 2, title: 'Unter meinem Bett 7' },
    { number: 3, title: 'Bridge Over Troubled Water (Remastered)' },
    { number: 19, title: 'Bibi & Tina: Mädchen gegen Jungs (Soundtrack)' },
    { number: 20, title: 'Unter meinem Bett 6' },
    { number: 21, title: 'Unter meinem Bett 5' },
    { number: 25, title: 'Bibi und Tina: Tohuwabohu total' },
    { number: 37, title: 'Unter meinem Bett' },
    { number: 38, title: 'Unter meinem Bett 2' },
    { number: 45, title: 'Der Räuber Hotzenplotz 1–3' },
  ];

  it('finds a series in at least three folders, with the folder titled like the series itself', () => {
    expect(findSeries(folders)).toEqual([{ name: 'Unter meinem Bett', key: 'unter meinem bett', folders: [2, 20, 21, 37, 38] }]);
  });

  it('leaves out series in fewer folders', () => {
    expect(findSeries(folders.filter((f) => f.number < 21))).toEqual([]);
    expect(findSeries(folders.filter((f) => f.number < 21), 2).map((s) => s.folders)).toEqual([[2, 20]]);
  });

  it('puts the series with the most folders first and takes the series the catalog names', () => {
    const found = findSeries([
      { number: 1, title: 'Paw Patrol 1' },
      { number: 2, title: 'Paw Patrol 2' },
      { number: 4, title: 'Folge 12: Der Schatz', series: 'Die drei ???' },
      { number: 5, title: 'Die drei ??? 13 – Feuermond' },
      { number: 6, title: 'Die drei ??? 014' },
      { number: 7, title: 'Die drei ???' },
      { number: 8, title: 'Paw Patrol 3' },
    ]);
    expect(found.map((s) => [s.name, s.folders])).toEqual([
      ['Die drei ???', [4, 5, 6, 7]],
      ['Paw Patrol', [1, 2, 8]],
    ]);
  });
});

describe('the order of the episodes', () => {
  it('follows the numbers in the titles; one without a number is the first episode', () => {
    expect(episodeNumber('Die drei ??? 012 – Der Super-Papagei')).toBe(12);
    expect(episodeNumber('5 Freunde 120 – Die Schatzinsel')).toBe(120);
    expect(episodeNumber('Unter meinem Bett')).toBeUndefined();
    // The Messkarte: "Unter meinem Bett 7" in 02, "… 6" in 20, …, the first one without a number in 37.
    const titles: [number, string][] = [
      [2, 'Unter meinem Bett 7'],
      [20, 'Unter meinem Bett 6'],
      [21, 'Unter meinem Bett 5'],
      [23, 'Unter meinem Bett 4'],
      [24, 'Unter meinem Bett 3'],
      [37, 'Unter meinem Bett'],
      [38, 'Unter meinem Bett 2'],
      [39, 'Unter meinem Bett 8'],
    ];
    expect(episodeOrder(titles.map(([number, title]) => ({ number, title })))).toEqual([37, 38, 24, 23, 21, 20, 2, 39]);
  });

  it('keeps the folder numbers when no title has a number, and for the same number', () => {
    expect(episodeOrder([{ number: 9, title: 'Hörbuch' }, { number: 3, title: 'Hörbuch' }, { number: 5, title: 'Noch eins' }])).toEqual([3, 5, 9]);
    expect(episodeOrder([{ number: 9, title: 'Reihe 1' }, { number: 3, title: 'Reihe 1' }])).toEqual([3, 9]);
  });
});
