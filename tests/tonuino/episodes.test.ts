import { describe, expect, it } from 'vitest';
import {
  appendRanges,
  detectEpisodes,
  episodeCards,
  episodeLabels,
  episodeModeFor,
  episodeModesFor,
  episodeProblems,
  folderRoom,
  mergeWithPrevious,
  moveStart,
  renameEpisode,
  sameEpisodes,
  splitEpisode,
  splitPoint,
  type Episode,
} from '../../src/core/tonuino/episodes';
import { checkCardAgainstSd } from '../../src/core/tonuino/modes';

const tracks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ number: from + i }));

describe('detectEpisodes', () => {
  it('groups tracks in a row by the name noted in the catalog, then origin, then album', () => {
    const list = [
      { number: 1, album: 'Folge 1: Das Gespenst' },
      { number: 2, album: 'Folge 1: Das Gespenst' },
      { number: 3, album: 'folge 1:  das gespenst' },
      { number: 4, episode: 'Folge 2: Der Schatz', album: 'Sammelbox' },
      { number: 5, episode: 'Folge 2: Der Schatz' },
      { number: 6, origin: 'Folge 3: Im Zoo', album: 'Podcast' },
    ];
    expect(detectEpisodes(list)).toEqual([
      { title: 'Folge 1: Das Gespenst', first: 1, last: 3 },
      { title: 'Folge 2: Der Schatz', first: 4, last: 5 },
      { title: 'Folge 3: Im Zoo', first: 6, last: 6 },
    ]);
  });

  it('names tracks without a name after the folder at the start, else after their tracks', () => {
    const list = [...tracks(4), { number: 5, episode: 'Neu' }, { number: 6, episode: 'Neu' }, ...tracks(3, 7)];
    expect(detectEpisodes(list, 'Die Sammlung')).toEqual([
      { title: 'Die Sammlung', first: 1, last: 4 },
      { title: 'Neu', first: 5, last: 6 },
      { title: 'Titel 7 bis 9', first: 7, last: 9 },
    ]);
    // Without a folder name, and for one track.
    expect(detectEpisodes([{ number: 1 }, { number: 2, album: 'A' }])).toEqual([
      { title: 'Titel 1', first: 1, last: 1 },
      { title: 'A', first: 2, last: 2 },
    ]);
  });

  it('follows the numbers, not the order given, and counts a number once', () => {
    const list = [
      { number: 3, album: 'B' },
      { number: 1, album: 'A' },
      { number: 2, album: 'A' },
      { number: 3, album: 'B' },
    ];
    expect(detectEpisodes(list)).toEqual([
      { title: 'A', first: 1, last: 2 },
      { title: 'B', first: 3, last: 3 },
    ]);
    expect(detectEpisodes([])).toEqual([]);
  });

  it('keeps one album in a folder as one episode', () => {
    expect(detectEpisodes(tracks(12).map((t) => ({ ...t, album: 'Das Album' })), 'Ordnername')).toEqual([{ title: 'Das Album', first: 1, last: 12 }]);
  });
});

describe('editing episodes', () => {
  const two: Episode[] = [
    { title: 'Eins', first: 1, last: 10 },
    { title: 'Zwei', first: 11, last: 20 },
  ];

  it('splits an episode inside, never at its first track', () => {
    expect(splitEpisode(two, 0, 6)).toEqual([
      { title: 'Eins', first: 1, last: 5 },
      { title: 'Titel 6 bis 10', first: 6, last: 10 },
      { title: 'Zwei', first: 11, last: 20 },
    ]);
    expect(splitEpisode(two, 0, 1)).toEqual(two);
    expect(splitEpisode(two, 0, 11)).toEqual(two);
    expect(splitPoint(two[0])).toBe(6);
    expect(splitPoint({ title: 'x', first: 4, last: 4 })).toBeUndefined();
    expect(splitPoint({ title: 'x', first: 4, last: 5 })).toBe(5);
  });

  it('merges with the episode before, which keeps its name', () => {
    expect(mergeWithPrevious(two, 1)).toEqual([{ title: 'Eins', first: 1, last: 20 }]);
    expect(mergeWithPrevious(two, 0)).toEqual(two);
  });

  it('moves a start, keeping at least one track on each side', () => {
    expect(moveStart(two, 1, 8)).toEqual([
      { title: 'Eins', first: 1, last: 7 },
      { title: 'Zwei', first: 8, last: 20 },
    ]);
    expect(moveStart(two, 1, 1)[1].first).toBe(2);
    expect(moveStart(two, 1, 99)[1].first).toBe(20);
    expect(moveStart(two, 0, 5)).toEqual(two);
  });

  it('renames and compares', () => {
    const renamed = renameEpisode(two, 1, 'Zwo');
    expect(renamed[1].title).toBe('Zwo');
    expect(sameEpisodes(two, renamed)).toBe(false);
    expect(sameEpisodes(two, two.map((e) => ({ ...e })))).toBe(true);
  });

  it('names what keeps episodes from being saved', () => {
    expect(episodeProblems(two)).toEqual([]);
    expect(episodeProblems([{ title: ' ', first: 1, last: 3 }])).toEqual(['Folge 1 hat keinen Namen.']);
    expect(episodeProblems([...two, { title: 'zwei ', first: 21, last: 22 }])).toEqual(['Folge 2 und 3 heißen gleich. Gib ihnen verschiedene Namen, sonst werden sie eine Folge.']);
    expect(episodeProblems([{ title: 'A', first: 250, last: 256 }])[0]).toMatch(/endet bei Titel 256/);
    expect(episodeProblems([{ title: 'A', first: 1, last: 5 }, { title: 'B', first: 5, last: 6 }])).toEqual(['Folge 2 fängt an, bevor Folge 1 aufhört.']);
  });

  it('labels every track of an episode with its name', () => {
    const labels = episodeLabels([{ title: ' Eins  neu ', first: 1, last: 2 }, two[1]], [1, 2, 11, 30]);
    expect([...labels]).toEqual([
      [1, 'Eins neu'],
      [2, 'Eins neu'],
      [11, 'Zwei'],
    ]);
  });

  it('labels survive a round trip through detection', () => {
    const eps: Episode[] = [
      { title: 'A', first: 1, last: 3 },
      { title: 'B', first: 4, last: 4 },
      { title: 'C', first: 5, last: 9 },
    ];
    const labels = episodeLabels(eps, tracks(9).map((t) => t.number));
    expect(detectEpisodes(tracks(9).map((t) => ({ ...t, episode: labels.get(t.number) })))).toEqual(eps);
  });
});

describe('episode cards', () => {
  it('gives every episode a von-bis card the box accepts', () => {
    const eps: Episode[] = [
      { title: 'Folge 1', first: 1, last: 14 },
      { title: 'Folge 2', first: 15, last: 255 },
    ];
    const cards = episodeCards(7, eps, 8);
    expect(cards).toEqual([
      { data: { folder: 7, mode: 8, special: 1, special2: 14 }, label: 'Folge 1' },
      { data: { folder: 7, mode: 8, special: 15, special2: 255 }, label: 'Folge 2' },
    ]);
    for (const c of cards) expect(checkCardAgainstSd(c.data, () => 255)).toEqual([]);
  });

  it('offers the von-bis modes of the firmware, Hörbuch only with TNG', () => {
    expect(episodeModesFor('tng').map((m) => m.code)).toEqual([8, 16, 7, 9]);
    expect(episodeModesFor('classic21').map((m) => m.code)).toEqual([8, 7, 9]);
    expect(episodeModesFor('tng').every((m) => m.params === 'range')).toBe(true);
  });

  it('plays an episode the way the folder card plays the folder', () => {
    expect(episodeModeFor(1)).toBe(7);
    expect(episodeModeFor(3)).toBe(9);
    expect(episodeModeFor(5)).toBe(8);
    expect(episodeModeFor(2)).toBe(8);
  });
});

describe('room in a folder', () => {
  it('warns before the limit of 255 tracks', () => {
    expect(folderRoom(100, 50)).toEqual({ total: 150, free: 105, state: 'ok' });
    expect(folderRoom(200, 31)).toEqual({ total: 231, free: 24, state: 'near' });
    expect(folderRoom(255)).toEqual({ total: 255, free: 0, state: 'full' });
    expect(folderRoom(250, 10)).toEqual({ total: 260, free: -5, state: 'over' });
  });

  it('appends albums one after the other, never renumbering what is there', () => {
    expect(appendRanges(12, [5, 3])).toEqual([
      { first: 13, last: 17, fits: true },
      { first: 18, last: 20, fits: true },
    ]);
    expect(appendRanges(250, [5, 1])).toEqual([
      { first: 251, last: 255, fits: true },
      { first: 256, last: 256, fits: false },
    ]);
    expect(appendRanges(0, [2])).toEqual([{ first: 1, last: 2, fits: true }]);
  });
});
