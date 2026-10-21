import { describe, expect, it } from 'vitest';
import {
  BIG_DOWNLOAD_BYTES,
  cardParts,
  defaultCardMode,
  guessSaved,
  guessSavedChoice,
  pickOfChoice,
  savedChoices,
  isWholeWork,
  matchDropped,
  MAX_DOWNLOAD_BYTES,
  picksOf,
  plannedBytes,
  plannedSeconds,
  planFiles,
  playingOrder,
  safeName,
  sharedStories,
  storyPart,
  titlesOnCard,
} from '../../src/core/sources/handoff';
import { MAX_TRACKS } from '../../src/core/tonuino/sd';
import type { IndexEntry } from '../../src/core/sources/types';
import { loadSample } from './sample';

const entry = (id: string): IndexEntry => loadSample().entries.find((e) => e.id === id)!;

describe('defaultCardMode', () => {
  it('puts short pieces on one card and long episodes on a card each', () => {
    const gsb = entry('global-storybooks-de');
    expect(defaultCardMode(gsb.items.slice(0, 5))).toBe('all');
    const kakadu = entry('kakadu-kinderhoerspiel');
    expect(defaultCardMode(kakadu.items)).toBe('each');
    expect(defaultCardMode([{ ...gsb.items[0], durationSec: undefined }, gsb.items[1]])).toBe('all');
    expect(defaultCardMode([{ ...gsb.items[0], durationSec: undefined, size: undefined }, gsb.items[1]])).toBe('each');
    expect(isWholeWork(entry('jamendo-139374-eckhardt'))).toBe(true);
    expect(isWholeWork(kakadu)).toBe(false);
  });
});

describe('planFiles', () => {
  it('one card for all: the source is the album, oldest episode first', () => {
    const klops = entry('radio-klops');
    const picked = [klops.items[0], klops.items[2], klops.items[1]];
    expect(playingOrder(klops, picked).map((i) => i.title)).toEqual([klops.items[2].title, klops.items[1].title, klops.items[0].title]);
    const plan = planFiles(klops, picksOf(klops, picked), 'all');
    expect(plan.map((p) => p.hint)).toEqual([
      { album: 'Radio Klops', albumArtist: 'Domenik Schuster', title: klops.items[2].title, trackNo: 1, trackOf: 3, discNo: 1, durationSec: klops.items[2].durationSec },
      { album: 'Radio Klops', albumArtist: 'Domenik Schuster', title: klops.items[1].title, trackNo: 2, trackOf: 3, discNo: 1, durationSec: klops.items[1].durationSec },
      { album: 'Radio Klops', albumArtist: 'Domenik Schuster', title: klops.items[0].title, trackNo: 3, trackOf: 3, discNo: 1, durationSec: klops.items[0].durationSec },
    ]);
    expect(plan[0].relativePath).toBe(`Entdecken/Radio Klops/${safeName(klops.items[2].title)}/${klops.items[2].files[0].name}`);
  });

  it('one card each: every episode is its own album, with the source as artist', () => {
    const klops = entry('radio-klops');
    const plan = planFiles(klops, picksOf(klops, klops.items.slice(0, 2)), 'each');
    expect(plan.map((p) => [p.hint.album, p.hint.albumArtist, p.hint.trackNo, p.hint.trackOf])).toEqual([
      [klops.items[1].title, 'Radio Klops', 1, 1],
      [klops.items[0].title, 'Radio Klops', 1, 1],
    ]);
  });

  it('keeps the songs of an album together', () => {
    const album = entry('jamendo-139374-eckhardt');
    const each = planFiles(album, picksOf(album, album.items), 'each');
    expect(each).toHaveLength(album.items[0].files.length);
    expect(each[0].hint).toMatchObject({ album: album.items[0].title, albumArtist: 'Stefan Eckhardt', title: 'Hänsel und Gretel', trackNo: 1, trackOf: each.length });
    const songs = planFiles(album, picksOf(album, album.items), 'all');
    expect(songs[0].hint).toMatchObject({ album: album.items[0].title, albumArtist: 'Stefan Eckhardt', title: 'Hänsel und Gretel', trackNo: 1 });
  });

  it('sums up sizes and lengths', () => {
    const gsb = entry('global-storybooks-de');
    const picks = picksOf(gsb, gsb.items.slice(0, 2));
    expect(plannedBytes(picks)).toBe(452_051 + 251_062);
    expect(plannedBytes([{ item: gsb.items[0], file: { url: 'https://x', name: 'x.mp3', durationSec: 60 } }])).toBe(960_000);
    expect(plannedSeconds(gsb.items.slice(0, 2))).toBe(49 + 28);
    expect(BIG_DOWNLOAD_BYTES).toBe(1024 ** 3);
    expect(MAX_DOWNLOAD_BYTES).toBe(3 * 1024 ** 3);
  });

  it('makes safe folder names', () => {
    expect(safeName('Ricci: Achtung / Lehrerbesuch? <neu>')).toBe('Ricci Achtung Lehrerbesuch neu');
    expect(safeName('  ')).toBe('_');
    expect(safeName('x'.repeat(200))).toHaveLength(80);
  });
});

describe('matchDropped', () => {
  it('recognises a saved episode by its name, also when the browser numbered it', () => {
    const srf = entry('srf-kids-hoerspiele');
    const file = srf.items[1].files[0];
    expect(matchDropped(srf, { name: file.name, size: 1 })?.item.key).toBe(srf.items[1].key);
    expect(matchDropped(srf, { name: file.name.replace('.mp3', ' (1).mp3').toUpperCase(), size: 1 })?.item.key).toBe(srf.items[1].key);
  });

  it('falls back to the exact size, and knows file names from link pages', () => {
    const srf = entry('srf-kids-hoerspiele');
    expect(matchDropped(srf, { name: 'download.mp3', size: srf.items[2].files[0].size! })?.item.key).toBe(srf.items[2].key);
    expect(matchDropped(srf, { name: 'download.mp3', size: 123 })).toBeUndefined();
    const ohrka = entry('ohrka');
    const hit = matchDropped(ohrka, { name: 'Black_Beauty-cut.mp3', size: 5 });
    expect(hit?.item.title).toBe('Black Beauty, gelesen von Petra Schmidt-Schaller');
    expect(hit?.file).toEqual({ url: '', name: 'Black_Beauty-cut.mp3', size: 5 });
    // A title whose file the list has: the list's file.
    const oz = matchDropped(ohrka, { name: 'Der_Zauberer_von_Oz-cut.mp3', size: 5 });
    expect([oz?.item.title, oz?.file.url]).toEqual(['Der Zauberer von Oz', 'https://www.ohrka.de/fileadmin/audio/eBooks/Der_Zauberer_von_Oz-cut.mp3']);
  });
});

describe('guessSaved', () => {
  // ARD Sounds: episodes as links, lengths in whole minutes, no file names in the list.
  const ard: IndexEntry = {
    ...entry('srf-kids-hoerspiele'),
    id: 'ard-test',
    type: 'link',
    items: [
      { key: 'ard-test/1', title: 'Die Schatzinsel (1/3)', category: 'hoerspiel', durationSec: 3180, files: [] },
      { key: 'ard-test/2', title: 'Die Schatzinsel (2/3)', category: 'hoerspiel', durationSec: 3180, files: [] },
      { key: 'ard-test/3', title: 'Die Schatzinsel (3/3)', category: 'hoerspiel', durationSec: 3000, files: [] },
      { key: 'ard-test/4', title: 'Mucks Wüstenfuchs: Auf dem Bauernhof (1/10)', category: 'hoerspiel', durationSec: 540, files: [] },
    ],
  };

  it('finds the episode by its length, also against a length rounded to the minute', () => {
    expect(guessSaved(ard, { name: 'urn-ard-episode-3ec7.mp3', durationSec: 3012.4 })?.key).toBe('ard-test/3');
    expect(guessSaved(ard, { name: 'x.mp3', durationSec: 541 })?.key).toBe('ard-test/4');
    // Exact lengths (not whole minutes) only allow a few seconds.
    const exact: IndexEntry = { ...ard, items: [{ ...ard.items[3], durationSec: 545 }] };
    expect(guessSaved(exact, { name: 'x.mp3', durationSec: 547 })?.key).toBe('ard-test/4');
    expect(guessSaved(exact, { name: 'x.mp3', durationSec: 560 })).toBeUndefined();
  });

  it('tells episodes of the same length apart by the words of the name or the title tag', () => {
    expect(guessSaved(ard, { name: 'x.mp3', durationSec: 3175 })).toBeUndefined();
    expect(guessSaved(ard, { name: 'Die_Schatzinsel_2_3.mp3', durationSec: 3175 })?.key).toBe('ard-test/2');
    expect(guessSaved(ard, { name: 'download.mp3', title: 'Die Schatzinsel (1/3)' })?.key).toBe('ard-test/1');
    expect(guessSaved(ard, { name: 'mucks-wuestenfuchs-bauernhof.mp3' })?.key).toBe('ard-test/4');
  });

  it('chooses nothing when nothing points to one episode', () => {
    expect(guessSaved(ard, { name: 'aufnahme.mp3' })).toBeUndefined();
    expect(guessSaved(ard, { name: 'aufnahme.mp3', durationSec: 1200 })).toBeUndefined();
    // A number alone points nowhere.
    expect(guessSaved(ard, { name: 'aufnahme.mp3', title: 'Kapitel 1' })).toBeUndefined();
  });
});

describe('savedChoices', () => {
  const book: IndexEntry = {
    ...entry('jamendo-139374-eckhardt'),
    id: 'book-test',
    items: [
      {
        key: 'book-test/1',
        title: 'Märchen',
        category: 'hoerbuch',
        files: [
          { url: 'https://media.example.org/k2.mp3', name: 'k2.mp3', title: 'Der kleine Muck', track: 2, durationSec: 1311 },
          { url: 'https://media.example.org/k1.mp3', name: 'k1.mp3', title: 'Kalif Storch', track: 1, durationSec: 902 },
        ],
      },
    ],
  };

  it('offers the songs of an album, not the whole album', () => {
    const choices = savedChoices(book);
    expect(choices.map((c) => [c.value, c.title, c.durationSec])).toEqual([
      ['book-test/1#0', 'Kalif Storch', 902],
      ['book-test/1#1', 'Der kleine Muck', 1311],
    ]);
    // The chapter itself: the same file the failed download misses, found again by its address.
    expect(pickOfChoice(choices[1], { name: 'download.mp3', size: 9 }).file.url).toBe('https://media.example.org/k2.mp3');
  });

  it('guesses the song by length and words', () => {
    expect(guessSavedChoice(book, { name: 'x.mp3', durationSec: 1310 })).toBe('book-test/1#1');
    expect(guessSavedChoice(book, { name: 'kalif_storch.mp3' })).toBe('book-test/1#0');
    expect(guessSavedChoice(book, { name: 'x.mp3' })).toBeUndefined();
  });

  it('offers the items of other sources, with the saved file', () => {
    const ohrka = entry('ohrka');
    const choices = savedChoices(ohrka);
    expect(choices.map((c) => c.value)).toEqual(ohrka.items.map((it) => it.key));
    expect(pickOfChoice(choices[0], { name: 'a.mp3', size: 3 }).file).toEqual({ url: '', name: 'a.mp3', size: 3 });
  });
});

describe('series in several parts and many episodes', () => {
  /** A link source like the Hörspielklassiker: episodes newest first, some told in parts. */
  const series = (titles: string[], o: { editPolicy?: IndexEntry['editPolicy']; sec?: number } = {}): IndexEntry => {
    const e = entry('radio-klops');
    return {
      ...e,
      editPolicy: o.editPolicy ?? 'unchanged',
      items: titles.map((title, i) => ({
        ...e.items[0],
        key: `k${i}`,
        title,
        published: `2026-0${9 - Math.min(i, 8)}-01`,
        files: [{ url: `https://example.org/${i}.mp3`, name: `${i}.mp3`, durationSec: o.sec ?? 1800 }],
        durationSec: o.sec ?? 1800,
      })),
    };
  };

  it('reads the part of a story only where the publisher numbers it under one name', () => {
    expect(storyPart('Komet im Mumintal (2/4): Auf in die Berge')).toEqual({ story: 'Komet im Mumintal', part: 2, of: 4 });
    expect(storyPart('Die Schatzinsel (1/3)')).toEqual({ story: 'Die Schatzinsel', part: 1, of: 3 });
    expect(storyPart('Mucks Wüstenfuchs: Am Strand (5/10)')).toEqual({ story: 'Mucks Wüstenfuchs: Am Strand', part: 5, of: 10 });
    for (const t of ['Folge 7: Der Hut', 'Heidi kann brauchen, was es gelernt hat (Heidi Teil 2)', 'Zahlen (3/2)', 'Bruch (0/2)']) expect(storyPart(t)).toBeUndefined();
    // Episodes with names of their own never share a story.
    const mucks = series(['Mucks Wüstenfuchs: Auf dem Bauernhof (1/10)', 'Mucks Wüstenfuchs: Auf der Baustelle (2/10)']);
    expect(sharedStories(mucks.items)).toEqual([]);
  });

  it('one card each: the parts of a story share one card, in the order of their parts, the rest stays on its own', () => {
    // Newest first, as the list has them: part 3 above part 1.
    const e = series(['Die Schatzinsel (3/3)', 'Die Schatzinsel (2/3)', 'Komet im Mumintal (2/4): Auf in die Berge', 'Die Schatzinsel (1/3)', 'Pumuckl und die Katze']);
    // Picked in a mixed order: part 2 was published after part 1 here, the plan still sorts by the part number.
    const picks = picksOf(e, e.items);
    const plan = planFiles(e, picks, 'each');
    expect(plan.map((p) => p.file.name)).toEqual(picks.map((p) => p.file.name));
    const treasure = plan.filter((p) => p.item.title.startsWith('Die Schatzinsel'));
    expect(treasure.map((p) => [p.item.title, p.hint.album, p.hint.trackNo, p.hint.trackOf])).toEqual(
      expect.arrayContaining([
        ['Die Schatzinsel (1/3)', 'Die Schatzinsel', 1, 3],
        ['Die Schatzinsel (2/3)', 'Die Schatzinsel', 2, 3],
        ['Die Schatzinsel (3/3)', 'Die Schatzinsel', 3, 3],
      ]),
    );
    expect(new Set(treasure.map((p) => p.relativePath.slice(0, p.relativePath.lastIndexOf('/'))))).toEqual(new Set([`Entdecken/${safeName(e.title)}/Die Schatzinsel`]));
    // One part alone is an episode of its own.
    const comet = plan.find((p) => p.item.title.startsWith('Komet'))!;
    expect(comet.hint).toMatchObject({ album: comet.item.title, trackNo: 1, trackOf: 1 });
    expect(plan.find((p) => p.item.title === 'Pumuckl und die Katze')!.hint.album).toBe('Pumuckl und die Katze');
    expect(sharedStories(e.items)).toEqual(['Die Schatzinsel']);
  });

  it('counts the pieces a long file is cut into, never for a publisher that allows no changes', () => {
    expect(titlesOnCard({ durationSec: 600 }, false)).toBe(1);
    expect(titlesOnCard({ durationSec: 30 * 60 }, false)).toBe(6);
    expect(titlesOnCard({ durationSec: 30 * 60 }, false, 15)).toBe(2);
    expect(titlesOnCard({ durationSec: 30 * 60 }, true)).toBe(1);
    expect(titlesOnCard({}, false)).toBe(1);
  });

  it('one card for all: more than the player plays from one folder goes on several cards, whole episodes each', () => {
    // 50 episodes of 30 minutes, cut into 6 pieces each: 300 titles, more than 255.
    const titles = Array.from({ length: 50 }, (_, i) => `Folge ${i + 1}`);
    const cut = series(titles, { editPolicy: 'normal' });
    const picks = picksOf(cut, cut.items);
    const parts = cardParts(cut, picks);
    expect(new Set(parts.values())).toEqual(new Set([1, 2]));
    expect([...parts.values()].filter((c) => c === 1)).toHaveLength(Math.floor(MAX_TRACKS / 6));
    const plan = planFiles(cut, picks, 'all');
    expect(plan[0].hint).toMatchObject({ album: `${cut.title} (Teil 1)`, trackNo: 1, trackOf: 42 });
    expect(plan[42].hint).toMatchObject({ album: `${cut.title} (Teil 2)`, trackNo: 1, trackOf: 8 });
    expect(plan[42].relativePath.startsWith(`Entdecken/${safeName(cut.title)}/Teil 2/`)).toBe(true);
    // The same episodes unchanged are 50 titles: one card, as before.
    const whole = series(titles);
    const one = planFiles(whole, picksOf(whole, whole.items), 'all');
    expect(new Set(one.map((p) => p.hint.album))).toEqual(new Set([whole.title]));
    expect(one.map((p) => p.hint.trackNo)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});
