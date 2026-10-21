/**
 * The pages that come as their own files (TODO #70, src/app/App.tsx): their
 * style sheets still belong to the app's one style sheet, in front of the
 * style of main.tsx, and index.html shows paper and the logo until the app
 * draws its first page.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Static imports of a source file, resolved to files (no `import type`, no `import()`). */
function staticImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:([^'";]*?)\s+from\s+)?['"](\.[^'"]+)['"]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[1] || (m[2] && /^\{\s*(type\s+[\w$]+(\s+as\s+[\w$]+)?\s*,?\s*)+\}$/.test(m[2].trim()))) continue;
    const base = join(dirname(file), m[3].replace(/\?.*$/, ''));
    const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((e) => base + e).find((p) => existsSync(p) && statSync(p).isFile());
    if (hit) out.push(hit);
  }
  return out;
}

/** Style sheets in the order the start reaches them (first time seen, depth first, as the build orders them). */
function startStyleSheets(): string[] {
  const seen = new Set<string>();
  const css: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.endsWith('.css')) css.push(relative(ROOT, file));
    else if (/\.tsx?$/.test(file)) staticImports(file).forEach(visit);
  };
  visit(join(ROOT, 'src/main.tsx'));
  return css;
}

/** Every style sheet some source file imports. */
function allStyleSheets(): string[] {
  const seen = new Set<string>();
  const css = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.endsWith('.css')) css.add(relative(ROOT, file));
    else if (/\.tsx?$/.test(file)) {
      staticImports(file).forEach(visit);
      // The pages that come later.
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/import\(['"](\.[^'"]+)['"]\)/g)) {
        const base = join(dirname(file), m[1]);
        const hit = ['.ts', '.tsx', ''].map((e) => base + e).find((p) => existsSync(p) && statSync(p).isFile());
        if (hit) visit(hit);
      }
    }
  };
  visit(join(ROOT, 'src/main.tsx'));
  return [...css];
}

describe('pages that come as their own files', () => {
  it('leave their style sheets in the one the app starts with, in front of the style of main.tsx', () => {
    const start = startStyleSheets();
    const missing = allStyleSheets().filter((f) => !start.includes(f));
    // A new style sheet of a page that comes later: import it in src/app/App.tsx too, next to the others.
    expect(missing).toEqual([]);
    const style = start.indexOf('src/ui/styles/stil-holz.css');
    expect(style).toBeGreaterThan(0);
    for (const f of ['src/ui/styles/stickers.css', 'src/ui/styles/workshop.css', 'src/ui/styles/settings.css', 'src/ui/styles/help.css', 'src/features/sources/sources.css']) {
      expect(start.indexOf(f), f).toBeGreaterThan(-1);
      expect(start.indexOf(f), f).toBeLessThan(style);
    }
  });

  it('are not part of the start, "Meine Box" is', () => {
    const app = read('src/app/App.tsx');
    expect(app).toMatch(/import \{ BoxPage, useAutoRefresh \} from '\.\.\/features\/box\/BoxPage'/);
    for (const page of ['FolderPage', 'AddPage', 'SourcesPage', 'StickerPage', 'CardsPage', 'RecordPage', 'WorkshopPage', 'HelpPage', 'SettingsPage']) {
      expect(app).not.toMatch(new RegExp(`import \\{[^}]*\\b${page}\\b[^}]*\\} from`));
      expect(app).toContain(`.then((m) => m.${page})`);
    }
  });
});

describe('big libraries', () => {
  // Only some tasks need them: with import() each comes as its own file, and the start does not wait for it.
  const LATER = ['jszip', 'qrcode', 'music-metadata', '@breezystack/lamejs'];

  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

  it('are loaded with import() where they are used, never imported at the top (import type is fine)', () => {
    const found: string[] = [];
    for (const file of sources(join(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8');
      const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        if (!LATER.includes(m[3])) continue;
        if (m[1] || (m[2] && /^\{\s*(type\s+[\w$]+(\s+as\s+[\w$]+)?\s*,?\s*)+\}$/.test(m[2].trim()))) continue;
        found.push(`${relative(ROOT, file)}: ${m[3]}`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe('index.html until the app draws', () => {
  const html = read('index.html');

  it('shows paper in the colours of the app, light and dark', () => {
    const tokens = read('src/ui/styles/tokens.css');
    const [light, dark] = [...tokens.matchAll(/\n\s*--bg:\s*(#[0-9a-f]{6});/gi)].map((m) => m[1].toLowerCase());
    expect(light).toBeTruthy();
    expect(dark).toBeTruthy();
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    expect(style).toMatch(new RegExp(`body \\{[^}]*background: ${light};`));
    expect(style).toMatch(new RegExp(`:where\\(html\\[data-theme='dark'\\]\\) body \\{[^}]*background: ${dark};`));
    // The desktop window shows the same paper before the page is there.
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { app: { windows: { backgroundColor?: string }[] } };
    expect(conf.app.windows[0].backgroundColor?.toLowerCase()).toBe(light);
  });

  it('shows the logo, which the app takes away with its first frame', () => {
    expect(html).toMatch(/<div id="boot" aria-hidden="true">\s*<svg /);
    expect(read('src/main.tsx')).toContain("document.getElementById('boot')?.remove();");
  });
});

describe('lazyPage', () => {
  it('says when its code is there, so the page before can stay until then (no empty page in between)', async () => {
    const { lazyPage } = await import('../../src/app/lazyPage');
    const Page = () => null;
    const page = lazyPage(async () => Page);
    expect(page.ready()).toBe(false);
    await page.preload();
    expect(page.ready()).toBe(true);
  });

  it('stays not ready after a failed load, and preload does not throw (the page then shows its message)', async () => {
    const { lazyPage } = await import('../../src/app/lazyPage');
    const page = lazyPage(() => Promise.reject(new Error('weg')));
    await expect(page.preload()).resolves.toBeUndefined();
    expect(page.ready()).toBe(false);
  });
});
