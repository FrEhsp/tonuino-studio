/**
 * Native file dialogs and file drops. The backend registers everything the
 * user picks or drops in its allow-list; here the paths become ByteSources.
 *
 * Files inside a picked or dropped folder carry a relativePath that starts
 * with the folder's own name ("Bibi Blocksberg/CD 1/01 Intro.mp3"), like
 * the browser build, so album grouping sees the same paths everywhere.
 */
import type { ByteSource, Dir, PickFilesOptions, RecentDownload, SaveFolderPurpose } from '../types';
import type { Bridge } from './bridge';
import { PathByteSource, TauriDir } from './fs';

export interface PickedFileDto {
  path: string;
  name: string;
  size: number;
  relativePath?: string | null;
}

export interface PickedFolderDto {
  path: string;
  name: string;
  files?: PickedFileDto[] | null;
}

function toSources(bridge: Bridge, files: PickedFileDto[]): ByteSource[] {
  return files.map((f) => new PathByteSource(bridge, f));
}

function normalizeExtensions(extensions: string[] | undefined): string[] | null {
  const list = (extensions ?? []).map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean);
  return list.length ? [...new Set(list)] : null;
}

export async function pickFiles(bridge: Bridge, opts: PickFilesOptions): Promise<ByteSource[]> {
  const extensions = normalizeExtensions(opts.extensions);
  if (opts.directory) {
    const folder = await bridge.call<PickedFolderDto | null>('dialog', 'dialog_pick_folder', {
      purpose: 'import',
      extensions,
      title: 'Ordner auswählen',
    });
    return folder?.files ? toSources(bridge, folder.files) : [];
  }
  const multiple = opts.multiple ?? true;
  const files = await bridge.call<PickedFileDto[]>('dialog', 'dialog_pick_files', {
    multiple,
    extensions,
    title: multiple ? 'Dateien auswählen' : 'Datei auswählen',
  });
  return toSources(bridge, files);
}

interface RecentDownloadsDto {
  folder?: string | null;
  files: (PickedFileDto & { modifiedMs: number })[];
}

/** New audio files in the download folder; the backend makes only these readable. */
export async function recentDownloads(bridge: Bridge, sinceMs: number, extensions: readonly string[]): Promise<{ folder?: string; files: RecentDownload[] }> {
  const dto = await bridge.call<RecentDownloadsDto>('dialog', 'downloads_recent', { sinceMs: Math.max(0, Math.floor(sinceMs)), extensions: normalizeExtensions([...extensions]) ?? [] });
  return { ...(dto.folder ? { folder: dto.folder } : {}), files: dto.files.map((f) => ({ source: new PathByteSource(bridge, f), modifiedMs: f.modifiedMs })) };
}

const SAVE_TITLES: Record<SaveFolderPurpose, string> = {
  backup: 'Ordner für die Sicherung wählen',
  copy: 'SD-Karte der anderen Box wählen',
  export: 'Ordner auf dem Computer wählen',
};

/**
 * A folder the app may write into (purpose "card" in the backend grants
 * that), for a backup or a copy onto another card. It stays out of the
 * volume list, so it is never offered or remembered as the box's card.
 */
export async function pickSaveFolder(bridge: Bridge, opts: { purpose?: SaveFolderPurpose } = {}): Promise<Dir | null> {
  const folder = await bridge.call<PickedFolderDto | null>('dialog', 'dialog_pick_folder', {
    purpose: 'card',
    title: SAVE_TITLES[opts.purpose ?? 'backup'],
  });
  return folder ? new TauriDir(bridge, folder.path, folder.name) : null;
}

/**
 * Delivers files dropped onto the window. Folders arrive expanded
 * (recursively, in natural order). Resolves nothing for drops the backend
 * cannot read; those are logged.
 */
export function onFileDrop(bridge: Bridge, cb: (sources: ByteSource[]) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  bridge.ipc
    .onDragDrop((event) => {
      if (disposed || event.type !== 'drop' || !event.paths.length) return;
      bridge
        .call<PickedFileDto[]>('dialog', 'drop_resolve', { paths: event.paths })
        .then((files) => {
          if (!disposed && files.length) cb(toSources(bridge, files));
        })
        .catch((e: unknown) => console.error('Dropped files could not be read', e));
    })
    .then(
      (stop) => {
        if (disposed) stop();
        else unlisten = stop;
      },
      (e: unknown) => console.error('File drops are unavailable', e),
    );
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
