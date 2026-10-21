import { snapshotFromEntry, snapshotFromFiles } from '../snapshot';
import type { AudioBackend, ByteSource, CardSnapshotAccess, NfcAccess, PickFilesOptions, Platform, VolumeWatcher } from '../types';
import { cardEntryFromDrop } from './carddrop';
import { startDownload } from './download';
import { onFolderChosen, openFolderChooser } from './folderpick';
import { collectFiles, fileSource } from './fsa';
import { inputPick } from './inputpick';
import { fsaWithin, pickSaveFolder } from './savefolder';
import { cleanupScratch, createScratchStore } from './scratch';
import { deviceHints, isHandheld, type DeviceHints } from './handheld';
import { webSerial } from './serial';
import { WebVolumes } from './volumes';

function detectOs(): Platform['os'] {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return 'other';
}

/** Phones and tablets: no card, also no remembered one. */
const NO_VOLUMES: VolumeWatcher = {
  subscribe(cb) {
    cb([]);
    return () => undefined;
  },
  pick: async () => null,
  refresh: async () => undefined,
  eject: async () => undefined,
  info: async () => {
    throw new Error('Die SD-Karte geht nur am Computer.');
  },
};

const noNfc: NfcAccess = {
  supported: false,
  listReaders: async () => [],
  waitForCard: async () => null,
  read: async () => {
    throw new Error('NFC-Leser per USB gehen nur mit der Desktop-App.');
  },
  write: async () => {
    throw new Error('NFC-Leser per USB gehen nur mit der Desktop-App.');
  },
};

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg']);
const FIRMWARE_EXT = new Set(['hex', 'bin']);
/** Text files, also track lists (CSV, M3U, a Spotify JSON): no audio, even when they name songs. */
const TEXT_EXT = new Set(['txt', 'log', 'csv', 'tsv', 'json', 'm3u', 'm3u8']);

function mimeFor(ext: string): string {
  if (IMAGE_EXT.has(ext)) return 'image/*';
  if (ext === 'zip') return 'application/zip';
  if (FIRMWARE_EXT.has(ext)) return 'application/octet-stream';
  if (TEXT_EXT.has(ext)) return 'text/plain';
  return 'audio/*';
}

/** File type filter for the picker: grouped by kind, named in words people know. */
function pickerTypes(extensions: string[] | undefined): FilePickerAcceptType[] | undefined {
  if (!extensions?.length) return undefined;
  const groups = new Map<string, `.${string}`[]>();
  for (const e of extensions) {
    const mime = mimeFor(e);
    groups.set(mime, [...(groups.get(mime) ?? []), `.${e}`]);
  }
  const names: Record<string, string> = {
    'audio/*': 'Audiodateien',
    'image/*': 'Bilder',
    'application/zip': 'ZIP-Archive',
    'application/octet-stream': 'Firmware-Dateien',
    'text/plain': 'Textdateien',
  };
  const description = [...groups.keys()].map((m) => names[m]).join(' und ');
  return [{ description, accept: Object.fromEntries(groups) }];
}

async function pickFiles(opts: PickFilesOptions): Promise<ByteSource[]> {
  try {
    if (opts.directory && 'showDirectoryPicker' in window) {
      const dir = await window.showDirectoryPicker({ id: 'tonuino-import', mode: 'read' });
      return await collectFiles(dir);
    }
    if (!opts.directory && 'showOpenFilePicker' in window) {
      const handles = await window.showOpenFilePicker({
        id: 'tonuino-import',
        multiple: opts.multiple ?? true,
        types: pickerTypes(opts.extensions),
        excludeAcceptAllOption: false,
      });
      return Promise.all(handles.map(async (h) => fileSource(await h.getFile())));
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return [];
    throw e;
  }
  return inputPick(opts);
}

async function save(name: string, data: Blob): Promise<boolean> {
  if ('showSaveFilePicker' in window) {
    try {
      const ext = name.split('.').pop() ?? '';
      const h = await window.showSaveFilePicker({
        suggestedName: name,
        types: ext ? [{ description: ext.toUpperCase(), accept: { [data.type || 'application/octet-stream']: [`.${ext}` as `.${string}`] } }] : undefined,
      });
      const w = await h.createWritable();
      await w.write(data);
      await w.close();
      return true;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false;
      // Fall through to a plain download.
    }
  }
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Safari asking where to save, or a slow disk, can take a while before the download reads the data.
  setTimeout(() => URL.revokeObjectURL(url), SAVE_URL_LIFETIME_MS);
  return true;
}

const SAVE_URL_LIFETIME_MS = 10 * 60 * 1000;

/** Reading the card once and downloading Pakete, for browsers without folder access. */
function cardSnapshotAccess(): CardSnapshotAccess {
  return {
    choose: openFolderChooser,
    onChosen: (cb) =>
      onFolderChosen((o) => {
        if ('cancelled' in o) return cb(o);
        const items = o.files.map((f) => ({ path: f.webkitRelativePath || f.name, blob: f, modified: f.lastModified }));
        cb({ purpose: o.purpose, result: snapshotFromFiles(items) });
      }),
    fromDrop(dt, opts) {
      const got = cardEntryFromDrop(dt);
      if (!got) return null;
      if ('problem' in got) return Promise.resolve({ kind: got.problem });
      return snapshotFromEntry(got.entry, opts);
    },
    createScratch: createScratchStore,
    download: startDownload,
  };
}

export function createWebPlatform(audio: AudioBackend, hints: DeviceHints = deviceHints()): Platform {
  // Phones and tablets get no card access at all: the app asks to open it on a computer (see HandheldNotice).
  const handheld = isHandheld(hints);
  const fsa = !handheld && typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  // Firefox and Safari: no folder access, but a folder chooser. Decided by features, never by the browser's name.
  const sdPackage = !handheld && !fsa && typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;
  // What an earlier visit left for a Paket (a closed tab): gone after two days.
  if (sdPackage) void cleanupScratch();
  const serial = webSerial();
  return {
    kind: 'web',
    os: detectOs(),
    ...(handheld ? { handheld } : {}),
    volumes: handheld ? NO_VOLUMES : new WebVolumes(),
    serial,
    nfc: noNfc,
    files: { save, downloadsOnly: typeof window !== 'undefined' && !('showSaveFilePicker' in window) },
    audio,
    pickFiles,
    pickBackupFolder: (opts) => pickSaveFolder(opts),
    isWithin: fsaWithin,
    ...(sdPackage ? { cardSnapshot: cardSnapshotAccess() } : {}),
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    fetch: (url, init) => fetch(url, init),
    capabilities: {
      sd: fsa,
      sdPackage,
      sdAutoDetect: false,
      eject: false,
      fsDetails: false,
      serial: serial.supported && !handheld,
      nfcReader: false,
      wifiBox: false,
      builtInMic: false,
    },
  };
}
