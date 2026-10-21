/// <reference types="node" />
/**
 * Small file helpers for the source scripts: JSON files, the request cache
 * (.sources-cache/bodies) and command line flags.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withEditorial } from '../../src/core/sources/editorial';
import type { CachedAnswer, NetCache } from '../../src/core/sources/net';

export const ROOT = process.cwd();
export const CACHE_DIR = resolve(ROOT, '.sources-cache');

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as T;
}

export function readJsonIfExists<T>(path: string): T | undefined {
  const p = resolve(ROOT, path);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Where the editors' notes are (src/core/sources/editorial.ts): SOURCES_EDITORIAL, else sources/redaktion.json (git-ignored). */
export function editorialPath(): string {
  return process.env.SOURCES_EDITORIAL?.trim() || 'sources/redaktion.json';
}

/**
 * sources/catalog.json with the editors' notes mixed in when they are there.
 * Without them (a public checkout, CI) the catalogue is used as it is.
 */
export function readCatalog(): unknown {
  const raw = readJson<unknown>('sources/catalog.json');
  const path = editorialPath();
  const notes = readJsonIfExists<unknown>(path);
  if (notes === undefined) {
    console.log(`Hinweis: keine Notizen der Redaktion (${path}); der Katalog gilt ohne sie.`);
    return raw;
  }
  const errors: string[] = [];
  const merged = withEditorial(raw, notes, errors);
  for (const e of errors) console.warn(`Warnung: ${e}`);
  return merged;
}

export function writeText(path: string, text: string): void {
  const p = resolve(ROOT, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

export function writeJson(path: string, value: unknown, pretty = true): void {
  writeText(path, (pretty ? JSON.stringify(value, null, 1) : JSON.stringify(value)) + '\n');
}

/** Answers with ETag or Last-Modified, one file per URL. */
export function fileCache(dir = join(CACHE_DIR, 'bodies')): NetCache {
  const file = (url: string) => join(dir, createHash('sha256').update(url).digest('hex') + '.json');
  return {
    get(url) {
      const p = file(url);
      if (!existsSync(p)) return undefined;
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as CachedAnswer;
      } catch {
        return undefined;
      }
    },
    set(url, answer) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file(url), JSON.stringify(answer));
    },
  };
}

/** "--out x --include a,b --flag" -> { out: 'x', include: 'a,b', flag: true } */
export function parseArgs(argv: readonly string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
