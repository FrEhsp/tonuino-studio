import type JSZip from 'jszip';
import type { ByteSource } from '../../platform/types';

/**
 * Albums packed as ZIP (Frank, 13.10.2026: „zip und rar Archive … als
 * Alben“): the files in the archive are taken as if the unpacked folder had
 * been picked. Each file sits under a folder named after the archive, so a
 * ZIP with the tracks at its top level still becomes one album with the
 * archive's name, and one with a folder per CD keeps its CDs apart.
 *
 * RAR and 7z stay out: their formats need code the app does not have, and
 * the file manager unpacks them with a right click.
 */

/** Bigger archives are not read into memory: the browser cannot hold them, the user unpacks them. */
export const ZIP_MAX_BYTES = 1.5 * 1024 ** 3;

export interface Unzipped {
  sources: ByteSource[];
  /** Why nothing came out of the archive, in plain German. */
  error?: string;
}

/** The archive's name without ".zip": the folder its files are put in. */
function archiveFolder(zip: ByteSource): string {
  const base = zip.name.replace(/\.zip$/i, '').trim() || 'Archiv';
  const dir = zip.relativePath?.includes('/') ? zip.relativePath.slice(0, zip.relativePath.lastIndexOf('/') + 1) : '';
  return dir + base;
}

/** Mac leftovers and hidden files that come along in many archives. */
function skipped(path: string): boolean {
  return path.split('/').some((part) => part === '__MACOSX' || part.startsWith('.'));
}

function blobSource(blob: Blob, name: string, relativePath: string): ByteSource {
  return {
    name,
    size: blob.size,
    blob,
    relativePath,
    read: async (start, length) => new Uint8Array(await blob.slice(start, start + length).arrayBuffer()),
  };
}

export async function unzipSource(zip: ByteSource, signal?: AbortSignal): Promise<Unzipped> {
  if (zip.size > ZIP_MAX_BYTES) {
    return { sources: [], error: 'ZIP-Datei: Sie ist zu groß, um sie hier zu öffnen. Entpacke sie zuerst und nimm dann den Ordner mit den Audiodateien.' };
  }
  // Loaded outside the try: a missing library is no broken ZIP.
  const { default: JSZipLib } = await import('jszip');
  let archive: JSZip;
  try {
    archive = await JSZipLib.loadAsync(zip.blob ?? (await zip.read(0, zip.size)));
  } catch (e) {
    const locked = e instanceof Error && /encrypt/i.test(e.message);
    return {
      sources: [],
      error: locked
        ? 'ZIP-Datei mit Passwort: Entpacke sie zuerst und nimm dann den Ordner mit den Audiodateien.'
        : 'ZIP-Datei: Sie lässt sich nicht öffnen, vielleicht ist sie unvollständig. Entpacke sie zuerst und nimm dann den Ordner mit den Audiodateien.',
    };
  }
  const folder = archiveFolder(zip);
  const sources: ByteSource[] = [];
  for (const entry of Object.values(archive.files)) {
    if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    if (entry.dir || skipped(entry.name)) continue;
    const name = entry.name.slice(entry.name.lastIndexOf('/') + 1);
    try {
      sources.push(blobSource(await entry.async('blob'), name, `${folder}/${entry.name}`));
    } catch {
      return { sources: [], error: 'ZIP-Datei: Sie lässt sich nicht ganz entpacken. Entpacke sie zuerst und nimm dann den Ordner mit den Audiodateien.' };
    }
  }
  if (!sources.length) return { sources, error: 'ZIP-Datei: Es ist nichts darin.' };
  return { sources };
}
