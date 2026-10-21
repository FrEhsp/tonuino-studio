/** Small helpers for running work concurrently. */

/** Runs `fn` over all items with at most `limit` calls at once; results keep the order of the items. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/**
 * A promise to be settled from outside. Rejections nobody waits for are not
 * reported as unhandled; whoever awaits the promise still gets them.
 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Calls `fn` at most every `ms` milliseconds; `force` calls it right away. */
export function throttle(fn: () => void, ms: number): (force?: boolean) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (force = false) => {
    const now = Date.now();
    if (!force && now - last < ms) return;
    last = now;
    fn();
  };
}
