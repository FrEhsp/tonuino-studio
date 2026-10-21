/**
 * "Reinhören": one shared <audio> element for all of "Entdecken". Starting
 * another item stops the current one. The page sends no referrer. Files the
 * app loads itself are played like they are loaded: as a CORS request without
 * cookies (`cors`). Files that are only saved on the publisher's page cannot
 * be played that way, since their server allows no CORS; the browser then
 * sends that publisher's cookies, as the privacy text says.
 */
import { signal } from '@preact/signals';
import { Pause, Play } from 'lucide-preact';
import { Button, Spinner } from '../../ui/components/controls';
import { SeekBar } from '../../ui/components/SeekBar';
import { toast } from '../../ui/components/Toast';

export interface PreviewState {
  key: string;
  title: string;
  status: 'loading' | 'playing' | 'paused';
  time: number;
  duration?: number;
  /** The message when playing fails: where to listen instead ("Öffne die Folge auf der Webseite von WDR."). */
  failText?: string;
}

const FAILED = 'Reinhören klappt gerade nicht. Öffne die Folge auf der Webseite des Anbieters.';

/** What plays right now, or nothing. */
export const preview = signal<PreviewState | null>(null);

let player: HTMLAudioElement | null = null;

function audioElement(): HTMLAudioElement {
  if (player) return player;
  const a = new Audio();
  a.preload = 'none';
  const update = (patch: Partial<PreviewState>) => {
    if (preview.value) preview.value = { ...preview.value, ...patch };
  };
  a.addEventListener('playing', () => update({ status: 'playing' }));
  a.addEventListener('pause', () => update({ status: 'paused' }));
  a.addEventListener('waiting', () => update({ status: 'loading' }));
  a.addEventListener('timeupdate', () => update({ time: a.currentTime }));
  a.addEventListener('durationchange', () => {
    if (Number.isFinite(a.duration) && a.duration > 0) update({ duration: a.duration });
  });
  a.addEventListener('ended', () => update({ status: 'paused', time: 0 }));
  a.addEventListener('error', () => {
    if (!preview.value || !a.getAttribute('src')) return;
    const text = preview.value.failText ?? FAILED;
    preview.value = null;
    toast.error(text);
  });
  player = a;
  return a;
}

/** Plays an item, or pauses it when it is the one playing. `cors`: the publisher allows loading from the app; the request then carries no cookies. */
export function togglePreview(key: string, url: string, title: string, durationSec?: number, cors = false, failText?: string): void {
  const a = audioElement();
  const p = preview.value;
  if (p?.key === key) {
    if (p.status === 'paused') a.play().catch(() => undefined);
    else a.pause();
    return;
  }
  a.pause();
  preview.value = { key, title, status: 'loading', time: 0, duration: durationSec, failText };
  a.crossOrigin = cors ? 'anonymous' : null;
  a.src = url;
  a.play().catch((e: unknown) => {
    // Replaced by the next play() or pause(): not an error.
    if (e instanceof DOMException && e.name === 'AbortError') return;
    if (preview.value?.key === key && a.error === null) preview.value = { ...preview.value, status: 'paused' };
  });
}

/** Jumps within what plays now. */
export function seekPreview(key: string, sec: number): void {
  const p = preview.value;
  if (!player || p?.key !== key) return;
  player.currentTime = sec;
  preview.value = { ...p, time: sec };
}

/** Stops "Reinhören" and lets go of the file. */
export function stopPreview(): void {
  preview.value = null;
  if (!player) return;
  player.pause();
  player.removeAttribute('src');
  player.load();
}

/** "Reinhören", while playing "Anhalten" with a bar to jump in and "0:42 / 53:00". */
export function PreviewButton({
  itemKey,
  url,
  title,
  durationSec,
  disabled,
  cors,
  failText,
}: {
  itemKey: string;
  url: string;
  title: string;
  durationSec?: number;
  disabled?: boolean;
  cors?: boolean;
  failText?: string;
}) {
  const p = preview.value;
  const mine = p?.key === itemKey ? p : null;
  const active = !!mine && mine.status !== 'paused';
  const duration = mine?.duration ?? durationSec;
  return (
    <span class="source-preview">
      <Button
        size="sm"
        variant={mine ? 'soft' : 'ghost'}
        icon={active ? Pause : Play}
        disabled={disabled && !active}
        aria-label={`${active ? 'Anhalten' : 'Reinhören'}: ${title}`}
        onClick={() => togglePreview(itemKey, url, title, durationSec, cors, failText)}
      >
        {active ? 'Anhalten' : 'Reinhören'}
      </Button>
      {mine ? (
        <>
          {/* The spinner has its own slot, so the bar does not move while the stream buffers (a click aimed at it would land beside it). */}
          <span class="source-preview-wait">{mine.status === 'loading' ? <Spinner size={12} /> : null}</span>
          <SeekBar time={mine.time} duration={duration} label={title} clock onSeek={(sec) => seekPreview(itemKey, sec)} />
        </>
      ) : null}
    </span>
  );
}
