/**
 * Long writes must not be cut short by closing the app: a box without
 * firmware does not start, and half a repair hides tracks from the box.
 * Every such write holds the guard while it runs, and so do downloads from
 * "Entdecken" and a selection under "Hinzufügen" that closing would throw away. As long as one does,
 * closing asks first: the browser with its own question (beforeunload), the
 * desktop app with ours, which says what is being written and what closing
 * would do to it.
 */
import { effect, signal } from '@preact/signals';
import type { Platform } from '../platform/types';

/** Writes that leave something broken when they stop half-way, and downloads that would be lost. */
export type WriteKind = 'firmware' | 'sounds' | 'repair' | 'order' | 'tracks' | 'tags' | 'downloads' | 'covers' | 'selection';

/** What closing in the middle of a write would do, most serious first. */
export const CLOSE_RISKS: Readonly<Record<WriteKind, string>> = {
  firmware: 'Gerade wird die Firmware aufgespielt. Wenn du jetzt schließt, kann die Box danach nicht mehr starten.',
  sounds: 'Gerade werden die Systemansagen auf die SD-Karte geschrieben. Wenn du jetzt schließt, fehlen der Box danach Ansagen.',
  repair: 'Gerade wird die SD-Karte repariert. Wenn du jetzt schließt, bleibt die Reparatur halb fertig. Dann findet die Box manche Titel nicht.',
  order: 'Gerade werden Titel neu sortiert. Wenn du jetzt schließt, fehlen danach Titel auf der Karte.',
  tracks: 'Gerade werden Titel auf die SD-Karte geschrieben. Wenn du jetzt schließt, ist danach nur ein Teil davon auf der Karte.',
  tags: 'Gerade werden Titel-Infos in die Dateien auf der SD-Karte geschrieben. Wenn du jetzt schließt, haben nur manche Titel die neuen Infos.',
  downloads: 'Gerade lade ich Titel aus „Entdecken“, oder geladene Titel warten noch auf die SD-Karte. Wenn du jetzt schließt, musst du sie noch einmal laden.',
  covers: 'Gerade werden Cover auf die SD-Karte geschrieben. Wenn du jetzt schließt, fehlen danach die neuen Cover.',
  // Nothing is written yet: the files picked under „Hinzufügen“ live only in the app.
  selection: 'Gerade wartet deine Auswahl unter „Hinzufügen“. Wenn du jetzt schließt, musst du die Dateien neu auswählen.',
};

const ORDER = Object.keys(CLOSE_RISKS) as WriteKind[];

/** Where the app can be closed: a browser tab, or the window of the desktop app. */
export interface CloseHost {
  /**
   * Starts asking before the app closes. A browser asks by itself; the
   * desktop app keeps its window open and calls `ask` instead. Returns the
   * function that stops it.
   */
  guard(ask: () => void): () => void;
  /** Closes the app right away, without asking (desktop app). */
  close?(): Promise<void>;
}

type EventHost = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * The browser's "Seite verlassen?" question for a closing tab or a reload,
 * and in the desktop app also the close button of the window.
 */
export function closeHostFor(p: Pick<Platform, 'holdWindowOpen' | 'closeWindow'>, page: EventHost | undefined = typeof window === 'undefined' ? undefined : window): CloseHost {
  const closeWindow = p.closeWindow?.bind(p);
  return {
    guard(ask) {
      const warn = (e: Event) => {
        e.preventDefault();
        // Older Chromium versions only ask with this set.
        (e as BeforeUnloadEvent).returnValue = true;
      };
      page?.addEventListener('beforeunload', warn);
      const release = p.holdWindowOpen?.(ask);
      return () => {
        page?.removeEventListener('beforeunload', warn);
        release?.();
      };
    },
    close: closeWindow,
  };
}

export class WriteGuard {
  /** The writes running now, most serious first, each kind once. */
  readonly running = signal<readonly WriteKind[]>([]);
  /** Someone wanted to close the app while something was written: the question shows. */
  readonly asking = signal(false);

  private readonly holds: { kind: WriteKind }[] = [];
  private host: CloseHost | null;
  private stop: (() => void) | null = null;

  constructor(host: CloseHost | null = null) {
    this.host = host;
  }

  /** Where closing is asked about; a guard that is on moves to the new host. */
  connect(host: CloseHost | null): void {
    this.disarm();
    this.host = host;
    this.sync();
  }

  /**
   * Holds the guard until the returned function is called. Each write holds
   * its own: the guard stays on until the last one is done. Releasing twice
   * does no harm.
   */
  hold(kind: WriteKind): () => void {
    const entry = { kind };
    this.holds.push(entry);
    this.sync();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holds.splice(this.holds.indexOf(entry), 1);
      this.sync();
    };
  }

  /** Runs `write` while holding the guard; lets go when it succeeds, fails or is cancelled. */
  async during<T>(kind: WriteKind, write: () => Promise<T>): Promise<T> {
    const release = this.hold(kind);
    try {
      return await write();
    } finally {
      release();
    }
  }

  /** "Offen lassen": the question goes away, the guard stays on. */
  keepOpen(): void {
    this.asking.value = false;
  }

  /**
   * "Trotzdem schließen": stops asking and closes the app. When that fails,
   * the guard is on again and the error goes to the caller.
   */
  async closeAnyway(): Promise<void> {
    const close = this.host?.close;
    if (!close) return;
    // Without this a browser part of the host would ask a second time.
    this.disarm();
    try {
      await close();
      this.asking.value = false;
    } catch (e) {
      this.sync();
      throw e;
    }
  }

  private ask(): void {
    // Nothing runs any more: the window closes without a question.
    if (!this.holds.length) {
      void this.host?.close?.().catch(() => undefined);
      return;
    }
    this.asking.value = true;
  }

  private sync(): void {
    const kinds = new Set(this.holds.map((h) => h.kind));
    const running = ORDER.filter((k) => kinds.has(k));
    // peek: a hold taken inside an effect (holdWhile) must not make that effect depend on the list.
    if (running.join() !== this.running.peek().join()) this.running.value = running;
    if (this.holds.length && !this.stop && this.host) this.stop = this.host.guard(() => this.ask());
    else if (!this.holds.length) this.disarm();
  }

  private disarm(): void {
    this.stop?.();
    this.stop = null;
  }
}

/**
 * Holds the guard for `kind` as long as `on()` is true, read as a signal:
 * the guard follows each change. Returns the function that stops following
 * (and lets go).
 */
export function holdWhile(guard: WriteGuard, kind: WriteKind, on: () => boolean): () => void {
  return effect(() => {
    if (!on()) return;
    return guard.hold(kind);
  });
}

/** The guard of the app; boot() connects it to the platform. */
export const writeGuard = new WriteGuard();
