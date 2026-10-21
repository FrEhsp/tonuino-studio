/**
 * Writes lizenzen.json at build time: the licence texts of every npm package
 * the bundles contain (the audio workers included), of every Rust crate the
 * desktop app is compiled from. Names, versions and texts come from the
 * packages' own files and from `cargo metadata`, so the list cannot drift
 * from what ships. The help shows it under "Bausteine anderer Projekte", the
 * Rust part only in the desktop app; src/features/help/licensefile.ts has
 * the format. Fonts that ship as their own files (src/assets/fonts) are
 * listed with the npm packages, with the licence text that lies next to them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
// This file is loaded with the Vite config, whose native loader needs file extensions.
import type { LicenseFile, NoticeEntry } from '../src/features/help/licensefile.ts';
import type { FontNotice } from '../src/features/help/notices.ts';

/* ------------------------------------------------------------------ licence files */

/** LICENSE, LICENSE-MIT, LICENSE_FONT, LICENCE.md, COPYING, NOTICE … at the top of a package. */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;

/** The licence files of a package folder, sorted by name. */
export function licenseFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort();
}

function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').trim();
}

/** Stores each distinct text once; entries point to it by index. */
export class TextStore {
  readonly texts: string[] = [];
  private readonly index = new Map<string, number>();

  add(text: string): number {
    let i = this.index.get(text);
    if (i === undefined) {
      i = this.texts.push(text) - 1;
      this.index.set(text, i);
    }
    return i;
  }
}

/** The texts of these files in a package folder; the same text twice counts once. */
function textsOf(dir: string, files: readonly string[], store: TextStore): number[] {
  return [...new Set(files.map((f) => store.add(readText(join(dir, f)))))];
}

/** A web address for a repository field: "github:a/b", "a/b", "git+https://…git" or { url }. */
export function repositoryUrl(repo: unknown): string | undefined {
  const raw = typeof repo === 'string' ? repo : repo && typeof repo === 'object' ? (repo as { url?: unknown }).url : undefined;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let url = raw.trim();
  if (/^github:/.test(url)) url = `https://github.com/${url.slice(7)}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  url = url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/#.*$/, '')
    .replace(/\.git$/, '');
  return /^https?:\/\/[^\s]+$/.test(url) ? url : undefined;
}

/* ------------------------------------------------------------------ fonts in the app */

/** Where the fonts of the interface lie, with their licence texts. */
export const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'fonts');

/** The file names a bundle output came from: Vite and Rollup name assets by `names`, `originalFileNames` or `name`. */
function sourceNames(out: { name?: string; names?: string[]; originalFileNames?: string[] }): string[] {
  return [...(out.names ?? []), ...(out.originalFileNames ?? []), ...(out.name ? [out.name] : [])].map((n) => basename(n));
}

/** The fonts of src/assets/fonts whose files are in the bundle, each with its licence text. */
export function bundledFontNotices(fonts: readonly FontNotice[], assetNames: ReadonlySet<string>, store: TextStore, dir = FONT_DIR): NoticeEntry[] {
  return fonts.flatMap((f) =>
    f.bundled && f.bundled.files.some((file) => assetNames.has(file))
      ? [
          {
            name: f.family,
            version: f.bundled.version,
            license: f.license,
            url: f.url,
            texts: [f.bundled.licenseFile, ...(f.bundled.noticeFile ? [f.bundled.noticeFile] : [])].map((file) => store.add(readText(join(dir, file)))),
          },
        ]
      : [],
  );
}

/* ------------------------------------------------------------------ npm */

export interface NpmPackage {
  name: string;
  version: string;
  license?: string;
  authors?: string;
  url?: string;
  dir: string;
}

function personName(p: unknown): string | undefined {
  if (typeof p === 'string') return p.replace(/\s*[<(].*$/, '').trim() || undefined;
  if (p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string') return (p as { name: string }).name;
  return undefined;
}

function npmLicense(pkg: Record<string, unknown>): string | undefined {
  if (typeof pkg.license === 'string') return pkg.license.trim();
  // Old packages: "licenses": [{ "type": "MIT" }].
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (l && typeof l === 'object' ? (l as { type?: unknown }).type : l)).filter((t): t is string => typeof t === 'string');
    return types.length ? types.join(' OR ') : undefined;
  }
  return undefined;
}

/** True for node_modules/<name> and node_modules/@scope/<name>, where npm puts a package. */
function isPackageRoot(dir: string): boolean {
  const parts = dir.split('/');
  const parent = parts[parts.length - 2];
  return parent === 'node_modules' || (parent?.startsWith('@') === true && parts[parts.length - 3] === 'node_modules');
}

/**
 * The package a bundled file belongs to: the folder npm installed it in,
 * node_modules/<name> or node_modules/@scope/<name>. Package files deeper
 * inside, like preact/hooks/package.json, only describe a part of it. Ids
 * are the bundler's module ids, which may carry a query such as "?url".
 */
export function packageOf(moduleId: string, cache = new Map<string, NpmPackage | null>()): NpmPackage | undefined {
  if (moduleId.startsWith('\0')) return undefined;
  const file = moduleId.replace(/[?#].*$/, '').replace(/\\/g, '/');
  let dir = dirname(file);
  while (dir.includes('/node_modules/') && !isPackageRoot(dir)) dir = dirname(dir);
  if (!dir.includes('/node_modules/')) return undefined;
  const known = cache.get(dir);
  if (known !== undefined) return known ?? undefined;
  let found: NpmPackage | null = null;
  const manifest = join(dir, 'package.json');
  if (existsSync(manifest)) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    if (typeof pkg.name === 'string' && pkg.name) {
      found = {
        name: pkg.name,
        version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
        license: npmLicense(pkg),
        authors: personName(pkg.author),
        url: repositoryUrl(pkg.repository) ?? (typeof pkg.homepage === 'string' ? repositoryUrl(pkg.homepage) : undefined),
        dir,
      };
    }
  }
  cache.set(dir, found);
  return found ?? undefined;
}

/** Collects the packages of every module id it is given, from the main bundle and the workers. */
export class NpmCollector {
  private readonly cache = new Map<string, NpmPackage | null>();
  private readonly found = new Map<string, NpmPackage>();

  add(moduleId: string): void {
    const pkg = packageOf(moduleId, this.cache);
    if (pkg) this.found.set(`${pkg.name}@${pkg.version}`, pkg);
  }

  packages(): NpmPackage[] {
    return [...this.found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  }
}

export function npmNotices(packages: readonly NpmPackage[], store: TextStore): NoticeEntry[] {
  return packages.map((p) => ({
    name: p.name,
    version: p.version,
    ...(p.license ? { license: p.license } : {}),
    ...(p.authors ? { authors: p.authors } : {}),
    ...(p.url ? { url: p.url } : {}),
    texts: textsOf(p.dir, licenseFilesIn(p.dir), store),
  }));
}

/* ------------------------------------------------------------------ Rust */

/** The part of `cargo metadata --format-version 1` used here. */
export interface CargoMetadata {
  packages: {
    id: string;
    name: string;
    version: string;
    license?: string | null;
    license_file?: string | null;
    authors?: string[];
    repository?: string | null;
    homepage?: string | null;
    manifest_path: string;
  }[];
  workspace_members: string[];
  resolve: { root: string | null; nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] } | null;
}

/**
 * The crates the app is built from: everything reachable from the app over
 * normal and build dependencies, without the app itself. Dev dependencies
 * only serve the tests and do not ship.
 */
export function cargoCrates(meta: CargoMetadata): CargoMetadata['packages'] {
  const root = meta.resolve?.root;
  if (!meta.resolve || !root) throw new Error('cargo metadata has no dependency graph (resolve.root is missing)');
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some((k) => k.kind !== 'dev')) stack.push(dep.pkg);
  }
  const own = new Set(meta.workspace_members);
  return meta.packages.filter((p) => seen.has(p.id) && !own.has(p.id)).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function rustNotices(crates: CargoMetadata['packages'], store: TextStore): NoticeEntry[] {
  return crates.map((c) => {
    const dir = dirname(c.manifest_path);
    const files = new Set(licenseFilesIn(dir));
    // A licence file named in Cargo.toml may sit elsewhere, e.g. "../LICENSE.txt".
    if (c.license_file && existsSync(join(dir, c.license_file))) files.add(c.license_file);
    const authors = (c.authors ?? []).map(personName).filter(Boolean).join(', ');
    const url = repositoryUrl(c.repository ?? undefined) ?? repositoryUrl(c.homepage ?? undefined);
    return {
      name: c.name,
      version: c.version,
      ...(c.license ? { license: c.license } : {}),
      ...(authors ? { authors } : {}),
      ...(url ? { url } : {}),
      texts: textsOf(dir, [...files].sort(), store),
    };
  });
}

/**
 * Asks cargo for the crates of the desktop app. Without a target it lists
 * those of every platform, a few more than one build contains.
 */
export function readCargoMetadata(manifestPath: string, targetTriple?: string): CargoMetadata {
  const args = ['metadata', '--format-version', '1', '--manifest-path', manifestPath];
  if (targetTriple) args.push('--filter-platform', targetTriple);
  return JSON.parse(execFileSync('cargo', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })) as CargoMetadata;
}

/* ------------------------------------------------------------------ Vite */

export interface LicensePluginOptions {
  /** Name of the file next to index.html, LICENSE_FILE_NAME of the app. */
  fileName: string;
  /** src-tauri/Cargo.toml of the desktop app. */
  cargoManifest: string;
  /** Defaults to process.env; tests pass their own. */
  env?: Record<string, string | undefined>;
  /** Defaults to running cargo; tests pass a fixture. */
  cargoMetadata?: (manifestPath: string, targetTriple?: string) => CargoMetadata;
  /** The font notices of the app (FONT_NOTICES); the ones in src/assets/fonts are listed when the bundle has their files. */
  fonts?: readonly FontNotice[];
}

/**
 * The plugin for the main build, which writes the file, and the plugins for
 * the worker builds, which only report their packages. Workers are bundled
 * while the main build reads its modules, so their packages are known before
 * the main bundle is written.
 *
 * Every build lists the Rust crates, because the front end of the desktop
 * app is not always built by Tauri itself: build scripts may build it first
 * and tell Tauri to skip that step. Only when Tauri runs the build (it sets
 * TAURI_ENV_*) is it known to be the desktop app, which must not ship
 * without them; any other build may also be the web app and goes on with a
 * warning when cargo is missing.
 */
export function licenseFilePlugins(opts: LicensePluginOptions): { main: Plugin; worker: () => Plugin[] } {
  const env = opts.env ?? process.env;
  const cargoMetadata = opts.cargoMetadata ?? readCargoMetadata;
  const npm = new NpmCollector();
  const assets = new Set<string>();
  const collect = (bundle: Record<string, { type: string; moduleIds?: string[]; name?: string; names?: string[]; originalFileNames?: string[] }>) => {
    for (const out of Object.values(bundle)) {
      if (out.type === 'chunk') for (const id of out.moduleIds ?? []) npm.add(id);
      else for (const name of sourceNames(out)) assets.add(name);
    }
  };
  return {
    main: {
      name: 'tonuino-studio:licenses',
      apply: 'build',
      generateBundle(_, bundle) {
        collect(bundle);
        const store = new TextStore();
        const npmEntries = [...npmNotices(npm.packages(), store), ...bundledFontNotices(opts.fonts ?? [], assets, store)];
        let rustEntries: NoticeEntry[] = [];
        try {
          rustEntries = rustNotices(cargoCrates(cargoMetadata(opts.cargoManifest, env.TAURI_ENV_TARGET_TRIPLE)), store);
        } catch (e) {
          const why = `Could not list the Rust crates for ${opts.fileName}: ${e instanceof Error ? e.message : String(e)}`;
          if (env.TAURI_ENV_PLATFORM) this.error(why);
          this.warn(`${why}. Fine for the web app; the desktop app must not be built from this.`);
        }
        const file: LicenseFile = { npm: npmEntries, rust: rustEntries, texts: store.texts };
        this.emitFile({ type: 'asset', fileName: opts.fileName, source: JSON.stringify(file) });
      },
    },
    worker: () => [
      {
        name: 'tonuino-studio:licenses-worker',
        apply: 'build',
        generateBundle(_, bundle) {
          collect(bundle);
        },
      },
    ],
  };
}
