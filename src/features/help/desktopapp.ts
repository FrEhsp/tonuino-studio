/**
 * Where people download the desktop app: VITE_DESKTOP_DOWNLOAD_URL, set when
 * building the web app. Without it (and in the desktop app itself) the app
 * only names the desktop app and links nothing.
 */

/** The address as a link may use it: https only, else none. */
export function desktopDownloadUrl(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  try {
    return new URL(v).protocol === 'https:' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The download address of this build; only the web build links it. */
export const DESKTOP_DOWNLOAD_URL = __DESKTOP_BUILD__ ? undefined : desktopDownloadUrl(import.meta.env.VITE_DESKTOP_DOWNLOAD_URL);
