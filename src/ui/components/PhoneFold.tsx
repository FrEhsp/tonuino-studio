import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { PHONE_QUERY, useMedia } from '../useMedia';

/**
 * A part of a page that is set once and then rarely touched (how stickers
 * look, the paper, the way cards are written). On a phone it folds to one
 * line saying what is chosen, with "ändern" to open it, so the page is
 * short; on wider screens it shows as it is. Once opened it stays open
 * while the page lives.
 */
export function PhoneFold({ summary, label, children }: { summary: ComponentChildren; label: string; children: ComponentChildren }) {
  const narrow = useMedia(PHONE_QUERY);
  const [open, setOpen] = useState(false);
  if (!narrow || open) return <>{children}</>;
  return (
    <button type="button" class="fold-line" aria-expanded="false" aria-label={`${label} ändern`} onClick={() => setOpen(true)}>
      <span class="fold-summary">{summary}</span>
      <span class="fold-open" aria-hidden="true">
        ändern
      </span>
    </button>
  );
}
