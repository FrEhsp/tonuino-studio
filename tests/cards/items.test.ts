import { describe, expect, it } from 'vitest';
import { adminCard, modifierCard } from '../../src/core/tonuino/modes';
import type { Catalog, ExtraCard } from '../../src/core/tonuino/catalog';
import { addExtraCards, alreadyListedNote, adoptLooseExtras, applyFolderCard, buildCardItems, cardSummary, choiceKey, newCards, partialDuplicateNote, sameCard, extraLabel, extras, extraSelection, firmwareNeeds, folderExtraSummary, guideEntries, isFolderExtra, keepsFolderCard, looseExtras, otherMeaning, supportProblem } from '../../src/features/cards/items';

describe('cardSummary', () => {
  it('names the random folder of a Hörbuch card over several folders', () => {
    expect(cardSummary({ folder: 5, mode: 5, special: 0, special2: 2 }, 12)).toBe('Hörbuch · zufällig aus Ordner 05 bis 07');
    expect(cardSummary({ folder: 5, mode: 5, special: 0, special2: 0 }, 12)).toBe('Hörbuch · 12 Titel');
  });
});

describe("a folder's own card", () => {
  it('saving it unchanged changes nothing', () => {
    // A Hörbuch folder without a card of its own plays as Hörbuch.
    expect(keepsFolderCard({ kind: 'hoerbuch' }, { mode: 5, special: 0, special2: 0 })).toBe(true);
    expect(keepsFolderCard(undefined, { mode: 5 })).toBe(true);
    expect(keepsFolderCard({ kind: 'hoerbuch' }, { mode: 2 })).toBe(false);
    expect(keepsFolderCard({ kind: 'musik', card: { mode: 3 } }, { mode: 3, special: 0, special2: 0 })).toBe(true);
  });

  it('the default of the kind is not stored, so the card follows a later change of kind', () => {
    const e: { kind?: 'hoerbuch' | 'musik'; card?: { mode: number; special?: number; special2?: number } } = { kind: 'hoerbuch', card: { mode: 2 } };
    applyFolderCard(e, { mode: 5, special: 0, special2: 0 });
    expect(e.card).toBeUndefined();
    applyFolderCard(e, { mode: 4, special: 2, special2: 0 });
    expect(e.card).toEqual({ mode: 4, special: 2, special2: 0 });
  });
});

describe('supportProblem', () => {
  it('TonUINO 2.1 has no random folder', () => {
    expect(supportProblem({ folder: 5, mode: 5, special: 0, special2: 2 }, 'classic21')).toContain('zufälligen Ordner');
    expect(supportProblem({ folder: 5, mode: 5, special: 0, special2: 2 }, 'tng')).toBeUndefined();
  });

  it('a TNG box older than September 2026 plays only the first folder of a surprise card', () => {
    const surprise = { folder: 5, mode: 5, special: 0, special2: 2 };
    expect(supportProblem(surprise, 'tng', 'older')).toBe('Deine Box ist älter als TNG 3.3.3 vom 17.09.2026 und spielt mit dieser Karte nur Ordner 05.');
    expect(supportProblem({ ...surprise, mode: 10, special: 3 }, 'tng', 'older')).toContain('nur Ordner 05');
    expect(supportProblem(surprise, 'tng', 'newer')).toBeUndefined();
    expect(supportProblem(surprise, 'tng', 'unknown')).toBeUndefined();
    expect(supportProblem({ ...surprise, special2: 0 }, 'tng', 'older')).toBeUndefined();
    // Not knowing the version, the card says what to look for.
    expect(firmwareNeeds(surprise, 'tng', 'unknown')).toContain('nur Ordner 05');
    expect(firmwareNeeds(surprise, 'tng', 'newer')).toBeUndefined();
    expect(firmwareNeeds(surprise, 'tng', 'older')).toBeUndefined();
  });
});

describe('the TNG release', () => {
  const endless: ExtraCard = { id: 'e', label: 'Endlos', folder: 0, mode: 11, special: 0, special2: 0 };
  const standby: ExtraCard = { id: 'p', label: 'Ausschalt-Timer aus', folder: 0, mode: 10, special: 0, special2: 0 };

  it('an older box does not know the Endlos card', () => {
    const [e, p] = buildCardItems(undefined, null, [endless, standby], 'tng', 'older');
    expect(e.unsupported).toContain('älter als TNG');
    // "Older" may still be 3.3.2: the card that keeps the box on stays a card to check.
    expect(p.unsupported).toBeUndefined();
    expect(p.needs).toContain('3.3.2');
    expect(supportProblem(endless, 'tng', 'older')).toBe(e.unsupported);
  });

  it('a newer box needs no note, an unknown one keeps it', () => {
    const newer = buildCardItems(undefined, null, [endless, standby], 'tng', 'newer');
    expect(newer.map((i) => [i.unsupported, i.needs])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
    const unknown = buildCardItems(undefined, null, [endless], 'tng', 'unknown');
    expect(unknown[0].unsupported).toBeUndefined();
    expect(unknown[0].needs).toContain('17.09.2026');
  });
});

describe('otherMeaning', () => {
  it('code 3 is another card on the other firmware', () => {
    const game: ExtraCard = { id: 'f', label: 'Feuer, Wasser, Luft', folder: 0, mode: 3, special: 1, special2: 0 };
    expect(otherMeaning(game, 'classic21')).toBe('Mit TonUINO 2.1 ist das die Karte „Alles gesperrt“: Sperrt Tasten und Karten.');
    expect(otherMeaning(game, 'tng')).toBeUndefined();
    expect(buildCardItems(undefined, null, [game], 'classic21')[0].needs).toContain('Alles gesperrt');
    const lock: ExtraCard = { id: 'l', label: 'Alles gesperrt', folder: 0, mode: 3, special: 0, special2: 0 };
    expect(otherMeaning(lock, 'tng')).toContain('„Feuer, Wasser, Luft“');
    expect(otherMeaning(lock, 'classic21')).toBeUndefined();
  });
});

describe('firmwareNeeds', () => {
  it('flags special cards only some TNG boxes can use', () => {
    expect(firmwareNeeds(modifierCard(8), 'tng')).toContain('5 Tasten mit allen Extras');
    expect(firmwareNeeds(modifierCard(9), 'tng')).toContain('selbst gebauten');
    expect(firmwareNeeds(modifierCard(11), 'tng')).toContain('17.09.2026');
    expect(firmwareNeeds(modifierCard(1, 15), 'tng')).toBeUndefined();
    expect(firmwareNeeds(adminCard(), 'tng')).toBeUndefined();
    // Folder cards use the same mode numbers for something else.
    expect(firmwareNeeds({ folder: 3, mode: 8, special: 1, special2: 4 }, 'tng')).toBeUndefined();
  });

  it('reaches the list of cards to write', () => {
    const extra = { id: 'j', label: 'Jukebox', folder: 0, mode: 8, special: 0, special2: 0 };
    const [item] = buildCardItems(undefined, null, [extra], 'tng');
    expect(item.needs).toContain('5 Tasten mit allen Extras');
    expect(item.unsupported).toBeUndefined();
  });
});

describe('more cards for one folder', () => {
  const one = (id: string, folder: number, track: number): ExtraCard => ({ id, label: `Titel ${track}`, folder, mode: 4, special: track, special2: 0 });

  it('names them after the track or the part of the folder', () => {
    const titles = new Map([[3, 'Alle meine Entchen']]);
    expect(extraLabel({ folder: 2, mode: 4, special: 3, special2: 0 }, 'tng', (n) => titles.get(n))).toBe('Alle meine Entchen');
    expect(extraLabel({ folder: 2, mode: 4, special: 4, special2: 0 }, 'tng', (n) => titles.get(n))).toBe('Titel 4');
    expect(extraLabel({ folder: 2, mode: 8, special: 1, special2: 12 }, 'tng')).toBe('Titel 1 bis 12');
    expect(extraLabel({ folder: 2, mode: 3, special: 0, special2: 0 }, 'tng')).toBe('Party');
    // The repeat card is no card for a folder.
    expect(isFolderExtra({ folder: 0xff, mode: 11, special: 0, special2: 0 })).toBe(false);
  });

  it('come right after the folder cards, sorted by folder and track, before the special cards', () => {
    const sleep: ExtraCard = { id: 's', label: 'Schlummerkarte', folder: 0, mode: 1, special: 15, special2: 0 };
    const items = buildCardItems(undefined, null, [sleep, one('b', 3, 2), one('a', 3, 1), one('c', 1, 7)], 'tng');
    expect(items.map((i) => i.extra?.id)).toEqual(['c', 'a', 'b', 's']);
    // The title says "Titel 1" already.
    expect(items[1].summary).toBe('Einzeltitel');
  });

  it('name their folder, as it is called now, also for the phone and on paper', () => {
    const cat = { folders: { '03': { title: 'Die Olchis', tracks: [], addedAt: 0, updatedAt: 0 } }, extraCards: [] } as unknown as Catalog;
    const party: ExtraCard = { id: 'p', label: 'Party', folder: 3, mode: 3, special: 0, special2: 0 };
    const range: ExtraCard = { id: 'r', label: 'Titel 1 bis 12', folder: 3, mode: 8, special: 1, special2: 12 };
    const items = buildCardItems(undefined, cat, [one('a', 3, 1), party, range, one('b', 5, 2)], 'tng');
    expect(items.map((i) => i.title)).toEqual(['Die Olchis · Party', 'Die Olchis · Titel 1', 'Die Olchis · Titel 1 bis 12', 'Ordner 05 · Titel 2']);
    // The line under it does not say again what the title says.
    expect(items[0].summary).toBe('Spielt alle Titel gemischt, ohne Ende.');
    expect(items[2].summary).toBe('Album, Teil eines Ordners');
    expect(folderExtraSummary(party, 'Party', 6)).toBe('6 Titel');
  });

  it('name an episode of a packed series by itself, with its tracks under it', () => {
    const cat = { folders: { '02': { title: 'Unter meinem Bett', tracks: [], addedAt: 0, updatedAt: 0 } }, extraCards: [] } as unknown as Catalog;
    const episode: ExtraCard = { id: 'e', label: 'Unter meinem Bett 2', folder: 2, mode: 8, special: 19, special2: 36 };
    const [item] = buildCardItems(undefined, cat, [episode], 'tng');
    expect(item.title).toBe('Unter meinem Bett 2');
    expect(item.summary).toBe('Album, Teil eines Ordners · Titel 19 bis 36');
  });

  it('single-track cards in a row become one walk-through at the box', () => {
    const items = buildCardItems(undefined, null, [one('a', 3, 1), one('b', 3, 2), one('c', 3, 3), one('d', 5, 9)], 'tng');
    expect(guideEntries(items)).toEqual([
      { first: 0, last: 2 },
      { first: 3, last: 3 },
    ]);
  });

  it('adds many cards at once and selects them', async () => {
    looseExtras.value = [];
    extraSelection.value = new Set();
    await addExtraCards([1, 2, 3].map((n) => ({ data: { folder: 4, mode: 4, special: n, special2: 0 }, label: `Titel ${n}` })));
    expect(extras.value.map((x) => x.special)).toEqual([1, 2, 3]);
    expect(extraSelection.value.size).toBe(3);
  });
});

describe('end check: the same card twice', () => {
  const x = (id: string, folder: number, mode: number, special = 0, special2 = 0): ExtraCard => ({ id, label: id, folder, mode, special, special2 });

  it('tells cards apart by folder, mode and settings', () => {
    expect(sameCard({ folder: 3, mode: 8, special: 2, special2: 5 }, { folder: 3, mode: 8, special: 2, special2: 5 })).toBe(true);
    expect(sameCard({ folder: 3, mode: 8, special: 2, special2: 5 }, { folder: 3, mode: 8, special: 2, special2: 6 })).toBe(false);
    expect(sameCard(modifierCard(1, 15), modifierCard(1, 30))).toBe(false);
  });

  it('adds only the cards that are not in the list yet, each once', () => {
    const existing = [x('a', 4, 4, 2), x('b', 4, 4, 3)];
    const added = [2, 3, 4, 4, 5].map((n) => ({ data: { folder: 4, mode: 4, special: n, special2: 0 } }));
    expect(newCards(existing, added).map((c) => c.data.special)).toEqual([4, 5]);
    expect(newCards([], [{ data: modifierCard(1, 15) }, { data: modifierCard(1, 15) }])).toHaveLength(1);
  });

  it('marks a card that is in the list twice, from the second one on', () => {
    const items = buildCardItems(undefined, null, [x('a', 3, 8, 2, 5), x('b', 3, 8, 2, 5), x('c', 3, 8, 2, 6), x('s1', 0, 1, 15), x('s2', 0, 1, 15)], 'tng');
    expect(items.map((i) => [i.extra?.id, i.duplicate ?? false])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
      ['s1', false],
      ['s2', true],
    ]);
  });

  it('a new choice of cards, also of the same size, starts the WLAN run over', () => {
    expect(choiceKey([{ key: 'f1' }, { key: 'f2' }])).not.toBe(choiceKey([{ key: 'f1' }, { key: 'f3' }]));
    expect(choiceKey([{ key: 'f1' }, { key: 'f2' }])).toBe(choiceKey([{ key: 'f1' }, { key: 'f2' }]));
  });
});

describe('partialDuplicateNote', () => {
  it('matches the number of cards already in the list', () => {
    expect(partialDuplicateNote(1)).toBe('Eine dieser Karten ist schon in der Liste. Sie kommt nicht doppelt dazu.');
    expect(partialDuplicateNote(3)).toBe('3 dieser Karten sind schon in der Liste. Sie kommen nicht doppelt dazu.');
  });
});

describe('special cards in the list', () => {
  it('have one name each and a line that does not repeat it', () => {
    const dance: ExtraCard = { id: 'd', label: 'Stopptanz', folder: 0, mode: 2, special: 0, special2: 0 };
    const sleep: ExtraCard = { id: 's', label: 'Schlummerkarte, 15 Minuten', folder: 0, mode: 1, special: 15, special2: 0 };
    const admin: ExtraCard = { id: 'a', label: 'Admin-Karte', ...adminCard() };
    const items = buildCardItems(undefined, null, [dance, sleep, admin], 'tng');
    expect(items.map((i) => i.summary)).toEqual(['Pausen alle 15 bis 30 Sekunden.', 'Schaltet nach 15 Minuten ab.', 'Öffnet das Admin-Menü der Box.']);
    expect(extraLabel(modifierCard(1, 15), 'tng')).toBe('Schlummerkarte, 15 Minuten');
    expect(extraLabel({ folder: 0xff, mode: 11, special: 0, special2: 0 }, 'tng')).toBe('Nochmal-Karte');
  });
});

describe('adoptLooseExtras', () => {
  it('takes the special cards made without SD card into its list, without doubles', () => {
    const onCard: ExtraCard = { id: 'k', label: 'Stopptanz', folder: 0, mode: 2, special: 0, special2: 0 };
    const sleep: ExtraCard = { id: 's', label: 'Schlummerkarte, 15 Minuten', folder: 0, mode: 1, special: 15, special2: 0 };
    const dance: ExtraCard = { ...onCard, id: 'd' };
    const { add, same } = adoptLooseExtras([onCard], [sleep, dance, { ...sleep, id: 's2' }]);
    expect(add.map((x) => x.id)).toEqual(['s']);
    // A chosen card that is there already stays chosen: as the card of the list.
    expect([...same]).toEqual([
      ['d', 'k'],
      ['s2', 's'],
    ]);
  });
});

describe('alreadyListedNote', () => {
  const card = (label: string, mode: number): ExtraCard => ({ id: 'a', label, folder: 0, mode, special: 0, special2: 0 });

  it('says the same card is there when it has the same name', () => {
    expect(alreadyListedNote(card('Krabbelmodus', 4), 'tng')).toBe('Genau diese Karte ist schon in der Liste. Du kannst sie dort beschreiben, auch mehrmals.');
  });

  it('names the card as the list shows it, made for the other firmware', () => {
    expect(alreadyListedNote(card('Alles gesperrt', 3), 'tng')).toBe(
      'Diese Karte steht schon in der Liste, als „Alles gesperrt“. Mit TonUINO TNG ist das die Karte „Feuer, Wasser, Luft“. Du kannst sie dort beschreiben, auch mehrmals.',
    );
    expect(alreadyListedNote(card('Meine Kita-Karte', 5), 'tng')).toBe('Diese Karte steht schon in der Liste, als „Meine Kita-Karte“. Du kannst sie dort beschreiben, auch mehrmals.');
  });
});
