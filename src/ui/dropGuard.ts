/**
 * While a drop zone is on the page, a file let go next to it must not open in
 * the tab: the browser would leave the app, and with it a running download or
 * transfer. A zone handles its own drop first and calls preventDefault; any
 * other file drag gets the "no drop" cursor and is dropped nowhere.
 */

type FileDrag = Pick<DragEvent, 'dataTransfer' | 'defaultPrevented' | 'preventDefault' | 'target' | 'type'>;

/** Refuses a file drag that no drop zone took. Text and other drags, and file inputs, are left alone. */
export function refuseStrayFileDrag(e: FileDrag): void {
  const dt = e.dataTransfer;
  if (!dt || !dt.types.includes('Files') || e.defaultPrevented) return;
  const target = e.target as { closest?: (selector: string) => unknown } | null;
  if (typeof target?.closest === 'function' && target.closest('input[type="file"]')) return;
  e.preventDefault();
  if (e.type === 'dragover') dt.dropEffect = 'none';
}

type Target = Pick<Window, 'addEventListener' | 'removeEventListener'>;

const users = new Map<Target, number>();

/** Guards the window while at least one drop zone is mounted; returns the function that ends this zone's part. */
export function guardWindowDrops(win: Target = window): () => void {
  const n = users.get(win) ?? 0;
  users.set(win, n + 1);
  if (n === 0) {
    win.addEventListener('dragover', refuseStrayFileDrag);
    win.addEventListener('drop', refuseStrayFileDrag);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (users.get(win) ?? 1) - 1;
    if (left > 0) {
      users.set(win, left);
      return;
    }
    users.delete(win);
    win.removeEventListener('dragover', refuseStrayFileDrag);
    win.removeEventListener('drop', refuseStrayFileDrag);
  };
}
