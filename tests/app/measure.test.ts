import { describe, expect, it } from 'vitest';
import { silentMp3 } from '../../src/app/measure';

describe('the silent title of the measuring mode', () => {
  it('is a run of MPEG-1 Layer III frames as long as asked', () => {
    const mp3 = silentMp3(600);
    // 144 bytes per frame of 1152 samples at 32 kHz.
    expect(mp3.length % 144).toBe(0);
    expect(((mp3.length / 144) * 1152) / 32000).toBeGreaterThanOrEqual(600);
    expect([...mp3.subarray(0, 4)]).toEqual([0xff, 0xfb, 0x18, 0xc0]);
    expect([...mp3.subarray(144, 148)]).toEqual([0xff, 0xfb, 0x18, 0xc0]);
  });
});
