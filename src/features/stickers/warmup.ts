/**
 * Which known work each folder of the card is (its colours and type, core/stickers/works.ts),
 * worked out ahead in a quiet moment after the card is read (Tempo #121). The result is kept per
 * catalog entry and by the folder's names, so „Sticker drucken“ opened for the first time, with
 * the folders without a sticker already chosen, no longer recognises 52 folders while one waits
 * (0.5.1 chose nothing there and recognised nothing). A changed catalog is gone over again; its
 * unchanged folders cost only a look-up then.
 *
 * Loaded by main.tsx right after the first frame; nothing here draws.
 */
import { effect } from '@preact/signals';
import type { Catalog } from '../../core/tonuino/catalog';
import { workColors } from '../../core/stickers/works';
import { catalog } from '../../app/state';
import { nextTask } from '../../ui/quiet';

/** At most this long in one go (ms): a click right then is not held up. */
const MAX_STEP_MS = 8;

/** At the latest after this long the first step comes also while the app is busy (ms): the page may be opened soon after the card was read. */
const AT_LATEST_MS = 300;

/** When to go on: `first` waits for a quiet moment, `next` only gives the browser a turn (a frame, a click) between two steps. */
export interface WarmSchedule {
  first: (run: () => void) => void;
  next: (run: () => void) => void;
}

const browserSchedule: WarmSchedule = {
  // WebKit (the Linux and Mac apps) has no requestIdleCallback: a short wait then.
  first: (run) => (typeof requestIdleCallback === 'function' ? void requestIdleCallback(run, { timeout: AT_LATEST_MS }) : void setTimeout(run, 50)),
  next: (run) => void nextTask().then(run),
};

/**
 * Goes over the folders of `cat` from the next quiet moment on, in steps of a few milliseconds
 * with a turn for the browser between them (about 15 ms in all for 52 folders on a fast computer);
 * stops when `current()` says another catalog took its place.
 */
export function warmCatalog(cat: Catalog, current: () => boolean, schedule: WarmSchedule = browserSchedule, now: () => number = () => performance.now()): void {
  const entries = Object.values(cat.folders);
  let i = 0;
  const step = () => {
    if (!current()) return;
    const until = now() + MAX_STEP_MS;
    do workColors(entries[i++]);
    while (i < entries.length && now() < until);
    if (i < entries.length) schedule.next(step);
  };
  if (entries.length) schedule.first(step);
}

let installed = false;

/** Watches the open card (or the remembered box) and works its folders out ahead. */
export function installWarmup(): void {
  if (installed) return;
  installed = true;
  effect(() => {
    const cat = catalog.value;
    if (cat) warmCatalog(cat, () => catalog.peek() === cat);
  });
}
