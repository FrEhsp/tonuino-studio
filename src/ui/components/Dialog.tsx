import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import { IconButton } from './controls';
import { useRootFlag } from '../rootFlag';
import { X } from 'lucide-preact';

export function Dialog({
  title,
  onClose,
  children,
  footer,
  width,
  dismissable = true,
  closeButton = true,
  bodyClass,
  top = false,
}: {
  title: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  width?: 'normal' | 'wide' | 'xwide';
  /** False while work runs that must not be interrupted. */
  dismissable?: boolean;
  /** False hides the X; Escape still closes a dismissable dialog. For questions about closing, where an X would be unclear. */
  closeButton?: boolean;
  /** Extra class for the body, for dialogs that lay out their own scrolling. */
  bodyClass?: string;
  /** Hold the top edge in place: for dialogs whose height changes while sliders in them are dragged. */
  top?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useRootFlag('dialog');
  // Read by the key handler, so it always closes the way the latest render says.
  const latest = useRef({ onClose, dismissable });
  latest.current = { onClose, dismissable };
  // A layout effect: focus and Escape work from the moment the dialog is on the screen. A plain
  // effect runs a frame later, and an Escape pressed right away got lost.
  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button.primary');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && latest.current.dismissable) {
        e.stopPropagation();
        latest.current.onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div class={top ? 'dialog-backdrop top' : 'dialog-backdrop'} onMouseDown={(e) => dismissable && e.target === e.currentTarget && onClose()}>
      <div class={`dialog ${width && width !== 'normal' ? width : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div class="dialog-head">
          <h2 id={titleId}>{title}</h2>
          {dismissable && closeButton ? <IconButton label="Schließen" icon={X} size="sm" onClick={onClose} /> : null}
        </div>
        <div class={bodyClass ? `dialog-body ${bodyClass}` : 'dialog-body'}>{children}</div>
        {footer ? <div class="dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
