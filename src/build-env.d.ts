/**
 * True in the desktop app's build and in the tests, false in the web build
 * (set in vite.config.ts). Code behind `if (__DESKTOP_BUILD__)` is left out
 * of the web build.
 */
declare const __DESKTOP_BUILD__: boolean;

/**
 * True when the build offers "Entdecken" (it has a list to show, see
 * sourcesEnabled in src/features/sources/release.ts) and in the tests.
 * Without it, the menu item, the page, the tip on "Hinzufügen", the help
 * section and the parts of the privacy text about it are left out, and
 * #/entdecken opens the start page like any unknown address.
 */
declare const __SOURCES_ENABLED__: boolean;

/**
 * True in the desktop app (unless its build names another list in
 * VITE_SOURCES_INDEX_URL) and in the tests: the app builds the list of
 * "Entdecken" itself, at most once a day, from the sources' own feeds and
 * pages (src/core/sources/local.ts). The web app cannot (CORS) and shows the
 * list that comes with it.
 */
declare const __LOCAL_SOURCES__: boolean;

/**
 * The build brings a list for "Entdecken" (sources/snapshot/index-v1.json
 * with entries). Then "Entdecken" works from that list also in a desktop app
 * built without an address for a newer one (VITE_WEB_ORIGIN): it shows the
 * list it came with and checks on opening which titles are still online.
 */
declare const __SOURCES_BUNDLED__: boolean;

/**
 * True in a desktop build with Tauri's updater (VITE_SELF_UPDATE=on, see
 * docs/BUILD.md "Automatische Updates"): "Neue Version da" then offers
 * "Jetzt aktualisieren" on Windows, the Mac and with the AppImage
 * (src/platform/tauri/updater.ts). False everywhere else, also in the tests.
 */
declare const __SELF_UPDATE__: boolean;
