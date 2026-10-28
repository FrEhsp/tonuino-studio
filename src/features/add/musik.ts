/**
 * „Musik auf die SD-Karte“ (0.6): what the screen works out besides the
 * import itself. New titles for a folder that has some already go to a
 * place the user picks (#126): the import puts them at the end as always,
 * then the folder gets its new order the way the folder page saves one
 * (planReorder, runRepair), so nothing is overwritten and the others move
 * up by one.
 */

/**
 * The folder's files after the new ones went in after the first `at` old
 * ones (0: in front; `old.length` or more: at the end). Null when nothing
 * moves, because the new ones are at the end already.
 */
export function insertAt<T>(old: readonly T[], fresh: readonly T[], at: number): T[] | null {
  const k = Math.max(0, Math.min(old.length, Math.floor(at)));
  if (k >= old.length || !fresh.length) return null;
  return [...old.slice(0, k), ...fresh, ...old.slice(k)];
}

/** One row of the list while the new titles wait: an old title with the number it had, or a new one. */
export type Placed = { kind: 'old'; index: number; was: number; moved: boolean } | { kind: 'new'; index: number };

/**
 * The rows as the folder will be: the old titles (numbered 1 … in their
 * order) with the new ones after the first `at`. Old titles behind them
 * move: they show the number they had („war 003“).
 */
export function placedRows(oldCount: number, freshCount: number, at: number): Placed[] {
  const k = Math.max(0, Math.min(oldCount, Math.floor(at)));
  const rows: Placed[] = [];
  for (let i = 0; i < k; i++) rows.push({ kind: 'old', index: i, was: i + 1, moved: false });
  for (let i = 0; i < freshCount; i++) rows.push({ kind: 'new', index: i });
  for (let i = k; i < oldCount; i++) rows.push({ kind: 'old', index: i, was: i + 1, moved: freshCount > 0 });
  return rows;
}

/**
 * Minutes left of a transfer, from how fast it went so far; null while it
 * is too early to say (the first seconds and per cent say little: the
 * measuring of an album comes first).
 */
export function minutesLeft(elapsedMs: number, done: number, total: number): number | null {
  if (total <= 0 || done <= 0 || elapsedMs < 8000 || done / total < 0.03) return null;
  const left = (elapsedMs * (total - done)) / done;
  return Math.max(0, Math.ceil(left / 60000));
}

/** „Noch etwa 3 Minuten“, as the line under the button says it. */
export function minutesLeftText(minutes: number | null): string {
  if (minutes === null) return 'Ich schätze noch, wie lange es dauert.';
  if (minutes <= 1) return 'Noch etwa eine Minute';
  if (minutes >= 90) return `Noch etwa ${Math.round(minutes / 60)} Stunden`;
  return `Noch etwa ${minutes} Minuten`;
}

/** The folder numbers still free after `n` would be taken. */
export function freeAfter(free: readonly number[], n: number): number {
  return free.filter((x) => x !== n).length;
}
