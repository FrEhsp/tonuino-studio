import { describe, expect, it } from 'vitest';
import { ArrayPcmReader, readAllPcm, ResamplingPcmReader } from '../../src/core/audio/pcm';
import { Resampler, resampleBuffer } from '../../src/core/audio/resample';
import { rmsDb, sine, toneAmplitude } from './helpers';

/** Level of everything except the given tone, in dB relative to full scale. */
function residualDb(x: Float32Array, sampleRate: number, freq: number, start: number, end: number): number {
  const amp = toneAmplitude(x, sampleRate, freq, start, end);
  // fit phase with a least-squares sine/cosine projection
  let sc = 0;
  let cc = 0;
  for (let i = start; i < end; i++) {
    sc += x[i] * Math.sin((2 * Math.PI * freq * i) / sampleRate);
    cc += x[i] * Math.cos((2 * Math.PI * freq * i) / sampleRate);
  }
  const n = end - start;
  const a = (2 * sc) / n;
  const b = (2 * cc) / n;
  let res = 0;
  for (let i = start; i < end; i++) {
    const fit = a * Math.sin((2 * Math.PI * freq * i) / sampleRate) + b * Math.cos((2 * Math.PI * freq * i) / sampleRate);
    res += (x[i] - fit) ** 2;
  }
  expect(amp).toBeGreaterThan(0);
  return 10 * Math.log10(res / n + 1e-30);
}

describe('Resampler', () => {
  it('keeps frequency and level of a sine (48 kHz → 44.1 kHz)', () => {
    const x = sine(48000, 1000, 1, 0.5);
    const [y] = resampleBuffer([x], 48000, 44100);
    expect(y.length).toBe(Math.ceil((x.length * 147) / 160));
    const mid = [4410, 40000] as const;
    expect(toneAmplitude(y, 44100, 1000, ...mid)).toBeCloseTo(0.5, 3);
    expect(toneAmplitude(y, 44100, 1100, ...mid)).toBeLessThan(0.001);
    expect(residualDb(y, 44100, 1000, ...mid)).toBeLessThan(-80);
  });

  it('upsamples 22.05 kHz → 44.1 kHz without images', () => {
    const x = sine(22050, 5000, 1, 0.5);
    const [y] = resampleBuffer([x], 22050, 44100);
    expect(y.length).toBe(x.length * 2);
    expect(toneAmplitude(y, 44100, 5000, 4410, 40000)).toBeCloseTo(0.5, 3);
    expect(toneAmplitude(y, 44100, 17050, 4410, 40000)).toBeLessThan(1e-3); // image of 5 kHz
    expect(residualDb(y, 44100, 5000, 4410, 40000)).toBeLessThan(-70);
  });

  it('suppresses aliasing when downsampling (44.1 kHz → 22.05 kHz)', () => {
    const high = sine(44100, 15000, 1, 0.5);
    const [y] = resampleBuffer([high], 44100, 22050);
    expect(rmsDb(y, 1000, 20000)).toBeLessThan(-70);
    const low = sine(44100, 3000, 1, 0.5);
    const [z] = resampleBuffer([low], 44100, 22050);
    expect(toneAmplitude(z, 22050, 3000, 2205, 20000)).toBeCloseTo(0.5, 3);
  });

  it('handles 32 kHz → 44.1 kHz and ratios without a small phase table', () => {
    const x = sine(32000, 440, 1, 0.3);
    const [y] = resampleBuffer([x], 32000, 44100);
    expect(toneAmplitude(y, 44100, 440, 4410, 40000)).toBeCloseTo(0.3, 3);
    const [z] = resampleBuffer([x], 32000, 44101); // L = 44101: interpolated phases
    expect(z.length).toBe(Math.ceil((x.length * 44101) / 32000));
    expect(toneAmplitude(z, 44101, 440, 4410, 40000)).toBeCloseTo(0.3, 3);
    expect(residualDb(z, 44101, 440, 4410, 40000)).toBeLessThan(-75);
  });

  it('gives the same output when streaming in odd block sizes', () => {
    const l = sine(48000, 700, 0.5, 0.4);
    const r = sine(48000, 1300, 0.5, 0.2);
    const [refL, refR] = resampleBuffer([l, r], 48000, 44100);
    const rs = new Resampler(48000, 44100, 2);
    const outL: number[] = [];
    const outR: number[] = [];
    for (let i = 0, step = 1; i < l.length; i += step, step = (step * 7 + 3) % 1500 || 1) {
      const [a, b] = rs.process([l.subarray(i, i + step), r.subarray(i, i + step)]);
      outL.push(...a);
      outR.push(...b);
    }
    const [a, b] = rs.flush();
    outL.push(...a);
    outR.push(...b);
    expect(outL.length).toBe(refL.length);
    expect(Float32Array.from(outL)).toEqual(refL);
    expect(Float32Array.from(outR)).toEqual(refR);
  });

  it('wraps a PcmReader', async () => {
    const x = sine(48000, 1000, 0.75, 0.5);
    const reader = new ResamplingPcmReader(new ArrayPcmReader([x, x], 48000), 44100);
    expect(reader.sampleRate).toBe(44100);
    expect(reader.channels).toBe(2);
    const [l, r] = await readAllPcm(reader, 3000);
    expect(l.length).toBe(Math.ceil((x.length * 147) / 160));
    expect(r).toEqual(l);
    expect(toneAmplitude(l, 44100, 1000, 3000, 30000)).toBeCloseTo(0.5, 3);
  });
});
