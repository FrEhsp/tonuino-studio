/**
 * The bar under "Reinhören" and "Anhören": where in the track the player is,
 * and where it should go. Pure helpers; the bar itself is SeekBar.tsx.
 */

/** "0:42", "53:00", "1:02:03". */
export function clockLabel(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The length next to the bar: rounded to the second like every length in the
 * lists (formatDuration), so 65.6 s reads 1:06 in both places, not 1:05 here.
 */
export function lengthLabel(sec: number | undefined): string {
  return sec === undefined || !Number.isFinite(sec) || sec < 0 ? '0:00' : clockLabel(Math.round(sec));
}

/** The position next to the bar: counts up in whole seconds, and at the end shows the length itself. */
export function positionLabel(time: number, duration: number | undefined): string {
  return canSeek(duration) && time >= duration - 0.05 ? lengthLabel(duration) : clockLabel(time);
}

/** A length the bar can show: known, finite, more than nothing (live streams have none). */
export function canSeek(duration: number | undefined): duration is number {
  return duration !== undefined && Number.isFinite(duration) && duration > 0;
}

/** A position inside the track. */
export function clampSeek(sec: number, duration: number): number {
  if (!Number.isFinite(sec) || sec < 0) return 0;
  return Math.min(sec, duration);
}

/**
 * A drag or click that ends at the very left of the bar means "from the
 * start": the knob is 14 px wide, and on a bar a few hundred pixels long a
 * hand lands a second or more after 0:00 (an audiobook: half a minute).
 * Within half the knob's width of the start, the jump goes to exactly 0,
 * but never more than 10 seconds: on an audiobook half a knob is minutes.
 */
const MAX_SNAP_SEC = 10;

export function snapToStart(sec: number, duration: number, width: number | (() => number), knobPx = 14): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  // Measured only when it matters: measuring the bar made the page lay itself out at every jump.
  if (sec > MAX_SNAP_SEC) return sec;
  const widthPx = typeof width === 'function' ? width() : width;
  if (!(widthPx > knobPx) || !canSeek(duration)) return sec;
  const perPx = duration / (widthPx - knobPx);
  return sec <= Math.min((perPx * knobPx) / 2, MAX_SNAP_SEC) ? 0 : sec;
}

/** How far the bar is filled, 0 to 100. */
export function seekPercent(time: number, duration: number | undefined): number {
  if (!canSeek(duration)) return 0;
  return (clampSeek(time, duration) / duration) * 100;
}

/** What a screen reader says: "0:42 von 53:00". */
export function seekValueText(time: number, duration: number | undefined): string {
  return canSeek(duration) ? `${positionLabel(time, duration)} von ${lengthLabel(duration)}` : clockLabel(time);
}

/** Small and big steps with the keyboard, in seconds: a long audiobook needs bigger ones. */
export function seekSteps(duration: number): { small: number; big: number } {
  if (duration > 20 * 60) return { small: 10, big: 60 };
  return { small: 5, big: 30 };
}

/** Where a key moves the player, or null when the key is not for the bar. */
export function seekKey(key: string, time: number, duration: number): number | null {
  const { small, big } = seekSteps(duration);
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampSeek(time - small, duration);
    case 'ArrowRight':
    case 'ArrowUp':
      return clampSeek(time + small, duration);
    case 'PageDown':
      return clampSeek(time - big, duration);
    case 'PageUp':
      return clampSeek(time + big, duration);
    case 'Home':
      return 0;
    case 'End':
      return duration;
    default:
      return null;
  }
}
