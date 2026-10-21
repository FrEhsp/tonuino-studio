import { describe, expect, it } from 'vitest';
import {
  albumLoudness,
  CLIPS_PER_MINUTE,
  integratedLoudness,
  isClipped,
  kWeightingFilters,
  MONO_PLAYBACK_OFFSET_DB,
  MAX_BOOST_DB,
  momentaryDb,
  planAlbumGain,
  playbackLufs,
  PowerEnvelope,
  powerToLufs,
  QUIET_SHORTFALL_DB,
  TARGET_LUFS,
} from '../../src/core/audio/loudness';
import { GAIN_STEP_DB } from '../../src/core/audio/mp3gain';
import { sine } from './helpers';

function dbfs(db: number): number {
  return 10 ** (db / 20);
}

/** Concatenated 1 kHz stereo tone sections [seconds, dBFS]. */
function toneSections(sampleRate: number, sections: [number, number][]): Float32Array {
  const parts = sections.map(([sec, db]) => sine(sampleRate, 1000, sec, dbfs(db)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function measure(sampleRate: number, channels: Float32Array[], chunk = 4096): { lufs: number; power: Float32Array } {
  const env = new PowerEnvelope(sampleRate, channels.length);
  for (let i = 0; i < channels[0].length; i += chunk) env.push({ channels: channels.map((c) => c.subarray(i, i + chunk)), sampleRate });
  const power = env.finish();
  return { lufs: integratedLoudness(power, 0.01), power };
}

describe('K-weighting', () => {
  it('matches the BS.1770-4 coefficients at 48 kHz', () => {
    const [shelf, hp] = kWeightingFilters(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 6);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 6);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 6);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 6);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 6);
    expect([hp.b0, hp.b1, hp.b2]).toEqual([1, -2, 1]);
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 6);
    expect(hp.a2).toBeCloseTo(0.99007225036621, 6);
  });
});

describe('integrated loudness (EBU Tech 3341)', () => {
  for (const sampleRate of [48000, 44100]) {
    it(`case 1: stereo 1 kHz at -23 dBFS reads -23.0 LUFS (${sampleRate} Hz)`, () => {
      const x = toneSections(sampleRate, [[20, -23]]);
      expect(measure(sampleRate, [x, x]).lufs).toBeCloseTo(-23, 1);
      expect(Math.abs(measure(sampleRate, [x, x]).lufs + 23)).toBeLessThan(0.1);
    });
  }

  it('case 2: -33 dBFS reads -33.0 LUFS', () => {
    const x = toneSections(48000, [[20, -33]]);
    expect(Math.abs(measure(48000, [x, x]).lufs + 33)).toBeLessThan(0.1);
  });

  it('cases 3 and 4: gating ignores quiet sections', () => {
    const c3 = toneSections(48000, [
      [10, -36],
      [60, -23],
      [10, -36],
    ]);
    expect(Math.abs(measure(48000, [c3, c3]).lufs + 23)).toBeLessThan(0.1);
    const c4 = toneSections(44100, [
      [10, -72],
      [10, -36],
      [60, -23],
      [10, -36],
      [10, -72],
    ]);
    expect(Math.abs(measure(44100, [c4, c4]).lufs + 23)).toBeLessThan(0.1);
  });

  it('case 5: -26/-20/-26 dBFS reads -23.0 LUFS', () => {
    const x = toneSections(48000, [
      [20, -26],
      [20.1, -20],
      [20, -26],
    ]);
    expect(Math.abs(measure(48000, [x, x]).lufs + 23)).toBeLessThan(0.1);
  });

  it('counts mono once and works at 22.05 kHz', () => {
    const x = toneSections(44100, [[10, -23]]);
    expect(measure(44100, [x]).lufs).toBeCloseTo(-26.01, 1);
    const y = toneSections(22050, [[10, -23]]);
    expect(Math.abs(measure(22050, [y, y]).lufs + 23)).toBeLessThan(0.1);
  });

  it('returns -Infinity for silence and handles clips shorter than a block', () => {
    const silent = new Float32Array(48000);
    expect(measure(48000, [silent, silent]).lufs).toBe(Number.NEGATIVE_INFINITY);
    const short = toneSections(48000, [[0.2, -23]]);
    expect(measure(48000, [short, short]).lufs).toBeCloseTo(-23, 0);
    expect(integratedLoudness(new Float32Array(0))).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('PowerEnvelope', () => {
  it('produces one value per 10 ms window, independent of chunking', () => {
    const x = toneSections(44100, [
      [1, -20],
      [1, -40],
    ]);
    const a = measure(44100, [x, x], 4096).power;
    const b = measure(44100, [x, x], 777).power;
    const c = measure(44100, [x, x], x.length).power;
    expect(a.length).toBe(200);
    expect([...b]).toEqual([...a]);
    expect([...c]).toEqual([...a]);
    // per-window momentary values follow the level (+3 dB for two channels, K-weighting ~0 dB at 1 kHz)
    const m = momentaryDb(a);
    expect(m[50]).toBeCloseTo(-20, 0);
    expect(m[150]).toBeCloseTo(-40, 0);
    expect(powerToLufs(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('keeps windows aligned for sample rates without an integer window length', () => {
    const x = toneSections(22050, [[2, -20]]);
    const p = measure(22050, [x], 1000).power;
    expect(p.length).toBe(200);
  });

  it('tracks the largest sample of all channels', () => {
    const env = new PowerEnvelope(44100, 2);
    expect(env.peak).toBe(0);
    env.push({ channels: [Float32Array.from([0.1, -0.2, 0.3]), Float32Array.from([0, 0.25, -0.1])], sampleRate: 44100 });
    env.push({ channels: [Float32Array.from([0.05]), Float32Array.from([-0.7])], sampleRate: 44100 });
    expect(env.peak).toBeCloseTo(0.7, 6);
  });

  it('rejects chunks with another sample rate', () => {
    const env = new PowerEnvelope(48000, 2);
    expect(() => env.push({ channels: [new Float32Array(10), new Float32Array(10)], sampleRate: 44100 })).toThrow();
  });
});

describe('clipped files', () => {
  const SR = 44100;
  const clipsOf = (channels: Float32Array[]) => {
    const env = new PowerEnvelope(SR, channels.length);
    for (let i = 0; i < channels[0].length; i += 1000) env.push({ channels: channels.map((c) => c.subarray(i, i + 1000)), sampleRate: SR });
    env.finish();
    return env.clips();
  };
  const cut = (x: Float32Array, at = 1) => x.map((v) => Math.max(-at, Math.min(at, v)));
  /** As saved with 16 bits. */
  const q16 = (x: Float32Array) => x.map((v) => Math.round(v * 32767) / 32767);

  it('counts the cut-off tops of a tone turned up past full scale, also when it was turned down afterwards', () => {
    // 220 Hz for 2 s, 6 dB over: a flat top every half wave, on both channels.
    const x = cut(sine(SR, 220, 2, 2));
    expect(clipsOf([x, x])).toBe(1760);
    const down = x.map((v) => v * 0.5);
    expect(clipsOf([down, down])).toBe(1760);
    expect(clipsOf([q16(x)])).toBe(880);
  });

  it('leaves loud and deep tones alone, and flat stretches below the loudest level', () => {
    expect(clipsOf([q16(sine(SR, 1000, 2, 0.999))])).toBe(0);
    // The top of a deep tone has equal 16-bit samples too, but it gets there gently.
    expect(clipsOf([q16(sine(SR, 25, 2, 0.999))])).toBe(0);
    // Cut off at half the level, but louder elsewhere: not the file's limit.
    const half = cut(sine(SR, 220, 1, 2), 0.5);
    expect(clipsOf([Float32Array.from([...half, ...sine(SR, 220, 1, 1)])])).toBe(0);
  });

  it('calls a file clipped only when it happens again and again', () => {
    expect(isClipped({ clips: 2000, durationSec: 180 })).toBe(true);
    expect(isClipped({ clips: CLIPS_PER_MINUTE * 3 - 1, durationSec: 180 })).toBe(false);
    // A short file needs some at least.
    expect(isClipped({ clips: 10, durationSec: 5 })).toBe(false);
    expect(isClipped({ durationSec: 180 })).toBe(false);
  });
});

describe('album and playback loudness', () => {
  const sr = 48000;
  const track = (db: number, channels: 1 | 2, sec = 4) => {
    const x = toneSections(sr, [[sec, db]]);
    const m = measure(sr, channels === 2 ? [x, x] : [x]);
    return { ...m, power: m.power, windowSec: 0.01, channels };
  };

  it('equals the integrated loudness for a single stereo track', () => {
    const t = track(-20, 2);
    expect(albumLoudness([t])).toBeCloseTo(t.lufs, 6);
    expect(playbackLufs(t)).toBe(t.lufs);
    expect(t.lufs).toBeCloseTo(-20, 1);
  });

  it('counts mono files as heard on a player', () => {
    const mono = track(-20, 1);
    expect(mono.lufs).toBeCloseTo(-23.01, 1);
    expect(playbackLufs(mono)).toBeCloseTo(-20, 1);
    expect(playbackLufs({ channels: 1, lufs: -30 })).toBeCloseTo(-30 + MONO_PLAYBACK_OFFSET_DB, 9);
    expect(albumLoudness([mono, track(-20, 2)])).toBeCloseTo(-20, 1);
  });

  it('gates all tracks of an album together', () => {
    // Equal durations at -20 and -30: blocks average to 0.55 of the loud power; nothing is gated away.
    const album = albumLoudness([track(-20, 2), track(-30, 2)]);
    expect(album).toBeCloseTo(-20 + 10 * Math.log10(0.55), 1);
    // A silent track changes nothing.
    expect(albumLoudness([track(-20, 2), { power: new Float32Array(300), windowSec: 0.01, channels: 2 }])).toBeCloseTo(-20, 1);
    expect(albumLoudness([])).toBe(-Infinity);
  });

  it('measures from the power envelope when a backend gives no LUFS value', () => {
    const t = track(-25, 2);
    expect(playbackLufs({ channels: 2, power: t.power, windowSec: 0.01 })).toBeCloseTo(t.lufs, 6);
    expect(playbackLufs({ channels: 2, power: new Float32Array(100), windowSec: 0.01 })).toBeUndefined();
  });
});

describe('album gain', () => {
  it('changes MP3 albums in whole steps, never past clipping', () => {
    // Loud: down to the target in whole steps.
    const loud = planAlbumGain({ lufs: -10, mp3Peaks: [1, 0.9] });
    expect(loud.steps).toBe(Math.round(-6 / GAIN_STEP_DB));
    expect(loud.convertDb).toBeCloseTo(loud.steps * GAIN_STEP_DB, 9);
    expect(loud.shortfallDb).toBeLessThan(GAIN_STEP_DB / 2);
    // Quiet with room: up as far as wanted.
    const quiet = planAlbumGain({ lufs: -24, mp3Peaks: [0.1] });
    expect(quiet.steps).toBe(Math.round(8 / GAIN_STEP_DB));
    expect(quiet.shortfallDb).toBeLessThan(GAIN_STEP_DB / 2 + 1e-9);
    // Quiet with a loud peak: the room decides, and the rest is the shortfall.
    const peaky = planAlbumGain({ lufs: -24, mp3Peaks: [0.5] });
    expect(peaky.steps).toBe(Math.floor(-20 * Math.log10(0.5) / GAIN_STEP_DB));
    expect(peaky.shortfallDb).toBeCloseTo(8 - peaky.steps * GAIN_STEP_DB, 9);
    expect(peaky.boosted).toBeUndefined();
    // An unknown peak: no boost at all.
    expect(planAlbumGain({ lufs: -24, mp3Peaks: [0.1, undefined] }).steps).toBe(0);
  });

  it('converts the MP3s of a quiet album only when allowed and far enough under its level', () => {
    expect(planAlbumGain({ lufs: -40, mp3Peaks: [0.98], boostQuietMp3: true })).toEqual({ steps: 0, convertDb: MAX_BOOST_DB, shortfallDb: 0, quietDb: 24 - MAX_BOOST_DB, boosted: true });
    // Within reach of the boost, it gets all the way.
    expect(planAlbumGain({ lufs: -24, mp3Peaks: [0.98], boostQuietMp3: true })).toMatchObject({ convertDb: 8, quietDb: 0, boosted: true });
    // Less than QUIET_SHORTFALL_DB under: stays lossless.
    const near = planAlbumGain({ lufs: TARGET_LUFS - QUIET_SHORTFALL_DB + 0.5, mp3Peaks: [0.98], boostQuietMp3: true });
    expect(near).toMatchObject({ steps: 0, convertDb: 0 });
    expect(near.boosted).toBeUndefined();
    expect(near.shortfallDb).toBeCloseTo(QUIET_SHORTFALL_DB - 0.5, 9);
  });

  it('tells how far a quiet album stays under the others, also beyond the largest boost', () => {
    // 22 dB under the target, no room: the shortfall stops at MAX_BOOST_DB, the distance does not.
    const far = planAlbumGain({ lufs: TARGET_LUFS - 22, mp3Peaks: [0.98] });
    expect(far.steps).toBe(0);
    expect(far.shortfallDb).toBeCloseTo(MAX_BOOST_DB, 9);
    expect(far.quietDb).toBeCloseTo(22, 9);
    const some = planAlbumGain({ lufs: TARGET_LUFS - 8, mp3Peaks: [0.5] });
    expect(some.quietDb).toBeCloseTo(8 - some.steps * GAIN_STEP_DB, 9);
  });

  it('gives albums without MP3s to copy the whole change for the converter', () => {
    expect(planAlbumGain({ lufs: -26, mp3Peaks: [] })).toEqual({ steps: 0, convertDb: 10, shortfallDb: 0 });
    expect(planAlbumGain({ lufs: -60, mp3Peaks: [] }).convertDb).toBe(MAX_BOOST_DB);
  });
});
