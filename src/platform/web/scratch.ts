import { crc32, crc32OfBlob, rememberCrc32 } from '../../core/zip/crc32';
import { MEMORY_BUDGET, memoryScratch, ScratchFullError, SMALL_DATA, type ScratchStore } from '../overlay';
import type { WriteOptions } from '../types';

/**
 * Where new files wait for the Paket in the browser: the origin private
 * file system (OPFS), a folder of the browser's own on the computer's disk.
 * Files there are Files on disk, so a Paket of several gigabytes does not
 * need that much memory.
 *
 * Without OPFS (Firefox in a private window, Safari before 26 without
 * createWritable) new files stay in memory, up to a budget.
 *
 * Never calls navigator.storage.persist(): Firefox would ask the user.
 */

const DIR = 'tonuino-studio-staging';
/** Writes go to disk in pieces of at least this size. */
const CHUNK = 1024 * 1024;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** For trying the memory budget during development (see tests/e2e/memory-mode.mjs). */
const DEV_BUDGET_KEY = 'tonuino-studio:dev-scratch-budget';

function memoryBudget(): number {
  if (import.meta.env.DEV) {
    try {
      const v = Number(localStorage.getItem(DEV_BUDGET_KEY));
      if (v > 0) return v;
    } catch {
      // No storage: the normal budget.
    }
  }
  return MEMORY_BUDGET;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const isQuota = (e: unknown) => e instanceof DOMException && e.name === 'QuotaExceededError';

function sessionName(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Every open tab holds a Web Lock named after its folder until the store is
 * disposed or the tab closes. Cleaning up skips folders whose lock is held,
 * so a tab left open for days keeps the files of its Paket.
 */
const LOCK_PREFIX = 'tonuino-studio-scratch:';

type LockManagerLike = Pick<LockManager, 'request'>;

function lockManager(): LockManagerLike | undefined {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManagerLike }).locks : undefined;
  return locks && typeof locks.request === 'function' ? locks : undefined;
}

/** Holds the lock of a session folder; the returned function lets it go. */
function holdSessionLock(name: string): () => void {
  const locks = lockManager();
  let release = () => {};
  if (!locks) return release;
  const held = new Promise<void>((resolve) => (release = resolve));
  locks.request(LOCK_PREFIX + name, { mode: 'exclusive' }, () => held).catch(() => undefined);
  return release;
}

async function writeAll(w: FileSystemWritableFileStream, data: Uint8Array | Blob, opts: WriteOptions): Promise<number> {
  let crc = 0;
  let written = 0;
  if (data instanceof Uint8Array) {
    for (let at = 0; at < data.length; at += CHUNK) {
      opts.signal?.throwIfAborted();
      const part = data.subarray(at, at + CHUNK);
      crc = crc32(part, crc);
      await w.write(part as Uint8Array<ArrayBuffer>);
      written += part.length;
      opts.onProgress?.(written);
    }
    return crc;
  }
  const reader = data.stream().getReader();
  let batch: Uint8Array[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batchBytes) return;
    await w.write(new Blob(batch as BlobPart[]));
    written += batchBytes;
    batch = [];
    batchBytes = 0;
    opts.onProgress?.(written);
  };
  try {
    for (;;) {
      opts.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      crc = crc32(value, crc);
      batch.push(value);
      batchBytes += value.length;
      if (batchBytes >= CHUNK) await flush();
    }
    await flush();
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  return crc;
}

function opfsScratch(top: FileSystemDirectoryHandle, dir: FileSystemDirectoryHandle, name: string): ScratchStore {
  let n = 0;
  const releaseLock = holdSessionLock(name);
  return {
    kind: 'opfs',
    async put(data, opts = {}) {
      opts.signal?.throwIfAborted();
      const size = data instanceof Uint8Array ? data.length : data.size;
      if (size < SMALL_DATA) {
        // Small things (catalog, covers, system sounds) stay in memory.
        if (data instanceof Uint8Array) {
          const crc = crc32(data);
          const blob = new Blob([data as BlobPart]);
          rememberCrc32(blob, crc);
          opts.onProgress?.(size);
          return { blob, crc32: crc };
        }
        return { blob: data, crc32: await crc32OfBlob(data, { signal: opts.signal }) };
      }
      const file = `${++n}.bin`;
      const fh = await dir.getFileHandle(file, { create: true });
      let w: FileSystemWritableFileStream | undefined;
      let crc: number;
      try {
        w = await fh.createWritable();
        crc = await writeAll(w, data, opts);
        await w.close();
        w = undefined;
      } catch (e) {
        await w?.abort().catch(() => undefined);
        await dir.removeEntry(file).catch(() => undefined);
        if (isAbort(e)) throw e;
        if (isQuota(e)) throw new ScratchFullError('quota');
        throw e;
      }
      const blob = await fh.getFile();
      rememberCrc32(blob, crc);
      return { blob, crc32: crc };
    },
    async available() {
      try {
        const e = await navigator.storage.estimate();
        return e.quota !== undefined && e.usage !== undefined ? Math.max(0, e.quota - e.usage) : undefined;
      } catch {
        return undefined;
      }
    },
    async dispose() {
      await top.removeEntry(name, { recursive: true }).catch(() => undefined);
      releaseLock();
    },
  };
}

/** A store for this session: OPFS when it works, memory otherwise. */
export async function createScratchStore(): Promise<ScratchStore> {
  let root: FileSystemDirectoryHandle;
  try {
    if (!navigator.storage?.getDirectory) return memoryScratch({ budgetBytes: memoryBudget(), reason: 'budget' });
    root = await navigator.storage.getDirectory();
  } catch {
    // Firefox in a private window has no OPFS.
    return memoryScratch({ budgetBytes: memoryBudget(), reason: 'private' });
  }
  const name = sessionName();
  let top: FileSystemDirectoryHandle | undefined;
  try {
    top = await root.getDirectoryHandle(DIR, { create: true });
    const dir = await top.getDirectoryHandle(name, { create: true });
    // Safari before 26 has OPFS, but no createWritable outside a worker.
    const probe = await dir.getFileHandle('probe', { create: true });
    if (typeof probe.createWritable !== 'function') throw new Error('createWritable fehlt');
    const w = await probe.createWritable();
    await w.write(new Uint8Array(1));
    await w.close();
    await dir.removeEntry('probe');
    return opfsScratch(top, dir, name);
  } catch {
    await top?.removeEntry(name, { recursive: true }).catch(() => undefined);
    return memoryScratch({ budgetBytes: memoryBudget(), reason: 'budget' });
  }
}

/**
 * Removes what earlier sessions left (a closed tab, a crash), once it is
 * older than `maxAgeMs`. A folder whose tab is still open (its Web Lock is
 * held, see holdSessionLock) stays however old it is. Without Web Locks the
 * app cannot tell, so it removes nothing. Never throws.
 */
export async function cleanupScratch(maxAgeMs = MAX_AGE_MS): Promise<void> {
  try {
    const locks = lockManager();
    if (!locks || !navigator.storage?.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    let top: FileSystemDirectoryHandle;
    try {
      top = await root.getDirectoryHandle(DIR);
    } catch {
      return;
    }
    const old: string[] = [];
    for await (const name of top.keys()) {
      const m = /^s-(\d+)-/.exec(name);
      if (!m || Date.now() - Number(m[1]) > maxAgeMs) old.push(name);
    }
    for (const name of old) {
      // Taken only if no open tab holds it; held while removing, so nothing can start using it meanwhile.
      await locks
        .request(LOCK_PREFIX + name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          if (lock) await top.removeEntry(name, { recursive: true }).catch(() => undefined);
        })
        .catch(() => undefined);
    }
  } catch {
    // Nothing to clean, or no access: try again next time.
  }
}
