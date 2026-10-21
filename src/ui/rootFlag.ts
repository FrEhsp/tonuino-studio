import { useEffect } from 'preact/hooks';
import { usePageShown } from '../app/pageAlive';

/**
 * A mark on <html> while a component is on the screen (`data-<name>`), for
 * styles elsewhere that depend on it (the toasts move up while an action bar
 * or a dialog is open). Instead of `body:has(...)`: with that, every element
 * added anywhere made the browser work out the styles of the whole app
 * again, and a jump in the player waited for it.
 */
const counts = new Map<string, number>();

export function useRootFlag(name: string, on = true): void {
  useEffect(() => {
    if (!on || typeof document === 'undefined') return undefined;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    document.documentElement.setAttribute(`data-${name}`, '');
    return () => {
      const left = (counts.get(name) ?? 1) - 1;
      counts.set(name, left);
      if (!left) document.documentElement.removeAttribute(`data-${name}`);
    };
  }, [name, on]);
}

/** The action bar at the bottom of a page (Hinzufügen, Entdecken): marked only while its page shows. */
export function ImportBarFlag(): null {
  useRootFlag('import-bar', usePageShown());
  return null;
}
