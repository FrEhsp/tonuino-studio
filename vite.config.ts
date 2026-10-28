import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { licenseFilePlugins } from './scripts/licenses.ts';
import { pwaPlugin } from './scripts/pwa.ts';
import { LICENSE_FILE_NAME } from './src/features/help/licensefile.ts';
import { FONT_NOTICES } from './src/features/help/notices.ts';
import { entryCount, releaseProblems, sourcesEnabled, type BuildTarget, type ReleaseEnv } from './src/features/sources/release.ts';

// The licence texts of every bundled package, and of the Rust crates in the desktop app.
const licenses = licenseFilePlugins({ fileName: LICENSE_FILE_NAME, cargoManifest: 'src-tauri/Cargo.toml', fonts: FONT_NOTICES });

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const ENV_PREFIX = ['VITE_', 'TAURI_ENV_'];

/**
 * The list that comes with the app (sources/snapshot/index-v1.json).
 * SOURCES_SNAPSHOT=off builds without it: an empty list takes its place
 * (sources/snapshot/leer.json), so a build without any list address has no
 * "Entdecken".
 */
function bundledList(): string {
  return process.env.SOURCES_SNAPSHOT === 'off' ? './sources/snapshot/leer.json' : './sources/snapshot/index-v1.json';
}

/** Entries of the list that comes with the app. */
function bundledEntries(): number {
  try {
    return entryCount(readFileSync(new URL(bundledList(), import.meta.url), 'utf8'));
  } catch {
    return 0;
  }
}

/**
 * Says whether a production build offers "Entdecken", and stops one that
 * does but lacks the settings it needs (docs/BUILD.md, sources/README.md).
 * SOURCES_RELEASE_CHECK=off turns the stop into a warning, for test builds
 * only. When SOURCES_RELEASE_CHECK_REPORT names a file, the problems also go
 * there, one per line: the build scripts print them with what to do.
 */
function sourcesReleaseCheck(env: ReleaseEnv, target: BuildTarget, enabled: boolean, localList: boolean, bundledOnly: boolean): Plugin {
  return {
    name: 'sources-release-check',
    apply: 'build',
    configResolved(config) {
      if (config.build.ssr || config.mode !== 'production') return;
      if (!enabled) {
        config.logger.info('Entdecken: aus (keine Liste dabei und keine Adresse für die Liste gesetzt).');
        return;
      }
      const problems = releaseProblems(env, target, localList, bundledOnly);
      if (!problems.length) {
        config.logger.info('Entdecken: an.');
        return;
      }
      const text = `Entdecken: ${problems.join(' ')}`;
      if (process.env.SOURCES_RELEASE_CHECK === 'off') {
        config.logger.warn(`${text} (SOURCES_RELEASE_CHECK=off: nur für Testbuilds)`);
        return;
      }
      const report = process.env.SOURCES_RELEASE_CHECK_REPORT;
      if (report) writeFileSync(report, problems.map((p) => `${p}\n`).join(''));
      throw new Error(`${text} Für einen Testbuild ohne diese Angaben: SOURCES_RELEASE_CHECK=off.`);
    },
  };
}

/**
 * The font files of the first screen (src/ui/fontsReady.ts), fetched
 * while the page is still read instead of once the app's script runs: the
 * first frame waits for them, so they should be there by then.
 */
// Since 0.6 the app writes in Roboto (400, 500, 700); the stamp of the made covers on the shelf
// (--font-sticker-stamp) stays Permanent Marker. Fira Sans and Shantell Sans no longer show at the
// start: their files only took the place of Roboto's, which the first frame waits for (Prüfrunde 2, webkit W6).
const FIRST_SCREEN_FONT_FILES = /^assets\/(roboto-latin-(400|500|700)-normal|permanent-marker-latin)-[\w-]{8}\.woff2$/;
function firstScreenFontPreload(): Plugin {
  return {
    name: 'first-screen-font-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        // The app's own font first: the first frame waits for it.
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => FIRST_SCREEN_FONT_FILES.test(f)).sort((a, b) => Number(b.includes('roboto')) - Number(a.includes('roboto')) || a.localeCompare(b));
        return files.map((f) => ({ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: '', href: `./${f}` }, injectTo: 'head' as const }));
      },
    },
  };
}

// Tauri expects a fixed port and does not need the browser to open.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, ENV_PREFIX);
  // The Tauri CLI sets TAURI_ENV_PLATFORM while it builds or serves the front end for the desktop app.
  const target: BuildTarget = process.env.TAURI_ENV_PLATFORM ? 'desktop' : 'web';
  // The Android app (scripts/build-android.sh) has the Tauri platform too, but builds no list itself:
  // its backend has no HTTPS of its own (src-tauri/Cargo.toml), so it shows the list that comes with it.
  const android = process.env.TAURI_ENV_PLATFORM === 'android';
  // The desktop app builds the list of "Entdecken" itself, at most once a day (src/core/sources/local.ts),
  // unless the build names another list (VITE_SOURCES_INDEX_URL, e.g. a preview).
  const localList = target === 'desktop' && !android && !env.VITE_SOURCES_INDEX_URL?.trim();
  // "Entdecken" only with a list to show (src/features/sources/release.ts); the tests see it.
  const bundled = bundledEntries();
  const entdecken = mode === 'test' || sourcesEnabled(env, target, bundled, localList);
  // The desktop app replaces itself with Tauri's updater (src/platform/tauri/updater.ts), only in a build
  // that has the plugin and its key (docs/BUILD.md, "Automatische Updates"): VITE_SELF_UPDATE=on.
  const selfUpdate = target === 'desktop' && !android && env.VITE_SELF_UPDATE === 'on';
  return {
    // The web app is installable and has a service worker (scripts/pwa.ts); the apps update in their own way.
    plugins: [preact(), licenses.main, sourcesReleaseCheck(env, target, entdecken, localList, android), firstScreenFontPreload(), pwaPlugin(target === 'web' && mode !== 'test')],
    // Relative paths: the web app runs from any folder of a website (for example example.org/test/), not only from the top.
    base: './',
    clearScreen: false,
    server: { port: 5173, strictPort: true },
    envPrefix: ENV_PREFIX,
    resolve: {
      alias: [{ find: /^(?:\.\.\/)+sources\/snapshot\/index-v1\.json$/, replacement: fileURLToPath(new URL(bundledList(), import.meta.url)) }],
    },
    define: {
      // What only the desktop app can do stays out of the web build; the tests see everything.
      __DESKTOP_BUILD__: JSON.stringify(mode === 'test' || target === 'desktop'),
      __SOURCES_ENABLED__: JSON.stringify(entdecken),
      // The desktop app builds the list of "Entdecken" itself (see localList above); the tests see it.
      __LOCAL_SOURCES__: JSON.stringify(mode === 'test' || localList),
      // A list comes with the app: "Entdecken" works from it also without an address for a newer list.
      __SOURCES_BUNDLED__: JSON.stringify(mode !== 'test' && bundled > 0),
      // The desktop app can update itself (see selfUpdate above).
      __SELF_UPDATE__: JSON.stringify(selfUpdate),
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      // The maps carry no source text: they stay small, and the sources hold
      // texts of parts a build leaves out (desktop-only, "Entdecken").
      rolldownOptions: {
        output: {
          sourcemapExcludeSources: true,
          // What the first page needs comes as one file next to the entry, not as dozens of small
          // shared ones: in the desktop app every file is a request through the app (TODO #70).
          // The other pages come as their own files (src/app/App.tsx).
          codeSplitting: { groups: [{ name: 'start', tags: ['$initial'] }] },
        },
      },
      chunkSizeWarningLimit: 2000,
    },
    worker: { format: 'es', plugins: licenses.worker, rolldownOptions: { output: { sourcemapExcludeSources: true } } },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
      // The default of 5 s per test: tests with real audio work or builds set a longer one themselves (SLOW in their files).
    },
  };
});
