import { describe, expect, it } from 'vitest';
import { TauriAudio } from '../../src/platform/tauri/audio';
import { PathByteSource } from '../../src/platform/tauri/fs';
import { f32Bytes, fakeBridge, frame } from './fake-ipc';

const header = {
  durationSec: 0.03,
  sampleRate: 44100,
  channels: 2,
  windowSec: 0.01,
  windowCount: 3,
  lufs: -23.01,
  chapters: [{ startSec: 0, title: 'Kapitel 1' }, { startSec: 0.02 }],
  codec: 'mp3',
  bitrateKbps: 128,
};

describe('TauriAudio', () => {
  it('analyses a file by path, with progress for its own job only', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('audio_analyze', (args) => {
      const { jobId, path } = args as { jobId: string; path: string };
      expect(path).toBe('/home/anna/a.mp3');
      ipc.emit('audio-progress', { jobId, fraction: 0.5 });
      ipc.emit('audio-progress', { jobId: 'someone-else', fraction: 0.9 });
      ipc.emit('audio-progress', { jobId, fraction: 1 });
      return frame(header, f32Bytes([0.001, 0.5, 0]));
    });
    const audio = new TauriAudio(bridge);
    const fractions: number[] = [];
    const source = new PathByteSource(bridge, { path: '/home/anna/a.mp3', name: 'a.mp3', size: 1000 });
    const a = await audio.analyze(source, (f) => fractions.push(f));
    expect(fractions).toEqual([0.5, 1]);
    expect(a.power).toBeInstanceOf(Float32Array);
    expect(Array.from(a.power)).toEqual([Math.fround(0.001), 0.5, 0]);
    expect(a).toMatchObject({ durationSec: 0.03, sampleRate: 44100, channels: 2, windowSec: 0.01, lufs: -23.01, codec: 'mp3', bitrateKbps: 128 });
    expect(a.chapters).toEqual([{ startSec: 0, title: 'Kapitel 1' }, { startSec: 0.02 }]);
    expect(ipc.listenerCount('audio-progress')).toBe(0);
  });

  it('leaves out loudness and chapters the backend did not find', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('audio_analyze', () => frame({ ...header, lufs: null, chapters: [], bitrateKbps: null }, f32Bytes([0, 0, 0])));
    const a = await new TauriAudio(bridge).analyze(new PathByteSource(bridge, { path: '/x.wav', name: 'x.wav', size: 1 }));
    expect('lufs' in a || 'chapters' in a || 'bitrateKbps' in a).toBe(false);
  });

  it('copies in-memory sources to a temp file and removes it afterwards', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('fs_temp_file', () => '/tmp/tonuino-studio/tmp-1.m4b');
    ipc.on('fs_write', () => null);
    ipc.on('fs_temp_remove', () => null);
    ipc.on('audio_analyze', () => frame(header, f32Bytes([1, 2, 3])));
    const data = new Uint8Array([9, 8, 7]);
    const memory = { name: 'Hörbuch.M4B', size: 3, read: async (s: number, n: number) => data.subarray(s, s + n) };
    await new TauriAudio(bridge).analyze(memory);
    expect(ipc.calls.map((c) => c.cmd)).toEqual(['fs_temp_file', 'fs_write', 'audio_analyze', 'fs_temp_remove']);
    expect(ipc.calls[0].args).toEqual({ extension: 'm4b' });
    expect(ipc.calls[1].args).toEqual(data);
    expect(ipc.calls[3].args).toEqual({ path: '/tmp/tonuino-studio/tmp-1.m4b' });
  });

  it('cancels the backend job when the signal aborts', async () => {
    const { ipc, bridge } = fakeBridge();
    const controller = new AbortController();
    let cancelled: string | undefined;
    ipc.on('audio_cancel', (args) => {
      cancelled = (args as { jobId: string }).jobId;
      return null;
    });
    ipc.on('audio_analyze', async (args) => {
      controller.abort();
      await Promise.resolve();
      expect(cancelled).toBe((args as { jobId: string }).jobId);
      throw { code: 'cancelled', detail: 'analysis cancelled' };
    });
    const source = new PathByteSource(bridge, { path: '/x.mp3', name: 'x.mp3', size: 1 });
    await expect(new TauriAudio(bridge).analyze(source, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBeDefined();
  });

  it('streams PCM blocks per channel and ends with null', async () => {
    const { ipc, bridge } = fakeBridge();
    ipc.on('audio_pcm_open', (args) => {
      expect(args).toEqual({ path: '/x.flac', targetSampleRate: 48000 });
      return { handle: 7, sampleRate: 48000, channels: 2, durationSec: 12.5 };
    });
    const blocks = [f32Bytes([0.1, -0.1, 0.2, -0.2, 0.3, -0.3]).buffer, new ArrayBuffer(0)];
    ipc.on('audio_pcm_read', (args) => {
      expect(args).toEqual({ handle: 7, maxFrames: 4096 });
      return blocks.shift();
    });
    ipc.on('audio_pcm_close', () => null);
    const reader = await new TauriAudio(bridge).openPcm(new PathByteSource(bridge, { path: '/x.flac', name: 'x.flac', size: 1 }), {
      targetSampleRate: 48000,
    });
    expect([reader.sampleRate, reader.channels, reader.durationSec]).toEqual([48000, 2, 12.5]);
    const chunk = await reader.next(4096);
    expect(chunk!.sampleRate).toBe(48000);
    expect(chunk!.channels.map((c) => Array.from(c))).toEqual([
      [0.1, 0.2, 0.3].map(Math.fround),
      [-0.1, -0.2, -0.3].map(Math.fround),
    ]);
    expect(await reader.next(4096)).toBeNull();
    expect(await reader.next(4096)).toBeNull();
    await reader.close();
    await reader.close();
    expect(ipc.callsOf('audio_pcm_read')).toHaveLength(2);
    expect(ipc.callsOf('audio_pcm_close')).toEqual([{ cmd: 'audio_pcm_close', args: { handle: 7 } }]);
  });
});
