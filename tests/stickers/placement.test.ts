import { describe, expect, it } from 'vitest';
import { arrange, blockedSlots, layOut, moveSticker, movedOf, pinsOf, place, sameSpots, stepSpot, type Spot } from '../../src/core/stickers/placement';
import { mirrorPage } from '../../src/core/stickers/backside';
import { paginate } from '../../src/core/stickers/slots';
import { getTemplate, type LabelTemplate } from '../../src/core/stickers/templates';

const herma = getTemplate('herma-5028') as LabelTemplate;
const keys = (count: number) => Array.from({ length: count }, (_, i) => `k${i + 1}`);
const at = (sheet: number, slot: number): Spot => ({ sheet, slot });
const sheetsOf = (k: string[], spots: Spot[], perSheet = 10) => layOut(k, spots, perSheet);

describe('arrange without pins', () => {
  it('fills the labels in order, like paginate', () => {
    for (const count of [0, 1, 10, 11, 23]) {
      for (const used of [[], [0, 4], [9]]) {
        const k = keys(count);
        expect(sheetsOf(k, arrange(k, 10, used))).toEqual(paginate(k, herma, 0, { skipSlots: used }));
      }
    }
  });

  it('skips nothing when every label of the first sheet is gone', () => {
    const k = keys(3);
    expect(arrange(k, 10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([at(0, 0), at(0, 1), at(0, 2)]);
    expect(blockedSlots(10, [3, 3, 11, -1, 1.5])).toEqual(new Set([3]));
  });
});

describe('moveSticker', () => {
  const k = keys(4);
  const natural = arrange(k, 10);

  it('moves onto an empty label', () => {
    const pins = moveSticker(k, natural, at(0, 1), at(0, 7), 10)!;
    const spots = arrange(k, 10, [], pins);
    expect(sheetsOf(k, spots)[0]).toEqual(['k1', null, 'k3', 'k4', null, null, null, 'k2', null, null]);
  });

  it('swaps with the sticker on the label', () => {
    const pins = moveSticker(k, natural, at(0, 0), at(0, 3), 10)!;
    expect(sheetsOf(k, arrange(k, 10, [], pins))[0].slice(0, 4)).toEqual(['k4', 'k2', 'k3', 'k1']);
  });

  it('moves across sheets', () => {
    const k12 = keys(12);
    const spots = arrange(k12, 10);
    const pins = moveSticker(k12, spots, at(1, 1), at(0, 0), 10)!;
    const sheets = sheetsOf(k12, arrange(k12, 10, [], pins));
    expect(sheets[0][0]).toBe('k12');
    expect(sheets[1].slice(0, 2)).toEqual(['k11', 'k1']);
  });

  it('refuses labels that are gone, outside the sheets or the same', () => {
    const spots = arrange(k, 10, [5]);
    expect(moveSticker(k, spots, at(0, 0), at(0, 5), 10, [5])).toBeNull();
    expect(moveSticker(k, spots, at(0, 0), at(1, 0), 10, [5])).toBeNull();
    expect(moveSticker(k, spots, at(0, 0), at(0, 10), 10, [5])).toBeNull();
    expect(moveSticker(k, spots, at(0, 2), at(0, 2), 10, [5])).toBeNull();
    expect(moveSticker(k, spots, at(0, 8), at(0, 9), 10, [5])).toBeNull();
  });
});

describe('arrange with pins', () => {
  // k2 moved to the last label: k1 _ k3 k4 … k2
  const k = keys(4);
  const pins = moveSticker(k, arrange(k, 10), at(0, 1), at(0, 9), 10)!;

  it('leaves the label of a sticker left out empty and shuffles nothing', () => {
    const fewer = ['k1', 'k2', 'k4'];
    expect(arrange(fewer, 10, [], pins)).toEqual([at(0, 0), at(0, 9), at(0, 3)]);
  });

  it('puts new stickers into the first free labels', () => {
    const more = [...k, 'n1', 'n2'];
    expect(arrange(more, 10, [], pins).slice(4)).toEqual([at(0, 1), at(0, 4)]);
  });

  it('keeps new stickers where they went when others leave', () => {
    const more = [...k, 'n1'];
    const spots = arrange(more, 10, [], pins);
    const kept = pinsOf(more, spots);
    expect(arrange(['k2', 'k3', 'k4', 'n1'], 10, [], kept)).toEqual([at(0, 9), at(0, 2), at(0, 3), at(0, 1)]);
  });

  it('moves a sticker off a label marked as gone, into the first free one', () => {
    expect(arrange(k, 10, [9, 0], pins)).toEqual([at(0, 1), at(0, 4), at(0, 2), at(0, 3)]);
  });

  it('keeps the labels on another paper where they exist', () => {
    // round-25 has 54 labels, a 1-label paper only the first.
    expect(arrange(k, 54, [], pins)).toEqual([at(0, 0), at(0, 9), at(0, 2), at(0, 3)]);
    expect(arrange(k, 1, [], pins)).toEqual([at(0, 0), at(1, 0), at(2, 0), at(3, 0)]);
  });

  it('drops sheets without stickers and ignores broken or doubled pins', () => {
    const odd = { k1: at(3, 2), k2: at(3, 2), k3: at(-1, 0), k4: at(5, 0.5) };
    expect(arrange(k, 10, [], odd)).toEqual([at(0, 2), at(0, 0), at(0, 1), at(0, 3)]);
    expect(arrange(['toString', 'k1'], 10, [], { k1: at(2, 4) })).toEqual([at(0, 0), at(0, 4)]);
  });

  it('closes the gap of a sheet left without stickers', () => {
    expect(arrange(['a', 'b'], 10, [], { a: at(0, 0), b: at(2, 3) })).toEqual([at(0, 0), at(1, 3)]);
    // The last sticker of the second sheet goes onto the first: one sheet left.
    const k11 = keys(11);
    const spots = arrange(k11.slice(1), 10, [], pinsOf(k11, arrange(k11, 10)));
    const pins = moveSticker(k11.slice(1), spots, at(1, 0), at(0, 0), 10)!;
    expect(sheetsOf(k11.slice(1), arrange(k11.slice(1), 10, [], pins))).toHaveLength(1);
  });
});

describe('place', () => {
  // 47 stickers on 10-label paper, the first one moved to the last label of sheet 0.
  const k = keys(47);
  const moved = movedOf(moveSticker(k, arrange(k, 10), at(0, 0), at(0, 9), 10)!, 10);
  const order = (spots: Spot[], perSheet: number) => layOut(k, spots, perSheet).flat();

  it('keeps the pins on the paper they were made on', () => {
    expect(place(k, 10, [], moved)).toEqual(arrange(k, 10, [], moved.pins));
    expect(place(k, 10, [], null)).toEqual(arrange(k, 10));
  });

  it('fills another paper anew in the order the stickers had', () => {
    const spots = place(k, 40, [], moved);
    expect(layOut(k, spots, 40)).toHaveLength(2);
    // k1 and k10 swapped: the order stays, the second sheet is not half empty.
    expect(order(spots, 40).slice(0, 10)).toEqual(['k10', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k1']);
    expect(order(spots, 40).filter((x) => x === null)).toHaveLength(80 - 47);
  });

  it('does not spread the stickers one per sheet after a 1-label paper', () => {
    const ten = keys(10);
    const one = movedOf(moveSticker(ten, arrange(ten, 1), at(0, 0), at(3, 0), 1)!, 1);
    const spots = place(ten, 54, [], one);
    expect(layOut(ten, spots, 54)).toHaveLength(1);
    expect(layOut(ten, spots, 54)[0].slice(0, 10)).toEqual(['k4', 'k2', 'k3', 'k1', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10']);
  });

  it('closes the gaps of the old paper, but leaves the labels marked as gone', () => {
    // k1 _ k3 k4 … k2 on 10 labels: k1 k3 k4 k2 into the free labels of 12.
    const gap = movedOf(moveSticker(keys(4), arrange(keys(4), 10), at(0, 1), at(0, 9), 10)!, 10);
    expect(place(keys(4), 12, [0, 2], gap)).toEqual([at(0, 1), at(0, 5), at(0, 3), at(0, 4)]);
  });

  it('gives the labels back once they are no longer marked as gone', () => {
    const marked = place(k, 10, [0, 1], moved);
    expect(order(marked, 10).slice(0, 4)).toEqual([null, null, 'k10', 'k2']);
    expect(layOut(k, marked, 10)).toHaveLength(5);
    const again = movedOf(pinsOf(k, marked), 10, [0, 1]);
    const back = place(k, 10, [], again);
    expect(back).toEqual(place(k, 10, [], moved));
    expect(order(back, 10).slice(0, 2)).toEqual(['k10', 'k2']);
  });
});

describe('layOut', () => {
  it('puts the back of a moved sticker behind it', () => {
    const k = keys(3);
    const spots = arrange(k, 10, [], moveSticker(k, arrange(k, 10), at(0, 0), at(0, 5), 10));
    const front = layOut(k, spots, 10)[0];
    const back = mirrorPage(front, herma);
    // Slot 5 is row 2, column 1: its back is in column 0 of row 2.
    expect(front[5]).toBe('k1');
    expect(back[4]).toBe('k1');
  });

  it('is empty without stickers or labels', () => {
    expect(layOut([], [], 10)).toEqual([]);
    expect(layOut(['a'], [at(0, 0)], 0)).toEqual([]);
  });

  it('compares spots', () => {
    expect(sameSpots([at(0, 1)], [at(0, 1)])).toBe(true);
    expect(sameSpots([at(0, 1)], [at(1, 1)])).toBe(false);
    expect(sameSpots([], [at(0, 0)])).toBe(false);
  });
});

describe('stepSpot', () => {
  const grid = { cols: 2, rows: 5 };
  const none = new Set<number>();

  it('goes on to the next row and the next sheet', () => {
    expect(stepSpot(at(0, 1), 'right', grid, 2, none)).toEqual(at(0, 2));
    expect(stepSpot(at(0, 9), 'right', grid, 2, none)).toEqual(at(1, 0));
    expect(stepSpot(at(1, 0), 'left', grid, 2, none)).toEqual(at(0, 9));
    expect(stepSpot(at(1, 9), 'right', grid, 2, none)).toEqual(at(1, 9));
    expect(stepSpot(at(0, 0), 'left', grid, 2, none)).toEqual(at(0, 0));
  });

  it('stays on the sheet going up and down', () => {
    expect(stepSpot(at(0, 1), 'down', grid, 2, none)).toEqual(at(0, 3));
    expect(stepSpot(at(0, 8), 'down', grid, 2, none)).toEqual(at(0, 8));
    expect(stepSpot(at(1, 1), 'up', grid, 2, none)).toEqual(at(1, 1));
  });

  it('skips labels that are gone', () => {
    const gone = new Set([2, 4]);
    expect(stepSpot(at(0, 1), 'right', grid, 1, gone)).toEqual(at(0, 3));
    expect(stepSpot(at(0, 0), 'down', grid, 1, gone)).toEqual(at(0, 6));
    // Only on the first sheet.
    expect(stepSpot(at(1, 0), 'down', grid, 2, gone)).toEqual(at(1, 2));
  });

  it('turns to the same label of the sheet before or after', () => {
    expect(stepSpot(at(0, 4), 'nextSheet', grid, 2, none)).toEqual(at(1, 4));
    expect(stepSpot(at(1, 4), 'prevSheet', grid, 2, new Set([4, 5]))).toEqual(at(0, 6));
    expect(stepSpot(at(1, 4), 'nextSheet', grid, 2, none)).toEqual(at(1, 4));
  });
});
