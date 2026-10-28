/**
 * "Drucken": the sticker sheets to the printer in their real size.
 *
 * Three ways, by where the app runs:
 * - Desktop app (Linux, Windows): the PDF of the sheets goes to the system
 *   (Platform.printer, src-tauri/src/print.rs): on Linux straight to CUPS
 *   with "no scaling", after a small dialog of the app's own to pick the
 *   printer (SystemPrintDialog.tsx); on Windows, or without CUPS, it opens
 *   in the PDF program with the note to print at "Tatsächliche Größe".
 *   WebKitGTK's own print shrank the sheets to the printer's printable
 *   width (about 94 %) and put an empty page after every sheet (TODO #85,
 *   scripts/bench/druck.py).
 * - Android app: the PDF to the phone's print service (Platform.printPdf,
 *   src-tauri/android/TonuinoFiles.kt); its WebView does nothing with
 *   window.print().
 * - Browser: the system's print dialog, without saving a PDF first (Frank,
 *   11.10.2026). The sheets are drawn as pictures of the whole page (the
 *   same pictures as for a photo service, with calibration and cut marks)
 *   and put into a print area of the app's own page. `@page` sets the paper
 *   size and no margin, each picture is exactly as big as the page in
 *   millimetres, so the dialog's default "100 %" prints the stickers in
 *   their real size. The app itself is hidden while printing.
 */
import type { Platform } from '../../platform/types';
import { canvasesLost } from '../../ui/repaint';
import { printWithSystem } from './SystemPrintDialog';

export interface PrintPage {
  /** Paper size of the sheet. */
  widthMm: number;
  heightMm: number;
}

const ROOT_ID = 'sticker-print-root';
const STYLE_ID = 'sticker-print-style';

/** How this app prints: the page's own dialog, a PDF to the phone's print service or to the computer's printer, or not at all. */
export type PrintWay = 'dialog' | 'pdf' | 'system' | null;

type PrintPlatform = Pick<Platform, 'mobile' | 'printPdf' | 'printer'>;

export function printWay(p: PrintPlatform | null | undefined): PrintWay {
  if (p?.printPdf) return 'pdf';
  if (p?.printer) return 'system';
  // The Android app without its file bridge: window.print() is there, but nothing would come out.
  if (p?.mobile) return null;
  return typeof window !== 'undefined' && typeof window.print === 'function' ? 'dialog' : null;
}

/** Whether this environment can print at all. */
export function canPrint(p: PrintPlatform | null | undefined): boolean {
  return printWay(p) !== null;
}

export interface PrintDocument {
  /** File name of the PDF, also the job's name at the printer. */
  name: string;
  page: PrintPage;
  /** Every other page is the back of the one before. */
  twoSided?: boolean;
  /** Pages of the PDF, for the dialog. */
  pages?: number;
  /** The document as a PDF in real size (desktop and Android app). */
  pdf: () => Promise<Blob>;
  /** The document as one picture per page (the browser's print dialog). */
  pictures: () => Promise<Blob[]>;
}

/**
 * Prints the document the way this app prints (see printWay). Resolves true
 * when it went to a printer, a print dialog or the PDF program, false when
 * the user stopped in the app's own print dialog.
 */
export async function printDocument(p: PrintPlatform, doc: PrintDocument): Promise<boolean> {
  if (p.printPdf) {
    await p.printPdf(doc.name, await doc.pdf());
    return true;
  }
  if (p.printer) {
    return printWithSystem(p.printer, { name: doc.name, page: doc.page, twoSided: !!doc.twoSided, ...(doc.pages ? { pages: doc.pages } : {}), pdf: doc.pdf });
  }
  await printSheets(await doc.pictures(), doc.page);
  return true;
}

/** The CSS for the print: paper size, no margins, only the sheets. */
export function printCss(page: PrintPage): string {
  const w = `${page.widthMm}mm`;
  const h = `${page.heightMm}mm`;
  return [
    `@page { size: ${w} ${h}; margin: 0; }`,
    `#${ROOT_ID} { display: none; }`,
    '@media print {',
    `  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; width: ${w}; }`,
    `  body > *:not(#${ROOT_ID}) { display: none !important; }`,
    `  #${ROOT_ID} { display: block !important; }`,
    // One pixel less than the page, the picture not squeezed but its lowest pixel row (white paper edge) cut off:
    // WebKit (Safari, GNOME Web, the Linux app's WebView) put an empty page after every sheet exactly as tall as the page (Testlabor #69).
    `  #${ROOT_ID} img { display: block; width: ${w}; height: calc(${h} - 1px); object-fit: cover; object-position: left top; margin: 0; padding: 0; break-after: page; page-break-after: always; }`,
    `  #${ROOT_ID} img:last-child { break-after: auto; page-break-after: auto; }`,
    '  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
    '}',
  ].join('\n');
}

/**
 * Opens the print dialog with these sheet pictures. Resolves once the dialog
 * is closed (or right away where the browser does not wait); everything the
 * print needed is removed again afterwards.
 */
export async function printSheets(sheets: Blob[], page: PrintPage): Promise<void> {
  cleanup();
  const urls = sheets.map((b) => URL.createObjectURL(b));
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = printCss(page);
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('aria-hidden', 'true');
  const images = urls.map((url, i) => {
    const img = document.createElement('img');
    img.alt = `Bogen ${i + 1}`;
    img.src = url;
    root.appendChild(img);
    return img;
  });
  document.head.appendChild(style);
  document.body.appendChild(root);
  try {
    // Every sheet must be decoded before the dialog takes its picture of the page.
    await Promise.all(images.map((img) => img.decode().catch(() => undefined)));
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('afterprint', finish);
        resolve();
      };
      window.addEventListener('afterprint', finish);
      window.print();
      // print() blocks in most browsers; where it does not, afterprint ends the wait. A safety net for WebViews that send neither.
      setTimeout(finish, 120_000);
    });
  } finally {
    cleanup();
    for (const u of urls) URL.revokeObjectURL(u);
    // WebKitGTK may hand the page back with white canvases, with or without "afterprint".
    canvasesLost();
  }
}

function cleanup(): void {
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
}
