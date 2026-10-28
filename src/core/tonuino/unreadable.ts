import type { Dir } from '../../platform/types';
import { CATALOG_FILE } from './sd';

/**
 * App files on a card that were there but could not be read (the card reader
 * dropped off while writing, a half-written file). Such a file is never
 * overwritten or removed until a later reading works: the app would put an
 * empty or stale state over what may still be rescued (0.5.1, cover loss).
 */
const unreadable = new WeakMap<Dir, Set<string>>();

export class UnreadableCardFile extends Error {
  constructor(readonly file: string) {
    super(
      file === CATALOG_FILE
        ? 'Die Namen auf der Karte ließen sich beim Einlesen nicht lesen. Damit nichts verloren geht, speichere ich keine Änderungen daran, bis die Karte wieder sauber gelesen ist.'
        : 'Die Cover auf der Karte ließen sich beim Einlesen nicht lesen. Damit sie nicht verloren gehen, ändere ich an den Covern nichts, bis die Karte wieder sauber gelesen ist.',
    );
    this.name = 'UnreadableCardFile';
  }
}

/** Notes how reading an app file went; a later good reading lifts the block. */
export function noteRead(root: Dir, file: string, ok: boolean): void {
  const set = unreadable.get(root);
  if (ok) {
    set?.delete(file);
    return;
  }
  if (set) set.add(file);
  else unreadable.set(root, new Set([file]));
}

/** App files of this card that failed to read, in no particular order. */
export function unreadableFiles(root: Dir): string[] {
  return [...(unreadable.get(root) ?? [])];
}

/** Throws before a write over or a removal of an app file that failed to read. */
export function assertWritable(root: Dir, file: string): void {
  if (unreadable.get(root)?.has(file)) throw new UnreadableCardFile(file);
}

/** A deliberate full replacement (copy to another card): what failed to read there goes anyway. */
export function forgetUnreadable(root: Dir): void {
  unreadable.delete(root);
}
