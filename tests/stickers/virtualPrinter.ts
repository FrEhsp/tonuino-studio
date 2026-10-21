/**
 * A virtual printer for the print tests (TODO #85): what a PDF that went to
 * the printer looks like on paper. pdfinfo reads the page sizes, pdftoppm
 * draws every page (poppler-utils), and the ink of each page is measured in
 * millimetres. Without poppler-utils the checks that need it are skipped.
 *
 * The rule from 0.5: pages = sheets, no empty first page, paper exactly as
 * large as the sheet, the picture where it belongs (± 0.5 mm).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BoxMm {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PrintedPage {
  widthMm: number;
  heightMm: number;
  /** Everything not white on the page; null: an empty page. */
  ink: BoxMm | null;
}

function has(program: string): boolean {
  try {
    execFileSync(program, ['-v'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    // pdfinfo -v exits with 0 or 99 depending on the version; only a missing program throws ENOENT.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export const canLookAtPaper = has('pdfinfo') && has('pdftoppm');

/** Bounding box of the pixels darker than `white` in a binary PGM (P5, 8 bit). */
export function inkOfPgm(pgm: Uint8Array, dpi: number, white = 245): { widthMm: number; heightMm: number; ink: BoxMm | null } {
  const head = new TextDecoder('latin1').decode(pgm.subarray(0, 64));
  const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(head);
  if (!m) throw new Error('not a PGM');
  const [w, h] = [Number(m[1]), Number(m[2])];
  const data = pgm.subarray(m[0].length);
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x] < white) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const mm = (px: number) => (px * 25.4) / dpi;
  return { widthMm: mm(w), heightMm: mm(h), ink: x1 < 0 ? null : { left: mm(x0), top: mm(y0), right: mm(x1 + 1), bottom: mm(y1 + 1) } };
}

/** Prints the PDF on the virtual printer: every page with its paper size and its ink. */
export function printOnPaper(pdf: Uint8Array, dpi = 100): PrintedPage[] {
  const dir = mkdtempSync(join(tmpdir(), 'tonuino-virtual-printer-'));
  try {
    const file = join(dir, 'job.pdf');
    writeFileSync(file, pdf);
    const info = execFileSync('pdfinfo', ['-f', '1', '-l', '9999', file], { encoding: 'utf8' });
    const sizes = [...info.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((m) => ({ widthMm: (Number(m[1]) * 25.4) / 72, heightMm: (Number(m[2]) * 25.4) / 72 }));
    execFileSync('pdftoppm', ['-r', String(dpi), '-gray', file, join(dir, 'p')]);
    const pages = readdirSync(dir)
      .filter((f) => f.startsWith('p-'))
      .sort();
    return pages.map((f, i) => ({ ...sizes[i], ink: inkOfPgm(readFileSync(join(dir, f)), dpi).ink }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What is wrong with a print: wrong number of pages, an empty page, other
 * paper, ink away from where it belongs by more than `toleranceMm`.
 */
export function printProblems(printed: PrintedPage[], expected: { page: { widthMm: number; heightMm: number }; ink: (BoxMm | null)[] }, toleranceMm = 0.5): string[] {
  const out: string[] = [];
  if (printed.length !== expected.ink.length) out.push(`${printed.length} Seiten statt ${expected.ink.length}`);
  printed.forEach((p, i) => {
    const n = i + 1;
    if (Math.abs(p.widthMm - expected.page.widthMm) > 0.1 || Math.abs(p.heightMm - expected.page.heightMm) > 0.1) {
      out.push(`Seite ${n}: Papier ${p.widthMm.toFixed(1)} × ${p.heightMm.toFixed(1)} mm statt ${expected.page.widthMm} × ${expected.page.heightMm}`);
    }
    const want = expected.ink[i];
    if (want === undefined) return;
    if (!p.ink) {
      if (want) out.push(`Seite ${n} ist leer`);
      return;
    }
    if (!want) {
      out.push(`Seite ${n} sollte leer sein`);
      return;
    }
    for (const k of ['left', 'top', 'right', 'bottom'] as const) {
      const off = p.ink[k] - want[k];
      if (Math.abs(off) > toleranceMm) out.push(`Seite ${n}: ${k} ${off > 0 ? '+' : ''}${off.toFixed(2)} mm`);
    }
  });
  return out;
}
