/** Build settings of the help (Vite reads them from the environment at build time). */
interface ImportMetaEnv {
  /** Download page of the desktop app ("https://…"); the web app links it where it recommends the desktop app. */
  readonly VITE_DESKTOP_DOWNLOAD_URL?: string;
  /** Download of the Android app ("https://…", the APK or its release page); the web app links it on Android phones. */
  readonly VITE_ANDROID_DOWNLOAD_URL?: string;
}
