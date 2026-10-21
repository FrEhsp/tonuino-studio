/**
 * "Anhören" (src/ui/useListen.ts) with pages that stay mounted: a track that
 * loads too late does not play, only one list plays at a time, and a hidden
 * page goes quiet. The hook runs here on a tiny stand-in for preact/hooks,
 * as the tests have no DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ByteSource, PlayerAccess, PlayerEvent, PlayerSource } from '../../src/platform/types';

/* A component with its hook slots, rendered by hand. */
interface Comp {
  slots: unknown[];
  effects: { deps?: unknown[]; cleanup?: () => void }[];
  queued: (() => void)[];
  i: number;
  shown: boolean;
}
let comp: Comp | null = null;

vi.mock('preact/hooks', () => {
  const slot = <T>(make: () => T): T => {
    const c = comp!;
    const i = c.i++;
    if (!(i in c.slots)) c.slots[i] = make();
    return c.slots[i] as T;
  };
  return {
    useRef: <T>(init: T) => slot(() => ({ current: init })),
    // No re-render on a change: the tests render again (`now`) before they look.
    useState: <T>(init: T) => {
      const box = slot(() => {
        const b: [T, (v: T) => void] = [init, (v: T) => void (b[0] = v)];
        return b;
      });
      return [box[0], box[1]];
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const c = comp!;
      const i = c.i++;
      const prev = c.effects[i];
      if (prev && deps && prev.deps && deps.every((d, k) => Object.is(d, prev.deps![k]))) return;
      c.queued.push(() => {
        prev?.cleanup?.();
        const cleanup = fn();
        c.effects[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      });
    },
  };
});
vi.mock('../../src/app/pageAlive', () => ({ usePageShown: () => comp!.shown }));
vi.mock('../../src/ui/components/Toast', () => ({ toastError: vi.fn(), toast: { error: vi.fn() } }));

const { useListen, shownLength, after } = await import('../../src/ui/useListen');
type ListenNext = import('../../src/ui/useListen').ListenNext;

/** A list of tracks as a page hands it over: each one knows the one after it in `order` as it is when asked. */
function album(order: string[], loaded: string[] = [], what: (key: string) => Promise<Blob | ByteSource> = quick) {
  const entry = (key: string): ListenNext => ({
    key,
    load: () => {
      loaded.push(key);
      return what(key);
    },
    opts: {
      name: `${key}.wav`,
      next: () => {
        const n = after(order, key, (k) => k);
        return n ? entry(n) : null;
      },
    },
  });
  return entry;
}
/** Lets started loads and plays run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const { toast } = await import('../../src/ui/components/Toast');
const { platform } = await import('../../src/app/state');

function mount() {
  const c: Comp = { slots: [], effects: [], queued: [], i: 0, shown: true };
  let out!: ReturnType<typeof useListen>;
  const render = () => {
    comp = c;
    c.i = 0;
    out = useListen();
    comp = null;
    const q = c.queued.splice(0);
    q.forEach((run) => run());
    return out;
  };
  render();
  return {
    get now() {
      return render();
    },
    hide() {
      c.shown = false;
      render();
    },
    unmount() {
      c.effects.forEach((e) => e?.cleanup?.());
    },
  };
}

class FakeAudio {
  static made: FakeAudio[] = [];
  /** Errors the next play() calls reject with, one per call. */
  static refuse: Error[] = [];
  paused = true;
  preload = '';
  /** Ever given a file: players made for a click whose file never came stay empty. */
  hadFile = false;
  private file = '';
  get src() {
    return this.file;
  }
  set src(v: string) {
    this.file = v;
    if (v) {
      this.hadFile = true;
      this.unloaded = false;
    }
  }
  currentTime = 0;
  ended = false;
  seeking = false;
  error: { code: number } | null = null;
  unloaded = false;
  private on = new Map<string, (() => void)[]>();
  constructor() {
    FakeAudio.made.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    this.on.set(type, [...(this.on.get(type) ?? []), fn]);
  }
  removeAttribute(name: string) {
    if (name === 'src') this.file = '';
  }
  load() {
    this.unloaded = !this.src;
  }
  play() {
    const no = FakeAudio.refuse.shift();
    if (no) return Promise.reject(no);
    this.paused = false;
    this.on.get('play')?.forEach((f) => f());
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.on.get('pause')?.forEach((f) => f());
  }
  /** The file played to its end: the order of a browser's player, "pause" before "ended". */
  end() {
    this.ended = true;
    this.paused = true;
    this.on.get('pause')?.forEach((f) => f());
    this.on.get('ended')?.forEach((f) => f());
  }
}

/** A load that finishes when the test says so. */
function later() {
  let done!: (b: Blob) => void;
  const p = new Promise<Blob>((r) => (done = r));
  return { load: () => p, done: () => done(new Blob(['x'])) };
}
const quick = () => Promise.resolve(new Blob(['x']));
const playing = () => FakeAudio.made.filter((a) => !a.paused);
/** The players that got a file, in order. */
const used = () => FakeAudio.made.filter((a) => a.hadFile);

const RealURL = URL;

describe('Anhören', () => {
  const revoked: string[] = [];
  beforeEach(() => {
    FakeAudio.made = [];
    FakeAudio.refuse = [];
    vi.mocked(toast.error).mockClear();
    revoked.length = 0;
    let n = 0;
    vi.stubGlobal('Audio', FakeAudio);
    // A real URL besides: loading the MP3 helpers needs it.
    vi.stubGlobal('URL', Object.assign(class extends RealURL {}, { createObjectURL: () => `blob:${++n}`, revokeObjectURL: (u: string) => revoked.push(u) }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not play a track that finishes loading after a stop', async () => {
    const list = mount();
    const slow = later();
    const started = list.now.toggle('a', slow.load);
    list.now.stop();
    slow.done();
    await started;
    expect(used()).toHaveLength(0);
    expect(list.now.listen).toBeNull();
    list.unmount();
  });

  it('does not play a track that finishes loading after the list went away', async () => {
    const list = mount();
    const slow = later();
    const started = list.now.toggle('a', slow.load);
    list.unmount();
    slow.done();
    await started;
    expect(used()).toHaveLength(0);
  });

  it('keeps the newer click when an older, slower track finishes loading last', async () => {
    const list = mount();
    const slow = later();
    const first = list.now.toggle('a', slow.load);
    await list.now.toggle('b', quick);
    slow.done();
    await first;
    expect(used()).toHaveLength(1);
    expect(list.now.listen?.key).toBe('b');
    expect(playing()).toHaveLength(1);
    list.unmount();
  });

  it('plays one list at a time: starting a track in a second list stops the first', async () => {
    const one = mount();
    const two = mount();
    await one.now.toggle('a', quick);
    await two.now.toggle('b', quick);
    expect(playing().map((a) => a.src)).toEqual(['blob:2']);
    // The first player let go of its file, not only paused (WebKitGTK keeps a paused one running).
    expect(used()[0].unloaded).toBe(true);
    expect(revoked).toEqual(['blob:1']);
    expect(one.now.listen).toBeNull();
    expect(two.now.listen?.key).toBe('b');
    one.unmount();
    two.unmount();
  });

  it('goes quiet and lets go of the file when its page is hidden', async () => {
    const list = mount();
    await list.now.toggle('a', quick);
    expect(playing()).toHaveLength(1);
    list.hide();
    expect(playing()).toHaveLength(0);
    expect(revoked).toEqual(['blob:1']);
    expect(list.now.listen).toBeNull();
    list.unmount();
  });

  it('tries once more with a fresh player when the browser refuses the file', async () => {
    const list = mount();
    FakeAudio.refuse = [new DOMException('The operation is not supported.', 'NotSupportedError')];
    await list.now.toggle('a', quick, { name: '003.mp3' });
    expect(used()).toHaveLength(2);
    expect(used()[0].unloaded).toBe(true);
    expect(playing()).toEqual([used()[1]]);
    expect(list.now.listen?.playing).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
    list.unmount();
  });

  it('says in German what to do when the second try fails too, never the browser text', async () => {
    const list = mount();
    FakeAudio.refuse = [0, 1].map(() => new DOMException('The operation is not supported.', 'NotSupportedError'));
    await list.now.toggle('a', quick, { name: '003.mp3' });
    expect(used()).toHaveLength(2);
    expect(list.now.listen).toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [title, text] = vi.mocked(toast.error).mock.calls[0];
    expect(title).toBe('Abspielen geht nicht');
    expect(text).toMatch(/noch einmal/);
    expect(`${title} ${text}`).not.toMatch(/operation|supported/i);
    list.unmount();
  });

  it('does not retry other refusals, and stays silent when a play is cut short on purpose', async () => {
    const list = mount();
    FakeAudio.refuse = [new DOMException('play() was interrupted', 'AbortError')];
    await list.now.toggle('a', quick);
    expect(used()).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
    FakeAudio.refuse = [new DOMException('denied', 'NotAllowedError')];
    await list.now.toggle('b', quick);
    expect(used()).toHaveLength(2);
    expect(vi.mocked(toast.error).mock.calls[0][1]).toMatch(/Anhören/);
    list.unmount();
  });

  it('starts with the length the list shows', async () => {
    const list = mount();
    await list.now.toggle('a', quick, { name: 'a.wav', durationSec: 181 });
    expect(list.now.listen?.durationSec).toBe(181);
    list.now.listen?.seek(-3);
    expect(used()[0].currentTime).toBe(0);
    list.now.listen?.seek(42);
    expect(used()[0].currentTime).toBe(42);
    list.unmount();
  });
  it('plays on the player made at the click, before the file was read', async () => {
    const list = mount();
    const slow = later();
    const started = list.now.toggle('a', slow.load, { name: 'a.wav' });
    expect(FakeAudio.made).toHaveLength(1);
    const atClick = FakeAudio.made[0];
    slow.done();
    await started;
    expect(playing()).toEqual([atClick]);
    list.unmount();
  });

  it('swaps a player whose clock stands still for a fresh one at the same spot, and lets a refused swap wait quietly', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const list = mount();
      await list.now.toggle('a', quick, { name: 'a.wav' });
      const first = used()[0];
      first.currentTime = 12;
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(2500);
      await Promise.resolve();
      expect(used()).toHaveLength(2);
      expect(first.unloaded).toBe(true);
      expect(used()[1].currentTime).toBe(12);
      expect(playing()).toEqual([used()[1]]);
      // The second swap is refused (sound only after a click): it waits paused, without a message.
      FakeAudio.refuse = [new DOMException('denied', 'NotAllowedError')];
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
      await Promise.resolve();
      expect(used()).toHaveLength(3);
      expect(playing()).toEqual([]);
      expect(list.now.listen?.playing).toBe(false);
      expect(list.now.listen?.audio).toBe(used()[2]);
      expect(toast.error).not.toHaveBeenCalled();
      // A click on play goes on there.
      await list.now.toggle('a', quick, { name: 'a.wav' });
      expect(playing()).toEqual([used()[2]]);
      list.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds the track after one in a list, none after the last or for a track no longer there', () => {
    const list = ['a', 'b', 'c'];
    expect(after(list, 'a', (k) => k)).toBe('b');
    expect(after(list, 'c', (k) => k)).toBeNull();
    expect(after(list, 'x', (k) => k)).toBeNull();
    expect(after([] as string[], 'a', (k) => k)).toBeNull();
  });

  it('plays on into the next track of the list like a CD, moves the marker, and stops after the last', async () => {
    const list = mount();
    const loaded: string[] = [];
    const entry = album(['a', 'b', 'c'], loaded);
    const first = entry('b');
    await list.now.toggle(first.key, first.load, first.opts);
    expect(list.now.isPlaying('b')).toBe(true);
    used()[0].end();
    await settle();
    expect(loaded).toEqual(['b', 'c']);
    expect(list.now.listen?.key).toBe('c');
    expect(list.now.isPlaying('c')).toBe(true);
    // The finished player let go of its file.
    expect(used()[0].unloaded).toBe(true);
    expect(playing()).toEqual([used()[1]]);
    // The last track ends quietly, its marker stays.
    used()[1].end();
    await settle();
    expect(loaded).toEqual(['b', 'c']);
    expect(list.now.listen?.key).toBe('c');
    expect(list.now.listen?.playing).toBe(false);
    list.unmount();
  });

  it('asks the list for the next track only at the end, so a new order counts', async () => {
    const list = mount();
    const order = ['a', 'b', 'c'];
    const loaded: string[] = [];
    const entry = album(order, loaded);
    const a = entry('a');
    await list.now.toggle(a.key, a.load, a.opts);
    order.splice(0, 3, 'a', 'c', 'b');
    used()[0].end();
    await settle();
    expect(loaded).toEqual(['a', 'c']);
    list.unmount();
  });

  it('does not play on after a pause, a stop or a track from another list', async () => {
    const list = mount();
    const loaded: string[] = [];
    const entry = album(['a', 'b'], loaded);
    const a = entry('a');
    // Paused: the player's end does not come, and a stopped one hands over nothing.
    await list.now.toggle(a.key, a.load, a.opts);
    await list.now.toggle(a.key, a.load, a.opts);
    expect(list.now.listen?.playing).toBe(false);
    list.now.stop();
    used()[0].end();
    await settle();
    expect(loaded).toEqual(['a']);
    expect(list.now.listen).toBeNull();
    // Another list took over: the first one's late end starts nothing.
    const other = mount();
    await list.now.toggle(a.key, a.load, a.opts);
    const late = used()[1];
    await other.now.toggle('x', quick);
    late.end();
    await settle();
    expect(loaded).toEqual(['a', 'a']);
    expect(other.now.listen?.key).toBe('x');
    list.unmount();
    other.unmount();
  });

  it('lets the next track wait, marked and without a message, when the browser wants a click first', async () => {
    const list = mount();
    const entry = album(['a', 'b']);
    const a = entry('a');
    await list.now.toggle(a.key, a.load, a.opts);
    FakeAudio.refuse = [new DOMException('denied', 'NotAllowedError')];
    used()[0].end();
    await settle();
    expect(list.now.listen?.key).toBe('b');
    expect(list.now.listen?.playing).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
    // A click on play starts it.
    const b = entry('b');
    await list.now.toggle(b.key, b.load, b.opts);
    expect(list.now.isPlaying('b')).toBe(true);
    list.unmount();
  });
});

describe('Anhören am Computer (eigener Spieler)', () => {
  /** A made-up backend of the desktop player. */
  const made: { calls: unknown[][]; emit: (e: Partial<PlayerEvent>) => void; loads: PlayerSource[] } = { calls: [], emit: () => {}, loads: [] };
  beforeEach(() => {
    const listeners = new Set<(e: PlayerEvent) => void>();
    made.calls = [];
    made.loads = [];
    let next = 1;
    const record =
      (name: string) =>
      async (...args: unknown[]) => {
        made.calls.push([name, ...args]);
      };
    const player: PlayerAccess = {
      warm: () => void made.calls.push(['warm']),
      load: async (source) => {
        made.loads.push(source);
        const voice = next++;
        return { voice, track: 100 + voice, durationSec: 181.4, exact: false };
      },
      queue: async () => 0,
      play: record('play'),
      pause: record('pause'),
      seek: record('seek'),
      volume: record('volume'),
      close: record('close'),
      closeAll: async () => {},
      onEvent: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    made.emit = (e) => listeners.forEach((cb) => cb({ voice: 1, kind: 'pos', track: 101, posSec: 0, playing: true, ...e }));
    platform.value = { player } as never;
    vi.mocked(toast.error).mockClear();
    vi.stubGlobal('Audio', FakeAudio);
    FakeAudio.made = [];
  });
  afterEach(() => {
    platform.value = null;
    vi.unstubAllGlobals();
  });

  const onCard: ByteSource = { name: '003.mp3', size: 5_000_000, path: '/media/SD/07/003.mp3', read: () => Promise.reject(new Error('read into memory')) };

  it('opens the output when the list shows, and hands the file over by its path without reading it', async () => {
    const list = mount();
    expect(made.calls).toEqual([['warm']]);
    await list.now.toggle('003.mp3', async () => onCard, { name: '003.mp3', durationSec: 181 });
    expect(made.loads).toEqual([{ path: '/media/SD/07/003.mp3', name: '003.mp3' }]);
    expect(FakeAudio.made).toHaveLength(0);
    expect(list.now.listen?.playing).toBe(true);
    expect(list.now.isPlaying('003.mp3')).toBe(true);
    // The same track again pauses, and plays on.
    await list.now.toggle('003.mp3', async () => onCard);
    expect(list.now.listen?.playing).toBe(false);
    await list.now.toggle('003.mp3', async () => onCard);
    expect(made.calls.map((c) => c[0])).toEqual(['warm', 'pause', 'play']);
    expect(made.loads).toHaveLength(1);
    list.unmount();
  });

  it('keeps the length of the list when the exact one is close, takes the exact one otherwise', async () => {
    const list = mount();
    await list.now.toggle('a', async () => onCard, { durationSec: 181 });
    expect(list.now.listen?.durationSec).toBe(181);
    made.emit({ kind: 'duration', durationSec: 240.5 });
    expect(list.now.listen?.durationSec).toBe(240.5);
    expect(shownLength(181, 181.6)).toBe(181);
    expect(shownLength(undefined, 181.6)).toBe(181.6);
    list.unmount();
  });

  it('jumps through the player and lets go of the voice when the page is hidden', async () => {
    const list = mount();
    await list.now.toggle('a', async () => onCard);
    list.now.listen?.seek(95.5);
    expect(made.calls).toContainEqual(['seek', 1, 95.5]);
    list.hide();
    expect(made.calls).toContainEqual(['close', 1]);
    expect(list.now.listen).toBeNull();
    list.unmount();
  });

  it('plays on into the next track through the own player too', async () => {
    const list = mount();
    const files: Record<string, ByteSource> = {
      a: { ...onCard, name: '001.mp3', path: '/media/SD/07/001.mp3' },
      b: { ...onCard, name: '002.mp3', path: '/media/SD/07/002.mp3' },
    };
    const entry = album(['a', 'b'], [], async (k) => files[k]);
    const a = entry('a');
    await list.now.toggle(a.key, a.load, a.opts);
    made.emit({ kind: 'ended', track: 101, playing: false });
    await settle();
    expect(made.loads.map((l) => (l as { path: string }).path)).toEqual(['/media/SD/07/001.mp3', '/media/SD/07/002.mp3']);
    expect(made.calls).toContainEqual(['close', 1]);
    expect(list.now.listen?.key).toBe('b');
    expect(list.now.isPlaying('b')).toBe(true);
    // The end of the last track starts nothing more.
    made.emit({ voice: 2, kind: 'ended', track: 102, playing: false });
    await settle();
    expect(made.loads).toHaveLength(2);
    expect(list.now.listen?.playing).toBe(false);
    list.unmount();
  });

  it('says in German why a track broke off', async () => {
    const list = mount();
    await list.now.toggle('a', async () => onCard);
    made.emit({ kind: 'error', code: 'decode-failed' });
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [title, text] = vi.mocked(toast.error).mock.calls[0];
    expect(title).toBe('Abspielen geht nicht');
    expect(text).toMatch(/beschädigt/);
    expect(list.now.listen).toBeNull();
    list.unmount();
  });
});
