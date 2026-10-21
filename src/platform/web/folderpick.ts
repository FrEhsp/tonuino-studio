import type { SnapshotPurpose } from '../types';

/**
 * The folder chooser of browsers without folder access (Firefox, Safari):
 * one hidden <input type="file" webkitdirectory> that stays in the page.
 *
 * Nothing waits for it. Firefox fires neither "change" nor "cancel" when
 * the user declines its "Hochladen" question, so a promise could hang for
 * good; listeners just hear about each choice as it comes.
 */

export type FolderChoice = { purpose: SnapshotPurpose; files: File[] } | { purpose: SnapshotPurpose; cancelled: true };

let input: HTMLInputElement | null = null;
let purpose: SnapshotPurpose = 'card';
let openedAt = 0;
const listeners = new Set<(o: FolderChoice) => void>();

function emit(o: FolderChoice) {
  for (const cb of [...listeners]) cb(o);
}

function theInput(): HTMLInputElement {
  if (input?.isConnected) return input;
  const el = document.createElement('input');
  el.type = 'file';
  el.multiple = true;
  el.webkitdirectory = true;
  el.hidden = true;
  el.dataset.tsFolderpick = '';
  el.addEventListener('change', () => {
    const files = [...(el.files ?? [])];
    // Lets the same folder be chosen again later.
    el.value = '';
    emit({ purpose, files });
  });
  el.addEventListener('cancel', () => emit({ purpose, cancelled: true }));
  document.body.append(el);
  input = el;
  return el;
}

/** Opens the chooser. Must run in a click handler. */
export function openFolderChooser(p: SnapshotPurpose): void {
  const el = theInput();
  purpose = p;
  el.value = '';
  openedAt = Date.now();
  el.click();
}

export function onFolderChosen(cb: (o: FolderChoice) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** When the chooser was opened last (ms since epoch), 0 when never. */
export function lastChooserOpenedAt(): number {
  return openedAt;
}
