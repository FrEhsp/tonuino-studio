/**
 * The thin layer between the bridge and Tauri. Everything else in this
 * folder talks to `TauriIpc`, so tests can replace it with a fake.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Arguments of a command: named JSON arguments or a raw binary body. */
export type IpcArgs = Record<string, unknown> | Uint8Array | ArrayBuffer;

export interface IpcOptions {
  /** Header values must be ASCII; the bridge URI-encodes paths. */
  headers?: Record<string, string>;
}

export type DragDropPayload =
  | { type: 'enter'; paths: string[] }
  | { type: 'over' }
  | { type: 'drop'; paths: string[] }
  | { type: 'leave' };

export interface TauriIpc {
  invoke<T>(cmd: string, args?: IpcArgs, options?: IpcOptions): Promise<T>;
  /** Subscribes to an app event; resolves with the unsubscribe function. */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  /** Native file drops onto the window (needs `dragDropEnabled`). */
  onDragDrop(handler: (event: DragDropPayload) => void): Promise<() => void>;
  /**
   * The user wants to close the window. While a handler is registered, the
   * window stays open; resolves with the function that removes the handler.
   */
  onCloseRequested(handler: () => void): Promise<() => void>;
}

export function createDefaultIpc(): TauriIpc {
  return {
    invoke: <T>(cmd: string, args?: IpcArgs, options?: IpcOptions) =>
      options?.headers ? tauriInvoke<T>(cmd, args, { headers: options.headers }) : tauriInvoke<T>(cmd, args),
    listen: <T>(event: string, handler: (payload: T) => void) => tauriListen<T>(event, (e) => handler(e.payload)),
    onDragDrop: (handler) =>
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === 'drop' || p.type === 'enter') handler({ type: p.type, paths: p.paths });
        else handler({ type: p.type });
      }),
    // Tauri keeps the window open while a listener exists. Without
    // preventDefault() the API would close it right after the handler.
    onCloseRequested: (handler) =>
      getCurrentWindow().onCloseRequested((e) => {
        e.preventDefault();
        handler();
      }),
  };
}
