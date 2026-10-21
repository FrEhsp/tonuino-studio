/**
 * What the flap of "Kassette" says besides the title (TODO #91): the number
 * of songs and the running time as on a real cassette, the episode when the
 * spine does not name it, never a part of it broken over two lines.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { card } from '../../src/app/state';
import { newCatalog } from '../../src/core/tonuino/catalog';
import { scanSd } from '../../src/core/tonuino/sd';
import { tokenize, wrap } from '../../src/core/stickers/text';
import { memDir } from '../../src/platform/memory';
import { folderLength } from '../../src/features/stickers/content';
import { flapLine, flapParts, runningTime, splitEpisode } from '../../src/features/stickers/tape';

afterEach(() => {
  card.value = null;
});

describe('the flap line', () => {
  it('writes the running time like a cassette, from 100 minutes on in hours', () => {
    expect(runningTime(52 * 60)).toBe('52 Min.');
    expect(runningTime(20)).toBe('1 Min.');
    expect(runningTime(99 * 60)).toBe('99 Min.');
    expect(runningTime(150 * 60)).toBe('2,5 Std.');
    expect(runningTime(6 * 3600 + 5 * 60)).toBe('6 Std.');
  });

  it('counts songs, but not the parts of a story; the episode only where asked', () => {
    expect(flapParts({ length: { tracks: 14, durationSec: 52 * 60, story: false } }, false)).toEqual(['14 Titel', '52 Min.']);
    const story = { series: 'Bibi & Tina, Folge 50', length: { tracks: 12, durationSec: 44 * 60, story: true } };
    expect(flapParts(story, true)).toEqual(['Folge 50', '44 Min.']);
    expect(flapParts(story, false)).toEqual(['44 Min.']);
    // Beside an episode the songs are not counted, so the line stays short.
    expect(flapParts({ series: 'Unter meinem Bett, Folge 8', length: { tracks: 16, durationSec: 46 * 60, story: false } }, true)).toEqual(['Folge 8', '46 Min.']);
    // A single song is no count; an unknown length is left out.
    expect(flapParts({ length: { tracks: 1, durationSec: 200, story: false } }, false)).toEqual(['3 Min.']);
    expect(flapParts({ length: { tracks: 9, story: false } }, false)).toEqual(['9 Titel']);
    expect(flapLine({}, true)).toBeUndefined();
  });

  it('splits "Serie, Folge 50" into the series and its episode', () => {
    expect(splitEpisode('Bibi & Tina, Folge 50')).toEqual({ name: 'Bibi & Tina', episode: '50' });
    expect(splitEpisode('Zaches & Zinnober')).toEqual({ name: 'Zaches & Zinnober' });
  });

  it('breaks a long line only after a dot, never inside "16 Titel"', () => {
    const line = flapLine({ length: { tracks: 16, durationSec: 46 * 60, story: false } }, false)! + ' · Folge 8';
    const measure = (s: string, size: number) => s.length * size * 0.6;
    const lines = wrap(tokenize(line), 2, 13, measure, 'none')!;
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l.startsWith('·')).toBe(false);
      expect(l).not.toMatch(/^(Titel|Min\.)/);
    }
    expect(lines.map((l) => l.replace(/\u00a0/g, ' ')).join(' ')).toBe('16 Titel · 46 Min. · Folge 8');
  });
});

describe('folderLength', () => {
  it('counts the tracks on the card and adds up their lengths from the catalog', async () => {
    const scan = await scanSd(memDir({ '05': { '001.mp3': 10, '002.mp3': 10, '003.mp3': 10 } }));
    const cat = newCatalog();
    cat.folders['05'] = { title: 'Spuckepack', kind: 'musik', tracks: ['001', '002', '003'].map((n) => ({ file: `${n}.mp3`, durationSec: 100 })), addedAt: 1, updatedAt: 1 };
    card.value = { volume: { id: 'sd', label: 'SD', root: memDir({}), info: {}, canEject: false }, status: 'ready', scan, catalog: cat, catalogOnCard: true, covers: new Map(), coverUrls: new Map(), info: {} };
    expect(folderLength(5, cat.folders['05'])).toEqual({ tracks: 3, durationSec: 300, story: false });
    // A track whose length nobody knows: the count stays, the time goes.
    const partly = { ...cat.folders['05'], kind: 'hoerspiel' as const, tracks: cat.folders['05'].tracks.slice(0, 2) };
    expect(folderLength(5, partly)).toEqual({ tracks: 3, durationSec: undefined, story: true });
    expect(folderLength(7, undefined)).toBeUndefined();
  });
});
