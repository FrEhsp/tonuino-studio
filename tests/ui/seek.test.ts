import { describe, expect, it } from 'vitest';
import { canSeek, clampSeek, clockLabel, lengthLabel, positionLabel, seekKey, seekPercent, seekValueText, snapToStart } from '../../src/ui/seek';
import { clockLabel as sourcesClock } from '../../src/features/sources/labels';

describe('the bar under "Anhören"', () => {
  it('is there only with a real length', () => {
    expect(canSeek(180)).toBe(true);
    expect(canSeek(undefined)).toBe(false);
    expect(canSeek(0)).toBe(false);
    expect(canSeek(Number.NaN)).toBe(false);
    // A live stream: no end to jump to.
    expect(canSeek(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('fills as far as the track played, never beyond the ends', () => {
    expect(seekPercent(45, 180)).toBe(25);
    expect(seekPercent(-3, 180)).toBe(0);
    expect(seekPercent(200, 180)).toBe(100);
    expect(seekPercent(10, undefined)).toBe(0);
    expect(clampSeek(Number.NaN, 60)).toBe(0);
  });

  it('tells the screen reader where it is', () => {
    expect(seekValueText(42, 3180)).toBe('0:42 von 53:00');
    expect(seekValueText(42, undefined)).toBe('0:42');
  });

  it('moves with the keys: small steps with the arrows, big ones with the page keys, the ends with Home and End', () => {
    expect(seekKey('ArrowRight', 30, 180)).toBe(35);
    expect(seekKey('ArrowLeft', 3, 180)).toBe(0);
    expect(seekKey('PageUp', 30, 180)).toBe(60);
    expect(seekKey('PageDown', 30, 180)).toBe(0);
    expect(seekKey('Home', 30, 180)).toBe(0);
    expect(seekKey('End', 30, 180)).toBe(180);
    expect(seekKey('ArrowRight', 178, 180)).toBe(180);
    // Other keys (Tab, Enter) are not the bar's.
    expect(seekKey('Tab', 30, 180)).toBeNull();
  });

  it('takes bigger steps in a long audiobook', () => {
    expect(seekKey('ArrowRight', 0, 3180)).toBe(10);
    expect(seekKey('PageUp', 0, 3180)).toBe(60);
  });

  it('keeps one clock for "Entdecken" and the folders', () => {
    expect(sourcesClock).toBe(clockLabel);
    expect(clockLabel(3723)).toBe('1:02:03');
  });

  it('shows lengths rounded like the lists, so 65.6 s is 1:06 in both places', () => {
    expect(lengthLabel(65.6)).toBe('1:06');
    expect(lengthLabel(65.4)).toBe('1:05');
    expect(lengthLabel(undefined)).toBe('0:00');
    // The position counts whole seconds up and ends on the length itself.
    expect(positionLabel(65.4, 65.6)).toBe('1:05');
    expect(positionLabel(65.6, 65.6)).toBe('1:06');
    expect(seekValueText(10, 65.6)).toBe('0:10 von 1:06');
  });

  it('jumps to exactly 0:00 when the hand lets go at the very left of the bar', () => {
    // 3 minutes on 300 px: half a knob (7 px) is about 4.4 s.
    expect(snapToStart(3.9, 180, 300)).toBe(0);
    expect(snapToStart(5, 180, 300)).toBe(5);
    expect(snapToStart(-1, 180, 300)).toBe(0);
    expect(snapToStart(0.2, 180, 0)).toBe(0.2);
    // A long audiobook: half a knob is minutes there, the snap stays within 10 s.
    expect(snapToStart(8, 3 * 3600, 300)).toBe(0);
    expect(snapToStart(40, 3 * 3600, 300)).toBe(40);
  });
});
