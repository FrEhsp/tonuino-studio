/**
 * Small controls from 0.4: one of two or three words (a radio group with
 * arrow keys), a box to tick for yes or no, and a note beside a thing. In
 * 0.4 they were drawn on paper; since 0.4.1 they look like the controls of
 * 0.3.1 (a segmented control, an ordinary checkbox, a plain small sentence,
 * see stil-holz.css), and keep what they do for the keyboard.
 */
import { Fragment, type ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';

export type CircleOption<T> = { value: T; label: ComponentChildren; title?: string; disabled?: boolean };

/**
 * One of two or three, as words in a sentence: the chosen one is circled.
 * A radio group with one tab stop; the arrow keys move the circle, as in a
 * row of radio buttons. Between the words stands "oder" (or a comma), so it
 * reads like a sentence: "zugeschnitten oder ganz".
 */
export function CircleChoice<T extends string | number>({
  value,
  options,
  onChange,
  label,
  labelledBy,
  describedBy,
  disabled,
  joined = true,
  class: cls,
}: {
  value: T;
  options: CircleOption<T>[];
  onChange: (v: T) => void;
  label?: string;
  /** Instead of `label`: the id of what names the group (a label in the margin). */
  labelledBy?: string;
  describedBy?: string;
  disabled?: boolean;
  /** false: the words stand side by side without "oder". */
  joined?: boolean;
  /** A look of its own, for example the row of button caps on Karten beschreiben. */
  class?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.max(0, options.findIndex((o) => o.value === value));
  // The arrow keys skip words that cannot be chosen here.
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    let n = i;
    for (let tries = 0; tries < options.length; tries++) {
      n = (n + step + options.length) % options.length;
      if (!options[n].disabled) break;
    }
    if (n === i || options[n].disabled) return;
    onChange(options[n].value);
    refs.current[n]?.focus();
  };
  return (
    <span class={`circle-choice ${joined ? '' : 'apart'} ${cls ?? ''}`} role="radiogroup" aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-disabled={disabled ? 'true' : undefined}>
      {options.map((o, i) => (
        <Fragment key={String(o.value)}>
          {i > 0 && joined ? (
            <span class={i === options.length - 1 ? 'circle-or circle-or-word' : 'circle-or'} aria-hidden="true">
              {i === options.length - 1 ? ' oder ' : ', '}
            </span>
          ) : null}
          <button
            type="button"
            role="radio"
            aria-checked={o.value === value}
            aria-disabled={o.disabled ? 'true' : undefined}
            tabIndex={i === at ? 0 : -1}
            disabled={disabled}
            title={o.title}
            ref={(el) => {
              refs.current[i] = el;
            }}
            onClick={() => o.disabled || onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.label}
          </button>
        </Fragment>
      ))}
    </span>
  );
}

/** Yes or no: a box drawn with a pen, ticked with a felt pen. A real checkbox underneath. */
export function PenCheck({
  checked,
  onChange,
  children,
  disabled,
  id,
  describedBy,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ComponentChildren;
  disabled?: boolean;
  id?: string;
  describedBy?: string;
}) {
  return (
    <label class={`pen-check ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" class="pen-box" id={id} checked={checked} disabled={disabled} aria-describedby={describedBy} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span class="pen-check-text">{children}</span>
    </label>
  );
}

/**
 * One note in the margin, in handwriting, with a pencil arrow: pointing left
 * and up at what stands beside it, or (`down`) at what comes under it.
 */
export function MarginNote({ children, down }: { children: ComponentChildren; down?: boolean }) {
  return (
    <aside class={`margin-note ${down ? 'down' : ''}`}>
      <svg class="margin-note-arrow" viewBox="0 0 64 40" aria-hidden="true" focusable="false">
        <path d="M60 30 Q44 36 26 26 Q14 19 7 9 M5.6 19.4 Q6 13.4 6.6 8.2 Q12.2 9.4 17.4 10.4" />
      </svg>
      <p>{children}</p>
    </aside>
  );
}
