import type { ScratchStore } from './overlay';
import type { SnapshotProblem, SnapshotResult } from './snapshot';

/**
 * Platform abstraction. The UI and the core logic only talk to these
 * interfaces; `web/` implements them with browser APIs (File System Access,
 * Web Serial) and `tauri/` with commands of the desktop app.
 */

export interface DirEntry {
  name: string;
  kind: 'file' | 'directory';
  /** Size in bytes (files only). */
  size?: number;
  /** Last modification, ms since epoch, when known. */
  modified?: number;
  /** Desktop: write-protected (the FAT read-only attribute); the app cannot change or replace it until that is cleared. */
  readOnly?: boolean;
}

/** Random-access, read-only bytes: a local file, or a file on the SD card. */
export interface ByteSource {
  readonly name: string;
  readonly size: number;
  /** Absolute path when the file lives on disk and the platform can open it natively (desktop). */
  readonly path?: string;
  /** The browser File/Blob behind this source, when there is one. */
  readonly blob?: Blob;
  /** Path relative to a picked or dropped folder, e.g. "CD1/01 Intro.mp3". */
  readonly relativePath?: string;
  read(start: number, length: number): Promise<Uint8Array>;
}

export interface WriteOptions {
  onProgress?: (writtenBytes: number) => void;
  signal?: AbortSignal;
}

/** A directory on the SD card (or any folder the user picked). */
export interface Dir {
  readonly name: string;
  /** Absolute path for display (desktop only). */
  readonly path?: string;
  list(): Promise<DirEntry[]>;
  dir(name: string, opts?: { create?: boolean }): Promise<Dir>;
  exists(name: string): Promise<boolean>;
  read(name: string): Promise<Uint8Array>;
  readRange(name: string, start: number, length: number): Promise<Uint8Array>;
  source(name: string): Promise<ByteSource>;
  /** Creates or replaces a file. Data is flushed to the device before resolving. */
  write(name: string, data: Uint8Array | Blob, opts?: WriteOptions): Promise<void>;
  remove(name: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Renames an entry inside this directory. */
  rename(from: string, to: string): Promise<void>;
  /** Moves an entry into another directory on the same volume. */
  move(name: string, target: Dir, newName?: string): Promise<void>;
  /**
   * Desktop: removes the write protection (FAT read-only attribute) of the
   * given entries below this folder ("05/003.mp3"), or of everything on it
   * when `paths` is empty. Resolves with how many entries changed.
   */
  makeWritable?(paths: string[]): Promise<number>;
}

export interface VolumeInfo {
  /** e.g. "vfat", "exfat", "FAT32", "msdos". */
  fsType?: string;
  /** Cluster (allocation unit) size in bytes. */
  clusterSize?: number;
  totalBytes?: number;
  freeBytes?: number;
  removable?: boolean;
  device?: string;
  /**
   * The modification times in DirEntry.modified come straight from the
   * card's own file system (web: File.lastModified). Only then may the health
   * check judge the format by them (see core/tonuino/fsguess.ts). Not set when
   * a platform makes up times itself, e.g. Date.now() for staged writes.
   */
  fileTimesFromCard?: boolean;
  /** Desktop: whether the app may change files there. Missing: unknown (browser). */
  writable?: boolean;
  /** Desktop: mounted read-only, e.g. by the lock slider of the card or its adapter. */
  readOnly?: boolean;
  /**
   * Desktop (Linux): read-only although the card is not locked. The system
   * mounted it so, usually after the connection broke off while writing.
   */
  readOnlyBySystem?: boolean;
  /** Desktop (Linux): the mount belongs to another user account, e.g. root. */
  foreignOwner?: boolean;
  /** Desktop (Linux): the app can mount the card again for this user (VolumeWatcher.fixAccess). */
  canFixAccess?: boolean;
}

/** A mounted SD card or folder the app works on. */
export interface Volume {
  /** Stable key for this mount (desktop: mount path, web: stored handle id). */
  id: string;
  /** Volume label (desktop) or folder name (web). */
  label: string;
  root: Dir;
  info: VolumeInfo;
  /** True when the platform can unmount and eject it. */
  canEject: boolean;
  /**
   * 'snapshot': a copy of the card read once in a browser that cannot write
   * to it (Firefox, Safari). Changes wait in the app and reach the card as a
   * Paket the user unpacks. Missing means 'direct'.
   */
  access?: 'direct' | 'snapshot';
  /** When the snapshot was read (ms since epoch). */
  snapshotAt?: number;
}

export interface VolumeWatcher {
  /** Called with all currently reachable volumes whenever that set changes. */
  subscribe(cb: (volumes: Volume[]) => void): () => void;
  /** Lets the user choose a card or folder. Needs a user gesture in the browser. */
  pick(): Promise<Volume | null>;
  /** Re-checks volumes right now (e.g. after the user clicked "Erneut suchen"). */
  refresh(): Promise<void>;
  /**
   * Resolves once the first list after subscribe is known: the system asked,
   * a remembered card looked for. Until then the start page waits calmly
   * instead of saying that there is no card. Without it the first list counts.
   */
  settled?(): Promise<void>;
  /** Flushes, unmounts and powers off the card. */
  eject(volume: Volume): Promise<void>;
  /** Re-reads free space and filesystem details. */
  info(volume: Volume): Promise<VolumeInfo>;
  /**
   * Desktop (Linux): mounts the card again so this user may write to it
   * ("Schreibrechte holen"). The system may ask for a password in its own
   * window. Resolves with the card as it is mounted now, often under a new path.
   */
  fixAccess?(volume: Volume): Promise<Volume>;
  /**
   * Desktop: tells when writing on a listed card or picked folder failed
   * because the app lacks the rights there; gets the volume's id.
   */
  onWriteDenied?(cb: (volumeId: string) => void): () => void;
  /** Browser only: a remembered card exists but needs a click to grant access again. */
  readonly needsPermission?: boolean;
  requestPermission?(): Promise<boolean>;
  forget?(volume: Volume): Promise<void>;
}

export interface SerialPortInfo {
  /** Opaque key used to open the port again. */
  id: string;
  /** Human readable, e.g. "USB-Serial CH340 (ttyUSB0)". */
  label: string;
  path?: string;
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialSignals {
  dtr?: boolean;
  rts?: boolean;
}

/**
 * An open serial port.
 *
 * When the device goes away (cable pulled, box switched off), the connection
 * is lost for good: read() hands out bytes that still arrived, then rejects
 * instead of timing out, and write() rejects too. Both errors carry
 * `code: 'disconnected'` and a German message for the user, so callers can
 * tell a pulled cable from other failures. The other methods reject as well,
 * but their code may differ by platform.
 *
 * close() never rejects and may be called again. After it, every other
 * method rejects with `code: 'closed'`; a read that was waiting when close()
 * was called resolves with what it got.
 */
export interface SerialConnection {
  readonly port: SerialPortInfo;
  readonly baudRate: number;
  write(data: Uint8Array): Promise<void>;
  /**
   * Resolves with the bytes received within `timeoutMs` (at most `maxBytes`).
   * Resolves with an empty array on timeout; never rejects on timeout.
   * Rejects with `code: 'disconnected'` once the device is gone and every
   * byte that arrived before was read.
   */
  read(timeoutMs: number, maxBytes?: number): Promise<Uint8Array>;
  /** Drops anything already received and not yet read. */
  discardInput(): Promise<void>;
  setSignals(signals: SerialSignals): Promise<void>;
  close(): Promise<void>;
}

export interface SerialAccess {
  readonly supported: boolean;
  /** Ports the app may open without asking (desktop: all; web: previously granted). */
  list(): Promise<SerialPortInfo[]>;
  /** Browser only: shows the browser's port chooser. */
  request?(filters?: { usbVendorId: number; usbProductId?: number }[]): Promise<SerialPortInfo | null>;
  /**
   * The browser may first ask whether it may add a small add-on for USB
   * access (Firefox does that). Only switches on a hint.
   */
  readonly mayAskForAddon?: boolean;
  open(port: SerialPortInfo, baudRate: number): Promise<SerialConnection>;
}

export type NfcCardType = 'mifare-classic-1k' | 'mifare-classic-4k' | 'mifare-classic-mini' | 'mifare-ultralight' | 'ntag213' | 'ntag215' | 'ntag216' | 'unknown';

export interface NfcCardInfo {
  uid: string;
  type: NfcCardType;
  /** ATR or SAK/ATQA summary for diagnostics. */
  details?: string;
}

export interface NfcReadResult extends NfcCardInfo {
  /** The 16 TonUINO bytes (block 4, or pages 8-11). */
  data: Uint8Array;
}

/** The phone's NFC in the Android app: missing, switched off in the system settings, or on. */
export type PhoneNfcState = 'none' | 'off' | 'on';

export interface NfcAccess {
  readonly supported: boolean;
  listReaders(): Promise<string[]>;
  /** Waits until a card lies on the reader; null on timeout or abort. */
  waitForCard(reader: string, timeoutMs: number): Promise<NfcCardInfo | null>;
  read(reader: string): Promise<NfcReadResult>;
  /**
   * `uid`: the card the caller read and means. The phone (Android) refuses
   * with code 'wrong-card' when another card came meanwhile; a reader on
   * the desktop holds one card and ignores it.
   */
  write(reader: string, data: Uint8Array, uid?: string): Promise<void>;
  /**
   * Android app: the reader is the phone itself (src/platform/tauri/nfcAndroid.ts).
   * The card is held to the back of the phone instead of laid on a reader.
   * listReaders() rejects with code 'nfc-off' while NFC is switched off.
   */
  readonly phone?: boolean;
  /** Android app: opens the system's NFC settings, to switch NFC on. */
  openSettings?(): void;
  /** Android app: called when the app comes back to the front, with the state of NFC then. */
  onStateChange?(cb: (state: PhoneNfcState) => void): () => void;
  /**
   * Android app: every card held to the phone that no waitForCard is waiting
   * for. Asking for it keeps the phone's reader mode on while the app is in
   * the front (src/features/cards/nfcTap.ts).
   */
  onTap?(cb: (card: NfcCardInfo) => void): () => void;
}

export interface FileSaver {
  /** Saves a generated file (PDF, CSV, ZIP). Resolves false when the user cancelled. */
  save(suggestedName: string, data: Blob): Promise<boolean>;
  /** Saving only starts a download: there is no save dialog, the file lands in the download folder. */
  readonly downloadsOnly?: boolean;
}

/** A download the browser was asked to start. */
export interface StartedDownload {
  readonly name: string;
  readonly size: number;
  /** Starts the same download once more. */
  again(): void;
  /** Lets go of the data. */
  dispose(): void;
}

export type SnapshotPurpose = 'card' | 'check';

/**
 * Browsers without write access to folders (Firefox, Safari): read the card
 * once as a snapshot, keep new files, download the Paket.
 */
export interface CardSnapshotAccess {
  /** Opens the folder chooser. Must run in a click handler. The result arrives through onChosen. */
  choose(purpose: SnapshotPurpose): void;
  onChosen(cb: (o: { purpose: SnapshotPurpose; result: SnapshotResult | SnapshotProblem } | { purpose: SnapshotPurpose; cancelled: true }) => void): () => void;
  /**
   * The card from a drop. Takes what it needs from the event right away, so
   * call it in the drop handler itself. Null when nothing was dropped.
   */
  fromDrop(dt: DataTransfer, opts?: { signal?: AbortSignal; onProgress?: (files: number) => void }): Promise<SnapshotResult | SnapshotProblem> | null;
  /** Where new files wait for the Paket: the browser's own storage when it has some, else memory. */
  createScratch(): Promise<ScratchStore>;
  download(blob: Blob, name: string): StartedDownload;
}

/**
 * What a folder to save into is for: a backup of the card on the computer,
 * another card to copy folders to, or a folder on the computer to take to
 * another card by hand.
 */
export type SaveFolderPurpose = 'backup' | 'copy' | 'export';

/** Free space and drive of a folder (desktop). */
export interface FolderInfo extends VolumeInfo {
  /** Mount point of the drive the folder lives on. */
  mountPath?: string;
}

export interface PickFilesOptions {
  multiple?: boolean;
  /** Lower-case extensions without dot, e.g. ["mp3", "m4b"]. */
  extensions?: string[];
  /** Pick a folder and return all files in it (recursively). */
  directory?: boolean;
}

/** An audio file that arrived in the user's download folder. */
export interface RecentDownload {
  source: ByteSource;
  /** Last change, milliseconds since 1970. */
  modifiedMs: number;
}

/** Desktop only: the download folder, for files saved on a publisher's page ("Entdecken"). */
export interface DownloadsAccess {
  /**
   * Files directly in the download folder with one of `extensions`, changed
   * since `sinceMs`, not empty and not still being written; newest first.
   * Only these files become readable. `folder` is undefined when the system
   * names no download folder.
   */
  recent(sinceMs: number, extensions: readonly string[]): Promise<{ folder?: string; files: RecentDownload[] }>;
}

export interface Platform {
  /**
   * web: the app in a browser. desktop: the Tauri app, also on Android
   * (`mobile`), where it opens links and lists its Rust crates like the
   * desktop app.
   */
  readonly kind: 'web' | 'desktop';
  /** The computer's system; 'other' in the Android app (see `mobile`). */
  readonly os: 'linux' | 'windows' | 'macos' | 'other';
  readonly volumes: VolumeWatcher;
  readonly serial: SerialAccess;
  readonly nfc: NfcAccess;
  readonly files: FileSaver;
  readonly audio: AudioBackend;
  /** Lets the user choose files or a folder. Resolves with [] when cancelled. */
  pickFiles(opts: PickFilesOptions): Promise<ByteSource[]>;
  /**
   * Lets the user choose a folder the app may write into: a place on the
   * computer for a backup of the card, or another SD card to copy folders
   * to. Unlike volumes.pick() it is never added to the cards and never
   * remembered as one. Resolves null when cancelled, and in browsers that
   * cannot write to folders.
   */
  pickBackupFolder(opts?: { purpose?: SaveFolderPurpose }): Promise<Dir | null>;
  /** Desktop only: free space and drive of a folder, e.g. one from pickBackupFolder. */
  folderInfo?(dir: Dir): Promise<FolderInfo>;
  /**
   * Whether `inner` is `outer` itself or a folder somewhere inside it (a
   * backup must not end up on the card it saves). Null when the platform
   * cannot tell.
   */
  isWithin(inner: Dir, outer: Dir): Promise<boolean | null>;
  /**
   * Desktop only: files dropped onto the window arrive as paths. The browser
   * build handles drops with DOM events in the UI instead.
   */
  onFileDrop?(cb: (sources: ByteSource[]) => void): () => void;
  /**
   * Desktop app only: what the app needs to build the list of "Entdecken"
   * itself (src/core/sources/local.ts). Missing in the browser build and in
   * a desktop build that loads a published list (VITE_SOURCES_INDEX_URL).
   */
  readonly sourcesList?: SourcesListAccess;
  /**
   * Desktop app only: the cover search through the backend, with the app's
   * own User-Agent and without CORS limits (src/core/covers/route.ts).
   */
  readonly coverNet?: CoverNetAccess;
  /** Desktop only: new files in the download folder (see DownloadsAccess). */
  readonly downloads?: DownloadsAccess;
  /** Desktop only: the computer's own voice, for spoken track titles (see SpeechAccess). */
  readonly speech?: SpeechAccess;
  /**
   * Desktop only: "Anhören" plays through the computer's own player
   * (symphonia and cpal in src-tauri/src/player), not the WebView's <audio>.
   * The web app and the Android app play in the browser.
   */
  readonly player?: PlayerAccess;
  /** Browser without write access to folders: the card is read as a snapshot (see capabilities.sdPackage). */
  readonly cardSnapshot?: CardSnapshotAccess;
  /**
   * Web app on a phone or tablet (src/platform/web/handheld.ts). The app
   * asks to open it on a computer and offers no card and no USB there.
   * The Android app is handheld too, but never asks that (see `mobile`).
   */
  readonly handheld?: boolean;
  /**
   * The Android app (Tauri on a phone or tablet, src/platform/tauri/android.ts).
   * It writes cards with the phone's own NFC (`nfc.phone`), opens the SD card
   * in a USB card reader and talks to the box over a USB cable (USB-OTG),
   * both where the APK has its Kotlin bridge (see `capabilities`). Help
   * written for a computer does not apply. Always together with `handheld`.
   */
  readonly mobile?: boolean;
  /**
   * Android app only: hands a PDF to the system's print dialog. The
   * WebView there has no window.print(), so pages that print build a PDF
   * and give it here (src/features/stickers/print.ts).
   */
  printPdf?(name: string, pdf: Blob): Promise<void>;
  /**
   * Desktop only: prints a PDF in its real size through the system (CUPS on
   * Linux), or opens it in the PDF program (Windows). The WebView's own
   * print shrinks the sheets in WebKitGTK (TODO #85).
   */
  readonly printer?: PrinterAccess;
  /**
   * Android app only: the app's page in the system settings, where a
   * permission said "no" for good (the microphone) can be given after all.
   */
  openAppSettings?(): void;
  /** Opens a link in the user's browser. */
  openExternal(url: string): Promise<void>;
  /**
   * Desktop only: light or dark for the window frame and title bar, which
   * the page's own colours do not reach. null follows the system.
   */
  setWindowTheme?(theme: 'light' | 'dark' | null): Promise<void>;
  /**
   * Desktop only: until the returned function is called, closing the window
   * keeps it open and calls `onRequest`, so the app can ask first. A browser
   * asks by itself (beforeunload) and has no such method.
   */
  holdWindowOpen?(onRequest: () => void): () => void;
  /** Desktop only: closes the window right away, without asking. */
  closeWindow?(): Promise<void>;
  /**
   * HTTP(S) request. HTTPS goes through the browser's or the WebView's fetch
   * and is bound by CORS on both platforms (the desktop origin is
   * tauri://localhost or http(s)://tauri.localhost). Only the desktop app sends
   * plain http:// requests to other hosts (an ESP32 box in the home network)
   * through its backend, without CORS.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  readonly capabilities: {
    /** Read and write the SD card. */
    sd: boolean;
    /** Read the card as a snapshot and bring changes to it as a Paket (browsers without folder access). */
    sdPackage: boolean;
    /** Detect any card on insertion, not just remembered ones. */
    sdAutoDetect: boolean;
    eject: boolean;
    /** Filesystem type and cluster size are known. */
    fsDetails: boolean;
    serial: boolean;
    nfcReader: boolean;
    /** Talk to an ESP32 box over plain HTTP. */
    wifiBox: boolean;
    /**
     * The device has its own microphone and is held in the hand (phone,
     * tablet): recording is an everyday way to add audio there, not an extra
     * (src/features/add/RecordDialog.tsx). False on computers.
     */
    builtInMic: boolean;
  };
}

/* ------------------------------------------------------------------ audio */

/**
 * Result of analysing an audio file. Both the browser (WASM/WebCodecs) and the
 * desktop app (Rust) produce exactly this shape, so pause detection and
 * loudness work the same everywhere.
 */
export interface AudioAnalysis {
  durationSec: number;
  /** Sample rate and channel count of the source. */
  sampleRate: number;
  channels: number;
  /** Length of one analysis window in seconds (normally 0.01). */
  windowSec: number;
  /**
   * Per window: K-weighted mean-square power as defined by ITU-R BS.1770-4,
   * summed over channels with weight 1.0 (L, R; mono counts once). Linear
   * scale. 10*log10(p) - 0.691 is the momentary loudness of that window in
   * LUFS, and integrated loudness follows from gating 400 ms blocks of it.
   */
  power: Float32Array;
  /** Integrated loudness in LUFS (EBU R128), when the producer computed it. */
  lufs?: number;
  /** Largest absolute sample value of the decoded audio (1 = full scale), when known. */
  peak?: number;
  /**
   * Flat tops at the loudest level, where the wave was cut off before the
   * file was saved (clipping), counted per channel; see ClipCounter and
   * isClipped in core/audio/loudness.ts. Undefined when not counted.
   */
  clips?: number;
  /** Chapter marks found in the file (MP4/M4B chapters, ID3 CHAP). */
  chapters?: { startSec: number; title?: string }[];
  /** e.g. "mp3", "aac", "flac". */
  codec?: string;
  bitrateKbps?: number;
}

/** What opening a file told, before decoding it. */
export interface AudioProbe {
  durationSec?: number;
  sampleRate?: number;
  channels?: number;
  codec?: string;
}

export interface PcmChunk {
  /** One Float32Array per channel, all the same length, values -1..1. */
  channels: Float32Array[];
  sampleRate: number;
}

export interface PcmReader {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSec: number;
  /** Next block of at most `maxFrames` frames; null at the end. */
  next(maxFrames: number): Promise<PcmChunk | null>;
  close(): Promise<void>;
}

export interface AudioBackend {
  analyze(input: ByteSource, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<AudioAnalysis>;
  /**
   * Opens the file without decoding it and tells what the decoder found;
   * rejects with the reason (an AudioError with a German message) when it
   * cannot be decoded here. Used to point out files the import could not
   * convert before anything is written, and for playing times the tags lack.
   */
  check?(input: ByteSource, signal?: AbortSignal): Promise<AudioProbe>;
  /** Streams decoded PCM, resampled to `targetSampleRate` when given. `signal` stops the opening (e.g. a wait for memory). */
  openPcm(input: ByteSource, opts?: { targetSampleRate?: number; signal?: AbortSignal }): Promise<PcmReader>;
}

/* ------------------------------------------------------- the computer's voice */

/** The voice the desktop app found on this computer (src-tauri/src/speech.rs). */
export interface VoiceInfo {
  /** sapi (Windows), say (macOS), pico2wave, espeak-ng or espeak (Linux); null: no voice. */
  engine: string | null;
  /** Its name, where the system names voices (Windows, macOS). */
  voice?: string;
  /** It speaks German; otherwise titles are read by a voice for another language. */
  german: boolean;
}

/** How the computer prints a PDF (see Platform.printer). */
export interface PrinterList {
  /** "system": straight to one of `printers` in real size; "open": the PDF opens in the PDF program. */
  way: 'system' | 'open';
  printers: string[];
  /** The printer the computer prints with when none is chosen. */
  default: string | null;
}

export interface PrintJob {
  /** File name of the PDF, also the job's name at the printer. */
  name: string;
  pdf: Blob;
  /** Paper size of the PDF's pages. */
  page: { widthMm: number; heightMm: number };
  /** Every other page is the back of the one before: print on both sides. */
  twoSided?: boolean;
  /** One of PrinterList.printers; missing: the default one. */
  printer?: string | null;
  /** In colour (default); false: black and white. Never left to the printer's default. */
  color?: boolean;
  /** "high": the printer's best quality; missing or "normal": its normal one. */
  quality?: 'normal' | 'high';
  /** The kind of paper, said to the driver where it knows it; missing: the printer's own setting. */
  paper?: PaperKind;
  /** Open the PDF in the PDF program instead. */
  open?: boolean;
}

export type PaperKind = 'plain' | 'photo' | 'labels';

/** What a printer has in itself (lpoptions): its paper size and the kinds of paper its driver knows. */
export interface PrinterPaper {
  /** "A4", "Letter", …; null when unknown. */
  size: string | null;
  kinds: PaperKind[];
}

/** Desktop only: printing a PDF without the WebView. */
export interface PrinterAccess {
  list(): Promise<PrinterList>;
  /** The paper of `printer`; absent where the system cannot tell. */
  paper?(printer: string): Promise<PrinterPaper>;
  /** "sent": to the printer; "opened": in the PDF program (where nothing prints without the user). */
  print(job: PrintJob): Promise<'sent' | 'opened'>;
}

/** Desktop only: speech with the voice the computer already has. The app brings none of its own. */
export interface SpeechAccess {
  /** Looks for a voice (the answer is kept; `refresh` looks again). */
  voice(refresh?: boolean): Promise<VoiceInfo>;
  /** Speaks `text` (one line, at most 300 characters) into a WAV file. */
  say(text: string): Promise<Uint8Array>;
}

/* ------------------------------------------------------------------ player */

/** What the player plays: a file it opens itself, or data from memory. */
export type PlayerSource = { path: string; name: string } | { data: Uint8Array; name: string };

export interface PlayerLoadOptions {
  /** Where to start, seconds. */
  at?: number;
  /** Starts at once (default), else waits paused. */
  play?: boolean;
  /** 0 to 1. */
  volume?: number;
}

export interface PlayerLoaded {
  /** The voice that plays the track; all other calls name it. */
  voice: number;
  track: number;
  durationSec: number;
  /** The length is exact; otherwise a "duration" event brings the exact one. */
  exact: boolean;
}

/** What the player reports, for one voice (`voice` 0: the output itself). */
export interface PlayerEvent {
  voice: number;
  kind: 'started' | 'ended' | 'seeked' | 'paused' | 'pos' | 'duration' | 'error' | 'device';
  track: number;
  /** Where the listener is, seconds. */
  posSec: number;
  playing: boolean;
  durationSec?: number;
  epoch?: number;
  /** started: milliseconds from the command to the first sound given to the output. */
  startMs?: number;
  /** pos: milliseconds of sound that were missing because decoding fell behind. */
  gapMs?: number;
  /** error and device: what went wrong ("device-lost", "no-device", or an audio error code). */
  code?: string;
}

/** The computer's own player (desktop app). */
export interface PlayerAccess {
  /** Opens the sound output ahead of time, so the first "Anhören" starts at once. */
  warm(): void;
  load(source: PlayerSource, opts?: PlayerLoadOptions): Promise<PlayerLoaded>;
  /** Plays `path` right after the voice's track, without a gap; resolves with its track number. */
  queue(voice: number, path: string): Promise<number>;
  play(voice: number): Promise<void>;
  pause(voice: number): Promise<void>;
  seek(voice: number, sec: number): Promise<void>;
  volume(voice: number, volume: number): Promise<void>;
  /** Lets go of the voice and its file. */
  close(voice: number): Promise<void>;
  closeAll(): Promise<void>;
  /** Every event of every voice; returns the function that stops listening. */
  onEvent(cb: (e: PlayerEvent) => void): () => void;
}

/** The cover search's requests through the desktop app's backend (src-tauri/src/cover_net.rs). */
export interface CoverNetAccess {
  /** GET over https to the cover services' hosts only; redirects come back as answers. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** The list of "Entdecken" built on this computer (desktop app, see __LOCAL_SOURCES__). */
export interface SourcesListAccess {
  /** GET over https to the hosts of the list's sources only; redirects come back as answers. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The list kept in the app's data folder, or null. */
  readCache(): Promise<string | null>;
  writeCache(text: string): Promise<void>;
}
