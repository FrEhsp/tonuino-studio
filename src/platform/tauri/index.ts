/**
 * Desktop implementation of the Platform interface: every member maps to
 * commands of the Rust backend in src-tauri (see docs in each module).
 *
 *   volumes   volumes_list/_refresh, volume_info, volume_eject, volume_fix_access, event "volumes-changed"
 *   Dir       fs_list, fs_read(_range), fs_write(_chunk/_finish/_abort), fs_mkdir,
 *             fs_remove, fs_rename, fs_exists, fs_stat, fs_copy (+ "copy-progress")
 *   serial    serial_list/_open/_write/_read/_set_signals/_discard/_close/_diagnose
 *   nfc       nfc_list_readers, nfc_wait_card, nfc_read, nfc_write, nfc_diagnose
 *   audio     audio_analyze (+ "audio-progress", audio_cancel), audio_pcm_open/_read/_close
 *   files     dialog_save + fs_write
 *   pick/drop dialog_pick_files, dialog_pick_folder (also for backups), drop_resolve, volume_info (folderInfo)
 *   downloads downloads_recent (new audio files in the download folder, for "Entdecken")
 *   fetch     WebView fetch for https, http_plain for http:// boxes in the home network
 *   sourcesList  sources_fetch, sources_cache_read, sources_cache_write (the list of "Entdecken" built here)
 *   coverNet  cover_fetch (the cover search with the app's own User-Agent)
 *   speech    speech_voice, speech_say (the computer's own voice, for spoken track titles)
 *   printer   print_printers, print_pdf (a PDF in real size to CUPS, or to the PDF program)
 *   player    player_warm/_load/_load_data/_queue/_play/_pause/_seek/_volume/_close/_close_all, event "player" ("Anhören")
 *   window    Tauri's own: set_theme, destroy, unminimize, set_focus, the close request (capabilities/default.json allows them)
 */
import type { ByteSource, Platform } from '../types';
import { TauriAudio } from './audio';
import { Bridge, detectOs, type DesktopOs } from './bridge';
import { TauriFileSaver } from './files';
import { createFetch } from './http';
import { createDefaultIpc, type TauriIpc } from './ipc';
import { TauriNfc } from './nfc';
import { onFileDrop, pickFiles, pickSaveFolder, recentDownloads } from './pick';
import { TauriSerial } from './serial';
import { pathWithin, toInfo, TauriVolumes, type VolumeInfoDto } from './volumes';
import { TauriSourcesList } from './sourcesList';
import { TauriCoverNet } from './coverNet';
import { TauriSpeech } from './speech';
import { TauriPlayer } from './player';
import { TauriPrinter } from './printer';

export { isTauri } from './detect';
export { TauriPlatformError, type HintInfo } from './errors';
export type { TauriSerialPortInfo } from './serial';
export { TauriAudio, TauriFileSaver, TauriNfc, TauriSerial, TauriSpeech, TauriVolumes };
export { TauriDir, PathByteSource } from './fs';

/** The Platform plus the desktop extras (diagnostics, USB setup, native copy). */
export interface TauriPlatform extends Platform {
  readonly kind: 'desktop';
  readonly os: DesktopOs;
  readonly volumes: TauriVolumes;
  readonly serial: TauriSerial;
  readonly nfc: TauriNfc;
  readonly files: TauriFileSaver;
  readonly audio: TauriAudio;
  /** The list of "Entdecken" built on this computer (see __LOCAL_SOURCES__). */
  readonly sourcesList?: TauriSourcesList;
  readonly coverNet?: TauriCoverNet;
  readonly speech: TauriSpeech;
  readonly player: TauriPlayer;
  onFileDrop(cb: (sources: ByteSource[]) => void): () => void;
  holdWindowOpen(onRequest: () => void): () => void;
  closeWindow(): Promise<void>;
}

export interface TauriPlatformOptions {
  /** Replaces the Tauri IPC (tests). */
  ipc?: TauriIpc;
  os?: DesktopOs;
  /** The fetch used for https and same-origin requests. */
  nativeFetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** The app's only window, as tauri.conf.json names it. */
const MAIN_WINDOW = 'main';

export function createTauriPlatform(options: TauriPlatformOptions = {}): TauriPlatform {
  const ipc = options.ipc ?? createDefaultIpc();
  const os = options.os ?? detectOs(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const bridge = new Bridge(ipc, os);
  // Closes without the close request, so nothing asks again.
  const closeWindow = async () => {
    await ipc.invoke('plugin:window|destroy', { label: MAIN_WINDOW });
  };
  // The question shows inside the window. Closed from the taskbar or the overview, the window may be
  // minimized or behind others: then it comes to the front, or closing would seem to do nothing.
  const bringForward = async () => {
    try {
      await ipc.invoke('plugin:window|unminimize', { label: MAIN_WINDOW });
      await ipc.invoke('plugin:window|set_focus', { label: MAIN_WINDOW });
    } catch (e) {
      console.error('The window cannot come to the front', e);
    }
  };
  return {
    kind: 'desktop',
    os,
    volumes: new TauriVolumes(bridge),
    serial: new TauriSerial(bridge),
    nfc: new TauriNfc(bridge),
    files: new TauriFileSaver(bridge),
    audio: new TauriAudio(bridge),
    ...(__DESKTOP_BUILD__ && __LOCAL_SOURCES__ ? { sourcesList: new TauriSourcesList(bridge) } : {}),
    ...(__DESKTOP_BUILD__ ? { coverNet: new TauriCoverNet(bridge) } : {}),
    downloads: { recent: (sinceMs, extensions) => recentDownloads(bridge, sinceMs, extensions) },
    speech: new TauriSpeech(bridge),
    player: new TauriPlayer(bridge),
    printer: new TauriPrinter(bridge),
    pickFiles: (opts) => pickFiles(bridge, opts),
    pickBackupFolder: (opts) => pickSaveFolder(bridge, opts),
    folderInfo: async (dir) => {
      if (!dir.path) return {};
      const dto = await bridge.call<VolumeInfoDto>('volume', 'volume_info', { path: dir.path });
      return { ...toInfo(dto), ...(dto.mountPath ? { mountPath: dto.mountPath } : {}) };
    },
    isWithin: async (inner, outer) => (inner.path && outer.path ? pathWithin(inner.path, outer.path, os) : null),
    onFileDrop: (cb) => onFileDrop(bridge, cb),
    openExternal: async (url) => {
      await bridge.call('app', 'open_external', { url });
    },
    // Tauri's own window command; src-tauri/capabilities/default.json allows it.
    setWindowTheme: async (theme) => {
      await ipc.invoke('plugin:window|set_theme', { label: MAIN_WINDOW, value: theme });
    },
    holdWindowOpen: (onRequest) => {
      let held = true;
      let release: (() => void) | undefined;
      ipc
        .onCloseRequested(() => {
          if (held) {
            onRequest();
            void bringForward();
          }
          // Let go while Tauri still had the listener: close as the user wanted.
          else void closeWindow().catch(() => undefined);
        })
        .then(
          (unlisten) => {
            if (held) release = unlisten;
            else unlisten();
          },
          (e: unknown) => console.error('The window cannot ask before closing', e),
        );
      return () => {
        held = false;
        release?.();
        release = undefined;
      };
    },
    closeWindow,
    fetch: createFetch(bridge, options.nativeFetch),
    capabilities: {
      sd: true,
      sdPackage: false,
      sdAutoDetect: true,
      eject: true,
      fsDetails: true,
      serial: true,
      nfcReader: true,
      wifiBox: true,
      builtInMic: false,
    },
  };
}
