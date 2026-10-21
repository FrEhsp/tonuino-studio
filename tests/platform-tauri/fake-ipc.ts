/** A scriptable stand-in for the Tauri IPC, so the bridge can be tested in Node. */
import { Bridge } from '../../src/platform/tauri/bridge';
import type { DragDropPayload, IpcArgs, IpcOptions, TauriIpc } from '../../src/platform/tauri/ipc';

export interface Call {
  cmd: string;
  args?: IpcArgs;
  headers?: Record<string, string>;
}

type Handler = (args: IpcArgs | undefined, headers: Record<string, string>) => unknown;

export class FakeIpc implements TauriIpc {
  readonly calls: Call[] = [];
  private readonly handlers = new Map<string, Handler>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly dropHandlers = new Set<(e: DragDropPayload) => void>();
  private readonly closeHandlers = new Set<() => void>();

  /** Answers `cmd` with the handler's result (thrown values reject, like Tauri errors). */
  on(cmd: string, handler: Handler): this {
    this.handlers.set(cmd, handler);
    return this;
  }

  async invoke<T>(cmd: string, args?: IpcArgs, options?: IpcOptions): Promise<T> {
    const headers = options?.headers ?? {};
    // Copy binary bodies: the bridge may reuse its buffers.
    const recorded = args instanceof Uint8Array ? args.slice() : args;
    this.calls.push({ cmd, args: recorded, ...(options?.headers ? { headers } : {}) });
    const handler = this.handlers.get(cmd);
    if (!handler) throw { code: 'other', detail: `no fake for ${cmd}` };
    return (await handler(args, headers)) as T;
  }

  async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    const h = handler as (payload: unknown) => void;
    set.add(h);
    return () => set.delete(h);
  }

  async onDragDrop(handler: (event: DragDropPayload) => void): Promise<() => void> {
    this.dropHandlers.add(handler);
    return () => this.dropHandlers.delete(handler);
  }

  async onCloseRequested(handler: () => void): Promise<() => void> {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /**
   * The user clicks the window's close button. Like Tauri: with a listener
   * the window stays open and the listeners run; returns whether it closes.
   */
  requestClose(): boolean {
    const handlers = [...this.closeHandlers];
    for (const h of handlers) h();
    return handlers.length === 0;
  }

  get closeListenerCount(): number {
    return this.closeHandlers.size;
  }

  emit(event: string, payload: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h(payload);
  }

  drop(event: DragDropPayload): void {
    for (const h of this.dropHandlers) h(event);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  get dropListenerCount(): number {
    return this.dropHandlers.size;
  }

  callsOf(cmd: string): Call[] {
    return this.calls.filter((c) => c.cmd === cmd);
  }
}

export function fakeBridge(os: Bridge['os'] = 'linux'): { ipc: FakeIpc; bridge: Bridge } {
  const ipc = new FakeIpc();
  return { ipc, bridge: new Bridge(ipc, os) };
}

/** Builds a TSB1 frame like src-tauri/src/framing.rs. */
export function frame(header: unknown, payload: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const offset = Math.ceil((8 + json.length) / 4) * 4;
  const out = new Uint8Array(offset + payload.length);
  out.set([0x54, 0x53, 0x42, 0x31]);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(payload, offset);
  return out.buffer;
}

export function f32Bytes(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return out;
}

/** Lets pending promise callbacks run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
