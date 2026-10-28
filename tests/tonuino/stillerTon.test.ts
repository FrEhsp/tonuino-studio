import { describe, expect, it } from 'vitest';
import { scanMp3 } from '../../src/core/audio/mp3frames';
import { bufferSource } from '../../src/core/audio/source';
import { Mp3PcmReader } from '../../src/core/audio/mp3decode';
import { istStill, stillesMp3 } from '../../src/core/tonuino/stillerTon';

describe('silent start tone (mp3/0262.mp3)', () => {
  it('is a clean MP3 of about a quarter second', async () => {
    const data = stillesMp3();
    const ix = await scanMp3(bufferSource(data, '0262.mp3'));
    expect(ix.layer).toBe(3);
    expect(ix.frameCount).toBe(10);
    expect(ix.sampleRate).toBe(44100);
    expect(ix.junkBytes).toBe(0);
    expect(ix.durationSec).toBeGreaterThan(0.2);
    expect(istStill(data.length)).toBe(true);
  });

  it('decodes to silence', async () => {
    const reader = await Mp3PcmReader.open(bufferSource(stillesMp3(), '0262.mp3'));
    let peak = 0;
    let samples = 0;
    for (;;) {
      const block = await reader.next(4096);
      if (!block) break;
      for (const ch of block.channels) for (const v of ch) peak = Math.max(peak, Math.abs(v));
      samples += block.channels[0].length;
    }
    expect(samples).toBeGreaterThan(0);
    expect(peak).toBe(0);
  });
});
