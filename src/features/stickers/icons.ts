import { h, render } from 'preact';
import type { LucideIcon } from 'lucide-preact';

const cache = new Map<string, Promise<HTMLImageElement>>();

/**
 * A Lucide icon as an image for the canvas. The SVG is drawn at its final
 * size by the browser, so it stays sharp at 300 dpi.
 */
export function iconImage(icon: LucideIcon, color = '#ffffff', strokeWidth = 1.6): Promise<HTMLImageElement> {
  const key = `${icon.displayName ?? icon.name}|${color}|${strokeWidth}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const host = document.createElement('div');
      render(h(icon, { size: 512, color, strokeWidth }), host);
      let svg = host.innerHTML;
      render(null, host);
      if (!svg.includes('xmlns=')) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      return img;
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}
