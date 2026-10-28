/**
 * Quiet moments for work nobody waits for: reading a folder's files on a
 * first visit, stickers of a page built ahead behind the shelf. Done while
 * someone scrolls, that work made the shelf, the track list and the
 * player's bar stutter.
 */

let lastScroll = 0;
/** When a page last came to the front (pageComingUp). */
let lastPageUp = 0;
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

/**
 * Waits until nobody has scrolled or clicked for `quietMs`, no page came to the front in that time,
 * and the browser is idle. A change of page counts like a click: not every one comes from a click
 * (the browser's back button, the app after an import, the measuring mode), and the stickers of a page
 * built ahead were drawn right in the first frames of the next page then: the Werkstatt after „Sticker
 * drucken“ came at 2x 180–200 ms instead of 120 in 0.5.1 (Prüfrunde 2, Tempo).
 */
export async function quietMoment(quietMs = 400): Promise<void> {
  const since = () => Math.max(lastScroll, lastPageUp);
  for (let wait = since() + quietMs - performance.now(); wait > 0; wait = since() + quietMs - performance.now()) {
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

/**
 * Gives the browser a turn: what follows runs in a task of its own, so a frame can be painted
 * before it. Several stickers whose pictures arrive together are then drawn one task each instead
 * of in one long task that holds back the page coming to the front (Tempo #121). `scheduler.yield`
 * where there is one: its turn comes before other waiting tasks, so the drawing does not end up
 * behind everything else. A plain message instead came out slower in the speed check.
 */
export function nextTask(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof s?.yield === 'function') return s.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let settling: Promise<void> | null = null;

/**
 * A page just came to the front (App.tsx): its first frames are painted before the stickers on
 * it are drawn, so it shows at once and the drawing follows (Tempo #121).
 */
export function pageComingUp(): void {
  lastPageUp = performance.now();
  if (typeof requestAnimationFrame !== 'function') return;
  const mine: Promise<void> = new Promise((resolve) => {
    // Three frames: the one that shows the page, and two more, so a click or a look right after it is answered at once.
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))));
  });
  settling = mine;
  void mine.then(() => {
    if (settling === mine) settling = null;
  });
}

/** Resolved once the page that came to the front last is painted; null when none is coming up. */
export function pageSettled(): Promise<void> | null {
  return settling;
}
