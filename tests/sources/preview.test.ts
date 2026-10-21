import { afterAll, describe, expect, it, vi } from 'vitest';

/** Just enough of an <audio> element to see how "Reinhören" requests a file. */
class FakeAudio {
  static made: FakeAudio[] = [];
  crossOrigin: string | null = null;
  preload = '';
  src = '';
  error = null;
  currentTime = 0;
  duration = NaN;
  /** The cross-origin mode at the moment the file was requested. */
  requested: { src: string; crossOrigin: string | null }[] = [];
  constructor() {
    FakeAudio.made.push(this);
  }
  addEventListener() {}
  getAttribute(name: string) {
    return name === 'src' ? this.src : null;
  }
  removeAttribute() {
    this.src = '';
  }
  load() {}
  pause() {}
  play() {
    this.requested.push({ src: this.src, crossOrigin: this.crossOrigin });
    return Promise.resolve();
  }
}

vi.stubGlobal('Audio', FakeAudio);
const { stopPreview, togglePreview } = await import('../../src/features/sources/Preview');

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('"Reinhören"', () => {
  it('requests files the app loads itself without cookies, and other files as the browser does', () => {
    togglePreview('gsb/1', 'https://gitlab.com/a.mp3', 'Geschichte', undefined, true);
    togglePreview('srf/1', 'https://download-media.srf.ch/b.mp3', 'Folge', undefined, false);
    togglePreview('gsb/2', 'https://gitlab.com/c.mp3', 'Geschichte 2', undefined, true);
    stopPreview();
    expect(FakeAudio.made).toHaveLength(1);
    expect(FakeAudio.made[0].requested).toEqual([
      { src: 'https://gitlab.com/a.mp3', crossOrigin: 'anonymous' },
      { src: 'https://download-media.srf.ch/b.mp3', crossOrigin: null },
      { src: 'https://gitlab.com/c.mp3', crossOrigin: 'anonymous' },
    ]);
  });
});
