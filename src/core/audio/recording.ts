/**
 * Recording from the microphone ("Selbst aufnehmen", an extra of the
 * settings page): grandma reads a story aloud, or a child records its own
 * announcement. The page taps the microphone's PCM (AudioWorklet) and hands
 * it here block by block; the result is a WAV file that goes through the
 * import like a file picked on the computer (converted, loudness matched).
 *
 * Plain code without DOM, so the tests can feed it blocks.
 */

/** Longest recording: 30 minutes at 48 kHz are about 170 MB in memory. Longer readings become several tracks. */
export const MAX_RECORDING_SEC = 30 * 60;
/** The meter shows this range: -60 dBFS is the left end, 0 dBFS the right one. */
export const METER_FLOOR_DB = -60;
/** Peaks above this: too loud, it may distort. */
export const TOO_LOUD_DB = -1;
/** Speech whose peaks stay below this for a few seconds: too quiet. */
export const TOO_QUIET_DB = -36;

/** Peak level of a block in dBFS (-Infinity for silence). */
export function peakDb(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
}

/** Where the meter's bar ends for a level, 0..1. */
export function meterFraction(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/** What the meter says about the last seconds, if anything. */
export function levelAdvice(recentPeaksDb: readonly number[]): 'loud' | 'quiet' | null {
  if (!recentPeaksDb.length) return null;
  const top = Math.max(...recentPeaksDb);
  if (top >= TOO_LOUD_DB) return 'loud';
  return top < TOO_QUIET_DB ? 'quiet' : null;
}

/** The 44 bytes in front of 16-bit PCM in a WAV file. */
export function wavHeader(sampleRate: number, channels: number, dataBytes: number): Uint8Array {
  const out = new Uint8Array(44);
  const v = new DataView(out.buffer);
  const put = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  put(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  put(36, 'data');
  v.setUint32(40, dataBytes, true);
  return out;
}

/**
 * The microphone's PCM, mixed to mono and kept as 16-bit samples (half the
 * memory of floats). Stops taking blocks at MAX_RECORDING_SEC.
 */
export class PcmRecording {
  private readonly blocks: Int16Array[] = [];
  private samples = 0;

  constructor(readonly sampleRate: number) {}

  /** Adds a block; false once the recording is full (nothing more is kept). */
  push(channels: readonly Float32Array[]): boolean {
    const n = channels[0]?.length ?? 0;
    const room = Math.max(0, Math.round(MAX_RECORDING_SEC * this.sampleRate) - this.samples);
    const take = Math.min(n, room);
    if (take > 0) {
      const out = new Int16Array(take);
      const k = channels.length;
      for (let i = 0; i < take; i++) {
        let sum = 0;
        for (let c = 0; c < k; c++) sum += channels[c][i];
        const v = (sum / k) * 32767;
        out[i] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : Math.round(v);
      }
      this.blocks.push(out);
      this.samples += take;
    }
    return take === n && this.samples < MAX_RECORDING_SEC * this.sampleRate;
  }

  get durationSec(): number {
    return this.samples / this.sampleRate;
  }

  get full(): boolean {
    return this.samples >= Math.round(MAX_RECORDING_SEC * this.sampleRate);
  }

  /** The recording as a WAV file (16-bit mono). */
  toWav(): Blob {
    const parts: BlobPart[] = [wavHeader(this.sampleRate, 1, this.samples * 2) as BlobPart];
    for (const b of this.blocks) parts.push(b as BlobPart);
    return new Blob(parts, { type: 'audio/wav' });
  }
}

/**
 * The file name for a recording called `title`: what is not allowed in file
 * names on the card or the computer goes; empty becomes "Aufnahme" with the
 * date and time of `now`.
 */
export function recordingFileName(title: string, now: Date = new Date()): string {
  const clean = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  const two = (n: number) => String(n).padStart(2, '0');
  const fallback = `Aufnahme ${two(now.getDate())}.${two(now.getMonth() + 1)}.${now.getFullYear()} ${two(now.getHours())}-${two(now.getMinutes())}`;
  return `${clean || fallback}.wav`;
}
