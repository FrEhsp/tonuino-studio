import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cargoCrates,
  licenseFilePlugins,
  licenseFilesIn,
  npmNotices,
  packageOf,
  repositoryUrl,
  rustNotices,
  TextStore,
  type CargoMetadata,
} from '../../scripts/licenses';
import { isLicenseFile, LICENSE_FILE_NAME, type LicenseFile } from '../../src/features/help/licensefile';
import { FONT_NOTICES } from '../../src/features/help/notices';

const root = fileURLToPath(new URL('../../', import.meta.url));
const nm = (path: string) => join(root, 'node_modules', path);
const versionOf = (name: string) => (JSON.parse(readFileSync(nm(`${name}/package.json`), 'utf8')) as { version: string }).version;

const temp = mkdtempSync(join(tmpdir(), 'licenses-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** A folder with these files in it; a name ending in "/" becomes a folder. */
function folder(name: string, files: Record<string, string>): string {
  const dir = join(temp, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    if (file.endsWith('/')) mkdirSync(join(dir, file), { recursive: true });
    else writeFileSync(join(dir, file), text);
  }
  return dir;
}

describe('npm packages in the bundles', () => {
  it('finds the package a bundled file belongs to', () => {
    // preact/hooks has its own small package.json, but it is part of preact.
    expect(packageOf(nm('preact/hooks/dist/hooks.mjs'))).toMatchObject({ name: 'preact', version: versionOf('preact'), license: 'MIT' });
    // Fonts come in as "…ttf?url".
    expect(packageOf(`${nm('@expo-google-fonts/fredoka/400Regular/Fredoka_400Regular.ttf')}?url`)?.name).toBe('@expo-google-fonts/fredoka');
    // Vite's own helpers and the app's files are no packages.
    expect(packageOf('\0vite/modulepreload-polyfill.js')).toBeUndefined();
    expect(packageOf(join(root, 'src/main.tsx'))).toBeUndefined();
  });

  it('takes the licence files from the package folder', () => {
    const store = new TextStore();
    const [mpg, preact] = npmNotices([packageOf(nm('mpg123-decoder/dist/mpg123-decoder.min.js'))!, packageOf(nm('preact/dist/preact.mjs'))!], store);
    expect(preact).toMatchObject({ name: 'preact', license: 'MIT', url: 'https://github.com/preactjs/preact' });
    expect(preact.texts).toHaveLength(1);
    expect(store.texts[preact.texts[0]]).toContain('Jason Miller');
    // No licence file in the package: the dialog names its licence and authors instead.
    expect(mpg).toMatchObject({ name: 'mpg123-decoder', license: 'MIT', authors: 'Ethan Halsall', texts: [] });
  });

  it('lists licence files only, sorted', () => {
    const dir = folder('pkg', { 'LICENSE-MIT': 'a', NOTICE: 'b', 'COPYING.txt': 'c', 'licence.md': 'd', 'README.md': 'e', 'index.js': '', 'licenses/': '' });
    expect(licenseFilesIn(dir)).toEqual(['COPYING.txt', 'LICENSE-MIT', 'NOTICE', 'licence.md']);
    expect(licenseFilesIn(join(temp, 'nothing-here'))).toEqual([]);
  });

  it('turns repository fields into web addresses', () => {
    expect(repositoryUrl('preactjs/preact')).toBe('https://github.com/preactjs/preact');
    expect(repositoryUrl('github:Stuk/jszip')).toBe('https://github.com/Stuk/jszip');
    expect(repositoryUrl({ type: 'git', url: 'git+https://github.com/eshaz/wasm-audio-decoders.git' })).toBe('https://github.com/eshaz/wasm-audio-decoders');
    expect(repositoryUrl('git://github.com/a/b.git')).toBe('https://github.com/a/b');
    expect(repositoryUrl('git@github.com:a/b.git')).toBe('https://github.com/a/b');
    expect(repositoryUrl('git+ssh://git@github.com/a/b.git')).toBe('https://github.com/a/b');
    expect(repositoryUrl('https://github.com/a/b.git#main')).toBe('https://github.com/a/b');
    expect(repositoryUrl('https://preactjs.com')).toBe('https://preactjs.com');
    for (const nothing of [undefined, null, '', ' ', 42, {}, 'not an address']) expect(repositoryUrl(nothing)).toBeUndefined();
  });

  it('stores a text that several packages share once', () => {
    const store = new TextStore();
    expect(store.add('MIT')).toBe(0);
    expect(store.add('Apache')).toBe(1);
    expect(store.add('MIT')).toBe(0);
    expect(store.texts).toEqual(['MIT', 'Apache']);
  });
});

/* ------------------------------------------------------------------ Rust */

type Crate = CargoMetadata['packages'][number];

function crate(name: string, dir: string, extra: Partial<Crate> = {}): Crate {
  return { id: `${name} 1.0.0`, name, version: '1.0.0', manifest_path: join(dir, 'Cargo.toml'), ...extra };
}

/** The app, its normal and build dependencies, a dev dependency and an unused crate. */
function metadata(): CargoMetadata {
  const ids = ['app', 'serde', 'libc', 'cc', 'both', 'proptest', 'rand', 'unused'];
  const node = (id: string, deps: [string, string | null][] = []) => ({
    id: `${id} 1.0.0`,
    deps: deps.map(([pkg, kind]) => ({ pkg: `${pkg} 1.0.0`, dep_kinds: [{ kind }] })),
  });
  return {
    packages: ids.map((id) => crate(id, join(temp, 'crates', id))),
    workspace_members: ['app 1.0.0'],
    resolve: {
      root: 'app 1.0.0',
      nodes: [
        node('app', [
          ['serde', null],
          ['cc', 'build'],
          ['proptest', 'dev'],
        ]),
        node('serde', [['libc', null]]),
        node('proptest', [['rand', null]]),
        // Wanted by the tests and by the app itself.
        { id: 'both 1.0.0', deps: [] },
        node('libc', [['both', null]]),
        node('rand', [['both', 'dev']]),
      ],
    },
  };
}

describe('Rust crates in the desktop app', () => {
  it('takes what the app is built from, without dev dependencies and without the app itself', () => {
    expect(cargoCrates(metadata()).map((c) => c.name)).toEqual(['both', 'cc', 'libc', 'serde']);
  });

  it('stops when cargo gives no dependency graph', () => {
    expect(() => cargoCrates({ ...metadata(), resolve: null })).toThrow(/resolve/);
  });

  it('reads licence files, the license_file of Cargo.toml, authors and addresses', () => {
    const mit = 'Permission is hereby granted, free of charge …';
    const dual = folder('crates/serde', { 'LICENSE-MIT': mit, 'LICENSE-APACHE': 'Apache License 2.0 …' });
    folder('crates/shared', { 'LICENSE.txt': mit });
    const nested = folder('crates/ring/sub', {});
    const bare = folder('crates/bare', {});
    const store = new TextStore();
    const [serde, ring, bareEntry] = rustNotices(
      [
        crate('serde', dual, { license: 'MIT OR Apache-2.0', authors: ['Erick Tryzelaar <erick.tryzelaar@gmail.com>', 'David Tolnay'], repository: 'https://github.com/serde-rs/serde' }),
        crate('ring', nested, { license: null, license_file: '../../shared/LICENSE.txt', homepage: 'https://github.com/briansmith/ring' }),
        crate('bare', bare, { license: 'Zlib' }),
      ],
      store,
    );
    expect(serde).toMatchObject({ license: 'MIT OR Apache-2.0', authors: 'Erick Tryzelaar, David Tolnay', url: 'https://github.com/serde-rs/serde' });
    expect(serde.texts.map((i) => store.texts[i])).toEqual(['Apache License 2.0 …', mit]);
    // The same MIT text, stored once.
    expect(ring).toEqual({ name: 'ring', version: '1.0.0', url: 'https://github.com/briansmith/ring', texts: [serde.texts[1]] });
    expect(bareEntry).toEqual({ name: 'bare', version: '1.0.0', license: 'Zlib', texts: [] });
    expect(store.texts).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ Vite */

type Bundle = Record<string, { type: 'chunk'; moduleIds: string[] } | { type: 'asset'; names?: string[]; originalFileNames?: string[] }>;
interface Emitted {
  fileName: string;
  source: string;
}

/** Runs a plugin's generateBundle the way Vite does, with only the context the plugin uses. */
function generate(plugin: Plugin, bundle: Bundle): { emitted: Emitted[]; warnings: string[] } {
  const emitted: Emitted[] = [];
  const warnings: string[] = [];
  const context = {
    emitFile: (file: Emitted) => emitted.push(file),
    warn: (message: string) => warnings.push(message),
    error: (message: string) => {
      throw new Error(message);
    },
  };
  const hook = plugin.generateBundle;
  const run = (typeof hook === 'function' ? hook : hook?.handler) as unknown as (this: typeof context, options: object, bundle: Bundle, isWrite: boolean) => void;
  run.call(context, {}, bundle, true);
  return { emitted, warnings };
}

const workerBundle: Bundle = { 'decode.js': { type: 'chunk', moduleIds: [nm('mpg123-decoder/dist/mpg123-decoder.min.js')] } };
const mainBundle: Bundle = {
  'index.js': { type: 'chunk', moduleIds: ['\0vite/modulepreload-polyfill.js', join(root, 'src/main.tsx'), nm('preact/dist/preact.mjs'), nm('preact/hooks/dist/hooks.mjs')] },
  'index.css': { type: 'asset' },
};

function licenseFile(emitted: Emitted[]): LicenseFile {
  expect(emitted.map((f) => f.fileName)).toEqual([LICENSE_FILE_NAME]);
  const file: unknown = JSON.parse(emitted[0].source);
  expect(isLicenseFile(file)).toBe(true);
  return file as LicenseFile;
}

/** The plugins with a cargo that answers with the fixture, or fails. */
function plugins(env: Record<string, string>, cargo: 'answers' | 'fails') {
  const asked: [string, string | undefined][] = [];
  const made = licenseFilePlugins({
    fileName: LICENSE_FILE_NAME,
    cargoManifest: 'src-tauri/Cargo.toml',
    env,
    cargoMetadata: (manifest, target) => {
      asked.push([manifest, target]);
      if (cargo === 'fails') throw new Error('cargo not found');
      return metadata();
    },
  });
  return { ...made, asked };
}

describe('build plugin', () => {
  it('writes the packages of the app, of its workers and the crates of the desktop app into one file', () => {
    const p = plugins({}, 'answers');
    for (const worker of p.worker()) expect(generate(worker, workerBundle).emitted).toEqual([]);
    const { emitted, warnings } = generate(p.main, mainBundle);
    const file = licenseFile(emitted);
    expect(file.npm.map((e) => e.name)).toEqual(['mpg123-decoder', 'preact']);
    expect(file.rust.map((e) => e.name)).toEqual(['both', 'cc', 'libc', 'serde']);
    expect(warnings).toEqual([]);
    // Built without Tauri, for example by a script that builds the front end first: crates of every platform.
    expect(p.asked).toEqual([['src-tauri/Cargo.toml', undefined]]);
  });

  it('asks for the crates of the target Tauri builds for', () => {
    const p = plugins({ TAURI_ENV_PLATFORM: 'windows', TAURI_ENV_TARGET_TRIPLE: 'x86_64-pc-windows-msvc' }, 'answers');
    licenseFile(generate(p.main, mainBundle).emitted);
    expect(p.asked).toEqual([['src-tauri/Cargo.toml', 'x86_64-pc-windows-msvc']]);
  });

  it('stops the desktop build when the crates cannot be listed', () => {
    const p = plugins({ TAURI_ENV_PLATFORM: 'linux' }, 'fails');
    expect(() => generate(p.main, mainBundle)).toThrow(/Rust crates.*cargo not found/);
  });

  it('lists the fonts of src/assets/fonts that the bundle carries, with their licence text', () => {
    const made = licenseFilePlugins({ fileName: LICENSE_FILE_NAME, cargoManifest: 'src-tauri/Cargo.toml', env: {}, cargoMetadata: () => metadata(), fonts: FONT_NOTICES });
    const bundle: Bundle = {
      ...mainBundle,
      'assets/gochi-hand-latin-Ab12.woff2': { type: 'asset', names: ['gochi-hand-latin.woff2'], originalFileNames: ['src/assets/fonts/gochi-hand-latin.woff2'] },
      'assets/permanent-marker-latin-Cd34.woff2': { type: 'asset', originalFileNames: ['src/assets/fonts/permanent-marker-latin.woff2'] },
    };
    const file = licenseFile(generate(made.main, bundle).emitted);
    // No worker ran here, so only the main bundle's packages come before the fonts.
    expect(file.npm.map((e) => e.name)).toEqual(['preact', 'Permanent Marker', 'Gochi Hand']);
    const gochi = file.npm.find((e) => e.name === 'Gochi Hand')!;
    expect(gochi.license).toBe('OFL-1.1');
    expect(file.texts[gochi.texts[0]]).toMatch(/Juan Pablo del Peral[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/);
    const marker = file.npm.find((e) => e.name === 'Permanent Marker')!;
    expect(marker.license).toBe('Apache-2.0');
    // The licence text, then the NOTICE file with the copyright line the licence itself does not have.
    expect(file.texts[marker.texts[0]]).toMatch(/Apache License/);
    expect(file.texts[marker.texts[1]]).toMatch(/Font Diner/);
  });

  it('lets any other build go on without them, with a warning: it may be the web app', () => {
    const { emitted, warnings } = generate(plugins({}, 'fails').main, mainBundle);
    expect(licenseFile(emitted).rust).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cargo not found.*desktop app/);
  });
});
