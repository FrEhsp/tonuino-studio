/**
 * Runtime check without any Tauri imports, so main.tsx can call it before
 * deciding which platform to load (only in the desktop build; the web build
 * leaves the desktop platform out, see __DESKTOP_BUILD__):
 *
 *   const p = isTauri() ? (await import('./platform/tauri')).createTauriPlatform() : …;
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
}

/**
 * The Tauri app on an Android phone (the APK, scripts/build-android.sh):
 * Tauri, and the WebView says Android. main.tsx then loads
 * createAndroidPlatform (./android.ts) instead of the desktop platform.
 */
export function isTauriAndroid(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return isTauri() && /\bAndroid\b/i.test(userAgent);
}
