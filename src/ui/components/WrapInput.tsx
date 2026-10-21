import { homeEnd, oneLine } from '../oneLine';

export interface WrapInputProps {
  value: string;
  onValue: (value: string) => void;
  label: string;
  placeholder?: string;
  /** Sets the size of the text, e.g. "album-title". */
  class?: string;
  /** Leaving the field, with its text: for fields that save only then. */
  onBlur?: (value: string) => void;
  /** Escape: the field gives up what was typed and is left. */
  onCancel?: () => void;
}

/**
 * A field for one line of text that wraps instead of hiding what does not
 * fit, so a long title stays readable on a phone. It grows with its text:
 * a hidden copy of the text next to it sets the height (see .wrap-input),
 * which needs no measuring and follows every change of width. It behaves as
 * a one-line field: Enter adds no line but ends the editing, as in the other
 * title fields, Home and End go to the start and end of the whole title, and
 * screen readers hear a one-line field.
 */
export function WrapInput({ value, onValue, label, placeholder, class: cls, onBlur, onCancel }: WrapInputProps) {
  return (
    <div class={cls ? `wrap-input ${cls}` : 'wrap-input'} data-value={value || placeholder || ''}>
      <textarea
        class="input inline-edit"
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-multiline="false"
        enterkeyhint="done"
        onKeyDown={(e) => {
          if (e.isComposing) return;
          const field = e.currentTarget;
          if (e.key === 'Enter') {
            e.preventDefault();
            field.blur();
          } else if (e.key === 'Escape' && onCancel) {
            e.preventDefault();
            onCancel();
            field.blur();
          } else if ((e.key === 'Home' || e.key === 'End') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            const next = homeEnd(e.key, field.value.length, { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection }, e.shiftKey);
            field.setSelectionRange(next.start, next.end, next.direction);
          }
        }}
        onBlur={onBlur ? (e) => onBlur(e.currentTarget.value) : undefined}
        onInput={(e) => {
          const field = e.currentTarget;
          const next = oneLine(field.value, field.selectionStart ?? field.value.length);
          if (next.text !== field.value) {
            field.value = next.text;
            field.setSelectionRange(next.caret, next.caret);
          }
          onValue(next.text);
        }}
      />
    </div>
  );
}
