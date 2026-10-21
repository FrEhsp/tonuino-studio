import { computed, effect, signal } from '@preact/signals';
import {
  buildPackageBlob,
  crcPending,
  manifestOf,
  packageContent,
  packageName,
  type PackageContent,
  type PackageManifest,
  type PackageMode,
} from '../core/tonuino/package';
import { catalogContent, parseCatalog, type Catalog } from '../core/tonuino/catalog';
import { cardPrint, fitsWaitingPrint, type CardPrint, type WaitingPrint } from '../core/tonuino/cardprint';
import { APP_FILES, CATALOG_FILE, isJunk } from '../core/tonuino/sd';
import { checkCardContent } from '../core/tonuino/verify';
import { diffForPackage, withoutAppFile, type WritePlan } from '../core/tonuino/writeplan';
import { forgetCrc32 } from '../core/zip/crc32';
import { childOf, files, type BlobFolder } from '../platform/blobtree';
import { createOverlay, type Overlay } from '../platform/overlay';
import { cardLabel, isSnapshotProblem, pickedSubfolder, type SnapshotProblem, type SnapshotResult } from '../platform/snapshot';
import type { SnapshotPurpose, StartedDownload, Volume } from '../platform/types';
import { card, catalog, openVolume, plat, platform } from './state';
import { writeGuard, type WriteKind } from './writeguard';

/**
 * The card in browsers that cannot write to it (Firefox, Safari): the app
 * reads it once as a snapshot and works on a copy of it. What changed waits
 * here until it reaches the card as a Paket the user downloads and unpacks.
 *
 * clean: the copy equals the card as read. pending: changes wait.
 * downloaded: a Paket is on its way to the card; until the card was checked
 * (or the Paket discarded) only names and pictures may change, because the
 * next Paket has to fit the card as it will be then.
 *
 * Readings from the folder chooser arrive here whichever page opened it
 * (see connect() at the end), so a reading never gets lost on the way.
 */

interface Session {
  overlay: Overlay;
  /** The reading the copy started from. */
  snapshot: SnapshotResult;
  volume: Volume;
  unwatch: () => void;
  /** Id of the catalog on the card as read; null when it had none. */
  cardId: string | null;
  /** That catalog without its time (catalogContent); null when the card had none. */
  baseCatalog: string | null;
  /** The card's root as read, to know it again without a catalog. */
  print: CardPrint;
}

export interface DownloadedPackage {
  manifest: PackageManifest;
  /** Missing for a Paket downloaded before the app was closed (`restored`). */
  download?: StartedDownload;
  /**
   * Downloaded in an earlier visit and not checked yet: the card read now
   * does not hold it. Nothing may change until it is on the card or thrown
   * away, not even names, because the Paket brings its own.
   */
  restored?: boolean;
  /** The app's files (catalog, covers) as they were packed; changed ones go into the next Paket. */
  appBlobs: Map<string, Blob>;
  /** When the download started (ms since epoch). */
  at: number;
}

export type PackageState = { kind: 'clean' } | { kind: 'pending' } | ({ kind: 'downloaded' } & DownloadedPackage);

const session = signal<Session | null>(null);
/** Follows overlay.version, so what depends on the copy follows its changes. */
const version = signal(0);
const downloaded = signal<DownloadedPackage | null>(null);
/** Pakete downloaded and then discarded since the card was read. */
const discarded = signal(0);

/** The session of the open card; null when the open card is not a snapshot. */
const current = computed(() => {
  const s = session.value;
  return s && card.value?.volume.id === s.volume.id ? s : null;
});

/** The reading of the open card, or null when the app writes to the card directly. */
export const snapshotOfCard = computed<SnapshotResult | null>(() => current.value?.snapshot ?? null);

/** What waits for the card. Null when no snapshot is open. */
export const plan = computed<WritePlan | null>(() => {
  const s = current.value;
  void version.value;
  if (!s) return null;
  const p = diffForPackage(s.overlay.base, s.overlay.tree);
  // A catalog saved again with what it said when read (a card added and taken out again) brings nothing new.
  const c = catalog.value;
  return s.baseCatalog !== null && c && catalogContent(c) === s.baseCatalog ? withoutAppFile(p, s.overlay.tree, CATALOG_FILE) : p;
});

const CLEAN: PackageState = { kind: 'clean' };
const PENDING: PackageState = { kind: 'pending' };

export const packageState = computed<PackageState>(() => {
  if (!current.value) return CLEAN;
  const d = downloaded.value;
  if (d) return { kind: 'downloaded', ...d };
  return (plan.value?.count ?? 0) > 0 ? PENDING : CLEAN;
});

/** Pakete thrown away since the card was read: the guide then says to take only the newest one. */
export const discardedPackages = computed(() => (current.value ? discarded.value : 0));

export function isSnapshotCard(): boolean {
  return card.value?.volume.access === 'snapshot';
}

/**
 * A Paket from somewhere else went onto the card and was checked while the
 * app's own changes wait: those are planned against the card as it was
 * read before. They must not go into a Paket, and nothing new may be
 * planned on top, until the user takes the card as it is now.
 */
export interface ChangedElsewhere {
  /** The card as the check read it, with the other Paket on it. */
  reading: SnapshotResult;
  /** File name of that Paket. */
  packageName: string;
  at: number;
}

const changedElsewhere = signal<{ session: Session; info: ChangedElsewhere } | null>(null);

/** Set while the open card changed by a Paket from elsewhere and own changes still wait (see ChangedElsewhere). */
export const cardChangedElsewhere = computed<ChangedElsewhere | null>(() => {
  const c = changedElsewhere.value;
  return c && c.session === current.value ? c.info : null;
});

/**
 * False while a downloaded Paket waits for the card (then only names and
 * pictures may change), or while the card changed elsewhere and the app's
 * copy is an old reading.
 */
export function canChangeCard(): boolean {
  return !(isSnapshotCard() && (downloaded.value || cardChangedElsewhere.value));
}

/**
 * Space left for new files, in bytes, when the browser tells. Undefined for
 * the store in memory: files taken over as they are cost it nothing, so an
 * estimate of the whole import would say "too much" too early.
 */
export async function scratchAvailable(): Promise<number | undefined> {
  const store = current.peek()?.overlay.store;
  return store?.kind === 'opfs' ? store.available() : undefined;
}

function appBlobsOf(tree: BlobFolder): Map<string, Blob> {
  const m = new Map<string, Blob>();
  for (const name of APP_FILES) {
    const node = childOf(tree, name);
    if (node?.kind === 'file') m.set(name, node.blob);
  }
  return m;
}

/** The app's files that changed after the Paket was packed. */
function appChangedSince(d: DownloadedPackage, tree: BlobFolder): string[] {
  const now = appBlobsOf(tree);
  return APP_FILES.filter((name) => now.get(name) !== d.appBlobs.get(name));
}

/**
 * Whether closing the page now loses work: changes wait and no Paket has
 * them, or names and pictures changed after the download.
 */
export const changesWouldBeLost = computed(() => {
  const s = current.value;
  const st = packageState.value;
  if (!s || st.kind === 'clean') return false;
  if (st.kind === 'pending') return true;
  void version.value;
  return appChangedSince(st, s.overlay.tree).length > 0;
});

/** Folders the copy has and the card not yet: they come with the next Paket. */
export const foldersNotOnCard = computed<ReadonlySet<number>>(() => {
  const p = plan.value;
  return new Set(p ? p.changes.flatMap((c) => (c.kind === 'add' && c.folder ? [c.folder] : [])) : []);
});

/** New system sounds wait in the copy for the next Paket. */
export const systemSoundsPending = computed(() => !!plan.value?.changes.some((c) => c.system && c.kind !== 'remove'));

/* ------------------------------------------------------------------ remembered Paket */

/**
 * A downloaded Paket is remembered on this computer until the card was
 * checked or the Paket thrown away. After the app was closed, the next
 * reading of that card then knows a Paket still waits, and nothing new is
 * planned on top of a card that is about to change.
 */
const WAITING_KEY = 'tonuino-studio:waiting-package';

interface WaitingRecord {
  /** 1: before the fingerprint; such a record only fits a card by its catalog id. */
  v: 1 | 2;
  /** Catalog ids of the card: as read, and as the Paket brings it. */
  cardIds: (string | null)[];
  /** v2: the card's root as read and as the Paket makes it (see cardprint.ts). */
  print?: WaitingPrint;
  at: number;
  name: string;
  mode: PackageMode;
  createdAt: number;
  size: number;
  topLevel: string[];
  deleteFirst: string[];
  deleteJunk?: string[];
  removeOnly: string[];
  /** path, size, crc32, isNew (1/0) */
  files: [string, number, number, number][];
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function saveWaiting(m: PackageManifest, at: number, cardIds: (string | null)[], print: WaitingPrint): void {
  const st = storage();
  if (!st) return;
  const rec: WaitingRecord = {
    v: 2,
    cardIds,
    print,
    at,
    name: m.name,
    mode: m.mode,
    createdAt: m.createdAt,
    size: m.size,
    topLevel: m.topLevel,
    deleteFirst: m.deleteFirst,
    deleteJunk: m.deleteJunk,
    removeOnly: m.removeOnly,
    files: m.files.map((f) => [f.path, f.size, f.crc32, f.isNew ? 1 : 0]),
  };
  try {
    st.setItem(WAITING_KEY, JSON.stringify(rec));
  } catch {
    // Too big for the browser's storage (a whole card): then at least no older Paket stays remembered.
    clearWaiting();
  }
}

function clearWaiting(): void {
  try {
    storage()?.removeItem(WAITING_KEY);
  } catch {
    // Nothing remembered, nothing to forget.
  }
}

interface Waiting {
  manifest: PackageManifest;
  at: number;
  cardIds: (string | null)[];
  print?: WaitingPrint;
}

function validPrint(p: unknown): p is CardPrint {
  return Array.isArray(p) && p.every((e) => Array.isArray(e) && e.length === 3 && typeof e[0] === 'string' && typeof e[1] === 'number' && typeof e[2] === 'number');
}

function printOf(raw: unknown): WaitingPrint | undefined {
  const p = raw as Partial<WaitingPrint> | undefined;
  if (!p || !validPrint(p.before) || !validPrint(p.after) || !Array.isArray(p.mayBeGone)) return undefined;
  return { before: p.before, after: p.after, mayBeGone: p.mayBeGone.map(String), formatted: !!p.formatted };
}

function loadWaiting(): Waiting | null {
  try {
    const text = storage()?.getItem(WAITING_KEY);
    if (!text) return null;
    const r = JSON.parse(text) as WaitingRecord;
    if ((r?.v !== 1 && r?.v !== 2) || !Array.isArray(r.files) || !Array.isArray(r.cardIds)) return null;
    const manifest: PackageManifest = {
      name: String(r.name),
      mode: r.mode === 'full' ? 'full' : 'changes',
      createdAt: Number(r.createdAt) || 0,
      size: Number(r.size) || 0,
      topLevel: r.topLevel.map(String),
      deleteFirst: r.deleteFirst.map(String),
      ...(Array.isArray(r.deleteJunk) && r.deleteJunk.length ? { deleteJunk: r.deleteJunk.map(String) } : {}),
      removeOnly: r.removeOnly.map(String),
      files: r.files.map(([path, size, crc, isNew]) => ({ path: String(path), size: Number(size), crc32: Number(crc) >>> 0, isNew: isNew === 1 })),
    };
    return { manifest, at: Number(r.at) || 0, cardIds: r.cardIds, print: r.v === 2 ? printOf(r.print) : undefined };
  } catch {
    return null;
  }
}

/**
 * Whether the card read now is the one the remembered Paket waits for. A
 * catalog id names the card; a card without one (or before the Paket's
 * catalog is on it) is known by its fingerprint. A different card never
 * fits: it has another catalog, or other folders and files.
 */
export function isWaitingCard(w: Pick<Waiting, 'manifest' | 'cardIds' | 'print'>, root: BlobFolder, cardId: string | null): boolean {
  // A formatted card (whole-card Paket) has nothing on it yet.
  const blank = !root.children.some((c) => !isJunk(c.name));
  if (w.manifest.mode === 'full' && blank) return true;
  if (cardId !== null) return w.cardIds.includes(cardId);
  // No catalog on the card: only its content can tell. An old record without a fingerprint cannot.
  return !!w.print && fitsWaitingPrint(cardPrint(root), w.print);
}

async function catalogIn(root: BlobFolder): Promise<Catalog | null> {
  const node = childOf(root, CATALOG_FILE);
  if (node?.kind !== 'file') return null;
  try {
    return parseCatalog(await node.blob.text());
  } catch {
    return null;
  }
}

/**
 * The Paket from an earlier visit that still waits for this card, if any.
 * A card that holds it already (unpacked, but not checked in the app)
 * lets it go.
 */
async function waitingFor(r: SnapshotResult, cardId: string | null): Promise<{ manifest: PackageManifest; at: number } | null> {
  const w = loadWaiting();
  if (!w || !isWaitingCard(w, r.root, cardId)) return null;
  try {
    if ((await checkCardContent(r.root, r.label, w.manifest)).ok) {
      clearWaiting();
      return null;
    }
  } catch {
    // Could not read the card: treat the Paket as still waiting.
  }
  return { manifest: w.manifest, at: w.at };
}

/** Card files may change on the card before the next Paket: their CRCs are read again then. */
function forgetCardCrcs(tree: BlobFolder): void {
  for (const { file } of files(tree)) {
    if (file.staged) continue;
    delete file.crc32;
    forgetCrc32(file.blob);
  }
}

/* ------------------------------------------------------------------ open */

let openSeq = 0;

function endSession(s: Session) {
  s.unwatch();
  if (changedElsewhere.peek()?.session === s) changedElsewhere.value = null;
  if (session.peek() === s) {
    downloaded.peek()?.download?.dispose();
    downloaded.value = null;
    discarded.value = 0;
    session.value = null;
  }
  // A Paket of this copy is no longer downloading by now: the card was checked, or the Paket thrown away.
  void s.overlay.store.dispose().catch(() => undefined);
}

/**
 * Opens a reading of the card. Whatever waited for the card before is
 * dropped: ask the user first. `carry`: the app's files to put on top
 * (bytes), or to remove (null).
 */
async function startSession(r: SnapshotResult, carry?: Map<string, Uint8Array | null>): Promise<void> {
  const my = ++openSeq;
  const access = plat().cardSnapshot;
  if (!access) throw new Error('Dieser Browser kann die Karte nicht einlesen.');
  const read = await catalogIn(r.root);
  const cardId = read?.id ?? null;
  // A reading of its own (not the one after a check): perhaps a Paket from an earlier visit waits for this card.
  const earlier = carry ? null : await waitingFor(r, cardId);
  const store = await access.createScratch();
  const overlay = createOverlay(r.root, store, r.label);
  try {
    for (const [name, bytes] of carry ?? []) {
      if (bytes) await overlay.root.write(name, bytes);
      else if (await overlay.root.exists(name)) await overlay.root.remove(name);
    }
  } catch (e) {
    await store.dispose().catch(() => undefined);
    throw e;
  }
  if (my !== openSeq) {
    // Another reading came in meanwhile and wins.
    await store.dispose().catch(() => undefined);
    return;
  }
  const volume: Volume = {
    id: `snap-${r.takenAt}-${my}`,
    label: r.label,
    root: overlay.root,
    info: {},
    canEject: false,
    access: 'snapshot',
    snapshotAt: r.takenAt,
  };
  const old = session.peek();
  if (old) endSession(old);
  version.value = overlay.version;
  const unwatch = overlay.onChange(() => {
    version.value = overlay.version;
  });
  session.value = { overlay, snapshot: r, volume, unwatch, cardId, baseCatalog: read && catalogContent(read), print: cardPrint(r.root) };
  if (earlier) {
    overlay.lock(true);
    downloaded.value = { manifest: earlier.manifest, appBlobs: appBlobsOf(overlay.tree), at: earlier.at, restored: true };
  }
  await openVolume(volume);
}

/** Opens the card as read. Replaces a card read before, with whatever waited for it. */
export function openSnapshot(r: SnapshotResult): Promise<void> {
  cardNote.value = null;
  return startSession(r);
}

/** Reads the card again: changes that wait in the app are dropped, so ask first. */
export function rereadCard(r: SnapshotResult): Promise<void> {
  return openSnapshot(r);
}

/**
 * The card was checked after unpacking: this reading becomes the new start.
 * Names and pictures changed after the download come along and wait for the
 * next Paket.
 */
export async function acceptCheckedCard(r: SnapshotResult): Promise<void> {
  const s = current.peek();
  const d = downloaded.peek();
  const carry = new Map<string, Uint8Array | null>();
  if (s && d) {
    // Read now: the old session's storage goes away with it.
    for (const name of appChangedSince(d, s.overlay.tree)) {
      const node = childOf(s.overlay.tree, name);
      carry.set(name, node?.kind === 'file' ? new Uint8Array(await node.blob.arrayBuffer()) : null);
    }
  }
  cardNote.value = null;
  clearWaiting();
  await startSession(r, carry);
}

/* ------------------------------------------------------------------ Paket */

/** The card as the app has it now (the copy with the changes). Null when no snapshot is open. */
export function copyOfCard(): BlobFolder | null {
  return current.peek()?.overlay.tree ?? null;
}

/** What a Paket would hold right now (sizes, what to delete first). Null when no snapshot is open. */
export function previewPackage(mode: PackageMode): PackageContent | null {
  const s = current.peek();
  const p = plan.peek();
  return s && p ? packageContent(p, s.overlay.tree, mode) : null;
}

/** Long writes that change the copy of the card: a Paket made meanwhile would hold only part of them. */
const COPY_WRITES: readonly WriteKind[] = ['tracks', 'repair', 'order', 'sounds', 'covers'];

/** Something is being written into the copy right now: no Paket until it is done. */
export const copyBusy = computed(() => writeGuard.running.value.some((k) => COPY_WRITES.includes(k)));

export const BUSY_TEXT = 'Gerade lege ich noch etwas fürs Paket bereit. Warte, bis ich fertig bin. Danach kannst du das Paket herunterladen.';

function busyNow(s: Session): boolean {
  return copyBusy.peek() || s.overlay.writing > 0;
}

const STALE_TEXT = 'Auf der Karte ist inzwischen ein anderes Paket. Übernimm zuerst die Karte, wie sie jetzt ist. Danach passt das nächste Paket wieder.';

/** What was packed when, to tell a Paket that still fits the copy from one that does not. */
const packed = new WeakMap<PackageManifest, { session: Session; version: number; appBlobs: Map<string, Blob> }>();

/**
 * Packs what waits for the card. Card files whose checksum is unknown are
 * read once for it (`onProgress` counts those bytes). `needsClick`: that
 * took a while, so the download needs a click of its own (Safari only
 * downloads right after a click).
 */
export async function makePackage(
  mode: PackageMode,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ blob: Blob; manifest: PackageManifest; needsClick: boolean }> {
  const s = current.peek();
  const p = plan.peek();
  if (!s || !p) throw new Error('Es ist keine eingelesene Karte offen. Lies die Karte zuerst ein.');
  if (cardChangedElsewhere.peek()) throw new Error(STALE_TEXT);
  if (busyNow(s)) throw new Error(BUSY_TEXT);
  const at = new Date();
  const content = packageContent(p, s.overlay.tree, mode);
  const needsClick = crcPending(content).files > 0;
  const builtAt = s.overlay.version;
  const appBlobs = appBlobsOf(s.overlay.tree);
  const { blob, layout } = await buildPackageBlob(content, { now: at, signal: opts.signal, onProgress: opts.onProgress });
  const manifest = manifestOf(content, layout, packageName(mode, at), at.getTime());
  packed.set(manifest, { session: s, version: builtAt, appBlobs });
  return { blob, manifest, needsClick };
}

/**
 * Starts the download. From now on the copy waits for the card: only
 * names and pictures may change until the card was checked.
 */
export function startPackageDownload(blob: Blob, manifest: PackageManifest): StartedDownload {
  const s = current.peek();
  const p = packed.get(manifest);
  if (!s || !p || p.session !== s) throw new Error('Das Paket gehört zu einer Karte, die nicht mehr offen ist. Packe es neu.');
  if (busyNow(s)) throw new Error(BUSY_TEXT);
  if (s.overlay.version !== p.version) throw new Error('Seit dem Packen hat sich etwas geändert. Packe das Paket noch einmal.');
  if (cardChangedElsewhere.peek()) throw new Error(STALE_TEXT);
  const before = downloaded.peek();
  if (before) {
    before.download?.dispose();
    discarded.value++;
  }
  const download = plat().cardSnapshot!.download(blob, manifest.name);
  s.overlay.lock();
  const at = Date.now();
  downloaded.value = { manifest, download, appBlobs: p.appBlobs, at };
  const print: WaitingPrint = {
    before: s.print,
    after: cardPrint(s.overlay.tree),
    mayBeGone: [...manifest.deleteFirst, ...manifest.removeOnly],
    formatted: manifest.mode === 'full',
  };
  saveWaiting(manifest, at, [s.cardId, catalog.peek()?.id ?? null], print);
  return download;
}

/**
 * The downloaded Paket is not wanted: the changes wait again for the next
 * one. Ask first whether something was deleted on the card already: then
 * the Paket is the only copy left of it.
 */
export function discardPackage(): void {
  const d = downloaded.peek();
  if (!d) return;
  d.download?.dispose();
  downloaded.value = null;
  discarded.value++;
  clearWaiting();
  const s = current.peek();
  if (!s) return;
  s.overlay.unlock();
  // The card may have changed since: the next Paket reads its files again, and a file that is gone shows before any download.
  forgetCardCrcs(s.overlay.tree);
}

/**
 * A Paket from elsewhere was checked on the card. With nothing waiting in
 * the app (or no card open), the checked reading becomes the new start.
 * When own changes or an own Paket wait, they were planned against the old
 * reading: the app keeps them, but holds them back until the user decides
 * (takeChangedCard, or reading the card again).
 */
export async function foreignPackageChecked(r: SnapshotResult, packageName: string): Promise<'opened' | 'held'> {
  const s = current.peek();
  if (!s || packageState.peek().kind === 'clean') {
    await openSnapshot(r);
    return 'opened';
  }
  changedElsewhere.value = { session: s, info: { reading: r, packageName, at: Date.now() } };
  return 'held';
}

/**
 * Takes the card as the check read it, after a Paket from elsewhere. Own
 * changes and an own downloaded Paket are dropped: they were planned for
 * the card as it was.
 */
export async function takeChangedCard(): Promise<void> {
  const c = cardChangedElsewhere.peek();
  if (!c) return;
  // The own Paket no longer fits this card: it must not lock the new reading.
  if (downloaded.peek()) clearWaiting();
  await openSnapshot(c.reading);
}

/**
 * Reads the card once more after it changed elsewhere; the reading then
 * replaces the copy as usual. An own downloaded Paket is forgotten, it no
 * longer fits. Must run in a click handler.
 */
export function rereadChangedCard(): void {
  if (cardChangedElsewhere.peek() && downloaded.peek()) clearWaiting();
  chooseCardFolder('card');
}

/* ------------------------------------------------------------------ readings */

export type CardNote =
  /** The reading did not work. */
  | { kind: 'problem'; problem: SnapshotProblem; source: 'chooser' | 'drop' }
  /** A folder of the card was chosen, not the card: it waits until the user decides. */
  | { kind: 'picked-subfolder'; result: SnapshotResult }
  /** The card opened, and it is empty: perhaps the wrong folder. */
  | { kind: 'looks-empty' };

/** What the box page says about the last reading of the card. */
export const cardNote = signal<CardNote | null>(null);
/** A dropped card is being read: files so far. */
export const cardReading = signal<{ purpose: SnapshotPurpose; files: number } | null>(null);
/** The last reading for "Karte prüfen". */
export const checkReading = signal<{ result: SnapshotResult | SnapshotProblem; source: 'chooser' | 'drop'; at: number } | null>(null);
/** The folder chooser was opened and nothing came back yet. */
export const chooserOpen = signal<{ purpose: SnapshotPurpose; at: number } | null>(null);

function emptyCard(label: string | undefined): SnapshotResult {
  const name = cardLabel(label ?? '');
  return { root: { kind: 'directory', name, children: [] }, label: name, takenAt: Date.now(), files: 0, bytes: 0, source: 'chooser' };
}

/** A reading of the card itself (not for checking it). */
export async function takeCardReading(r: SnapshotResult | SnapshotProblem, source: 'chooser' | 'drop' = 'chooser'): Promise<void> {
  if (isSnapshotProblem(r)) {
    if (r.kind !== 'empty') {
      cardNote.value = { kind: 'problem', problem: r, source };
      return;
    }
    // A new card is empty: open it, and say what else it could be.
    await startSession(emptyCard(r.label));
    cardNote.value = { kind: 'looks-empty' };
    return;
  }
  if (pickedSubfolder(r)) {
    cardNote.value = { kind: 'picked-subfolder', result: r };
    return;
  }
  await openSnapshot(r);
}

function deliver(purpose: SnapshotPurpose, r: SnapshotResult | SnapshotProblem, source: 'chooser' | 'drop') {
  if (source === 'chooser') chooserOpen.value = null;
  if (purpose === 'check') {
    checkReading.value = { result: r, source, at: Date.now() };
    return;
  }
  void takeCardReading(r, source).catch((e: unknown) => {
    cardNote.value = { kind: 'problem', problem: { kind: 'read-failed', path: '', message: e instanceof Error ? e.message : String(e) }, source };
  });
}

/** Opens the folder chooser. Must run in a click handler. */
export function chooseCardFolder(purpose: SnapshotPurpose): void {
  const access = platform.peek()?.cardSnapshot;
  if (!access) return;
  if (purpose === 'check') checkReading.value = null;
  chooserOpen.value = { purpose, at: Date.now() };
  access.choose(purpose);
}

let dropSeq = 0;

/**
 * Reads a card dropped onto the page. Call it in the drop handler itself.
 * False when the drop held no files (or this browser reads no cards).
 */
export function readDroppedCard(dt: DataTransfer, purpose: SnapshotPurpose): boolean {
  const access = platform.peek()?.cardSnapshot;
  if (!access) return false;
  const my = ++dropSeq;
  const reading = access.fromDrop(dt, {
    onProgress: (files) => {
      if (my === dropSeq) cardReading.value = { purpose, files };
    },
  });
  if (!reading) return false;
  if (purpose === 'check') checkReading.value = null;
  cardReading.value = { purpose, files: 0 };
  void reading
    .then(
      (r) => r,
      (e: unknown): SnapshotProblem => ({ kind: 'read-failed', path: '', message: e instanceof Error ? e.message : String(e) }),
    )
    .then((r) => {
      // Only the last drop counts.
      if (my !== dropSeq) return;
      cardReading.value = null;
      deliver(purpose, r, 'drop');
    });
  return true;
}

/* ------------------------------------------------------------------ wiring */

function warnBeforeLeaving(e: BeforeUnloadEvent) {
  e.preventDefault();
  // Safari asks only when returnValue is set.
  e.returnValue = true;
}

// Readings arrive here, from whichever page opened the chooser.
let disconnect: (() => void) | undefined;
effect(() => {
  const p = platform.value;
  disconnect?.();
  disconnect = p?.cardSnapshot?.onChosen((o) => {
    if ('cancelled' in o) {
      chooserOpen.value = null;
      return;
    }
    deliver(o.purpose, o.result, 'chooser');
  });
});

// A card that was closed takes its copy along.
effect(() => {
  const c = card.value;
  const s = session.peek();
  if (!c && s) endSession(s);
});

// Asks before the tab closes while changes exist only in the app.
if (typeof window !== 'undefined') {
  effect(() => {
    if (changesWouldBeLost.value) window.addEventListener('beforeunload', warnBeforeLeaving);
    else window.removeEventListener('beforeunload', warnBeforeLeaving);
  });
}
