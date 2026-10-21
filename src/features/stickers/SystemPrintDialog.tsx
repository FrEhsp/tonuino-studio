/**
 * The desktop app's own small print dialog (TODO #85): which printer, then
 * the PDF goes to it in its real size (Platform.printer, CUPS on Linux).
 * Without CUPS (Windows) the PDF opens in the PDF program instead, with the
 * note to print it at "Tatsächliche Größe" there.
 *
 * Paper type and tray come from the printer's own settings; whoever needs
 * other ones opens the PDF in the PDF program from here.
 */
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import type { PrinterAccess, PrinterList, PrintJob } from '../../platform/types';
import { Button } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { toast } from '../../ui/components/Toast';
import { Drucker } from '../../ui/icons';

const PRINTER_KEY = 'tonuino-studio:drucker';

export interface SystemPrintJob extends Omit<PrintJob, 'printer' | 'open'> {
  /** Pages of the PDF. */
  pages?: number;
}

interface Request {
  job: SystemPrintJob;
  list: PrinterList;
  printer: PrinterAccess;
  done: (printed: boolean) => void;
}

const request = signal<Request | null>(null);

/** CUPS names have no spaces: "Brother_MFC_J5320DW" reads as "Brother MFC J5320DW". */
export function printerLabel(name: string): string {
  return name.replace(/_+/g, ' ').trim() || name;
}

function storedPrinter(): string | null {
  try {
    return localStorage.getItem(PRINTER_KEY);
  } catch {
    return null;
  }
}

function storePrinter(name: string): void {
  try {
    localStorage.setItem(PRINTER_KEY, name);
  } catch {
    // Chosen again next time.
  }
}

/** The printer to start with: the one chosen last time, else the computer's default, else the first. */
export function firstChoice(list: PrinterList, stored: string | null): string | null {
  if (stored && list.printers.includes(stored)) return stored;
  if (list.default && list.printers.includes(list.default)) return list.default;
  return list.printers[0] ?? null;
}

const OPENED_NOTE = 'Drucke dort mit „Tatsächliche Größe“ (100 %), nicht „An Seite anpassen“.';

async function openInPdfProgram(printer: PrinterAccess, job: SystemPrintJob): Promise<void> {
  await printer.print({ ...job, open: true });
  toast.info('Das PDF ist im PDF-Programm geöffnet', OPENED_NOTE);
}

/**
 * Prints the PDF through the system. Resolves true once it went to a printer
 * or opened in the PDF program, false when the user closed the dialog.
 */
export async function printWithSystem(printer: PrinterAccess, job: SystemPrintJob): Promise<boolean> {
  const list = await printer.list();
  if (list.way === 'open') {
    await openInPdfProgram(printer, job);
    return true;
  }
  request.value?.done(false);
  return new Promise<boolean>((done) => {
    request.value = {
      job,
      list,
      printer,
      done: (printed) => {
        request.value = null;
        done(printed);
      },
    };
  });
}

/** Mounted once in the app (App.tsx). */
export function SystemPrintDialogHost() {
  const r = request.value;
  // A new request gets a fresh dialog (and with it a fresh choice).
  return r ? <SystemPrintDialog key={r.job.name + r.list.printers.join()} request={r} /> : null;
}

function SystemPrintDialog({ request: r }: { request: Request }) {
  const { job, list } = r;
  const [chosen, setChosen] = useState(() => firstChoice(list, storedPrinter()));
  const [busy, setBusy] = useState<'print' | 'open' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const none = !list.printers.length;

  const send = async () => {
    if (!chosen) return;
    setBusy('print');
    setError(null);
    try {
      await r.printer.print({ ...job, printer: chosen });
      storePrinter(chosen);
      toast.success('An den Drucker geschickt', `Kommt gleich aus „${printerLabel(chosen)}“, in echter Größe.`);
      r.done(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const open = async () => {
    setBusy('open');
    setError(null);
    try {
      await openInPdfProgram(r.printer, job);
      r.done(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const pages = job.pages ? (job.pages === 1 ? '1 Seite' : `${job.pages} Seiten`) : null;
  return (
    <Dialog
      title="Drucken"
      onClose={() => r.done(false)}
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => void open()} disabled={!!busy} loading={busy === 'open'}>
            Im PDF-Programm öffnen
          </Button>
          {none ? null : (
            <Button variant="primary" icon={Drucker} onClick={() => void send()} disabled={!!busy || !chosen} loading={busy === 'print'}>
              Drucken
            </Button>
          )}
        </>
      }
    >
      <div class="stack">
        {none ? (
          <p>An diesem Computer ist noch kein Drucker eingerichtet. Richte ihn in den Einstellungen des Computers ein, oder öffne das PDF und drucke es von dort.</p>
        ) : list.printers.length === 1 ? (
          <p>
            Drucker: <b>{printerLabel(list.printers[0])}</b>
          </p>
        ) : (
          <label class="stack tight">
            <span>Drucker</span>
            <select class="select" value={chosen ?? ''} disabled={!!busy} onChange={(e) => setChosen(e.currentTarget.value)}>
              {list.printers.map((p) => (
                <option key={p} value={p}>
                  {printerLabel(p)}
                  {p === list.default ? ' (Standard)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {none ? null : (
          <p>
            {pages ? `${pages}, ` : ''}in echter Größe (100 %), so wie der Bogen in der Vorschau. Papierart und Papierfach nimmt der Drucker aus seinen
            eigenen Einstellungen.
          </p>
        )}
        {job.twoSided && !none ? (
          <p class="soft small">Beidseitig, an der langen Kante gewendet. Kann dein Drucker das nicht, kommen die Rückseiten als eigene Blätter.</p>
        ) : null}
        <p class="soft small">Andere Einstellungen nötig? Öffne das PDF im PDF-Programm und wähle dort „Tatsächliche Größe“.</p>
        {error ? (
          <p class="callout danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
