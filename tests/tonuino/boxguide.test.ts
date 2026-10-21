import { describe, expect, it } from 'vitest';
import { adminAccessFor, batchGuide, boxGuide, describePresses, effectiveAccess, menuPresses, releaseMatters, singleTrackRuns, type BoxGuide, type GuideResult, type KeyPress } from '../../src/core/tonuino/boxguide';
import { adminCard, modifierCard, TNG_SEPTEMBER_2026 } from '../../src/core/tonuino/modes';

function guide(r: GuideResult): BoxGuide {
  if (!r.ok) throw new Error(r.reason);
  return r.guide;
}

/** Plays the presses through a voice menu exactly like TNG's VoiceMenu::react. */
function simulate(from: number, presses: KeyPress[], max: number): number {
  let v = from;
  for (const p of presses) {
    for (let i = 0; i < p.times; i++) {
      if (p.key === 'up') v = Math.min(v + (p.long ? 10 : 1), max);
      if (p.key === 'down') v = Math.max(v - (p.long ? 10 : 1), 1);
    }
  }
  return v;
}

/** The menu presses of a step, without the confirming Pause. */
const moves = (g: BoxGuide, i: number) => (g.steps[i].presses ?? []).filter((p) => p.key !== 'pause');

describe('menuPresses', () => {
  it('counts short presses for small numbers', () => {
    expect(menuPresses(0, 5, 16)).toEqual([{ key: 'up', times: 5 }]);
    expect(menuPresses(4, 6, 99)).toEqual([{ key: 'up', times: 2 }]);
  });

  it('jumps by ten when holding the button', () => {
    expect(menuPresses(0, 23, 99)).toEqual([
      { key: 'up', long: true, times: 2 },
      { key: 'up', times: 3 },
    ]);
    expect(menuPresses(0, 10, 99)).toEqual([{ key: 'up', long: true, times: 1 }]);
  });

  it('overshoots and comes back for 8 and 9 when there is room', () => {
    expect(menuPresses(0, 19, 99)).toEqual([
      { key: 'up', long: true, times: 2 },
      { key: 'down', times: 1 },
    ]);
    expect(menuPresses(0, 9, 16)).toEqual([
      { key: 'up', long: true, times: 1 },
      { key: 'down', times: 1 },
    ]);
    // A menu with only 9 options has no room for the jump.
    expect(menuPresses(0, 9, 9)).toEqual([{ key: 'up', times: 9 }]);
  });

  it('always lands on the target in the box menu', () => {
    for (const max of [5, 9, 16, 30, 99]) {
      for (let from = 0; from <= max; from++) {
        for (let to = Math.max(1, from); to <= max; to++) {
          expect(simulate(from, menuPresses(from, to, max), max)).toBe(to);
        }
      }
    }
  });

  it('reads like a sentence', () => {
    expect(describePresses(menuPresses(0, 23, 99))).toBe('die Vor-Taste zweimal lang und dann dreimal kurz');
    expect(describePresses(menuPresses(0, 19, 99))).toBe('die Vor-Taste zweimal lang und dann die Zurück-Taste einmal kurz');
    expect(describePresses(menuPresses(0, 12, 99))).toBe('die Vor-Taste einmal lang und dann zweimal kurz');
  });
});

describe('TNG', () => {
  it('audiobook on a blank card: mode, folder, last folder', () => {
    const g = guide(boxGuide({ folder: 5, mode: 5, special: 0, special2: 0 }, 'tng', { start: 'blank' }));
    expect(g.steps.map((s) => s.kind)).toEqual(['card', 'menu', 'menu', 'menu', 'done']);
    expect(moves(g, 1)).toEqual([{ key: 'up', times: 5 }]);
    expect(g.steps[1].hear).toContain('Hörbuch Modus');
    expect(moves(g, 2)).toEqual([{ key: 'up', times: 5 }]);
    // The last-folder menu starts one below the folder: one press selects the folder itself.
    expect(moves(g, 3)).toEqual([{ key: 'up', times: 1 }]);
    expect(g.steps[3].hear).toBe('„5“');
    expect(g.steps.at(-1)!.hear).toContain('OK');
  });

  it('audiobook across folders, one chapter per placement', () => {
    const g = guide(boxGuide({ folder: 3, mode: 10, special: 1, special2: 2 }, 'tng', { start: 'blank' }));
    expect(simulate(2, moves(g, 3), 99)).toBe(5);
    expect(simulate(0, moves(g, 4), 30)).toBe(2);
  });

  it('several folders mean a random folder, and only newer boxes ask for it', () => {
    const range = guide(boxGuide({ folder: 5, mode: 5, special: 0, special2: 2 }, 'tng', { start: 'blank' }));
    expect(range.steps[3].text).toContain('zufällig einen der Ordner 5 bis 7');
    expect(range.steps[3].text).not.toMatch(/geht bis|Hörbuch geht/);
    expect(range.notes.join(' ')).toContain(TNG_SEPTEMBER_2026);
    expect(range.notes.join(' ')).toContain('nur Ordner 5');

    // One folder: the question only comes on boxes since 17.09.2026, older ones go on directly.
    const blank = guide(boxGuide({ folder: 5, mode: 5, special: 0, special2: 0 }, 'tng', { start: 'blank' }));
    expect(blank.steps[3].text).toContain('Neuere Boxen');
    expect(blank.steps[3].text).toContain('sagen gleich „OK“');
    expect(blank.notes.join(' ')).not.toContain(TNG_SEPTEMBER_2026);
    const reuse = guide(boxGuide({ folder: 5, mode: 5, special: 0, special2: 0 }, 'tng', { start: 'reuse' }));
    expect(reuse.steps[4].text).toContain('Bitte lege nun die Karte auf');
    const chapters = guide(boxGuide({ folder: 5, mode: 10, special: 2, special2: 0 }, 'tng', { start: 'blank' }));
    expect(chapters.steps[3].text).toContain('Zahl der Titel');
    expect(simulate(4, moves(chapters, 3), 99)).toBe(5);
  });

  it('the last folder question follows the TNG release the family names', () => {
    const book = { folder: 5, mode: 5, special: 0, special2: 0 };
    // Not known: a step only some boxes ask, without a number of its own.
    const unknown = guide(boxGuide(book, 'tng', { start: 'blank' }));
    expect(unknown.steps[3].optional).toBe(true);
    expect(unknown.steps.filter((s) => !s.optional)).toHaveLength(4);
    // Older boxes do not ask: the card is done after the folder.
    const older = guide(boxGuide(book, 'tng', { start: 'blank', release: 'older' }));
    expect(older.steps).toHaveLength(4);
    expect(older.steps[3].kind).toBe('done');
    // Newer boxes always ask; one press picks the folder itself.
    const newer = guide(boxGuide(book, 'tng', { start: 'blank', release: 'newer' }));
    expect(newer.steps[3].optional).toBeUndefined();
    expect(newer.steps[3].text).toContain('nur Ordner 5');
    expect(simulate(4, moves(newer, 3), 99)).toBe(5);
    // A random folder needs the newer release.
    const random = { ...book, special2: 2 };
    expect(boxGuide(random, 'tng', { start: 'blank', release: 'older' }).ok).toBe(false);
    expect(guide(boxGuide(random, 'tng', { start: 'blank', release: 'newer' })).notes.join(' ')).not.toContain('nur Ordner 5');
  });

  it('asks the folder before the track for a single track', () => {
    const g = guide(boxGuide({ folder: 12, mode: 4, special: 7, special2: 0 }, 'tng', { start: 'blank', trackCount: () => 20 }));
    expect(simulate(0, moves(g, 1), 16)).toBe(4);
    expect(simulate(0, moves(g, 2), 99)).toBe(12);
    expect(simulate(0, moves(g, 3), 20)).toBe(7);
  });

  it('range modes pick first and last track; the last menu starts at the first', () => {
    const g = guide(boxGuide({ folder: 7, mode: 8, special: 3, special2: 12 }, 'tng', { start: 'blank', trackCount: () => 14 }));
    expect(simulate(0, moves(g, 3), 14)).toBe(3);
    expect(simulate(3, moves(g, 4), 14)).toBe(12);
  });

  it('same first and last track needs only the Pause button', () => {
    const g = guide(boxGuide({ folder: 7, mode: 8, special: 4, special2: 4 }, 'tng', { start: 'blank' }));
    expect(g.steps[4].presses).toEqual([{ key: 'pause', times: 1 }]);
  });

  it('a used card goes through admin entry 1, is placed, then the admin menu is left', () => {
    const g = guide(boxGuide({ folder: 2, mode: 2, special: 0, special2: 0 }, 'tng', { start: 'reuse' }));
    expect(g.steps[0].presses).toEqual([{ key: 'all', long: true, times: 1 }]);
    expect(moves(g, 1)).toEqual([{ key: 'up', times: 1 }]);
    expect(g.steps.at(-2)!.text).toContain('Bitte lege nun die Karte auf');
    expect(g.steps.at(-1)!.presses).toEqual([{ key: 'pause', long: true, times: 1 }]);
    expect(g.steps.at(-1)!.text).toContain('Und weiter im Admin Menü');
  });

  it('PIN and admin card entries', () => {
    const pin = guide(boxGuide({ folder: 2, mode: 2, special: 0, special2: 0 }, 'tng', { start: 'reuse', access: 'pin' }));
    expect(pin.steps[0].hear).toContain('Pin');
    expect(pin.steps[1].text).toContain('PIN');
    const card = guide(boxGuide({ folder: 2, mode: 2, special: 0, special2: 0 }, 'tng', { start: 'reuse', access: 'card' }));
    expect(card.steps[0].text).toContain('Admin-Karte');
    expect(card.steps[0].presses).toBeUndefined();
  });

  it('TNG has no sum to solve: that lock opens like no lock', () => {
    expect(adminAccessFor('tng')).toEqual(['buttons', 'card', 'pin']);
    expect(adminAccessFor('classic21')).toEqual(['buttons', 'card', 'pin', 'calc']);
    expect(effectiveAccess('calc', 'tng')).toBe('buttons');
    expect(effectiveAccess('calc', 'classic21')).toBe('calc');
    const sum = guide(boxGuide({ folder: 2, mode: 2, special: 0, special2: 0 }, 'tng', { start: 'reuse', access: 'calc' }));
    const plain = guide(boxGuide({ folder: 2, mode: 2, special: 0, special2: 0 }, 'tng', { start: 'reuse', access: 'buttons' }));
    expect(sum.steps).toEqual(plain.steps);
  });

  it('admin card: mode 6 and no folder', () => {
    const g = guide(boxGuide(adminCard(), 'tng', { start: 'blank' }));
    expect(g.steps.map((s) => s.kind)).toEqual(['card', 'menu', 'done']);
    expect(simulate(0, moves(g, 1), 16)).toBe(6);
  });

  it('sleep timer card with stop at end of track', () => {
    const g = guide(boxGuide(modifierCard(1, 15 + 0x80), 'tng', { start: 'blank' }));
    // admin entry, admin menu, modifier, minutes, end of track, place card, leave the admin menu
    expect(g.steps).toHaveLength(7);
    expect(simulate(0, moves(g, 1), 14)).toBe(6);
    expect(simulate(0, moves(g, 2), 11)).toBe(1);
    expect(simulate(0, moves(g, 3), 4)).toBe(2);
    expect(g.steps[3].hear).toBe('„15 Minuten.“');
    expect(simulate(0, moves(g, 4), 2)).toBe(2);
    expect(g.steps[5].text).toContain('Bitte lege nun die Karte auf');
  });

  it('freeze dance with pause length', () => {
    const g = guide(boxGuide(modifierCard(2, 1), 'tng', { start: 'blank' }));
    expect(simulate(0, moves(g, 3), 3)).toBe(2);
    expect(g.steps[3].hear).toBe('„25 bis 40 Sekunden“');
  });

  it('warns about cards that need a firmware option or a newer release', () => {
    const notes = (code: number) => guide(boxGuide(modifierCard(code), 'tng', { start: 'blank' })).notes.join(' ');
    // The box's menu offers all eleven cards, whatever the firmware can do.
    expect(notes(8)).toContain('5 Tasten mit allen Extras');
    expect(notes(8)).toContain('trotzdem an');
    expect(notes(9)).toContain('selbst gebauten');
    expect(notes(11)).toContain(TNG_SEPTEMBER_2026);
    expect(notes(11)).toContain('Endlos Ein- und Ausschaltkarte');
    // "Disable standby timer" came with TNG 3.3.2 (15.11.2025, issue 284).
    expect(notes(10)).toContain('erst ab TNG 3.3.2');
    expect(notes(5)).toBe('');
    expect(guide(boxGuide(modifierCard(1, 15), 'tng', { start: 'blank' })).notes).toEqual([]);
  });

  it('the Endlos card follows the TNG release the family names', () => {
    const endless = modifierCard(11);
    // Older than 17.09.2026: the box does not know the card, so there is nothing to walk through.
    const older = boxGuide(endless, 'tng', { start: 'blank', release: 'older' });
    expect(older.ok).toBe(false);
    if (!older.ok) expect(older.reason).toContain(TNG_SEPTEMBER_2026);
    expect(guide(boxGuide(endless, 'tng', { start: 'blank', release: 'newer' })).notes).toEqual([]);
    // "Older" may still be 3.3.2, which knows the card that keeps the box on.
    const standby = guide(boxGuide(modifierCard(10), 'tng', { start: 'blank', release: 'older' }));
    expect(standby.notes.join(' ')).toContain('erst ab TNG 3.3.2');
    expect(guide(boxGuide(modifierCard(10), 'tng', { start: 'blank', release: 'newer' })).notes).toEqual([]);
  });

  it('asks for the release only for cards it changes', () => {
    expect(releaseMatters({ folder: 5, mode: 5, special: 0, special2: 0 })).toBe(true);
    expect(releaseMatters({ folder: 5, mode: 10, special: 1, special2: 0 })).toBe(true);
    expect(releaseMatters({ folder: 5, mode: 2, special: 0, special2: 0 })).toBe(false);
    expect(releaseMatters(modifierCard(11))).toBe(true);
    expect(releaseMatters(modifierCard(10))).toBe(false);
    expect(releaseMatters(adminCard())).toBe(false);
  });

  it('quiz picks the answer variant', () => {
    const g = guide(boxGuide({ folder: 30, mode: 12, special: 4, special2: 1 }, 'tng', { start: 'blank' }));
    expect(simulate(0, moves(g, 3), 5)).toBe(4);
    expect(g.notes.join(' ')).toContain('Firmware');
  });

  it('refuses what the box cannot do', () => {
    expect(boxGuide({ folder: 4, mode: 4, special: 30, special2: 0 }, 'tng', { start: 'blank', trackCount: () => 12 }).ok).toBe(false);
    expect(boxGuide(modifierCard(1, 20), 'tng', { start: 'blank' }).ok).toBe(false);
    expect(boxGuide({ folder: 4, mode: 13, special: 1, special2: 0 }, 'tng', { start: 'blank' }).ok).toBe(false);
  });
});

describe('TonUINO 2.1', () => {
  it('asks the folder first, then the mode', () => {
    const g = guide(boxGuide({ folder: 12, mode: 2, special: 0, special2: 0 }, 'classic21', { start: 'blank' }));
    expect(g.steps.map((s) => s.kind)).toEqual(['card', 'menu', 'menu', 'done']);
    expect(simulate(0, moves(g, 1), 99)).toBe(12);
    expect(simulate(0, moves(g, 2), 9)).toBe(2);
  });

  it('range: first and last track after the mode', () => {
    const g = guide(boxGuide({ folder: 1, mode: 9, special: 2, special2: 9 }, 'classic21', { start: 'blank' }));
    expect(simulate(0, moves(g, 2), 9)).toBe(9);
    expect(simulate(0, moves(g, 3), 255)).toBe(2);
    expect(simulate(2, moves(g, 4), 255)).toBe(9);
  });

  it('a used card: admin entry 1, place the card, then the menu', () => {
    const g = guide(boxGuide({ folder: 1, mode: 1, special: 0, special2: 0 }, 'classic21', { start: 'reuse' }));
    expect(g.steps.map((s) => s.kind)).toEqual(['admin', 'menu', 'card', 'menu', 'menu', 'done']);
    // 2.1 opens the menu only once all three buttons are let go.
    expect(g.steps[0].text).toContain('sobald du loslässt');
  });

  it('a sum to solve before the admin menu', () => {
    const g = guide(boxGuide({ folder: 1, mode: 1, special: 0, special2: 0 }, 'classic21', { start: 'reuse', access: 'calc' }));
    expect(g.steps.map((s) => s.kind)).toEqual(['admin', 'admin', 'menu', 'card', 'menu', 'menu', 'done']);
    expect(g.steps[0].hear).toBe('„Wieviel ist …“');
    expect(g.steps[1].text).toContain('Rechenaufgabe');
    expect(g.steps[1].hear).toContain('Willkommen im Admin Menü');
  });

  it('admin card needs any folder, then mode 6', () => {
    const g = guide(boxGuide(adminCard(), 'classic21', { start: 'blank' }));
    expect(simulate(0, moves(g, 1), 99)).toBe(1);
    expect(simulate(0, moves(g, 2), 9)).toBe(6);
  });

  it('sleep timer without the end-of-track question', () => {
    const g = guide(boxGuide(modifierCard(1, 30), 'classic21', { start: 'blank' }));
    expect(g.steps).toHaveLength(5);
    expect(simulate(0, moves(g, 3), 4)).toBe(3);
    expect(boxGuide(modifierCard(1, 30 + 0x80), 'classic21', { start: 'blank' }).ok).toBe(false);
  });

  it('while the box waits for a card, only Vor or Zurück abort', () => {
    // Tonuino.ino resetCard() and the modifier loop only check up/down.wasReleased().
    const reuse = guide(boxGuide({ folder: 1, mode: 1, special: 0, special2: 0 }, 'classic21', { start: 'reuse' }));
    expect(reuse.steps[2].kind).toBe('card');
    expect(reuse.steps[2].text).toContain('Vor oder Zurück');
    const sleep = guide(boxGuide(modifierCard(1, 15), 'classic21', { start: 'blank' }));
    expect(sleep.steps.at(-1)!.text).toContain('Vor oder Zurück');
    const batch = guide(batchGuide(6, 1, 4, 'classic21', { trackCount: () => 4 }));
    const text = batch.steps.map((s) => s.text).join(' ');
    expect(text).toContain('Vor oder Zurück');
    expect(text).not.toContain('Play/Pause-Taste lang');
    // TNG aborts a card wait with a long Pause (WriteCard::react → isAbort).
    const tngBatch = guide(batchGuide(6, 1, 4, 'tng', { trackCount: () => 4 }));
    expect(tngBatch.steps.map((s) => s.text).join(' ')).not.toContain('Vor oder Zurück');
  });

  it('admin menu locked with a sum: the answer comes before the welcome', () => {
    const g = guide(boxGuide({ folder: 1, mode: 1, special: 0, special2: 0 }, 'classic21', { start: 'reuse', access: 'calc' }));
    expect(g.steps.map((s) => s.kind)).toEqual(['admin', 'admin', 'menu', 'card', 'menu', 'menu', 'done']);
    expect(g.steps[0].presses).toEqual([{ key: 'all', long: true, times: 1 }]);
    expect(g.steps[0].hear).toContain('Wieviel ist');
    expect(g.steps[1].text).toContain('Ergebnis');
    expect(g.steps[1].hear).toContain('Willkommen');
    // The admin card skips the lock (adminMenu(true)).
    const viaCard = guide(boxGuide(modifierCard(5), 'classic21', { start: 'blank', access: 'card' }));
    expect(viaCard.steps[0].text).toContain('Admin-Karte');
  });

  it('TNG has no sum lock and opens with the buttons instead', () => {
    const calc = guide(boxGuide(modifierCard(5), 'tng', { start: 'blank', access: 'calc' }));
    const buttons = guide(boxGuide(modifierCard(5), 'tng', { start: 'blank', access: 'buttons' }));
    expect(calc).toEqual(buttons);
  });

  it('refuses TNG-only modes and multi-folder audiobooks', () => {
    expect(boxGuide({ folder: 1, mode: 10, special: 0, special2: 0 }, 'classic21', { start: 'blank' }).ok).toBe(false);
    expect(boxGuide({ folder: 1, mode: 5, special: 0, special2: 2 }, 'classic21', { start: 'blank' }).ok).toBe(false);
    expect(boxGuide(modifierCard(8), 'classic21', { start: 'blank' }).ok).toBe(false);
  });
});

describe('batch of single-track cards', () => {
  it('uses admin entry 9 with folder, first and last track', () => {
    const g = guide(batchGuide(6, 1, 14, 'tng', { trackCount: () => 14 }));
    expect(simulate(0, moves(g, 1), 14)).toBe(9);
    expect(simulate(0, moves(g, 2), 99)).toBe(6);
    expect(simulate(0, moves(g, 3), 14)).toBe(1);
    expect(simulate(1, moves(g, 4), 14)).toBe(14);
    expect(batchGuide(6, 1, 20, 'tng', { trackCount: () => 14 }).ok).toBe(false);
  });

  it('finds single-track cards the box can write in one go', () => {
    const one = (folder: number, track: number) => ({ folder, mode: 4, special: track, special2: 0 });
    const album = { folder: 2, mode: 2, special: 0, special2: 0 };
    expect(singleTrackRuns([one(3, 1), one(3, 2), one(3, 3)])).toEqual([[0, 2]]);
    // A gap, another folder or another card ends the run; a single card is no run.
    expect(singleTrackRuns([one(3, 1), one(3, 2), one(3, 4), one(4, 5), one(4, 6), album, one(5, 1)])).toEqual([
      [0, 1],
      [3, 4],
    ]);
    expect(singleTrackRuns([one(3, 2), one(3, 1)])).toEqual([]);
    // The repeat card (folder 255) and modifier cards are not folder cards.
    expect(singleTrackRuns([one(255, 1), one(255, 2), { folder: 0, mode: 4, special: 1, special2: 0 }, { folder: 0, mode: 4, special: 2, special2: 0 }])).toEqual([]);
  });
});
