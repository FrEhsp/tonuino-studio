/** Links that leave the app: publisher pages, licences, and e-mail for "Melden". */
import type { ComponentChildren } from 'preact';
import { ExternalLink as ExternalIcon } from 'lucide-preact';
import { plat, platform } from '../../app/state';
import { toastError } from '../../ui/components/Toast';
import type { IndexEntry, IndexItem } from '../../core/sources/types';
import { isContactAddress } from './release';

/** Opens in the browser: a new tab in the web app, the system browser in the desktop app. */
export function openLink(href: string): void {
  plat()
    .openExternal(href)
    .catch((e) => toastError('Der Link ließ sich nicht öffnen', e));
}

/** A link to another site. The web app opens a tab without referrer; the desktop app hands it to the system. */
export function ExternalLink({ href, children, class: cls, icon = true, onOpen }: { href: string; children: ComponentChildren; class?: string; icon?: boolean; onOpen?: () => void }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      class={cls}
      onClick={(e) => {
        onOpen?.();
        if (platform.value?.kind !== 'desktop') return;
        e.preventDefault();
        openLink(href);
      }}
    >
      {children}
      {icon ? <ExternalIcon size={14} strokeWidth={2.2} aria-hidden="true" /> : null}
    </a>
  );
}

/** The address for "Melden", when the build has one (a release build always has; see release.ts). */
export function contactAddress(): string | undefined {
  const c = import.meta.env.VITE_SOURCES_CONTACT?.trim();
  return isContactAddress(c) ? c : undefined;
}

/** A prepared e-mail about the list, a source or one item; nothing without a contact address. */
export function reportHref(entry?: Pick<IndexEntry, 'id' | 'title'>, item?: Pick<IndexItem, 'key' | 'title'>): string | undefined {
  const to = contactAddress();
  if (!to) return undefined;
  const subject = entry ? `Entdecken: ${item ? item.title : entry.title}` : 'Entdecken: Hinweis zur Liste';
  const lines = [
    'Was stimmt nicht? (zum Beispiel: passt nicht zum Alter, Link kaputt, Angabe fehlt)',
    '',
    '',
    '---',
    entry ? `Quelle: ${entry.title} (${entry.id})` : undefined,
    item ? `Titel: ${item.title} (${item.key})` : undefined,
  ].filter((l): l is string => l !== undefined);
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}

/** "Melden": an e-mail link; the desktop app hands it to the mail program. */
export function ReportLink({ href, children, class: cls }: { href: string; children: ComponentChildren; class?: string }) {
  return (
    <a
      href={href}
      class={cls}
      onClick={(e) => {
        if (platform.value?.kind !== 'desktop') return;
        e.preventDefault();
        openLink(href);
      }}
    >
      {children}
    </a>
  );
}
