import { childOf, sameContent, type BlobFile, type BlobFolder, type BlobNode } from '../../platform/blobtree';
import { belongsInFullPackage, isTempFolder, packedBytes, topLevelOrder } from './package';
import { APP_FILES, CATALOG_FILE, COVERS_FILE, isJunk, parseFolderNumber } from './sd';

/**
 * What has to happen on a card that was read as a snapshot (Firefox,
 * Safari) so it matches the app's changed copy. The unit is a whole entry
 * of the card's root: a folder that changed in any way is replaced as a
 * whole (delete it, unpack it again), which is what the TonUINO community
 * recommends anyway.
 */

export interface TopChange {
  kind: 'add' | 'replace' | 'remove';
  name: string;
  entry: 'directory' | 'file';
  /** 1 … 99 for a numbered folder. */
  folder?: number;
  system?: 'mp3' | 'advert';
  /** What goes into the Paket for it (for 'remove': what is on the card now). */
  bytes: number;
}

export interface WritePlan {
  /** In the order of the Paket. */
  changes: TopChange[];
  /** The app's catalog and covers when they changed; `empty`: no covers left, the Paket brings an empty file. */
  appFiles: { name: string; empty?: boolean }[];
  /** What to delete on the card before unpacking, in Paket order. */
  deleteFirst: string[];
  /**
   * Hidden files the app's copy no longer has, in folders that are otherwise
   * as on the card ("01/._001.mp3"). They are deleted on the card by hand:
   * a whole folder in the Paket for a 4-byte file would be out of all proportion.
   */
  deleteJunk: string[];
  /** The card had nothing on it but junk. */
  fresh: boolean;
  /**
   * Found on the card as it was read: junk in the box's folders (01 … 99,
   * mp3, advert) and repair helper folders that a Paket of changes would
   * leave there, and junk in the root (which the box ignores).
   */
  junk: { inFolders: number; atRoot: number; tempFolders: string[] };
  bytes: { changes: number; full: number };
  recommend: 'changes' | 'full';
  reasons: ('junk-in-folders' | 'temp-folders' | 'many-replacements')[];
  /** Number of things waiting for the card: every change, and the app files as one. */
  count: number;
}

/**
 * The plan without one of the app's files: for a catalog whose content is
 * the same as on the card and that was only saved at another time.
 */
export function withoutAppFile(plan: WritePlan, current: BlobFolder, name: string): WritePlan {
  const lower = name.toLowerCase();
  if (!plan.appFiles.some((f) => f.name.toLowerCase() === lower)) return plan;
  const appFiles = plan.appFiles.filter((f) => f.name.toLowerCase() !== lower);
  const node = childOf(current, name);
  const size = node?.kind === 'file' ? node.blob.size : 0;
  return { ...plan, appFiles, bytes: { ...plan.bytes, changes: plan.bytes.changes - size }, count: plan.changes.length + (appFiles.length ? 1 : 0) };
}

/** From this many replaced folders on, rebuilding the whole card is the better advice. */
export const MANY_REPLACEMENTS = 5;

const APP_NAMES = new Set<string>(APP_FILES.map((n) => n.toLowerCase()));

function junkIn(folder: BlobFolder): number {
  let n = 0;
  for (const c of folder.children) {
    if (isJunk(c.name)) n++;
    else if (c.kind === 'directory') n += junkIn(c);
  }
  return n;
}

function systemName(name: string): 'mp3' | 'advert' | undefined {
  const n = name.toLowerCase();
  return n === 'mp3' || n === 'advert' ? n : undefined;
}

/**
 * The junk below `was` that `now` no longer has, as paths ("01/._001.mp3");
 * null when the two differ in anything else.
 */
function junkRemoved(was: BlobNode, now: BlobNode, path: string): string[] | null {
  if (was.name !== now.name || was.kind !== now.kind) return null;
  if (was.kind === 'file') return was.blob === (now as BlobFile).blob ? [] : null;
  const rest = (now as BlobFolder).children;
  const out: string[] = [];
  let i = 0;
  for (const c of was.children) {
    const at = `${path}/${c.name}`;
    if (i < rest.length && rest[i].name === c.name) {
      const below = junkRemoved(c, rest[i++], at);
      if (!below) return null;
      out.push(...below);
    } else if (isJunk(c.name)) out.push(at);
    else return null;
  }
  return i === rest.length ? out : null;
}

/** Compares the card as read (`base`) with the app's copy (`current`). */
export function diffForPackage(base: BlobFolder, current: BlobFolder): WritePlan {
  const changes: TopChange[] = [];
  const appFiles: WritePlan['appFiles'] = [];
  const deleteJunk: string[] = [];
  const describe = (node: BlobNode, kind: TopChange['kind']): TopChange => {
    const folder = node.kind === 'directory' ? parseFolderNumber(node.name) : null;
    const system = node.kind === 'directory' ? systemName(node.name) : undefined;
    return { kind, name: node.name, entry: node.kind, ...(folder !== null ? { folder } : {}), ...(system ? { system } : {}), bytes: packedBytes(node) };
  };

  for (const c of current.children) {
    if (isJunk(c.name)) continue;
    const b = childOf(base, c.name);
    if (b && sameContent(b, c)) continue;
    const junkOnly = b?.kind === 'directory' ? junkRemoved(b, c, c.name) : null;
    if (junkOnly?.length) {
      deleteJunk.push(...junkOnly);
      continue;
    }
    if (c.kind === 'file' && APP_NAMES.has(c.name.toLowerCase()) && (!b || b.kind === 'file')) {
      appFiles.push({ name: c.name });
      continue;
    }
    changes.push(describe(c, b ? 'replace' : 'add'));
  }
  for (const b of base.children) {
    if (isJunk(b.name) || childOf(current, b.name)) continue;
    if (b.kind === 'file' && b.name.toLowerCase() === COVERS_FILE) {
      appFiles.push({ name: COVERS_FILE, empty: true });
      continue;
    }
    changes.push(describe(b, 'remove'));
  }
  changes.sort((a, b) => topLevelOrder(a, b));
  appFiles.sort((a, b) => (a.name.toLowerCase() === CATALOG_FILE ? -1 : b.name.toLowerCase() === CATALOG_FILE ? 1 : 0));

  // A file that is replaced is overwritten when unpacking; folders and what goes away have to be deleted.
  const deleteFirst = changes
    .filter((c) => c.kind === 'remove' || (c.kind === 'replace' && (c.entry === 'directory' || childOf(base, c.name)?.kind === 'directory')))
    .map((c) => c.name);

  const fresh = !base.children.some((c) => !isJunk(c.name));
  // What a Paket of changes leaves on the card as it is: folders it neither replaces nor removes.
  const untouched = base.children.filter((b) => {
    if (isJunk(b.name)) return false;
    const c = childOf(current, b.name);
    return !!c && sameContent(b, c);
  });
  const junk = {
    inFolders: untouched.reduce((n, c) => n + (c.kind === 'directory' && (parseFolderNumber(c.name) !== null || systemName(c.name)) ? junkIn(c) : 0), 0),
    atRoot: base.children.filter((c) => isJunk(c.name)).length,
    tempFolders: untouched.filter(isTempFolder).map((c) => c.name),
  };

  const appBytes = appFiles.reduce((n, f) => {
    if (f.empty) return n + 22;
    const node = childOf(current, f.name);
    return n + (node?.kind === 'file' ? node.blob.size : 0);
  }, 0);
  const bytes = {
    changes: changes.reduce((n, c) => n + (c.kind === 'remove' ? 0 : c.bytes), 0) + appBytes,
    full: current.children.reduce((n, c) => n + (belongsInFullPackage(c) ? packedBytes(c) : 0), 0),
  };

  const reasons: WritePlan['reasons'] = [];
  if (!fresh) {
    if (junk.inFolders > 0) reasons.push('junk-in-folders');
    if (junk.tempFolders.length) reasons.push('temp-folders');
    if (changes.filter((c) => c.kind === 'replace').length > MANY_REPLACEMENTS) reasons.push('many-replacements');
  }

  return {
    changes,
    appFiles,
    deleteFirst,
    deleteJunk,
    fresh,
    junk,
    bytes,
    recommend: reasons.length ? 'full' : 'changes',
    reasons,
    count: changes.length + (appFiles.length ? 1 : 0) + (deleteJunk.length ? 1 : 0),
  };
}
