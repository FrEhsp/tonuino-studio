import { signal } from '@preact/signals';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-preact';
import { platform } from '../../app/state';

/** A button in a toast that leads on, e.g. "Schreibrechte holen". */
export interface ToastAction {
  label: string;
  run: () => void;
  /** The text of the toast as it reads next to the button (e.g. without "see elsewhere"). */
  tidy?: (text: string) => string;
}

interface ToastItem {
  id: number;
  kind: 'success' | 'error' | 'info';
  title: string;
  text?: string;
  action?: ToastAction;
}

const items = signal<ToastItem[]>([]);
let next = 0;

function push(kind: ToastItem['kind'], title: string, text?: string, ms = kind === 'error' ? 9000 : 4500, action?: ToastAction) {
  const id = ++next;
  if (action?.tidy && text) text = action.tidy(text);
  items.value = [...items.value.slice(-3), { id, kind, title, text, ...(action ? { action } : {}) }];
  setTimeout(() => dismiss(id), ms);
}

/** An error told only as text: its way out, if a feature knows one (see setErrorAction). */
function errorPush(title: string, text?: string) {
  const action = text ? errorAction?.(text) : undefined;
  push('error', title, text, action ? 15000 : undefined, action);
}

function dismiss(id: number) {
  items.value = items.value.filter((t) => t.id !== id);
}

export const toast = {
  /** With an action ("Jetzt prüfen"), the toast stays longer. */
  success: (title: string, text?: string, action?: ToastAction) => push('success', title, text, action ? 9000 : undefined, action),
  error: (title: string, text?: string) => errorPush(title, text),
  info: (title: string, text?: string, action?: ToastAction) => push('info', title, text, action ? 9000 : undefined, action),
};

/**
 * After files.save() said yes. Where saving only starts a download (Firefox,
 * Safari), the file is not saved yet: say where it lands instead. Without a
 * title, nothing is said where a save dialog was shown.
 */
export function toastSaved(title?: string, detail?: string) {
  if (platform.peek()?.files.downloadsOnly) {
    push('success', 'Download gestartet', detail ? `Die Datei landet in deinem Download-Ordner. ${detail}` : 'Die Datei landet in deinem Download-Ordner.');
  } else if (title) push('success', title, detail);
}

let errorAction: ((e: unknown) => ToastAction | undefined) | null = null;

/**
 * Lets a feature offer the way out of an error right in its toast (see
 * features/box/writeAccess.ts: "Schreibrechte holen" when the app may not
 * write to the card).
 */
export function setErrorAction(fn: ((e: unknown) => ToastAction | undefined) | null) {
  errorAction = fn;
}

/** Shows an error from a caught exception with a friendly title. */
export function toastError(title: string, e: unknown) {
  if (e instanceof DOMException && e.name === 'AbortError') return;
  const action = errorAction?.(e);
  push('error', title, e instanceof Error ? e.message : String(e), action ? 15000 : undefined, action);
}

const ICONS = { success: CircleCheck, error: CircleAlert, info: Info };

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {items.value.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div class={`toast ${t.kind}`} key={t.id}>
            <Icon size={18} strokeWidth={2.2} />
            <div class="grow">
              <div class="toast-title">{t.title}</div>
              {t.text ? <div style={{ opacity: 0.85 }}>{t.text}</div> : null}
              {t.action ? (
                <button
                  type="button"
                  class="link-button toast-action"
                  onClick={() => {
                    dismiss(t.id);
                    t.action!.run();
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
            </div>
            <button onClick={() => dismiss(t.id)} aria-label="Schließen">
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
