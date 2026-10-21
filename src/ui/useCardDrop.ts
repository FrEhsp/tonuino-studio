import { useEffect, useState } from 'preact/hooks';
import { chooserOpen, readDroppedCard } from '../app/pending';
import type { SnapshotPurpose } from '../platform/types';

/**
 * The SD card dropped onto an element (Firefox, Safari): the app reads it
 * as a snapshot. The reading arrives through app/pending, like one from
 * the folder chooser.
 */
export function useCardDrop(purpose: SnapshotPurpose) {
  const [over, setOver] = useState(false);
  const handlers = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget === e.target || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      setOver(false);
      // The browser empties the DataTransfer when this handler returns: readDroppedCard takes what it needs now.
      readDroppedCard(e.dataTransfer, purpose);
    },
  };
  return { over, handlers };
}

/** How long after coming back from the chooser the app waits before it says what may have gone wrong. */
export const CHOOSER_HINT_MS = 5000;

/**
 * True when the folder chooser was opened for `purpose`, the user is back
 * on the page and nothing arrived for a while: Firefox delivers nothing
 * when its question "Hochladen?" was declined.
 */
export function useChooserHint(purpose: SnapshotPurpose): boolean {
  const open = chooserOpen.value;
  const waiting = open?.purpose === purpose ? open.at : null;
  const [shownFor, setShownFor] = useState<number | null>(null);
  useEffect(() => {
    if (waiting === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const back = () => {
      // The pointer still moves a little while the chooser opens.
      if (timer !== undefined || Date.now() - waiting < 800) return;
      timer = setTimeout(() => setShownFor(waiting), CHOOSER_HINT_MS);
    };
    // While the chooser is open, the page has neither focus nor the pointer.
    window.addEventListener('focus', back);
    window.addEventListener('pointermove', back);
    window.addEventListener('pointerdown', back);
    window.addEventListener('keydown', back);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', back);
      window.removeEventListener('pointermove', back);
      window.removeEventListener('pointerdown', back);
      window.removeEventListener('keydown', back);
    };
  }, [waiting]);
  return waiting !== null && shownFor === waiting;
}
