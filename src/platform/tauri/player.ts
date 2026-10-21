/**
 * PlayerAccess on top of the computer's own player (src-tauri/src/player):
 * symphonia decodes, cpal plays. Commands player_*, event "player".
 *
 * A file on disk is opened by the backend itself (only its path crosses
 * over); data that exists only in memory goes over as a raw body.
 */
import type { PlayerAccess, PlayerEvent, PlayerLoaded, PlayerLoadOptions, PlayerSource } from '../types';
import type { Bridge } from './bridge';

export const EVENT_PLAYER = 'player';

export class TauriPlayer implements PlayerAccess {
  private readonly listeners = new Set<(e: PlayerEvent) => void>();
  private listening: Promise<() => void> | null = null;

  constructor(private readonly bridge: Bridge) {}

  warm(): void {
    this.listen();
    void this.bridge.call('audio', 'player_warm').catch(() => undefined);
  }

  load(source: PlayerSource, opts: PlayerLoadOptions = {}): Promise<PlayerLoaded> {
    this.listen();
    const play = opts.play ?? true;
    if ('path' in source) {
      return this.bridge.call<PlayerLoaded>('audio', 'player_load', { path: source.path, at: opts.at ?? 0, play, volume: opts.volume ?? 1 });
    }
    const headers: Record<string, string> = { 'x-name': encodeURIComponent(source.name), 'x-play': play ? '1' : '0' };
    if (opts.at) headers['x-at'] = String(opts.at);
    if (opts.volume !== undefined) headers['x-volume'] = String(opts.volume);
    return this.bridge.call<PlayerLoaded>('audio', 'player_load_data', source.data, { headers });
  }

  queue(voice: number, path: string): Promise<number> {
    return this.bridge.call<number>('audio', 'player_queue', { voice, path });
  }

  play(voice: number): Promise<void> {
    return this.bridge.call('audio', 'player_play', { voice });
  }

  pause(voice: number): Promise<void> {
    return this.bridge.call('audio', 'player_pause', { voice });
  }

  seek(voice: number, sec: number): Promise<void> {
    return this.bridge.call('audio', 'player_seek', { voice, sec });
  }

  volume(voice: number, volume: number): Promise<void> {
    return this.bridge.call('audio', 'player_volume', { voice, volume });
  }

  close(voice: number): Promise<void> {
    return this.bridge.call('audio', 'player_close', { voice });
  }

  closeAll(): Promise<void> {
    return this.bridge.call('audio', 'player_close_all');
  }

  onEvent(cb: (e: PlayerEvent) => void): () => void {
    this.listen();
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** One subscription to the backend for all voices, made at the first use. */
  private listen() {
    this.listening ??= this.bridge.ipc.listen<PlayerEvent>(EVENT_PLAYER, (e) => {
      for (const cb of [...this.listeners]) cb(e);
    });
  }
}
