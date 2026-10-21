/** Build settings of the help (Vite reads them from the environment at build time). */
interface ImportMetaEnv {
  /** Download page of the desktop app ("https://…"); the web app links it where it recommends the desktop app. */
  readonly VITE_DESKTOP_DOWNLOAD_URL?: string;
}
