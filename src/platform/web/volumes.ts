import type { Volume, VolumeInfo, VolumeWatcher } from '../types';
import { FsaDir } from './fsa';
import { kv } from './idb';

/**
 * SD cards in the browser: the user picks the card once, the app remembers
 * the folder handle and notices when the card comes back, by probing it
 * every few seconds. Chrome asks again for permission after a restart unless
 * the user chose "Bei jedem Besuch erlauben".
 */

interface Remembered {
  id: string;
  handle: FileSystemDirectoryHandle;
  label: string;
  lastUsed: number;
}

const PREFIX = 'volume:';
const MAX_REMEMBERED = 5;
const POLL_MS = 2000;
/** The browser does not tell the format, but File.lastModified is the time the card stores. */
const CARD_INFO: VolumeInfo = { fileTimesFromCard: true };

export class WebVolumes implements VolumeWatcher {
  private remembered: Remembered[] = [];
  private reachable = new Map<string, Volume>();
  private subs = new Set<(v: Volume[]) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ready: Promise<void>;
  needsPermission = false;

  constructor() {
    this.ready = this.load();
  }

  private async load() {
    const keys = await kv.keys(PREFIX);
    const items = await Promise.all(keys.map((k) => kv.get<Remembered>(k)));
    this.remembered = items.filter((x): x is Remembered => !!x?.handle).sort((a, b) => b.lastUsed - a.lastUsed);
    await this.refresh();
  }

  settled(): Promise<void> {
    return this.ready;
  }

  subscribe(cb: (volumes: Volume[]) => void): () => void {
    this.subs.add(cb);
    cb([...this.reachable.values()]);
    if (!this.timer) this.timer = setInterval(() => void this.refresh(), POLL_MS);
    return () => {
      this.subs.delete(cb);
      if (!this.subs.size && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  private emit() {
    const list = [...this.reachable.values()];
    for (const cb of this.subs) cb(list);
  }

  private toVolume(r: Remembered): Volume {
    return { id: r.id, label: r.label, root: new FsaDir(r.handle), info: { ...CARD_INFO }, canEject: false };
  }

  private refreshing: Promise<void> | null = null;

  refresh(): Promise<void> {
    // Firefox and Safari keep no folder handles: there is nothing to look for.
    if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) return Promise.resolve();
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    let changed = false;
    let needsPermission = false;
    for (const r of this.remembered) {
      let ok = false;
      try {
        const state = await r.handle.queryPermission({ mode: 'readwrite' });
        if (state === 'granted') {
          // Throws NotFoundError while the card is not inserted.
          const it = r.handle.keys();
          await it.next();
          ok = true;
        } else if (state === 'prompt') {
          needsPermission = true;
        }
      } catch {
        ok = false;
      }
      if (ok && !this.reachable.has(r.id)) {
        this.reachable.set(r.id, this.toVolume(r));
        changed = true;
      } else if (!ok && this.reachable.has(r.id)) {
        this.reachable.delete(r.id);
        changed = true;
      }
    }
    if (needsPermission !== this.needsPermission) {
      this.needsPermission = needsPermission;
      changed = true;
    }
    if (changed) this.emit();
  }

  async requestPermission(): Promise<boolean> {
    await this.ready;
    let any = false;
    for (const r of this.remembered) {
      try {
        if ((await r.handle.queryPermission({ mode: 'readwrite' })) === 'prompt') {
          if ((await r.handle.requestPermission({ mode: 'readwrite' })) === 'granted') any = true;
        }
      } catch {
        // The card is not inserted; asking again later.
      }
    }
    await this.refresh();
    return any;
  }

  async pick(): Promise<Volume | null> {
    if (!('showDirectoryPicker' in window)) return null;
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await window.showDirectoryPicker({ id: 'tonuino-sd', mode: 'readwrite' });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      throw e;
    }
    await this.ready;
    let entry: Remembered | undefined;
    for (const r of this.remembered) {
      if (await r.handle.isSameEntry(handle).catch(() => false)) entry = r;
    }
    if (!entry) {
      entry = { id: `web-${Date.now().toString(36)}`, handle, label: handle.name || 'SD-Karte', lastUsed: Date.now() };
      this.remembered.unshift(entry);
    }
    entry.lastUsed = Date.now();
    entry.handle = handle;
    await kv.set(PREFIX + entry.id, entry);
    // Forget the oldest cards.
    this.remembered.sort((a, b) => b.lastUsed - a.lastUsed);
    for (const old of this.remembered.splice(MAX_REMEMBERED)) {
      await kv.delete(PREFIX + old.id);
      this.reachable.delete(old.id);
    }
    const volume = this.toVolume(entry);
    this.reachable.set(entry.id, volume);
    this.emit();
    return volume;
  }

  async eject(): Promise<void> {
    throw new Error('Im Browser kann ich die Karte nicht auswerfen. Nutze dafür das Auswerfen-Symbol deines Computers.');
  }

  async info(): Promise<VolumeInfo> {
    return { ...CARD_INFO };
  }

  async forget(volume: Volume): Promise<void> {
    this.remembered = this.remembered.filter((r) => r.id !== volume.id);
    this.reachable.delete(volume.id);
    await kv.delete(PREFIX + volume.id);
    this.emit();
  }
}
