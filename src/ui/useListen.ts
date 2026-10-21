/**
 * "Anhören" in a list of tracks: one track at a time, loaded into memory,
 * paused and played on where it stopped, with the bar of SeekBar.tsx under
 * the track that is loaded. Lets go of the file when the list goes away or
 * its page is hidden (pages stay mounted, App.tsx), and only one list in the
 * whole app plays at a time.
 *
 * A player that is done gets its file taken away (src removed, load()), not
 * only paused: WebKitGTK (the Linux desktop app) keeps a running media
 * pipeline per <audio> element until it is collected, and with a few of them
 * left over, new ones fail now and then with "NotSupportedError". Such a
 * failure gets one more try with a fresh player.
 *
 * For MP3s the length comes from the file's frames, the same as the list
 * shows (mp3PlaybackInfo), not from the browser's guess; VBR files without a
 * Xing frame play from a copy with a table of contents, so jumps land where
 * the bar says. Both are worked out before the track starts (a few
 * hundredths of a second): giving a player a new file just after it began
 * left WebKitGTK silent now and then, its clock stuck near 0.
 *
 * A click on another track quiets the one playing at once, while the new
 * file is still being read from the card.
 *
 * WebKitGTK also falls silent now and then on its own: the player says it
 * plays, but its clock stands still. A player whose clock stands still for
 * two seconds while it should play is swapped for a fresh one at the same
 * spot (twice per track at most).
 *
 * The desktop app plays through its own player instead (NativeAudio, the
 * Rust part): none of the WebKitGTK cures above are needed there, a file on
 * the card is opened by the backend itself (only its path crosses over), and
 * the exact length and the jumps come from the backend too. The output is
 * opened when a list with tracks shows, so the first click sounds at once.
 *
 * A list plays on like a CD: when a track ends, the list is asked for the
 * one after it (`next`, asked only then, so a list sorted or shortened
 * meanwhile counts as it is now), and that one starts with the marker on it.
 * The last track of the list ends quietly. Pausing, stopping or another
 * track starting ends the chain, as only the player of the list's current
 * track may hand over. A browser that lets sound start only on a click
 * (Safari) may refuse the next track: it then waits at its start, marked,
 * for a click on play.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { usePageShown } from '../app/pageAlive';
import type { ByteSource, PlayerAccess } from '../platform/types';
import { toast } from './components/Toast';
import { NativeAudio, nativePlayer, type MediaLike } from './nativeAudio';
import { isAbort, isNotSupported, playProblem } from './playError';

export interface Listening {
  key: string;
  audio: MediaLike;
  playing: boolean;
  /** Length of the track as the list shows it: from its frames where they could be read, else the length given to toggle. */
  durationSec?: number;
  /** Jumps there. */
  seek: (sec: number) => void;
}

export interface ListenOptions {
  /** File name, for the type of the file ("003.mp3"). */
  name?: string;
  /** Length the list shows. */
  durationSec?: number;
  /** Starts there instead of at the beginning (listening into a cut). */
  startSec?: number;
  /** The track after this one in the same list, asked for when this one ends; none at the end of the list. */
  next?: () => ListenNext | null | undefined;
}

/** What toggle needs for the next track of a list. */
export interface ListenNext {
  key: string;
  load: () => Promise<Blob | ByteSource>;
  opts?: ListenOptions;
}

/** The item after the one with `key` in `list`, or null for the last one and for a key no longer in the list. */
export function after<T>(list: readonly T[], key: string, keyOf: (t: T) => string): T | null {
  const i = list.findIndex((t) => keyOf(t) === key);
  return i < 0 ? null : (list[i + 1] ?? null);
}

/** What useListen needs to know about an MP3 (src/core/audio/mp3play.ts), loaded only when a track plays. */
async function mp3Helpers() {
  const [{ mp3PlaybackInfo, withSeekTable }, { fileSource }] = await Promise.all([import('../core/audio/mp3play'), import('../core/audio/source')]);
  return { mp3PlaybackInfo, withSeekTable, fileSource };
}

/** The list whose track plays or loads now; starting one in another list stops it. */
let holder: { stop: () => void } | null = null;

interface Current {
  el: HTMLAudioElement | NativeAudio;
  /** The object URL the browser's player plays (none for NativeAudio). */
  url: string;
  /** The check that the clock moves (setInterval). */
  watch?: ReturnType<typeof setInterval>;
}

/** How long a playing player's clock may stand still before it is swapped, ms. */
const STALL_MS = 2000;
const WATCH_EVERY_MS = 500;
/** Fresh players per track for a clock that stands still. */
const MAX_REVIVALS = 2;

/** Takes the file away from a player, so it lets go of everything it holds. */
function unload(el: HTMLAudioElement | NativeAudio, url: string) {
  if (el instanceof NativeAudio) {
    el.release();
    return;
  }
  el.pause();
  el.removeAttribute?.('src');
  try {
    el.load?.();
  } catch {
    // Nothing to let go of.
  }
  URL.revokeObjectURL(url);
}

/** The type the browser needs to pick its decoder; blobs read from the card come without one. */
function typed(blob: Blob, name: string | undefined): Blob {
  if (blob.type && blob.type !== 'application/octet-stream') return blob;
  const ext = name?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const type = ext === 'mp3' || !ext ? 'audio/mpeg' : ext === 'm4a' || ext === 'm4b' || ext === 'mp4' ? 'audio/mp4' : ext === 'ogg' || ext === 'opus' || ext === 'oga' ? 'audio/ogg' : ext === 'flac' ? 'audio/flac' : ext === 'wav' ? 'audio/wav' : ext === 'aac' ? 'audio/aac' : '';
  return type ? new Blob([blob], { type }) : blob;
}

function isMp3(blob: Blob, name: string | undefined): boolean {
  return blob.type === 'audio/mpeg' || /\.mp3$/i.test(name ?? '');
}

/** The browser's player needs the bytes; a file on the card is read into memory for it. */
async function asBlob(data: Blob | ByteSource): Promise<Blob> {
  if (data instanceof Blob) return data;
  return data.blob ?? new Blob([(await data.read(0, data.size)) as BlobPart]);
}

/** The length to show: the list's, unless the exact one says otherwise by more than a second. */
export function shownLength(tagged: number | undefined, exact: number): number {
  return tagged !== undefined && Number.isFinite(tagged) && Math.abs(tagged - exact) <= 1 ? tagged : exact;
}

export function useListen(): {
  listen: Listening | null;
  /** `load` gives the track: a file of the card (ByteSource, opened where it is on the desktop) or data in memory. */
  toggle: (key: string, load: () => Promise<Blob | ByteSource>, opts?: ListenOptions) => Promise<void>;
  stop: () => void;
  isPlaying: (key: string) => boolean;
} {
  const [listen, setListen] = useState<Listening | null>(null);
  const current = useRef<Current | null>(null);
  // Counts starts and stops: a track that finishes loading after a newer
  // click, a stop or the list going away does not play.
  const gen = useRef(0);
  const me = useRef<{ stop: () => void }>({ stop: () => {} }).current;
  // The latest state, for event handlers made before it changed.
  const latest = useRef<Listening | null>(null);
  const show = (l: Listening | null) => {
    latest.current = l;
    setListen(l);
  };
  const letGo = () => {
    const cur = current.current;
    if (!cur) return;
    clearInterval(cur.watch);
    unload(cur.el, cur.url);
    current.current = null;
  };
  const release = () => {
    gen.current++;
    letGo();
    if (holder === me) holder = null;
  };
  const stop = () => {
    release();
    show(null);
  };
  me.stop = stop;
  useEffect(() => release, []);
  // The desktop player opens its output now, not at the first click.
  useEffect(() => nativePlayer()?.warm(), []);

  // A hidden page can neither be heard nor stopped.
  const shown = usePageShown();
  useEffect(() => {
    if (!shown) stop();
  }, [shown]);

  const fail = (e: unknown, code?: number) => {
    if (isAbort(e)) return;
    stop();
    const p = playProblem(e, code);
    toast.error(p.title, p.text);
  };

  const seekFor = (cur: Current) => (sec: number) => {
    if (current.current !== cur) return;
    cur.el.currentTime = Number.isFinite(sec) && sec > 0 ? sec : 0;
  };

  const toggle = async (key: string, load: () => Promise<Blob | ByteSource>, opts: ListenOptions = {}) => {
    // The same track again: pause, or go on where it stopped.
    if (listen?.key === key && current.current) {
      const a = current.current.el;
      if (listen.playing) a.pause();
      else await a.play().catch((e: unknown) => fail(e, a.error?.code));
      return;
    }
    return start(key, load, opts, false);
  };

  /** Starts a track of the list: clicked (`chained` false) or the next one after a track ended. */
  const start = async (key: string, load: () => Promise<Blob | ByteSource>, opts: ListenOptions, chained: boolean): Promise<void> => {
    if (holder && holder !== me) holder.stop();
    holder = me;
    const my = ++gen.current;
    // The old track goes quiet now, not only once the new one is read.
    current.current?.el.pause();
    const native = nativePlayer();
    // At the end of the track: the next one of the list, if there is one.
    const onEnd = opts.next
      ? () => {
          const n = opts.next?.();
          if (n) void start(n.key, n.load, n.opts ?? {}, true);
        }
      : undefined;
    if (native) return openNative(native, key, load, opts, my, onEnd);
    // The player is made while the click is still going on: browsers that
    // let sound start only on a click (Safari) remember it for this player,
    // though the file is read and checked before it plays.
    const fresh = new Audio();
    try {
      fresh.load();
    } catch {
      // Nothing to prepare.
    }
    let blob: Blob;
    let durationSec = opts.durationSec;
    try {
      blob = typed(await asBlob(await load()), opts.name);
    } catch (e) {
      if (my !== gen.current) return;
      stop();
      // Reading the file failed: the platform's message says why (German, with what to do).
      if (!isAbort(e)) toast.error('Datei lässt sich nicht lesen', e instanceof Error ? e.message : String(e));
      return;
    }
    if (my !== gen.current) return;
    if (isMp3(blob, opts.name)) {
      try {
        const { mp3PlaybackInfo, withSeekTable, fileSource } = await mp3Helpers();
        const info = await mp3PlaybackInfo(fileSource(blob, opts.name), opts.durationSec);
        if (info.index) blob = withSeekTable(blob, info.index);
        if (info.durationSec !== undefined) durationSec = info.durationSec;
      } catch {
        // The browser's own idea of the length stays.
      }
      if (my !== gen.current) return;
    }
    letGo();
    await open(key, blob, durationSec, my, Math.max(0, opts.startSec ?? 0), 0, { prepared: fresh, quiet: chained, onEnd });
  };

  /** The desktop app's own player: no copy into memory, no stall watch, the exact length from the backend. */
  const openNative = async (player: PlayerAccess, key: string, load: () => Promise<Blob | ByteSource>, opts: ListenOptions, my: number, onEnd?: () => void): Promise<void> => {
    // Made at the click, like the browser's player (nothing to remember here, but the order stays the same).
    const a = new NativeAudio(player);
    let data: Blob | ByteSource;
    try {
      data = await load();
    } catch (e) {
      if (my !== gen.current) return;
      stop();
      if (!isAbort(e)) toast.error('Datei lässt sich nicht lesen', e instanceof Error ? e.message : String(e));
      return;
    }
    if (my !== gen.current) return;
    letGo();
    a.setSource(data, opts.name);
    const cur: Current = { el: a, url: '' };
    const mine = () => current.current === cur;
    let durationSec = opts.durationSec;
    const base = (): Listening => ({ key, audio: a, playing: !a.paused, durationSec, seek: seekFor(cur) });
    a.addEventListener('play', () => mine() && show({ ...base(), playing: true }));
    a.addEventListener('pause', () => mine() && show({ ...base(), playing: false }));
    a.addEventListener('ended', () => mine() && onEnd?.());
    a.addEventListener('durationchange', () => {
      if (!mine() || !Number.isFinite(a.duration)) return;
      durationSec = shownLength(opts.durationSec, a.duration);
      show(base());
    });
    // Broken off while playing (a damaged file, the card pulled out): the backend says why, in German.
    a.addEventListener('error', () => mine() && !a.paused && fail(a.error ?? new DOMException('', 'MediaError'), a.error?.code));
    current.current = cur;
    show({ key, audio: a, playing: false, durationSec, seek: seekFor(cur) });
    try {
      await a.play();
    } catch (e) {
      if (my !== gen.current || current.current !== cur) return;
      fail(e);
    }
  };

  /**
   * Starts a player for `blob` at `at` seconds; it watches its clock (see above).
   * `quiet`: a refusal to start without a click leaves it waiting, without a message (the next track of a list).
   */
  const open = async (key: string, blob: Blob, durationSec: number | undefined, my: number, at: number, revivals: number, more: { prepared?: HTMLAudioElement; quiet?: boolean; onEnd?: () => void } = {}): Promise<void> => {
    const { prepared, quiet, onEnd } = more;
    // One player per try; a refused first try gets a second with a fresh one.
    for (let attempt = 0; ; attempt++) {
      const url = URL.createObjectURL(blob);
      const a = attempt === 0 && prepared ? prepared : new Audio();
      a.preload = 'auto';
      const cur: Current = { el: a, url };
      const mine = () => current.current === cur;
      const base = (): Listening => ({ key, audio: a, playing: !a.paused, durationSec, seek: seekFor(cur) });
      a.addEventListener('play', () => mine() && show({ ...base(), playing: true }));
      a.addEventListener('pause', () => mine() && show({ ...base(), playing: false }));
      a.addEventListener('ended', () => mine() && onEnd?.());
      // Broken off while playing (a damaged file, the card pulled out): say so in German.
      a.addEventListener('error', () => mine() && !a.paused && fail(new DOMException('', 'MediaError'), a.error?.code));
      a.src = url;
      if (at > 0) {
        a.currentTime = at;
        // WebKitGTK may know only a sliver of the file when it starts and puts the player at 0:
        // once more each time it learns more of the length, until the place is reached (a few seconds at most).
        const again = () => {
          if (!mine() || a.currentTime >= at - 0.5) return a.removeEventListener('durationchange', again);
          if (a.duration > at) a.currentTime = at;
        };
        a.addEventListener('durationchange', again);
        setTimeout(() => a.removeEventListener('durationchange', again), 5000);
      }
      current.current = cur;
      show({ key, audio: a, playing: false, durationSec, seek: seekFor(cur) });
      try {
        await a.play();
      } catch (e) {
        if (my !== gen.current || current.current !== cur) return;
        // A fresh player for a stuck one, or the next track of a list, refused
        // where sound needs a click: it waits at its spot for the next click on play.
        if ((revivals > 0 || quiet) && e instanceof DOMException && e.name === 'NotAllowedError') return;
        const code = a.error?.code;
        letGo();
        if (attempt === 0 && isNotSupported(e)) continue;
        fail(e, code);
        return;
      }
      if (my !== gen.current || current.current !== cur) return;
      if (revivals < MAX_REVIVALS) {
        let last = a.currentTime;
        let still = 0;
        cur.watch = setInterval(() => {
          if (current.current !== cur) return clearInterval(cur.watch);
          const moved = a.currentTime !== last;
          last = a.currentTime;
          still = moved || a.paused || a.ended || a.seeking ? 0 : still + WATCH_EVERY_MS;
          if (still < STALL_MS) return;
          letGo();
          void open(key, blob, durationSec, my, last, revivals + 1, { onEnd });
        }, WATCH_EVERY_MS);
      }
      return;
    }
  };

  return { listen, toggle, stop, isPlaying: (key) => listen?.key === key && listen.playing };
}
