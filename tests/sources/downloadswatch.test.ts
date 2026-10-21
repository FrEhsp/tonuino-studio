import { afterEach, describe, expect, it, vi } from 'vitest';
import { markTaken, newMemory, settledFiles, WATCH_FOR_MS, WATCH_SLACK_MS } from '../../src/core/sources/downloadsWatch';

describe('files saved on the publisher\'s page', () => {
  it('hands over a file once it stopped growing, and never twice', () => {
    const m = newMemory();
    // First look: the browser is still writing.
    expect(settledFiles([{ path: '/dl/folge.mp3', size: 1000 }], m)).toEqual([]);
    expect(settledFiles([{ path: '/dl/folge.mp3', size: 5000 }], m)).toEqual([]);
    // Same size as before: done.
    const done = settledFiles([{ path: '/dl/folge.mp3', size: 5000 }, { path: '/dl/neu.mp3', size: 10 }], m);
    expect(done).toEqual([{ path: '/dl/folge.mp3', size: 5000 }]);
    markTaken(m, done);
    expect(settledFiles([{ path: '/dl/folge.mp3', size: 5000 }, { path: '/dl/neu.mp3', size: 10 }], m)).toEqual([{ path: '/dl/neu.mp3', size: 10 }]);
    expect(settledFiles([{ path: '/dl/folge.mp3', size: 5000 }], m)).toEqual([]);
  });

  it('waits while the family answers a question: the file stays for the next look', () => {
    const m = newMemory();
    settledFiles([{ path: '/dl/a.mp3', size: 7 }], m);
    // Not taken at this look (paused) …
    expect(settledFiles([{ path: '/dl/a.mp3', size: 7 }], m)).toHaveLength(1);
    // … so the next look offers it again.
    expect(settledFiles([{ path: '/dl/a.mp3', size: 7 }], m)).toHaveLength(1);
    // An empty file is never done.
    settledFiles([{ path: '/dl/leer.mp3', size: 0 }], m);
    expect(settledFiles([{ path: '/dl/leer.mp3', size: 0 }], m)).toEqual([]);
  });
});

describe('when the app looks', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../src/app/state');
  });

  it('starts with "Auf der Webseite öffnen" in the desktop app only, for a while, and keeps the start when clicked again', async () => {
    for (const desktop of [true, false]) {
      vi.resetModules();
      vi.doMock('../../src/app/state', () => ({ plat: () => (desktop ? { downloads: { recent: async () => ({ files: [] }) } } : {}) }));
      const w = await import('../../src/features/sources/downloadsWatch');
      w.startWatch('wdr-mumins', 1_000_000);
      if (!desktop) {
        expect(w.downloadWatch.value).toBeNull();
        continue;
      }
      expect(w.downloadWatch.value).toEqual({ entry: 'wdr-mumins', since: 1_000_000 - WATCH_SLACK_MS, until: 1_000_000 + WATCH_FOR_MS });
      w.startWatch('wdr-mumins', 1_060_000);
      expect(w.downloadWatch.value).toEqual({ entry: 'wdr-mumins', since: 1_000_000 - WATCH_SLACK_MS, until: 1_060_000 + WATCH_FOR_MS });
      // Another source starts afresh.
      w.startWatch('ard-hoerspielklassiker', 1_100_000);
      expect(w.downloadWatch.value?.since).toBe(1_100_000 - WATCH_SLACK_MS);
      w.stopWatch();
      expect(w.downloadWatch.value).toBeNull();
    }
  });
});
