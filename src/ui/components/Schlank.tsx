/**
 * Parts the three screens of 0.6 share (06-entwuerfe/quelle/basis.css):
 * the folder number with − and +, the choice as a list of rows, and the
 * frame of a screen (the big thing on the left, a column with the questions
 * and the one purple button on the right; on a phone one above the other,
 * the button fixed at the bottom). Same things look the same (rule 15).
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { arrowKeyHandler } from '../arrowKeys';

/** Reads a typed folder number; null when it is not a whole number from `min` to `max`. */
export function readNumber(text: string, min = 1, max = 99): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** The next number up or down, staying inside min … max. */
export function step(value: number, by: number, min = 1, max = 99): number {
  return Math.min(max, Math.max(min, value + by));
}

/**
 * A number with − and + (TonUINO NFC Tools, #132): big enough for a thumb.
 * A tap on the number opens the digits to type it.
 */
export function NumberField({ value, onChange, label, min = 1, max = 99, disabled }: { value: number; onChange: (n: number) => void; label: string; min?: number; max?: number; disabled?: boolean }) {
  const [typing, setTyping] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (typing !== null) input.current?.select();
  }, [typing !== null]);
  const commit = () => {
    if (typing === null) return;
    const n = readNumber(typing, min, max);
    if (n === null) {
      setWrong(true);
      return;
    }
    setWrong(false);
    setTyping(null);
    if (n !== value) onChange(n);
  };
  const text = String(value).padStart(2, '0');
  return (
    <div class="zahl-feld">
      <div class="zahl" role="group" aria-label={label}>
        <button type="button" class="btn pm" aria-label="eins weniger" disabled={disabled || value <= min} onClick={() => onChange(step(value, -1, min, max))}>
          −
        </button>
        {typing !== null ? (
          <input
            ref={input}
            class="wert"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            aria-label={label}
            aria-invalid={wrong || undefined}
            value={typing}
            onInput={(e) => {
              setTyping((e.currentTarget as HTMLInputElement).value.replace(/\D/g, ''));
              setWrong(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setTyping(null);
                setWrong(false);
              }
            }}
            onBlur={commit}
          />
        ) : (
          <button type="button" class="wert" aria-label={`${label}: ${value}. Zum Eintippen antippen.`} disabled={disabled} onClick={() => setTyping(String(value))}>
            {text}
          </button>
        )}
        <button type="button" class="btn pm" aria-label="eins mehr" disabled={disabled || value >= max} onClick={() => onChange(step(value, 1, min, max))}>
          +
        </button>
      </div>
      {wrong ? (
        <p class="zahl-fehler" role="alert">
          Bitte eine Zahl zwischen {min} und {max}.
        </p>
      ) : null}
    </div>
  );
}

export interface Choice<T> {
  value: T;
  name: ComponentChildren;
  text?: ComponentChildren;
  /** Something to set right in the row (the title after which, #126). */
  extra?: ComponentChildren;
  disabled?: boolean;
}

/** One of a few, as a list of rows with a round mark (Hörspiel/Album/…, Ganz vorne/Nach/Ganz hinten). */
export function ChoiceList<T extends string | number>({ value, choices, onChange, label, class: cls }: { value: T; choices: Choice<T>[]; onChange: (v: T) => void; label: string; class?: string }) {
  const usable = choices.filter((c) => !c.disabled);
  return (
    <div
      class={`liste ${cls ?? ''}`}
      role="radiogroup"
      aria-label={label}
      onKeyDown={arrowKeyHandler(
        usable.findIndex((c) => c.value === value),
        (i) => onChange(usable[i].value),
      )}
    >
      {choices.map((c) => {
        const on = c.value === value;
        return (
          <div
            key={String(c.value)}
            class="opt"
            role="radio"
            aria-checked={on}
            aria-disabled={c.disabled || undefined}
            tabIndex={on ? 0 : -1}
            onClick={(e) => {
              // A control inside the row (the title to insert after) chooses the row too, but keeps its own click.
              if (c.disabled) return;
              if ((e.target as HTMLElement).closest('select, input')) {
                if (!on) onChange(c.value);
                return;
              }
              onChange(c.value);
            }}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !(e.target as HTMLElement).closest('select, input')) {
                e.preventDefault();
                if (!c.disabled) onChange(c.value);
              }
            }}
          >
            <i class="radio" aria-hidden="true" />
            <b>{c.name}</b>
            {c.text ? <span class="opt-text">{c.text}</span> : null}
            {c.extra}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The frame of a screen: the big thing (`big`) and the column (`title`,
 * the questions as `children`, the button area as `foot`). On a phone the
 * column's questions come first, then the big thing, and the foot stays
 * fixed above the bar (schlank.css decides by width; `phoneBigFirst` puts
 * the big thing above the questions, as the stickers' sheet).
 */
export function Screen({
  name,
  title,
  big,
  children,
  foot,
  top,
  phoneBigFirst,
  bigClass,
  handlers,
  help,
}: {
  name: string;
  title: string;
  big?: ComponentChildren;
  children?: ComponentChildren;
  foot?: ComponentChildren;
  top?: ComponentChildren;
  phoneBigFirst?: boolean;
  bigClass?: string;
  /** Files dropped anywhere on the screen (useFileDrop). */
  handlers?: Record<string, (e: DragEvent) => void>;
  /** Where „Hilfe“ leads on a phone; the help's start page when not given. */
  help?: string;
}) {
  return (
    <div class={`schirm schirm-${name} ${phoneBigFirst ? 'gross-zuerst' : ''}`} {...handlers}>
      {top}
      <div class="arbeit">
        {big !== undefined ? <section class={`gross ${bigClass ?? ''}`}>{big}</section> : null}
        <aside class="spalte">
          <h1>{title}</h1>
          {/* On a phone the bar on top with „Hilfe“ is gone: a small link beside the title (Prüfrunde 1 B6). */}
          <a class="hilfe-handy nur-handy" href={help ?? '#/hilfe'}>
            Hilfe
          </a>
          <div class="fragen">{children}</div>
          {foot ? <div class="unten">{foot}</div> : null}
        </aside>
      </div>
    </div>
  );
}
