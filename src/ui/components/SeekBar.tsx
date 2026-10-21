/**
 * The bar under "Reinhören" and "Anhören": shows where the track is and how
 * long it is, and takes a click, a drag or the arrow keys to jump there.
 * Drawn like the app's progress bars (each style draws `.progress` its own
 * way), with a real range input on top for the mouse, touch and keyboard.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { canSeek, clampSeek, lengthLabel, positionLabel, seekKey, seekPercent, seekValueText, snapToStart } from '../seek';
import type { MediaLike } from '../nativeAudio';

export interface SeekBarProps {
  /** Seconds played. */
  time: number;
  /** Length in seconds; without one there is no bar, only the clock. */
  duration: number | undefined;
  /** Jumps there. */
  onSeek: (sec: number) => void;
  /** What plays, for the screen reader: "Stelle in …". */
  label: string;
  /** Shows "0:42 / 3:10" next to the bar. */
  clock?: boolean;
  disabled?: boolean;
}

export function SeekBar({ time, duration, onSeek, label, clock, disabled }: SeekBarProps) {
  // While dragging, the bar follows the hand, not the player; the jump comes on letting go.
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? time;
  const clockText = (
    <span class="seekbar-clock">
      {positionLabel(shown, duration)}
      {canSeek(duration) ? ` / ${lengthLabel(duration)}` : ''}
    </span>
  );
  if (!canSeek(duration)) return clock ? clockText : null;
  const pct = seekPercent(shown, duration);
  const commit = (sec: number) => {
    setDraft(null);
    onSeek(clampSeek(sec, duration));
  };
  return (
    <div class={`seekbar${disabled ? ' disabled' : ''}`}>
      <div class="seekbar-track">
        <div class="progress" aria-hidden="true">
          <div style={{ width: `${pct}%` }} />
        </div>
        <span class="seekbar-knob" aria-hidden="true" style={{ left: `calc((100% - 14px) * ${pct / 100})` }} />
        <input
          type="range"
          min={0}
          max={duration}
          step="any"
          value={shown}
          disabled={disabled}
          aria-label={`Stelle in ${label}`}
          aria-valuetext={seekValueText(shown, duration)}
          onInput={(e) => setDraft(Number(e.currentTarget.value))}
          onChange={(e) => {
            const input = e.currentTarget;
            commit(snapToStart(Number(input.value), duration, () => input.getBoundingClientRect().width));
          }}
          onPointerCancel={() => setDraft(null)}
          onKeyDown={(e) => {
            const to = seekKey(e.key, shown, duration);
            if (to === null) return;
            e.preventDefault();
            commit(to);
          }}
        />
      </div>
      {clock ? clockText : null}
    </div>
  );
}

/**
 * The bar for a player the caller holds (an <audio> element, or the desktop
 * app's own player, which behaves like one): follows its clock by
 * itself, so only the bar draws anew while it plays, not the list around it.
 * `durationSec` is the length the list shows; the browser's own length (a
 * guess for some MP3s, which changes while it plays) counts only without it.
 * After a jump the bar stays where it was sent until the player got there:
 * clock ticks from before the jump would pull it back for a moment.
 */
export function AudioSeekBar({
  audio,
  label,
  durationSec,
  onSeek,
  clock = true,
}: {
  audio: MediaLike;
  label: string;
  durationSec?: number;
  onSeek?: (sec: number) => void;
  clock?: boolean;
}) {
  const [time, setTime] = useState(audio.currentTime);
  const [own, setOwn] = useState<number | undefined>(canSeek(audio.duration) ? audio.duration : undefined);
  const pending = useRef<{ to: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    const settle = () => {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = null;
    };
    const onTime = () => {
      if (pending.current && (audio.seeking || Math.abs(audio.currentTime - pending.current.to) > 1.5)) return;
      settle();
      setTime(audio.currentTime);
    };
    const onSeeked = () => {
      settle();
      setTime(audio.currentTime);
    };
    const onDuration = () => setOwn(canSeek(audio.duration) ? audio.duration : undefined);
    setTime(audio.currentTime);
    onDuration();
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeked', onSeeked);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('loadedmetadata', onDuration);
    return () => {
      settle();
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('seeked', onSeeked);
      audio.removeEventListener('durationchange', onDuration);
      audio.removeEventListener('loadedmetadata', onDuration);
    };
  }, [audio]);
  const duration = canSeek(durationSec) ? durationSec : own;
  return (
    <SeekBar
      time={duration !== undefined ? Math.min(time, duration) : time}
      duration={duration}
      label={label}
      clock={clock}
      onSeek={(sec) => {
        if (pending.current) clearTimeout(pending.current.timer);
        // Should the player never report the jump, the bar follows its clock again after a while.
        pending.current = { to: sec, timer: setTimeout(() => (pending.current = null), 2000) };
        if (onSeek) onSeek(sec);
        else audio.currentTime = sec;
        setTime(sec);
      }}
    />
  );
}
