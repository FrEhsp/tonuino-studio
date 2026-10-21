import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from '../../src/core/zip/crc32';
import { layoutZip, type ZipEntryInput, type ZipLayout } from '../../src/core/zip/zipwriter';

export const enc = new TextEncoder();

export interface TestFile {
  path: string;
  data?: Uint8Array;
}

export function file(path: string, text: string | Uint8Array): TestFile {
  return { path, data: typeof text === 'string' ? enc.encode(text) : text };
}

export function folder(path: string): TestFile {
  return { path };
}

/** A small card: system sounds, an advert, one album, an empty folder, another folder and the catalog. */
export const CARD: TestFile[] = [
  folder('mp3/'),
  file('mp3/0001.mp3', 'sound 1'),
  file('mp3/0002.mp3', 'sound 2'),
  folder('advert/'),
  file('advert/0001.mp3', 'advert 1'),
  folder('01/'),
  file('01/001.mp3', 'track 1'),
  file('01/002.mp3', 'track 2'),
  folder('02/'),
  folder('Andere Sachen/'),
  file('Andere Sachen/Grüße an Oma.txt', 'Hallo Ömchen'),
  file('tonuino-studio.json', '{"app":"tonuino-studio"}'),
];

export function inputs(files: TestFile[]): ZipEntryInput[] {
  return files.map((f) => (f.data ? { path: f.path, size: f.data.length, crc32: crc32(f.data) } : { path: f.path, size: 0, crc32: 0 }));
}

/** The archive's bytes: header parts as they are, entry parts from the files. */
export function assemble(layout: ZipLayout, files: TestFile[]): Uint8Array {
  const out = new Uint8Array(layout.size);
  let at = 0;
  for (const p of layout.parts) {
    const bytes = p instanceof Uint8Array ? p : files[p.entry].data!;
    out.set(bytes, at);
    at += bytes.length;
  }
  if (at !== layout.size) throw new Error(`size ${at} != ${layout.size}`);
  return out;
}

export function zipOf(files: TestFile[], opts: Parameters<typeof layoutZip>[1] = {}): { bytes: Uint8Array; layout: ZipLayout } {
  const layout = layoutZip(inputs(files), { now: new Date(2026, 9, 6, 14, 32, 10), ...opts });
  return { bytes: assemble(layout, files), layout };
}

/** A reader over bytes, as the browser gives it for a File. */
export function bytesReader(bytes: Uint8Array) {
  return async (start: number, length: number) => bytes.slice(start, start + length);
}

/**
 * A reader over a layout whose entries are only sizes (gigabytes that are
 * never written): header bytes are real, file data reads as zeros.
 */
export function layoutReader(layout: ZipLayout, sizes: number[]) {
  const spans: { start: number; end: number; bytes?: Uint8Array }[] = [];
  let at = 0;
  for (const p of layout.parts) {
    const len = p instanceof Uint8Array ? p.length : sizes[p.entry];
    spans.push({ start: at, end: at + len, bytes: p instanceof Uint8Array ? p : undefined });
    at += len;
  }
  return async (start: number, length: number) => {
    const out = new Uint8Array(Math.max(0, Math.min(length, at - start)));
    for (const s of spans) {
      if (s.end <= start || s.start >= start + out.length || !s.bytes) continue;
      const from = Math.max(start, s.start);
      const to = Math.min(start + out.length, s.end);
      out.set(s.bytes.subarray(from - s.start, to - s.start), from - start);
    }
    return out;
  };
}

/** Runs a program on the archive when it is installed; null when it is not. */
export function withTool<T>(bytes: Uint8Array, run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'tonuino-zip-'));
  try {
    const path = join(dir, 'test.zip');
    writeFileSync(path, bytes);
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function hasTool(name: string): boolean {
  const r = spawnSync(name, ['-h'], { encoding: 'utf8' });
  return !r.error;
}

export function tool(cmd: string, args: string[]) {
  return spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, maxBuffer: 64 * 1024 * 1024 });
}
