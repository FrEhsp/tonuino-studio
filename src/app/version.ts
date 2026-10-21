import { version } from '../../package.json';
import type { Platform } from '../platform/types';

/**
 * Version of TonUINO Studio as people see it in the app. The desktop build
 * takes its own number from src-tauri/tauri.conf.json; a test keeps both equal.
 */
export const APP_VERSION: string = version;

/** "Web-App im Browser", "Desktop-App für Windows" or "App für Android", shown next to the version. */
export function runsAs(p: (Pick<Platform, 'kind' | 'os' | 'mobile'> & { capabilities?: Pick<Platform['capabilities'], 'sd' | 'sdPackage'> }) | null | undefined): string {
  if (p?.mobile) return 'App für Android';
  if (p?.kind !== 'desktop') return p?.capabilities && !p.capabilities.sd && p.capabilities.sdPackage ? 'Web-App im Browser (Karte über Pakete)' : 'Web-App im Browser';
  return p.os === 'windows' ? 'Desktop-App für Windows' : p.os === 'linux' ? 'Desktop-App für Linux' : 'Desktop-App';
}
