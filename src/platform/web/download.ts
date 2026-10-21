import type { StartedDownload } from '../types';

/**
 * Hands a Blob to the browser as a download. The object URL stays until
 * dispose(), so the same download can be started again.
 */
export function startDownload(blob: Blob, name: string): StartedDownload {
  let url: string | null = URL.createObjectURL(blob);
  const start = () => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  };
  start();
  return {
    name,
    size: blob.size,
    again: start,
    dispose() {
      if (url) URL.revokeObjectURL(url);
      url = null;
    },
  };
}
