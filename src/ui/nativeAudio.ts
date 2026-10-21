/**
 * The desktop app's own player (src-tauri/src/player) dressed as an <audio>
 * element: the same properties and events, so "Anhören", the seek bar and
 * the measuring mode work with either. The web app and the Android app keep
 * the browser's player; only the desktop platform has `player`.
 *
 * The backend says four times a second where the sound is (and at once
 * after a start, a jump, a pause and the end). In between the clock moves on
 * by itself, and "timeupdate" comes often enough that a bar moves smoothly
 * on a fast screen: about every 1/2000 of the track, at least four times a
 * second, never more than once per frame. No message crosses for that.
 *
 * Differences that matter: a file on disk is opened by the backend (only
 * its path crosses over), and jumps land on the exact sample.
 */
import type { ByteSource, PlayerAccess, PlayerEvent, PlayerLoaded } from '../platform/types';
import { platform } from '../app/state';
import { toast } from './components/Toast';

/** What "Anhören", the seek bar and the measuring mode use of a player: the browser's <audio> or NativeAudio. */
export interface MediaLike {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  volume: number;
  readonly error: { code: number; message?: string } | null;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: () => void, options?: boolean | EventListenerOptions): void;
}

/** MediaError codes, as the browser's player has them. */
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;

/** How far the clock may run on without news from the backend (a hanging output must not run away). */
const MAX_COAST_SEC = 0.75;
/** A report this much behind the running clock moves the bar back; smaller ones only stop it for a moment. */
const BACK_SEC = 0.04;

/** The player of this platform, or null where the browser plays. */
export function nativePlayer(): PlayerAccess | null {
  return platform.peek()?.player ?? null;
}

/** What the measuring mode reads (src/app/measure.ts): the last player that started, and what it did. */
export interface PlayerStats {
  kind: 'rust';
  /** Where the data came from: a file the backend opened, or memory sent over. */
  source?: 'datei' | 'speicher';
  /** From play() to the answer of the load (file opened, first packets decoded). */
  loadMs?: number;
  /** The backend's count from the command to the first sound given to the output. */
  firstSoundMs?: number;
  /** From play() until the 'playing' event reached the page. */
  playingMs?: number;
  /** Sound missing so far because decoding fell behind. */
  gapMs?: number;
  /** From setting currentTime to 'seeked', per jump. */
  seekMs: number[];
}

let lastStarted: NativeAudio | null = null;

/** The NativeAudio that started last (measuring mode). */
export function lastNativeAudio(): NativeAudio | null {
  return lastStarted;
}

/** Says once per loss that the sound stopped (all voices pause; one message is enough). */
const watched = new WeakSet<PlayerAccess>();
function watchDevice(player: PlayerAccess) {
  if (watched.has(player)) return;
  watched.add(player);
  player.onEvent((e) => {
    if (e.kind !== 'device') return;
    const text =
      e.code === 'no-device'
        ? 'Am Computer ist gerade kein Lautsprecher und kein Kopfhörer zu finden. Schließe einen an und klicke noch einmal auf Abspielen.'
        : 'Der Kopfhörer oder Lautsprecher ist weg, darum hab ich angehalten. Klicke wieder auf Abspielen, dann geht es an derselben Stelle weiter.';
    toast.error('Ton angehalten', text);
  });
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const nextFrame = (cb: () => void): unknown => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16));
const cancelFrame = (id: unknown) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id as number) : clearTimeout(id as ReturnType<typeof setTimeout>));

type Source = { blob: Blob; name: string } | { source: ByteSource; name: string };

export class NativeAudio extends EventTarget implements MediaLike {
  /** Ignored: the backend reads ahead by itself. Here so code written for <audio> may set it. */
  preload = '';
  error: { code: number; message: string; german: true } | null = null;
  readonly stats: PlayerStats = { kind: 'rust', seekMs: [] };

  private src: Source | null = null;
  private voice: number | null = null;
  private track = 0;
  /** Bumped by every new source and release: answers for an older one are dropped. */
  private gen = 0;
  private loading: Promise<PlayerLoaded | null> | null = null;
  private off: (() => void) | null = null;
  private isPaused = true;
  private isEnded = false;
  private seekTo: number | null = null;
  private seekAt = 0;
  private startAt = 0;
  private dur = Number.NaN;
  private vol = 1;
  /** The clock: `sec` at `at` (performance.now()), moving on while playing. */
  private anchor = { sec: 0, at: 0 };
  private frame: unknown = null;
  private shownAt = -1;
  private shownWhen = 0;
  private playAsked = 0;

  constructor(private readonly player: PlayerAccess) {
    super();
    watchDevice(player);
  }

  /** What to play: data in memory or a file (a ByteSource with a path is opened by the backend). Lets go of the one before. */
  setSource(source: Blob | ByteSource, name = 'audio.mp3'): void {
    this.release();
    this.src = source instanceof Blob ? { blob: source, name } : { source, name: source.name || name };
  }

  get currentTime(): number {
    if (this.seekTo !== null) return this.seekTo;
    if (this.isPaused || this.voice === null) return this.anchor.sec;
    const t = this.anchor.sec + Math.min(MAX_COAST_SEC, Math.max(0, (now() - this.anchor.at) / 1000));
    return Number.isFinite(this.dur) ? Math.min(t, this.dur) : t;
  }

  set currentTime(v: number) {
    const sec = Number.isFinite(v) && v > 0 ? (Number.isFinite(this.dur) ? Math.min(v, this.dur) : v) : 0;
    this.isEnded = false;
    if (this.voice === null) {
      // Not loaded yet: the start place, as for a browser's player before it has its file.
      this.startAt = sec;
      this.setAnchor(sec);
      return;
    }
    this.seekTo = sec;
    this.seekAt = now();
    this.setAnchor(sec);
    this.fire('seeking');
    this.fire('timeupdate');
    void this.player.seek(this.voice, sec).catch((e: unknown) => this.failed(e));
  }

  get duration(): number {
    return this.dur;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get ended(): boolean {
    return this.isEnded;
  }

  get seeking(): boolean {
    return this.seekTo !== null;
  }

  get volume(): number {
    return this.vol;
  }

  set volume(v: number) {
    this.vol = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
    if (this.voice !== null) void this.player.volume(this.voice, this.vol).catch(() => undefined);
    this.fire('volumechange');
  }

  async play(): Promise<void> {
    if (!this.src) throw new DOMException('Nothing to play', 'NotSupportedError');
    const wasPaused = this.isPaused;
    this.isPaused = false;
    this.playAsked = now();
    lastStarted = this;
    if (wasPaused) this.fire('play');
    if (this.voice === null) {
      const loaded = await this.load(true);
      // Paused or let go while it loaded.
      if (loaded && this.isPaused && this.voice !== null) await this.player.pause(this.voice).catch(() => undefined);
      return;
    }
    if (this.isEnded) {
      this.isEnded = false;
      this.setAnchor(0);
    }
    try {
      await this.player.play(this.voice);
    } catch (e) {
      this.isPaused = true;
      this.fire('pause');
      throw e;
    }
    this.setAnchor(this.anchor.sec);
    this.fire('playing');
    this.tick();
  }

  pause(): void {
    if (this.isPaused) return;
    this.setAnchor(this.currentTime);
    this.isPaused = true;
    this.stopTicking();
    if (this.voice !== null) void this.player.pause(this.voice).catch(() => undefined);
    this.fire('pause');
  }

  /** Like <audio>.load(): lets go of what was loaded (the source stays). */
  load(): Promise<PlayerLoaded | null>;
  load(play: boolean): Promise<PlayerLoaded | null>;
  load(play?: boolean): Promise<PlayerLoaded | null> {
    if (play === undefined) {
      this.unloadVoice();
      return Promise.resolve(null);
    }
    this.loading ??= this.open(play);
    return this.loading;
  }

  /** Like removeAttribute('src') on <audio>: lets go of the file. */
  removeAttribute(name: string): void {
    if (name === 'src') this.release();
  }

  /** Lets go of the voice and the source. */
  release(): void {
    this.unloadVoice();
    this.src = null;
  }

  private unloadVoice() {
    this.gen++;
    this.stopTicking();
    this.off?.();
    this.off = null;
    if (this.voice !== null) void this.player.close(this.voice).catch(() => undefined);
    this.voice = null;
    this.loading = null;
    this.seekTo = null;
    if (!this.isPaused) {
      this.isPaused = true;
      this.fire('pause');
    }
  }

  private async open(play: boolean): Promise<PlayerLoaded | null> {
    const my = this.gen;
    const src = this.src!;
    const t0 = now();
    let loaded: PlayerLoaded;
    try {
      let data: Uint8Array | null = null;
      if ('blob' in src) data = new Uint8Array(await src.blob.arrayBuffer());
      else if (!src.source.path) data = src.source.blob ? new Uint8Array(await src.source.blob.arrayBuffer()) : await src.source.read(0, src.source.size);
      if (my !== this.gen) return null;
      this.stats.source = data ? 'speicher' : 'datei';
      const opts = { at: this.startAt, play: play && !this.isPaused, volume: this.vol };
      // Listening before the load, so the first events are not missed.
      this.off = this.player.onEvent((e) => this.onEvent(e));
      loaded = await this.player.load(data ? { data, name: src.name } : { path: (src as { source: ByteSource }).source.path!, name: src.name }, opts);
    } catch (e) {
      if (my !== this.gen) return null;
      this.loading = null;
      this.off?.();
      this.off = null;
      this.isPaused = true;
      this.fire('pause');
      throw e;
    }
    if (my !== this.gen) {
      void this.player.close(loaded.voice).catch(() => undefined);
      return null;
    }
    this.stats.loadMs = Math.round(now() - t0);
    this.voice = loaded.voice;
    this.track = loaded.track;
    if (loaded.durationSec > 0) {
      this.dur = loaded.durationSec;
      this.fire('durationchange');
      this.fire('loadedmetadata');
    }
    this.setAnchor(this.startAt);
    if (!this.isPaused) this.tick();
    return loaded;
  }

  private onEvent(e: PlayerEvent) {
    if (e.voice !== this.voice || this.voice === null) return;
    switch (e.kind) {
      case 'started':
        if (e.track !== this.track) {
          // The queued track took over without a gap.
          this.track = e.track;
          this.fire('trackchange');
        }
        if (this.seekTo === null) this.setAnchor(e.posSec);
        if (e.startMs !== undefined) {
          this.stats.firstSoundMs = Math.round(e.startMs * 10) / 10;
          this.stats.playingMs = Math.round(now() - this.playAsked);
        }
        this.fire('playing');
        break;
      case 'pos':
        if (this.seekTo !== null || this.isPaused) break;
        if (e.gapMs !== undefined) this.stats.gapMs = Math.round(e.gapMs);
        this.follow(e.posSec);
        break;
      case 'seeked':
        // Only the last jump counts; one dragged over the bar sends several.
        if (this.seekTo === null || Math.abs(e.posSec - this.seekTo) > 0.002) break;
        this.stats.seekMs.push(Math.round(now() - this.seekAt));
        this.seekTo = null;
        this.setAnchor(e.posSec);
        this.fire('seeked');
        this.fire('timeupdate');
        break;
      case 'paused':
        this.setAnchor(e.posSec);
        // Paused by the backend (the output is gone), not by a click.
        if (!this.isPaused) {
          this.isPaused = true;
          this.stopTicking();
          this.fire('pause');
        }
        this.fire('timeupdate');
        break;
      case 'duration':
        if (e.durationSec !== undefined && e.durationSec > 0) {
          this.dur = e.durationSec;
          this.fire('durationchange');
        }
        break;
      case 'ended':
        if (e.track !== this.track || e.playing) break;
        this.seekTo = null;
        this.isEnded = true;
        this.isPaused = true;
        this.stopTicking();
        if (Number.isFinite(this.dur)) this.setAnchor(this.dur);
        this.fire('timeupdate');
        this.fire('pause');
        this.fire('ended');
        break;
      case 'error': {
        const code = e.code ?? 'decode-failed';
        this.error = { code: code === 'io' || code === 'not-found' ? MEDIA_ERR_NETWORK : MEDIA_ERR_DECODE, message: errorText(code), german: true };
        // Like a browser's player: still "playing" when the error comes, so the page knows it broke off.
        this.fire('error');
        if (!this.isPaused) {
          this.isPaused = true;
          this.stopTicking();
          this.fire('pause');
        }
        break;
      }
    }
  }

  /** A report of the backend: the clock follows it, but does not jump back for a hair. */
  private follow(sec: number) {
    const shown = this.currentTime;
    this.setAnchor(sec < shown && shown - sec < BACK_SEC ? shown : sec);
  }

  private setAnchor(sec: number) {
    this.anchor = { sec, at: now() };
  }

  private failed(e: unknown) {
    const code = typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'other';
    // A voice let go of in the meantime is no error.
    if (code === 'closed') return;
    this.error = { code: MEDIA_ERR_DECODE, message: e instanceof Error ? e.message : errorText(code), german: true };
    this.fire('error');
  }

  /** "timeupdate" while playing: often enough for a smooth bar, not more (see above). */
  private tick() {
    if (this.frame !== null) return;
    const loop = () => {
      this.frame = null;
      if (this.isPaused || this.voice === null) return;
      const t = this.currentTime;
      const step = Number.isFinite(this.dur) && this.dur > 0 ? this.dur / 2000 : 0.05;
      const when = now();
      if (Math.abs(t - this.shownAt) >= Math.min(step, 0.25) || when - this.shownWhen >= 250) {
        this.shownAt = t;
        this.shownWhen = when;
        this.fire('timeupdate');
      }
      this.frame = nextFrame(loop);
    };
    this.frame = nextFrame(loop);
  }

  private stopTicking() {
    if (this.frame !== null) cancelFrame(this.frame);
    this.frame = null;
  }

  private fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

/** What the page says when the player stops with an error (codes of src-tauri/src/player and the audio area). */
function errorText(code: string): string {
  switch (code) {
    case 'unsupported-format':
      return 'Dieses Format kann der Computer nicht abspielen. Wandle die Datei zum Beispiel in MP3 um.';
    case 'drm-protected':
      return 'Diese Datei ist kopiergeschützt. Solche Dateien lassen sich hier nicht abspielen.';
    case 'io':
    case 'not-found':
      return 'Die Datei ließ sich nicht zu Ende lesen. Steckt die SD-Karte noch? Versuche es noch einmal.';
    default:
      return 'Die Datei ist beschädigt oder in einem Format, das dieser Computer nicht abspielen kann. Probiere einen anderen Titel.';
  }
}

/**
 * A player for one sound of a dialog (a cut, an announcement, a recording,
 * the box's "Pling"): the desktop app's own where there is one, else an
 * <audio> with an object URL. `free` lets go of everything: the file, the
 * URL, and WebKitGTK's pipeline, which a paused <audio> keeps (useListen.ts).
 * A file of the card (ByteSource) is opened where it is on the desktop and
 * read into memory only for the browser.
 */
export async function openPlayer(data: Blob | ByteSource, name: string, type = 'audio/mpeg'): Promise<{ el: MediaLike; free: () => void }> {
  const native = nativePlayer();
  if (native) {
    const el = new NativeAudio(native);
    el.setSource(data, name);
    return { el, free: () => el.release() };
  }
  let blob = data instanceof Blob ? data : (data.blob ?? new Blob([(await data.read(0, data.size)) as BlobPart]));
  if (!blob.type || blob.type === 'application/octet-stream') blob = new Blob([blob], { type });
  const url = URL.createObjectURL(blob);
  const el = new Audio();
  el.preload = 'auto';
  el.src = url;
  let freed = false;
  return {
    el,
    free: () => {
      if (freed) return;
      freed = true;
      el.pause();
      el.removeAttribute('src');
      try {
        el.load();
      } catch {
        // Nothing to let go of.
      }
      URL.revokeObjectURL(url);
    },
  };
}
