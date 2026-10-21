/**
 * The test bench before every release (TODO #69, docs/TESTLABOR.md): what
 * all areas share. The tests under tests/labor run only through
 * `npm run test:labor` (scripts/labor/run.mjs sets LABOR=1); a plain
 * `npm test` skips them, like tests/boxsim without the simulator.
 *
 * A part of an area whose tool is missing is skipped with a note: the
 * runner prints the notes under its table, so a skipped part is never
 * mistaken for a passed one.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const laborOn = process.env.LABOR === '1';

/** Whether `program` is on the PATH (any exit code counts: only a missing program throws ENOENT). */
export function has(program: string, args: string[] = ['--version']): boolean {
  try {
    execFileSync(program, args, { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Notes a skipped part for the runner's summary (and on stderr when run by hand). */
export function skipNote(area: string, text: string): void {
  const file = process.env.LABOR_NOTES;
  if (file) appendFileSync(file, JSON.stringify({ area, text }) + '\n');
  else console.warn(`[labor ${area}] übersprungen: ${text}`);
}

/** A notes line for a finding that is no failure (a known limit, a measured value). */
export function infoNote(area: string, text: string): void {
  const file = process.env.LABOR_NOTES;
  if (file) appendFileSync(file, JSON.stringify({ area, text, info: true }) + '\n');
}

/** A fresh folder under the system's temp folder, removed by `drop`. */
export function scratch(prefix: string): { dir: string; drop: () => void } {
  const dir = mkdtempSync(join(process.env.LABOR_TMP ?? tmpdir(), `labor-${prefix}-`));
  return { dir, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
