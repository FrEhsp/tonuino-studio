import type { ByteSource, Dir, DirEntry, WriteOptions } from '../types';

/**
 * Dir on top of the File System Access API (Chrome, Edge). Directory order is
 * the order the operating system reports, which on FAT is the order of the
 * directory entries.
 *
 * On a Mac, a card with FAT keeps extra file data in a hidden twin next to
 * the file ("._001.mp3", AppleDouble). The box's MP3 player counts such twins
 * as titles. After writing, renaming or moving an entry the app removes the
 * twin of exactly that entry, never other "._" files.
 */

const CHUNK = 1024 * 1024;

function isNotFound(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');
}

type MovableHandle = FileSystemHandle & { move?: (target: FileSystemDirectoryHandle, name: string) => Promise<void> };

/** Errors that mean "the browser cannot move this here", not "the file is in trouble". */
function cannotMove(e: unknown): boolean {
  return e instanceof DOMException && ['NotSupportedError', 'NotAllowedError', 'InvalidStateError', 'AbortError'].includes(e.name);
}

/**
 * The browser took back the right to use the card. The message asks to click
 * „Zugriff erlauben“: the toast of the error brings that button along
 * (features/box/writeAccess.ts).
 */
export const ACCESS_LOST_MARK = 'Der Browser erlaubt den Zugriff nicht mehr.';

/** Turns browser errors into messages a family can act on. */
export function explainFsError(e: unknown, what: string): Error {
  if (e instanceof DOMException) {
    switch (e.name) {
      case 'NotFoundError':
        return new Error(`${what}: nicht gefunden. Steckt die SD-Karte noch?`);
      case 'NotAllowedError':
      case 'SecurityError':
        return new Error(`${what}: ${ACCESS_LOST_MARK} Klicke auf „Zugriff erlauben“.`);
      case 'QuotaExceededError':
        return new Error(`${what}: Die SD-Karte ist voll.`);
      case 'NoModificationAllowedError':
      case 'InvalidModificationError':
        return new Error(`${what}: Die Datei ist gesperrt oder schreibgeschützt. Ist der Schreibschutzschalter der SD-Karte auf „Lock“?`);
      case 'AbortError':
        return e;
    }
    return new Error(`${what}: ${e.message || e.name}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

export function fileSource(file: File, relativePath?: string, path?: string): ByteSource {
  return {
    name: file.name,
    size: file.size,
    blob: file,
    path,
    relativePath: relativePath ?? ((file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined),
    read: async (start, length) => new Uint8Array(await file.slice(start, start + length).arrayBuffer()),
  };
}

/** The hidden twins a Mac may write next to `name`. */
function twinsOf(name: string): string[] {
  return [`._${name}`, `._${name}.crswap`];
}

/** Removes the twins of an entry just written; never fails, a twin that stays shows in the health check. */
async function dropTwins(handle: FileSystemDirectoryHandle, name: string): Promise<void> {
  if (name.startsWith('._')) return;
  for (const twin of twinsOf(name)) {
    try {
      await handle.removeEntry(twin);
    } catch {
      // Not there (the usual case), or not removable.
    }
  }
}

export class FsaDir implements Dir {
  constructor(
    readonly handle: FileSystemDirectoryHandle,
    readonly path?: string,
  ) {}

  get name(): string {
    return this.handle.name;
  }

  private sub(name: string): string | undefined {
    return this.path !== undefined ? `${this.path}/${name}` : undefined;
  }

  async list(): Promise<DirEntry[]> {
    const out: DirEntry[] = [];
    try {
      for await (const [name, h] of this.handle.entries()) {
        if (h.kind === 'file') {
          // Chrome's "*.crswap" helper files are listed too: one left by an
          // interrupted save is junk the health check cleans up (see isJunk).
          try {
            const f = await (h as FileSystemFileHandle).getFile();
            out.push({ name, kind: 'file', size: f.size, modified: f.lastModified });
          } catch {
            out.push({ name, kind: 'file' });
          }
        } else {
          out.push({ name, kind: 'directory' });
        }
      }
    } catch (e) {
      throw explainFsError(e, `Ordner ${this.name || 'SD-Karte'} lesen`);
    }
    return out;
  }

  async dir(name: string, opts: { create?: boolean } = {}): Promise<Dir> {
    try {
      return new FsaDir(await this.handle.getDirectoryHandle(name, { create: !!opts.create }), this.sub(name));
    } catch (e) {
      throw explainFsError(e, `Ordner ${name}`);
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.handle.getFileHandle(name);
      return true;
    } catch (e) {
      if (!isNotFound(e)) throw explainFsError(e, name);
    }
    try {
      await this.handle.getDirectoryHandle(name);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw explainFsError(e, name);
    }
  }

  private async file(name: string): Promise<File> {
    try {
      return await (await this.handle.getFileHandle(name)).getFile();
    } catch (e) {
      throw explainFsError(e, name);
    }
  }

  async read(name: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.file(name)).arrayBuffer());
  }

  async readRange(name: string, start: number, length: number): Promise<Uint8Array> {
    const f = await this.file(name);
    return new Uint8Array(await f.slice(start, start + length).arrayBuffer());
  }

  async source(name: string): Promise<ByteSource> {
    return fileSource(await this.file(name), undefined, this.sub(name));
  }

  async write(name: string, data: Uint8Array | Blob, opts: WriteOptions = {}): Promise<void> {
    let writable: FileSystemWritableFileStream | undefined;
    let created = false;
    try {
      created = !(await this.exists(name));
      // Creating the file first fixes its place in the directory before Chrome's helper file appears.
      const fh = await this.handle.getFileHandle(name, { create: true });
      writable = await fh.createWritable({ keepExistingData: false });
      const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
      for (let pos = 0; pos < blob.size; pos += CHUNK) {
        opts.signal?.throwIfAborted();
        await writable.write(blob.slice(pos, Math.min(blob.size, pos + CHUNK)));
        opts.onProgress?.(Math.min(blob.size, pos + CHUNK));
      }
      await writable.close();
      writable = undefined;
    } catch (e) {
      await writable?.abort().catch(() => undefined);
      // A file that was not there before must not stay behind empty or half written.
      if (created) await this.handle.removeEntry(name).catch(() => undefined);
      throw explainFsError(e, `${name} schreiben`);
    }
    await dropTwins(this.handle, name);
  }

  async remove(name: string, opts: { recursive?: boolean } = {}): Promise<void> {
    try {
      await this.handle.removeEntry(name, { recursive: !!opts.recursive });
    } catch (e) {
      // Chrome reports a folder that still has entries like a locked file; a file stays a locked file.
      if (!opts.recursive && e instanceof DOMException && e.name === 'InvalidModificationError' && (await this.isFolder(name))) {
        throw new Error(`${name} löschen: Der Ordner ist nicht leer.`);
      }
      throw explainFsError(e, `${name} löschen`);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    if (from.toLowerCase() === to.toLowerCase()) {
      // Only the case changes. On FAT both spellings are one entry; a detour gives it the new one.
      if (await this.hasEntryNamed(to)) throw new Error(`${to} gibt es schon.`);
      const detour = `${to}.tmp-${Date.now()}`;
      await this.rename(from, detour);
      await this.rename(detour, to);
      return;
    }
    await this.moveEntry(from, this, to, `${from} umbenennen`, `${to} gibt es schon.`);
    await dropTwins(this.handle, to);
  }

  async move(name: string, target: Dir, newName?: string): Promise<void> {
    if (!(target instanceof FsaDir)) throw new Error('Verschieben ist nur innerhalb der SD-Karte möglich.');
    const to = newName ?? name;
    if (await this.handle.isSameEntry(target.handle)) return this.rename(name, to);
    await this.moveEntry(name, target, to, `${name} verschieben`, `${to} gibt es dort schon.`);
    await dropTwins(target.handle, to);
  }

  /**
   * Moves or renames without ever replacing anything: the browser's move()
   * would overwrite an existing file without asking.
   */
  private async moveEntry(name: string, target: FsaDir, to: string, what: string, taken: string): Promise<void> {
    const h = await this.entryHandle(name);
    if (await target.exists(to)) throw new Error(taken);
    if (h.kind === 'directory') return this.moveDir(h as FileSystemDirectoryHandle, name, target, to, what);
    if (await this.nativeMove(h, target, to, what)) return;
    await target.copyChecked(to, await this.file(name));
    await this.remove(name);
  }

  /**
   * Writes a copy and checks it has the size of the original before the
   * caller removes that: a copy cut short (full card, card pulled) must
   * never be all that is left.
   */
  private async copyChecked(name: string, file: File): Promise<void> {
    await this.write(name, file);
    if ((await this.file(name)).size !== file.size) throw new Error(`${this.sub(name) ?? name} ist nach dem Kopieren nicht vollständig.`);
  }

  /** The browser's own move(). False when it has none, or none for this kind of entry. */
  private async nativeMove(h: FileSystemHandle, target: FsaDir, to: string, what: string): Promise<boolean> {
    const move = (h as MovableHandle).move;
    if (typeof move !== 'function') return false;
    try {
      await move.call(h, target.handle, to);
      return true;
    } catch (e) {
      if (cannotMove(e)) return false;
      throw explainFsError(e, what);
    }
  }

  /**
   * Moves a folder without copying its files: a new folder, every entry moved
   * over, then the empty old folder removed, so it works on a full card too.
   * It works as a whole or not at all: on an error what already moved goes
   * back and the new folder disappears again.
   */
  private async moveDir(src: FileSystemDirectoryHandle, name: string, target: FsaDir, to: string, what: string): Promise<void> {
    if (await this.nativeMove(src, target, to, what)) return;
    const entries: [string, FileSystemHandle][] = [];
    try {
      for await (const entry of src.entries()) entries.push(entry);
    } catch (e) {
      throw explainFsError(e, what);
    }
    const from = new FsaDir(src);
    if (entries.some(([, h]) => h.kind === 'file' && typeof (h as MovableHandle).move !== 'function')) {
      // A browser without move(): copy everything, and only then remove the original.
      try {
        await this.copyDir(src, target, to);
      } catch (e) {
        await target.handle.removeEntry(to, { recursive: true }).catch(() => undefined);
        throw explainFsError(e, what);
      }
      await this.remove(name, { recursive: true });
      return;
    }
    const dest = (await target.dir(to, { create: true })) as FsaDir;
    const moved: [string, FileSystemHandle][] = [];
    try {
      for (const [n, h] of entries) {
        if (h.kind === 'directory') await from.moveDir(h as FileSystemDirectoryHandle, n, dest, n, what);
        else if (!(await from.nativeMove(h, dest, n, what))) throw new Error(`${what}: Der Browser kann ${n} nicht verschieben.`);
        moved.push([n, h]);
      }
    } catch (e) {
      for (const [n, h] of moved.reverse()) {
        try {
          if (h.kind === 'directory') await dest.moveDir(await dest.handle.getDirectoryHandle(n), n, from, n, what);
          else await (h as MovableHandle).move!.call(h, src, n);
        } catch {
          // It stays in the new folder, which then stays too: nothing is lost.
        }
      }
      await target.handle.removeEntry(to).catch(() => undefined);
      throw explainFsError(e, what);
    }
    await this.remove(name);
  }

  private async isFolder(name: string): Promise<boolean> {
    try {
      await this.handle.getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  private async hasEntryNamed(name: string): Promise<boolean> {
    try {
      for await (const [n] of this.handle.entries()) if (n === name) return true;
    } catch (e) {
      throw explainFsError(e, name);
    }
    return false;
  }

  private async entryHandle(name: string): Promise<FileSystemHandle> {
    try {
      return await this.handle.getFileHandle(name);
    } catch (e) {
      if (!isNotFound(e)) throw explainFsError(e, name);
    }
    try {
      return await this.handle.getDirectoryHandle(name);
    } catch (e) {
      throw explainFsError(e, name);
    }
  }

  private async copyDir(src: FileSystemDirectoryHandle, targetParent: FsaDir, name: string): Promise<void> {
    const dest = (await targetParent.dir(name, { create: true })) as FsaDir;
    const from = new FsaDir(src);
    for (const e of await from.list()) {
      if (e.kind === 'directory') await from.copyDir(await src.getDirectoryHandle(e.name), dest, e.name);
      else await dest.copyChecked(e.name, await from.file(e.name));
    }
  }
}

/** All files below a directory handle, with their path relative to it. */
export async function collectFiles(handle: FileSystemDirectoryHandle, prefix = handle.name): Promise<ByteSource[]> {
  const out: ByteSource[] = [];
  for await (const [name, h] of handle.entries()) {
    if (name.startsWith('.') || name.endsWith('.crswap')) continue;
    if (h.kind === 'directory') out.push(...(await collectFiles(h as FileSystemDirectoryHandle, `${prefix}/${name}`)));
    else out.push(fileSource(await (h as FileSystemFileHandle).getFile(), `${prefix}/${name}`));
  }
  return out;
}
