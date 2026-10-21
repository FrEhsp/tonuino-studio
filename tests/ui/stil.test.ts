/** The look of the app: how it is put into effect, and the rules of its style sheets. */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

/** A localStorage in memory, holding the given settings. */
function storage(saved?: unknown) {
  const items = new Map<string, string>();
  if (saved !== undefined) items.set('tonuino-studio:settings', JSON.stringify(saved));
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
    items,
  };
}

/** Just enough of a document for the script in index.html. */
function fakeDocument() {
  const icon = { href: 'http://localhost/favicon.svg' };
  return {
    icon,
    documentElement: { dataset: {} as Record<string, string> },
    querySelector: (sel: string) => (sel === 'link[rel="icon"]' ? icon : null),
  };
}

/** The state module, loaded fresh with the given storage. */
async function loadState(saved?: unknown) {
  const store = storage(saved);
  vi.resetModules();
  vi.stubGlobal('localStorage', store);
  const state = await import('../../src/app/state');
  return { state, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the one look of the app', () => {
  it('drops a style saved by an earlier version, whatever its name', async () => {
    for (const style of ['lila', 'holz', 'schlicht', 'werkbank', 'bastelkeller', 'bastelstube', 'neon']) {
      const { state } = await loadState({ style, theme: 'dark', bitrateKbps: 160 });
      expect(state.settings.value, style).toMatchObject({ theme: 'dark', bitrateKbps: 160 });
      expect(state.settings.value, style).not.toHaveProperty('style');
    }
  });

  it('is set before the first paint by the script in index.html, whatever was saved', () => {
    const script = read('index.html').match(/<script>([\s\S]*?)<\/script>/)![1];
    const run = (saved?: unknown) => {
      const doc = fakeDocument();
      const matchMedia = () => ({ matches: false });
      new Function('document', 'localStorage', 'matchMedia', script)(doc, storage(saved), matchMedia);
      return doc;
    };
    expect(run().documentElement.dataset).toEqual({ stil: 'holz', theme: 'light' });
    expect(run({ theme: 'dark' }).documentElement.dataset).toEqual({ stil: 'holz', theme: 'dark' });
    for (const style of ['lila', 'schlicht', 'werkbank', 'bastelkeller', 'neon']) {
      const doc = run({ style });
      expect(doc.documentElement.dataset.stil, style).toBe('holz');
      expect(doc.icon.href, style).toBe('http://localhost/favicon.svg');
    }
    // Storage blocked: the look is still there.
    const blocked = fakeDocument();
    const broken = { getItem: () => { throw new Error('blocked'); } };
    new Function('document', 'localStorage', 'matchMedia', script)(blocked, broken, () => ({ matches: false }));
    expect(blocked.documentElement.dataset.stil).toBe('holz');
  });

  it('has no style choice in the settings any more', async () => {
    const { SETTINGS_SECTIONS, SETTING_TEXTS } = await import('../../src/features/settings/options');
    expect(SETTINGS_SECTIONS.flatMap((s) => s.keys as string[])).not.toContain('style');
    expect(Object.keys(SETTING_TEXTS)).not.toContain('style');
  });

  it('has its tab icon in public/ and no icons of the old styles', () => {
    const files = readdirSync(fileURLToPath(new URL('../../public', import.meta.url)));
    expect(files).toContain('favicon.svg');
    expect(files.filter((f) => f.startsWith('favicon'))).toEqual(['favicon.svg']);
    expect(read('index.html')).toContain('href="favicon.svg"');
  });
});

describe('the style sheets', () => {
  /** Selectors of a sheet outside @keyframes, comments removed. */
  function selectors(css: string): string[] {
    const plain = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    const out: string[] = [];
    const re = /([^{};]+)\{/g;
    for (let m = re.exec(plain); m; m = re.exec(plain)) {
      const head = m[1].trim();
      if (head.startsWith('@')) continue;
      // Split at top-level commas only: :where(...) and :is(...) contain commas of their own.
      let depth = 0;
      let start = 0;
      for (let i = 0; i < head.length; i++) {
        const c = head[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) {
          out.push(head.slice(start, i).trim());
          start = i + 1;
        }
      }
      out.push(head.slice(start).trim());
    }
    return out;
  }

  for (const name of ['holz']) {
    it(`stil-${name}.css only has rules for its own style`, () => {
      const css = read(`src/ui/styles/stil-${name}.css`);
      const list = selectors(css);
      expect(list.length).toBeGreaterThan(100);
      // Either the whole selector under :where(:root[data-stil=…]), or the style on the root element itself.
      const tag = `[data-stil='${name}']`;
      const own = (sel: string) => {
        if (sel.startsWith(`:where(:root${tag}) `)) return true;
        const root = sel.split(' ')[0];
        return /^(html)?:root/.test(root) && root.includes(`:where(${tag})`);
      };
      for (const sel of list) expect(own(sel), sel).toBe(true);
      for (const other of ['lila', 'schlicht']) expect(css).not.toContain(`data-stil='${other}'`);
    });
  }

  it('are loaded after the shared ones', () => {
    const main = read('src/main.tsx');
    const app = main.indexOf("from './app/App'");
    expect(app).toBeGreaterThan(-1);
    expect(main.indexOf("'./ui/styles/stil-holz.css'")).toBeGreaterThan(app);
    expect(main).not.toMatch(/stil-(lila|schlicht)\.css/);
  });

  it('give light and dark their own tokens, and nothing is left of the old styles', () => {
    const tokens = read('src/ui/styles/tokens.css');
    expect(tokens).toContain(":root:where([data-stil='holz']) {");
    expect(tokens).toContain(":root:where([data-stil='holz'])[data-theme='dark'] {");
    expect(tokens).not.toMatch(/data-stil='(lila|schlicht)'/);
    const sheets = readdirSync(fileURLToPath(new URL('../../src/ui/styles', import.meta.url)));
    expect(sheets.filter((f) => f.startsWith('stil-'))).toEqual(['stil-holz.css']);
  });
});
