/**
 * Whether the box can write cards over USB (TODO #93, writecard.ts),
 * remembered in this browser: set when a connected box answered the
 * WRITECARD question (logsession.ts) or when the app put a build with the
 * write-card preview on it (boxbuild.ts), cleared when a box surely said no
 * or got a firmware without it. „Karten beschreiben“ offers „Über USB an die
 * Box“ while it is set, also on another day before the box is connected.
 */
import { signal } from '@preact/signals';

const KEY = 'tonuino-studio:box-writes-cards';

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export const boxWritesCards = signal<boolean>(load());

export function rememberBoxWritesCards(yes: boolean): void {
  boxWritesCards.value = yes;
  try {
    if (yes) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered: the next connection asks again.
  }
}
