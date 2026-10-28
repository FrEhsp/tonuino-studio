import { getBundleType } from '@tauri-apps/api/app';

/**
 * How the desktop app was installed, as Tauri tells it: nsis, msi, deb,
 * rpm, appimage or app (src/app/updatesteps.ts). Null when it does not know
 * (built by hand, the Android app).
 */
export async function bundleType(): Promise<string | null> {
  try {
    return (await getBundleType()) ?? null;
  } catch {
    return null;
  }
}
