/**
 * A cache for loaded resources that cost memory, such as decoded pictures.
 *
 * Entries count against a budget (in any unit, e.g. pixels); when it is
 * exceeded, the least recently used entries are freed. Whoever uses a value
 * leases it and releases the lease when done: a leased value is never freed
 * under its user's hands, an entry dropped meanwhile is freed with the last
 * release. Failed loads are not kept, so the next lease tries again.
 */

export interface Lease<T> {
  value: T;
  /** Ends the lease; calling it again does nothing. */
  release(): void;
}

interface Entry<T> {
  promise: Promise<T>;
  value?: T;
  cost: number;
  leases: number;
  /** No longer in the cache: free when the last lease ends. */
  dropped: boolean;
}

export class LeaseCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly budget: number,
    private readonly costOf: (value: T) => number,
    private readonly free: (value: T) => void,
  ) {}

  /** The value for `key`, loaded with `load` when it is not cached. */
  async lease(key: string, load: () => Promise<T>): Promise<Lease<T>> {
    let entry = this.entries.get(key);
    if (entry) {
      // Most recently used last.
      this.entries.delete(key);
      this.entries.set(key, entry);
    } else {
      const created: Entry<T> = { promise: load(), cost: 0, leases: 0, dropped: false };
      entry = created;
      this.entries.set(key, created);
      created.promise.then(
        (value) => {
          created.value = value;
          created.cost = Math.max(0, this.costOf(value));
          if (created.dropped && created.leases === 0) this.free(value);
          else this.trim();
        },
        () => {
          if (this.entries.get(key) === created) this.entries.delete(key);
        },
      );
    }
    const e = entry;
    e.leases++;
    let value: T;
    try {
      value = await e.promise;
    } catch (err) {
      e.leases--;
      throw err;
    }
    let released = false;
    return {
      value,
      release: () => {
        if (released) return;
        released = true;
        e.leases--;
        if (e.leases > 0) return;
        if (e.dropped) this.free(value);
        else this.trim();
      },
    };
  }

  /** Removes an entry; its value is freed now or when its last lease ends. */
  drop(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    e.dropped = true;
    if (e.leases === 0 && e.value !== undefined) this.free(e.value);
  }

  /** Total cost of the loaded entries. */
  get usage(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.cost;
    return total;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Frees least recently used entries until the budget holds; leased and loading entries stay. */
  private trim(): void {
    let total = this.usage;
    for (const [key, e] of this.entries) {
      if (total <= this.budget) return;
      if (e.leases > 0 || e.value === undefined) continue;
      this.entries.delete(key);
      e.dropped = true;
      total -= e.cost;
      this.free(e.value);
    }
  }
}
