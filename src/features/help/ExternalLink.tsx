import type { ComponentChildren } from 'preact';
import { ExternalLink as ExternalLinkIcon } from 'lucide-preact';
import { platform } from '../../app/state';
import { toast } from '../../ui/components/Toast';
import '../../ui/styles/help.css';

/** The TonUINO forum, where the community helps: linked from the menu, the welcome page and the help. */
export const FORUM_URL = 'https://discourse.voss.earth';

/**
 * A link that leaves the app. The browser opens it in a new tab by itself;
 * the desktop app hands it to the system browser instead.
 */
export function ExternalLink({ href, class: cls, children }: { href: string; class?: string; children: ComponentChildren }) {
  const p = platform.value;
  const desktop = p?.kind === 'desktop';
  const open = (e: MouseEvent) => {
    if (!desktop || !p) return;
    e.preventDefault();
    p.openExternal(href).catch(() => toast.error('Der Link ließ sich nicht öffnen', `Öffne ihn selbst in deinem Browser: ${href}`));
  };
  // In running text the last word keeps the icon with it, so the icon never starts a line alone.
  // A button lays out text and icon side by side already.
  const text = typeof children === 'string' && !/\bbtn\b/.test(cls ?? '') ? children : null;
  const cut = text ? text.lastIndexOf(' ') + 1 : 0;
  return (
    <a class={`help-external ${cls ?? ''}`} href={href} target="_blank" rel="noopener noreferrer" onClick={open}>
      {text ? text.slice(0, cut) : children}
      {text ? (
        <span class="help-external-tail">
          {text.slice(cut)}
          <ExternalLinkIcon size={13} strokeWidth={2.4} aria-hidden="true" />
        </span>
      ) : (
        <ExternalLinkIcon size={13} strokeWidth={2.4} aria-hidden="true" />
      )}
      <span class="visually-hidden">{desktop ? ' (öffnet im Browser)' : ' (öffnet in einem neuen Tab)'}</span>
    </a>
  );
}
