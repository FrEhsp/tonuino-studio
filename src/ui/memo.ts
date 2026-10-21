/**
 * `memo` without preact/compat: importing compat switches on its global
 * option hooks, which turn `onChange` on range inputs into `onInput` and so
 * froze the player's bar after a jump. Same rule as compat's memo: render
 * again only when a prop changed (compared with ===).
 */
import { h, type Component, type FunctionComponent } from 'preact';

function propsDiffer(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const key in a) if (!(key in b)) return true;
  for (const key in b) if (a[key] !== b[key]) return true;
  return false;
}

export function memo<P extends object>(inner: FunctionComponent<P>): FunctionComponent<P> {
  function shouldUpdate(this: Component<P>, next: P): boolean {
    return propsDiffer(this.props as Record<string, unknown>, next as Record<string, unknown>);
  }
  // Preact calls a function component with its instance as `this`.
  function Memoed(this: Component<P>, props: P) {
    this.shouldComponentUpdate = shouldUpdate;
    return h(inner, props);
  }
  Memoed.displayName = `Memo(${inner.displayName ?? inner.name})`;
  return Memoed as FunctionComponent<P>;
}
