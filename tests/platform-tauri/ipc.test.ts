/**
 * The glue to Tauri's own close request, run through the real @tauri-apps/api
 * (with its mocks instead of the desktop app). Tauri keeps the window open while
 * a listener exists, but the API destroys it right after the listener ran unless
 * the listener called preventDefault(). The fake IPC of the other tests cannot
 * see that, so this test runs the real wrapper.
 */
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultIpc } from '../../src/platform/tauri/ipc';
import { flush } from './fake-ipc';

interface Listener {
  event: string;
  target: unknown;
  handler: number;
}

interface Internals {
  runCallback(id: number, data: unknown): void;
}

/** A desktop window named "main" whose commands the test sees. */
function tauriWindow() {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const listeners = new Map<number, Listener>();
  let nextId = 1;
  vi.stubGlobal('window', { crypto: globalThis.crypto });
  mockWindows('main');
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === 'plugin:event|listen') {
      const id = nextId++;
      listeners.set(id, a as unknown as Listener);
      return id;
    }
    if (cmd === 'plugin:event|unlisten') {
      listeners.delete(a.eventId as number);
      return null;
    }
    if (cmd === 'plugin:window|destroy') return null;
    throw new Error(`no mock for ${cmd}`);
  });
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  return {
    calls,
    listeners,
    /** The user clicks the close button: Tauri hands the request to the window's listeners. */
    async requestClose() {
      for (const [id, l] of listeners) {
        if (l.event === 'tauri://close-requested') internals.runCallback(l.handler, { event: l.event, id, payload: null });
      }
      await flush();
    },
    destroyed: () => calls.filter((c) => c.cmd === 'plugin:window|destroy').length,
  };
}

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

describe('the close request through the Tauri API', () => {
  it('keeps the window open and asks while the handler is registered', async () => {
    const tauri = tauriWindow();
    let asked = 0;
    const unlisten = await createDefaultIpc().onCloseRequested(() => asked++);
    expect([...tauri.listeners.values()]).toEqual([{ event: 'tauri://close-requested', target: { kind: 'Window', label: 'main' }, handler: expect.any(Number) }]);
    await tauri.requestClose();
    await tauri.requestClose();
    expect(asked).toBe(2);
    expect(tauri.destroyed()).toBe(0);
    // Removing the handler tells Tauri: then the window closes again without asking.
    await unlisten();
    expect(tauri.listeners.size).toBe(0);
    expect(tauri.calls.filter((c) => c.cmd === 'plugin:event|unlisten').map((c) => c.args)).toEqual([{ event: 'tauri://close-requested', eventId: 1 }]);
  });

  it('without preventDefault, the API itself closes the window after the handler', async () => {
    // The same setup with a bare listener: shows what the glue must prevent.
    const tauri = tauriWindow();
    let asked = 0;
    await getCurrentWindow().onCloseRequested(() => {
      asked++;
    });
    await tauri.requestClose();
    expect(asked).toBe(1);
    expect(tauri.destroyed()).toBe(1);
  });
});
