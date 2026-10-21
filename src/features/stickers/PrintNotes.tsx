/**
 * Small helps at the print button (sticker audit 16.10.2026, items 4 and 5):
 * the short list for the print dialog, and the question after a trial print
 * on plain paper.
 */
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { A4, type LabelTemplate } from '../../core/stickers/templates';
import { Button } from '../../ui/components/controls';
import { Dialog } from '../../ui/components/Dialog';
import { Drucker } from '../../ui/icons';

const CHECKLIST_KEY = 'tonuino-studio:druckliste';

/**
 * Room for the open list in the bar that stays over the sheet: a tall window
 * with the questions beside a sheet at its full 960 px, where the list fits
 * on one line. Below that, or on a tablet or phone, the open list would cover
 * half of the sheet or the line with the paper.
 */
function roomy(): boolean {
  try {
    return matchMedia('(min-height: 1000px) and (min-width: 1720px)').matches;
  } catch {
    return false;
  }
}

/**
 * Open until the first print where there is room for it, then closed, unless
 * the user opened it again; only a convenience of this browser. A list left
 * open on a big screen still starts closed in a small window: there the one
 * line "Druckgröße 100 %" stays in view and the rest is one click away.
 */
function storedOpen(): boolean {
  try {
    if (localStorage.getItem(CHECKLIST_KEY) === 'zu') return false;
  } catch {
    // As if nothing was stored.
  }
  return roomy();
}

/** After a print went to the printer: the list closes, unless the user chose to keep it open. */
export function printedOnce(): void {
  try {
    if (localStorage.getItem(CHECKLIST_KEY)) return;
  } catch {
    // Closed for this visit only.
  }
  checklistOpen.value = false;
  storeOpen(false);
}

function storeOpen(open: boolean): void {
  try {
    localStorage.setItem(CHECKLIST_KEY, open ? 'auf' : 'zu');
  } catch {
    // Kept for this visit.
  }
}

/**
 * One state for the bar and the phone's line under it; until the user opens
 * or closes the list, it follows the size of the window (read when drawn).
 */
const checklistOpen = signal<boolean | null>(null);

/**
 * What to set in the print dialog for a sheet: the size always in view (the
 * most common trap), the rest one click away. Paper type and feeding matter
 * because a printer that takes labels for plain paper feeds them unevenly.
 */
export function PrintChecklist({ template: t, inBar = false }: { template: LabelTemplate; inBar?: boolean }) {
  const open = checklistOpen.value ?? storedOpen();
  // In the bar over the sheet without room for one line, the open list floats above it like a menu:
  // as a line of its own it wrapped into two and the bar grew over the sheet (1280 px, #73).
  const pops = inBar && !roomy();
  const box = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!pops || !open) return;
    // Like a menu: a click elsewhere or Escape closes it again (for this visit; the stored choice stays).
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) checklistOpen.value = false;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') checklistOpen.value = false;
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [pops, open]);
  const a4 = Math.abs(t.page.widthMm - A4.widthMm) < 0.5 && Math.abs(t.page.heightMm - A4.heightMm) < 0.5;
  const rows = [
    ...(a4 ? ['A4, nicht Letter'] : []),
    t.kind === 'die-cut' ? 'Papierart „Etiketten“ oder „dickes Papier“' : 'Papierart passend, etwa „Fotopapier“ oder „dickes Papier“',
    'nicht randlos',
    'Bogen einzeln einlegen, Papierführung anlegen',
  ];
  return (
    <details ref={box} class={`print-check${pops ? ' pops' : ''}`} open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          checklistOpen.value = !open;
          storeOpen(!open);
        }}
      >
        Druckgröße 100 %, nicht „An Seite anpassen“
      </summary>
      <ul class={pops ? 'menu print-check-pop' : undefined}>
        {rows.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </details>
  );
}

/** After the trial print: does it fit? Then the label sheet goes in. */
export function TrialDialog({ onClose, onPrint }: { onClose: () => void; onPrint: () => void }) {
  return (
    <Dialog
      title="Passt alles?"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Noch nicht
          </Button>
          <Button variant="primary" icon={Drucker} onClick={onPrint}>
            Auf den Bogen drucken
          </Button>
        </>
      }
    >
      <div class="stack">
        <p>Lege das Blatt auf einen Etikettenbogen und halte beides gegen ein Fenster. Liegen alle Bilder in ihren Umrissen, lege den Etikettenbogen ein und drucke.</p>
        <p class="soft small">
          Liegen manche daneben? Was dann hilft, steht in der Hilfe unter{' '}
          <a href="#/hilfe/verrutscht" onClick={onClose}>
            Sticker liegen daneben
          </a>
          .
        </p>
      </div>
    </Dialog>
  );
}
