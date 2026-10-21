/**
 * A short "Pling" when the SD card is finished: albums on the card, a card
 * rebuilt or copied, the announcements installed. Only there (see
 * DoneOccasion), never for stickers, firmware, errors, repairs, renaming,
 * saving or other small steps: Frank wants it to mean "the card is ready". Settings >
 * "Töne" switches it off.
 *
 * With a box SD card in, it plays the box's own short sound (advert/0262.mp3
 * on TonUINO TNG cards), straight from the card at run time. That sound is
 * not the app's: it is never bundled, copied, uploaded or saved anywhere,
 * only read from the user's own card into memory and played. Without it the
 * app plays a soft two-note chime made with Web Audio (no audio files).
 *
 * In the Paket mode (Firefox, Safari) the app writes nothing on the card
 * itself: albums, a rebuild or announcements only go into the Paket. Then the
 * "Pling" waits until the Paket is checked on the card ('package').
 *
 * Besides it there are two small knocks (playCue), also made with Web Audio
 * and much quieter: "Klack" when an NFC card is written at the USB reader,
 * and a double knock when every point of "Box testen" has arrived. They never
 * use the box's sound; that one is for the finished SD card only. The same
 * switch "Töne" turns them off.
 *
 * Everything fails silently: a browser that blocks sound, a card that cannot
 * be read, an environment without audio (tests in Node) just stay quiet.
 */
import type { SdScan } from '../core/tonuino/sd';
import { card, settings } from '../app/state';
import { nativePlayer, openPlayer } from './nativeAudio';

/**
 * The big completions that may play the "Pling". Everything else stays
 * quiet; a new occasion is a deliberate decision, not a habit.
 */
export type DoneOccasion =
  /** Albums written to the card (Hinzufügen). */
  | 'songs'
  /** A Paket checked on the card: the web app's way of getting songs there. */
  | 'package'
  /** A card rebuilt from its backup. */
  | 'rebuild'
  /** A whole card copied to another one. */
  | 'copy'
  /** The box's announcements installed. */
  | 'sounds';

/** Number of the box's short sound in advert/ (TonUINO TNG). */
export const BOX_SOUND_NUMBER = 262;
/** A short sound is a few kB; anything bigger is not the "Pling" and is not read. */
export const BOX_SOUND_MAX_BYTES = 512 * 1024;
/** Two completions closer than this give one sound. */
export const MIN_GAP_MS = 4000;
/** Volume of the box's sound: moderate, it is a signal, not music. */
export const BOX_SOUND_VOLUME = 0.45;

/** Where the box's sound lies on a scanned card, or null when it has none. */
export function findBoxSound(scan: SdScan | undefined | null): { dir: string; file: string; size: number } | null {
  const advert = scan?.system.advert;
  if (!advert) return null;
  const t = advert.files.find((f) => f.number === BOX_SOUND_NUMBER && f.ext === 'mp3');
  if (!t || t.size <= 0 || t.size > BOX_SOUND_MAX_BYTES) return null;
  return { dir: advert.dirName, file: t.name, size: t.size };
}

export type FilePlay = 'played' | 'unsupported' | 'blocked';

export interface DoneSoundDeps {
  /** The "Töne" switch. */
  enabled(): boolean;
  /** The open card is in the Paket mode: writing only fills the Paket, nothing is on the card yet. */
  packageMode?(): boolean;
  /** Whether this environment can play sound at all. */
  canPlay(): boolean;
  /** The box's sound from the connected card, or null. */
  boxSound(): Promise<Blob | null>;
  /** Plays a sound file: 'unsupported' when it cannot be decoded here, 'blocked' when the browser does not allow sound. */
  playFile(data: Blob): Promise<FilePlay>;
  /** Plays the synthesized chime. */
  playChime(): Promise<void>;
  now(): number;
}

/** The player, with everything it touches passed in (tests use fakes). */
export function createDoneSound(deps: DoneSoundDeps): (occasion: DoneOccasion) => Promise<void> {
  let last = -Infinity;
  return async (occasion: DoneOccasion) => {
    try {
      if (!deps.enabled() || !deps.canPlay()) return;
      // In the Paket mode only the checked Paket is on the card.
      if (occasion !== 'package' && deps.packageMode?.()) return;
      const now = deps.now();
      if (now - last < MIN_GAP_MS) return;
      last = now;
      const data = await deps.boxSound().catch(() => null);
      if (data) {
        const played = await deps.playFile(data).catch((): FilePlay => 'unsupported');
        // Blocked: the chime would be blocked too.
        if (played !== 'unsupported') return;
      }
      await deps.playChime();
    } catch {
      // No sound is no problem.
    }
  };
}

/* ------------------------------------------------------------------ browser */

function hasAudio(): boolean {
  return typeof window !== 'undefined' && (typeof window.AudioContext === 'function' || typeof Audio === 'function');
}

async function readBoxSound(): Promise<Blob | null> {
  const s = card.peek();
  if (!s || s.status !== 'ready') return null;
  const found = findBoxSound(s.scan);
  if (!found) return null;
  const dir = await s.volume.root.dir(found.dir);
  const bytes = await dir.read(found.file);
  if (!bytes.length || bytes.length > BOX_SOUND_MAX_BYTES) return null;
  return new Blob([bytes as BlobPart], { type: 'audio/mpeg' });
}

async function playBlob(data: Blob): Promise<FilePlay> {
  // The desktop app plays it with its own player, the browser with an <audio> it lets go of afterwards (see openPlayer).
  if (typeof Audio !== 'function' && !nativePlayer()) return 'unsupported';
  const { el: a, free } = await openPlayer(data, 'pling.mp3');
  a.volume = BOX_SOUND_VOLUME;
  a.addEventListener('ended', free, { once: true });
  a.addEventListener('error', free, { once: true });
  // In case neither comes: the sound is short.
  setTimeout(free, 15000);
  try {
    await a.play();
    return 'played';
  } catch (e) {
    free();
    return e instanceof DOMException && e.name === 'NotAllowedError' ? 'blocked' : 'unsupported';
  }
}

let context: AudioContext | null = null;

/** Two soft notes, a fifth apart, upwards: done. */
async function playChime(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return;
  context ??= new AudioContext();
  const ctx = context;
  if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
  if (ctx.state !== 'running') return;
  const start = ctx.currentTime + 0.02;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(ctx.destination);
  const note = (freq: number, at: number, length: number, level: number) => {
    // A sine with a quiet octave on top: round, a little like a small bell.
    for (const [mult, share] of [
      [1, 1],
      [2, 0.18],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(level * share, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + length);
      osc.connect(g).connect(out);
      osc.start(at);
      osc.stop(at + length + 0.05);
    }
  };
  note(783.99, start, 0.5, 0.13); // G5
  note(1046.5, start + 0.13, 0.75, 0.11); // C6
  setTimeout(() => out.disconnect(), 1500);
}

/** Plays the "Pling" for a big completion. Never throws, never waits for the sound. */
export const playDoneSound: (occasion: DoneOccasion) => Promise<void> = createDoneSound({
  enabled: () => settings.peek().doneSound,
  packageMode: () => card.peek()?.volume.access === 'snapshot',
  canPlay: hasAudio,
  boxSound: readBoxSound,
  playFile: playBlob,
  playChime,
  now: () => Date.now(),
});

/* ------------------------------------------------------------------ small knocks */

/**
 * Small signals that are no "Pling": the card is not the SD card, and the
 * box test is not a finished card. Made with Web Audio only.
 */
export type CueOccasion =
  /** An NFC card was written at the USB reader (one "Klack"). */
  | 'cardWritten'
  /** Every point of "Box testen" has arrived (two knocks, upwards). */
  | 'testDone';

/**
 * Shortest time between two cues of the same kind. Cards are written quickly
 * one after the other, so the Klack may come often; the test's knock once.
 */
export const CUE_GAP_MS: Record<CueOccasion, number> = { cardWritten: 500, testDone: 4000 };

/** Level of a knock: about half of the chime's 0.13. */
export const KNOCK_LEVEL = 0.07;

export interface CueDeps {
  enabled(): boolean;
  canPlay(): boolean;
  /** Plays one knock: `pitch` 1 is the Klack, higher is brighter. */
  knock(at: number, pitch: number): Promise<void> | void;
  now(): number;
}

/** The cue player, with everything it touches passed in (tests use fakes). */
export function createCue(deps: CueDeps): (occasion: CueOccasion) => Promise<void> {
  const last: Record<CueOccasion, number> = { cardWritten: -Infinity, testDone: -Infinity };
  return async (occasion: CueOccasion) => {
    try {
      if (!deps.enabled() || !deps.canPlay()) return;
      const now = deps.now();
      if (now - last[occasion] < CUE_GAP_MS[occasion]) return;
      last[occasion] = now;
      if (occasion === 'cardWritten') await deps.knock(0, 1);
      else {
        await deps.knock(0, 1);
        await deps.knock(0.14, 1.3);
      }
    } catch {
      // No sound is no problem.
    }
  };
}

/**
 * A short wooden knock, about 60 ms: a burst of noise around 1.8 kHz for the
 * click of the wood, and a low sine around 220 Hz that dies away quickly for
 * its body. `delay` in seconds from now.
 */
async function knock(delay: number, pitch: number): Promise<void> {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return;
  context ??= new AudioContext();
  const ctx = context;
  if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
  if (ctx.state !== 'running') return;
  const at = ctx.currentTime + 0.01 + delay;
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);

  // The click: 40 ms of noise through a band filter.
  const length = Math.round(ctx.sampleRate * 0.04);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1800 * pitch;
  band.Q.value = 4;
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(KNOCK_LEVEL * 1.6, at);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
  noise.connect(band).connect(clickGain).connect(out);
  noise.start(at);
  noise.stop(at + 0.05);

  // The body: a low sine, gone after about 60 ms.
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(220 * pitch, at);
  osc.frequency.exponentialRampToValueAtTime(160 * pitch, at + 0.06);
  const body = ctx.createGain();
  body.gain.setValueAtTime(0.0001, at);
  body.gain.exponentialRampToValueAtTime(KNOCK_LEVEL, at + 0.004);
  body.gain.exponentialRampToValueAtTime(0.0001, at + 0.065);
  osc.connect(body).connect(out);
  osc.start(at);
  osc.stop(at + 0.08);
  setTimeout(() => out.disconnect(), (delay + 0.5) * 1000);
}

/** Plays a small knock. Never throws, never waits for the sound. Off with the switch "Töne". */
export const playCue: (occasion: CueOccasion) => Promise<void> = createCue({
  enabled: () => settings.peek().doneSound,
  canPlay: () => typeof window !== 'undefined' && typeof window.AudioContext === 'function',
  knock,
  now: () => Date.now(),
});
