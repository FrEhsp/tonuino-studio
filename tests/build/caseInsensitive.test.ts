/**
 * macOS and Windows ignore the case of file names. An import of
 * "./LoetplanSchema" there found "loetplanSchema.ts" before
 * "LoetplanSchema.tsx", and the Mac build stopped (Linux kept them apart).
 * No two modules in one folder may differ only in case.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const MODULE = /\.(ts|tsx|js|mjs|json|css)$/;

/** Folders below `dir` whose module names collide when case is ignored. */
function collisions(dir: string, out: string[] = []): string[] {
  const seen = new Map<string, string>();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && !e.name.startsWith('.')) collisions(join(dir, e.name), out);
      continue;
    }
    if (!MODULE.test(e.name)) continue;
    const stem = e.name.replace(MODULE, '');
    const key = stem.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other !== stem) out.push(`${join(dir, e.name)} ~ ${other}`);
    seen.set(key, stem);
  }
  return out;
}

describe('file names on case-insensitive systems', () => {
  it('no two modules in a folder differ only in case', () => {
    expect([...collisions(join(root, 'src')), ...collisions(join(root, 'tests')), ...collisions(join(root, 'scripts'))]).toEqual([]);
  });
});
