/**
 * "Anhören" in the provider's own player, for titles the app may not play
 * from a file (ARD Sounds offers its player for this, providers.ts). The
 * frame loads only after a click, one at a time, and goes away with the row:
 * until then the provider sees nothing. The app's own "Reinhören" and the
 * provider's player never play together.
 */
import { effect, signal } from '@preact/signals';
import { Play, X } from 'lucide-preact';
import { Button } from '../../ui/components/controls';
import { preview, stopPreview } from './Preview';

/** The item whose player is open, or nothing. */
export const openEmbed = signal<string | null>(null);

// "Reinhören" started elsewhere: the player of another title closes.
effect(() => {
  if (preview.value) openEmbed.value = null;
});

/** Opens or closes the player of one title. */
export function EmbedButton({ itemKey, title, disabled }: { itemKey: string; title: string; disabled?: boolean }) {
  const open = openEmbed.value === itemKey;
  return (
    <Button
      size="sm"
      variant={open ? 'soft' : 'ghost'}
      icon={open ? X : Play}
      disabled={disabled && !open}
      aria-expanded={open}
      aria-label={`${open ? 'Player schließen' : 'Anhören'}: ${title}`}
      onClick={() => {
        if (open) {
          openEmbed.value = null;
          return;
        }
        stopPreview();
        openEmbed.value = itemKey;
      }}
    >
      {open ? 'Schließen' : 'Anhören'}
    </Button>
  );
}

/**
 * The provider's player below the row, when it is open. Sandboxed: it may run
 * its own scripts and open its own pages in a new window, never change the app.
 */
export function EmbedFrame({ itemKey, url, title, publisher }: { itemKey: string; url: string; title: string; publisher: string }) {
  if (openEmbed.value !== itemKey) return null;
  return (
    <div class="source-embed">
      <iframe
        src={url}
        title={`Player von ${publisher}: ${title}`}
        allow="autoplay; encrypted-media"
        referrerpolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      />
      <p class="small muted">Der Player kommt von {publisher}. Speichern kannst du die Folge dort auf der Webseite.</p>
    </div>
  );
}
