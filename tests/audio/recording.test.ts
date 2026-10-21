import { describe, expect, it } from 'vitest';
import { levelAdvice, MAX_RECORDING_SEC, meterFraction, PcmRecording, peakDb, recordingFileName, wavHeader } from '../../src/core/audio/recording';
import { probeWav, wavToFloat } from '../../src/core/audio/wav';
import { bufferSource, readRange } from '../../src/core/audio/source';

describe('recording from the microphone', () => {
  it('measures the peak of a block in dBFS', () => {
    expect(peakDb([new Float32Array([0, 0.5, -0.25])])).toBeCloseTo(-6.02, 1);
    expect(peakDb([new Float32Array([0.1]), new Float32Array([-1])])).toBeCloseTo(0, 5);
    expect(peakDb([new Float32Array(4)])).toBe(Number.NEGATIVE_INFINITY);
  });

  it('draws the meter from -60 dB to 0 dB', () => {
    expect(meterFraction(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(meterFraction(-80)).toBe(0);
    expect(meterFraction(-30)).toBeCloseTo(0.5);
    expect(meterFraction(3)).toBe(1);
  });

  it('says when it is too loud or too quiet, and nothing in between', () => {
    expect(levelAdvice([])).toBeNull();
    expect(levelAdvice([-20, -0.5])).toBe('loud');
    expect(levelAdvice([-50, -40])).toBe('quiet');
    expect(levelAdvice([-50, -12])).toBeNull();
  });

  it('mixes to mono 16-bit and gives a WAV the app can read', async () => {
    const rec = new PcmRecording(48000);
    const left = new Float32Array(4800).fill(0.5);
    const right = new Float32Array(4800).fill(-0.25);
    expect(rec.push([left, right])).toBe(true);
    expect(rec.push([new Float32Array(2400).fill(2)])).toBe(true);
    expect(rec.durationSec).toBeCloseTo(0.15);
    const bytes = new Uint8Array(await rec.toWav().arrayBuffer());
    expect(bytes.length).toBe(44 + 7200 * 2);
    const source = bufferSource(bytes, 'a.wav');
    const info = await probeWav(source);
    expect(info).toMatchObject({ sampleRate: 48000, channels: 1 });
    const [pcm] = wavToFloat(await readRange(source, info.dataOffset, info.dataSize), info);
    expect(pcm[0]).toBeCloseTo(0.125, 3);
    // Clipped, not wrapped around.
    expect(pcm[7000]).toBeCloseTo(1, 3);
  });

  it('stops taking blocks once it is full', () => {
    const rate = 100;
    const rec = new PcmRecording(rate);
    const block = new Float32Array(rate * 60);
    let minutes = 0;
    while (rec.push([block])) minutes++;
    expect(minutes).toBe(MAX_RECORDING_SEC / 60 - 1);
    expect(rec.full).toBe(true);
    expect(rec.durationSec).toBe(MAX_RECORDING_SEC);
    expect(rec.push([block])).toBe(false);
    expect(rec.durationSec).toBe(MAX_RECORDING_SEC);
  });

  it('writes the WAV header the format asks for', () => {
    const h = new DataView(wavHeader(22050, 2, 1000).buffer);
    expect(h.getUint32(4, true)).toBe(1036);
    expect(h.getUint16(22, true)).toBe(2);
    expect(h.getUint32(28, true)).toBe(22050 * 4);
    expect(h.getUint32(40, true)).toBe(1000);
  });

  it('names the file after the title, or the date when there is none', () => {
    const now = new Date(2026, 9, 3, 7, 5);
    expect(recordingFileName('Oma liest: Frau Holle', now)).toBe('Oma liest Frau Holle.wav');
    expect(recordingFileName('  ..  ', now)).toBe('Aufnahme 03.10.2026 07-05.wav');
    expect(recordingFileName('a/b\\c?', now)).toBe('a b c.wav');
    expect(recordingFileName('x'.repeat(200), now)).toHaveLength(84);
  });
});
