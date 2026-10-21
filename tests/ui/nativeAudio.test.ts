/**
 * The desktop app's own player as the page sees it (src/ui/nativeAudio.ts):
 * it behaves like an <audio> element on top of a made-up backend, so the
 * logic runs here without sound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ByteSource, PlayerAccess, PlayerEvent, PlayerLoaded, PlayerLoadOptions, PlayerSource } from '../../src/platform/types';

vi.mock('../../src/ui/components/Toast', () => ({ toast: { error: vi.fn() } }));

const { NativeAudio, lastNativeAudio, openPlayer } = await import('../../src/ui/nativeAudio');
const { toast } = await import('../../src/ui/components/Toast');
const { platform } = await import('../../src/app/state');
const { playProblem } = await import('../../src/ui/playError');

/** A backend that records the calls and sends events when the test says. */
class FakePlayer implements PlayerAccess {
  calls: [string, ...unknown[]][] = [];
  loads: { source: PlayerSource; opts: PlayerLoadOptions }[] = [];
  private listeners = new Set<(e: PlayerEvent) => void>();
  next = 1;
  /** Makes the next load fail with this. */
  refuse: unknown = null;
  /** The next load waits for this. */
  gate: Promise<void> | null = null;
  warm() {
    this.calls.push(['warm']);
  }
  async load(source: PlayerSource, opts: PlayerLoadOptions = {}): Promise<PlayerLoaded> {
    this.loads.push({ source, opts });
    if (this.gate) await this.gate;
    if (this.refuse) throw this.refuse;
    const voice = this.next++;
    return { voice, track: 100 + voice, durationSec: 60, exact: false };
  }
  async queue(voice: number) {
    this.calls.push(['queue', voice]);
    return 7;
  }
  async play(voice: number) {
    this.calls.push(['play', voice]);
  }
  async pause(voice: number) {
    this.calls.push(['pause', voice]);
  }
  async seek(voice: number, sec: number) {
    this.calls.push(['seek', voice, sec]);
  }
  async volume(voice: number, v: number) {
    this.calls.push(['volume', voice, v]);
  }
  async close(voice: number) {
    this.calls.push(['close', voice]);
  }
  async closeAll() {}
  onEvent(cb: (e: PlayerEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(e: Partial<PlayerEvent> & Pick<PlayerEvent, 'kind'>) {
    for (const cb of [...this.listeners]) cb({ voice: 1, track: 101, posSec: 0, playing: true, ...e });
  }
  get listening() {
    return this.listeners.size;
  }
}

function fileOnCard(path = '/media/SD/01/001.mp3'): ByteSource {
  return { name: '001.mp3', size: 1000, path, read: () => Promise.reject(new Error('must not be read')) };
}

/** Events the element fired, in order. */
function record(a: EventTarget, types = ['play', 'playing', 'pause', 'seeking', 'seeked', 'timeupdate', 'durationchange', 'ended', 'error']) {
  const seen: string[] = [];
  for (const t of types) a.addEventListener(t, () => seen.push(t));
  return seen;
}

let clock = 1000;

describe('NativeAudio', () => {
  let fake: FakePlayer;
  beforeEach(() => {
    fake = new FakePlayer();
    clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.mocked(toast.error).mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('lets the backend open a file of the card by its path, and starts where it was asked to', async () => {
    const a = new NativeAudio(fake);
    const seen = record(a);
    a.setSource(fileOnCard(), '001.mp3');
    a.currentTime = 12;
    a.volume = 0.4;
    await a.play();
    expect(fake.loads).toEqual([{ source: { path: '/media/SD/01/001.mp3', name: '001.mp3' }, opts: { at: 12, play: true, volume: 0.4 } }]);
    expect(a.paused).toBe(false);
    expect(a.duration).toBe(60);
    expect(seen.slice(0, 2)).toEqual(['play', 'durationchange']);
    expect(lastNativeAudio()).toBe(a);
    a.release();
  });

  it('sends data from memory as bytes', async () => {
    const a = new NativeAudio(fake);
    a.setSource(new Blob([new Uint8Array([9, 8, 7])]), 'aufnahme.wav');
    await a.play();
    const src = fake.loads[0].source as { data: Uint8Array; name: string };
    expect([...src.data]).toEqual([9, 8, 7]);
    expect(src.name).toBe('aufnahme.wav');
    expect(a.stats.source).toBe('speicher');
    a.release();
  });

  it('moves its clock on between reports, and follows them without stepping back for a hair', async () => {
    const a = new NativeAudio(fake);
    a.setSource(fileOnCard());
    await a.play();
    fake.emit({ kind: 'started', posSec: 0, startMs: 3.2 });
    expect(a.stats.firstSoundMs).toBe(3.2);
    clock += 100;
    expect(a.currentTime).toBeCloseTo(0.1, 6);
    fake.emit({ kind: 'pos', posSec: 0.25 });
    clock += 50;
    expect(a.currentTime).toBeCloseTo(0.3, 6);
    // A report a little behind the running clock: the clock waits, it does not jump back.
    fake.emit({ kind: 'pos', posSec: 0.28 });
    expect(a.currentTime).toBeCloseTo(0.3, 6);
    // Far behind (the backend knows better): it follows.
    fake.emit({ kind: 'pos', posSec: 0.1 });
    expect(a.currentTime).toBeCloseTo(0.1, 6);
    // Without news it never runs away (an output that hangs).
    clock += 10_000;
    expect(a.currentTime).toBeLessThan(1);
    a.release();
  });

  it('jumps: shows the place at once and says seeked when the backend has it', async () => {
    const a = new NativeAudio(fake);
    a.setSource(fileOnCard());
    await a.play();
    const seen = record(a, ['seeking', 'seeked']);
    a.currentTime = 30;
    a.currentTime = 42.5;
    expect(a.seeking).toBe(true);
    expect(a.currentTime).toBe(42.5);
    expect(fake.calls.filter((c) => c[0] === 'seek')).toEqual([
      ['seek', 1, 30],
      ['seek', 1, 42.5],
    ]);
    // The first jump's answer is old news.
    fake.emit({ kind: 'seeked', posSec: 30 });
    expect(a.seeking).toBe(true);
    clock += 12;
    fake.emit({ kind: 'seeked', posSec: 42.5 });
    expect(a.seeking).toBe(false);
    expect(seen).toEqual(['seeking', 'seeking', 'seeked']);
    expect(a.stats.seekMs).toEqual([12]);
    // Never past the end.
    a.currentTime = 999;
    expect(a.currentTime).toBe(60);
    a.release();
  });

  it('pauses and plays on the same voice, and after the end starts again', async () => {
    const a = new NativeAudio(fake);
    a.setSource(fileOnCard());
    await a.play();
    const seen = record(a, ['pause', 'playing', 'ended', 'timeupdate']);
    a.pause();
    a.pause();
    expect(a.paused).toBe(true);
    await a.play();
    expect(fake.calls.filter((c) => c[0] === 'pause' || c[0] === 'play')).toEqual([
      ['pause', 1],
      ['play', 1],
    ]);
    fake.emit({ kind: 'ended', playing: false });
    expect(a.ended).toBe(true);
    expect(a.paused).toBe(true);
    expect(a.currentTime).toBe(60);
    expect(seen).toEqual(['pause', 'playing', 'timeupdate', 'pause', 'ended']);
    await a.play();
    expect(a.ended).toBe(false);
    expect(fake.loads).toHaveLength(1);
    a.release();
  });

  it('takes the exact length when the backend knows it', async () => {
    const a = new NativeAudio(fake);
    a.setSource(fileOnCard());
    await a.play();
    const seen = record(a, ['durationchange']);
    fake.emit({ kind: 'duration', durationSec: 61.234 });
    expect(a.duration).toBe(61.234);
    expect(seen).toEqual(['durationchange']);
    a.release();
  });

  it('reports a broken file with a German text, while it still counts as playing', async () => {
    const a = new NativeAudio(fake);
    a.setSource(fileOnCard());
    await a.play();
    let pausedAtError: boolean | null = null;
    a.addEventListener('error', () => (pausedAtError = a.paused));
    fake.emit({ kind: 'error', code: 'io' });
    expect(pausedAtError).toBe(false);
    expect(a.paused).toBe(true);
    expect(a.error?.code).toBe(2);
    expect(playProblem(a.error).text).toMatch(/SD-Karte/);
    a.release();
  });

  it('lets go of the voice when the source goes, also one that finishes loading too late', async () => {
    const a = new NativeAudio(fake);
    a.setSource(fileOnCard());
    await a.play();
    a.removeAttribute('src');
    expect(fake.calls).toContainEqual(['close', 1]);
    expect(fake.listening).toBe(1); // only the device watch stays
    let open!: () => void;
    fake.gate = new Promise((r) => (open = r));
    a.setSource(fileOnCard('/b.mp3'));
    const p = a.play();
    a.release();
    open();
    await p;
    expect(fake.calls).toContainEqual(['close', 2]);
  });

  it('says once in German that the loudspeaker is gone, and every player pauses', async () => {
    const a = new NativeAudio(fake);
    a.setSource(fileOnCard());
    await a.play();
    fake.emit({ kind: 'paused', posSec: 17, playing: false });
    fake.emit({ voice: 0, kind: 'device', code: 'device-lost', playing: false });
    expect(a.paused).toBe(true);
    expect(a.currentTime).toBe(17);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][1]).toMatch(/Kopfhörer oder Lautsprecher/);
    a.release();
  });

  it('gives a failed load to play() as an error with the German text', async () => {
    const a = new NativeAudio(fake);
    a.setSource(fileOnCard());
    const err = Object.assign(new Error('Am Computer ist gerade kein Lautsprecher und kein Kopfhörer zu finden.'), { name: 'TauriPlatformError', code: 'no-device' });
    fake.refuse = err;
    await expect(a.play()).rejects.toBe(err);
    expect(a.paused).toBe(true);
    expect(playProblem(err).text).toMatch(/kein Lautsprecher/);
  });

  it('sends timeupdate often enough for a smooth bar, but not every frame of a long track', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    try {
      const a = new NativeAudio(fake);
      a.setSource(fileOnCard());
      await a.play();
      fake.emit({ kind: 'started', posSec: 0 });
      let n = 0;
      a.addEventListener('timeupdate', () => n++);
      // One second at 120 frames per second, track of 60 s: a step is 30 ms.
      for (let i = 0; i < 120; i++) {
        clock += 1000 / 120;
        vi.advanceTimersByTime(1000 / 120);
      }
      expect(n).toBeGreaterThanOrEqual(20);
      expect(n).toBeLessThanOrEqual(40);
      a.pause();
      n = 0;
      vi.advanceTimersByTime(500);
      expect(n).toBe(0);
      a.release();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openPlayer', () => {
  afterEach(() => platform.value = null);

  it('uses the desktop player where there is one', async () => {
    const fake = new FakePlayer();
    platform.value = { player: fake } as never;
    const p = await openPlayer(fileOnCard(), '001.mp3');
    expect(p.el).toBeInstanceOf(NativeAudio);
    await p.el.play();
    p.free();
    expect(fake.calls).toContainEqual(['close', 1]);
  });
});
