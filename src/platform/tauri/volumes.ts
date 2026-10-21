/**
 * VolumeWatcher on top of the volume commands. The backend polls every
 * 1.5 s and emits `volumes-changed` with the full list whenever the set of
 * cards changes; folders the user picked are added to that list for the
 * rest of the session, so the app keeps them open.
 */
import type { Volume, VolumeInfo, VolumeWatcher } from '../types';
import type { Bridge } from './bridge';
import { platformError } from './errors';
import { TauriDir } from './fs';

export const EVENT_VOLUMES_CHANGED = 'volumes-changed';

export interface VolumeDto {
  id: string;
  label: string;
  mountPath: string;
  fsType: string | null;
  clusterSize: number | null;
  totalBytes: number | null;
  freeBytes: number | null;
  removable: boolean;
  device: string | null;
  canEject: boolean;
  /** Write access (see VolumeInfo); older backends leave them out. */
  writable?: boolean;
  readOnly?: boolean;
  foreignOwner?: boolean;
  canFixAccess?: boolean;
}

export interface VolumeInfoDto {
  fsType: string | null;
  clusterSize: number | null;
  totalBytes: number | null;
  freeBytes: number | null;
  removable: boolean;
  device: string | null;
  /** Mount point of the filesystem the folder lives on. */
  mountPath: string | null;
  canEject: boolean;
  writable?: boolean;
  readOnly?: boolean;
  foreignOwner?: boolean;
  canFixAccess?: boolean;
}

interface PickedFolderDto {
  path: string;
  name: string;
}

/** Drops nulls so optional fields stay absent, as the web build has them. */
export function toInfo(dto: Omit<VolumeInfoDto, 'mountPath' | 'canEject'>): VolumeInfo {
  const info: VolumeInfo = { removable: dto.removable };
  if (dto.fsType != null) info.fsType = dto.fsType;
  if (dto.clusterSize != null) info.clusterSize = dto.clusterSize;
  if (dto.totalBytes != null) info.totalBytes = dto.totalBytes;
  if (dto.freeBytes != null) info.freeBytes = dto.freeBytes;
  if (dto.device != null) info.device = dto.device;
  if (dto.writable != null) info.writable = dto.writable;
  if (dto.readOnly) info.readOnly = true;
  if (dto.foreignOwner) info.foreignOwner = true;
  if (dto.canFixAccess) info.canFixAccess = true;
  return info;
}

/** Path comparison key: no trailing separator; Windows and macOS ignore case. */
function normPath(p: string, os: Bridge['os']): string {
  let s = p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
  if (os === 'windows') s = s.replace(/\//g, '\\');
  if (/^[A-Za-z]:$/.test(s)) s += '\\';
  return os === 'windows' || os === 'macos' ? s.toLowerCase() : s;
}

export function samePath(a: string, b: string, os: Bridge['os']): boolean {
  return normPath(a, os) === normPath(b, os);
}

/** Whether `inner` is `outer` or a path below it ("/media/SD/x" is within "/media/SD", "/media/SD2" is not). */
export function pathWithin(inner: string, outer: string, os: Bridge['os']): boolean {
  const i = normPath(inner, os);
  const o = normPath(outer, os);
  if (i === o) return true;
  const sep = os === 'windows' ? '\\' : '/';
  return i.startsWith(o.endsWith(sep) ? o : o + sep);
}

interface PickedVolume {
  volume: Volume;
  /** Mount point of the filesystem the folder lives on, when known. */
  mountPath?: string;
}

export class TauriVolumes implements VolumeWatcher {
  private readonly listeners = new Set<(volumes: Volume[]) => void>();
  private detected: Volume[] = [];
  private picked: PickedVolume[] = [];
  private current: Volume[] | null = null;
  private stopListening: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private generation = 0;

  constructor(private readonly bridge: Bridge) {}

  subscribe(cb: (volumes: Volume[]) => void): () => void {
    this.listeners.add(cb);
    if (this.current) cb(this.current);
    if (!this.starting) this.starting = this.start();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stop();
    };
  }

  settled(): Promise<void> {
    return this.starting ?? Promise.resolve();
  }

  private async start(): Promise<void> {
    const generation = ++this.generation;
    let sawEvent = false;
    try {
      const unlisten = await this.bridge.ipc.listen<VolumeDto[]>(EVENT_VOLUMES_CHANGED, (list) => {
        if (generation !== this.generation) return;
        sawEvent = true;
        this.apply(list);
      });
      if (generation !== this.generation) {
        unlisten();
        return;
      }
      this.stopListening = unlisten;
    } catch {
      // Without events the list still arrives below; "Erneut suchen" refreshes it.
    }
    try {
      const list = await this.bridge.call<VolumeDto[]>('volume', 'volumes_list');
      // Every change after the listener was registered arrives as an event,
      // so an event is never older than this answer.
      if (generation === this.generation && !sawEvent) this.apply(list);
    } catch {
      if (generation === this.generation && !this.current) this.emit();
    }
  }

  private stop(): void {
    this.generation += 1;
    this.stopListening?.();
    this.stopListening = null;
    this.starting = null;
    this.current = null;
  }

  private toVolume(dto: VolumeDto): Volume {
    const known = this.detected.find((v) => v.id === dto.id);
    const info = toInfo(dto);
    if (known && known.label === dto.label) {
      known.info = info;
      known.canEject = dto.canEject;
      return known;
    }
    return {
      id: dto.id,
      label: dto.label,
      root: new TauriDir(this.bridge, dto.mountPath, dto.label),
      info,
      canEject: dto.canEject,
    };
  }

  /** Takes a new list from the backend and tells all subscribers. */
  private apply(list: VolumeDto[]): void {
    const before = this.detected;
    this.detected = list.map((dto) => this.toVolume(dto));
    // A picked folder on a card that just disappeared goes with it.
    const gone = before.filter((v) => !this.detected.some((d) => d.id === v.id));
    if (gone.length) {
      this.picked = this.picked.filter(
        (p) => !p.mountPath || !gone.some((g) => g.root.path && samePath(g.root.path, p.mountPath!, this.bridge.os)),
      );
    }
    this.emit();
  }

  private emit(): void {
    const extra = this.picked.map((p) => p.volume).filter((v) => !this.detected.some((d) => samePath(d.id, v.id, this.bridge.os)));
    this.current = [...this.detected, ...extra];
    const snapshot = this.current;
    for (const cb of [...this.listeners]) {
      try {
        cb(snapshot);
      } catch (e) {
        console.error('volume subscriber failed', e);
      }
    }
  }

  async pick(): Promise<Volume | null> {
    const folder = await this.bridge.call<PickedFolderDto | null>('dialog', 'dialog_pick_folder', {
      purpose: 'card',
      title: 'SD-Karte oder Ordner auswählen',
    });
    if (!folder) return null;
    const dto = await this.bridge.call<VolumeInfoDto>('volume', 'volume_info', { path: folder.path });
    // The root of a detected card: use that volume (it can be ejected).
    const detected = this.detected.find((v) => v.root.path && samePath(v.root.path, folder.path, this.bridge.os));
    if (detected) {
      detected.info = toInfo(dto);
      return detected;
    }
    const existing = this.picked.find((p) => samePath(p.volume.id, folder.path, this.bridge.os));
    if (existing) {
      existing.volume.info = toInfo(dto);
      return existing.volume;
    }
    const volume: Volume = {
      id: folder.path,
      label: folder.name,
      root: new TauriDir(this.bridge, folder.path, folder.name),
      info: toInfo(dto),
      canEject: false,
    };
    this.picked.push({ volume, mountPath: dto.mountPath ?? undefined });
    if (this.listeners.size) this.emit();
    return volume;
  }

  async refresh(): Promise<void> {
    const list = await this.bridge.call<VolumeDto[]>('volume', 'volumes_refresh');
    // While listening, the backend's forced `volumes-changed` event delivers
    // this list; applying it here as well would notify everyone twice.
    if (!this.stopListening) this.apply(list);
  }

  async eject(volume: Volume): Promise<void> {
    if (!volume.canEject || !volume.root.path) {
      throw platformError('unsupported', 'volume', `${volume.id} cannot be ejected`);
    }
    const mountPath = volume.root.path;
    await this.bridge.call('volume', 'volume_eject', { mountPath });
    this.picked = this.picked.filter((p) => !p.mountPath || !samePath(p.mountPath, mountPath, this.bridge.os));
  }

  /**
   * "Schreibrechte holen" (Linux): the backend mounts the card again for this
   * user. The card often comes back under a new path: the answer is the card
   * as listed now.
   */
  async fixAccess(volume: Volume): Promise<Volume> {
    if (!volume.root.path) throw platformError('unsupported', 'remount', `${volume.id} has no path`);
    const dto = await this.bridge.call<VolumeDto>('remount', 'volume_fix_access', { mountPath: volume.root.path });
    // The list as it is now, without waiting for the event (which may come later).
    const list = await this.bridge.call<VolumeDto[]>('volume', 'volumes_list').catch(() => null);
    if (list) this.apply(list);
    return this.detected.find((v) => v.id === dto.id) ?? this.toVolume(dto);
  }

  /** The listed card or picked folder a path lies on: the deepest one. */
  volumeAt(path: string): Volume | undefined {
    let best: Volume | undefined;
    for (const v of [...this.detected, ...this.picked.map((p) => p.volume)]) {
      const root = v.root.path;
      if (root && pathWithin(path, root, this.bridge.os) && (!best || root.length > (best.root.path?.length ?? 0))) best = v;
    }
    return best;
  }

  onWriteDenied(cb: (volumeId: string) => void): () => void {
    return this.bridge.onWriteDenied((path) => {
      const v = this.volumeAt(path);
      if (v) cb(v.id);
    });
  }

  /** Removes a picked folder from the list (detected cards stay until they are removed). */
  async forget(volume: Volume): Promise<void> {
    const before = this.picked.length;
    this.picked = this.picked.filter((p) => p.volume !== volume && !samePath(p.volume.id, volume.id, this.bridge.os));
    if (this.picked.length !== before && this.listeners.size) this.emit();
  }

  async info(volume: Volume): Promise<VolumeInfo> {
    const path = volume.root.path ?? volume.id;
    const info = toInfo(await this.bridge.call<VolumeInfoDto>('volume', 'volume_info', { path }));
    volume.info = info;
    return info;
  }
}
