import { signal } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import { keepAwakeWhileWriting, needsAwake, type WakeLockHost } from '../../src/app/wakelock';
import type { WriteKind } from '../../src/app/writeguard';

function fakeHost() {
  let visible = true;
  const listeners: (() => void)[] = [];
  const log: string[] = [];
  let refuse = false;
  const host: WakeLockHost = {
    request: async () => {
      if (refuse) throw new Error('NotAllowedError');
      log.push('lock');
      return { release: async () => void log.push('release') };
    },
    visible: () => visible,
    onVisibility(cb) {
      listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
  };
  return {
    host,
    log,
    listeners,
    refuse: () => (refuse = true),
    show(v: boolean) {
      visible = v;
      for (const l of [...listeners]) l();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('screen kept on while writing', () => {
  it('only for writes, not while something just waits', () => {
    expect(needsAwake([])).toBe(false);
    expect(needsAwake(['selection', 'downloads'])).toBe(false);
    expect(needsAwake(['tracks'])).toBe(true);
    expect(needsAwake(['selection', 'firmware'])).toBe(true);
  });

  it('holds the lock from the first write to the last and lets go after', async () => {
    const running = signal<readonly WriteKind[]>([]);
    const h = fakeHost();
    const stop = keepAwakeWhileWriting(running, h.host);
    await tick();
    expect(h.log).toEqual([]);
    running.value = ['tracks'];
    await tick();
    running.value = ['tracks', 'covers'];
    await tick();
    expect(h.log).toEqual(['lock']);
    running.value = [];
    await tick();
    expect(h.log).toEqual(['lock', 'release']);
    stop();
    expect(h.listeners).toHaveLength(0);
  });

  it('asks again when the page comes back during a write', async () => {
    const running = signal<readonly WriteKind[]>(['repair']);
    const h = fakeHost();
    const stop = keepAwakeWhileWriting(running, h.host);
    await tick();
    h.show(false);
    await tick();
    h.show(true);
    await tick();
    expect(h.log).toEqual(['lock', 'lock']);
    stop();
    await tick();
    expect(h.log.at(-1)).toBe('release');
  });

  it('lets the write go on when the system refuses, and does nothing without the API', async () => {
    const running = signal<readonly WriteKind[]>(['firmware']);
    const h = fakeHost();
    h.refuse();
    const stop = keepAwakeWhileWriting(running, h.host);
    await tick();
    expect(h.log).toEqual([]);
    stop();
    expect(() => keepAwakeWhileWriting(running, null)()).not.toThrow();
  });
});
