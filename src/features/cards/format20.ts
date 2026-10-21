/**
 * The old card format of TonUINO 2.0 (version 1 in byte 4), for boxes that
 * still run it. Switched on under "Mehr" on the cards page; then every card
 * written with the reader, the phone or over Wi-Fi gets version 1. TonUINO
 * 2.0 has no special cards and no admin card, so those are marked as not
 * fitting. Remembered in this browser only.
 */
import { signal } from '@preact/signals';
import { FORMAT20_MODES } from '../../core/tonuino/modes';
import type { CardItem } from './items';

const KEY = 'tonuino-studio:card-format-20';

/** Said with a card in the old format of TonUINO 2.0. */
export const FORMAT20_NOTE = 'Kartenformat für TonUINO 2.0';

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export const format20 = signal<boolean>(load());

export function setFormat20(on: boolean): void {
  format20.value = on;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered; it still applies until the app closes.
  }
}

/** Why TonUINO 2.0 cannot use this card, or undefined. */
export function format20Problem(item: Pick<CardItem, 'data'>): string | undefined {
  const d = item.data;
  if (d.folder === 0) return 'TonUINO 2.0 kennt keine Spezialkarten.';
  if (!FORMAT20_MODES.includes(d.mode)) return 'Diesen Modus kennt TonUINO 2.0 nicht.';
  return undefined;
}

/** The items as cards for TonUINO 2.0: version 1, and what 2.0 cannot play marked as not fitting. */
export function asFormat20(items: CardItem[]): CardItem[] {
  return items.map((i) => {
    const problem = format20Problem(i);
    // The whole list is in the old format then: no need to say it per card.
    const summary = i.summary.startsWith(`${FORMAT20_NOTE} · `) ? i.summary.slice(FORMAT20_NOTE.length + 3) : i.summary;
    const out: CardItem = { ...i, summary, data: { ...i.data, version: 1 } };
    if (problem) out.unsupported = problem;
    return out;
  });
}
