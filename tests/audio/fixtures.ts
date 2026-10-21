/** Small MP3 fixtures, encoded once per test file with lamejs. */
import { buildXingFrame } from '../../src/core/audio/mp3cut';
import { concat, encodeMp3, synth, type Segment } from './helpers';

export const SR = 44100;

/** 12 s: tone bursts with silences at 2–3 s, 6–7 s and 9–10 s. */
export const BURSTS: Segment[] = [
  { sec: 2, freq: 440 },
  { sec: 1 },
  { sec: 3, freq: 660 },
  { sec: 1 },
  { sec: 2, freq: 550 },
  { sec: 1 },
  { sec: 2, freq: 880 },
];

const cache = new Map<string, Uint8Array>();

function cached(key: string, make: () => Uint8Array): Uint8Array {
  let v = cache.get(key);
  if (!v) {
    v = make();
    cache.set(key, v);
  }
  return v;
}

/** MPEG1 Layer III, 44.1 kHz mono, 64 kbps CBR, 12 s. */
export function monoMp3(): Uint8Array {
  return cached('mono', () => encodeMp3([synth(SR, BURSTS)], SR, 64));
}

/** MPEG1 Layer III, 44.1 kHz stereo, 128 kbps CBR, 3 s (440 Hz left, 660 Hz right). */
export function stereoMp3(): Uint8Array {
  return cached('stereo', () =>
    encodeMp3([synth(SR, [{ sec: 3, freq: 440, amp: 0.25 }]), synth(SR, [{ sec: 3, freq: 660, amp: 0.2 }])], SR, 128),
  );
}

/** MPEG2 Layer III (LSF), 22.05 kHz mono, 32 kbps CBR, 4 s. */
export function lsfMp3(): Uint8Array {
  return cached('lsf', () => encodeMp3([synth(22050, [{ sec: 1.5, freq: 300 }, { sec: 1 }, { sec: 1.5, freq: 500 }])], 22050, 32));
}

/**
 * A mono 44.1 kHz file as LAME writes it: an Info frame that counts `frames`
 * frames, with encoder delay 576 and padding 1500, then the frames.
 */
export function withInfoFrame(mp3: Uint8Array, frames: number): Uint8Array {
  const info = buildXingFrame(
    { version: 1, sampleRate: SR, channelMode: 3, bitrateKbps: 64 },
    { kind: 'Info', frames, audioBytes: mp3.length, lame: { encoderDelay: 576, padding: 1500, encoder: 'LAME3.100' } },
  );
  return concat([info, mp3]);
}

/** MPEG1 Layer III, 44.1 kHz mono, 96 kbps CBR, 2 s (to mix bitrates into a VBR-like stream). */
export function mono96Mp3(): Uint8Array {
  return cached('mono96', () => encodeMp3([synth(SR, [{ sec: 2, freq: 330 }])], SR, 96));
}
