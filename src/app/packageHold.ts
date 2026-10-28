/**
 * A Paket for the card is being packed, or is packed and waits for
 * „Paket speichern“. Until it is saved, the copy of the card must stay as it
 * was packed: a change in between makes the Paket stale („Seit dem Packen hat
 * sich etwas geändert“). Writes nobody asked for just now, such as the
 * automatic cover search, wait while this holds.
 */
import { computed, signal } from '@preact/signals';

const holds = signal(0);

export const packageInHand = computed(() => holds.value > 0);

/** Holds until the returned function is called; calling it twice does no harm. */
export function holdForPackage(): () => void {
  holds.value++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holds.value--;
  };
}
