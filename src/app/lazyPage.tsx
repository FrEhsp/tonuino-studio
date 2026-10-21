import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Button, Callout } from '../ui/components/controls';

/**
 * A page whose code comes only when it is needed, so the start does not
 * wait for every page of the app (TODO #70). `preload` fetches it ahead,
 * in quiet moments after the start: then opening it is as quick as before.
 */
export interface LazyPage<P> {
  (props: P): preact.JSX.Element | null;
  preload: () => Promise<unknown>;
  /** Its code is there: it draws at once. */
  ready: () => boolean;
}

export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>): LazyPage<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const fetch = () =>
    (pending ??= load().then(
      (c) => (loaded = c),
      (e: unknown) => {
        // Tried again on the next visit (a short hiccup, or a web app updated on its server meanwhile).
        pending = null;
        throw e;
      },
    ));
  function Lazy(props: P) {
    const [page, setPage] = useState<{ c: ComponentType<P> | null; failed?: boolean }>(() => ({ c: loaded }));
    useEffect(() => {
      if (page.c) return undefined;
      let on = true;
      fetch().then(
        (c) => on && setPage({ c }),
        () => on && setPage({ c: null, failed: true }),
      );
      return () => {
        on = false;
      };
    }, []);
    const C = page.c;
    if (C) return <C {...props} />;
    if (!page.failed) return null;
    return (
      <div class="page narrow">
        <Callout tone="warning">
          <p>Diese Seite ließ sich nicht laden. Lade die App bitte neu.</p>
          <Button onClick={() => location.reload()}>Neu laden</Button>
        </Callout>
      </div>
    );
  }
  return Object.assign(Lazy, { preload: () => fetch().catch(() => undefined), ready: () => loaded !== null });
}
