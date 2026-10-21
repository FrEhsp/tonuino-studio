/**
 * Paper for the printer area of the test bench (TODO #69, #85): a PDF drawn
 * by more than one PDF engine (poppler's pdftoppm, MuPDF's mutool,
 * Ghostscript), and what is on each page measured in millimetres. Engines
 * that disagree about the number of pages or where the ink is point to a
 * PDF that only looks right in one program.
 *
 * Also here: the arguments of `lp` read out of src-tauri/src/print.rs, so the
 * bench prints exactly as the desktop app does, and plain sheet pictures
 * (grey PNG) for the browser's way of printing.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { slotRects } from '../../../src/core/stickers/slots';
import type { LabelTemplate } from '../../../src/core/stickers/templates';
import type { BoxMm, PrintedPage } from '../../stickers/virtualPrinter';
import { has } from '../labor';

export type { BoxMm, PrintedPage };

export type Engine = 'poppler' | 'mupdf' | 'ghostscript';

const ENGINE_TOOLS: Record<Engine, { program: string; probe: string[]; install: string }> = {
  poppler: { program: 'pdftoppm', probe: ['-v'], install: 'poppler-utils' },
  mupdf: { program: 'mutool', probe: ['-v'], install: 'mupdf-tools' },
  ghostscript: { program: 'gs', probe: ['--version'], install: 'ghostscript' },
};

export const ENGINE_NAMES: Record<Engine, string> = { poppler: 'Poppler (pdftoppm)', mupdf: 'MuPDF (mutool)', ghostscript: 'Ghostscript' };

/** The engines on this computer, and a note for each one missing. */
export function engines(): { here: Engine[]; missing: string[] } {
  const here: Engine[] = [];
  const missing: string[] = [];
  for (const e of Object.keys(ENGINE_TOOLS) as Engine[]) {
    const t = ENGINE_TOOLS[e];
    if (has(t.program, t.probe)) here.push(e);
    else missing.push(`${ENGINE_NAMES[e]} fehlt (apt-get install ${t.install})`);
  }
  if (here.includes('poppler') && !has('pdfinfo', ['-v'])) return { here: here.filter((e) => e !== 'poppler'), missing: [...missing, 'pdfinfo fehlt'] };
  return { here, missing };
}

/** A binary or ASCII-free PGM (P5, 8 bit), comments allowed in the header (Ghostscript writes one). */
export function readPgm(pgm: Uint8Array): { w: number; h: number; data: Uint8Array } {
  let at = 0;
  const fields: string[] = [];
  const text = (i: number) => String.fromCharCode(pgm[i]);
  while (fields.length < 4) {
    while (/\s/.test(text(at))) at++;
    if (text(at) === '#') {
      while (text(at) !== '\n') at++;
      continue;
    }
    let f = '';
    while (!/\s/.test(text(at))) f += text(at++);
    fields.push(f);
  }
  at++; // the one whitespace after maxval
  if (fields[0] !== 'P5' || fields[3] !== '255') throw new Error(`kein 8-Bit-PGM: ${fields.join(' ')}`);
  const [w, h] = [Number(fields[1]), Number(fields[2])];
  return { w, h, data: pgm.subarray(at, at + w * h) };
}

/** Paper and ink of one drawn page; ink is everything darker than `white`. */
export function measurePgm(pgm: Uint8Array, dpi: number, white = 245): PrintedPage {
  const { w, h, data } = readPgm(pgm);
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

/** The exact paper of every page, from the PDF itself (pdfinfo). */
export function paperOf(pdf: Uint8Array): { widthMm: number; heightMm: number }[] {
  const dir = mkdtempSync(join(workDir(), 'paper-'));
  try {
    const file = join(dir, 'p.pdf');
    writeFileSync(file, pdf);
    const info = execFileSync('pdfinfo', ['-f', '1', '-l', '9999', file], { encoding: 'utf8' });
    return [...info.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((m) => ({ widthMm: (Number(m[1]) * 25.4) / 72, heightMm: (Number(m[2]) * 25.4) / 72 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function workDir(): string {
  return process.env.LABOR_TMP ?? process.env.TMPDIR ?? '/tmp';
}

/**
 * Draws every page of the PDF with one engine (grey, `dpi`) and measures it.
 * Paper sizes come from the pixel size (± one pixel); with poppler they are
 * taken from pdfinfo, exactly.
 */
export function render(engine: Engine, pdf: Uint8Array, dpi = 150): PrintedPage[] {
  const dir = mkdtempSync(join(workDir(), `render-${engine}-`));
  try {
    const file = join(dir, 'in.pdf');
    writeFileSync(file, pdf);
    const out = join(dir, 'p');
    const opts = { stdio: ['ignore', 'ignore', 'pipe'] as ('ignore' | 'pipe')[], timeout: 120_000 };
    if (engine === 'poppler') execFileSync('pdftoppm', ['-r', String(dpi), '-gray', file, out], opts);
    else if (engine === 'mupdf') execFileSync('mutool', ['draw', '-q', '-r', String(dpi), '-c', 'gray', '-o', `${out}-%04d.pgm`, file], opts);
    else execFileSync('gs', ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pgmraw', `-r${dpi}`, `-sOutputFile=${out}-%04d.pgm`, file], opts);
    const pages = readdirSync(dir)
      .filter((f) => f.startsWith('p-') && f.endsWith('.pgm'))
      .sort((a, b) => Number(/(\d+)\.pgm$/.exec(a)![1]) - Number(/(\d+)\.pgm$/.exec(b)![1]));
    const drawn = pages.map((f) => measurePgm(readFileSync(join(dir, f)), dpi));
    if (engine !== 'poppler') return drawn;
    const paper = paperOf(pdf);
    return drawn.map((p, i) => ({ ...p, ...paper[i] }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where two drawings of the same PDF differ: pages, paper (± `paperMm`), ink (± `inkMm`). */
export function differences(a: PrintedPage[], b: PrintedPage[], inkMm = 0.5, paperMm = 0.5): string[] {
  const out: string[] = [];
  if (a.length !== b.length) return [`${b.length} Seiten statt ${a.length}`];
  a.forEach((p, i) => {
    const q = b[i];
    const n = i + 1;
    if (Math.abs(p.widthMm - q.widthMm) > paperMm || Math.abs(p.heightMm - q.heightMm) > paperMm) out.push(`Seite ${n}: Papier ${q.widthMm.toFixed(1)} × ${q.heightMm.toFixed(1)} statt ${p.widthMm.toFixed(1)} × ${p.heightMm.toFixed(1)} mm`);
    if (!p.ink !== !q.ink) out.push(`Seite ${n}: ${q.ink ? 'Farbe auf leerer Seite' : 'leer'}`);
    if (!p.ink || !q.ink) return;
    for (const k of ['left', 'top', 'right', 'bottom'] as const) {
      const off = q.ink[k] - p.ink[k];
      if (Math.abs(off) > inkMm) out.push(`Seite ${n}: ${k} ${off > 0 ? '+' : ''}${off.toFixed(2)} mm`);
    }
  });
  return out;
}

/** The scale of the ink between two pages (1 = same size), from the ink's width and height. */
export function inkScale(original: BoxMm, printed: BoxMm): number {
  const w = (printed.right - printed.left) / (original.right - original.left);
  const h = (printed.bottom - printed.top) / (original.bottom - original.top);
  return (w + h) / 2;
}

/** The same page turned by a quarter, either way: CUPS turns a landscape page onto portrait paper. */
export function turned(p: PrintedPage, clockwise: boolean): PrintedPage {
  const { widthMm: W, heightMm: H, ink } = p;
  if (!ink) return { widthMm: H, heightMm: W, ink };
  return clockwise
    ? { widthMm: H, heightMm: W, ink: { left: H - ink.bottom, top: ink.left, right: H - ink.top, bottom: ink.right } }
    : { widthMm: H, heightMm: W, ink: { left: ink.top, top: W - ink.right, right: ink.bottom, bottom: W - ink.left } };
}

/** Like `differences`, but a page that came out turned is compared turned back (the better way of the two). */
export function differencesTurned(want: PrintedPage[], got: PrintedPage[], inkMm = 0.5, paperMm = 0.5): string[] {
  if (want.length !== got.length) return differences(want, got, inkMm, paperMm);
  return want.flatMap((p, i) => {
    const q = got[i];
    const upright = (p.widthMm > p.heightMm) === (q.widthMm > q.heightMm);
    if (upright) return differences([p], [q], inkMm, paperMm).map((s) => s.replace('Seite 1', `Seite ${i + 1}`));
    const ways = [true, false].map((cw) => differences([turned(p, cw)], [q], inkMm, paperMm));
    const best = ways[0].length <= ways[1].length ? ways[0] : ways[1];
    return best.map((s) => s.replace('Seite 1', `Seite ${i + 1}`));
  });
}

/* --------------------------------------------------- lp as print.rs calls it */

export interface LpJob {
  title: string;
  printer: string | null;
  widthMm: number;
  heightMm: number;
  twoSided: boolean;
}

/**
 * The arguments of `lp` for a job, built from what src-tauri/src/print.rs
 * says (lp_args, media_for): the options and the paper names are read from
 * the Rust source, so a change there reaches the bench without a Rust build.
 */
export function lpArgsOfApp(job: LpJob, file: string, source = readFileSync(fileURLToPath(new URL('../../../src-tauri/src/print.rs', import.meta.url)), 'utf8')): string[] {
  const body = (name: string) => {
    const at = source.indexOf(`pub fn ${name}(`);
    if (at < 0) throw new Error(`print.rs: fn ${name} nicht gefunden – Testlabor anpassen`);
    return source.slice(at, source.indexOf('\n}\n', at));
  };
  const lp = body('lp_args');
  const media = body('media_for');
  const fixed = [...lp.matchAll(/"([a-z-]+=[a-z-]+)"\.to_string\(\)/g)].map((m) => m[1]);
  const sides = /if job\.two_sided \{ "([^"]+)" \} else \{ "([^"]+)" \}/.exec(lp);
  const named = [...media.matchAll(/\(([\d.]+), ([\d.]+), "(\w+)"\)/g)].map((m) => ({ w: Number(m[1]), h: Number(m[2]), name: m[3] }));
  const tolerance = /fn near\(a: f64, b: f64\) -> bool \{\s*\(a - b\)\.abs\(\) < ([\d.]+)/.exec(source);
  if (!fixed.length || !sides || !named.length || !tolerance || !/"-n", "1"/.test(lp) || !/format!\("media=\{\}"/.test(lp)) {
    throw new Error('print.rs: lp_args sieht anders aus als erwartet – Testlabor (tests/labor/druck/papier.ts) anpassen');
  }
  const near = (a: number, b: number) => Math.abs(a - b) < Number(tolerance[1]);
  const [a, b] = job.widthMm <= job.heightMm ? [job.widthMm, job.heightMm] : [job.heightMm, job.widthMm];
  const mm = (v: number) => String(Math.round(v * 10) / 10);
  const paper = named.find((n) => near(a, n.w) && near(b, n.h))?.name ?? `Custom.${mm(a)}x${mm(b)}mm`;
  const title = [...job.title].filter((c) => c >= ' ' && c !== '\x7f').slice(0, 120).join('');
  return [
    ...(job.printer ? ['-d', job.printer] : []),
    '-t',
    title.trim() ? title : 'TonUINO Studio',
    '-n',
    '1',
    ...[`media=${paper}`, ...fixed, `sides=${job.twoSided ? sides[1] : sides[2]}`].flatMap((o) => ['-o', o]),
    file,
  ];
}

/* ------------------------------------------------------- pictures of sheets */

/** A grey PNG (8 bit, no alpha) of `w` × `h` pixels. */
export function greyPng(w: number, h: number, px: Uint8Array): Uint8Array {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    raw.set(px.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grey
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', new Uint8Array())]));
}

/** A white page of `page` mm at `dpi` with grey boxes at `boxes` (mm), as a PNG. */
export function boxesPicture(page: { widthMm: number; heightMm: number }, boxes: BoxMm[], dpi = 300): Uint8Array {
  const k = dpi / 25.4;
  const [w, h] = [Math.round(page.widthMm * k), Math.round(page.heightMm * k)];
  const px = new Uint8Array(w * h).fill(255);
  for (const b of boxes) {
    const [x0, y0, x1, y1] = [Math.round(b.left * k), Math.round(b.top * k), Math.round(b.right * k), Math.round(b.bottom * k)];
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) px.fill(90, y * w + Math.max(0, x0), y * w + Math.min(w, x1));
  }
  return greyPng(w, h, px);
}

/** The labels of a sheet as boxes. */
export function labelBoxes(t: LabelTemplate, filled: number): BoxMm[] {
  return slotRects(t)
    .slice(0, filled)
    .map((r) => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height }));
}

/** The box around boxes; null for none. */
export function around(boxes: BoxMm[]): BoxMm | null {
  if (!boxes.length) return null;
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}
