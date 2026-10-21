import type JSZip from 'jszip';
import type { Dir } from '../../platform/types';
import { parseNumberedAudio, systemTrackName, type ParsedTrackName, type SystemDirName } from './sd';

/**
 * Installs the system announcements (folders mp3 and advert) from the
 * official TonUINO-TNG download. Both folders are replaced as a whole and
 * written in ascending order.
 */

export const TNG_SOUNDS_URL = 'https://tonuino.github.io/TonUINO-TNG/sd-card.zip';

export interface SoundFile {
  dir: SystemDirName;
  number: number;
  /** Name inside the zip, e.g. "0300_new_tag.mp3". */
  original: string;
  /** Text after the number, e.g. "_new_tag". */
  suffix: string;
  ext: ParsedTrackName['ext'];
  entry: JSZip.JSZipObject;
}

export interface SoundPackage {
  files: SoundFile[];
  bytes: number;
}

/** Reads the zip and finds mp3/ and advert/ at any depth ("sd-card/mp3/0001.mp3"). */
export async function readSoundPackage(zipBytes: Uint8Array): Promise<SoundPackage> {
  const { default: JSZipLib } = await import('jszip');
  const zip = await JSZipLib.loadAsync(zipBytes);
  const files: SoundFile[] = [];
  let bytes = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const parts = entry.name.split('/');
    const name = parts.pop()!;
    const dir = parts.pop()?.toLowerCase();
    if (dir !== 'mp3' && dir !== 'advert') continue;
    if (name.startsWith('._') || parts.includes('__MACOSX')) continue;
    const parsed = parseNumberedAudio(name);
    if (!parsed) continue;
    files.push({ dir, number: parsed.number, original: name, suffix: parsed.suffix, ext: parsed.ext, entry });
    bytes += (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  }
  if (!files.some((f) => f.dir === 'mp3') || !files.some((f) => f.dir === 'advert')) {
    throw new Error('Die Datei enthält keine Systemansagen (Ordner mp3 und advert fehlen).');
  }
  files.sort((a, b) => (a.dir === b.dir ? a.number - b.number : a.dir === 'mp3' ? -1 : 1));
  return { files, bytes };
}

export interface InstallProgress {
  done: number;
  total: number;
  current: string;
}

export async function installSystemSounds(
  root: Dir,
  pkg: SoundPackage,
  opts: { onProgress?: (p: InstallProgress) => void; signal?: AbortSignal } = {},
): Promise<{ written: number }> {
  let written = 0;
  const total = pkg.files.length;
  for (const dirName of ['mp3', 'advert'] as const) {
    // Find the folder whatever its case ("MP3") and replace it.
    const existing = (await root.list()).find((e) => e.kind === 'directory' && e.name.toLowerCase() === dirName);
    if (existing) await root.remove(existing.name, { recursive: true });
    const dir = await root.dir(dirName, { create: true });
    const seen = new Set<number>();
    for (const f of pkg.files) {
      if (f.dir !== dirName) continue;
      opts.signal?.throwIfAborted();
      // The download has a few numbers twice in some versions; the first one wins.
      if (seen.has(f.number)) continue;
      seen.add(f.number);
      const name = soundFileName(f);
      opts.onProgress?.({ done: written, total, current: `${dirName}/${name}` });
      await dir.write(name, await f.entry.async('uint8array'));
      written++;
    }
  }
  opts.onProgress?.({ done: total, total, current: '' });
  return { written };
}

/**
 * The name on the card: the four-digit number alone, "0300.mp3" for
 * "0300_new_tag.mp3" or "300_neue_karte.mp3". Some players (the AiO board,
 * the LKP player) find announcements only under the pure number, so the
 * text after it is dropped, whatever the setting for tracks says.
 */
export function soundFileName(f: Pick<SoundFile, 'number' | 'ext'>): string {
  return systemTrackName(f.number, f.ext);
}

/**
 * Without a network fetch only says "Failed to fetch" (in English). Says it
 * in plain words instead; a cancel stays a cancel.
 */
function offline(e: unknown): unknown {
  if (e instanceof DOMException && e.name === 'AbortError') return e;
  return new Error('Die Ansagen ließen sich nicht herunterladen. Prüfe die Internetverbindung und versuche es noch einmal.', { cause: e });
}

/** Downloads with progress. `fetchFn` is the platform's fetch (no CORS limits on desktop). */
export async function downloadWithProgress(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  onProgress?: (received: number, total?: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url, { signal });
  } catch (e) {
    throw offline(e);
  }
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status}). Prüfe die Internetverbindung und versuche es noch einmal.`);
  const total = Number(res.headers.get('content-length')) || undefined;
  if (!res.body) {
    let b: Uint8Array;
    try {
      b = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw offline(e);
    }
    onProgress?.(b.length, b.length);
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      throw offline(e);
    }
    const { value, done } = chunk;
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }
  const out = new Uint8Array(received);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
