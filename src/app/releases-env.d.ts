/** Build setting for "Neue Version da" (src/app/updatecheck.ts). */
interface ImportMetaEnv {
  /** Public list of releases (https), e.g. a GitHub "releases/latest" API address. Without it the app never asks. */
  readonly VITE_RELEASES_URL?: string;
}
