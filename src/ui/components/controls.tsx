import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { Fragment } from 'preact';
import type { LucideIcon } from 'lucide-preact';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-preact';
import { Bubble, bubblesShown } from './Sketch';

type Variant = 'default' | 'primary' | 'accent' | 'danger' | 'ghost' | 'soft';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'icon' | 'size' | 'type'> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  block?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
}

export function Button({ variant = 'default', size = 'md', icon: Icon, iconRight: IconRight, loading, block, children, class: cls, disabled, type = 'button', ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'default' && variant, size !== 'md' && size, block && 'block', !children && 'icon', cls].filter(Boolean).join(' ');
  const iconSize = size === 'sm' ? 16 : size === 'lg' ? 20 : 18;
  return (
    <button type={type} class={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span class="spinner" /> : Icon ? <Icon size={iconSize} strokeWidth={2.2} /> : null}
      {children}
      {IconRight && !loading ? <IconRight size={iconSize} strokeWidth={2.2} /> : null}
    </button>
  );
}

export function IconButton({ label, ...rest }: ButtonProps & { label: string }) {
  return <Button variant="ghost" title={label} aria-label={label} {...rest} />;
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ComponentChildren; hint?: ComponentChildren; disabled?: boolean }) {
  return (
    <label class="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span class="stack tight">
        <span style={{ fontWeight: 600 }}>{label}</span>
        {hint ? <span class="small muted">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: ComponentChildren; icon?: LucideIcon }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div class="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={String(o.value)} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.icon ? <o.icon size={15} strokeWidth={2.2} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, id }: { label: ComponentChildren; hint?: ComponentChildren; children: ComponentChildren; id?: string }) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {children}
      {hint ? <div class="field-hint">{hint}</div> : null}
    </div>
  );
}

export function Badge({ tone, children, dot }: { tone?: 'brand' | 'success' | 'warning' | 'danger' | 'accent'; children: ComponentChildren; dot?: boolean }) {
  return (
    <span class={`badge ${tone ?? ''}`}>
      {dot ? <span class="dot" /> : null}
      {children}
    </span>
  );
}

export function Progress({ value, max = 1, indeterminate, label }: { value?: number; max?: number; indeterminate?: boolean; label?: string }) {
  const pct = indeterminate || value === undefined ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div class={`progress ${indeterminate ? 'indeterminate' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(pct)}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <span class="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

// The plain hint has no (i): that is the pattern of a template (Prüfrunde 1 Aussehen 4).
const CALLOUT_ICONS = { info: null, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert, neutral: Info };

export function Callout({ tone = 'info', children, icon }: { tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral'; children: ComponentChildren; icon?: LucideIcon | null }) {
  const Icon = icon === null ? null : (icon ?? CALLOUT_ICONS[tone]);
  return (
    <div class={`callout ${tone === 'info' ? '' : tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      {Icon ? <Icon size={18} strokeWidth={2.2} /> : null}
      <div class="grow">{children}</div>
    </div>
  );
}

/** An empty page: a drawing, a title, a short text and buttons. `note` is a short speech bubble next to the drawing. */
export function EmptyState({ art, note, title, children, actions }: { art?: ComponentChildren; note?: ComponentChildren; title: ComponentChildren; children?: ComponentChildren; actions?: ComponentChildren }) {
  const drawing = art ? <div class="empty-art">{art}</div> : null;
  return (
    <div class="empty">
      {drawing && note && bubblesShown() ? (
        <div class="empty-art-note">
          {drawing}
          <Bubble tail="left" class="empty-note">
            {note}
          </Bubble>
        </div>
      ) : (
        drawing
      )}
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {actions ? <div class="row wrap">{actions}</div> : null}
    </div>
  );
}

/**
 * The one step bar of every assistant: circle, name, a dashed line between
 * (Prüfrunde 1 Aussehen 5, Bastler 1). With `onPick` the steps done are
 * buttons back; `values` shows what was chosen in a step done.
 */
export function Steps({ steps, active, onPick, values }: { steps: string[]; active: number; onPick?: (index: number) => void; values?: readonly (string | undefined)[] }) {
  return (
    <nav class="steps" aria-label="Schritte">
      {steps.map((s, i) => {
        const done = i < active;
        const inner = (
          <>
            <span class="step-num" aria-hidden="true">
              {done ? '✓' : i + 1}
            </span>
            <span class="step-name">{s}</span>
            {done && values?.[i] ? <span class="step-wahl">{values[i]}</span> : null}
          </>
        );
        return (
          <Fragment key={s}>
            {i > 0 ? <span class="sep" aria-hidden="true" /> : null}
            {done && onPick ? (
              <button type="button" class="step done" title={`Zurück zu „${s}“`} onClick={() => onPick(i)}>
                {inner}
              </button>
            ) : (
              <span class={`step ${i === active ? 'active' : done ? 'done' : ''}`} aria-current={i === active ? 'step' : undefined}>
                {inner}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
