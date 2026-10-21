/**
 * Dragging a track: it lands in the row under the pointer, up or down, and
 * does not jump back and forth once it moved.
 */
import { describe, expect, it } from 'vitest';
import { dragTarget, type RowBox } from '../../src/ui/dragTarget';

/** Rows one under the other, starting at y = 100. */
function layout(heights: number[]): RowBox[] {
  let top = 100;
  return heights.map((h) => {
    const r = { top, bottom: top + h };
    top += h;
    return r;
  });
}

function move<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

const names = ['001', '002', '003', '004', '005', '006'];

describe('dragTarget', () => {
  const rows = layout([40, 40, 40, 40, 40, 40]);
  // Row 003 spans 180 to 220.
  const upper = 190;
  const lower = 210;

  it('puts a row dragged down into the row under the pointer', () => {
    expect(move(names, 0, dragTarget(lower, rows, 0)).slice(0, 3)).toEqual(['002', '003', '001']);
    expect(move(names, 0, dragTarget(upper, rows, 0)).slice(0, 3)).toEqual(['002', '003', '001']);
  });

  it('puts a row dragged up into the row under the pointer', () => {
    expect(move(names, 5, dragTarget(lower, rows, 5)).slice(0, 4)).toEqual(['001', '002', '006', '003']);
    expect(move(names, 5, dragTarget(upper, rows, 5)).slice(0, 4)).toEqual(['001', '002', '006', '003']);
  });

  it('stays put while the pointer is over its own row', () => {
    expect(dragTarget(105, rows, 0)).toBe(0);
    expect(dragTarget(139, rows, 0)).toBe(0);
    expect(dragTarget(lower, rows, 2)).toBe(2);
  });

  it('goes to the first or last place above or below the list', () => {
    expect(dragTarget(20, rows, 3)).toBe(0);
    expect(dragTarget(900, rows, 1)).toBe(5);
  });

  it('keeps its place after it moved, also next to a taller row', () => {
    // Row 002 is playing and shows the seek bar.
    const heights = [40, 90, 40, 40, 40];
    for (let from = 0; from < heights.length; from++) {
      for (let y = 80; y < 400; y += 3) {
        const to = dragTarget(y, layout(heights), from);
        const again = dragTarget(y, layout(move(heights, from, to)), to);
        expect(again, `from ${from} at ${y}`).toBe(to);
      }
    }
  });

  it('lands under the pointer when the dragged row is taller', () => {
    // The playing row 001 (90 high) dragged onto 004 (spans 270 to 310).
    const to = dragTarget(280, layout([90, 40, 40, 40, 40]), 0);
    expect(to).toBe(3);
    const after = layout(move([90, 40, 40, 40, 40], 0, to))[to];
    expect(280 >= after.top && 280 < after.bottom).toBe(true);
  });

  it('leaves a single row alone', () => {
    expect(dragTarget(500, layout([40]), 0)).toBe(0);
  });
});
