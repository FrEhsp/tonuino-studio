/**
 * SD cards in the Android app: the user picks the card (or any folder) once
 * in Android's folder chooser; Android keeps that grant, also after a
 * restart, and the app lists the granted folders as cards. A card in a USB
 * reader comes back by itself when the same card is plugged in again (its
 * folder id is the card's serial number). Another card needs one pick.
 *
 * Whether a card is there is asked every few seconds while the app shows
 * something that listens, and at once when Android reports a plugged or
 * pulled USB device or a mounted or removed drive (event "storage").
 */
import type { Volume, VolumeInfo, VolumeWatcher } from '../types';
import type { AndroidCalls } from './androidBridge';
import { FLAG_DIR_SUPPORTS_CREATE, isRemovableStorage, newSafCard, SafDir, type SafFs, type SafTree } from './androidSaf';

/** How often the granted folders are looked for. */
export const POLL_MS = 3000;
/** Cards kept granted; the oldest beyond this are given back to Android (it allows 128 or 512 in all). */
export const MAX_REMEMBERED = 8;

const ORDER_KEY = 'tonuino-studio:android-cards';

/** The times Android reports are the card's own (DocumentsContract: File.lastModified on the card). */
const CARD_INFO: VolumeInfo = { fileTimesFromCard: true };

interface Order {
  /** Tree URI → last use, ms since 1970. */
  [uri: string]: number;
}

function loadOrder(storage: Storage | undefined): Order {
  try {
    const raw = storage?.getItem(ORDER_KEY);
    const o = raw ? (JSON.parse(raw) as unknown) : null;
    return o && typeof o === 'object' ? (o as Order) : {};
  } catch {
    return {};
  }
}

function saveOrder(storage: Storage | undefined, order: Order): void {
  try {
    storage?.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // Not remembered: the cards are still there, only their order is not.
  }
}

export const volumeIdOf = (tree: SafTree): string => `saf:${tree.uri}`;

export class AndroidVolumes implements VolumeWatcher {
  private readonly reachable = new Map<string, Volume>();
  private readonly subs = new Set<(v: Volume[]) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing: Promise<void> | null = null;
  private readonly ready: Promise<void>;
  private readonly order: Order;

  constructor(
    private readonly fs: SafFs,
    calls: AndroidCalls,
    private readonly storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
  ) {
    this.order = loadOrder(storage);
    calls.on('storage', () => void this.refresh());
    this.ready = this.refresh();
  }

  settled(): Promise<void> {
    return this.ready;
  }

  subscribe(cb: (volumes: Volume[]) => void): () => void {
    this.subs.add(cb);
    cb(this.list());
    if (!this.timer) this.timer = setInterval(() => void this.refresh(), POLL_MS);
    return () => {
      this.subs.delete(cb);
      if (!this.subs.size && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  /** Most recently used first, like the browser version. */
  private list(): Volume[] {
    return [...this.reachable.values()].sort((a, b) => (this.order[uriOf(b)] ?? 0) - (this.order[uriOf(a)] ?? 0));
  }

  private emit(): void {
    const list = this.list();
    for (const cb of [...this.subs]) cb(list);
  }

  refresh(): Promise<void> {
    if (!this.refreshing) this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const trees = this.fs.trees();
    let changed = false;
    const granted = new Set(trees.map(volumeIdOf));
    for (const id of [...this.reachable.keys()]) {
      if (!granted.has(id)) {
        this.reachable.delete(id);
        changed = true;
      }
    }
    for (const tree of trees) {
      const id = volumeIdOf(tree);
      let info: VolumeInfo | null = null;
      try {
        // Fails while the card is not plugged in.
        const root = await this.fs.stat(tree.uri, tree.doc);
        info = rootInfo(tree, root.flags);
      } catch {
        info = null;
      }
      const known = this.reachable.get(id);
      if (info && !known) {
        this.reachable.set(id, this.toVolume(tree, info));
        changed = true;
      } else if (!info && known) {
        this.reachable.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private toVolume(tree: SafTree, info: VolumeInfo): Volume {
    const card = newSafCard(this.fs, tree.uri);
    return { id: volumeIdOf(tree), label: tree.name, root: new SafDir(card, tree.doc, tree.name), info, canEject: false };
  }

  async pick(): Promise<Volume | null> {
    const tree = await this.fs.pickTree(true);
    if (!tree) return null;
    this.order[tree.uri] = Date.now();
    this.forgetOldest();
    saveOrder(this.storage, this.order);
    let info: VolumeInfo = { ...CARD_INFO };
    try {
      info = rootInfo(tree, (await this.fs.stat(tree.uri, tree.doc)).flags);
    } catch {
      // Asked again on the next look; the card was just chosen, so it is there.
    }
    const volume = this.toVolume(tree, info);
    this.reachable.set(volume.id, volume);
    this.emit();
    return volume;
  }

  /** Gives the oldest grants back to Android, beyond MAX_REMEMBERED. */
  private forgetOldest(): void {
    const trees = this.fs.trees();
    const sorted = [...trees].sort((a, b) => (this.order[b.uri] ?? 0) - (this.order[a.uri] ?? 0));
    for (const old of sorted.slice(MAX_REMEMBERED)) {
      this.fs.release(old.uri);
      delete this.order[old.uri];
      this.reachable.delete(volumeIdOf(old));
    }
  }

  async eject(): Promise<void> {
    throw new Error('Das Handy wirft die Karte nicht selbst aus. Warte, bis nichts mehr geschrieben wird, und wirf sie in den Einstellungen des Handys unter „Speicher“ aus. Dann kannst du den SD-Kartenleser abziehen.');
  }

  async info(volume: Volume): Promise<VolumeInfo> {
    const tree = this.fs.trees().find((t) => volumeIdOf(t) === volume.id);
    if (!tree) return { ...volume.info };
    const info: VolumeInfo = { ...volume.info };
    try {
      info.removable = isRemovableStorage(tree) ?? info.removable;
      const space = await this.fs.space(tree.uri);
      if (space.free !== undefined) info.freeBytes = space.free;
      if (space.total !== undefined) info.totalBytes = space.total;
    } catch {
      // Android does not tell for every place; the app works without the numbers.
    }
    return info;
  }

  async forget(volume: Volume): Promise<void> {
    const tree = this.fs.trees().find((t) => volumeIdOf(t) === volume.id);
    if (tree) {
      this.fs.release(tree.uri);
      delete this.order[tree.uri];
      saveOrder(this.storage, this.order);
    }
    this.reachable.delete(volume.id);
    this.emit();
  }
}

function uriOf(v: Volume): string {
  return v.id.slice('saf:'.length);
}

/** What the granted folder's own entry tells: a card in a reader, and whether new files may go there. */
export function rootInfo(tree: SafTree, flags: number | undefined): VolumeInfo {
  const info: VolumeInfo = { ...CARD_INFO };
  const removable = isRemovableStorage(tree);
  if (removable !== undefined) info.removable = removable;
  if (flags !== undefined) {
    const writable = (flags & FLAG_DIR_SUPPORTS_CREATE) !== 0;
    info.writable = writable;
    // Android mounts a card with its lock slider on read-only; the folder then takes no new files.
    if (!writable) info.readOnly = true;
  }
  return info;
}
