import { computed, effect, signal } from '@preact/signals';
import { arrange, layOut, moveSticker, movedOf, pinsOf, place, sameSpots, type Moved, type Spot } from '../../core/stickers/placement';
import { slotsPerSheet } from '../../core/stickers/slots';
import { stickerItems, type StickerItem } from './content';
import { template, usedSlots } from './design';

/**
 * Stickers moved by hand on the sheet (core/stickers/placement.ts): null while
 * they fill the labels in order. Only for this visit, like the labels marked
 * as gone; kept when the selection changes. Another paper or labels marked as
 * gone or back fill the labels anew in the order the stickers had.
 */
export const stickerPins = signal<Moved | null>(null);

export interface Placement {
  spots: Spot[];
  /** One array per sheet in slot order, null for an empty label. */
  pages: (StickerItem | null)[][];
  /** True when the stickers are not in their plain order. */
  moved: boolean;
}

/** Single pictures for a photo service have no sheet to move them on. */
const movable = computed(() => template.value.output !== 'images');

export const placement = computed<Placement>(() => {
  const items = stickerItems.value;
  const t = template.value;
  const used = usedSlots.value;
  const pins = movable.value ? stickerPins.value : null;
  const perSheet = slotsPerSheet(t);
  const keys = items.map((i) => i.key);
  const spots = place(keys, perSheet, used, pins);
  return { spots, pages: layOut(items, spots, perSheet), moved: !!pins && !sameSpots(spots, arrange(keys, perSheet, used)) };
});

/** Pins for the print files: none for single pictures. */
export const printPins = computed(() => (movable.value ? stickerPins.value : null));

/**
 * Puts the sticker on `from` onto `to` (moves or swaps). False when that
 * label cannot take it.
 */
export function placeSticker(from: Spot, to: Spot): boolean {
  if (!movable.value) return false;
  const keys = stickerItems.value.map((i) => i.key);
  const perSheet = slotsPerSheet(template.value);
  const pins = moveSticker(keys, placement.value.spots, from, to, perSheet, usedSlots.value);
  if (!pins) return false;
  stickerPins.value = movedOf(pins, perSheet, usedSlots.value);
  return true;
}

export function resetPlacement() {
  stickerPins.value = null;
}

// Once moved, every sticker keeps the label it has now: a new one, put into
// the first free label, stays there when another one is left out later.
// Filled anew in the plain order again, nothing counts as moved any more.
effect(() => {
  const moved = stickerPins.value;
  if (!moved || !movable.value) return;
  const now = placement.value;
  if (!now.moved) {
    stickerPins.value = null;
    return;
  }
  const keys = stickerItems.value.map((i) => i.key);
  const next = movedOf(pinsOf(keys, now.spots), slotsPerSheet(template.value), usedSlots.value);
  const pins = moved.pins;
  const same =
    next.perSheet === moved.perSheet &&
    next.blocked.join() === moved.blocked.join() &&
    Object.keys(next.pins).length === Object.keys(pins).length &&
    keys.every((k) => pins[k] && sameSpots([pins[k]], [next.pins[k]]));
  if (!same) stickerPins.value = next;
});
