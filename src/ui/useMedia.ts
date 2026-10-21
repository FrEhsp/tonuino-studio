import { useEffect, useState } from 'preact/hooks';

/** Phone-sized screens: the width where the pages fold their extras away (handy.css). */
export const PHONE_QUERY = '(max-width: 560px)';

function media(query: string): MediaQueryList | undefined {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `query` matches now; follows turning the phone and resizing the window. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => media(query)?.matches ?? false);
  useEffect(() => {
    const m = media(query);
    if (!m) return;
    const update = () => setOn(m.matches);
    update();
    m.addEventListener?.('change', update);
    return () => m.removeEventListener?.('change', update);
  }, [query]);
  return on;
}
