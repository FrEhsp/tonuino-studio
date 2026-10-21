/**
 * At most one file chooser waits for an answer. Firefox sends no event at
 * all when someone declines its "Hochladen" question, so a pick could wait
 * forever; the next pick settles it first with the empty answer, and the
 * one before can clean up after itself (remove its hidden input).
 */
export class PickQueue<T> {
  private current: ((value: T) => void) | null = null;

  constructor(private readonly empty: T) {}

  /**
   * Starts a pick. Settles a pick that still waits with the empty answer,
   * then returns the function that settles this one; only its first call counts.
   */
  begin(settle: (value: T) => void): (value: T) => void {
    this.current?.(this.empty);
    let done = false;
    const finish = (value: T) => {
      if (done) return;
      done = true;
      if (this.current === finish) this.current = null;
      settle(value);
    };
    this.current = finish;
    return finish;
  }

  /** True while a pick waits for its answer. */
  get waiting(): boolean {
    return this.current !== null;
  }
}
