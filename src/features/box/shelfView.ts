import { signal } from '@preact/signals';

/**
 * How the shelf of "Meine Box" shows the folders (#80, regal audit of
 * 20.10.2026, design/meine-box-2026-10-20/audit.md):
 * - "cover": each folder as a white card with its square cover and number,
 *   small, many in a row (Frank 17.10.: "Ich fand die Karten charmant");
 * - "sticker": each folder's sticker as "Sticker drucken" prints it;
 * - "liste": one line per folder, in columns like a contents list.
 * The words are the ones Frank expected (12:57): "Sticker" is the printed
 * sticker, "Cover" the square of the cover.
 */
export type ShelfView = 'cover' | 'sticker' | 'liste';

const KEY = 'tonuino-studio:regal-ansicht';
const VIEWS: readonly ShelfView[] = ['cover', 'sticker', 'liste'];

/** What the audit found best where nothing was chosen: the covers, on every screen. */
export const DEFAULT_VIEW: ShelfView = 'cover';

function read(): ShelfView {
  try {
    const v = localStorage.getItem(KEY) as ShelfView | null;
    return v && VIEWS.includes(v) ? v : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

export const shelfView = signal<ShelfView>(typeof window === 'undefined' ? DEFAULT_VIEW : read());

export function setShelfView(v: ShelfView) {
  shelfView.value = v;
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // Private mode: for this session only.
  }
}
