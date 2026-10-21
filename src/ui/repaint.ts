import { signal } from '@preact/signals';

/**
 * Counts the moments in which the drawn canvases of the page may have lost
 * what was on them. WebKitGTK (the Linux app) gave back white canvases after
 * the print dialog: the sheet, the style pictures (Frank 2026-10-17). Every
 * canvas that draws itself also watches this and draws again when it changes.
 */
export const canvasEpoch = signal(0);

const listeners = new Set<() => void>();

/** Called before canvasEpoch changes, e.g. to forget cached renderings that may be blank now. */
export function onCanvasesLost(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** The canvases may be blank now: forget cached ones and draw everything again. */
export function canvasesLost(): void {
  for (const f of listeners) f();
  canvasEpoch.value++;
}

if (typeof window !== 'undefined') {
  window.addEventListener('afterprint', () => canvasesLost());
  // A canvas the browser had to drop and has given back empty.
  document.addEventListener('contextrestored', () => canvasesLost(), true);
}
