/** Shelf tiles drawn ahead of the screen edge come first. */
const NEAR_MARGIN = '800px 0px';

let watcher: IntersectionObserver | null = null;
const onNear = new Map<Element, (near: boolean) => void>();

/**
 * Tells `cb` whether `el` is near the screen, through one observer for all
 * tiles. Without IntersectionObserver every tile counts as near. Returns the
 * function that stops watching.
 *
 * A module of its own, with no imports: the shelf stickers use it, and the
 * test of it loads in a blink, also on a busy computer.
 */
export function watchNear(el: Element, cb: (near: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    cb(true);
    return () => undefined;
  }
  watcher ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) onNear.get(e.target)?.(e.isIntersecting);
    },
    { rootMargin: NEAR_MARGIN },
  );
  onNear.set(el, cb);
  watcher.observe(el);
  return () => {
    onNear.delete(el);
    watcher?.unobserve(el);
  };
}
