/**
 * The covers the background search was not sure of (autoCovers.ts), to tap
 * where they are needed: on the card page under a folder without a cover,
 * and on the sticker screen for the chosen folders. A tap saves the picture
 * (never over a cover that is there), „Keins davon“ drops them for good.
 */
import { useEffect, useState } from 'preact/hooks';
import { folderName } from '../../core/tonuino/sd';
import type { CoverCandidate } from '../../core/stickers/coversearch';
import { Button } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast, toastError } from '../../ui/components/Toast';
import { SOURCE_LABEL } from '../box/CoverSearch';
import { dropProposal, takeProposal, type AutoCoverProposal } from './autoCoverState';
import '../../ui/styles/bulkcover.css';

function label(c: CoverCandidate): string {
  return `${c.title}${c.artist ? ` – ${c.artist}` : ''}${c.year ? `, ${c.year}` : ''} (${SOURCE_LABEL[c.source]})`;
}

/** One folder's hits as small pictures to tap, and „Keins davon“. */
export function ProposalPictures({ proposal, max = 5 }: { proposal: AutoCoverProposal; max?: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const shown = proposal.candidates.filter((c) => !broken.has(c.id)).slice(0, max);
  const take = async (c: CoverCandidate) => {
    setBusy(c.id);
    try {
      if (!(await takeProposal(proposal.folder, c.id))) toast.info('Kein Cover gespeichert', 'Das Bild ließ sich nicht laden, oder der Ordner hat inzwischen ein Cover.');
    } catch (e) {
      toastError('Das Cover ließ sich nicht speichern', e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div class="bulk-alts vorschlaege">
      {shown.map((c) => (
        <button
          key={c.id}
          type="button"
          class="bulk-alt"
          title={label(c)}
          aria-label={`Dieses Cover nehmen: ${label(c)}`}
          aria-busy={busy === c.id ? 'true' : undefined}
          disabled={busy !== null}
          onClick={() => void take(c)}
        >
          <img src={c.thumbUrl} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => setBroken((b) => new Set(b).add(c.id))} />
        </button>
      ))}
      <button type="button" class="link-button keins" disabled={busy !== null} onClick={() => void dropProposal(proposal.folder)}>
        Keins davon
      </button>
    </div>
  );
}

/** All folders with hits to choose from, one row each; closes by itself when none is left. */
export function ProposalsDialog({ proposals, rest = 0, onRest, onClose }: { proposals: readonly AutoCoverProposal[]; rest?: number; onRest?: () => void; onClose: () => void }) {
  const none = !proposals.length;
  useEffect(() => {
    if (none) onClose();
  }, [none]);
  return (
    <Dialog
      title="Cover zum Aussuchen"
      onClose={onClose}
      footer={
        <>
          {rest && onRest ? <Button onClick={onRest}>{rest === 1 ? 'Für den anderen Ordner suchen …' : `Für die anderen ${rest} Ordner suchen …`}</Button> : null}
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        </>
      }
    >
      <div class="stack">
        <p class="small muted" style={{ margin: 0 }}>
          {proposals.length === 1 ? 'Bei diesem Ordner' : 'Bei diesen Ordnern'} war ich mir nicht sicher. Wähle das passende Bild. Passt keins, nimm „Keins davon“.
        </p>
        {proposals.map((p) => (
          <div key={p.folder} class="vorschlag">
            <span class="ellipsis">
              <b>{folderName(p.folder)}</b> {p.title}
            </span>
            <ProposalPictures proposal={p} />
          </div>
        ))}
      </div>
    </Dialog>
  );
}
