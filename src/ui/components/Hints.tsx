import { useState } from 'preact/hooks';
import { Check, Copy } from 'lucide-preact';

export interface Hint {
  text: string;
  /** Command to paste into a terminal. */
  command?: string;
}

/** Follow-up advice carried by a desktop error (pcscd missing, driver blocked, …). */
export function errorHints(e: unknown): Hint[] {
  const hints = (e as { hints?: unknown } | null)?.hints;
  if (!Array.isArray(hints)) return [];
  return hints.filter((h): h is Hint => typeof h?.text === 'string');
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function HintList({ hints }: { hints: Hint[] }) {
  if (!hints.length) return null;
  return (
    <ul class="hint-list">
      {hints.map((h) => (
        <li key={h.text}>
          <span>{h.text}</span>
          {h.command ? <CommandLine command={h.command} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** A terminal command with a copy button. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked: the text is selectable anyway.
    }
  };
  return (
    <div class="command-line">
      <code>{command}</code>
      <button type="button" class="command-copy" onClick={copy} aria-label="Befehl kopieren" title="Befehl kopieren">
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}
