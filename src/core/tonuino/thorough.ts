/**
 * "Gründlich prüfen": reads every MP3 of the SD card once from start to end.
 * The quick check looks at names and folders only; this one finds what the
 * box stumbles over while playing:
 * - files that are broken inside (many bytes that are no audio, or the
 *   frames lose their beat twice or more: isDamagedMp3), or no MP3 at all,
 *   and files cut off while written (sd.ts OPEN_SUFFIX);
 * - files the card cannot read back. That is often the first sign of a card
 *   that wears out: then the whole card should be built anew, on a new one.
 * Nothing is written. Takes a while on a full card; it can be stopped.
 */
import type { Dir, ByteSource } from '../../platform/types';
import { checkMp3, type Mp3Check } from '../audio/mp3frames';
import { isAbortError } from '../audio/errors';
import type { SdScan } from './sd';

export interface ThoroughFile {
  folder: number;
  /** The folder's name on the card, e.g. "05". */
  folderName: string;
  file: string;
}

export interface ThoroughResult {
  /** Files read to the end. */
  checked: number;
  /** Bytes read. */
  bytes: number;
  /** Broken inside, or no MP3 at all. */
  damaged: ThoroughFile[];
  /** Could not be read: the card may be wearing out. */
  unreadable: (ThoroughFile & { error: string })[];
  /** Stopped before the end. */
  stopped: boolean;
}

export interface ThoroughProgress {
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  /** The file being read. */
  current?: ThoroughFile;
}

export interface ThoroughOptions {
  signal?: AbortSignal;
  onProgress?: (p: ThoroughProgress) => void;
  /** The check per file (tests). */
  check?: (source: ByteSource, signal?: AbortSignal) => Promise<{ check: Mp3Check }>;
}

/** The MP3s of the folders 01 to 99, in order. WAV files are left out: the box plays them rarely, and they are read as they are. */
export function thoroughTargets(scan: SdScan): (ThoroughFile & { size: number })[] {
  const out: (ThoroughFile & { size: number })[] = [];
  for (const f of [...scan.folders].sort((a, b) => a.number - b.number)) {
    for (const t of f.tracks) if (t.ext === 'mp3' && t.size > 0) out.push({ folder: f.number, folderName: f.name, file: t.name, size: t.size });
  }
  return out;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function thoroughCheck(root: Dir, scan: SdScan, opts: ThoroughOptions = {}): Promise<ThoroughResult> {
  const targets = thoroughTargets(scan);
  const bytesTotal = targets.reduce((n, t) => n + t.size, 0);
  const check = opts.check ?? ((source, signal) => checkMp3(source, { signal }));
  const result: ThoroughResult = { checked: 0, bytes: 0, damaged: [], unreadable: [], stopped: false };
  // Cut off while written (card pulled): broken whatever the frames say, the end is missing.
  const unfinished = new Set(scan.folders.flatMap((f) => (f.unfinished ?? []).map((n) => `${f.name}/${n}`)));
  const dirs = new Map<string, Dir>();
  for (const [i, t] of targets.entries()) {
    if (opts.signal?.aborted) {
      result.stopped = true;
      break;
    }
    const file: ThoroughFile = { folder: t.folder, folderName: t.folderName, file: t.file };
    opts.onProgress?.({ done: i, total: targets.length, bytesDone: result.bytes, bytesTotal, current: file });
    if (unfinished.has(`${t.folderName}/${t.file}`)) {
      result.damaged.push(file);
      result.bytes += t.size;
      continue;
    }
    try {
      let dir = dirs.get(t.folderName);
      if (!dir) {
        dir = await root.dir(t.folderName);
        dirs.set(t.folderName, dir);
      }
      const { check: c } = await check(await dir.source(t.file), opts.signal);
      if (c.rebuild === 'damaged') result.damaged.push(file);
      result.checked++;
    } catch (e) {
      if (isAbortError(e) || opts.signal?.aborted) {
        result.stopped = true;
        break;
      }
      result.unreadable.push({ ...file, error: errorText(e) });
    }
    result.bytes += t.size;
  }
  if (!result.stopped) opts.onProgress?.({ done: targets.length, total: targets.length, bytesDone: result.bytes, bytesTotal });
  return result;
}

export type ThoroughVerdict = 'fine' | 'damaged' | 'wearing';

/** Worst first: a card that cannot read its files back, then broken files. */
export function thoroughVerdict(r: ThoroughResult): ThoroughVerdict {
  if (r.unreadable.length) return 'wearing';
  if (r.damaged.length) return 'damaged';
  return 'fine';
}

/** The broken files by folder, for the list in the dialog. */
export function byFolder(files: readonly ThoroughFile[]): { folder: number; folderName: string; files: string[] }[] {
  const map = new Map<number, { folder: number; folderName: string; files: string[] }>();
  for (const f of files) {
    const g = map.get(f.folder) ?? { folder: f.folder, folderName: f.folderName, files: [] };
    g.files.push(f.file);
    map.set(f.folder, g);
  }
  return [...map.values()].sort((a, b) => a.folder - b.folder);
}
