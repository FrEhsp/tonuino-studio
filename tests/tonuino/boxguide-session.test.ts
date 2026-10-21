import { describe, expect, it } from 'vitest';
import { batchGuide, boxGuide, type AdminAccess, type BoxGuide, type BoxStep, type GuideResult, type KeyPress } from '../../src/core/tonuino/boxguide';
import type { CardData } from '../../src/core/tonuino/card';
import { adminCard, modifierCard } from '../../src/core/tonuino/modes';

function guide(r: GuideResult): BoxGuide {
  if (!r.ok) throw new Error(r.reason);
  return r.guide;
}

/**
 * The main states of a TonUINO-TNG 3.3.3 box while a family follows several
 * guides in a row (src/state_machine.cpp, src/commands.cpp):
 *
 * - Idle: holding all three buttons opens Admin_Allow (PIN) or Admin_Entry
 *   at position 0; the admin card does the same; a blank card starts the
 *   new-card menu, which returns to Idle after writing (return_to_idle).
 * - Admin_Entry: 14 entries, Vor/Zurück ±1 (long ±10) clamped to 1…14, Pause
 *   selects, a long Pause is adm_end (back to Idle). Holding all three is
 *   command::none there and cards are ignored (no card handler).
 * - Entries 1, 6 and 9 write cards and then go to Admin_End = Admin_Entry at
 *   the position used last ("Und weiter im Admin Menü"). Every other entry
 *   changes a box setting.
 *
 * The menus behind an entry are not modelled; boxguide.test.ts checks them.
 */
class TngBox {
  state: 'idle' | 'pin' | 'admin' | 'writing' | 'newCard' = 'idle';
  position = 0;
  lastPosition = 0;
  /** Admin entries chosen, in order. */
  chosen: number[] = [];
  written = 0;
  /** Steps the box did not do what the guide expects. */
  problems: string[] = [];

  constructor(private readonly lock: 'none' | 'pin' = 'none') {}

  follow(g: BoxGuide) {
    for (const step of g.steps) this.step(step);
  }

  private step(step: BoxStep) {
    const presses = step.presses ?? [];
    if (step.kind === 'admin') {
      if (presses.some((p) => p.key === 'all')) return this.holdAll();
      if (step.text.includes('Admin-Karte')) return this.adminCardPlaced();
      if (step.text.includes('PIN')) return this.pinEntered();
    }
    if (step.kind === 'card') {
      if (step.hear?.includes('Oh, eine neue Karte')) return this.blankCardPlaced();
      return this.cardPlacedForWriting();
    }
    if (step.kind === 'done' && !presses.length) {
      // "Fertig, sobald die Box OK sagt": the new-card menu wrote the card.
      if (this.state === 'newCard') {
        this.written++;
        this.state = 'idle';
      } else this.problems.push(`finished while ${this.state}`);
      return;
    }
    for (const p of presses) for (let i = 0; i < p.times; i++) this.press(p);
  }

  private holdAll() {
    if (this.state !== 'idle') return; // command::none outside Idle
    if (this.lock === 'pin') this.state = 'pin';
    else this.openAdmin();
  }

  private adminCardPlaced() {
    if (this.state === 'idle') this.openAdmin();
    else this.problems.push(`admin card ignored while ${this.state}`);
  }

  private pinEntered() {
    if (this.state === 'pin') this.openAdmin();
    else this.problems.push(`PIN presses landed in state ${this.state}`);
  }

  private openAdmin() {
    this.state = 'admin';
    this.lastPosition = 0;
    this.position = 0;
  }

  private blankCardPlaced() {
    if (this.state === 'idle') this.state = 'newCard';
    else this.problems.push(`blank card ignored while ${this.state}`);
  }

  private cardPlacedForWriting() {
    if (this.state !== 'writing') {
      this.problems.push(`card placed while ${this.state}`);
      return;
    }
    this.written++;
    // Admin_End = Admin_Entry: "Und weiter im Admin Menü", same position.
    this.state = 'admin';
    this.position = this.lastPosition;
  }

  private press(p: KeyPress) {
    if (this.state === 'idle') {
      this.problems.push(`${p.long ? 'long ' : ''}${p.key} pressed while the box plays`);
      return;
    }
    if (this.state !== 'admin') {
      // Menus behind an admin entry or of a new card: a long Pause aborts to Idle.
      if (p.key === 'pause' && p.long) this.state = 'idle';
      return;
    }
    if (p.key === 'up') this.position = Math.min(this.position + (p.long ? 10 : 1), 14);
    if (p.key === 'down') this.position = Math.max(this.position - (p.long ? 10 : 1), 1);
    if (p.key === 'pause' && p.long) {
      this.state = 'idle';
      return;
    }
    if (p.key === 'pause' && this.position !== 0) {
      this.lastPosition = this.position;
      this.chosen.push(this.position);
      if ([1, 6, 9].includes(this.position)) this.state = 'writing';
      else {
        this.problems.push(`changed box setting (admin entry ${this.position})`);
        this.state = 'idle';
      }
    }
  }
}

const SLEEP_15 = modifierCard(1, 15);
const KITA = modifierCard(5);
const AUDIOBOOK: CardData = { folder: 3, mode: 5, special: 0, special2: 0 };
const ALBUM: CardData = { folder: 9, mode: 2, special: 0, special2: 0 };

const tng = (card: CardData, start: 'blank' | 'reuse', access: AdminAccess = 'buttons') => guide(boxGuide(card, 'tng', { start, access, trackCount: () => 12 }));

describe('TNG: several cards in a row at the box', () => {
  it('the model reproduces the old fault: without leaving the menu the second card locks the admin menu', () => {
    const first = tng(SLEEP_15, 'blank');
    const box = new TngBox();
    box.follow({ ...first, steps: first.steps.filter((s) => !s.presses?.some((p) => p.key === 'pause' && p.long)) });
    box.follow(tng(KITA, 'blank'));
    expect(box.chosen).toEqual([6, 12]);
  });

  it('two special cards: each guide leaves the admin menu, both open "Spezialkarten"', () => {
    const box = new TngBox();
    box.follow(tng(SLEEP_15, 'blank'));
    expect(box.state).toBe('idle');
    box.follow(tng(KITA, 'blank'));
    expect(box.chosen).toEqual([6, 6]);
    expect(box.written).toBe(2);
    expect(box.problems).toEqual([]);
    expect(box.state).toBe('idle');
  });

  it('two used cards: both go through admin entry 1', () => {
    const box = new TngBox();
    box.follow(tng(AUDIOBOOK, 'reuse'));
    box.follow(tng(ALBUM, 'reuse'));
    expect(box.chosen).toEqual([1, 1]);
    expect(box.written).toBe(2);
    expect(box.problems).toEqual([]);
  });

  it('a blank card after a special card starts the new-card menu', () => {
    const box = new TngBox();
    box.follow(tng(KITA, 'blank'));
    box.follow(tng(ALBUM, 'blank'));
    expect(box.chosen).toEqual([6]);
    expect(box.written).toBe(2);
    expect(box.problems).toEqual([]);
  });

  it('works the same with the admin card and with a PIN', () => {
    const viaCard = new TngBox();
    viaCard.follow(tng(SLEEP_15, 'blank', 'card'));
    viaCard.follow(tng(adminCard(), 'reuse', 'card'));
    viaCard.follow(tng(AUDIOBOOK, 'reuse', 'card'));
    expect(viaCard.chosen).toEqual([6, 1, 1]);
    expect(viaCard.problems).toEqual([]);

    const viaPin = new TngBox('pin');
    viaPin.follow(tng(KITA, 'blank', 'pin'));
    viaPin.follow(tng(SLEEP_15, 'blank', 'pin'));
    expect(viaPin.chosen).toEqual([6, 6]);
    expect(viaPin.problems).toEqual([]);
  });

  it('a batch of single-track cards also ends outside the admin menu', () => {
    const box = new TngBox();
    box.follow(guide(batchGuide(4, 1, 6, 'tng', { trackCount: () => 6 })));
    box.follow(tng(ALBUM, 'reuse'));
    expect(box.chosen).toEqual([9, 1]);
    expect(box.problems).toEqual([]);
    expect(box.state).toBe('idle');
  });

  it('every TNG guide through the admin menu ends with a long Pause; 2.1 leaves the menu by itself', () => {
    const leaves = (g: BoxGuide) => {
      const last = g.steps.at(-1)!;
      return !!last.presses?.some((p) => p.key === 'pause' && p.long) && !!last.hear?.includes('abgebrochen');
    };
    for (const access of ['buttons', 'card', 'pin'] as const) {
      for (const card of [SLEEP_15, KITA, modifierCard(2, 1), AUDIOBOOK, adminCard()]) {
        expect(leaves(tng(card, 'reuse', access))).toBe(true);
      }
      expect(leaves(tng(KITA, 'blank', access))).toBe(true);
    }
    expect(leaves(tng(AUDIOBOOK, 'blank'))).toBe(false);
    expect(leaves(guide(boxGuide(AUDIOBOOK, 'classic21', { start: 'reuse' })))).toBe(false);
    expect(leaves(guide(boxGuide(KITA, 'classic21', { start: 'blank' })))).toBe(false);
  });
});
