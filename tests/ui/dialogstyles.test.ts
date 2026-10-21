import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../../src/ui/styles/', import.meta.url));
const sheets = readdirSync(dir)
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ file: f, css: readFileSync(dir + f, 'utf8') }));

/** Every rule as its selectors and declarations; for a media query, the rules inside it. */
function allRules(css: string): { selectors: string[]; body: string }[] {
  const out: { selectors: string[]; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let m = re.exec(plain); m; m = re.exec(plain)) {
    out.push({ selectors: m[1].split(',').map((x) => x.trim()), body: m[2] });
  }
  return out;
}

/** The declarations of every rule for exactly `selector`. */
function rules(css: string, selector: string): string[] {
  return allRules(css)
    .filter((r) => r.selectors.includes(selector))
    .map((r) => r.body);
}

describe('dialog buttons', () => {
  it('move to a new row in every dialog instead of being cut off', () => {
    const base = sheets.find((s) => s.file === 'components.css')!;
    expect(rules(base.css, '.dialog-foot').join()).toMatch(/flex-wrap:\s*wrap/);
    // No page needs its own fix any more.
    for (const { file, css } of sheets) {
      // The scope of a style (stil-*.css) is no page of its own.
      const unscoped = (x: string) => x.replace(/^:where\(:root\[data-stil='[a-z]+'\]\)\s+/, '');
      const special = allRules(css).flatMap((r) => r.selectors.map(unscoped).filter((x) => /\S\s+\.dialog-foot\b/.test(x)));
      expect(special, file).toEqual([]);
    }
  });

  it('share the rows on a phone and may break a long label', () => {
    const base = sheets.find((s) => s.file === 'components.css')!.css;
    const phone = base.slice(base.indexOf('@media (max-width: 560px)', base.indexOf('.dialog-foot {')));
    expect(rules(phone, '.dialog-foot > *').join()).toMatch(/flex:\s*1 1 auto/);
    expect(rules(phone, '.dialog-foot > .btn').join()).toMatch(/white-space:\s*normal/);
  });
});

describe('the announcements dialog', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/features/box/SoundsDialog.tsx', import.meta.url)), 'utf8');
  const footer = src.slice(src.indexOf('footer={'), src.indexOf('<div class="stack">'));
  const body = src.slice(src.indexOf('<div class="stack">'));

  it('ends with two buttons, so the main one stays on the row at desktop width', () => {
    // "Abbrechen", then the main button: the ZIP file for 2.1, the download for TNG.
    expect(footer.match(/<Button\b/g)).toHaveLength(3);
    expect(footer).toMatch(/\{classic \? \(\s*<Button [^\n]*variant="primary"[^\n]*\n\s*ZIP-Datei auswählen …\s*<\/Button>\s*\) : \(\s*<Button variant="primary"[\s\S]*Herunterladen und installieren/);
  });

  it('offers own announcements next to the sentence about them', () => {
    expect(body).toMatch(/Du hast eigene Ansagen[^<]*<\/p>\s*<Button size="sm" icon=\{FileArchive\} onClick=\{\(\) => run\(true\)\}>\s*ZIP-Datei auswählen …/);
  });

  it('does not promise the TNG download to a box with 2.1', () => {
    expect(body).toMatch(/\{classic \? null : [`'] Ich lade die aktuellen Ansagen von TonUINO-TNG herunter/);
  });
});
