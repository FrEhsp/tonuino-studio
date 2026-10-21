import { useEffect, useRef, useState } from 'preact/hooks';
import type { ByteSource } from '../platform/types';
import { captureDrop, sourcesFromCapture } from '../platform/web/drop';
import { plat } from '../app/state';
import { toastError } from './components/Toast';
import { guardWindowDrops } from './dropGuard';
import { usePageShown } from '../app/pageAlive';

/**
 * Reads what was dropped. Runs in the drop handler: the browser empties the
 * DataTransfer when the handler returns, so the files are taken out before
 * anything is awaited (an `await import(...)` first would leave nothing).
 */
export function handleDrop(dt: DataTransfer, deliver: (sources: ByteSource[]) => void, fail: (err: unknown) => void): void {
  const dropped = captureDrop(dt);
  sourcesFromCapture(dropped).then(deliver).catch(fail);
}

/** Files dropped onto an element (browser) or onto the window (desktop app). */
export function useFileDrop(onSources: (sources: ByteSource[]) => void) {
  const [over, setOver] = useState(false);
  const p = plat();
  const cb = useRef(onSources);
  cb.current = onSources;
  // A page kept in the background (App.tsx) does not take files dropped onto the window.
  const shown = useRef(true);
  shown.current = usePageShown();
  useEffect(() => p.onFileDrop?.((sources) => shown.current && cb.current(sources)), [p]);
  // A file let go beside the zone must not replace the app in the tab.
  useEffect(() => (typeof window === 'undefined' ? undefined : guardWindowDrops()), []);
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
      handleDrop(
        e.dataTransfer,
        (sources) => cb.current(sources),
        (err) => toastError('Die Dateien ließen sich nicht lesen', err),
      );
    },
  };
  return { over, handlers };
}
