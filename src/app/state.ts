import { tidyFolder } from '../core/library/tidy';
import { computed, effect, signal } from '@preact/signals';
import type { FirmwareProfile } from '../core/tonuino/card';
import { afterBoxReport, decideProfile, profileFromBox, tngReleaseOf, type ProfileDecision } from '../core/tonuino/firmwaredetect';
import type { AdminAccess, TngRelease } from '../core/tonuino/boxguide';
import { modeByCode } from '../core/tonuino/modes';
import {
  applyPlanToCatalog,
  dropPictureTweaks,
  loadCatalog,
  matchLibraryCatalog,
  newCatalog,
  newId,
  parseCatalog,
  saveCatalog,
  serializeCatalog,
  touchFolder,
  type Catalog,
  type StickerTweaks,
} from '../core/tonuino/catalog';
import { coverEntryName, coverMimeType, loadCovers, renumberCovers, saveCovers, swapCovers, type CoverMap } from '../core/tonuino/covers';
import { unreadableFiles } from '../core/tonuino/unreadable';
import { checkHealth, type FormatSystem, type HealthContext, type HealthReport } from '../core/tonuino/health';
import { doneSteps, executePlan, touchedFolders, type ExecuteProgress, type ExecuteResult, type PlanStep, type RepairPlan } from '../core/tonuino/repair';
import { folderName, helperFolders, parseTempDir, scanSd, type ScanProgress, type SdScan } from '../core/tonuino/sd';
import { macTidyText, tidyMacJunk } from '../core/tonuino/macjunk';
import type { BoxMemory } from '../core/tonuino/remember';
import { SNAPSHOT_LISTING_IS_FAT_ORDER } from '../platform/snapshot';
import type { Platform, Volume, VolumeInfo } from '../platform/types';
import { kv } from '../platform/web/idb';
import { closeHostFor, writeGuard, type WriteKind } from './writeguard';
import { keepAwakeWhileWriting } from './wakelock';
import { STIL } from '../ui/stil';

/* ------------------------------------------------------------------ settings */

export interface Settings {
  theme: 'auto' | 'light' | 'dark';
  /** Firmware of new boxes. Existing cards keep theirs in the catalog. */
  profile: FirmwareProfile;
  /** File names without text after the number ("001.mp3"). */
  pureNumbers: boolean;
  /** Bring tracks to the same loudness when adding them. */
  normalizeLoudness: boolean;
  /** Convert the MP3s of a quiet album that lossless steps would leave too quiet. */
  boostQuietMp3: boolean;
  /** Bitrate when converting to MP3. */
  bitrateKbps: 96 | 128 | 160 | 192;
  /** Approximate track length when cutting long files at pauses. */
  splitMinutes: number;
  /** Remove tags and embedded pictures from MP3 files on the card. */
  stripTags: boolean;
  /** Show modes for tinkerers (quiz, memory, …). */
  advancedModes: boolean;
  /** How the admin menu of the box opens, for the step-by-step guide. */
  adminAccess: AdminAccess;
  /** Whether the TNG box is from 17.09.2026 or later, for the step-by-step guide. */
  tngRelease: TngRelease;
  /** How cards were written last time. */
  cardMethod: CardMethod;
  /** Address of an ESP32 box in the home network. */
  boxAddress: string;
  /** A short "Pling" when the SD card is finished (src/ui/sound.ts). */
  doneSound: boolean;
  /** The shelf looks up missing covers at iTunes/MusicBrainz by itself (src/features/covers/shelfCards.ts). */
  findCovers: boolean;
  /** Extra: "Zusammenfügen" for several tracks on the folder page (src/features/box/JoinDialog.tsx). */
  joinTracks: boolean;
  /** Extra: Hörspiele and Hörbücher that are converted become mono at half the bitrate (add/process.ts). */
  monoSpeech: boolean;
  /** Extra: several episodes in one folder, one von-bis card each (src/core/tonuino/episodes.ts, box/EpisodesSection.tsx). */
  episodePlanner: boolean;
  /** Extra: a back side per sticker with the track list or a QR code, for duplex printing (stickers/backside.ts). */
  stickerBacks: boolean;
  /** Extra: spoken titles in front of tracks, by the computer's voice (src/features/box/AnnounceDialog.tsx, add/process.ts). */
  announceTitles: boolean;
  /** Extra: "Aufnehmen" from the microphone on the folder page and under "Hinzufügen" (src/features/add/RecordDialog.tsx). */
  recordAudio: boolean;
  /** Keep what is on each opened box on this device, for "Meine Box" without the card (src/app/remembered.ts). */
  rememberBoxes: boolean;
}

/** 'usb': the box writes the card itself (WRITECARD, features/cards/UsbPanel.tsx); only offered for a box that can. */
export type CardMethod = 'box' | 'qr' | 'reader' | 'wifi' | 'usb';

/** index.html reads this key too, to apply the theme before the first paint. */
export const SETTINGS_KEY = 'tonuino-studio:settings';

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  theme: 'auto',
  profile: 'tng',
  pureNumbers: true,
  normalizeLoudness: true,
  boostQuietMp3: true,
  bitrateKbps: 128,
  splitMinutes: 5,
  stripTags: true,
  advancedModes: false,
  adminAccess: 'buttons',
  tngRelease: 'unknown',
  cardMethod: 'box',
  boxAddress: '',
  doneSound: true,
  findCovers: true,
  joinTracks: false,
  monoSpeech: false,
  episodePlanner: false,
  stickerBacks: false,
  announceTitles: false,
  recordAudio: false,
  rememberBoxes: false,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const stored = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings & { style?: unknown };
      // Up to 0.1 the app had three looks to pick from; since 0.2 it has one (src/ui/stil.ts).
      delete stored.style;
      return stored;
    }
  } catch {
    // Private mode or blocked storage: defaults it is.
  }
  return { ...DEFAULT_SETTINGS };
}

export const settings = signal<Settings>(loadSettings());

export function updateSettings(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value));
  } catch {
    // Not persisted; still applies for this session.
  }
}

/** Back to the defaults. Forgets the stored values, so changed defaults of later versions apply too. */
export function resetSettings() {
  try {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(CARD_METHOD_CHOSEN_KEY);
  } catch {
    // Storage blocked: the defaults still apply for this session.
  }
  settings.value = { ...DEFAULT_SETTINGS, ...phoneDefaults(platform.value) };
}

/** Set once the user picked a way to write cards, so a default of the platform no longer applies. */
const CARD_METHOD_CHOSEN_KEY = 'tonuino-studio:card-method-chosen';

/** The way to write cards, picked by the user (cards page, settings). */
export function chooseCardMethod(cardMethod: CardMethod) {
  updateSettings({ cardMethod });
  try {
    localStorage.setItem(CARD_METHOD_CHOSEN_KEY, '1');
  } catch {
    // Not remembered: the next start offers the platform's default again.
  }
}

function cardMethodChosen(): boolean {
  try {
    return localStorage.getItem(CARD_METHOD_CHOSEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** The Android app writes cards with the phone itself, unless the user picked another way. */
function phoneDefaults(p: Platform | null): Partial<Settings> {
  return p?.mobile && !cardMethodChosen() ? { cardMethod: 'reader' } : {};
}

/* ------------------------------------------------------------------ platform */

export const platform = signal<Platform | null>(null);

/**
 * Whether "Selbst aufnehmen" is offered: switched on in the settings, or
 * always on a phone or tablet, which has its microphone built in.
 */
export function recordingOffered(): boolean {
  return settings.value.recordAudio || !!platform.value?.capabilities.builtInMic;
}

export function plat(): Platform {
  const p = platform.value;
  if (!p) throw new Error('Platform not ready');
  return p;
}

/* ------------------------------------------------------------------ SD card */

export interface CardState {
  volume: Volume;
  status: 'scanning' | 'ready' | 'error';
  progress?: ScanProgress;
  scan?: SdScan;
  report?: HealthReport;
  catalog?: Catalog;
  /** False while the catalog exists only in memory (fresh card, not yet written). */
  catalogOnCard: boolean;
  covers: CoverMap;
  coverUrls: Map<string, string>;
  info: VolumeInfo;
  error?: string;
  /** A write on the card failed because the app lacks the rights there (desktop). */
  writeDenied?: boolean;
  /** App files that are on the card but failed to read (unreadable.ts): the app changes nothing in them. */
  unreadable?: string[];
}

export const volumes = signal<Volume[]>([]);
export const needsPermission = signal(false);
export const card = signal<CardState | null>(null);
/** Hinzufügen put something on a card in this session: "Meine Box" may now ask once to remember the box (remembered.ts). */
export const transferredToCard = signal(false);
/** Hinzufügen holds a recording ("Selbst aufnehmen"): the phone's tabs keep „Aufnehmen“ lit on that page (session.ts). */
export const recordingInImport = signal(false);
/** Folders picked for printing or card writing, kept across pages. */
export const selection = signal<Set<number>>(new Set());
/**
 * Set by the ways that open „Viele Karten auf einmal“ with cards picked for it (a folder, after adding, renumbering):
 * the page then brings the first of them into view, once. Picks left from another page (stickers) do not
 * scroll it: it opens at its top (Prüfrunde 1 Aussehen 9).
 */
export const revealPicked = signal(false);
/** "Sticker anpassen" from a folder: the sticker page opens this folder's sticker for editing. */
export const stickerToEdit = signal<number | null>(null);

/**
 * Right after the start, while the app still looks for the card (the system
 * asked for its drives, a remembered card checked): "Meine Box" and the card
 * box in the sidebar stay calm and empty instead of saying "no card" for a
 * moment and then jumping to the card.
 */
const lookingForCard = signal(true);
export const startingUp = computed(() => lookingForCard.value && !card.value);
/** At most this long; a card that takes longer shows the start page meanwhile. */
const START_LOOK_MS = 3000;

/**
 * A box remembered on this device, shown read only while no card is open
 * („Box merken“, src/app/remembered.ts): its folders as last seen, its
 * catalog and small covers. Never written to.
 */
export interface RememberedView {
  memory: BoxMemory;
  scan: SdScan;
  catalog: Catalog;
  /** Thumbnails by cover entry, as in CardState.coverUrls. */
  coverUrls: Map<string, string>;
}

export const remembered = signal<RememberedView | null>(null);
/** The remembered box while it stands in for the card: only while no card is open. */
export const shownMemory = computed(() => (card.value ? null : remembered.value));

/** The open card's own catalog: what changes are written to. */
export const cardCatalog = computed(() => card.value?.catalog ?? null);
/** The catalog to show: the open card's, or the remembered box's while no card is open. */
export const catalog = computed(() => cardCatalog.value ?? shownMemory.value?.catalog ?? null);
/** The folders to show, as read from the open card or as remembered. */
export const boxScan = computed<SdScan | undefined>(() => card.value?.scan ?? shownMemory.value?.scan);

/** Said wherever the remembered box cannot do what the card could. */
export const NEEDS_CARD = 'Dafür muss die SD-Karte im Computer stecken. Gerade zeig ich nur den gemerkten Stand der Box.';
/** The firmware family the last box connected over USB named in this session (Box-Logbuch, „Box erkennen“, a firmware just put on). */
export const boxProfile = signal<FirmwareProfile | null>(null);

/**
 * Which firmware the open card is for, and how the app knows (#29): chosen by
 * hand, said by the box over USB, guessed from the announcements on the card,
 * or the default. See src/core/tonuino/firmwaredetect.ts.
 */
export const profileDecision = computed<ProfileDecision>(() => {
  const c = card.value;
  const stored = c?.catalog ? { profile: c.catalog.profile, from: c.catalog.profileFrom } : undefined;
  const box = boxProfile.value;
  if (box && stored?.from !== 'manual' && stored?.from !== 'box') return { profile: box, source: 'box' };
  // A remembered box knows its firmware as the card did: chosen, said by the box, or what its announcements said.
  const r = shownMemory.value;
  if (!c && r) {
    const d = decideProfile({ profile: r.catalog.profile, from: r.catalog.profileFrom }, undefined, settings.value.profile);
    return d.source === 'default' && r.memory.sounds ? { profile: r.memory.sounds.profile, source: 'sounds', files: r.memory.sounds.files } : d;
  }
  if (!c) return { profile: settings.value.profile, source: 'default' };
  return decideProfile(stored, c.scan, settings.value.profile);
});
export const profile = computed<FirmwareProfile>(() => profileDecision.value.profile);

/**
 * Whether the box of the open card runs TNG of 17.09.2026 or newer: what the
 * box named at its start (kept in the card's catalog, „automatisch erkannt“),
 * else the setting.
 */
export const releaseDecision = computed<{ release: TngRelease; detected: boolean }>(() => {
  const detected = tngReleaseOf(catalog.value?.firmware);
  return detected ? { release: detected, detected: true } : { release: settings.value.tngRelease, detected: false };
});

let unsubscribe: (() => void) | null = null;
let stopDenied: (() => void) | null = null;
let stopAwake: (() => void) | null = null;
let openSeq = 0;

export function boot(p: Platform) {
  platform.value = p;
  const phone = phoneDefaults(p);
  if (phone.cardMethod && settings.value.cardMethod !== phone.cardMethod) settings.value = { ...settings.value, ...phone };
  // Closing the app in the middle of a long write asks first.
  writeGuard.connect(closeHostFor(p));
  // ...and keeps the screen on, so the computer or phone does not fall asleep in the middle.
  stopAwake?.();
  stopAwake = keepAwakeWhileWriting(writeGuard.running);
  unsubscribe?.();
  lookingForCard.value = true;
  let selecting: Promise<void> | undefined;
  unsubscribe = p.volumes.subscribe((list) => {
    volumes.value = list;
    needsPermission.value = !!p.volumes.needsPermission;
    const current = card.value?.volume;
    // A card read as a snapshot (Firefox, Safari) is never in the list, and it stays open without the card.
    if (current && current.access !== 'snapshot' && !list.some((v) => v.id === current.id)) {
      closeCard();
    }
    if (!card.value && list.length) selecting = autoSelect(list).catch(() => undefined);
  });
  // The first list is known and a card in it looked at (or it takes too long): from now on "no card" is true.
  const looked = (async () => {
    await p.volumes.settled?.().catch(() => undefined);
    await selecting;
  })();
  void Promise.race([looked, new Promise((r) => setTimeout(r, START_LOOK_MS))]).then(() => (lookingForCard.value = false));
  stopDenied?.();
  stopDenied = p.volumes.onWriteDenied?.((id) => void noteWriteDenied(id)) ?? null;
}

/**
 * Writing on the open card failed for lack of rights: "Meine Box" says so
 * from now on, with what the platform now knows about the card.
 */
export async function noteWriteDenied(volumeId: string): Promise<void> {
  const s = card.value;
  if (!s || s.volume.id !== volumeId || s.volume.access === 'snapshot') return;
  card.value = { ...s, writeDenied: true };
  const info = await volumeInfo(s.volume, s.info);
  const now = card.value;
  if (now?.volume.id === volumeId) card.value = { ...now, info };
}

/**
 * "Schreibrechte holen" (desktop, Linux): mounts the card again for this
 * user and opens it from where it is mounted now.
 */
export async function fixCardAccess(): Promise<void> {
  const s = card.value;
  const v = plat().volumes;
  if (!s || !v.fixAccess) return;
  const fresh = await v.fixAccess(s.volume);
  await openVolume(fresh);
}

/** A drive the system reports as built in, e.g. a second partition mounted under /media. */
export function isBuiltInDrive(v: Volume): boolean {
  return v.info.removable === false;
}

/** Drives the user closed with "Andere Karte wählen": not opened by themselves again. */
const setAside = new Set<string>();

/**
 * "Andere Karte wählen": closes the open card without ejecting it, so the
 * start page offers the drives to pick from. In the browser the app also
 * forgets a drive that is no box (other files on it, or nothing): a wrongly
 * picked folder would open by itself again after a reload. A real box stays
 * remembered for next time; the card picked now is the newer one and wins
 * after a reload.
 */
export async function chooseOtherCard(): Promise<void> {
  const s = card.value;
  const volume = s?.volume;
  const foreign = !!s && !s.catalogOnCard && s.scan?.kind !== 'tonuino';
  if (volume) setAside.add(volume.id);
  closeCard();
  const p = platform.peek();
  if (volume && foreign && p && !p.capabilities?.sdAutoDetect) await p.volumes.forget?.(volume).catch(() => undefined);
}

/** Bigger than any SD card a TonUINO box takes. */
const MAX_CARD_BYTES = 512 * 1024 ** 3;

/**
 * Whether a plugged-in drive could be the box's SD card: a FAT file system
 * (or one the system does not name, e.g. "fuseblk") and not bigger than a card.
 * A USB hard disk with ext4 or NTFS, or one with 900 GB, is not.
 */
export function looksLikeCard(v: Volume): boolean {
  return fileSystemOfACard(v) && (v.info.totalBytes ?? 0) <= MAX_CARD_BYTES;
}

/** FAT or exFAT (or not known): the box's player reads no other file system. */
function fileSystemOfACard(v: Volume): boolean {
  const fs = v.info.fsType?.toLowerCase();
  return !fs || fs === 'fuseblk' || /fat|msdos/.test(fs);
}

/**
 * Prefers a card that already holds TonUINO content when several drives are
 * plugged in. Built-in drives, and drives that do not look like a card, are
 * never opened by themselves: the user picks them on the start page if they
 * really are the card.
 */
async function autoSelect(all: Volume[]) {
  // Only drives the box could read: a Linux disk named "SD" that once got a tonuino-studio.json
  // (a big disk with games and system backups) was opened by itself and read for minutes.
  const list = all.filter((v) => !isBuiltInDrive(v) && !setAside.has(v.id) && fileSystemOfACard(v));
  for (const v of list) {
    try {
      const names = (await v.root.list()).map((e) => e.name.toLowerCase());
      const box = names.some((n) => n === 'mp3' || n === 'advert' || n === 'tonuino-studio.json');
      // On a disk bigger than any card, folders 01–12 are more likely photos sorted by month (Testlabor #69).
      if (box || (looksLikeCard(v) && names.some((n) => /^\d\d$/.test(n)))) {
        if (card.value) return;
        return openVolume(v);
      }
    } catch {
      // Unreadable drive: skip.
    }
  }
  if (list.length === 1 && looksLikeCard(list[0]) && !card.value) return openVolume(list[0]);
}

function revokeCovers(state: CardState | null) {
  for (const url of state?.coverUrls.values() ?? []) URL.revokeObjectURL(url);
}

function coverUrls(covers: CoverMap): Map<string, string> {
  const m = new Map<string, string>();
  for (const [name, bytes] of covers) m.set(name, URL.createObjectURL(new Blob([bytes as BlobPart], { type: coverMimeType(name) })));
  return m;
}

export function closeCard() {
  revokeCovers(card.value);
  card.value = null;
  selection.value = new Set();
}

/** Flushes and unmounts the card so it can be pulled out safely. Says what the tidying before found (see ejectVolume). */
export async function ejectCard(): Promise<string | undefined> {
  const s = card.value;
  if (!s) return undefined;
  const note = await ejectVolume(s.volume);
  closeCard();
  return note;
}

/**
 * Removes the hidden files macOS left (TODO #95c) right before ejecting,
 * when the app may write to the card, then ejects it. Returns what the
 * tidying found in words for the message, or undefined.
 */
export async function ejectVolume(volume: Volume): Promise<string | undefined> {
  const writable = volume.access !== 'snapshot' && volume.info.writable !== false && !volume.info.readOnly;
  const tidy = writable ? await tidyMacJunk(volume.root).catch(() => undefined) : undefined;
  await plat().volumes.eject(volume);
  return macTidyText(tidy);
}

export function healthContext(state: Pick<CardState, 'catalog' | 'info'> & { volume?: Volume }): HealthContext {
  const c = state.catalog;
  const ranged = new Set<number>();
  for (const [key, f] of Object.entries(c?.folders ?? {})) {
    const params = f.card ? modeByCode(f.card.mode)?.params : undefined;
    if (params === 'track' || params === 'range') ranged.add(Number(key));
  }
  for (const x of c?.extraCards ?? []) if (x.folder > 0) ranged.add(x.folder);
  const snapshot = state.volume?.access === 'snapshot';
  return {
    profile: c?.profile ?? settings.value.profile,
    tngRelease: tngReleaseOf(c?.firmware) ?? settings.value.tngRelease,
    volume: state.info,
    formatChecked: !!c?.formatChecked,
    trustsDirectoryOrder: snapshot ? SNAPSHOT_LISTING_IS_FAT_ORDER : true,
    foldersWithRangeCards: ranged,
    keepRootJunk: snapshot,
    canUnlock: !!state.volume?.root.makeWritable,
    system: formatSystem(),
    pureNumbers: settings.value.pureNumbers,
  };
}

/** The system whose way to look at the card's format the hints name (health.ts checkFormat). */
function formatSystem(): FormatSystem | undefined {
  const p = platform.value;
  if (!p) return undefined;
  if (p.mobile || p.handheld) return 'phone';
  // A Chromebook counts as Linux for the platform (detectOs), but has no „Laufwerke“ to look in.
  if (typeof navigator !== 'undefined' && /CrOS/.test(navigator.userAgent)) return 'chromeos';
  return p.os;
}

/**
 * What the platform knows about the card. A card read as a snapshot keeps
 * its own info: its copy makes up the times of staged files (Date.now()),
 * and the health check must not judge the format by them (fileTimesFromCard).
 */
export async function volumeInfo(volume: Volume, fallback: VolumeInfo = volume.info): Promise<VolumeInfo> {
  if (volume.access === 'snapshot') return volume.info;
  return plat().volumes.info(volume).catch(() => fallback);
}

export async function openVolume(volume: Volume) {
  const seq = ++openSeq;
  revokeCovers(card.value);
  card.value = { volume, status: 'scanning', catalogOnCard: false, covers: new Map(), coverUrls: new Map(), info: volume.info };
  try {
    const info = await volumeInfo(volume);
    const scan = await scanSd(volume.root, {
      onProgress: (progress) => {
        if (seq === openSeq && card.value) card.value = { ...card.value, progress };
      },
    });
    let catalog = await loadCatalog(volume.root).catch(() => null);
    const catalogOnCard = !!catalog;
    // Downloader names in titles go without a word; the card gets the clean names with the next change.
    if (catalog) catalog = tidyCatalog(catalog);
    if (!catalog) catalog = (await restoreFromLibrary(scan)) ?? newCatalog('Meine TonUINO-Box', settings.value.profile);
    const covers = await loadCovers(volume.root).catch(() => new Map() as CoverMap);
    if (seq !== openSeq) return;
    const state: CardState = { volume, status: 'ready', scan, catalog, catalogOnCard, covers, coverUrls: coverUrls(covers), info };
    const unreadable = unreadableFiles(volume.root);
    if (unreadable.length) state.unreadable = unreadable;
    state.report = checkHealth(scan, healthContext(state));
    card.value = state;
  } catch (e) {
    if (seq !== openSeq) return;
    card.value = { volume, status: 'error', catalogOnCard: false, covers: new Map(), coverUrls: new Map(), info: volume.info, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The catalog with its folders' names tidied (tidyFolder); the same object when nothing changes. */
function tidyCatalog(c: Catalog): Catalog {
  let folders: Catalog['folders'] | undefined;
  for (const [key, f] of Object.entries(c.folders)) {
    const t = tidyFolder(f);
    if (t === f) continue;
    folders ??= { ...c.folders };
    folders[key] = t;
  }
  return folders ? { ...c, folders } : c;
}

/** Two readings of a card that found the same (only the time of reading differs). */
export function sameScan(a: SdScan, b: SdScan): boolean {
  return JSON.stringify({ ...a, scannedAt: 0 }) === JSON.stringify({ ...b, scannedAt: 0 });
}

/** Reads the card again after changes. Keeps the catalog in memory. */
export async function rescan(): Promise<SdScan | undefined> {
  const s = card.value;
  if (!s) return;
  const scan = await scanSd(s.volume.root);
  const info = await volumeInfo(s.volume, s.info);
  if (card.value?.volume.id !== s.volume.id) return;
  // Nothing changed on the card (the usual case when the window gets the focus again): the state stays
  // as it is, so the shelf, the open folder and the sidebar are not all drawn again for nothing.
  const prev = card.value;
  if (prev.status === 'ready' && prev.scan && sameScan(prev.scan, scan) && JSON.stringify(prev.info) === JSON.stringify(info)) return prev.scan;
  const next: CardState = { ...card.value, scan, info, status: 'ready' };
  next.report = checkHealth(scan, healthContext(next));
  card.value = next;
  return scan;
}

/* ------------------------------------------------------------------ catalog */

const LIBRARY_PREFIX = 'library:';

/** A catalog this computer has seen for a card whose own catalog is gone. */
async function restoreFromLibrary(scan: SdScan): Promise<Catalog | null> {
  if (scan.kind !== 'tonuino' || !scan.folders.length) return null;
  const copies: Catalog[] = [];
  for (const key of await kv.keys(LIBRARY_PREFIX)) {
    const text = await kv.get<string>(key);
    const c = text ? parseCatalog(text) : null;
    if (c) copies.push(c);
  }
  // Only when every folder matches exactly (see matchLibraryCatalog).
  const match = matchLibraryCatalog(scan, copies);
  // Under a new id: should the card be a copy of another box, that box's backup stays as it is.
  // The format seen on that card says nothing about this one.
  return match ? { ...match, id: newId(), formatChecked: undefined } : null;
}

/** Changes the catalog, writes it to the card and keeps a copy on this computer. */
export async function updateCatalog(mutate: (c: Catalog) => void, opts: { touchFolders?: number[] } = {}) {
  const key = keyOf(card.value);
  if (key) await inOrder(() => changeCatalog(key, mutate, opts));
  // The remembered box is never changed: say so instead of doing nothing.
  else if (shownMemory.value) throw new Error(NEEDS_CARD);
}

/**
 * Catalog and cover changes reach the card one after the other, each on top
 * of what the one before left. Two quick edits (typing a title, then a click
 * on "Hörbuch") both end up on the card instead of the second undoing the first.
 */
let queue: Promise<unknown> = Promise.resolve();

function inOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * The card a change was made for: the drive and the box catalog open on it.
 * The drive alone is not enough, since another card in the same reader comes
 * back under the same drive.
 */
interface CardKey {
  volumeId: string;
  catalogId: string;
}

function keyOf(s: CardState | null): CardKey | undefined {
  return s?.catalog ? { volumeId: s.volume.id, catalogId: s.catalog.id } : undefined;
}

function isCard(s: CardState | null, key: CardKey): s is CardState & { catalog: Catalog } {
  return !!s?.catalog && s.volume.id === key.volumeId && s.catalog.id === key.catalogId;
}

/** One catalog change, made to the catalog as it is now. Runs in `inOrder`. */
async function changeCatalog(key: CardKey, mutate: (c: Catalog) => void, opts: { touchFolders?: number[] } = {}) {
  const s = card.value;
  // Another card is open by now: the change was meant for the one before.
  if (!isCard(s, key)) return;
  const c: Catalog = structuredClone(s.catalog);
  mutate(c);
  // Files of an interrupted change still wait in a helper folder: noting such a folder now would drop their titles.
  const waiting = new Set(s.scan?.tempDirs.flatMap(helperFolders) ?? []);
  for (const n of opts.touchFolders ?? []) {
    const f = s.scan?.folders.find((x) => x.number === n);
    if (f && !waiting.has(n)) touchFolder(c, f);
  }
  await saveCatalog(s.volume.root, c);
  void kv.set(LIBRARY_PREFIX + c.id, serializeCatalog(c)).catch(() => undefined);
  if (!isCard(card.value, key)) return;
  const next: CardState = { ...card.value, catalog: c, catalogOnCard: true };
  next.report = next.scan ? checkHealth(next.scan, healthContext(next)) : next.report;
  card.value = next;
}

/** Firmware of the box, chosen by hand: kept with the card's catalog and as the default for new boxes. */
export async function setProfile(p: FirmwareProfile) {
  updateSettings({ profile: p });
  // The remembered box follows a choice by hand while it shows; it is never written.
  const r = shownMemory.peek();
  if (r && (r.catalog.profile !== p || r.catalog.profileFrom !== 'manual')) remembered.value = { ...r, catalog: { ...r.catalog, profile: p, profileFrom: 'manual' } };
  const c = card.value?.catalog;
  if (c && (c.profile !== p || c.profileFrom !== 'manual')) {
    await updateCatalog((cat) => {
      cat.profile = p;
      cat.profileFrom = 'manual';
    });
  }
}

/**
 * A box named its firmware at its start (over USB). Kept for this session,
 * and in the open card's catalog unless a choice by hand is there; a card
 * read as a snapshot (Firefox, Safari) is not written for this.
 */
export async function noteBoxFirmware(info: { firmware?: FirmwareProfile; version?: string; versionDate?: string; board?: string }): Promise<void> {
  const p = profileFromBox(info);
  if (!p) return;
  boxProfile.value = p;
  const s = card.value;
  const c = s?.catalog;
  if (!c || s.status !== 'ready' || s.volume.access === 'snapshot') return;
  const next = afterBoxReport({ profile: c.profile, from: c.profileFrom }, p);
  const fw = { board: info.board, version: info.version, date: info.versionDate };
  const fwChanged = c.firmware?.board !== fw.board || c.firmware?.version !== fw.version || c.firmware?.date !== fw.date;
  if (!next && !fwChanged) return;
  await updateCatalog((cat) => {
    if (next) {
      cat.profile = next.profile;
      cat.profileFrom = next.from;
    }
    if (fwChanged) cat.firmware = { ...fw, updatedAt: Date.now() };
  });
}

/**
 * Keeps titles with their files after a repair ran; `done` are the steps that
 * went through. `prepare` can record more as it was before the files moved.
 * Runs in turn with the other catalog changes, so a title saved meanwhile
 * is neither lost nor replayed onto the wrong file.
 */
export async function catalogAfterRepair(plan: RepairPlan, done: PlanStep[], prepare?: (c: Catalog) => void): Promise<void> {
  const key = keyOf(card.value);
  if (!key) return;
  await inOrder(async () => {
    const s = card.value;
    if (!isCard(s, key)) return;
    const c = structuredClone(s.catalog);
    prepare?.(c);
    applyPlanToCatalog(c, plan, done);
    card.value = { ...s, catalog: c };
  });
}

/**
 * Writes the catalog as it is once the files of a plan have their new
 * names, before the plan gets to the point after which an interrupted run
 * comes back with them (RepairPlan.commitAt). Then the titles fit the
 * tracks whenever the run stops: closed app, pulled card, power cut.
 * Throws when the catalog cannot be written; the plan stops then.
 */
async function commitRepairCatalog(plan: RepairPlan, done: PlanStep[], prepare?: (c: Catalog) => void): Promise<void> {
  const key = keyOf(card.value);
  if (!key || plan.commitAt === undefined) return;
  await inOrder(async () => {
    const s = card.value;
    if (!isCard(s, key)) throw new Error('Inzwischen ist eine andere Karte geöffnet. Deshalb hab ich hier aufgehört.');
    const c = structuredClone(s.catalog);
    prepare?.(c);
    const step = plan.steps[plan.commitAt!];
    applyPlanToCatalog(c, plan, [...done, step]);
    // The folder whose tracks get new numbers: the helper folder the step marks belongs to it.
    const n = step.op === 'mkdir' && !plan.swap ? parseTempDir(step.path[0]) : undefined;
    const entry = n ? c.folders[folderName(n)] : undefined;
    if (entry) entry.renumbered = true;
    try {
      await saveCatalog(s.volume.root, c);
    } catch (e) {
      // The cause in its own sentence, without the file name the web platform puts in front ("tonuino-studio.json schreiben: …").
      const cause = (e instanceof Error ? e.message : String(e)).replace(/^[^:]*tonuino-studio\.json[^:]*:\s*/i, '').trim();
      const what = plan.swap ? 'Die neuen Nummern ließen' : 'Die neue Reihenfolge ließ';
      throw new Error(`${what} sich nicht auf der Karte speichern. Deshalb hab ich aufgehört.${cause ? ` ${/[.!?]$/.test(cause) ? cause : `${cause}.`}` : ''}`);
    }
    void kv.set(LIBRARY_PREFIX + c.id, serializeCatalog(c)).catch(() => undefined);
    const now = card.value;
    if (isCard(now, key)) card.value = { ...now, catalog: c, catalogOnCard: true };
  });
}

/** What runRepair did: the result, the steps that went through and the card as read afterwards. */
export interface RepairRun {
  result: ExecuteResult;
  done: PlanStep[];
  /** Undefined when the card could not be read again. */
  scan?: SdScan;
}

/**
 * Runs a repair plan on the open card and keeps the catalog with the files
 * (see catalogAfterRepair and commitRepairCatalog), then reads the card
 * again and notes the touched folders. Closing the app asks first until
 * the catalog is written too.
 */
export async function runRepair(
  plan: RepairPlan,
  opts: {
    kind: Extract<WriteKind, 'repair' | 'order'>;
    /** Records more in the catalog as it was before the files moved; gets the steps that went through. */
    prepare?: (c: Catalog, done: PlanStep[]) => void;
    /** Folders to note afterwards; by default those the steps touched. */
    folders?: (done: PlanStep[]) => number[];
    onProgress?: (p: ExecuteProgress) => void;
  },
): Promise<RepairRun> {
  const s = card.value;
  if (!s) throw new Error('Es ist keine Karte geöffnet.');
  return writeGuard.during(opts.kind, async () => {
    let committed = false;
    const result = await executePlan(s.volume.root, plan, {
      onProgress: opts.onProgress,
      beforeCommit: async (sofar) => {
        await commitRepairCatalog(plan, sofar, opts.prepare && ((c) => opts.prepare!(c, sofar)));
        committed = true;
      },
    });
    const done = doneSteps(plan, result);
    // After the commit the catalog has the new names already: only the steps after it still count.
    if (committed) await catalogAfterRepair(plan, done.slice(plan.commitAt));
    else await catalogAfterRepair(plan, done, opts.prepare && ((c) => opts.prepare!(c, done)));
    const scan = await rescan().catch(() => undefined);
    await saveAfterRepair(opts.folders?.(done) ?? touchedFolders(done), scan).catch(() => undefined);
    return { result, done, scan };
  });
}

/**
 * Writes the catalog after a repair and notes how the touched folders look
 * now. `scan` is what rescan() returned after the repair: without a fresh
 * look at the card no folder is noted, because the scan from before the
 * repair would drop the titles of renamed tracks. A folder whose files still
 * wait in a helper folder is left alone too (see updateCatalog), so its
 * titles are still there when the files come back.
 */
export async function saveAfterRepair(folders: number[], scan: SdScan | undefined): Promise<void> {
  // With no helper folder of a swap left on the card, its note in the catalog has done its job (Catalog.swap).
  const swapDone = !!scan && !scan.tempDirs.some((t) => t.swap);
  await updateCatalog(
    (c) => {
      if (swapDone) delete c.swap;
    },
    { touchFolders: scan ? folders : [] },
  );
}

/** Stores a cover for a folder on the card (zip) and in the catalog. */
/** Whether the folder's cover is now noted on the card (false: another card was opened meanwhile, or the folder has no entry). */
export async function setCover(folder: number, data: Uint8Array | null, mimeType = 'image/jpeg', source?: string, orientation?: StickerTweaks['orientation']): Promise<boolean> {
  return (await setCovers([{ folder, data, mimeType, source, orientation }])).includes(folder);
}

/** One cover for setCovers; `data` null removes the folder's cover. */
export interface CoverChange {
  folder: number;
  data: Uint8Array | null;
  mimeType?: string;
  /** For the credit line: "iTunes", "MusicBrainz" or "Datei". */
  source?: string;
  /** The sticker turned this way for the new picture, e.g. upright for a cassette cover. */
  orientation?: StickerTweaks['orientation'];
}

/**
 * Stores covers for one or more folders: one write of the cover zip, then
 * one catalog update. A new picture also drops the sticker colour and
 * picture section chosen for the old one, since they do not fit it.
 * `onlyMissing` leaves out folders that have a cover by now or no catalog
 * entry, so a cover set elsewhere in the meantime is never replaced.
 * Returns the folders whose cover is noted in the catalog now: a folder
 * without a catalog entry gets none (its picture would sit unused in the
 * cover zip), and neither does any when another card was opened meanwhile.
 */
export async function setCovers(changes: readonly CoverChange[], opts: { onlyMissing?: boolean } = {}): Promise<number[]> {
  const key = keyOf(card.value);
  if (!key || !changes.length) return [];
  return inOrder(async () => {
    // Taken only now, so changes saved while this waited stay.
    const s = card.value;
    if (!isCard(s, key)) return [];
    const todo = opts.onlyMissing
      ? changes.filter((ch) => {
          const f = s.catalog.folders[folderName(ch.folder)];
          return !!f && !(f.cover && s.covers.has(f.cover));
        })
      : changes;
    if (!todo.length) return [];
    const covers: CoverMap = new Map(s.covers);
    const entries = new Map<number, string | undefined>();
    for (const ch of todo) {
      const prefix = `${folderName(ch.folder)}.`;
      for (const name of [...covers.keys()]) if (name.startsWith(prefix)) covers.delete(name);
      const entry = ch.data ? coverEntryName(ch.folder, ch.mimeType ?? 'image/jpeg') : undefined;
      if (entry && ch.data) covers.set(entry, ch.data);
      entries.set(ch.folder, entry);
    }
    const noted = new Set<number>();
    await writeGuard.during('covers', async () => {
      await saveCovers(s.volume.root, covers);
      const now = card.value;
      if (!isCard(now, key)) return;
      revokeCovers(now);
      card.value = { ...now, covers, coverUrls: coverUrls(covers) };
      await changeCatalog(key, (c) => {
        const at = Date.now();
        noted.clear();
        for (const ch of todo) {
          const f = c.folders[folderName(ch.folder)];
          if (!f) continue;
          noted.add(ch.folder);
          // A new picture or none at all: what was set for the old one does not fit.
          if (ch.data || f.cover) dropPictureTweaks(f);
          if (ch.data && ch.orientation) f.sticker = { ...f.sticker, orientation: ch.orientation };
          f.cover = entries.get(ch.folder);
          f.coverSource = ch.data ? ch.source : undefined;
          f.updatedAt = at;
        }
      });
    });
    // changeCatalog gives up when another card is open by now: then nothing was noted.
    return todo.filter((ch) => noted.has(ch.folder)).map((ch) => ch.folder);
  });
}

/**
 * Carries a folder's cover over to its new number (audit 0.4 #6): in the
 * cover zip and in the catalog, so a later folder under the old number
 * neither shows the picture nor removes it with its own. Does nothing when
 * the folder has no cover stored under the old number.
 */
export async function renumberCover(from: number, to: number): Promise<void> {
  const key = keyOf(card.value);
  if (!key) return;
  await inOrder(async () => {
    const s = card.value;
    if (!isCard(s, key)) return;
    const { covers, entry } = renumberCovers(s.covers, from, to);
    if (!entry) return;
    await writeGuard.during('covers', async () => {
      await saveCovers(s.volume.root, covers);
      const now = card.value;
      if (!isCard(now, key)) return;
      revokeCovers(now);
      card.value = { ...now, covers, coverUrls: coverUrls(covers) };
      await changeCatalog(key, (c) => {
        const f = c.folders[folderName(to)];
        if (f) f.cover = entry;
      });
    });
  });
}

/**
 * Changes the cover zip as a whole, in one write, without touching the
 * catalog ("Reihe in einen Ordner packen", pack.ts: the episodes' covers
 * under names of their own first, the old folders' ones go at the end).
 * False when the card changed meanwhile and nothing was written.
 */
export async function changeCovers(change: (covers: CoverMap) => void): Promise<boolean> {
  const key = keyOf(card.value);
  if (!key) return false;
  return inOrder(async () => {
    const s = card.value;
    if (!isCard(s, key)) return false;
    const covers: CoverMap = new Map(s.covers);
    change(covers);
    if (covers.size === s.covers.size && [...covers].every(([name, data]) => s.covers.get(name) === data)) return true;
    let written = false;
    await writeGuard.during('covers', async () => {
      await saveCovers(s.volume.root, covers);
      const now = card.value;
      if (!isCard(now, key)) return;
      revokeCovers(now);
      card.value = { ...now, covers, coverUrls: coverUrls(covers) };
      written = true;
    });
    return written;
  });
}

/**
 * Swaps the covers of two folders that swapped their numbers
 * (planSwapFolders), in the cover zip and in the catalog, like
 * renumberCover. Run after the catalog has the folders swapped.
 */
export async function swapCover(a: number, b: number): Promise<void> {
  const key = keyOf(card.value);
  if (!key) return;
  await inOrder(async () => {
    const s = card.value;
    if (!isCard(s, key)) return;
    const { covers, renamed } = swapCovers(s.covers, a, b);
    if (!renamed.size) return;
    await writeGuard.during('covers', async () => {
      await saveCovers(s.volume.root, covers);
      const now = card.value;
      if (!isCard(now, key)) return;
      revokeCovers(now);
      card.value = { ...now, covers, coverUrls: coverUrls(covers) };
      await changeCatalog(key, (c) => {
        for (const n of [a, b]) {
          const f = c.folders[folderName(n)];
          const entry = f?.cover ? renamed.get(f.cover) : undefined;
          if (f && entry) f.cover = entry;
        }
      });
    });
  });
}

export function coverUrlFor(folder: number): string | undefined {
  const s = card.value ?? shownMemory.value;
  const entry = s?.catalog?.folders[String(folder).padStart(2, '0')]?.cover;
  return entry ? s?.coverUrls.get(entry) : undefined;
}

/** The picture of a further card with a cover of its own (ExtraCard.cover), else the one of its folder. */
export function coverUrlForCard(x: { folder: number; cover?: string }): string | undefined {
  const s = card.value ?? shownMemory.value;
  return (x.cover ? s?.coverUrls.get(x.cover) : undefined) ?? coverUrlFor(x.folder);
}

/* ------------------------------------------------------------------ theme */

if (typeof window !== 'undefined') {
  // index.html sets it before the first paint already; this is for a page without that script.
  document.documentElement.dataset.stil = STIL;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const t = settings.value.theme;
    document.documentElement.dataset.theme = t === 'auto' ? (media.matches ? 'dark' : 'light') : t;
  };
  media.addEventListener('change', apply);
  effect(apply);

  // The desktop window's frame and title bar follow too; "auto" leaves them to the system.
  const theme = computed(() => settings.value.theme);
  effect(() => {
    const t = theme.value;
    platform.value?.setWindowTheme?.(t === 'auto' ? null : t).catch(() => {
      // Only the frame keeps the system's colours then; nothing the user could do about it.
    });
  });
}
