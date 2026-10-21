/**
 * Keyboard moves inside a group where only one item can be reached with
 * Tab (tabs, radio buttons): the arrow keys go to the next or previous
 * item and wrap around, Home and End go to the first and last one. The
 * caller selects that item and moves the focus to it, as the ARIA
 * patterns for tabs and radio groups expect.
 */

/** The index to move to for `key`, or null when the key is not a move. */
export function arrowTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const from = index < 0 ? 0 : index;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (from + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * A keydown handler for such a group. `items` are the buttons in order
 * (query them from the group element), `current` the selected index;
 * `select` makes the item at the new index the selected one.
 */
export function arrowKeyHandler(current: number, select: (index: number) => void) {
  return (e: KeyboardEvent) => {
    const group = e.currentTarget as HTMLElement | null;
    const items = group ? Array.from(group.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"]')).filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true') : [];
    const at = items.indexOf(e.target as HTMLElement);
    const next = arrowTarget(e.key, at >= 0 ? at : current, items.length);
    if (next === null) return;
    e.preventDefault();
    select(next);
    items[next]?.focus();
  };
}
