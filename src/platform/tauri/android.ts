/**
 * The Android app (Tauri on a phone or tablet, built by scripts/build-android.sh).
 * Everything the desktop app does with the SD card, the box and the cards
 * goes through small Kotlin bridges that MainActivity adds to the WebView:
 *
 *   window.TonuinoNfc    the phone's own NFC (./nfcAndroid.ts)
 *   window.TonuinoFiles  the SD card in a USB card reader, or any folder the
 *                        user grants (./androidSaf.ts, ./androidVolumes.ts);
 *                        saving files and printing PDFs
 *   window.TonuinoUsb    the box over a USB cable (./androidUsb.ts)
 *
 * The Rust backend has only the box in the home network (http_plain) and the
 * app's own commands (src-tauri/src/lib.rs): no voice of the computer and no
 * list of "Entdecken" built here (the app shows the list that comes with it).
 * Audio is decoded in the WebView, like in the web app. An APK built without
 * the Kotlin files has none of the bridges; then the pages that need them say
 * that this works on a computer.
 */
import type { AudioBackend, ByteSource, Dir, FileSaver, Platform, SerialAccess, VolumeWatcher } from '../types';
import { inputPick } from '../web/inputpick';
import { AndroidCalls, type AndroidCallbacks } from './androidBridge';
import { collectSafFiles, type FilesBridge, newSafCard, SafDir, SafFs, safWithin } from './androidSaf';
import { AndroidUsbSerial, type UsbBridge } from './androidUsb';
import { AndroidVolumes } from './androidVolumes';
import { Bridge } from './bridge';
import { createFetch } from './http';
import { createDefaultIpc, type TauriIpc } from './ipc';
import { AndroidNfc, type NfcBridge, type NfcCallbacks } from './nfcAndroid';

export { isTauriAndroid } from './detect';
export { AndroidNfc } from './nfcAndroid';

declare global {
  interface Window {
    TonuinoFiles?: FilesBridge;
    TonuinoUsb?: UsbBridge;
  }
}

/** No SD card: an APK without the file bridge. */
const NO_VOLUMES: VolumeWatcher = {
  subscribe(cb) {
    cb([]);
    return () => undefined;
  },
  pick: async () => null,
  refresh: async () => undefined,
  eject: async () => undefined,
  info: async () => {
    throw new Error('Die SD-Karte geht in dieser Handy-App nicht. Am Computer klappt es.');
  },
};

/** No box over USB: an APK without the USB bridge. */
const NO_SERIAL: SerialAccess = {
  supported: false,
  list: async () => [],
  open: async () => {
    throw new Error('Die Box per USB geht in dieser Handy-App nicht. Am Computer klappt es.');
  },
};

/** No saving: an APK without the file bridge. */
const NO_FILES: FileSaver = {
  save: async () => {
    throw new Error('Speichern geht in dieser Handy-App nicht. Am Computer klappt es.');
  },
};

export interface AndroidPlatformOptions {
  /** Decodes audio in the WebView (src/core/audio/browserBackend.ts). */
  audio: AudioBackend;
  /** Replaces the Tauri IPC (tests). */
  ipc?: TauriIpc;
  /** window.TonuinoNfc; missing when the APK was built without the Kotlin files. */
  nfcBridge?: NfcBridge;
  /** window.TonuinoFiles; missing likewise. */
  filesBridge?: FilesBridge;
  /** window.TonuinoUsb; missing likewise. */
  usbBridge?: UsbBridge;
  /** Where the bridges call back (window). */
  host?: { __tonuinoNfc?: NfcCallbacks; __tonuinoAndroid?: AndroidCallbacks };
  /** Where the order of the cards is kept (localStorage). */
  storage?: Storage;
  /** The fetch used for https and same-origin requests. */
  nativeFetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export function createAndroidPlatform(options: AndroidPlatformOptions): Platform {
  const ipc = options.ipc ?? createDefaultIpc();
  // Paths never reach the backend here; the separator of Linux fits Android.
  const bridge = new Bridge(ipc, 'linux');
  const host = options.host ?? window;
  const win = typeof window === 'undefined' ? undefined : window;
  const nfcBridge = options.nfcBridge ?? win?.TonuinoNfc;
  const filesBridge = options.filesBridge ?? win?.TonuinoFiles;
  const usbBridge = options.usbBridge ?? win?.TonuinoUsb;
  const calls = filesBridge || usbBridge ? new AndroidCalls(host) : undefined;
  const fs = filesBridge && calls ? new SafFs(filesBridge, calls) : undefined;
  const serial = usbBridge && calls ? new AndroidUsbSerial(usbBridge, calls) : undefined;
  let builtInMic = false;
  try {
    builtInMic = !!filesBridge?.hasMicrophone();
  } catch {
    // An older bridge: the microphone is then asked for by the WebView alone.
  }

  /** A folder chosen once, not kept as a card (backups, a folder of audio to add). */
  const pickOnce = async (): Promise<SafDir | null> => {
    if (!fs) return null;
    const tree = await fs.pickTree(false);
    return tree ? new SafDir(newSafCard(fs, tree.uri), tree.doc, tree.name) : null;
  };

  const pickFiles = async (opts: Parameters<Platform['pickFiles']>[0]): Promise<ByteSource[]> => {
    // The WebView's file chooser knows no folders: a folder goes through Android's folder chooser.
    if (opts.directory && fs) {
      const dir = await pickOnce();
      return dir ? collectSafFiles(dir.card, dir.doc, dir.name) : [];
    }
    return inputPick(opts);
  };

  return {
    kind: 'desktop',
    // No computer system: help written for Windows, Linux or macOS does not apply.
    os: 'other',
    mobile: true,
    // The web app's phone layout, but never "open it on a computer" (see `mobile`).
    handheld: true,
    volumes: fs && calls ? new AndroidVolumes(fs, calls, options.storage) : NO_VOLUMES,
    serial: serial ?? NO_SERIAL,
    nfc: new AndroidNfc(nfcBridge, host),
    files: fs ? { save: (name, data) => fs.saveAs(name, data) } : NO_FILES,
    ...(fs ? { printPdf: (name: string, pdf: Blob) => fs.print(name, pdf) } : {}),
    ...(filesBridge ? { openAppSettings: () => filesBridge.openAppSettings() } : {}),
    audio: options.audio,
    pickFiles,
    pickBackupFolder: async () => pickOnce(),
    isWithin: async (inner: Dir, outer: Dir) =>
      inner instanceof SafDir && outer instanceof SafDir ? safWithin({ tree: inner.card.tree, doc: inner.doc }, { tree: outer.card.tree, doc: outer.doc }) : null,
    openExternal: async (url) => {
      await bridge.call('app', 'open_external', { url });
    },
    fetch: createFetch(bridge, options.nativeFetch),
    capabilities: {
      sd: !!fs,
      sdPackage: false,
      // A card the user granted once comes back by itself; a new card is picked once.
      sdAutoDetect: false,
      eject: false,
      fsDetails: false,
      serial: !!serial,
      // The phone itself; a phone without NFC says so on the cards page.
      nfcReader: true,
      wifiBox: true,
      builtInMic,
    },
  };
}
