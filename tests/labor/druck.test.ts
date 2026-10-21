/**
 * Testlabor, Drucker (TODO #69, PRINT RULE of #85): every way the app
 * prints, against virtual printers, and every PDF it makes through more than
 * one PDF engine. On paper it checks: pages = sheets, no empty first page,
 * the paper of the sheet, the labels where the template puts them in their
 * real size (± 0,5 mm).
 *
 * - Desktop app: the PDF through TauriPrinter and `lp` with the arguments of
 *   print.rs into a CUPS of its own with inkjets (3 mm margins, 12 mm at the
 *   bottom), a borderless one, Letter, and CUPS-PDF. Controls: "An Seite
 *   anpassen" and lp without options must be caught.
 * - Browser: the print area of printSheets with printCss, printed by
 *   Chromium (100 % and "An Seite anpassen" 97 %), and by WebKitGTK through
 *   GTK's "In Datei drucken" (GNOME Web, Safari's engine, the Linux app's
 *   WebView) with and without printer margins.
 * - The PDFs (sheets, test page, content list, QR sheet, Bedienkarte) drawn
 *   by Poppler, MuPDF and Ghostscript: the same pages, the same ink.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mirrorTemplate } from '../../src/core/stickers/backside';
import { buildTestPagePdf } from '../../src/core/stickers/calibration';
import { buildSheetPdf, type StickerBitmap } from '../../src/core/stickers/pdf';
import { getTemplate, type LabelTemplate } from '../../src/core/stickers/templates';
import { manualSections } from '../../src/core/tonuino/manual';
import { sheetPdf, type ContentSheet } from '../../src/features/box/contentListPage';
import { qrSheetPdf, type QrCard } from '../../src/features/cards/qrsheet';
import { manualPdf } from '../../src/features/manual/manualpdf';
import { TauriPrinter } from '../../src/platform/tauri/printer';
import { fakeBridge } from '../platform-tauri/fake-ipc';
import { tinyJpeg } from '../stickers/fixtures';
import { has, infoNote, laborOn, scratch, skipNote } from './labor';
import { Chromium, findChromium, printPage } from './druck/browser';
import { cupsMissing, cupsPdfMissing, PrivateCups, type Margins, type VirtualPrinter } from './druck/cups';
import {
  around,
  boxesPicture,
  differences,
  differencesTurned,
  ENGINE_NAMES,
  engines,
  inkScale,
  labelBoxes,
  lpArgsOfApp,
  paperOf,
  render,
  type BoxMm,
  type PrintedPage,
} from './druck/papier';

const AREA = 'Drucker';
const herma = getTemplate('herma-5028') as LabelTemplate;
const letter: LabelTemplate = { ...herma, id: 'herma-letter', page: { widthMm: 215.9, heightMm: 279.4 } };

/* -------------------------------------------------------------- what is here */

const { here: engineList, missing: engineMissing } = laborOn ? engines() : { here: [], missing: [] };
const poppler = engineList.includes('poppler');
const noCups = laborOn ? cupsMissing() : 'aus';
const noCupsPdf = laborOn && !noCups ? cupsPdfMissing() : 'aus';
const chromium = laborOn ? findChromium() : null;

function webkitPython(): string | null {
  if (!has('xvfb-run', ['--help']) && !process.env.DISPLAY) return null;
  for (const py of ['python3', 'python3.12', 'python3.13', 'python3.11']) {
    try {
      execFileSync(py, ['-I', '-c', "import gi; gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1'); from gi.repository import WebKit2"], { stdio: 'ignore', timeout: 30_000 });
      return py;
    } catch {
      // next
    }
  }
  return null;
}
const python = laborOn && poppler ? webkitPython() : null;

if (laborOn) {
  for (const m of engineMissing) skipNote(AREA, m);
  skipNote(AREA, 'pdf.js (Firefox) nicht im Labor (keine neue npm-Abhängigkeit); Poppler, MuPDF und Ghostscript zeichnen statt seiner');
  if (!poppler) skipNote(AREA, 'ohne pdftoppm/pdfinfo (poppler-utils) misst das Labor kein Papier: Druckwege übersprungen');
  if (poppler && noCups) skipNote(AREA, `Desktop-Druck über CUPS: ${noCups}`);
  if (poppler && !noCups && noCupsPdf) skipNote(AREA, noCupsPdf);
  if (poppler && !chromium) skipNote(AREA, 'Browser-Druck in Chromium: kein Chromium gefunden (npx playwright install chromium oder apt-get install chromium)');
  if (poppler && !python) skipNote(AREA, 'WebKitGTK „In Datei drucken“: python3-gi mit WebKit2 4.1 (gir1.2-webkit2-4.1) oder xvfb fehlt');
}

/* ------------------------------------------------------------------- helpers */

const sticker: StickerBitmap = { image: tinyJpeg(), widthPx: 8, heightPx: 5, bleedMm: 0 };

function sheets(count: number): (StickerBitmap | null)[][] {
  const pages: (StickerBitmap | null)[][] = [];
  for (let i = 0; i < count; i += 10) pages.push(Array.from({ length: Math.min(10, count - i) }, () => sticker));
  return pages;
}

/** Where the ink of a sheet with `filled` labels belongs. */
const inkOf = (t: LabelTemplate, filled: number) => around(labelBoxes(t, filled));

async function bytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

/**
 * What is wrong on paper: pages, an empty page, the paper (± `paperMm`;
 * Chromium writes A4 as 595 pt), the ink away from where it belongs.
 */
function problems(printed: PrintedPage[], want: { page: { widthMm: number; heightMm: number }; ink: (BoxMm | null)[] }, inkMm = 0.5, paperMm = 0.3): string[] {
  const out: string[] = [];
  if (printed.length !== want.ink.length) out.push(`${printed.length} Seiten statt ${want.ink.length}`);
  if (printed[0] && !printed[0].ink) out.push('die erste Seite ist leer');
  printed.forEach((p, i) => {
    const n = i + 1;
    if (Math.abs(p.widthMm - want.page.widthMm) > paperMm || Math.abs(p.heightMm - want.page.heightMm) > paperMm) {
      out.push(`Seite ${n}: Papier ${p.widthMm.toFixed(1)} × ${p.heightMm.toFixed(1)} mm statt ${want.page.widthMm} × ${want.page.heightMm}`);
    }
    const w = want.ink[i];
    if (w === undefined) return;
    if (!p.ink || !w) {
      if (!p.ink !== !w) out.push(`Seite ${n} ${p.ink ? 'sollte leer sein' : 'ist leer'}`);
      return;
    }
    for (const k of ['left', 'top', 'right', 'bottom'] as const) {
      const off = p.ink[k] - w[k];
      if (Math.abs(off) > inkMm) out.push(`Seite ${n}: ${k} ${off > 0 ? '+' : ''}${off.toFixed(2)} mm`);
    }
  });
  return out;
}

/** A share as German percent, "95,0". */
const pct = (v: number) => (v * 100).toFixed(1).replace('.', ',');

/** The PDF's pages drawn by poppler, with the paper exact from pdfinfo. */
const look = (pdf: Uint8Array) => render('poppler', pdf);

/** A content list sheet as sheetPdf gets it, with a picture of known ink instead of the drawn list. */
function contentSheet(kind: 'a4' | 'a5x2'): { sheet: ContentSheet; ink: BoxMm } {
  const page = kind === 'a5x2' ? { widthMm: 297, heightMm: 210 } : { widthMm: 210, heightMm: 297 };
  // Not symmetric, so a page turned the wrong way shows.
  const ink = kind === 'a5x2' ? { left: 8, top: 8, right: 289, bottom: 150 } : { left: 8, top: 8, right: 150, bottom: 289 };
  const png = boxesPicture(page, [ink], 254);
  const canvas = { nodeType: 1, nodeName: 'CANVAS', width: page.widthMm * 10, height: page.heightMm * 10, toDataURL: () => `data:image/png;base64,${Buffer.from(png).toString('base64')}` };
  return { sheet: { canvas, layout: { sheet: kind, columns: 1, pt: 11 }, widthMm: page.widthMm, heightMm: page.heightMm } as unknown as ContentSheet, ink };
}

const qrCard = (title: string, folder: number): QrCard => ({ title, data: { folder, mode: 2, special: 0, special2: 0 } });

/** Every PDF the app makes, by name: the bytes and how many pages it must have. */
async function appPdfs(): Promise<{ name: string; pdf: Uint8Array; pages: number; page: { widthMm: number; heightMm: number } }[]> {
  const twelve = sheets(12);
  const a4 = { widthMm: 210, heightMm: 297 };
  return [
    { name: 'Stickerbögen A4 mit Rückseiten', pdf: await bytes(await buildSheetPdf({ template: herma, pages: twelve, backs: twelve, bleedMm: 1.5, cutMarks: true, title: 'Sticker' })), pages: 4, page: a4 },
    { name: 'Stickerbögen Letter', pdf: await bytes(await buildSheetPdf({ template: letter, pages: sheets(10), bleedMm: 0, cutMarks: false, title: 'Sticker' })), pages: 1, page: letter.page },
    { name: 'Testseite (Kalibrierung)', pdf: await bytes(await buildTestPagePdf(herma)), pages: 1, page: a4 },
    { name: 'Inhaltsliste A4', pdf: await bytes(await sheetPdf(contentSheet('a4').sheet)), pages: 1, page: a4 },
    { name: 'Inhaltsliste 2 × A5', pdf: await bytes(await sheetPdf(contentSheet('a5x2').sheet)), pages: 1, page: { widthMm: 297, heightMm: 210 } },
    {
      name: 'QR-Bogen',
      pdf: await bytes(await qrSheetPdf([Array.from({ length: 8 }, (_, i) => qrCard(`Hörspiel ${i + 1}`, i + 1)), [qrCard('Lieder', 9)]], { boxName: 'Labor', date: new Date(2026, 9, 20) })),
      pages: 1,
      page: a4,
    },
    {
      name: 'Bedienkarte',
      pdf: await bytes(await manualPdf(manualSections({ profile: 'tng', buttons: 3, shortPressVolume: true }), { title: 'So geht die Box', about: 'TonUINO TNG · 3 Tasten', contact: 'Labor' })),
      pages: 1,
      page: { widthMm: 297, heightMm: 210 },
    },
  ];
}

/* ===================================================================== tests */

describe.skipIf(!laborOn || !poppler)('Testlabor: jedes PDF der App in mehreren PDF-Engines', () => {
  it('hat die richtigen Seiten und dasselbe Bild in Poppler, MuPDF und Ghostscript', async () => {
    const report: string[] = [];
    for (const doc of await appPdfs()) {
      const paper = paperOf(doc.pdf);
      expect(paper, doc.name).toHaveLength(doc.pages);
      for (const p of paper) {
        expect(Math.abs(p.widthMm - doc.page.widthMm), `${doc.name}: Papierbreite`).toBeLessThan(0.3);
        expect(Math.abs(p.heightMm - doc.page.heightMm), `${doc.name}: Papierhöhe`).toBeLessThan(0.3);
      }
      const base = render('poppler', doc.pdf);
      expect(base.map((p) => !!p.ink), `${doc.name}: keine leere Seite`).toEqual(base.map(() => true));
      for (const e of engineList.filter((x) => x !== 'poppler')) {
        expect(differences(base, render(e, doc.pdf)), `${doc.name} in ${ENGINE_NAMES[e]}`).toEqual([]);
      }
      report.push(`${doc.name} ${doc.pages} S.`);
    }
    infoNote(AREA, `PDF-Engines ${engineList.map((e) => ENGINE_NAMES[e]).join(', ')} einig über: ${report.join(', ')}`);
  });
});

/* ------------------------------------------------------- desktop app: CUPS */

const INKJET: Margins = { top: 3, bottom: 12, left: 3, right: 3 };
const PRINTERS: VirtualPrinter[] = [
  { name: 'Tinte_A4', kind: 'file', paper: 'A4', margins: INKJET },
  { name: 'Tinte_Letter', kind: 'file', paper: 'Letter', margins: INKJET },
  { name: 'Randlos_A4', kind: 'file', paper: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 } },
];

describe.skipIf(!laborOn || !poppler || !!noCups)('Testlabor: Desktop-App druckt über CUPS (print.rs)', () => {
  let cups: PrivateCups;
  const a4Printers = ['Tinte_A4', 'Randlos_A4'];

  /** The desktop app's printer (TauriPrinter) with print_pdf doing what print.rs does: lp into the virtual CUPS. */
  function desktopPrinter() {
    const { ipc, bridge } = fakeBridge();
    const files = new Map<string, Uint8Array>();
    const got: { printer: string; args: string[]; paper: Uint8Array }[] = [];
    let n = 0;
    ipc.on('fs_temp_file', () => `/tmp/tonuino-studio-labor/tmp-${++n}.pdf`);
    ipc.on('fs_write', (args, headers) => {
      files.set(decodeURIComponent(headers['x-path']), (args as Uint8Array).slice());
      return null;
    });
    ipc.on('fs_temp_remove', () => null);
    ipc.on('print_printers', () => ({ way: 'system', printers: [...PRINTERS.map((p) => p.name), ...(noCupsPdf ? [] : ['CUPS_PDF'])], default: 'Tinte_A4' }));
    ipc.on('print_pdf', async (raw) => {
      const a = raw as { path: string; name: string; printer: string | null; widthMm: number; heightMm: number; twoSided: boolean; open: boolean };
      const pdf = files.get(a.path);
      if (!pdf) throw { code: 'not-allowed', detail: 'no such temp file' };
      const printer = a.printer ?? 'Tinte_A4';
      let args: string[] = [];
      const paper = await cups.print(printer, pdf, (file) => (args = lpArgsOfApp({ title: a.name, printer: a.printer, widthMm: a.widthMm, heightMm: a.heightMm, twoSided: a.twoSided }, file)));
      got.push({ printer, args, paper });
      return { way: 'sent', job: `${printer}-${got.length}` };
    });
    return { printer: new TauriPrinter(bridge), got };
  }

  beforeAll(async () => {
    cups = await PrivateCups.start();
    for (const p of PRINTERS) await cups.add(p);
    if (!noCupsPdf) await cups.add({ name: 'CUPS_PDF', kind: 'cups-pdf', paper: 'A4', margins: INKJET });
  }, 60_000);
  afterAll(async () => {
    await cups?.stop();
  });

  it('reads the options of lp from print.rs', () => {
    const args = lpArgsOfApp({ title: 'Sticker Meine Box.pdf', printer: 'Tinte_A4', widthMm: 210, heightMm: 297, twoSided: true }, '/tmp/x.pdf');
    expect(args).toEqual(['-d', 'Tinte_A4', '-t', 'Sticker Meine Box.pdf', '-n', '1', '-o', 'media=A4', '-o', 'print-scaling=none', '-o', 'fit-to-page=false', '-o', 'fitplot=false', '-o', 'sides=two-sided-long-edge', '/tmp/x.pdf']);
    expect(lpArgsOfApp({ title: '', printer: null, widthMm: 215.9, heightMm: 279.4, twoSided: false }, 'f')).toContain('media=Letter');
    expect(lpArgsOfApp({ title: 'x', printer: null, widthMm: 180, heightMm: 130, twoSided: false }, 'f')).toContain('media=Custom.130x180mm');
  });

  for (const name of [...a4Printers, 'CUPS_PDF']) {
    it(`prints sticker sheets in real size on ${name}: pages = sheets, no empty first page, every label in place`, async (ctx) => {
      if (name === 'CUPS_PDF' && noCupsPdf) return ctx.skip();
      const d = desktopPrinter();
      const pdf = await buildSheetPdf({ template: herma, pages: sheets(12), bleedMm: 0, cutMarks: false, footer: false, title: 'Sticker' });
      expect(await d.printer.print({ name: 'Sticker Labor.pdf', pdf, page: herma.page, printer: name })).toBe('sent');
      expect(d.got[0].args).toContain('print-scaling=none');
      expect(problems(look(d.got[0].paper), { page: herma.page, ink: [inkOf(herma, 10), inkOf(herma, 2)] })).toEqual([]);
    });
  }

  it('prints fronts and backs for both sides, the backs mirrored on every other page', async () => {
    const d = desktopPrinter();
    const pages = sheets(3);
    const pdf = await buildSheetPdf({ template: herma, pages, backs: pages, bleedMm: 0, cutMarks: false, footer: false, title: 'Sticker' });
    await d.printer.print({ name: 'Sticker beidseitig.pdf', pdf, page: herma.page, twoSided: true, printer: 'Tinte_A4' });
    expect(d.got[0].args).toContain('sides=two-sided-long-edge');
    expect(problems(look(d.got[0].paper), { page: herma.page, ink: [inkOf(herma, 3), inkOf(mirrorTemplate(herma), 3)] })).toEqual([]);
  });

  it('keeps the size on Letter paper', async () => {
    const d = desktopPrinter();
    const pdf = await buildSheetPdf({ template: letter, pages: sheets(10), bleedMm: 0, cutMarks: false, footer: false, title: 'Sticker' });
    await d.printer.print({ name: 'Sticker Letter.pdf', pdf, page: letter.page, printer: 'Tinte_Letter' });
    expect(d.got[0].args).toContain('media=Letter');
    expect(problems(look(d.got[0].paper), { page: letter.page, ink: [inkOf(letter, 10)] })).toEqual([]);
  });

  it('asks a Letter printer for A4 when the sheets are A4, instead of shrinking them onto Letter', async () => {
    const d = desktopPrinter();
    const pdf = await buildSheetPdf({ template: herma, pages: sheets(10), bleedMm: 0, cutMarks: false, footer: false, title: 'Sticker' });
    await d.printer.print({ name: 'Sticker.pdf', pdf, page: herma.page, printer: 'Tinte_Letter' });
    expect(problems(look(d.got[0].paper), { page: herma.page, ink: [inkOf(herma, 10)] })).toEqual([]);
  });

  it('prints the test page, the content list (A4 and 2 × A5 across) and sheets with cut marks exactly as the PDF is', async () => {
    const d = desktopPrinter();
    const twelve = sheets(12);
    const docs = [
      { name: 'Testseite.pdf', pdf: await buildTestPagePdf(herma), page: herma.page, twoSided: false },
      { name: 'Inhaltsliste A4.pdf', pdf: await sheetPdf(contentSheet('a4').sheet), page: { widthMm: 210, heightMm: 297 }, twoSided: false },
      { name: 'Inhaltsliste A5.pdf', pdf: await sheetPdf(contentSheet('a5x2').sheet), page: { widthMm: 297, heightMm: 210 }, twoSided: false },
      { name: 'Sticker.pdf', pdf: await buildSheetPdf({ template: herma, pages: twelve, backs: twelve, bleedMm: 1.5, cutMarks: true, title: 'Sticker' }), page: herma.page, twoSided: true },
    ];
    for (const doc of docs) {
      await d.printer.print({ ...doc, printer: 'Tinte_A4' });
      const want = look(await bytes(doc.pdf));
      const got = look(d.got[d.got.length - 1].paper);
      expect(differencesTurned(want, got), doc.name).toEqual([]);
    }
  });

  it('catches a print with "An Seite anpassen" (fit-to-page) and one without the app\'s options', async () => {
    const pdf = await bytes(await buildSheetPdf({ template: herma, pages: sheets(10), bleedMm: 0, cutMarks: false, footer: false, title: 'Sticker' }));
    const want = { page: herma.page, ink: [inkOf(herma, 10)] };
    const fitted = look(await cups.print('Tinte_A4', pdf, (f) => ['-d', 'Tinte_A4', '-o', 'media=A4', '-o', 'fit-to-page=true', f]));
    expect(problems(fitted, want).length).toBeGreaterThan(0);
    const scale = inkScale(inkOf(herma, 10)!, fitted[0].ink!);
    expect(scale).toBeLessThan(0.99);
    // lp without options on a Letter printer: Letter paper, not the sheet's A4.
    const plain = look(await cups.print('Tinte_Letter', pdf, (f) => ['-d', 'Tinte_Letter', f]));
    expect(problems(plain, want).some((p) => p.includes('Papier'))).toBe(true);
    // CUPS's own default ("auto") on the A4 inkjet: noted, not judged (the app always sends its options).
    const auto = look(await cups.print('Tinte_A4', pdf, (f) => ['-d', 'Tinte_A4', f]));
    const autoScale = auto[0].ink ? inkScale(inkOf(herma, 10)!, auto[0].ink) : 0;
    infoNote(AREA, `Kontrolle: „An Seite anpassen“ druckt die Bögen auf ${pct(scale)} % (erkannt); lp ohne Optionen auf dem A4-Tintenstrahler: ${pct(autoScale)} %`);
  });
});

/* -------------------------------------------------- browser: print dialog */

describe.skipIf(!laborOn || !poppler || !chromium)('Testlabor: Browser druckt mit dem Druckdialog (Chromium)', () => {
  let browser: Chromium;
  let tmp: { dir: string; drop: () => void };
  beforeAll(async () => {
    tmp = scratch('chromium');
    browser = await Chromium.start(chromium!, tmp.dir);
  }, 60_000);
  afterAll(async () => {
    await browser?.stop();
    tmp?.drop();
  });

  const pictures = (t: LabelTemplate, counts: number[]) => counts.map((n) => boxesPicture(t.page, labelBoxes(t, n)));

  it('prints one page per sheet at 100 %, the first one not empty, every label in place, nothing of the app', async () => {
    const pdf = await browser.printToPdf(printPage(pictures(herma, [10, 10, 3]), herma.page));
    const printed = look(pdf);
    expect(problems(printed, { page: herma.page, ink: [inkOf(herma, 10), inkOf(herma, 10), inkOf(herma, 3)] })).toEqual([]);
    for (const e of engineList.filter((x) => x !== 'poppler')) expect(differences(printed, render(e, pdf)), ENGINE_NAMES[e]).toEqual([]);
  });

  it('keeps Letter sheets on Letter paper', async () => {
    const printed = look(await browser.printToPdf(printPage(pictures(letter, [10]), letter.page)));
    expect(problems(printed, { page: letter.page, ink: [inkOf(letter, 10)] })).toEqual([]);
  });

  it('catches "An Seite anpassen" in the dialog (97 %)', async () => {
    const printed = look(await browser.printToPdf(printPage(pictures(herma, [10]), herma.page), 0.97));
    expect(problems(printed, { page: herma.page, ink: [inkOf(herma, 10)] }).length).toBeGreaterThan(0);
    expect(inkScale(inkOf(herma, 10)!, printed[0].ink!)).toBeLessThan(0.99);
  });
});

/* ---------------------------------------------- WebKitGTK: GTK print to file */

describe.skipIf(!laborOn || !poppler || !python)('Testlabor: WebKitGTK druckt in eine Datei (GTK „In Datei drucken“)', () => {
  let tmp: { dir: string; drop: () => void };
  beforeAll(() => {
    tmp = scratch('webkit');
  });
  afterAll(() => tmp?.drop());

  const script = fileURLToPath(new URL('./druck/webkit-druck.py', import.meta.url));
  function printWebKit(html: string, name: string, margins: Margins, paper = 'iso_a4'): PrintedPage[] {
    const page = join(tmp.dir, `${name}.html`);
    const out = join(tmp.dir, `${name}.pdf`);
    writeFileSync(page, html);
    const m = [margins.top, margins.bottom, margins.left, margins.right].join(',');
    const cmd = process.env.DISPLAY ? [python!, '-I', script, page, out, m, paper] : ['xvfb-run', '-a', python!, '-I', script, page, out, m, paper];
    execFileSync(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
    if (!existsSync(out)) throw new Error('WebKitGTK schrieb keine Datei');
    return look(new Uint8Array(readFileSync(out)));
  }

  it('prints the browser way without printer margins: pages = sheets, no empty page after a sheet, real size', () => {
    const html = printPage([boxesPicture(herma.page, labelBoxes(herma, 10)), boxesPicture(herma.page, labelBoxes(herma, 2))], herma.page);
    const printed = printWebKit(html, 'randlos', { top: 0, bottom: 0, left: 0, right: 0 });
    expect(problems(printed, { page: herma.page, ink: [inkOf(herma, 10), inkOf(herma, 2)] })).toEqual([]);
  });

  it('with printer margins shrinks the sheets but adds no empty pages (a known limit, noted)', () => {
    const html = printPage([boxesPicture(herma.page, labelBoxes(herma, 10)), boxesPicture(herma.page, labelBoxes(herma, 2))], herma.page);
    const results: string[] = [];
    for (const [label, m] of [
      ['GTK-Rand 6,35 mm', { top: 6.35, bottom: 6.35, left: 6.35, right: 6.35 }],
      ['Tintenstrahl 3/12 mm', INKJET],
    ] as const) {
      const printed = printWebKit(html, label.replace(/\W+/g, '-'), m);
      expect(printed.map((p) => !!p.ink), label).toEqual([true, true]);
      results.push(`${label}: ${pct(inkScale(inkOf(herma, 10)!, printed[0].ink!))} %`);
    }
    infoNote(AREA, `WebKitGTK (GNOME Web, Safari-Engine) mit Druckerrand: Bögen verkleinert (${results.join(', ')}); die Desktop-App druckt darum über CUPS; im Druckdialog des Browsers Ränder „keine“ wählen, wo es das gibt`);
  });
});
