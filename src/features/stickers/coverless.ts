/**
 * The folders of the open card (or the remembered box) without a cover, for
 * „Cover suchen“ wherever it is offered. On its own, so the card page can
 * ask without the code of the search dialog (BulkCoverDialog.tsx).
 */
import { useMemo } from 'preact/hooks';
import { coverlessFolders, type BulkTarget } from '../../core/stickers/bulkcover';
import { card, shownMemory } from '../../app/state';

/**
 * Folders on the open card that have no cover yet (see coverlessFolders).
 * `only` limits the list, e.g. to the folders picked for printing.
 */
export function coverlessOnCard(only?: readonly number[]): BulkTarget[] {
  const s = card.value;
  // The remembered box: the covers found wait on this device until its card is open again.
  const m = s ? null : shownMemory.value;
  if (m) return coverlessFolders(m.scan, m.catalog, m.coverUrls, only);
  if (s?.status !== 'ready' || !s.scan || !s.catalog) return [];
  return coverlessFolders(s.scan, s.catalog, s.covers, only);
}

/** Folders on the open card without a cover, kept up to date for entry points like "Cover suchen". */
export function useCoverless(only?: readonly number[]): BulkTarget[] {
  const s = card.value;
  const m = shownMemory.value;
  const key = only?.join(',');
  return useMemo(() => coverlessOnCard(only), [s?.scan, s?.catalog, s?.covers, s?.status, m?.catalog, m?.coverUrls, key]);
}
