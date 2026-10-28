/**
 * Which printer the stickers go to, for the printer correction kept per printer (TODO #128).
 *
 * The desktop app knows it: the one chosen in its print dialog (SystemPrintDialog.tsx), remembered for
 * next time. The browser's print dialog and the phone's print service do not tell the app which printer
 * they use: there everything counts as the one printer "standard", as before 0.6.
 */
import { signal } from '@preact/signals';

const PRINTER_KEY = 'tonuino-studio:drucker';

/** The name corrections saved before 0.6 stand under, and that of any printer the app cannot name. */
export const ANY_PRINTER = 'standard';

/** The printer chosen last time in the app's own print dialog, if any. */
export function storedPrinter(): string | null {
  try {
    return localStorage.getItem(PRINTER_KEY);
  } catch {
    return null;
  }
}

/** Remembers the printer chosen and makes it the one the next print is corrected for. */
export function storePrinter(name: string): void {
  activePrinter.value = name;
  try {
    localStorage.setItem(PRINTER_KEY, name);
  } catch {
    // Chosen again next time.
  }
}

/** The printer the next print goes to as far as the app knows; ANY_PRINTER where it cannot know. */
export const activePrinter = signal<string>(storedPrinter() ?? ANY_PRINTER);

/** CUPS names have no spaces: "Brother_MFC_J5320DW" reads as "Brother MFC J5320DW". */
export function printerLabel(name: string): string {
  return name.replace(/_+/g, ' ').trim() || name;
}
