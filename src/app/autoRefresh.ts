import { useEffect } from 'preact/hooks';
import { card, rescan } from './state';

/** Back in the window: the card is read again (something may have changed on it meanwhile). */
export function useAutoRefresh() {
  useEffect(() => {
    const onFocus = () => {
      // A snapshot does not change behind the app's back: nothing to look at again.
      if (card.value?.status === 'ready' && card.value.volume.access !== 'snapshot') void rescan().catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
}
