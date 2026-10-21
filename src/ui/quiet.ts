/**
 * Quiet moments for work nobody waits for: reading a folder's files on a
 * first visit, stickers of a page built ahead behind the shelf. Done while
 * someone scrolls, that work made the shelf, the track list and the
 * player's bar stutter.
 */

let lastScroll = 0;
if (typeof document !== 'undefined') {
  // Scrolling, and also a click, a key or a jump in the player: that work waits for those too.
  for (const type of ['scroll', 'wheel', 'pointerdown', 'keydown', 'input']) {
    document.addEventListener(type, () => (lastScroll = performance.now()), { capture: true, passive: true });
  }
}

/** When someone last scrolled, clicked, typed or moved a slider. */
export function lastActivity(): number {
  return lastScroll;
}

/** Waits until nobody has scrolled or clicked for `quietMs` and the browser is idle. */
export async function quietMoment(quietMs = 400): Promise<void> {
  for (let wait = lastScroll + quietMs - performance.now(); wait > 0; wait = lastScroll + quietMs - performance.now()) {
    await new Promise((r) => setTimeout(r, wait));
  }
  // WebKit (the Linux and Mac apps) has no requestIdleCallback.
  await new Promise<void>((r) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => r(), { timeout: 1000 }) : setTimeout(r, 16)));
}

let turns: Promise<unknown> = Promise.resolve();

/**
 * One after the other, each in a quiet moment of its own: many waiting at
 * once must not all start in the same one. The pause is longer: one heavy
 * step in the middle of scrolling must not look like its end.
 */
export function inQuietTurn<T>(run: () => Promise<T>): Promise<T> {
  const turn = turns.then(() => quietMoment(1500)).then(run);
  turns = turn.catch(() => undefined);
  return turn;
}
