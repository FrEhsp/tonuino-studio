/** Build setting for "Neue Version da" (src/app/updatecheck.ts). */
interface ImportMetaEnv {
  /** Public list of releases (https), e.g. a GitHub "releases/latest" API address. Without it the app never asks. */
  readonly VITE_RELEASES_URL?: string;
  /** "on": the desktop build has Tauri's updater and its key (docs/BUILD.md, "Automatische Updates"). */
  readonly VITE_SELF_UPDATE?: string;
}
