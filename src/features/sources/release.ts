/**
 * Build settings for "Entdecken". vite.config.ts asks sourcesEnabled()
 * whether a build offers it at all. A production build that does stops when
 * releaseProblems() finds something missing: the desktop app needs the web
 * address to load the current list with its kill switch, and every build
 * needs the address for "Melden", the families' way to report an episode.
 * A build without "Entdecken" needs none of these settings.
 *
 * No imports: vite.config.ts loads this file before anything is built.
 */

/** An e-mail address as "Melden" needs it. */
export function isContactAddress(value: string | undefined): boolean {
  const c = value?.trim();
  return !!c && /^[^@\s/?#:]+@[^@\s/?#:]+\.[^@\s/?#:]+$/.test(c);
}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ReleaseEnv {
  VITE_SOURCES_CONTACT?: string;
  VITE_WEB_ORIGIN?: string;
  VITE_SOURCES_INDEX_URL?: string;
}

export type BuildTarget = 'web' | 'desktop';

/**
 * Whether the build was given an address for the list:
 * VITE_SOURCES_INDEX_URL, or for the desktop app VITE_WEB_ORIGIN, from where
 * it loads the list. The web app's own server does not count, every web
 * build has one.
 */
export function listAddressSet(env: ReleaseEnv, target: BuildTarget): boolean {
  if (env.VITE_SOURCES_INDEX_URL?.trim()) return true;
  return target === 'desktop' && !!env.VITE_WEB_ORIGIN?.trim();
}

/**
 * Whether a build offers "Entdecken": only when it has a list to show, the
 * one that comes with the app (sources/snapshot/index-v1.json with entries)
 * or one from an address set for the build. The desktop app (`localList`)
 * builds its list itself from the catalogue that comes with it
 * (src/core/sources/local.ts). Otherwise the build leaves out
 * the menu item, the page, the tip on "Hinzufügen", the help section and the
 * parts of the privacy text about it (`__SOURCES_ENABLED__`).
 */
export function sourcesEnabled(env: ReleaseEnv, target: BuildTarget, bundledEntries: number, localList = false): boolean {
  return localList || bundledEntries > 0 || listAddressSet(env, target);
}

/** How many entries the text of a list file has; 0 when it is no list. */
export function entryCount(json: string): number {
  try {
    const entries = (JSON.parse(json) as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) ? entries.length : 0;
  } catch {
    return 0;
  }
}

/**
 * What a release build with "Entdecken" still lacks, in words for the person who builds it; empty when nothing.
 * `localList`: the desktop app, which builds its list itself and needs no address for it.
 * `bundledOnly`: the Android app, which shows the list that comes with it; it
 * needs no address either, unless the build names one anyway.
 */
export function releaseProblems(env: ReleaseEnv, target: BuildTarget, localList = false, bundledOnly = false): string[] {
  const problems: string[] = [];
  if (!isContactAddress(env.VITE_SOURCES_CONTACT)) problems.push('VITE_SOURCES_CONTACT fehlt oder ist keine E-Mail-Adresse. Ohne sie gibt es kein „Melden“.');
  const override = env.VITE_SOURCES_INDEX_URL?.trim();
  const origin = env.VITE_WEB_ORIGIN?.trim();
  // The desktop app builds its list itself: the list and its kill switch come from the catalogue it was built with.
  if (target === 'desktop' && localList) return problems;
  if (target === 'desktop' && bundledOnly && !override && !origin) return problems;
  if (target === 'desktop') {
    // The desktop app has no web server of its own: the list needs a full https address.
    if (override) {
      if (!isHttps(override)) problems.push('VITE_SOURCES_INDEX_URL muss für die Desktop-App eine vollständige https-Adresse sein.');
    } else if (!origin) {
      problems.push('VITE_WEB_ORIGIN (https://…) fehlt. Ohne sie lädt die Desktop-App die Liste nie und bekommt keine Sperrliste.');
    } else if (!isHttps(origin)) {
      problems.push('VITE_WEB_ORIGIN muss eine https-Adresse sein (https://…). Sonst lädt die Desktop-App die Liste nie und bekommt keine Sperrliste.');
    }
  } else if (override) {
    let ok = false;
    try {
      ok = ['https:', 'http:'].includes(new URL(override, 'https://studio.invalid/').protocol);
    } catch {
      ok = false;
    }
    if (!ok) problems.push('VITE_SOURCES_INDEX_URL ist keine gültige Adresse.');
  }
  return problems;
}
