/**
 * The desktop app updates itself (TODO #123), through Tauri's updater
 * plugin: it loads the new version named in the release's latest.json,
 * checks its signature against the public key in tauri.conf.json
 * (plugins.updater) and installs it. Windows (NSIS setup), the Mac app and
 * the AppImage only; the .deb and the Android app follow updatesteps.ts.
 *
 * Prepared, not yet built in: the Rust side (crate tauri-plugin-updater,
 * registered in src-tauri/src/lib.rs, permission "updater:default") and the
 * signing key are missing, see docs/BUILD.md "Automatische Updates". Until a
 * build sets VITE_SELF_UPDATE=on, `__SELF_UPDATE__` is false and nothing
 * here runs. The calls are those of @tauri-apps/plugin-updater, made with
 * invoke directly, so the app needs no further npm package.
 */
import { Channel, invoke as tauriInvoke } from '@tauri-apps/api/core';

/** Progress of the download, as the plugin reports it. */
export type DownloadEvent = { event: 'Started'; data: { contentLength?: number } } | { event: 'Progress'; data: { chunkLength: number } } | { event: 'Finished' };

interface UpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
}

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Loads and installs the newest version. Resolves with its version, or null
 * when there is none newer than this one. `onProgress` gets the bytes so far
 * and, when the server says so, the whole size.
 */
export async function installNewest(onProgress: (done: number, total?: number) => void, invoke: Invoke = tauriInvoke, channel: () => Channel<DownloadEvent> = () => new Channel<DownloadEvent>()): Promise<string | null> {
  const meta = await invoke<UpdateMetadata | null>('plugin:updater|check', {});
  if (!meta) return null;
  let done = 0;
  let total: number | undefined;
  const events = channel();
  events.onmessage = (e) => {
    if (e.event === 'Started') total = e.data.contentLength;
    else if (e.event === 'Progress') done += e.data.chunkLength;
    onProgress(done, total);
  };
  await invoke('plugin:updater|download_and_install', { onEvent: events, rid: meta.rid });
  return meta.version;
}
