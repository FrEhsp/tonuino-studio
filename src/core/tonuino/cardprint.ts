import { files, type BlobFolder } from '../../platform/blobtree';
import { PACKAGE_FILE_PATTERN } from './package';
import { isJunk } from './sd';

/**
 * A short fingerprint of a card read in the browser (Firefox, Safari): every
 * entry of its root with the bytes and files below it. It tells a card that
 * has no catalog yet from another one, so a Paket remembered for one card
 * does not lock a different card.
 *
 * Left out: what the box ignores and what computers add on their own (junk
 * like ".Trashes" or "._001.mp3"), and a Paket saved onto the card itself.
 */
export type CardPrint = [name: string, bytes: number, files: number][];

function counts(node: BlobFolder): { bytes: number; files: number } {
  let bytes = 0;
  let n = 0;
  for (const { path, file } of files(node)) {
    if (path.split('/').some(isJunk)) continue;
    bytes += file.blob.size;
    n++;
  }
  return { bytes, files: n };
}

/** The fingerprint of a card's root, in a fixed order. */
export function cardPrint(root: BlobFolder): CardPrint {
  const out: CardPrint = [];
  for (const c of root.children) {
    if (isJunk(c.name)) continue;
    if (c.kind === 'file') {
      if (PACKAGE_FILE_PATTERN.test(c.name)) continue;
      out.push([c.name.toLowerCase(), c.blob.size, 1]);
    } else {
      const { bytes, files: n } = counts(c);
      out.push([`${c.name.toLowerCase()}/`, bytes, n]);
    }
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** What a card looked like when read, and what it looks like once the Paket is on it. */
export interface WaitingPrint {
  before: CardPrint;
  after: CardPrint;
  /** Root entries the user deletes on the card while unpacking (folders the Paket replaces, or removes). */
  mayBeGone: string[];
  /** A whole-card Paket: the card gets formatted first, so any entry may be gone. */
  formatted: boolean;
}

type State = [number, number] | null;

function stateMap(p: CardPrint): Map<string, [number, number]> {
  return new Map(p.map(([name, bytes, n]) => [name, [bytes, n]]));
}

const same = (a: State, b: State) => (a === null || b === null ? a === b : a[0] === b[0] && a[1] === b[1]);

/**
 * Whether a card read now can be the one the Paket waits for: every entry of
 * its root is as it was when read, or as the Paket brings it, or (while
 * unpacking) deleted. A card with other content is a different card.
 *
 * Two cards with exactly the same content cannot be told apart (two empty
 * cards, say); then the Paket waits for both, and "Paket verwerfen" ends it.
 */
export function fitsWaitingPrint(now: CardPrint, w: WaitingPrint): boolean {
  const cur = stateMap(now);
  const before = stateMap(w.before);
  const after = stateMap(w.after);
  const gone = new Set(w.mayBeGone.map((n) => n.toLowerCase()));
  const names = new Set([...cur.keys(), ...before.keys(), ...after.keys()]);
  for (const name of names) {
    const state: State = cur.get(name) ?? null;
    if (same(state, before.get(name) ?? null) || same(state, after.get(name) ?? null)) continue;
    if (state === null && (w.formatted || gone.has(name.replace(/\/$/, '')))) continue;
    return false;
  }
  return true;
}
