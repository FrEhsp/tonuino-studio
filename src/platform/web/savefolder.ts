import type { Dir, SaveFolderPurpose } from '../types';
import { FsaDir } from './fsa';

/**
 * A folder the app may write into that is not the SD card: a place on the
 * computer for a backup, or another card to copy folders to. Chrome keeps a
 * separate start folder for each purpose. Unlike WebVolumes.pick() nothing
 * is stored, so the folder never shows up as an SD card.
 */

interface PickerHost {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}

const PICKER_ID: Record<SaveFolderPurpose, string> = { backup: 'tonuino-backup', copy: 'tonuino-copy', export: 'tonuino-export' };

export async function pickSaveFolder(opts: { purpose?: SaveFolderPurpose } = {}, host: PickerHost | undefined = typeof window === 'undefined' ? undefined : (window as PickerHost)): Promise<Dir | null> {
  if (!host?.showDirectoryPicker) return null;
  try {
    const handle = await host.showDirectoryPicker({ id: PICKER_ID[opts.purpose ?? 'backup'], mode: 'readwrite' });
    return new FsaDir(handle);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      throw new Error('Der Browser hat das Speichern in diesem Ordner nicht erlaubt. Wähle den Ordner noch einmal und erlaube der App, Dateien darin zu ändern. Manche Ordner sperrt der Browser ganz. Lege dann einen neuen Ordner an, zum Beispiel unter „Dokumente“, und wähle ihn aus.');
    }
    throw e;
  }
}

/** Whether `inner` is `outer` or lies inside it; null for folders that are not from the browser's folder access. */
export async function fsaWithin(inner: Dir, outer: Dir): Promise<boolean | null> {
  if (!(inner instanceof FsaDir) || !(outer instanceof FsaDir)) return null;
  try {
    if (await outer.handle.isSameEntry(inner.handle)) return true;
    return (await outer.handle.resolve(inner.handle)) !== null;
  } catch {
    return null;
  }
}
