/** Where a row sits on the screen, as getBoundingClientRect gives it. */
export interface RowBox {
  top: number;
  bottom: number;
}

/**
 * The place a dragged row moves to: the one where it lies under the pointer
 * once it is there. `rows` are the rows as they are shown now, the dragged
 * one (at `from`) included. Each place is worked out from the heights of the
 * other rows, so a taller row (one that is playing) shifts the places, and
 * the row does not jump back and forth after it moved. Where two places
 * would both fit (the dragged row is taller), it stays where it is.
 */
export function dragTarget(y: number, rows: RowBox[], from: number): number {
  const n = rows.length;
  if (n < 2 || from < 0 || from >= n) return from;
  // How far down each row pushes the next one, gaps between the rows included.
  const step = rows.map((r, i) => (i < n - 1 ? rows[i + 1].top - r.top : r.bottom - r.top));
  const own = step[from];
  const others = step.filter((_, i) => i !== from);
  const tops: number[] = [];
  let top = rows[0].top;
  for (let k = 0; k < n; k++) {
    tops.push(top);
    if (k < n - 1) top += others[k];
  }
  if (y >= tops[from] && y < tops[from] + own) return from;
  for (let k = 0; k < n; k++) if (y < tops[k] + own) return k;
  return n - 1;
}
