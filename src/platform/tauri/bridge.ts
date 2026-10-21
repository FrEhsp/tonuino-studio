import { toPlatformError, type ErrorArea } from './errors';
import type { IpcArgs, IpcOptions, TauriIpc } from './ipc';

export type DesktopOs = 'linux' | 'windows' | 'macos' | 'other';

/** Commands that change files: a "permission" error there means the app may not write. */
const WRITE_COMMANDS = new Set(['fs_write', 'fs_write_chunk', 'fs_write_finish', 'fs_mkdir', 'fs_remove', 'fs_rename', 'fs_copy', 'fs_make_writable']);

/** The path a write command was about: `path`, `to` or the x-path header. */
function writtenPath(args: IpcArgs | undefined, options: IpcOptions | undefined): string | undefined {
  const header = options?.headers?.['x-path'];
  if (header) {
    try {
      return decodeURIComponent(header);
    } catch {
      return undefined;
    }
  }
  if (!args || args instanceof Uint8Array || args instanceof ArrayBuffer) return undefined;
  const p = args.path ?? args.to;
  return typeof p === 'string' ? p : undefined;
}

/** Invokes commands and turns backend errors into German TauriPlatformErrors. */
export class Bridge {
  private readonly deniedListeners = new Set<(path: string) => void>();

  constructor(
    readonly ipc: TauriIpc,
    readonly os: DesktopOs,
  ) {}

  async call<T>(area: ErrorArea, cmd: string, args?: IpcArgs, options?: IpcOptions): Promise<T> {
    try {
      return await this.ipc.invoke<T>(cmd, args, options);
    } catch (e) {
      const err = toPlatformError(e, area);
      if (err.code === 'permission' && WRITE_COMMANDS.has(cmd)) {
        const path = writtenPath(args, options);
        if (path) for (const cb of [...this.deniedListeners]) cb(path);
      }
      throw err;
    }
  }

  /** Called with the path whenever a write command fails for lack of rights. */
  onWriteDenied(cb: (path: string) => void): () => void {
    this.deniedListeners.add(cb);
    return () => this.deniedListeners.delete(cb);
  }

  get sep(): string {
    return this.os === 'windows' ? '\\' : '/';
  }
}

export function detectOs(userAgent: string): DesktopOs {
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux|X11|CrOS/i.test(userAgent)) return 'linux';
  return 'other';
}

/** Header-safe path encoding (headers must be ASCII). */
export function encodeHeader(value: string): string {
  return encodeURIComponent(value);
}

let counter = 0;
export function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
