import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { signal } from '@preact/signals';
import { CLOSE_RISKS, closeHostFor, holdWhile, WriteGuard, type CloseHost } from '../../src/app/writeguard';
import { createTauriPlatform } from '../../src/platform/tauri';
import { FakeIpc, flush } from '../platform-tauri/fake-ipc';

/** A host that records how often the guard is switched on and off. */
function recordingHost(close?: () => Promise<void>) {
  const log: string[] = [];
  let ask: (() => void) | undefined;
  const host: CloseHost = {
    guard(a) {
      log.push('on');
      ask = a;
      return () => {
        log.push('off');
        ask = undefined;
      };
    },
    close,
  };
  return { host, log, request: () => ask?.() };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function desktop() {
  const ipc = new FakeIpc();
  ipc.on('plugin:window|destroy', () => null);
  ipc.on('plugin:window|unminimize', () => null);
  ipc.on('plugin:window|set_focus', () => null);
  const platform = createTauriPlatform({ ipc, os: 'linux' });
  const guard = new WriteGuard(closeHostFor(platform, undefined));
  return { ipc, platform, guard };
}

describe('write guard', () => {
  it('stays on while any of several writes runs, and goes off after the last', () => {
    const { host, log } = recordingHost();
    const guard = new WriteGuard(host);
    const flash = guard.hold('firmware');
    const album = guard.hold('tracks');
    const sounds = guard.hold('sounds');
    expect(log).toEqual(['on']);
    // Most serious first, whatever started first.
    expect(guard.running.value).toEqual(['firmware', 'sounds', 'tracks']);
    flash();
    expect(guard.running.value).toEqual(['sounds', 'tracks']);
    sounds();
    // Releasing twice must not end the album's hold.
    sounds();
    expect(guard.running.value).toEqual(['tracks']);
    expect(log).toEqual(['on']);
    album();
    expect(guard.running.value).toEqual([]);
    expect(log).toEqual(['on', 'off']);
    // Later writes switch it on again.
    guard.hold('repair')();
    expect(log).toEqual(['on', 'off', 'on', 'off']);
  });

  it('names each kind once while two writes of it run', () => {
    const guard = new WriteGuard();
    const a = guard.hold('repair');
    const b = guard.hold('repair');
    expect(guard.running.value).toEqual(['repair']);
    a();
    expect(guard.running.value).toEqual(['repair']);
    b();
    expect(guard.running.value).toEqual([]);
  });

  it('lets go when a write succeeds, fails or is cancelled', async () => {
    const { host, log } = recordingHost();
    const guard = new WriteGuard(host);
    await expect(guard.during('tracks', async () => 42)).resolves.toBe(42);
    expect(guard.running.value).toEqual([]);
    await expect(
      guard.during('sounds', async () => {
        throw new Error('Karte voll');
      }),
    ).rejects.toThrow('Karte voll');
    expect(guard.running.value).toEqual([]);
    const abort = new AbortController();
    const cancelled = guard.during('order', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      abort.signal.throwIfAborted();
    });
    expect(guard.running.value).toEqual(['order']);
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(guard.running.value).toEqual([]);
    expect(log).toEqual(['on', 'off', 'on', 'off', 'on', 'off']);
  });

  it('keeps writes that overlap guarded until both are done', async () => {
    const { host, log } = recordingHost();
    const guard = new WriteGuard(host);
    const flash = deferred();
    const album = deferred();
    const a = guard.during('firmware', () => flash.promise);
    const b = guard.during('tracks', () => album.promise).catch(() => 'stopped');
    album.reject(new Error('Karte heraus'));
    expect(await b).toBe('stopped');
    expect(guard.running.value).toEqual(['firmware']);
    expect(log).toEqual(['on']);
    flash.resolve();
    await a;
    expect(log).toEqual(['on', 'off']);
  });

  it('moves to a host that comes later, also while a write runs', () => {
    const guard = new WriteGuard();
    const release = guard.hold('firmware');
    const first = recordingHost();
    guard.connect(first.host);
    expect(first.log).toEqual(['on']);
    const second = recordingHost();
    guard.connect(second.host);
    expect(first.log).toEqual(['on', 'off']);
    expect(second.log).toEqual(['on']);
    release();
    expect(second.log).toEqual(['on', 'off']);
  });

  it('asks, and closes only when told to', async () => {
    let closed = 0;
    const { host, log, request } = recordingHost(async () => {
      closed++;
    });
    const guard = new WriteGuard(host);
    const release = guard.hold('firmware');
    request();
    expect(guard.asking.value).toBe(true);
    guard.keepOpen();
    expect(guard.asking.value).toBe(false);
    expect(closed).toBe(0);
    request();
    await guard.closeAnyway();
    expect(closed).toBe(1);
    // The guard is off before the window goes, so nothing asks a second time.
    expect(log).toEqual(['on', 'off']);
    expect(guard.asking.value).toBe(false);
    release();
    expect(log).toEqual(['on', 'off']);
  });

  it('is on again when the window does not close', async () => {
    const { host, log, request } = recordingHost(async () => {
      throw new Error('not allowed');
    });
    const guard = new WriteGuard(host);
    guard.hold('tracks');
    request();
    await expect(guard.closeAnyway()).rejects.toThrow('not allowed');
    expect(log).toEqual(['on', 'off', 'on']);
    expect(guard.asking.value).toBe(true);
  });

  it('keeps the question open when the write ends meanwhile, with nothing left to warn about', () => {
    const { host, request } = recordingHost();
    const guard = new WriteGuard(host);
    const release = guard.hold('order');
    request();
    release();
    expect(guard.asking.value).toBe(true);
    expect(guard.running.value).toEqual([]);
  });

  it('says what closing would do, in plain words', () => {
    expect(CLOSE_RISKS.firmware).toBe('Gerade wird die Firmware aufgespielt. Wenn du jetzt schließt, kann die Box danach nicht mehr starten.');
    for (const text of Object.values(CLOSE_RISKS)) {
      expect(text).toMatch(/^Gerade .+\. Wenn du jetzt schließt, .+\.$/);
    }
  });
});

describe('closing in the browser', () => {
  it("asks with the browser's question while a write runs, and not after", () => {
    const page = new EventTarget();
    const guard = new WriteGuard(closeHostFor({}, page));
    const leave = () => {
      const e = new Event('beforeunload', { cancelable: true });
      page.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(leave()).toBe(false);
    const release = guard.hold('tracks');
    expect(leave()).toBe(true);
    release();
    expect(leave()).toBe(false);
    // A browser has no window to close by itself.
    expect(closeHostFor({}, page).close).toBeUndefined();
  });
});

describe('closing the desktop window', () => {
  it('keeps the window open while a write runs and asks in the app', async () => {
    const { ipc, guard } = desktop();
    expect(ipc.requestClose()).toBe(true);
    const release = guard.hold('firmware');
    await flush();
    expect(ipc.requestClose()).toBe(false);
    expect(guard.asking.value).toBe(true);
    guard.keepOpen();
    release();
    await flush();
    expect(ipc.closeListenerCount).toBe(0);
    expect(ipc.requestClose()).toBe(true);
    expect(guard.asking.value).toBe(false);
  });

  it('asks while files from "Entdecken" load or wait for the card, and not after', async () => {
    const { ipc, guard } = desktop();
    const loading = signal(false);
    const stop = holdWhile(guard, 'downloads', () => loading.value);
    await flush();
    expect(ipc.requestClose()).toBe(true);
    loading.value = true;
    await flush();
    expect(ipc.requestClose()).toBe(false);
    expect(guard.asking.value).toBe(true);
    expect(guard.running.value).toEqual(['downloads']);
    expect(CLOSE_RISKS.downloads).toContain('musst du sie noch einmal laden');
    guard.keepOpen();
    // A transfer that starts meanwhile is named first.
    const release = guard.hold('tracks');
    expect(guard.running.value).toEqual(['tracks', 'downloads']);
    release();
    loading.value = false;
    await flush();
    expect(guard.running.value).toEqual([]);
    expect(ipc.closeListenerCount).toBe(0);
    expect(ipc.requestClose()).toBe(true);
    stop();
  });

  it('"Trotzdem schließen" closes the window without asking again', async () => {
    const { ipc, guard } = desktop();
    guard.hold('sounds');
    await flush();
    ipc.requestClose();
    await guard.closeAnyway();
    expect(ipc.callsOf('plugin:window|destroy').map((c) => c.args)).toEqual([{ label: 'main' }]);
    expect(ipc.closeListenerCount).toBe(0);
  });

  it('a write that ends before Tauri confirmed the listener leaves no listener behind', async () => {
    const { ipc, platform } = desktop();
    let asked = 0;
    const release = platform.holdWindowOpen(() => asked++);
    release();
    await flush();
    expect(ipc.closeListenerCount).toBe(0);
    expect(ipc.requestClose()).toBe(true);
    expect(asked).toBe(0);
  });

  it('brings the window to the front to ask, and only then', async () => {
    const { ipc, guard } = desktop();
    const release = guard.hold('tracks');
    await flush();
    // Closed from the taskbar while minimized: the question would wait unseen.
    expect(ipc.requestClose()).toBe(false);
    await flush();
    expect(guard.asking.value).toBe(true);
    expect(ipc.calls.map((c) => c.cmd).filter((cmd) => cmd.startsWith('plugin:window|'))).toEqual(['plugin:window|unminimize', 'plugin:window|set_focus']);
    expect(ipc.callsOf('plugin:window|unminimize').map((c) => c.args)).toEqual([{ label: 'main' }]);
    expect(ipc.callsOf('plugin:window|set_focus').map((c) => c.args)).toEqual([{ label: 'main' }]);
    guard.keepOpen();
    release();
    await flush();
    // Nothing runs: the window closes and is not brought back.
    expect(ipc.requestClose()).toBe(true);
    await flush();
    expect(ipc.callsOf('plugin:window|unminimize')).toHaveLength(1);
    expect(ipc.callsOf('plugin:window|set_focus')).toHaveLength(1);
  });

  it('still asks when the window cannot come to the front', async () => {
    const { ipc, guard } = desktop();
    ipc.on('plugin:window|unminimize', () => {
      throw { code: 'other', detail: 'not allowed' };
    });
    const errors: unknown[] = [];
    const saved = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      guard.hold('order');
      await flush();
      expect(ipc.requestClose()).toBe(false);
      await flush();
      expect(guard.asking.value).toBe(true);
      expect(errors).toHaveLength(1);
      expect(ipc.callsOf('plugin:window|destroy')).toHaveLength(0);
    } finally {
      console.error = saved;
    }
  });

  it('may destroy the window, bring it to the front and nothing more than it needs', () => {
    const capabilities = JSON.parse(readFileSync(fileURLToPath(new URL('../../src-tauri/capabilities/default.json', import.meta.url)), 'utf8')) as { permissions: string[] };
    expect(capabilities.permissions).toEqual([
      'core:default',
      'core:window:allow-set-theme',
      'core:window:allow-destroy',
      'core:window:allow-unminimize',
      'core:window:allow-set-focus',
    ]);
  });
});
