/**
 * Printing a PDF in its real size (see src-tauri/src/print.rs): the page
 * writes the PDF into the app's temp folder, the backend hands it to CUPS's
 * lp with the options that keep the size, or opens it in the PDF program.
 *
 *   fs_temp_file + fs_write, print_printers, print_paper, print_pdf
 */
import type { PaperKind, PrinterAccess, PrinterList, PrinterPaper, PrintJob } from '../types';
import type { Bridge } from './bridge';
import { writeFile } from './fs';

export class TauriPrinter implements PrinterAccess {
  constructor(private readonly bridge: Bridge) {}

  async list(): Promise<PrinterList> {
    const dto = await this.bridge.call<PrinterList>('print', 'print_printers');
    return { way: dto.way === 'system' ? 'system' : 'open', printers: dto.printers ?? [], default: dto.default ?? null };
  }

  async paper(printer: string): Promise<PrinterPaper> {
    const dto = await this.bridge.call<{ size?: string | null; kinds?: string[] }>('print', 'print_paper', { printer });
    const kinds = (dto.kinds ?? []).filter((k): k is PaperKind => k === 'plain' || k === 'photo' || k === 'labels');
    return { size: dto.size ?? null, kinds };
  }

  async print(job: PrintJob): Promise<'sent' | 'opened'> {
    const path = await this.bridge.call<string>('print', 'fs_temp_file', { extension: 'pdf' });
    try {
      await writeFile(this.bridge, path, job.pdf, { area: 'print' });
    } catch (e) {
      await this.bridge.ipc.invoke('fs_temp_remove', { path }).catch(() => undefined);
      throw e;
    }
    // The backend removes the file (or keeps it for the PDF program).
    const done = await this.bridge.call<{ way: string }>('print', 'print_pdf', {
      path,
      name: job.name,
      printer: job.printer ?? null,
      widthMm: job.page.widthMm,
      heightMm: job.page.heightMm,
      twoSided: !!job.twoSided,
      open: !!job.open,
      color: job.color !== false,
      quality: job.quality ?? 'normal',
      paper: job.paper ?? null,
    });
    return done.way === 'sent' ? 'sent' : 'opened';
  }
}
