import type { EntryLike } from '../snapshot';

/**
 * The card dropped onto the page. Must run in the drop handler itself: the
 * browser empties the DataTransfer when the handler returns (the entry
 * stays usable after that). Null when the drag holds no files.
 */
export function cardEntryFromDrop(dt: DataTransfer): { entry: EntryLike } | { problem: 'several-items' | 'not-a-folder' } | null {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  if (!items.length) return null;
  if (items.length > 1) return { problem: 'several-items' };
  const entry = (items[0].webkitGetAsEntry?.() as EntryLike | null) ?? null;
  if (!entry?.isDirectory) return { problem: 'not-a-folder' };
  return { entry };
}
