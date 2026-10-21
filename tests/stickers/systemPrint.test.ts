/**
 * "Drucken" in the desktop app (TODO #85): the PDF of the sheets goes to the
 * system (CUPS's lp on Linux) instead of WebKitGTK's print, which shrank the
 * sheets to the printable width and put an empty page after each one.
 *
 * The fake backend stands in for lp: it keeps the bytes it was handed, and
 * the virtual printer (virtualPrinter.ts) checks them like paper: pages =
 * sheets, no empty first page, A4 or Letter exactly, every label where the
 * template puts it (± 0.5 mm).
 */
import { describe, expect, it } from 'vitest';
import { buildSheetPdf, type StickerBitmap } from '../../src/core/stickers/pdf';
import { mirrorTemplate } from '../../src/core/stickers/backside';
import { slotRects } from '../../src/core/stickers/slots';
import { getTemplate, type LabelTemplate } from '../../src/core/stickers/templates';
import { printDocument, printWay } from '../../src/features/stickers/print';
import { firstChoice, printerLabel } from '../../src/features/stickers/SystemPrintDialog';
import type { PrinterAccess, PrintJob } from '../../src/platform/types';
import { TauriPrinter } from '../../src/platform/tauri/printer';
import { fakeBridge } from '../platform-tauri/fake-ipc';
import { tinyJpeg } from './fixtures';
import { canLookAtPaper, printOnPaper, printProblems, type BoxMm } from './virtualPrinter';

const herma = getTemplate('herma-5028') as LabelTemplate;
const letter: LabelTemplate = { ...herma, id: 'herma-letter', page: { widthMm: 215.9, heightMm: 279.4 } };

const sticker: StickerBitmap = { image: tinyJpeg(), widthPx: 8, heightPx: 5, bleedMm: 0 };

/** Sheets with `count` stickers, ten to a sheet. */
function sheets(count: number) {
  const pages: (StickerBitmap | null)[][] = [];
  for (let i = 0; i < count; i += 10) pages.push(Array.from({ length: Math.min(10, count - i) }, () => sticker));
  return pages;
}

/** Where the ink of a sheet with these labels belongs. */
function inkOf(t: LabelTemplate, filled: number): BoxMm | null {
  const rects = slotRects(t).slice(0, filled);
  if (!rects.length) return null;
  return {
    left: Math.min(...rects.map((r) => r.x)),
    top: Math.min(...rects.map((r) => r.y)),
    right: Math.max(...rects.map((r) => r.x + r.width)),
    bottom: Math.max(...rects.map((r) => r.y + r.height)),
  };
}

/** The desktop backend with lp in it: keeps the PDF that went to the printer. */
function virtualCups(printers = ['Brother_MFC_J5320DW', 'PDF'], fallback = 'Brother_MFC_J5320DW') {
  const { ipc, bridge } = fakeBridge();
  const files = new Map<string, Uint8Array>();
  const jobs: { args: Record<string, unknown>; pdf: Uint8Array }[] = [];
  ipc.on('fs_temp_file', () => '/tmp/tonuino-studio-1000/tmp-1.pdf');
  ipc.on('fs_write', (args, headers) => {
    files.set(decodeURIComponent(headers['x-path']), (args as Uint8Array).slice());
    return null;
  });
  ipc.on('fs_temp_remove', () => null);
  ipc.on('print_printers', () => ({ way: 'system', printers, default: fallback }));
  ipc.on('print_pdf', (args) => {
    const a = args as Record<string, unknown>;
    const pdf = files.get(a.path as string);
    if (!pdf) throw { code: 'not-allowed', detail: 'no such temp file' };
    jobs.push({ args: a, pdf });
    files.delete(a.path as string);
    return { way: a.open ? 'opened' : 'sent', job: 'PDF-1' };
  });
  return { printer: new TauriPrinter(bridge), ipc, jobs };
}

async function bytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

describe('the desktop app prints the PDF, not the WebView', () => {
  it('chooses the system way where the platform has a printer', () => {
    const printer = {} as PrinterAccess;
    expect(printWay({ printer })).toBe('system');
    expect(printWay({ printer, printPdf: async () => undefined })).toBe('pdf');
  });

  it('writes the PDF into the temp folder and hands it to lp with its paper size', async () => {
    const cups = virtualCups();
    const pdf = await buildSheetPdf({ template: herma, pages: sheets(3), bleedMm: 0, cutMarks: false, title: 'Sticker' });
    const way = await cups.printer.print({ name: 'Sticker Meine Box.pdf', pdf, page: herma.page, printer: 'PDF' });
    expect(way).toBe('sent');
    expect(cups.ipc.calls.map((c) => c.cmd)).toEqual(['fs_temp_file', 'fs_write', 'print_pdf']);
    expect(cups.jobs[0].args).toEqual({ path: '/tmp/tonuino-studio-1000/tmp-1.pdf', name: 'Sticker Meine Box.pdf', printer: 'PDF', widthMm: 210, heightMm: 297, twoSided: false, open: false });
    expect(cups.jobs[0].pdf).toEqual(await bytes(pdf));
    expect(await cups.printer.list()).toEqual({ way: 'system', printers: ['Brother_MFC_J5320DW', 'PDF'], default: 'Brother_MFC_J5320DW' });
  });

  it('opens the PDF in the PDF program where there is no CUPS (Windows)', async () => {
    const calls: PrintJob[] = [];
    const printer: PrinterAccess = {
      list: async () => ({ way: 'open', printers: [], default: null }),
      print: async (job) => {
        calls.push(job);
        return 'opened';
      },
    };
    const pdf = new Blob(['%PDF-1.3'], { type: 'application/pdf' });
    const printed = await printDocument({ printer }, { name: 'Testseite.pdf', page: herma.page, pdf: async () => pdf, pictures: async () => [] });
    expect(printed).toBe(true);
    expect(calls).toEqual([{ name: 'Testseite.pdf', page: herma.page, twoSided: false, pdf, open: true }]);
  });

  it('starts with the printer chosen last time, else the computer default', () => {
    const list = { way: 'system' as const, printers: ['A', 'Brother_MFC_J5320DW'], default: 'Brother_MFC_J5320DW' };
    expect(firstChoice(list, null)).toBe('Brother_MFC_J5320DW');
    expect(firstChoice(list, 'A')).toBe('A');
    expect(firstChoice(list, 'Gone')).toBe('Brother_MFC_J5320DW');
    expect(firstChoice({ ...list, default: null }, null)).toBe('A');
    expect(firstChoice({ ...list, printers: [] }, null)).toBeNull();
    expect(printerLabel('Brother_MFC_J5320DW')).toBe('Brother MFC J5320DW');
  });
});

describe.skipIf(!canLookAtPaper)('on the virtual printer', () => {
  const printAndLook = async (t: LabelTemplate, count: number, backs = false) => {
    const pages = sheets(count);
    const cups = virtualCups();
    const pdf = await buildSheetPdf({ template: t, pages, backs: backs ? pages : undefined, bleedMm: 0, cutMarks: false, footer: false, title: 'Sticker' });
    await cups.printer.print({ name: 'Sticker.pdf', pdf, page: t.page, twoSided: backs, printer: 'Brother_MFC_J5320DW' });
    // Without the line under the sheets: only the labels are measured.
    return { paper: printOnPaper(cups.jobs[0].pdf), args: cups.jobs[0].args, pages };
  };

  it('prints one page per sheet, the first one not empty, every label in place (A4)', async () => {
    const { paper, pages } = await printAndLook(herma, 12);
    expect(pages).toHaveLength(2);
    expect(paper[0].ink).not.toBeNull();
    expect(printProblems(paper, { page: herma.page, ink: [inkOf(herma, 10), inkOf(herma, 2)] })).toEqual([]);
  });

  it('keeps the size on Letter as well', async () => {
    const { paper, args } = await printAndLook(letter, 10);
    expect(args).toMatchObject({ widthMm: 215.9, heightMm: 279.4 });
    expect(printProblems(paper, { page: letter.page, ink: [inkOf(letter, 10)] })).toEqual([]);
  });

  it('puts the backs on every other page, mirrored, for both sides', async () => {
    const { paper, args } = await printAndLook(herma, 3, true);
    expect(args.twoSided).toBe(true);
    expect(printProblems(paper, { page: herma.page, ink: [inkOf(herma, 3), inkOf(mirrorTemplate(herma), 3)] })).toEqual([]);
  });

  it('notices a shrunk print such as WebKitGTK made of it', () => {
    // Measured from WebKitGTK's print to a file (scripts/bench/druck.py): 94 % and moved by the 6.35 mm margin.
    const want = inkOf(herma, 10)!;
    const s = 197.3 / 210;
    const shrunk = { left: 6.35 + want.left * s, top: 6.35 + want.top * s, right: 6.35 + want.right * s, bottom: 6.35 + want.bottom * s };
    const problems = printProblems(
      [
        { ...herma.page, ink: shrunk },
        { ...herma.page, ink: null },
      ],
      { page: herma.page, ink: [want] },
    );
    expect(problems[0]).toBe('2 Seiten statt 1');
    expect(problems.some((p) => p.startsWith('Seite 1: left'))).toBe(true);
  });
});
