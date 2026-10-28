/**
 * What each build contains. Builds the front end in memory, once as the web
 * app and once as the Tauri CLI builds it for the desktop app:
 * - No build names a video downloader: the check in scripts/lib/common.sh
 *   stops a release build that does.
 * - The web app never runs in the desktop app's window: the desktop platform
 *   stays out of it completely.
 * - "Entdecken" is only in a build that offers it (a list comes with the app
 *   or a list address is set): here the desktop build with VITE_WEB_ORIGIN
 *   and a web build as it is released with a list, not the web build
 *   without the list that comes with the app (SOURCES_SNAPSHOT=off) and
 *   without settings. Since 0.2 a list comes with the app: the public
 *   desktop app as the owner builds it (no web address, no contact, release
 *   check off) has "Entdecken" from that list, without "Melden". Since 0.3
 *   the desktop app builds the list itself once a day (sources_fetch); the
 *   web app cannot (CORS) and has none of that code.
 * - The web build with "Entdecken" pulls in more code (its pages, the hand-off
 *   to "Hinzufügen", its help): it leaves out the desktop platform just the same.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The variables the builds below depend on; unset ones are left empty, so no .env file can switch anything on. */
const SETTINGS = ['TAURI_ENV_PLATFORM', 'SOURCES_SNAPSHOT', 'SOURCES_RELEASE_CHECK', 'SOURCES_RELEASE_CHECK_REPORT', 'VITE_SOURCES_CONTACT', 'VITE_WEB_ORIGIN', 'VITE_SOURCES_INDEX_URL', 'VITE_SELF_UPDATE'] as const;
type Settings = Partial<Record<(typeof SETTINGS)[number], string>>;

async function withSettings<T>(settings: Settings, run: () => Promise<T>): Promise<T> {
  const saved = new Map(SETTINGS.map((name) => [name, process.env[name]]));
  for (const name of SETTINGS) {
    const value = settings[name];
    if (value !== undefined) process.env[name] = value;
    else if (name.startsWith('VITE_')) process.env[name] = '';
    else delete process.env[name];
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function buildApp(sourcemap = false) {
  return build({ root, mode: 'production', logLevel: 'silent', build: { write: false, sourcemap } });
}

interface Bundle {
  /** The JavaScript of every chunk, by file name. */
  chunks: Map<string, string>;
  /** The source map files as they are published, by file name (only with source maps). */
  maps: Map<string, string>;
  /** The source files the maps name. */
  sources: string[];
  /** The other files (service worker, manifest, icons, index.html …), as text. */
  files: Map<string, string>;
}

async function bundle(settings: Settings, sourcemap = false): Promise<Bundle> {
  const result = await withSettings(settings, () => buildApp(sourcemap));
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const chunks = new Map<string, string>();
  const maps = new Map<string, string>();
  const sources: string[] = [];
  const files = new Map<string, string>();
  for (const out of outputs) {
    for (const item of out.output) {
      if (item.type === 'chunk') {
        chunks.set(item.fileName, item.code);
        if (item.map) sources.push(...item.map.sources);
      } else if (item.fileName.endsWith('.map')) {
        maps.set(item.fileName, typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source));
      } else {
        files.set(item.fileName, typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source));
      }
    }
  }
  return { chunks, maps, sources, files };
}

let builds: Promise<{ web: Bundle; webSources: Bundle; desktop: Bundle; ownList: Bundle }> | undefined;

/**
 * The web app without any settings and the web app as it is released with
 * "Entdecken", both with their source maps as they are published, and the
 * desktop app with the settings of a release with "Entdecken".
 */
function allBuilds() {
  builds ??= (async () => ({
    // Without the list that comes with the app (it has entries since 0.2) and without a list address: no "Entdecken".
    web: await bundle({ SOURCES_SNAPSHOT: 'off' }, true),
    webSources: await bundle({ VITE_SOURCES_INDEX_URL: '/quellen/index-v1.json', VITE_SOURCES_CONTACT: 'quellen@studio.example.de' }, true),
    desktop: await bundle({ TAURI_ENV_PLATFORM: 'linux', VITE_WEB_ORIGIN: 'https://studio.example.de', VITE_SOURCES_CONTACT: 'quellen@studio.example.de' }),
    // The public desktop app as the owner builds it: the list comes with it, no web address, no contact, check off.
    ownList: await bundle({ TAURI_ENV_PLATFORM: 'linux', SOURCES_RELEASE_CHECK: 'off' }),
  }))();
  return builds;
}

/** What scripts/lib/common.sh refuses to find in dist/: the name of a video downloader or site. */
const DOWNLOADER = /yt-dlp|ytdlp|youtube/gi;

/** Texts of "Entdecken" outside its page: the help section, the tip on "Hinzufügen", the line in the privacy text. */
const SOURCES_TEXTS = ['Freie Inhalte entdecken', 'Freie Hörspiele entdecken', 'die zuletzt geladene Liste von „Entdecken“'];

function count(chunks: Map<string, string>, text: string | RegExp): number {
  let n = 0;
  for (const code of chunks.values()) n += typeof text === 'string' ? code.split(text).length - 1 : (code.match(text) ?? []).length;
  return n;
}

describe('the web build', () => {
  it('names no video downloader, and keeps the desktop platform out of the web app', async () => {
    const { web, webSources, desktop, ownList } = await allBuilds();
    for (const [label, b] of [
      ['Desktop', desktop],
      ['Desktop, eigene Liste', ownList],
      ['ohne Entdecken', web],
      ['mit Entdecken', webSources],
    ] as const) {
      expect(count(b.chunks, DOWNLOADER), label).toBe(0);
      expect(count(b.maps, DOWNLOADER), label).toBe(0);
    }
    expect(count(desktop.chunks, 'plugin:window|destroy')).toBeGreaterThan(0);
    for (const [label, b] of [
      ['ohne Entdecken', web],
      ['mit Entdecken', webSources],
    ] as const) {
      expect(b.maps.size, label).toBeGreaterThan(0);
      expect(count(b.chunks, 'plugin:window|destroy'), label).toBe(0);
      expect(b.sources.filter((s) => /platform\/tauri\//.test(s)), label).toEqual([]);
    }
  }, 300_000);

  it('has "Entdecken" only when the build offers it', async () => {
    const { web, webSources, desktop, ownList } = await allBuilds();
    for (const text of SOURCES_TEXTS) {
      expect(count(desktop.chunks, text), text).toBeGreaterThan(0);
      expect(count(webSources.chunks, text), text).toBeGreaterThan(0);
      expect(count(web.chunks, text), text).toBe(0);
      // The list that comes with the app is enough: "Entdecken" works from it without a list address.
      expect(count(ownList.chunks, text), `mitgelieferte Liste: ${text}`).toBeGreaterThan(0);
    }
    // The desktop app builds its list itself, once a day; it says so in the privacy text, and has no "Melden" without a contact address.
    expect(count(ownList.chunks, 'höchstens einmal am Tag selbst zusammen')).toBeGreaterThan(0);
    expect(count(ownList.chunks, 'sources_fetch')).toBeGreaterThan(0);
    expect(count(webSources.chunks, 'sources_fetch')).toBe(0);
    expect(count(ownList.chunks, 'quellen@studio.example.de')).toBe(0);
  }, 300_000);

  it('makes only the web app installable, with its service worker of this very build', async () => {
    const { web, webSources, desktop, ownList } = await allBuilds();
    for (const [label, b] of [
      ['ohne Entdecken', web],
      ['mit Entdecken', webSources],
    ] as const) {
      const version = /<meta name="tonuino-build" content="(\w+)"/.exec(b.files.get('index.html') ?? '')?.[1];
      expect(version, label).toBeTruthy();
      const sw = b.files.get('sw.js') ?? '';
      expect(sw, label).toContain(`const VERSION = "${version}";`);
      // The page's first files are kept at install, and all of them exist.
      const shell = JSON.parse(/const SHELL = (\[.*?\]);/.exec(sw)![1]) as string[];
      for (const f of shell.filter((x) => x.startsWith('assets/'))) expect(b.chunks.has(f) || b.files.has(f), `${label}: ${f}`).toBe(true);
      expect(JSON.parse(b.files.get('manifest.webmanifest') ?? '{}').icons.length, label).toBeGreaterThan(2);
      expect(b.files.has('icons/icon-maskable-512.png'), label).toBe(true);
      expect(b.files.get('index.html'), label).toContain('rel="manifest"');
    }
    for (const [label, b] of [
      ['Desktop', desktop],
      ['Desktop, eigene Liste', ownList],
    ] as const) {
      expect([...b.files.keys()].filter((f) => f === 'sw.js' || f === 'manifest.webmanifest' || f.startsWith('icons/')), label).toEqual([]);
      expect(b.files.get('index.html'), label).not.toContain('tonuino-build');
      // Without VITE_SELF_UPDATE the desktop app has no updater code.
      expect(count(b.chunks, 'plugin:updater|'), label).toBe(0);
    }
  }, 300_000);

  it('publishes source maps without the source text', async () => {
    const { web, webSources } = await allBuilds();
    for (const b of [web, webSources]) {
      expect(b.maps.size).toBeGreaterThan(0);
      for (const [fileName, text] of b.maps) {
        const sources = (JSON.parse(text) as { sourcesContent?: (string | null)[] }).sourcesContent ?? [];
        expect(sources.filter((s) => s !== null), fileName).toEqual([]);
      }
    }
  }, 300_000);
});

describe('the release check of "Entdecken"', () => {
  it('stops a build that offers "Entdecken" without the settings it needs, and says what is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-check-'));
    const report = join(dir, 'report.txt');
    try {
      const failed = withSettings({ VITE_SOURCES_INDEX_URL: '/quellen/index-preview.json', SOURCES_RELEASE_CHECK_REPORT: report }, () => buildApp());
      await expect(failed).rejects.toThrow(/VITE_SOURCES_CONTACT fehlt.*SOURCES_RELEASE_CHECK=off/);
      // For the build scripts, one problem per line.
      expect(readFileSync(report, 'utf8')).toBe('VITE_SOURCES_CONTACT fehlt oder ist keine E-Mail-Adresse. Ohne sie gibt es kein „Melden“.\n');
      const desktop = withSettings({ TAURI_ENV_PLATFORM: 'linux', VITE_SOURCES_CONTACT: 'quellen@studio.example.de', VITE_SOURCES_INDEX_URL: '/quellen/index-preview.json' }, () => buildApp());
      await expect(desktop).rejects.toThrow(/VITE_SOURCES_INDEX_URL muss für die Desktop-App eine vollständige https-Adresse sein/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Two builds that stop early: still several seconds each while the whole suite keeps the machine busy.
  }, 180_000);
});
