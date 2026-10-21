/**
 * A problem explained: what happened, what to try (numbered), a button for
 * the most likely fix, and the technical details folded away for the forum.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { CircleAlert, CircleSlash, ExternalLink, ShieldCheck, Upload } from 'lucide-preact';
import type { FlashProblem } from '../../core/firmware/flash';
import { Button } from '../../ui/components/controls';
import { CommandLine } from '../../ui/components/Hints';
import { toast, toastError } from '../../ui/components/Toast';
import { plat } from '../../app/state';
import { ExternalLink as OutLink } from '../help/ExternalLink';
import { TechDetails } from './common';
import { desktopSerial } from './ports';

/** Whether the page shows a button for the problem's own fix (a link, or USB setup in the desktop app). */
export function offersAction(problem: FlashProblem): boolean {
  const a = problem.action;
  return a?.kind === 'link' || (a?.kind === 'usb-access-setup' && !!desktopSerial(plat().serial));
}

export function ProblemView({
  problem,
  onFlashAnyway,
  note,
  children,
  compact,
}: {
  problem: FlashProblem;
  /** Shown as the problem's own button when it offers to flash anyway. */
  onFlashAnyway?: () => void;
  /** Shown right above the buttons, e.g. a reminder for the next try. */
  note?: ComponentChildren;
  /** More buttons, e.g. "Noch einmal versuchen". */
  children?: ComponentChildren;
  /** Inside a step instead of on its own. */
  compact?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const aborted = problem.code === 'aborted';
  const Icon = aborted ? CircleSlash : CircleAlert;

  // Screen readers and keyboards land on the news, not somewhere above it.
  useEffect(() => {
    if (!compact) heading.current?.focus();
  }, [problem, compact]);

  const action = problem.action;
  const desktop = desktopSerial(plat().serial);
  let actionButton: ComponentChildren = null;
  if (action?.kind === 'link') {
    actionButton = (
      <Button variant="primary" icon={ExternalLink} onClick={() => void plat().openExternal(action.url)}>
        {action.label}
      </Button>
    );
  } else if (action?.kind === 'usb-access-setup' && desktop) {
    const setup = async () => {
      setBusy(true);
      try {
        await desktop.setupAccess();
        toast.success('USB-Zugriff ist eingerichtet', 'Stecke die Box einmal aus und wieder ein. Dann versuche es noch einmal.');
      } catch (e) {
        toastError('Das Einrichten hat nicht geklappt', e);
      } finally {
        setBusy(false);
      }
    };
    actionButton = (
      <Button variant="primary" icon={ShieldCheck} loading={busy} onClick={setup}>
        {action.label}
      </Button>
    );
  } else if (action?.kind === 'flash-anyway' && onFlashAnyway) {
    actionButton = (
      <Button icon={Upload} onClick={onFlashAnyway}>
        {action.label}
      </Button>
    );
  }

  const Heading = compact ? 'h3' : 'h2';
  return (
    <section class={compact ? 'stack' : 'card pad stack loose'} aria-labelledby={titleId}>
      <div class="ws-problem-head">
        <div class={`ws-problem-icon ${aborted ? 'neutral' : ''}`} aria-hidden="true">
          <Icon size={compact ? 22 : 26} strokeWidth={2.2} />
        </div>
        <div class="stack tight">
          <Heading id={titleId} ref={heading} tabIndex={-1}>
            {problem.title}
          </Heading>
          <p class="soft">{problem.explanation}</p>
        </div>
      </div>
      {problem.steps.length ? (
        <div class="stack">
          <span class="section-title">Das kannst du tun</span>
          <ol class="ws-numbered">
            {problem.steps.map((s) => (
              <Step key={s} text={s} />
            ))}
          </ol>
          {problem.link ? (
            <span>
              <OutLink href={problem.link.url}>{problem.link.label}</OutLink>
            </span>
          ) : null}
        </div>
      ) : null}
      {note}
      {/* The USB help has more for each system, e.g. the SerEnum setting of the CH340 driver on Windows. */}
      {problem.code.startsWith('port-') ? (
        <a class="small" href="#/werkstatt/usb">
          Mehr Hilfe bei USB-Problemen
        </a>
      ) : null}
      {actionButton || children ? (
        <div class="row wrap">
          {action?.kind === 'flash-anyway' ? children : actionButton}
          {action?.kind === 'flash-anyway' ? actionButton : children}
        </div>
      ) : null}
      {problem.technical ? <TechDetails text={problem.technical} /> : null}
    </section>
  );
}

/**
 * One step. The steps put a terminal command last ("… entferne es im
 * Terminal mit: sudo apt remove brltty"); it gets a box with a copy button.
 */
function Step({ text }: { text: string }) {
  // The command follows a colon or a space.
  const m = /[:\s]sudo /.exec(text);
  const at = m ? m.index + 1 : -1;
  if (at <= 0) return <li>{text}</li>;
  return (
    <li>
      <div class="stack tight">
        <span>{text.slice(0, at).trimEnd()}</span>
        <CommandLine command={text.slice(at)} />
      </div>
    </li>
  );
}
