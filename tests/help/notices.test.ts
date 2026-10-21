import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../src/app/version';
import { SETTINGS_KEY } from '../../src/app/state';
import {
  BUNDLED_DEPENDENCY_LICENSES,
  CRATE_NOTICES,
  FONT_NOTICES,
  LICENSES,
  PACKAGE_NOTICES,
  licenseIds,
  licenseInfo,
  licenseLabel,
  licenseUrl,
  licenseWords,
} from '../../src/features/help/notices';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readText = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');
const readJson = <T>(...parts: string[]) => JSON.parse(readText(...parts)) as T;

interface PackageJson {
  name: string;
  version: string;
  license?: string;
  author?: string | { name: string };
  dependencies?: Record<string, string>;
}

const app = readJson<PackageJson>('package.json');
const runtimeDeps = Object.keys(app.dependencies ?? {});

/** Text of every licence file a package ships, with spaces and line breaks evened out. */
function licenceText(dir: string): string {
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f));
  return files
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
    .replace(/^﻿/, '')
    .replace(/\s+/g, ' ');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css|html)$/.test(name) ? [path] : [];
  });
}

/**
 * npm packages the app imports, from import statements, dynamic imports and
 * CSS @import in src/ and index.html. Names in plain strings (like the list
 * in notices.ts) do not count.
 */
function importedPackages(): Set<string> {
  const out = new Set<string>();
  const files = [...sourceFiles(join(root, 'src')), join(root, 'index.html')];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|@import\s+)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      const parts = spec.split('/');
      out.add(spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
    }
  }
  return out;
}

/** Is an SPDX expression like "(MIT AND Zlib)" or "MPL-2.0 OR Apache-2.0" fulfilled with these licences? */
function satisfiable(expression: string, allowed: readonly string[]): boolean {
  const e = expression.replace(/[()]/g, '').trim();
  if (/\s+OR\s+/.test(e)) return e.split(/\s+OR\s+/).some((alt) => satisfiable(alt, allowed));
  return e.split(/\s+AND\s+/).every((id) => allowed.includes(id.trim()));
}

describe('third-party notices: npm packages', () => {
  it('lists every runtime dependency of package.json exactly once', () => {
    expect(PACKAGE_NOTICES.map((p) => p.name).sort()).toEqual([...runtimeDeps].sort());
  });

  it('versions and licences are those of the installed packages', () => {
    for (const notice of PACKAGE_NOTICES) {
      const pkg = readJson<PackageJson>('node_modules', notice.name, 'package.json');
      expect(notice.version, notice.name).toBe(pkg.version);
      expect(notice.license, notice.name).toBe(pkg.license);
    }
  });

  it('every named rights holder stands in the licence file or as author of the package', () => {
    for (const notice of PACKAGE_NOTICES) {
      const dir = join(root, 'node_modules', notice.name);
      const pkg = readJson<PackageJson>('node_modules', notice.name, 'package.json');
      const author = typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? '');
      const known = `${licenceText(dir)} ${author}`;
      expect(notice.holders.length, notice.name).toBeGreaterThan(0);
      for (const holder of notice.holders) {
        expect(notice.copyright, notice.name).toContain(holder);
        // Font packages carry the font's holders in LICENSE_FONT, read with the other licence files.
        expect(known, `${notice.name}: ${holder}`).toContain(holder);
      }
      // A copyright quoted in the note (the Feather icons in lucide) is copied from the licence file too.
      const quoted = notice.note?.match(/Copyright \(c\) [^.,;]+/)?.[0];
      if (quoted) expect(known, notice.name).toContain(quoted);
    }
  });

  it('packages marked as not included are really not imported anywhere in the app, all others are', () => {
    const imported = importedPackages();
    for (const notice of PACKAGE_NOTICES) expect(imported.has(notice.name), notice.name).toBe(!notice.unused);
  });

  it('the packages they bring along only use the licences the help page names', () => {
    const lock = readJson<{ packages: Record<string, { version: string; license?: string; dev?: boolean }> }>('package-lock.json');
    const direct = new Set(runtimeDeps);
    const used = new Set<string>();
    let count = 0;
    for (const [path, p] of Object.entries(lock.packages)) {
      if (!path || p.dev) continue;
      const name = path.replace(/^.*node_modules\//, '');
      if (direct.has(name)) continue;
      count++;
      // "MIT OR SEE LICENSE IN FEEL-FREE.md" (rgbcolor) offers MIT.
      const expression = (p.license ?? '').replace(/\s+OR\s+SEE LICENSE IN \S+/, '');
      expect(satisfiable(expression, BUNDLED_DEPENDENCY_LICENSES), `${name}: ${p.license}`).toBe(true);
      for (const id of licenseIds(expression)) used.add(id);
    }
    expect(count).toBeGreaterThan(10);
    // No licence on the list that no package uses.
    for (const id of BUNDLED_DEPENDENCY_LICENSES) expect(used, id).toContain(id);
  });
});

describe('third-party notices: fonts', () => {
  const fontImports = [...importedPackages()].filter((name) => /^@(expo-google-fonts|fontsource|fontsource-variable)\//.test(name));

  it('finds the fonts the app bundles', () => {
    expect(new Set(fontImports)).toEqual(new Set(['@expo-google-fonts/fredoka', '@expo-google-fonts/figtree', '@expo-google-fonts/bitter', '@expo-google-fonts/patrick-hand', '@expo-google-fonts/nunito']));
  });

  it('every bundled font package is covered by a font notice', () => {
    for (const name of new Set(fontImports)) {
      expect(FONT_NOTICES.some((f) => f.packages.includes(name)), name).toBe(true);
      expect(PACKAGE_NOTICES.find((p) => p.name === name)?.kind, name).toBe('font');
    }
    // "Patrick Hand" comes from @expo-google-fonts/patrick-hand.
    for (const font of FONT_NOTICES) {
      for (const name of font.packages) expect(name, font.family).toMatch(new RegExp(`/${font.family.toLowerCase().replace(/ /g, '-')}$`));
    }
  });

  it('fonts that ship as files in src/assets/fonts bring their licence text, and every such file is listed', () => {
    const dir = join(root, 'src', 'assets', 'fonts');
    const css = readText('src', 'ui', 'styles', 'tokens.css');
    const listed = FONT_NOTICES.flatMap((f) => f.bundled?.files ?? []);
    expect(readdirSync(dir).filter((f) => f.endsWith('.woff2')).sort()).toEqual([...listed].sort());
    for (const font of FONT_NOTICES) {
      if (!font.bundled) continue;
      expect(font.packages, font.family).toEqual([]);
      // Declared in the styles under the same name, from the same files.
      expect(css, font.family).toContain(`font-family: '${font.family}'`);
      for (const file of font.bundled.files) expect(css, file).toContain(`assets/fonts/${file}`);
      const text = readFileSync(join(dir, font.bundled.licenseFile), 'utf8').replace(/\s+/g, ' ');
      // Where the licence has no copyright line (Apache), a NOTICE file next to it names it.
      const notice = font.bundled.noticeFile ? readFileSync(join(dir, font.bundled.noticeFile), 'utf8').replace(/\s+/g, ' ') : '';
      expect(`${text} ${notice}`, font.family).toContain(font.copyright.replace(/\s+/g, ' '));
      expect(text, font.family).toMatch(font.license === 'OFL-1.1' ? /SIL OPEN FONT LICENSE Version 1\.1/i : /Apache License\s+Version 2\.0/);
    }
  });

  it('every licence and notice file in src/assets/fonts belongs to a font notice', () => {
    const dir = join(root, 'src', 'assets', 'fonts');
    const named = FONT_NOTICES.flatMap((f) => (f.bundled ? [f.bundled.licenseFile, ...(f.bundled.noticeFile ? [f.bundled.noticeFile] : [])] : []));
    expect(readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()).toEqual([...new Set(named)].sort());
  });

  it('the app loads no font from the internet', () => {
    for (const file of sourceFiles(join(root, 'src'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });

  it('copyright lines are copied from the fonts’ own licence files', () => {
    for (const font of FONT_NOTICES) {
      for (const name of font.packages) {
        const dir = join(root, 'node_modules', name);
        const file = existsSync(join(dir, 'LICENSE_FONT')) ? 'LICENSE_FONT' : 'LICENSE';
        const text = readFileSync(join(dir, file), 'utf8').replace(/^﻿/, '').replace(/\s+/g, ' ');
        expect(text, `${font.family} in ${name}`).toContain(font.copyright);
        expect(text, `${font.family} in ${name}`).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
      }
    }
  });
});

describe('third-party notices: desktop app', () => {
  const cargo = readText('src-tauri', 'Cargo.toml');
  const lock = readText('src-tauri', 'Cargo.lock');
  const lockVersions = (name: string) => [...lock.matchAll(new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`, 'g'))].map((m) => m[1]);

  /** Dependencies of the program itself, not of its build script. */
  function directCrates(): { name: string; requirement: string }[] {
    const out: { name: string; requirement: string }[] = [];
    let inDeps = false;
    for (const line of cargo.split('\n')) {
      const header = line.match(/^\[(.+)\]\s*$/);
      if (header) {
        inDeps = header[1] === 'dependencies' || /^target\..+\.dependencies$/.test(header[1]);
        continue;
      }
      const dep = inDeps ? line.match(/^([a-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{.*version\s*=\s*"([^"]+)")/) : null;
      if (dep) out.push({ name: dep[1], requirement: dep[2] ?? dep[3] });
    }
    return out;
  }

  it('lists every crate of Cargo.toml with the version Cargo.lock uses', () => {
    const crates = directCrates();
    expect(crates.map((c) => c.name).sort()).toEqual(CRATE_NOTICES.map((c) => c.name).sort());
    for (const c of crates) {
      const notice = CRATE_NOTICES.find((n) => n.name === c.name)!;
      expect(lockVersions(c.name), c.name).toContain(notice.version);
      // "2" allows 2.x.y, "0.37" allows 0.37.z.
      expect(notice.version.startsWith(`${c.requirement}.`) || notice.version === c.requirement, c.name).toBe(true);
    }
  });
});

describe('licences', () => {
  it('every licence named in the notices has a link to its text', () => {
    const expressions = [...PACKAGE_NOTICES.map((p) => p.license), ...FONT_NOTICES.map((f) => f.license), ...CRATE_NOTICES.map((c) => c.license), ...BUNDLED_DEPENDENCY_LICENSES, app.license ?? ''];
    for (const e of expressions) for (const id of licenseIds(e)) expect(licenseInfo(id), id).toBeDefined();
    for (const l of LICENSES) expect(l.url).toMatch(/^https:\/\//);
  });

  it('reads SPDX expressions', () => {
    expect(licenseIds('(MIT OR GPL-3.0-or-later)')).toEqual(['MIT', 'GPL-3.0-or-later']);
    expect(licenseIds('MIT AND OFL-1.1')).toEqual(['MIT', 'OFL-1.1']);
    expect(licenseLabel('Apache-2.0 OR MIT')).toBe('Apache-2.0 oder MIT');
    expect(licenseLabel('(MIT AND Zlib)')).toBe('MIT und Zlib');
  });

  it('reads the expressions of the full licence list, old Cargo ones included', () => {
    expect(licenseLabel('MIT/Apache-2.0')).toBe('MIT oder Apache-2.0');
    expect(licenseLabel('Apache-2.0 / MIT')).toBe('Apache-2.0 oder MIT');
    expect(licenseLabel('(MIT OR Apache-2.0) AND Unicode-3.0')).toBe('(MIT oder Apache-2.0) und Unicode-3.0');
    expect(licenseLabel('Apache-2.0 WITH LLVM-exception OR MIT')).toBe('Apache-2.0 mit LLVM-exception oder MIT');
    expect(licenseLabel('SEE LICENSE IN LICENSE.md')).toBe('SEE LICENSE IN LICENSE.md');
    expect(licenseWords('(Zlib OR MIT)')).toEqual([
      { text: 'Zlib', licence: true },
      { text: ' oder ', licence: false },
      { text: 'MIT', licence: true },
    ]);
  });

  it('links each licence to its text, or to nothing when it is no licence id', () => {
    expect(licenseUrl('MIT')).toBe(licenseInfo('MIT')?.url);
    expect(licenseUrl('Unicode-3.0')).toBe('https://spdx.org/licenses/Unicode-3.0.html');
    expect(licenseUrl('GPL-2.0+')).toBe('https://spdx.org/licenses/GPL-2.0.html');
    for (const none of ['SEE LICENSE IN LICENSE.md', 'UNLICENSED', 'LicenseRef-Proprietary', '', '(']) expect(licenseUrl(none), none).toBeUndefined();
  });
});

describe('version', () => {
  it('the web app and the desktop app show the same version', () => {
    const tauri = readJson<{ version: string }>('src-tauri', 'tauri.conf.json');
    expect(APP_VERSION).toBe(app.version);
    // Tauri takes a version number, or the path of a package.json to read it from.
    const desktop = tauri.version.endsWith('package.json') ? readJson<{ version: string }>('src-tauri', tauri.version).version : tauri.version;
    expect(desktop).toBe(APP_VERSION);
  });

  it('index.html reads the theme from the key the app saves settings under', () => {
    expect(readText('index.html')).toContain(`'${SETTINGS_KEY}'`);
  });
});
