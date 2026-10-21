/**
 * A style sheet repeats some rules of the shared sheets, marked "As in
 * layout.css, repeated so it still comes after this style's own rules", so
 * they win over the style's own, more general rules. Such a copy must stay
 * what the shared sheet says: whoever changes the shared rule is told here
 * to change the copies too, instead of seeing no effect in the app.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface Rule {
  /** The @media/@container conditions around it, joined. */
  at: string;
  selector: string;
  declarations: string[];
  /** The comment right before the rule, if any. */
  comment: string;
}

/** A small parser for the app's own style sheets: rules, their conditions and the comment above each. */
function parse(css: string): Rule[] {
  const out: Rule[] = [];
  const at: string[] = [];
  let comment = '';
  let i = 0;
  const scan = (from: number, stop: (c: string, depth: number) => boolean) => {
    let j = from;
    let depth = 0;
    let quote: string | null = null;
    for (; j < css.length; j++) {
      const c = css[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (css.startsWith('/*', j)) {
        // A comment in a rule: its words ("the drop zone's top") are no quotes.
        j = css.indexOf('*/', j + 2) + 1 || css.length;
      } else if (c === '"' || c === "'") quote = c;
      else if (stop(c, depth)) break;
      else if (c === '(' || c === '{') depth++;
      else if (c === ')' || c === '}') depth--;
    }
    return j;
  };
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i) + 2;
      comment = css.slice(i, end);
      i = end;
      continue;
    }
    if (css[i] === '}') {
      at.pop();
      comment = '';
      i++;
      continue;
    }
    const open = scan(i, (c, depth) => depth === 0 && (c === '{' || c === ';'));
    const prelude = css.slice(i, open).trim().replace(/\s+/g, ' ');
    if (css[open] === ';') {
      i = open + 1;
      continue;
    }
    if (/^@(media|container|supports)/.test(prelude)) {
      at.push(prelude);
      comment = '';
      i = open + 1;
      continue;
    }
    const close = scan(open + 1, (c, depth) => depth === 0 && c === '}');
    const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
    if (!prelude.startsWith('@')) {
      const declarations = body
        .split(';')
        .map((d) => d.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
      out.push({ at: at.join(' | '), selector: prelude, declarations, comment });
    }
    comment = '';
    i = close + 1;
  }
  return out;
}

function findSheet(name: string): string | undefined {
  const stack = [join(ROOT, 'src')];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) stack.push(path);
      else if (e.name === name) return path;
    }
  }
  return undefined;
}

const sameSelector = (a: string, b: string) => a.split(',').map((s) => s.trim()).join(', ') === b.split(',').map((s) => s.trim()).join(', ');

describe('rules a style repeats from a shared sheet', () => {
  for (const name of ['holz']) {
    it(`in stil-${name}.css still say what the shared sheet says`, () => {
      const css = readFileSync(join(ROOT, `src/ui/styles/stil-${name}.css`), 'utf8');
      const prefix = new RegExp(`:where\\(:root\\[data-stil='${name}'\\]\\) `, 'g');
      const copies = parse(css).filter((r) => /As in [\w-]+\.css, repeated/.test(r.comment));
      expect(copies.length).toBeGreaterThan(20);
      const shared = new Map<string, Rule[]>();
      for (const copy of copies) {
        const file = /As in ([\w-]+\.css)/.exec(copy.comment)![1];
        if (!shared.has(file)) {
          const path = findSheet(file);
          expect(path, `${file} named in stil-${name}.css`).toBeTruthy();
          shared.set(file, parse(readFileSync(path!, 'utf8')));
        }
        const selector = copy.selector.replace(prefix, '');
        const originals = shared.get(file)!.filter((r) => r.at === copy.at && sameSelector(r.selector, selector));
        const where = `stil-${name}.css repeats "${selector}"${copy.at ? ` (${copy.at})` : ''} from ${file}`;
        expect(originals.length, `${where}, but ${file} has no such rule any more`).toBeGreaterThan(0);
        const matches = originals.some((o) => copy.declarations.every((d) => o.declarations.includes(d)));
        expect(matches, `${where}, but ${file} says something else now: change the copy too`).toBe(true);
      }
    });
  }
});
