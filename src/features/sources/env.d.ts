/** Build settings for "Entdecken" (Vite reads them from the environment at build time). */
interface ImportMetaEnv {
  /** Address of the list, e.g. a preview list ("/quellen/index-preview.json"); wins over the default. */
  readonly VITE_SOURCES_INDEX_URL?: string;
  /** Web address of the app ("https://…"); the desktop app loads the list from there. */
  readonly VITE_WEB_ORIGIN?: string;
  /** E-mail address for "Melden"; without it the app shows no report link. */
  readonly VITE_SOURCES_CONTACT?: string;
}
