import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

/**
 * Pages once opened stay mounted, hidden, so going back to one shows it
 * finished at once (App.tsx). Each knows here whether it is the one shown:
 * what reaches the whole window (a file dropped onto the desktop app) only
 * goes to the page in sight.
 */
export const PageShown = createContext(true);

export function usePageShown(): boolean {
  return useContext(PageShown);
}
