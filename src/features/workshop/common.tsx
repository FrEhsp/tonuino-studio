/** Small pieces the workshop tools share. */
import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Copy, Keyboard, ListChecks, ScanLine } from 'lucide-preact';
import { Button, Callout, Segmented } from '../../ui/components/controls';
import { PenCheck } from '../../ui/components/Hand';
import { toast } from '../../ui/components/Toast';
import { DesktopAppLink } from '../help/DesktopAppLink';
import { DESKTOP_DOWNLOAD_URL } from '../help/desktopapp';
import { BoxMeldungen } from './BoxMeldungen';
import { platform } from '../../app/state';
import { BackToWorkshop } from '../../ui/components/BackToWorkshop';

/** The Android app: the box's USB talk needs a computer there, whatever the browser. */
const onPhone = () => !!platform.value?.mobile;

export { BackToWorkshop };

/** `meldungen`: the banner with the problems the connected box reported (BoxMeldungen); Box testen shows them itself. */
export function ToolHeader({ title, intro, children, meldungen = true }: { title: string; intro?: ComponentChildren; children?: ComponentChildren; meldungen?: boolean }) {
  return (
    <div class="stack">
      <div>
        <BackToWorkshop />
        <header class="page-header">
          <div class="titles">
            <h1>{title}</h1>
            {intro ? <p>{intro}</p> : null}
          </div>
          {children}
        </header>
      </div>
      {meldungen ? <BoxMeldungen /> : null}
    </div>
  );
}

/**
 * "Box testen" is the guided test of the whole box (BoxTestTool, tab "Alles");
 * for a closer look it holds two single tests: the keys (with the parts that
 * report at start), and the card reader. Each keeps its own address (help
 * links point at them); the row of tabs switches between them. Title and
 * intro are the same on all three, so the tabs stay in place; what each test
 * does stands under them. The connection to the box stays open across them.
 * `meldungen`: the guided test lists the box's problems in its own steps.
 */
export function BoxTestHeader({ current, children, meldungen = true }: { current: 'testen' | 'tasten' | 'kartenleser'; children: ComponentChildren; meldungen?: boolean }) {
  return (
    <>
      <ToolHeader title="Box testen" intro="Fertig gelötet? Hier prüfst du, ob Tasten, MP3-Player und der Kartenleser in der Box funktionieren." meldungen={meldungen} />
      <div class="ws-test-tabs">
        <Segmented
          label="Was willst du testen?"
          value={current}
          options={[
            { value: 'testen', label: 'Alles', icon: ListChecks },
            { value: 'tasten', label: 'Tasten', icon: Keyboard },
            { value: 'kartenleser', label: 'Kartenleser', icon: ScanLine },
          ]}
          onChange={(v) => {
            if (v !== current) location.hash = `#/werkstatt/${v}`;
          }}
        />
        <p class="soft">{children}</p>
      </div>
    </>
  );
}

/** Copies text and says so on the button for a moment. */
export function CopyButton({
  text,
  label = 'Kopieren',
  size = 'sm',
  variant = 'default',
  disabled,
  fallback = 'Markiere den Text und kopiere ihn selbst.',
}: {
  text: () => string;
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'default' | 'ghost' | 'soft';
  disabled?: boolean;
  /** What to do instead when the clipboard is blocked. */
  fallback?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Kopieren hat nicht geklappt', `Der Browser hat den Zugriff auf die Zwischenablage verweigert. ${fallback}`);
    }
  };
  return (
    <Button size={size} variant={variant} icon={copied ? Check : Copy} disabled={disabled} onClick={copy}>
      {copied ? 'Kopiert' : label}
    </Button>
  );
}

export interface FactRow {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'error';
  /** A page of the app where this can be changed, shown after the value. */
  link?: { label: string; href: string };
}

export function Facts({ facts }: { facts: FactRow[] }) {
  return (
    <dl class="ws-facts">
      {facts.map((f) => (
        <Fragment key={f.label}>
          <dt>{f.label}</dt>
          <dd class={f.tone ?? ''}>
            {f.value}
            {f.link ? (
              <>
                {' '}
                <a class="ws-fact-link" href={f.link.href} aria-label={`${f.label}: ${f.link.label}`}>
                  {f.link.label}
                </a>
              </>
            ) : null}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Details for the forum or for support, folded away so they do not scare anyone. */
export function TechDetails({ text, summary = 'Technische Details' }: { text: string; summary?: string }) {
  return (
    <details class="ws-tech">
      <summary>{summary}</summary>
      <div class="ws-tech-body">
        <pre>{text}</pre>
        <div>
          <CopyButton text={() => text} label="Details kopieren" />
        </div>
      </div>
    </details>
  );
}

/** For tools that need USB: says plainly that this browser cannot, and what works instead. */
export function NoSerial({ children }: { children?: ComponentChildren }) {
  return (
    <Callout tone="warning">
      <div class="stack tight">
        {/* The Android app has no USB bridge to the box everywhere: there it is the phone, not a browser (audit 0.4 #28). */}
        <b>{onPhone() ? 'Über USB spricht die Box nur mit einem Computer.' : 'Dieser Browser kann nicht über USB mit der Box sprechen.'}</b>
        <span>
          {onPhone()
            ? 'Am Computer geht das mit der Desktop-App für Windows und Linux, oder in Chrome und Edge.'
            : 'Das geht mit Firefox ab Version 151, Google Chrome oder Microsoft Edge auf einem Computer, oder mit der Desktop-App für Windows und Linux.'}
        </span>
        {children}
        {DESKTOP_DOWNLOAD_URL ? (
          <span>
            <DesktopAppLink />
          </span>
        ) : null}
      </div>
    </Callout>
  );
}

/**
 * One thing to change under „Box einstellen“: a pen-drawn box to tick, the
 * name, and how it is now in small letters on the same line. Ticks, not
 * switches: ticking changes nothing on the box, it adds the buttons to press
 * (audit 0.4 #17).
 */
export function SettingCheck({ checked, onChange, title, note }: { checked: boolean; onChange: (on: boolean) => void; title: string; note?: string }) {
  return (
    <PenCheck checked={checked} onChange={onChange}>
      <span class="ws-set-name">{title}</span>
      {note ? <span class="ws-set-now small soft"> {note}</span> : null}
    </PenCheck>
  );
}
