/**
 * The desktop app's own small print dialog (TODO #85): which printer, then
 * the PDF goes to it in its real size (Platform.printer, CUPS on Linux).
 * Without CUPS (Windows) the PDF opens in the PDF program instead, with the
 * note to print it at "Tatsächliche Größe" there.
 *
 * Colour and quality are said with every job (never the printer's default:
 * a Brother set to black and white printed the covers grey, 0.5.1). The kind
 * of paper too, where the driver knows kinds; the tray comes from the
 * printer's own settings. The dialog names the paper size the printer is set
 * to and warns when it is not the one of the sheet (Letter in the US,
 * Prüfrunde 1, bastler 23).
 */
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import type {
  PaperKind,
  PrinterAccess,
  PrinterList,
  PrinterPaper,
  PrintJob,
} from "../../platform/types";
import { Button, Segmented } from "../../ui/components/controls";
import { Dialog } from "../../ui/components/Dialog";
import { toast } from "../../ui/components/Toast";
import { Drucker } from "../../ui/icons";
import { printerLabel, storedPrinter, storePrinter } from "./printers";

export { printerLabel };
const LOOK_KEY = "tonuino-studio:druck-art";

/** Colour and quality, as chosen last time: colour and normal quality at first. */
export interface PrintLook {
  color: boolean;
  quality: "normal" | "high";
  paper: PaperKind;
}

export function storedLook(): PrintLook {
  try {
    const raw = JSON.parse(
      localStorage.getItem(LOOK_KEY) ?? "{}",
    ) as Partial<PrintLook>;
    return {
      color: raw.color !== false,
      quality: raw.quality === "high" ? "high" : "normal",
      paper: raw.paper === "photo" || raw.paper === "labels" ? raw.paper : "plain",
    };
  } catch {
    return { color: true, quality: "normal", paper: "plain" };
  }
}

function storeLook(look: PrintLook): void {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    // Chosen again next time.
  }
}

export interface SystemPrintJob extends Omit<
  PrintJob,
  "printer" | "open" | "color" | "quality" | "paper" | "pdf"
> {
  /** Pages of the PDF. */
  pages?: number;
  /**
   * The PDF, made once the printer is chosen: the printer correction is kept per printer
   * (printers.ts, TODO #128), so the stickers are placed for the one they go to.
   */
  pdf: Blob | (() => Promise<Blob>);
}

/** The job with its PDF made. */
async function withPdf(job: SystemPrintJob): Promise<Omit<PrintJob, "printer">> {
  return { ...job, pdf: typeof job.pdf === "function" ? await job.pdf() : job.pdf };
}

interface Request {
  job: SystemPrintJob;
  list: PrinterList;
  printer: PrinterAccess;
  done: (printed: boolean) => void;
}

const request = signal<Request | null>(null);


/** The printer to start with: the one chosen last time, else the computer's default, else the first. */
export function firstChoice(
  list: PrinterList,
  stored: string | null,
): string | null {
  if (stored && list.printers.includes(stored)) return stored;
  if (list.default && list.printers.includes(list.default)) return list.default;
  return list.printers[0] ?? null;
}

/** The name of a paper size as printers say it: "A4", "Letter", or null. */
export function paperName(size: string | null | undefined): "A4" | "Letter" | null {
  if (!size) return null;
  if (/(^|_)a4(\b|_|$)/i.test(size)) return "A4";
  if (/letter/i.test(size)) return "Letter";
  return null;
}

/** The sheet's paper, from its size in mm (either way round). */
export function sheetPaper(page: { widthMm: number; heightMm: number }): "A4" | "Letter" | null {
  const [a, b] = [Math.min(page.widthMm, page.heightMm), Math.max(page.widthMm, page.heightMm)];
  if (Math.abs(a - 210) < 1 && Math.abs(b - 297) < 1) return "A4";
  if (Math.abs(a - 215.9) < 1 && Math.abs(b - 279.4) < 1) return "Letter";
  return null;
}

/** What to say when the printer is set to another paper than the sheet; null when it fits or is unknown. */
export function paperWarning(sheet: "A4" | "Letter" | null, printer: "A4" | "Letter" | null): string | null {
  if (!sheet || !printer || sheet === printer) return null;
  return sheet === "A4"
    ? "Dein Drucker ist auf Letter eingestellt, der Bogen ist A4. Lege A4 ein und stelle den Drucker auf A4, sonst fehlt unten ein Streifen."
    : "Dein Drucker ist auf A4 eingestellt, der Bogen ist Letter. Lege Letter ein und stelle den Drucker auf Letter.";
}

const PAPER_LABELS: Record<PaperKind, string> = {
  plain: "Normal",
  photo: "Foto",
  labels: "Etiketten",
};

const OPENED_NOTE =
  "Drucke dort mit „Tatsächliche Größe“ (100 %), nicht „An Seite anpassen“.";

async function openInPdfProgram(
  printer: PrinterAccess,
  job: SystemPrintJob,
): Promise<void> {
  await printer.print({ ...(await withPdf(job)), open: true });
  toast.info("Das PDF ist im PDF-Programm geöffnet", OPENED_NOTE);
}

/**
 * Prints the PDF through the system. Resolves true once it went to a printer
 * or opened in the PDF program, false when the user closed the dialog.
 */
export async function printWithSystem(
  printer: PrinterAccess,
  job: SystemPrintJob,
): Promise<boolean> {
  const list = await printer.list();
  if (list.way === "open") {
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
  return r ? (
    <SystemPrintDialog key={r.job.name + r.list.printers.join()} request={r} />
  ) : null;
}

function SystemPrintDialog({ request: r }: { request: Request }) {
  const { job, list } = r;
  const [chosen, setChosen] = useState(() =>
    firstChoice(list, storedPrinter()),
  );
  const [look, setLook] = useState(storedLook);
  const [busy, setBusy] = useState<"print" | "open" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paper, setPaper] = useState<PrinterPaper | null>(null);
  const none = !list.printers.length;
  // What the chosen printer has in itself: its paper size and kinds of paper.
  useEffect(() => {
    setPaper(null);
    if (!chosen || !r.printer.paper) return;
    let alive = true;
    r.printer
      .paper(chosen)
      .then((p) => alive && setPaper(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [chosen]);
  const kinds = paper?.kinds ?? [];
  const sheet = sheetPaper(job.page);
  const inPrinter = paperName(paper?.size);
  const warning = paperWarning(sheet, inPrinter);

  const send = async () => {
    if (!chosen) return;
    setBusy("print");
    setError(null);
    try {
      // The printer first: its correction places the stickers in the PDF made now.
      storePrinter(chosen);
      const { paper: kind, ...rest } = look;
      await r.printer.print({ ...(await withPdf(job)), printer: chosen, ...rest, ...(kinds.includes(kind) ? { paper: kind } : {}) });
      storeLook(look);
      toast.success(
        "An den Drucker geschickt",
        `Kommt gleich aus „${printerLabel(chosen)}“, in echter Größe.`,
      );
      r.done(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const open = async () => {
    setBusy("open");
    setError(null);
    try {
      await openInPdfProgram(r.printer, job);
      r.done(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const pages = job.pages
    ? job.pages === 1
      ? "1 Seite"
      : `${job.pages} Seiten`
    : null;
  return (
    <Dialog
      title="Drucken"
      onClose={() => r.done(false)}
      dismissable={!busy}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => void open()}
            disabled={!!busy}
            loading={busy === "open"}
          >
            Im PDF-Programm öffnen
          </Button>
          {none ? null : (
            <Button
              variant="primary"
              icon={Drucker}
              onClick={() => void send()}
              disabled={!!busy || !chosen}
              loading={busy === "print"}
            >
              Drucken
            </Button>
          )}
        </>
      }
    >
      <div class="stack">
        {none ? (
          <p>
            An diesem Computer ist noch kein Drucker eingerichtet. Richte ihn in
            den Einstellungen des Computers ein, oder öffne das PDF und drucke
            es von dort.
          </p>
        ) : list.printers.length === 1 ? (
          <p>
            Drucker: <b>{printerLabel(list.printers[0])}</b>
          </p>
        ) : (
          <label class="stack tight">
            <span>Drucker</span>
            <select
              class="select"
              value={chosen ?? ""}
              disabled={!!busy}
              onChange={(e) => setChosen(e.currentTarget.value)}
            >
              {list.printers.map((p) => (
                <option key={p} value={p}>
                  {printerLabel(p)}
                  {p === list.default ? " (Standard)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {none ? null : (
          <div class="row wrap">
            <div class="stack tight">
              <span>Farbe</span>
              <Segmented
                label="Farbe"
                value={look.color ? "color" : "mono"}
                options={[
                  { value: "color", label: "Farbig" },
                  { value: "mono", label: "Schwarzweiß" },
                ]}
                onChange={(v) => setLook({ ...look, color: v === "color" })}
              />
            </div>
            <div class="stack tight">
              <span>Qualität</span>
              <Segmented
                label="Qualität"
                value={look.quality}
                options={[
                  { value: "normal", label: "Normal" },
                  { value: "high", label: "Hoch" },
                ]}
                onChange={(quality) => setLook({ ...look, quality })}
              />
            </div>
            {kinds.length > 1 ? (
              <div class="stack tight">
                <span>Papierart</span>
                <Segmented
                  label="Papierart"
                  value={kinds.includes(look.paper) ? look.paper : kinds[0]}
                  options={kinds.map((k) => ({ value: k, label: PAPER_LABELS[k] }))}
                  onChange={(kind) => setLook({ ...look, paper: kind })}
                />
              </div>
            ) : null}
          </div>
        )}
        {!none && (sheet || inPrinter) ? (
          <p>
            Papier: <b>{sheet ?? `${Math.round(job.page.widthMm)} × ${Math.round(job.page.heightMm)} mm`}</b>
            {inPrinter ? `, im Drucker eingestellt: ${inPrinter}` : ""}
          </p>
        ) : null}
        {warning ? (
          <p class="callout warning" role="alert">
            {warning}
          </p>
        ) : null}
        {none ? null : (
          <p>
            {pages ? `${pages}, ` : ""}in echter Größe (100 %), so wie der Bogen
            in der Vorschau. {kinds.length > 1 ? "Das Papierfach" : "Papierart und Papierfach"} nimmt der Drucker aus
            seinen eigenen Einstellungen.{" "}
            {/* With a paper kind to choose, that is the setting for photo paper (Prüfrunde 2, bastler 17). */}
            {kinds.includes("photo") ? "Für Fotopapier wähle Papierart „Foto“ und Qualität „Hoch“." : "Für Fotopapier wähle „Hoch“."}
          </p>
        )}
        {job.twoSided && !none ? (
          <p class="soft small">
            Beidseitig, an der langen Kante gewendet. Kann dein Drucker das
            nicht, kommen die Rückseiten als eigene Blätter.
          </p>
        ) : null}
        <p class="soft small">
          Andere Einstellungen nötig? Öffne das PDF im PDF-Programm und wähle
          dort „Tatsächliche Größe“.
        </p>
        {error ? (
          <p class="callout danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
