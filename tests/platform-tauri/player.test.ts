/** The desktop bridge to the computer's own player (src-tauri/src/player), against a fake IPC. */
import { describe, expect, it } from 'vitest';
import { createTauriPlatform } from '../../src/platform/tauri';
import { TauriPlatformError } from '../../src/platform/tauri/errors';
import { TauriPlayer } from '../../src/platform/tauri/player';
import type { PlayerEvent } from '../../src/platform/types';
import { FakeIpc, fakeBridge } from './fake-ipc';

const loaded = { voice: 3, track: 4, durationSec: 12.5, exact: false };

describe('TauriPlayer', () => {
  it('hands a file over by its path only', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('player_load', () => loaded);
    const got = await new TauriPlayer(bridge).load({ path: '/media/SD/01/001.mp3', name: '001.mp3' }, { at: 30, volume: 0.5 });
    expect(got).toEqual(loaded);
    expect(ipc.calls[0].args).toEqual({ path: '/media/SD/01/001.mp3', at: 30, play: true, volume: 0.5 });
  });

  it('sends data from memory as the raw body, with the name for its type', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('player_load_data', () => loaded);
    await new TauriPlayer(bridge).load({ data: new Uint8Array([1, 2, 3]), name: 'Mein Lied ü.m4a' }, { play: false, at: 2.5 });
    const call = ipc.calls[0];
    expect([...(call.args as Uint8Array)]).toEqual([1, 2, 3]);
    expect(call.headers).toEqual({ 'x-name': encodeURIComponent('Mein Lied ü.m4a'), 'x-play': '0', 'x-at': '2.5' });
  });

  it('names the voice in every other call', async () => {
    const { ipc, bridge } = fakeBridge();
    for (const cmd of ['player_play', 'player_pause', 'player_seek', 'player_volume', 'player_close', 'player_close_all', 'player_queue']) ipc.on(cmd, () => (cmd === 'player_queue' ? 9 : null));
    const p = new TauriPlayer(bridge);
    await p.play(3);
    await p.pause(3);
    await p.seek(3, 61.25);
    await p.volume(3, 0.2);
    expect(await p.queue(3, '/x/002.mp3')).toBe(9);
    await p.close(3);
    await p.closeAll();
    expect(ipc.calls.map((c) => [c.cmd, c.args])).toEqual([
      ['player_play', { voice: 3 }],
      ['player_pause', { voice: 3 }],
      ['player_seek', { voice: 3, sec: 61.25 }],
      ['player_volume', { voice: 3, volume: 0.2 }],
      ['player_queue', { voice: 3, path: '/x/002.mp3' }],
      ['player_close', { voice: 3 }],
      ['player_close_all', undefined],
    ]);
  });

  it('listens once to the backend and hands every event to every listener', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('player_warm', () => null);
    const p = new TauriPlayer(bridge);
    const a: PlayerEvent[] = [];
    const b: PlayerEvent[] = [];
    const offA = p.onEvent((e) => a.push(e));
    p.onEvent((e) => b.push(e));
    p.warm();
    await Promise.resolve();
    expect(ipc.listenerCount('player')).toBe(1);
    const ev: PlayerEvent = { voice: 3, kind: 'pos', track: 4, posSec: 1.5, playing: true };
    ipc.emit('player', ev);
    offA();
    ipc.emit('player', { ...ev, posSec: 1.75 });
    expect(a.map((e) => e.posSec)).toEqual([1.5]);
    expect(b.map((e) => e.posSec)).toEqual([1.5, 1.75]);
  });

  it('says in German when there is no loudspeaker', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('player_load', () => {
      throw { code: 'no-device', detail: 'no default output device' };
    });
    const err = await new TauriPlayer(bridge).load({ path: '/a.mp3', name: 'a.mp3' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TauriPlatformError);
    expect((err as Error).message).toMatch(/Lautsprecher/);
    expect((err as Error).message).not.toMatch(/device/);
  });

  it('is part of the desktop platform only', () => {
    expect(createTauriPlatform({ ipc: new FakeIpc(), os: 'linux' }).player).toBeInstanceOf(TauriPlayer);
  });
});
